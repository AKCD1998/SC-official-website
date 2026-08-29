const fs = require("node:fs");
const path = require("node:path");

const mockPool = jest.fn();
jest.mock("pg", () => ({ Pool: mockPool }));

const {
  readSafeTestTarget,
  verifyMigrations,
} = require("../scripts/verify-seamless-migrations.cjs");

function safeEnv(overrides = {}) {
  return {
    SEAMLESS_MIGRATION_SMOKE: "1",
    SEAMLESS_MIGRATION_TEST_DATABASE_URL: "postgresql://ci_user:ci_password@localhost/seamless_ci",
    SEAMLESS_MIGRATION_TEST_SCHEMA: "clasp_scx_seamless_ci",
    ...overrides,
  };
}

test("migration verifier accepts only an explicit local _test/_ci target", () => {
  expect(readSafeTestTarget(safeEnv())).toEqual({
    connectionString: "postgresql://ci_user:ci_password@localhost/seamless_ci",
    databaseName: "seamless_ci",
    schemaName: "clasp_scx_seamless_ci",
  });
});

test.each([
  ["remote host", { SEAMLESS_MIGRATION_TEST_DATABASE_URL: "postgresql://ci:ci@db.example.com/seamless_ci" }],
  ["query-string host override", {
    SEAMLESS_MIGRATION_TEST_DATABASE_URL:
      "postgresql://ci:ci@localhost/safe_ci?host=192.168.1.50",
  }],
  ["any query parameters", {
    SEAMLESS_MIGRATION_TEST_DATABASE_URL:
      "postgresql://ci:ci@localhost/seamless_ci?sslmode=disable",
  }],
  ["URL hash", {
    SEAMLESS_MIGRATION_TEST_DATABASE_URL:
      "postgresql://ci:ci@localhost/seamless_ci#review",
  }],
  ["non-test database", { SEAMLESS_MIGRATION_TEST_DATABASE_URL: "postgresql://ci:ci@localhost/seamless" }],
  ["non-test schema", { SEAMLESS_MIGRATION_TEST_SCHEMA: "clasp_scx_seamless" }],
  ["missing smoke opt-in", { SEAMLESS_MIGRATION_SMOKE: "0" }],
])("migration verifier rejects %s", (_label, overrides) => {
  expect(() => readSafeTestTarget(safeEnv(overrides))).toThrow();
});

test("shared database env vars cannot substitute for the dedicated migration test URL", () => {
  expect(() => readSafeTestTarget({
    DATABASE_URL: "postgresql://ignored:ignored@localhost/ignored_ci",
    SC_OFFICIAL_DATABASE_URL: "postgresql://ignored:ignored@localhost/ignored_ci",
    SC_OFFICIAL_SUPABASE_DATABASE_URL: "postgresql://ignored:ignored@localhost/ignored_ci",
    SEAMLESS_MIGRATION_SMOKE: "1",
    SEAMLESS_MIGRATION_TEST_SCHEMA: "clasp_scx_seamless_ci",
  })).toThrow(/SEAMLESS_MIGRATION_TEST_DATABASE_URL/u);

  const source = fs.readFileSync(path.join(
    __dirname,
    "../scripts/verify-seamless-migrations.cjs",
  ), "utf8");
  expect(source).not.toMatch(
    /SC_OFFICIAL_SUPABASE_DATABASE_URL|SC_OFFICIAL_DATABASE_URL|\bDATABASE_URL\b/u,
  );
});

test("query-string host override is rejected before pg.Pool is constructed", async () => {
  mockPool.mockClear();

  await expect(verifyMigrations(safeEnv({
    SEAMLESS_MIGRATION_TEST_DATABASE_URL:
      "postgresql://ci:ci@localhost/safe_ci?host=192.168.1.50",
  }))).rejects.toThrow(/query parameters/u);
  expect(mockPool).not.toHaveBeenCalled();
});
