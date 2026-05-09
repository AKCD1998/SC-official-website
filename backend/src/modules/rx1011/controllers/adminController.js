import { getClient, query } from "../db/pool.js";
import { httpError } from "../utils/httpError.js";

const SQL_TEXT_MAX_LENGTH = readIntegerEnv("ADMIN_SQL_EXECUTOR_MAX_SQL_LENGTH", 20000, {
  min: 1000,
  max: 200000,
});
const STATEMENT_TIMEOUT_MS = readIntegerEnv("ADMIN_SQL_EXECUTOR_TIMEOUT_MS", 5000, {
  min: 100,
  max: 60000,
});
const ROW_CAP = readIntegerEnv("ADMIN_SQL_EXECUTOR_ROW_CAP", 200, {
  min: 1,
  max: 1000,
});
const TABLE_ROW_CAP = readIntegerEnv("ADMIN_TABLE_BROWSER_ROW_CAP", 500, {
  min: 50,
  max: 2000,
});
const RESULT_LIMIT = ROW_CAP + 1;
const ALLOWED_START_TOKENS = new Set(["SELECT", "WITH", "EXPLAIN"]);
const PROHIBITED_TOKENS = new Set([
  "ALTER",
  "ANALYZE",
  "BEGIN",
  "CALL",
  "CHECKPOINT",
  "CLUSTER",
  "COMMENT",
  "COMMIT",
  "COPY",
  "CREATE",
  "DEALLOCATE",
  "DELETE",
  "DISCARD",
  "DO",
  "DROP",
  "EXECUTE",
  "GRANT",
  "IMPORT",
  "INSERT",
  "INTO",
  "LISTEN",
  "LOCK",
  "MERGE",
  "NOTIFY",
  "PREPARE",
  "REFRESH",
  "REINDEX",
  "RELEASE",
  "RESET",
  "REVOKE",
  "ROLLBACK",
  "SAVEPOINT",
  "SECURITY",
  "SET",
  "TRUNCATE",
  "UNLISTEN",
  "UPDATE",
  "VACUUM",
]);

function readIntegerEnv(name, fallback, options = {}) {
  const min = Number.isFinite(options.min) ? options.min : Number.NEGATIVE_INFINITY;
  const max = Number.isFinite(options.max) ? options.max : Number.POSITIVE_INFINITY;
  const rawValue = String(process.env[name] ?? "").trim();
  const parsed = Number.parseInt(rawValue || String(fallback), 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

function toCleanText(value) {
  return String(value ?? "").trim();
}

function truncateText(value, maxLength = 2000) {
  const text = toCleanText(value);
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(maxLength - 3, 0))}...`;
}

function parseBoundedInteger(value, fallback, { min = 0, max = 1000 } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const integerValue = Math.floor(numeric);
  return Math.min(Math.max(integerValue, min), max);
}

function isSafeIdentifier(value) {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(toCleanText(value));
}

function quoteIdentifier(value) {
  const identifier = toCleanText(value);
  if (!isSafeIdentifier(identifier)) {
    throw httpError(400, `Invalid SQL identifier: ${identifier || "-"}`);
  }

  return `"${identifier.replace(/"/g, '""')}"`;
}

function getClientIp(req) {
  const forwardedFor = String(req.headers?.["x-forwarded-for"] || "").trim();
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() || "";
  }

  return toCleanText(req.ip || req.socket?.remoteAddress);
}

function readDollarQuoteTag(sql, index) {
  const slice = sql.slice(index);
  const matched = slice.match(/^\$[A-Za-z_][A-Za-z0-9_]*\$/) || slice.match(/^\$\$/);
  return matched?.[0] || "";
}

function analyzeSql(sqlText) {
  let state = "normal";
  let blockCommentDepth = 0;
  let dollarQuoteTag = "";
  let separatorCount = 0;
  let lastSeparatorIndex = -1;
  let lastSignificantChar = "";
  let normalized = "";

  for (let index = 0; index < sqlText.length; ) {
    const char = sqlText[index];
    const nextChar = sqlText[index + 1] || "";

    if (state === "single-quote") {
      if (char === "'" && nextChar === "'") {
        index += 2;
        continue;
      }
      if (char === "'") {
        state = "normal";
        normalized += " ";
      }
      index += 1;
      continue;
    }

    if (state === "double-quote") {
      if (char === '"' && nextChar === '"') {
        index += 2;
        continue;
      }
      if (char === '"') {
        state = "normal";
        normalized += " ";
      }
      index += 1;
      continue;
    }

    if (state === "line-comment") {
      if (char === "\n") {
        state = "normal";
        normalized += " ";
      }
      index += 1;
      continue;
    }

    if (state === "block-comment") {
      if (char === "/" && nextChar === "*") {
        blockCommentDepth += 1;
        index += 2;
        continue;
      }
      if (char === "*" && nextChar === "/") {
        blockCommentDepth -= 1;
        index += 2;
        if (blockCommentDepth === 0) {
          state = "normal";
          normalized += " ";
        }
        continue;
      }
      index += 1;
      continue;
    }

    if (state === "dollar-quote") {
      if (dollarQuoteTag && sqlText.startsWith(dollarQuoteTag, index)) {
        index += dollarQuoteTag.length;
        dollarQuoteTag = "";
        state = "normal";
        normalized += " ";
        continue;
      }
      index += 1;
      continue;
    }

    if (char === "'") {
      state = "single-quote";
      index += 1;
      continue;
    }

    if (char === '"') {
      state = "double-quote";
      index += 1;
      continue;
    }

    if (char === "-" && nextChar === "-") {
      state = "line-comment";
      index += 2;
      continue;
    }

    if (char === "/" && nextChar === "*") {
      state = "block-comment";
      blockCommentDepth = 1;
      index += 2;
      continue;
    }

    const tag = char === "$" ? readDollarQuoteTag(sqlText, index) : "";
    if (tag) {
      state = "dollar-quote";
      dollarQuoteTag = tag;
      index += tag.length;
      continue;
    }

    if (char === ";") {
      separatorCount += 1;
      lastSeparatorIndex = index;
    }

    normalized += char;
    if (!/\s/.test(char)) {
      lastSignificantChar = char;
    }
    index += 1;
  }

  if (state !== "normal") {
    throw httpError(400, "SQL statement is not terminated correctly");
  }

  const collapsed = normalized.replace(/\s+/g, " ").trim();
  const tokens = (collapsed.match(/[A-Za-z_][A-Za-z0-9_$]*/g) || []).map((token) =>
    token.toUpperCase()
  );

  return {
    collapsed,
    tokens,
    separatorCount,
    lastSeparatorIndex,
    lastSignificantChar,
  };
}

function validateAndPrepareSql(rawSql) {
  if (typeof rawSql !== "string") {
    throw httpError(400, "sql must be a string");
  }

  const sqlText = rawSql.trim();
  if (!sqlText) {
    throw httpError(400, "sql is required");
  }
  if (sqlText.length > SQL_TEXT_MAX_LENGTH) {
    throw httpError(400, `sql exceeds max length of ${SQL_TEXT_MAX_LENGTH} characters`);
  }

  const analyzed = analyzeSql(sqlText);
  if (!analyzed.tokens.length) {
    throw httpError(400, "SQL statement is empty after removing comments");
  }

  if (analyzed.separatorCount > 1) {
    throw httpError(400, "Only a single SQL statement is allowed");
  }
  if (analyzed.separatorCount === 1 && analyzed.lastSignificantChar !== ";") {
    throw httpError(400, "Only a single SQL statement is allowed");
  }

  const statementType = analyzed.tokens[0];
  if (!ALLOWED_START_TOKENS.has(statementType)) {
    throw httpError(400, "Only SELECT, WITH, or EXPLAIN statements are allowed");
  }

  const prohibitedToken = analyzed.tokens.find((token) => PROHIBITED_TOKENS.has(token));
  if (prohibitedToken) {
    throw httpError(400, `Token ${prohibitedToken} is not allowed in read-only SQL executor`);
  }

  if (statementType === "WITH" && !analyzed.tokens.includes("SELECT")) {
    throw httpError(400, "WITH queries must resolve to a SELECT statement");
  }

  if (statementType === "EXPLAIN") {
    const explainsReadOnlyQuery = analyzed.tokens.some(
      (token) => token === "SELECT" || token === "WITH"
    );
    if (!explainsReadOnlyQuery) {
      throw httpError(400, "EXPLAIN is limited to SELECT or WITH queries");
    }
  }

  const sqlForExecution =
    analyzed.separatorCount === 1 && analyzed.lastSeparatorIndex >= 0
      ? sqlText.slice(0, analyzed.lastSeparatorIndex).trim()
      : sqlText;

  if (!sqlForExecution) {
    throw httpError(400, "SQL statement is empty");
  }

  return {
    statementType,
    sqlForExecution,
  };
}

function buildWrappedSelectSql(sqlForExecution) {
  return `SELECT * FROM (${sqlForExecution}) AS admin_sql_executor_result LIMIT ${RESULT_LIMIT}`;
}

function normalizeExecutionError(error) {
  if (error?.status) {
    return error;
  }

  const code = toCleanText(error?.code).toUpperCase();
  const message = truncateText(error?.message || "SQL execution failed");

  if (code === "57014") {
    return httpError(408, `SQL statement timed out after ${STATEMENT_TIMEOUT_MS} ms`);
  }
  if (code === "25006") {
    return httpError(400, "SQL statement must remain read-only");
  }
  if (code) {
    return httpError(400, message || "SQL execution failed");
  }

  return httpError(500, message || "SQL execution failed");
}

function formatColumnType(row) {
  const dataType = toCleanText(row.dataType);
  const udtName = toCleanText(row.udtName);
  const maxLength = row.characterMaximumLength;
  const precision = row.numericPrecision;
  const scale = row.numericScale;

  if (dataType === "character varying" && maxLength) {
    return `varchar(${maxLength})`;
  }
  if (dataType === "character" && maxLength) {
    return `char(${maxLength})`;
  }
  if (dataType === "numeric" && precision) {
    return scale === null || scale === undefined ? `numeric(${precision})` : `numeric(${precision},${scale})`;
  }
  if (dataType === "ARRAY" && udtName.startsWith("_")) {
    return `${udtName.slice(1)}[]`;
  }

  return dataType || udtName || "-";
}

function mapSchemaPayload({ tableRows, columnRows, primaryKeyRows, foreignKeyRows, uniqueRows, indexRows }) {
  const primaryKeyMap = new Map();
  primaryKeyRows.forEach((row) => {
    const key = `${row.tableName}.${row.columnName}`;
    primaryKeyMap.set(key, {
      constraintName: row.constraintName,
      ordinalPosition: Number(row.ordinalPosition || 0),
    });
  });

  const uniqueMap = new Map();
  uniqueRows.forEach((row) => {
    const key = `${row.tableName}.${row.columnName}`;
    if (!uniqueMap.has(key)) uniqueMap.set(key, []);
    uniqueMap.get(key).push(row.constraintName);
  });

  const foreignKeyMap = new Map();
  const relationships = foreignKeyRows.map((row) => {
    const sourceTable = toCleanText(row.sourceTable);
    const sourceColumn = toCleanText(row.sourceColumn);
    const key = `${sourceTable}.${sourceColumn}`;
    const relationship = {
      constraintName: toCleanText(row.constraintName),
      sourceTable,
      sourceColumn,
      targetTable: toCleanText(row.targetTable),
      targetColumn: toCleanText(row.targetColumn),
      updateRule: toCleanText(row.updateRule),
      deleteRule: toCleanText(row.deleteRule),
      ordinalPosition: Number(row.ordinalPosition || 0),
    };
    if (!foreignKeyMap.has(key)) foreignKeyMap.set(key, []);
    foreignKeyMap.get(key).push(relationship);
    return relationship;
  });

  const indexesByTable = new Map();
  indexRows.forEach((row) => {
    const tableName = toCleanText(row.tableName);
    if (!indexesByTable.has(tableName)) indexesByTable.set(tableName, []);
    indexesByTable.get(tableName).push({
      name: toCleanText(row.indexName),
      definition: toCleanText(row.indexDefinition),
    });
  });

  const columnsByTable = new Map();
  columnRows.forEach((row) => {
    const tableName = toCleanText(row.tableName);
    const columnName = toCleanText(row.columnName);
    const key = `${tableName}.${columnName}`;
    const primaryKey = primaryKeyMap.get(key) || null;
    const column = {
      name: columnName,
      ordinalPosition: Number(row.ordinalPosition || 0),
      type: formatColumnType(row),
      dataType: toCleanText(row.dataType),
      udtName: toCleanText(row.udtName),
      isNullable: Boolean(row.isNullable),
      defaultValue: row.defaultValue === null || row.defaultValue === undefined ? null : String(row.defaultValue),
      isPrimaryKey: Boolean(primaryKey),
      primaryKeyOrdinal: primaryKey?.ordinalPosition || null,
      isForeignKey: foreignKeyMap.has(key),
      foreignKeys: foreignKeyMap.get(key) || [],
      uniqueConstraints: uniqueMap.get(key) || [],
      comment: toCleanText(row.comment),
    };
    if (!columnsByTable.has(tableName)) columnsByTable.set(tableName, []);
    columnsByTable.get(tableName).push(column);
  });

  const tables = tableRows.map((row) => {
    const name = toCleanText(row.tableName);
    const columns = columnsByTable.get(name) || [];
    return {
      schema: toCleanText(row.tableSchema),
      name,
      kind: toCleanText(row.kind),
      rowEstimate: Number(row.rowEstimate || 0),
      comment: toCleanText(row.comment),
      columns,
      primaryKeyColumns: columns
        .filter((column) => column.isPrimaryKey)
        .sort((left, right) => Number(left.primaryKeyOrdinal || 0) - Number(right.primaryKeyOrdinal || 0))
        .map((column) => column.name),
      foreignKeyCount: columns.reduce((sum, column) => sum + column.foreignKeys.length, 0),
      indexes: indexesByTable.get(name) || [],
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    tables,
    relationships,
    indexes: indexRows.map((row) => ({
      tableName: toCleanText(row.tableName),
      name: toCleanText(row.indexName),
      definition: toCleanText(row.indexDefinition),
    })),
  };
}

async function assertReadablePublicRelation(tableName) {
  if (!isSafeIdentifier(tableName)) {
    throw httpError(400, "Invalid table name");
  }

  const result = await query(
    `
      SELECT
        c.relname AS "tableName",
        n.nspname AS "tableSchema",
        c.relkind AS "kind",
        GREATEST(c.reltuples::bigint, 0) AS "rowEstimate"
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = $1
        AND c.relkind IN ('r', 'p', 'v', 'm')
      LIMIT 1
    `,
    [tableName]
  );

  if (!result.rows[0]) {
    throw httpError(404, `Table not found: ${tableName}`);
  }

  return result.rows[0];
}

async function writeSqlAuditLog({
  executedBy,
  statementType,
  sqlText,
  succeeded,
  resultRowCount,
  wasTruncated,
  executionMs,
  clientIp,
  errorMessage,
}) {
  try {
    await query(
      `
        INSERT INTO admin_sql_query_audits (
          executed_by,
          statement_type,
          sql_text,
          succeeded,
          result_row_count,
          was_truncated,
          execution_ms,
          statement_timeout_ms,
          row_cap,
          client_ip,
          error_message
        )
        VALUES (
          $1::uuid,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11
        )
      `,
      [
        executedBy,
        statementType,
        sqlText,
        succeeded,
        resultRowCount,
        wasTruncated,
        executionMs,
        STATEMENT_TIMEOUT_MS,
        ROW_CAP,
        clientIp || null,
        truncateText(errorMessage, 4000) || null,
      ]
    );
  } catch (auditError) {
    console.error("[admin-sql] failed to persist audit log", auditError);
  }
}

async function runReadOnlyQuery(statementType, sqlForExecution) {
  const client = await getClient();
  const startedAt = Date.now();

  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SELECT set_config('statement_timeout', $1, true)", [
      String(STATEMENT_TIMEOUT_MS),
    ]);

    const result =
      statementType === "EXPLAIN"
        ? await client.query(sqlForExecution)
        : await client.query(buildWrappedSelectSql(sqlForExecution));

    await client.query("ROLLBACK");

    const rawRows = Array.isArray(result.rows) ? result.rows : [];
    const wasTruncated = rawRows.length > ROW_CAP;
    const rows = wasTruncated ? rawRows.slice(0, ROW_CAP) : rawRows;

    return {
      columns: Array.isArray(result.fields) ? result.fields.map((field) => field.name) : [],
      rows,
      resultRowCount: rows.length,
      wasTruncated,
      executionMs: Date.now() - startedAt,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback failures so the original SQL error can surface.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function getDatabaseSchema(_req, res) {
  const [tablesResult, columnsResult, primaryKeysResult, foreignKeysResult, uniqueResult, indexesResult] =
    await Promise.all([
      query(
        `
          SELECT
            n.nspname AS "tableSchema",
            c.relname AS "tableName",
            CASE c.relkind
              WHEN 'r' THEN 'table'
              WHEN 'p' THEN 'partitioned table'
              WHEN 'v' THEN 'view'
              WHEN 'm' THEN 'materialized view'
              ELSE c.relkind::text
            END AS "kind",
            GREATEST(c.reltuples::bigint, 0) AS "rowEstimate",
            obj_description(c.oid) AS comment
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relkind IN ('r', 'p', 'v', 'm')
          ORDER BY c.relname ASC
        `
      ),
      query(
        `
          SELECT
            cols.table_schema AS "tableSchema",
            cols.table_name AS "tableName",
            cols.column_name AS "columnName",
            cols.ordinal_position AS "ordinalPosition",
            cols.data_type AS "dataType",
            cols.udt_name AS "udtName",
            cols.is_nullable = 'YES' AS "isNullable",
            cols.column_default AS "defaultValue",
            cols.character_maximum_length AS "characterMaximumLength",
            cols.numeric_precision AS "numericPrecision",
            cols.numeric_scale AS "numericScale",
            descr.description AS comment
          FROM information_schema.columns cols
          LEFT JOIN pg_namespace ns
            ON ns.nspname = cols.table_schema
          LEFT JOIN pg_class cls
            ON cls.relnamespace = ns.oid
           AND cls.relname = cols.table_name
          LEFT JOIN pg_attribute attr
            ON attr.attrelid = cls.oid
           AND attr.attname = cols.column_name
          LEFT JOIN pg_description descr
            ON descr.objoid = cls.oid
           AND descr.objsubid = attr.attnum
          WHERE cols.table_schema = 'public'
          ORDER BY cols.table_name ASC, cols.ordinal_position ASC
        `
      ),
      query(
        `
          SELECT
            kcu.table_name AS "tableName",
            kcu.column_name AS "columnName",
            kcu.ordinal_position AS "ordinalPosition",
            tc.constraint_name AS "constraintName"
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON kcu.constraint_schema = tc.constraint_schema
           AND kcu.constraint_name = tc.constraint_name
           AND kcu.table_schema = tc.table_schema
           AND kcu.table_name = tc.table_name
          WHERE tc.table_schema = 'public'
            AND tc.constraint_type = 'PRIMARY KEY'
          ORDER BY kcu.table_name ASC, kcu.ordinal_position ASC
        `
      ),
      query(
        `
          SELECT
            tc.constraint_name AS "constraintName",
            kcu.table_name AS "sourceTable",
            kcu.column_name AS "sourceColumn",
            ccu.table_name AS "targetTable",
            ccu.column_name AS "targetColumn",
            rc.update_rule AS "updateRule",
            rc.delete_rule AS "deleteRule",
            kcu.ordinal_position AS "ordinalPosition"
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON kcu.constraint_schema = tc.constraint_schema
           AND kcu.constraint_name = tc.constraint_name
           AND kcu.table_schema = tc.table_schema
           AND kcu.table_name = tc.table_name
          JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_schema = tc.constraint_schema
           AND ccu.constraint_name = tc.constraint_name
          LEFT JOIN information_schema.referential_constraints rc
            ON rc.constraint_schema = tc.constraint_schema
           AND rc.constraint_name = tc.constraint_name
          WHERE tc.table_schema = 'public'
            AND tc.constraint_type = 'FOREIGN KEY'
          ORDER BY kcu.table_name ASC, tc.constraint_name ASC, kcu.ordinal_position ASC
        `
      ),
      query(
        `
          SELECT
            kcu.table_name AS "tableName",
            kcu.column_name AS "columnName",
            tc.constraint_name AS "constraintName"
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON kcu.constraint_schema = tc.constraint_schema
           AND kcu.constraint_name = tc.constraint_name
           AND kcu.table_schema = tc.table_schema
           AND kcu.table_name = tc.table_name
          WHERE tc.table_schema = 'public'
            AND tc.constraint_type = 'UNIQUE'
          ORDER BY kcu.table_name ASC, tc.constraint_name ASC, kcu.ordinal_position ASC
        `
      ),
      query(
        `
          SELECT
            tablename AS "tableName",
            indexname AS "indexName",
            indexdef AS "indexDefinition"
          FROM pg_indexes
          WHERE schemaname = 'public'
          ORDER BY tablename ASC, indexname ASC
        `
      ),
    ]);

  return res.json(
    mapSchemaPayload({
      tableRows: tablesResult.rows,
      columnRows: columnsResult.rows,
      primaryKeyRows: primaryKeysResult.rows,
      foreignKeyRows: foreignKeysResult.rows,
      uniqueRows: uniqueResult.rows,
      indexRows: indexesResult.rows,
    })
  );
}

export async function listTableRows(req, res) {
  const tableName = toCleanText(req.params.tableName);
  const limit = parseBoundedInteger(req.query.limit, 100, {
    min: 1,
    max: TABLE_ROW_CAP,
  });
  const offset = parseBoundedInteger(req.query.offset, 0, {
    min: 0,
    max: 1000000,
  });
  const requestedOrderBy = toCleanText(req.query.orderBy);
  const requestedOrder = toCleanText(req.query.order).toUpperCase();
  const sortDirection = requestedOrder === "DESC" ? "DESC" : "ASC";
  const relation = await assertReadablePublicRelation(tableName);

  const [columnsResult, primaryKeysResult] = await Promise.all([
    query(
      `
        SELECT column_name AS "columnName", ordinal_position AS "ordinalPosition"
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
        ORDER BY ordinal_position ASC
      `,
      [tableName]
    ),
    query(
      `
        SELECT kcu.column_name AS "columnName", kcu.ordinal_position AS "ordinalPosition"
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_schema = tc.constraint_schema
         AND kcu.constraint_name = tc.constraint_name
         AND kcu.table_schema = tc.table_schema
         AND kcu.table_name = tc.table_name
        WHERE tc.table_schema = 'public'
          AND tc.table_name = $1
          AND tc.constraint_type = 'PRIMARY KEY'
        ORDER BY kcu.ordinal_position ASC
      `,
      [tableName]
    ),
  ]);

  const columns = columnsResult.rows.map((row) => toCleanText(row.columnName)).filter(Boolean);
  const columnSet = new Set(columns);
  if (!columns.length) {
    throw httpError(400, `Table ${tableName} has no readable columns`);
  }

  const primaryKeyColumns = primaryKeysResult.rows
    .map((row) => toCleanText(row.columnName))
    .filter(Boolean);
  const orderColumn = columnSet.has(requestedOrderBy)
    ? requestedOrderBy
    : primaryKeyColumns.find((column) => columnSet.has(column)) || columns[0];
  const orderClause = orderColumn
    ? `ORDER BY ${quoteIdentifier(orderColumn)} ${sortDirection} NULLS LAST`
    : "";
  const startedAt = Date.now();
  const client = await getClient();

  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SELECT set_config('statement_timeout', $1, true)", [
      String(STATEMENT_TIMEOUT_MS),
    ]);
    const result = await client.query(
      `
        SELECT *
        FROM ${quoteIdentifier("public")}.${quoteIdentifier(tableName)}
        ${orderClause}
        LIMIT $1
        OFFSET $2
      `,
      [limit + 1, offset]
    );
    await client.query("ROLLBACK");

    const rawRows = Array.isArray(result.rows) ? result.rows : [];
    const rows = rawRows.slice(0, limit);
    return res.json({
      table: {
        schema: "public",
        name: tableName,
        kind: relation.kind,
        rowEstimate: Number(relation.rowEstimate || 0),
      },
      columns: Array.isArray(result.fields) ? result.fields.map((field) => field.name) : columns,
      rows,
      limit,
      offset,
      rowCount: rows.length,
      hasMore: rawRows.length > limit,
      orderBy: orderColumn,
      order: sortDirection,
      executionMs: Date.now() - startedAt,
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
      rowCap: TABLE_ROW_CAP,
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback failures so the original table read error can surface.
    }
    throw normalizeExecutionError(error);
  } finally {
    client.release();
  }
}

export async function executeSql(req, res) {
  const executedBy = toCleanText(req.user?.id);
  const clientIp = getClientIp(req);
  const sqlText = typeof req.body?.sql === "string" ? req.body.sql : req.body?.sql;
  let statementType = "UNKNOWN";
  let sqlForAudit = typeof sqlText === "string" ? sqlText.trim() : toCleanText(sqlText);

  try {
    const validated = validateAndPrepareSql(sqlText);
    statementType = validated.statementType;
    sqlForAudit = validated.sqlForExecution;

    const result = await runReadOnlyQuery(validated.statementType, validated.sqlForExecution);

    await writeSqlAuditLog({
      executedBy,
      statementType,
      sqlText: sqlForAudit,
      succeeded: true,
      resultRowCount: result.resultRowCount,
      wasTruncated: result.wasTruncated,
      executionMs: result.executionMs,
      clientIp,
      errorMessage: "",
    });

    return res.json({
      ok: true,
      statementType,
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
      rowCap: ROW_CAP,
      columns: result.columns,
      rows: result.rows,
      rowCount: result.resultRowCount,
      truncated: result.wasTruncated,
      executionMs: result.executionMs,
    });
  } catch (error) {
    const normalizedError = normalizeExecutionError(error);

    await writeSqlAuditLog({
      executedBy,
      statementType,
      sqlText: sqlForAudit,
      succeeded: false,
      resultRowCount: null,
      wasTruncated: false,
      executionMs: null,
      clientIp,
      errorMessage: normalizedError.message,
    });

    throw normalizedError;
  }
}
