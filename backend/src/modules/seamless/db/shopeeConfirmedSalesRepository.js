const { getTables } = require('../tables');
const { requireShopeeShopScope } = require('../services/shopeeShops');
const { datesInRange } = require('../services/shopeeConfirmedSalesService');

async function importConfirmedSalesSources(sources, { client, actor, manageTransaction = true }) {
  if (!client || !String(actor || '').trim()) throw new Error('Confirmed import requires explicit client and actor.');
  const tables = getTables();
  let imported = 0; let unchanged = 0;
  if (manageTransaction) await client.query('BEGIN');
  try {
    for (const shop of [...new Set(sources.map(source => source.shopCode))].sort()) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`shopee-confirmed-source:${shop}`]);
    }
    for (const source of sources) {
      const existing = await client.query(`SELECT * FROM ${tables.shopeeConfirmedSources} WHERE source_sha256 = $1`, [source.sourceSha256]);
      if (existing.rows.length) {
        const row = existing.rows[0];
        if (row.shop_code !== source.shopCode || row.source_filename !== source.sourceFilename
          || new Date(row.observed_at).toISOString() !== source.observedAt || Number(row.day_count) !== source.facts.length) {
          throw new Error('Existing confirmed source metadata differs; cannot relabel a snapshot or shop.');
        }
        unchanged += 1; continue;
      }
      const overlap = await client.query(`SELECT 1 FROM ${tables.shopeeConfirmedSources}
        WHERE shop_code=$1 AND observed_at=$2 AND start_date <= $4::date AND end_date >= $3::date LIMIT 1`,
      [source.shopCode, source.observedAt, source.startDate, source.endDate]);
      if (overlap.rows.length) throw new Error('Ambiguous overlapping confirmed snapshots at the same observation time.');
      await client.query(`INSERT INTO ${tables.shopeeConfirmedSources}
        (shop_code,source_sha256,source_filename,observed_at,start_date,end_date,day_count,control,imported_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`, [source.shopCode, source.sourceSha256, source.sourceFilename,
        source.observedAt, source.startDate, source.endDate, source.facts.length, JSON.stringify(source.control), actor.trim()]);
      for (const fact of source.facts) {
        if (fact.shopCode !== source.shopCode || fact.date < source.startDate || fact.date > source.endDate) throw new Error('Confirmed fact/source scope mismatch.');
        await client.query(`INSERT INTO ${tables.shopeeConfirmedDailyFacts}
          (shop_code,source_sha256,report_date,sales_total,order_count,cancelled_sales,cancelled_order_count,returned_sales,returned_order_count,source_row)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [fact.shopCode, source.sourceSha256, fact.date, fact.salesTotal,
          fact.orderCount, fact.cancelledSales, fact.cancelledOrderCount, fact.returnedSales, fact.returnedOrderCount, fact.sourceRow]);
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

async function listConfirmedSalesDays({ shopCode, startDate, endDate }) {
  const scope = requireShopeeShopScope(shopCode);
  datesInRange(startDate, endDate);
  const pool = require('../../../../db');
  const tables = getTables();
  const result = await pool.query(`
    SELECT DISTINCT ON (f.shop_code, f.report_date)
      f.shop_code, to_char(f.report_date, 'YYYY-MM-DD') AS report_date,
      f.sales_total, f.order_count, f.cancelled_sales, f.cancelled_order_count,
      f.returned_sales, f.returned_order_count, f.source_row,
      s.source_filename, s.source_sha256, s.observed_at, s.imported_at
    FROM ${tables.shopeeConfirmedDailyFacts} f JOIN ${tables.shopeeConfirmedSources} s USING (shop_code, source_sha256)
    WHERE ($1::text = 'all' OR f.shop_code = $1) AND f.report_date BETWEEN $2::date AND $3::date
    ORDER BY f.shop_code, f.report_date, s.observed_at DESC, s.source_sha256 DESC
  `, [scope, startDate, endDate]);
  const numberOrNull = value => value == null ? null : Number(value);
  return result.rows.map(row => ({ shopCode: row.shop_code, date: row.report_date,
    salesTotal: Number(row.sales_total), orderCount: Number(row.order_count),
    cancelledSales: numberOrNull(row.cancelled_sales), cancelledOrderCount: numberOrNull(row.cancelled_order_count),
    returnedSales: numberOrNull(row.returned_sales), returnedOrderCount: numberOrNull(row.returned_order_count),
    sourceRow: row.source_row, sourceFilename: row.source_filename, sourceSha256: row.source_sha256,
    observedAt: new Date(row.observed_at).toISOString(), importedAt: new Date(row.imported_at).toISOString() }));
}
module.exports = { importConfirmedSalesSources, listConfirmedSalesDays };
