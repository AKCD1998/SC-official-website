const express=require('express');
const request=require('supertest');
const jwt=require('jsonwebtoken');
const mockQuery=jest.fn();
jest.mock('../db',()=>({query:(...args)=>mockQuery(...args)}));
const {quotePoints,validatePromotion,receiptEligibleAmount,getActivePromotions}=require('../lib/sccrmPromotions');
const promotion=(overrides={})=>({id:'11111111-1111-4111-8111-111111111111',name:'Fixture double points',type:'multiplier',value:2,condition_json:{},...overrides});
function app(){const a=express();a.use(express.json());a.use('/api/sccrm',require('../routes/centralPromotions'));a.use('/sccrm/promotions',require('../routes/promotionPortal'));return a;}
beforeEach(()=>{mockQuery.mockReset();mockQuery.mockImplementation(async sql=>String(sql).startsWith('SELECT id FROM users')?{rowCount:1,rows:[{id:'admin'}]}:{rowCount:1,rows:[promotion()]});process.env.JWT_SECRET='synthetic-admin-fixture';process.env.SCCRM_PROMOTION_ADMIN_EMAILS='test-admin@example.invalid';});
test('same central award ignores client version and local point estimate',()=>{
 expect(quotePoints(250,[promotion()])).toMatchObject({basePoints:10,awardedPoints:20,bahtPerPoint:25});
 expect(quotePoints(249.99,[]).awardedPoints).toBe(9);
 expect(quotePoints(25,[]).awardedPoints).toBe(1);
});
test('bonus rules have a common minimum spend and deterministic stacking',()=>{
 const rules=[promotion({condition_json:{minimum_spend:250}}),promotion({id:'bonus',type:'threshold',value:5,condition_json:{minimum_spend:250}})];
 expect(quotePoints(249,rules).awardedPoints).toBe(9);
 expect(quotePoints(250,rules).awardedPoints).toBe(25);
 expect(quotePoints(0,[promotion({type:'fixed_bonus',value:5,condition_json:{minimum_spend:1}})]).awardedPoints).toBe(0);
 expect(quotePoints(0,[promotion({type:'fixed_bonus',value:5})])).toMatchObject({awardedPoints:0,appliedPromotions:[]});
});
test('revision changes when business rules change without changing any app version',()=>{
 expect(quotePoints(250,[promotion()]).revision).not.toBe(quotePoints(250,[promotion({value:3})]).revision);
});
test.each([{type:'unknown'},{value:-1},{value:Infinity},{value:101},{condition_json:{unexpected:1}},{condition_json:{minimum_spend:-1}},{condition_json:{branch_codes:[]}},{condition_json:{branch_codes:['<script>']}},{starts_at:'bad'},{starts_at:'2026-10-22',ends_at:'2026-10-21'},{is_active:'false'}])('rejects malformed rules %j',input=>{
 expect(()=>validatePromotion(promotion(input))).toThrow();
});
test('eligible receipt excludes pharmacy lines on server too',()=>{
 const items=[{productName:'วิตามิน',lineTotal:250,unitPrice:250,qty:1},{productName:'เภสัช ยาทดสอบ',lineTotal:100,unitPrice:100,qty:1}];
 expect(receiptEligibleAmount(items)).toBe(250);
 expect(()=>receiptEligibleAmount([{...items[0],qty:-1}])).toThrow();
 expect(()=>quotePoints(Infinity,[])).toThrow();
 expect(()=>quotePoints(10000001,[])).toThrow();
});
test('branch-restricted test promotions never leak into other branch calculations',async()=>{
 mockQuery.mockResolvedValue({rows:[promotion({condition_json:{branch_codes:['TEST_ONLY']}})]});
 expect(await getActivePromotions({query:mockQuery},'005')).toEqual([]);
 expect(await getActivePromotions({query:mockQuery},'test_only')).toHaveLength(1);
 expect(mockQuery.mock.calls[0][0]).toContain('ends_at > NOW()');
});
test('older and newer clients get identical uncached catalog and quote',async()=>{
 const old=await request(app()).get('/api/sccrm/promotions/active').set('X-App-Version','1.1.0');
 const newer=await request(app()).get('/api/sccrm/promotions/active').set('X-App-Version','1.2.0');
 expect(old.status).toBe(200);expect(old.headers['cache-control']).toBe('no-store');
 expect(old.body.revision).toBe(newer.body.revision);expect(old.body.promotions).toEqual(newer.body.promotions);
 const quote=await request(app()).get('/api/sccrm/promotions/quote?amount=250');expect(quote.body.awardedPoints).toBe(20);
});
test('unavailable central rules produce an error instead of silently awarding base points',async()=>{
 mockQuery.mockRejectedValue(Error('synthetic DB failure'));
 const response=await request(app()).get('/api/sccrm/promotions/quote?amount=250');
 expect(response.status).toBe(503);expect(response.body.awardedPoints).toBeUndefined();
});
test('staff token cannot publish a promotion; allowlisted site admin can',async()=>{
 const denied=await request(app()).post('/api/sccrm/promotions').set('Authorization','Bearer opaque-staff-token').send(promotion());expect(denied.status).toBe(401);
 const ordinary=jwt.sign({userId:'00000000-0000-4000-8000-000000000001',email:'normal@example.invalid'},process.env.JWT_SECRET);
 expect((await request(app()).post('/api/sccrm/promotions').set('Authorization','Bearer '+ordinary).send(promotion())).status).toBe(403);
 const admin=jwt.sign({userId:'00000000-0000-4000-8000-000000000001',email:'test-admin@example.invalid'},process.env.JWT_SECRET);
 expect((await request(app()).post('/api/sccrm/promotions').set('Authorization','Bearer '+admin).send(promotion())).status).toBe(201);
});
test('public portal works on old devices without requiring a session or app download',async()=>{
 const response=await request(app()).get('/sccrm/promotions');expect(response.status).toBe(200);expect(response.text).toContain('โปรโมชั่นสะสมแต้ม');expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
});
test('initial admin setup requires a scoped expiring invite and cannot replace an existing password',async()=>{
 let accountExists=false;
 mockQuery.mockImplementation(async sql=>{
  if(String(sql).startsWith('SELECT id FROM users WHERE lower(email)'))return {rowCount:accountExists?1:0,rows:[]};
  if(String(sql).startsWith('INSERT INTO users'))accountExists=true;
  return {rowCount:1,rows:[]};
 });
 const invite=jwt.sign({scope:'promotion-admin-setup',email:'test-admin@example.invalid'},require('../lib/promotionAdminSetup').setupSigningSecret(),{algorithm:'HS256',audience:'sccrm-promotion-admin-setup',issuer:'sccrm-admin-operator',jwtid:'test-invite',expiresIn:'1h'});
 expect((await request(app()).post('/api/sccrm/promotions/admin/setup').send({setupToken:'invalid',password:'synthetic-test-password'})).status).toBe(401);
 expect((await request(app()).post('/api/sccrm/promotions/admin/setup').send({setupToken:invite,password:'short'})).status).toBe(400);
 expect((await request(app()).post('/api/sccrm/promotions').set('Authorization','Bearer '+invite).send(promotion())).status).toBe(401);
 expect((await request(app()).post('/api/sccrm/promotions/admin/setup').send({setupToken:invite,password:'synthetic-test-password'})).status).toBe(201);
 expect((await request(app()).post('/api/sccrm/promotions/admin/setup').send({setupToken:invite,password:'synthetic-replacement-password'})).status).toBe(409);
});
