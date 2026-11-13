jest.mock("pg", () => ({ Pool: jest.fn(() => ({})) }));

beforeEach(() => {
  jest.resetModules();
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.SC_OFFICIAL_DB_POOL_MAX;
  jest.restoreAllMocks();
});

test.each([[undefined, 10], ["2", 2], ["6", 6], ["0", 10], ["100", 10], ["bad", 10]])(
  "bounds the main website connection budget for %s", (value, expected) => {
    if (value !== undefined) process.env.SC_OFFICIAL_DB_POOL_MAX = value;
    require("../db");
    const options = require("pg").Pool.mock.calls.at(-1)[0];
    expect(options).toMatchObject({ max: expected, connectionTimeoutMillis: 10_000, application_name: "sc-official-website" });
  },
);
