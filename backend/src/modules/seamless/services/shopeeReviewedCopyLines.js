'use strict';

const { createHash } = require('node:crypto');
const registry = require('../data/shopeeAdaSmartCopyRules.v1.json');
const { moneyCents } = require('./shopeeSalesAccounting');
const { normalizeIdentityUnit } = require('./shopee004IdentityRules');
const { localDate, validDate } = require('./shopeeCopyBusinessDate');

const VERSION = 'reviewed-copy-source-equivalence-2026-11-13-v1';
const PRODUCT_REUSE_VERSION = 'reviewed-copy-product-option-2026-11-18-v1';
const hash = value => /^[a-f0-9]{64}$/u.test(value || '');
const code = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(value);
const label = value => String(value ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim();
const timestamp = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const productKey = (shopCode, item) => JSON.stringify([shopCode,label(item.productName ?? item.name),label(item.variant)]);

// A reusable approval binds product facts, independently of any order's price
// or quantity. Order-specific exceptions retain the original fingerprint path.
function reviewedCopyProductDigest(contract) {
  return createHash('sha256').update(JSON.stringify({
    shopCode:contract.shopCode,productName:contract.productName,variant:contract.variant,
    sourceSku:contract.sourceSku,components:contract.components,evidence:contract.evidence,
    sourceIdentity:contract.productReuse?.sourceIdentity,validFrom:contract.productReuse?.validFrom,
    validThrough:contract.productReuse?.validThrough ?? null,
  })).digest('hex');
}

function sourceIdentityAgrees(item, expected) {
  const source = item.copySourceIdentity;
  if (!source || source.invalid || !code(expected?.sourceSku)) return false;
  if (Object.keys(source).some(key => !['sourceSku','listingId','variationId','invalid'].includes(key))) return false;
  if (['sourceSku','listingId','variationId'].some(key => String(source[key] ?? '') !== String(expected[key] ?? ''))) return false;
  const directKeys = ['productId','listingProductId','variationId','listingVariationId','barcode','sourceBarcode','sourceSku','variantSku'];
  return directKeys.every(key => item[key] == null || String(item[key]).trim() === String(expected[key] ?? ''));
}

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
  const products = new Map();
  const holds = new Set((data.copyIdentityHolds || []).map(item => productKey(item.shopCode,item)));
  const otherIdentities = new Map();
  for (const row of [...(data.rules || []),...(data.supplementalCopyIdentities || [])]) {
    const key = productKey(row.shopCode,row);
    const matches = otherIdentities.get(key) || [];
    matches.push(row.components || [{companySku:row.companySku,quantityPerSale:row.quantityPerSale}]);
    otherIdentities.set(key,matches);
  }
  for (const contract of data.reviewedCopySourceContracts || []) {
    if (contract.productReuse) {
      const key = productKey(contract.shopCode,contract);
      const matches = products.get(key) || [];
      matches.push(contract);
      products.set(key,matches);
    }
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
    let matches = fingerprints.get(fingerprint) || [];
    let reuse = false;
    const review = reason => ({ reason, matchingReview:{ status:'review',
      reasonCode:'reviewed_copy_source_conflict', candidates:[] } });
    if (!matches.length) {
      const key = productKey(shopCode,item);
      const known = products.get(key) || [];
      if (!known.length || shopCode !== 'sc-drug-store' || order?.shopCode !== shopCode) return null;
      if (holds.has(key)) return review('มีหลักฐานขัดกันที่ยังต้องตรวจสำหรับตัวเลือกนี้');
      const date = localDate(order.orderedAt);
      if (!date || known.some(c => !validDate(c.productReuse.validFrom)
        || (c.productReuse.validThrough != null && (!validDate(c.productReuse.validThrough)
          || c.productReuse.validThrough < c.productReuse.validFrom)))) return review('วันที่มีผลของแพ็กที่ยืนยันไม่ครบหรือขัดกัน');
      // Earlier orders retain their existing historical resolver.
      if (known.every(c => date < c.productReuse.validFrom)) return null;
      const active = known.filter(c => date >= c.productReuse.validFrom
        && (c.productReuse.validThrough == null || date <= c.productReuse.validThrough));
      if (active.length !== 1) return review('ช่วงแพ็กที่ยืนยันขาดหายหรือมีหลักฐานทับซ้อนกัน');
      const c = active[0], approval = c.productReuse;
      const conflicting = (otherIdentities.get(key) || []).some(parts => parts.length !== c.components?.length
        || parts.some(part => !c.components.some(approved => part.companySku === approved.companySku
          && part.quantityPerSale === approved.quantityPerSale)));
      if (approval.status !== 'verified' || !hash(approval.approvalDigest)
        || approval.approvalDigest !== reviewedCopyProductDigest(c)
        || !sourceIdentityAgrees(item,approval.sourceIdentity)
        || conflicting
        || c.components?.length !== 1 || c.components[0].companySku !== c.sourceSku
        || !c.bindings?.length) return review('SKU หรือหลักฐานสินค้าและแพ็กไม่ตรงกับคำยืนยันเดิม');
      const binding = c.bindings.find(b => hash(b.fingerprint) && hash(b.sourceSha256)
        && Number.isSafeInteger(b.sourceRow) && b.sourceRow >= 2);
      if (!binding) return review('หลักฐานแถวต้นทางที่ใช้ยืนยันสินค้ายังไม่ครบ');
      matches = [{contract:c,binding}];
      reuse = true;
    }
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
    const common = { authority:reuse ? 'reviewed_product_option_and_erp_unit' : 'reviewed_order_source_and_erp_unit',
      originalMatch:item.productMatch,
      matchingProvenance:{ version:reuse ? PRODUCT_REUSE_VERSION : VERSION,
        method:reuse ? 'reviewed_product_option' : 'reviewed_order_source_equivalence',
        contractId:c.contractId, ...(reuse ? { approvalDigest:c.productReuse.approvalDigest,
          validFrom:c.productReuse.validFrom,validThrough:c.productReuse.validThrough ?? null } : { fingerprint }),
        reviewedSourceSha256:binding.sourceSha256,
        reviewedSourceRow:binding.sourceRow, masterSourceSha256:c.evidence.masterSourceSha256,
        ...(c.evidence.ownerContentsResponseSha256 ? { ownerContentsResponseSha256:c.evidence.ownerContentsResponseSha256 } : {}) } };
    return components.length === 1 ? { ...components[0], ...common } : { components, ...common,
      reason:'ยืนยันส่วนประกอบชุดแล้ว ต้องใช้กฎแบ่งราคาที่เจ้าของอนุมัติตรงกับชุดนี้' };
  };
}

const resolveReviewedCopyLine = buildReviewedCopyLineResolver();
module.exports = { VERSION, reviewedCopyLineFingerprint, reviewedCopyProductDigest, buildReviewedCopyLineResolver, resolveReviewedCopyLine };
