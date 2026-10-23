const { isDeepStrictEqual } = require('node:util');
const { randomUUID } = require('node:crypto');
const { validateCatalog, orderSnapshot, projectPosition, canCorrectPostCutoverReview, fail } = require('./shopee004StockPolicy');
const { buildOpeningBasis } = require('./shopee004OpeningBasis');
const { resolveReviewScope } = require('./shopee004ReviewScope');
const { nextRecovery, classifyRecoveryFailure, classifyReviewReason, MAPPING_REASONS } = require('./shopee004RecoveryPolicy');
const { publicException, selectExceptionItem, exceptionRevision, ruleAffectsOrder } = require('./shopee004ExceptionReadModel');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER = /^[A-Z0-9]{8,40}$/;
const KINDS = new Set(['cancel-before-dispatch','dispatched','returned-sellable','legacy-in-baseline']);
function createShopee004StockLedger({ pool, schema, enabled = false, matchItem, mappingContextProvider }) {
  let mappingReviewCursor = '';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) fail('LEDGER_SCHEMA_INVALID');
  const table = name => `"${schema}".shopee004_stock_${name}`;
  const orders = `"${schema}".shopee_orders`, events = `"${schema}".shopee_order_events`;
  const scopedMatcher = async (c, control) => mappingContextProvider ? await mappingContextProvider(c, control) : matchItem;
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
      const failure = classifyRecoveryFailure(error);
      fail(['57014','55P03'].includes(error?.code) ? 'LEDGER_BUSY_OR_TIMEOUT'
        : failure.retryable ? 'LEDGER_SERVICE_UNAVAILABLE' : 'LEDGER_OPERATION_FAILED');
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
  async function guardedPrevious(c,previous){
    if(!previous)return previous;
    const lines=await c.query(`SELECT product_code,unit,ordered_quantity,reserved_quantity,shipped_unposted_quantity
      FROM ${table('lines')} WHERE order_number=$1`,[previous.order_number]);
    return {...previous,noStockLines:!lines.rows.length,retainedLines:lines.rows};
  }
  async function prepare({ posCatalog, openingOrderNumbers, openingBasis, actor }) {
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
      const matchItem = await scopedMatcher(c,{mode:'planned',pos_catalog:posCatalog});
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
      const acceptedBasis = buildOpeningBasis({ input: openingBasis, rows, openingOrderNumbers,
        catalog: validateCatalog(posCatalog), actor, matchItem });
      if (acceptedBasis) plan.openingBasis = acceptedBasis;
      await c.query(`INSERT INTO ${table('control')}(singleton,mode,plan,pos_catalog,actor) VALUES(1,'planned',$1,$2,$3)
        ON CONFLICT(singleton) DO UPDATE SET plan=EXCLUDED.plan,pos_catalog=EXCLUDED.pos_catalog,actor=EXCLUDED.actor,created_at=now()`,
      [JSON.stringify(plan), JSON.stringify([...validateCatalog(posCatalog).values()]), actor]);
      await audit(c, 'opening-plan-prepared', { pendingOrders: opening.length, legacyOrders: plan.legacyOrders.length,
        ...(acceptedBasis ? { openingBasisQuality: acceptedBasis.quality, historicalOrdersCovered: acceptedBasis.coveredOrderCount,
          excludedPhysicalReviewOrders: acceptedBasis.excludedPhysicalReviewOrders, physicalStockVerified: false } : {}) }, actor);
      return { mode: 'planned', planId: plan.planId, pendingOrders: opening.length, legacyOrders: plan.legacyOrders.length,
        requiresPhysicalPendingReview: !acceptedBasis, historicalShippedReconciliationRequired: !acceptedBasis,
        ...(acceptedBasis ? { openingBasisQuality: acceptedBasis.quality, ownerEstimateApprovalRequired: true } : {}), activated: false };
    });
  }
  async function activate({ planId, actor, openingOrdersVerified, olderShippedReconciledInPosBasis, emailFeedChecked, unpostedPosWorkflow,
    ownerAcceptedOpeningEstimate = false }) {
    requireEnabled();
    const physicallyVerified = openingOrdersVerified === true && olderShippedReconciledInPosBasis === true;
    if (!actor || emailFeedChecked !== true || unpostedPosWorkflow !== true
      || (!physicallyVerified && ownerAcceptedOpeningEstimate !== true)) fail('OPENING_ATTESTATIONS_REQUIRED');
    return transaction(async c => {
      const r = await c.query(`SELECT * FROM ${table('control')} WHERE singleton=1 FOR UPDATE`);
      const control = r.rows[0];
      if (!control) fail('OPENING_PLAN_REQUIRED');
      if (control.plan.planId !== planId) fail('OPENING_PLAN_APPROVAL_MISMATCH');
      if (control.plan.openingBasis?.quality === 'owner-accepted-estimate'
        ? ownerAcceptedOpeningEstimate !== true : !physicallyVerified) fail('OPENING_BASIS_APPROVAL_REQUIRED');
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
      await audit(c, 'activated', { openingOrders: control.plan.opening.length, workflow: 'shopee-not-posted-in-pos',
        ...(control.plan.openingBasis ? { openingBasisQuality: control.plan.openingBasis.quality,
          physicalStockVerified: false, posStockAdjusted: false } : {}) }, actor);
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
  async function extendPosCatalog({posCatalog,actor}){
    requireEnabled();if(!actor)fail('HUMAN_ADMIN_REQUIRED');
    if(!Array.isArray(posCatalog)||!posCatalog.length||posCatalog.length>50)fail('CATALOG_EXTENSION_SCOPE_INVALID');
    const additions=validateCatalog(posCatalog);
    return transaction(async c=>{
      const control=(await c.query(`SELECT mode,cutover_at,pos_catalog FROM ${table('control')} WHERE singleton=1 FOR UPDATE`)).rows[0];
      if(!['live','paused'].includes(control?.mode))fail('ACTIVE_CUTOVER_REQUIRED');
      const current=validateCatalog(control.pos_catalog);let added=0;
      for(const [code,entry] of additions){
        if(current.has(code)){if(!isDeepStrictEqual(current.get(code),entry))fail('EXISTING_POS_CONTRACT_CHANGED');}
        else{current.set(code,entry);added++;}
      }
      validateCatalog([...current.values()]);
      if(added){await c.query(`UPDATE ${table('control')} SET pos_catalog=$1 WHERE singleton=1`,[JSON.stringify([...current.values()])]);
        await audit(c,'verified-pos-contracts-extended',{addedProducts:added,originalCutoverPreserved:true,existingContractsUnchanged:true},actor);}
      return {addedProducts:added,originalCutoverPreserved:true,existingContractsUnchanged:true,stockWrites:false};
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
      const matchItem = await scopedMatcher(c,control.rows[0]);
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
        previous: await guardedPrevious(c,previous.rows[0]), now: stamp.rows[0].at, matchItem });
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
      const work = await c.query(`SELECT * FROM ${table('dirty')}
        WHERE recovery_revision IS DISTINCT FROM revision OR recovery_state='ready'
          OR (recovery_state='retry_wait' AND retry_after<=clock_timestamp())
        ORDER BY queued_at,order_number FOR UPDATE SKIP LOCKED LIMIT 1`);
      if (!work.rows.length) return false;
      const selected = work.rows[0], orderNumber = selected.order_number;
      await c.query('SAVEPOINT stock_order_projection');
      try {
      const matchItem = await scopedMatcher(c,control);
      const source = await c.query(`SELECT * FROM ${orders} WHERE shop_code='sc-drug-store' AND order_number=$1`, [orderNumber]);
      if (!source.rows.length) fail('QUEUED_ORDER_MISSING');
      const history = await c.query(`SELECT event_type,occurred_at FROM ${events} WHERE shop_code='sc-drug-store' AND order_number=$1 ORDER BY occurred_at,id`, [orderNumber]);
      const decisions = await c.query(`SELECT * FROM ${table('reviews')} WHERE order_number=$1 ORDER BY recorded_at,operation_id`, [orderNumber]);
      const old = await c.query(`SELECT * FROM ${table('positions')} WHERE order_number=$1`, [orderNumber]);
      const stamp = await c.query('SELECT clock_timestamp() AS at');
      const position = projectPosition({ order: source.rows[0], events: history.rows, reviews: decisions.rows,
        control, previous: await guardedPrevious(c,old.rows[0]), now: stamp.rows[0].at, matchItem });
      // Retain the original item contract on a conflicting edit. Reprocessing
      // must not turn a second identical retry into an implicit approval.
      const snapshot = position.reasons.includes('order-items-changed-needs-review')
        ? old.rows[0].source_snapshot : position.snapshot;
      await c.query(`INSERT INTO ${table('positions')}(order_number,eligibility,state,reasons,source_snapshot,warnings,exception_id) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(order_number) DO UPDATE SET eligibility=EXCLUDED.eligibility,state=EXCLUDED.state,reasons=EXCLUDED.reasons,
          source_snapshot=EXCLUDED.source_snapshot,warnings=EXCLUDED.warnings,updated_at=now()`,
        [orderNumber, position.eligibility, position.state, JSON.stringify(position.reasons), JSON.stringify(snapshot),JSON.stringify(position.warnings),selected.exception_id]);
      if (position.state !== 'review_required') {
        await c.query(`DELETE FROM ${table('lines')} WHERE order_number=$1`, [orderNumber]);
        for (const l of position.lines) await c.query(`INSERT INTO ${table('lines')}(order_number,product_code,unit,ordered_quantity,reserved_quantity,shipped_unposted_quantity)
          VALUES($1,$2,$3,$4,$5,$6)`, [orderNumber, l.productCode, l.unit, l.orderedQuantity, l.reservedQuantity, l.shippedUnpostedQuantity]);
      }
      await audit(c, 'position-projected', { state: position.state, reasons: position.reasons, warnings: position.warnings }, null, orderNumber);
      await c.query(`DELETE FROM ${table('dirty')} WHERE order_number=$1`, [orderNumber]);
      return true;
      } catch (error) {
        // Roll back all position/line/audit effects for this order, then retain
        // the dirty row with a durable bounded retry or a semantic hold. Other
        // orders can progress; a restart never resets this attempt budget.
        await c.query('ROLLBACK TO SAVEPOINT stock_order_projection');
        const recovery = nextRecovery({ error, attemptCount: String(selected.recovery_revision) === String(selected.revision)
          ? selected.attempt_count : 0 });
        await c.query(`UPDATE ${table('dirty')} SET recovery_revision=revision,attempt_count=$3,
          recovery_state=$4,retry_after=COALESCE($5::timestamptz,clock_timestamp()),last_error_code=$6,first_failed_at=COALESCE(first_failed_at,clock_timestamp()),
          last_failed_at=clock_timestamp() WHERE order_number=$1 AND revision=$2`,
        [orderNumber, selected.revision, recovery.attemptCount, recovery.recoveryState,
          recovery.retryAfter, recovery.reasonCode]);
        await audit(c,'processing-exception-held',{reasonCode:recovery.reasonCode,issueClass:recovery.issueClass,
          attemptCount:recovery.attemptCount,retryScheduled:recovery.recoveryState==='retry_wait',
          retryBudgetExhausted:recovery.exhausted,holdsRetained:true},null,orderNumber);
        return true;
      }
    });
  }
  async function reconcileAcceptedLegacy({ actor, ownerAcceptedOpeningEstimate }) {
    requireEnabled();
    if (!actor || ownerAcceptedOpeningEstimate !== true) fail('OWNER_ESTIMATE_APPROVAL_REQUIRED');
    return transaction(async c => {
      const control = (await c.query(`SELECT * FROM ${table('control')} WHERE singleton=1 FOR SHARE`)).rows[0];
      if (!['live','paused'].includes(control?.mode)
        || control.plan.openingBasis?.quality !== 'owner-accepted-estimate') fail('ACCEPTED_ESTIMATE_CUTOVER_REQUIRED');
      // Requeue only old, unheld positions blocked by the former opening rule.
      // Never approve cancellations, returns, changed items, new orders or
      // missing dates; ordinary projection still validates each source row.
      const queued = await c.query(`INSERT INTO ${table('dirty')}(order_number)
        SELECT p.order_number FROM ${table('positions')} p JOIN ${orders} o
          ON o.order_number=p.order_number AND o.shop_code='sc-drug-store'
        WHERE p.eligibility='legacy' AND p.state='review_required'
          AND p.reasons='["legacy-arrival-needs-opening-review"]'::jsonb
          AND o.ordered_at < $1
          AND NOT EXISTS (SELECT 1 FROM ${table('lines')} l WHERE l.order_number=p.order_number
            AND (l.reserved_quantity<>0 OR l.shipped_unposted_quantity<>0))
        ORDER BY p.order_number LIMIT 500
        ON CONFLICT(order_number) DO NOTHING`, [control.cutover_at]);
      await audit(c, 'accepted-estimate-legacy-requeued', { queuedOrders: queued.rowCount,
        originalCutoverPreserved: true, physicalStockVerified: false, posStockAdjusted: false }, actor);
      return { queuedOrders: queued.rowCount, originalCutoverPreserved: true,
        physicalStockVerified: false, posStockAdjusted: false };
    });
  }
  async function requeueResolvedMappings() {
    requireEnabled();
    const result = await transaction(async c => {
      const control = (await c.query(`SELECT mode,pos_catalog,cutover_at,plan FROM ${table('control')} WHERE singleton=1 FOR SHARE`)).rows[0];
      if (!['live','paused'].includes(control?.mode)) return { queuedOrders: 0,nextCursor:'' };
      const matchItem = await scopedMatcher(c,control);
      const candidates = await c.query(`SELECT p.order_number,p.eligibility,p.state,p.reasons,p.source_snapshot,o.items,o.ordered_at FROM ${table('positions')} p JOIN ${orders} o
        ON o.order_number=p.order_number AND o.shop_code='sc-drug-store'
        WHERE p.state='review_required' AND ((p.reasons ?| $3::text[]
            AND NOT(p.reasons ? 'order-items-changed-needs-review') AND NOT(p.reasons ? 'mapping-held-contract-changed-needs-review'))
          OR (p.eligibility='legacy' AND p.reasons='["legacy-arrival-needs-opening-review"]'::jsonb AND o.ordered_at >= $2
            AND NOT EXISTS(SELECT 1 FROM ${table('lines')} l WHERE l.order_number=p.order_number)))
          AND p.order_number>$1 ORDER BY p.order_number LIMIT 50`, [mappingReviewCursor,control.cutover_at,MAPPING_REASONS]);
      const nextCursor=candidates.rows.length===50 ? candidates.rows.at(-1).order_number : '';
      if (!candidates.rows.length) return { queuedOrders: 0,nextCursor };
      const { mapShopeeStockLines } = require('./shopeeStockReservationShadow');
      const catalog = validateCatalog(control.pos_catalog);
      const resolved = candidates.rows.filter(o => (o.reasons[0]!=='legacy-arrival-needs-opening-review'
          ||canCorrectPostCutoverReview({order:o,previous:{...o,noStockLines:true},control}))
          &&mapShopeeStockLines({ items:o.items,posCatalog:catalog,matchItem }).status === 'mapped')
        .map(o => o.order_number);
      if (!resolved.length) return { queuedOrders: 0,nextCursor };
      // A reviewed stock-mapping upgrade can re-evaluate a former mapping hold.
      // It adds no cancellation/return decision and normal projection rechecks
      // the current source, lifecycle and retained item contract before writing.
      const queued = await c.query(`INSERT INTO ${table('dirty')}(order_number)
        SELECT unnest($1::text[]) ON CONFLICT(order_number) DO NOTHING`, [resolved]);
      if (queued.rowCount) await audit(c, 'verified-stock-mapping-requeued', { queuedOrders:queued.rowCount,
        lifecycleApprovalsAdded:false,originalCutoverPreserved:true }, 'system-stock-mapping');
      return { queuedOrders: queued.rowCount,nextCursor };
    });
    mappingReviewCursor=result.nextCursor;
    return {queuedOrders:result.queuedOrders};
  }
  async function projection(productCodes) {
    requireEnabled();
    if (!Array.isArray(productCodes) || productCodes.length > 10000
      || productCodes.some(s => typeof s !== 'string' || !s.length || s.length > 100)
      || new Set(productCodes).size !== productCodes.length) fail('PROJECTION_SCOPE_INVALID');
    return transaction(async c => {
      const ctrl = await c.query(`SELECT mode,cutover_at,pos_catalog,plan->'openingBasis' AS opening_basis FROM ${table('control')} WHERE singleton=1`);
      const matchItem = ctrl.rows[0] ? await scopedMatcher(c,ctrl.rows[0]) : undefined;
      const ruleJobs = (await c.query(`SELECT count(*)::int AS count
        FROM "${schema}".shopee004_stock_identity_recovery_jobs WHERE NOT completed`)).rows[0].count;
      const pending = await c.query(`SELECT count(*)::int AS count,
        count(*) FILTER(WHERE recovery_revision IS DISTINCT FROM revision OR recovery_state='ready')::int AS ready,
        count(*) FILTER(WHERE recovery_revision=revision AND recovery_state='retry_wait')::int AS retrying,
        count(*) FILTER(WHERE recovery_revision=revision AND recovery_state='blocked')::int AS blocked,
        min(retry_after) FILTER(WHERE recovery_revision=revision AND recovery_state='retry_wait') AS next_retry_at
        FROM ${table('dirty')}`);
      const review = await c.query(`SELECT count(*) FILTER (WHERE state='review_required')::int AS count,
        count(*) FILTER (WHERE warnings ? 'owner-confirmed-source-label-mismatch')::int AS warning_count,
        count(*) FILTER (WHERE warnings ? 'late-legacy-excluded-under-owner-accepted-estimate')::int AS estimate_excluded_count
        FROM ${table('positions')}`);
      const stamp = await c.query(`SELECT transaction_timestamp() AS at,COALESCE((SELECT max(revision) FROM ${table('audit')}),0)::text AS revision`);
      const feed = await c.query(`SELECT max(created_at) AS last_ingested_at FROM ${events} WHERE shop_code='sc-drug-store'`);
      let affected = new Set(),unallocatedOrders=0,scopeScanLimited=false; let scopeValidated = ctrl.rows[0]?.mode === 'live';
      if (scopeValidated && (pending.rows[0].count || review.rows[0].count)) {
        // The same snapshot fences source, retained contracts and quantities.
        const blocked = await c.query(`SELECT o.items,p.source_snapshot,count(*) OVER()::int AS scope_order_count,
          ARRAY(SELECT l.product_code FROM ${table('lines')} l WHERE l.order_number=b.order_number) AS retained_codes
          FROM (SELECT order_number FROM ${table('dirty')} UNION
            SELECT order_number FROM ${table('positions')} WHERE state='review_required') b
          LEFT JOIN ${orders} o ON o.order_number=b.order_number AND o.shop_code='sc-drug-store'
          LEFT JOIN ${table('positions')} p ON p.order_number=b.order_number
          ORDER BY b.order_number LIMIT 100`);
        const scope=resolveReviewScope(blocked.rows,validateCatalog(ctrl.rows[0].pos_catalog),{matchItem});
        const unscanned=Math.max(0,(blocked.rows[0]?.scope_order_count||0)-blocked.rows.length);
        scopeValidated=scope.complete;affected=scope.affected;unallocatedOrders=scope.unallocatedOrders+unscanned;scopeScanLimited=unscanned>0;
      }
      // An approved/revoked rule or changed catalog is visible before its
      // bounded recovery cursor reaches every order. Fence those known product
      // identities in this same snapshot, including aliases' canonical masters.
      // Do not invent dirty-order counts from metadata-job counts.
      const ruleAffected=new Set();
      if(scopeValidated&&ruleJobs){
        const catalog=validateCatalog(ctrl.rows[0].pos_catalog),requested=new Set(productCodes);
        const relevant=[...new Set([...productCodes,...[...catalog.values()]
          .filter(p=>requested.has(p.stockCode)).map(p=>p.companySku)])];
        const codes=await c.query(`SELECT DISTINCT code.value AS product_code
          FROM "${schema}".shopee004_stock_identity_recovery_jobs j
          CROSS JOIN LATERAL jsonb_array_elements_text(j.product_codes) code(value)
          WHERE NOT j.completed AND code.value=ANY($1::text[])`,[relevant]);
        for(const row of codes.rows){const code=catalog.get(row.product_code)?.stockCode||row.product_code;
          if(requested.has(code)){affected.add(code);ruleAffected.add(code);}}
      }
      const hasBlockedOrders = pending.rows[0].count > 0 || review.rows[0].count > 0;
      const rows = await c.query(`SELECT product_code,min(unit) AS unit,count(DISTINCT unit)::int AS units,
        sum(reserved_quantity)::text AS reserved,sum(shipped_unposted_quantity)::text AS shipped
        FROM ${table('lines')} WHERE product_code=ANY($1::text[]) GROUP BY product_code`, [productCodes]);
      const byCode = new Map(rows.rows.map(r => [r.product_code, r]));
      const basis = ctrl.rows[0]?.opening_basis;
      const initial = new Map((basis?.records || []).map(r => [r.productCode, r]));
      const records=productCodes.map(productCode=>{
        const row=byCode.get(productCode),base=initial.get(productCode);
        const reserved=Number(row?.reserved||0),shipped=Number(row?.shipped||0)+(base?.quantity||0);
        const invalid=ruleAffected.has(productCode)||row?.units>1||!Number.isSafeInteger(reserved)||reserved<0||!Number.isSafeInteger(shipped)||shipped<0
          ||!Number.isSafeInteger(reserved+shipped)||(row?.unit&&base?.unit&&row.unit!==base.unit);
        return {productCode,availabilityStatus:!scopeValidated||affected.has(productCode)||invalid?'review_required'
          :unallocatedOrders?'known-commitments-only':'available',unit:invalid?null:row?.unit||base?.unit||null,
          reservedQuantity:invalid?null:reserved,shippedUnpostedQuantity:invalid?null:shipped};
      });
      const pageReviewProducts=records.filter(r=>r.availabilityStatus==='review_required').length;
      const ready=scopeValidated&&!hasBlockedOrders&&!pageReviewProducts;
      return { schemaVersion: 'shopee004-commitments-v1', branchCode: '004', mode: ctrl.rows[0]?.mode || 'unconfigured',
        status: ready ? 'available' : scopeValidated ? 'partial' : 'review-or-processing-required',
        availabilityContract:'per-product-review-v2',scopeValidated,unallocatedOrders,scopeScanLimited,
        pageReviewProducts,
        cutoverAt: ctrl.rows[0]?.cutover_at?.toISOString() || null,
        asOf: stamp.rows[0].at.toISOString(), revision: stamp.rows[0].revision,
        lastEmailIngestedAt: feed.rows[0].last_ingested_at?.toISOString() || null,
        pendingOrders: pending.rows[0].count, reviewOrders: review.rows[0].count,
        recovery: { readyOrders:pending.rows[0].ready,retryingOrders:pending.rows[0].retrying,
          blockedOrders:pending.rows[0].blocked,pendingRuleJobs:ruleJobs,
          nextRetryAt:pending.rows[0].next_retry_at?.toISOString() || null },
        sourceLabelReviewOrders: review.rows[0].warning_count,
        acceptedOpeningLateLegacyOrders: review.rows[0].estimate_excluded_count,
        posPostingPolicy: 'not-recorded-in-pos', emailCoverage: 'email-orders-only',
        ...(basis ? { openingBasisQuality: basis.quality, openingBasisAsOf: basis.sourceAsOf,
          openingBasisHistoricalOrders: basis.coveredOrderCount, openingBasisPhysicalStockVerified: false,
          openingBasisExcludedReviewOrders: basis.excludedPhysicalReviewOrders } : {}),
        records };
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
  async function readExceptionRows(c,{limit=25,cursor=null,exceptionId=null}={}) {
    return (await c.query(`SELECT b.order_number,COALESCE(p.exception_id,d.exception_id) AS exception_id,
      p.reasons,p.warnings,p.source_snapshot,o.items,p.eligibility,p.state,p.updated_at,
      d.revision AS dirty_revision,d.recovery_revision,d.queued_at,d.recovery_state,d.attempt_count,d.retry_after,
      d.last_error_code,d.first_failed_at,d.last_failed_at,
      COALESCE((SELECT max(a.revision) FROM ${table('audit')} a WHERE a.order_number=b.order_number),0)::text AS audit_revision,
      ARRAY(SELECT l.product_code FROM ${table('lines')} l WHERE l.order_number=b.order_number) AS retained_codes
      FROM (SELECT order_number FROM ${table('dirty')} UNION SELECT order_number FROM ${table('positions')}
        WHERE state='review_required') b
      LEFT JOIN ${table('positions')} p ON p.order_number=b.order_number
      LEFT JOIN ${table('dirty')} d ON d.order_number=b.order_number
      LEFT JOIN ${orders} o ON o.order_number=b.order_number AND o.shop_code='sc-drug-store'
      WHERE ($1::uuid IS NULL OR COALESCE(p.exception_id,d.exception_id)>$1::uuid)
        AND ($2::uuid IS NULL OR COALESCE(p.exception_id,d.exception_id)=$2::uuid)
      ORDER BY COALESCE(p.exception_id,d.exception_id) LIMIT $3`,[cursor,exceptionId,limit])).rows;
  }
  async function exceptions({limit=25,cursor=null}={}) {
    requireEnabled();
    if(!Number.isInteger(limit)||limit<1||limit>100||(cursor&&!UUID.test(cursor)))fail('EXCEPTION_PAGE_INVALID');
    return transaction(async c=>{
      const rows=await readExceptionRows(c,{limit:limit+1,cursor});
      const at=(await c.query('SELECT transaction_timestamp() AS at')).rows[0].at;
      const control=(await c.query(`SELECT mode,pos_catalog,cutover_at,plan FROM ${table('control')} WHERE singleton=1`)).rows[0];
      const catalog=control?validateCatalog(control.pos_catalog):new Map();
      const matchItem=control?await scopedMatcher(c,control):undefined;
      const records=rows.slice(0,limit).map(row=>publicException(row,{selection:selectExceptionItem(row,catalog,{matchItem})}));
      return {schemaVersion:'shopee004-exceptions-v1',branchCode:'004',asOf:at.toISOString(),status:'available',records,
        pagination:{hasMore:rows.length>limit,nextCursor:rows.length>limit?records.at(-1).exceptionId:null}};
    },true);
  }
  // Internal integration only. The source identity and order reference must stay
  // in server RAM. Approval routes pass their own transaction client so revision
  // validation and append-only rule writing share one atomic boundary.
  async function exceptionContext({exceptionId,expectedRevision,client}={}) {
    requireEnabled();
    if(!UUID.test(exceptionId||'')||typeof expectedRevision!=='string'||expectedRevision.length>200)fail('EXCEPTION_CONTEXT_INVALID');
    const read=async c=>{
      const row=(await readExceptionRows(c,{exceptionId,limit:1}))[0];
      if(!row)fail('EXCEPTION_NOT_FOUND');
      if(exceptionRevision(row)!==expectedRevision)fail('EXCEPTION_REVISION_CONFLICT');
      const control=(await c.query(`SELECT mode,cutover_at,pos_catalog,plan FROM ${table('control')} WHERE singleton=1 ${client?'FOR SHARE':''}`)).rows[0];
      const catalog=control?validateCatalog(control.pos_catalog):new Map(),matchItem=control?await scopedMatcher(c,control):undefined;
      return {orderNumber:row.order_number,items:row.items,originalItems:row.source_snapshot?.items||[],
        retainedProductCodes:row.retained_codes,record:publicException(row,{selection:selectExceptionItem(row,catalog,{matchItem})}),control};
    };
    return client?read(client):transaction(read,true);
  }
  async function reconciliation() {
    requireEnabled();
    return transaction(async c=>{
      const control=(await c.query(`SELECT mode,cutover_at,plan->'openingBasis' AS basis FROM ${table('control')} WHERE singleton=1`)).rows[0];
      const counts=(await c.query(`SELECT count(*) FILTER(WHERE state='reserved')::int AS reserved,
        count(*) FILTER(WHERE state='shipped_unposted')::int AS shipped,
        count(*) FILTER(WHERE state='review_required')::int AS review FROM ${table('positions')}`)).rows[0];
      const outstanding=(await c.query(`SELECT EXISTS(SELECT 1 FROM ${table('lines')} WHERE shipped_unposted_quantity>0) AS present`)).rows[0].present;
      return {schemaVersion:'shopee004-reconciliation-v1',branchCode:'004',openingBoundaryPreserved:Boolean(control?.cutover_at),
        cutoverAt:control?.cutover_at?.toISOString()||null,openingBasisQuality:control?.basis?.quality||'physical-opening-attested',
        physicalStockVerified:false,
        reservedOrders:counts.reserved,shippedUnpostedOrders:counts.shipped,reviewOrders:counts.review,
        requiresCountReconciliation:Boolean(control?.basis||outstanding||counts.review),
        stockCountAction:'separate-physical-count-and-cutover-approval-required',automaticRebaseline:false,posWrites:false};
    },true);
  }
  async function requeueRuleAffected({identities=[],productCodes=[],cursor='',limit=100,client}={}) {
    requireEnabled();
    if(!Array.isArray(identities)||identities.length>100||!Array.isArray(productCodes)||productCodes.length>100
      ||!Number.isInteger(limit)||limit<1||limit>100||(cursor&&!ORDER.test(cursor))
      ||identities.some(i=>!i||typeof i.listingId!=='string'||typeof i.variationId!=='string'
        ||i.listingId.length>100||i.variationId.length>100||!Array.isArray(i.aliases||[])
        ||(i.aliases||[]).some(a=>!a||typeof a.productName!=='string'||typeof a.variantName!=='string'))
      ||productCodes.some(code=>typeof code!=='string'||!code.length||code.length>100)
      ||(!identities.length&&!productCodes.length))fail('RULE_REQUEUE_SCOPE_INVALID');
    const run=async c=>{
      // Scan is bounded and resumable. Only exact current/original identities or
      // retained affected stock codes are queued; no lifecycle decision is added.
      const rows=(await c.query(`SELECT b.order_number,o.items,p.source_snapshot,
        ARRAY(SELECT l.product_code FROM ${table('lines')} l WHERE l.order_number=b.order_number) AS retained_codes
        FROM (SELECT order_number FROM ${table('positions')} UNION SELECT order_number FROM ${table('dirty')}) b
        LEFT JOIN ${orders} o ON o.order_number=b.order_number AND o.shop_code='sc-drug-store'
        LEFT JOIN ${table('positions')} p ON p.order_number=b.order_number
        WHERE b.order_number>$1 ORDER BY b.order_number LIMIT $2`,[cursor,limit])).rows;
      const matched=rows.filter(row=>ruleAffectsOrder(row,{identities,productCodes})).map(row=>row.order_number);
      const queued=matched.length?await c.query(`INSERT INTO ${table('dirty')}(order_number)
        SELECT unnest($1::text[]) ON CONFLICT(order_number) DO UPDATE SET revision=${table('dirty')}.revision+1,
        queued_at=clock_timestamp()`,[matched]):{rowCount:0};
      if(queued.rowCount)await audit(c,'stock-rule-affected-requeued',{queuedOrders:queued.rowCount,lifecycleApprovalsAdded:false,
        originalCutoverPreserved:true,holdsRetained:true},'system-stock-rule');
      return {queuedOrders:queued.rowCount,scannedOrders:rows.length,hasMore:rows.length===limit,
        nextCursor:rows.length===limit?rows.at(-1).order_number:null};
    };
    return client?run(client):transaction(run);
  }
  return { prepare, activate, pause, resume, extendPosCatalog, review, reviewQueue, reconcileAcceptedLegacy,
    requeueResolvedMappings, processOne, projection, exceptions, exceptionContext, reconciliation, requeueRuleAffected };
}
module.exports = { createShopee004StockLedger };
