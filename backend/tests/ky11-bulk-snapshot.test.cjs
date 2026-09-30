const { createHash } = require("node:crypto");

const query = jest.fn();
jest.unstable_mockModule("../src/modules/rx1011/db/pool.js", () => ({ query }));

let getKy11BulkSourceSnapshot;
beforeAll(async () => {
  ({ getKy11BulkSourceSnapshot } = await import("../src/modules/rx1011/controllers/ky11BulkSnapshotsController.js"));
});
beforeEach(() => query.mockReset());

const response = () => ({ set: jest.fn(), type: jest.fn(), send: jest.fn() });
const request = { params: { snapshotKey: "stockday-20260618-20260927-dev-v1" } };

test("serves the exact saved CSV with private cache headers", async () => {
  const csv = "\uFEFFrecordType,branchCode\nSALE,001";
  const source_sha256 = createHash("sha256").update(csv, "utf8").digest("hex");
  query.mockResolvedValue({ rows: [{ source_csv: csv, source_sha256 }] });
  const res = response();
  await getKy11BulkSourceSnapshot(request, res);
  expect(query).toHaveBeenCalledWith(expect.stringContaining("WHERE snapshot_key = $1"), [request.params.snapshotKey]);
  expect(res.set).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  expect(res.type).toHaveBeenCalledWith("text/csv; charset=utf-8");
  expect(res.send).toHaveBeenCalledWith(csv);
});

test("rejects missing or altered snapshots", async () => {
  query.mockResolvedValueOnce({ rows: [] });
  await expect(getKy11BulkSourceSnapshot(request, response())).rejects.toMatchObject({ status: 404 });
  query.mockResolvedValueOnce({ rows: [{ source_csv: "changed", source_sha256: "0".repeat(64) }] });
  await expect(getKy11BulkSourceSnapshot(request, response())).rejects.toMatchObject({ status: 500 });
});
