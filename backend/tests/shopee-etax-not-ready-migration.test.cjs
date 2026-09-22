const fs = require("node:fs");
const path = require("node:path");

test("migration 028 adds only the strict e-Tax not-ready observation state", () => {
  const sql = fs.readFileSync(path.resolve(__dirname,
    "../src/modules/seamless/db/migrations/028_shopee_etax_not_ready_observations.sql"), "utf8");
  for (const fragment of [
    "'not_ready'", "'SHOPEE_ETAX_DOCUMENT_NOT_READY'", "documentStatusText",
    "retryExhausted", "attemptsObserved", "resultRowCount' = '1'::jsonb",
    "searchEndpoint' = '/api/v1/seller/tax-documents/list'",
  ]) expect(sql).toContain(fragment);
  expect(sql).toContain("(source_validation->>'attemptsObserved')::integer >= 4");
  expect(sql).toContain("length(btrim(source_validation->>'documentStatusText')) BETWEEN 1 AND 200");
});
