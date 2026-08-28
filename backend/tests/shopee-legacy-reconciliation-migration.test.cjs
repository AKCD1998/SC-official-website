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
