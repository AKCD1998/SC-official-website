const {
  DEFAULT_USER_FINANCIAL_VISIBILITY,
  getViewerFinancialVisibility,
  sanitizeShopeeOrderFinancials,
} = require("../src/modules/seamless/services/shopeeFinancialVisibilityService");

const order = {
  itemSubtotal: 90,
  items: [{ name: "Vitamin C Gummy", quantity: 1, unitPrice: 90 }],
  orderNumber: "260612V6TNNMU2",
  shippingFee: 35,
  totalAmount: 125,
};

test("regular-user defaults expose item subtotal only and remove hidden values server-side", () => {
  const visibility = getViewerFinancialVisibility("user", DEFAULT_USER_FINANCIAL_VISIBILITY);
  const safe = sanitizeShopeeOrderFinancials(order, visibility);

  expect(safe.itemSubtotal).toBe(90);
  expect(safe).not.toHaveProperty("shippingFee");
  expect(safe).not.toHaveProperty("totalAmount");
  expect(safe.items[0]).not.toHaveProperty("unitPrice");
  expect(order.shippingFee).toBe(35);
  expect(order.items[0].unitPrice).toBe(90);
});

test("an admin receives the same default financial fields as every other account", () => {
  const visibility = getViewerFinancialVisibility("admin", DEFAULT_USER_FINANCIAL_VISIBILITY);
  const safe = sanitizeShopeeOrderFinancials(order, visibility);

  expect(visibility).toEqual(DEFAULT_USER_FINANCIAL_VISIBILITY);
  expect(safe.itemSubtotal).toBe(90);
  expect(safe).not.toHaveProperty("shippingFee");
  expect(safe).not.toHaveProperty("totalAmount");
  expect(safe.items[0]).not.toHaveProperty("unitPrice");
});

test("regular users receive only the extra fields explicitly enabled by an admin", () => {
  const visibility = getViewerFinancialVisibility("user", {
    shippingFee: true,
    totalAmount: false,
    unitPrice: true,
  });
  const safe = sanitizeShopeeOrderFinancials(order, visibility);

  expect(safe.shippingFee).toBe(35);
  expect(safe.items[0].unitPrice).toBe(90);
  expect(safe).not.toHaveProperty("totalAmount");
});
