'use strict';
// Offline operator SQL only. No HTTP endpoint, authentication alias, point
// adjustment or automatic identity inference is created by this module.
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function buildMergeSql(rows,approvalReference){
 if(!Array.isArray(rows)||!rows.length||rows.length>10||typeof approvalReference!=='string'||!approvalReference.trim()||approvalReference.length>500)throw Error('MERGE_APPROVAL_REQUIRED');
 for(const r of rows)if(!uuid.test(r.sourceId)||!uuid.test(r.targetId)||r.sourceId===r.targetId||!/^AR000-\d{6}$/.test(r.arCode)||!/^0\d{8,9}$/.test(r.sourcePhone)||!/^0\d{9}$/.test(r.primaryPhone)||r.sourcePhone===r.primaryPhone)throw Error('MERGE_IDENTITY_REFUSED');
 if(new Set(rows.flatMap(r=>[r.sourceId,r.targetId])).size!==rows.length*2)throw Error('MERGE_OVERLAPPING_COHORT');
 const literal=v=>"'"+String(v).replaceAll("'","''")+"'";
 return `BEGIN;
SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='20s';
DO $merge$
DECLARE p record;s record;t record;r record;n bigint;before_data jsonb;old_merge record;
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' THEN RAISE EXCEPTION 'MERGE_OPERATOR_REQUIRED';END IF;
 FOR p IN SELECT * FROM jsonb_to_recordset(${literal(JSON.stringify(rows))}::jsonb) AS x("sourceId" uuid,"targetId" uuid,"arCode" text,"sourcePhone" text,"primaryPhone" text) LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('approved-member-merge:'||p."sourceId"::text,0));
  SELECT * INTO old_merge FROM ada_history.member_merges WHERE source_member_id=p."sourceId";
  IF FOUND THEN
   IF old_merge.target_member_id<>p."targetId" OR old_merge.target_code<>p."arCode" OR old_merge.source_phone<>p."sourcePhone" OR old_merge.primary_phone<>p."primaryPhone" OR old_merge.approval_reference<>${literal(approvalReference)} THEN RAISE EXCEPTION 'MERGE_REPLAY_CONFLICT';END IF;
   CONTINUE;
  END IF;
  PERFORM 1 FROM public.users WHERE id IN(p."sourceId",p."targetId") ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.member_profiles WHERE user_id IN(p."sourceId",p."targetId") ORDER BY user_id FOR UPDATE;
  SELECT u.id,u.full_name,u.phone_number,m.member_code,m.is_active,m.remark INTO s FROM public.users u JOIN public.member_profiles m ON m.user_id=u.id WHERE u.id=p."sourceId";
  SELECT u.id,u.full_name,u.phone_number,m.member_code,m.is_active,m.remark INTO t FROM public.users u JOIN public.member_profiles m ON m.user_id=u.id WHERE u.id=p."targetId";
  IF s.id IS NULL OR t.id IS NULL OR NOT s.is_active OR NOT t.is_active OR s.phone_number IS DISTINCT FROM p."sourcePhone" OR t.phone_number IS DISTINCT FROM p."primaryPhone" OR t.member_code<>p."arCode" OR s.member_code NOT LIKE 'SCM-%' THEN RAISE EXCEPTION 'MERGE_PROFILE_CHANGED';END IF;
  IF NOT EXISTS(SELECT 1 FROM ada_history.member_links l JOIN ada_history.customers c USING(source_id,ada_code) WHERE l.member_id=t.id AND l.source_id='hq000/AdaAcc' AND l.ada_code=p."arCode" AND c.phone=p."primaryPhone"||';'||p."sourcePhone") THEN RAISE EXCEPTION 'MERGE_APPROVED_NATIVE_CONTACT_NOT_SYNCED';END IF;
  IF NOT EXISTS(SELECT 1 FROM ada_points.approved_owner_links l JOIN ada_points.balance_cache b ON b.ada_code=l.canonical_code WHERE l.member_id=t.id::text AND l.ada_code=p."arCode" AND b.state='ready') THEN RAISE EXCEPTION 'MERGE_ADA_POINTS_NOT_READY';END IF;
  FOR r IN SELECT ns.nspname,c.relname,a.attname FROM pg_constraint fk JOIN pg_class c ON c.oid=fk.conrelid JOIN pg_namespace ns ON ns.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=fk.conkey[1] WHERE fk.contype='f' AND fk.confrelid='public.users'::regclass AND array_length(fk.conkey,1)=1 AND (ns.nspname,c.relname) NOT IN(('public','member_profiles'),('public','crm_member_consents')) LOOP
   EXECUTE format('SELECT count(*) FROM %I.%I WHERE %I=$1',r.nspname,r.relname,r.attname) INTO n USING s.id;
   IF n<>0 THEN RAISE EXCEPTION 'MERGE_SOURCE_HAS_DEPENDENCIES: %.%',r.nspname,r.relname;END IF;
  END LOOP;
  -- Refuse any source with financial/history/assignment/medical dependencies.
  -- Keep original registration and outbound review rows as historical evidence.
  FOR r IN SELECT ns.nspname,c.relname,a.attname FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid WHERE c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped AND ns.nspname IN('public','ada_history','crm_reporting','sccrm_fanout','sccrm_member_codes','sccrm_receipt_sync','sccrm_registration') AND a.attname IN('member_id','user_id','customer_account_id') AND (ns.nspname,c.relname) NOT IN(('public','member_profiles'),('public','crm_member_consents'),('ada_history','outbound_state'),('crm_reporting','member_registrations')) LOOP
   EXECUTE format('SELECT count(*) FROM %I.%I WHERE %I::text=$1',r.nspname,r.relname,r.attname) INTO n USING s.id::text;
   IF n<>0 THEN RAISE EXCEPTION 'MERGE_SOURCE_HAS_DEPENDENCIES: %.%',r.nspname,r.relname;END IF;
  END LOOP;
  SELECT jsonb_build_object('source',to_jsonb(s),'target',to_jsonb(t),'consents',COALESCE((SELECT jsonb_agg(to_jsonb(c)) FROM public.crm_member_consents c WHERE user_id=s.id),'[]'::jsonb),'adaPoints',(SELECT to_jsonb(b) FROM ada_points.approved_owner_links l JOIN ada_points.balance_cache b ON b.ada_code=l.canonical_code WHERE l.member_id=t.id::text AND l.ada_code=p."arCode" LIMIT 1)) INTO before_data;
  INSERT INTO ada_history.member_merges(source_member_id,target_member_id,source_code,target_code,source_phone,primary_phone,approval_reference,before_state) VALUES(s.id,t.id,s.member_code,t.member_code,p."sourcePhone",p."primaryPhone",${literal(approvalReference)},before_data);
  UPDATE public.crm_member_consents SET user_id=t.id WHERE user_id=s.id;
  UPDATE public.member_profiles SET is_active=false,remark=concat_ws(E'\\n',remark,'[MERGED] '||t.member_code||' approval: '||${literal(approvalReference)}),updated_at=now() WHERE user_id=s.id;
  UPDATE public.member_profiles SET remark=concat_ws(E'\\n',remark,'[APPROVED CONTACTS] '||p."primaryPhone"||';'||p."sourcePhone"),updated_at=now() WHERE user_id=t.id;
 END LOOP;
END $merge$;
COMMIT;`;
}
module.exports={buildMergeSql};
