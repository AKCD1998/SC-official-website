const { getTables } = require('../tables');

// An explicit client is mandatory. This module must never initialize or select
// a production connection on its own. The caller owns connection lifecycle.
async function importSalesSources(sources, { client, actor, manageTransaction = true }) {
  if (!client || !String(actor || '').trim()) throw new Error('Import requires an explicit client and actor.');
  const tables = getTables();
  let imported = 0;
  let unchanged = 0;
  if (manageTransaction) await client.query('BEGIN');
  try {
    // Stable lock ordering makes multi-file / multi-shop replays atomic.
    for (const shop of [...new Set(sources.map((source) => source.shopCode))].sort()) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`shopee-sales-source:${shop}`]);
    }
    for (const source of sources) {
      const existing = await client.query(
        `SELECT * FROM ${tables.shopeeSalesSources} WHERE source_sha256 = $1`, [source.sourceSha256],
      );
      if (existing.rows.some((row) => row.shop_code !== source.shopCode)) {
        throw new Error('The same source file is already assigned to a different shop.');
      }
      if (existing.rows.length) {
        const row = existing.rows[0];
        if (new Date(row.observed_at).toISOString() !== source.observedAt
          || row.source_filename !== source.sourceFilename
          || Number(row.order_count) !== source.facts.length) {
          throw new Error('Existing source metadata differs; do not relabel an imported snapshot.');
        }
        const lineageRows = source.facts.map((fact) => ({
          shop_code: fact.shopCode,
          source_sha256: source.sourceSha256,
          order_number: fact.orderNumber,
          paid_at: fact.paidAt,
          completed_at: fact.completedAt,
          voucher_codes: fact.voucherCodes,
        }));
        if (lineageRows.length) {
          const conflicts = await client.query(`
            SELECT f.order_number
            FROM ${tables.shopeeSalesOrderFacts} f
            JOIN jsonb_to_recordset($1::jsonb) AS item(
              shop_code text, source_sha256 text, order_number text,
              paid_at timestamptz, completed_at timestamptz, voucher_codes jsonb
            ) USING (shop_code, source_sha256, order_number)
            WHERE (f.paid_at IS NOT NULL AND f.paid_at IS DISTINCT FROM item.paid_at)
               OR (f.completed_at IS NOT NULL AND f.completed_at IS DISTINCT FROM item.completed_at)
               OR (f.voucher_codes IS NOT NULL AND f.voucher_codes IS DISTINCT FROM item.voucher_codes)
            LIMIT 1
          `, [JSON.stringify(lineageRows)]);
          if (conflicts.rows.length) {
            throw new Error('Existing immutable order lineage differs from the replayed source.');
          }
          // Migrations 021/022 introduced these fields after earlier source
          // imports. Same-hash replay may fill only NULL lineage columns from
          // the exact same immutable workbook; it never changes existing values.
          await client.query(`
            UPDATE ${tables.shopeeSalesOrderFacts} f
            SET paid_at = COALESCE(f.paid_at, item.paid_at),
                completed_at = COALESCE(f.completed_at, item.completed_at),
                voucher_codes = COALESCE(f.voucher_codes, item.voucher_codes)
            FROM jsonb_to_recordset($1::jsonb) AS item(
              shop_code text, source_sha256 text, order_number text,
              paid_at timestamptz, completed_at timestamptz, voucher_codes jsonb
            )
            WHERE f.shop_code = item.shop_code
              AND f.source_sha256 = item.source_sha256
              AND f.order_number = item.order_number
              AND ((f.paid_at IS NULL AND item.paid_at IS NOT NULL)
                OR (f.completed_at IS NULL AND item.completed_at IS NOT NULL)
                OR (f.voucher_codes IS NULL AND item.voucher_codes IS NOT NULL))
          `, [JSON.stringify(lineageRows)]);
        }
        unchanged += 1;
        continue;
      }
      const overlapping = await client.query(`
        SELECT f.order_number FROM ${tables.shopeeSalesOrderFacts} f
        JOIN ${tables.shopeeSalesSources} s USING (shop_code, source_sha256)
        WHERE f.shop_code = $1 AND s.observed_at = $2
          AND f.order_number = ANY($3::text[]) LIMIT 1
      `, [source.shopCode, source.observedAt, source.facts.map((fact) => fact.orderNumber)]);
      if (overlapping.rows.length) throw new Error('Ambiguous overlapping snapshots at the same observation time.');
      await client.query(`
        INSERT INTO ${tables.shopeeSalesSources}
          (shop_code, source_sha256, source_filename, observed_at, start_date, end_date, order_count, imported_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [source.shopCode, source.sourceSha256, source.sourceFilename, source.observedAt,
        source.startDate, source.endDate, source.facts.length, String(actor).trim()]);
      const factRows = source.facts.map((fact) => {
        if (fact.shopCode !== source.shopCode) throw new Error('Fact/source shop mismatch.');
        return {
          shop_code: fact.shopCode,
          source_sha256: source.sourceSha256,
          order_number: fact.orderNumber,
          ordered_at: fact.orderedAt,
          paid_at: fact.paidAt,
          completed_at: fact.completedAt,
          voucher_codes: fact.voucherCodes,
          status: fact.status,
          excluded: fact.excluded,
          item_subtotal: fact.itemSubtotal,
          seller_voucher: fact.sellerVoucher,
          shopee_product_discount: fact.shopeeProductDiscount,
          items: fact.items,
          source_rows: fact.sourceRows,
        };
      });
      if (factRows.length) {
        // A rolling 31-day Shopee export can contain thousands of orders. One
        // parameterized bulk statement keeps the upload inside the agent's
        // request timeout while preserving the surrounding atomic transaction.
        await client.query(`
          INSERT INTO ${tables.shopeeSalesOrderFacts}
            (shop_code, source_sha256, order_number, ordered_at, paid_at, completed_at, status, excluded,
             item_subtotal, seller_voucher, shopee_product_discount, voucher_codes, items, source_rows)
          SELECT fact.shop_code, fact.source_sha256, fact.order_number, fact.ordered_at,
                 fact.paid_at, fact.completed_at, fact.status, fact.excluded, fact.item_subtotal, fact.seller_voucher,
                 fact.shopee_product_discount, fact.voucher_codes, fact.items, fact.source_rows
          FROM jsonb_to_recordset($1::jsonb) AS fact(
            shop_code text,
            source_sha256 text,
            order_number text,
            ordered_at timestamptz,
            paid_at timestamptz,
            completed_at timestamptz,
            status text,
            excluded boolean,
            item_subtotal numeric,
            seller_voucher numeric,
            shopee_product_discount numeric,
            voucher_codes jsonb,
            items jsonb,
            source_rows jsonb
          )
        `, [JSON.stringify(factRows)]);
      }
      imported += 1;
    }
    if (manageTransaction) await client.query('COMMIT');
    return { imported, unchanged };
  } catch (error) {
    if (manageTransaction) await client.query('ROLLBACK');
    throw error;
  }
}

module.exports = { importSalesSources };
