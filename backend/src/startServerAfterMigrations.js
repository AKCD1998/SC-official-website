async function startServerAfterMigrations({ app, port, runMigrations, logger = console }) {
  if (!app?.listen || typeof runMigrations !== "function") {
    throw new Error("Server startup dependencies are invalid.");
  }

  await runMigrations();
  return app.listen(port, () => logger.log(`Server is running on port ${port}`));
}

module.exports = { startServerAfterMigrations };
