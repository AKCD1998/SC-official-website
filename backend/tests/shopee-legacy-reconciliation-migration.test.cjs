const fs = require("node:fs");
const path = require("node:path");

test("legacy reconciliation migration creates review storage without reassigning quarantined rows", () => {
  const sql = fs.readFileSync(path.join(
    __dirname,
    "../src/modules/seamless/db/migrations/010_shopee_legacy_reconciliation_decisions.sql",
  ), "utf8");

  expect(sql).toContain("CREATE TABLE IF NOT EXISTS shopee_legacy_reconciliation_decisions");
  expect(sql).toContain("decision_status");
  expect(sql).not.toMatch(/UPDATE\s+shopee_(orders|order_events)/iu);
  expect(sql).not.toMatch(/DELETE\s+FROM\s+shopee_(orders|order_events)/iu);
});

test("legacy apply migration adds audit snapshots without moving production rows", () => {
  const sql = fs.readFileSync(path.join(
    __dirname,
    "../src/modules/seamless/db/migrations/011_shopee_legacy_reconciliation_apply_audit.sql",
  ), "utf8");

  expect(sql).toContain("shopee_legacy_reconciliation_apply_batches");
  expect(sql).toContain("shopee_legacy_reconciliation_apply_items");
  expect(sql).toContain("legacy_order_snapshot jsonb");
  expect(sql).toContain("moved_event_ids uuid[]");
  expect(sql).not.toMatch(/UPDATE\s+shopee_(orders|order_events)/iu);
  expect(sql).not.toMatch(/DELETE\s+FROM\s+shopee_(orders|order_events)/iu);
});

test("financial visibility migration defaults regular users to item subtotal only", () => {
  const sql = fs.readFileSync(path.join(
    __dirname,
    "../src/modules/seamless/db/migrations/014_shopee_financial_visibility_settings.sql",
  ), "utf8");

  expect(sql).toContain("CREATE TABLE IF NOT EXISTS shopee_financial_visibility_settings");
  expect(sql).toContain("user_can_view_unit_price boolean NOT NULL DEFAULT false");
  expect(sql).toContain("user_can_view_shipping_fee boolean NOT NULL DEFAULT false");
  expect(sql).toContain("user_can_view_total_amount boolean NOT NULL DEFAULT false");
  expect(sql).toContain("VALUES ('user', false, false, false, 'migration-default')");
  expect(sql).not.toMatch(/UPDATE\s+shopee_(orders|order_events)/iu);
  expect(sql).not.toMatch(/DELETE\s+FROM\s+shopee_(orders|order_events)/iu);
});

test("production migration workflow is manual, exact-confirmation gated, and read-only after apply", () => {
  const workflow = fs.readFileSync(path.join(
    __dirname,
    "../../.github/workflows/seamless-production-migrate.yml",
  ), "utf8");
  const verifier = fs.readFileSync(path.join(
    __dirname,
    "../scripts/verify-seamless-production-migration.cjs",
  ), "utf8");

  expect(workflow).toContain("workflow_dispatch:");
  expect(workflow).not.toMatch(/\b(push|schedule):/u);
  expect(workflow).toContain("APPLY_014_SHOPEE_FINANCIAL_VISIBILITY");
  expect(workflow).toContain("secrets.SC_OFFICIAL_SUPABASE_DATABASE_URL");
  expect(verifier).toContain("014_shopee_financial_visibility_settings.sql");
  expect(verifier).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/iu);
});
