const fs = require("node:fs");
const path = require("node:path");

test("ingest audit migration is bounded, privacy-safe and idempotency-keyed", () => {
  const sql = fs.readFileSync(path.resolve(__dirname,
    "../src/modules/seamless/db/migrations/018_shopee_sales_ingest_jobs.sql"), "utf8");
  expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS shopee_sales_ingest_jobs/iu);
  expect(sql).toMatch(/job_id text PRIMARY KEY/iu);
  expect(sql).toMatch(/shop_code text NOT NULL CHECK/iu);
  expect(sql).toMatch(/report_type text NOT NULL CHECK/iu);
  expect(sql).toMatch(/source_sha256 text NOT NULL CHECK/iu);
  expect(sql).toMatch(/observed_at timestamptz NOT NULL/iu);
  expect(sql).toMatch(/result_status text NOT NULL CHECK/iu);
  expect(sql).not.toMatch(/^\s*(?:token|cookie|password|customer|order_number)\s+/imu);
});

test("Sales Overview migration preserves unavailable cancellation fields as null", () => {
  const sql = fs.readFileSync(path.resolve(__dirname,
    "../src/modules/seamless/db/migrations/019_shopee_sales_overview.sql"), "utf8");
  expect(sql).toMatch(/ALTER COLUMN cancelled_sales DROP NOT NULL/iu);
  expect(sql).toMatch(/ALTER COLUMN cancelled_order_count DROP NOT NULL/iu);
  expect(sql).toMatch(/ALTER COLUMN returned_sales DROP NOT NULL/iu);
  expect(sql).toMatch(/ALTER COLUMN returned_order_count DROP NOT NULL/iu);
});
