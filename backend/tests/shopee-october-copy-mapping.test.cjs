jest.mock('../db', () => ({ query: jest.fn() }));
const rules = require('../src/modules/seamless/data/shopeeAdaSmartCopyRules.v1.json');
const { resolveCopyProduct, buildAdaSmartCopyPlan } = require('../src/modules/seamless/services/shopeeAdaSmartCopyService');
const { bundleAllocation } = require('../src/modules/seamless/services/shopeeCopyAllocation');
const shop = 'sc-drug-store';
const input = (name, variant) => ({ name, variant, quantity: 1, unitPrice: 495, productMatch: { status: 'unmapped' } });

test('owner-confirmed Klean crate uses 24 base bottles and retains both conflicting barcode observations', () => {
  const rule = rules.rules.find(r => r.variant === '500 มล. ยกลัง แหลม');
  expect(resolveCopyProduct(shop, input(rule.productName, rule.variant))).toMatchObject({sku:'IC-004060',factor:24,unit:'ขวด'});
  expect(rule.authority).toContain('user_confirmed');
  expect(rule.evidence).toMatchObject({sellerGtin:'8854060609121',erpBarcode:'8854060609114',
    identityStatus:'owner_confirmed_company_sku_and_24_bottles_per_sale'});
  expect(resolveCopyProduct(shop, input(rule.productName, '500 มล. ยกลัง 12 ขวด')).reason).toBeTruthy();
});

test.each([
  ['SOS Plus S Series ผ้าก๊อซพร้อมใช้', 'S1-B 3x7 cm 1 box 10 pieces', 'IC-001199', 1],
  ['SOS Plus T Series waterproof dressing', 'T 12x12 cm 1 box 2 pieces', 'IC-001204', 1],
  ['SOS Plus S Series ผ้าก๊อซพร้อมใช้', 'S 12x12 cm 1 box 3 pieces', 'IC-000645', 1],
  ['Propoliz Lozenge 8 tablets', '1 sachet', 'IC-002080', 1],
  ['Propoliz เม็ดอม Vit C ส้ม 8 เม็ด', '1 ซอง', 'IC-003569', 1],
  ['Propoliz X เม็ดอม 8 เม็ด', '1 แผง', 'IC-004601', 1],
  ['Propoliz Lozenge 8 tablets', '1 box 10 sachets', 'IC-002080', 10],
])('verified new spelling %s / %s resolves retail units', (name, variant, sku, factor) => {
  expect(resolveCopyProduct(shop, input(name, variant))).toMatchObject({ sku, factor,
    matchingProvenance: { method: 'verified_structural_attributes' } });
});

test.each([
  ['SOS Plus S Series ผ้าก๊อซพร้อมใช้', 'T1-B 3x7 cm 1 box 10 pieces'],
  ['SOS Plus T Series waterproof dressing', 'S1-B 3x7 cm 1 box 10 pieces'],
  ['SOS Plus S Series ผ้าก๊อซพร้อมใช้', 'S1-B 3x7 cm 1 box 2 pieces'],
  ['Propoliz Lozenge 16 tablets', '1 sachet'],
  ['Propoliz X เม็ดอม 8 เม็ด', '1 ซอง'],
  ['Propoliz Lozenge 8 tablets', '1 blister'],
  ['Propoliz Lozenge 8 tablets', '1 box 12 sachets'],
  ['Propoliz X honey lemon เม็ดอม 8 เม็ด', '1 blister'],
  ['Propoliz Extherb เม็ดอม 8 เม็ด', '1 sachet'],
])('unverified formula or contents %s / %s stays blocked', (name, variant) => {
  expect(resolveCopyProduct(shop, input(name, variant)).reason).toBeTruthy();
});

const white = rules.rules.find(r => r.allocationIdentity);
const blue = rules.rules.find(r => r.productName === white.productName && r.variant === 'ฝาฟ้า 2 แถม ฝาฟ้า');
const policy = { shopCode: shop, enabled: true, policyKey: 'existing-owner-approved-white-gift',
  approvedBy: 'synthetic-owner', approvedAt: '2026-09-29T00:00:00Z',
  approval: { kind: 'user_confirmed_allocation', caseId: 'synthetic', responseSha256: 'a'.repeat(64) },
  policy: { type: 'bundle', ...white.allocationIdentity, method: 'paid_component_and_free_gift',
    components: [{ sku: 'IC-002462', factor: 2, weight: 1 }, { sku: 'IC-005557', factor: 1, weight: 0, freeGift: true }] } };
const parts = rule => resolveCopyProduct(shop, input(rule.productName, rule.variant)).components;

test('renamed white-gift bundle reuses only the same owner-approved component allocation', () => {
  const raw = input(white.productName, white.variant); const before = JSON.stringify(raw);
  const allocation = bundleAllocation([policy], shop, raw, parts(white), 49500);
  expect(allocation.components.map(c => [c.sku,c.factor,c.amountCents,c.freeGift]))
    .toEqual([['IC-002462',2,49500,false],['IC-005557',1,0,true]]);
  expect(JSON.stringify(raw)).toBe(before);
  expect(bundleAllocation([{ ...policy, enabled: false }], shop, raw, parts(white), 49500)).toBeNull();
  expect(bundleAllocation([policy], 'dr-morepen', raw, parts(white), 49500)).toBeNull();
  expect(bundleAllocation([policy], shop, { ...raw, name: `${raw.name} changed` }, parts(white), 49500)).toBeNull();
  expect(bundleAllocation([policy], shop, raw, parts(white).map(c=>({...c,factor:1})), 49500)).toBeNull();
});

test('blue-gift identity cannot inherit the prior white-gift approval or expose copy columns', () => {
  const raw = input(blue.productName, blue.variant);
  expect(parts(blue).map(c=>[c.sku,c.factor])).toEqual([['IC-002462',2],['IC-006023',1]]);
  expect(bundleAllocation([policy], shop, raw, parts(blue), 49500)).toBeNull();
  const date='2026-10-05'; const filters={shopCode:shop,startDate:date,endDate:date};
  const order={shopCode:shop,orderNumber:'SYNTHETIC',paidAt:`${date}T03:00:00Z`,orderedAt:`${date}T01:00:00Z`,
    items:[raw],sourceRows:[2],sourceFilename:'synthetic.xlsx',sourceSha256:'b'.repeat(64),
    itemSubtotal:495,sellerVoucher:0,shopeeProductDiscount:0};
  const confirmed={...filters,status:'source_backed',salesTotal:495,orderCount:1,
    shops:[{shopCode:shop,sources:[{sourceSha256:'c'.repeat(64)}]}]};
  const plan=buildAdaSmartCopyPlan([order],confirmed,filters,[],[],{allocationPolicies:[policy]});
  expect(plan.status).toBe('review_required'); expect(plan.columns).toBeNull();
});
