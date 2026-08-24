const express = require("express");
const request = require("supertest");

let lastFilters = null;
jest.mock("../src/modules/seamless/services/shopeeEmailInboxService", () => ({
  CATEGORY_QUERIES: {
    order_confirmed: "confirmed",
    shipment_due: "shipment",
    order_cancelled: "cancelled",
    out_of_stock: "stock",
    security_alert: "security",
    seller_return_delivery: "return",
  },
  listShopeeEmailInbox: jest.fn(async (filters) => {
    lastFilters = filters;
    return {
      emails: [{
        id: "gmail-1",
        subject: "คำสั่งซื้อ #260824ABC จากผู้ซื้อ buyer_name ถูกยกเลิก",
        category: "order_cancelled",
      }, {
        id: "gmail-2",
        subject: "คำสั่งซื้อ #260824XYZ ถูกทำการยกเลิกโดย cancellation_buyer",
        category: "order_cancelled",
      }, {
        id: "gmail-3",
        subject: "คำสั่งซื้อ #260824SHORT ถูกยกเลิกโดย short_form_buyer",
        category: "order_cancelled",
      }],
      nextCursor: "next-page",
      source: "info@mail.shopee.co.th",
    };
  }),
}));

const { errorHandler } = require("../src/modules/seamless/middleware/errorHandler");

function buildApp() {
  delete require.cache[require.resolve("../src/modules/seamless/middleware/appAuth")];
  delete require.cache[require.resolve("../src/modules/seamless/routes/shopeeEmailRoutes")];
  // eslint-disable-next-line global-require
  const routes = require("../src/modules/seamless/routes/shopeeEmailRoutes");
  const app = express();
  app.use("/api/app/shopee", routes);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  lastFilters = null;
  delete process.env.SEAMLESS_APP_BASIC_USER;
  delete process.env.SEAMLESS_APP_BASIC_PASSWORD;
  delete process.env.SEAMLESS_APP_ADMIN_BASIC_USER;
  delete process.env.SEAMLESS_APP_ADMIN_BASIC_PASSWORD;
});

describe("Shopee email inbox API", () => {
  test("returns the live read-only Gmail page", async () => {
    const response = await request(buildApp()).get("/api/app/shopee/inbox?limit=20&category=shipment_due");

    expect(response.status).toBe(200);
    expect(response.body.source).toBe("info@mail.shopee.co.th");
    expect(response.body.emails).toHaveLength(3);
    expect(response.body.emails[0].subject).toContain("buyer_name");
    expect(response.body.emails[1].subject).toContain("cancellation_buyer");
    expect(response.body.emails[2].subject).toContain("short_form_buyer");
    expect(lastFilters).toMatchObject({ category: "shipment_due", limit: 20 });
  });

  test("redacts buyer usernames server-side for a regular staff session", async () => {
    process.env.SEAMLESS_APP_BASIC_USER = "staff001";
    process.env.SEAMLESS_APP_BASIC_PASSWORD = "staff-password";

    const response = await request(buildApp())
      .get("/api/app/shopee/inbox")
      .auth("staff001", "staff-password");

    expect(response.status).toBe(200);
    expect(response.body.emails[0].subject).toContain("จากผู้ซื้อ [ปกปิด]");
    expect(response.body.emails[0].subject).not.toContain("buyer_name");
  });

  test("redacts the alternate cancellation-by username for a regular staff session", async () => {
    process.env.SEAMLESS_APP_BASIC_USER = "staff001";
    process.env.SEAMLESS_APP_BASIC_PASSWORD = "staff-password";

    const response = await request(buildApp())
      .get("/api/app/shopee/inbox")
      .auth("staff001", "staff-password");

    expect(response.status).toBe(200);
    expect(response.body.emails[1].subject).toContain("ถูกทำการยกเลิกโดย [ปกปิด]");
    expect(response.body.emails[1].subject).not.toContain("cancellation_buyer");
    expect(response.body.emails[2].subject).toContain("ถูกยกเลิกโดย [ปกปิด]");
    expect(response.body.emails[2].subject).not.toContain("short_form_buyer");
  });

  test("converts a single ICT calendar day to an inclusive/exclusive timestamp range", async () => {
    const response = await request(buildApp()).get(
      "/api/app/shopee/inbox?receivedFrom=2026-08-24&receivedTo=2026-08-24",
    );

    expect(response.status).toBe(200);
    expect(lastFilters.receivedFrom).toBe("2026-08-23T17:00:00.000Z");
    expect(lastFilters.receivedTo).toBe("2026-08-24T17:00:00.000Z");
  });

  test.each([
    ["category=unknown", "category"],
    ["limit=0", "limit"],
    ["limit=26", "limit"],
    ["receivedFrom=2026-02-31", "receivedFrom"],
    ["receivedFrom=2026-08-25&receivedTo=2026-08-24", "receivedFrom"],
  ])("rejects invalid query parameters: %s", async (query, messagePart) => {
    const response = await request(buildApp()).get(`/api/app/shopee/inbox?${query}`);

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain(messagePart);
    expect(lastFilters).toBeNull();
  });
});
