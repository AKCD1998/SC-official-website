'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const jwt=require('jsonwebtoken');
const {Client}=require('pg');
const {setupSigningSecret}=require('../lib/promotionAdminSetup');
async function main(){
 const [email,output]=process.argv.slice(2);
 if(!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !output || process.argv.length!==4)throw Error('EMAIL_AND_PRIVATE_OUTPUT_REQUIRED');
 const allowed=String(process.env.SCCRM_PROMOTION_ADMIN_EMAILS || '').split(',').map(s=>s.trim().toLowerCase());
 if(!allowed.includes(email.toLowerCase()))throw Error('EMAIL_NOT_ALLOWLISTED');
 const url=new URL(process.env.SC_OFFICIAL_SUPABASE_DATABASE_URL);
 for(const key of ['sslmode','sslcert','sslkey','sslrootcert'])if(url.searchParams.has(key))throw Error('TLS_OVERRIDE_REFUSED');
 const ca=process.env.CRM_BOOTSTRAP_TLS_CA_FILE;
 const client=new Client({connectionString:url.href,ssl:{rejectUnauthorized:true,...(ca?{ca:fs.readFileSync(ca,'utf8')}:{})},connectionTimeoutMillis:10000,query_timeout:10000});
 try{
  await client.connect();const existing=await client.query('SELECT 1 FROM users WHERE lower(email)=lower($1)',[email]);
  if(existing.rowCount)throw Error('ACCOUNT_ALREADY_EXISTS_USE_LOGIN');
  const token=jwt.sign({scope:'promotion-admin-setup',email:email.toLowerCase()},setupSigningSecret(),{algorithm:'HS256',audience:'sccrm-promotion-admin-setup',issuer:'sccrm-admin-operator',jwtid:crypto.randomUUID(),expiresIn:'1h'});
  const href='https://sc-official-website.onrender.com/sccrm/promotions/admin#setup='+encodeURIComponent(token);
  const file=path.resolve(output);if(fs.existsSync(file))throw Error('OUTPUT_EXISTS');
  fs.writeFileSync(file,`<!doctype html><html lang="th"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>ตั้งรหัสผ่านผู้ดูแล SCCRM</title><body style="font:18px Tahoma;max-width:720px;padding:40px;margin:auto"><h1>ตั้งรหัสผ่านผู้ดูแลโปรโมชั่น</h1><p>สำหรับบัญชี ${email.replace(/[&<>"']/g,'')} เท่านั้น ลิงก์หมดอายุใน 1 ชั่วโมงหลังออก</p><p><a rel="noreferrer" href="${href}">เปิดหน้าตั้งรหัสผ่านบนเว็บไซต์ SC</a></p><p>หลังสร้างบัญชีแล้ว ลิงก์นี้ใช้ซ้ำเพื่อเปลี่ยนรหัสผ่านไม่ได้</p></body></html>`,{flag:'wx',mode:0o600});
  console.log(JSON.stringify({ok:true,privateActivationFile:file,expiresAt:new Date(Date.now()+3600000).toISOString(),secretPrinted:false}));
 }finally{await client.end();}
}
main().catch(()=>{console.error('{"ok":false,"code":"ADMIN_SETUP_LINK_NOT_ISSUED","detailsWithheld":true}');process.exitCode=1;});
