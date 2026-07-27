const { readSchemaName } = require("./config");

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteIdentifier(identifier, label) {
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    const error = new Error(`Invalid PostgreSQL ${label}: ${identifier}`);
    error.statusCode = 500;
    throw error;
  }

  return `"${identifier}"`;
}

function getTables() {
  const schemaName = readSchemaName();
  const schemaSql = quoteIdentifier(schemaName, "schema");
  const qualifyTable = (tableName) => `${schemaSql}.${quoteIdentifier(tableName, "table")}`;

  return {
    generatedFiles: qualifyTable("generated_files"),
    operationLogs: qualifyTable("operation_logs"),
    previewSheets: qualifyTable("preview_sheets"),
    printJobs: qualifyTable("print_jobs"),
    processingBatches: qualifyTable("processing_batches"),
    processingRecordBranchCodes: qualifyTable("processing_record_branch_codes"),
    processingRecords: qualifyTable("processing_records"),
    schemaMigrations: qualifyTable("schema_migrations"),
    workbookUploads: qualifyTable("workbook_uploads"),
  };
}

module.exports = { getTables, quoteIdentifier };
