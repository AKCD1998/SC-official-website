'use strict';
// Input is a private, reviewed plan. Never commit real customers or source images.
const fs=require('node:fs'),{randomUUID}=require('node:crypto');
const model=require('../lib/memberPreorderModel');
const {createCatalog}=require('../lib/memberPreorderCatalog');
async function importPlan(plan,{db,apply=false,catalog=createCatalog(),actor='operator:preorder-paper-import'}={}){
 if(!plan||!/^sha256:[a-f0-9]{64}$/.test(plan.source?.reference)||!Array.isArray(plan.entries)||!plan.entries.length||plan.entries.length>100)throw Error('Invalid reviewed import plan');
 const label=model.text(plan.source.label,255,true),seen=new Set(),prepared=[];
 for(const entry of plan.entries){
  const memberId=model.id(entry.memberId),row=entry.sourceRow;
  if(!Number.isInteger(row)||row<1||seen.has(memberId+'|'+row))throw Error('Duplicate or invalid source row');seen.add(memberId+'|'+row);
  const existing=(await db.query('SELECT u.remark,m.member_code FROM public.users u JOIN public.member_profiles m ON m.user_id=u.id WHERE u.id=$1',[memberId])).rows[0];
  if(!existing||existing.member_code!==entry.memberCode||!entry.expectedSourceMarker||!String(existing.remark||'').includes(entry.expectedSourceMarker))throw Error('Member/code/source proof mismatch at row '+row);
  const value=model.draft({...entry.history,sourceReference:label});value.items=await catalog.validate(value.items);
  prepared.push({memberId,row,value});
 }
 const summary={ok:true,mode:apply?'apply':'plan',source:plan.source.reference,members:prepared.length,items:prepared.reduce((n,r)=>n+r.value.items.length,0)};
 if(!apply)return summary;
 const service=require('../lib/memberPreorders').createMemberPreorders({db,catalog});
 let created=0,replayed=0;
 // Per-row commits are deliberate. If interrupted, the immutable source key
 // resumes without overwriting a staff correction or duplicating a source row.
 for(const row of prepared){const r=await service.save(row.memberId,{...row.value,requestId:randomUUID()},{device_id:actor},{kind:'paper_import',reference:plan.source.reference,row:row.row});if(r.replayed)replayed++;else created++;}
 return {...summary,created,replayed};
}
if(require.main===module){
 const args=process.argv.slice(2),apply=args.includes('--apply'),file=args.find(a=>!a.startsWith('--'));
 if(!file){console.error('Usage: node scripts/import-member-preorders.cjs PRIVATE-PLAN.json [--apply]');process.exitCode=1;}
 else {const db=require('../db');(async()=>{try{const plan=JSON.parse(fs.readFileSync(file,'utf8'));console.log(JSON.stringify(await importPlan(plan,{db,apply})));}finally{await db.end()}})().catch(e=>{console.error(e.status?e.message:'Import stopped. Check the private plan and database; no original notes, bills or points were deleted.');process.exitCode=1})}
}
module.exports={importPlan};
