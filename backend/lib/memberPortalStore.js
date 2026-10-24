'use strict';
const crypto = require('node:crypto');
const OTP_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
function failure(status, code) { return Object.assign(new Error(code), {status, code}); }
function normalizeEmail(value) {
  if (typeof value !== 'string') throw failure(400, 'INVALID_EMAIL');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw failure(400, 'INVALID_EMAIL');
  return email;
}
function createMemberPortalStore({pool, secret, now = Date.now, maxDailyEmails = 80}) {
  if (!secret || secret.length < 16) throw failure(503, 'PORTAL_NOT_CONFIGURED');
  // Derive a purpose-specific key even when reusing the existing OTP root secret.
  const key = crypto.createHmac('sha256', secret).update('SC-OFFICIAL-MEMBER-PORTAL/v1').digest();
  const hash = (kind, ...values) => crypto.createHmac('sha256', key).update(JSON.stringify([kind, ...values])).digest('hex');
  async function transaction(work) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query("SET LOCAL lock_timeout='2s'");
      await db.query("SET LOCAL statement_timeout='5s'");
      const result = await work(db); await db.query('COMMIT'); return result;
    } catch (error) { await db.query('ROLLBACK').catch(()=>{}); throw error; }
    finally { db.release(); }
  }
  async function prepareOtp(rawEmail, ip) {
    const email = normalizeEmail(rawEmail), emailHash = hash('email', email), ipHash = hash('ip', ip);
    return transaction(async db => {
      // Same-address/IP requests serialize across all app instances, in stable order.
      for (const lock of ['budget', 'email:'+emailHash, 'ip:'+ipHash].sort())
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['member-portal:'+lock]);
      const {rows} = await db.query(`SELECT
        COUNT(*)::int AS daily_count,
        COUNT(*) FILTER (WHERE email_hash=$1 AND created_at>now()-interval '15 minutes')::int AS email_count,
        COUNT(*) FILTER (WHERE ip_hash=$2 AND created_at>now()-interval '15 minutes')::int AS ip_count,
        COALESCE(bool_or(email_hash=$1 AND created_at>now()-interval '60 seconds'),false) AS cooldown
        FROM public.member_portal_email_otps
        WHERE created_at>now()-interval '24 hours'`, [emailHash,ipHash]);
      if (rows[0].cooldown || rows[0].email_count >= 3 || rows[0].ip_count >= 10 || rows[0].daily_count >= maxDailyEmails) throw failure(429,'OTP_RATE_LIMIT');
      const id = crypto.randomUUID(), otp = String(crypto.randomInt(0,1000000)).padStart(6,'0');
      // Only the newest code for an email remains usable.
      await db.query('UPDATE public.member_portal_email_otps SET used_at=now() WHERE email_hash=$1 AND used_at IS NULL',[emailHash]);
      await db.query(`INSERT INTO public.member_portal_email_otps(id,email_hash,ip_hash,code_hash,expires_at)
        VALUES($1,$2,$3,$4,$5)`,[id,emailHash,ipHash,hash('otp',id,emailHash,otp),new Date(now()+OTP_TTL_MS)]);
      return {id,otp,email}; // Internal only: the HTTP response must never include the code.
    });
  }
  async function finishDelivery(id, delivered) {
    await pool.query(delivered
      ? 'UPDATE public.member_portal_email_otps SET delivered_at=now() WHERE id=$1 AND used_at IS NULL'
      : 'UPDATE public.member_portal_email_otps SET used_at=now() WHERE id=$1', [id]);
  }
  async function verifyOtp(rawEmail, id, code) {
    const email = normalizeEmail(rawEmail), emailHash=hash('email',email);
    if (typeof id!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
        typeof code!=='string' || !/^\d{6}$/.test(code)) throw failure(400,'INVALID_OTP');
    const result = await transaction(async db => {
      const {rows} = await db.query('SELECT * FROM public.member_portal_email_otps WHERE id=$1 FOR UPDATE',[id]);
      const row=rows[0];
      if (!row || row.used_at || !row.delivered_at || row.email_hash!==emailHash || row.attempt_count>=5 || new Date(row.expires_at).getTime()<=now())
        return {error:failure(400,'INVALID_OTP')};
      const match=crypto.timingSafeEqual(Buffer.from(row.code_hash,'hex'),Buffer.from(hash('otp',id,emailHash,code),'hex'));
      if (!match) {
        await db.query(`UPDATE public.member_portal_email_otps SET attempt_count=attempt_count+1,
          used_at=CASE WHEN attempt_count>=4 THEN now() ELSE used_at END WHERE id=$1`,[id]);
        return {error:failure(400,'INVALID_OTP')};
      }
      await db.query('UPDATE public.member_portal_email_otps SET used_at=now() WHERE id=$1',[id]);
      // Lookup happens only after email ownership is proved. Never accept a phone,
      // member ID or name from the browser to bind an existing member.
      const members=await db.query(`SELECT u.id,u.full_name,m.member_code FROM public.users u
        JOIN public.member_profiles m ON m.user_id=u.id
        WHERE lower(btrim(u.email))=$1 AND m.is_active=TRUE LIMIT 2`,[email]);
      if (members.rows.length!==1) return {error:failure(403,'EMAIL_NOT_LINKED')};
      const member=members.rows[0], token=crypto.randomBytes(32).toString('base64url');
      await db.query(`INSERT INTO public.member_portal_sessions(id,user_id,token_hash,email_hash,expires_at)
        VALUES($1,$2,$3,$4,$5)`,[crypto.randomUUID(),member.id,hash('session',token),emailHash,new Date(now()+SESSION_TTL_MS)]);
      return {token,member};
    });
    if(result.error)throw result.error; return result;
  }
  async function getSession(token) {
    if(typeof token!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(token))throw failure(401,'SESSION_REQUIRED');
    const {rows}=await pool.query(`SELECT s.id,s.user_id,s.email_hash,s.expires_at,s.revoked_at,
      u.email,u.full_name,m.member_code,m.is_active FROM public.member_portal_sessions s
      JOIN public.users u ON u.id=s.user_id JOIN public.member_profiles m ON m.user_id=u.id
      WHERE s.token_hash=$1`,[hash('session',token)]);
    const row=rows[0];
    let emailHash;
    try { emailHash=hash('email',normalizeEmail(row?.email)); } catch { /* An invalidated member email also ends the session. */ }
    if(!row || row.revoked_at || !row.is_active || new Date(row.expires_at).getTime()<=now() || emailHash!==row.email_hash)
      throw failure(401,'SESSION_REQUIRED');
    return {id:row.user_id,name:row.full_name || '',memberCode:row.member_code || ''};
  }
  async function revoke(token) {
    if(typeof token==='string' && /^[A-Za-z0-9_-]{43}$/.test(token))
      await pool.query('UPDATE public.member_portal_sessions SET revoked_at=now() WHERE token_hash=$1',[hash('session',token)]);
  }
  return {prepareOtp,finishDelivery,verifyOtp,getSession,revoke};
}
module.exports={createMemberPortalStore,normalizeEmail,OTP_TTL_MS,SESSION_TTL_MS};
