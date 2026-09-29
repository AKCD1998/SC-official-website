const { resolveCopyProduct, buildAdaSmartCopyPlan } = require('../src/modules/seamless/services/shopeeAdaSmartCopyService');
const inhaler = 'ยาดม ตรา แทนใจ กลิ่นยูคาลิปตัส 5 กรัม แบบหัวคู่ เลือกสีได้ 6 สี';
const bep = 'Bepanthen บีแพนเธน ออยเมนต์ Ointment 30 กรัม / เซนซิเดิร์ม ครีม Sensiderm 20 กรัม เลือกรุ่น';
const identities = [
  [inhaler, 'ม่วง', 'IC-006114', 1, 'ชิ้น'], [inhaler, 'ชมพู', 'IC-006114', 1, 'ชิ้น'],
  [inhaler, '1 เซ็ต 6 สี', 'IC-006114', 6, 'ชิ้น'],
  [bep, 'เซนซิเดิร์ม 50 กรัม', 'IC-005488', 1, 'หลอด'],
  ['BalanceActiv บาลานซ์แอคทีฟ เจลปรับสมดุลช่องคลอด 5 มล. บรรจุ 7 หลอด', '1 กล่อง', 'IC-003816', 1, 'กล่อง'],
  ['Deeday ดีเดย์ ผลิตภัณฑ์เสริมอาหาร เลือกสูตร Biotin Zinc Night’s Story Bio C Fish Oil BioMag Luti-berry Fiber', 'Biotin (H) Plus Zinc', 'IC-005369', 1, 'กล่อง'],
];
test.each(identities)('source variant %s / %s resolves its exact ERP formula, size and quantity', (name, variant, sku, factor, unit) => {
  const item = { name, variant, productMatch: { status: 'unmapped' } };
  expect(resolveCopyProduct('sc-drug-store', item)).toMatchObject({ sku, factor, unit });
  expect(resolveCopyProduct('dr-morepen', item).reason).toBeTruthy();
  expect(resolveCopyProduct('sc-drug-store', { ...item, variant: `${variant} unverified` }).reason).toBeTruthy();
});
test('two six-color sets become twelve pieces and keep the source line amount', () => {
  const filters = { shopCode: 'sc-drug-store', startDate: '2020-01-01', endDate: '2020-01-01' };
  const plan = buildAdaSmartCopyPlan([{ ...filters, orderNumber: '200101SET001', paidAt: '2020-01-01T00:00:00Z',
    observedAt: '2020-01-02T00:00:00Z', sourceFilename: 'synthetic.xlsx', sourceSha256: 'c'.repeat(64), sourceRows: [2],
    itemSubtotal: 120, sellerVoucher: 0, shopeeProductDiscount: 0,
    items: [{ name: inhaler, variant: '1 เซ็ต 6 สี', quantity: 2, unitPrice: 60, productMatch: { status: 'unmapped' } }] }],
  { ...filters, status: 'source_backed', salesTotal: 120, orderCount: 1, shops: [{ shopCode: filters.shopCode, sources: [{}] }] }, filters);
  expect(plan.status).toBe('ready'); expect(plan.columns).toEqual({ sku: 'IC-006114', quantity: '12', unitPrice: '10.00' });
});
