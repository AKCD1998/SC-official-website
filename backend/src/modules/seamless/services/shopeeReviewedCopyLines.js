'use strict';

const { createHash } = require('node:crypto');
const registry = require('../data/shopeeAdaSmartCopyRules.v1.json');
const { moneyCents } = require('./shopeeSalesAccounting');
const { normalizeIdentityUnit } = require('./shopee004IdentityRules');
const { localDate, validDate } = require('./shopeeCopyBusinessDate');
const { formattingKey } = require('./shopeeVerifiedCopyMatcher');

const VERSION = 'reviewed-copy-source-equivalence-2026-11-13-v1';
const PRODUCT_REUSE_VERSION = 'reviewed-copy-product-option-2026-11-25-v2';
const hash = value => /^[a-f0-9]{64}$/u.test(value || '');
const code = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(value);
const id = value => typeof value === 'string' && /^\d{1,40}$/u.test(value);
const label = value => String(value ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim();
const timestamp = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const productKey = (shopCode, item) => JSON.stringify([shopCode,label(item.productName ?? item.name),label(item.variant)]);
const optionKey = (shopCode, variationId) => JSON.stringify([shopCode,variationId]);

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

function missingSkuProofAgrees(contract, priorRules) {
  const proof = contract.evidence?.sourceIdentityLink;
  const common = contract.sourceSku === '' && contract.components?.length === 1
    && proof?.uniqueSellerOption === true && proof.sellerSku === ''
    && /^\d{1,40}$/u.test(proof.listingId || '') && /^\d{1,40}$/u.test(proof.variationId || '')
    && [proof.sellerSourceRow,proof.descriptionSourceRow].every(row => Number.isSafeInteger(row) && row > 1)
    && [proof.sellerSourceSha256,proof.descriptionSourceSha256,proof.packagingPhotoSha256].every(hash)
    && proof.posSourceSha256 === contract.evidence.masterSourceSha256;
  if (!common) return false;
  if (proof.kind === 'unique_seller_option_packaging_barcode_pos') {
    return proof.packagingBarcode === contract.components[0].baseUnitBarcode;
  }
  if (proof.kind !== 'unique_seller_option_prior_verified_catalog_pos'
    || proof.unchangedRetailPack !== true || !hash(proof.priorRuleDigest)) return false;
  const matches = (priorRules || []).filter(rule => rule.shopCode === contract.shopCode
    && label(rule.productName) === label(contract.productName)
    && label(rule.variant) === label(proof.priorVariant));
  if (matches.length !== 1) return false;
  const prior = matches[0], part = contract.components[0];
  return prior.authority === 'stockday_verified_exact_identity_20260928'
    && prior.enabled !== false && (prior.status == null || prior.status === 'verified')
    && prior.verifiedOn === '2026-09-28' && prior.evidence?.masterEvidenceId === 'stockday-004-20260928'
    && Number.isSafeInteger(prior.evidence.masterSourceRow) && prior.evidence.masterSourceRow > 1
    && prior.companySku === part.companySku && prior.quantityPerSale === part.quantityPerSale
    && normalizeIdentityUnit(prior.evidence.erpUnit) === normalizeIdentityUnit(part.unit)
    && prior.evidence.erpBarcode === part.baseUnitBarcode
    && createHash('sha256').update(JSON.stringify(prior)).digest('hex') === proof.priorRuleDigest;
}

function evidencedOption(contract, hasMissingSkuProof) {
  const e = contract.evidence;
  const proof = hasMissingSkuProof ? e.sourceIdentityLink : e;
  if (!id(proof?.listingId) || !id(proof.variationId) || !hash(proof.sellerSourceSha256)
    || !Number.isSafeInteger(proof.sellerSourceRow) || proof.sellerSourceRow < 2
    || (!hasMissingSkuProof && !proof.packBasis)) return null;
  return { listingId:proof.listingId, variationId:proof.variationId };
}

function sourceIdentityAgrees(item, contract, option, allowMissingSku) {
  const expected = contract.productReuse.sourceIdentity;
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return false;
  const source = item.copySourceIdentity ?? (allowMissingSku ? {} : null);
  if (!source || typeof source !== 'object' || Array.isArray(source)
    || source.invalid || (!allowMissingSku && !code(expected?.sourceSku))) return false;
  if (Object.keys(source).some(key => !['sourceSku','listingId','variationId','invalid'].includes(key))) return false;
  const sku = allowMissingSku ? contract.components[0].companySku : expected.sourceSku;
  const listingId = expected.listingId || option?.listingId;
  const variationId = expected.variationId || option?.variationId;
  const barcode = expected.barcode || contract.evidence.sellerGtin
    || (allowMissingSku && contract.evidence.sourceIdentityLink.packagingBarcode) || '';
  const agrees = (value, approved) => value == null || String(value).trim() === ''
    || String(value).trim() === approved;
  if (!allowMissingSku && (source.sourceSku !== sku || contract.sourceSku !== sku)) return false;
  if (option && (option.listingId !== listingId || option.variationId !== variationId)) return false;
  if ((expected.listingId && source.listingId !== expected.listingId)
    || (expected.variationId && source.variationId !== expected.variationId)) return false;
  return [source.sourceSku,item.sourceSku,item.variantSku].every(value => agrees(value,sku))
    && [source.listingId,item.productId,item.listingProductId].every(value => agrees(value,listingId))
    && [source.variationId,item.variationId,item.listingVariationId].every(value => agrees(value,variationId))
    && agrees(item.barcode,barcode) && agrees(item.sourceBarcode,barcode);
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
  const options = new Map();
  const holds = new Set((data.copyIdentityHolds || []).map(item => productKey(item.shopCode,item)));
  const otherIdentities = new Map();
  for (const row of [...(data.rules || []),...(data.supplementalCopyIdentities || [])]) {
    const key = productKey(row.shopCode,row);
    const matches = otherIdentities.get(key) || [];
    matches.push(row.components || [{companySku:row.companySku,quantityPerSale:row.quantityPerSale,
      unit:row.evidence?.erpUnit || row.evidence?.pos?.smallUnit}]);
    otherIdentities.set(key,matches);
  }
  for (const contract of data.reviewedCopySourceContracts || []) {
    if (contract.productReuse) {
      const key = productKey(contract.shopCode,contract);
      const missingSku = !contract.productReuse.sourceIdentity?.sourceSku && missingSkuProofAgrees(contract, data.rules);
      const option = evidencedOption(contract,missingSku);
      const record = { contract, missingSku, option };
      const matches = products.get(key) || [];
      matches.push(record);
      products.set(key,matches);
      if (option) {
        const key = optionKey(contract.shopCode,option.variationId);
        const matches = options.get(key) || [];
        matches.push(record);
        options.set(key,matches);
      }
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
    let reviewOption;
    const review = reason => ({ reason, matchingReview:{ status:'review',
      reasonCode:'reviewed_copy_source_conflict', candidates:[], ...(reviewOption ? { option:reviewOption } : {}) } });
    if (!matches.length) {
      const key = productKey(shopCode,item);
      if (shopCode !== 'sc-drug-store' || order?.shopCode !== shopCode) return null;
      const variationId = item.copySourceIdentity?.variationId || item.variationId || item.listingVariationId;
      const identified = id(variationId) ? options.get(optionKey(shopCode,variationId)) || [] : [];
      const named = products.get(key) || [];
      const known = identified.length ? identified : named;
      if (!known.length) return null;
      if (known.every(record => record.option?.variationId === known[0].option?.variationId)) {
        reviewOption = known[0].option;
      }
      if (holds.has(key)) return review('มีหลักฐานขัดกันที่ยังต้องตรวจสำหรับตัวเลือกนี้');
      const date = localDate(order.orderedAt);
      const approvals = known.map(record => record.contract.productReuse);
      if (!date || approvals.some(a => !validDate(a.validFrom)
        || (a.validThrough != null && (!validDate(a.validThrough)
          || a.validThrough < a.validFrom)))) return review('วันที่มีผลของแพ็กที่ยืนยันไม่ครบหรือขัดกัน');
      // Earlier orders retain their existing historical resolver.
      if (approvals.every(a => date < a.validFrom)) return null;
      const active = known.filter(({contract:{productReuse:a}}) => date >= a.validFrom
        && (a.validThrough == null || date <= a.validThrough));
      if (active.length !== 1) return review('ช่วงแพ็กที่ยืนยันขาดหายหรือมีหลักฐานทับซ้อนกัน');
      const {contract:c, missingSku, option} = active[0];
      const approval = c.productReuse;
      reviewOption = option;
      const approvedKey = productKey(shopCode,c);
      if (holds.has(approvedKey)) return review('มีหลักฐานขัดกันที่ยังต้องตรวจสำหรับตัวเลือกนี้');
      const approved = c.components?.length === 1 ? c.components[0] : null;
      const identityRules = [...(otherIdentities.get(key) || []),
        ...(key === approvedKey ? [] : otherIdentities.get(approvedKey) || [])];
      const conflicting = identityRules.some(parts => parts.length !== 1
        || parts[0].companySku !== approved?.companySku
        || parts[0].quantityPerSale !== approved?.quantityPerSale
        || (parts[0].unit && normalizeIdentityUnit(parts[0].unit) !== normalizeIdentityUnit(approved?.unit)));
      if (approval.status !== 'verified' || !hash(approval.approvalDigest)
        || approval.approvalDigest !== reviewedCopyProductDigest(c)
        || !sourceIdentityAgrees(item,c,option,missingSku)
        || conflicting
        || !approved || (!missingSku && approved.companySku !== c.sourceSku)
        || !c.bindings?.length) return review('SKU หรือหลักฐานสินค้าและแพ็กไม่ตรงกับคำยืนยันเดิม');
      // Stable IDs can corroborate a formatting-only change. A substantive
      // new label can indicate repackaging under an otherwise unchanged ID.
      if (key !== approvedKey && !(identified.length && formattingKey(c.productName) === formattingKey(item.name)
        && formattingKey(c.variant) === formattingKey(item.variant))) {
        return review('ชื่อตัวเลือกหรือสินค้าเปลี่ยน ต้องยืนยันว่าแพ็กเดิมยังใช้ได้');
      }
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
      || c.shopCode !== shopCode
      || (!reuse && (label(c.productName) !== label(item.name) || label(c.variant) !== label(item.variant)
        || String(c.sourceSku ?? '') !== String(item.copySourceIdentity?.sourceSku ?? '')))
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
          validFrom:c.productReuse.validFrom,validThrough:c.productReuse.validThrough ?? null,
          ...(reviewOption || {}) } : { fingerprint }),
        reviewedSourceSha256:binding.sourceSha256,
        reviewedSourceRow:binding.sourceRow, masterSourceSha256:c.evidence.masterSourceSha256,
        ...(c.evidence.ownerContentsResponseSha256 ? { ownerContentsResponseSha256:c.evidence.ownerContentsResponseSha256 } : {}) } };
    return components.length === 1 ? { ...components[0], ...common } : { components, ...common,
      reason:'ยืนยันส่วนประกอบชุดแล้ว ต้องใช้กฎแบ่งราคาที่เจ้าของอนุมัติตรงกับชุดนี้' };
  };
}

const resolveReviewedCopyLine = buildReviewedCopyLineResolver();
module.exports = { VERSION, reviewedCopyLineFingerprint, reviewedCopyProductDigest, buildReviewedCopyLineResolver, resolveReviewedCopyLine };
