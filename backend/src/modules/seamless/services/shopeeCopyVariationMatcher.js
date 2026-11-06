'use strict';

const rules = require('../data/shopeeAdaSmartCopyRules.v1.json');
const { localDate, validDate } = require('./shopeeCopyBusinessDate');
const { normalizeIdentityUnit } = require('./shopee004IdentityRules');

const SC = 'sc-drug-store';
const VERSION = 'sc-copy-variation-phase1-v1';
const id = value => typeof value === 'string' && /^\d{1,40}$/u.test(value);
const hash = value => /^[a-f0-9]{64}$/u.test(value || '');
const label = value => String(value ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim();
const aliasKey = (name, variant) => JSON.stringify([label(name), label(variant)]);
const variantKey = e => JSON.stringify([e.listingId, e.variationId]);

function append(index, key, value) {
  const values = index.get(key) || [];
  values.push(value);
  index.set(key, values);
}

function buildCopyVariationMatcher(registry = rules) {
  const masters = new Map(registry.masters.map(row => [row.companySku, row]));
  const exact = new Map();
  for (const row of registry.rules.filter(row => row.shopCode === SC)) {
    append(exact, aliasKey(row.productName, row.variant), row);
  }
  const aliases = new Map();
  const byVariation = new Map();
  const bySku = new Map();
  const holds = new Set((registry.copyIdentityHolds || []).filter(row => row.shopCode === SC)
    .map(row => aliasKey(row.productName, row.variant)));
  for (const row of registry.supplementalCopyIdentities.filter(row => row.shopCode === SC)) {
    const e = row.evidence;
    if (!id(e?.listingId) || !id(e.variationId)) continue;
    // SKU matches are only hints, even for other verified exact-name rules.
    if (row.status === 'verified' && row.companySku) append(bySku, row.companySku, row);
    for (const period of row.variationReusePeriods || []) {
      const prior = period.prior;
      const anchors = exact.get(aliasKey(prior?.productName, prior?.variant)) || [];
      const anchor = anchors.length === 1 ? anchors[0] : null;
      const master = masters.get(anchor?.companySku);
      const pos = e.pos;
      const verified = Boolean(anchor?.authority && !anchor.components && !row.components
        && row.status === 'verified' && row.scope === 'accounting_copy_only'
        && anchor.companySku === row.companySku && row.companySku === e.sellerSku
        && pos?.companySku === anchor.companySku && pos.active === 1 && pos.smallFactor === 1
        && master?.unit && master.name && normalizeIdentityUnit(master.unit) === normalizeIdentityUnit(pos.smallUnit)
        && Number.isSafeInteger(anchor.quantityPerSale) && anchor.quantityPerSale > 0 && anchor.quantityPerSale <= 1000
        && anchor.quantityPerSale === row.quantityPerSale
        && prior?.listingId === e.listingId && prior.variationId === e.variationId && prior.sellerSku === e.sellerSku
        && /^\d{8,14}$/u.test(e.sellerPackBarcode || '') && prior.sellerPackBarcode === e.sellerPackBarcode
        && [e.sellerSourceSha256, e.descriptionSourceSha256, e.posSourceSha256,
          prior?.sellerSourceSha256, prior?.descriptionSourceSha256].every(hash)
        && [e.sellerSourceRow, e.descriptionSourceRow, prior?.sellerSourceRow, prior?.descriptionSourceRow]
          .every(value => Number.isSafeInteger(value) && value > 1)
        && validDate(period.validFrom) && validDate(period.validThrough)
        && period.validFrom <= period.validThrough && period.packBasis && e.packBasis);
      const record = { row, period, anchor, master, verified };
      append(byVariation, e.variationId, record);
      if (period.sellerAliasUnique === true) append(aliases, aliasKey(row.productName, row.variant), record);
      if (prior?.sellerAliasUnique === true && aliasKey(prior.productName, prior.variant) !== aliasKey(row.productName, row.variant)) {
        append(aliases, aliasKey(prior.productName, prior.variant), record);
      }
    }
  }

  function resolve(shopCode, item, order) {
    if (shopCode !== SC) return null;
    const source = item.copySourceIdentity;
    const key = aliasKey(item.name, item.variant);
    const named = aliases.get(key) || [];
    const hints = [...new Map((bySku.get(source?.sourceSku) || []).map(row => [variantKey(row.evidence), {
      listingId:row.evidence.listingId, variationId:row.evidence.variationId, sku:row.companySku,
      productName:row.productName, variant:row.variant,
    }])).values()].slice(0, 8);
    const review = (reasonCode, identity, inScope = true) => ({ status:'review', inScope, reasonCode,
      reviewKey:JSON.stringify([SC, identity || [key, source?.listingId || '', source?.variationId || '', source?.sourceSku || '']]),
      candidates:hints });
    if (holds.has(key)) return review('existing_copy_identity_hold');
    const identified = source?.variationId ? byVariation.get(source.variationId) || [] : named;
    if (!identified.length && !named.length) return review('no_verified_variation_rule', null, false);
    const stableKeys = new Set(identified.map(r => variantKey(r.row.evidence)));
    const identity = stableKeys.size === 1 ? [...stableKeys][0] : null;
    if (!source?.sourceSku || source.invalid || (source.listingId && !id(source.listingId))
      || (source.variationId && !id(source.variationId))) return review('missing_or_invalid_order_identity', identity);

    const date = localDate(order?.orderedAt);
    const active = identified.filter(r => date && date >= r.period.validFrom && date <= r.period.validThrough);
    if (!identified.length) return review('order_variation_conflict');
    if (!active.length) return review('outside_verified_pack_period', identity);
    // Evaluate uniqueness before using SKU as corroboration. A SKU can be
    // shared by multiple offers and package sizes.
    if (active.length !== 1) return review('ambiguous_variation_or_pack_period', identity);
    const { row, period, anchor, master, verified } = active[0];
    const e = row.evidence;
    if (!verified) return review('seller_pos_pack_evidence_conflict', identity);
    const namedActive = named.filter(r => date >= r.period.validFrom && date <= r.period.validThrough);
    const conflictingLabel = (namedActive.length ? namedActive : named).some(r =>
      variantKey(r.row.evidence) !== variantKey(e) || r.row.quantityPerSale !== row.quantityPerSale);
    if ((source.listingId && source.listingId !== e.listingId)
      || conflictingLabel || source.sourceSku !== e.sellerSku) return review('order_variation_conflict', identity);
    return { status:'matched', product:{ sku:anchor.companySku, factor:anchor.quantityPerSale,
      unit:master.unit, name:master.name, authority:'verified_copy_variation_reuse',
      originalMatch:item.productMatch, matchingProvenance:{ version:VERSION,
        method:source.variationId ? 'order_variation_id' : 'unique_seller_alias',
        listingId:e.listingId, variationId:e.variationId, validFrom:period.validFrom, validThrough:period.validThrough,
        anchorProductName:anchor.productName, anchorVariant:anchor.variant,
        sellerSourceSha256:e.sellerSourceSha256, posSourceSha256:e.posSourceSha256 } } };
  }

  return { resolve };
}

function groupCopyVariationReviews(entries) {
  const groups = new Map();
  for (const { decision, orderNumber, productName, variant } of entries) {
    if (decision?.status !== 'review') continue;
    const group = groups.get(decision.reviewKey) || {
      productName, variant, lineCount:0, orders:new Set(), reasons:new Set(), candidates:new Map(),
    };
    group.lineCount++;
    group.orders.add(orderNumber);
    group.reasons.add(decision.reasonCode);
    for (const candidate of decision.candidates) group.candidates.set(variantKey(candidate), candidate);
    groups.set(decision.reviewKey, group);
  }
  return [...groups.values()].map(({ orders, reasons, candidates, ...group }) => ({
    ...group, orderNumbers:[...orders].sort(), reasonCodes:[...reasons].sort(), candidates:[...candidates.values()],
  }));
}

module.exports = { buildCopyVariationMatcher, groupCopyVariationReviews, VERSION };
