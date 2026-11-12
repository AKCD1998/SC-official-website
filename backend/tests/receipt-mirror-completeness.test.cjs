'use strict';
const {mirrorPlan}=require('../lib/receiptMirrorCompleteness');
const copy=v=>JSON.parse(JSON.stringify(v));
const identity={branchCode:'004',posCode:'002',receiptNo:'S2611004002-9999001',memberId:'member-one',adaCode:'AR004-999001'};
const item={seq:1,productCode:'SKU-A',qty:2,lineTotal:100,unitCode:'BOX',unitName:'กล่อง',barcode:'8850000000001'};
function fixture(){const snapshot={items:[{...item}],totalAmount:100,receiptDiscount:0};return {
 claim:{id:'claim-one',receipt_snapshot:snapshot},p:{snapshot,sourceOwned:true,hqOwned:true},
 mirror:{source_system:'AdaAcc',source_event_key:'sale:004:'+identity.receiptNo,branch_code:'004',doc_no:identity.receiptNo,doc_type:'1',pos_code:null,ada_customer_code:'0',net_total:0,paid_total:0,gross_total:100,raw_payload:{}},
 lines:[{line_no:1,product_code:'SKU-A',qty:2,net_amount:0,discount_amount:0,unit_code:'BOX',unit_name:'กล่อง',barcode:'8850000000001'}]};}
const check=v=>mirrorPlan(v.mirror,v.lines,v.claim,v.p,identity);
test('legacy zero projection requires the exact bill and confirmed member in both databases',()=>expect(check(fixture())).toMatchObject({legacyZero:true,resequence:false}));
test.each(['sourceOwned','hqOwned'])('a missing %s ownership proof cannot adopt an imported projection',field=>{const v=fixture();v.p[field]=false;expect(()=>check(v)).toThrow('RECON_MIRROR_IDENTITY_REVIEW');});
test.each([
 ['different owner',v=>{v.mirror.ada_customer_code='AR004-999999';}],
 ['different source key',v=>{v.mirror.source_event_key='sale:005:'+identity.receiptNo;}],
 ['different register',v=>{v.mirror.pos_code='001';}],
 ['other claim',v=>{v.mirror.raw_payload.loyalty_claim_id='another-claim';}],
 ['nonzero saved price',v=>{v.lines[0].net_amount=1;}],
 ['different total',v=>{v.mirror.gross_total=999;}],
 ['different person',v=>{v.mirror.raw_payload.member_id='other-member';}],
])('%s keeps a legacy projection held',(_,mutate)=>{const v=fixture();mutate(v);expect(()=>check(v)).toThrow('RECON_MIRROR_IDENTITY_REVIEW');});
test.each(['qty','barcode','unit_name'])('a conflicting %s cannot be filled over',field=>{const v=fixture();v.lines[0][field]=field==='qty'?999:'wrong';expect(()=>check(v)).toThrow('RECON_MIRROR_LINES_REVIEW');});
test('old positional rows after Void can be reindexed only with matching complete line and snapshot evidence',()=>{
 const v=fixture();v.claim.receipt_snapshot.items[0].seq=3;v.claim.receipt_snapshot.lineAdjustments={policy:'ada-exact-item-void-pairs',pairs:[{originalSeq:1,voidSeq:2}]};
 v.mirror.source_system='SCCRMonPOS';v.mirror.raw_payload={loyalty_claim_id:v.claim.id,receipt_snapshot:copy(v.claim.receipt_snapshot)};
 v.lines[0].net_amount=100;v.lines[0].raw_payload=copy(v.claim.receipt_snapshot.items[0]);
 expect(check(v)).toMatchObject({legacyZero:false,resequence:true});
 delete v.lines[0].raw_payload.seq;expect(()=>check(v)).toThrow('RECON_MIRROR_LINES_REVIEW');
});
