const { getTables } = require("../tables");
const { isDeepStrictEqual } = require("node:util");

function assertImportOptions({ client, actor }) {
  if (!client || !String(actor || "").trim()) {
    throw new Error("Official document import requires an explicit client and actor.");
  }
}

function dateOnly(value) {
  if (!(value instanceof Date)) return String(value).slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function assertExistingSource(row, source) {
  if (row.shop_code !== source.shopCode) {
    throw new Error("The same official Shopee document is already assigned to a different shop.");
  }
  const mismatches = [];
  if (row.report_type !== source.reportType) mismatches.push("report type");
  if (row.source_filename !== source.sourceFilename) mismatches.push("source filename");
  if (new Date(row.observed_at).toISOString() !== source.observedAt) mismatches.push("observed time");
  if (dateOnly(row.start_date) !== source.startDate) mismatches.push("period start");
  if (dateOnly(row.end_date) !== source.endDate) mismatches.push("period end");
  if (Number(row.source_row_count) !== source.facts.length) mismatches.push("source row count");
  if (!isDeepStrictEqual(row.control || {}, source.control || {})) mismatches.push("control totals");
  if (mismatches.length) {
    throw new Error(
      `Existing official Shopee document metadata differs (${mismatches.join(", ")}); do not relabel imported evidence.`,
    );
  }
}

async function enrichIncomeComponents(client, tables, source) {
  if (!["income-transferred", "income-pending"].includes(source.reportType)) return;
  const result = await client.query(`
    SELECT source_row, order_number, return_request_number, ordered_at,
      transferred_at, payout_amount, components
    FROM ${tables.shopeeIncomeFacts}
    WHERE shop_code = $1 AND source_sha256 = $2
    ORDER BY source_row
  `, [source.shopCode, source.sourceSha256]);
  if (result.rows.length !== source.facts.length) {
    throw new Error("Existing My Income fact count differs from the exact-source replay.");
  }
  const existingByRow = new Map(result.rows.map((row) => [Number(row.source_row), row]));
  const updates = [];
  for (const fact of source.facts) {
    const existing = existingByRow.get(fact.sourceRow);
    if (!existing
      || existing.order_number !== fact.orderNumber
      || (existing.return_request_number || null) !== (fact.returnRequestNumber || null)
      || new Date(existing.ordered_at).toISOString() !== fact.orderedAt
      || (existing.transferred_at ? new Date(existing.transferred_at).toISOString() : null) !== fact.transferredAt
      || Number(existing.payout_amount) !== fact.payoutAmount) {
      throw new Error("Existing My Income fact identity or amount differs from the exact-source replay.");
    }
    const current = existing.components || {};
    const incoming = fact.components || {};
    for (const [key, value] of Object.entries(current)) {
      if (!Object.hasOwn(incoming, key) || !isDeepStrictEqual(value, incoming[key])) {
        throw new Error(`Existing immutable My Income component differs: ${key}.`);
      }
    }
    const merged = { ...incoming, ...current };
    if (!isDeepStrictEqual(current, merged)) updates.push({ source_row: fact.sourceRow, components: merged });
  }
  if (updates.length) {
    await client.query(`
      UPDATE ${tables.shopeeIncomeFacts} fact
      SET components = item.components
      FROM jsonb_to_recordset($3::jsonb) AS item(source_row integer, components jsonb)
      WHERE fact.shop_code = $1
        AND fact.source_sha256 = $2
        AND fact.source_row = item.source_row
    `, [source.shopCode, source.sourceSha256, JSON.stringify(updates)]);
  }
}

async function insertFinancialStatement(client, tables, source) {
  const [fact] = source.facts;
  if (!fact || source.facts.length !== 1) throw new Error("Financial Statement must contain one control fact.");
  await client.query(`
    INSERT INTO ${tables.shopeeFinancialStatementFacts}
      (shop_code, source_sha256, transferred_total, page_count)
    VALUES ($1,$2,$3,$4)
  `, [source.shopCode, source.sourceSha256, fact.transferredTotal, fact.pageCount]);
}

async function insertIncome(client, tables, source) {
  if (!source.facts.length) return;
  const rows = source.facts.map((fact) => ({
    shop_code: fact.shopCode,
    source_sha256: source.sourceSha256,
    source_row: fact.sourceRow,
    order_number: fact.orderNumber,
    return_request_number: fact.returnRequestNumber,
    ordered_at: fact.orderedAt,
    transferred_at: fact.transferredAt,
    payout_amount: fact.payoutAmount,
    components: fact.components,
  }));
  await client.query(`
    INSERT INTO ${tables.shopeeIncomeFacts}
      (shop_code, source_sha256, source_row, order_number, return_request_number,
       ordered_at, transferred_at, payout_amount, components)
    SELECT item.shop_code, item.source_sha256, item.source_row, item.order_number,
           item.return_request_number, item.ordered_at, item.transferred_at,
           item.payout_amount, item.components
    FROM jsonb_to_recordset($1::jsonb) AS item(
      shop_code text, source_sha256 text, source_row integer, order_number text,
      return_request_number text, ordered_at timestamptz, transferred_at timestamptz,
      payout_amount numeric, components jsonb
    )
  `, [JSON.stringify(rows)]);
}

async function insertSellerBalance(client, tables, source) {
  if (!source.facts.length) return;
  const rows = source.facts.map((fact) => ({
    shop_code: fact.shopCode,
    source_sha256: source.sourceSha256,
    source_row: fact.sourceRow,
    transaction_at: fact.transactionAt,
    transaction_type: fact.transactionType,
    order_number: fact.orderNumber,
    direction: fact.direction,
    amount: fact.amount,
    status: fact.status,
    balance_after: fact.balanceAfter,
  }));
  await client.query(`
    INSERT INTO ${tables.shopeeSellerBalanceFacts}
      (shop_code, source_sha256, source_row, transaction_at, transaction_type,
       order_number, direction, amount, status, balance_after)
    SELECT item.shop_code, item.source_sha256, item.source_row, item.transaction_at,
           item.transaction_type, item.order_number, item.direction, item.amount,
           item.status, item.balance_after
    FROM jsonb_to_recordset($1::jsonb) AS item(
      shop_code text, source_sha256 text, source_row integer, transaction_at timestamptz,
      transaction_type text, order_number text, direction text, amount numeric,
      status text, balance_after numeric
    )
  `, [JSON.stringify(rows)]);
}

async function insertReturns(client, tables, source) {
  if (!source.facts.length) return;
  const rows = source.facts.map((fact) => ({
    shop_code: fact.shopCode,
    source_sha256: source.sourceSha256,
    event_key: fact.eventKey,
    event_type: fact.eventType,
    order_number: fact.orderNumber,
    return_request_number: fact.returnRequestNumber,
    ordered_at: fact.orderedAt,
    event_at: fact.eventAt,
    status: fact.status,
    reason: fact.reason,
    amount_label: fact.amountLabel,
    amount: fact.amount,
    entry_filename: fact.entryFilename,
    source_rows: fact.sourceRows,
  }));
  await client.query(`
    INSERT INTO ${tables.shopeeReturnFacts}
      (shop_code, source_sha256, event_key, event_type, order_number,
       return_request_number, ordered_at, event_at, status, reason, amount_label,
       amount, entry_filename, source_rows)
    SELECT item.shop_code, item.source_sha256, item.event_key, item.event_type,
           item.order_number, item.return_request_number, item.ordered_at,
           item.event_at, item.status, item.reason, item.amount_label, item.amount,
           item.entry_filename, item.source_rows
    FROM jsonb_to_recordset($1::jsonb) AS item(
      shop_code text, source_sha256 text, event_key text, event_type text,
      order_number text, return_request_number text, ordered_at timestamptz,
      event_at timestamptz, status text, reason text, amount_label text,
      amount numeric, entry_filename text, source_rows jsonb
    )
  `, [JSON.stringify(rows)]);
}

async function insertFacts(client, tables, source) {
  if (source.facts.some((fact) => fact.shopCode && fact.shopCode !== source.shopCode)) {
    throw new Error("Official document fact/source shop mismatch.");
  }
  if (source.reportType === "financial-statement") return insertFinancialStatement(client, tables, source);
  if (["income-transferred", "income-pending"].includes(source.reportType)) return insertIncome(client, tables, source);
  if (source.reportType === "seller-balance") return insertSellerBalance(client, tables, source);
  if (source.reportType === "return-refund-cancel") return insertReturns(client, tables, source);
  throw new Error(`Unsupported official Shopee document type: ${source.reportType}`);
}

async function importOfficialDocumentSources(sources, {
  client,
  actor,
  manageTransaction = true,
}) {
  assertImportOptions({ client, actor });
  const tables = getTables();
  let imported = 0;
  let unchanged = 0;
  if (manageTransaction) await client.query("BEGIN");
  try {
    for (const shopCode of [...new Set(sources.map((source) => source.shopCode))].sort()) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`shopee-official-document:${shopCode}`]);
    }
    for (const source of sources) {
      const existing = await client.query(`
        SELECT * FROM ${tables.shopeeOfficialDocumentSources}
        WHERE source_sha256 = $1
      `, [source.sourceSha256]);
      if (existing.rows.length) {
        assertExistingSource(existing.rows[0], source);
        await enrichIncomeComponents(client, tables, source);
        unchanged += 1;
        continue;
      }
      await client.query(`
        INSERT INTO ${tables.shopeeOfficialDocumentSources}
          (shop_code, source_sha256, report_type, source_filename, observed_at,
           start_date, end_date, source_row_count, control, imported_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
      `, [source.shopCode, source.sourceSha256, source.reportType, source.sourceFilename,
        source.observedAt, source.startDate, source.endDate, source.facts.length,
        JSON.stringify(source.control), String(actor).trim()]);
      await insertFacts(client, tables, source);
      imported += 1;
    }
    if (manageTransaction) await client.query("COMMIT");
    return { imported, unchanged };
  } catch (error) {
    if (manageTransaction) await client.query("ROLLBACK");
    throw error;
  }
}

async function listFinanceSources({ client, shopCode, startDate, endDate }) {
  const tables = getTables();
  const params = [startDate, endDate];
  let shopClause = "";
  if (shopCode !== "all") {
    params.push(shopCode);
    shopClause = `AND shop_code = $${params.length}`;
  }
  const result = await client.query(`
    SELECT DISTINCT ON (shop_code, report_type, start_date, end_date)
      shop_code, report_type, source_sha256, source_filename, observed_at,
      start_date, end_date, source_row_count, control
    FROM ${tables.shopeeOfficialDocumentSources}
    WHERE report_type IN ('financial-statement', 'seller-balance', 'income-transferred', 'income-pending')
      AND start_date <= $2::date AND end_date >= $1::date
      ${shopClause}
    ORDER BY shop_code, report_type, start_date, end_date, observed_at DESC, imported_at DESC
  `, params);
  return result.rows;
}

async function listReconciliationFacts({ client, sourceSha256, reportType, shopCode }) {
  const tables = getTables();
  if (reportType === "income-transferred") {
    const result = await client.query(`
      SELECT order_number, payout_amount
      FROM ${tables.shopeeIncomeFacts}
      WHERE shop_code = $1 AND source_sha256 = $2
      ORDER BY order_number, payout_amount, source_row
    `, [shopCode, sourceSha256]);
    return result.rows;
  }
  if (reportType === "seller-balance") {
    const result = await client.query(`
      SELECT order_number, amount
      FROM ${tables.shopeeSellerBalanceFacts}
      WHERE shop_code = $1 AND source_sha256 = $2
        AND order_number IS NOT NULL AND status = 'ทำรายการสำเร็จ'
      ORDER BY order_number, amount, source_row
    `, [shopCode, sourceSha256]);
    return result.rows;
  }
  throw new Error("Unsupported finance reconciliation fact type.");
}

async function listReturnSourcesAndFacts({ client, shopCode, startDate, endDate }) {
  const tables = getTables();
  const params = [startDate, endDate];
  let shopClause = "";
  if (shopCode !== "all") {
    params.push(shopCode);
    shopClause = `AND source.shop_code = $${params.length}`;
  }
  const sources = await client.query(`
    SELECT source.shop_code, source.source_sha256, source.source_filename,
           source.observed_at, source.start_date, source.end_date, source.control
    FROM ${tables.shopeeOfficialDocumentSources} source
    WHERE source.report_type = 'return-refund-cancel'
      AND source.start_date <= $2::date AND source.end_date >= $1::date
      ${shopClause}
    ORDER BY source.shop_code, source.observed_at DESC, source.imported_at DESC
  `, params);
  const facts = await client.query(`
    SELECT DISTINCT ON (fact.shop_code, fact.event_key)
      fact.shop_code, fact.event_key, fact.event_type, fact.order_number,
      fact.return_request_number, fact.ordered_at, fact.event_at, fact.status,
      fact.reason, fact.amount_label, fact.amount, source.observed_at
    FROM ${tables.shopeeReturnFacts} fact
    JOIN ${tables.shopeeOfficialDocumentSources} source
      ON source.shop_code = fact.shop_code AND source.source_sha256 = fact.source_sha256
    WHERE (fact.ordered_at AT TIME ZONE 'Asia/Bangkok')::date BETWEEN $1::date AND $2::date
      ${shopClause}
    ORDER BY fact.shop_code, fact.event_key, source.observed_at DESC, source.imported_at DESC
  `, params);
  return { sources: sources.rows, facts: facts.rows };
}

module.exports = {
  enrichIncomeComponents,
  importOfficialDocumentSources,
  listFinanceSources,
  listReconciliationFacts,
  listReturnSourcesAndFacts,
};
