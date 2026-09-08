const { getTables } = require('../tables');

// An explicit client is mandatory. This module must never initialize or select
// a production connection on its own. The caller owns connection lifecycle.
async function importSalesSources(sources, { client, actor }) {
  if (!client || !String(actor || '').trim()) throw new Error('Import requires an explicit client and actor.');
  const tables = getTables();
  let imported = 0;
  let unchanged = 0;
  await client.query('BEGIN');
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
      for (const fact of source.facts) {
        if (fact.shopCode !== source.shopCode) throw new Error('Fact/source shop mismatch.');
        await client.query(`
          INSERT INTO ${tables.shopeeSalesOrderFacts}
            (shop_code, source_sha256, order_number, ordered_at, status, excluded,
             item_subtotal, seller_voucher, shopee_product_discount, items, source_rows)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
        `, [fact.shopCode, source.sourceSha256, fact.orderNumber, fact.orderedAt, fact.status,
          fact.excluded, fact.itemSubtotal, fact.sellerVoucher, fact.shopeeProductDiscount,
          JSON.stringify(fact.items), JSON.stringify(fact.sourceRows)]);
      }
      imported += 1;
    }
    await client.query('COMMIT');
    return { imported, unchanged };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

module.exports = { importSalesSources };
