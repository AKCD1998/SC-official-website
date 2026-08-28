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
