'use strict';

const { buildReviewedCopyLineResolver, reviewedCopyLineFingerprint } =
  require('../src/modules/seamless/services/shopeeReviewedCopyLines');
const { buildAdaSmartCopyPlan } = require('../src/modules/seamless/services/shopeeAdaSmartCopyService');
const SC='sc-drug-store';
const master={companySku:'TEST-BASE',unit:'ขวด',name:'Synthetic base bottle'};
const part={companySku:'TEST-BASE',quantityPerSale:12,unit:'ขวด',productName:master.name,
  smallFactor:1,active:true,baseUnitBarcode:'1234567890123'};

function fixture({variant='12 bottles',factor=12,number='SYNTHETIC-REVIEW',sku='TEST-BASE',components}={}){
  const item={name:'Synthetic reviewed product',variant,quantity:2,unitPrice:120,
    copySourceIdentity:{sourceSku:sku},productMatch:{status:'unmapped'}};
  const order={shopCode:SC,orderNumber:number,orderedAt:'2026-11-05T00:00:00Z',paidAt:'2026-11-05T01:00:00Z',
    observedAt:'2026-11-06T01:00:00Z',sourceSha256:'b'.repeat(64),sourceFilename:'synthetic.xlsx',sourceRows:[2],
    itemSubtotal:240,sellerVoucher:0,shopeeProductDiscount:0,
    lineFinancials:[{netSale:240,shopeeProductDiscount:0}],items:[item]};
  const contract={contractId:'synthetic-reviewed-line',scope:'accounting_copy_only',shopCode:SC,
    productName:item.name,variant,sourceSku:sku,components:components||[{...part,quantityPerSale:factor}],
    evidence:{masterSourceSha256:'c'.repeat(64),reviewSourceSha256:'d'.repeat(64),reviewedAt:'2026-11-06T02:00:00Z'},
    bindings:[{fingerprint:reviewedCopyLineFingerprint(SC,item,order,0),sourceSha256:order.sourceSha256,sourceRow:2}]};
  return {item,order,contract,registry:{masters:[master],reviewedCopySourceContracts:[contract]}};
}

test('a reviewed order keeps its SKU and pack through rolling files without expanding to new orders',()=>{
  const {item,order,registry}=fixture();const resolve=buildReviewedCopyLineResolver(registry);
  expect(resolve(SC,item,order,0)).toMatchObject({sku:'TEST-BASE',factor:12,unit:'ขวด',
    matchingProvenance:{method:'reviewed_order_source_equivalence',reviewedSourceRow:2}});
  const rolled={...order,sourceSha256:'e'.repeat(64),sourceRows:[200],sourceFilename:'later.xlsx',observedAt:'2026-11-07T00:00:00Z'};
  expect(resolve(SC,item,rolled,0)).toMatchObject({sku:'TEST-BASE',factor:12,
    matchingProvenance:{reviewedSourceSha256:order.sourceSha256,reviewedSourceRow:2}});
  expect(resolve(SC,item,{...rolled,orderNumber:'SYNTHETIC-UNREVIEWED'},0)).toBeNull();
  expect(resolve('dr-morepen',item,order,0)).toBeNull();
});

test.each([
  ['quantity',(item)=>{item.quantity=1;}],['unit price',(item)=>{item.unitPrice=119;}],
  ['SKU',(item)=>{item.copySourceIdentity.sourceSku='OTHER';}],['invalid SKU',(item)=>{item.copySourceIdentity.invalid=true;}],
  ['name',(item)=>{item.name+=' changed';}],['pack',(item)=>{item.variant='10 bottles';}],
  ['native variation',(item)=>{item.copySourceIdentity.variationId='999';}],
  ['direct barcode',(item)=>{item.barcode='1234567890123';}],
  ['payment time',(_,order)=>{order.paidAt='2026-11-05T02:00:00Z';}],
  ['creation time',(_,order)=>{order.orderedAt='2026-11-04T00:00:00Z';}],
  ['line money',(_,order)=>{order.lineFinancials[0].netSale=239;}],
  ['Shopee support',(_,order)=>{order.shopeeProductDiscount=1;}],
])('changed %s cannot borrow an earlier reviewed order line',(_,change)=>{
  const {item,order,registry}=fixture();const resolve=buildReviewedCopyLineResolver(registry);
  change(item,order);expect(resolve(SC,item,order,0)).toBeNull();
});

test('one shared bottle SKU does not merge single, 10-bottle and 12-bottle quantity contracts',()=>{
  const fixtures=[1,10,12].map(factor=>fixture({variant:`${factor} bottles`,factor,number:`SYNTHETIC-${factor}`}));
  const resolve=buildReviewedCopyLineResolver({masters:[master],reviewedCopySourceContracts:fixtures.map(f=>f.contract)});
  for(const f of fixtures)expect(resolve(SC,f.item,f.order,0).factor).toBe(f.contract.components[0].quantityPerSale);
  expect(resolve(SC,{...fixtures[0].item,variant:'24 bottles'},fixtures[0].order,0)).toBeNull();
});

test.each([
  ['missing hash',c=>{c.evidence.masterSourceSha256='';}],
  ['wrong scope',c=>{c.scope='physical_stock';}],
  ['inactive POS',c=>{c.components[0].active=false;}],
  ['non-base POS factor',c=>{c.components[0].smallFactor=12;}],
  ['unknown barcode',c=>{c.components[0].baseUnitBarcode='';}],
  ['zero quantity',c=>{c.components[0].quantityPerSale=0;}],
  ['duplicate components',c=>{c.components.push({...c.components[0]});}],
])('a matched review still blocks %s',(_,change)=>{
  const {item,order,registry,contract}=fixture();change(contract);
  expect(buildReviewedCopyLineResolver(registry)(SC,item,order,0).reason).toBeTruthy();
});

test('conflicting ERP units, duplicate proofs and missing current source rows fail closed',()=>{
  const {item,order,registry,contract}=fixture();
  expect(buildReviewedCopyLineResolver({...registry,masters:[{...master,unit:'แผง'}]})(SC,item,order,0).reason).toBeTruthy();
  expect(buildReviewedCopyLineResolver({...registry,reviewedCopySourceContracts:[contract,contract]})(SC,item,order,0).reason).toBeTruthy();
  expect(buildReviewedCopyLineResolver(registry)(SC,item,{...order,sourceRows:[]},0).reason).toBeTruthy();
  expect(buildReviewedCopyLineResolver(registry)(SC,item,{...order,sourceSha256:'invalid'},0).reason).toBeTruthy();
});

test('reviewed kit identity needs its own approved allocation and keeps two needle boxes positive',()=>{
  const components=[{...part,companySku:'TEST-METER',quantityPerSale:1,unit:'กล่อง'},
    {...part,companySku:'TEST-STRIPS',quantityPerSale:1,unit:'กล่อง'},
    {...part,companySku:'TEST-NEEDLES',quantityPerSale:2,unit:'กล่อง'}];
  const f=fixture({variant:'reviewed 100-needle kit',components});
  f.contract.evidence.ownerContentsResponseSha256='f'.repeat(64);
  const resolve=buildReviewedCopyLineResolver({...f.registry,masters:[]});
  const filters={shopCode:SC,startDate:'2026-11-05',endDate:'2026-11-05'};
  const confirmed={...filters,status:'source_backed',salesTotal:240,orderCount:1,
    shops:[{shopCode:SC,sources:[{sourceSha256:'a'.repeat(64)}]}]};
  const context={copyVariationResolver:resolve};
  expect(buildAdaSmartCopyPlan([f.order],confirmed,filters,[],[],context)).toMatchObject({status:'review_required',columns:null});
  const policy={shopCode:SC,policyKey:'synthetic-kit-100',enabled:true,approvedBy:'synthetic-owner',
    approvedAt:'2026-11-06T03:00:00Z',approval:{kind:'user_confirmed_allocation',caseId:'synthetic-owner',responseSha256:'a'.repeat(64)},
    policy:{type:'bundle',method:'primary_component_with_nominal_secondary_lines',productName:f.item.name,
      variant:f.item.variant,primarySku:'TEST-METER',components:[{sku:'TEST-METER',factor:1,weight:1},
        {sku:'TEST-STRIPS',factor:1,weight:0,nominalLineCentsPerSale:10},
        {sku:'TEST-NEEDLES',factor:2,weight:0,nominalLineCentsPerSale:10}]}};
  const plan=buildAdaSmartCopyPlan([f.order],confirmed,filters,[],[],{...context,allocationPolicies:[policy]});
  expect(plan).toMatchObject({status:'ready',issues:[],totalCents:24000,targetCents:24000});
  expect(plan.rows.find(r=>r.sku==='TEST-NEEDLES')).toMatchObject({quantity:4,unitPrice:'0.05',amountCents:20});
  expect(plan.rows.reduce((sum,r)=>sum+r.amountCents,0)).toBe(24000);
  const missingOwner=structuredClone(f.registry);delete missingOwner.reviewedCopySourceContracts[0].evidence.ownerContentsResponseSha256;
  expect(buildReviewedCopyLineResolver(missingOwner)(SC,f.item,f.order,0).reason).toBeTruthy();
});
