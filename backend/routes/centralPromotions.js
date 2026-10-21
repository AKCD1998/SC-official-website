const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const {setupSigningSecret}=require('../lib/promotionAdminSetup');
const pool = require('../db');
const { createId } = require('../lib/sccrm');
const { BAHT_PER_POINT, validatePromotion, getActivePromotions, quotePoints } = require('../lib/sccrmPromotions');
const router = express.Router();
router.use('/promotions', (_req,res,next)=>{res.set('Cache-Control','no-store');next();});
async function requirePromotionAdmin(req,res,next) {
  try {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    if (!token || !process.env.JWT_SECRET) return res.status(401).json({error:'Website administrator login required.'});
    const payload = jwt.verify(token,process.env.JWT_SECRET,{algorithms:['HS256']});
    const emails = String(process.env.SCCRM_PROMOTION_ADMIN_EMAILS || '').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
    if (!payload.userId || !emails.includes(String(payload.email || '').toLowerCase())) return res.status(403).json({error:'Administrator access required.'});
    const account = await pool.query('SELECT id FROM users WHERE id=$1::uuid AND lower(email)=lower($2)',[payload.userId,payload.email]);
    if (!account.rowCount) return res.status(403).json({error:'Administrator account unavailable.'});
    return next();
  } catch {return res.status(401).json({error:'Website administrator login required.'});}
}
function branch(req) {
  const value = String(req.query.branchCode || '').trim().toUpperCase();
  if (value && !/^[A-Z0-9_-]{1,20}$/.test(value)) throw Object.assign(Error('Invalid branchCode.'),{status:400});
  return value;
}
router.get('/promotions/active',async(req,res)=>{
  try {
    const promotions = await getActivePromotions(pool,branch(req));
    return res.json({ok:true,promotions,bahtPerPoint:BAHT_PER_POINT,revision:quotePoints(0,promotions).revision,serverTime:new Date().toISOString()});
  } catch(e){return res.status(e.status || 503).json({error:e.status?e.message:'Central promotions are unavailable. Please retry.'});}
});
router.get('/promotions/quote',async(req,res)=>{
  try {
    if (req.query.amount == null || req.query.amount === '') return res.status(400).json({error:'amount is required.'});
    const promotions=await getActivePromotions(pool,branch(req));
    return res.json({ok:true,...quotePoints(req.query.amount,promotions),serverTime:new Date().toISOString()});
  } catch(e){return res.status(e.status || 503).json({error:e.status?e.message:'Central promotions are unavailable. Please retry.'});}
});
// An operator issues a short-lived setup JWT offline, using the existing site
// signing key. It has no userId and cannot authenticate an admin API request.
// Creating the unique email consumes the invite; existing accounts cannot reset.
router.post('/promotions/admin/setup',async(req,res)=>{
  try {
    const password=req.body?.password;
    if(typeof password!=='string' || password.length<12 || Buffer.byteLength(password,'utf8')>72) return res.status(400).json({error:'ใช้รหัสผ่านอย่างน้อย 12 ตัวอักษร และไม่เกิน 72 ไบต์'});
    const invite=jwt.verify(String(req.body?.setupToken || ''),setupSigningSecret(),{algorithms:['HS256'],audience:'sccrm-promotion-admin-setup',issuer:'sccrm-admin-operator',maxAge:'1h'});
    const emails=String(process.env.SCCRM_PROMOTION_ADMIN_EMAILS || '').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
    const email=String(invite.email || '').toLowerCase();
    if(invite.scope!=='promotion-admin-setup' || invite.userId || !invite.jti || !emails.includes(email)) return res.status(403).json({error:'ลิงก์นี้ไม่มีสิทธิ์สร้างผู้ดูแลโปรโมชั่น'});
    const existing=await pool.query('SELECT id FROM users WHERE lower(email)=lower($1)',[email]);
    if(existing.rowCount) return res.status(409).json({error:'บัญชีนี้ถูกสร้างแล้ว กรุณาเข้าสู่ระบบด้วยรหัสผ่าน'});
    const hash=await bcrypt.hash(password,12);
    await pool.query('INSERT INTO users(id,full_name,email,password_hash,is_verified,verified_at) VALUES($1,$2,$3,$4,true,NOW())',[createId(),'ผู้ดูแลโปรโมชั่น SC',email,hash]);
    return res.status(201).json({ok:true});
  }catch(e){return res.status(e.code==='23505'?409:401).json({error:e.code==='23505'?'บัญชีนี้ถูกสร้างแล้ว':'ลิงก์ตั้งรหัสผ่านไม่ถูกต้องหรือหมดอายุ กรุณาขอลิงก์ใหม่'});}
});
router.get('/promotions',requirePromotionAdmin,async(_req,res)=>{
  try{return res.json({ok:true,promotions:(await pool.query('SELECT id, name, type, value, condition_json, starts_at, ends_at, is_active, updated_at FROM promotions ORDER BY created_at DESC, id ASC')).rows});}
  catch{return res.status(503).json({error:'Promotions unavailable.'});}
});
async function save(req,res,update) {
  try {
    const p=validatePromotion(req.body || {}),id=update?req.params.id:createId();
    if (!/^[a-f\d-]{36}$/i.test(id))return res.status(400).json({error:'Invalid promotion ID.'});
    const values=[id,p.name,p.type,p.value,JSON.stringify(p.condition_json),p.starts_at,p.ends_at,p.is_active];
    const result=await pool.query(update?`UPDATE promotions SET name=$2,type=$3,value=$4,condition_json=$5::jsonb,starts_at=$6,ends_at=$7,is_active=$8,updated_at=NOW() WHERE id=$1 RETURNING id`:
      `INSERT INTO promotions(id,name,type,value,condition_json,starts_at,ends_at,is_active,created_at,updated_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,NOW(),NOW()) RETURNING id`,values);
    if(!result.rowCount)return res.status(404).json({error:'Promotion not found.'});
    return res.status(update?200:201).json({ok:true,promotionId:id});
  }catch(e){return res.status(e.status || 500).json({error:e.status?e.message:'Promotion save failed.'});}
}
router.post('/promotions',requirePromotionAdmin,(req,res)=>save(req,res,false));
router.put('/promotions/:id',requirePromotionAdmin,(req,res)=>save(req,res,true));
module.exports=router;
