const {resolveStockProductMatch}=require('../src/modules/seamless/services/shopeeStockProductMatch');
const {matchShopeeProduct}=require('../src/modules/seamless/services/shopeeProductMatcher');
const {mapShopeeStockLines}=require('../src/modules/seamless/services/shopeeStockReservationShadow');
const {startShopee004StockMaintenance}=require('../src/modules/seamless/services/shopee004StockRuntime');
const rules=require('../src/modules/seamless/data/shopeeStockReviewedVariants.v1.json').rules
 .filter(r=>r.authority==='exact_live_listing_and_pos_metadata_review_2026-10-23');
test('both live identity corrections are exact, stock-only evidence',()=>{
 expect(rules).toHaveLength(2);
 for(const rule of rules){const c=rule.components[0],item={name:rule.productName,variant:rule.variant,quantity:3};
  const catalog=[{companySku:c.companySku,stockCode:c.companySku,active:true,stockFactor:1,smallFactor:1,smallUnit:c.quantityUnit,productName:c.posProductName}];
  expect(matchShopeeProduct('sc-drug-store',item).status).toBe('unmapped');
  expect(resolveStockProductMatch('sc-drug-store',item)).toMatchObject({status:'matched',companySku:c.companySku,
   quantityPerSale:c.quantityPerSale,quantityUnit:c.quantityUnit,quantityRuleStatus:'verified'});
  expect(mapShopeeStockLines({items:[item],posCatalog:catalog})).toMatchObject({status:'mapped',lines:[{stockCode:c.companySku,quantity:3*c.quantityPerSale}]});
  expect(resolveStockProductMatch('another-shop',item).status).not.toBe('matched');
  for(const changed of [{variant:rule.variant+' unknown'},{sourceSku:'CONFLICT'},{productId:'unknown',variationId:'unknown'},{sourceBarcode:'unknown'}])
   expect(resolveStockProductMatch('sc-drug-store',{...item,...changed}).status).toBe('unmapped');
  expect(mapShopeeStockLines({items:[item],posCatalog:[]})).toMatchObject({status:'blocked'});
 }
 expect(rules.find(r=>r.productName.startsWith('Blendera')).components[0]).toMatchObject({quantityPerSale:4,quantityUnit:'ถุง'});
 expect(rules.find(r=>r.productName.startsWith('Durex')).components[0]).toMatchObject({quantityPerSale:1,quantityUnit:'ขวด'});
});
test('mapping recovery uses the existing worker, is throttled and stops without overlapping passes',async()=>{
 jest.useFakeTimers();let at=0;
 const processOne=jest.fn(async()=>false),refresh=jest.fn(async()=>({queuedOrders:0})),report=jest.fn();
 const stop=startShopee004StockMaintenance({enabled:true,processOne,refreshResolvedMappings:refresh,now:()=>at,reportFailure:report});
 await jest.advanceTimersByTimeAsync(0);expect(refresh).toHaveBeenCalledTimes(1);
 at=29000;await jest.advanceTimersByTimeAsync(2000);expect(refresh).toHaveBeenCalledTimes(1);
 at=30000;await jest.advanceTimersByTimeAsync(2000);expect(refresh).toHaveBeenCalledTimes(2);
 stop();at=60000;await jest.advanceTimersByTimeAsync(4000);expect(refresh).toHaveBeenCalledTimes(2);expect(report).not.toHaveBeenCalled();
 jest.useRealTimers();
});
test('OFF does not refresh mappings or read the database',()=>{
 const refresh=jest.fn(),processOne=jest.fn();const stop=startShopee004StockMaintenance({enabled:false,processOne,refreshResolvedMappings:refresh});stop();
 expect(refresh).not.toHaveBeenCalled();expect(processOne).not.toHaveBeenCalled();
});
