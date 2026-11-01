'use strict';
const { normalizeIdentityText, normalizeIdentityUnit } = require('./shopee004IdentityRules');
const rules = require('../data/shopeeAdaSmartCopyRules.v1.json');

// A transient lookup over the existing canonical registry, not a second set of
// mapping rules. Identity metadata participates in the key so contradictory
// IDs/barcodes on otherwise equal names cannot borrow another item's proof.
function copyIdentityKey(shopCode, item) {
  return JSON.stringify([shopCode, normalizeIdentityText(item?.name), normalizeIdentityText(item?.variant),
    ...['productId','listingProductId','variationId','listingVariationId','barcode','sourceBarcode','sourceSku','variantSku']
      .map(key => String(item?.[key] ?? '').trim())]);
}

async function readCopyIdentityEvidence(orders, dependencies = {}) {
  const enabled = dependencies.enabled ?? process.env.SHOPEE004_STOCK_LEDGER_ENABLED === 'true';
  const items = new Map();
  for (const order of orders) if (order.shopCode === 'sc-drug-store') for (const item of order.items || []) {
    items.set(copyIdentityKey(order.shopCode,item), { ...item, quantity:1 });
  }
  if (!enabled || !items.size) return { status:'not_requested', records:[] };
  if (items.size > 1000) return { status:'unavailable', records:[], reasonCode:'COPY_IDENTITY_SCOPE_LIMIT' };
  try {
    const store = dependencies.identityStore || require('./shopee004StockRuntime').getIdentityStore();
    return { status:'available', records:await store.copyIdentityEvidence([...items.values()]) };
  } catch {
    return { status:'unavailable', records:[], reasonCode:'COPY_IDENTITY_READ_UNAVAILABLE' };
  }
}

function resolveCopyIdentityEvidence(shopCode,item,record,masters) {
  if (shopCode !== 'sc-drug-store' || record?.key !== copyIdentityKey(shopCode,item)
    || record.basis !== 'canonical_sc004_seller_pos' || record.status !== 'verified'
    || !/^[a-f0-9]{64}$/.test(record.snapshotSha256 || '')
    || !Array.isArray(record.components) || !record.components.length || record.components.length > 10
    || new Set(record.components.map(c=>c.sku)).size !== record.components.length) return null;
  const components=[];
  for (const c of record.components) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(c.sku || '') || !Number.isSafeInteger(c.factor)
      || c.factor < 1 || c.factor > 10000 || !c.unit || !c.name) return null;
    const master=masters.get(c.sku);
    // Canonical POS metadata must agree with the accounting base unit. A stock
    // code shared by products is not substituted for the actual company SKU.
    if (master && normalizeIdentityUnit(master.unit) !== normalizeIdentityUnit(c.unit)) return null;
    components.push({sku:c.sku,factor:c.factor,unit:master?.unit || c.unit,name:master?.name || c.name});
  }
  const provenance={version:'canonical-copy-identity-v1',method:record.basis,
    snapshotSha256:record.snapshotSha256,matchSource:record.matchSource,
    ...(record.ruleReferences?.length ? { ruleReferences:record.ruleReferences } : {})};
  const common={authority:'existing_canonical_seller_pos_identity',originalMatch:item.productMatch,matchingProvenance:provenance};
  return components.length===1 ? {...components[0],...common} : {components,...common,
    reason:'ยืนยัน SKU และหน่วยของชุดแล้ว แต่ยังต้องตรวจการแบ่งราคาตามกติกาที่อนุมัติ'};
}

// These exact accounting identities live alongside the existing copy rules.
// Physical matchers read only rules/masters and never consume this supplement.
function resolveSupplementalCopyIdentity(shopCode,item,masters) {
  const matches=(rules.supplementalCopyIdentities || []).filter(r=>r.shopCode===shopCode
    && r.productName===item.name && r.variant===(item.variant || ''));
  if(matches.length!==1)return null;
  const r=matches[0],e=r.evidence,p=e?.pos;
  if(r.status!=='verified' || !e?.listingId || !e.variationId
    || !/^[a-f0-9]{64}$/.test(e.sellerSourceSha256 || '')
    || !/^[a-f0-9]{64}$/.test(e.posSourceSha256 || '')
    || !e.packBasis || p?.companySku!==r.companySku || p.active!==1
    || !p.smallUnit || p.smallFactor!==1 || !p.productName
    || !Number.isSafeInteger(r.quantityPerSale) || r.quantityPerSale<1
    || r.quantityPerSale>1000)return null;
  const supplied=keys=>[...new Set(keys.map(k=>String(item[k]??'').trim()).filter(Boolean))];
  const product=supplied(['productId','listingProductId']),variation=supplied(['variationId','listingVariationId']);
  if(product.length||variation.length){
    if(product.length!==1||variation.length!==1||product[0]!==e.listingId||variation[0]!==e.variationId)return null;
  }
  if(supplied(['sourceSku','variantSku']).some(s=>s!==r.companySku)
    || supplied(['barcode','sourceBarcode']).some(b=>b!==e.sellerPackBarcode))return null;
  const master=masters.get(r.companySku);
  if(master&&normalizeIdentityUnit(master.unit)!==normalizeIdentityUnit(p.smallUnit))return null;
  return{sku:r.companySku,factor:r.quantityPerSale,unit:p.smallUnit,name:master?.name || p.productName,
    authority:'verified_seller_pos_copy_only',originalMatch:item.productMatch,
    matchingProvenance:{version:rules.supplementalCopyIdentityVersion,
      method:'exact_seller_variation_pos_unit',listingId:e.listingId,variationId:e.variationId,
      sellerSourceSha256:e.sellerSourceSha256,posSourceSha256:e.posSourceSha256,
      packBasis:e.packBasis,posObservedAt:e.posObservedAt}};
}
function copyIdentityHold(shopCode,item){
  const held=(rules.copyIdentityHolds || []).filter(r=>r.shopCode===shopCode
    && r.productName===item.name&&r.variant===(item.variant || ''));
  return held.length?{reason:held[0].reason,
    matchingReview:{status:'review',reasonCode:'copy_pack_evidence_conflict',candidates:[]}}:null;
}
module.exports={copyIdentityKey,readCopyIdentityEvidence,resolveCopyIdentityEvidence,resolveSupplementalCopyIdentity,copyIdentityHold};
