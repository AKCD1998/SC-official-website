'use strict';

const { createHash } = require('node:crypto');
const registry = require('../data/shopeeAdaSmartCopyRules.v1.json');
const { moneyCents } = require('./shopeeSalesAccounting');
const { normalizeIdentityUnit } = require('./shopee004IdentityRules');

const VERSION = 'reviewed-copy-source-equivalence-2026-11-13-v1';
const hash = value => /^[a-f0-9]{64}$/u.test(value || '');
const code = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(value);
const label = value => String(value ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim();
const timestamp = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

// A review follows the same immutable order line through later rolling exports.
// Neither SKU alone nor a new order with the same product earns this authority.
function reviewedCopyLineFingerprint(shopCode, item, order, index) {
  const source = item?.copySourceIdentity;
  const financial = (order?.lineFinancials || order?.sourceLineComponents)?.[index];
  const amounts = [item?.unitPrice, order?.itemSubtotal, order?.sellerVoucher,
    order?.shopeeProductDiscount, financial?.netSale, financial?.shopeeProductDiscount].map(moneyCents);
  if (shopCode !== 'sc-drug-store' || order?.shopCode !== shopCode || !order.orderNumber
    || !timestamp(order.orderedAt) || !timestamp(order.paidAt)
    || !Number.isSafeInteger(item?.quantity) || item.quantity < 1
    || !label(item.name) || amounts.some(value => !Number.isSafeInteger(value) || value < 0)
    || source?.invalid) return null;
  const identity = [source?.sourceSku, source?.listingId, source?.variationId,
    ...['productId','listingProductId','variationId','listingVariationId','barcode','sourceBarcode','sourceSku','variantSku']
      .map(key => item[key])].map(value => String(value ?? '').trim());
  return createHash('sha256').update(JSON.stringify([VERSION, shopCode, order.orderNumber,
    timestamp(order.orderedAt), timestamp(order.paidAt), label(item.name), label(item.variant),
    item.quantity, amounts, identity])).digest('hex');
}

function buildReviewedCopyLineResolver(data = registry) {
  const masters = new Map(data.masters.map(row => [row.companySku, row]));
  const fingerprints = new Map();
  for (const contract of data.reviewedCopySourceContracts || []) {
    for (const binding of contract.bindings || []) {
      if (!hash(binding.fingerprint) || !hash(binding.sourceSha256)
        || !Number.isSafeInteger(binding.sourceRow) || binding.sourceRow < 2) continue;
      const matches = fingerprints.get(binding.fingerprint) || [];
      matches.push({ contract, binding });
      fingerprints.set(binding.fingerprint, matches);
    }
  }
  return function resolveReviewedCopyLine(shopCode, item, order, index) {
    const fingerprint = reviewedCopyLineFingerprint(shopCode, item, order, index);
    const matches = fingerprints.get(fingerprint) || [];
    if (!matches.length) return null;
    const review = reason => ({ reason, matchingReview:{ status:'review',
      reasonCode:'reviewed_copy_source_conflict', candidates:[] } });
    if (matches.length !== 1) return review('หลักฐานตรวจแถวต้นทางซ้ำหรือขัดกัน');
    const { contract:c, binding } = matches[0];
    if (!hash(order.sourceSha256) || !Number.isSafeInteger(order.sourceRows?.[index])
      || order.sourceRows[index] < 2 || !c.contractId || c.scope !== 'accounting_copy_only'
      || c.shopCode !== shopCode || label(c.productName) !== label(item.name)
      || label(c.variant) !== label(item.variant)
      || String(c.sourceSku ?? '') !== String(item.copySourceIdentity?.sourceSku ?? '')
      || !hash(c.evidence?.masterSourceSha256) || !hash(c.evidence?.reviewSourceSha256)
      || !Number.isFinite(Date.parse(c.evidence.reviewedAt))
      || !Array.isArray(c.components) || !c.components.length || c.components.length > 10
      || new Set(c.components.map(part => part.companySku)).size !== c.components.length
      || (c.components.length > 1 && !hash(c.evidence.ownerContentsResponseSha256))) {
      return review('หลักฐาน SKU หน่วย หรือคำยืนยันชุดที่ตรวจไว้ไม่ครบ');
    }
    const components = [];
    for (const part of c.components) {
      const master = masters.get(part.companySku);
      if (!code(part.companySku) || !Number.isSafeInteger(part.quantityPerSale)
        || part.quantityPerSale < 1 || part.quantityPerSale > 1000
        || !part.unit || !part.productName || part.smallFactor !== 1 || part.active !== true
        || !/^\d{8,14}$/u.test(part.baseUnitBarcode || '')
        || (master && normalizeIdentityUnit(master.unit) !== normalizeIdentityUnit(part.unit))) {
        return review('หน่วยฐาน ERP ของแถวที่ตรวจไว้ยังไม่ตรงกัน');
      }
      components.push({ sku:part.companySku, factor:part.quantityPerSale,
        unit:part.unit, name:master?.name || part.productName });
    }
    const common = { authority:'reviewed_order_source_and_erp_unit', originalMatch:item.productMatch,
      matchingProvenance:{ version:VERSION, method:'reviewed_order_source_equivalence',
        contractId:c.contractId, fingerprint, reviewedSourceSha256:binding.sourceSha256,
        reviewedSourceRow:binding.sourceRow, masterSourceSha256:c.evidence.masterSourceSha256,
        ...(c.evidence.ownerContentsResponseSha256 ? { ownerContentsResponseSha256:c.evidence.ownerContentsResponseSha256 } : {}) } };
    return components.length === 1 ? { ...components[0], ...common } : { components, ...common,
      reason:'ยืนยันส่วนประกอบชุดแล้ว ต้องใช้กฎแบ่งราคาที่เจ้าของอนุมัติตรงกับชุดนี้' };
  };
}

const resolveReviewedCopyLine = buildReviewedCopyLineResolver();
module.exports = { VERSION, reviewedCopyLineFingerprint, buildReviewedCopyLineResolver, resolveReviewedCopyLine };
