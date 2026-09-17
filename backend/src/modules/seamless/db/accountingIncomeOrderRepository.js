const pool = require("../../../../db");
const { getTables } = require("../tables");

function numberValue(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${label} returned by PostgreSQL.`);
  return parsed;
}

async function listIncomeOrders({
  dateColumn,
  dateFrom,
  dateTo,
  orderNumber,
  page,
  pageSize,
}, db = pool) {
  const tables = getTables();
  const params = [];
  const sourceWhere = ["source.report_type = 'income-transferred'"];
  if (orderNumber) {
    params.push(orderNumber);
    sourceWhere.push(`POSITION($${params.length} IN fact.order_number) > 0`);
  }
  const dateExpression = dateColumn === "transferredAt"
    ? "fact.transferred_at"
    : "fact.ordered_at";
  if (dateFrom) {
    params.push(dateFrom);
    sourceWhere.push(
      `${dateExpression} >= ($${params.length}::date::timestamp AT TIME ZONE 'Asia/Bangkok')`,
    );
  }
  if (dateTo) {
    params.push(dateTo);
    sourceWhere.push(
      `${dateExpression} < (($${params.length}::date + 1)::timestamp AT TIME ZONE 'Asia/Bangkok')`,
    );
  }
  params.push(pageSize, (page - 1) * pageSize);
  const limitPosition = params.length - 1;
  const offsetPosition = params.length;

  // Exact source replays and overlapping export snapshots can contain the same Income fact.
  // Keep the latest observation of that identical fact, while preserving genuinely distinct
  // transfers for the same order when return reference, dates, or amount differ.
  const result = await db.query(`
    WITH ranked AS (
      SELECT fact.shop_code, fact.order_number, fact.return_request_number,
             fact.ordered_at, fact.transferred_at, fact.payout_amount,
             ROW_NUMBER() OVER (
               PARTITION BY fact.shop_code, fact.order_number,
                 COALESCE(fact.return_request_number, ''), fact.ordered_at,
                 fact.transferred_at, fact.payout_amount
               ORDER BY source.observed_at DESC, source.imported_at DESC,
                        source.source_sha256 DESC, fact.source_row DESC
             ) AS source_rank
        FROM ${tables.shopeeIncomeFacts} fact
        JOIN ${tables.shopeeOfficialDocumentSources} source
          ON source.shop_code = fact.shop_code
         AND source.source_sha256 = fact.source_sha256
       WHERE ${sourceWhere.join(" AND ")}
    ), filtered AS (
      SELECT *, ${dateColumn === "transferredAt" ? "transferred_at" : "ordered_at"} AS sort_at
        FROM ranked
       WHERE source_rank = 1
    ), page_rows AS (
      SELECT order_number,
             to_char(ordered_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD') AS ordered_date,
             to_char(transferred_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD') AS transferred_date,
             payout_amount, sort_at, shop_code, return_request_number
        FROM filtered
       ORDER BY sort_at DESC, order_number ASC, shop_code ASC,
                COALESCE(return_request_number, '') ASC
       LIMIT $${limitPosition} OFFSET $${offsetPosition}
    )
    SELECT totals.total_count, page_rows.*
      FROM (SELECT COUNT(*)::integer AS total_count FROM filtered) totals
      LEFT JOIN page_rows ON TRUE
     ORDER BY page_rows.sort_at DESC NULLS LAST, page_rows.order_number ASC,
              page_rows.shop_code ASC, COALESCE(page_rows.return_request_number, '') ASC
  `, params);

  const totalCount = numberValue(result.rows[0]?.total_count || 0, "Income total count");
  const orders = result.rows
    .filter((row) => row.order_number)
    .map((row) => ({
      amount: numberValue(row.payout_amount, "Income payout amount"),
      orderDate: row.ordered_date,
      orderNumber: row.order_number,
      transferDate: row.transferred_date,
    }));
  return { orders, totalCount };
}

module.exports = { listIncomeOrders };
