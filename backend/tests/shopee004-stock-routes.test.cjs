const express = require('express'), request = require('supertest');
const { createShopee004StockRoutes } = require('../src/modules/seamless/routes/shopee004StockRoutes');
const { startShopee004StockMaintenance } = require('../src/modules/seamless/services/shopee004StockRuntime');
const { validateCatalog } = require('../src/modules/seamless/services/shopee004StockPolicy');
function fixture(source = 'admin_basic', role = 'admin') {
  const ledger = { projection: jest.fn(async () => ({status:'available'})), prepare: jest.fn(async () => ({activated:false})),
    activate: jest.fn(async input => ({actor:input.actor})), pause: jest.fn(), review: jest.fn(),
    reconcileAcceptedLegacy: jest.fn(async input => ({actor:input.actor})) };
  const routers=createShopee004StockRoutes({ledger:()=>ledger,auth:(req,res,next)=>{
    req.appAuthSource=source;req.appRole=role;req.appActor='synthetic-admin';next();},readToken:()=> 'x'.repeat(40),allowedOrigins:()=>['https://trusted.invalid']});
  const app=express();app.use(express.json());app.use('/admin',routers.admin);app.use('/internal',routers.internal);
  return {app,ledger};
}
test.each(['local_default_open','internal_token','basic_user'])('%s cannot write durable reservations',async source=>{
  const {app,ledger}=fixture(source);
  expect((await request(app).post('/admin/activate').set('x-shopee-stock-action','1').send({})).status).toBe(403);
  expect(ledger.activate).not.toHaveBeenCalled();
});
test('human writes require action header and trusted Origin; caller cannot forge audit actor',async()=>{
  const {app,ledger}=fixture();
  expect((await request(app).post('/admin/activate').send({})).status).toBe(403);
  expect((await request(app).post('/admin/activate').set('x-shopee-stock-action','1').set('Origin','https://evil.invalid').send({})).status).toBe(403);
  const r=await request(app).post('/admin/activate').set('x-shopee-stock-action','1').set('Origin','https://trusted.invalid').send({actor:'forged'});
  expect(r.status).toBe(200);expect(r.body.actor).toBe('synthetic-admin');expect(ledger.activate).toHaveBeenCalledTimes(1);
});
test('dedicated read token only reaches fixed-scope projection, never admin mutations',async()=>{
  const {app,ledger}=fixture('internal_token');
  expect((await request(app).post('/internal/projection').send({productCodes:[]})).status).toBe(401);
  const r=await request(app).post('/internal/projection').set('Authorization','Bearer '+'x'.repeat(40)).send({productCodes:['P1'],branch:'001'});
  expect(r.status).toBe(200);expect(r.headers['cache-control']).toBe('no-store');expect(ledger.projection).toHaveBeenCalledWith(['P1']);
  expect((await request(app).post('/admin/review').set('Authorization','Bearer '+'x'.repeat(40)).send({})).status).toBe(403);
});

test('accepted-estimate requeue requires human admin and action protection and cannot forge the actor',async()=>{
  const {app,ledger}=fixture();
  expect((await request(app).post('/admin/reconcile-accepted-legacy').send({ownerAcceptedOpeningEstimate:true})).status).toBe(403);
  expect((await request(app).post('/admin/reconcile-accepted-legacy').set('x-shopee-stock-action','1')
    .send({ownerAcceptedOpeningEstimate:true,actor:'forged'})).status).toBe(200);
  expect(ledger.reconcileAcceptedLegacy).toHaveBeenCalledWith({ownerAcceptedOpeningEstimate:true,actor:'synthetic-admin'});
  const readonly=fixture('internal_token');
  expect((await request(readonly.app).post('/admin/reconcile-accepted-legacy').set('x-shopee-stock-action','1')
    .send({ownerAcceptedOpeningEstimate:true})).status).toBe(403);
  expect(readonly.ledger.reconcileAcceptedLegacy).not.toHaveBeenCalled();
});
test('upstream and database failures never return raw details or private parameters',async()=>{
  const {app,ledger}=fixture();ledger.projection.mockRejectedValue(Object.assign(new Error('secret synthetic value'),{code:'42P01',details:'private'}));
  const r=await request(app).get('/admin/status');expect(r.status).toBe(503);
  expect(JSON.stringify(r.body)).not.toMatch(/secret|private|42P01/);expect(r.body.error.detailsWithheld).toBe(true);
});
test('disabled maintenance never schedules or reads; unit contract strips unrelated fields',()=>{
  const processOne=jest.fn();const stop=startShopee004StockMaintenance({enabled:false,processOne});stop();expect(processOne).not.toHaveBeenCalled();
  const index=validateCatalog([{companySku:'P1',stockCode:'P1',active:true,stockFactor:1,smallFactor:1,smallUnit:'ซอง',productName:'Synthetic 8 tablets',token:'must-not-store'}]);
  expect(index.get('P1')).not.toHaveProperty('token');
  expect(index.get('P1').productName).toBe('Synthetic 8 tablets');
});
