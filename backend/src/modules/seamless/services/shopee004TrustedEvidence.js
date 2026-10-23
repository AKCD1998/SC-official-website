'use strict';

// This module validates evidence metadata, not human authority. The authenticated
// import action must still attest provenance. No stock/lifecycle write occurs.
const { normalizeStockUnit } = require('./shopeeStockProductMatch');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const REF = /^[A-Za-z0-9:_-]{1,160}$/;
const KINDS = new Set(['seller_catalog','seller_description','owner_unit','reviewed_stock_rule','pos_unit']);
const QUANTITY_KINDS = new Set(['seller_description','owner_unit','reviewed_stock_rule']);
const PROVENANCE = ['reviewedRuleVersion','reviewedRuleReference','auditReference','reviewAuthority'];
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const text = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu,' ') : '';
const norm = value => text(value).toLowerCase();
const unit = value => normalizeStockUnit(text(value));
const identityKey = f => JSON.stringify([f.shopCode,f.branchCode,f.listingId,f.variationId]);
const aliasKey = a => JSON.stringify([norm(a.productName),norm(a.variantName)]);
const fail = (code='TRUSTED_EVIDENCE_IMPORT_INVALID') => {
  throw Object.assign(new Error(code),{code,statusCode:409,detailsWithheld:true});
};
function boundedText(value,maximum,{empty=false}={}) {
  if(typeof value!=='string'||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))fail();
  const result=text(value);if(result.length>maximum||(!empty&&!result))fail();return result;
}
function identifier(value,pattern=ID) {
  const result=boundedText(value,160);if(!pattern.test(result))fail();return result;
}
function aliases(value) {
  if(!Array.isArray(value)||!value.length||value.length>30)fail();
  const result=value.map(a=>{
    if(!plain(a))fail();
    return {productName:boundedText(a.productName,1000),variantName:boundedText(a.variantName,300,{empty:true})};
  });
  if(new Set(result.map(aliasKey)).size!==result.length)fail();return result;
}
function components(value) {
  if(!Array.isArray(value)||!value.length||value.length>20)fail();
  const result=value.map(c=>{
    if(!plain(c)||!Number.isSafeInteger(c.quantityPerSale)||c.quantityPerSale<1||c.quantityPerSale>10000)fail();
    return {productCode:identifier(c.productCode),quantityPerSale:c.quantityPerSale,unit:boundedText(c.unit,40)};
  });
  if(new Set(result.map(c=>c.productCode)).size!==result.length)fail();return result;
}
function sourceSkus(value) {
  if(!Array.isArray(value)||value.length>20)fail();
  const result=value.map(s=>identifier(s));if(new Set(result).size!==result.length)fail();return result;
}
function factor(value) {
  if(typeof value!=='number'||!Number.isFinite(value)||value<=0||value>Number.MAX_SAFE_INTEGER)fail();return value;
}
function normalizeTrustedEvidenceFact(f,{now=new Date()}={}) {
  if(!plain(f)||!UUID.test(f.reference||'')||!KINDS.has(f.kind)||f.shopCode!=='sc-drug-store'||f.branchCode!=='004')fail();
  if(typeof now==='function')now=now();
  const current=+new Date(now),observed=Date.parse(f.observedAt);
  if(!Number.isFinite(current)||typeof f.observedAt!=='string'
    ||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(f.observedAt)
    ||!Number.isFinite(observed)||observed>current+5000)fail();
  const details={shopCode:'sc-drug-store',branchCode:'004',listingId:identifier(f.listingId),
    variationId:identifier(f.variationId),observedAt:new Date(observed).toISOString(),verified:true};
  if(f.kind==='seller_catalog') {
    details.catalogVersion=identifier(f.catalogVersion,REF);details.aliases=aliases(f.aliases);details.sourceSkus=sourceSkus(f.sourceSkus);
    if(f.packText!==undefined)details.packText=boundedText(f.packText,5000,{empty:true});
  } else if(QUANTITY_KINDS.has(f.kind)) {
    // A raw product description is not a verified sale-to-POS conversion.
    details.aliases=aliases(f.aliases);details.components=components(f.components);
    if(f.sourceSkus!==undefined)details.sourceSkus=sourceSkus(f.sourceSkus);
    if(f.catalogVersion!==undefined)details.catalogVersion=identifier(f.catalogVersion,REF);
    if(f.packText!==undefined)details.packText=boundedText(f.packText,5000,{empty:true});
    if(f.kind==='reviewed_stock_rule')for(const key of PROVENANCE)details[key]=identifier(f[key],REF);
  } else {
    details.productCode=identifier(f.productCode);details.unit=boundedText(f.unit,40);details.stockCode=identifier(f.stockCode);
    details.stockFactor=factor(f.stockFactor);details.smallFactor=factor(f.smallFactor);
    if(f.active!==undefined){if(typeof f.active!=='boolean')fail();details.active=f.active;}
    const shared=details.productCode!==details.stockCode;
    if(shared||f.masterStockCode!==undefined)details.masterStockCode=identifier(f.masterStockCode);
    if(shared||f.masterActive!==undefined){if(typeof f.masterActive!=='boolean')fail();details.masterActive=f.masterActive;}
    if(shared||f.masterStockFactor!==undefined)details.masterStockFactor=factor(f.masterStockFactor);
    if(shared||f.masterSmallFactor!==undefined)details.masterSmallFactor=factor(f.masterSmallFactor);
    if(f.aliases!==undefined)details.aliases=aliases(f.aliases);
    if(f.components!==undefined)fail();
  }
  if(JSON.stringify(details).length>15000)fail('TRUSTED_EVIDENCE_IMPORT_LIMIT');
  return {reference:f.reference.toLowerCase(),kind:f.kind,details};
}
const stableAliases = f => (f.aliases||[]).map(aliasKey).sort();
const catalogMeaning = f => JSON.stringify({aliases:stableAliases(f),sourceSkus:[...(f.sourceSkus||[])].sort(),packText:norm(f.packText)});
const unitMeaning = f => JSON.stringify((f.components||[]).map(c=>[c.productCode,c.quantityPerSale,unit(c.unit)]).sort((a,b)=>a[0].localeCompare(b[0])));
function posMeaning(f) {
  return JSON.stringify({unit:unit(f.unit),stockCode:f.stockCode,active:f.active!==false,
    stockFactor:f.stockFactor,smallFactor:f.smallFactor,...(f.productCode!==f.stockCode?{
      masterStockCode:f.masterStockCode,masterActive:f.masterActive,
      masterStockFactor:f.masterStockFactor,masterSmallFactor:f.masterSmallFactor}:{})});
}
function deriveTrustedEvidenceSnapshot(input) {
  if(!(input instanceof Map)||input.size>20000)fail('TRUSTED_EVIDENCE_SNAPSHOT_INVALID');
  const result=new Map(),trusted=[];
  for(const [reference,f] of input) {
    if(!UUID.test(reference||''))continue;
    try {
      // Import validates observation time against its captured request clock.
      // Deriving the same already-stored snapshot is deterministic and does not
      // silently change authority merely because the wall clock advanced.
      const normalized=normalizeTrustedEvidenceFact({...f,reference},{now:new Date(Date.parse(f?.observedAt))});
      const fact={...normalized.details,kind:normalized.kind,verified:f.verified===true};
      result.set(reference,fact);if(fact.verified)trusted.push([reference,fact]);
    } catch {
      // One malformed stored proof cannot throw every order's projection. It
      // remains unusable by any rule referring to it; no private input is echoed.
      const invalid={kind:KINDS.has(f?.kind)?f.kind:'invalid',verified:false,invalidReasonCode:'TRUSTED_EVIDENCE_SHAPE_INVALID'};
      if(f?.shopCode==='sc-drug-store'&&f?.branchCode==='004'&&ID.test(f.listingId||'')&&ID.test(f.variationId||'')) {
        invalid.shopCode='sc-drug-store';invalid.branchCode='004';invalid.listingId=f.listingId;invalid.variationId=f.variationId;
        try{invalid.aliases=aliases(f.aliases);}catch{invalid.aliases=[];}
      }
      result.set(reference,invalid);
    }
  }
  const invalidate=(reference,reason)=>{const fact=result.get(reference);fact.verified=false;fact.invalidReasonCode=reason;};
  let entries=0;
  function applyGroups(rows,key,meaning,{immutableVersion=false,changed,conflict}={}) {
    const groups=new Map();
    for(const pair of rows)for(const groupKey of key(pair[1])) {
      if(++entries>200000)fail('TRUSTED_EVIDENCE_SNAPSHOT_LIMIT');
      if(!groups.has(groupKey))groups.set(groupKey,[]);groups.get(groupKey).push(pair);
    }
    for(const group of groups.values()) {
      const versions=new Map();
      if(immutableVersion)for(const [,f] of group){
        if(!versions.has(f.catalogVersion))versions.set(f.catalogVersion,new Set());
        versions.get(f.catalogVersion).add(meaning(f));
      }
      const latestAt=Math.max(...group.map(([,f])=>Date.parse(f.observedAt)));
      const newest=group.filter(([,f])=>Date.parse(f.observedAt)===latestAt);
      const latestMeanings=new Set(newest.map(([,f])=>meaning(f)));
      const latestInvalid=latestMeanings.size!==1||newest.some(([,f])=>immutableVersion&&versions.get(f.catalogVersion).size>1);
      const selected=meaning(newest[0][1]);
      for(const [ref,f] of group){
        if(latestInvalid||immutableVersion&&versions.get(f.catalogVersion).size>1)invalidate(ref,conflict);
        else if(meaning(f)!==selected)invalidate(ref,changed);
      }
    }
  }
  applyGroups(trusted.filter(([,f])=>f.kind==='seller_catalog'),f=>[identityKey(f)],catalogMeaning,
    {immutableVersion:true,changed:'CATALOG_SEMANTICS_CHANGED',conflict:'CATALOG_EVIDENCE_CONFLICT'});
  applyGroups(trusted.filter(([,f])=>QUANTITY_KINDS.has(f.kind)),f=>(f.aliases||[]).map(a=>identityKey(f)+aliasKey(a)),unitMeaning,
    {changed:'UNIT_SEMANTICS_CHANGED',conflict:'UNIT_EVIDENCE_CONFLICT'});
  // POS metadata belongs to a branch/product, not to whichever Shopee listing
  // happened to carry that proof. New incompatible observations fence all old
  // scoped proofs even if the ledger's stored POS catalog has not caught up.
  applyGroups(trusted.filter(([,f])=>f.kind==='pos_unit'),f=>[JSON.stringify([f.branchCode,f.productCode])],posMeaning,
    {changed:'POS_METADATA_CHANGED',conflict:'POS_METADATA_CONFLICT'});
  for(const [ref,f] of trusted)if(f.kind==='pos_unit'&&(f.active===false||f.stockFactor!==1||f.smallFactor!==1
    ||(f.productCode!==f.stockCode&&(f.masterStockCode!==f.stockCode||f.masterActive!==true||f.masterStockFactor!==1||f.masterSmallFactor!==1)))) {
    invalidate(ref,'POS_METADATA_OBSERVATION_ONLY');
  }
  return result;
}
module.exports={normalizeTrustedEvidenceFact,deriveTrustedEvidenceSnapshot};
