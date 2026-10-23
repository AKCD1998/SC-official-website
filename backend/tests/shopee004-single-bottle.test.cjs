const {mapShopeeStockLines}=require('../src/modules/seamless/services/shopeeStockReservationShadow');
const rules=require('../src/modules/seamless/data/shopeeStockReviewedVariants.v1.json').rules;
test('ALSOFF single bottle is exact and cannot inherit the separate six-bottle pack',()=>{
 const r=rules.find(r=>r.authority==='exact_live_single_bottle_listing_review_2026-10-23'),c=r.components[0];
 expect(c.quantityPerSale).toBe(1);expect(c.quantityUnit).toBe('ขวด');
 const catalog=[{companySku:c.companySku,stockCode:c.companySku,active:true,stockFactor:1,smallFactor:1,smallUnit:c.quantityUnit,productName:c.posProductName}];
 const item={name:r.productName,variant:r.variant,quantity:2};
 expect(mapShopeeStockLines({items:[item],posCatalog:catalog})).toMatchObject({status:'mapped',lines:[{quantity:2}]});
 expect(mapShopeeStockLines({items:[{...item,variant:'unknown'}],posCatalog:catalog}).status).toBe('blocked');
 expect(rules.find(x=>x.productName.includes('ALSOFF')&&x.productName.includes('แพ็ค 6 ขวด')&&x.variant==='สีฟ้า 450 มล.').components[0].quantityPerSale).toBe(6);
});
