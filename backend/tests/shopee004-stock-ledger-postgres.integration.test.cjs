const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createShopee004StockLedger } = require('../src/modules/seamless/services/shopee004StockLedger');
const url = process.env.SHOPEE004_TEST_DATABASE_URL;
const run = url ? describe : describe.skip;
const catalog = [{ companySku: 'P1', stockCode: 'P1', active: true, stockFactor: 1, smallFactor: 1, smallUnit: 'ซอง' }];
const matchItem = () => ({ status: 'matched', companySku: 'P1', quantityUnit: 'sachet' });
const actor = 'synthetic-reviewer';
run('durable ledger against isolated PostgreSQL (never production)', () => {
  let pool, schema, ledger;
  const t = name => `"${schema}".shopee004_stock_${name}`;
  beforeAll(() => { pool = new Pool({ connectionString: url, max: 6 }); });
  beforeEach(async () => {
    schema = 'stock_test_' + randomUUID().replaceAll('-','');
    const c = await pool.connect();
    try {
      await c.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}",public;
        CREATE TABLE shopee_orders(shop_code text,order_number text,current_status text,ordered_at timestamptz,items jsonb,last_event_at timestamptz,
          PRIMARY KEY(shop_code,order_number));
        CREATE TABLE shopee_order_events(id bigserial PRIMARY KEY,shop_code text,order_number text,event_type text,occurred_at timestamptz,created_at timestamptz DEFAULT now());`);
      const sql = fs.readFileSync(path.join(__dirname,'../src/modules/seamless/db/migrations/034_shopee004_durable_stock_commitments.sql'),'utf8');
      await c.query(sql); await c.query(sql); // Direct rerun, not merely ledger skip.
      const recoverySql=fs.readFileSync(process.env.SHOPEE004_RECOVERY_SCHEMA_FIXTURE
        ||path.join(__dirname,'../src/modules/seamless/db/migrations/035_shopee004_stock_recovery_identity.sql'),'utf8');
      await c.query(recoverySql);await c.query(recoverySql);
    } finally { c.release(); }
    ledger = createShopee004StockLedger({ pool, schema, enabled: true, matchItem });
  });
  afterEach(async () => { await pool.query(`DROP SCHEMA "${schema}" CASCADE`); });
  afterAll(async () => { await pool.end(); });
  async function source(order = 'OLDORDER1', { old = true, shop = 'sc-drug-store', quantity = 2 } = {}) {
    const stamp = old ? '2000-01-01T00:00:00Z' : new Date().toISOString();
    await pool.query(`INSERT INTO "${schema}".shopee_orders VALUES($1,$2,'order_confirmed',$3,$4,$3)`,
      [shop, order, stamp, JSON.stringify([{ name: 'Synthetic', quantity }])]);
    await pool.query(`INSERT INTO "${schema}".shopee_order_events(shop_code,order_number,event_type,occurred_at) VALUES($1,$2,'order_confirmed',$3)`, [shop,order,stamp]);
  }
  async function open(selected = ['OLDORDER1']) {
    const plan = await ledger.prepare({ posCatalog: catalog, openingOrderNumbers: selected, actor });
    await ledger.activate({ planId: plan.planId, actor, openingOrdersVerified: true, olderShippedReconciledInPosBasis: true,
      emailFeedChecked: true, unpostedPosWorkflow: true });
    return plan;
  }
  async function drain(service = ledger) { while (await service.processOne()) {} }
  const read = () => ledger.projection(['P1']);
  test('migration reruns; explicit opening set, duplicate activation, worker restart and duplicate events never double reserve', async () => {
    await source(); const plan = await open();
    expect((await read()).status).not.toBe('available');
    await Promise.all([drain(),drain()]);
    expect((await read()).records[0]).toMatchObject({ reservedQuantity: 2, shippedUnpostedQuantity: 0 });
    await ledger.activate({ planId: plan.planId, actor, openingOrdersVerified: true, olderShippedReconciledInPosBasis: true,emailFeedChecked: true,unpostedPosWorkflow: true });
    await pool.query(`INSERT INTO "${schema}".shopee_order_events(shop_code,order_number,event_type,occurred_at) VALUES('sc-drug-store','OLDORDER1','order_confirmed','2000-01-01')`);
    await drain(createShopee004StockLedger({ pool,schema,enabled:true,matchItem }));
    expect((await read()).records[0].reservedQuantity).toBe(2);
  });
  test('owner-accepted historical basis is applied once with pending/new orders, without POS-reconciled attestation', async () => {
    await source('OLDORDER1');await source('SHIPPED01',{quantity:3});
    const openingBasis={quality:'owner-accepted-estimate',ownerAccepted:true,olderShippedNotPostedInPos:true,
      periodStart:'1999-01-01T00:00:00Z',sourceAsOf:'2001-01-01T00:00:00Z',excludedPhysicalReviewOrders:47,
      coveredOrderNumbers:['SHIPPED01'],records:[{productCode:'P1',unit:'ซอง',quantity:3}]};
    const plan=await ledger.prepare({posCatalog:catalog,openingOrderNumbers:['OLDORDER1'],openingBasis,actor});
    expect(plan).toMatchObject({openingBasisQuality:'owner-accepted-estimate',ownerEstimateApprovalRequired:true});
    const approval={planId:plan.planId,actor,emailFeedChecked:true,unpostedPosWorkflow:true,ownerAcceptedOpeningEstimate:true};
    await expect(ledger.activate({...approval,ownerAcceptedOpeningEstimate:false,openingOrdersVerified:true,olderShippedReconciledInPosBasis:true}))
      .rejects.toMatchObject({code:'OPENING_BASIS_APPROVAL_REQUIRED'});
    await ledger.activate(approval);await drain();
    expect(await read()).toMatchObject({status:'available',openingBasisQuality:'owner-accepted-estimate',openingBasisPhysicalStockVerified:false,
      openingBasisHistoricalOrders:1,records:[{reservedQuantity:2,shippedUnpostedQuantity:3}]});
    await ledger.activate(approval);
    await pool.query(`INSERT INTO "${schema}".shopee_order_events(shop_code,order_number,event_type,occurred_at) VALUES('sc-drug-store','SHIPPED01','order_confirmed','2000-01-01')`);
    await drain(createShopee004StockLedger({pool,schema,enabled:true,matchItem}));
    expect((await read()).records[0]).toMatchObject({reservedQuantity:2,shippedUnpostedQuantity:3});
    await source('NEWAFTER1',{old:false});await drain();
    expect((await read()).records[0]).toMatchObject({reservedQuantity:4,shippedUnpostedQuantity:3});
    await ledger.pause({actor});expect(await read()).toMatchObject({mode:'paused',records:[{reservedQuantity:4,shippedUnpostedQuantity:3}]});
  });
  test('owner estimate approval cannot waive the ordinary physical-opening contract',async()=>{
    await source();const plan=await ledger.prepare({posCatalog:catalog,openingOrderNumbers:['OLDORDER1'],actor});
    await expect(ledger.activate({planId:plan.planId,actor,emailFeedChecked:true,unpostedPosWorkflow:true,ownerAcceptedOpeningEstimate:true}))
      .rejects.toMatchObject({code:'OPENING_BASIS_APPROVAL_REQUIRED'});
  });
  test('wrong accepted historical quantities leave no opening control row',async()=>{
    await source('SHIPPED01',{quantity:3});
    const openingBasis={quality:'owner-accepted-estimate',ownerAccepted:true,olderShippedNotPostedInPos:true,
      periodStart:'1999-01-01T00:00:00Z',sourceAsOf:'2001-01-01T00:00:00Z',excludedPhysicalReviewOrders:0,
      coveredOrderNumbers:['SHIPPED01'],records:[{productCode:'P1',unit:'ซอง',quantity:4}]};
    await expect(ledger.prepare({posCatalog:catalog,openingOrderNumbers:[],openingBasis,actor})).rejects.toMatchObject({code:'OPENING_ESTIMATE_TOTALS_DIFFER'});
    expect((await pool.query(`SELECT count(*)::int AS n FROM ${t('control')}`)).rows[0].n).toBe(0);
  });
  test('late historical orders are not new deductions; explicit baseline review resolves uncertainty', async () => {
    await source(); await open(); await drain(); await source('LATEOLD01'); await drain();
    expect(await read()).toMatchObject({ status: 'partial', reviewOrders: 1, records: [{ reservedQuantity: 2, availabilityStatus:'review_required' }] });
    await ledger.review({ operationId: randomUUID(),orderNumber:'LATEOLD01',kind:'legacy-in-baseline',actor,physicalEvidenceVerified:true,notPostedInPos:true });
    await drain(); expect((await read()).status).toBe('available');
  });
  async function acceptedOpening() {
    await source('OLDORDER1');await source('SHIPPED01',{quantity:3});
    const openingBasis={quality:'owner-accepted-estimate',ownerAccepted:true,olderShippedNotPostedInPos:true,
      periodStart:'1999-01-01T00:00:00Z',sourceAsOf:'2001-01-01T00:00:00Z',excludedPhysicalReviewOrders:47,
      coveredOrderNumbers:['SHIPPED01'],records:[{productCode:'P1',unit:'ซอง',quantity:3}]};
    const p=await ledger.prepare({posCatalog:catalog,openingOrderNumbers:['OLDORDER1'],openingBasis,actor});
    await ledger.activate({planId:p.planId,actor,emailFeedChecked:true,unpostedPosWorkflow:true,ownerAcceptedOpeningEstimate:true});
    await drain();return p;
  }
  test('late old mail under an accepted estimate is visibly excluded without debiting or claiming POS reconciliation',async()=>{
    await acceptedOpening();const before=await read();
    await source('LATEOLD01');await drain();
    const after=await read();expect(after).toMatchObject({status:'available',reviewOrders:0,acceptedOpeningLateLegacyOrders:1,
      sourceLabelReviewOrders:0,openingBasisPhysicalStockVerified:false,cutoverAt:before.cutoverAt,
      records:[{reservedQuantity:2,shippedUnpostedQuantity:3}]});
    const p=(await pool.query(`SELECT state,warnings FROM ${t('positions')} WHERE order_number='LATEOLD01'`)).rows[0];
    expect(p).toEqual({state:'legacy_excluded',warnings:['late-legacy-excluded-under-owner-accepted-estimate']});
    await pool.query(`UPDATE "${schema}".shopee_orders SET last_event_at=now() WHERE order_number='LATEOLD01'`);await drain();
    expect((await read()).records).toEqual(after.records);
  });
  test('bounded accepted-legacy recovery reprocesses the old review without moving cutover or changing quantities',async()=>{
    await acceptedOpening();const before=await read();await source('LATEOLD01');await drain();
    await pool.query(`UPDATE ${t('positions')} SET state='review_required',reasons='["legacy-arrival-needs-opening-review"]',warnings='[]' WHERE order_number='LATEOLD01'`);
    await expect(ledger.reconcileAcceptedLegacy({actor})).rejects.toMatchObject({code:'OWNER_ESTIMATE_APPROVAL_REQUIRED'});
    const input={actor,ownerAcceptedOpeningEstimate:true};
    expect(await ledger.reconcileAcceptedLegacy(input)).toMatchObject({queuedOrders:1,originalCutoverPreserved:true,physicalStockVerified:false,posStockAdjusted:false});
    expect((await ledger.reconcileAcceptedLegacy(input)).queuedOrders).toBe(0);
    await drain();expect(await read()).toMatchObject({status:'available',cutoverAt:before.cutoverAt,records:before.records});
    expect((await ledger.reconcileAcceptedLegacy(input)).queuedOrders).toBe(0);
  });
  test('estimated legacy recovery cannot waive a physical opening, a current hold or another review reason',async()=>{
    await source();await open();await drain();
    await expect(ledger.reconcileAcceptedLegacy({actor,ownerAcceptedOpeningEstimate:true})).rejects.toMatchObject({code:'ACCEPTED_ESTIMATE_CUTOVER_REQUIRED'});
  });
  test('estimate exclusion cannot drop a backdated new hold, an unknown date or a changed-date legacy review',async()=>{
    await acceptedOpening();await source('NEWAFTER1',{old:false});await drain();
    await pool.query(`UPDATE "${schema}".shopee_orders SET ordered_at='2000-01-01' WHERE order_number='NEWAFTER1'`);await drain();
    await source('NODATE001');await pool.query(`UPDATE "${schema}".shopee_orders SET ordered_at=NULL WHERE order_number='NODATE001'`);await drain();
    await source('LATEOLD01');await drain();
    await pool.query(`UPDATE "${schema}".shopee_orders SET ordered_at=now() WHERE order_number='LATEOLD01'`);await drain();
    expect((await ledger.reconcileAcceptedLegacy({actor,ownerAcceptedOpeningEstimate:true})).queuedOrders).toBe(0);
    expect(await read()).toMatchObject({reviewOrders:3,records:[{reservedQuantity:4,shippedUnpostedQuantity:3}]});
  });
  test('accepted legacy recovery never requeues a legacy position with an outstanding held line',async()=>{
    await acceptedOpening();await source('LATEOLD01');await drain();
    await pool.query(`UPDATE ${t('positions')} SET state='review_required',reasons='["legacy-arrival-needs-opening-review"]' WHERE order_number='LATEOLD01'`);
    await pool.query(`INSERT INTO ${t('lines')}(order_number,product_code,unit,ordered_quantity,reserved_quantity,shipped_unposted_quantity) VALUES('LATEOLD01','P1','ซอง',1,1,0)`);
    expect((await ledger.reconcileAcceptedLegacy({actor,ownerAcceptedOpeningEstimate:true})).queuedOrders).toBe(0);
    expect((await read()).reviewOrders).toBe(1);
  });
  test('new post-cutover orders reserve once, other shops are not queued', async () => {
    await source(); await open(); await drain(); await source('NEWORDER1',{old:false}); await source('OTHERSHOP',{old:false,shop:'dr-morepen'});
    await drain(); expect((await read()).records[0].reservedQuantity).toBe(4);
  });
  test('a reviewed mapping upgrade heals only fully mapped holds without moving cutover or approving cancellation',async()=>{
    await source();await open();await drain();const before=await read();
    await pool.query(`UPDATE ${t('positions')} SET state='review_required',reasons='["product_mapping_unverified"]' WHERE order_number='OLDORDER1'`);
    const unverified=createShopee004StockLedger({pool,schema,enabled:true,matchItem:()=>({status:'unmapped'})});
    expect((await unverified.requeueResolvedMappings()).queuedOrders).toBe(0);
    expect((await ledger.requeueResolvedMappings()).queuedOrders).toBe(1);
    expect((await ledger.requeueResolvedMappings()).queuedOrders).toBe(0);
    await drain();expect(await read()).toMatchObject({status:'available',cutoverAt:before.cutoverAt,records:before.records});
    await pool.query(`UPDATE ${t('positions')} SET state='review_required',reasons='["cancel-dispatch-unverified"]' WHERE order_number='OLDORDER1'`);
    expect((await ledger.requeueResolvedMappings()).queuedOrders).toBe(0);
    await pool.query(`UPDATE ${t('positions')} SET reasons='["product_mapping_unverified","order-items-changed-needs-review"]' WHERE order_number='OLDORDER1'`);
    expect((await ledger.requeueResolvedMappings()).queuedOrders).toBe(0);
    expect((await read()).records).toEqual(before.records.map(r=>({...r,availabilityStatus:'review_required'})));
  });
  test('mapping recovery cursor does not starve later resolved items behind 50 unresolved orders',async()=>{
    await source();await open();await drain();
    await pool.query(`INSERT INTO "${schema}".shopee_orders(shop_code,order_number,current_status,ordered_at,items,last_event_at)
      SELECT 'sc-drug-store','BATCH'||lpad(n::text,5,'0'),'order_confirmed',now(),
      jsonb_build_array(jsonb_build_object('name',CASE WHEN n=51 THEN 'ResolvedLater' ELSE 'StillUnmapped' END,'quantity',1)),now()
      FROM generate_series(1,51) n`);
    await pool.query(`INSERT INTO "${schema}".shopee_order_events(shop_code,order_number,event_type,occurred_at)
      SELECT shop_code,order_number,'order_confirmed',ordered_at FROM "${schema}".shopee_orders WHERE order_number LIKE 'BATCH%'`);
    await drain(createShopee004StockLedger({pool,schema,enabled:true,matchItem:()=>({status:'unmapped'})}));
    const upgraded=createShopee004StockLedger({pool,schema,enabled:true,matchItem:(_shop,item)=>item.name==='ResolvedLater'?matchItem():({status:'unmapped'})});
    expect(await upgraded.requeueResolvedMappings()).toEqual({queuedOrders:0});
    expect(await upgraded.requeueResolvedMappings()).toEqual({queuedOrders:1});
  });
  test('changed opening plan, stale approval and missing attestations cannot activate', async () => {
    await source(); const p=await ledger.prepare({posCatalog:catalog,openingOrderNumbers:['OLDORDER1'],actor});
    await expect(ledger.activate({actor})).rejects.toMatchObject({code:'OPENING_ATTESTATIONS_REQUIRED'});
    const yes={actor,openingOrdersVerified:true,olderShippedReconciledInPosBasis:true,emailFeedChecked:true,unpostedPosWorkflow:true};
    await expect(ledger.activate({...yes,planId:randomUUID()})).rejects.toMatchObject({code:'OPENING_PLAN_APPROVAL_MISMATCH'});
    await source('NEWBEFORE');
    await expect(ledger.activate({...yes,planId:p.planId})).rejects.toMatchObject({code:'OPENING_PLAN_CHANGED'});
    expect((await read()).mode).toBe('planned');
  });
  test('email cancellation does not release; verified physical cancellation is idempotent', async () => {
    await source();await open();await drain();
    await pool.query(`INSERT INTO "${schema}".shopee_order_events(shop_code,order_number,event_type,occurred_at) VALUES('sc-drug-store','OLDORDER1','order_cancelled',now())`);
    await drain();expect(await read()).toMatchObject({reviewOrders:1,records:[{reservedQuantity:2}]});
    const queue=await ledger.reviewQueue();expect(queue.records).toMatchObject([{orderNumber:'OLDORDER1'}]);
    expect(queue.records[0]).not.toHaveProperty('items');
    const decision={operationId:randomUUID(),orderNumber:'OLDORDER1',kind:'cancel-before-dispatch',actor,physicalEvidenceVerified:true,notPostedInPos:true};
    await ledger.review(decision);await ledger.review(decision);await drain();
    expect(await read()).toMatchObject({status:'available',records:[{reservedQuantity:0}]});
    await expect(ledger.review({...decision,kind:'dispatched'})).rejects.toMatchObject({code:'REVIEW_IDEMPOTENCY_CONFLICT'});
  });
  test('dispatch retains unposted demand, partial physical return releases only verified units, over-return blocks', async () => {
    await source();await open();await drain();
    const base={orderNumber:'OLDORDER1',actor,physicalEvidenceVerified:true,notPostedInPos:true};
    await ledger.review({...base,operationId:randomUUID(),kind:'dispatched'});await drain();
    expect((await read()).records[0]).toMatchObject({reservedQuantity:0,shippedUnpostedQuantity:2});
    await ledger.review({...base,operationId:randomUUID(),kind:'returned-sellable',quantities:[{productCode:'P1',quantity:1}]});await drain();
    expect((await read()).records[0].shippedUnpostedQuantity).toBe(1);
    await expect(ledger.review({...base,operationId:randomUUID(),kind:'returned-sellable',quantities:[{productCode:'P1',quantity:2}]}))
      .rejects.toMatchObject({code:'REVIEW_WOULD_LEAVE_UNVERIFIED_POSITION'});
    await drain();expect(await read()).toMatchObject({reviewOrders:0,records:[{shippedUnpostedQuantity:1}]});
  });
  test('item edits stay blocked across retries; pause retains holds and cannot recreate cutover', async () => {
    await source();await open();await drain();
    await pool.query(`UPDATE "${schema}".shopee_orders SET items=$1 WHERE order_number='OLDORDER1'`,[JSON.stringify([{name:'Synthetic',quantity:3}])]);
    await drain();
    await pool.query(`UPDATE "${schema}".shopee_orders SET last_event_at=now() WHERE order_number='OLDORDER1'`);await drain();
    expect(await read()).toMatchObject({reviewOrders:1,records:[{reservedQuantity:2}]});
    await ledger.pause({actor});expect(await read()).toMatchObject({mode:'paused',status:'review-or-processing-required',records:[{reservedQuantity:2}]});
    await expect(ledger.prepare({posCatalog:catalog,openingOrderNumbers:[],actor})).rejects.toMatchObject({code:'CUTOVER_ALREADY_EXISTS'});
  });
  test('failed projection transaction retains dirty work and no partial position, then retry recovers', async () => {
    await source();await open();
    const broken=createShopee004StockLedger({pool,schema,enabled:true,matchItem:()=>{throw new Error('private injected details');}});
    expect(await broken.processOne()).toBe(true);expect(await broken.processOne()).toBe(false);
    expect((await read()).pendingOrders).toBe(1);
    await pool.query(`UPDATE "${schema}".shopee_orders SET last_event_at=now() WHERE order_number='OLDORDER1'`);
    await drain();expect((await read()).status).toBe('available');
  });
  test('activation fence queues in-flight source change and SKIP LOCKED workers never lose work',async()=>{
    await source(); const plan=await ledger.prepare({posCatalog:catalog,openingOrderNumbers:['OLDORDER1'],actor});
    const c=await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`UPDATE "${schema}".shopee_orders SET last_event_at=now() WHERE order_number='OLDORDER1'`);
      const activation=ledger.activate({planId:plan.planId,actor,openingOrdersVerified:true,olderShippedReconciledInPosBasis:true,emailFeedChecked:true,unpostedPosWorkflow:true});
      await c.query('COMMIT');
      await expect(activation).rejects.toMatchObject({code:'OPENING_PLAN_CHANGED'});
    }finally{c.release();}
    await open();
    await Promise.all(Array.from({length:5},()=>drain()));
    expect((await read()).records[0].reservedQuantity).toBe(2);
  });
  test('an event arriving while a worker holds the dirty row remains queued after acknowledgement',async()=>{
    await source();await open();await drain();
    await pool.query(`UPDATE "${schema}".shopee_orders SET last_event_at=now() WHERE order_number='OLDORDER1'`);
    let releaseGate, markRead;
    const gate=new Promise(r=>releaseGate=r),readReached=new Promise(r=>markRead=r);
    let intercepted=false;
    const workerPool={connect:async()=>{
      const c=await pool.connect();return {release:(...args)=>c.release(...args),query:async(sql,args)=>{
        const result=await c.query(sql,args);
        if(!intercepted&&sql.includes(`"${schema}".shopee_orders`)&&sql.startsWith('SELECT *')){
          intercepted=true;markRead();await gate;
        }return result;
      }};
    }};
    const worker=createShopee004StockLedger({pool:workerPool,schema,enabled:true,matchItem}).processOne();
    await readReached;
    const arriving=pool.query(`INSERT INTO "${schema}".shopee_order_events(shop_code,order_number,event_type,occurred_at)
      VALUES('sc-drug-store','OLDORDER1','order_cancelled',now())`);
    try {
      for(let i=0;i<100;i++){
        const waiting=await pool.query("SELECT count(*)::int AS count FROM pg_locks WHERE NOT granted");
        if(waiting.rows[0].count)break;
        await pool.query('SELECT pg_sleep(0.01)');
      }
    }finally{releaseGate();}
    await worker;await arriving;
    expect((await read()).pendingOrders).toBe(1);await drain();
    expect(await read()).toMatchObject({reviewOrders:1,records:[{reservedQuantity:2}]});
  });
  test('historical identity cannot be made new by a corrected source date; new holds cannot disappear after backdating',async()=>{
    await source();await source('KNOWNOLD1');await open();await drain();
    await pool.query(`UPDATE "${schema}".shopee_orders SET ordered_at=now() WHERE order_number='KNOWNOLD1'`);
    await drain();expect((await read()).records[0].reservedQuantity).toBe(2);
    await source('NEWORDER1',{old:false});await drain();
    await pool.query(`UPDATE "${schema}".shopee_orders SET ordered_at='2000-01-01' WHERE order_number='NEWORDER1'`);
    await drain();expect(await read()).toMatchObject({reviewOrders:1,records:[{reservedQuantity:4}]});
  });
  test('deleted source evidence cannot silently advertise a fully qualified quantity or clear old holds',async()=>{
    await source();await open();await drain();
    await pool.query(`DELETE FROM "${schema}".shopee_orders WHERE order_number='OLDORDER1'`);
    expect(await ledger.processOne()).toBe(true);expect(await ledger.processOne()).toBe(false);
    expect(await read()).toMatchObject({status:'partial',unallocatedOrders:1,pendingOrders:1,records:[{availabilityStatus:'review_required',reservedQuantity:2}]});
  });
  test('owner-confirmed source-label mismatch remains a visible warning, not a silent clean data qualification',async()=>{
    ledger=createShopee004StockLedger({pool,schema,enabled:true,matchItem:()=>({...matchItem(),sourceLabelMismatch:true})});
    await source();await open();await drain();
    expect(await read()).toMatchObject({status:'available',sourceLabelReviewOrders:1,records:[{reservedQuantity:2}]});
  });
  test('known cancellation and pending work qualify only unaffected products; pause still blocks all',async()=>{
    await source();await open();await drain();
    await pool.query(`INSERT INTO "${schema}".shopee_order_events(shop_code,order_number,event_type,occurred_at) VALUES('sc-drug-store','OLDORDER1','order_cancelled',now())`);
    let r=await ledger.projection(['P1','P2']);
    expect(r).toMatchObject({status:'partial',scopeValidated:true,pendingOrders:1,pageReviewProducts:1,
      records:[{productCode:'P1',availabilityStatus:'review_required'},{productCode:'P2',availabilityStatus:'available'}]});
    await drain();r=await ledger.projection(['P1','P2']);
    expect(r).toMatchObject({status:'partial',reviewOrders:1,pendingOrders:0,pageReviewProducts:1});
    expect((await ledger.projection([])).status).toBe('partial');
    await ledger.pause({actor});
    expect(await ledger.projection(['P1','P2'])).toMatchObject({scopeValidated:false,pageReviewProducts:2,
      records:[{availabilityStatus:'review_required'},{availabilityStatus:'review_required'}]});
  });
  test('changed items fence current identities and retained original identities',async()=>{
    const two=[...catalog,{...catalog[0],companySku:'P2',stockCode:'P2'}];
    ledger=createShopee004StockLedger({pool,schema,enabled:true,matchItem:(_shop,item)=>({status:'matched',companySku:item.name==='Other'?'P2':'P1',quantityUnit:'sachet'})});
    await source();const p=await ledger.prepare({posCatalog:two,openingOrderNumbers:['OLDORDER1'],actor});
    await ledger.activate({planId:p.planId,actor,openingOrdersVerified:true,olderShippedReconciledInPosBasis:true,emailFeedChecked:true,unpostedPosWorkflow:true});await drain();
    await pool.query(`UPDATE "${schema}".shopee_orders SET items=$1 WHERE order_number='OLDORDER1'`,[JSON.stringify([{name:'Other',quantity:1}])]);await drain();
    expect(await ledger.projection(['P1','P2','P3'])).toMatchObject({status:'partial',pageReviewProducts:2,
      records:[{availabilityStatus:'review_required',reservedQuantity:2},{availabilityStatus:'review_required'},{availabilityStatus:'available'}]});
  });
  test('unknown current identity preserves old holds and explicitly qualifies only known commitments elsewhere',async()=>{
    await source();await open();await drain();
    ledger=createShopee004StockLedger({pool,schema,enabled:true,matchItem:(_shop,item)=>item.name==='Unknown'?{status:'unmapped'}:matchItem()});
    await pool.query(`UPDATE "${schema}".shopee_orders SET items=$1 WHERE order_number='OLDORDER1'`,[JSON.stringify([{name:'Unknown',quantity:1}])]);
    expect(await ledger.projection(['P1','P2'])).toMatchObject({status:'partial',scopeValidated:true,unallocatedOrders:1,pageReviewProducts:1,
      records:[{availabilityStatus:'review_required',reservedQuantity:2},{availabilityStatus:'known-commitments-only'}]});
  });
  test('fully unknown new order remains queued for review without hiding every other product or releasing any hold',async()=>{
    await source();await open();await drain();
    ledger=createShopee004StockLedger({pool,schema,enabled:true,matchItem:(_shop,item)=>item.name==='Unknown'?{status:'unmapped'}:matchItem()});
    await source('NEWORDER1',{old:false});await pool.query(`UPDATE "${schema}".shopee_orders SET items=$1 WHERE order_number='NEWORDER1'`,[JSON.stringify([{name:'Unknown',quantity:1}])]);await drain();
    expect(await ledger.projection(['P1','P2'])).toMatchObject({status:'partial',unallocatedOrders:1,reviewOrders:1,pageReviewProducts:0,
      records:[{availabilityStatus:'known-commitments-only',reservedQuantity:2},{availabilityStatus:'known-commitments-only',reservedQuantity:0}]});
    expect((await pool.query(`SELECT count(*)::int n FROM ${t('reviews')}`)).rows[0].n).toBe(0);
  });
  test('POS metadata extension is append-only, idempotent and preserves cutover/opening/holds',async()=>{
    await source();await open();await drain();const before=(await pool.query(`SELECT * FROM ${t('control')}`)).rows[0];
    const p2={...catalog[0],companySku:'P2',stockCode:'P2'};
    await expect(ledger.extendPosCatalog({posCatalog:[p2]})).rejects.toMatchObject({code:'HUMAN_ADMIN_REQUIRED'});
    expect(await ledger.extendPosCatalog({posCatalog:[p2],actor})).toMatchObject({addedProducts:1,originalCutoverPreserved:true,stockWrites:false});
    expect(await ledger.extendPosCatalog({posCatalog:[p2],actor})).toMatchObject({addedProducts:0});
    await expect(ledger.extendPosCatalog({posCatalog:[{...catalog[0],smallUnit:'ขวด'}],actor})).rejects.toMatchObject({code:'EXISTING_POS_CONTRACT_CHANGED'});
    const after=(await pool.query(`SELECT * FROM ${t('control')}`)).rows[0];
    expect(after.cutover_at).toEqual(before.cutover_at);expect(after.plan).toEqual(before.plan);expect(after.pos_catalog[0]).toEqual(before.pos_catalog[0]);
    expect((await read()).records[0].reservedQuantity).toBe(2);
  });
  test('conflicting units quarantine only that product without replacing its demand with zero',async()=>{
    await source();await open();await drain();await source('NEWORDER1',{old:false});await drain();
    await pool.query(`UPDATE ${t('lines')} SET unit='ขวด' WHERE order_number='NEWORDER1'`);
    expect(await ledger.projection(['P1','P2'])).toMatchObject({status:'partial',pageReviewProducts:1,
      records:[{availabilityStatus:'review_required',reservedQuantity:null,shippedUnpostedQuantity:null},{availabilityStatus:'available'}]});
  });
  test('a missing POS contract heals through the existing worker after verified append, never by replaying the opening',async()=>{
    await source();await open();await drain();const before=await read();
    ledger=createShopee004StockLedger({pool,schema,enabled:true,matchItem:(_shop,item)=>({...matchItem(),companySku:item.name==='Other'?'P2':'P1'})});
    await source('NEWORDER1',{old:false});await pool.query(`UPDATE "${schema}".shopee_orders SET items=$1 WHERE order_number='NEWORDER1'`,[JSON.stringify([{name:'Other',quantity:1}])]);await drain();
    expect((await read()).unallocatedOrders).toBe(1);
    await ledger.extendPosCatalog({posCatalog:[{...catalog[0],companySku:'P2',stockCode:'P2'}],actor});
    expect((await ledger.requeueResolvedMappings()).queuedOrders).toBe(1);await drain();
    const r=await ledger.projection(['P1','P2']);expect(r).toMatchObject({cutoverAt:before.cutoverAt,reviewOrders:0,unallocatedOrders:0,
      records:[{reservedQuantity:2},{reservedQuantity:1}]});
    expect((await ledger.requeueResolvedMappings()).queuedOrders).toBe(0);
  });
  test('cancel-first post-cutover mail is new but unapproved; the former unheld misclassification can heal safely',async()=>{
    await source();await open();await drain();await source('NEWCANCEL1',{old:false});
    await pool.query(`DELETE FROM "${schema}".shopee_order_events WHERE order_number='NEWCANCEL1'`);
    await pool.query(`UPDATE "${schema}".shopee_orders SET current_status='order_cancelled' WHERE order_number='NEWCANCEL1'`);
    await pool.query(`INSERT INTO "${schema}".shopee_order_events(shop_code,order_number,event_type,occurred_at) VALUES('sc-drug-store','NEWCANCEL1','order_cancelled',now())`);await drain();
    let p=(await pool.query(`SELECT * FROM ${t('positions')} WHERE order_number='NEWCANCEL1'`)).rows[0];
    expect(p).toMatchObject({eligibility:'new',state:'review_required',reasons:['cancel-dispatch-unverified','confirmation-missing']});
    await pool.query(`UPDATE ${t('positions')} SET eligibility='legacy',reasons='["legacy-arrival-needs-opening-review"]' WHERE order_number='NEWCANCEL1'`);
    expect((await ledger.requeueResolvedMappings()).queuedOrders).toBe(1);await drain();
    p=(await pool.query(`SELECT * FROM ${t('positions')} WHERE order_number='NEWCANCEL1'`)).rows[0];expect(p.eligibility).toBe('new');expect(p.state).toBe('review_required');
    expect((await pool.query(`SELECT count(*)::int n FROM ${t('reviews')}`)).rows[0].n).toBe(0);
    await ledger.review({operationId:randomUUID(),orderNumber:'NEWCANCEL1',kind:'cancel-before-dispatch',actor,physicalEvidenceVerified:true,notPostedInPos:true});await drain();
    expect(await read()).toMatchObject({status:'available',reviewOrders:0,records:[{reservedQuantity:2}]});
  });
  test('a source date correction cannot become new demand on a second retry, and any prior line blocks reclassification',async()=>{
    await source();await open();await drain();await source('LATEOLD01');await drain();
    await pool.query(`UPDATE "${schema}".shopee_orders SET ordered_at=now() WHERE order_number='LATEOLD01'`);await drain();
    expect((await ledger.requeueResolvedMappings()).queuedOrders).toBe(0);await drain();
    expect((await ledger.requeueResolvedMappings()).queuedOrders).toBe(0);
    await source('NEWCANCEL1',{old:false});await drain();
    await pool.query(`UPDATE ${t('positions')} SET eligibility='legacy',state='review_required',reasons='["legacy-arrival-needs-opening-review"]' WHERE order_number='NEWCANCEL1'`);
    expect((await ledger.requeueResolvedMappings()).queuedOrders).toBe(0);
    await pool.query(`UPDATE "${schema}".shopee_orders SET last_event_at=now() WHERE order_number='NEWCANCEL1'`);await drain();
    expect((await pool.query(`SELECT eligibility FROM ${t('positions')} WHERE order_number='NEWCANCEL1'`)).rows[0].eligibility).toBe('legacy');
    expect((await read()).records[0].reservedQuantity).toBe(4);
  });
  test('a truncated queue retains temporary quantities rather than falsely qualifying or hiding all products',async()=>{
    await source();await open();await drain();
    await pool.query(`INSERT INTO "${schema}".shopee_orders(shop_code,order_number,current_status,ordered_at,items,last_event_at)
      SELECT 'sc-drug-store','LIMIT'||lpad(n::text,5,'0'),'order_confirmed',now(),
      jsonb_build_array(jsonb_build_object('name','Synthetic','quantity',1)),now() FROM generate_series(1,101) n`);
    expect(await ledger.projection(['P2'])).toMatchObject({scopeValidated:true,pendingOrders:101,scopeScanLimited:true,unallocatedOrders:1,
      records:[{availabilityStatus:'known-commitments-only'}]});
  });
  function faultLedger({code='57014',target='OLDORDER1',beforeFailure,realTimeout=false}={}) {
    const faultPool={connect:async()=>{
      const c=await pool.connect();
      return {release:error=>c.release(error),query:async(text,values)=>{
        if(typeof text==='string'&&text.startsWith(`SELECT * FROM "${schema}".shopee_orders WHERE`)
          &&values?.[0]===target){
          if(beforeFailure)await beforeFailure();
          if(realTimeout){await c.query("SET LOCAL statement_timeout='5ms'");return c.query('SELECT pg_sleep(0.05)');}
          throw Object.assign(new Error('Synthetic provider exception must stay private'),{code});
        }
        return c.query(text,values);
      }};
    }};
    return createShopee004StockLedger({pool:faultPool,schema,enabled:true,matchItem});
  }
  test('a poison order is isolated; five durable transient attempts survive restart and do not starve other orders',async()=>{
    await source();await open();await source('SECOND002',{old:false});
    for(let i=1;i<=5;i++){
      await pool.query(`UPDATE ${t('dirty')} SET retry_after=now()-interval '1 second' WHERE order_number='OLDORDER1'`);
      expect(await faultLedger().processOne()).toBe(true);
      const dirty=(await pool.query(`SELECT attempt_count,recovery_state,last_error_code FROM ${t('dirty')} WHERE order_number='OLDORDER1'`)).rows[0];
      expect(dirty).toEqual({attempt_count:i,recovery_state:i===5?'blocked':'retry_wait',last_error_code:'PROCESSING_TIMEOUT'});
      if(i===1){expect(await faultLedger().processOne()).toBe(true);expect(await faultLedger().processOne()).toBe(false);}
    }
    expect(await faultLedger().processOne()).toBe(false);
    expect(await read()).toMatchObject({pendingOrders:1,recovery:{readyOrders:0,retryingOrders:0,blockedOrders:1},
      records:[{reservedQuantity:2,availabilityStatus:'review_required'}]});
    // A real source revision, rather than a retry loop, wakes the old work.
    await pool.query(`UPDATE "${schema}".shopee_orders SET last_event_at=now() WHERE order_number='OLDORDER1'`);
    await drain();expect(await read()).toMatchObject({pendingOrders:0,records:[{reservedQuantity:4,availabilityStatus:'available'}]});
  });
  test('a real PostgreSQL statement timeout rolls back one order and preserves held quantities',async()=>{
    await source();await open();await drain();const before=await read();
    await pool.query(`UPDATE "${schema}".shopee_orders SET last_event_at=now() WHERE order_number='OLDORDER1'`);
    expect(await faultLedger({realTimeout:true}).processOne()).toBe(true);
    expect(await read()).toMatchObject({cutoverAt:before.cutoverAt,pendingOrders:1,recovery:{retryingOrders:1},
      records:[{reservedQuantity:2,availabilityStatus:'review_required'}]});
    expect((await pool.query(`SELECT count(*)::int n FROM ${t('lines')}`)).rows[0].n).toBe(1);
    await pool.query(`UPDATE ${t('dirty')} SET retry_after=now()-interval '1 second'`);await drain();
    expect((await read()).records).toEqual(before.records);
  });
  test('a source revision committed during failure wakes once without losing the event or double reserving',async()=>{
    await source();await open();await drain();const before=await read();
    await pool.query(`UPDATE "${schema}".shopee_orders SET last_event_at=now() WHERE order_number='OLDORDER1'`);
    let selected,release;const selectedPromise=new Promise(resolve=>selected=resolve),resume=new Promise(resolve=>release=resolve);
    const processing=faultLedger({beforeFailure:async()=>{selected();await resume;}}).processOne();
    await selectedPromise;
    const ingestion=pool.query(`UPDATE "${schema}".shopee_orders SET last_event_at=now() WHERE order_number='OLDORDER1'`);
    release();await processing;await ingestion;await drain(createShopee004StockLedger({pool,schema,enabled:true,matchItem}));
    expect(await read()).toMatchObject({pendingOrders:0,cutoverAt:before.cutoverAt,records:before.records});
  });
  test('missing source is a durable semantic exception; read models expose only admin-scoped metadata',async()=>{
    await source();await open();await drain();await pool.query(`DELETE FROM "${schema}".shopee_orders WHERE order_number='OLDORDER1'`);
    expect(await ledger.processOne()).toBe(true);expect(await ledger.processOne()).toBe(false);
    const page=await ledger.exceptions();expect(page.records).toHaveLength(1);
    expect(page.records[0]).toMatchObject({reasonCode:'QUEUED_ORDER_MISSING',issueClass:'identity',canApproveMapping:false,
      recovery:{state:'blocked',attempts:1,nextRetryAt:null}});
    expect(JSON.stringify(page)).not.toContain('OLDORDER1');
    expect(page.records[0].exceptionId).toMatch(/^[0-9a-f-]{36}$/);
    const context=await ledger.exceptionContext({exceptionId:page.records[0].exceptionId,expectedRevision:page.records[0].revision});
    expect(context.orderNumber).toBe('OLDORDER1');
    await expect(ledger.exceptionContext({exceptionId:page.records[0].exceptionId,expectedRevision:'stale'}))
      .rejects.toMatchObject({code:'EXCEPTION_REVISION_CONFLICT'});
    expect(await ledger.reconciliation()).toMatchObject({openingBoundaryPreserved:true,reservedOrders:1,physicalStockVerified:false,automaticRebaseline:false,posWrites:false});
  });
  test('registry snapshot repair requeues semantic unit conflicts and leaves lifecycle evidence unapproved',async()=>{
    await source();await open();await drain();let valid=false;
    const changing=createShopee004StockLedger({pool,schema,enabled:true,mappingContextProvider:async()=>valid?matchItem:
      ()=>({status:'unmapped',reasonCode:'sale_unit_pos_mismatch'})});
    await source('NEWUNIT01',{old:false});await drain(changing);
    await pool.query(`INSERT INTO "${schema}".shopee_order_events(shop_code,order_number,event_type,occurred_at)
      VALUES('sc-drug-store','NEWUNIT01','order_cancelled',now())`);await drain(changing);
    valid=true;expect(await changing.requeueResolvedMappings()).toEqual({queuedOrders:1});await drain(changing);
    expect(await changing.requeueResolvedMappings()).toEqual({queuedOrders:0});
    const review=(await changing.exceptions()).records[0];
    expect(review).toMatchObject({reasonCode:'cancel-dispatch-unverified',requiresLifecycleReview:true,canApproveMapping:false});
    expect((await pool.query(`SELECT count(*)::int n FROM ${t('reviews')}`)).rows[0].n).toBe(0);
  });
  test('a mapping version cannot silently change an existing held multiplier or be approved by cancellation evidence',async()=>{
    await source();await open();await drain();const before=await read();
    const upgraded=createShopee004StockLedger({pool,schema,enabled:true,matchItem:()=>({status:'matched',companySku:'P1',quantityUnit:'sachet',
      quantityRuleStatus:'verified',quantityPerSale:2})});
    expect(await upgraded.requeueRuleAffected({productCodes:['P1']})).toMatchObject({queuedOrders:1});await drain(upgraded);
    expect(await read()).toMatchObject({cutoverAt:before.cutoverAt,records:[{reservedQuantity:2,availabilityStatus:'review_required'}]});
    expect((await upgraded.exceptions()).records[0].reasonCodes).toContain('mapping-held-contract-changed-needs-review');
    await expect(upgraded.review({operationId:randomUUID(),orderNumber:'OLDORDER1',kind:'cancel-before-dispatch',actor,
      physicalEvidenceVerified:true,notPostedInPos:true})).rejects.toMatchObject({code:'REVIEW_WOULD_LEAVE_UNVERIFIED_POSITION'});
    expect((await pool.query(`SELECT count(*)::int n FROM ${t('reviews')}`)).rows[0].n).toBe(0);
  });
  test('a verified shared alias reserves its canonical master once without modifying the opening',async()=>{
    await source();await open();await drain();const before=await read();
    const alias={...catalog[0],companySku:'ALIAS1',masterStockCode:'P1',masterActive:true,masterStockFactor:1,masterSmallFactor:1};
    expect(await ledger.extendPosCatalog({posCatalog:[...catalog,alias],actor})).toMatchObject({addedProducts:1,originalCutoverPreserved:true});
    await source('SHAREDT01',{old:false});
    const shared=createShopee004StockLedger({pool,schema,enabled:true,matchItem:()=>({status:'matched',companySku:'ALIAS1',quantityUnit:'ซอง'})});
    await drain(shared);expect(await read()).toMatchObject({cutoverAt:before.cutoverAt,pendingOrders:0,records:[{reservedQuantity:4,unit:'ซอง'}]});
    await pool.query(`UPDATE "${schema}".shopee_orders SET last_event_at=now() WHERE order_number='SHAREDT01'`);await drain(shared);
    expect((await read()).records[0].reservedQuantity).toBe(4);
  });
  test('a pending rule scan fences known products before any order is queued, then clears after completion',async()=>{
    await source();await open();await drain();const before=await read(),operation=randomUUID();
    await pool.query(`INSERT INTO "${schema}".shopee004_stock_identity_recovery_jobs(operation_id,identities,product_codes)
      VALUES($1,'[]','["P1"]')`,[operation]);
    expect(await read()).toMatchObject({status:'partial',pendingOrders:0,reviewOrders:0,pageReviewProducts:1,
      recovery:{pendingRuleJobs:1},cutoverAt:before.cutoverAt,
      records:[{availabilityStatus:'review_required',reservedQuantity:null,shippedUnpostedQuantity:null,unit:null}]});
    expect(await ledger.projection(['P2'])).toMatchObject({status:'available',pageReviewProducts:0,
      records:[{availabilityStatus:'available',reservedQuantity:0}]});
    await pool.query(`UPDATE "${schema}".shopee004_stock_identity_recovery_jobs SET completed=true WHERE operation_id=$1`,[operation]);
    expect(await read()).toMatchObject({status:'available',recovery:{pendingRuleJobs:0},cutoverAt:before.cutoverAt,records:before.records});
  });
  test('pending rule scans include a shared alias canonical master, while an empty metadata scope does not hide unrelated products',async()=>{
    await source();await open();await drain();
    const alias={...catalog[0],companySku:'ALIAS1',masterStockCode:'P1',masterActive:true,masterStockFactor:1,masterSmallFactor:1};
    await ledger.extendPosCatalog({posCatalog:[...catalog,alias],actor});
    await pool.query(`INSERT INTO "${schema}".shopee004_stock_identity_recovery_jobs(operation_id,identities,product_codes)
      VALUES($1,'[]','["ALIAS1"]')`,[randomUUID()]);
    expect(await read()).toMatchObject({status:'partial',records:[{availabilityStatus:'review_required',reservedQuantity:null}]});
    await pool.query(`UPDATE "${schema}".shopee004_stock_identity_recovery_jobs SET completed=true`);
    await pool.query(`INSERT INTO "${schema}".shopee004_stock_identity_recovery_jobs(operation_id,identities,product_codes)
      VALUES($1,'[]','[]')`,[randomUUID()]);
    expect(await read()).toMatchObject({status:'available',recovery:{pendingRuleJobs:1},records:[{availabilityStatus:'available',reservedQuantity:2}]});
  });
  test('multi-item exception and atomic approval context identify the actual failed item in the scoped mapper snapshot',async()=>{
    await source();await open();await drain();await source('MULTIITEM1',{old:false});
    await pool.query(`UPDATE "${schema}".shopee_orders SET items=$1 WHERE order_number='MULTIITEM1'`,[JSON.stringify([
      {name:'Synthetic valid first',variant:'box',quantity:1},{name:'Synthetic blocked second',variant:'new pack',quantity:2},
      {name:'Synthetic blocked second',variant:'new pack',quantity:1}])]);
    const scoped=createShopee004StockLedger({pool,schema,enabled:true,mappingContextProvider:async()=>
      (_shop,item)=>item.name==='Synthetic blocked second'?{status:'unmapped'}:matchItem()});
    await drain(scoped);const page=await scoped.exceptions();expect(page.records).toHaveLength(1);
    expect(page.records[0]).toMatchObject({productName:'Synthetic blocked second',variantName:'new pack',
      canApproveMapping:true,itemContext:'current-issue',itemIssueConfirmed:true,unresolvedItemCount:1});
    expect(JSON.stringify(page)).not.toContain('MULTIITEM1');
    const context=await scoped.exceptionContext({exceptionId:page.records[0].exceptionId,expectedRevision:page.records[0].revision});
    expect(context.record.productName).toBe('Synthetic blocked second');
    expect(context.items).toHaveLength(3);expect((await read()).cutoverAt).toBe((await scoped.projection(['P1'])).cutoverAt);
  });
});
