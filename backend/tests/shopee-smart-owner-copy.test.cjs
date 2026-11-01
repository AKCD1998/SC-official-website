'use strict';
const rules=require('../src/modules/seamless/data/shopeeAdaSmartCopyRules.v1.json');
const {resolveCopyProduct}=require('../src/modules/seamless/services/shopeeAdaSmartCopyService');
const {resolveSupplementalCopyIdentity}=require('../src/modules/seamless/services/shopeeCopyIdentityEvidence');
const {bundleAllocation}=require('../src/modules/seamless/services/shopeeCopyAllocation');
const {enrichShopeeOrderItems}=require('../src/modules/seamless/services/shopeeProductMatcher');
const rule=rules.supplementalCopyIdentities.find(r=>r.components&&r.variant==='เครื่องแผ่น50เข็ม50');
const shop='sc-drug-store',masters=new Map(rules.masters.map(m=>[m.companySku,m]));
const source={name:rule.productName,variant:rule.variant,quantity:1,unitPrice:500,productMatch:{status:'unmapped'}};
const policy={shopCode:shop,policyKey:'synthetic-smart-owner',enabled:true,approvedBy:'synthetic-owner',approvedAt:'2026-11-01T00:00:00Z',
 approval:{kind:'user_confirmed_allocation',caseId:'synthetic-case',responseSha256:'a'.repeat(64)},policy:{type:'bundle',productName:source.name,variant:source.variant,
  method:'primary_component_with_nominal_secondary_lines',primarySku:'IC-006010',components:[{sku:'IC-006010',factor:1,weight:1},
   {sku:'IC-003101',factor:1,weight:0,nominalLineCentsPerSale:10},{sku:'IC-001230',factor:1,weight:0,nominalLineCentsPerSale:10}]}};

test('owner-confirmed purchased Smart kit expands into three evidenced ERP boxes without using the incorrect whole-kit BOM',()=>{
 const result=resolveCopyProduct(shop,source);
 expect(result.components.map(c=>[c.sku,c.factor,c.unit])).toEqual([['IC-006010',1,'กล่อง'],['IC-003101',1,'กล่อง'],['IC-001230',1,'กล่อง']]);
 expect(result.components[0].name).toContain('10 ชิ้น');
 expect(result.components.some(c=>['IC-001231','IC-003200'].includes(c.sku))).toBe(false);
 expect(result.matchingProvenance).toMatchObject({method:'exact_owner_confirmed_seller_bundle_pos_units',listingId:'40735044760',variationId:'298008802896'});
 expect(result.reason).toBeTruthy();
 expect(bundleAllocation([],shop,source,result.components,50000)).toBeNull();
 expect(enrichShopeeOrderItems(shop,[{name:source.name,variant:source.variant,quantity:1}])[0].productMatch.status).toBe('unmapped');
});

test('Smart source amount is preserved with the approved main-product allocation, including multiple sets and repeat reads',()=>{
 const parts=resolveCopyProduct(shop,source).components;
 const one=bundleAllocation([policy],shop,source,parts,50000);
 expect(one.components.map(c=>[c.sku,c.factor,c.amountCents])).toEqual([['IC-006010',1,49980],['IC-003101',1,10],['IC-001230',1,10]]);
 const two=bundleAllocation([policy],shop,{...source,quantity:2},[...parts].reverse(),100000);
 expect(two.components.find(c=>c.sku==='IC-006010').amountCents).toBe(99960);
 expect(two.components.reduce((s,c)=>s+c.amountCents,0)).toBe(100000);
 expect(bundleAllocation([policy],shop,{...source,quantity:2},[...parts].reverse(),100000)).toEqual(two);
 expect(one.components.every(c=>c.freeGift===false)).toBe(true);
});

test('new names, 100-needle packs, another shop and conflicting or partial IDs cannot borrow the purchased 50-needle mapping',()=>{
 for(const changed of [{...source,name:source.name+' changed'}, {...source,variant:'เครื่องแผ่น50เข็ม100'},
  {...source,listingProductId:'wrong',listingVariationId:rule.evidence.variationId},{...source,listingVariationId:rule.evidence.variationId},
  {...source,sourceSku:'IC-003200'},{...source,barcode:'unexpected'}])expect(resolveSupplementalCopyIdentity(shop,changed,masters)).toBeNull();
 expect(resolveSupplementalCopyIdentity('dr-morepen',source,masters)).toBeNull();
 expect(resolveCopyProduct(shop,{...source,variant:'เครื่องแผ่น50เข็ม100'}).matchingReview.reasonCode).toBe('copy_pack_evidence_conflict');
 expect(resolveSupplementalCopyIdentity(shop,{...source,listingProductId:rule.evidence.listingId,listingVariationId:rule.evidence.variationId},masters)).toBeTruthy();
});

test('missing owner evidence, inactive POS identities, duplicate components and invalid base units or factors keep the bundle unresolved',()=>{
 const original=structuredClone(rule);
 const restore=()=>{for(const key of Object.keys(rule))delete rule[key];Object.assign(rule,structuredClone(original));};
 try{for(const change of [
  r=>{r.status='proposed';},r=>{r.scope='physical';},r=>{r.evidence.ownerConfirmation.responseSha256='';},
  r=>{r.evidence.posSourceSha256='';},r=>{r.components[0].quantityPerSale=0;},
  r=>{r.components[1].companySku=r.components[0].companySku;},r=>{r.evidence.posComponents[0].active=0;},
  r=>{r.evidence.posComponents[0].smallFactor=10;},r=>{r.evidence.posComponents[0].smallUnit='';},r=>{r.evidence.posComponents.pop();},
 ]){restore();change(rule);expect(resolveSupplementalCopyIdentity(shop,source,masters)).toBeNull();}}
 finally{restore();}
 const conflictingMaster=new Map(masters);conflictingMaster.set('IC-006010',{unit:'แผง'});
 expect(resolveSupplementalCopyIdentity(shop,source,conflictingMaster)).toBeNull();
});
