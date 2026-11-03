'use strict';
const express=require('express');
const crypto=require('node:crypto');
const defaultPool=require('../db');
const releases=require('../lib/sccrmFleetRelease');
const store=require('../lib/sccrmFleetStore');

function createFleetRouter({pool=defaultPool,getRelease=releases.latest}={}){
 const router=express.Router();
 router.use(express.json({limit:'80kb'}));
 router.use((req,res,next)=>{res.set('Cache-Control','private, no-store');next();});
 function token(req){const match=/^Bearer ([A-Za-z0-9._~-]{20,512})$/.exec(req.headers.authorization||'');return match?.[1]||null;}
 const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
 const sendError=(res,error)=>res.status(error.status||503).json({ok:false,code:error.code||'FLEET_TEMPORARILY_UNAVAILABLE'});
 async function admin(req,res,next){
  const key=token(req);if(!key)return res.status(401).json({ok:false,code:'FLEET_ADMIN_AUTH_REQUIRED'});
  try{
   req.fleetAdmin=(await pool.query("SELECT id FROM sccrm_fleet.admin_keys WHERE token_hash=$1 AND station='SCPRODUCTDEV' AND revoked_at IS NULL",[hash(key)])).rows[0];
   if(!req.fleetAdmin)return res.status(403).json({ok:false,code:'FLEET_ADMIN_AUTH_REQUIRED'});
   next();
  }catch(e){sendError(res,e);}
 }
 async function device(req,res,next){
  const key=token(req);if(!key)return res.status(401).json({ok:false,code:'STAFF_DEVICE_AUTH_REQUIRED'});
  try{
   req.fleetDevice=(await pool.query('SELECT id,device_id FROM public.staff_devices WHERE token_hash=$1 AND revoked_at IS NULL',[hash(key)])).rows[0];
   if(!req.fleetDevice)return res.status(401).json({ok:false,code:'STAFF_DEVICE_AUTH_REQUIRED'});
   next();
  }catch(e){sendError(res,e);}
 }
 const run=fn=>async(req,res)=>{try{res.json(await fn(req));}catch(e){sendError(res,e);}};
 router.get('/admin/status',admin,run(()=>store.inventory(pool)));
 router.get('/admin/release',admin,run(async()=>{const r=await getRelease();return {ok:true,version:r.version,sha256:r.sha256};}));
 router.post('/admin/commands',admin,run(req=>store.issue(pool,req.fleetAdmin,req.body,getRelease)));
 router.post('/admin/pause',admin,run(async req=>{
  if(typeof req.body?.enabled!=='boolean'||Object.keys(req.body).length!==1)throw store.error('INVALID_PAUSE_REQUEST');
  await pool.query('UPDATE sccrm_fleet.settings SET enabled=$1 WHERE id=1',[req.body.enabled]);return {ok:true,enabled:req.body.enabled};
 }));
 router.post('/device/poll',device,run(req=>store.heartbeat(pool,req.fleetDevice,req.body)));
 router.post('/device/report',device,run(req=>store.report(pool,req.fleetDevice,req.body)));
 return router;
}
module.exports={createFleetRouter};
