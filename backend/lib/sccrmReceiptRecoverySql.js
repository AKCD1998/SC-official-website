'use strict';
// Exact SQL used in copy acceptance and the operator's bounded live repair.
// No public endpoint, no SECURITY DEFINER, no sale/point creation.
const {validate,hash}=require('./sccrmReceiptFinalRevision');
const literal=v=>"'"+JSON.stringify(v).replaceAll("'","''")+"'::jsonb";
function build(before,packet){
 validate(packet);
 if(before.claim.id!==packet.claimId||before.job.state!=='review'||before.deliveries.length!==2)throw Error('RECEIPT_RECOVERY_BASELINE');
 const importedZero=before.mirrors.length===1&&before.mirrors[0].header.source_system==='AdaAcc'
  &&before.mirrors[0].header.branch_code===packet.branchCode&&before.mirrors[0].header.doc_no===packet.receiptNo
  &&(before.mirrors[0].header.pos_code===packet.posCode||before.mirrors[0].header.pos_code===null)&&Number(before.mirrors[0].header.net_total)===0
  &&['0','',null].includes(before.mirrors[0].header.ada_customer_code)
  &&before.mirrors[0].items.every(l=>Number(l.net_amount)===0);
 if(before.mirrors.length!==1||(!importedZero&&before.mirrors[0].header.raw_payload?.loyalty_claim_id!==packet.claimId)
  ||before.mirrors[0].items.some(l=>{
   const i=packet.finalSnapshot.items.find(i=>i.seq===l.line_no);
   return !i||l.product_code!==i.productCode||Number(l.qty)!==i.qty||(!importedZero&&Number(l.net_amount)!==i.lineTotal)
    ||(l.unit_code||null)!==i.unitCode||(l.unit_name||null)!==i.unitName||(l.barcode||null)!==i.barcode;
  }))throw Error('RECEIPT_RECOVERY_MIRROR_LINES');
 const deliveries=before.deliveries.map(d=>({...d,revision:1}));
 return `BEGIN;SET LOCAL lock_timeout='2s';SET LOCAL TIME ZONE 'UTC';
DO $recovery$
DECLARE p jsonb:=${literal(packet)};b jsonb:=${literal(before)};lc public.loyalty_claims%ROWTYPE;j sccrm_receipt_sync.jobs%ROWTYPE;
 old_items jsonb;old_deliveries jsonb;mirrors jsonb;old_mirror public.crm_pos_sale_events%ROWTYPE;mirror_lines jsonb;
 d sccrm_receipt_sync.native_deliveries%ROWTYPE;item jsonb;new_id uuid;body jsonb;recovery_digest text:='${hash(packet)}';old_count int;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('ada-points-receipt:'||(p->>'branchCode')||':'||(p->>'receiptNo'),0));
 SELECT * INTO lc FROM public.loyalty_claims WHERE id=p->>'claimId' FOR UPDATE;
 SELECT * INTO j FROM sccrm_receipt_sync.jobs WHERE claim_id=lc.id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM sccrm_receipt_sync.final_revisions WHERE claim_id=lc.id AND revision=2 AND final_revisions.packet_hash=recovery_digest) THEN RETURN;END IF;
 IF to_jsonb(lc) IS DISTINCT FROM b->'claim' OR to_jsonb(j) IS DISTINCT FROM b->'job'
  OR lc.user_id::text<>p->>'memberId' OR j.member_id::text<>p->>'memberId' OR lc.receipt_no<>p->>'receiptNo'
  OR lc.branch_code<>p->>'branchCode' OR j.origin_pos<>p->>'posCode' OR j.state<>'review' OR j.last_code<>'ADA_RECEIPT_REQUIRES_REVIEW'
 THEN RAISE EXCEPTION 'RECEIPT_RECOVERY_STALE_IDENTITY';END IF;
 PERFORM 1 FROM public.member_profiles WHERE user_id=lc.user_id::uuid FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM public.member_profiles m JOIN ada_history.member_links ml ON ml.member_id=m.user_id
  WHERE m.user_id=lc.user_id::uuid AND ml.source_id='hq000/AdaAcc' AND ml.ada_code=p->>'adaCode'
  AND CASE WHEN left(m.member_code,4)='ADA-' THEN substring(m.member_code from 5) ELSE m.member_code END=p->>'adaCode')
 THEN RAISE EXCEPTION 'RECEIPT_RECOVERY_MEMBER_LINK';END IF;
 PERFORM 1 FROM sccrm_receipt_sync.native_deliveries WHERE parent_id=j.id ORDER BY target_branch FOR UPDATE;
 SELECT jsonb_agg(to_jsonb(x) ORDER BY target_branch) INTO old_deliveries FROM sccrm_receipt_sync.native_deliveries x WHERE parent_id=j.id;
 IF old_deliveries IS DISTINCT FROM ${literal(deliveries)} OR EXISTS(SELECT 1 FROM sccrm_receipt_sync.native_deliveries WHERE parent_id=j.id
   AND(state<>'review' OR revision<>1 OR last_code NOT IN('RECEIPT_ITEMS_CHANGED','RECEIPT_FINANCIAL_HEADER_CHANGED')
   OR payload->>'memberId'<>p->>'memberId' OR payload->>'adaCode'<>p->>'adaCode'))
 THEN RAISE EXCEPTION 'RECEIPT_RECOVERY_ACTIVE_OR_APPLIED';END IF;
 SELECT jsonb_agg(to_jsonb(i) ORDER BY created_at,id) INTO old_items FROM public.loyalty_claim_items i WHERE claim_id=lc.id;
 IF old_items IS DISTINCT FROM b->'items' THEN RAISE EXCEPTION 'RECEIPT_RECOVERY_CLAIM_LINES';END IF;
 PERFORM 1 FROM public.crm_pos_sale_events WHERE branch_code=lc.branch_code AND doc_no=lc.receipt_no FOR UPDATE;
 SELECT * INTO STRICT old_mirror FROM public.crm_pos_sale_events WHERE branch_code=lc.branch_code AND doc_no=lc.receipt_no;
 SELECT jsonb_agg(to_jsonb(l) ORDER BY line_no) INTO mirror_lines FROM public.crm_pos_sale_line_events l WHERE sale_event_id=old_mirror.id;
 mirrors:=jsonb_build_array(jsonb_build_object('header',to_jsonb(old_mirror),'items',mirror_lines));
 IF mirrors IS DISTINCT FROM b->'mirrors' OR (NOT ${importedZero} AND old_mirror.raw_payload->>'loyalty_claim_id' IS DISTINCT FROM lc.id) THEN RAISE EXCEPTION 'RECEIPT_RECOVERY_MIRROR_CHANGED';END IF;
 INSERT INTO sccrm_receipt_sync.final_revisions(claim_id,revision,job_id,member_id,branch_code,pos_code,receipt_no,original_claim,
  original_items,original_mirror,final_snapshot,native_proof,packet_hash)
 VALUES(lc.id,2,j.id,j.member_id,j.origin_branch,j.origin_pos,lc.receipt_no,to_jsonb(lc),old_items,mirrors,p->'finalSnapshot',p->'nativeProof',recovery_digest);
 old_count:=jsonb_array_length(p#>'{originalSnapshot,items}');
 FOR item IN SELECT value FROM jsonb_array_elements(p#>'{finalSnapshot,items}') WITH ORDINALITY a(value,n) WHERE n>old_count LOOP
  INSERT INTO public.loyalty_claim_items(id,claim_id,product_code,product_name,qty,unit_price,line_total)
  VALUES(gen_random_uuid()::text,lc.id,item->>'productCode',item->>'productName',(item->>'qty')::numeric,(item->>'unitPrice')::numeric,(item->>'lineTotal')::numeric);
  IF NOT EXISTS(SELECT 1 FROM public.crm_pos_sale_line_events WHERE sale_event_id=old_mirror.id AND line_no=(item->>'seq')::int) THEN
  INSERT INTO public.crm_pos_sale_line_events(id,sale_event_id,line_no,product_code,barcode,qty,unit_code,unit_name,net_amount,discount_amount,raw_payload)
  VALUES(gen_random_uuid(),old_mirror.id,(item->>'seq')::int,item->>'productCode',item->>'barcode',(item->>'qty')::numeric,item->>'unitCode',item->>'unitName',
   (item->>'lineTotal')::numeric,COALESCE((item->>'lineDiscount')::numeric,0),item);
  END IF;
 END LOOP;
 UPDATE public.crm_pos_sale_line_events l SET net_amount=(i.value->>'lineTotal')::numeric,
  discount_amount=COALESCE((i.value->>'lineDiscount')::numeric,0),raw_payload=l.raw_payload||i.value||jsonb_build_object('native_final_recovery',true)
  FROM jsonb_array_elements(p#>'{finalSnapshot,items}') i(value)
  WHERE ${importedZero} AND l.sale_event_id=old_mirror.id AND l.line_no=(i.value->>'seq')::int AND l.net_amount=0;
 UPDATE public.loyalty_claims SET receipt_total_amount=(p#>>'{finalSnapshot,totalAmount}')::numeric,receipt_snapshot=p->'finalSnapshot' WHERE id=lc.id;
 UPDATE public.crm_pos_sale_events SET pos_code=p->>'posCode',net_total=(p#>>'{finalSnapshot,totalAmount}')::numeric,paid_total=(p#>>'{finalSnapshot,totalAmount}')::numeric,
  gross_total=(p#>>'{finalSnapshot,totalAmount}')::numeric+(p#>>'{finalSnapshot,receiptDiscount}')::numeric,
  raw_payload=raw_payload||jsonb_build_object('loyalty_claim_id',lc.id,'receipt_snapshot',p->'finalSnapshot','native_final_recovery',true),updated_at=now() WHERE id=old_mirror.id;
 FOR d IN SELECT * FROM sccrm_receipt_sync.native_deliveries WHERE parent_id=j.id AND revision=1 LOOP
  new_id:=gen_random_uuid();body:=d.payload||jsonb_build_object('operationId',new_id,'totalAmount',p#>'{finalSnapshot,totalAmount}','items',p#>'{finalSnapshot,items}','lineAdjustments',NULL);
  INSERT INTO sccrm_receipt_sync.native_deliveries(id,parent_id,target_branch,payload,payload_hash,revision)
   VALUES(new_id,j.id,d.target_branch,body,encode(sha256(convert_to(body::text,'UTF8')),'hex'),2);
 END LOOP;
 UPDATE sccrm_receipt_sync.jobs SET state='pending',last_code='ADA_FINAL_SNAPSHOT_RECOVERED',next_attempt_at=now(),lease_token=NULL,lease_until=NULL,
  completed_at=NULL,updated_at=now() WHERE id=j.id;
 INSERT INTO sccrm_receipt_sync.events(job_id,state,code)VALUES(j.id,'pending','ADA_FINAL_SNAPSHOT_RECOVERED');
END $recovery$;
COMMIT;
SELECT claim_id,revision,packet_hash FROM sccrm_receipt_sync.final_revisions WHERE claim_id=(${literal({claimId:packet.claimId})}->>'claimId') AND revision=2;`;
}
module.exports={build};
