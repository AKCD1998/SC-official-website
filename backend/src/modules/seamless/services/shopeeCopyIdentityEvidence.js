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
function resolveSupplementalCopyIdentity(shopCode,item,masters,packUnitMismatchSku) {
  const matches=(rules.supplementalCopyIdentities || []).filter(r=>r.shopCode===shopCode
    && r.scope!=='accounting_shadow_only'
    && r.productName===item.name && r.variant===(item.variant || ''));
  if(matches.length!==1)return null;
  const r=matches[0],e=r.evidence,p=e?.pos,isBundle=Array.isArray(r.components);
  if(packUnitMismatchSku && (r.resolvesPackUnitMismatch!==true || isBundle
    || r.companySku!==packUnitMismatchSku || r.quantityPerSale<=1))return null;
  if(r.status!=='verified' || !e?.listingId || !e.variationId
    || !/^[a-f0-9]{64}$/.test(e.sellerSourceSha256 || '')
    || !/^[a-f0-9]{64}$/.test(e.posSourceSha256 || '')
    || !e.packBasis)return null;
  const supplied=keys=>[...new Set(keys.map(k=>String(item[k]??'').trim()).filter(Boolean))];
  const product=supplied(['productId','listingProductId']),variation=supplied(['variationId','listingVariationId']);
  if(product.length||variation.length){
    if(product.length!==1||variation.length!==1||product[0]!==e.listingId||variation[0]!==e.variationId)return null;
  }
  if(supplied(['sourceSku','variantSku']).some(s=>s!==(isBundle?e.sellerSku:r.companySku))
    || supplied(['barcode','sourceBarcode']).some(b=>b!==e.sellerPackBarcode))return null;
  const provenance={version:rules.supplementalCopyIdentityVersion,
    method:'exact_seller_variation_pos_unit',listingId:e.listingId,variationId:e.variationId,
    sellerSourceSha256:e.sellerSourceSha256,posSourceSha256:e.posSourceSha256,
    packBasis:e.packBasis,posObservedAt:e.posObservedAt};
  if(isBundle){
    // Only the existing accounting supplement reads this owner-confirmed kit.
    // Physical matching, kit masters/BOMs and lifecycle remain unchanged.
    if(r.scope!=='accounting_copy_only' || r.components.length<2 || r.components.length>10
      || new Set(r.components.map(c=>c.companySku)).size!==r.components.length
      || e.ownerConfirmation?.kind!=='user_confirmed_bundle_contents'
      || !/^[a-f0-9]{64}$/.test(e.ownerConfirmation.responseSha256 || '')
      || !Array.isArray(e.posComponents) || e.posComponents.length!==r.components.length
      || new Set(e.posComponents.map(c=>c.companySku)).size!==r.components.length)return null;
    const components=[];
    for(const part of r.components){
      const pos=e.posComponents.find(c=>c.companySku===part.companySku),master=masters.get(part.companySku);
      if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(part.companySku || '')
        || !Number.isSafeInteger(part.quantityPerSale) || part.quantityPerSale<1 || part.quantityPerSale>1000
        || pos?.active!==1 || pos.smallFactor!==1 || !pos.smallUnit || !pos.productName
        || (master&&normalizeIdentityUnit(master.unit)!==normalizeIdentityUnit(pos.smallUnit)))return null;
      components.push({sku:part.companySku,factor:part.quantityPerSale,unit:pos.smallUnit,name:master?.name || pos.productName});
    }
    return{components,authority:'verified_seller_pos_owner_bundle_copy_only',originalMatch:item.productMatch,
      matchingProvenance:{...provenance,method:'exact_owner_confirmed_seller_bundle_pos_units',ownerResponseSha256:e.ownerConfirmation.responseSha256},
      reason:'ยืนยันส่วนประกอบชุดตามออเดอร์และเจ้าของร้านแล้ว แต่ยังต้องใช้กฎแบ่งราคาที่อนุมัติ'};
  }
  if(p?.companySku!==r.companySku || p.active!==1 || !p.smallUnit || p.smallFactor!==1 || !p.productName
    || !Number.isSafeInteger(r.quantityPerSale) || r.quantityPerSale<1 || r.quantityPerSale>1000)return null;
  const master=masters.get(r.companySku);
  if(master&&normalizeIdentityUnit(master.unit)!==normalizeIdentityUnit(p.smallUnit))return null;
  return{sku:r.companySku,factor:r.quantityPerSale,unit:p.smallUnit,name:master?.name || p.productName,
    authority:'verified_seller_pos_copy_only',originalMatch:item.productMatch,
    matchingProvenance:provenance};
}
function copyIdentityHold(shopCode,item){
  const held=(rules.copyIdentityHolds || []).filter(r=>r.shopCode===shopCode
    && r.productName===item.name&&r.variant===(item.variant || ''));
  return held.length?{reason:held[0].reason,
    matchingReview:{status:'review',reasonCode:'copy_pack_evidence_conflict',candidates:[]}}:null;
}
module.exports={copyIdentityKey,readCopyIdentityEvidence,resolveCopyIdentityEvidence,resolveSupplementalCopyIdentity,copyIdentityHold};
