'use strict';
const express=require('express');const path=require('node:path');const cookieParser=require('cookie-parser');
const {createMemberPortalStore,SESSION_TTL_MS}=require('../lib/memberPortalStore');
const {createMemberPortalMailer}=require('../lib/memberPortalMail');
const directory=path.join(__dirname,'../public/member-portal');
const cookieName='sccrm_member_portal_session';
const messages={INVALID_EMAIL:'กรุณากรอกอีเมลให้ถูกต้อง',INVALID_OTP:'รหัสไม่ถูกต้อง หมดอายุ หรือถูกใช้แล้ว กรุณาตรวจสอบหรือขอรหัสใหม่',
  OTP_RATE_LIMIT:'ขอรหัสบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่',EMAIL_NOT_LINKED:'อีเมลนี้ยังไม่ได้ผูกกับสมาชิกที่เปิดใช้งาน กรุณาให้พนักงานตรวจสอบและเพิ่มอีเมลในข้อมูลสมาชิกก่อน',
  SESSION_REQUIRED:'กรุณาเข้าสู่ระบบเพื่อดูประวัติของคุณ',PORTAL_NOT_CONFIGURED:'บริการเข้าใช้งานยังไม่พร้อม กรุณาลองใหม่ภายหลัง'};
function publicPurchase(p) {
  return {receiptNo:p.receiptNo,branchCode:p.branchCode,soldAt:p.soldAt,totalAmount:p.totalAmount,totalAmountSource:p.totalAmountSource,
    receiptDiscount:p.receiptDiscount,items:(p.items||[]).map(i=>({productCode:i.productCode,productName:i.productName,qty:i.qty,
      unitCode:i.unitCode||null,unitName:i.unitName||null,unitPrice:i.unitPrice,lineTotal:i.lineTotal})),
    returns:(p.returns||[]).map(r=>({refundDocNo:r.refundDocNo,refundedAt:r.refundedAt,refundTotal:r.refundTotal,returnedQty:r.returnedQty}))};
}
function createMemberPortal({pool,getHistory,env=process.env,store,mailer}={}) {
  const app=express();app.disable('x-powered-by');app.set('trust proxy',1);
  const origin=env.SC_OFFICIAL_MEMBER_PORTAL_ORIGIN || 'https://sc-official-website.onrender.com';
  const secure=new URL(origin).protocol==='https:';
  if(!secure && !['localhost','127.0.0.1'].includes(new URL(origin).hostname))throw Error('HTTPS portal origin required');
  const cookie={httpOnly:true,secure,sameSite:'strict',path:'/my-purchases',maxAge:SESSION_TTL_MS};
  mailer=mailer || createMemberPortalMailer({env});
  try { store=store || createMemberPortalStore({pool,secret:env.SC_OFFICIAL_MEMBER_PORTAL_HMAC_SECRET || env.OTP_SECRET}); } catch { /* Disabled until configured. */ }
  const enabled=()=>env.SC_OFFICIAL_MEMBER_PORTAL_ENABLED==='true' && mailer.configured && Boolean(store);
  app.locals.portalConfiguration={enabled:enabled(),emailProvider:mailer.provider,mailConfigured:mailer.configured,sessionConfigured:Boolean(store)};
  app.use((req,res,next)=> {
    res.set({'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',
      'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"});
    if(req.get('origin') && req.get('origin')!==origin)return res.status(403).json({error:'กรุณาเปิดจากเว็บไซต์ของร้าน'});
    if(req.method==='POST' && (req.get('origin')!==origin || !req.is('application/json')))return res.status(403).json({error:'กรุณาเปิดจากเว็บไซต์ของร้าน'});
    next();
  });
  app.use(cookieParser());app.use(express.json({limit:'2kb'}));
  app.get('/',(_req,res)=>res.sendFile(path.join(directory,'index.html')));
  app.use('/assets',express.static(directory,{index:false,dotfiles:'deny'}));
  app.get('/api/config',(_req,res)=>res.json({enabled:enabled()}));
  app.use('/api',(req,res,next)=>enabled()?next():res.status(503).json({error:messages.PORTAL_NOT_CONFIGURED}));
  const wrap=work=>async(req,res)=>{try{await work(req,res);}catch(error){
    if(error.code==='OTP_RATE_LIMIT')res.set('Retry-After','60');
    res.status(messages[error.code]?error.status:503).json({error:messages[error.code] || 'ระบบไม่พร้อมใช้งานชั่วคราว กรุณาลองใหม่อีกครั้ง'});
  }};
  app.post('/api/auth/request',wrap(async(req,res)=> {
    const challenge=await store.prepareOtp(req.body?.email,req.ip);
    try {await mailer.sendOtp(challenge);await store.finishDelivery(challenge.id,true);}
    catch {await store.finishDelivery(challenge.id,false).catch(()=>{});throw Error('MAIL_UNAVAILABLE');}
    res.json({ok:true,requestId:challenge.id,retryAfterSeconds:60,expiresInSeconds:600});
  }));
  app.post('/api/auth/verify',wrap(async(req,res)=> {
    const result=await store.verifyOtp(req.body?.email,req.body?.requestId,req.body?.code);
    res.cookie(cookieName,result.token,cookie).json({ok:true,member:{name:result.member.full_name||'',memberCode:result.member.member_code||''}});
  }));
  const session=async req=>store.getSession(req.cookies[cookieName]);
  app.get('/api/session',wrap(async(req,res)=> {
    const member=await session(req);res.json({ok:true,member:{name:member.name,memberCode:member.memberCode}});
  }));
  app.get('/api/history',wrap(async(req,res)=> {
    const member=await session(req);
    if((req.query.limit!==undefined && (typeof req.query.limit!=='string'||!/^\d{1,2}$/.test(req.query.limit))) ||
      (req.query.cursor!==undefined && typeof req.query.cursor!=='string'))return res.status(400).json({error:'ข้อมูลหน้าประวัติไม่ถูกต้อง'});
    let history;
    try {history=await getHistory(member.id,{limit:Math.min(Number(req.query.limit)||20,50),cursor:req.query.cursor});}
    catch(error){if(error.status===400)return res.status(400).json({error:'ข้อมูลหน้าประวัติไม่ถูกต้อง'});throw error;}
    res.json({ok:true,purchases:history.purchases.map(publicPurchase),hasMore:history.hasMore,nextCursor:history.nextCursor});
  }));
  app.post('/api/auth/logout',wrap(async(req,res)=> {
    try { await store.revoke(req.cookies[cookieName]); }
    finally { res.clearCookie(cookieName,{...cookie,maxAge:undefined}); }
    res.json({ok:true});
  }));
  app.use((error,_req,res,_next)=>res.status(error.type==='entity.too.large'?413:400).json({error:'รูปแบบข้อมูลไม่ถูกต้อง'}));
  return app;
}
module.exports={createMemberPortal,publicPurchase};
