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

test("official document migration is immutable, privacy-safe and supports every downloaded type", () => {
  const sql = fs.readFileSync(path.resolve(__dirname,
    "../src/modules/seamless/db/migrations/020_shopee_official_documents.sql"), "utf8");
  for (const reportType of [
    "financial-statement", "seller-balance", "income-transferred",
    "income-pending", "return-refund-cancel",
  ]) expect(sql).toContain(`'${reportType}'`);
  expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS shopee_official_document_sources/iu);
  expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS shopee_financial_statement_facts/iu);
  expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS shopee_income_facts/iu);
  expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS shopee_seller_balance_facts/iu);
  expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS shopee_return_facts/iu);
  expect(sql).not.toMatch(/^\s*(?:buyer|address|phone|username)\s+/imu);
});
