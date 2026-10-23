const express=require('express'),request=require('supertest');
const {createShopee004StockRoutes,stockPlanJsonParser}=require('../src/modules/seamless/routes/shopee004StockRoutes');
function app(){const a=express(),prepare=jest.fn(async input=>({receivedBasis:!!input.openingBasis}));
 a.use('/plan',stockPlanJsonParser());a.use(express.json());
 const auth=(req,res,next)=>{req.appRole='admin';req.appAuthSource='admin_basic';req.appActor='synthetic-human';next();};
 a.use(createShopee004StockRoutes({ledger:()=>({prepare}),auth}).admin);
 a.post('/other',(_q,res)=>res.json({ok:true}));a.use((e,_q,res,_next)=>res.status(e.status||500).json({rejected:true}));
 return {a,prepare};}
test('reviewed plan body above 100 KB reaches the authenticated route; other routes keep the old limit',async()=>{
 const {a,prepare}=app(),body={openingBasis:{padding:'x'.repeat(150000)}};
 expect((await request(a).post('/plan').set('x-shopee-stock-action','1').send(body)).status).toBe(200);expect(prepare).toHaveBeenCalledTimes(1);
 expect((await request(a).post('/other').send(body)).status).toBe(413);
 expect((await request(a).post('/plan').set('x-shopee-stock-action','1').send({padding:'x'.repeat(530000)})).status).toBe(413);
 expect(prepare).toHaveBeenCalledTimes(1);
});
