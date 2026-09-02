const DEFAULT_USER_FINANCIAL_VISIBILITY = Object.freeze({
  itemSubtotal: true,
  shippingFee: false,
  totalAmount: false,
  unitPrice: false,
});

const ALL_FINANCIAL_VISIBILITY = Object.freeze({
  itemSubtotal: true,
  shippingFee: true,
  totalAmount: true,
  unitPrice: true,
});

function normalizeUserFinancialVisibility(value) {
  return {
    itemSubtotal: true,
    shippingFee: value?.shippingFee === true,
    totalAmount: value?.totalAmount === true,
    unitPrice: value?.unitPrice === true,
  };
}

function getViewerFinancialVisibility(_role, userVisibility) {
  return normalizeUserFinancialVisibility(userVisibility);
}

function sanitizeShopeeOrderFinancials(order, visibility) {
  if (!order) return order;
  const allowed = normalizeUserFinancialVisibility(visibility);
  const safe = {
    ...order,
    items: (order.items || []).map((item) => {
      const safeItem = { ...item };
      if (!allowed.unitPrice) delete safeItem.unitPrice;
      return safeItem;
    }),
  };
  if (!allowed.shippingFee) delete safe.shippingFee;
  if (!allowed.totalAmount) delete safe.totalAmount;
  return safe;
}

module.exports = {
  ALL_FINANCIAL_VISIBILITY,
  DEFAULT_USER_FINANCIAL_VISIBILITY,
  getViewerFinancialVisibility,
  normalizeUserFinancialVisibility,
  sanitizeShopeeOrderFinancials,
};
