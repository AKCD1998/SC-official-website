const express = require("express");
const request = require("supertest");

const ORDER_NUMBER = "26082471YK8C02";
const listMock = jest.fn(async () => ({
  hasMore: false,
  orders: [{
    currentStatus: "shipment_due",
    decision: null,
    eventCount: 1,
    evidence: {
      evidenceStatus: "recipient_match",
      matchedEventCount: 1,
      suggestedShopCode: "dr-morepen",
      totalEventCount: 1,
    },
    lastEventAt: "2026-08-24T03:00:00.000Z",
    orderNumber: ORDER_NUMBER,
  }],
}));
const reviewMock = jest.fn(async ({ orderNumber, selectedShopCode }) => ({
  decision: { orderNumber, selectedShopCode },
  orderNumber,
  reviewOnly: true,
}));

jest.mock("../src/modules/seamless/services/shopeeLegacyReconciliationService", () => ({
  listLegacyReconciliationPage: (...args) => listMock(...args),
  reviewLegacyOrder: (...args) => reviewMock(...args),
}));

const { errorHandler } = require("../src/modules/seamless/middleware/errorHandler");

function buildApp() {
  delete require.cache[require.resolve("../src/modules/seamless/middleware/appAuth")];
  delete require.cache[require.resolve("../src/modules/seamless/routes/shopeeEmailRoutes")];
  const routes = require("../src/modules/seamless/routes/shopeeEmailRoutes");
  const app = express();
  app.use(express.json());
  app.use("/api/app/shopee", routes);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SEAMLESS_APP_BASIC_USER;
  delete process.env.SEAMLESS_APP_BASIC_PASSWORD;
  delete process.env.SEAMLESS_APP_ADMIN_BASIC_USER;
  delete process.env.SEAMLESS_APP_ADMIN_BASIC_PASSWORD;
});

test("admin can list safe review candidates and save a review-only choice", async () => {
  const list = await request(buildApp()).get(
    "/api/app/shopee/orders/legacy-reconciliation?status=pending&limit=10",
  );
  expect(list.status).toBe(200);
  expect(list.body.reviewOnly).toBe(true);
  expect(JSON.stringify(list.body)).not.toMatch(/gmail|mailbox|subject|buyer/iu);

  const save = await request(buildApp())
    .post(`/api/app/shopee/orders/legacy-reconciliation/${ORDER_NUMBER}`)
    .send({ shopCode: "dr-morepen" });
  expect(save.status).toBe(200);
  expect(save.body.reviewOnly).toBe(true);
  expect(reviewMock).toHaveBeenCalledWith({
    orderNumber: ORDER_NUMBER,
    selectedShopCode: "dr-morepen",
  });
});

test("regular app users cannot view or change legacy attribution decisions", async () => {
  process.env.SEAMLESS_APP_BASIC_USER = "staff";
  process.env.SEAMLESS_APP_BASIC_PASSWORD = "staff-password";
  const response = await request(buildApp())
    .get("/api/app/shopee/orders/legacy-reconciliation")
    .auth("staff", "staff-password");
  expect(response.status).toBe(403);
  expect(listMock).not.toHaveBeenCalled();
});
