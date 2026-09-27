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
  return rows.map(row => ({ shopCode: row.shop_code, orderNumber: row.order_number,
    paidAt: row.paid_at, orderedAt: row.ordered_at, status: row.status, excluded: row.excluded,
    itemSubtotal: row.item_subtotal, sellerVoucher: row.seller_voucher,
    shopeeProductDiscount: row.shopee_product_discount, items: row.items,
    sourceRows: row.source_rows, sourceSha256: row.source_sha256,
    sourceFilename: row.source_filename, observedAt: row.observed_at }));
}

module.exports = { listPaidOrdersForCopy };
