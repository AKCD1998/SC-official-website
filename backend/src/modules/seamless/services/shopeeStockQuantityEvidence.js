// Quantity rules for a previously approved exact Company SKU. This does not do
// product-name similarity matching or assign a new SKU from a packaging word.
const UNIT_WORDS = 'กระป๋อง|กระปุก|กล่อง|ขวด|หลอด|ซอง|แผง|ชิ้น|แพ็ค|แพ๊ค|แพค|แพ็ก|ถุง|ก้อน|ห่อ|เม็ด|box(?:es)?|bx|bottles?|tubes?|sachets?|blisters?|pieces?|pcs?|packs?|cans?|jars?|bars?|tablets?';
const ENGLISH_UNITS = { boxes: 'box', bottles: 'bottle', tubes: 'tube', sachets: 'sachet', blisters: 'blister',
  pieces: 'piece', pc: 'piece', pcs: 'piece', bx: 'box', packs: 'pack', cans: 'can', jars: 'jar', bars: 'bar', tablets: 'tablet' };
function packFacts(value, normalizeUnit) {
  const text = String(value || '').normalize('NFKC').toLowerCase();
  let invalid = new RegExp(`\\d+[.,/]\\d+\\s*(?:${UNIT_WORDS})|(?:^|\\s|\\()-\\s*\\d+\\s*(?:${UNIT_WORDS})`, 'u').test(text);
  const facts = [];
  for (const m of text.matchAll(new RegExp(`(?<![\\d.,/])(\\d+)(?:\\s*\\+\\s*(\\d+))?\\s*(${UNIT_WORDS})(?![a-z])`, 'gu'))) {
    const quantity = Number(m[1]) + Number(m[2] || 0);
    if (Number.isSafeInteger(quantity) && quantity > 0) facts.push({ quantity,
      unit: normalizeUnit(ENGLISH_UNITS[m[3]] || m[3]) });
    else invalid = true;
  }
  return { facts, invalid };
}
function stockContentFrame(master, posProduct, normalizeUnit) {
  if (!posProduct || posProduct.companySku !== master?.companySku || posProduct.active !== true
    || posProduct.stockFactor !== 1 || posProduct.smallFactor !== 1
    || normalizeUnit(posProduct.smallUnit) !== normalizeUnit(master.unit)) return null;
  const erp = packFacts(master.name, normalizeUnit), pos = packFacts(posProduct.productName, normalizeUnit);
  if (erp.invalid || pos.invalid || erp.facts.length !== 1 || pos.facts.length !== 1) return null;
  return erp.facts[0].unit === pos.facts[0].unit && erp.facts[0].quantity === pos.facts[0].quantity
    ? erp.facts[0] : null;
}
function contentQuantity(item, frame, normalizeUnit) {
  if (!frame) return null;
  const variant = packFacts(item.variant, normalizeUnit), title = packFacts(item.name, normalizeUnit);
  if (variant.invalid || title.invalid) return null;
  const contentCounts = [...new Set(variant.facts.filter(f => f.unit === frame.unit).map(f => f.quantity))];
  const outer = variant.facts.filter(f => f.unit !== frame.unit && f.unit !== 'tablet');
  const titleContents = title.facts.filter(f => f.unit === frame.unit);
  if (contentCounts.length === 1 && outer.length === 1 && outer[0].quantity === 1
    && titleContents.some(f => f.quantity === frame.quantity)) {
    const factor = contentCounts[0] / frame.quantity;
    if (Number.isSafeInteger(factor) && factor > 0) return { factor, evidence: 'pos_and_erp_stock_pack_content_ratio' };
    return { invalid: true };
  }
  // Example: source title says one blister containing two tablets; both POS and
  // ERP define the stock SKU as a two-tablet pack. Three blisters mean three SKUs.
  if (variant.facts.length === 1 && variant.facts[0].unit !== frame.unit
    && titleContents.length === 1 && titleContents[0].quantity === frame.quantity
    && title.facts.filter(f => f.unit === variant.facts[0].unit && f.quantity === 1).length === 1) {
    return { factor: variant.facts[0].quantity, evidence: 'pos_and_erp_single_source_pack_content' };
  }
  return null;
}
function buildSingleCatalogUnitAnchors(records, { master, unitReviews = [], rules = [], normalizeUnit, posCatalog }) {
  const anchors = [];
  for (const r of records) {
    if (r.match?.status !== 'matched' || !master(r.match.companySku)?.unit
      || unitReviews.some(v => v.companySku === r.match.companySku && v.variant === r.variant)) continue;
    const exact = rules.find(v => v.shopCode === r.shopCode && v.productName === r.productName && v.variant === r.variant);
    if (exact && (exact.components || exact.quantityPerSale !== 1 || /accounting/i.test(exact.authority || ''))) continue;
    const variant = packFacts(r.variant, normalizeUnit), title = packFacts(r.productName, normalizeUnit);
    let facts = variant.facts.length ? variant : title;
    // A source single sachet containing six tablets can anchor the same SKU's
    // five-sachet model when both independent stock masters define six tablets
    // per POS base unit. Tablet contents are not another packaging multiplier.
    const frame = stockContentFrame(master(r.match.companySku), posCatalog?.get(r.match.companySku), normalizeUnit);
    if (!variant.facts.length && !title.invalid && frame && title.facts.length === 2) {
      const outer = title.facts.filter(f => f.unit !== frame.unit);
      if (outer.length === 1 && outer[0].quantity === 1
        && title.facts.some(f => f.unit === frame.unit && f.quantity === frame.quantity)) {
        facts = { facts: outer, invalid: false };
      }
    }
    if (facts.invalid || facts.facts.length !== 1 || facts.facts[0].quantity !== 1
      || /แถม|bundle|คละ|เซ็ต|ชุดรวม/iu.test(r.productName)) continue;
    const m = master(r.match.companySku);
    anchors.push({ shopCode: r.shopCode, companySku: r.match.companySku,
      sourceQuantityUnit: facts.facts[0].unit, erpUnit: m.unit,
      authority: 'approved_catalog_explicit_one_unit_sku', sourceVariant: r.variant });
  }
  return anchors;
}
function buildReviewedCatalogUnitFactors(records, { master, rules = [], unitReviews = [], normalizeUnit }) {
  const factors = [];
  for (const r of records) {
    const sku = r.match?.companySku;
    if (r.match?.status !== 'matched' || !master(sku)?.unit
      || unitReviews.some(v => v.companySku === sku && v.variant === r.variant)) continue;
    const rule = rules.find(v => v.shopCode === r.shopCode && v.productName === r.productName && v.variant === r.variant);
    // This must be an independently reviewed physical rule, not a number derived
    // from the same automatic catalog algorithm we are trying to verify.
    if (!rule || rule.components || rule.companySku !== sku || !rule.authority
      || /accounting|existing_verified_catalog|automatic/i.test(rule.authority)
      || !Number.isSafeInteger(rule.quantityPerSale) || rule.quantityPerSale < 1) continue;
    const variant = packFacts(r.variant, normalizeUnit), title = packFacts(r.productName, normalizeUnit);
    const source = variant.facts.length ? variant : title;
    if (source.invalid || source.facts.length !== 1) continue;
    const factor = rule.quantityPerSale / source.facts[0].quantity;
    if (!Number.isSafeInteger(factor) || factor < 1) continue;
    factors.push({ shopCode: r.shopCode, companySku: sku, sourceQuantityUnit: source.facts[0].unit,
      erpUnit: master(sku).unit, factor });
  }
  return factors;
}
function resolveCatalogQuantity({ item, match, master, posProduct, unitEquivalences = [], unitReviews = [],
  catalogUnitAnchors = [], reviewedUnitFactors = [], shopCode, normalizeUnit }) {
  if (!master?.unit) return { reason: 'verified_base_unit_missing' };
  if (unitReviews.some(r => r.companySku === match.companySku && r.variant === (item.variant || ''))) {
    return { reason: 'sale_quantity_rule_unverified' };
  }
  if (packFacts(item.variant, normalizeUnit).invalid || packFacts(item.name, normalizeUnit).invalid) {
    return { reason: 'sale_quantity_rule_unverified' };
  }
  const baseUnit = normalizeUnit(master.unit);
  const frame = stockContentFrame(master, posProduct, normalizeUnit);
  const erpContent = packFacts(master.name, normalizeUnit), posContent = packFacts(posProduct?.productName, normalizeUnit);
  if (posProduct && !frame && ((erpContent.facts.length === 1 && posContent.facts.length === 1
    && erpContent.facts[0].unit === posContent.facts[0].unit
    && erpContent.facts[0].quantity !== posContent.facts[0].quantity)
    || [...erpContent.facts, ...posContent.facts].some(f => f.unit === baseUnit && f.quantity > 1))) {
    return { reason: 'sale_quantity_evidence_conflict' };
  }
  const content = contentQuantity(item, frame, normalizeUnit);
  if (content?.invalid) return { reason: 'sale_quantity_rule_unverified' };
  if (content) return { quantityPerSale: content.factor, quantityUnit: master.unit, quantityEvidence: content.evidence };
  if (match.quantityRuleStatus === 'requires_validation') return { reason: 'sale_quantity_rule_unverified' };
  const factorFor = sourceUnit => {
    const factors = [...new Set(reviewedUnitFactors.filter(r => r.shopCode === shopCode
      && r.companySku === match.companySku && r.sourceQuantityUnit === normalizeUnit(sourceUnit)
      && normalizeUnit(r.erpUnit) === baseUnit).map(r => r.factor))];
    if (factors.length > 1) return null;
    if (factors.length === 1) return factors[0];
    return (normalizeUnit(sourceUnit) === baseUnit || unitEquivalences.some(r =>
    r.companySku === match.companySku && normalizeUnit(r.sourceQuantityUnit) === normalizeUnit(sourceUnit)
    && normalizeUnit(r.erpUnit) === baseUnit && typeof r.authority === 'string' && r.authority.length > 0)
    || catalogUnitAnchors.some(r => r.companySku === match.companySku && r.shopCode === shopCode
      && r.sourceQuantityUnit === normalizeUnit(sourceUnit) && normalizeUnit(r.erpUnit) === baseUnit
      && (!frame || frame.quantity === 1 || frame.unit !== normalizeUnit(sourceUnit)))) ? 1 : null;
  };
  const equivalent = sourceUnit => factorFor(sourceUnit) !== null;
  if (match.quantityUnit && !equivalent(match.quantityUnit)) return { reason: 'sale_unit_pos_mismatch' };
  if (match.quantityRuleStatus === 'verified') {
    if (!Number.isSafeInteger(match.quantityPerSale) || match.quantityPerSale <= 0) return { reason: 'sale_quantity_rule_unverified' };
    if (!match.quantityUnit || !equivalent(match.quantityUnit)) return { reason: 'sale_unit_pos_mismatch' };
    const quantityPerSale = match.quantityPerSale * factorFor(match.quantityUnit);
    if (!Number.isSafeInteger(quantityPerSale)) return { reason: 'sale_quantity_rule_unverified' };
    return { quantityPerSale, quantityUnit: master.unit,
      quantityEvidence: normalizeUnit(match.quantityUnit) === baseUnit ? 'existing_verified_pack' : 'existing_approved_unit_equivalence' };
  }
  const variantPack = packFacts(item.variant, normalizeUnit), titlePack = packFacts(item.name, normalizeUnit);
  if (variantPack.invalid || titlePack.invalid) return { reason: 'sale_quantity_rule_unverified' };
  const variantFacts = variantPack.facts, titleFacts = titlePack.facts;
  const chosen = variantFacts;
  const baseCounts = [...new Set(chosen.filter(f => equivalent(f.unit)).map(f => f.quantity * factorFor(f.unit)))];
  if (baseCounts.length > 1) return { reason: 'sale_quantity_evidence_conflict' };
  if (baseCounts.length === 1) {
    if (frame && frame.quantity > 1 && frame.unit === baseUnit) return { reason: 'sale_quantity_rule_unverified' };
    return { quantityPerSale: baseCounts[0], quantityUnit: master.unit, quantityEvidence: 'exact_catalog_variant_pack' };
  }
  // Contents such as tablets inside a known bottle/box are not an extra sale multiplier.
  // Other retail-package counts, pack-X notation, gifts and mixed-SKU sets need evidence.
  const meaningful = chosen.filter(f => f.unit !== 'tablet');
  if (meaningful.some(f => f.quantity > 1) || /(?:แพ[็คค๊ก]|pack)\s*\d+|\b\d+\s*[x×]\s*\d+|แถม|bundle|คละ|เซ็ต|ชุดรวม/iu.test(`${item.name} ${item.variant || ''}`)) {
    return { reason: 'sale_quantity_rule_unverified' };
  }
  if (!variantFacts.length && titleFacts.some(f => f.quantity > 1 && f.unit !== 'tablet'
    && (!frame || frame.unit !== f.unit || frame.quantity !== f.quantity))) {
    // A count of the actual non-generic POS base container (e.g. 12 sachets) is
    // an outer sale pack when neither independent stock master defines such a pack.
    // Generic pieces/boxes are excluded because their names may describe contents.
    const same = [...new Set(titleFacts.filter(f => equivalent(f.unit)).map(f => f.quantity))];
    if (posProduct?.active === true && posProduct.smallFactor === 1 && posProduct.stockFactor === 1
      && normalizeUnit(posProduct.smallUnit) === baseUnit && ['sachet', 'bottle', 'tube', 'can', 'jar', 'blister', 'bar'].includes(baseUnit)
      && same.length === 1 && (!frame || frame.unit !== baseUnit)) {
      return { quantityPerSale: same[0], quantityUnit: master.unit, quantityEvidence: 'exact_catalog_non_generic_base_container_pack' };
    }
    return { reason: 'title_pack_requires_evidence' };
  }
  // The existing reviewed copy contract declares an ordinary exact matched SKU as
  // one ERP base unit unless a pack rule/hold overrides it. Carry its actual unit,
  // rather than requiring the separate 13-SKU multipack-validation table to cover all SKUs.
  return { quantityPerSale: 1, quantityUnit: master.unit, quantityEvidence: 'approved_catalog_single_base_unit' };
}
module.exports = { packFacts, resolveCatalogQuantity, stockContentFrame, buildSingleCatalogUnitAnchors, buildReviewedCatalogUnitFactors };
