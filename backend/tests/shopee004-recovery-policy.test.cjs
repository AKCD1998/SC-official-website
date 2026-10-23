const {nextRecovery,classifyRecoveryFailure,classifyReviewReason}=require('../src/modules/seamless/services/shopee004RecoveryPolicy');
const {publicException,ruleAffectsOrder}=require('../src/modules/seamless/services/shopee004ExceptionReadModel');
const {startShopee004StockMaintenance}=require('../src/modules/seamless/services/shopee004StockRuntime');
const {validateCatalog}=require('../src/modules/seamless/services/shopee004StockPolicy');
test('four one-to-one aliases retain independently verified master metadata and canonical units',()=>{
 const master={companySku:'P1',stockCode:'P1',active:true,stockFactor:1,smallFactor:1,smallUnit:'กล่อง'};
 const aliases=Array.from({length:4},(_,i)=>({...master,companySku:'A'+i,masterStockCode:'P1',masterActive:true,masterStockFactor:1,masterSmallFactor:1}));
 expect(validateCatalog([master,...aliases]).size).toBe(5);
 expect(validateCatalog([master,...aliases]).get('A0')).toMatchObject({stockCode:'P1',masterActive:true,masterSmallFactor:1});
 for(const change of [{masterActive:false},{masterSmallFactor:12},{masterStockCode:'OTHER'},{smallUnit:'ขวด'}])
  expect(()=>validateCatalog([master,{...aliases[0],...change}])).toThrow('POS_UNIT_CONTRACT_INVALID');
 expect(()=>validateCatalog(aliases)).toThrow('POS_UNIT_CONTRACT_INVALID');
});
test('only bounded transport/database codes retry, with exactly five attempts',()=>{
 let attempts=0;const now=new Date(0),results=[];
 for(let i=0;i<5;i++){const result=nextRecovery({error:{code:'57014'},attemptCount:attempts,now});attempts=result.attemptCount;results.push(result);}
 expect(results.map(r=>r.retryAfter&&+new Date(r.retryAfter))).toEqual([2000,10000,30000,120000,null]);
 expect(results.at(-1)).toMatchObject({recoveryState:'blocked',exhausted:true,reasonCode:'PROCESSING_TIMEOUT'});
 for(const code of ['QUEUED_ORDER_MISSING','POS_UNIT_CONTRACT_INVALID','UNKNOWN']){
  expect(nextRecovery({error:{code,message:'private raw provider failure'}})).toMatchObject({retryable:false,recoveryState:'blocked',retryAfter:null});
 }
 expect(classifyRecoveryFailure({code:'08006'})).toMatchObject({retryable:true,reasonCode:'PROCESSING_SERVICE_UNAVAILABLE'});
 expect(classifyRecoveryFailure({message:'timeout'}).retryable).toBe(false);
 expect(classifyReviewReason('POS_UNIT_CONTRACT_INVALID')).toBe('unit');
 expect(classifyReviewReason('PROCESSING_REVIEW_REQUIRED')).toBe('identity');
 expect(classifyReviewReason('PROCESSING_TIMEOUT')).toBe('temporary');
});
test('exception read model removes order refs/customer/raw errors and keeps mapping distinct from lifecycle',()=>{
 const row={order_number:'PRIVATEORDER01',exception_id:'e',audit_revision:'4',dirty_revision:'2',recovery_revision:'2',queued_at:new Date(0),
  reasons:['cancel-dispatch-unverified','sale_unit_pos_mismatch'],items:[{name:'Synthetic pack',variant:'2 boxes',unit:'box',customer:'private'}],
  source_snapshot:{orderNumber:'PRIVATEORDER01'},retained_codes:['P1'],recovery_state:'blocked',attempt_count:5,
  retry_after:new Date(0),first_failed_at:new Date(0),last_failed_at:new Date(1),rawError:'private raw'};
 const result=publicException(row,{selection:{item:row.items[0],source:'current-issue',issueConfirmed:true,mappingApplicable:true,
  reasonCodes:['sale_unit_pos_mismatch'],unresolvedItemCount:1}});
 expect(result).toMatchObject({revision:'4:2:1970-01-01T00:00:00.000Z',issueClass:'unit',canApproveMapping:true,requiresLifecycleReview:true,
  recovery:{state:'blocked',nextRetryAt:null}});
 expect(JSON.stringify(result)).not.toMatch(/PRIVATEORDER|private raw|customer/);
 expect(publicException({...row,dirty_revision:'3'})).toMatchObject({reasonCode:'PROCESSING_PENDING',canApproveMapping:false,recovery:{state:'ready',attempts:0}});
 expect(classifyReviewReason('mapping-held-contract-changed-needs-review')).toBe('identity');
});
test('changed identity targets current, original and retained products with exact aliases, never fuzzy names',()=>{
 const scope={identities:[{listingId:'listing-1',variationId:'variant-1',aliases:[{productName:'Exact old name',variantName:'2 boxes'}]}],productCodes:['P1']};
 expect(ruleAffectsOrder({items:[{productId:'listing-1',variationId:'variant-1'}]},scope)).toBe(true);
 expect(ruleAffectsOrder({items:[{productId:'other'}],source_snapshot:{items:[{name:'Exact old name',variant:'2 boxes'}]}},scope)).toBe(true);
 expect(ruleAffectsOrder({items:[{name:'  EXACT   OLD NAME ',variant:'２ BOXES'}]},scope)).toBe(true);
 expect(ruleAffectsOrder({items:[],retained_codes:['P1']},scope)).toBe(true);
 expect(ruleAffectsOrder({items:[{name:'Exact old names',variant:'2 boxes'}]},scope)).toBe(false);
 expect(ruleAffectsOrder({items:[{name:'Exact old name',variant:'2 boxes',productId:'other'}]},scope)).toBe(false);
 expect(ruleAffectsOrder({items:[{productId:'listing-1',listingProductId:'other',variationId:'variant-1'}]},scope)).toBe(false);
});
test('worker caps pass count and elapsed work, then bounds global failures without overlapping timers',async()=>{
 jest.useFakeTimers();let at=0;
 const processOne=jest.fn(async()=>{at+=600;return true;}),refresh=jest.fn(async()=>{});
 const stop=startShopee004StockMaintenance({enabled:true,processOne,refreshResolvedMappings:refresh,now:()=>at,maximumPassMs:1000});
 await jest.advanceTimersByTimeAsync(0);expect(processOne).toHaveBeenCalledTimes(2);stop();
 const fail=jest.fn(async()=>{throw Object.assign(new Error('private'),{code:'08006'});}),report=jest.fn();at=0;
 const stopFailure=startShopee004StockMaintenance({enabled:true,processOne:fail,refreshResolvedMappings:refresh,now:()=>at,reportFailure:report});
 await jest.advanceTimersByTimeAsync(0);expect(fail).toHaveBeenCalledTimes(1);
 for(const time of [2000,12000,42000,162000]){at=time;await jest.advanceTimersByTimeAsync(2000);}
 expect(fail).toHaveBeenCalledTimes(5);expect(report).toHaveBeenLastCalledWith({code:'PROCESSING_SERVICE_UNAVAILABLE',exhausted:true});
 at=200000;await jest.advanceTimersByTimeAsync(5000);expect(fail).toHaveBeenCalledTimes(5);
 at=462000;await jest.advanceTimersByTimeAsync(2000);expect(fail).toHaveBeenCalledTimes(6);stopFailure();jest.useRealTimers();
});
