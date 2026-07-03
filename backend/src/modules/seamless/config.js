const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function readSchemaName() {
  const schemaName = String(
    process.env.SEAMLESS_DB_SCHEMA || process.env.DB_SCHEMA || "clasp_scx_seamless",
  ).trim();

  if (!IDENTIFIER_PATTERN.test(schemaName)) {
    const error = new Error(`Invalid Seamless schema name: ${schemaName}`);
    error.statusCode = 500;
    throw error;
  }

  return schemaName;
}

function readInternalApiToken() {
  return String(
    process.env.SEAMLESS_INTERNAL_API_TOKEN || process.env.INTERNAL_API_TOKEN || "",
  ).trim();
}

module.exports = {
  readInternalApiToken,
  readSchemaName,
};
