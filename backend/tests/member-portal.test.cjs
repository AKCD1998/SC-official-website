const express=require('express');const request=require('supertest');
const {createMemberPortal}=require('../routes/memberPortal');
const {normalizeEmail,createMemberPortalStore}=require('../lib/memberPortalStore');
const {createMemberPortalMailer}=require('../lib/memberPortalMail');
let app,store,mailer,getHistory;
const origin='https://portal.example.test';
const member={id:'11111111-1111-4111-8111-111111111111',name:'สมาชิกทดสอบ',memberCode:'SCM-TEST'};
const token='x'.repeat(43),id='22222222-2222-4222-8222-222222222222';
function post(path,body){return request(app).post('/my-purchases/api/'+path).set('Origin',origin).send(body);}
beforeEach(()=> {
  store={prepareOtp:jest.fn(async()=>({id,email:'member@example.test',otp:'123456'})),finishDelivery:jest.fn(async()=>{}),
    verifyOtp:jest.fn(async()=>({token,member:{id:member.id,full_name:member.name,member_code:member.memberCode}})),
    getSession:jest.fn(async value=>{if(value!==token)throw Object.assign(new Error(),{status:401,code:'SESSION_REQUIRED'});return member;}),revoke:jest.fn(async()=>{})};
  mailer={configured:true,sendOtp:jest.fn(async()=>{})};
  getHistory=jest.fn(async()=>({purchases:[{receiptNo:'S-TEST',branchCode:'004',soldAt:'2026-10-24T10:00:00+07:00',totalAmount:100,
    totalAmountSource:'pos_header',cashierStaffCode:'INTERNAL',awardedPoints:50,items:[{productCode:'SKU-1',productName:'สินค้า',unitName:'กล่อง',qty:2,unitPrice:50,lineTotal:100,barcode:'INTERNAL'}],returns:[]}],hasMore:true,nextCursor:'opaque-cursor'}));
  app=express();app.use('/my-purchases',createMemberPortal({store,mailer,getHistory,env:{SC_OFFICIAL_MEMBER_PORTAL_ENABLED:'true',SC_OFFICIAL_MEMBER_PORTAL_ORIGIN:origin}}));
});
test('serves the mobile portal with no-store and restrictive browser headers',async()=> {
  const r=await request(app).get('/my-purchases/');expect(r.status).toBe(200);expect(r.text).toContain('ประวัติการซื้อของฉัน');
  expect(r.headers['cache-control']).toBe('private, no-store');expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
});
test('the portal is disabled by default and never sends a message when disabled',async()=> {
  const disabled=express();disabled.use('/my-purchases',createMemberPortal({store,mailer,getHistory,env:{SC_OFFICIAL_MEMBER_PORTAL_ORIGIN:origin}}));
  expect((await request(disabled).get('/my-purchases/api/config')).body.enabled).toBe(false);
  expect((await request(disabled).post('/my-purchases/api/auth/request').set('Origin',origin).send({email:'a@example.test'})).status).toBe(503);
  expect(mailer.sendOtp).not.toHaveBeenCalled();
});
test('OTP requests never disclose the code or whether the email is linked',async()=> {
  const r=await post('auth/request',{email:'member@example.test',memberId:'someone-else'});
  expect(r.status).toBe(200);expect(r.body).toEqual({ok:true,requestId:id,retryAfterSeconds:60,expiresInSeconds:600});
  expect(store.prepareOtp).toHaveBeenCalledWith('member@example.test',expect.any(String));expect(store.finishDelivery).toHaveBeenCalledWith(id,true);
});
test('failed delivery invalidates the challenge and never claims success',async()=> {
  mailer.sendOtp.mockRejectedValue(new Error('provider private detail'));
  const r=await post('auth/request',{email:'member@example.test'});
  expect(r.status).toBe(503);expect(r.text).not.toContain('private');expect(store.finishDelivery).toHaveBeenCalledWith(id,false);
});
test('persistent rate-limit failures include a retry interval',async()=> {
  store.prepareOtp.mockRejectedValue(Object.assign(new Error(),{status:429,code:'OTP_RATE_LIMIT'}));
  const r=await post('auth/request',{email:'member@example.test'});expect(r.status).toBe(429);expect(r.headers['retry-after']).toBe('60');
});
test('verification issues only a secure HttpOnly same-site cookie, never a browser token',async()=> {
  const r=await post('auth/verify',{email:'member@example.test',requestId:id,code:'123456',phone:'someone else'});
  expect(r.status).toBe(200);expect(r.body).toEqual({ok:true,member:{name:member.name,memberCode:member.memberCode}});
  expect(r.headers['set-cookie'][0]).toContain('HttpOnly');expect(r.headers['set-cookie'][0]).toContain('Secure');
  expect(r.headers['set-cookie'][0]).toContain('SameSite=Strict');expect(r.headers['set-cookie'][0]).toContain('Path=/my-purchases');
  expect(store.verifyOtp).toHaveBeenCalledWith('member@example.test',id,'123456');
});
test('rejects anonymous and staff tokens before reading purchases',async()=> {
  for(const headers of [{},{Authorization:'Bearer staff-token'}]){
    const r=await request(app).get('/my-purchases/api/history').set(headers);expect(r.status).toBe(401);
  }expect(getHistory).not.toHaveBeenCalled();
});
test('history always uses the session owner and omits staff/internal/points fields',async()=> {
  const r=await request(app).get('/my-purchases/api/history?memberId=another-user&phone=0990000000&limit=20').set('Cookie','sccrm_member_portal_session='+token);
  expect(r.status).toBe(200);expect(getHistory).toHaveBeenCalledWith(member.id,{limit:20,cursor:undefined});
  expect(r.body.purchases[0].items[0]).toMatchObject({productCode:'SKU-1',unitName:'กล่อง',qty:2});
  expect(r.text).not.toContain('INTERNAL');expect(r.text).not.toContain('awardedPoints');expect(r.body.hasMore).toBe(true);
});
test('pagination stays owner-scoped and malformed repeated arguments are rejected',async()=> {
  await request(app).get('/my-purchases/api/history?cursor=opaque-cursor&limit=99').set('Cookie','sccrm_member_portal_session='+token);
  expect(getHistory).toHaveBeenCalledWith(member.id,{limit:50,cursor:'opaque-cursor'});
  expect((await request(app).get('/my-purchases/api/history?cursor=a&cursor=b').set('Cookie','sccrm_member_portal_session='+token)).status).toBe(400);
});
test('cross-origin reads and submissions cannot use a portal session',async()=> {
  expect((await request(app).get('/my-purchases/api/history').set('Origin','https://other.example.test').set('Cookie','sccrm_member_portal_session='+token)).status).toBe(403);
  expect((await request(app).post('/my-purchases/api/auth/request').send({email:'a@example.test'})).status).toBe(403);
  expect(getHistory).not.toHaveBeenCalled();expect(mailer.sendOtp).not.toHaveBeenCalled();
});
test('logout revokes the opaque session and clears its cookie even if storage fails',async()=> {
  const r=await post('auth/logout',{}).set('Cookie','sccrm_member_portal_session='+token);
  expect(store.revoke).toHaveBeenCalledWith(token);expect(r.headers['set-cookie'][0]).toContain('1970');
  store.revoke.mockRejectedValue(new Error('database details'));const failed=await post('auth/logout',{});
  expect(failed.status).toBe(503);expect(failed.headers['set-cookie'][0]).toContain('1970');expect(failed.text).not.toContain('database details');
});
test('does not use an unsafe remote HTTP cookie origin',()=> {
  expect(()=>createMemberPortal({store,mailer,env:{SC_OFFICIAL_MEMBER_PORTAL_ORIGIN:'http://public.example.test'}})).toThrow('HTTPS');
});
test('email validation and purpose-specific secret requirements',()=> {
  expect(normalizeEmail(' User@Example.test ')).toBe('user@example.test');
  for(const v of [undefined,{},'bad','a@b','a\n@b.test'])expect(()=>normalizeEmail(v)).toThrow();
  expect(()=>createMemberPortalStore({pool:{},secret:'short'})).toThrow('PORTAL_NOT_CONFIGURED');
});
test.each(['sendgrid','brevo','resend'])('the %s gateway sends one OTP email with a deadline and no attachments',async provider=> {
  const fetchImpl=jest.fn(async()=>({ok:true}));
  const env={SC_OFFICIAL_MEMBER_PORTAL_EMAIL_PROVIDER:provider,MAIL_USER:'sender@example.test',SENDGRID_API_KEY:'synthetic',BREVO_API_KEY:'synthetic',SC_OFFICIAL_MEMBER_PORTAL_RESEND_API_KEY:'synthetic'};
  await createMemberPortalMailer({env,fetchImpl}).sendOtp({email:'member@example.test',otp:'654321'});
  const [url,options]=fetchImpl.mock.calls[0];expect(url).toMatch(/^https:/);expect(options.body).toContain('654321');
  expect(options.body).toContain('member@example.test');expect(options.body).not.toContain('attachments');expect(options.signal).toBeDefined();
});

test('reuses the configured Seamless provider and sender with normalized provider names',async()=> {
  const fetchImpl=jest.fn(async()=>({ok:true}));
  const mail=createMemberPortalMailer({env:{EMAIL_PROVIDER:' Brevo ',BREVO_API_KEY:'synthetic',MAIL_FROM:'verified@example.test'},fetchImpl});
  expect(mail.provider).toBe('brevo');expect(mail.configured).toBe(true);
  await mail.sendOtp({email:'member@example.test',otp:'123456'});
  expect(JSON.parse(fetchImpl.mock.calls[0][1].body).sender.email).toBe('verified@example.test');
});
