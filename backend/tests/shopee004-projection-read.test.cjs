const {createShopee004StockLedger}=require('../src/modules/seamless/services/shopee004StockLedger');
const catalog=['P1','P2','P3','P4'].map(code=>({companySku:code,stockCode:code,active:true,stockFactor:1,smallFactor:1,smallUnit:'ซอง'}));
const at=new Date('2026-10-23T06:26:56.146Z');
function fixture(overrides={},options={}){
 const snapshot={mode:'live',cutover_at:at,pos_catalog:catalog,opening_basis:null,pending_count:0,
  ready:0,retrying:0,blocked:0,next_retry_at:null,review_count:0,warning_count:0,estimate_excluded_count:0,
  rule_jobs:0,at,revision:'91',last_ingested_at:at,held_lines:[{product_code:'P1',unit:'ซอง',units:1,reserved:'2',shipped:'3'}],
  blocked_scope:[],...overrides};
 const raw={release:jest.fn(),query:jest.fn(async config=>{
  if(config.text.includes('AS held_lines'))return{rows:[snapshot]};
  if(config.text.includes('SELECT DISTINCT code.value'))return{rows:options.ruleCodes||[]};
  return{rows:[]};
 })};
 const pool={connect:jest.fn(async()=>raw)};
 const provider=jest.fn(async()=>{if(options.failMapping)throw Error('identity provider unavailable');return(_shop,item)=>
  item.code?{status:'matched',companySku:item.code,quantityUnit:'sachet'}:{status:'unmapped'};});
 return{raw,pool,provider,ledger:createShopee004StockLedger({pool,schema:'synthetic',enabled:true,mappingContextProvider:provider})};
}
test('settled projection batches its reads once and does not load an unused identity snapshot',async()=>{
 const {ledger,raw,provider}=fixture({}, {failMapping:true});
 expect(await ledger.projection(['P1','P4'])).toMatchObject({status:'available',revision:'91',pendingOrders:0,reviewOrders:0,
  records:[{productCode:'P1',reservedQuantity:2,shippedUnpostedQuantity:3},{productCode:'P4',reservedQuantity:0}]});
 expect(provider).not.toHaveBeenCalled();
 expect(raw.query.mock.calls.map(([c])=>c.text).filter(text=>!text.startsWith('SET '))).toEqual([
  'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',expect.stringContaining('AS held_lines'),'COMMIT']);
 expect(raw.query.mock.calls.find(([c])=>c.text.includes('AS held_lines'))[0].values).toEqual([['P1','P4']]);
 expect(raw.release).toHaveBeenCalledTimes(1);
});
test('same-snapshot scope retains current, original and held product fences, with unallocated review visible',async()=>{
 const {ledger,provider}=fixture({review_count:2,blocked_scope:[
  {items:[{code:'P1',quantity:1}],source_snapshot:{items:[{code:'P2',quantity:1}]},retained_codes:['P3'],scope_order_count:2},
  {items:[{name:'unresolved synthetic',quantity:1}],retained_codes:[],scope_order_count:2},
 ]});
 const result=await ledger.projection(['P1','P2','P3','P4']);
 expect(result).toMatchObject({status:'partial',scopeValidated:true,unallocatedOrders:1,pageReviewProducts:3,scopeScanLimited:false,
  records:[{availabilityStatus:'review_required',reservedQuantity:2},{availabilityStatus:'review_required'},
   {availabilityStatus:'review_required'},{availabilityStatus:'known-commitments-only'}]});
 expect(provider).toHaveBeenCalledTimes(1);
});
test('paused mode keeps held quantities fenced without needing an item matcher',async()=>{
 const {ledger,provider}=fixture({mode:'paused',review_count:1},{failMapping:true});
 expect(await ledger.projection(['P1'])).toMatchObject({status:'review-or-processing-required',scopeValidated:false,
  records:[{availabilityStatus:'review_required',reservedQuantity:2,shippedUnpostedQuantity:3}]});
 expect(provider).not.toHaveBeenCalled();
});
test('unconfigured control remains an unavailable projection with the same empty commitments',async()=>{
 const {ledger,provider}=fixture({mode:null,cutover_at:null,pos_catalog:null,held_lines:[]});
 expect(await ledger.projection(['P1'])).toMatchObject({mode:'unconfigured',scopeValidated:false,cutoverAt:null,
  records:[{availabilityStatus:'review_required',reservedQuantity:0,shippedUnpostedQuantity:0}]});
 expect(provider).not.toHaveBeenCalled();
});
test('identity recovery still fences a canonical stock code before its order cursor is queued',async()=>{
 const alias={...catalog[0],companySku:'ALIAS1',masterStockCode:'P1',masterActive:true,masterStockFactor:1,masterSmallFactor:1};
 const {ledger,provider,raw}=fixture({rule_jobs:1,pos_catalog:[...catalog,alias]},
  {ruleCodes:[{product_code:'ALIAS1'}],failMapping:true});
 expect(await ledger.projection(['P1','P4'])).toMatchObject({status:'partial',pendingOrders:0,reviewOrders:0,
  recovery:{pendingRuleJobs:1},records:[{availabilityStatus:'review_required',reservedQuantity:null},{availabilityStatus:'available'}]});
 expect(provider).not.toHaveBeenCalled();
 expect(raw.query.mock.calls.find(([c])=>c.text.includes('SELECT DISTINCT code.value'))[0].values).toEqual([['P1','P4','ALIAS1']]);
});
test('bounded scope overflow keeps the unscanned orders visible',async()=>{
 const {ledger}=fixture({pending_count:101,ready:101,blocked_scope:Array.from({length:100},()=>({
  items:[{code:'P1',quantity:1}],retained_codes:[],scope_order_count:101}))});
 expect(await ledger.projection(['P4'])).toMatchObject({scopeScanLimited:true,unallocatedOrders:1,
  records:[{availabilityStatus:'known-commitments-only'}]});
});
test('required scope mapper failure never returns apparently available stock',async()=>{
 const {ledger,raw}=fixture({review_count:1},{failMapping:true});
 await expect(ledger.projection(['P1'])).rejects.toMatchObject({code:'LEDGER_OPERATION_FAILED'});
 expect(raw.query.mock.calls.map(([c])=>c.text)).toContain('ROLLBACK');
 expect(raw.query.mock.calls.map(([c])=>c.text)).not.toContain('COMMIT');
});
