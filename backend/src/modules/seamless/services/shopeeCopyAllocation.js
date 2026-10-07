// Owner-approved accounting allocations are separate from Shopee source prices.
// Keep all arithmetic in integer satang and leave the immutable source untouched.
function allocateCents(total, weights) {
  if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(weights)
    || !weights.length || weights.some(value => !Number.isSafeInteger(value) || value < 0)) return null;
  const denominator = weights.reduce((sum, value) => sum + BigInt(value), 0n);
  if (denominator === 0n) return total === 0 ? weights.map(() => 0) : null;
  const parts = weights.map((weight, index) => {
    const numerator = BigInt(total) * BigInt(weight);
    return { index, amount: Number(numerator / denominator), remainder: numerator % denominator };
  });
  let remaining = total - parts.reduce((sum, part) => sum + part.amount, 0);
  const ranked = [...parts].sort((a, b) => a.remainder === b.remainder ? a.index - b.index
    : a.remainder > b.remainder ? -1 : 1);
  for (const part of ranked) if (remaining > 0) { part.amount += 1; remaining -= 1; }
  return parts.map(part => part.amount);
}

function approvedPolicy(policies, shopCode, matches) {
  const candidates = (Array.isArray(policies) ? policies : []).filter(row => row?.shopCode === shopCode && row.enabled === true && matches(row.policy));
  if (candidates.length !== 1) return null;
  const record = candidates[0];
  if (!record.policyKey || !record.approvedBy?.trim() || !Number.isFinite(Date.parse(record.approvedAt))
    || record.approval?.kind !== 'user_confirmed_allocation' || !record.approval.caseId
    || !/^[a-f0-9]{64}$/u.test(record.approval.responseSha256 || '')) return null;
  return record;
}

function sellerAllocationPolicy(policies, shopCode) {
  return approvedPolicy(policies, shopCode, policy => policy?.type === 'seller_voucher'
    && policy.method === 'proportional_net_merchandise_largest_remainder');
}

function bundleAllocation(policies, shopCode, item, components, totalCents) {
  // A renamed listing may reuse an approval only through an exact, evidenced
  // rule with the same component identities and quantities. Never infer an
  // approval from a brand name, similar wording, or an equal bundle amount.
  const rules = require('../data/shopeeAdaSmartCopyRules.v1.json');
  const alias = rules.rules.find(row => row.shopCode === shopCode
    && row.productName === item.name && row.variant === (item.variant || '')
    && row.allocationIdentity && row.evidence?.allocationReuseBasis
    && row.components?.length === components.length
    && row.components.every(part => components.some(component =>
      component.sku === part.companySku && component.factor === part.quantityPerSale)));
  const identity = alias?.allocationIdentity || { productName: item.name, variant: item.variant || '' };
  const record = approvedPolicy(policies, shopCode, policy => policy?.type === 'bundle'
    && policy.productName === identity.productName && policy.variant === identity.variant);
  const policy = record?.policy;
  if (!policy || !['paid_component_and_free_gift', 'equal_components'].includes(policy.method)
    || !Array.isArray(policy.components) || policy.components.length !== components.length) return null;
  const parts = components.map(component => ({ ...component,
    allocation: policy.components.find(row => row.sku === component.sku && row.factor === component.factor) }));
  if (parts.some(row => !row.allocation || !Number.isSafeInteger(row.allocation.weight) || row.allocation.weight < 0)
    || new Set(policy.components.map(row => row.sku)).size !== components.length) return null;
  if (policy.method === 'paid_component_and_free_gift' && (parts.filter(row => row.allocation.weight > 0).length !== 1
    || parts.some(row => row.allocation.weight === 0 && row.allocation.freeGift !== true)
    || parts.some(row => row.allocation.weight > 0 && row.allocation.freeGift === true))) return null;
  if (policy.method === 'equal_components' && (parts.some(row => row.allocation.weight !== 1 || row.allocation.freeGift)
    || !Number.isSafeInteger(policy.sourcePriceCentsPerSale)
    || totalCents !== policy.sourcePriceCentsPerSale * item.quantity)) return null;
  const amounts = allocateCents(totalCents, parts.map(row => row.allocation.weight));
  if (!amounts) return null;
  return { record, components: parts.map((row, index) => ({ sku: row.sku, factor: row.factor,
    name: row.name, unit: row.unit, amountCents: amounts[index], freeGift: row.allocation.freeGift === true })) };
}

function policyReference(record) {
  return { policyKey: record.policyKey, shopCode: record.shopCode, policy: record.policy,
    approval: record.approval, approvedBy: record.approvedBy, approvedAt: record.approvedAt };
}

module.exports = { allocateCents, sellerAllocationPolicy, bundleAllocation, policyReference };
