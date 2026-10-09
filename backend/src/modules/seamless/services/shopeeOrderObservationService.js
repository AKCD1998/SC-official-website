const crypto = require('node:crypto');
const pool = require('../../../../db');
const { badRequest, conflict } = require('../errors');
const { getTables } = require('../tables');
const { SHOPEE_SHOP_PROFILES } = require('./shopeeShops');

// Each status must be accompanied by the specific rendered UI signal that proves it.
const PROOFS = Object.freeze({
  payment: { unpaid: ['unpaid_list'], cod_pending: ['cod_method'], paid: ['buyer_paid_marker'] },
  fulfillment: { to_ship: ['order_status'], shipping: ['order_status'], delivered: ['order_status'], completed: ['order_status'], cancelled: ['order_status'] },
  refund: { requested: ['return_request'], refunded: ['refund_completed'], cancel_requested: ['cancel_request'], closed: ['request_closed'] },
  settlement: { pending: ['income_pending'], released: ['income_released'] },
});
function fields(object, required, optional = []) {
  return object && typeof object === 'object' && !Array.isArray(object)
    && required.every(key => Object.hasOwn(object, key))
    && Object.keys(object).every(key => [...required, ...optional].includes(key));
}
function validateBatch(body, now = new Date()) {
  if (!fields(body, ['batchId','shopCode','portalAccount','observedAt','coverage','orders'])
      || !SHOPEE_SHOP_PROFILES[body.shopCode]
      || body.portalAccount !== SHOPEE_SHOP_PROFILES[body.shopCode].statisticsUsername
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(body.batchId)
      || typeof body.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T.+Z$/.test(body.observedAt)
      || !Number.isFinite(Date.parse(body.observedAt)) || Date.parse(body.observedAt) > now.getTime() + 300000
      || !fields(body.coverage, ['area','pages','complete'])
      || !['orders','unpaid','shipping','returns','finance'].includes(body.coverage.area)
      || !Number.isInteger(body.coverage.pages) || body.coverage.pages < 1 || body.coverage.pages > 100
      || typeof body.coverage.complete !== 'boolean'
      || !Array.isArray(body.orders) || body.orders.length > 500) throw badRequest('Invalid bounded Seller Centre observation batch.');
  const seen = new Set();
  for (const order of body.orders) {
    if (!fields(order, ['orderNumber','internalOrderId','axes'])
        || typeof order.orderNumber !== 'string' || !/^[A-Z0-9]{8,40}$/.test(order.orderNumber)
        || seen.has(order.orderNumber)
        || !(order.internalOrderId === null || (typeof order.internalOrderId === 'string' && /^\d{8,24}$/.test(order.internalOrderId)))
        || !fields(order.axes, [], Object.keys(PROOFS)) || !Object.keys(order.axes).length) throw badRequest('Invalid or duplicate order observation.');
    seen.add(order.orderNumber);
    if (order.internalOrderId === null && Object.keys(order.axes).some(axis => axis !== 'refund')) throw badRequest('Only return observations may omit the internal order ID.');
    for (const [axis, proof] of Object.entries(order.axes)) {
      if (!fields(proof, ['value','evidence','page'])
          || !PROOFS[axis]?.[proof.value]?.includes(proof.evidence)
          || !['orders','order_detail','income_detail','returns'].includes(proof.page)
          || (axis === 'payment' && proof.value === 'paid' && !['order_detail','income_detail'].includes(proof.page))
          || (axis === 'settlement' && proof.page !== 'income_detail')
          || (axis === 'refund' && proof.page !== 'returns')) throw badRequest('Status is not supported by its rendered evidence.');
    }
  }
  return { ...body, observedAt: new Date(body.observedAt).toISOString() };
}
function mergeSnapshot(previous = {}, order, observedAt) {
  const next = structuredClone(previous);
  for (const [axis, proof] of Object.entries(order.axes)) {
    if (axis === 'payment' && proof.value === 'cod_pending' && next.paidEvidence) continue;
    if (!next[axis] || observedAt >= next[axis].observedAt) next[axis] = { ...proof, observedAt };
    // A cancellation/refund or later ambiguous page cannot erase the fact that payment occurred.
    if (axis === 'payment' && proof.value === 'paid'
        && (!next.paidEvidence || observedAt < next.paidEvidence.observedAt)) next.paidEvidence = { ...proof, observedAt };
  }
  return next;
}
async function recordOrderObservations({ body, dbPool = pool, now = new Date() }) {
  const batch = validateBatch(body, now);
  const hash = crypto.createHash('sha256').update(JSON.stringify(batch)).digest('hex');
  const tables = getTables();
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`shopee-live:${batch.shopCode}`]);
    const prior = await client.query(`SELECT payload_sha256 FROM ${tables.shopeeOrderObservationBatches} WHERE batch_id = $1`, [batch.batchId]);
    if (prior.rows.length) {
      if (prior.rows[0].payload_sha256 !== hash) throw conflict('Observation batchId already has different evidence.');
      await client.query('COMMIT');
      return { status: 'already_recorded', batchId: batch.batchId, count: batch.orders.length };
    }
    await client.query(`INSERT INTO ${tables.shopeeOrderObservationBatches} (batch_id,shop_code,observed_at,payload_sha256,coverage) VALUES ($1,$2,$3,$4,$5::jsonb)`, [batch.batchId,batch.shopCode,batch.observedAt,hash,JSON.stringify(batch.coverage)]);
    for (const order of batch.orders) {
      const current = await client.query(`SELECT internal_order_id,snapshot FROM ${tables.shopeeLiveOrders} WHERE shop_code=$1 AND order_number=$2`, [batch.shopCode,order.orderNumber]);
      if (current.rows[0]?.internal_order_id && order.internalOrderId && current.rows[0].internal_order_id !== order.internalOrderId) throw conflict('Order identity changed within this shop.');
      const snapshot = mergeSnapshot(current.rows[0]?.snapshot, order, batch.observedAt);
      const changed = Object.entries(order.axes).some(([axis, proof]) =>
        ['value','evidence','page'].some(key => current.rows[0]?.snapshot?.[axis]?.[key] !== proof[key]));
      await client.query(`INSERT INTO ${tables.shopeeLiveOrders} (shop_code,order_number,internal_order_id,snapshot,first_observed_at,last_observed_at)
        VALUES ($1,$2,$3,$4::jsonb,$5,$5) ON CONFLICT (shop_code,order_number) DO UPDATE SET snapshot=EXCLUDED.snapshot,
        internal_order_id=COALESCE(EXCLUDED.internal_order_id,${tables.shopeeLiveOrders}.internal_order_id),
        first_observed_at=LEAST(${tables.shopeeLiveOrders}.first_observed_at,EXCLUDED.first_observed_at),
        last_observed_at=GREATEST(${tables.shopeeLiveOrders}.last_observed_at,EXCLUDED.last_observed_at)`, [batch.shopCode,order.orderNumber,order.internalOrderId,JSON.stringify(snapshot),batch.observedAt]);
      if (changed) await client.query(`INSERT INTO ${tables.shopeeOrderObservationEvents} (batch_id,shop_code,order_number,observation) VALUES ($1,$2,$3,$4::jsonb)`, [batch.batchId,batch.shopCode,order.orderNumber,JSON.stringify(order)]);
    }
    await client.query('COMMIT');
    return { status: 'recorded', batchId: batch.batchId, count: batch.orders.length };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
// Same row shape as the email table, including live-only orders without inventing email events.
function liveOrderRelation(tables) {
  return `(SELECT combined.*, official.proof AS official_payment FROM
    (SELECT o.*, l.snapshot || jsonb_build_object('internalOrderId',l.internal_order_id) AS live_status FROM ${tables.shopeeOrders} o LEFT JOIN ${tables.shopeeLiveOrders} l USING (shop_code,order_number)
    UNION ALL SELECT (jsonb_populate_record(NULL::${tables.shopeeOrders}, jsonb_build_object(
      'shop_code',l.shop_code,'order_number',l.order_number,'current_status','seller_center',
      'items','[]'::jsonb,'item_count',0,'total_quantity',0,'first_event_at',l.first_observed_at,'last_event_at',l.first_observed_at))).*, l.snapshot || jsonb_build_object('internalOrderId',l.internal_order_id) AS live_status
    FROM ${tables.shopeeLiveOrders} l WHERE NOT EXISTS (SELECT 1 FROM ${tables.shopeeOrders} o WHERE o.shop_code=l.shop_code AND o.order_number=l.order_number)
    UNION ALL SELECT (jsonb_populate_record(NULL::${tables.shopeeOrders}, jsonb_build_object(
      'shop_code',f.shop_code,'order_number',f.order_number,'current_status','official_report',
      'items',f.items,'item_count',jsonb_array_length(f.items),'item_subtotal',f.item_subtotal,'ordered_at',f.ordered_at,
      'total_quantity',COALESCE((SELECT SUM((item->>'quantity')::numeric) FROM jsonb_array_elements(f.items) item),0),
      'first_event_at',COALESCE(f.ordered_at,f.observed_at),'last_event_at',COALESCE(f.ordered_at,f.observed_at)))).*, NULL::jsonb AS live_status
      FROM (SELECT DISTINCT ON (f.shop_code,f.order_number) f.*,s.observed_at
        FROM ${tables.shopeeSalesOrderFacts} f JOIN ${tables.shopeeSalesSources} s USING (shop_code,source_sha256)
        ORDER BY f.shop_code,f.order_number,s.observed_at DESC,f.source_sha256 ASC) f
      WHERE NOT EXISTS (SELECT 1 FROM ${tables.shopeeOrders} o WHERE o.shop_code=f.shop_code AND o.order_number=f.order_number)
      AND NOT EXISTS (SELECT 1 FROM ${tables.shopeeLiveOrders} l WHERE l.shop_code=f.shop_code AND l.order_number=f.order_number)) combined
    LEFT JOIN LATERAL (SELECT jsonb_build_object('paidAt',f.paid_at,'observedAt',s.observed_at,
      'sourceFilename',s.source_filename,'sourceSha256',s.source_sha256) AS proof
      FROM ${tables.shopeeSalesOrderFacts} f JOIN ${tables.shopeeSalesSources} s USING (shop_code,source_sha256)
      WHERE f.shop_code=combined.shop_code AND f.order_number=combined.order_number AND f.paid_at IS NOT NULL
      ORDER BY s.observed_at DESC LIMIT 1) official ON TRUE)`;
}
module.exports = { validateBatch, mergeSnapshot, recordOrderObservations, liveOrderRelation, PROOFS };
