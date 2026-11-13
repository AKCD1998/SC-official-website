'use strict';
// Offline operator only. An explicit confirmed family joins existing Ada owners;
// the normal HQ worker publishes unowned existing AR links. No native/point SQL.
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const AR=/^AR(?:000|001|003|004|005)-\d{6}$/;
function buildExistingArMergeSql(families,approval){
 if(!Array.isArray(families)||!families.length||families.length>10||typeof approval!=='string'||!approval.trim()||approval.length>500)throw Error('EXISTING_AR_APPROVAL_REQUIRED');
 const members=new Set(),codes=new Set();
 for(const f of families){
  if(!UUID.test(f.member_id)||!AR.test(f.primary_code)||!/^0\d{9}$/.test(f.phone)||typeof f.current_code!=='string'||!Array.isArray(f.native_codes)||!f.native_codes.length||!Array.isArray(f.retire_members))throw Error('EXISTING_AR_PLAN_REFUSED');
  for(const id of [f.member_id,...f.retire_members.map(r=>r.id)]){if(!UUID.test(id)||members.has(id))throw Error('EXISTING_AR_OVERLAPPING_MEMBERS');members.add(id);}
  if(!f.native_codes.some(n=>n.code===f.primary_code))throw Error('EXISTING_AR_PRIMARY_MISSING');
  for(const n of f.native_codes){if(!AR.test(n.code)||codes.has(n.code)||!(/^[a-f0-9]{64}$/.test(n.hash))||(n.owner!==null&&!UUID.test(n.owner)))throw Error('EXISTING_AR_NATIVE_REFUSED');codes.add(n.code);if(n.owner&&n.owner!==f.member_id&&!f.retire_members.some(r=>r.id===n.owner&&r.stub))throw Error('EXISTING_AR_OWNER_NOT_APPROVED');}
  for(const r of f.retire_members)if(typeof r.code!=='string'||(r.stub?r.phone!==null:r.phone!==f.phone))throw Error('EXISTING_AR_RETIREMENT_REFUSED');
 }
 const lit=v=>"'"+String(v).replaceAll("'","''")+"'";
 return `BEGIN;SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='25s';
DO $approved$ DECLARE f record;c record;r record;s record;t record;dep record;n bigint;owner uuid;old_ref text;before_data jsonb;
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' THEN RAISE EXCEPTION 'EXISTING_AR_OPERATOR_REQUIRED';END IF;
 FOR f IN SELECT * FROM jsonb_to_recordset(${lit(JSON.stringify(families))}::jsonb) AS x(member_id uuid,primary_code text,current_code text,phone text,native_codes jsonb,retire_members jsonb) LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('ada-link-member:'||f.member_id::text,0));
  SELECT u.id,u.full_name,u.phone_number,m.member_code,m.is_active,m.contact_phone,m.remark INTO t FROM users u JOIN member_profiles m ON m.user_id=u.id WHERE u.id=f.member_id FOR UPDATE OF u,m;
  IF t.id IS NULL OR NOT t.is_active OR t.member_code<>f.current_code OR (t.phone_number IS NOT NULL AND t.phone_number<>f.phone) OR(t.contact_phone IS NOT NULL AND t.contact_phone<>f.phone) THEN RAISE EXCEPTION 'EXISTING_AR_TARGET_CHANGED';END IF;
  IF EXISTS(SELECT 1 FROM sccrm_member_codes.assignments WHERE member_id=f.member_id) THEN RAISE EXCEPTION 'EXISTING_AR_ASSIGNED_TARGET_REVIEW';END IF;
  IF EXISTS(SELECT 1 FROM ada_history.member_links l WHERE l.member_id=f.member_id AND(l.source_id<>'hq000/AdaAcc' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(f.native_codes) j WHERE j->>'code'=l.ada_code))) THEN RAISE EXCEPTION 'EXISTING_AR_EXTRA_TARGET_LINK';END IF;
  FOR c IN SELECT * FROM jsonb_to_recordset(f.native_codes) AS x(code text,hash text,owner uuid) LOOP
   PERFORM pg_advisory_xact_lock(hashtextextended('ada-link-code:hq000/AdaAcc:'||c.code,0));
   IF NOT EXISTS(SELECT 1 FROM ada_history.customers a WHERE a.source_id='hq000/AdaAcc' AND a.ada_code=c.code AND a.payload_hash=c.hash AND a.active='1' AND regexp_replace(a.phone,'[^0-9]','','g')=f.phone) THEN RAISE EXCEPTION 'EXISTING_AR_NATIVE_CHANGED';END IF;
   IF NOT EXISTS(SELECT 1 FROM ada_points.balance_cache b WHERE b.ada_code=c.code AND b.state='ready' AND b.observed_at>now()-interval '10 minutes') THEN RAISE EXCEPTION 'EXISTING_AR_POINTS_NOT_READY';END IF;
   owner=NULL;SELECT member_id INTO owner FROM ada_history.member_links WHERE source_id='hq000/AdaAcc' AND ada_code=c.code FOR UPDATE;
   IF owner IS DISTINCT FROM c.owner THEN RAISE EXCEPTION 'EXISTING_AR_OWNER_CHANGED';END IF;
  END LOOP;
  FOR r IN SELECT * FROM jsonb_to_recordset(f.retire_members) AS x(id uuid,code text,phone text,stub boolean) LOOP
   PERFORM pg_advisory_xact_lock(hashtextextended('ada-link-member:'||r.id::text,0));
   SELECT u.id,u.full_name,u.phone_number,u.email,u.is_verified,(u.password_hash IS NOT NULL) has_login,m.member_code,m.is_active,m.remark INTO s FROM users u JOIN member_profiles m ON m.user_id=u.id WHERE u.id=r.id FOR UPDATE OF u,m;
   IF s.id IS NULL OR NOT s.is_active OR s.member_code<>r.code OR s.phone_number IS DISTINCT FROM r.phone OR(r.stub AND(s.email IS NOT NULL OR s.is_verified OR s.has_login)) THEN RAISE EXCEPTION 'EXISTING_AR_SOURCE_CHANGED';END IF;
   IF EXISTS(SELECT 1 FROM ada_history.member_merges WHERE source_member_id=r.id OR target_member_id=r.id) THEN RAISE EXCEPTION 'EXISTING_AR_PRIOR_MERGE_REVIEW';END IF;
   IF EXISTS(SELECT 1 FROM ada_history.member_links l WHERE l.member_id=r.id AND(l.source_id<>'hq000/AdaAcc' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(f.native_codes) j WHERE j->>'code'=l.ada_code AND(j->>'owner')::uuid=r.id))) THEN RAISE EXCEPTION 'EXISTING_AR_EXTRA_SOURCE_LINK';END IF;
   FOR dep IN SELECT ns.nspname,cl.relname,a.attname FROM pg_constraint fk JOIN pg_class cl ON cl.oid=fk.conrelid JOIN pg_namespace ns ON ns.oid=cl.relnamespace JOIN pg_attribute a ON a.attrelid=cl.oid AND a.attnum=fk.conkey[1] WHERE fk.contype='f' AND fk.confrelid='public.users'::regclass AND array_length(fk.conkey,1)=1 AND(ns.nspname,cl.relname) NOT IN(('public','member_profiles'),('public','crm_member_consents')) LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I WHERE %I=$1',dep.nspname,dep.relname,dep.attname) INTO n USING r.id;
    IF n<>0 THEN RAISE EXCEPTION 'EXISTING_AR_SOURCE_HAS_DATA: %.%',dep.nspname,dep.relname;END IF;
   END LOOP;
   FOR dep IN SELECT ns.nspname,cl.relname,a.attname FROM pg_class cl JOIN pg_namespace ns ON ns.oid=cl.relnamespace JOIN pg_attribute a ON a.attrelid=cl.oid WHERE cl.relkind='r' AND a.attnum>0 AND NOT a.attisdropped AND ns.nspname IN('public','ada_history','crm_reporting','sccrm_fanout','sccrm_member_codes','sccrm_receipt_sync','sccrm_registration') AND a.attname IN('member_id','user_id','customer_account_id') AND(ns.nspname,cl.relname) NOT IN(('public','member_profiles'),('public','crm_member_consents'),('ada_history','member_links'),('ada_history','outbound_state'),('crm_reporting','member_registrations')) LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I WHERE %I::text=$1',dep.nspname,dep.relname,dep.attname) INTO n USING r.id::text;
    IF n<>0 THEN RAISE EXCEPTION 'EXISTING_AR_SOURCE_HAS_DATA: %.%',dep.nspname,dep.relname;END IF;
   END LOOP;
   SELECT jsonb_build_object('source',to_jsonb(s),'target',to_jsonb(t),'nativeCodes',f.native_codes,'links',(SELECT jsonb_agg(to_jsonb(l)) FROM ada_history.member_links l WHERE l.member_id IN(r.id,f.member_id)),'consents',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM crm_member_consents x WHERE user_id=r.id),'[]'::jsonb),'adaBalances',(SELECT jsonb_agg(to_jsonb(b)) FROM ada_points.balance_cache b WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(f.native_codes) j WHERE j->>'code'=b.ada_code))) INTO before_data;
   INSERT INTO ada_history.member_merges(source_member_id,target_member_id,source_code,target_code,source_phone,primary_phone,approval_reference,before_state) VALUES(r.id,f.member_id,r.code,f.primary_code,COALESCE(s.phone_number,f.phone),f.phone,${lit(approval)},before_data);
   UPDATE crm_member_consents SET user_id=f.member_id WHERE user_id=r.id;
   UPDATE member_profiles SET is_active=false,remark=concat_ws(E'\\n',remark,'[MERGED EXISTING AR] '||f.primary_code||' approval: '||${lit(approval)}),updated_at=now() WHERE user_id=r.id;
  END LOOP;
  FOR c IN SELECT * FROM jsonb_to_recordset(f.native_codes) AS x(code text,hash text,owner uuid) LOOP
   IF c.owner IS NULL THEN
    INSERT INTO ada_history.member_links(member_id,source_id,ada_code,approval_reference) VALUES(f.member_id,'hq000/AdaAcc',c.code,jsonb_build_object('scope','OWNER-CONFIRMED-EXISTING-AR','approval',${lit(approval)},'memberId',f.member_id,'nativeHash',c.hash,'nativeWrites',0)::text);
   ELSIF c.owner<>f.member_id THEN
    UPDATE ada_history.member_links SET member_id=f.member_id,approval_reference=jsonb_build_object('scope','OWNER-CONFIRMED-EXISTING-AR','approval',${lit(approval)},'previousMemberId',c.owner,'previousApproval',approval_reference,'memberId',f.member_id,'nativeWrites',0)::text WHERE source_id='hq000/AdaAcc' AND ada_code=c.code AND member_id=c.owner;
   END IF;
  END LOOP;
  IF f.current_code='ADA-'||f.primary_code THEN
   IF EXISTS(SELECT 1 FROM member_profiles WHERE member_code=f.primary_code AND user_id<>f.member_id) THEN RAISE EXCEPTION 'EXISTING_AR_CODE_COLLISION';END IF;
   UPDATE member_profiles SET member_code=f.primary_code WHERE user_id=f.member_id;
  ELSIF f.current_code<>f.primary_code AND f.current_code<>'SCM-'||upper(left(replace(f.member_id::text,'-',''),8)) THEN RAISE EXCEPTION 'EXISTING_AR_PUBLICATION_REQUIRED';END IF;
  UPDATE member_profiles SET contact_phone=CASE WHEN t.phone_number IS NULL THEN f.phone ELSE contact_phone END,updated_at=now() WHERE user_id=f.member_id;
 END LOOP;
END $approved$;COMMIT;`;
}
module.exports={buildExistingArMergeSql};
