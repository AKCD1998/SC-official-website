'use strict';

const { buildReviewedCopyLineResolver, reviewedCopyLineFingerprint, reviewedCopyProductDigest } =
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

function reusableFixture() {
  const f=fixture();
  f.contract.productReuse={status:'verified',validFrom:'2026-11-05',sourceIdentity:{sourceSku:'TEST-BASE'}};
  f.contract.productReuse.approvalDigest=reviewedCopyProductDigest(f.contract);
  f.order={...f.order,orderNumber:'SYNTHETIC-NEW-ORDER',orderedAt:'2026-11-18T00:00:00Z',
    paidAt:'2026-11-18T01:00:00Z',observedAt:'2026-11-19T01:00:00Z',sourceSha256:'e'.repeat(64),sourceRows:[300]};
  return f;
}

test('an explicit product approval survives new orders and prices while keeping the pack and source amount',()=>{
  const f=reusableFixture();
  const item={...f.item,quantity:3,unitPrice:99};
  const order={...f.order,items:[item],itemSubtotal:297,lineFinancials:[{netSale:297,shopeeProductDiscount:0}]};
  const resolve=buildReviewedCopyLineResolver(f.registry);
  expect(resolve(SC,item,order,0)).toMatchObject({sku:'TEST-BASE',factor:12,unit:'ขวด',
    matchingProvenance:{method:'reviewed_product_option',contractId:f.contract.contractId}});
  const filters={shopCode:SC,startDate:'2026-11-18',endDate:'2026-11-18'};
  const confirmed={...filters,status:'source_backed',salesTotal:297,orderCount:1,
    shops:[{shopCode:SC,sources:[{sourceSha256:'a'.repeat(64)}]}]};
  const plan=buildAdaSmartCopyPlan([order],confirmed,filters,[],[],{copyVariationResolver:resolve});
  expect(plan).toMatchObject({status:'ready',totalQuantity:36,totalCents:29700,targetCents:29700,issues:[]});
  expect(plan.columns).not.toBeNull();
  expect(resolve('dr-morepen',item,{...order,shopCode:'dr-morepen'},0)).toBeNull();
  const prior=fixture();
  expect(resolve(SC,prior.item,prior.order,0).matchingProvenance.method).toBe('reviewed_order_source_equivalence');
});

test.each([
  ['SKU',f=>{f.item.copySourceIdentity.sourceSku='OTHER';}],
  ['missing source metadata',f=>{delete f.item.copySourceIdentity;}],
  ['invalid source metadata',f=>{f.item.copySourceIdentity.invalid=true;}],
  ['new native ID',f=>{f.item.copySourceIdentity.variationId='999';}],
  ['direct barcode',f=>{f.item.barcode='1234567890123';}],
  ['changed approved factor',f=>{f.contract.components[0].quantityPerSale=10;}],
  ['changed approved unit',f=>{f.contract.components[0].unit='กล่อง';}],
  ['changed effective date',f=>{f.contract.productReuse.validFrom='2026-11-01';}],
  ['disabled approval',f=>{f.contract.productReuse.status='revoked';}],
  ['missing reviewed source',f=>{f.contract.bindings[0].sourceSha256='';}],
  ['new conflict',f=>{f.registry.copyIdentityHolds=[{shopCode:SC,productName:f.item.name,variant:f.item.variant}];}],
  ['contradictory pack rule',f=>{f.registry.rules=[{shopCode:SC,productName:f.item.name,variant:f.item.variant,
    companySku:'TEST-BASE',quantityPerSale:10}];}],
])('a reusable approval blocks %s for a new order',(_,change)=>{
  const f=reusableFixture();change(f);
  const product=buildReviewedCopyLineResolver(f.registry)(SC,f.item,f.order,0);
  expect(product).toMatchObject({reason:expect.any(String),matchingReview:{status:'review'}});
  expect(product.sku).toBeUndefined();
});

test('changed names and options need their own evidence, and SKU-only or swapped-SKU reuse stays blocked',()=>{
  const f=reusableFixture(),resolve=buildReviewedCopyLineResolver(f.registry);
  expect(resolve(SC,{...f.item,name:'New unverified title'},f.order,0)).toBeNull();
  expect(resolve(SC,{...f.item,variant:'10 bottles'},f.order,0)).toBeNull();
  f.contract.sourceSku='OTHER';
  f.contract.productReuse.sourceIdentity.sourceSku='OTHER';
  f.item.copySourceIdentity.sourceSku='OTHER';
  f.contract.productReuse.approvalDigest=reviewedCopyProductDigest(f.contract);
  expect(buildReviewedCopyLineResolver(f.registry)(SC,f.item,f.order,0).reason).toBeTruthy();
});

test('pack versions use creation time, hold gaps or overlaps, and preserve older orders',()=>{
  const f=reusableFixture();
  f.contract.productReuse.validThrough='2026-11-18';
  f.contract.productReuse.approvalDigest=reviewedCopyProductDigest(f.contract);
  const later=structuredClone(f.contract);
  later.contractId='synthetic-repack';
  later.bindings=[];
  later.components[0].quantityPerSale=10;
  later.productReuse.validFrom='2026-11-19';
  later.productReuse.validThrough=null;
  later.bindings=[{fingerprint:'f'.repeat(64),sourceSha256:'a'.repeat(64),sourceRow:7}];
  later.productReuse.approvalDigest=reviewedCopyProductDigest(later);
  const registry={...f.registry,reviewedCopySourceContracts:[f.contract,later]};
  const resolve=buildReviewedCopyLineResolver(registry);
  expect(resolve(SC,f.item,{...f.order,orderedAt:'2026-11-18T16:59:59Z'},0).factor).toBe(12);
  expect(resolve(SC,f.item,{...f.order,orderedAt:'2026-11-18T17:00:00Z'},0).factor).toBe(10);
  expect(resolve(SC,f.item,{...f.order,orderedAt:'2026-11-04T16:59:59Z'},0)).toBeNull();
  later.productReuse.validFrom='2026-11-20';
  later.productReuse.approvalDigest=reviewedCopyProductDigest(later);
  expect(buildReviewedCopyLineResolver(registry)(SC,f.item,{...f.order,orderedAt:'2026-11-19T00:00:00Z'},0).reason).toBeTruthy();
  later.productReuse.validFrom='2026-11-18';
  later.productReuse.approvalDigest=reviewedCopyProductDigest(later);
  expect(buildReviewedCopyLineResolver(registry)(SC,f.item,f.order,0).reason).toBeTruthy();
  f.contract.productReuse.validThrough='invalid';
  expect(buildReviewedCopyLineResolver(registry)(SC,f.item,f.order,0).reason).toBeTruthy();
});

test('the 39 promoted SC approvals retain their individually reviewed SKU, ERP unit and pack on new orders',()=>{
  const data=require('../src/modules/seamless/data/shopeeAdaSmartCopyRules.v1.json');
  const promoted=data.reviewedCopySourceContracts.filter(c=>c.productReuse&&c.contractId.startsWith('sc-copy-review-20261113-'));
  expect(promoted).toHaveLength(39);
  const resolve=buildReviewedCopyLineResolver(data);
  for(const c of promoted) {
    const item={name:c.productName,variant:c.variant,quantity:1,unitPrice:100,copySourceIdentity:{...c.productReuse.sourceIdentity}};
    const order={...reusableFixture().order,items:[item]};
    const part=c.components[0];
    expect(resolve(SC,item,order,0)).toMatchObject({sku:part.companySku,unit:part.unit,factor:part.quantityPerSale,
      matchingProvenance:{method:'reviewed_product_option',contractId:c.contractId}});
  }
});

function missingSkuFixture() {
  const f=reusableFixture();
  delete f.item.copySourceIdentity;
  f.contract.sourceSku='';
  f.contract.productReuse.sourceIdentity={};
  f.contract.evidence.sourceIdentityLink={
    kind:'unique_seller_option_packaging_barcode_pos',uniqueSellerOption:true,sellerSku:'',
    listingId:'100',variationId:'200',sellerSourceRow:12,descriptionSourceRow:20,
    sellerSourceSha256:'1'.repeat(64),descriptionSourceSha256:'2'.repeat(64),
    packagingPhotoSha256:'3'.repeat(64),posSourceSha256:f.contract.evidence.masterSourceSha256,
    packagingBarcode:f.contract.components[0].baseUnitBarcode,
  };
  f.contract.productReuse.approvalDigest=reviewedCopyProductDigest(f.contract);
  return f;
}

test('missing Order All SKU needs a unique Seller option and independent packaging-barcode/POS proof',()=>{
  const f=missingSkuFixture();
  expect(buildReviewedCopyLineResolver(f.registry)(SC,f.item,f.order,0)).toMatchObject({
    sku:'TEST-BASE',factor:12,unit:'ขวด',matchingProvenance:{method:'reviewed_product_option'},
  });
  const noApproval=structuredClone(f.registry);
  delete noApproval.reviewedCopySourceContracts[0].productReuse;
  expect(buildReviewedCopyLineResolver(noApproval)(SC,f.item,f.order,0)).toBeNull();
});

test.each([
  ['photograph',f=>{delete f.contract.evidence.sourceIdentityLink.packagingPhotoSha256;}],
  ['unique Seller option',f=>{f.contract.evidence.sourceIdentityLink.uniqueSellerOption=false;}],
  ['POS barcode',f=>{f.contract.evidence.sourceIdentityLink.packagingBarcode='9999999999999';}],
  ['POS evidence',f=>{f.contract.evidence.sourceIdentityLink.posSourceSha256='a'.repeat(64);}],
  ['Seller ID',f=>{f.contract.evidence.sourceIdentityLink.variationId='unknown';}],
  ['source SKU conflict',f=>{f.item.copySourceIdentity={sourceSku:'OTHER'};}],
  ['unexpected native ID',f=>{f.item.copySourceIdentity={variationId:'999'};}],
])('missing source SKU cannot borrow incomplete or conflicting %s proof',(_,change)=>{
  const f=missingSkuFixture();change(f);
  f.contract.productReuse.approvalDigest=reviewedCopyProductDigest(f.contract);
  expect(buildReviewedCopyLineResolver(f.registry)(SC,f.item,f.order,0).reason).toBeTruthy();
});

test('the newly evidenced packs retain five sachets, twenty sachets, one GEN-DM bag and three Kangaroo cans',()=>{
  const data=require('../src/modules/seamless/data/shopeeAdaSmartCopyRules.v1.json');
  const resolve=buildReviewedCopyLineResolver(data);
  for(const [id,sku,unit,factor] of [
    ['02','IC-005328','ซอง',5],['08','IC-001444','ถุง',1],['12','IC-005480','กล่อง',1],
    ['18','IC-004647','ซอง',20],['21','630020333','กระป๋อง',3],
  ]) {
    const c=data.reviewedCopySourceContracts.find(c=>c.contractId==='sc-copy-review-20261118-'+id);
    const item={name:c.productName,variant:c.variant,quantity:1,unitPrice:100,copySourceIdentity:{...c.productReuse.sourceIdentity}};
    expect(resolve(SC,item,{...reusableFixture().order,items:[item]},0)).toMatchObject({sku,unit,factor});
  }
});
