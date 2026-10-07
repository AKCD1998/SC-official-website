const rules = require('../src/modules/seamless/data/shopeeAdaSmartCopyRules.v1.json');
const { resolveCopyProduct, buildAdaSmartCopyPlan } = require('../src/modules/seamless/services/shopeeAdaSmartCopyService');
const shopCode = 'sc-drug-store';
const names = {
  blue: 'SOS Plus ผ้าก๊อซปิดแผลแบบพร้อมใช้ รุ่น S Series พร้อมแผ่นดูดซับ เลือกขนาดได้ (กล่องสีน้ำเงิน)',
  red: 'SOS Plus พลาสเตอร์ใสปิดแผลกันน้ำ รุ่น T และแผ่นฟิล์มใส เลือกรุ่นและขนาดได้ (กล่องสีแดง)',
  syrup: 'I-HERB OTC ยาน้ำแก้ไอ ตราไอ-เฮิร์บ โอทีซี 60 มล./100 มล. บรรเทาอาการไอ ขับเสมหะ 0% Alcohol',
  bakamol: 'พาราเซตามอล 500 มก. ชนิดเม็ด ไทลินอล TYLENOL ซาร่า SARA บาคามอล BAKAMOL พาราแมน PARAMAN แบบแผง',
  lozenges: 'I-Herb ไอ-เฮิร์บ เม็ดอมสมุนไพร 8 เม็ด และยาอม OTC โอทีซี 18 เม็ด เลือกสูตรได้',
  yoki: 'แป้งโยคีในรัศมีวงกลม ขนาด 60 กรัม และ 100 กรัม',
  spray: 'Propoliz โพรโพลิซ สเปรย์ช่องปาก Mouth Spray X Plus กระชาย และ Kid 10/15 มล. เลือกรุ่น',
  inhaler: 'ยาดม ตรา แทนใจ กลิ่นยูคาลิปตัส 5 กรัม แบบหัวคู่ เลือกสีได้ 6 สี',
  oneGerd: 'กล่อง One Gerd วันเกิร์ด รสมินท์ ปราศจากน้ำตาล 12 ซอง x 10 มล.',
  fiber: 'Deeday ดีเดย์ ผลิตภัณฑ์เสริมอาหาร เลือกสูตร Biotin Zinc Night’s Story Bio C Fish Oil BioMag Luti-berry Fiber',
};
const fixtures = [
  ['blue', 'S 8x8 ซม.', 'IC-004134', 1, 'กล่อง'],
  ['syrup', '100 มล.', 'IC-005465', 1, 'ขวด'],
  ['bakamol', 'บาคามอล 500', 'IC-002039', 1, 'แผง'],
  ['red', 'T2 6x7 ซม.', '630010166', 1, 'กล่อง'],
  ['red', 'T1-B 3x7 ซม.', 'IC-002739', 1, 'กล่อง'],
  ['lozenges', 'ยาอมโอทีซี 18 เม็ด', 'IC-005056', 1, 'ซอง'],
  ['yoki', '60 กรัม', 'IC-000818', 1, 'กระป๋อง'],
  ['red', 'T1 2.5x5.6 ซม.', '630010167', 1, 'กล่อง'],
  ['red', 'S 2.2x3.5 ซม.', 'IC-003439', 1, 'กล่อง'],
  ['blue', 'S2 6x7 ซม.', '630010162', 1, 'กล่อง'],
  ['blue', 'M 4x7 ซม.', 'IC-004135', 1, 'กล่อง'],
  ['spray', 'กระชาย 15 มล.', 'IC-002067', 1, 'กล่อง'],
  ['inhaler', 'ส้ม', 'IC-006114', 1, 'ชิ้น'],
  ['spray', 'Mouth Spray 15 มล.', 'IC-001292', 1, 'กล่อง'],
  ['spray', 'Kid 10 มล.', 'IC-002893', 1, 'ขวด'],
  ['spray', 'Kid 15 มล.', 'IC-002706', 1, 'กล่อง'],
  ['spray', 'X 15 มล.', 'IC-004453', 1, 'กล่อง'],
  ['blue', 'S3 6x10 ซม.', '630010161', 1, 'กล่อง'],
  ['oneGerd', '1 กล่อง 12 ซอง', 'IC-002441', 12, 'ซอง'],
  ['red', 'M 4x7 ซม.', 'IC-004095', 1, 'กล่อง'],
  ['red', 'T 8x8 ซม.', 'IC-004132', 1, 'กล่อง'],
  ['fiber', 'Fiber Fiber', 'IC-005371', 10, 'ซอง'],
];
const itemFor = (family, variant, quantity = 2) => ({ name: names[family], variant, quantity,
  unitPrice: 50, productMatch: { status: 'unmapped' } });
function planFor(item, date = '2026-09-30', target = 102.01) {
  const filters = { shopCode, startDate: date, endDate: date };
  const order = { shopCode, orderNumber: 'synthetic-variant-package', paidAt: `${date}T03:00:00Z`,
    observedAt: `${date}T04:00:00Z`, sourceFilename: 'synthetic.xlsx', sourceSha256: 'a'.repeat(64),
    sourceRows: [2], items: [item], itemSubtotal: 101, shopeeProductDiscount: 1.01, sellerVoucher: 0 };
  const confirmed = { ...filters, status: 'source_backed', salesTotal: target, orderCount: 1,
    shops: [{ shopCode, sources: [{ sourceSha256: 'b'.repeat(64) }] }] };
  return buildAdaSmartCopyPlan([order], confirmed, filters);
}
test.each(fixtures)('%s / %s retains exact product, ERP unit and source cents', (family, variant, sku, factor, unit) => {
  const item = itemFor(family, variant);
  expect(resolveCopyProduct(shopCode, item)).toMatchObject({ sku, factor, unit });
  const plan = planFor(item);
  expect(plan.status).toBe('ready');
  expect(plan.totalQuantity).toBe(2 * factor);
  expect(plan.totalCents).toBe(10201);
  expect(plan.supportCents).toBe(101);
  expect(plan.rows.every(row => row.sku === sku && row.unit === unit)).toBe(true);
  expect(plan.rows.reduce((sum, row) => sum + Number(row.unitPrice.replace('.', '')) * row.quantity, 0)).toBe(10201);
  expect(plan.rows[0].sources[0]).toMatchObject({ listingQuantity: 2, quantityPerSale: factor, amountCents: 10201 });
});
test('same-sized blue gauze and red waterproof dressings keep separate SKUs and box units', () => {
  const examples = [ ['blue', 'S 8x8 ซม.', 'IC-004134'], ['red', 'T 8x8 ซม.', 'IC-004132'],
    ['blue', 'M 4x7 ซม.', 'IC-004135'], ['red', 'M 4x7 ซม.', 'IC-004095'],
    ['blue', 'S2 6x7 ซม.', '630010162'], ['red', 'T2 6x7 ซม.', '630010166'] ];
  for (const [family, variant, sku] of examples) {
    expect(resolveCopyProduct(shopCode, itemFor(family, variant))).toMatchObject({ sku, unit: 'กล่อง', factor: 1 });
  }
  expect(resolveCopyProduct(shopCode, itemFor('blue', 'S 2.2x3.5 ซม.')).reason).toBeTruthy();
  expect(resolveCopyProduct(shopCode, itemFor('red', 'SB 8x8 ซม.')).reason).toBeTruthy();
  expect(resolveCopyProduct(shopCode, itemFor('red', 'T1 100 ชิ้น')).reason).toBeTruthy();
});
test('formula, volume, packaging and brand boundaries remain exact', () => {
  expect(resolveCopyProduct(shopCode, itemFor('lozenges', 'เม็ดอม 8 เม็ด')).sku).toBe('IC-004806');
  expect(resolveCopyProduct(shopCode, itemFor('lozenges', 'ยาอมโอทีซี 18 เม็ด')).sku).toBe('IC-005056');
  expect(resolveCopyProduct(shopCode, itemFor('syrup', '60 มล')).sku).toBe('IC-004261');
  expect(resolveCopyProduct(shopCode, itemFor('yoki', '100 กรัม')).sku).toBe('IC-005707');
  expect(resolveCopyProduct(shopCode, itemFor('spray', 'X 20 มล.')).reason).toBeTruthy();
  expect(resolveCopyProduct(shopCode, itemFor('spray', 'Plus 15 มล.')).reason).toBeTruthy();
  expect(resolveCopyProduct(shopCode, itemFor('bakamol', 'ซาร่า 500')).reason).toBeTruthy();
});
test('three One Gerd boxes become 36 sachets and copy columns preserve numeric company codes as text', () => {
  const pack = planFor(itemFor('oneGerd', '1 กล่อง 12 ซอง', 3));
  expect(pack.totalQuantity).toBe(36);
  expect(pack.totalCents).toBe(10201);
  const numeric = planFor(itemFor('red', 'T2 6x7 ซม.'));
  expect(numeric.columns.sku.split('\n').every(sku => sku === '630010166')).toBe(true);
  expect(numeric.columns.unitPrice.split('\n').every(price => /^\d+\.\d{2}$/u.test(price))).toBe(true);
});
test('user-confirmed Fiber Fiber box converts to ten ERP sachets and preserves the indivisible source cent', () => {
  const plan = planFor(itemFor('fiber', 'Fiber Fiber', 1));
  expect(plan.totalQuantity).toBe(10);
  expect(plan.totalCents).toBe(10201);
  expect(plan.rows.map(row => [row.quantity, row.unitPrice]).sort((a, b) => a[1].localeCompare(b[1])))
    .toEqual([[9, '10.20'], [1, '10.21']]);
  const rule = rules.rules.find(rule => rule.productName === names.fiber && rule.variant === 'Fiber Fiber');
  expect(rule.authority).toContain('user_confirmed_pack');
  expect(rule.evidence.erpBarcode).toBe('8859612272143');
  expect(resolveCopyProduct(shopCode, itemFor('fiber', 'Fiber Fiber 1 ซอง')).reason).toBeTruthy();
});
test('saved exact rules apply on future dates while unknown variants, other shops and BI mismatches remain blocked', () => {
  const item = itemFor('spray', 'Kid 15 มล.');
  expect(planFor(item, '2027-01-02').status).toBe('ready');
  expect(resolveCopyProduct('dr-morepen', item).reason).toBeTruthy();
  expect(resolveCopyProduct(shopCode, { ...item, variant: 'Kid 20 มล.' }).reason).toBeTruthy();
  expect(planFor(item, '2026-09-30', 102.02).columns).toBeNull();
});
test('October rules retain durable stock evidence without prices, balances or private source orders', () => {
  const additions = rules.rules.filter(rule => rule.verifiedOn === '2026-10-01');
  expect(additions).toHaveLength(21);
  for (const rule of additions) {
    expect(rule.evidence.masterEvidenceId).toBe('stockday-004-20260930');
    expect(rule.evidence.erpBarcode).toBeTruthy();
    expect(rule.evidence.masterSourceRow).toBeGreaterThan(2);
    expect(JSON.stringify(rule)).not.toMatch(/"(?:stock004|unitPrice|orderNumber|itemSubtotal|salePrice)"/u);
  }
  expect(new Set(rules.rules.map(rule => JSON.stringify([rule.shopCode, rule.productName, rule.variant]))).size).toBe(rules.rules.length);
});
