'use strict';
// Real receipt fixtures are local ignored evidence, never bundled in source.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{Pool}=require('pg');
const {build}=require('../lib/sccrmReceiptRecoverySql');
async function run(){
 const u=new URL(process.env.SCCRM_RECOVERY_TEST_DATABASE_URL||'');
 assert(['127.0.0.1','localhost'].includes(u.hostname)&&u.port!=='5432'&&/^\/crm_history_first_test_real8_/.test(u.pathname),'Dedicated loopback copy required');
 const root=path.resolve(process.env.SCCRM_RECOVERY_FIXTURES||'');
 const before=JSON.parse(fs.readFileSync(path.join(root,'recovery-pg-before.json'))),packets=JSON.parse(fs.readFileSync(path.join(root,'recovery-packets.json')));
 assert.equal(before.cases.length,8);assert.equal(packets.length,8);
 const db=new Pool({connectionString:u.toString(),ssl:false});
 try{
  assert.equal(Number((await db.query('SELECT count(*) n FROM loyalty_claims WHERE id=ANY($1::text[])',[packets.map(p=>p.claimId)])).rows[0].n),0,'Fresh fixture scope required');
  let phone=0;const seedUser=async id=>db.query('INSERT INTO users(id,full_name,phone_number)VALUES($1,$2,$3)ON CONFLICT(id)DO NOTHING',[id,'Isolated copied member','09988'+String(++phone).padStart(5,'0')]);
  const insert=async(table,rows)=>{for(const row of rows)await db.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table},$1::jsonb)`,[row]);};
  for(const b of before.cases){
   await seedUser(b.claim.user_id);
   await db.query('INSERT INTO member_profiles(user_id,member_code)VALUES($1,$2)',[b.claim.user_id,b.member_code]);
   await insert('loyalty_claims',[b.claim]);await insert('loyalty_claim_items',b.items);
   await insert('sccrm_receipt_sync.jobs',[b.job]);await insert('sccrm_receipt_sync.native_deliveries',b.deliveries.map(d=>({...d,revision:1})));
   for(const m of b.mirrors){await insert('crm_pos_sale_events',[m.header]);await insert('crm_pos_sale_line_events',m.items);}
  }
  for(const point of before.points){await seedUser(point.user_id);await insert('point_ledger',[point]);}
  const points=async()=>(await db.query('SELECT * FROM point_ledger ORDER BY id')).rows;
  const pointBefore=await points(),count=Number((await db.query('SELECT count(*) n FROM loyalty_claims')).rows[0].n),results=[];
  for(const b of before.cases){const p=packets.find(p=>p.claimId===b.claim.id),sql=build(b,p);
   fs.writeFileSync(path.join(root,'recover-'+p.receiptNo+'.sql'),sql);
   const c=await db.connect();try{await c.query(sql);await c.query(sql);}finally{c.release();}
   const cl=(await db.query('SELECT * FROM loyalty_claims WHERE id=$1',[p.claimId])).rows[0];
   assert.equal(cl.user_id,p.memberId);assert.equal(Number(cl.receipt_total_amount),p.finalSnapshot.totalAmount);assert.deepEqual(cl.receipt_snapshot,p.finalSnapshot);
   const saved=(await db.query('SELECT * FROM loyalty_claim_items WHERE claim_id=$1',[p.claimId])).rows;
   assert.equal(saved.length,p.finalSnapshot.items.length);
   for(const i of b.items){const actual=saved.find(s=>s.id===i.id);assert(actual);for(const key of ['product_code','product_name','qty','unit_price','line_total'])assert.equal(['qty','unit_price','line_total'].includes(key)?Number(actual[key]):actual[key],['qty','unit_price','line_total'].includes(key)?Number(i[key]):i[key]);}
   const ds=(await db.query('SELECT * FROM sccrm_receipt_sync.native_deliveries WHERE parent_id=$1 ORDER BY revision,target_branch',[b.job.id])).rows;
   assert.equal(ds.length,4);for(const old of b.deliveries){const actual=ds.find(d=>d.id===old.id);assert.deepEqual(actual.payload,old.payload);assert.equal(actual.payload_hash,old.payload_hash);assert.equal(actual.state,'review');}
   assert(ds.filter(d=>d.revision===2).every(d=>d.state==='pending'&&d.payload.totalAmount===p.finalSnapshot.totalAmount));
   const audit=(await db.query('SELECT * FROM sccrm_receipt_sync.final_revisions WHERE claim_id=$1',[p.claimId])).rows;
   assert.equal(audit.length,1);assert.deepEqual(audit[0].original_claim.receipt_snapshot,p.originalSnapshot);
   results.push({doc:p.receiptNo,appendedLines:p.finalSnapshot.items.length-p.originalSnapshot.items.length,total:p.finalSnapshot.totalAmount,replayedWithoutDuplicate:true});
  }
  assert.deepEqual(await points(),pointBefore);assert.equal(Number((await db.query('SELECT count(*) n FROM loyalty_claims')).rows[0].n),count);
  const proof={ok:true,results,pointRowsUnchanged:pointBefore.length,noNewClaims:true,originalItemIdsAndPayloadsRetained:true,productionWrites:0};
  fs.writeFileSync(path.join(root,'recovery-pg-copy-proof.json'),JSON.stringify(proof,null,2));return proof;
 }finally{await db.end();}
}
if(require.main===module)run().then(x=>console.log(JSON.stringify(x))).catch(e=>{console.log(JSON.stringify({ok:false,type:e.name,error:e.message}));process.exitCode=1;});
module.exports={run};
