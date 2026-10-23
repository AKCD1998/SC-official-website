'use strict';

// Pure candidate mapping contract. Storage, actor authentication, evidence creation,
// lifecycle reviews and reservation mutations belong to their existing owners.
const SCHEMA = 'shopee004-identity-rule-v1';
const text = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ') : '';
const norm = value => text(value).toLowerCase();
const UNITS = new Map([['กล่อง', 'box'], ['bx', 'box'], ['boxes', 'box'], ['ชิ้น', 'piece'], ['pcs', 'piece'],
  ['pc', 'piece'], ['ขวด', 'bottle'], ['แผง', 'blister'], ['ซอง', 'sachet'], ['ถุง', 'bag'],
  ['หลอด', 'tube'], ['แพ็ค', 'pack'], ['แพค', 'pack'], ['แพ็ก', 'pack'], ['เม็ด', 'tablet']]);
const unit = value => UNITS.get(norm(value)) || norm(value);
const aliasKey = a => JSON.stringify([norm(a.productName ?? a.name), norm(a.variantName ?? a.variant)]);
const identityKey = a => JSON.stringify([text(a.listingId), text(a.variationId)]);
const fail = reasonCode => ({ valid: false, reasonCode });
const blocked = reasonCode => ({ status: 'unmapped', reasonCode });
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const exactId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/u.test(value);
const refId = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,160}$/u.test(value);
const get = (map, key) => map instanceof Map ? map.get(key) : undefined;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const componentsEqual = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length
  && a.every(c => b.some(d => c.productCode === d.productCode && c.quantityPerSale === d.quantityPerSale && unit(c.unit) === unit(d.unit)));
const componentValid = c => plain(c) && exactId(c.productCode) && Number.isSafeInteger(c.quantityPerSale)
  && c.quantityPerSale >= 1 && c.quantityPerSale <= 10000 && text(c.unit).length > 0 && text(c.unit).length <= 40;

function trustedEvidence(rule, evidenceRefs) {
  if (!(evidenceRefs instanceof Map)) return null;
  const found = rule.evidenceRefs.map(ref => get(evidenceRefs, ref));
  // Trusted evidence must come from the server-owned evidence registry, never the
  // request body. A caller-supplied reference cannot create a verified fact.
  if (found.some(e => !plain(e) || e.verified !== true || !date(e.observedAt)
    || e.shopCode !== rule.shopCode || e.branchCode !== rule.branchCode
    || e.listingId !== rule.listingId || e.variationId !== rule.variationId)) return null;
  return found;
}

function validateIdentityRule(rule, { posCatalog, evidenceRefs } = {}) {
  if (!plain(rule) || rule.schemaVersion !== SCHEMA || rule.shopCode !== 'sc-drug-store' || rule.branchCode !== '004'
    || !exactId(rule.ruleId) || !Number.isSafeInteger(rule.version) || rule.version < 1
    || !['active', 'revoked'].includes(rule.state) || !exactId(rule.listingId) || !exactId(rule.variationId)
    || !date(rule.createdAt) || !Array.isArray(rule.sourceSkus) || rule.sourceSkus.length > 20
    || rule.sourceSkus.some(s => !exactId(s)) || new Set(rule.sourceSkus).size !== rule.sourceSkus.length
    || !Array.isArray(rule.aliases) || rule.aliases.length < 1 || rule.aliases.length > 30
    || !Array.isArray(rule.components) || !rule.components.length || rule.components.length > 20
    || rule.components.some(c => !componentValid(c))
    || new Set(rule.components.map(c => c.productCode)).size !== rule.components.length
    || !Array.isArray(rule.evidenceRefs) || rule.evidenceRefs.length < 2 || rule.evidenceRefs.length > 50
    || rule.evidenceRefs.some(r => !refId(r)) || new Set(rule.evidenceRefs).size !== rule.evidenceRefs.length) return fail('identity_rule_invalid');
  const evidence = trustedEvidence(rule, evidenceRefs);
  if (!evidence) return fail('identity_rule_evidence_missing');
  if (!evidence.some(e => e.kind === 'seller_catalog' && text(e.catalogVersion)
    && rule.sourceSkus.every(s => Array.isArray(e.sourceSkus) && e.sourceSkus.includes(s)))) return fail('identity_rule_identity_unverified');
  if (!evidence.some(e => ['seller_description', 'owner_unit'].includes(e.kind)
    && componentsEqual(e.components, rule.components))) return fail('identity_rule_quantity_unverified');
  const aliases = new Set();
  for (const a of rule.aliases) {
    if (!plain(a) || !text(a.productName) || text(a.productName).length > 1000 || text(a.variantName).length > 300
      || !Array.isArray(a.evidenceRefs) || !a.evidenceRefs.length || a.evidenceRefs.some(r => !rule.evidenceRefs.includes(r))
      || aliases.has(aliasKey(a))) return fail('identity_rule_alias_invalid');
    if (!a.evidenceRefs.some(ref => {
      const e = get(evidenceRefs, ref);
      return ['seller_catalog', 'seller_description', 'owner_unit'].includes(e?.kind)
        && Array.isArray(e.aliases) && e.aliases.some(v => aliasKey(v) === aliasKey(a));
    })) return fail('identity_rule_alias_unverified');
    if (!evidence.some(e => ['seller_description', 'owner_unit'].includes(e.kind)
      && componentsEqual(e.components, rule.components) && Array.isArray(e.aliases)
      && e.aliases.some(v => aliasKey(v) === aliasKey(a)))) return fail('identity_rule_quantity_unverified');
    aliases.add(aliasKey(a));
  }
  for (const c of rule.components) {
    const p = get(posCatalog, c.productCode);
    if (!p || p.active !== true) return fail('pos_product_missing');
    if (!unit(p.smallUnit ?? p.unit) || unit(p.smallUnit ?? p.unit) !== unit(c.unit)) return fail('identity_rule_unit_conflict');
    if (!text(p.stockCode) || p.stockFactor !== 1 || p.smallFactor !== 1) return fail('identity_rule_pos_contract_invalid');
    // Match the existing stock reader's supported shared-stock contract. This
    // registry does not introduce a new conversion model for aliases or packs.
    if (p.companySku !== p.stockCode && (p.masterStockCode !== p.stockCode || p.masterActive !== true
      || p.masterStockFactor !== 1 || p.masterSmallFactor !== p.smallFactor)) return fail('shared_stock_conversion_unverified');
    if (!evidence.some(e => e.kind === 'pos_unit' && e.productCode === c.productCode
      && unit(e.unit) === unit(c.unit) && e.stockCode === p.stockCode
      && e.stockFactor === p.stockFactor && e.smallFactor === p.smallFactor
      && (p.companySku === p.stockCode || (e.masterStockCode === p.masterStockCode && e.masterActive === true
        && e.masterStockFactor === p.masterStockFactor && e.masterSmallFactor === p.masterSmallFactor)))) return fail('identity_rule_pos_contract_unverified');
  }
  return { valid: true, reasonCode: null };
}

function sourceIdentity(item) {
  const listings = [item?.listingId, item?.listingProductId, item?.productId].filter(v => v != null && text(String(v))).map(String);
  const variations = [item?.variationId, item?.listingVariationId].filter(v => v != null && text(String(v))).map(String);
  const any = listings.length + variations.length > 0;
  const invalid = any && (!listings.length || !variations.length || new Set(listings).size !== 1 || new Set(variations).size !== 1);
  return { any, invalid, listingId: listings[0], variationId: variations[0] };
}

function resolveIdentityRule({ rule, item, posCatalog, evidenceRefs } = {}) {
  const valid = validateIdentityRule(rule, { posCatalog, evidenceRefs });
  if (!valid.valid) return blocked(valid.reasonCode);
  if (rule.state === 'revoked') return blocked('identity_rule_revoked');
  const ids = sourceIdentity(item);
  if (ids.invalid || (ids.any && (ids.listingId !== rule.listingId || ids.variationId !== rule.variationId))) return blocked('source_identifier_conflict');
  if (!rule.aliases.some(a => aliasKey(a) === aliasKey(item || {}))) return blocked('identity_rule_source_drift');
  const skus = [item?.sourceSku, item?.variantSku].filter(v => v != null && text(String(v))).map(v => text(String(v)));
  if (skus.some(s => !rule.sourceSkus.includes(s))) return blocked('source_identifier_conflict');
  if (item?.sourceBarcode || item?.barcode) return blocked('source_barcode_unverified');
  const common = { quantityRuleStatus: 'verified', quantityEvidence: 'versioned_identity_and_pos_unit_evidence',
    matchSource: 'versioned_exact_listing_variation', listingProductId: rule.listingId,
    listingVariationId: rule.variationId, identityRuleId: rule.ruleId, identityRuleVersion: rule.version };
  if (rule.components.length > 1) return { ...common, status: 'bundle',
    components: rule.components.map(c => ({ companySku: c.productCode, quantityPerSale: c.quantityPerSale })) };
  const c = rule.components[0];
  return { ...common, status: 'matched', companySku: c.productCode, quantityPerSale: c.quantityPerSale, quantityUnit: c.unit };
}

function latestIdentityRules(versions) {
  if (!Array.isArray(versions) || versions.length > 100000) throw new Error('IDENTITY_RULE_SNAPSHOT_INVALID');
  const latest = new Map(), seen = new Map();
  for (const r of versions) {
    if (!plain(r) || !exactId(r.ruleId) || !Number.isSafeInteger(r.version) || r.version < 1) throw new Error('IDENTITY_RULE_SNAPSHOT_INVALID');
    const key = JSON.stringify([r.ruleId, r.version]);
    if (seen.has(key) && JSON.stringify(seen.get(key)) !== JSON.stringify(r)) throw new Error('IDENTITY_RULE_VERSION_CONFLICT');
    seen.set(key, r);
    if (!latest.has(r.ruleId) || latest.get(r.ruleId).version < r.version) latest.set(r.ruleId, r);
  }
  return [...latest.values()];
}

function createIdentityRuleMatcher({ rules = [], posCatalog, evidenceRefs } = {}) {
  const latest = JSON.parse(JSON.stringify(latestIdentityRules(rules))), identities = new Map(), aliases = new Map();
  for (const r of latest) {
    const key = identityKey(r);
    if (!identities.has(key)) identities.set(key, []);
    identities.get(key).push(r);
    for (const a of Array.isArray(r.aliases) ? r.aliases : []) {
      const k = aliasKey(a);
      if (!aliases.has(k)) aliases.set(k, []);
      aliases.get(k).push(r);
    }
  }
  // Capture an independent snapshot: a caller cannot mutate an already-created
  // matcher by changing its input rules or evidence while a ledger tx is open.
  const captured = new Map(latest.map(r => [r.ruleId, r]));
  const capturedEvidence = evidenceRefs instanceof Map ? new Map([...evidenceRefs].map(([k, v]) => [k, JSON.parse(JSON.stringify(v))])) : new Map();
  const capturedPos = posCatalog instanceof Map ? new Map([...posCatalog].map(([k, v]) => [k, { ...v }])) : new Map();
  const matchIdentity = function (shop, item, options = {}) {
    if (shop !== 'sc-drug-store') return null;
    const ids = sourceIdentity(item);
    if (ids.invalid) return blocked('source_identifier_conflict');
    const candidates = ids.any ? identities.get(identityKey(ids)) || [] : aliases.get(aliasKey(item || {})) || [];
    if (!candidates.length) {
      // An exact known alias with contradictory IDs must fence, not fall through.
      if (ids.any && aliases.has(aliasKey(item || {}))) return blocked('source_identifier_conflict');
      return null;
    }
    if (candidates.length !== 1) return blocked('identity_rule_conflict');
    return resolveIdentityRule({ rule: captured.get(candidates[0].ruleId), item,
      posCatalog: options.posCatalog || capturedPos, evidenceRefs: capturedEvidence });
  };
  matchIdentity.baseUnit = function (shop, productCode) {
    if (shop !== 'sc-drug-store') return null;
    const found = latest.filter(r => r.state === 'active' && validateIdentityRule(r, {
      posCatalog: capturedPos, evidenceRefs: capturedEvidence }).valid)
      .flatMap(r => r.components).filter(c => c.productCode === productCode);
    return found.length && new Set(found.map(c => unit(c.unit))).size === 1 ? { quantityUnit: found[0].unit } : null;
  };
  return matchIdentity;
}

function appendIdentityRule({ versions = [], rule, expectedVersion, posCatalog, evidenceRefs } = {}) {
  const latest = latestIdentityRules(versions), previous = latest.find(r => r.ruleId === rule?.ruleId);
  const current = previous?.version || 0;
  if (expectedVersion !== current || rule?.version !== current + 1) throw new Error('IDENTITY_RULE_REVISION_CONFLICT');
  if (previous && (previous.listingId !== rule.listingId || previous.variationId !== rule.variationId)) throw new Error('IDENTITY_RULE_IDENTITY_IMMUTABLE');
  if (rule?.state !== 'active') throw new Error('IDENTITY_RULE_STATE_INVALID');
  const checked = validateIdentityRule(rule, { posCatalog, evidenceRefs });
  if (!checked.valid) throw new Error(checked.reasonCode.toUpperCase());
  if (latest.some(r => r.ruleId !== rule.ruleId && r.state === 'active' && (identityKey(r) === identityKey(rule)
    || r.aliases.some(a => rule.aliases.some(b => aliasKey(a) === aliasKey(b)))))) throw new Error('IDENTITY_RULE_CONFLICT');
  return { rule: JSON.parse(JSON.stringify(rule)), changedIdentity: { listingId: rule.listingId, variationId: rule.variationId },
    previousVersion: current, version: rule.version };
}

function revokeIdentityRule({ versions = [], ruleId, expectedVersion, reason, createdAt } = {}) {
  const previous = latestIdentityRules(versions).find(r => r.ruleId === ruleId);
  if (!previous || previous.version !== expectedVersion || previous.state !== 'active') throw new Error('IDENTITY_RULE_REVISION_CONFLICT');
  if (!/^[a-z][a-z0-9_]{2,79}$/u.test(reason || '') || !date(createdAt)) throw new Error('IDENTITY_RULE_REVOCATION_INVALID');
  return { rule: { ...JSON.parse(JSON.stringify(previous)), version: previous.version + 1,
    state: 'revoked', revocationReason: reason, createdAt }, changedIdentity: { listingId: previous.listingId, variationId: previous.variationId },
  previousVersion: previous.version, version: previous.version + 1 };
}

module.exports = { IDENTITY_RULE_SCHEMA: SCHEMA, validateIdentityRule, resolveIdentityRule, createIdentityRuleMatcher,
  latestIdentityRules, appendIdentityRule, revokeIdentityRule, normalizeIdentityText: norm, normalizeIdentityUnit: unit };
