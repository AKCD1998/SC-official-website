'use strict';
const { normalizeIdentityText: norm, normalizeIdentityUnit: unit } = require('./shopee004IdentityRules');
const key = f => JSON.stringify([f.listingId, f.variationId]);
const aliasKey = a => JSON.stringify([norm(a?.productName ?? a?.name), norm(a?.variantName ?? a?.variant)]);
const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/u.test(v);
const sku = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/u.test(v);
const ref = v => typeof v === 'string' && /^[A-Za-z0-9:_-]{1,160}$/u.test(v);
const conflict = () => ({ status: 'unmapped', reasonCode: 'verified_mapping_evidence_conflict' });
// These markers are added by the server's trusted snapshot derivation after an
// originally verified observation conflicts with another observation. They may
// fence a legacy fallback, but must never approve a unit or clear an exception.
const SEMANTIC_FENCES = new Set(['CATALOG_SEMANTICS_CHANGED', 'CATALOG_EVIDENCE_CONFLICT',
  'UNIT_SEMANTICS_CHANGED', 'UNIT_EVIDENCE_CONFLICT', 'POS_METADATA_CHANGED', 'POS_METADATA_CONFLICT',
  'POS_METADATA_OBSERVATION_ONLY']);
const trusted = f => f && typeof f === 'object' && !Array.isArray(f)
  && (f.verified === true || (f.verified === false && SEMANTIC_FENCES.has(f.invalidReasonCode)))
  && f.shopCode === 'sc-drug-store' && f.branchCode === '004' && id(f.listingId) && id(f.variationId)
  && typeof f.observedAt === 'string' && Number.isFinite(Date.parse(f.observedAt));
const quantityFact = f => ['seller_description', 'owner_unit'].includes(f.kind)
  || (f.kind === 'reviewed_stock_rule' && ref(f.reviewedRuleVersion) && ref(f.reviewedRuleReference)
    && ref(f.reviewAuthority) && ref(f.auditReference));
const componentValid = c => c && sku(c.productCode) && Number.isSafeInteger(c.quantityPerSale)
  && c.quantityPerSale > 0 && c.quantityPerSale <= 10000 && typeof c.unit === 'string' && !!unit(c.unit);
const latest = rows => {
  if (!rows.length) return [];
  const stamp = Math.max(...rows.map(f => Date.parse(f.observedAt)));
  return rows.filter(f => Date.parse(f.observedAt) === stamp);
};
const catalogMeaning = f => JSON.stringify({ sourceSkus: [...new Set(f.sourceSkus)].sort(),
  aliases: [...new Set(f.aliases.map(aliasKey))].sort(), packText: norm(f.packText) });
function idsOf(item) {
  const listing = [item?.listingId, item?.listingProductId, item?.productId].filter(x => x != null && String(x).trim()).map(String);
  const variant = [item?.variationId, item?.listingVariationId].filter(x => x != null && String(x).trim()).map(String);
  return { listing, variant, complete: listing.length > 0 && variant.length > 0
    && new Set(listing).size === 1 && new Set(variant).size === 1 };
}
function componentsOf(match, pos) {
  if (match?.status === 'matched') return [{ productCode: match.companySku,
    quantityPerSale: match.quantityPerSale || 1, unit: match.quantityUnit || pos.get(match.companySku)?.smallUnit }];
  if (match?.status === 'bundle' && match.quantityRuleStatus === 'verified') return (match.components || []).map(c => ({
    productCode: c.companySku, quantityPerSale: c.quantityPerSale,
    unit: c.quantityUnit || pos.get(c.companySku)?.smallUnit }));
  return [];
}
function canonical(components, pos) {
  if (!Array.isArray(components) || !components.length || components.some(c => !componentValid(c))) return null;
  const totals = new Map();
  for (const c of components) {
    const p = pos.get(c.productCode);
    if (!p || p.companySku !== c.productCode || p.active !== true || !sku(p.stockCode)
      || unit(p.smallUnit) !== unit(c.unit) || p.stockFactor !== 1 || p.smallFactor !== 1) return null;
    if (p.companySku !== p.stockCode) {
      const master = pos.get(p.stockCode);
      if (p.masterStockCode !== p.stockCode || p.masterActive !== true || p.masterStockFactor !== 1 || p.masterSmallFactor !== 1
        || !master || master.companySku !== master.stockCode || master.active !== true
        || master.stockFactor !== 1 || master.smallFactor !== 1 || unit(master.smallUnit) !== unit(p.smallUnit)) return null;
    }
    const k = JSON.stringify([p.stockCode, unit(c.unit)]), next = (totals.get(k) || 0) + c.quantityPerSale;
    if (!Number.isSafeInteger(next)) return null;
    totals.set(k, next);
  }
  return JSON.stringify([...totals].sort(([a], [b]) => a.localeCompare(b)));
}
const posShape = p => JSON.stringify([p.stockCode, unit(p.unit ?? p.smallUnit), p.active !== false, p.stockFactor, p.smallFactor,
  ...(p.productCode !== p.stockCode && p.companySku !== p.stockCode
    ? [p.masterStockCode, p.masterActive, p.masterStockFactor, p.masterSmallFactor] : [])]);

// Guards old static matching only. It never approves an unknown mapping, changes
// a quantity, releases a hold or turns raw catalog text into unit evidence.
function createLegacyEvidenceGuard({ evidenceRefs, posCatalog } = {}) {
  const facts = evidenceRefs instanceof Map ? [...evidenceRefs.values()].filter(trusted).map(f => JSON.parse(JSON.stringify(f))) : [];
  const pos = posCatalog instanceof Map ? new Map([...posCatalog].map(([k, v]) => [k, { ...v }])) : new Map();
  const catalogFacts = facts.filter(f => f.kind === 'seller_catalog' && typeof f.catalogVersion === 'string' && f.catalogVersion
    && Array.isArray(f.sourceSkus) && f.sourceSkus.every(id) && Array.isArray(f.aliases));
  return function guardLegacy(shop, item, legacyMatch) {
    if (shop !== 'sc-drug-store' || !['matched', 'bundle'].includes(legacyMatch?.status)) return legacyMatch;
    const components = componentsOf(legacyMatch, pos), baseline = canonical(components, pos);
    // Invalid old metadata remains subject to the old reader's own guard. It is
    // not promoted to valid simply because this additional guard has no vector.
    if (!baseline) return legacyMatch;
    const componentCodes = new Set(components.flatMap(c => [c.productCode, pos.get(c.productCode)?.stockCode].filter(Boolean)));
    for (const code of componentCodes) {
      const p = pos.get(code); if (!p) continue;
      const observed = latest(facts.filter(f => f.kind === 'pos_unit' && f.productCode === code
        && sku(f.stockCode) && typeof f.unit === 'string' && !!unit(f.unit)
        && Number.isFinite(f.stockFactor) && Number.isFinite(f.smallFactor)));
      if (observed.some(f => posShape(f) !== posShape(p))) return conflict();
    }
    const source = idsOf(item), alias = aliasKey(item), byAlias = catalogFacts.filter(f => f.aliases.some(a => aliasKey(a) === alias));
    const byId = source.complete ? catalogFacts.filter(f => f.listingId === source.listing[0] && f.variationId === source.variant[0]) : [];
    if ((source.listing.length || source.variant.length) && (!source.complete || !byId.length) && byAlias.length) return conflict();
    const anchored = new Set((source.complete ? byId : byAlias).map(key));
    if (!anchored.size) return legacyMatch;
    const current = [...anchored].flatMap(k => latest(catalogFacts.filter(f => key(f) === k)));
    if (anchored.size > 1) return conflict();
    const payloads = current.map(catalogMeaning);
    if (new Set(payloads).size > 1) return conflict();
    const quantity = latest(facts.filter(f => quantityFact(f) && anchored.has(key(f))
      && Array.isArray(f.components) && f.components.length && f.components.every(componentValid)
      && Array.isArray(f.aliases) && (source.complete || f.aliases.some(a => aliasKey(a) === alias))));
    // An independently reviewed quantity disagreement is a semantic conflict,
    // even if an old title-only rule could still produce a convenient number.
    if (quantity.some(f => canonical(f.components, pos) !== baseline)) return conflict();
    const independentlyCompatible = quantity.some(f => f.verified === true && canonical(f.components, pos) === baseline);
    // If catalog meaning actually changed, an older unit attestation cannot
    // silently certify the new pack. An identical later export is harmless:
    // compare against the start of this semantic revision, not its refresh time.
    const history = catalogFacts.filter(f => anchored.has(key(f))), currentMeaning = payloads[0];
    const different = history.filter(f => catalogMeaning(f) !== currentMeaning);
    if (different.length) {
      const changedAfter = Math.max(...different.map(f => Date.parse(f.observedAt)));
      const semanticStart = Math.min(...history.filter(f => catalogMeaning(f) === currentMeaning
        && Date.parse(f.observedAt) > changedAfter).map(f => Date.parse(f.observedAt)));
      if (!quantity.some(f => f.verified === true && canonical(f.components, pos) === baseline
        && Date.parse(f.observedAt) >= semanticStart)) return conflict();
    }
    const skuConflict = components.length === 1 && current.some(f => f.sourceSkus.length
      && f.sourceSkus.some(s => s !== components[0].productCode));
    if (skuConflict && !independentlyCompatible) return conflict();
    return legacyMatch;
  };
}

module.exports = { createLegacyEvidenceGuard };
