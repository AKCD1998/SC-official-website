jest.mock("../db", () => ({
  query: jest.fn(),
}));

const pool = require("../db");
const {
  getUserFinancialVisibility,
  mapSettings,
  updateUserFinancialVisibility,
} = require("../src/modules/seamless/db/shopeeFinancialVisibilityRepository");

beforeEach(() => {
  jest.clearAllMocks();
});

test("missing settings fail closed to item subtotal only", () => {
  expect(mapSettings(null)).toEqual({
    itemSubtotal: true,
    shippingFee: false,
    totalAmount: false,
    unitPrice: false,
    updatedAt: null,
    updatedBy: "",
  });
});

test("reads the singleton user visibility policy", async () => {
  pool.query.mockResolvedValueOnce({
    rows: [{
      user_can_view_shipping_fee: true,
      user_can_view_total_amount: false,
      user_can_view_unit_price: true,
      updated_at: new Date("2026-09-02T01:00:00.000Z"),
      updated_by: "admin001",
    }],
  });

  const result = await getUserFinancialVisibility();

  expect(result).toMatchObject({
    itemSubtotal: true,
    shippingFee: true,
    totalAmount: false,
    unitPrice: true,
    updatedBy: "admin001",
  });
  expect(pool.query.mock.calls[0][0]).toContain("shopee_financial_visibility_settings");
});

test("updates every mutable field atomically with an audit actor", async () => {
  pool.query.mockResolvedValueOnce({
    rows: [{
      user_can_view_shipping_fee: true,
      user_can_view_total_amount: true,
      user_can_view_unit_price: false,
      updated_at: new Date("2026-09-02T02:00:00.000Z"),
      updated_by: "root-admin",
    }],
  });

  const result = await updateUserFinancialVisibility({
    shippingFee: true,
    totalAmount: true,
    unitPrice: false,
  }, "root-admin");

  expect(result.totalAmount).toBe(true);
  expect(pool.query.mock.calls[0][1]).toEqual([false, true, true, "root-admin"]);
});
