const pool = require('../../../../db');
const { getTables } = require('../tables');
const { requireShopeeShopCode } = require('../services/shopeeShops');

async function listPaidOrdersForCopy({ shopCode, startDate, endDate }) {
  requireShopeeShopCode(shopCode);
  const tables = getTables();
  const { rows } = await pool.query(`
    WITH latest AS (
      SELECT DISTINCT ON (f.shop_code, f.order_number) f.*, s.source_filename, s.observed_at
      FROM ${tables.shopeeSalesOrderFacts} f
      JOIN ${tables.shopeeSalesSources} s USING (shop_code, source_sha256)
      WHERE f.shop_code = $1
      ORDER BY f.shop_code, f.order_number, s.observed_at DESC, f.source_sha256 ASC
    )
    SELECT * FROM latest
    WHERE paid_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Bangkok')
      AND paid_at < (($3::date::timestamp + INTERVAL '1 day') AT TIME ZONE 'Asia/Bangkok')
    ORDER BY paid_at, order_number
  `, [shopCode, startDate, endDate]);
  // Source items, including cancelled paid orders, are authoritative here.
  // Do not merge email products or apply the created-date summary's exclusions.
  return rows.map(mapSourceOrder);
}

function mapSourceOrder(row) {
  return { shopCode: row.shop_code, orderNumber: row.order_number,
    paidAt: row.paid_at, orderedAt: row.ordered_at, status: row.status, excluded: row.excluded,
    itemSubtotal: row.item_subtotal, sellerVoucher: row.seller_voucher,
    shopeeProductDiscount: row.shopee_product_discount, items: row.items, lineFinancials: row.source_line_components,
    sourceRows: row.source_rows, sourceSha256: row.source_sha256,
    sourceFilename: row.source_filename, observedAt: row.observed_at };
}

// Load source orders AND the private correction ledger in one statement so
// selector and builder see the same snapshot. Fetch both sides of a correction,
// including orders now paid outside the range, to detect drift or missing facts.
async function getOrdersForCopyCohort({ shopCode, startDate, endDate }) {
  requireShopeeShopCode(shopCode);
  const tables = getTables();
  const { rows } = await pool.query(`
    WITH corrections AS (
      SELECT * FROM ${tables.shopeeCopyBusinessDates}
      WHERE shop_code = $1 AND enabled
        AND (business_date BETWEEN $2::date AND $3::date
          OR paid_business_date BETWEEN $2::date AND $3::date)
    ), allocations AS (
      SELECT * FROM ${tables.shopeeCopyLineEvidence}
      WHERE shop_code = $1 AND enabled
        AND (business_date BETWEEN $2::date AND $3::date
          OR paid_business_date BETWEEN $2::date AND $3::date)
    ), latest AS (
      SELECT DISTINCT ON (f.shop_code, f.order_number) f.*, s.source_filename, s.observed_at
      FROM ${tables.shopeeSalesOrderFacts} f
      JOIN ${tables.shopeeSalesSources} s USING (shop_code, source_sha256)
      WHERE f.shop_code = $1
      ORDER BY f.shop_code, f.order_number, s.observed_at DESC, f.source_sha256 ASC
    ), candidates AS (
      SELECT * FROM latest
      WHERE (paid_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Bangkok')
        AND paid_at < (($3::date::timestamp + INTERVAL '1 day') AT TIME ZONE 'Asia/Bangkok'))
        OR order_number IN (SELECT order_number FROM corrections)
        OR order_number IN (SELECT order_number FROM allocations)
    )
    SELECT COALESCE((SELECT jsonb_agg(to_jsonb(candidates) ORDER BY paid_at, order_number)
      FROM candidates), '[]'::jsonb) AS orders,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'shopCode', shop_code, 'orderNumber', order_number,
        'paidBusinessDate', to_char(paid_business_date, 'YYYY-MM-DD'),
        'businessDate', to_char(business_date, 'YYYY-MM-DD'),
        'sourceFactFingerprint', source_fact_fingerprint, 'evidence', evidence,
        'verifiedBy', verified_by, 'verifiedAt', verified_at, 'enabled', enabled
      ) ORDER BY order_number) FROM corrections), '[]'::jsonb) AS corrections,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'shopCode', shop_code, 'orderNumber', order_number,
        'paidBusinessDate', to_char(paid_business_date, 'YYYY-MM-DD'),
        'businessDate', to_char(business_date, 'YYYY-MM-DD'),
        'sourceFactFingerprint', source_fact_fingerprint, 'lineFinancials', line_financials,
        'evidence', evidence, 'verifiedBy', verified_by, 'verifiedAt', verified_at, 'enabled', enabled
      ) ORDER BY order_number) FROM allocations), '[]'::jsonb) AS allocations
  `, [shopCode, startDate, endDate]);
  return { orders: rows[0].orders.map(mapSourceOrder), businessDateCorrections: rows[0].corrections,
    lineFinancialEvidence: rows[0].allocations };
}

module.exports = { listPaidOrdersForCopy, getOrdersForCopyCohort };
