const express=require('express'),request=require('supertest');
const {createShopee004StockRoutes}=require('../src/modules/seamless/routes/shopee004StockRoutes');
const read='synthetic-read-token-12345678901234567890',write='synthetic-write-token-1234567890123456789';
function fixture({enabled=true,role='admin',writeCredential=write}={}){
 const calls=[],app=express();app.use(express.json());
 const store={exceptions:async body=>{calls.push(['exceptions',body]);return {records:[]};},approveMapping:async body=>{calls.push(['mapping',body]);return {recorded:true};},revoke:async body=>{calls.push(['revoke',body]);return {recorded:true};},importEvidence:async body=>{calls.push(['proof',body]);return {recorded:true};},approveCatalogMapping:async body=>{calls.push(['catalog',body]);return {recorded:true};}};
 const routes=createShopee004StockRoutes({ledger:()=>({projection:async()=>({status:'available'}),reconciliation:async()=>({openingBoundaryPreserved:true})}),identityStore:()=>store,
  readToken:()=>read,reviewToken:()=>writeCredential,exceptionAdminEnabled:()=>enabled,
  auth:(req,res,next)=>{req.appRole=role;req.appAuthSource='admin_basic';req.appActor='synthetic-human';next();}});
 app.use('/read',routes.internal);app.use('/write',routes.privileged);app.use('/human',routes.admin);return {app,calls};
}
test('projection read credential cannot approve mappings or create trusted proof',async()=>{
 const f=fixture();expect((await request(f.app).post('/write/mapping').set('Authorization','Bearer '+read).send({actor:'synthetic-admin'})).status).toBe(403);expect(f.calls).toHaveLength(0);
 expect((await request(f.app).post('/write/identity-evidence').set('Authorization','Bearer '+write).send({actor:'synthetic-admin'})).status).toBe(404);expect(f.calls).toHaveLength(0);
});
test('new privileged bridge defaults fail-closed and rejects reused projection credential',async()=>{
 let f=fixture({enabled:false}),r=await request(f.app).post('/write/mapping').set('Authorization','Bearer '+write).send({actor:'synthetic-admin'});expect(r.status).toBe(503);expect(r.body.error.definitiveNoWrite).toBe(true);expect(f.calls).toHaveLength(0);
 f=fixture({writeCredential:read});expect((await request(f.app).post('/write/mapping').set('Authorization','Bearer '+read).send({actor:'synthetic-admin'})).status).toBe(403);
});
test('read-only queue and reconciliation retain separate bearer scope',async()=>{
 const f=fixture();expect((await request(f.app).post('/read/exceptions').set('Authorization','Bearer '+read).send({limit:25})).status).toBe(200);expect(f.calls[0][0]).toBe('exceptions');
 expect((await request(f.app).post('/read/reconciliation').set('Authorization','Bearer '+read).send({})).body.openingBoundaryPreserved).toBe(true);
});
test('human proof imports require existing app admin/action protection and overwrite forged actor',async()=>{
 const f=fixture();expect((await request(f.app).post('/human/identity-evidence').send({})).status).toBe(403);
 expect((await request(f.app).post('/human/identity-evidence').set('x-shopee-stock-action','1').send({actor:'forged',facts:[]})).status).toBe(200);expect(f.calls[0][1].actor).toBe('synthetic-human');
 const branch=fixture({role:'branch'});expect((await request(branch.app).post('/human/identity-evidence').set('x-shopee-stock-action','1').send({})).status).toBe(403);
});
test('proactive catalog binding is a separate human action and contains no lifecycle operation',async()=>{
 const f=fixture();expect((await request(f.app).post('/human/identity-catalog-mapping').set('x-shopee-stock-action','1').send({actor:'forged',listingId:'synthetic-listing'})).status).toBe(200);
 expect(f.calls[0][0]).toBe('catalog');expect(f.calls[0][1].actor).toBe('synthetic-human');expect(f.calls[0][1].kind).toBeUndefined();
});
