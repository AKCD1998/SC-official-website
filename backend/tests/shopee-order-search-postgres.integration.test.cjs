jest.mock('../db',()=>({query:jest.fn(),connect:jest.fn()}));
const {Pool}=require('pg');
const {randomUUID}=require('node:crypto');
const db=require('../db');
const repository=require('../src/modules/seamless/db/shopeeOrderRepository');
const {liveOrderRelation}=require('../src/modules/seamless/services/shopeeOrderObservationService');
const {getTables}=require('../src/modules/seamless/tables');
const catalog=require('../src/modules/seamless/data/shopeeProductCatalog.v1.json');
const run=process.env.SHOPEE004_TEST_DATABASE_URL?describe:describe.skip;
run('SKU search SQL parity in isolated local PostgreSQL',()=>{
 let pool,schema,oldSchema,readOnlyObserved=[];
 const sc='sc-drug-store',dr='dr-morepen';
 const record=catalog.records.find(r=>r.shopCode===sc&&r.sourceRow===33);
 const item={name:record.productName,variant:record.variant,quantity:1,unitPrice:20};
 beforeAll(async()=>{
  const url=process.env.SHOPEE004_TEST_DATABASE_URL;
  if(!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))throw Error('REFUSING_NON_LOCAL_TEST_DATABASE');
  pool=new Pool({connectionString:url,max:3});schema='sku_search_'+randomUUID().replaceAll('-','')+'_test';
  oldSchema=process.env.SEAMLESS_DB_SCHEMA;process.env.SEAMLESS_DB_SCHEMA=schema;
  await pool.query(`CREATE SCHEMA "${schema}";
   CREATE TABLE "${schema}".shopee_orders(shop_code text,order_number text,current_status text,delivery_method text,
    first_event_at timestamptz,last_event_at timestamptz,ordered_at timestamptz,shipping_deadline date,
    item_count integer,total_quantity numeric,items jsonb,item_subtotal numeric,shipping_fee numeric,total_amount numeric,
    PRIMARY KEY(shop_code,order_number));
   CREATE TABLE "${schema}".shopee_live_orders(shop_code text,order_number text,internal_order_id text,snapshot jsonb,first_observed_at timestamptz,PRIMARY KEY(shop_code,order_number));
   CREATE TABLE "${schema}".shopee_order_events(shop_code text,order_number text);
   CREATE TABLE "${schema}".shopee_sales_sources(shop_code text,source_sha256 text,observed_at timestamptz,source_filename text,PRIMARY KEY(shop_code,source_sha256));
   CREATE TABLE "${schema}".shopee_sales_order_facts(shop_code text,order_number text,source_sha256 text,items jsonb,item_subtotal numeric,ordered_at timestamptz,paid_at timestamptz,
    PRIMARY KEY(shop_code,source_sha256,order_number));
   CREATE INDEX ON "${schema}".shopee_sales_order_facts(shop_code,order_number);`);
  db.query.mockImplementation((...args)=>pool.query(...args));
  db.connect.mockImplementation(async()=>{const c=await pool.connect();return{release:e=>c.release(e),query:async(...args)=>{
   const result=await c.query(...args);if(String(args[0]).startsWith('BEGIN'))readOnlyObserved.push((await c.query("SHOW transaction_read_only")).rows[0].transaction_read_only);return result;
  }};});
  async function email(shop,order,items){await pool.query(`INSERT INTO "${schema}".shopee_orders VALUES($1,$2,'shipment_due','normal',
   '2026-09-01T01:00Z','2026-09-01T02:00Z','2026-09-01T01:00Z','2026-09-10',1,1,$3,20,10,30)`,[shop,order,JSON.stringify(items)]);}
  await email(sc,'EMAIL0001',[item]);await email(sc,'PACK24001',[{name:'กัมมี่ รุ่นใหม่ Vita-C',variant:'24 ซอง',quantity:1,unitPrice:20}]);
  await email(sc,'RAWCODE01',[{name:'ＩＣ－００１８４９ test',variant:'unmapped',quantity:1,unitPrice:20}]);
  await email(dr,'PACK24001',[{name:'กัมมี่ รุ่นใหม่ Vita-C',variant:'24 ซอง',quantity:1,unitPrice:20}]);
  for(const[hash,date]of[['a','2026-09-01T03:00Z'],['b','2026-09-02T03:00Z'],['c','2026-09-03T03:00Z']])await pool.query(`INSERT INTO "${schema}".shopee_sales_sources VALUES($1,$2,$3,$4)`,[sc,hash.repeat(64),date,hash+'.xlsx']);
  for(const order of ['EMAIL0001','OFFICIAL01'])for(const hash of ['a','b','c'])await pool.query(`INSERT INTO "${schema}".shopee_sales_order_facts VALUES($1,$2,$3,$4,20,'2026-09-01T01:00Z',$5)`,[sc,order,hash.repeat(64),JSON.stringify([item]),hash==='c'?null:'2026-09-01T01:05Z']);
  await pool.query(`INSERT INTO "${schema}".shopee_live_orders VALUES($1,'LIVE00001','12345678','{"payment":{"value":"unpaid"}}','2026-09-01T00:00Z')`,[sc]);
 });
 afterAll(async()=>{
  if(pool){await pool.query(`DROP SCHEMA "${schema}" CASCADE`);await pool.end();}
  if(oldSchema===undefined)delete process.env.SEAMLESS_DB_SCHEMA;else process.env.SEAMLESS_DB_SCHEMA=oldSchema;
 });
 const aliases=[{productName:'กัมมี่ รุ่นใหม่ Vita-C',variantName:'24 ซอง'}];
 test('email, live-only and official-only rows retain their original typed shape and latest non-null payment proof',async()=>{
  const table=getTables();const {rows}=await pool.query(`SELECT * FROM ${liveOrderRelation(table)} o WHERE shop_code=$1 ORDER BY order_number`,[sc]);
  expect(rows).toHaveLength(5);
  const live=rows.find(r=>r.order_number==='LIVE00001');expect(live.current_status).toBe('seller_center');expect(live.items).toEqual([]);expect(live.item_subtotal).toBeNull();
  const official=rows.find(r=>r.order_number==='OFFICIAL01');expect(official.current_status).toBe('official_report');expect(official.items).toEqual([item]);expect(Number(official.total_quantity)).toBe(1);
  for(const r of rows.filter(r=>['EMAIL0001','OFFICIAL01'].includes(r.order_number)))expect(r.official_payment.sourceFilename).toBe('b.xlsx');
 });
 test.each(['sc-drug-store','all'])('full filtering, sorting, counts and pagination preserve the baseline for %s',async(shopCode)=>{
  const tables=getTables(),scope=shopCode==='all'?[sc,dr]:[sc];
  const rows=(await pool.query(`SELECT o.*,0::bigint event_count FROM ${liveOrderRelation(tables)} o WHERE shop_code=ANY($1::text[])`,[scope])).rows;
  const baseline=rows.map(repository.mapOrder).filter(o=>repository.buildShopeeOrderSearchText(o).includes('ic-001849')||(o.shopCode===sc&&o.items.some(i=>i.name===aliases[0].productName&&i.variant===aliases[0].variantName))).sort((a,b)=>a.orderNumber.localeCompare(b.orderNumber));
  const first=await repository.listOrders({shopCode,search:'IC-001849',stockSearchAliases:aliases,page:1,limit:2,sortBy:'orderNumber',sortOrder:'asc'});
  const second=await repository.listOrders({shopCode,search:'ic-001849',stockSearchAliases:aliases,page:2,limit:2,sortBy:'orderNumber',sortOrder:'asc'});
  expect([...first.orders,...second.orders]).toEqual(baseline);expect(first.totalCount).toBe(4);expect(second.totalCount).toBe(4);expect(first.hasMore).toBe(true);expect(second.hasMore).toBe(false);
  expect(readOnlyObserved.every(v=>v==='on')).toBe(true);
 });
 test('status filters and unknown SKU counts remain honest',async()=>{
  const result=await repository.listOrders({shopCode:sc,search:'IC-001849',status:'official_report',page:1,stockSearchAliases:aliases});
  expect(result.totalCount).toBe(1);expect(result.orders[0].orderNumber).toBe('OFFICIAL01');
  const absent=await repository.listOrders({shopCode:sc,search:'IC-999999',page:1});expect(absent).toMatchObject({orders:[],totalCount:0,hasMore:false});
 });
 test('recursive report keys handle an empty report history without losing email or live-only orders',async()=>{
  const c=await pool.connect();
  try {
   await c.query('BEGIN');await c.query(`DELETE FROM "${schema}".shopee_sales_order_facts`);
   const rows=(await c.query(`SELECT * FROM ${liveOrderRelation(getTables())} o WHERE shop_code=$1`,[sc])).rows;
   expect(rows.map(r=>r.order_number).sort()).toEqual(['EMAIL0001','LIVE00001','PACK24001','RAWCODE01']);
  } finally { await c.query('ROLLBACK');c.release(); }
 });
 test('latest official-only payload stays scoped by shop across repeated versions',async()=>{
  const c=await pool.connect();
  try {
   await c.query('BEGIN');
   await c.query(`INSERT INTO "${schema}".shopee_sales_sources VALUES($1,$2,'2026-09-05T03:00Z','dr.xlsx')`,[dr,'d'.repeat(64)]);
   await c.query(`INSERT INTO "${schema}".shopee_sales_order_facts VALUES($1,'OFFICIAL01',$2,'[]',99,'2026-09-04T01:00Z',null)`,[dr,'d'.repeat(64)]);
   await c.query(`UPDATE "${schema}".shopee_sales_order_facts SET item_subtotal=42 WHERE source_sha256=$1`,['c'.repeat(64)]);
   const rows=(await c.query(`SELECT * FROM ${liveOrderRelation(getTables())} o WHERE order_number='OFFICIAL01' ORDER BY shop_code`)).rows;
   expect(rows.map(r=>[r.shop_code,Number(r.item_subtotal)])).toEqual([[dr,99],[sc,42]]);
   expect(rows[0].official_payment).toBeNull();expect(rows[1].official_payment.sourceFilename).toBe('b.xlsx');
  } finally { await c.query('ROLLBACK');c.release(); }
 });
});
