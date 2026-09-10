const pool = require('../../../../db');
const { getTables } = require('../tables');
const { requireShopeeShopScope, SHOPEE_SHOP_PROFILES } = require('../services/shopeeShops');

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function numberOrNull(value) {
  return value == null ? null : Number(value);
}

function dateOnly(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function shopsForScope(shopCode) {
  const scope = requireShopeeShopScope(shopCode);
  return scope === 'all' ? Object.keys(SHOPEE_SHOP_PROFILES) : [scope];
}

async function listOrderSnapshots({ shopCode, startDate, endDate }) {
  const tables = getTables();
  const shops = shopsForScope(shopCode);
  const result = await pool.query(`
    WITH scoped_orders AS (
      SELECT DISTINCT f.shop_code, f.order_number
      FROM ${tables.shopeeSalesOrderFacts} f
      WHERE f.shop_code = ANY($1::text[])
        AND f.paid_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Bangkok')
        AND f.paid_at < (($3::date::timestamp + INTERVAL '1 day') AT TIME ZONE 'Asia/Bangkok')
    )
    SELECT f.shop_code, f.order_number, f.ordered_at, f.paid_at, f.completed_at,
      f.status, f.excluded, f.item_subtotal, f.seller_voucher,
      f.shopee_product_discount, f.voucher_codes, f.source_rows, s.source_sha256,
      s.source_filename, s.observed_at, s.start_date, s.end_date,
      s.order_count, s.imported_at
    FROM ${tables.shopeeSalesOrderFacts} f
    JOIN scoped_orders scoped USING (shop_code, order_number)
    JOIN ${tables.shopeeSalesSources} s USING (shop_code, source_sha256)
    ORDER BY f.shop_code, f.order_number, s.observed_at, s.source_sha256
  `, [shops, startDate, endDate]);
  return result.rows.map((row) => ({
    shopCode: row.shop_code,
    orderNumber: row.order_number,
    orderedAt: iso(row.ordered_at),
    paidAt: iso(row.paid_at),
    completedAt: iso(row.completed_at),
    status: row.status,
    excluded: row.excluded === true,
    itemSubtotal: numberOrNull(row.item_subtotal),
    sellerVoucher: numberOrNull(row.seller_voucher),
    shopeeProductDiscount: numberOrNull(row.shopee_product_discount),
    voucherCodes: row.voucher_codes,
    sourceRows: row.source_rows || [],
    sourceSha256: row.source_sha256,
    sourceFilename: row.source_filename,
    observedAt: iso(row.observed_at),
    sourceStartDate: dateOnly(row.start_date),
    sourceEndDate: dateOnly(row.end_date),
    sourceOrderCount: Number(row.order_count),
    importedAt: iso(row.imported_at),
  }));
}

function bangkokDateOnly(value) {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) throw new Error('Invalid order timestamp in voucher evidence query.');
  return new Date(instant.getTime() + 7 * 3600000).toISOString().slice(0, 10);
}

async function listSellerVoucherEvidence({ shopCode, startDate, endDate }, orderSnapshots = []) {
  const tables = getTables();
  const paymentDates = orderSnapshots.filter((row) => row.paidAt).map((row) => bangkokDateOnly(row.paidAt));
  const evidenceStartDate = [startDate, ...paymentDates].sort()[0];
  const evidenceEndDate = [endDate, ...paymentDates].sort().at(-1);
  const result = await pool.query(`
    SELECT shop_code, voucher_id, voucher_name, valid_from, valid_to,
      discount_rate, max_discount, min_spend, applies_to_all_products,
      source_url, source_observed_at, source_observed_precision,
      source_notes, recorded_by, recorded_at
    FROM ${tables.shopeeSellerVoucherEvidence}
    WHERE shop_code = ANY($1::text[])
      AND valid_from < (($3::date::timestamp + INTERVAL '1 day') AT TIME ZONE 'Asia/Bangkok')
      AND valid_to >= ($2::date::timestamp AT TIME ZONE 'Asia/Bangkok')
    ORDER BY shop_code, valid_from, valid_to, voucher_id
  `, [shopsForScope(shopCode), evidenceStartDate, evidenceEndDate]);
  return result.rows.map((row) => ({
    shopCode: row.shop_code,
    voucherId: row.voucher_id,
    voucherName: row.voucher_name,
    validFrom: iso(row.valid_from),
    validTo: iso(row.valid_to),
    discountRate: Number(row.discount_rate),
    maxDiscount: Number(row.max_discount),
    minSpend: Number(row.min_spend),
    appliesToAllProducts: row.applies_to_all_products === true,
    sourceUrl: row.source_url,
    sourceObservedAt: iso(row.source_observed_at),
    sourceObservedPrecision: row.source_observed_precision,
    sourceNotes: row.source_notes,
    recordedBy: row.recorded_by,
    recordedAt: iso(row.recorded_at),
  }));
}

async function listOrderSources({ shopCode, startDate, endDate }) {
  const tables = getTables();
  const result = await pool.query(`
    SELECT shop_code, source_sha256, source_filename, observed_at,
      start_date, end_date, order_count, imported_at
    FROM ${tables.shopeeSalesSources} s
    WHERE shop_code = ANY($1::text[])
      AND (
        (start_date <= $3::date AND end_date >= $2::date)
        OR EXISTS (
          SELECT 1
          FROM ${tables.shopeeSalesOrderFacts} fact
          WHERE fact.shop_code = s.shop_code
            AND fact.source_sha256 = s.source_sha256
            AND fact.paid_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Bangkok')
            AND fact.paid_at < (($3::date::timestamp + INTERVAL '1 day') AT TIME ZONE 'Asia/Bangkok')
        )
      )
    ORDER BY shop_code, start_date, end_date, observed_at, source_sha256
  `, [shopsForScope(shopCode), startDate, endDate]);
  return result.rows.map((row) => ({
    shopCode: row.shop_code,
    sourceSha256: row.source_sha256,
    sourceFilename: row.source_filename,
    observedAt: iso(row.observed_at),
    startDate: dateOnly(row.start_date),
    endDate: dateOnly(row.end_date),
    orderCount: Number(row.order_count),
    importedAt: iso(row.imported_at),
  }));
}

async function listReturnSources({ shopCode, startDate, endDate }) {
  const tables = getTables();
  const result = await pool.query(`
    SELECT s.shop_code, s.report_type, s.source_sha256, s.source_filename,
      s.observed_at, s.start_date, s.end_date, s.source_row_count, s.control, s.imported_at
    FROM ${tables.shopeeOfficialDocumentSources} s
    WHERE s.shop_code = ANY($1::text[])
      AND s.report_type = 'return-refund-cancel'
      AND s.start_date <= $3::date
      AND s.end_date >= $2::date
    ORDER BY s.shop_code, s.report_type, s.start_date, s.end_date,
      s.observed_at, s.source_sha256
  `, [shopsForScope(shopCode), startDate, endDate]);
  return result.rows.map((row) => ({
    shopCode: row.shop_code,
    reportType: row.report_type,
    sourceSha256: row.source_sha256,
    sourceFilename: row.source_filename,
    observedAt: iso(row.observed_at),
    startDate: dateOnly(row.start_date),
    endDate: dateOnly(row.end_date),
    sourceRowCount: Number(row.source_row_count),
    control: row.control || {},
    importedAt: iso(row.imported_at),
  }));
}

async function listIndependentDocumentEvidence({ shopCode, startDate, endDate, incomeCycles = [] }) {
  const tables = getTables();
  const cycleKeys = [...new Set(incomeCycles
    .filter((row) => row.shopCode && row.startDate && row.endDate)
    .map((row) => `${row.shopCode}:${row.startDate}:${row.endDate}`))];
  const result = await pool.query(`
    SELECT s.shop_code, s.report_type, s.source_sha256, s.source_filename,
      s.observed_at, s.start_date, s.end_date, s.source_row_count, s.control,
      s.imported_at, statement.transferred_total, statement.page_count
    FROM ${tables.shopeeOfficialDocumentSources} s
    LEFT JOIN ${tables.shopeeFinancialStatementFacts} statement
      USING (shop_code, source_sha256)
    WHERE s.shop_code = ANY($1::text[])
      AND s.report_type IN ('financial-statement', 'seller-balance')
      AND (
        (s.shop_code || ':' || s.start_date::text || ':' || s.end_date::text) = ANY($4::text[])
        OR (s.start_date <= $3::date AND s.end_date >= $2::date)
      )
    ORDER BY s.shop_code, s.report_type, s.start_date, s.end_date,
      s.observed_at, s.source_sha256
  `, [shopsForScope(shopCode), startDate, endDate, cycleKeys]);
  const rows = result.rows.map((row) => {
    const mapped = {
      shopCode: row.shop_code,
      reportType: row.report_type,
      sourceSha256: row.source_sha256,
      sourceFilename: row.source_filename,
      observedAt: iso(row.observed_at),
      startDate: dateOnly(row.start_date),
      endDate: dateOnly(row.end_date),
      sourceRowCount: Number(row.source_row_count),
      control: row.control || {},
      importedAt: iso(row.imported_at),
      transferredTotal: numberOrNull(row.transferred_total),
      pageCount: row.page_count == null ? null : Number(row.page_count),
    };
    mapped.linkedIncomeCycle = cycleKeys.includes(`${mapped.shopCode}:${mapped.startDate}:${mapped.endDate}`);
    return mapped;
  });
  return {
    financialStatements: rows.filter((row) => row.reportType === 'financial-statement' && row.linkedIncomeCycle),
    sellerBalanceSources: rows.filter((row) => row.reportType === 'seller-balance' && row.linkedIncomeCycle),
    unlinkedSources: rows.filter((row) => !row.linkedIncomeCycle),
  };
}

async function listLinkedDocuments(orderSnapshots) {
  const tables = getTables();
  const keys = [...new Set(orderSnapshots.map((row) => `${row.shopCode}:${row.orderNumber}`))];
  if (!keys.length) return { incomeFacts: [], balanceFacts: [], returnFacts: [] };
  const [income, balance, returns] = await Promise.all([
    pool.query(`
      SELECT f.shop_code, f.order_number, f.return_request_number, f.ordered_at,
        f.payout_amount, f.components, f.transferred_at, f.source_row, s.report_type, s.source_sha256,
        s.source_filename, s.observed_at, s.start_date, s.end_date
      FROM ${tables.shopeeIncomeFacts} f
      JOIN ${tables.shopeeOfficialDocumentSources} s USING (shop_code, source_sha256)
      WHERE (f.shop_code || ':' || f.order_number) = ANY($1::text[])
      ORDER BY f.shop_code, f.order_number, s.observed_at DESC, f.source_row
    `, [keys]),
    pool.query(`
      SELECT f.shop_code, f.order_number, f.amount, f.transaction_at,
        f.transaction_type, f.direction, f.status, f.source_row,
        s.source_sha256, s.source_filename, s.observed_at
      FROM ${tables.shopeeSellerBalanceFacts} f
      JOIN ${tables.shopeeOfficialDocumentSources} s USING (shop_code, source_sha256)
      WHERE f.order_number IS NOT NULL
        AND (f.shop_code || ':' || f.order_number) = ANY($1::text[])
      ORDER BY f.shop_code, f.order_number, s.observed_at DESC, f.source_row
    `, [keys]),
    pool.query(`
      SELECT f.shop_code, f.order_number, f.event_key, f.event_type,
        f.event_at, f.amount, f.amount_label, f.status, f.reason,
        f.return_request_number, f.entry_filename, f.source_rows,
        s.source_sha256, s.source_filename, s.observed_at
      FROM ${tables.shopeeReturnFacts} f
      JOIN ${tables.shopeeOfficialDocumentSources} s USING (shop_code, source_sha256)
      WHERE (f.shop_code || ':' || f.order_number) = ANY($1::text[])
      ORDER BY f.shop_code, f.order_number, f.event_key, s.observed_at DESC
    `, [keys]),
  ]);
  return {
    incomeFacts: income.rows.map((row) => ({
      shopCode: row.shop_code, orderNumber: row.order_number,
      returnRequestNumber: row.return_request_number,
      orderedAt: iso(row.ordered_at),
      payoutAmount: Number(row.payout_amount), components: row.components || {},
      transferredAt: iso(row.transferred_at), sourceRow: Number(row.source_row),
      reportType: row.report_type, sourceSha256: row.source_sha256,
      sourceFilename: row.source_filename, observedAt: iso(row.observed_at),
      sourceStartDate: dateOnly(row.start_date), sourceEndDate: dateOnly(row.end_date),
    })),
    balanceFacts: balance.rows.map((row) => ({
      shopCode: row.shop_code, orderNumber: row.order_number,
      amount: Number(row.amount), transactionAt: iso(row.transaction_at),
      transactionType: row.transaction_type, direction: row.direction,
      status: row.status, sourceRow: Number(row.source_row),
      sourceSha256: row.source_sha256, sourceFilename: row.source_filename,
      observedAt: iso(row.observed_at),
    })),
    returnFacts: returns.rows.map((row) => ({
      shopCode: row.shop_code, orderNumber: row.order_number,
      eventKey: row.event_key, eventType: row.event_type, eventAt: iso(row.event_at),
      amount: numberOrNull(row.amount), amountLabel: row.amount_label,
      status: row.status, reason: row.reason,
      returnRequestNumber: row.return_request_number,
      entryFilename: row.entry_filename, sourceRows: row.source_rows || [],
      sourceSha256: row.source_sha256, sourceFilename: row.source_filename,
      observedAt: iso(row.observed_at),
    })),
  };
}

async function listReconciliationEvidence(filters) {
  const [orderSnapshots, orderSources, returnSources] = await Promise.all([
    listOrderSnapshots(filters),
    listOrderSources(filters),
    listReturnSources(filters),
  ]);
  const [linked, sellerVoucherEvidence] = await Promise.all([
    listLinkedDocuments(orderSnapshots),
    listSellerVoucherEvidence(filters, orderSnapshots),
  ]);
  const incomeCycles = linked.incomeFacts.map((row) => ({
    shopCode: row.shopCode,
    startDate: row.sourceStartDate,
    endDate: row.sourceEndDate,
  }));
  const downstreamControls = await listIndependentDocumentEvidence({ ...filters, incomeCycles });
  return {
    orderSnapshots,
    orderSources,
    returnSources,
    sellerVoucherEvidence,
    downstreamControls,
    ...linked,
  };
}

module.exports = {
  listIndependentDocumentEvidence,
  listLinkedDocuments,
  listOrderSnapshots,
  listOrderSources,
  listReturnSources,
  listSellerVoucherEvidence,
  listReconciliationEvidence,
};
