const { isDeepStrictEqual } = require('node:util');
const { randomUUID } = require('node:crypto');
const { validateCatalog, orderSnapshot, projectPosition, fail } = require('./shopee004StockPolicy');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER = /^[A-Z0-9]{8,40}$/;
const KINDS = new Set(['cancel-before-dispatch','dispatched','returned-sellable','legacy-in-baseline']);
function createShopee004StockLedger({ pool, schema, enabled = false, matchItem }) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) fail('LEDGER_SCHEMA_INVALID');
  const table = name => `"${schema}".shopee004_stock_${name}`;
  const orders = `"${schema}".shopee_orders`, events = `"${schema}".shopee_order_events`;
  function requireEnabled() { if (!enabled) fail('SHOPEE004_LEDGER_DISABLED'); }
  async function transaction(fn, readonly = false) {
    const c = await pool.connect(); let broken;
    try {
      await c.query(readonly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
      await c.query("SET LOCAL statement_timeout='10s'");
      await c.query("SET LOCAL lock_timeout='5s'");
      const result = await fn(c); await c.query('COMMIT'); return result;
    } catch (error) {
      try { await c.query('ROLLBACK'); } catch { broken = true; }
      // Never forward PG details (which can contain order numbers or parameters).
      if (error?.statusCode === 409) throw error;
      fail(['57014','55P03'].includes(error?.code) ? 'LEDGER_BUSY_OR_TIMEOUT' : 'LEDGER_OPERATION_FAILED');
    } finally { c.release(broken ? new Error('TRANSACTION_NOT_CLOSED') : undefined); }
  }
  async function readOrders(c) {
    const r = await c.query(`SELECT order_number,current_status,ordered_at,items,last_event_at FROM ${orders}
      WHERE shop_code='sc-drug-store' ORDER BY order_number LIMIT 20001`);
    if (r.rows.length > 20000) fail('OPENING_SCOPE_LIMIT');
    return r.rows;
  }
  const pending = rows => rows.filter(o => ['order_confirmed','shipment_due'].includes(o.current_status));
  const plannedOpening = (rows, selected) => pending(rows).filter(o => selected.includes(o.order_number))
    .map(o => ({ orderNumber: o.order_number, snapshot: orderSnapshot(o) }));
  async function audit(c, action, outcome, actor = null, order = null) {
    await c.query(`INSERT INTO ${table('audit')}(action,outcome,actor,order_number) VALUES($1,$2,$3,$4)`,
      [action, JSON.stringify(outcome), actor, order]);
  }
  async function prepare({ posCatalog, openingOrderNumbers, actor }) {
    requireEnabled(); validateCatalog(posCatalog);
    if (!actor) fail('HUMAN_ADMIN_REQUIRED');
    if (!Array.isArray(openingOrderNumbers) || openingOrderNumbers.length > 2000
      || openingOrderNumbers.some(o => !ORDER.test(o)) || new Set(openingOrderNumbers).size !== openingOrderNumbers.length) fail('EXPLICIT_OPENING_SET_REQUIRED');
    return transaction(async c => {
      // Transaction advisory lock covers the initially absent singleton too.
      await c.query("SELECT pg_advisory_xact_lock(hashtext('shopee004-stock-opening'))");
      const existing = await c.query(`SELECT mode FROM ${table('control')} WHERE singleton=1 FOR UPDATE`);
      if (existing.rows[0] && existing.rows[0].mode !== 'planned') fail('CUTOVER_ALREADY_EXISTS');
      const rows = await readOrders(c);
      const opening = plannedOpening(rows, openingOrderNumbers);
      if (opening.length !== openingOrderNumbers.length) fail('OPENING_ORDER_NOT_PENDING');
      // All mappings must pass BEFORE an operator can approve an opening set.
      for (const o of pending(rows).filter(o => openingOrderNumbers.includes(o.order_number))) {
        const { mapShopeeStockLines } = require('./shopeeStockReservationShadow');
        if (mapShopeeStockLines({ items: o.items, posCatalog: validateCatalog(posCatalog), matchItem }).status !== 'mapped') {
          fail('OPENING_MAPPING_REVIEW_REQUIRED');
        }
      }
      const plan = { planId: randomUUID(), opening, legacyOrders: rows.filter(o => !opening.some(p => p.orderNumber === o.order_number)).map(o => o.order_number) };
      await c.query(`INSERT INTO ${table('control')}(singleton,mode,plan,pos_catalog,actor) VALUES(1,'planned',$1,$2,$3)
        ON CONFLICT(singleton) DO UPDATE SET plan=EXCLUDED.plan,pos_catalog=EXCLUDED.pos_catalog,actor=EXCLUDED.actor,created_at=now()`,
      [JSON.stringify(plan), JSON.stringify([...validateCatalog(posCatalog).values()]), actor]);
      await audit(c, 'opening-plan-prepared', { pendingOrders: opening.length, legacyOrders: plan.legacyOrders.length }, actor);
      return { mode: 'planned', planId: plan.planId, pendingOrders: opening.length, legacyOrders: plan.legacyOrders.length,
        requiresPhysicalPendingReview: true, historicalShippedReconciliationRequired: true, activated: false };
    });
  }
  async function activate({ planId, actor, openingOrdersVerified, olderShippedReconciledInPosBasis, emailFeedChecked, unpostedPosWorkflow }) {
    requireEnabled();
    if (!actor || ![openingOrdersVerified,olderShippedReconciledInPosBasis,emailFeedChecked,unpostedPosWorkflow].every(v => v === true)) fail('OPENING_ATTESTATIONS_REQUIRED');
    return transaction(async c => {
      const r = await c.query(`SELECT * FROM ${table('control')} WHERE singleton=1 FOR UPDATE`);
      const control = r.rows[0];
      if (!control) fail('OPENING_PLAN_REQUIRED');
      if (control.plan.planId !== planId) fail('OPENING_PLAN_APPROVAL_MISMATCH');
      if (control.mode === 'live') return { mode: 'live', cutoverAt: control.cutover_at.toISOString(), alreadyActivated: true };
      if (control.mode !== 'planned') fail('CUTOVER_CANNOT_BE_RESTARTED');
      const rows = await readOrders(c);
      if (!isDeepStrictEqual(control.plan.opening, plannedOpening(rows, control.plan.opening.map(o => o.orderNumber)))
        || rows.some(o => !control.plan.opening.some(p => p.orderNumber === o.order_number) && !control.plan.legacyOrders.includes(o.order_number))) fail('OPENING_PLAN_CHANGED');
      // DB-clock cutover belongs to this activation transaction, not mail arrival.
      const stamp = await c.query(`UPDATE ${table('control')} SET mode='live',cutover_at=clock_timestamp(),activated_at=clock_timestamp(),actor=$1
        WHERE singleton=1 RETURNING cutover_at`, [actor]);
      const queued = await c.query(`INSERT INTO ${table('dirty')}(order_number) SELECT order_number FROM ${orders}
        WHERE shop_code='sc-drug-store' AND (order_number=ANY($1::text[]) OR ordered_at >= $2)
        ON CONFLICT(order_number) DO UPDATE SET revision=${table('dirty')}.revision+1`,
      [control.plan.opening.map(o => o.orderNumber), stamp.rows[0].cutover_at]);
      await audit(c, 'activated', { openingOrders: control.plan.opening.length, workflow: 'shopee-not-posted-in-pos' }, actor);
      return { mode: 'live', cutoverAt: stamp.rows[0].cutover_at.toISOString(), queuedOrders: queued.rowCount, activated: true };
    });
  }
  async function pause({ actor }) {
    requireEnabled(); if (!actor) fail('HUMAN_ADMIN_REQUIRED');
    return transaction(async c => {
      const r = await c.query(`UPDATE ${table('control')} SET mode='paused' WHERE singleton=1 AND cutover_at IS NOT NULL RETURNING mode`);
      if (!r.rows.length) fail('ACTIVE_CUTOVER_REQUIRED');
      await audit(c, 'paused', { holdsRetained: true, availabilityBlocked: true }, actor);
      return { mode: 'paused', holdsRetained: true, availabilityBlocked: true };
    });
  }
  async function resume({ actor, unpostedPosWorkflow, openingBasisStillValid }) {
    requireEnabled();
    if (!actor || unpostedPosWorkflow !== true || openingBasisStillValid !== true) fail('WORKFLOW_RECONFIRMATION_REQUIRED');
    return transaction(async c => {
      const r = await c.query(`UPDATE ${table('control')} SET mode='live' WHERE singleton=1 AND mode='paused' RETURNING cutover_at`);
      if (!r.rows.length) fail('PAUSED_CUTOVER_REQUIRED');
      await audit(c,'resumed-existing-cutover',{ holdsRetained: true },actor);
      return { mode: 'live', cutoverAt: r.rows[0].cutover_at.toISOString(), existingHoldsRetained: true };
    });
  }
  async function review({ operationId, orderNumber, kind, quantities = [], actor, physicalEvidenceVerified, notPostedInPos }) {
    requireEnabled();
    if (!actor || physicalEvidenceVerified !== true || notPostedInPos !== true) fail('PHYSICAL_EVIDENCE_ATTESTATION_REQUIRED');
    if (!UUID.test(operationId || '') || !ORDER.test(orderNumber || '') || !KINDS.has(kind)
      || !Array.isArray(quantities) || quantities.length > 1000 || quantities.some(q => !q || typeof q.productCode !== 'string'
        || !q.productCode.length || q.productCode.length > 100 || !Number.isSafeInteger(q.quantity) || q.quantity <= 0)
      || new Set(quantities.map(q => q.productCode)).size !== quantities.length
      || (kind === 'returned-sellable' ? !quantities.length : quantities.length)) fail('REVIEW_CONTRACT_INVALID');
    return transaction(async c => {
      // Lock order then dirty, same ordering as ingestion; workers lock dirty but
      // do not lock orders. Shared control lock fences pause/activation.
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [operationId]);
      const control = await c.query(`SELECT * FROM ${table('control')} WHERE singleton=1 FOR SHARE`);
      if (!['live','paused'].includes(control.rows[0]?.mode)) fail('ACTIVE_CUTOVER_REQUIRED');
      const exists = await c.query(`SELECT * FROM ${orders} WHERE shop_code='sc-drug-store' AND order_number=$1`, [orderNumber]);
      if (!exists.rows.length) fail('ORDER_NOT_FOUND');
      const old = await c.query(`SELECT order_number,kind,quantities FROM ${table('reviews')} WHERE operation_id=$1`, [operationId]);
      if (old.rows.length) {
        if (!isDeepStrictEqual(old.rows[0], { order_number: orderNumber, kind, quantities })) fail('REVIEW_IDEMPOTENCY_CONFLICT');
        return { recorded: true, duplicate: true };
      }
      await c.query(`INSERT INTO ${table('dirty')}(order_number) VALUES($1)
        ON CONFLICT(order_number) DO UPDATE SET revision=${table('dirty')}.revision+1`, [orderNumber]);
      const history = await c.query(`SELECT event_type,occurred_at FROM ${events} WHERE shop_code='sc-drug-store' AND order_number=$1 ORDER BY occurred_at,id`, [orderNumber]);
      const decisions = await c.query(`SELECT * FROM ${table('reviews')} WHERE order_number=$1 ORDER BY recorded_at,operation_id`, [orderNumber]);
      const previous = await c.query(`SELECT * FROM ${table('positions')} WHERE order_number=$1`, [orderNumber]);
      const stamp = await c.query('SELECT clock_timestamp() AS at');
      const candidate = projectPosition({ order: exists.rows[0], events: history.rows,
        reviews: [...decisions.rows, { kind, quantities, recorded_at: stamp.rows[0].at }], control: control.rows[0],
        previous: previous.rows[0], now: stamp.rows[0].at, matchItem });
      if (candidate.state === 'review_required') fail('REVIEW_WOULD_LEAVE_UNVERIFIED_POSITION');
      await c.query(`INSERT INTO ${table('reviews')}(operation_id,order_number,kind,quantities,actor) VALUES($1,$2,$3,$4,$5)`,
        [operationId, orderNumber, kind, JSON.stringify(quantities), actor]);
      await audit(c, 'physical-review', { kind }, actor, orderNumber);
      return { recorded: true, duplicate: false };
    });
  }
  async function processOne() {
    requireEnabled();
    return transaction(async c => {
      const ctrl = await c.query(`SELECT * FROM ${table('control')} WHERE singleton=1`);
      const control = ctrl.rows[0];
      if (!['live','paused'].includes(control?.mode)) return false;
      const work = await c.query(`SELECT * FROM ${table('dirty')} ORDER BY queued_at,order_number FOR UPDATE SKIP LOCKED LIMIT 1`);
      if (!work.rows.length) return false;
      const orderNumber = work.rows[0].order_number;
      const source = await c.query(`SELECT * FROM ${orders} WHERE shop_code='sc-drug-store' AND order_number=$1`, [orderNumber]);
      if (!source.rows.length) fail('QUEUED_ORDER_MISSING');
      const history = await c.query(`SELECT event_type,occurred_at FROM ${events} WHERE shop_code='sc-drug-store' AND order_number=$1 ORDER BY occurred_at,id`, [orderNumber]);
      const decisions = await c.query(`SELECT * FROM ${table('reviews')} WHERE order_number=$1 ORDER BY recorded_at,operation_id`, [orderNumber]);
      const old = await c.query(`SELECT * FROM ${table('positions')} WHERE order_number=$1`, [orderNumber]);
      const stamp = await c.query('SELECT clock_timestamp() AS at');
      const position = projectPosition({ order: source.rows[0], events: history.rows, reviews: decisions.rows,
        control, previous: old.rows[0], now: stamp.rows[0].at, matchItem });
      // Retain the original item contract on a conflicting edit. Reprocessing
      // must not turn a second identical retry into an implicit approval.
      const snapshot = position.reasons.includes('order-items-changed-needs-review')
        ? old.rows[0].source_snapshot : position.snapshot;
      await c.query(`INSERT INTO ${table('positions')}(order_number,eligibility,state,reasons,source_snapshot,warnings) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(order_number) DO UPDATE SET eligibility=EXCLUDED.eligibility,state=EXCLUDED.state,reasons=EXCLUDED.reasons,
          source_snapshot=EXCLUDED.source_snapshot,warnings=EXCLUDED.warnings,updated_at=now()`,
        [orderNumber, position.eligibility, position.state, JSON.stringify(position.reasons), JSON.stringify(snapshot),JSON.stringify(position.warnings)]);
      if (position.state !== 'review_required') {
        await c.query(`DELETE FROM ${table('lines')} WHERE order_number=$1`, [orderNumber]);
        for (const l of position.lines) await c.query(`INSERT INTO ${table('lines')}(order_number,product_code,unit,ordered_quantity,reserved_quantity,shipped_unposted_quantity)
          VALUES($1,$2,$3,$4,$5,$6)`, [orderNumber, l.productCode, l.unit, l.orderedQuantity, l.reservedQuantity, l.shippedUnpostedQuantity]);
      }
      await audit(c, 'position-projected', { state: position.state, reasons: position.reasons, warnings: position.warnings }, null, orderNumber);
      await c.query(`DELETE FROM ${table('dirty')} WHERE order_number=$1`, [orderNumber]);
      return true;
    });
  }
  async function projection(productCodes) {
    requireEnabled();
    if (!Array.isArray(productCodes) || productCodes.length > 10000
      || productCodes.some(s => typeof s !== 'string' || !s.length || s.length > 100)
      || new Set(productCodes).size !== productCodes.length) fail('PROJECTION_SCOPE_INVALID');
    return transaction(async c => {
      const ctrl = await c.query(`SELECT mode,cutover_at FROM ${table('control')} WHERE singleton=1`);
      const pending = await c.query(`SELECT count(*)::int AS count FROM ${table('dirty')}`);
      const review = await c.query(`SELECT count(*) FILTER (WHERE state='review_required')::int AS count,
        count(*) FILTER (WHERE jsonb_array_length(warnings)>0)::int AS warning_count FROM ${table('positions')}`);
      const stamp = await c.query(`SELECT transaction_timestamp() AS at,COALESCE((SELECT max(revision) FROM ${table('audit')}),0)::text AS revision`);
      const feed = await c.query(`SELECT max(created_at) AS last_ingested_at FROM ${events} WHERE shop_code='sc-drug-store'`);
      const ready = ctrl.rows[0]?.mode === 'live' && !pending.rows[0].count && !review.rows[0].count;
      const rows = await c.query(`SELECT product_code,min(unit) AS unit,count(DISTINCT unit)::int AS units,
        sum(reserved_quantity)::text AS reserved,sum(shipped_unposted_quantity)::text AS shipped
        FROM ${table('lines')} WHERE product_code=ANY($1::text[]) GROUP BY product_code`, [productCodes]);
      const byCode = new Map(rows.rows.map(r => [r.product_code, r]));
      return { schemaVersion: 'shopee004-commitments-v1', branchCode: '004', mode: ctrl.rows[0]?.mode || 'unconfigured',
        status: ready ? 'available' : 'review-or-processing-required', cutoverAt: ctrl.rows[0]?.cutover_at?.toISOString() || null,
        asOf: stamp.rows[0].at.toISOString(), revision: stamp.rows[0].revision,
        lastEmailIngestedAt: feed.rows[0].last_ingested_at?.toISOString() || null,
        pendingOrders: pending.rows[0].count, reviewOrders: review.rows[0].count,
        sourceLabelReviewOrders: review.rows[0].warning_count,
        posPostingPolicy: 'not-recorded-in-pos', emailCoverage: 'email-orders-only',
        records: productCodes.map(productCode => {
          const row = byCode.get(productCode);
          const reserved = Number(row?.reserved || 0), shipped = Number(row?.shipped || 0);
          if (row?.units > 1 || !Number.isSafeInteger(reserved + shipped)) fail('PROJECTION_UNIT_OR_QUANTITY_CONFLICT');
          return { productCode, unit: row?.unit || null, reservedQuantity: reserved, shippedUnpostedQuantity: shipped };
        }) };
    }, true);
  }
  async function reviewQueue({ limit = 100, cursor = '' } = {}) {
    requireEnabled();
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor && !ORDER.test(cursor))) fail('REVIEW_PAGE_INVALID');
    return transaction(async c => {
      const result = await c.query(`SELECT order_number,eligibility,reasons,warnings FROM ${table('positions')}
        WHERE state='review_required' AND order_number>$1 ORDER BY order_number LIMIT $2`, [cursor,limit+1]);
      const page = result.rows.slice(0,limit);
      return { records: page.map(r => ({ orderNumber:r.order_number,eligibility:r.eligibility,reasons:r.reasons,warnings:r.warnings })),
        hasMore:result.rows.length>limit,nextCursor:result.rows.length>limit?page.at(-1).order_number:null };
    },true);
  }
  return { prepare, activate, pause, resume, review, reviewQueue, processOne, projection };
}
module.exports = { createShopee004StockLedger };
