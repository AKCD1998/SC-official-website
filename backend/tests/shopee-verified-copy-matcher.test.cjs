const rules = require('../src/modules/seamless/data/shopeeAdaSmartCopyRules.v1.json');
const catalog = require('../src/modules/seamless/data/shopeeProductCatalog.v1.json');
const { sanitizeShopeeOrderItem } = require('../src/modules/seamless/shopeeOrderValidation');
const { enrichShopeeOrderItems, getShopeeProductCatalogDigest } = require('../src/modules/seamless/services/shopeeProductMatcher');
const { resolveCopyProduct, buildAdaSmartCopyPlan } = require('../src/modules/seamless/services/shopeeAdaSmartCopyService');
const { VERIFIED_COPY_MATCH_VERSION, buildVerifiedCopyIndex, formattingKey, getVerifiedCopyMatcherDigest,
  resolveVerifiedCopyMatch } = require('../src/modules/seamless/services/shopeeVerifiedCopyMatcher');
const shop = 'sc-drug-store';
const item = (name, variant, metadata = {}) => ({ name, variant, quantity: 2, unitPrice: 50,
  productMatch: { status: 'unmapped' }, ...metadata });
const positives = [
  ['SOS Plus S Series ผ้าก๊อซพร้อมใช้', 'S 8×8 cm 1 box', 'IC-004134', 1, 'กล่อง'],
  ['SOS Plus T Series waterproof dressing', 'T 8*8 ซม. 1 กล่อง', 'IC-004132', 1, 'กล่อง'],
  ['SOS Plus S Series ผ้าก๊อซพร้อมใช้', 'M 4 x 7 cm 1 box', 'IC-004135', 1, 'กล่อง'],
  ['SOS Plus T Series waterproof dressing', 'M 4x7 cm 1 box', 'IC-004095', 1, 'กล่อง'],
  ['SOS Plus red waterproof dressing', 'T1-B 3×7 centimetres 1 box', 'IC-002739', 1, 'กล่อง'],
  ['SOS Plus S Series ผ้าก๊อซพร้อมใช้', 'S2 6x7 ซม. 1 กล่อง', '630010162', 1, 'กล่อง'],
  ['SOS Plus T Series waterproof dressing', 'T1 2.5x5.6 cm 1 box 10 pieces', '630010167', 1, 'กล่อง'],
  ['Kids Propoliz Mouth Spray 10ml', '1 bottle', 'IC-002893', 1, 'ขวด'],
  ['Propoliz Mouth Spray Kid 15 มล.', '1 ขวด', 'IC-002706', 1, 'กล่อง'],
  ['Propoliz กระชาย Mouth Spray 15 มล.', '1 ขวด', 'IC-002067', 1, 'กล่อง'],
  ['Mouth Spray Propoliz X 15 ml', '1 bottle', 'IC-004453', 1, 'กล่อง'],
  ['Propoliz Mouth Spray Original 15 ml', '1 bottle', 'IC-001292', 1, 'กล่อง'],
  ['I-Herb เม็ดอมสมุนไพร ซองซิป 8 เม็ด', '1 ซอง', 'IC-004806', 1, 'ซอง'],
  ['I-Herb Herbal Lozenges regular 8 tablets', '1 sachet', 'IC-003652', 1, 'ซอง'],
  ['I-Herb ยาอม OTC 18 เม็ด', '1 ซอง', 'IC-005056', 1, 'ซอง'],
  ['I-Herb OTC cough syrup 100 ml', '1 bottle', 'IC-005465', 1, 'ขวด'],
  ['I-Herb OTC cough syrup 60 ml', '1 bottle', 'IC-004261', 1, 'ขวด'],
  ['One Gerd mint 10 millilitres', '1 box 12 sachets', 'IC-002441', 12, 'ซอง'],
  ['One Gerd รสมินท์ 10 มล.', '1 ซอง', 'IC-002441', 1, 'ซอง'],
  ['Deeday Fiber Fiber 18 grams', '1 box 10 sachets', 'IC-005371', 10, 'ซอง'],
  ['BACTIGRAS dressing 10x10 cm 10 sheets/box', '4 boxes', 'IC-000295', 40, 'แผ่น'],
];
test.each(positives)('new wording %s / %s reuses verified identity and units', (name, variant, sku, factor, unit) => {
  const raw = item(name, variant);
  const original = JSON.stringify(raw);
  const result = resolveCopyProduct(shop, raw);
  expect(result.reason).toBeUndefined();
  expect(result).toMatchObject({ sku, factor, unit,
    matchingProvenance: { version: VERIFIED_COPY_MATCH_VERSION, method: 'verified_structural_attributes' } });
  expect(result.matchingProvenance.anchor.companySku).toBe(sku);
  expect(JSON.stringify(raw)).toBe(original);
});
const negatives = [
  ['SOS Plus dressing', 'M 4x7 cm 1 box'],
  ['SOS Plus S Series ผ้าก๊อซพร้อมใช้', 'T2 6x7 cm 1 box'],
  ['SOS Plus T Series waterproof dressing', 'S2 6x7 cm 1 box'],
  ['SOS Plus SB สีเนื้อ dressing', 'S 8x8 cm 1 box'],
  ['SOS Plus S Series ผ้าก๊อซพร้อมใช้', 'S 8x8 cm 1 sachet'],
  ['SOS Plus S Series ผ้าก๊อซพร้อมใช้', 'S 8x8 cm 1 box 3 pieces'],
  ['SOS Plus T Series waterproof dressing', 'T1 2.5x5.6 cm 1 box 100 pieces'],
  ['Propoliz Kids Mouth Spray 15 ml', 'Kid 10 ml 1 bottle'],
  ['Propoliz Original Mouth Spray 15 ml', 'X 15 ml 1 bottle'],
  ['Propoliz Krachai Mouth Spray 15 ml', 'Kid 15 ml 1 bottle'],
  ['Propoliz Plus Mouth Spray 15 ml', '1 bottle'],
  ['Propoliz Kids Mouth Spray 20 ml', '1 bottle'],
  ['Propoliz Mouth Spray New Formula 15 ml', '1 bottle'],
  ['Propoliz Kids Mouth Spray 10 ml', '1 box 2 bottles'],
  ['AnotherBrand Kids Mouth Spray 10 ml', '1 bottle'],
  ['I-Herb Herbal Lozenges 8 tablets', '1 sachet'],
  ['I-Herb Herbal Lozenges zip 8 tablets', 'regular 1 sachet'],
  ['I-Herb Herbal Lozenges regular 8 tablets', 'zip 1 sachet'],
  ['I-Herb Herbal Lozenges zip 18 tablets', '1 sachet'],
  ['I-Herb OTC cough syrup 100 ml', '60 ml 1 bottle'],
  ['I-Herb OTC cough syrup 100 ml', '1 box 12 bottles'],
  ['One Gerd mint 10 ml', '1 box 24 sachets'],
  ['One Gerd mint 10 ml', '12 boxes 1 sachet'],
  ['One Gerd mint 10 ml', '1 box'],
  ['One Gerd mint 10 ml 1 box 12 sachets', '1 box 24 sachets'],
  ['One Gerd mint 20 ml', '1 box 12 sachets'],
  ['One Gerd berry 10 ml', '1 box 12 sachets'],
  ['Deeday Fiber Fiber', ''],
  ['Deeday Fiber Fiber 18 g', '1 box'],
  ['Deeday Fiber Fiber 18 g', '1 box 20 sachets'],
  ['Deeday Fiber Fiber 18 g', '1 sachet'],
  ['Deeday Bio C 18 g', '1 box 10 sachets'],
  ['BACTIGRAS dressing 5x5 cm 10 sheets/box', '4 boxes'],
  ['BACTIGRAS dressing 10x10 cm 20 sheets/box', '4 boxes'],
  ['BACTIGRAS dressing 10x10 cm', '4 boxes'],
  ['One Gerd mint 10 ml แถม Propoliz Kids 10 ml', '1 box 12 sachets'],
];
test.each(negatives)('ambiguous or contradictory %s / %s stays in review', (name, variant) => {
  const result = resolveCopyProduct(shop, item(name, variant));
  expect(result.reason).toBeTruthy();
  expect(result.sku).toBeUndefined();
  expect(result.matchingReview.status).toBe('review');
});
test('generic normalization preserves number/unit associations and source component order', () => {
  expect(formattingKey('1 กล่อง 12 ซอง')).not.toBe(formattingKey('12 กล่อง 1 ซอง'));
  const anchor = rules.rules.find(r => r.companySku === 'IC-002441' && r.quantityPerSale === 12);
  expect(resolveCopyProduct(shop, item(anchor.productName, '12 กล่อง 1 ซอง')).reason).toBeTruthy();
});
test('known combined frame accepts an unambiguous newly formatted option but rejects changed packs', () => {
  const kids = rules.rules.find(r => r.variant === 'Kid 15 มล.');
  expect(resolveCopyProduct(shop, item(kids.productName, 'Kids 15 millilitres')).sku).toBe('IC-002706');
  const onegerd = rules.rules.find(r => r.companySku === 'IC-002441' && r.quantityPerSale === 12);
  expect(resolveCopyProduct(shop, item(onegerd.productName, '1 กล่อง 24 ซอง')).reason).toBeTruthy();
  const fiber = rules.rules.find(r => r.companySku === 'IC-005371' && r.variant === 'Fiber Fiber');
  expect(resolveCopyProduct(shop, item(fiber.productName, fiber.variant))).toMatchObject({ sku: 'IC-005371', factor: 10 });
});
test('safe formatting reuse retains numeric SKU as text, not a guessed barcode or number', () => {
  const anchor = rules.rules.find(r => r.companySku === '630010166');
  const changed = item(anchor.productName.toUpperCase(), 'T2 6 × 7 cm');
  expect(resolveCopyProduct(shop, changed)).toMatchObject({ sku: '630010166', factor: 1,
    matchingProvenance: { method: 'verified_formatting_identity' } });
});
test('shop boundaries, special consolidation authority, known bundles and quantity holds remain intact', () => {
  expect(resolveCopyProduct('dr-morepen', item('One Gerd mint 10 ml', '1 box 12 sachets')).reason).toBeTruthy();
  const consolidation = rules.rules.find(r => r.authority.includes('accounting_consolidation'));
  expect(resolveCopyProduct(shop, item(consolidation.productName.toUpperCase(), consolidation.variant)).reason).toBeTruthy();
  expect(resolveCopyProduct(shop, item(consolidation.productName, consolidation.variant)).sku).toBe(consolidation.companySku);
  const bundle = rules.rules.find(r => r.components);
  const known = resolveCopyProduct(shop, item(bundle.productName, bundle.variant));
  expect(known.components).toHaveLength(2);
  expect(known.reason).toBeTruthy();
  expect(resolveCopyProduct(shop, item(bundle.productName.toUpperCase(), bundle.variant)).reason).toBeTruthy();
  const held = item('RENAMED Gaviscon', 'เขียว 1 กล่อง', { productMatch: { status: 'matched',
    companySku: 'IC-001048', quantityPerSale: 12, quantityRuleStatus: 'requires_validation' } });
  expect(resolveCopyProduct(shop, held).reason).toContain('ยังไม่ยืนยัน');
});
test('duplicate structural evidence with incompatible SKU or factor fails closed', () => {
  const anchor = rules.rules.find(r => r.companySku === 'IC-002441' && r.quantityPerSale === 12);
  const conflict = { ...anchor, productName: 'One Gerd mint 10 ml', variant: '1 box 12 sachets', quantityPerSale: 24 };
  const idx = buildVerifiedCopyIndex({ ...rules, rules: [...rules.rules, conflict] });
  expect(resolveVerifiedCopyMatch(shop, item('One Gerd 10 ml mint', '1 box 12 sachets'), idx))
    .toMatchObject({ status: 'review', reasonCode: 'automatic_evidence_conflict' });
});
test('supplied IDs need independently verified same-SKU and same-pack evidence', () => {
  const single = catalog.records.find(r => r.shopCode === shop && r.sourceRow === 17);
  const box = catalog.records.find(r => r.shopCode === shop && r.sourceRow === 29);
  const raw = item('One Gerd mint 10 ml', '1 box 12 sachets');
  expect(resolveCopyProduct(shop, { ...raw, productId: single.productId, variationId: single.variationId }).reason).toBeTruthy();
  expect(resolveCopyProduct(shop, { ...raw, productId: box.productId, variationId: box.variationId }))
    .toMatchObject({ sku: 'IC-002441', factor: 12 });
  expect(resolveCopyProduct(shop, { ...raw, productId: box.productId, variationId: '999999999' }).reason).toBeTruthy();
  expect(resolveCopyProduct(shop, { ...raw, productId: box.productId }).reason).toBeTruthy();
  expect(resolveCopyProduct(shop, { ...raw, productId: box.productId, listingProductId: 'different', variationId: box.variationId }).reason).toBeTruthy();
  const fiber3 = catalog.records.find(r => r.shopCode === shop && r.sourceRow === 134);
  expect(resolveCopyProduct(shop, { ...item('Deeday Fiber Fiber 18 g', '1 box 10 sachets'),
    productId: fiber3.productId, variationId: fiber3.variationId }).reason).toBeTruthy();
});
test('barcodes cannot justify identity or a box-to-base-unit conversion', () => {
  const raw = item('Propoliz Kids Mouth Spray 10 ml', '1 bottle');
  expect(resolveCopyProduct(shop, { ...raw, barcode: '8856513013059' }).sku).toBe('IC-002893');
  expect(resolveCopyProduct(shop, { ...raw, barcode: '8856513012175' }).reason).toBeTruthy();
  expect(resolveCopyProduct(shop, { ...raw, barcode: '8856513013059', sourceBarcode: 'wrong' }).reason).toBeTruthy();
  expect(resolveCopyProduct(shop, item('Unknown product', '', { barcode: '8856513013059' })).reason).toBeTruthy();
  expect(resolveCopyProduct(shop, item('One Gerd mint 10 ml', '1 box 12 sachets', { barcode: '8852673000830' })).reason).toBeTruthy();
});
test('real sanitized/enriched copy flow reuses renamed mappings and preserves satang, raw facts and BI blocking', () => {
  const source = { name: 'BACTIGRAS dressing 10x10 cm 10 sheets/box', variant: '4 boxes', quantity: 2, unitPrice: 50 };
  const sanitized = sanitizeShopeeOrderItem(source);
  const enriched = enrichShopeeOrderItems(shop, [sanitized]);
  expect(enriched[0].productMatch.status).toBe('unmapped');
  const date = '2027-01-02'; const filters = { shopCode: shop, startDate: date, endDate: date };
  const order = { shopCode: shop, orderNumber: 'SYNTHETIC', paidAt: `${date}T03:00:00Z`, observedAt: `${date}T04:00:00Z`,
    sourceFilename: 'synthetic.xlsx', sourceSha256: 'a'.repeat(64), sourceRows: [2], items: enriched,
    itemSubtotal: 101, shopeeProductDiscount: 1.01, sellerVoucher: 0 };
  const confirmed = { ...filters, status: 'source_backed', salesTotal: 102.01, orderCount: 1,
    shops: [{ shopCode: shop, sources: [{ sourceSha256: 'b'.repeat(64) }] }] };
  const before = JSON.stringify(order);
  const plan = buildAdaSmartCopyPlan([order], confirmed, filters);
  expect(plan).toMatchObject({ status: 'ready', totalQuantity: 80, totalCents: 10201,
    matchingAlgorithmVersion: VERIFIED_COPY_MATCH_VERSION });
  expect(plan.rows.reduce((sum, row) => sum + Number(row.unitPrice.replace('.', '')) * row.quantity, 0)).toBe(10201);
  expect(plan.rows[0].sources[0]).toMatchObject({ productName: source.name, variant: source.variant,
    listingQuantity: 2, quantityPerSale: 40, amountCents: 10201,
    matchingProvenance: { version: VERIFIED_COPY_MATCH_VERSION, method: 'verified_structural_attributes' } });
  expect(JSON.stringify(order)).toBe(before);
  expect(buildAdaSmartCopyPlan([order], { ...confirmed, salesTotal: 102.02 }, filters).columns).toBeNull();
  expect(buildAdaSmartCopyPlan([order], { ...confirmed, orderCount: 2 }, filters).columns).toBeNull();
});
test('the cache digest accounts for the matcher version and durable mapping evidence', () => {
  expect(getVerifiedCopyMatcherDigest()).toMatch(/^[a-f0-9]{64}$/u);
  expect(getShopeeProductCatalogDigest()).toMatch(/^[a-f0-9]{64}$/u);
  expect(VERIFIED_COPY_MATCH_VERSION).toBe('verified-structural-copy-2026-10-08-v3');
});

const additionalPackCases = [
  ['Polar Spray blue 280 ml', '24 cans', 'IC-002462', 24],
  ['Polar Spray white 80 ml', '3 cans', 'IC-005557', 3],
  ['Polar Spray Innocence 280 ml', '6 cans', 'IC-005185', 6],
  ['Polar Spray blue 80 ml', '48 cans', 'IC-006023', 48],
  ['Myda Soap Sulfur 2.5% 30 g', '5 bars', 'IC-003560', 5],
  ['Myda Soap Sulfur 2.5% 80 g', '2 bars', 'IC-003493', 2],
  ['Yoki powder 1997 100 g', '2 bottles', '630010244', 2],
  ['Yoki powder 1997 60 g', '3 bottles', '630010243', 3],
  ['Yoki powder circle 100 g', '2 bottles', 'IC-005707', 2],
  ['Yoki powder circle 60 g', '3 cans', 'IC-000818', 3],
  ['Propoliz เม็ดอม Extherb 8 เม็ด', '2 แผง', 'IC-004857', 2],
  ['Propoliz Extherb Lozenge 8 tablets', '2 blisters', 'IC-004857', 2],
  ['Propoliz เม็ดอม เอ็กซ์เฮิร์บ 8 เม็ด', '2 แผง', 'IC-004857', 2],
  ['Propoliz เม็ดอม Extherb 8 เม็ด', '1 กล่อง 15 แผง', 'IC-004857', 15],
  ['SOS Plus S Series dressing', 'S 9×15 cm 1 box 3 pieces', 'IC-004133', 1],
  ['SOS Plus S Series dressing', 'S 10x20 cm 1 box 2 pieces', 'IC-000522', 1],
];
test.each(additionalPackCases)('verified base identity scales %s / %s to %s x %s', (name, variant, sku, factor) => {
  expect(resolveCopyProduct(shop, item(name, variant))).toMatchObject({ sku, factor,
    matchingProvenance: { method: 'verified_structural_attributes' } });
});
const additionalPackHolds = [
  ['Polar Spray blue 280 ml', '24 bottles'],
  ['Polar Spray blue 280 ml', 'white 24 cans'],
  ['Polar Spray blue 280 ml', '80 ml 24 cans'],
  ['Polar Spray blue 280 ml', '1 box'],
  ['Polar Spray blue 280 ml', '0 cans'],
  ['Polar Spray blue 280 ml', '1001 cans'],
  ['Polar Spray blue 280 ml', '2 cans 3 cans'],
  ['Polar Spray blue 280 ml', '2 cans แถม white 80 ml 1 can'],
  ['Polar Spray new formula 280 ml', '2 cans'],
  ['Myda Soap Sulfur 5% 30 g', '3 bars'],
  ['Myda Soap Sulfur 2.5% 30 g', '80 g 3 bars'],
  ['Myda Soap Sulfur 2.5% 30 g', '3 boxes'],
  ['Myda Soap Sulfur 2.5% 30 g', ''],
  ['AnotherBrand Soap Sulfur 2.5% 30 g', '3 bars'],
  ['Yoki powder 100 g', '2 bottles'],
  ['Yoki powder 1997 100 g', 'circle 2 bottles'],
  ['Yoki powder 1997 100 g', '60 g 2 bottles'],
  ['Yoki powder 1997 100 g', '2 boxes'],
  ['Propoliz เม็ดอม Extherb 8 เม็ด', '1 ซอง'],
  ['Propoliz เม็ดอม Extherb 8 เม็ด', 'X 1 แผง'],
  ['Propoliz เม็ดอม Extherb 8 เม็ด', '1 กล่อง 16 แผง'],
  ['Propoliz เม็ดอม Extherb 10 เม็ด', '1 แผง'],
  ['SOS Plus S Series dressing', 'S 9x15 cm 1 box 4 pieces'],
  ['SOS Plus T Series dressing', 'S 9x15 cm 1 box 3 pieces'],
];
test.each(additionalPackHolds)('new pack parser retains review for %s / %s', (name, variant) => {
  const result = resolveCopyProduct(shop, item(name, variant));
  expect(result.sku).toBeUndefined();
  expect(result.reason).toBeTruthy();
});
test('a known multi-option frame cannot infer a missing pack or formula from a different option', () => {
  const frame = sku => rules.rules.find(r => r.authority.endsWith('_20261008') && r.companySku === sku).productName;
  expect(resolveCopyProduct(shop, item(frame('IC-002462'), 'ฝาฟ้า 280 มล.')).reason).toBeTruthy();
  expect(resolveCopyProduct(shop, item(frame('IC-003560'), '30 กรัม')).reason).toBeTruthy();
  expect(resolveCopyProduct(shop, item(frame('630010244'), '100 กรัม')).reason).toBeTruthy();
  expect(resolveCopyProduct(shop, item(frame('IC-004857'), '8 เม็ด')).reason).toBeTruthy();
});
test('the five repaired options preserve source money and expand only verified base-unit quantities', () => {
  const date = '2027-01-03'; const filters = { shopCode: shop, startDate: date, endDate: date };
  const cases = [
    ['IC-002462', 'ฝาฟ้า 280 มล. 12 กป.', 1, 2950, 12],
    ['IC-004133', 'S 9x15 ซม.', 1, 75, 1],
    ['IC-004857', 'Extherb 8 เม็ด', 1, 33, 1],
    ['IC-003560', '30 กรัม 3 ก้อน', 2, 96, 6],
    ['630010244', 'โยคี1997 100 กรัม', 2, 25, 2],
  ];
  const orders = cases.map(([sku, variant, quantity, unitPrice], index) => {
    const anchor = rules.rules.find(r => r.authority.endsWith('_20261008') && r.companySku === sku && r.variant === variant);
    expect(anchor).toBeDefined();
    return { shopCode: shop, orderNumber: `SYNTHETIC-PACK-${index}`, paidAt: `${date}T03:00:00Z`,
      observedAt: `${date}T04:00:00Z`, sourceFilename: 'synthetic.xlsx', sourceSha256: 'a'.repeat(64), sourceRows: [2],
      items: enrichShopeeOrderItems(shop, [sanitizeShopeeOrderItem({ name: anchor.productName, variant, quantity, unitPrice })]),
      itemSubtotal: quantity * unitPrice, shopeeProductDiscount: 0, sellerVoucher: 0 };
  });
  const before = JSON.stringify(orders);
  const confirmed = { ...filters, status: 'source_backed', salesTotal: 3300, orderCount: 5,
    shops: [{ shopCode: shop, sources: [{ sourceSha256: 'b'.repeat(64) }] }] };
  const plan = buildAdaSmartCopyPlan(orders, confirmed, filters);
  expect(plan).toMatchObject({ status: 'ready', totalCents: 330000, totalQuantity: 22, orderCount: 5 });
  for (const [sku, , quantity, price, baseQuantity] of cases) {
    const rows = plan.rows.filter(row => row.sku === sku);
    expect(rows.reduce((sum, row) => sum + row.quantity, 0)).toBe(baseQuantity);
    expect(rows.reduce((sum, row) => sum + row.amountCents, 0)).toBe(quantity * price * 100);
  }
  expect(JSON.stringify(orders)).toBe(before);
});
