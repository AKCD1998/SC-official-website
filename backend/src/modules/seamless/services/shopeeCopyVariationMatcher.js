'use strict';

const rules = require('../data/shopeeAdaSmartCopyRules.v1.json');
const { localDate, validDate } = require('./shopeeCopyBusinessDate');
const { normalizeIdentityUnit } = require('./shopee004IdentityRules');

const SC = 'sc-drug-store';
const VERSION = 'sc-copy-variation-phase1-v3';
const id = value => typeof value === 'string' && /^\d{1,40}$/u.test(value);
const hash = value => /^[a-f0-9]{64}$/u.test(value || '');
const label = value => String(value ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim();
const aliasKey = (name, variant) => JSON.stringify([label(name), label(variant)]);
const variantKey = e => JSON.stringify([e.listingId, e.variationId]);
const covers = (period, date) => date && date >= period.validFrom && date <= period.validThrough;

function append(index, key, value) {
  const values = index.get(key) || [];
  values.push(value);
  index.set(key, values);
}

function reviewedOrderProduct(row, item, exactRules, sellers, master) {
  const e = row.evidence;
  const source = item.copySourceIdentity;
  const { pos, posBarcode, posPackFactor } = e;
  const previous = row.orderLineReview.previous;
  const priorMatches = previous ? exactRules.length === 1 && !exactRules[0].components
    && exactRules[0].companySku === previous.companySku
    && exactRules[0].quantityPerSale === previous.factor
    && exactRules[0].authority === previous.authority : exactRules.length === 0;
  const unit = pos?.smallUnit;
  const factor = row.quantityPerSale;
  if (!source?.sourceSku || source.invalid || source.sourceSku !== e.sellerSku
    || (source.listingId && source.listingId !== e.listingId)
    || (source.variationId && source.variationId !== e.variationId)
    || !priorMatches || sellers.some(other => variantKey(other.evidence) !== variantKey(e)
      || other.companySku !== row.companySku || other.quantityPerSale !== factor)
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(row.companySku || '')
    || !pos?.productName || pos.companySku !== row.companySku || pos.active !== 1 || pos.smallFactor !== 1
    || !unit || (master && normalizeIdentityUnit(master.unit) !== normalizeIdentityUnit(unit))
    || !Number.isSafeInteger(factor) || factor < 1 || factor > 1000 || posPackFactor !== factor
    || !/^\d{8,14}$/u.test(e.sellerPackBarcode || '') || posBarcode?.value !== e.sellerPackBarcode
    || (posBarcode.factor !== factor && posBarcode.factor !== 1)
    || (row.companySku !== e.sellerSku && (posBarcode.factor !== factor || previous?.companySku !== row.companySku))
    || ![e.sellerSourceSha256,e.descriptionSourceSha256,e.posSourceSha256,e.posBarcodeSourceSha256,
      e.priorSellerSourceSha256,e.priorDescriptionSourceSha256].every(hash)
    || !e.packBasis) return null;
  return { sku:row.companySku,factor,unit,name:master?.name || pos.productName,
    authority:'verified_copy_order_line_review',originalMatch:item.productMatch,
    matchingProvenance:{ version:VERSION,method:'reviewed_order_line',listingId:e.listingId,variationId:e.variationId,
      sourceSku:e.sellerSku,packBarcode:e.sellerPackBarcode,sellerSourceSha256:e.sellerSourceSha256,
      posBarcodeSourceSha256:e.posBarcodeSourceSha256 } };
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
  const sellerLabels = new Map();
  const reviewedLabels = new Map();
  const holds = new Set((registry.copyIdentityHolds || []).filter(row => row.shopCode === SC)
    .map(row => aliasKey(row.productName, row.variant)));
  for (const row of registry.supplementalCopyIdentities.filter(row => row.shopCode === SC)) {
    const e = row.evidence;
    if (!id(e?.listingId) || !id(e.variationId)) continue;
    if (row.status === 'verified' && row.scope === 'accounting_shadow_only' && row.orderLineReview) {
      append(reviewedLabels,aliasKey(row.productName,row.variant),row);
    }
    // SKU matches are only hints, even for other verified exact-name rules.
    if (row.status === 'verified' && row.scope === 'accounting_copy_only') {
      append(sellerLabels, aliasKey(row.productName, row.variant), row);
      if (row.companySku) append(bySku, row.companySku, row);
    }
    for (const period of row.variationReusePeriods || []) {
      const prior = period.prior;
      const anchors = exact.get(aliasKey(prior?.productName, prior?.variant)) || [];
      const anchor = anchors.length === 1 ? anchors[0] : null;
      const master = masters.get(anchor?.companySku);
      const pos = e.pos;
      const fresh = period.reconfirmed;
      const reconfirmed = !fresh || (validDate(fresh.observedDate) && fresh.observedDate >= period.validThrough
        && [fresh.sellerSourceSha256,fresh.descriptionSourceSha256,fresh.posSourceSha256].every(hash)
        && [fresh.sellerSourceRow,fresh.descriptionSourceRow].every(value => Number.isSafeInteger(value) && value > 1));
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
        && period.validFrom <= period.validThrough && period.packBasis && e.packBasis && reconfirmed);
      const record = { row, period, anchor, master, verified };
      append(byVariation, e.variationId, record);
      if (period.sellerAliasUnique === true) append(aliases, aliasKey(row.productName, row.variant), record);
      if (prior?.sellerAliasUnique === true && aliasKey(prior.productName, prior.variant) !== aliasKey(row.productName, row.variant)) {
        append(aliases, aliasKey(prior.productName, prior.variant), record);
      }
    }
  }

  function resolve(shopCode, item, order, sourceRow) {
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
    const date = localDate(order?.orderedAt);
    const exactRules = exact.get(key) || [];
    const sellers = (sellerLabels.get(key) || []).filter(row =>
      !row.variationReusePeriods?.length || row.variationReusePeriods.some(period => covers(period,date)));
    const reviewed = (reviewedLabels.get(key) || []).filter(row =>
      Number.isSafeInteger(sourceRow) && hash(order?.sourceSha256) && order.sourceRows?.includes(sourceRow)
      && row.orderLineReview.sources?.some(file => file.sha256 === order.sourceSha256 && file.rows?.includes(sourceRow)));
    if (reviewed.length) {
      const row = reviewed[0];
      const reviewedIdentity = variantKey(row.evidence);
      if (reviewed.length !== 1 || named.some(record => covers(record.period,date))) {
        return review('ambiguous_variation_or_pack_period',reviewedIdentity);
      }
      const product = reviewedOrderProduct(row,item,exactRules,sellers,masters.get(row.companySku));
      return product ? { status:'matched',product } : review('order_variation_conflict',reviewedIdentity);
    }
    const known = [...exactRules, ...sellers];
    const identified = source?.variationId ? byVariation.get(source.variationId) || [] : named;
    const stableKeys = new Set(identified.map(r => variantKey(r.row.evidence)));
    const identity = stableKeys.size === 1 ? [...stableKeys][0] : null;
    if (source?.invalid) return review('missing_or_invalid_order_identity', identity);
    if (!identified.length && !named.length) {
      // An exact existing match can stay the fallback only when its own known
      // Seller identifiers and SKU do not contradict the workbook.
      if (known.some(row => row.companySku && source?.sourceSku && row.companySku !== source.sourceSku)
        || sellers.some(row => (source?.listingId && source.listingId !== row.evidence.listingId)
          || (source?.variationId && source.variationId !== row.evidence.variationId))) {
        return review('order_variation_conflict');
      }
      return review('no_verified_variation_rule', null, false);
    }
    if (!source?.sourceSku || (source.listingId && !id(source.listingId))
      || (source.variationId && !id(source.variationId))) return review('missing_or_invalid_order_identity', identity);

    const active = identified.filter(r => covers(r.period,date));
    if (!identified.length) return review('order_variation_conflict');
    if (!active.length) {
      const prior = identified.find(r => r.verified && date && date < r.period.validFrom
        && key === aliasKey(r.anchor.productName,r.anchor.variant) && source.sourceSku === r.row.evidence.sellerSku
        && (!source.listingId || source.listingId === r.row.evidence.listingId));
      if (prior && stableKeys.size === 1 && exactRules.length === 1
        && sellers.every(row => variantKey(row.evidence) === variantKey(prior.row.evidence))) {
        return review('historical_exact_rule', identity, false);
      }
      return review('outside_verified_pack_period', identity);
    }
    // Evaluate uniqueness before using SKU as corroboration. A SKU can be
    // shared by multiple offers and package sizes.
    if (active.length !== 1) return review('ambiguous_variation_or_pack_period', identity);
    const { row, period, anchor, master, verified } = active[0];
    const e = row.evidence;
    if (!verified) return review('seller_pos_pack_evidence_conflict', identity);
    const namedActive = named.filter(r => covers(r.period,date));
    const conflictingLabel = (namedActive.length ? namedActive : named).some(r =>
      variantKey(r.row.evidence) !== variantKey(e) || r.row.companySku !== row.companySku
      || r.row.quantityPerSale !== row.quantityPerSale);
    const conflictingPack = known.some(other => other.components || other.companySku !== row.companySku
      || other.quantityPerSale !== row.quantityPerSale
      || (other.evidence?.pos && normalizeIdentityUnit(other.evidence.pos.smallUnit) !== normalizeIdentityUnit(master.unit)));
    if ((source.listingId && source.listingId !== e.listingId)
      || conflictingLabel || conflictingPack || sellers.some(other => variantKey(other.evidence) !== variantKey(e))
      || source.sourceSku !== e.sellerSku) return review('order_variation_conflict', identity);
    // Even native IDs may be carried over when a listing is repacked. A new
    // label needs Seller evidence for this offer and period before reuse.
    if (!namedActive.some(r => r === active[0])) return review('unverified_order_pack_label', identity);
    return { status:'matched', product:{ sku:anchor.companySku, factor:anchor.quantityPerSale,
      unit:master.unit, name:master.name, authority:'verified_copy_variation_reuse',
      originalMatch:item.productMatch, matchingProvenance:{ version:VERSION,
        method:source.variationId ? 'order_variation_id' : 'unique_seller_alias',
        listingId:e.listingId, variationId:e.variationId, validFrom:period.validFrom, validThrough:period.validThrough,
        anchorProductName:anchor.productName, anchorVariant:anchor.variant,
        sellerSourceSha256:e.sellerSourceSha256, posSourceSha256:e.posSourceSha256,
        ...(period.reconfirmed ? { reconfirmed:period.reconfirmed } : {}) } } };
  }

  return { resolve };
}

function selectCopyVariationShadowResult(decision) {
  if (decision?.status === 'matched') return decision.product;
  if (decision?.status === 'review' && decision.inScope) {
    return { reason:decision.reasonCode, matchingReview:decision };
  }
  // Only evidence that is out of scope can defer to the legacy resolver.
  return null;
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

module.exports = { buildCopyVariationMatcher, groupCopyVariationReviews, selectCopyVariationShadowResult, VERSION };
