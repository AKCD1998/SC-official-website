'use strict';
const { randomUUID } = require('node:crypto');
const { appendIdentityRule, latestIdentityRules, normalizeIdentityText: norm,
  normalizeIdentityUnit: unit } = require('./shopee004IdentityRules');

const fail = code => { throw Object.assign(new Error(code), { code, statusCode: 409 }); };
const exactId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/u.test(v);
const reference = v => typeof v === 'string' && /^[A-Za-z0-9:_-]{1,160}$/u.test(v);
const aliasKey = a => JSON.stringify([norm(a?.productName), norm(a?.variantName)]);
const scopeMatches = (f, r) => f?.shopCode === 'sc-drug-store' && f.branchCode === '004'
  && f.listingId === r.listingId && f.variationId === r.variationId;
const sameComponents = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length
  && a.every(c => b.some(d => c?.productCode === d?.productCode && c?.quantityPerSale === d?.quantityPerSale && unit(c?.unit) === unit(d?.unit)));
const catalogPayload = f => JSON.stringify({ sourceSkus: [...new Set(f.sourceSkus || [])].sort(),
  aliases: [...new Set((f.aliases || []).map(aliasKey))].sort() });

// Prepare exactly one proactive approval from an already imported trusted
// evidence snapshot. No SQL, reservation writes, lifecycle actions or HTTP calls.
// The storage owner authenticates the actor and journals operationId separately.
function buildCatalogIdentityApproval({ versions = [], posCatalog, evidenceRefs } = {}, request = {}, { now = () => new Date() } = {}) {
  if (!(posCatalog instanceof Map) || !(evidenceRefs instanceof Map)
    || !exactId(request.listingId) || !exactId(request.variationId)
    || !Number.isSafeInteger(request.expectedVersion) || request.expectedVersion < 0
    || typeof request.expectedCatalogVersion !== 'string' || !request.expectedCatalogVersion.trim() || request.expectedCatalogVersion.length > 160
    || request.acknowledgeUnitEvidence !== true || !Array.isArray(request.components)
    || request.components.length < 1 || request.components.length > 20
    || !Array.isArray(request.evidenceRefs) || request.evidenceRefs.length < 2 || request.evidenceRefs.length > 50
    || request.evidenceRefs.some(r => !reference(r)) || new Set(request.evidenceRefs).size !== request.evidenceRefs.length) fail('CATALOG_MAPPING_APPROVAL_INVALID');
  const facts = request.evidenceRefs.map(ref => evidenceRefs.get(ref));
  if (facts.some(f => !f || f.verified !== true || !scopeMatches(f, request))) fail('IDENTITY_EVIDENCE_SCOPE_CONFLICT');
  const current = [...evidenceRefs.values()].filter(f => f?.kind === 'seller_catalog' && f.verified === true && scopeMatches(f, request));
  if (!current.length || current.some(f => !Number.isFinite(Date.parse(f.observedAt)))) fail('IDENTITY_CATALOG_EVIDENCE_REQUIRED');
  const latestTime = Math.max(...current.map(f => Date.parse(f.observedAt)));
  const latest = current.filter(f => Date.parse(f.observedAt) === latestTime);
  if (new Set(latest.map(catalogPayload)).size !== 1) fail('IDENTITY_CATALOG_EVIDENCE_CONFLICT');
  if (!latest.some(f => f.catalogVersion === request.expectedCatalogVersion)) fail('IDENTITY_CATALOG_VERSION_CONFLICT');
  const catalog = facts.find(f => f.kind === 'seller_catalog' && f.catalogVersion === request.expectedCatalogVersion
    && Date.parse(f.observedAt) === latestTime);
  if (!catalog) fail('IDENTITY_CATALOG_EVIDENCE_REQUIRED');
  const previousRules = latestIdentityRules(versions).filter(r => r.listingId === request.listingId && r.variationId === request.variationId);
  if (previousRules.length > 1) fail('IDENTITY_RULE_CONFLICT');
  const previous = previousRules[0] || null;
  if ((previous?.version || 0) !== request.expectedVersion) fail('IDENTITY_RULE_REVISION_CONFLICT');
  const quantityFacts = facts.filter(f => ['seller_description', 'owner_unit', 'reviewed_stock_rule'].includes(f.kind)
    && sameComponents(f.components, request.components));
  const aliases = [...new Map(quantityFacts.flatMap(f => f.aliases || []).map(a => [aliasKey(a), {
    productName: a.productName, variantName: a.variantName,
    evidenceRefs: request.evidenceRefs.filter(ref => (evidenceRefs.get(ref)?.aliases || []).some(v => aliasKey(v) === aliasKey(a))),
  }])).values()];
  if (!aliases.length) fail('IDENTITY_RULE_QUANTITY_UNVERIFIED');
  const stamp = typeof now === 'function' ? now() : now;
  const createdAt = stamp instanceof Date ? stamp.toISOString() : new Date(stamp).toISOString();
  const rule = { schemaVersion: 'shopee004-identity-rule-v1', shopCode: 'sc-drug-store', branchCode: '004',
    ruleId: previous?.ruleId || randomUUID(), version: request.expectedVersion + 1, state: 'active',
    listingId: request.listingId, variationId: request.variationId, sourceSkus: [...(catalog.sourceSkus || [])],
    aliases, components: request.components.map(c => ({ productCode: c.productCode, quantityPerSale: c.quantityPerSale,
      unit: posCatalog.get(c.productCode)?.smallUnit || c.unit })), evidenceRefs: [...request.evidenceRefs], createdAt };
  const next = appendIdentityRule({ versions, posCatalog, evidenceRefs, rule, expectedVersion: request.expectedVersion });
  return { rule: next.rule, previous, version: next.version };
}

module.exports = { buildCatalogIdentityApproval };
