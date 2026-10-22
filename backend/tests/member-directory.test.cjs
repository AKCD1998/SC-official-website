const express = require('express');
const request = require('supertest');
jest.mock('../db', () => ({ query: jest.fn() }));
const pool = require('../db');
const router = require('../routes/sccrmInternal');
const { buildReceiptSnapshot } = require('../lib/purchaseHistory');
const app = express(); app.use('/internal', router);
const id = '11111111-1111-4111-8111-111111111111';
beforeEach(() => { pool.query.mockReset(); process.env.SCCRM_INTERNAL_API_TOKEN = 'synthetic-directory-test-token'; });
afterAll(() => { delete process.env.SCCRM_INTERNAL_API_TOKEN; });
function get(path) { return request(app).get('/internal/crm/member-directory' + path).set('x-internal-token', process.env.SCCRM_INTERNAL_API_TOKEN); }
test('directory and history require the existing internal credential before querying data', async () => {
  for (const path of ['', `/${id}/purchase-history`]) {
    expect((await request(app).get('/internal/crm/member-directory' + path)).status).toBe(401);
    expect((await request(app).get('/internal/crm/member-directory' + path).set('x-internal-token', 'wrong')).status).toBe(401);
  }
  expect(pool.query).not.toHaveBeenCalled();
});
test('bounded literal search returns only directory fields including QR members', async () => {
  pool.query.mockResolvedValue({ rows: [{ total: 1, members: [{ id, full_name: 'ลูกค้าทดสอบ', phone_number: '0990000000', member_code: 'SC-QR', is_active: true, created_at: '2026-10-22T00:00:00Z', email: 'private', dob: 'private' }] }] });
  const response = await get('?search=QR%25_&page=2&limit=25');
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.body).toEqual({ ok: true, page: 2, limit: 25, total: 1, members: [{ id, name: 'ลูกค้าทดสอบ', phone: '0990000000', memberCode: 'SC-QR', isActive: true, registeredAt: '2026-10-22T00:00:00Z' }] });
  expect(pool.query.mock.calls[0][1]).toEqual(['QR%_', '%QR\\%\\_%', 25, 25]);
  expect(pool.query.mock.calls[0][0]).toContain('JOIN member_profiles');
});
test.each(['?limit=101', '?page=0', '?search[a]=x', '/not-a-uuid/purchase-history', `/${id}/purchase-history?cursor=bad`, `/${id}/purchase-history?limit=501`])('rejects invalid inputs without database access: %s', async path => {
  expect((await get(path)).status).toBe(400); expect(pool.query).not.toHaveBeenCalled();
});
test('history uses the same member-scoped reader and retains unit snapshots and Thai source time', async () => {
  const snapshot = buildReceiptSnapshot({ receiptTotalAmount: 90 }, [{ productCode: 'IC-TEST', productName: 'สินค้า', unitCode: 'BOX', unitName: 'กล่อง', qty: 3, unitPrice: 30, lineTotal: 90 }]);
  pool.query.mockResolvedValueOnce({ rows: [{ id }] })
    .mockResolvedValueOnce({ rows: [{ id: 'claim-owned', receipt_no: 'BILL-TEST', branch_code: '005', sold_at: '2026-10-22T03:04:05Z', receipt_total_amount: 90, receipt_snapshot: snapshot }] })
    .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
  const response = await get(`/${id}/purchase-history?limit=25`);
  expect(response.status).toBe(200);
  expect(pool.query.mock.calls[1][1]).toEqual([id, 26]);
  expect(response.body.purchases[0]).toMatchObject({ receiptNo: 'BILL-TEST', soldAt: '2026-10-22T03:04:05Z', items: [{ productCode: 'IC-TEST', unitCode: 'BOX', unitName: 'กล่อง', qty: 3 }] });
  expect(buildReceiptSnapshot({}, [{ qty: 1, unitPrice: 1, lineTotal: 1 }]).items[0]).toMatchObject({ unitCode: null, unitName: null });
});
test('missing members return 404 and database failures do not disclose SQL or credentials', async () => {
  pool.query.mockResolvedValueOnce({ rows: [] });
  expect((await get(`/${id}/purchase-history`)).status).toBe(404);
  pool.query.mockRejectedValueOnce(new Error('secret connection string SQL'));
  const response = await get(''); expect(response.status).toBe(500); expect(JSON.stringify(response.body)).not.toContain('secret');
});
