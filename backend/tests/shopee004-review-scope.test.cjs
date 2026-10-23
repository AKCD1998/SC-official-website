const {resolveReviewScope}=require('../src/modules/seamless/services/shopee004ReviewScope');
const {mapShopeeStockLines}=require('../src/modules/seamless/services/shopeeStockReservationShadow');
const rules=require('../src/modules/seamless/data/shopeeStockReviewedVariants.v1.json').rules;
const catalog=new Map(['P1','P2'].map(code=>[code,{companySku:code,stockCode:code,active:true,stockFactor:1,smallFactor:1,smallUnit:'กล่อง'}]));
const known=()=>({status:'matched',companySku:'P1',quantityUnit:'box'}),unknown=()=>({status:'unmapped',reasonCode:'catalog_identity_not_found'});
test('unit uncertainty fences exact identity only; contradictory identifiers remain unallocated',()=>{
 const item={name:'Synthetic',quantity:1},identityMatch=()=>({status:'matched',companySku:'P1',matchSource:'exact_name_variant'});
 let r=resolveReviewScope([{items:[item]}],catalog,{matchItem:unknown,identityMatch});
 expect(r.complete).toBe(true);expect([...r.affected]).toEqual(['P1']);expect(r.unallocatedOrders).toBe(0);
 for(const changed of [{sourceSku:'wrong'},{barcode:'wrong'},{productId:'wrong'}]){
  r=resolveReviewScope([{items:[{...item,...changed}]}],catalog,{matchItem:unknown,identityMatch});
  expect(r.unallocatedOrders).toBe(1);expect(r.affected.size).toBe(0);
 }
 r=resolveReviewScope([{items:[item]}],catalog,{matchItem:unknown,identityMatch:()=>({status:'matched',companySku:'P1',matchSource:'fuzzy'})});
 expect(r.unallocatedOrders).toBe(1);
});
test('unknown order keeps retained identities fenced and counts once across current and original items',()=>{
 const r=resolveReviewScope([{items:[{name:'Unknown',quantity:1}],source_snapshot:{items:[{name:'Unknown',quantity:1}]},retained_codes:['P1']}],catalog,{matchItem:unknown,identityMatch:unknown});
 expect(r.complete).toBe(true);expect(r.unallocatedOrders).toBe(1);expect([...r.affected]).toEqual(['P1']);
});
test('missing source and truncated queues remain operational failures, never a clean projection',()=>{
 expect(resolveReviewScope([{items:null}],catalog,{matchItem:known}).complete).toBe(false);
 expect(resolveReviewScope(Array.from({length:101},()=>({items:[{quantity:1}]})),catalog,{matchItem:known}).complete).toBe(false);
});
test('SOS 10x20 cm is one complete POS box of two, not two boxes or another S size',()=>{
 const r=rules.find(r=>r.authority==='exact_sos_listing_and_live_pos_metadata_2026-10-23'),c=r.components[0];
 const pos=[{companySku:c.companySku,stockCode:c.companySku,active:true,stockFactor:1,smallFactor:1,smallUnit:c.quantityUnit,productName:c.posProductName}];
 expect(c.quantityPerSale).toBe(1);expect(c.quantityUnit).toBe('กล่อง');
 const item={name:r.productName,variant:r.variant,quantity:3};
 expect(mapShopeeStockLines({items:[item],posCatalog:pos})).toMatchObject({status:'mapped',lines:[{quantity:3}]});
 expect(mapShopeeStockLines({items:[{...item,variant:'S 2x4นิ้ว'}],posCatalog:pos}).status).toBe('blocked');
});
