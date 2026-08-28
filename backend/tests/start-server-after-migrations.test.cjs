const { startServerAfterMigrations } = require("../src/startServerAfterMigrations");

test("applies database migrations before accepting HTTP traffic", async () => {
  const calls = [];
  const server = { close: jest.fn() };
  const runMigrations = jest.fn(async () => calls.push("migrate"));
  const app = {
    listen: jest.fn((port, callback) => {
      calls.push(`listen:${port}`);
      callback();
      return server;
    }),
  };
  const logger = { log: jest.fn() };

  await expect(startServerAfterMigrations({
    app,
    logger,
    port: 3000,
    runMigrations,
  })).resolves.toBe(server);
  expect(calls).toEqual(["migrate", "listen:3000"]);
  expect(logger.log).toHaveBeenCalledWith("Server is running on port 3000");
});

test("fails closed without listening when a migration fails", async () => {
  const error = new Error("migration rejected");
  const app = { listen: jest.fn() };

  await expect(startServerAfterMigrations({
    app,
    port: 3000,
    runMigrations: jest.fn(async () => { throw error; }),
  })).rejects.toBe(error);
  expect(app.listen).not.toHaveBeenCalled();
});
