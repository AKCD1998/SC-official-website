const { projectShopeeStockShadow, summarizeStockShadow } = require('./shopeeStockReservationShadow');

// Caller supplies an existing authorized pool. No dotenv, default pool or credentials discovery.
// Current order items have no per-event historical version: this is a current snapshot audit,
// not an as-of reconstruction. Reject historical cutoffs rather than back-date present items.
async function readShopeeStockShadow({ pool, schema, posCatalog, from, now = () => new Date(),
  limit = 10000, project = projectShopeeStockShadow } = {}) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema || '') || !/^\d{4}-\d{2}-\d{2}$/.test(from || '')
    || !Number.isInteger(limit) || limit < 1 || limit > 20000) {
    throw Object.assign(new Error('SHADOW_READER_SCOPE_INVALID'), { code: 'SHADOW_READER_SCOPE_INVALID' });
  }
  let client, failure, stage = 'connect';
  try {
    client = await pool.connect(); stage = 'snapshot';
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '10s'");
    const stamp = await client.query('SELECT transaction_timestamp() AS captured_at');
    const asOf = new Date(stamp.rows[0].captured_at).toISOString();
    if (Math.abs(Date.parse(asOf) - now().getTime()) > 300000) {
      throw Object.assign(new Error('SHADOW_CLOCK_UNCERTAIN'), { code: 'SHADOW_CLOCK_UNCERTAIN' });
    }
    stage = 'orders';
    const orders = await client.query(`SELECT order_number,current_status,items,last_event_at
      FROM "${schema}".shopee_orders WHERE shop_code=$1 AND last_event_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Bangkok')
      AND last_event_at <= $3::timestamptz ORDER BY order_number LIMIT $4`,
    ['sc-drug-store', from, asOf, limit + 1]);
    if (orders.rows.length > limit) throw Object.assign(new Error('SHADOW_ORDER_LIMIT'), { code: 'SHADOW_ORDER_LIMIT' });
    const identities = orders.rows.map(o => o.order_number);
    stage = 'events';
    const events = await client.query(`SELECT canonical_message_key,order_number,event_type,occurred_at
      FROM "${schema}".shopee_order_events WHERE shop_code=$1 AND order_number=ANY($2::text[])
      AND occurred_at <= $3::timestamptz ORDER BY occurred_at LIMIT 100001`, ['sc-drug-store', identities, asOf]);
    if (events.rows.length > 100000) throw Object.assign(new Error('SHADOW_EVENT_LIMIT'), { code: 'SHADOW_EVENT_LIMIT' });
    stage = 'project';
    const result = project({ asOf, posCatalog,
      orders: orders.rows.map(o => ({ shopCode: 'sc-drug-store', branchCode: '004', orderKey: o.order_number, items: o.items })),
      events: events.rows.map(e => ({ shopCode: 'sc-drug-store', branchCode: '004', orderKey: e.order_number,
        eventKey: e.canonical_message_key, type: e.event_type, occurredAt: new Date(e.occurred_at).toISOString() })),
      // Email ingestion alone proves neither complete dispatch history nor inclusion in POS stock.
      coverage: { emailComplete: false, lifecycleComplete: false, posLinksComplete: false } });
    return { ...summarizeStockShadow(result), evidenceBasis: 'current-email-order-snapshot',
      sellerCentreOnlyAndReportOnlyOrdersIncluded: false,
      posIssueLinksInferredFromDryRunJobs: false, historicalReconstructionSupported: false };
  } catch (error) {
    const ownCodes = new Set(['SHADOW_CLOCK_UNCERTAIN', 'SHADOW_ORDER_LIMIT', 'SHADOW_EVENT_LIMIT']);
    const code = ownCodes.has(error?.code) ? error.code
      : ['42501', '28000', '28P01'].includes(error?.code) ? 'SHADOW_READ_ACCESS_DENIED'
        : ['57014', 'ETIMEDOUT'].includes(error?.code) ? 'SHADOW_READ_TIMEOUT' : 'SHADOW_READ_FAILED';
    failure = Object.assign(new Error(code), { code, stage, detailsWithheld: true });
    throw failure;
  } finally {
    if (client) {
      let rollbackFailure;
      try { await client.query('ROLLBACK'); }
      catch { rollbackFailure = Object.assign(new Error('SHADOW_ROLLBACK_FAILED'), {
        code: 'SHADOW_ROLLBACK_FAILED', stage: 'rollback', detailsWithheld: true }); }
      // Destroy a connection whose transaction could not be ended; never return it for reuse.
      client.release(rollbackFailure);
      if (rollbackFailure && !failure) throw rollbackFailure;
    }
  }
}

module.exports = { readShopeeStockShadow };
