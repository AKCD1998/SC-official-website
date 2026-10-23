const { buildOpeningBasis } = require('../src/modules/seamless/services/shopee004OpeningBasis');
const catalog = new Map([['P1',{companySku:'P1',stockCode:'P1',active:true,stockFactor:1,smallFactor:1,smallUnit:'ซอง'}]]);
const matchItem = () => ({status:'matched',companySku:'P1',quantityRuleStatus:'verified',quantityPerSale:1,quantityUnit:'ซอง'});
const rows=[{order_number:'SHIP00001',ordered_at:new Date('2026-10-01T10:00:00+07:00'),items:[{name:'Synthetic',quantity:3}]}];
const input={quality:'owner-accepted-estimate',ownerAccepted:true,olderShippedNotPostedInPos:true,
  periodStart:'2026-10-01T00:00:00+07:00',sourceAsOf:'2026-10-23T10:20:00+07:00',excludedPhysicalReviewOrders:47,
  coveredOrderNumbers:['SHIP00001'],records:[{productCode:'P1',unit:'ซอง',quantity:3}]};
const build=(patch={},options={})=>buildOpeningBasis({input:{...input,...patch},rows,openingOrderNumbers:['OPEN00001'],catalog,actor:'human',matchItem,now:new Date('2026-10-23T13:00:00+07:00'),...options});
test('accepted estimate is explicit, recomputed from source and does not claim physical/POS adjustment',()=>{
 expect(build()).toMatchObject({quality:'owner-accepted-estimate',coveredOrderCount:1,physicalStockVerified:false,
  records:[{productCode:'P1',unit:'ซอง',quantity:3}]});
 expect(build()).not.toHaveProperty('coveredOrderNumbers');
});
test.each([
 ['owner acceptance',{ownerAccepted:false}],['posting policy',{olderShippedNotPostedInPos:false}],
 ['invalid timezone',{sourceAsOf:'2026-10-23T10:20:00'}],['future basis',{sourceAsOf:'2026-10-24T10:20:00+07:00'}],
 ['duplicate orders',{coveredOrderNumbers:['SHIP00001','SHIP00001']}],
 ['opening overlap',{coveredOrderNumbers:['OPEN00001']}],['missing order',{coveredOrderNumbers:['UNKNOWN01']}],
 ['wrong quantity',{records:[{productCode:'P1',unit:'ซอง',quantity:4}]}],['wrong unit',{records:[{productCode:'P1',unit:'กล่อง',quantity:3}]}],
 ['negative quantity',{records:[{productCode:'P1',unit:'ซอง',quantity:-1}]}],
])('%s cannot create an accepted basis',(_label,patch)=>{expect(()=>build(patch)).toThrow();});
test('September source cannot be silently included in October basis',()=>{
 expect(()=>build({}, {rows:[{...rows[0],ordered_at:new Date('2026-09-30T23:59:00+07:00')}]})).toThrow('OPENING_ESTIMATE_SOURCE_WINDOW_INVALID');
});
test('mapping or actual POS-unit conflict cannot be waived as approximate',()=>{
 expect(()=>build({}, {matchItem:()=>({status:'unmapped'})})).toThrow('OPENING_ESTIMATE_MAPPING_REVIEW_REQUIRED');
 const wrong=new Map([['P1',{...catalog.get('P1'),smallUnit:'กล่อง'}]]);
 expect(()=>build({}, {catalog:wrong})).toThrow('OPENING_ESTIMATE_MAPPING_REVIEW_REQUIRED');
});
test('ordinary physically verified plans keep the original contract',()=>{
 expect(buildOpeningBasis({input:undefined})).toBeNull();
});
