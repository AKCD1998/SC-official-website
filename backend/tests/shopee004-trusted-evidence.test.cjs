const {randomUUID}=require('node:crypto');
const {normalizeTrustedEvidenceFact:normalize,deriveTrustedEvidenceSnapshot:derive}=require('../src/modules/seamless/services/shopee004TrustedEvidence');
const now=new Date('2026-10-23T12:00:00Z');
const alias={productName:'Synthetic product',variantName:'2 boxes'};
const part={productCode:'P1',quantityPerSale:2,unit:'กล่อง'};
function fact(kind='seller_catalog',patch={}) {
 return {reference:randomUUID(),kind,shopCode:'sc-drug-store',branchCode:'004',listingId:'L1',variationId:'V1',
  observedAt:'2000-01-01T00:00:00Z',...(kind==='seller_catalog'?{catalogVersion:'v1',sourceSkus:['SKU1'],aliases:[{...alias}],packText:'2 boxes'}:
   kind==='pos_unit'?{productCode:'P1',unit:'กล่อง',stockCode:'P1',stockFactor:1,smallFactor:1,active:true}:
   {aliases:[{...alias}],components:[{...part}]}),...patch};
}
function snapshot(facts) {
 return derive(new Map(facts.map(f=>{const n=normalize(f,{now});return [n.reference,{...n.details,kind:n.kind}];})));
}
test('strict catalog normalization retains only bounded evidence fields and independent arrays',()=>{
 const raw=fact('seller_catalog',{customerName:'must not retain',token:'must not retain',rawEmail:'must not retain'});
 const result=normalize(raw,{now});expect(result.reference).toMatch(/^[0-9a-f-]{36}$/);
 expect(result.details).toMatchObject({verified:true,aliases:[alias],sourceSkus:['SKU1']});
 expect(JSON.stringify(result)).not.toMatch(/customerName|token|rawEmail|must not retain/);
 raw.aliases[0].productName='Mutated';expect(result.details.aliases[0].productName).toBe('Synthetic product');
});
test.each([
 ['string aliases',{aliases:'not-an-array'}],['empty names',{aliases:[{productName:' ',variantName:''}]}],
 ['object SKUs',{sourceSkus:{}}],['duplicate aliases',{aliases:[alias,{...alias,productName:'SYNTHETIC PRODUCT'}]}],
 ['missing version',{catalogVersion:''}],['non-UUID reference',{reference:'opaque-string'}],
 ['wrong branch',{branchCode:'001'}],['future observation',{observedAt:'2030-01-01T00:00:00Z'}],
 ['timezone missing',{observedAt:'2000-01-01T00:00:00'}],['source SKU duplicate',{sourceSkus:['SKU1','SKU1']}]
])('rejects malformed catalog shape: %s',(_name,patch)=>{
 expect(()=>normalize(fact('seller_catalog',patch),{now})).toThrow('TRUSTED_EVIDENCE_IMPORT_INVALID');
});
test('raw seller description alone cannot become a sale-unit approval',()=>{
 expect(()=>normalize(fact('seller_description',{components:undefined,description:'Contains two boxes'}),{now}))
  .toThrow('TRUSTED_EVIDENCE_IMPORT_INVALID');
 expect(normalize(fact('seller_description'),{now}).details.components).toEqual([part]);
});
test.each([0,-1,1.5,'2',10001])('rejects unsafe sale component quantity %p',quantity=>{
 expect(()=>normalize(fact('owner_unit',{components:[{...part,quantityPerSale:quantity}]}),{now}))
  .toThrow('TRUSTED_EVIDENCE_IMPORT_INVALID');
});
test('reviewed stock-rule evidence requires all four independent provenance fields',()=>{
 const proof=fact('reviewed_stock_rule',{reviewedRuleVersion:'version-1',reviewedRuleReference:'reviewed-rule-1',
  auditReference:'audit-1',reviewAuthority:'owner-unit-review'});
 expect(normalize(proof,{now}).details.reviewAuthority).toBe('owner-unit-review');
 for(const field of ['reviewedRuleVersion','reviewedRuleReference','auditReference','reviewAuthority'])
  expect(()=>normalize({...proof,[field]:undefined},{now})).toThrow('TRUSTED_EVIDENCE_IMPORT_INVALID');
});
test('catalog-version refresh with identical semantic payload keeps both old and new proofs usable',()=>{
 const old=fact(),fresh=fact('seller_catalog',{catalogVersion:'v2',observedAt:'2000-01-02T00:00:00Z',
  aliases:[{productName:'  SYNTHETIC PRODUCT ',variantName:'2  boxes'}],packText:' 2 BOXES '});
 const result=snapshot([old,fresh]);expect(result.get(old.reference).verified).toBe(true);expect(result.get(fresh.reference).verified).toBe(true);
});
test('catalog alias/SKU order does not create a semantic conflict',()=>{
 const aliases=[alias,{productName:'Former synthetic name',variantName:'same pack'}];
 const old=fact('seller_catalog',{aliases,sourceSkus:['S1','S2']}),fresh=fact('seller_catalog',{
  catalogVersion:'v2',observedAt:'2000-01-02T00:00:00Z',aliases:[...aliases].reverse(),sourceSkus:['S2','S1']});
 expect([...snapshot([old,fresh]).values()].every(f=>f.verified)).toBe(true);
});
test.each([
 ['title',{aliases:[{...alias,productName:'New synthetic name'}]}],['SKU',{sourceSkus:['SKU2']}],['pack text',{packText:'12 boxes'}]
])('new catalog %s semantics invalidate the old proof',(_label,patch)=>{
 const old=fact(),fresh=fact('seller_catalog',{catalogVersion:'v2',observedAt:'2000-01-02T00:00:00Z',...patch});
 const result=snapshot([old,fresh]);expect(result.get(old.reference)).toMatchObject({verified:false,invalidReasonCode:'CATALOG_SEMANTICS_CHANGED'});
 expect(result.get(fresh.reference).verified).toBe(true);
});
test('same-time contradictory catalog observations remain conflicted instead of choosing ingestion order',()=>{
 const a=fact(),b=fact('seller_catalog',{catalogVersion:'v2',packText:'12 boxes'});
 for(const order of [[a,b],[b,a]])expect([...snapshot(order).values()].every(f=>!f.verified)).toBe(true);
});
test('reusing the same version for different payload invalidates both even with different observation times',()=>{
 const a=fact(),b=fact('seller_catalog',{observedAt:'2000-01-02T00:00:00Z',packText:'12 boxes'});
 expect([...snapshot([a,b]).values()].every(f=>!f.verified)).toBe(true);
});
test('a new unambiguous catalog version may resolve an older version conflict without making the contradictory old proofs valid',()=>{
 const a=fact(),b=fact('seller_catalog',{observedAt:'2000-01-02T00:00:00Z',packText:'12 boxes'}),
  fresh=fact('seller_catalog',{catalogVersion:'v2',observedAt:'2000-01-03T00:00:00Z'});
 const result=snapshot([a,b,fresh]);expect(result.get(a.reference).verified).toBe(false);
 expect(result.get(b.reference).verified).toBe(false);expect(result.get(fresh.reference).verified).toBe(true);
});
test('unit evidence is selected per exact identity and alias; newer different components invalidate only related old proofs',()=>{
 const old=fact('owner_unit'),fresh=fact('seller_description',{observedAt:'2000-01-02T00:00:00Z',components:[{...part,quantityPerSale:12}]}),
  unrelated=fact('owner_unit',{variationId:'V2'}),differentAlias=fact('owner_unit',{aliases:[{...alias,variantName:'another pack'}]});
 const result=snapshot([old,fresh,unrelated,differentAlias]);
 expect(result.get(old.reference)).toMatchObject({verified:false,invalidReasonCode:'UNIT_SEMANTICS_CHANGED'});
 for(const f of [fresh,unrelated,differentAlias])expect(result.get(f.reference).verified).toBe(true);
});
test('equal-time unit disagreement blocks both; component ordering and unit synonyms do not',()=>{
 const old=fact('owner_unit'),conflict=fact('seller_description',{components:[{...part,quantityPerSale:12}]});
 expect([...snapshot([old,conflict]).values()].every(f=>!f.verified)).toBe(true);
 const bundle=[part,{productCode:'P2',quantityPerSale:1,unit:'ขวด'}],a=fact('owner_unit',{components:bundle}),
  b=fact('seller_description',{components:[{...bundle[1],unit:'bottle'},{...part,unit:'box'}]});
 expect([...snapshot([a,b]).values()].every(f=>f.verified)).toBe(true);
});
test('POS metadata invalidation crosses listing scopes for the same branch/product even when stored control is stale',()=>{
 const old=fact('pos_unit'),fresh=fact('pos_unit',{listingId:'L2',variationId:'V2',observedAt:'2000-01-02T00:00:00Z',unit:'ขวด'}),
  unrelated=fact('pos_unit',{productCode:'P2',stockCode:'P2'});
 const result=snapshot([old,fresh,unrelated]);expect(result.get(old.reference)).toMatchObject({verified:false,invalidReasonCode:'POS_METADATA_CHANGED'});
 expect(result.get(fresh.reference).verified).toBe(true);expect(result.get(unrelated.reference).verified).toBe(true);
});
test.each([{active:false},{stockFactor:12},{smallFactor:0.5},{stockCode:'MASTER',masterStockCode:'MASTER',masterActive:false,masterStockFactor:1,masterSmallFactor:1}])(
 'POS observation %p may fence an old proof but cannot itself authorize the 1x stock rule',patch=>{
  const old=fact('pos_unit'),fresh=fact('pos_unit',{observedAt:'2000-01-02T00:00:00Z',...patch});
  expect(normalize(fresh,{now}).details).toMatchObject(patch);
  const result=snapshot([old,fresh]);expect(result.get(old.reference).verified).toBe(false);
  expect(result.get(fresh.reference)).toMatchObject({verified:false,invalidReasonCode:'POS_METADATA_OBSERVATION_ONLY'});
 });
test('same-time contradictory POS master metadata blocks all competing proofs, while unit synonyms remain valid',()=>{
 const shared={productCode:'A1',stockCode:'MASTER',masterStockCode:'MASTER',masterActive:true,masterStockFactor:1,masterSmallFactor:1};
 const a=fact('pos_unit',shared),b=fact('pos_unit',{...shared,listingId:'L2',masterStockCode:'OTHER'});
 expect([...snapshot([a,b]).values()].every(f=>!f.verified)).toBe(true);
 const c=fact('pos_unit'),d=fact('pos_unit',{listingId:'L2',unit:'box'});
 expect([...snapshot([c,d]).values()].every(f=>f.verified)).toBe(true);
});
test('malformed stored proof is isolated and input snapshots cannot mutate the derived map',()=>{
 const good=fact(),n=normalize(good,{now}),raw={...n.details,kind:n.kind};
 const bad=randomUUID(),source=new Map([[n.reference,raw],[bad,{kind:'seller_catalog',verified:true,aliases:'poison',rawEmail:'private'}]]);
 const result=derive(source);expect(result.get(n.reference).verified).toBe(true);
 expect(result.get(bad)).toEqual({kind:'seller_catalog',verified:false,invalidReasonCode:'TRUSTED_EVIDENCE_SHAPE_INVALID'});
 raw.aliases[0].productName='Changed input';expect(result.get(n.reference).aliases[0].productName).toBe('Synthetic product');
 result.get(n.reference).sourceSkus.push('derived-only');expect(raw.sourceSkus).toEqual(['SKU1']);
 expect(JSON.stringify([...result.values()])).not.toContain('private');
});
test('an explicitly unverified fact is never promoted by normalization inside a derived snapshot',()=>{
 const old=fact(),n=normalize(old,{now}),input=new Map([[n.reference,{...n.details,kind:n.kind,verified:false}]]);
 expect(derive(input).get(n.reference).verified).toBe(false);
});
