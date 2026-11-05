const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const request = require("supertest");
const { Client } = require("pg");
const { provisionCrmCounter } = require("../scripts/provision-crm-counter.cjs");

let mockClient;
let mockTransactionNumber = 0;
const mockPool = {
  query: (...args) => mockClient.query(...args),
  async connect() {
    const savepoint = `crm_counter_route_${++mockTransactionNumber}`;
    return {
      async query(sql, params) {
        if (sql === "BEGIN") return mockClient.query(`SAVEPOINT ${savepoint}`);
        if (sql === "COMMIT") return mockClient.query(`RELEASE SAVEPOINT ${savepoint}`);
        if (sql === "ROLLBACK") return mockClient.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        return mockClient.query(sql, params);
      },
      release() {},
    };
  },
};
jest.mock("../db", () => mockPool);
jest.mock("@sendgrid/mail", () => ({ setApiKey: jest.fn(), send: jest.fn() }));

const run = process.env.CRM_COUNTER_POSTGRES_SMOKE === "1";
const describePostgres = run ? describe : describe.skip;
const sql = fs.readFileSync(path.join(__dirname,
  "../migrations/202610200001_crm_counter_bootstrap.sql"), "utf8");

describePostgres("CRM counter bootstrap with PostgreSQL and real route handlers", () => {
  let app;
  let staffToken;
  let memberId;
  const priorPin = process.env.SCCRM_STAFF_PIN;
  const priorNames = process.env.SCCRM_ALLOWED_STAFF_DEVICE_NAMES;
  const priorRefreshSecret = process.env.SCCRM_REFRESH_TOKEN_SECRET;
  const member = {
    name: "Synthetic counter fixture",
    phone: "0990000000",
    email: "crm-counter-fixture@example.invalid",
    dob: "1990-01-01",
    sex: "female",
    consents: { pdpa_general: true, pdpa_health: true },
  };

  beforeAll(async () => {
    const raw = process.env.SC_OFFICIAL_SUPABASE_DATABASE_URL;
    if (!raw || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(raw).hostname)) {
      throw new Error("CRM integration tests require an explicitly enabled local ephemeral database");
    }
    mockClient = new Client({ connectionString: raw, ssl: false });
    await mockClient.connect();
    const before = await mockClient.query("SELECT to_regclass('public.users') IS NULL AS empty");
    if (!before.rows[0].empty) throw new Error("CRM integration database must start without CRM tables");
    const dry = await provisionCrmCounter(mockClient);
    expect(dry.status).toBe("dry-run-rolled-back");
    const after = await mockClient.query("SELECT to_regclass('public.users') IS NULL AS empty");
    expect(after.rows[0].empty).toBe(true);

    await mockClient.query("BEGIN");
    await mockClient.query(sql);
    await mockClient.query(fs.readFileSync(path.join(__dirname, '../migrations/20261101042429_crm_member_registrations.sql'), 'utf8'));
    process.env.SCCRM_STAFF_PIN = "synthetic-fixture-pin";
    process.env.SCCRM_REFRESH_TOKEN_SECRET = "synthetic-fixture-hmac-secret";
    process.env.SCCRM_ALLOWED_STAFF_DEVICE_NAMES = "synthetic-counter-fixture";
    app = express();
    app.use(express.json());
    app.use("/api/sccrm", require("../routes/sccrm"));
    app.use("/api/crm", require("../routes/crmMembers"));
    app.use("/api/members", require("../routes/loyalty"));
    app.use("/join", require("../routes/publicMemberRegistration").createPublicMemberRegistration({ pool: mockPool, maxRequests: 1000 }));
  });

  const priorPosKey = process.env.POS_API_KEY;
  beforeAll(() => { process.env.POS_API_KEY = "synthetic-pos-fixture-key"; });
  afterAll(() => {
    if (priorPosKey === undefined) delete process.env.POS_API_KEY;
    else process.env.POS_API_KEY = priorPosKey;
  });

  afterAll(async () => {
    if (mockClient) {
      await mockClient.query("ROLLBACK");
      await mockClient.end();
    }
    if (priorPin === undefined) delete process.env.SCCRM_STAFF_PIN;
    else process.env.SCCRM_STAFF_PIN = priorPin;
    if (priorNames === undefined) delete process.env.SCCRM_ALLOWED_STAFF_DEVICE_NAMES;
    else process.env.SCCRM_ALLOWED_STAFF_DEVICE_NAMES = priorNames;
    if (priorRefreshSecret === undefined) delete process.env.SCCRM_REFRESH_TOKEN_SECRET;
    else process.env.SCCRM_REFRESH_TOKEN_SECRET = priorRefreshSecret;
  });

  test("rejects anonymous requests and a Sync key header without a staff session", async () => {
    const anonymous = await request(app).post("/api/crm/members").send(member);
    const sync = await request(app).post("/api/crm/members").set("x-pos-api-key", "synthetic-sync-key").send(member);
    expect(anonymous.status).toBe(401);
    expect(sync.status).toBe(401);
  });

  test("rejects a wrong staff PIN before creating a device", async () => {
    const response = await request(app).post("/api/sccrm/auth/staff-device").send({
      deviceId: "synthetic-fixture-device", deviceName: "synthetic-counter-fixture", pin: "incorrect",
    });
    expect(response.status).toBe(401);
    const count = await mockClient.query("SELECT count(*)::int AS count FROM public.staff_devices");
    expect(count.rows[0].count).toBe(0);
  });

  test("authenticates the existing staff-device contract and registers profile/consent atomically", async () => {
    const login = await request(app).post("/api/sccrm/auth/staff-device").send({
      deviceId: "synthetic-fixture-device", deviceName: "synthetic-counter-fixture", pin: "synthetic-fixture-pin",
    });
    expect(login.status).toBe(200);
    expect(typeof login.body.staffToken === "string").toBe(true);
    staffToken = login.body.staffToken;
    const registration = await request(app).post("/api/crm/members")
      .set("Authorization", `Bearer ${staffToken}`).send(member);
    expect(registration.status).toBe(201);
    expect(registration.body.ok === true).toBe(true);
    memberId = registration.body.data.id;
    const counts = await mockClient.query(`SELECT
      (SELECT count(*)::int FROM public.users) AS users,
      (SELECT count(*)::int FROM public.member_profiles) AS profiles,
      (SELECT count(*)::int FROM public.crm_member_consents WHERE pdpa_general AND pdpa_health) AS consents`);
    expect(counts.rows[0]).toEqual({ users: 1, profiles: 1, consents: 1 });
  });

  test("rejects duplicate registration and preserves the original profile", async () => {
    const response = await request(app).post("/api/crm/members")
      .set("Authorization", `Bearer ${staffToken}`).send(member);
    expect(response.status).toBe(409);
    const count = await mockClient.query("SELECT count(*)::int AS count FROM public.users");
    expect(count.rows[0].count).toBe(1);
  });

  test("supports the existing optional health-record upsert with synthetic data", async () => {
    const first = await request(app).put(`/api/crm/members/${memberId}/health`)
      .set("Authorization", `Bearer ${staffToken}`).send({ hasDiabetes: false });
    const second = await request(app).put(`/api/crm/members/${memberId}/health`)
      .set("Authorization", `Bearer ${staffToken}`).send({ hasDiabetes: true });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const count = await mockClient.query("SELECT count(*)::int AS count FROM public.crm_member_health_records");
    expect(count.rows[0].count).toBe(1);
  });

  test("reapplying setup preserves fixture rows and the single ledger entry", async () => {
    await mockClient.query(sql);
    const counts = await mockClient.query(`SELECT
      (SELECT count(*)::int FROM public.users) AS users,
      (SELECT count(*)::int FROM public.crm_counter_schema_migrations WHERE filename='202610200001_crm_counter_bootstrap.sql') AS ledger`);
    expect(counts.rows[0]).toEqual({ users: 1, ledger: 1 });
  });

  test("RLS denies a non-owner role even when it receives SELECT permission", async () => {
    await mockClient.query("CREATE ROLE crm_counter_reader_ci NOLOGIN");
    await mockClient.query("GRANT USAGE ON SCHEMA public TO crm_counter_reader_ci");
    await mockClient.query("GRANT SELECT ON public.users TO crm_counter_reader_ci");
    await mockClient.query("SET LOCAL ROLE crm_counter_reader_ci");
    try {
      const rows = await mockClient.query("SELECT count(*)::int AS count FROM public.users");
      expect(rows.rows[0].count).toBe(0);
    } finally {
      await mockClient.query("RESET ROLE");
    }
    const security = await mockClient.query(`SELECT count(*)::int AS count
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND c.relrowsecurity`,
    [["users", "branches", "staff_devices", "member_profiles", "crm_member_consents", "crm_member_health_records", "crm_counter_schema_migrations"]]);
    expect(security.rows[0].count).toBe(7);
  });

  test("POS creates, searches and edits the same QR identity without loyalty or medical tables", async () => {
    const key = "synthetic-pos-fixture-key";
    const authorization = `Bearer ${staffToken}`;
    const qrPhone = "0990000011";
    const qr = await request(app).post("/join/submit").send({
      firstName: "QR", lastName: "Shared Identity", phone: qrPhone, consent: true,
    });
    expect(qr.status).toBe(200);
    const search = await request(app).get("/api/members/search").query({ q: "+66 99 000 0011" }).set("Authorization", authorization);
    expect(search.status).toBe(200);
    expect(search.body).toHaveLength(1);
    const qrMember = search.body[0];
    expect(qrMember).toEqual(expect.objectContaining({
      displayName: "QR Shared Identity", phone: qrPhone,
      pointsAvailable: false, pharmacyMedRecordAvailable: false, currentPoints: 0,
    }));
    await request(app).get(`/api/members/${qrMember.id}`).expect(401);
    const detail = await request(app).get(`/api/members/${qrMember.id}`).set("Authorization", authorization);
    expect(detail.status).toBe(200);
    expect(detail.body.memberCode).toBe(qrMember.memberCode);
    expect(detail.body.pharmacy_med_record).toBeNull();

    const update = await request(app).put(`/api/members/${qrMember.id}`).set("Authorization", authorization).send({
      name: "QR Updated by POS", phone: qrPhone, email: "shared-qr@example.invalid", sex: "female", dob: "1990-01-01", remark: "POS edit",
    });
    expect(update.status).toBe(200);
    expect(update.body).toEqual(expect.objectContaining({ id: qrMember.id, memberCode: qrMember.memberCode, displayName: "QR Updated by POS", remark: "POS edit" }));
    const consent = await mockClient.query(`SELECT u.is_verified, c.pdpa_general, c.pdpa_health, c.consent_version
      FROM users u JOIN crm_member_consents c ON c.user_id=u.id WHERE u.id=$1`, [qrMember.id]);
    expect(consent.rows).toEqual([{ is_verified: false, pdpa_general: true, pdpa_health: false, consent_version: "qr-v1.0" }]);

    const create = await request(app).post("/api/members").set("Authorization", authorization).send({
      name: "POS Created Identity", phone: "+66 99 000 0012", email: "pos-new@example.invalid", sex: "male", dob: "1988-09-15",
    });
    expect(create.status).toBe(201);
    expect(create.body.phone).toBe("0990000012");
    expect(create.body.pointsAvailable).toBe(false);
    const posId = create.body.id;
    const tier = await mockClient.query("SELECT tier FROM member_profiles WHERE user_id=$1", [posId]);
    expect(tier.rows[0].tier).toBe("bronze");
    const duplicate = await request(app).post("/api/members").set("Authorization", authorization).send({ name: "Must not replace", phone: qrPhone });
    expect(duplicate.status).toBe(409);
    const duplicateEdit = await request(app).put(`/api/members/${posId}`).set("x-pos-api-key", key).send({ name: "Must roll back", phone: qrPhone });
    expect(duplicateEdit.status).toBe(409);
    const unchanged = await request(app).get(`/api/members/${posId}`).set("x-pos-api-key", key);
    expect(unchanged.body.displayName).toBe("POS Created Identity");
    expect(unchanged.body.phone).toBe("0990000012");

    const medical = await request(app).put(`/api/members/${qrMember.id}`).set("x-pos-api-key", key).send({ name: "Must not partially save", pharmacy_med_record: { weightKg: 50 } });
    expect(medical.status).toBe(503);
    const after = await request(app).get(`/api/members/${qrMember.id}`).set("x-pos-api-key", key);
    expect(after.body.displayName).toBe("QR Updated by POS");
    const movePhone = await request(app).put(`/api/members/${posId}`).set("x-pos-api-key", key).send({ phone: "099-000-0013" });
    expect(movePhone.status).toBe(200);
    const found = await request(app).get("/api/members/search").query({ q: create.body.memberCode }).set("Authorization", authorization);
    expect(found.body[0]).toEqual(expect.objectContaining({ id: posId, phone: "0990000013" }));
  });
  test('provisions additive central promotions, awards the same rules to old and new requests, and preserves immutable snapshots', async () => {
    const {provisionCentralPromotions}=require('../scripts/provision-central-promotions.cjs');
    const dry=await provisionCentralPromotions(await mockPool.connect());
    expect(dry.status).toBe('dry-run-rolled-back');
    expect((await mockClient.query("SELECT to_regclass('public.promotions') IS NULL AS absent")).rows[0].absent).toBe(true);
    await provisionCentralPromotions(await mockPool.connect(),{apply:true});
    const {provisionPurchaseHistory}=require('../scripts/provision-purchase-history.cjs');
    expect((await provisionPurchaseHistory(await mockPool.connect())).status).toBe('dry-run-rolled-back');
    expect((await mockClient.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='loyalty_claims' AND column_name='receipt_snapshot'")).rows[0].n).toBe(0);
    await provisionPurchaseHistory(await mockPool.connect(),{apply:true});
    expect((await provisionPurchaseHistory(await mockPool.connect(),{apply:true})).alreadyApplied).toBe(true);
    expect((await provisionCentralPromotions(await mockPool.connect(),{apply:true})).alreadyApplied).toBe(true);
    const promoId='22222222-2222-4222-8222-222222222222';
    await mockClient.query(`INSERT INTO promotions(id,name,type,value,condition_json) VALUES($1,'Scoped double points','multiplier',2,'{"branch_codes":["TEST_PROMO"]}')`,[promoId]);
    const quote=await request(app).get('/api/sccrm/promotions/quote?amount=250&branchCode=TEST_PROMO');
    expect(quote.body.awardedPoints).toBe(20);
    const other=await request(app).get('/api/sccrm/promotions/quote?amount=250&branchCode=005');expect(other.body.awardedPoints).toBe(10);
    app.use('/api/loyalty',require('../routes/loyalty'));
    const claim={receiptNo:'PROMOTEST-OLD',branchCode:'TEST_PROMO',memberId,totalAmount:250,previewPoints:999999,items:[{productCode:'TEST',productName:'Synthetic fixture',qty:1,unitPrice:250,lineTotal:250}]};
    const old=await request(app).post('/api/loyalty/claims').set('Authorization','Bearer '+staffToken).set('X-App-Version','1.1.0').send(claim);
    expect(old.status).toBe(201);expect(old.body.awardedPoints).toBe(20);
    const newer=await request(app).post('/api/loyalty/claims').set('Authorization','Bearer '+staffToken).set('X-App-Version','1.2.0').send({...claim,receiptNo:'PROMOTEST-NEW'});
    expect(newer.status).toBe(201);expect(newer.body.awardedPoints).toBe(20);expect(newer.body.newPointsBalance).toBe(40);
    expect(newer.body.promotionRevision).toBe(old.body.promotionRevision);
    const duplicate=await request(app).post('/api/loyalty/claims').set('Authorization','Bearer '+staffToken).send(claim);expect(duplicate.status).toBe(409);
    const malformed=await request(app).post('/api/loyalty/claims').set('Authorization','Bearer '+staffToken).send({...claim,receiptNo:'PROMOTEST-BAD',totalAmount:1000});expect(malformed.status).toBe(400);
    await mockClient.query('UPDATE promotions SET value=3,updated_at=NOW() WHERE id=$1',[promoId]);
    const updated=await request(app).post('/api/loyalty/claims').set('Authorization','Bearer '+staffToken).send({...claim,receiptNo:'PROMOTEST-AFTER'});expect(updated.body.awardedPoints).toBe(30);
    const snapshots=await mockClient.query('SELECT promotion_snapshot,awarded_points FROM loyalty_claims ORDER BY created_at,id');
    expect(snapshots.rows.filter(r=>r.awarded_points===20)).toHaveLength(2);
    expect(snapshots.rows.filter(r=>r.awarded_points===20).every(r=>r.promotion_snapshot[0].value===2)).toBe(true);
    expect((await mockClient.query('SELECT count(*)::int AS n FROM crm_loyalty_awards')).rows[0].n).toBe(3);
  });

  test('awards medicine purchases from old and new clients while preserving original totals and every ordered line', async () => {
    const auth='Bearer '+staffToken;
    const items=[{seq:3,productCode:'VIT',productName:'วิตามิน fixture',barcode:'SYNTHETIC-BC',unitCode:'BOX',unitName:'กล่อง',qty:2,unitPrice:130,lineTotal:250,lineDiscount:10,promotionCode:'PROMO_FIXTURE'},
      {seq:5,productCode:'DRUG',productName:'เภสัช fixture',qty:1,unitPrice:100,lineTotal:100}];
    const claim={receiptNo:'HISTORY-MIXED',branchCode:'TEST_HISTORY',memberId,totalAmount:250,receiptTotalAmount:340,receiptDiscount:10,posCode:'POS-TEST',receiptCashierCode:'CASH-TEST',soldAt:'2026-10-21T08:01:02+07:00',items};
    expect((await request(app).post('/api/loyalty/claims').set('Authorization',auth).send(claim)).status).toBe(201);
    const drug={...claim,receiptNo:'HISTORY-ZERO',totalAmount:0,receiptTotalAmount:100,receiptDiscount:0,items:[items[1]]};
    const zero=await request(app).post('/api/loyalty/claims').set('Authorization',auth).send(drug);
    expect(zero.status).toBe(201);expect(zero.body).toMatchObject({awardedPoints:4,eligibleAmount:100,pointsPolicy:'include-medicine-purchases-2026-10-29'});
    const current=await request(app).post('/api/loyalty/claims').set('Authorization',auth).send({...drug,receiptNo:'HISTORY-DRUG-CURRENT',totalAmount:100});
    expect(current.status).toBe(201);expect(current.body.awardedPoints).toBe(zero.body.awardedPoints);
    const free=await request(app).post('/api/loyalty/claims').set('Authorization',auth).send({...drug,receiptNo:'HISTORY-FREE',receiptTotalAmount:0,items:[{...items[1],lineTotal:0}]});
    expect(free.status).toBe(201);expect(free.body.awardedPoints).toBe(0);
    expect((await request(app).post('/api/loyalty/claims').set('Authorization',auth).send(claim)).status).toBe(409);
    let history=await request(app).get(`/api/members/${memberId}/purchase-history`).set('Authorization',auth);
    expect(history.status).toBe(200);
    const mixed=history.body.purchases.find(p=>p.receiptNo===claim.receiptNo);
    expect(mixed).toMatchObject({totalAmount:340,eligibleAmount:350,awardedPoints:14,totalAmountSource:'pos_header',receiptDiscount:10,posCode:'POS-TEST',receiptCashierCode:'CASH-TEST'});
    expect(mixed.items).toMatchObject(items);
    expect(history.body.purchases.find(p=>p.receiptNo===drug.receiptNo)).toMatchObject({totalAmount:100,eligibleAmount:100,awardedPoints:4,items:[{productCode:'DRUG'}]});
    const policy=await mockClient.query("SELECT receipt_snapshot FROM loyalty_claims WHERE receipt_no='HISTORY-MIXED'");
    expect(policy.rows[0].receipt_snapshot).toMatchObject({pointsPolicy:'include-medicine-purchases-2026-10-29',reportedEligibleAmount:250});
    // Already-claimed medicine bills retain the old award; replay cannot backfill them.
    await mockClient.query("INSERT INTO loyalty_claims(id,receipt_no,branch_code,total_amount,awarded_points,user_id) VALUES('HISTORICAL-DRUG','HISTORY-BEFORE-POLICY','TEST_HISTORY',0,0,$1)",[memberId]);
    const historical=await request(app).post('/api/loyalty/claims').set('Authorization',auth).send({...drug,receiptNo:'HISTORY-BEFORE-POLICY',totalAmount:100});
    expect(historical.status).toBe(409);
    expect((await mockClient.query("SELECT total_amount::int,awarded_points FROM loyalty_claims WHERE id='HISTORICAL-DRUG'")).rows).toEqual([{total_amount:0,awarded_points:0}]);
    expect((await mockClient.query("SELECT count(*)::int AS n FROM point_ledger WHERE reference_id='HISTORICAL-DRUG'")).rows[0].n).toBe(0);
    const mirrored=await mockClient.query("SELECT paid_total,pos_code,cashier_code FROM crm_pos_sale_events WHERE branch_code='TEST_HISTORY' AND doc_no='HISTORY-MIXED'");
    expect(Number(mirrored.rows[0].paid_total)).toBe(340);expect(mirrored.rows[0].pos_code).toBe('POS-TEST');expect(mirrored.rows[0].cashier_code).toBe('CASH-TEST');
    const units=await mockClient.query("SELECT l.unit_code,l.unit_name FROM crm_pos_sale_line_events l JOIN crm_pos_sale_events s ON s.id=l.sale_event_id WHERE s.branch_code='TEST_HISTORY' AND s.doc_no='HISTORY-MIXED' ORDER BY l.line_no");
    expect(units.rows).toEqual([{unit_code:'BOX',unit_name:'กล่อง'},{unit_code:null,unit_name:null}]);
    // A points-only reset must not remove any purchase history.
    const save=await mockPool.connect();await save.query('BEGIN');
    await save.query('DELETE FROM point_ledger WHERE user_id=$1',[memberId]);
    history=await request(app).get(`/api/members/${memberId}/purchase-history`).set('Authorization',auth);
    expect(history.body.purchases.find(p=>p.receiptNo===claim.receiptNo)).toEqual(mixed);
    await save.query('ROLLBACK');
    const other=await request(app).post('/api/crm/members').set('Authorization',auth).send({...member,name:'Other history fixture',phone:'0990000020',email:'other-history@example.invalid'});
    expect(other.status).toBe(201);
    const otherId=other.body.data.id;
    expect((await request(app).post('/api/loyalty/claims').set('Authorization',auth).send({...claim,branchCode:'TEST_OTHER',memberId:otherId})).status).toBe(201);
    const otherHistory=await request(app).get(`/api/members/${otherId}/purchase-history`).set('Authorization',auth);
    expect(otherHistory.body.purchases).toHaveLength(1);expect(otherHistory.body.purchases[0].branchCode).toBe('TEST_OTHER');
    expect(history.body.purchases.every(p=>p.branchCode!=='TEST_OTHER')).toBe(true);
  });

  test('item-removal sale persists actual purchases, private original rows, and exactly one owner across retries', async () => {
    const {saleWithItemVoid}=require('./fixtures/ada-item-void.cjs');
    const auth='Bearer '+staffToken;
    const claim={receiptNo:'SYNTHETIC-VOID-PAID',branchCode:'TEST_VOID',memberId,totalAmount:175,
      receiptTotalAmount:175,receiptDiscount:0,posCode:'001',soldAt:'2026-11-03T17:50:58+07:00',items:saleWithItemVoid()};
    const send=body=>request(app).post('/api/loyalty/claims').set('Authorization',auth).send(body);
    const saved=await send(claim);expect(saved.status).toBe(201);
    const history=await request(app).get(`/api/members/${memberId}/purchase-history`).set('Authorization',auth);
    const purchase=history.body.purchases.find(p=>p.receiptNo===claim.receiptNo);
    expect(purchase).toMatchObject({totalAmount:175,eligibleAmount:175,posCode:'001',
      items:[{seq:3,productCode:'SALINE-FIXTURE',qty:2,unitName:'ขวด',lineTotal:90},
        {seq:4,productCode:'MEDICINE-FIXTURE',qty:1,unitName:'ขวด',lineTotal:85}]});
    expect(new Date(purchase.soldAt).toISOString()).toBe('2026-11-03T10:50:58.000Z');
    expect(purchase).not.toHaveProperty('lineAdjustments');
    const stored=await mockClient.query('SELECT receipt_snapshot FROM loyalty_claims WHERE id=$1',[saved.body.claimId]);
    expect(stored.rows[0].receipt_snapshot.lineAdjustments.sourceItems).toHaveLength(4);
    const lines=await mockClient.query('SELECT product_code,qty,line_total FROM loyalty_claim_items WHERE claim_id=$1 ORDER BY product_code',[saved.body.claimId]);
    expect(lines.rows.map(r=>[r.product_code,Number(r.qty),Number(r.line_total)])).toEqual([
      ['MEDICINE-FIXTURE',1,85],['SALINE-FIXTURE',2,90],
    ]);
    const mirror=await mockClient.query('SELECT l.product_code,l.qty FROM crm_pos_sale_line_events l JOIN crm_pos_sale_events s ON s.id=l.sale_event_id WHERE s.branch_code=$1 AND s.doc_no=$2 ORDER BY l.line_no',[claim.branchCode,claim.receiptNo]);
    expect(mirror.rows.map(r=>[r.product_code,Number(r.qty)])).toEqual([['SALINE-FIXTURE',2],['MEDICINE-FIXTURE',1]]);
    const before=await mockClient.query('SELECT count(*)::int AS n FROM point_ledger');
    expect((await send(claim)).status).toBe(409);
    const someoneElse=await mockClient.query('SELECT user_id FROM member_profiles WHERE user_id<>$1 LIMIT 1',[memberId]);
    expect(someoneElse.rowCount).toBe(1);
    expect((await send({...claim,memberId:someoneElse.rows[0].user_id})).status).toBe(409);
    expect((await mockClient.query('SELECT count(*)::int AS n FROM loyalty_claims WHERE receipt_no=$1',[claim.receiptNo])).rows[0].n).toBe(1);
    expect((await mockClient.query('SELECT count(*)::int AS n FROM point_ledger')).rows).toEqual(before.rows);
  });

  test('separate Ada contacts sharing a phone can edit demographics and medical records without merging accounts', async () => {
    const priorMirror = process.env.SC_OFFICIAL_ADA_SYNC_ENABLED;
    const save = await mockPool.connect();
    await save.query('BEGIN');
    try {
      await mockClient.query(fs.readFileSync(path.join(__dirname, '../sql/ada-member-mirror.sql'), 'utf8'));
      const medicalSql = fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261105014604_member_pharmacy_records.sql'),'utf8');
      await mockClient.query(medicalSql);
      process.env.SC_OFFICIAL_ADA_SYNC_ENABLED = 'true';
      const sharedPhone = member.phone;
      const source = 'hq000/AdaAcc', code = 'AR004-TESTEDIT';
      const inserted = await mockClient.query(`INSERT INTO ada_history.customers
        (source_id,ada_code,name,phone,active,source_payload,payload_hash,source_snapshot)
        VALUES($1,$2::varchar(20),'Separate personal fixture',$3,'1',jsonb_build_object('FTCstCode',$2::text),repeat('a',64),gen_random_uuid())
        RETURNING directory_id`,[source,code,sharedPhone]);
      const id = inserted.rows[0].directory_id;
      await mockClient.query(`INSERT INTO ada_history.receipts
        (source_id,receipt_key,branch_code,pos_code,doc_no,doc_type,customer_code,sale_date,grand_total,source_payload,payload_hash,source_snapshot)
        VALUES($1,repeat('b',64),'004','001','SYNTHETIC-PERSON-HISTORY','1',$2,'2026-11-01',100,'{}',repeat('c',64),gen_random_uuid())`,[source,code]);
      const historyBefore = (await mockClient.query('SELECT id,user_id,receipt_no FROM ada_history.purchase_claims WHERE user_id=$1',[id])).rows;
      expect(historyBefore).toHaveLength(1);
      const otherBefore = (await mockClient.query('SELECT to_jsonb(u) AS row FROM users u WHERE id=$1',[memberId])).rows;
      const adaBefore = (await mockClient.query('SELECT to_jsonb(c) AS row FROM ada_history.customers c WHERE directory_id=$1',[id])).rows;
      const ledgerBefore = (await mockClient.query('SELECT count(*)::int n FROM point_ledger')).rows;
      const auth = 'Bearer '+staffToken;
      const send = body => request(app).put(`/api/members/${id}`).set('Authorization',auth).send(body);
      const payload = {name:'Personal fixture updated',phone:'+66 '+sharedPhone.slice(1),sex:'female',dob:'1991-05-20',
        pharmacy_med_record:{weightKg:61.25,heightCm:168,hasDiabetes:true,drugAllergies:'Synthetic allergy',medicalHistory:'Synthetic history'}};
      // Real unique users.phone_number index: the other account owns this number.
      const updated = await send(payload);
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({id,displayName:payload.name,phone:sharedPhone,sex:'female',dob:'1991-05-20',
        pharmacy_med_record:{weightKg:61.25,hasDiabetes:true,drugAllergies:'Synthetic allergy'}});
      expect((await send(payload)).status).toBe(200);
      const reopened = await request(app).get(`/api/members/${id}`).set('Authorization',auth);
      expect(reopened.body).toMatchObject({id,phone:sharedPhone,sex:'female',dob:payload.dob,
        pharmacy_med_record:{medicalHistory:'Synthetic history',weightKg:61.25}});
      expect((await mockClient.query('SELECT phone_number FROM users WHERE id=$1',[id])).rows[0].phone_number).toBeNull();
      expect((await mockClient.query('SELECT to_jsonb(u) AS row FROM users u WHERE id=$1',[memberId])).rows).toEqual(otherBefore);
      expect((await mockClient.query('SELECT to_jsonb(c) AS row FROM ada_history.customers c WHERE directory_id=$1',[id])).rows).toEqual(adaBefore);
      expect((await mockClient.query('SELECT count(*)::int n FROM point_ledger')).rows).toEqual(ledgerBefore);
      expect((await mockClient.query('SELECT id,user_id,receipt_no FROM ada_history.purchase_claims WHERE user_id=$1',[id])).rows).toEqual(historyBefore);
      expect((await mockClient.query('SELECT member_id FROM ada_history.member_links WHERE source_id=$1 AND ada_code=$2',[source,code])).rows).toEqual([{member_id:id}]);
      // A genuinely new, unused phone may change; a later collision must roll back every field.
      expect((await send({...payload,phone:'0990000088'})).status).toBe(200);
      const conflict = await send({...payload,name:'Must not save',phone:sharedPhone,pharmacy_med_record:{weightKg:99}});
      expect(conflict.status).toBe(409);
      const afterConflict = await request(app).get(`/api/members/${id}`).set('Authorization',auth);
      expect(afterConflict.body).toMatchObject({displayName:payload.name,phone:'0990000088',pharmacy_med_record:{weightKg:61.25}});
      const search = await request(app).get('/api/members/search').query({q:payload.name}).set('Authorization',auth);
      expect(search.body.filter(row=>row.id===id)).toHaveLength(1);
      expect((await request(app).put(`/api/members/${id}`).send(payload)).status).toBe(401);
      // Reapplying setup retains records; browser/Data API roles cannot read them.
      await mockClient.query(medicalSql);
      expect((await mockClient.query('SELECT count(*)::int n FROM member_pharmacy_med_records WHERE member_id=$1',[id])).rows[0].n).toBe(1);
      await mockClient.query('GRANT SELECT ON public.member_pharmacy_med_records TO crm_counter_reader_ci');
      await mockClient.query('SET LOCAL ROLE crm_counter_reader_ci');
      try { expect((await mockClient.query('SELECT count(*)::int n FROM public.member_pharmacy_med_records')).rows[0].n).toBe(0); }
      finally { await mockClient.query('RESET ROLE'); }
    } finally {
      if(priorMirror===undefined)delete process.env.SC_OFFICIAL_ADA_SYNC_ENABLED;
      else process.env.SC_OFFICIAL_ADA_SYNC_ENABLED=priorMirror;
      await save.query('ROLLBACK');
    }
  });

  test('keyset pagination reaches every bill beyond 100 without duplicates at tied timestamps and never crosses members', async () => {
    await mockClient.query(`INSERT INTO loyalty_claims(id,receipt_no,branch_code,sold_at,total_amount,awarded_points,user_id,created_at)
      SELECT 'PAGE-'||lpad(i::text,4,'0'),'PAGE-'||i,'TEST_PAGE','2027-01-01 00:00:00.123456+00',0,0,$1,'2027-01-01 00:00:00.654321+00' FROM generate_series(1,105) AS i`,[memberId]);
    const seen=[],auth='Bearer '+staffToken;let cursor;
    do {
      const response=await request(app).get(`/api/members/${memberId}/purchase-history`).query({limit:17,...(cursor?{cursor}:{})}).set('Authorization',auth);
      expect(response.status).toBe(200);expect(response.body.purchases.length).toBeLessThanOrEqual(17);
      seen.push(...response.body.purchases.map(p=>p.claimId));cursor=response.body.nextCursor;
      if(response.body.hasMore)expect(cursor).toBeTruthy();
    }while(cursor);
    const stored=await mockClient.query('SELECT id FROM loyalty_claims WHERE user_id=$1',[memberId]);
    expect(new Set(seen).size).toBe(seen.length);expect(new Set(seen)).toEqual(new Set(stored.rows.map(r=>r.id)));
  });
});
