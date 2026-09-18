const pool = require("../../../../db");
const { getTables } = require("../tables");

function numberValue(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${label} returned by PostgreSQL.`);
  return parsed;
}

const SELLER_BALANCE_STATUSES = Object.freeze({
  AMOUNT_MISMATCH: "amount_mismatch",
  CREDITED: "credited",
  NOT_COVERED: "not_covered",
  NOT_FOUND_IN_COVERED_REPORT: "not_found_in_covered_report",
  OUTFLOW_OR_REVERSED: "outflow_or_reversed",
});

function moneyCents(value, label) {
  return Math.round(numberValue(value, label) * 100);
}

function deriveSellerBalanceStatus({
  covered,
  hasSuccessfulOutflow,
  incomeAmount,
  successfulInflowAmount,
  successfulInflowCount,
}) {
  if (hasSuccessfulOutflow) return SELLER_BALANCE_STATUSES.OUTFLOW_OR_REVERSED;
  if (Number(successfulInflowCount) > 0) {
    return moneyCents(successfulInflowAmount, "Seller Balance inflow amount")
      === moneyCents(incomeAmount, "Income payout amount")
      ? SELLER_BALANCE_STATUSES.CREDITED
      : SELLER_BALANCE_STATUSES.AMOUNT_MISMATCH;
  }
  return covered
    ? SELLER_BALANCE_STATUSES.NOT_FOUND_IN_COVERED_REPORT
    : SELLER_BALANCE_STATUSES.NOT_COVERED;
}

async function listIncomeOrders({
  dateColumn,
  dateFrom,
  dateTo,
  orderNumber,
  page,
  pageSize,
  shopCode,
}, db = pool) {
  const tables = getTables();
  const params = [];
  const sourceWhere = ["source.report_type = 'income-transferred'"];
  if (orderNumber) {
    params.push(orderNumber);
    sourceWhere.push(`POSITION($${params.length} IN fact.order_number) > 0`);
  }
  if (shopCode) {
    params.push(shopCode);
    sourceWhere.push(`fact.shop_code = $${params.length}`);
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

  // Exact source replays and overlapping export snapshots can contain the same Income or
  // Seller Balance fact. Keep the latest observation of each identical fact. Balance-after is
  // part of the Balance identity so separate real transactions with the same order, timestamp,
  // direction, and amount are not collapsed when they move the running balance independently.
  // Seller Balance joins start from page_order_keys, limiting the indexed order lookup to the
  // current page rather than reconciling the entire Income result set for every request.
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
    ), page_rows AS MATERIALIZED (
      SELECT order_number, ordered_at, transferred_at, payout_amount, sort_at,
             shop_code, return_request_number
        FROM filtered
       ORDER BY sort_at DESC, order_number ASC, shop_code ASC,
                COALESCE(return_request_number, '') ASC
       LIMIT $${limitPosition} OFFSET $${offsetPosition}
    ), page_order_keys AS (
      SELECT DISTINCT shop_code, order_number
        FROM page_rows
    ), balance_ranked AS (
      SELECT balance.shop_code, balance.order_number, balance.transaction_at,
             balance.direction, balance.amount, balance.status, balance.balance_after,
             ROW_NUMBER() OVER (
               PARTITION BY balance.shop_code, balance.order_number,
                 balance.transaction_at, balance.transaction_type, balance.direction,
                 balance.amount, balance.status, balance.balance_after
               ORDER BY balance_source.observed_at DESC,
                        balance_source.imported_at DESC,
                        balance_source.source_sha256 DESC,
                        balance.source_row DESC
             ) AS evidence_rank
        FROM page_order_keys page_key
        JOIN ${tables.shopeeSellerBalanceFacts} balance
          ON balance.shop_code = page_key.shop_code
         AND balance.order_number = page_key.order_number
        JOIN ${tables.shopeeOfficialDocumentSources} balance_source
          ON balance_source.shop_code = balance.shop_code
         AND balance_source.source_sha256 = balance.source_sha256
       WHERE balance_source.report_type = 'seller-balance'
         AND balance.transaction_type = 'รายรับจากคำสั่งซื้อ'
    ), balance_evidence AS (
      SELECT shop_code, order_number,
             COUNT(*) FILTER (
               WHERE status = 'ทำรายการสำเร็จ' AND direction = 'เงินเข้า'
             )::integer AS successful_inflow_count,
             COALESCE(SUM(amount) FILTER (
               WHERE status = 'ทำรายการสำเร็จ' AND direction = 'เงินเข้า'
             ), 0) AS successful_inflow_amount,
             COALESCE(SUM(amount) FILTER (
               WHERE status = 'ทำรายการสำเร็จ'
             ), 0) AS successful_net_amount,
             BOOL_OR(
               status = 'ทำรายการสำเร็จ' AND direction = 'เงินออก'
             ) AS has_successful_outflow,
             MAX(transaction_at) FILTER (
               WHERE status = 'ทำรายการสำเร็จ' AND direction = 'เงินเข้า'
             ) AS latest_successful_inflow_at
        FROM balance_ranked
       WHERE evidence_rank = 1
       GROUP BY shop_code, order_number
    )
    SELECT totals.total_count, page_rows.order_number,
           to_char(page_rows.ordered_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD') AS ordered_date,
           to_char(page_rows.transferred_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD') AS transferred_date,
           page_rows.payout_amount, page_rows.sort_at, page_rows.shop_code,
           page_rows.return_request_number,
           evidence.successful_inflow_count, evidence.successful_inflow_amount,
           evidence.successful_net_amount, evidence.has_successful_outflow,
           to_char(evidence.latest_successful_inflow_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD')
             AS seller_balance_inflow_date,
           CASE WHEN page_rows.order_number IS NULL THEN FALSE ELSE EXISTS (
             SELECT 1
               FROM ${tables.shopeeOfficialDocumentSources} coverage_source
              WHERE coverage_source.shop_code = page_rows.shop_code
                AND coverage_source.report_type = 'seller-balance'
                AND page_rows.transferred_at IS NOT NULL
                AND coverage_source.start_date
                    <= (page_rows.transferred_at AT TIME ZONE 'Asia/Bangkok')::date
                AND coverage_source.end_date
                    >= (page_rows.transferred_at AT TIME ZONE 'Asia/Bangkok')::date
           ) END AS seller_balance_covered
      FROM (SELECT COUNT(*)::integer AS total_count FROM filtered) totals
      LEFT JOIN page_rows ON TRUE
      LEFT JOIN balance_evidence evidence
        ON evidence.shop_code = page_rows.shop_code
       AND evidence.order_number = page_rows.order_number
     ORDER BY page_rows.sort_at DESC NULLS LAST, page_rows.order_number ASC,
              page_rows.shop_code ASC, COALESCE(page_rows.return_request_number, '') ASC
  `, params);

  const totalCount = numberValue(result.rows[0]?.total_count || 0, "Income total count");
  const orders = result.rows
    .filter((row) => row.order_number)
    .map((row) => {
      const amount = numberValue(row.payout_amount, "Income payout amount");
      const successfulInflowCount = Number(row.successful_inflow_count || 0);
      const hasSuccessfulOutflow = row.has_successful_outflow === true;
      const hasSuccessfulEvidence = successfulInflowCount > 0 || hasSuccessfulOutflow;
      return {
        amount,
        orderDate: row.ordered_date,
        orderNumber: row.order_number,
        shopCode: row.shop_code,
        sellerBalanceNetAmount: hasSuccessfulEvidence
          ? numberValue(row.successful_net_amount, "Seller Balance net amount")
          : null,
        sellerBalanceStatus: deriveSellerBalanceStatus({
          covered: row.seller_balance_covered === true,
          hasSuccessfulOutflow,
          incomeAmount: amount,
          successfulInflowAmount: row.successful_inflow_amount || 0,
          successfulInflowCount,
        }),
        sellerBalanceInflowDate: successfulInflowCount > 0
          ? row.seller_balance_inflow_date
          : null,
        transferDate: row.transferred_date,
      };
    });
  return { orders, totalCount };
}

async function listIncomeExportSourceDocuments({ dateFrom, dateTo, shopCode }, db = pool) {
  const tables = getTables();
  const params = [dateFrom, dateTo];
  const shopParameter = shopCode ? params.push(shopCode) : null;
  const storedShopCondition = shopParameter
    ? `AND item.document->>'shopCode' = $${shopParameter}`
    : "";
  const canonicalShopCondition = shopParameter ? `AND shop_code = $${shopParameter}` : "";
  const stored = await db.query(`
    SELECT item.id AS item_id, item.batch_id, item.document, item.source_file,
           batch.created_at, NULL::text AS source_original_id
      FROM ${tables.accountingPrintItems} item
      JOIN ${tables.accountingPrintBatches} batch ON batch.id = item.batch_id
     WHERE item.document->>'kind' IN ('statement', 'income')
       AND (item.document->>'start')::date <= $2::date
       AND (item.document->>'end')::date >= $1::date
       ${storedShopCondition}
    UNION ALL
    SELECT NULL::uuid AS item_id, NULL::uuid AS batch_id,
           jsonb_build_object(
             'checksumSha256', source.source_sha256,
             'end', source.end_date::text,
             'filename', source.source_filename,
             'kind', source.document_kind,
             'periodType', source.period_type,
             'shopCode', source.shop_code,
             'start', source.start_date::text
           ) AS document,
           source.source_file, source.created_at,
           source.id::text AS source_original_id
      FROM ${tables.accountingSourceOriginals} source
     WHERE source.document_kind IN ('statement')
       AND source.start_date <= $2::date
       AND source.end_date >= $1::date
       ${shopParameter ? `AND source.shop_code = $${shopParameter}` : ""}
     ORDER BY created_at DESC
  `, params);
  const canonical = await db.query(`
    SELECT shop_code, source_sha256, report_type, source_filename,
           start_date::text, end_date::text, imported_at
      FROM ${tables.shopeeOfficialDocumentSources}
     WHERE report_type IN ('financial-statement', 'income-transferred')
       AND start_date <= $2::date
       AND end_date >= $1::date
       ${canonicalShopCondition}
     ORDER BY imported_at DESC, source_filename ASC
  `, params);

  const byChecksum = new Map();
  for (const row of stored.rows) {
    const document = row.document || {};
    const checksumSha256 = String(document.checksumSha256 || "").toLowerCase();
    if (!checksumSha256 || byChecksum.has(checksumSha256)) continue;
    byChecksum.set(checksumSha256, {
      checksumSha256,
      endDate: String(document.end || ""),
      filename: String(document.filename || ""),
      kind: document.kind,
      originalAvailable: true,
      originalPath: row.source_original_id
        ? `/app/accounting-print-bundles/source-originals/${row.source_original_id}`
        : `/app/accounting-print-bundles/${row.batch_id}/items/${row.item_id}/original?disposition=inline`,
      periodType: String(document.periodType || ""),
      shopCode: String(document.shopCode || ""),
      sourceFile: row.source_file || null,
      startDate: String(document.start || ""),
    });
  }
  for (const row of canonical.rows) {
    const checksumSha256 = String(row.source_sha256 || "").toLowerCase();
    if (!checksumSha256 || byChecksum.has(checksumSha256)) continue;
    byChecksum.set(checksumSha256, {
      checksumSha256,
      endDate: String(row.end_date || ""),
      filename: String(row.source_filename || ""),
      kind: row.report_type === "financial-statement" ? "statement" : "income",
      originalAvailable: false,
      originalPath: null,
      periodType: "",
      shopCode: String(row.shop_code || ""),
      sourceFile: null,
      startDate: String(row.start_date || ""),
    });
  }

  const kindOrder = { statement: 0, income: 1 };
  return [...byChecksum.values()].sort((left, right) => (
    left.startDate.localeCompare(right.startDate)
      || left.shopCode.localeCompare(right.shopCode)
      || (kindOrder[left.kind] ?? 99) - (kindOrder[right.kind] ?? 99)
      || left.filename.localeCompare(right.filename, "th")
  ));
}

module.exports = {
  SELLER_BALANCE_STATUSES,
  deriveSellerBalanceStatus,
  listIncomeExportSourceDocuments,
  listIncomeOrders,
};
