const repository = require("../db/shopeeOrderRepository");
const { getVerifiedBundleUnitsPerSale } = require("./shopeeProductMatcher");

function normalizeProductText(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

function collectCompanySkus(productMatch) {
  if (productMatch?.status === "matched" && productMatch.companySku) {
    return [productMatch.companySku];
  }
  if (productMatch?.status === "bundle") {
    return (productMatch.components || [])
      .map((component) => component?.companySku)
      .filter(Boolean);
  }
  return [];
}

function resolveSalesQuantity(item) {
  const listingQuantity = Number(item?.quantity);
  if (!Number.isSafeInteger(listingQuantity) || listingQuantity <= 0) return null;
  const isBundle = item?.productMatch?.status === "bundle";
  const unitsPerSale = getVerifiedBundleUnitsPerSale(item?.productMatch);
  const bundleMetadata = isBundle
    ? {
      isBundle: true,
      quantityRuleStatus: unitsPerSale ? "verified" : "requires_validation",
    }
    : {};
  if (!unitsPerSale) {
    return { listingQuantity, quantity: listingQuantity, unitsPerSale: 1, ...bundleMetadata };
  }
  const quantity = listingQuantity * unitsPerSale;
  if (!Number.isSafeInteger(quantity)) return null;
  return { listingQuantity, quantity, unitsPerSale, ...bundleMetadata };
}

function summarizeSalesByProduct(orders = []) {
  const productsByKey = new Map();
  const contributingOrders = new Set();
  let totalQuantity = 0;

  orders.forEach((order) => {
    (order.items || []).forEach((item) => {
      const quantityResolution = resolveSalesQuantity(item);
      if (!quantityResolution) return;
      const {
        isBundle = false,
        listingQuantity,
        quantity,
        quantityRuleStatus,
        unitsPerSale,
      } = quantityResolution;

      const name = String(item.name || "").trim();
      const variant = String(item.variant || "").trim();
      if (!name) return;

      const productKey = `${normalizeProductText(name)}\u0000${normalizeProductText(variant)}`;
      let product = productsByKey.get(productKey);
      if (!product) {
        product = {
          companySkus: new Set(),
          name,
          ordersByKey: new Map(),
          totalQuantity: 0,
          ...(isBundle ? { isBundle: true, quantityRuleStatus } : {}),
          ...(isBundle && quantityRuleStatus === "verified" ? { unitsPerSale } : {}),
          variant,
        };
        productsByKey.set(productKey, product);
      } else if (isBundle) {
        product.isBundle = true;
        product.quantityRuleStatus = quantityRuleStatus;
        if (quantityRuleStatus === "verified") product.unitsPerSale = unitsPerSale;
      }

      collectCompanySkus(item.productMatch).forEach((sku) => product.companySkus.add(sku));
      product.totalQuantity += quantity;
      totalQuantity += quantity;

      const orderKey = `${order.shopCode}:${order.orderNumber}`;
      const existingOrder = product.ordersByKey.get(orderKey);
      if (existingOrder) {
        existingOrder.quantity += quantity;
        if (isBundle) {
          existingOrder.isBundle = true;
          existingOrder.listingQuantity = (existingOrder.listingQuantity || 0) + listingQuantity;
          existingOrder.quantityRuleStatus = quantityRuleStatus;
          if (quantityRuleStatus === "verified") existingOrder.unitsPerSale = unitsPerSale;
        }
      } else {
        product.ordersByKey.set(orderKey, {
          ...(isBundle ? { isBundle: true, listingQuantity, quantityRuleStatus } : {}),
          ...(isBundle && quantityRuleStatus === "verified" ? { unitsPerSale } : {}),
          orderNumber: order.orderNumber,
          orderedAt: order.orderedAt,
          quantity,
          shopCode: order.shopCode,
        });
      }
      contributingOrders.add(orderKey);
    });
  });

  const products = [...productsByKey.values()]
    .map((product) => ({
      companySkus: [...product.companySkus].sort(),
      name: product.name,
      orderCount: product.ordersByKey.size,
      orders: [...product.ordersByKey.values()].sort((left, right) => (
        String(right.orderedAt || "").localeCompare(String(left.orderedAt || ""))
          || left.orderNumber.localeCompare(right.orderNumber)
      )),
      totalQuantity: product.totalQuantity,
      ...(product.isBundle ? {
        isBundle: true,
        quantityRuleStatus: product.quantityRuleStatus,
      } : {}),
      ...(product.isBundle && product.quantityRuleStatus === "verified"
        ? { unitsPerSale: product.unitsPerSale }
        : {}),
      variant: product.variant,
    }))
    .sort((left, right) => (
      right.totalQuantity - left.totalQuantity
        || left.name.localeCompare(right.name, "th")
        || left.variant.localeCompare(right.variant, "th")
    ))
    .map((product, index) => ({ id: String(index + 1), ...product }));

  return {
    orderCount: contributingOrders.size,
    productCount: products.length,
    products,
    totalQuantity,
  };
}

async function getShopeeSalesSummary({ endDate, shopCode, startDate }) {
  const orders = await repository.listOrdersForSalesSummary({ endDate, shopCode, startDate });
  return summarizeSalesByProduct(orders);
}

module.exports = {
  getShopeeSalesSummary,
  normalizeProductText,
  resolveSalesQuantity,
  summarizeSalesByProduct,
};
