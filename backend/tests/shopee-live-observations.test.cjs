jest.mock('../db', () => ({ connect: jest.fn() }));
const assert = require('node:assert/strict');
const { validateBatch, mergeSnapshot, recordOrderObservations } = require('../src/modules/seamless/services/shopeeOrderObservationService');
function sample() { return {batchId:'bd353d88-9841-4a49-9310-5c4ab4246ae4',shopCode:'sc-drug-store',portalAccount:'142wuxqhgi',observedAt:'2026-10-09T03:00:00.000Z',coverage:{area:'orders',pages:1,complete:false},orders:[{orderNumber:'26100967N5NR3K',internalOrderId:'245214385221747',axes:{payment:{value:'paid',evidence:'buyer_paid_marker',page:'income_detail'}}}]}; }
test('requires identity, bounded data, unique orders and direct payment evidence',()=>{
  assert.equal(validateBatch(sample(),new Date('2026-10-09T04:00:00Z')).orders.length,1);
  for(const alter of [b=>{b.portalAccount='mu3f314od9'}, b=>{b.customerName='PII'}, b=>{b.orders[0].axes.payment.evidence='order_status'}, b=>{b.orders[0].axes.payment.page='orders'}, b=>{b.orders.push(b.orders[0])}, b=>{b.orders[0].axes.payment.extra='raw text'}, b=>{b.observedAt='2026-10-10T03:00:00Z'}]) {
    const b=sample(); alter(b); assert.throws(()=>validateBatch(b,new Date('2026-10-09T04:00:00Z')));
  }
});
test('older snapshots cannot replace new status; refunds preserve prior payment proof',()=>{
  const paid=sample().orders[0]; const initial=mergeSnapshot({},paid,'2026-10-09T03:00:00.000Z');
  const refund={axes:{refund:{value:'refunded',evidence:'refund_completed',page:'returns'}}};
  const updated=mergeSnapshot(initial,refund,'2026-10-09T04:00:00.000Z');
  assert.equal(updated.paidEvidence.value,'paid'); assert.equal(updated.refund.value,'refunded');
  const old={axes:{payment:{value:'unpaid',evidence:'unpaid_list',page:'orders'}}};
  assert.equal(mergeSnapshot(updated,old,'2026-10-09T02:00:00.000Z').payment.value,'paid');
  const cod={axes:{payment:{value:'cod_pending',evidence:'cod_method',page:'orders'}}};
  assert.equal(mergeSnapshot(updated,cod,'2026-10-09T05:00:00.000Z').payment.value,'paid');
  assert.equal(mergeSnapshot({},refund,'2026-10-09T04:00:00.000Z').paidEvidence,undefined);
});
test('return request may lack internal order ID but payment may not',()=>{
  const b=sample(); b.orders[0].internalOrderId=null;
  assert.throws(()=>validateBatch(b,new Date('2026-10-09T04:00:00Z')));
  b.orders[0].axes={refund:{value:'refunded',evidence:'refund_completed',page:'returns'}};
  assert.equal(validateBatch(b,new Date('2026-10-09T04:00:00Z')).orders[0].internalOrderId,null);
});

test('a maximum-size batch uses bounded database round trips and preserves every row',async()=>{
  const body=sample();
  body.orders=Array.from({length:500},(_,i)=>({...structuredClone(body.orders[0]),orderNumber:`261009BATCH${String(i).padStart(4,'0')}`,internalOrderId:String(245214385221747+i)}));
  const calls=[];
  const client={query:async(sql,params)=>{calls.push({sql,params});return {rows:[]}},release:jest.fn()};
  const result=await recordOrderObservations({body,dbPool:{connect:async()=>client},now:new Date('2026-10-09T04:00:00Z')});
  assert.equal(result.count,500);
  assert.ok(calls.length<=8,'database work must not scale to per-order network round trips');
  const writes=calls.filter(call=>call.sql.includes('jsonb_to_recordset'));
  assert.equal(writes.length,2);
  assert.equal(JSON.parse(writes[0].params[2]).length,500);
  assert.equal(JSON.parse(writes[1].params[2]).length,500);
  assert.equal(JSON.parse(writes[0].params[2])[499].snapshot.paidEvidence.value,'paid');
  assert.equal(calls.at(-1).sql,'COMMIT');
  expect(client.release).toHaveBeenCalledTimes(1);
});

test('identity conflict in a bulk batch rolls back before any live snapshot write',async()=>{
  const body=sample(); const calls=[];
  const client={query:async(sql,params)=>{calls.push({sql,params});return {rows:sql.startsWith('SELECT order_number')?[{order_number:body.orders[0].orderNumber,internal_order_id:'999999999999999',snapshot:{}}]:[]}},release:jest.fn()};
  await assert.rejects(()=>recordOrderObservations({body,dbPool:{connect:async()=>client},now:new Date('2026-10-09T04:00:00Z')}),/identity changed/);
  assert.equal(calls.at(-1).sql,'ROLLBACK');
  assert.equal(calls.some(call=>call.sql.includes('jsonb_to_recordset')),false);
  expect(client.release).toHaveBeenCalledTimes(1);
});
