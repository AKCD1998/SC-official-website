const { classifyReviewReason, MAPPING_REASONS } = require('./shopee004RecoveryPolicy');
const { mapShopeeStockLines } = require('./shopeeStockReservationShadow');
const clean = (value, maximum = 500) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, maximum) : '';
const iso = value => value ? new Date(value).toISOString() : null;
const identityText=value=>typeof value==='string'?value.normalize('NFKC').trim().replace(/\s+/gu,' ').toLowerCase():'';
function exceptionRevision(row) {
  return `${row.audit_revision || '0'}:${row.dirty_revision || '0'}:${iso(row.queued_at) || ''}`;
}
function selectExceptionItem(row,catalog,{matchItem}={}) {
  const current=Array.isArray(row.items)?row.items:[],original=Array.isArray(row.source_snapshot?.items)?row.source_snapshot.items:[];
  const reference=current.find(item=>item&&typeof item==='object'&&!Array.isArray(item))
    ||original.find(item=>item&&typeof item==='object'&&!Array.isArray(item))||{};
  const fallback={item:reference,source:'reference-only',issueConfirmed:false,mappingApplicable:false,reasonCodes:[],unresolvedItemCount:0};
  const reasons=Array.isArray(row.reasons)?row.reasons:[];
  if(!reasons.some(reason=>MAPPING_REASONS.includes(reason)))return fallback;
  const failures=[],seen=new Set();
  for(const [source,items] of [['current-issue',current],['original-issue',original]]) {
    if(items.length>1000)return fallback;
    for(const item of items) {
      if(!item||typeof item!=='object'||Array.isArray(item))continue;
      let mapped;try{mapped=mapShopeeStockLines({items:[item],posCatalog:catalog,matchItem});}catch{return fallback;}
      if(mapped.status==='mapped')continue;
      const key=JSON.stringify([item.listingId,item.listingProductId,item.productId,item.variationId,item.listingVariationId,
        item.name||item.productName,item.variant||item.variantName,item.sourceSku,item.variantSku]);
      if(seen.has(key))continue;seen.add(key);
      const reasonCodes=Object.keys(mapped.reasonCounts),mappingApplicable=reasonCodes.some(reason=>MAPPING_REASONS.includes(reason))
        &&typeof(item.name||item.productName)==='string'&&!!(item.name||item.productName).trim();
      failures.push({item,source,issueConfirmed:true,mappingApplicable,reasonCodes});
    }
  }
  if(!failures.length)return fallback;
  const selected=failures.find(failure=>failure.mappingApplicable)||failures[0];
  return {...selected,unresolvedItemCount:failures.length};
}
function publicException(row,{selection}={}) {
  const current = Array.isArray(row.items) ? row.items : [];
  const original = Array.isArray(row.source_snapshot?.items) ? row.source_snapshot.items : [];
  const item = selection?.item || current[0] || original[0] || {};
  const reasons = Array.isArray(row.reasons) ? row.reasons : [];
  const newRevision = row.dirty_revision != null && String(row.recovery_revision) !== String(row.dirty_revision);
  const mappingReasons = reasons.filter(reason => ['identity','unit'].includes(classifyReviewReason(reason)));
  const reasonCode = newRevision ? 'PROCESSING_PENDING' : row.last_error_code || selection?.reasonCodes?.[0] || mappingReasons[0] || reasons[0] || 'PROCESSING_PENDING';
  const issueClass = classifyReviewReason(reasonCode);
  const requiresLifecycleReview = reasons.some(reason => classifyReviewReason(reason) === 'lifecycle');
  return { exceptionId: row.exception_id, revision: exceptionRevision(row),
    listingId: clean(String(item.listingId || item.listingProductId || item.productId || ''), 100),
    variationId: clean(String(item.listingVariationId || item.variationId || ''), 100),
    productName: clean(item.name || item.productName), variantName: clean(item.variant || item.variantName),
    reasonCode, issueClass, reasonCodes: reasons, observedUnit: clean(item.unit || item.quantityUnit, 80) || null,
    proposedMatches: [], evidence: [], affectedOrders: 1, affectedProducts: row.retained_codes || [],
    itemCount: current.length, itemContext:selection?.source||'reference-only',itemIssueConfirmed:selection?.issueConfirmed===true,
    itemReasonCodes:selection?.reasonCodes||[],unresolvedItemCount:selection?.unresolvedItemCount||0,
    canApproveMapping:!newRevision&&selection?.mappingApplicable===true,
    requiresLifecycleReview, ruleVersion: null,
    recovery: { state: newRevision ? 'ready' : row.recovery_state || null, attempts: newRevision ? 0 : row.attempt_count || 0,
      nextRetryAt: !newRevision&&row.recovery_state==='retry_wait'?iso(row.retry_after):null,
      firstFailedAt: iso(row.first_failed_at), lastFailedAt: iso(row.last_failed_at) } };
}
function itemMatchesIdentity(item, identity) {
  if (!item || typeof item !== 'object') return false;
  const listing = String(item.listingId || item.listingProductId || item.productId || '');
  const variation = String(item.listingVariationId || item.variationId || '');
  const listingIds=[item.listingId,item.listingProductId,item.productId].filter(v=>v!=null&&String(v));
  const conflicting = new Set(listingIds.map(String)).size>1
    || item.listingVariationId && item.variationId && String(item.listingVariationId) !== String(item.variationId);
  if (conflicting) return false;
  if (listing || variation) return listing === identity.listingId && variation === identity.variationId;
  return (identity.aliases || []).some(alias => identityText(item.name || item.productName) === identityText(alias.productName)
    && identityText(item.variant || item.variantName) === identityText(alias.variantName));
}
function ruleAffectsOrder(row, { identities = [], productCodes = [] }) {
  if ((row.retained_codes || []).some(code => productCodes.includes(code))) return true;
  return [row.items, row.source_snapshot?.items].filter(Array.isArray).some(items =>
    items.some(item => identities.some(identity => itemMatchesIdentity(item, identity))));
}
module.exports = { publicException, selectExceptionItem, exceptionRevision, ruleAffectsOrder, itemMatchesIdentity };
