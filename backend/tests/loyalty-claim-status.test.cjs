const express = require('express');
const request = require('supertest');
process.env.SCCRM_REFRESH_TOKEN_SECRET = 'synthetic-status-test-only';
jest.mock('../db', () => ({query: jest.fn()}));
const pool = require('../db');
const {hashOpaqueToken} = require('../lib/sccrm');
const router = require('../routes/loyalty');
let claim, staffBranch, revoked, unavailable;
const app = express();
app.use('/api/loyalty', router);
const lookup = (query = {branchCode:'004',receiptNo:'S-FIXTURE'}) => request(app).get('/api/loyalty/claims/status').query(query).set('Authorization','Bearer synthetic-status-session');
beforeEach(() => {
  claim = {id:'claim-fixture',created_at:'2026-10-23T04:00:00Z',user_id:'member-a',full_name:'สมาชิกที่บันทึกจริง',member_code:'SCM-FIXTURE'};
  staffBranch='004';revoked=false;unavailable=false;
  pool.query.mockReset().mockImplementation(async(sql,params) => {
    if(sql.includes('SELECT sd.id'))return {rows: !revoked && params[0]===hashOpaqueToken('synthetic-status-session') ? [{id:'device-fixture',branch_code:staffBranch}] : []};
    if(sql.startsWith('UPDATE staff_devices SET last_seen_at'))return {rows:[]};
    if(sql.includes('SELECT lc.id, lc.created_at')) {
      if(unavailable)throw new Error('synthetic database failure');
      return {rows:claim && params[0]==='004' && params[1]==='S-FIXTURE' ? [claim] : []};
    }
    throw new Error('Unexpected SQL in status lookup');
  });
});
test('returns the stored owner and never an owner selected by the caller', async() => {
  const response=await lookup({branchCode:' 004 ',receiptNo:' s-fixture ',memberId:'member-b'});
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.body).toEqual({ok:true,branchCode:'004',receiptNo:'S-FIXTURE',claimed:true,claimId:'claim-fixture',claimedAt:claim.created_at,member:{id:'member-a',displayName:claim.full_name,memberCode:'SCM-FIXTURE'}});
  expect(pool.query.mock.calls.filter(([sql])=>/INSERT|DELETE|UPDATE loyalty|UPDATE users|point_ledger/.test(sql))).toHaveLength(0);
});
test('an unclaimed receipt has an explicit false state without member data', async() => {
  claim=null;
  expect((await lookup()).body).toEqual({ok:true,branchCode:'004',receiptNo:'S-FIXTURE',claimed:false});
});
test('rejects anonymous, invalid, revoked and POS-key-only sessions', async() => {
  expect((await request(app).get('/api/loyalty/claims/status')).status).toBe(401);
  expect((await request(app).get('/api/loyalty/claims/status').set('x-pos-api-key','synthetic-key')).status).toBe(401);
  expect((await request(app).get('/api/loyalty/claims/status').set('Authorization','Bearer invalid')).status).toBe(401);
  revoked=true;expect((await lookup()).status).toBe(401);
});
test('refuses another branch before looking up member information', async() => {
  expect((await lookup({branchCode:'001',receiptNo:'S-FIXTURE'})).status).toBe(403);
  expect(pool.query.mock.calls.some(([sql])=>sql.includes('SELECT lc.id'))).toBe(false);
});
test('validates missing, repeated and oversized receipt arguments', async() => {
  for(const query of [{},{branchCode:'004'},{branchCode:'4',receiptNo:'S-FIXTURE'},{branchCode:['004','001'],receiptNo:'S-FIXTURE'},{branchCode:'004',receiptNo:'S'.repeat(101)}])expect((await lookup(query)).status).toBe(400);
});
test('a database failure is an error, never an unclaimed receipt', async() => {
  unavailable=true;const response=await lookup();
  expect(response.status).toBe(500);expect(response.body.claimed).toBeUndefined();
  expect(response.body.error).toBe('Failed to check receipt status.');
});
test('each request sees fresh ownership and supports centrally authorized staff without a branch binding', async() => {
  staffBranch=null;claim=null;expect((await lookup()).body.claimed).toBe(false);
  claim={id:'new-claim',user_id:'member-b',full_name:'สมาชิกใหม่',member_code:'SCM-B'};
  const response=await lookup();expect(response.body.claimed).toBe(true);expect(response.body.member.id).toBe('member-b');
});
