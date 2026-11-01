jest.mock('../db',()=>({query:jest.fn()}));
const {copyIdentityKey,readCopyIdentityEvidence,resolveCopyIdentityEvidence,resolveSupplementalCopyIdentity}=require('../src/modules/seamless/services/shopeeCopyIdentityEvidence');
const {resolveCopyProduct,buildAdaSmartCopyPlan}=require('../src/modules/seamless/services/shopeeAdaSmartCopyService');
const rules=require('../src/modules/seamless/data/shopeeAdaSmartCopyRules.v1.json');
const shop='sc-drug-store',masters=new Map(rules.masters.map(m=>[m.companySku,m]));
const item={name:'Synthetic exact changed title',variant:'box of 12',quantity:2,unitPrice:99,productMatch:{status:'unmapped'}};
const proof=(i=item,components=[{sku:'SYNTH-RETAIL',factor:12,unit:'ซอง',name:'Synthetic retail sachet'}])=>({
 key:copyIdentityKey(shop,i),status:'verified',basis:'canonical_sc004_seller_pos',snapshotSha256:'a'.repeat(64),components});

test('canonical evidence supplies only missing identity; amount and source are unchanged at integer satang',()=>{
 const source={...item},p=proof(),date='2026-10-10',filters={shopCode:shop,startDate:date,endDate:date};
 const order={shopCode:shop,orderNumber:'SYNTHETIC',paidAt:`${date}T03:00:00Z`,items:[source],itemSubtotal:198,
  sellerVoucher:0,shopeeProductDiscount:0,sourceRows:[2],sourceSha256:'b'.repeat(64),sourceFilename:'synthetic.xlsx',observedAt:'2026-10-11T00:00:00Z'};
 const confirmed={...filters,status:'source_backed',salesTotal:198,orderCount:1,shops:[{shopCode:shop,sources:[{sourceSha256:'c'.repeat(64)}]}]};
 const before=JSON.stringify(order),context={copyIdentityEvidence:{status:'available',records:[p]}};
 const plan=buildAdaSmartCopyPlan([order],confirmed,filters,[],[],context);
 expect(plan.status).toBe('ready');expect(plan.columns).toEqual({sku:'SYNTH-RETAIL',quantity:'24',unitPrice:'8.25'});
 expect(plan.totalCents).toBe(19800);expect(JSON.stringify(order)).toBe(before);
 expect(buildAdaSmartCopyPlan([order],confirmed,filters,[],[],context)).toEqual(plan);
 expect(buildAdaSmartCopyPlan([order],confirmed,filters).columns).toBeNull();
 // A display field provided by a caller is never independent proof.
 expect(resolveCopyProduct(shop,{...item,stockProductMatch:{status:'verified',components:p.components}}).reason).toBeTruthy();
});

test('proof cannot cross identities, shops, packs, unit conflicts, or malformed metadata',()=>{
 for(const changed of [{name:'Different title'},{variant:'box of 24'},{barcode:'other'},
  {listingProductId:'OTHER'},{sourceSku:'OTHER'}])expect(resolveCopyIdentityEvidence(shop,{...item,...changed},proof(),masters)).toBeNull();
 expect(resolveCopyIdentityEvidence('dr-morepen',item,proof(),masters)).toBeNull();
 for(const p of [{...proof(),status:'blocked'},{...proof(),snapshotSha256:''},proof(item,[{sku:'IC-002516',factor:1,unit:'กล่อง',name:'conflict'}]),
  proof(item,[{sku:'X',factor:0,unit:'ซอง',name:'bad'}])])expect(resolveCopyIdentityEvidence(shop,item,p,masters)).toBeNull();
 expect(resolveCopyIdentityEvidence(shop,{...item,quantity:99},proof(),masters).factor).toBe(12);
 const held={...item,productMatch:{status:'matched',companySku:'IC-003778',quantityUnit:'box'},variant:'ชมพู 1 กล่อง'};
 expect(resolveCopyProduct(shop,held,proof(held)).reason).toBeTruthy();
 const supported={...item,productMatch:{status:'matched',companySku:'630010066'}};
 expect(resolveCopyProduct(shop,supported,proof(supported)).sku).toBe('630010066');
});

test('physical bundle identity alone does not authorize financial allocation',()=>{
 const p=proof(item,[{sku:'SYNTH-A',factor:2,unit:'ขวด',name:'paid'},{sku:'SYNTH-B',factor:1,unit:'ขวด',name:'gift'}]);
 const r=resolveCopyProduct(shop,item,p);expect(r.components).toHaveLength(2);expect(r.reason).toBeTruthy();
 expect(r).not.toHaveProperty('unitPrice');expect(r).not.toHaveProperty('allocationPolicy');
});

test('monthly reader deduplicates items rather than applying the 25-order display limit; no cache survives a read',async()=>{
 const identityStore={copyIdentityEvidence:jest.fn(async items=>items.map(i=>proof(i)))};
 const orders=Array.from({length:60},(_,i)=>({shopCode:shop,items:[{...item,quantity:i+1}]}));
 expect((await readCopyIdentityEvidence(orders,{enabled:true,identityStore})).status).toBe('available');
 expect(identityStore.copyIdentityEvidence).toHaveBeenCalledWith([{...item,quantity:1}]);
 await readCopyIdentityEvidence(orders,{enabled:true,identityStore});expect(identityStore.copyIdentityEvidence).toHaveBeenCalledTimes(2);
 identityStore.copyIdentityEvidence.mockRejectedValueOnce(Error('unavailable'));
 expect(await readCopyIdentityEvidence(orders,{enabled:true,identityStore})).toMatchObject({status:'unavailable',records:[]});
 expect(await readCopyIdentityEvidence(orders,{enabled:false,identityStore})).toMatchObject({status:'not_requested'});
 const tooMany=Array.from({length:1001},(_,i)=>({shopCode:shop,items:[{...item,name:`distinct ${i}`}]}));
 expect(await readCopyIdentityEvidence(tooMany,{enabled:true,identityStore})).toMatchObject({status:'unavailable',reasonCode:'COPY_IDENTITY_SCOPE_LIMIT'});
});

test.each(rules.supplementalCopyIdentities)('exact Seller/POS copy evidence: $companySku / $variant',r=>{
 const source={name:r.productName,variant:r.variant,quantity:1,productMatch:{status:'unmapped'}};
 expect(resolveCopyProduct(shop,source)).toMatchObject({sku:r.companySku,factor:r.quantityPerSale,unit:r.evidence.pos.smallUnit});
 expect(resolveSupplementalCopyIdentity(shop,{...source,variant:`${source.variant} changed pack`},masters)).toBeNull();
 for(const extra of [{listingProductId:'wrong',listingVariationId:r.evidence.variationId},{listingVariationId:r.evidence.variationId},
  {barcode:'wrong'},{sourceSku:'wrong'}])expect(resolveSupplementalCopyIdentity(shop,{...source,...extra},masters)).toBeNull();
 expect(resolveSupplementalCopyIdentity('dr-morepen',source,masters)).toBeNull();
 expect(resolveSupplementalCopyIdentity(shop,{...source,listingProductId:r.evidence.listingId,listingVariationId:r.evidence.variationId,
  barcode:r.evidence.sellerPackBarcode,sourceSku:r.companySku},masters)).toBeTruthy();
 expect(rules.rules.some(p=>p.productName===r.productName&&p.variant===r.variant)).toBe(false);
});
