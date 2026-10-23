const {Pool}=require('pg');
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {createShopee004StockLedger}=require('../src/modules/seamless/services/shopee004StockLedger');
const {createShopee004IdentityStore}=require('../src/modules/seamless/services/shopee004IdentityStore');
const url=process.env.SHOPEE004_TEST_DATABASE_URL,run=url?describe:describe.skip;
run('identity administration uses the existing ledger in isolated PostgreSQL only',()=>{
 let pool,schema,ledger,store,proofs,components,context;
 const t=name=>`"${schema}".shopee004_stock_${name}`;
 beforeAll(()=>{pool=new Pool({connectionString:url,max:4});});
 beforeEach(async()=>{
  schema='identity_test_'+randomUUID().replaceAll('-','');const c=await pool.connect();
  try{
   await c.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}",public;
    CREATE TABLE shopee_orders(shop_code text,order_number text,current_status text,ordered_at timestamptz,items jsonb,last_event_at timestamptz,PRIMARY KEY(shop_code,order_number));
    CREATE TABLE shopee_order_events(id bigserial PRIMARY KEY,shop_code text,order_number text,event_type text,occurred_at timestamptz,created_at timestamptz DEFAULT now());`);
   for(const file of ['034_shopee004_durable_stock_commitments.sql','035_shopee004_stock_recovery_identity.sql']){const sql=fs.readFileSync(path.join(__dirname,'../src/modules/seamless/db/migrations',file),'utf8');await c.query(sql);await c.query(sql);}
  }finally{c.release();}
  store=createShopee004IdentityStore({pool,schema,ledger:()=>ledger});
  ledger=createShopee004StockLedger({pool,schema,enabled:true,mappingContextProvider:store.mappingContextProvider});
  const plan=await ledger.prepare({posCatalog:[{companySku:'SYNTH-P1',productName:'Synthetic POS sachet',stockCode:'SYNTH-P1',stockFactor:1,smallFactor:1,active:true,smallUnit:'ซอง'}],openingOrderNumbers:[],actor:'synthetic-admin'});
  await ledger.activate({planId:plan.planId,actor:'synthetic-admin',openingOrdersVerified:true,olderShippedReconciledInPosBasis:true,emailFeedChecked:true,unpostedPosWorkflow:true});
  const date=(await pool.query('SELECT clock_timestamp() AS at')).rows[0].at;
  const items=[{name:'Synthetic previously unknown product',variant:'one sachet',quantity:2,listingProductId:'LISTING-1',listingVariationId:'VARIANT-1'}];
  await pool.query(`INSERT INTO "${schema}".shopee_orders VALUES('sc-drug-store','SYNTHETIC01','order_confirmed',$1,$2,$1)`,[date,JSON.stringify(items)]);
  await pool.query(`INSERT INTO "${schema}".shopee_order_events(shop_code,order_number,event_type,occurred_at) VALUES('sc-drug-store','SYNTHETIC01','order_confirmed',$1)`,[date]);
  await ledger.processOne();
  components=[{productCode:'SYNTH-P1',quantityPerSale:1,unit:'ซอง'}];
  const common={shopCode:'sc-drug-store',branchCode:'004',listingId:'LISTING-1',variationId:'VARIANT-1',observedAt:date.toISOString()};
  const aliases=[{productName:items[0].name,variantName:items[0].variant}];
  proofs=[{...common,reference:randomUUID(),kind:'seller_catalog',catalogVersion:'catalog-1',sourceSkus:[],aliases},
   {...common,reference:randomUUID(),kind:'owner_unit',aliases,components},
   {...common,reference:randomUUID(),kind:'pos_unit',productCode:'SYNTH-P1',unit:'ซอง',stockCode:'SYNTH-P1',stockFactor:1,smallFactor:1}];
  context=(await ledger.exceptions({})).records[0];
 });
 afterEach(async()=>{await pool.query(`DROP SCHEMA "${schema}" CASCADE`);});
 afterAll(async()=>{await pool.end();});
 const approve=extra=>store.approveMapping({operationId:randomUUID(),exceptionId:context.exceptionId,expectedRevision:context.revision,listingId:'LISTING-1',variationId:'VARIANT-1',components,evidenceRefs:proofs.map(p=>p.reference),acknowledgeUnitEvidence:true,actor:'synthetic-admin',...extra});
 async function importProofs(){await store.importEvidence({facts:proofs,humanEvidenceVerified:true,actor:'synthetic-admin'});}
 async function settle(){for(let i=0;i<20;i++){await store.drainRecovery();while(await ledger.processOne()){};const jobs=(await pool.query(`SELECT count(*)::int n FROM ${t('identity_recovery_jobs')} WHERE NOT completed`)).rows[0].n;if(!jobs)break;}}
 const control=async()=>(await pool.query(`SELECT cutover_at,plan,pos_catalog FROM ${t('control')}`)).rows[0];
 test('caller-created references alone never approve a mapping or release a held quantity',async()=>{
  await expect(approve()).rejects.toMatchObject({code:'IDENTITY_EVIDENCE_SCOPE_CONFLICT'});
  expect((await pool.query(`SELECT count(*)::int n FROM ${t('identity_rule_versions')}`)).rows[0].n).toBe(0);
 });
 test('readonly exception enrichment works and supplies only independently verified proof',async()=>{
  await importProofs();const q=await store.exceptions({});expect(q.records).toHaveLength(1);expect(q.records[0].canApproveMapping).toBe(true);
  expect(q.records[0].proposedMatches[0]).toMatchObject({productCode:'SYNTH-P1',quantityPerSale:1,unit:'ซอง'});
  expect(JSON.stringify(q)).not.toMatch(/SYNTHETIC01|order_number|source_snapshot/);
 });
 test('missing POS unit proof never enables a candidate approval button',async()=>{
  await store.importEvidence({facts:proofs.slice(0,2),humanEvidenceVerified:true,actor:'synthetic-admin'});
  const q=await store.exceptions({});expect(q.records[0].canApproveMapping).toBe(false);
 });
 test('proactive catalog approval requires no order exception and remains a metadata-only idempotent operation',async()=>{
  await importProofs();const before=await control(),operationId=randomUUID();
  const input={operationId,listingId:'LISTING-1',variationId:'VARIANT-1',components,evidenceRefs:proofs.map(p=>p.reference),expectedVersion:0,expectedCatalogVersion:'catalog-1',acknowledgeUnitEvidence:true,actor:'synthetic-admin'};
  const r=await store.approveCatalogMapping(input);expect(r).toMatchObject({recorded:true,ruleVersion:1,requeuePending:true});expect(await store.approveCatalogMapping(input)).toMatchObject({duplicate:true});
  await settle();expect((await ledger.projection(['SYNTH-P1'])).records[0].reservedQuantity).toBe(2);expect(await control()).toEqual(before);
  expect((await pool.query(`SELECT count(*)::int n FROM ${t('reviews')}`)).rows[0].n).toBe(0);
 });
 test('malformed imported proof is rejected before any facts or recovery jobs are committed',async()=>{
  await expect(store.importEvidence({facts:[proofs[0],{...proofs[1],aliases:'bad'}],humanEvidenceVerified:true,actor:'synthetic-admin'})).rejects.toMatchObject({code:'TRUSTED_EVIDENCE_IMPORT_INVALID'});
  expect((await pool.query(`SELECT count(*)::int n FROM ${t('identity_evidence')}`)).rows[0].n).toBe(0);
 });
 test('the second failed item is shown and approved; an already-mapped first item cannot substitute for it',async()=>{
  await importProofs();await approve();await settle();
  const at=new Date(),first={name:'Synthetic previously unknown product',variant:'one sachet',quantity:1,listingProductId:'LISTING-1',listingVariationId:'VARIANT-1'},second={name:'Synthetic second product',variant:'one sachet',quantity:1,listingProductId:'LISTING-2',listingVariationId:'VARIANT-2'};
  await pool.query(`INSERT INTO "${schema}".shopee_orders VALUES('sc-drug-store','SYNTHETIC02','order_confirmed',$1,$2,$1)`,[at,JSON.stringify([first,second])]);
  await pool.query(`INSERT INTO "${schema}".shopee_order_events(shop_code,order_number,event_type,occurred_at) VALUES('sc-drug-store','SYNTHETIC02','order_confirmed',$1)`,[at]);await ledger.processOne();
  const nextProofs=proofs.map(p=>({...p,reference:randomUUID(),listingId:'LISTING-2',variationId:'VARIANT-2',...(p.aliases?{aliases:[{productName:second.name,variantName:second.variant}]}:{})}));
  await store.importEvidence({facts:nextProofs,humanEvidenceVerified:true,actor:'synthetic-admin'});
  context=(await store.exceptions({})).records.find(r=>r.productName===second.name);expect(context).toMatchObject({itemContext:'current-issue',itemIssueConfirmed:true,canApproveMapping:true});
  await expect(approve()).rejects.toMatchObject({code:'IDENTITY_EXCEPTION_TARGET_CONFLICT'});
  await approve({listingId:'LISTING-2',variationId:'VARIANT-2',evidenceRefs:nextProofs.map(p=>p.reference)});await settle();
  expect((await ledger.projection(['SYNTH-P1'])).records[0].reservedQuantity).toBe(4);
 });
 test('duplicate lines for the same evidenced variant do not make a mapping approval ambiguous',async()=>{
  const at=new Date(),item={name:'Synthetic previously unknown product',variant:'one sachet',quantity:1,listingProductId:'LISTING-1',listingVariationId:'VARIANT-1'};
  await pool.query(`INSERT INTO "${schema}".shopee_orders VALUES('sc-drug-store','SYNTHETIC02','order_confirmed',$1,$2,$1)`,[at,JSON.stringify([item,item])]);
  await pool.query(`INSERT INTO "${schema}".shopee_order_events(shop_code,order_number,event_type,occurred_at) VALUES('sc-drug-store','SYNTHETIC02','order_confirmed',$1)`,[at]);await ledger.processOne();await importProofs();
  context=(await store.exceptions({})).records.find(r=>r.itemCount===2);expect(context.canApproveMapping).toBe(true);await approve();await settle();
  expect((await ledger.projection(['SYNTH-P1'])).records[0].reservedQuantity).toBe(4);
 });
 test('background serialization conflicts keep bounded transient retry semantics without retrying a human approval',async()=>{
  await importProofs();let once=true;
  const busyPool={connect:async()=>{const c=await pool.connect();return {query:async(sql,...args)=>{if(once&&String(sql).includes('FOR UPDATE SKIP LOCKED')){once=false;throw Object.assign(Error('synthetic serialization conflict'),{code:'40001'});}return c.query(sql,...args);},release:(...args)=>c.release(...args)};}};
  const busyStore=createShopee004IdentityStore({pool:busyPool,schema,ledger:()=>ledger});let failure;
  try{await busyStore.drainRecovery();}catch(e){failure=e;}
  expect(failure).toMatchObject({code:'40001'});const {nextRecovery}=require('../src/modules/seamless/services/shopee004RecoveryPolicy');
  expect(nextRecovery({error:failure,now:new Date(0)})).toMatchObject({retryable:true,retryAfter:'1970-01-01T00:00:02.000Z'});
  await expect(busyStore.drainRecovery()).resolves.toHaveProperty('queuedOrders');
 });
 test('same-content catalog refresh keeps old binding while conflicting POS observations fence it without rewriting metadata',async()=>{
  await importProofs();await approve();await settle();const before=await control();
  await store.importEvidence({facts:[{...proofs[0],reference:randomUUID(),catalogVersion:'catalog-2',observedAt:new Date(Date.now()+1).toISOString()}],humanEvidenceVerified:true,actor:'synthetic-admin'});await settle();
  expect((await ledger.projection(['SYNTH-P1'])).records[0].availabilityStatus).toBe('available');
  await store.importEvidence({facts:[{...proofs[2],reference:randomUUID(),unit:'กล่อง',observedAt:new Date(Date.now()+2).toISOString()}],humanEvidenceVerified:true,actor:'synthetic-admin'});await settle();
  expect((await ledger.projection(['SYNTH-P1'])).records[0].availabilityStatus).toBe('review_required');expect(await control()).toEqual(before);
 });
 test('mapping approval reprocesses safely through the original worker; repeated approval/events/restart never double debit',async()=>{
  const before=await control();await importProofs();const operationId=randomUUID(),first=await approve({operationId});expect(first).toMatchObject({recorded:true,ruleVersion:1,requeuePending:true});
  expect(await approve({operationId})).toMatchObject({duplicate:true,ruleId:first.ruleId});
  await settle();expect((await ledger.projection(['SYNTH-P1'])).records[0]).toMatchObject({reservedQuantity:2,shippedUnpostedQuantity:0});
  ledger=createShopee004StockLedger({pool,schema,enabled:true,mappingContextProvider:store.mappingContextProvider});
  await pool.query(`INSERT INTO "${schema}".shopee_order_events(shop_code,order_number,event_type,occurred_at) SELECT shop_code,order_number,'order_confirmed',ordered_at FROM "${schema}".shopee_orders`);
  await settle();expect((await ledger.projection(['SYNTH-P1'])).records[0].reservedQuantity).toBe(2);expect(await control()).toEqual(before);
  expect((await pool.query(`SELECT count(*)::int n FROM ${t('reviews')}`)).rows[0].n).toBe(0);
 });
 test('operation reuse with altered components fails rather than becoming a second approval',async()=>{
  await importProofs();const operationId=randomUUID();await approve({operationId});await expect(approve({operationId,components:[{...components[0],quantityPerSale:2}]})).rejects.toMatchObject({code:'IDENTITY_IDEMPOTENCY_CONFLICT'});
 });
 test('unit evidence conflict or stale exception revision cannot be approved',async()=>{
  await importProofs();await expect(approve({components:[{...components[0],quantityPerSale:2}]})).rejects.toMatchObject({statusCode:409});
  await expect(approve({expectedRevision:'stale'})).rejects.toMatchObject({code:'EXCEPTION_REVISION_CONFLICT'});
 });
 test('rule revocation fences pending scope immediately and retains the old hold after recovery',async()=>{
  await importProofs();const first=await approve();await settle();const before=await control();
  const operationId=randomUUID(),result=await store.revoke({operationId,ruleId:first.ruleId,expectedVersion:1,reason:'mapping_incorrect',actor:'synthetic-admin'});expect(result.ruleVersion).toBe(2);
  const pending=await ledger.projection(['SYNTH-P1']);expect(pending.records[0].availabilityStatus).toBe('review_required');
  await settle();expect((await ledger.projection(['SYNTH-P1'])).records[0].availabilityStatus).toBe('review_required');
  expect((await pool.query(`SELECT reserved_quantity FROM ${t('lines')}`)).rows[0].reserved_quantity).toBe('2');expect(await control()).toEqual(before);
  expect(await store.revoke({operationId,ruleId:first.ruleId,expectedVersion:1,reason:'mapping_incorrect',actor:'synthetic-admin'})).toMatchObject({duplicate:true});
 });
 test('new catalog identity/pack evidence creates a durable recovery cursor without changing source orders or opening',async()=>{
  await importProofs();await approve();await settle();const before=await control();
  await store.importEvidence({facts:[{...proofs[0],reference:randomUUID(),catalogVersion:'catalog-2',observedAt:new Date(Date.now()+1).toISOString(),aliases:[{productName:'Changed pack',variantName:'new box'}]}],humanEvidenceVerified:true,actor:'synthetic-admin'});
  const pending=await ledger.projection(['SYNTH-P1']);expect(pending.records[0].availabilityStatus).toBe('review_required');await settle();
  expect((await ledger.projection(['SYNTH-P1'])).records[0].availabilityStatus).toBe('review_required');expect(await control()).toEqual(before);
 });
});
