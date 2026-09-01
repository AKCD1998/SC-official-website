const repository = require("../db/shopeeOrderRepository");

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

function summarizeSalesByProduct(orders = []) {
  const productsByKey = new Map();
  const contributingOrders = new Set();
  let totalQuantity = 0;

  orders.forEach((order) => {
    (order.items || []).forEach((item) => {
      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0) return;

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
          variant,
        };
        productsByKey.set(productKey, product);
      }

      collectCompanySkus(item.productMatch).forEach((sku) => product.companySkus.add(sku));
      product.totalQuantity += quantity;
      totalQuantity += quantity;

      const orderKey = `${order.shopCode}:${order.orderNumber}`;
      const existingOrder = product.ordersByKey.get(orderKey);
      if (existingOrder) {
        existingOrder.quantity += quantity;
      } else {
        product.ordersByKey.set(orderKey, {
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
  summarizeSalesByProduct,
};
