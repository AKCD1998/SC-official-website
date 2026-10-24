const express = require('express');
const request = require('supertest');
jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));
const pool = require('../db');
const router = require('../routes/sccrmInternal');
const app = express(); app.use(express.json()); app.use('/internal', router);
const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const prefix = '/internal/crm/member-directory';
beforeEach(() => {
  jest.clearAllMocks();
  process.env.SC_OFFICIAL_ADA_SYNC_ENABLED='true';
  process.env.SCCRM_INTERNAL_API_TOKEN='synthetic-read-token';
  process.env.SC_OFFICIAL_ADA_LINK_ADMIN_TOKEN='synthetic-separate-admin-token-at-least-32-characters';
});
afterAll(() => { delete process.env.SC_OFFICIAL_ADA_SYNC_ENABLED; delete process.env.SCCRM_INTERNAL_API_TOKEN; delete process.env.SC_OFFICIAL_ADA_LINK_ADMIN_TOKEN; });
const get = path => request(app).get(prefix+path).set('x-internal-token',process.env.SCCRM_INTERNAL_API_TOKEN);
const post = (body, write=true, member=id) => {
  const r=request(app).post(prefix+'/'+member+'/ada-links').set('x-internal-token',process.env.SCCRM_INTERNAL_API_TOKEN);
  if(write)r.set('x-ada-link-admin-token',process.env.SC_OFFICIAL_ADA_LINK_ADMIN_TOKEN);
  return r.send(body);
};
test('a POS/read-only internal token cannot authorize a link', async () => {
  expect((await post({adaCode:'A-1'},false)).status).toBe(403);
  expect((await request(app).post(prefix+'/'+id+'/ada-links').send({})).status).toBe(401);
  expect(pool.query).not.toHaveBeenCalled();expect(pool.connect).not.toHaveBeenCalled();
});
test('disabled feature and malformed reads never query customer records', async () => {
  process.env.SC_OFFICIAL_ADA_SYNC_ENABLED='false';expect((await get('/ada-links')).status).toBe(503);
  process.env.SC_OFFICIAL_ADA_SYNC_ENABLED='true';
  for(const path of ['/ada-links?limit=101','/ada-links?page=0','/ada-links?page[a]=1','/invalid/ada-links'])expect((await get(path)).status).toBe(400);
  expect(pool.query).not.toHaveBeenCalled();
});
async function options() {
  pool.query.mockResolvedValueOnce({rows:[{id,full_name:'Test member',phone_number:'0990000001',member_code:'SC-TEST'}]})
    .mockResolvedValueOnce({rows:[]})
    .mockResolvedValueOnce({rows:[{ada_code:'A-1',name:'Test native',phone:'0990000001',branch_code:'001',active:'1',payload_hash:'a'.repeat(64),sale_count:2,return_count:0,last_sale:null,source_payload:{pin:'never return'}}]});
  const r=await get('/'+id+'/ada-links');expect(r.status).toBe(200);return r;
}
test('options show exact native codes and history summary without raw source data', async () => {
  const r=await options();expect(r.body.candidates[0]).toMatchObject({adaCode:'A-1',saleCount:2,linkedMemberId:null,reviewToken:expect.any(String)});
  expect(r.body.member.id).toBe(id);expect(r.headers['cache-control']).toBe('private, no-store');
  expect(r.text).not.toContain('source_payload');expect(r.text).not.toContain('payload_hash');expect(r.text).not.toContain('never return');
});
test('tampered or cross-member choices and untrusted actor fields cannot reach a write transaction', async () => {
  const r=await options(),token=r.body.candidates[0].reviewToken,actor={id:'test-admin',role:'admin'};
  for(const [body,member]of [
    [{adaCode:'A-1',reviewToken:token+'x',actor},id],
    [{adaCode:'A-2',reviewToken:token,actor},id],
    [{adaCode:'A-1',reviewToken:token,actor},other],
    [{adaCode:'A-1',reviewToken:token,actor:{id:'test',role:'staff'}},id],
    [{adaCode:'A-1',reviewToken:token,actor,userId:other},id],
  ])expect((await post(body,true,member)).status).toBe(400);
  expect(pool.connect).not.toHaveBeenCalled();
});
test('upstream storage errors are sanitized', async () => {
  pool.query.mockRejectedValueOnce(Error('secret SQL connection string'));
  const r=await get('/ada-links');expect(r.status).toBe(500);expect(r.text).not.toContain('secret');
});
