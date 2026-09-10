const getShopeeDocumentSyncStatusMock = jest.fn();

jest.mock("../src/modules/seamless/services/shopeeDocumentSyncStatusService", () => ({
  getShopeeDocumentSyncStatus: (...args) => getShopeeDocumentSyncStatusMock(...args),
}));

const {
  getDocumentSyncStatus,
} = require("../src/modules/seamless/controllers/shopeeDocumentSyncStatusController");

function response() {
  return {
    headers: {},
    body: null,
    set(name, value) { this.headers[name] = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

beforeEach(() => getShopeeDocumentSyncStatusMock.mockReset());

test("document sync status is admin-only", async () => {
  await expect(getDocumentSyncStatus({ appRole: "user", query: {} }, response()))
    .rejects.toMatchObject({ statusCode: 403 });
  expect(getShopeeDocumentSyncStatusMock).not.toHaveBeenCalled();
});

test("admin response is no-store and uses the selected history window", async () => {
  const payload = { days: 31, shops: [] };
  getShopeeDocumentSyncStatusMock.mockResolvedValue(payload);
  const res = response();
  await getDocumentSyncStatus({ appRole: "admin", query: { days: "31" } }, res);
  expect(getShopeeDocumentSyncStatusMock).toHaveBeenCalledWith({ days: 31 });
  expect(res.headers["Cache-Control"]).toBe("no-store");
  expect(res.body).toBe(payload);
});
