require("dotenv").config();

const connectionString = process.env.SC_OFFICIAL_DATABASE_URL || process.env.DATABASE_URL;

module.exports = {
  development: {
    client: "pg",
    connection: connectionString,
    migrations: {
      directory: "./migrations",
      extension: "cjs",
    },
  },
  production: {
    client: "pg",
    connection: {
      connectionString,
      ssl: { rejectUnauthorized: false },
    },
    migrations: {
      directory: "./migrations",
      extension: "cjs",
    },
  },
};
