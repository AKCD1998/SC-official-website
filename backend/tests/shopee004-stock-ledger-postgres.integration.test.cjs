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
  test('late historical orders are not new deductions; explicit baseline review resolves uncertainty', async () => {
    await source(); await open(); await drain(); await source('LATEOLD01'); await drain();
    expect(await read()).toMatchObject({ status: 'review-or-processing-required', reviewOrders: 1, records: [{ reservedQuantity: 2 }] });
    await ledger.review({ operationId: randomUUID(),orderNumber:'LATEOLD01',kind:'legacy-in-baseline',actor,physicalEvidenceVerified:true,notPostedInPos:true });
    await drain(); expect((await read()).status).toBe('available');
  });
  test('new post-cutover orders reserve once, other shops are not queued', async () => {
    await source(); await open(); await drain(); await source('NEWORDER1',{old:false}); await source('OTHERSHOP',{old:false,shop:'dr-morepen'});
    await drain(); expect((await read()).records[0].reservedQuantity).toBe(4);
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
    await expect(broken.processOne()).rejects.toMatchObject({code:'LEDGER_OPERATION_FAILED'});
    expect((await read()).pendingOrders).toBe(1);await drain();expect((await read()).status).toBe('available');
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
    await expect(ledger.processOne()).rejects.toMatchObject({code:'QUEUED_ORDER_MISSING'});
    expect(await read()).toMatchObject({status:'review-or-processing-required',pendingOrders:1,records:[{reservedQuantity:2}]});
  });
});
