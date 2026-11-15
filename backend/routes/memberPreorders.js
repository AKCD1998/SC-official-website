'use strict';
const express=require('express');
const {createMemberPreorders}=require('../lib/memberPreorders');
function staffSession(db){return async(req,res,next)=>{
 try{const {parseBearerToken,hashOpaqueToken}=require('../lib/sccrm');const token=parseBearerToken(req.headers.authorization);if(!token)return res.status(401).json({error:'กรุณาเข้าสู่ระบบพนักงานใหม่'});
  const actor=(await db.query('SELECT id,device_id,device_name,branch_id FROM public.staff_devices WHERE token_hash=$1 AND revoked_at IS NULL',[hashOpaqueToken(token)])).rows[0];
  if(!actor)return res.status(401).json({error:'กรุณาเข้าสู่ระบบพนักงานใหม่'});req.staffDevice=actor;next();
 }catch{res.status(503).json({error:'ตรวจสิทธิ์พนักงานไม่ได้ กรุณาลองใหม่'})}
}}
function createMemberPreorderRouter(deps={}){
 const db=deps.db||require('../db'),service=deps.service||createMemberPreorders({...deps,db}),router=express.Router();
 router.use(deps.requireStaff||staffSession(db));router.use((req,res,next)=>{res.set('Cache-Control','private, no-store');next()});
 const run=fn=>async(req,res)=>{try{res.json(await fn(req))}catch(e){res.status(e.status||503).json({error:e.status?e.message:'ระบบพรีออเดอร์ยังไม่พร้อม กรุณาลองใหม่',...(e.status&&e.code?{code:e.code}:{})})}};
 router.get('/preorders/catalog',run(async req=>({ok:true,items:await service.catalog.search(req.query.q)})));
 router.get('/:id/preorders',run(req=>service.list(req.params.id,req.query)));
 router.post('/:id/preorders',run(req=>service.save(req.params.id,req.body,req.staffDevice)));
 router.post('/:id/preorders/receipt-confirmations',run(req=>service.confirm(req.params.id,req.body,req.staffDevice)));
 router.post('/:id/preorders/receipt-confirmations/:linkId/revoke',run(req=>service.revoke(req.params.id,req.params.linkId,req.body,req.staffDevice)));
 return router;
}
module.exports={createMemberPreorderRouter,staffSession};
