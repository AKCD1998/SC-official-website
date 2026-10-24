const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const {Pool}=require('pg');const {createMemberPortalStore}=require('../lib/memberPortalStore');
// Never use the general production URL. Only an explicit loopback test database.
const raw=process.env.MEMBER_PORTAL_TEST_DATABASE_URL || (process.env.CI==='true' ? process.env.SEAMLESS_MIGRATION_TEST_DATABASE_URL : null);
const suite=raw?describe:describe.skip;
suite('customer portal: real PostgreSQL transaction and privacy contracts',()=> {
  let pool,store,schema;
  const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
  const scoped=sql=>sql.replaceAll('public.',`"${schema}".`);
  const query=(sql,params)=>pool.query(scoped(sql),params);
  beforeAll(async()=> {
    const url=new URL(raw);if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!/(?:test|_ci)/i.test(url.pathname))throw Error('REFUSING_NON_TEST_DATABASE');
    pool=new Pool({connectionString:raw,max:5});schema='member_portal_test_'+crypto.randomBytes(6).toString('hex');
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await query(`CREATE TABLE public.users(id uuid PRIMARY KEY,email text,full_name text);
      CREATE TABLE public.member_profiles(user_id uuid PRIMARY KEY REFERENCES public.users(id),member_code text,is_active boolean);
      CREATE TABLE public.crm_counter_schema_migrations(filename text PRIMARY KEY)`);
    await query(fs.readFileSync(path.join(__dirname,'../migrations/202610240001_member_portal_email_auth.sql'),'utf8'));
    const scopedPool={query,connect:async()=>{const db=await pool.connect();return {query:(sql,params)=>db.query(scoped(sql),params),release:()=>db.release()};}};
    store=createMemberPortalStore({pool:scopedPool,secret:'synthetic-member-portal-secret-only'});
  });
  beforeEach(async()=> {
    await query('TRUNCATE public.member_portal_sessions,public.member_portal_email_otps,public.member_profiles,public.users CASCADE');
    await query('INSERT INTO public.users(id,email,full_name) VALUES($1,$2,$3),($4,$5,$6)',[a,'a@example.test','Member A',b,'b@example.test','Member B']);
    await query('INSERT INTO public.member_profiles(user_id,member_code,is_active) VALUES($1,$2,TRUE),($3,$4,TRUE)',[a,'SCM-A',b,'SCM-B']);
  });
  afterAll(async()=>{if(pool){if(/^member_portal_test_[a-f0-9]{12}$/.test(schema))await pool.query(`DROP SCHEMA "${schema}" CASCADE`);await pool.end();}});
  async function delivered(email='a@example.test',ip='127.0.0.1') {const c=await store.prepareOtp(email,ip);await store.finishDelivery(c.id,true);return c;}
  test('stores only hashed codes and tokens, resolves the verified email to the original member',async()=> {
    const c=await delivered();const stored=(await query('SELECT * FROM public.member_portal_email_otps')).rows[0];
    expect(stored.code_hash).toMatch(/^[a-f0-9]{64}$/);expect(stored.code_hash).not.toBe(c.otp);expect(JSON.stringify(stored)).not.toContain(c.email);
    const result=await store.verifyOtp(c.email,c.id,c.otp);expect(result.member.id).toBe(a);
    const session=await store.getSession(result.token);expect(session.id).toBe(a);expect(session.memberCode).toBe('SCM-A');
    expect(JSON.stringify((await query('SELECT * FROM public.member_portal_sessions')).rows)).not.toContain(result.token);
  });
  test('concurrent verification consumes a code exactly once',async()=> {
    const c=await delivered();const result=await Promise.allSettled([store.verifyOtp(c.email,c.id,c.otp),store.verifyOtp(c.email,c.id,c.otp)]);
    expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(result.filter(r=>r.status==='rejected')).toHaveLength(1);
    expect((await query('SELECT COUNT(*)::int AS n FROM public.member_portal_sessions')).rows[0].n).toBe(1);
  });
  test('the fifth wrong code permanently consumes that challenge',async()=> {
    const c=await delivered();const wrong=c.otp==='000000'?'000001':'000000';
    for(let i=0;i<5;i++)await expect(store.verifyOtp(c.email,c.id,wrong)).rejects.toMatchObject({code:'INVALID_OTP'});
    await expect(store.verifyOtp(c.email,c.id,c.otp)).rejects.toMatchObject({code:'INVALID_OTP'});
    expect((await query('SELECT attempt_count,used_at FROM public.member_portal_email_otps')).rows[0]).toMatchObject({attempt_count:5,used_at:expect.any(Date)});
  });
  test('undelivered, failed, expired and superseded codes cannot log in',async()=> {
    const c=await store.prepareOtp('a@example.test','ip-one');
    await expect(store.verifyOtp(c.email,c.id,c.otp)).rejects.toMatchObject({code:'INVALID_OTP'});
    await store.finishDelivery(c.id,false);await expect(store.verifyOtp(c.email,c.id,c.otp)).rejects.toMatchObject({code:'INVALID_OTP'});
    await query("UPDATE public.member_portal_email_otps SET created_at=now()-interval '61 seconds'");
    const next=await delivered();await query("UPDATE public.member_portal_email_otps SET expires_at=now()-interval '1 second' WHERE id=$1",[next.id]);
    await expect(store.verifyOtp(next.email,next.id,next.otp)).rejects.toMatchObject({code:'INVALID_OTP'});
    await query("UPDATE public.member_portal_email_otps SET created_at=now()-interval '61 seconds'");
    const newest=await delivered();await expect(store.verifyOtp(c.email,c.id,c.otp)).rejects.toMatchObject({code:'INVALID_OTP'});
    expect((await store.verifyOtp(newest.email,newest.id,newest.otp)).member.id).toBe(a);
  });
  test('a verified but unlinked or ambiguous email cannot claim a member by phone or name',async()=> {
    const unknown=await delivered('unknown@example.test');await expect(store.verifyOtp(unknown.email,unknown.id,unknown.otp)).rejects.toMatchObject({code:'EMAIL_NOT_LINKED'});
    await query('UPDATE public.users SET email=$1 WHERE id=$2',['A@example.test',b]);
    const ambiguous=await delivered();await expect(store.verifyOtp(ambiguous.email,ambiguous.id,ambiguous.otp)).rejects.toMatchObject({code:'EMAIL_NOT_LINKED'});
    expect((await query('SELECT COUNT(*)::int AS n FROM public.member_portal_sessions')).rows[0].n).toBe(0);
  });
  test('parallel requests for one email cannot bypass cooldown',async()=> {
    const result=await Promise.allSettled([store.prepareOtp('a@example.test','ip-one'),store.prepareOtp('a@example.test','ip-two')]);
    expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(result.find(r=>r.status==='rejected').reason.code).toBe('OTP_RATE_LIMIT');
  });
  test('revocation, member deactivation, expiry and a changed email invalidate access',async()=> {
    const c=await delivered();const {token}=await store.verifyOtp(c.email,c.id,c.otp);
    await query('UPDATE public.users SET email=$1 WHERE id=$2',['invalid',a]);await expect(store.getSession(token)).rejects.toMatchObject({code:'SESSION_REQUIRED',status:401});
    await query('UPDATE public.users SET email=$1 WHERE id=$2',['changed@example.test',a]);await expect(store.getSession(token)).rejects.toMatchObject({code:'SESSION_REQUIRED'});
    await query('UPDATE public.users SET email=$1 WHERE id=$2',[c.email,a]);await query('UPDATE public.member_profiles SET is_active=FALSE WHERE user_id=$1',[a]);
    await expect(store.getSession(token)).rejects.toMatchObject({code:'SESSION_REQUIRED'});await query('UPDATE public.member_profiles SET is_active=TRUE WHERE user_id=$1',[a]);
    await query("UPDATE public.member_portal_sessions SET expires_at=now()-interval '1 second'");await expect(store.getSession(token)).rejects.toMatchObject({code:'SESSION_REQUIRED'});
    await query("UPDATE public.member_portal_sessions SET expires_at=now()+interval '1 hour'");await store.revoke(token);await expect(store.getSession(token)).rejects.toMatchObject({code:'SESSION_REQUIRED'});
  });
  test('the new credential tables have row security and no public grants',async()=> {
    const rows=(await pool.query("SELECT relname,relrowsecurity,relacl::text AS acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND relname=ANY($2::text[])",[schema,['member_portal_email_otps','member_portal_sessions']])).rows;
    expect(rows).toHaveLength(2);expect(rows.every(r=>r.relrowsecurity)).toBe(true);expect(rows.every(r=>!/(?:\{|,)=/.test(r.acl||''))).toBe(true);
  });
});
