const { sourceFactFingerprint } = require('../src/modules/seamless/services/shopeeCopyBusinessDate');
const { buildAdaSmartCopyPlan } = require('../src/modules/seamless/services/shopeeAdaSmartCopyService');
const filters = { shopCode:'sc-drug-store',startDate:'2020-01-01',endDate:'2020-01-01' };
const order = { ...filters,orderNumber:'200101ALLOC01',orderedAt:'2020-01-01T01:00:00Z',paidAt:'2020-01-01T01:05:00Z',
  sourceSha256:'a'.repeat(64),sourceFilename:'synthetic-orders.xlsx',sourceRows:[2,3,4],observedAt:'2020-01-02T00:00:00Z',
  itemSubtotal:53,sellerVoucher:0,shopeeProductDiscount:1,
  items:[['A','630010066',2,15],['B','IC-003143',1,20],['C','630010066',3,1]].map(([name,sku,quantity,unitPrice])=>({
    name,variant:'',quantity,unitPrice,productMatch:{status:'matched',companySku:sku},
  })) };
const evidence = { ...filters,orderNumber:order.orderNumber,businessDate:filters.startDate,paidBusinessDate:filters.startDate,
  sourceFactFingerprint:sourceFactFingerprint(order),enabled:true,verifiedBy:'synthetic-review',verifiedAt:'2020-01-02T01:00:00Z',
  lineFinancials:[{netSale:30,shopeeProductDiscount:1},{netSale:20,shopeeProductDiscount:0},{netSale:3,shopeeProductDiscount:0}],
  evidence:{kind:'daily_product_line_reconciliation',caseId:'synthetic-allocation',sources:[{
    reportType:'shopee_confirmed_product_report',date:filters.startDate,sourceFilename:'synthetic-products.xlsx',sourceSha256:'b'.repeat(64),
  }]} };
const confirmed = { ...filters,status:'source_backed',salesTotal:54,orderCount:1,
  shops:[{shopCode:filters.shopCode,sources:[{sourceFilename:'synthetic-bi.xlsx',sourceSha256:'c'.repeat(64)}]}] };
const build = (o=order,records=[evidence]) => buildAdaSmartCopyPlan([o],confirmed,filters,[],records);

test('independently evidenced line attribution includes Shopee support once on its actual source product',()=>{
  const before=JSON.stringify(order); const plan=build();
  expect(plan.status).toBe('ready'); expect(plan.totalCents).toBe(5400); expect(plan.supportCents).toBe(100);
  const sources=[...new Map(plan.rows.flatMap(r=>r.sources).map(s=>[s.sourceRow,s])).values()];
  expect(sources.map(s=>s.amountCents).sort((a,b)=>a-b)).toEqual([300,2000,3100]);
  expect(sources.every(s=>s.lineFinancialCaseId==='synthetic-allocation')).toBe(true);
  expect(plan.lineFinancialEvidence[0].applied).toBe(true); expect(JSON.stringify(order)).toBe(before);
});

test('matching BI total cannot substitute for absent product attribution',()=>{
  expect(build(order,[]).columns).toBeNull();
});

test.each([
  ['different merchandise',{itemSubtotal:54}],['different support',{shopeeProductDiscount:2}],
  ['different quantity',{items:[{...order.items[0],quantity:3},...order.items.slice(1)]}],
])('source drift (%s) invalidates its allocation',(_,change)=>{
  const p=build({...order,...change}); expect(p.columns).toBeNull(); expect(p.lineFinancialEvidence[0].applied).toBe(false);
});

test.each([
  ['missing evidence',{evidence:{...evidence.evidence,sources:[]}}],
  ['wrong evidence kind',{evidence:{...evidence.evidence,kind:'total_only'}}],
  ['wrong line count',{lineFinancials:evidence.lineFinancials.slice(1)}],
  ['wrong component sum',{lineFinancials:[{netSale:29,shopeeProductDiscount:1},...evidence.lineFinancials.slice(1)]}],
  ['duplicated support',{lineFinancials:[{netSale:30,shopeeProductDiscount:1},{netSale:20,shopeeProductDiscount:1},{netSale:3,shopeeProductDiscount:0}]}],
])('%s keeps every copy column disabled',(_,change)=>expect(build(order,[{...evidence,...change}]).columns).toBeNull());

test('duplicate evidence and missing source rows cannot disappear behind a matching aggregate',()=>{
  expect(build(order,[evidence,evidence]).columns).toBeNull();
  expect(build({...order,orderNumber:'200101UNRELATED'}).columns).toBeNull();
});
