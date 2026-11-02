const express=require('express');
const request=require('supertest');
jest.mock('../db',()=>({query:jest.fn(),connect:jest.fn()}));
jest.mock('@sendgrid/mail',()=>({setApiKey:jest.fn(),send:jest.fn()}));
const pool=require('../db');
const {issueCustomerAccessToken}=require('../lib/sccrm');
const id='11111111-1111-4111-8111-111111111111';
const other='22222222-2222-4222-8222-222222222222';
const code='AR005-000001',receipt='S2610005001-000001';
let state,calls,staffBranch,locks;
const result=rows=>({rows,rowCount:rows.length});
const compact=sql=>String(sql).replace(/\s+/g,' ').trim();

// Transactional in-memory adapter exercises real routes and real authority /
// ownership helpers. The advisory-lock emulation lets two HTTP claim channels
// race and observe the preceding committed owner, as READ COMMITTED does.
async function execute(sql,params=[],tx=null) {
  const text=compact(sql);calls.push({text,params,transaction:Boolean(tx)});
  if(text==='BEGIN') return result([]);
  if(text==='COMMIT'||text==='ROLLBACK') {
    if(text==='COMMIT') for(const action of tx.pending)action();
    tx.pending=[];for(const release of tx.releases)release();tx.releases=[];return result([]);
  }
  if(text.startsWith('SELECT pg_advisory_xact_lock')) {
    const key=params[0],previous=locks.get(key)||Promise.resolve();let release;
    const waiting=new Promise(resolve=>{release=resolve;});locks.set(key,previous.then(()=>waiting));
    await previous;tx.releases.push(release);return result([]);
  }
  if(text.includes('SELECT sd.id'))return result([{id:'device-fixture',device_id:'POS-FIXTURE',branch_code:staffBranch,branch_id:null}]);
  if(text.startsWith('UPDATE staff_devices SET last_seen_at'))return result([]);
  if(text.includes("to_regclass('public.point_ledger')"))return result([{points_available:true,pharmacy_available:false}]);
  if(text.startsWith('WITH requested')&&text.includes('balance_cache'))return result(params[0].map(member=>({member_id:member,resolved_code:code,cache_code:code,
    balance_exact:state.balance,observed_at:state.observed,state:state.cacheState})));
  if(text.includes('FROM requested r LEFT JOIN ada_points.native_events'))return result(params[0].flatMap((branch,index)=>
    state.events.length?state.events.map(event=>({branch_code:branch,doc_no:params[1][index],...event})):[{branch_code:branch,doc_no:params[1][index],event_key:null}]));
  if(text.includes('FROM ada_points.native_events'))return result(state.events);
  if(text.startsWith('SELECT user_id::text AS owner_id FROM public.loyalty_claims'))return result([
    ...state.claims.filter(c=>c.branch===params[0]&&c.receipt===params[1]),
    ...state.mobileClaims.filter(c=>c.branch===params[0]&&c.receipt===params[1]),
    ...state.awards.filter(c=>c.branch===params[0]&&c.receipt===params[1]),
    ...state.transactions.filter(c=>c.receipt===params[1]),
  ].map(c=>({owner_id:c.member})));
  if(text.startsWith('SELECT saved.id,saved.created_at,saved.user_id'))return result([
    ...state.claims.filter(c=>c.branch===params[0]&&c.receipt===params[1]),
    ...state.mobileClaims.filter(c=>c.branch===params[0]&&c.receipt===params[1]),
    ...state.awards.filter(c=>c.branch===params[0]&&c.receipt===params[1]),
    ...state.transactions.filter(c=>c.receipt===params[1]),
  ].map(c=>({id:c.id||'stored-claim',created_at:'2026-11-02T02:00:00Z',user_id:c.member,full_name:'Stored native member',member_code:code})));
  if(text.startsWith('SELECT r.doc_no, r.grand_total'))return result(state.nativeReceipt?[state.nativeReceipt]:[]);
  if(text.startsWith('SELECT user_id FROM member_profiles'))return result([{user_id:params[0]}]);
  if(text.startsWith('SELECT id FROM loyalty_claims'))return result(state.claims.map(c=>({id:c.id})));
  if(text.includes('FROM users u JOIN member_profiles m'))return result([{id:/^[a-f0-9-]{36}$/.test(params[0]||'')?params[0]:id,full_name:'Synthetic member',phone:'0990000001',member_code:code,is_active:true,current_points:null,tier:'bronze'}]);
  if(text.startsWith('SELECT tier FROM member_profiles'))return result([{tier:'bronze'}]);
  if(text.startsWith('SELECT id FROM public.users'))return result([{id:params[0]}]);
  if(text.startsWith('INSERT INTO loyalty_claims')) {
    tx.pending.push(()=>state.claims.push({id:params[0],receipt:params[1],branch:params[2],member:params[8],points:params[7],snapshot:JSON.parse(params[12])}));return result([]);
  }
  if(text.startsWith('INSERT INTO loyalty_claim_items')) {
    if(state.failLine)throw Error('Synthetic line insert failure');
    tx.pending.push(()=>state.lines.push(params));return result([]);
  }
  if(text.startsWith('SELECT id FROM crm_pos_sale_events'))return result([{id:'sale-fixture'}]);
  if(text.startsWith('INSERT INTO crm_pos_sale_events')||text.startsWith('DELETE FROM crm_pos_sale_line_events')||text.startsWith('INSERT INTO crm_pos_sale_line_events'))return result([]);
  if(text.startsWith('SELECT t.id AS claim_token_id'))return result([{
    claim_token_id:'token-fixture',sale_event_id:'sale-fixture',sale_branch_code:'005',sale_doc_no:receipt,
    expires_at:new Date(Date.now()+60000),paid_total:388,used_at:null,claim_id:null,
  }]);
  if(text.startsWith('UPDATE crm_sale_claim_tokens')||text.startsWith('UPDATE crm_pos_sale_events'))return result([]);
  if(text.startsWith('INSERT INTO crm_sale_claims')) {
    tx.pending.push(()=>state.mobileClaims.push({id:params[0],receipt,branch:'005',member:params[2]}));return result([]);
  }
  if(text.startsWith('INSERT INTO transactions')) {
    tx.pending.push(()=>state.transactions.push({id:params[0],member:params[1],total:params[2],points:params[3],receipt:params[5],createdAt:params[8]}));return result([]);
  }
  if(text.startsWith('SELECT c.id AS claim_id'))return result([{
    claim_id:'claim-fixture',sale_event_id:'sale-fixture',doc_no:receipt,branch_code:'005',points_awarded:807,
  }]);
  if(text.startsWith('SELECT refund_doc_no')||text.startsWith('SELECT line_no, product_code'))return result([]);
  if(text.startsWith('SELECT id, receipt_no, branch_code'))return result(state.claims.map(claim=>({id:claim.id,receipt_no:claim.receipt,branch_code:claim.branch,
    awarded_points:claim.points,total_amount:388,receipt_snapshot:claim.snapshot,sold_at:'2026-11-02T02:00:00Z',created_at:'2026-11-02T02:00:00Z'})));
  if(text.startsWith('SELECT claim_id, product_code')||text.startsWith('SELECT r.id, r.branch_code'))return result([]);
  throw Error(`Unexpected SQL: ${text}`);
}
function app(){const a=express();a.use(express.json());a.use('/loyalty',require('../routes/loyalty'));
  a.use('/sccrm',require('../routes/sccrm'));a.use('/sccrm',require('../routes/centralPromotions'));return a;}
function staffClaim(member=id){return request(app()).post('/loyalty/claims').set('Authorization','Bearer staff-fixture').send({
  receiptNo:receipt,branchCode:'005',memberId:member,totalAmount:388,previewPoints:999,
  soldAt:'2026-11-02T02:00:00.000Z',items:[{productCode:'SKU-FIXTURE',productName:'Synthetic product',qty:1,unitPrice:388,lineTotal:388,unitCode:'BOX',unitName:'กล่อง'}],
});}
function customerToken(member=id){return issueCustomerAccessToken({id:member,phone:null,email:null});}
function mobileClaim(member=id){return request(app()).post('/sccrm/claims/confirm').set('Authorization','Bearer '+customerToken(member)).send({claim_token:'synthetic-token'});}
function manualClaim(member=id,reference=receipt){return request(app()).post('/sccrm/points/earn').set('Authorization','Bearer staff-fixture').send({customer_id:member,reference_id:reference,amount_thb:999999});}
function forbiddenWrites(){return calls.filter(({text})=>/^(INSERT INTO (point_ledger|crm_loyalty_awards|redemptions)|UPDATE member_profiles SET tier|UPDATE ada_points|INSERT INTO ada_points|DELETE FROM ada_points)/i.test(text));}
beforeEach(()=>{
  process.env.SC_OFFICIAL_ADA_POINTS_MODE='ada-primary';process.env.SCCRM_ACCESS_JWT_SECRET='synthetic-route-test-secret';
  process.env.SCCRM_REFRESH_TOKEN_SECRET='synthetic-route-test-refresh';delete process.env.SC_OFFICIAL_ADA_SYNC_ENABLED;
  calls=[];locks=new Map();staffBranch='005';
  state={balance:'51.5',observed:new Date(),cacheState:'ready',claims:[],mobileClaims:[],awards:[],transactions:[],lines:[],
    nativeReceipt:{doc_no:receipt,total_amount:'388.00',sold_at:'2026-11-02T02:00:00.000Z',owner_id:id},
    events:[{event_key:'a'.repeat(64),ada_code:code,card_type:'1',points_exact:'3',state:'ready',active:true,owner_member_id:id}]};
  pool.query.mockReset().mockImplementation((sql,params)=>execute(sql,params));
  pool.connect.mockReset().mockImplementation(async()=>{
    const tx={pending:[],releases:[]};return {query:(sql,params)=>execute(sql,params,tx),release:jest.fn()};
  });
});
afterEach(()=>{delete process.env.SC_OFFICIAL_ADA_POINTS_MODE;delete process.env.SCCRM_ACCESS_JWT_SECRET;delete process.env.SCCRM_REFRESH_TOKEN_SECRET;});

test('staff scan preserves receipt header/items and reads Ada award without re-credit or tier mutation',async()=>{
  const response=await staffClaim();expect(response.status).toBe(201);
  expect(response.body).toMatchObject({awardedPoints:3,newPointsBalance:51.5,balanceExact:'51.5',pointsSource:'ada',pointsStatus:'recorded_by_ada',historyRecorded:true,pointsCredited:false});
  expect(state.claims).toHaveLength(1);expect(state.lines).toHaveLength(1);
  expect(state.claims[0]).toMatchObject({member:id,points:3,snapshot:{pointsPolicy:'ada-native-recorded',items:[{unitName:'กล่อง',productCode:'SKU-FIXTURE'}]}});
  expect(forbiddenWrites()).toEqual([]);
  expect(calls.some(({text})=>/FROM point_ledger|SUM\(pl.amount\)|FROM promotions/.test(text))).toBe(false);
});
test('bill without native award records history with explicit zero and no promise of future points',async()=>{
  state.events=[];state.nativeReceipt=null;
  const response=await staffClaim();expect(response.status).toBe(201);
  expect(response.body).toMatchObject({awardedPoints:0,pointsStatus:'not_recorded_by_ada',pointsCredited:false});
  expect(forbiddenWrites()).toEqual([]);
});
test.each(['staff-first','mobile-first','manual-first'])('shared ownership guard blocks duplicates across methods: %s',async order=>{
  const first=order==='staff-first'?await staffClaim():order==='mobile-first'?await mobileClaim():await manualClaim();
  expect(first.status).toBe(201);
  const attempts=await Promise.all([staffClaim(),mobileClaim(),manualClaim()]);
  expect(attempts.map(r=>r.status)).toEqual([409,409,409]);
  expect(state.claims.length+state.mobileClaims.length+state.transactions.length).toBe(1);
  expect(forbiddenWrites()).toEqual([]);
});
test('native award may precede history scan; racing staff/mobile methods save exactly one history owner',async()=>{
  const responses=await Promise.all([staffClaim(),mobileClaim()]);
  expect(responses.map(r=>r.status).sort()).toEqual([201,409]);
  expect(state.claims.length+state.mobileClaims.length).toBe(1);expect(forbiddenWrites()).toEqual([]);
});
test('a previously claimed different owner cannot be silently reassigned',async()=>{
  state.mobileClaims.push({branch:'005',receipt,member:other});
  const response=await staffClaim();expect(response.status).toBe(409);expect(response.body.code).toBe('BILL_OWNER_CONFLICT');
  expect(state.claims).toHaveLength(0);expect(forbiddenWrites()).toEqual([]);
});
test('a different native receipt owner fails before history or points writes',async()=>{
  state.nativeReceipt.owner_id=other;
  const response=await staffClaim();expect(response.status).toBe(409);expect(response.body.code).toBe('BILL_OWNER_CONFLICT');
  expect(state.claims).toHaveLength(0);expect(forbiddenWrites()).toEqual([]);
});
test.each(['stale','unknown','review'])('unavailable %s native authority rolls back instead of storing zero',async reason=>{
  if(reason==='stale')state.observed=new Date(Date.now()-121000);
  if(reason==='review')state.events[0].state='review';
  if(reason==='unknown')state.cacheState='pending';
  const response=await staffClaim();expect(response.status).toBe(reason==='review'?409:503);
  expect(state.claims).toHaveLength(0);expect(state.lines).toHaveLength(0);
  expect(calls.some(c=>c.text==='ROLLBACK')).toBe(true);expect(forbiddenWrites()).toEqual([]);
});
test('failed item insert rolls back header and releases bill lock for a successful retry',async()=>{
  state.failLine=true;expect((await staffClaim()).status).toBe(500);
  expect(state.claims).toHaveLength(0);expect(state.lines).toHaveLength(0);
  state.failLine=false;expect((await mobileClaim()).status).toBe(201);
  expect(state.mobileClaims).toHaveLength(1);expect(forbiddenWrites()).toEqual([]);
});
test('Ada mode requires the authenticated staff branch, never a client-supplied replacement',async()=>{
  staffBranch=null;expect((await staffClaim()).status).toBe(403);
  expect(calls.some(c=>c.text==='BEGIN')).toBe(false);expect(forbiddenWrites()).toEqual([]);
});
test('manual earn requires a real Ada receipt and uses its amount/owner rather than client amount',async()=>{
  expect((await manualClaim(id,'')).status).toBe(409);
  state.nativeReceipt=null;expect((await manualClaim()).status).toBe(409);
  state.nativeReceipt={doc_no:receipt,total_amount:'388.00',sold_at:'2026-11-02T02:00:00.000Z',owner_id:id};
  const response=await manualClaim();expect(response.status).toBe(201);expect(response.body.pointsAwarded).toBe(3);
  expect(state.transactions[0]).toMatchObject({member:id,total:'388.00',points:3,createdAt:'2026-11-02T02:00:00.000Z'});
  expect(forbiddenWrites()).toEqual([]);
});
test('POS import ignores supplied phone/amount ownership, records native history and deduplicates',async()=>{
  const send=()=>request(app()).post('/sccrm/import/pos').set('Authorization','Bearer staff-fixture').send({transactions:[{
    pos_ref_id:receipt,phone:'0999999999',total_amount:999999,created_at:'2026-10-01T00:00:00Z',source:'pos_import',
  }]});
  const first=await send();expect(first.status).toBe(200);expect(first.body.summary.imported).toBe(1);
  const repeat=await send();expect(repeat.body.summary.skipped_duplicates).toBe(1);
  expect(state.transactions[0]).toMatchObject({member:id,total:'388.00',points:3});expect(forbiddenWrites()).toEqual([]);
});
test('redeem and independent promotion quotes direct staff to Ada before any credit/debit',async()=>{
  const redeem=await request(app()).post('/sccrm/points/redeem').set('Authorization','Bearer staff-fixture').send({customer_id:id,points:3,reward_name:'fixture'});
  expect(redeem.status).toBe(409);expect(redeem.body.code).toBe('USE_ADA_POINTS');
  const quote=await request(app()).get('/sccrm/promotions/quote?amount=388');expect(quote.status).toBe(409);expect(quote.body.awardedPoints).toBeUndefined();
  const active=await request(app()).get('/sccrm/promotions/active');expect(active.body).toMatchObject({promotions:[],bahtPerPoint:null,previewAvailable:false});
  expect(forbiddenWrites()).toEqual([]);
});
test('balance read publishes an unavailable state without old ledger fallback or false zero',async()=>{
  state.observed=new Date(Date.now()-121000);
  const response=await request(app()).get(`/sccrm/points/${id}/balance`).set('Authorization','Bearer '+customerToken());
  expect(response.status).toBe(200);expect(response.body).toMatchObject({balance:null,pointsAvailable:false,pointsStatus:'stale',lifetimeEarned:null});
  expect(calls.some(({text})=>text.includes('FROM point_ledger'))).toBe(false);expect(forbiddenWrites()).toEqual([]);
});
test('staff member search/profile both publish the same exact Ada balance and explicit source status',async()=>{
  for(const endpoint of ['/loyalty/search?q=fixture',`/loyalty/${id}`]){
    const response=await request(app()).get(endpoint).set('Authorization','Bearer staff-fixture');
    expect(response.status).toBe(200);const member=Array.isArray(response.body)?response.body[0]:response.body;
    expect(member).toMatchObject({id,currentPoints:51.5,balanceExact:'51.5',pointsSource:'ada',pointsAvailable:true});
  }
  state.cacheState='pending';
  const unavailable=await request(app()).get('/loyalty/search?q=fixture').set('Authorization','Bearer staff-fixture');
  expect(unavailable.body[0]).toMatchObject({currentPoints:null,balanceExact:null,pointsAvailable:false,pointsStatus:'source_unavailable'});
  expect(calls.some(({text})=>/SUM\(pl.amount\)|FROM point_ledger/.test(text))).toBe(false);
});
test('mobile claim/detail reads use actual native award rather than the archived 807-point award',async()=>{
  for(const endpoint of ['/sccrm/claims/claim-fixture/status','/sccrm/transactions/sale-fixture']) {
    const response=await request(app()).get(endpoint).set('Authorization','Bearer '+customerToken());
    expect(response.status).toBe(200);const data=response.body.claim||response.body.transaction;
    expect(data).toMatchObject({pointsAwarded:3,awardedPoints:3,pointsSource:'ada',pointsCredited:false});
  }
});
test('member purchase history publishes native award and preserves the archived SCCRM award separately without rewriting it',async()=>{
  state.claims.push({id:'archived-claim',member:id,receipt,branch:'005',points:807,snapshot:{items:[]}});
  const original=JSON.stringify(state.claims);
  const response=await request(app()).get(`/loyalty/${id}/purchase-history`).set('Authorization','Bearer staff-fixture');
  expect(response.status).toBe(200);
  expect(response.body.purchases[0]).toMatchObject({awardedPoints:3,archivedSccrmPoints:807,pointsSource:'ada',pointsCredited:false});
  expect(JSON.stringify(state.claims)).toBe(original);expect(forbiddenWrites()).toEqual([]);
});
test.each(['mobileClaims','transactions','awards','claims'])('receipt status displays the stored %s owner even when native points are unavailable',async channel=>{
  state[channel].push({id:'stored-history',branch:'005',receipt,member:id});state.cacheState='pending';
  const response=await request(app()).get('/loyalty/claims/status').set('Authorization','Bearer staff-fixture')
    .query({branchCode:'005',receiptNo:receipt,memberId:other});
  expect(response.status).toBe(200);expect(response.body).toMatchObject({claimed:true,claimId:'stored-history',member:{id,displayName:'Stored native member',memberCode:code}});
  expect(response.body.awardedPoints).toBeUndefined();
  expect(calls.some(({text})=>text.includes('balance_cache')||text.includes('native_events'))).toBe(false);
  expect(forbiddenWrites()).toEqual([]);
});
test('native points alone never claim a receipt or choose the staff-selected history owner',async()=>{
  const response=await request(app()).get('/loyalty/claims/status').set('Authorization','Bearer staff-fixture').query({branchCode:'005',receiptNo:receipt});
  expect(response.status).toBe(200);expect(response.body.claimed).toBe(false);
  expect(response.body.member).toBeUndefined();expect(forbiddenWrites()).toEqual([]);
});
test('cross-method historical owner conflicts cannot silently display the first owner as authoritative',async()=>{
  state.claims.push({branch:'005',receipt,member:id});state.mobileClaims.push({branch:'005',receipt,member:other});
  const response=await request(app()).get('/loyalty/claims/status').set('Authorization','Bearer staff-fixture').query({branchCode:'005',receiptNo:receipt});
  expect(response.status).toBe(409);expect(response.body.code).toBe('BILL_OWNER_CONFLICT');expect(response.body.claimed).toBeUndefined();
});
