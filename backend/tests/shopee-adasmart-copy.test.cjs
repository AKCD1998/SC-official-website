jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));
const pool = require('../db');
const { buildAdaSmartCopyPlan, resolveCopyProduct, resolveLineAmounts } = require('../src/modules/seamless/services/shopeeAdaSmartCopyService');
const { listPaidOrdersForCopy } = require('../src/modules/seamless/db/shopeeAdaSmartCopyRepository');
const { getAdaSmartCopySummary } = require('../src/modules/seamless/controllers/shopeeOrderController');
const filters = { shopCode: 'sc-drug-store', startDate: '2026-09-01', endDate: '2026-09-01' };
const source = { sourceFilename: 'Order.all.20260826_20260925.xlsx', sourceSha256: 'a'.repeat(64), observedAt: '2026-09-26T00:00:00Z' };
const item = (sku = '630010066', quantity = 1, unitPrice = 33) => ({ name: 'source product', variant: '', quantity, unitPrice,
  productMatch: { status: 'matched', companySku: sku } });
const order = (overrides = {}) => ({ ...source, shopCode: filters.shopCode, orderNumber: '260901TEST01',
  paidAt: '2026-09-01T01:00:00Z', items: [item()], sourceRows: [2],
  itemSubtotal: 33, shopeeProductDiscount: 0, sellerVoucher: 0, ...overrides });
const confirmed = (salesTotal = 33, orderCount = 1) => ({ ...filters, status: 'source_backed', salesTotal, orderCount,
  shops: [{ shopCode: filters.shopCode, sources: [source] }] });

test('paid Bangkok date defines cohort, including later cancellation and prior creation', () => {
  const plan = buildAdaSmartCopyPlan([
    order({ orderedAt: '2026-08-31T16:59:00Z', paidAt: '2026-08-31T17:00:00Z', excluded: true }),
    order({ orderNumber: '260902TEST02', paidAt: '2026-09-01T17:00:00Z' }),
    order({ shopCode: 'dr-morepen', orderNumber: '260901TEST03' }),
  ], confirmed(), filters);
  expect(plan.status).toBe('ready');
  expect(plan.orderCount).toBe(1);
  expect(plan.columns).toEqual({ sku: '630010066', quantity: '1', unitPrice: '33.00' });
});

test('Shopee-funded 63 baht belongs to the affected product exactly once', () => {
  const plan = buildAdaSmartCopyPlan([order({ items: [item('IC-003143', 1, 293)], itemSubtotal: 293,
    shopeeProductDiscount: 63 })], confirmed(356), filters);
  expect(plan.columns.unitPrice).toBe('356.00');
  expect(plan.supportCents).toBe(6300);
  expect(plan.totalCents).toBe(35600);
});

test('aggregate identical SKUs and preserve exact cents with high-price row first', () => {
  const plan = buildAdaSmartCopyPlan([order({ items: [item('630010066', 3)], itemSubtotal: '100.00' })], confirmed(100), filters);
  expect(plan.rows.map(row => [row.quantity, row.unitPrice])).toEqual([[1, '33.34'], [2, '33.33']]);
  expect(plan.columns.sku).toBe('630010066\n630010066');
  expect(plan.totalCents).toBe(10000);
});

test('multiple source unit prices allowed only with exact subtotal and no allocated discounts', () => {
  const multi = order({ items: [item('630010066', 2, 33), item('IC-003143', 1, 293)], sourceRows: [2, 3], itemSubtotal: 359 });
  expect(resolveLineAmounts(multi).amounts).toEqual([6600, 29300]);
  expect(resolveLineAmounts({ ...multi, itemSubtotal: 358 }).reason).toBeTruthy();
  expect(resolveLineAmounts({ ...multi, shopeeProductDiscount: 63 }).reason).toBeTruthy();
  expect(resolveLineAmounts({ ...multi, sellerVoucher: 10 }).reason).toBeTruthy();
  expect(resolveLineAmounts({ ...multi, shopeeProductDiscount: 63,
    lineFinancials: [{ netSale: 66, shopeeProductDiscount: 0 }, { netSale: 293, shopeeProductDiscount: 63 }] }).amounts)
    .toEqual([6600, 35600]);
});

test.each([
  ['missing Business Insights', undefined],
  ['different amount', confirmed(34)],
  ['different order count', confirmed(33, 2)],
  ['missing BI evidence', { ...confirmed(), shops: [{ shopCode: filters.shopCode, sources: [] }] }],
])('%s blocks every copy column', (_, bi) => {
  const plan = buildAdaSmartCopyPlan([order()], bi, filters);
  expect(plan.status).toBe('review_required');
  expect(plan.columns).toBeNull();
});

test('matching total alone does not waive missing SKU, source evidence or base-unit issues', () => {
  for (const changed of [
    order({ sourceRows: [] }), order({ sourceSha256: '' }),
    order({ items: [{ ...item(), productMatch: { status: 'unmapped' } }] }),
    order({ items: [{ ...item(), productMatch: { status: 'matched', companySku: 'IC-003778', quantityUnit: 'box' }, variant: 'ชมพู 1 กล่อง' }] }),
    order({ items: [{ ...item(), productMatch: { status: 'matched', companySku: '630010066', quantityPerSale: 6 } }] }),
  ]) expect(buildAdaSmartCopyPlan([changed], confirmed(), filters).columns).toBeNull();
});

test('SC004 exact user SKU consolidation keeps original price and source variant', () => {
  const changed = { ...item(), name: '1 ซอง Strepsils HHR ยาอมบรรเทาอาการเจ็บคอ 8 เม็ด',
    variant: 'เลมอน ไม่มีน้ำตาล', productMatch: { status: 'unmapped' } };
  expect(resolveCopyProduct('sc-drug-store', changed).sku).toBe('630010066');
  expect(resolveCopyProduct('dr-morepen', changed).reason).toBeTruthy();
  const plan = buildAdaSmartCopyPlan([order({ items: [changed] }), order({ orderNumber: '260901TEST02',
    items: [item('630010066', 2)], itemSubtotal: 66 })], confirmed(99, 2), filters);
  expect(plan.columns).toEqual({ sku: '630010066', quantity: '3', unitPrice: '33.00' });
  expect(plan.rows[0].sources[0].variant).toBe('เลมอน ไม่มีน้ำตาล');
});

test('verified Oreda packaging uses ten ERP sachets, not one 10Pcs item', () => {
  const changed = { ...item('IC-004371'), name: '10 ซอง Oreda RO ผงเกลือแร่ รสส้ม 5.5 กรัม บรรเทาอาการท้องเสีย', variant: '10Pcs' };
  const plan = buildAdaSmartCopyPlan([order({ items: [changed], itemSubtotal: 21 })], confirmed(21), filters);
  expect(plan.columns).toEqual({ sku: 'IC-004371', quantity: '10', unitPrice: '2.10' });
});

const oredaBox = (quantity = 1, unitPrice = 29) => ({
  name: '10 ซอง Oreda RO ผงเกลือแร่ รสส้ม 5.5 กรัม บรรเทาอาการท้องเสีย',
  variant: '1 กล่อง 10 ซอง', quantity, unitPrice, productMatch: { status: 'unmapped' },
});

test('user-confirmed Oreda box resolves an unmapped variant to ten ERP sachets per box', () => {
  const plan = buildAdaSmartCopyPlan([order({ items: [oredaBox(2, 21)], itemSubtotal: 42 })], confirmed(42), filters);
  expect(plan.status).toBe('ready');
  expect(plan.columns).toEqual({ sku: 'IC-004371', quantity: '20', unitPrice: '2.10' });
  expect(plan.rows[0].unit).toBe('ซอง');
  expect(plan.rows[0].sources[0]).toMatchObject({ listingQuantity: 2, quantityPerSale: 10,
    amountCents: 4200, variant: '1 กล่อง 10 ซอง', authority: 'user_confirmed_pack_identity_2026-09-28',
    originalMatch: { status: 'unmapped' } });
});

test('Oreda box and previous 10Pcs sales preserve mixed source prices and exact cents after consolidation', () => {
  const plan = buildAdaSmartCopyPlan([
    order({ items: [{ ...oredaBox(9, 21), variant: '10Pcs' }], itemSubtotal: 189 }),
    order({ orderNumber: '260901BOX02', items: [oredaBox(2, 21)], itemSubtotal: 42 }),
    order({ orderNumber: '260901BOX03', items: [oredaBox()], itemSubtotal: 29 }),
    order({ orderNumber: '260901BOX04', items: [oredaBox()], itemSubtotal: 29 }),
  ], confirmed(289, 4), filters);
  expect(plan.status).toBe('ready');
  expect(plan.columns).toEqual({ sku: 'IC-004371\nIC-004371', quantity: '40\n90', unitPrice: '2.23\n2.22' });
  expect(plan.totalQuantity).toBe(130);
  expect(plan.totalCents).toBe(28900);
  expect(plan.varianceCents).toBe(0);
  expect(plan.rows[0].sources.map(row => row.amountCents)).toEqual([18900, 4200, 2900, 2900]);
});

test.each([
  ['dr-morepen', oredaBox()],
  ['sc-drug-store', { ...oredaBox(), variant: '1 ซอง' }],
  ['sc-drug-store', { ...oredaBox(), variant: '1 กล่อง 50 ซอง' }],
  ['sc-drug-store', { ...oredaBox(), name: '50 ซอง Oreda RO ผงเกลือแร่ รสส้ม 5.5 กรัม บรรเทาอาการท้องเสีย' }],
])('Oreda user confirmation does not broaden to another shop, pack or product (%s)', (shopCode, changed) => {
  expect(resolveCopyProduct(shopCode, changed).reason).toBeTruthy();
});

test('Oreda mapping records the confirmed box barcode separately from the ERP sachet barcode', () => {
  const rules = require('../src/modules/seamless/data/shopeeAdaSmartCopyRules.v1.json');
  const rule = rules.rules.find(row => row.shopCode === filters.shopCode
    && row.productName === oredaBox().name && row.variant === oredaBox().variant);
  expect(rule).toMatchObject({ companySku: 'IC-004371', quantityPerSale: 10,
    sourcePackBarcode: '8852914302211', erpBaseUnitBarcode: '8852914302204',
    authority: 'user_confirmed_pack_identity_2026-09-28' });
});

const gavisconName = 'กาวิสคอน เลือกสูตรและขนาดได้ ชนิดน้ำ 150 มล. / Suspension Mint / Double Action Mint | Gaviscon';
const gavisconBox = (quantity = 1) => ({ ...item('IC-003778', quantity, 410), name: gavisconName,
  variant: 'ชมพู 1 กล่อง' });
const gavisconGreenBox = (quantity = 1) => ({ ...item('IC-001048', quantity, 354), name: gavisconName,
  variant: 'เขียว 1 กล่อง' });
const senhamiBox = (quantity = 1) => ({ ...item('IC-005092', quantity, 46),
  name: 'Senhami เซนฮามี่ ยาอมสมุนไพร 20 เม็ด บรรเทาอาการไอและขับเสมหะ',
  productMatch: { status: 'unmapped' } });

test('confirmed Gaviscon pink box resolves its old unit hold and converts each box to twelve sachets', () => {
  const resolved = resolveCopyProduct(filters.shopCode, gavisconBox(2));
  expect(resolved).toMatchObject({ sku: 'IC-003778', factor: 12, unit: 'ซอง',
    authority: 'user_confirmed_12_sachet_box_2026-09-28' });
  const plan = buildAdaSmartCopyPlan([order({ items: [gavisconBox(2)], itemSubtotal: 820 })], confirmed(820), filters);
  expect(plan.status).toBe('ready');
  expect(plan.totalQuantity).toBe(24);
  expect(plan.totalCents).toBe(82000);
  expect(plan.columns).toEqual({ sku: 'IC-003778\nIC-003778', quantity: '16\n8', unitPrice: '34.17\n34.16' });
});

test.each([
  ['dr-morepen', gavisconBox()],
  ['sc-drug-store', { ...gavisconBox(), name: 'another source product' }],
  ['sc-drug-store', { ...gavisconBox(), variant: 'ชมพู 2 กล่อง', productMatch: { status: 'unmapped' } }],
])('Gaviscon confirmation keeps other shops, identities and pack sizes unresolved (%s)', (shopCode, changed) => {
  expect(resolveCopyProduct(shopCode, changed).reason).toBeTruthy();
});

test('confirmed Gaviscon green box converts eight source boxes to ninety-six ERP sachets without changing money', () => {
  expect(resolveCopyProduct(filters.shopCode, gavisconGreenBox())).toMatchObject({ sku: 'IC-001048',
    factor: 12, unit: 'ซอง', authority: 'user_confirmed_green_12_sachet_box_2026-09-28' });
  const plan = buildAdaSmartCopyPlan([order({ items: [gavisconGreenBox(8)], itemSubtotal: 2832 })], confirmed(2832), filters);
  expect(plan.status).toBe('ready');
  expect(plan.columns).toEqual({ sku: 'IC-001048', quantity: '96', unitPrice: '29.50' });
  expect(plan.totalCents).toBe(283200);
  expect(plan.varianceCents).toBe(0);
  expect(plan.rows[0].sources[0]).toMatchObject({ listingQuantity: 8, quantityPerSale: 12,
    amountCents: 283200, originalMatch: { status: 'matched', companySku: 'IC-001048' } });
});

test.each([
  ['dr-morepen', gavisconGreenBox()],
  ['sc-drug-store', { ...gavisconGreenBox(), name: 'another source product' }],
  ['sc-drug-store', { ...gavisconGreenBox(), variant: 'เขียว 2 กล่อง', productMatch: { status: 'unmapped' } }],
])('Gaviscon green confirmation keeps other shops, identities and pack sizes unresolved (%s)', (shopCode, changed) => {
  expect(resolveCopyProduct(shopCode, changed).reason).toBeTruthy();
});

test('green box factor does not multiply green bottles or individual ERP sachets', () => {
  expect(resolveCopyProduct(filters.shopCode, { ...gavisconGreenBox(), variant: 'เขียว 1 ขวด',
    productMatch: { status: 'matched', companySku: 'IC-000398' } }))
    .toMatchObject({ sku: 'IC-000398', factor: 1, unit: 'ขวด' });
  expect(resolveCopyProduct(filters.shopCode, { ...gavisconGreenBox(), variant: 'เขียว 1 ซอง' }))
    .toMatchObject({ sku: 'IC-001048', factor: 1, unit: 'ซอง' });
});

test('green mapping records the confirmed box barcode separately from the existing ERP sachet barcode', () => {
  const rules = require('../src/modules/seamless/data/shopeeAdaSmartCopyRules.v1.json');
  expect(rules.rules.find(row => row.shopCode === filters.shopCode
    && row.productName === gavisconName && row.variant === 'เขียว 1 กล่อง'))
    .toMatchObject({ companySku: 'IC-001048', quantityPerSale: 12,
      sourcePackBarcode: '8850360032249', erpBaseUnitBarcode: '50230112' });
});

test('Senhami twenty-tablet box maps the confirmed SKU in ERP boxes without multiplying tablets', () => {
  const plan = buildAdaSmartCopyPlan([order({ items: [senhamiBox(2)], itemSubtotal: 92 })], confirmed(92), filters);
  expect(plan.status).toBe('ready');
  expect(plan.columns).toEqual({ sku: 'IC-005092', quantity: '2', unitPrice: '46.00' });
  expect(plan.rows[0].unit).toBe('กล่อง');
  expect(plan.rows[0].sources[0]).toMatchObject({ listingQuantity: 2, quantityPerSale: 1,
    amountCents: 9200, originalMatch: { status: 'unmapped' } });
  expect(resolveCopyProduct('dr-morepen', senhamiBox()).reason).toBeTruthy();
  expect(resolveCopyProduct(filters.shopCode, { ...senhamiBox(), variant: '40 เม็ด' }).reason).toBeTruthy();
});

test('mixed confirmed green and pink Gaviscon boxes preserve each source amount and reconcile all copy columns', () => {
  const green = gavisconGreenBox(8);
  const plan = buildAdaSmartCopyPlan([
    order({ items: [green, gavisconBox(9)], sourceRows: [1082, 1083], itemSubtotal: 6522 }),
    order({ orderNumber: '260901SENHAMI', items: [senhamiBox()], itemSubtotal: 46 }),
    order({ orderNumber: '260901PINK02', items: [gavisconBox()], itemSubtotal: 410 }),
    order({ orderNumber: '260901PINK03', items: [gavisconBox()], itemSubtotal: 410 }),
  ], confirmed(7388, 4), filters);
  expect(plan.status).toBe('ready');
  expect(plan.issues).toEqual([]);
  expect(plan.columns).toEqual({ sku: 'IC-001048\nIC-003778\nIC-003778\nIC-005092',
    quantity: '96\n88\n44\n1', unitPrice: '29.50\n34.17\n34.16\n46.00' });
  const pink = plan.rows.filter(row => row.sku === 'IC-003778');
  expect(pink.map(row => [row.quantity, row.unitPrice])).toEqual([[88, '34.17'], [44, '34.16']]);
  expect(pink.reduce((sum, row) => sum + row.amountCents, 0)).toBe(451000);
  expect(pink[0].sources[0]).toMatchObject({ sourceRow: 1083, listingQuantity: 9,
    quantityPerSale: 12, amountCents: 369000, priceBasis: 'source_unit_prices_exact_subtotal' });
  const greenRow = plan.rows.find(row => row.sku === 'IC-001048');
  expect(greenRow).toMatchObject({ quantity: 96, unit: 'ซอง', unitPrice: '29.50', amountCents: 283200 });
  expect(greenRow.sources[0]).toMatchObject({ sourceRow: 1082, listingQuantity: 8,
    quantityPerSale: 12, amountCents: 283200, priceBasis: 'source_unit_prices_exact_subtotal' });
  expect(plan.rows.find(row => row.sku === 'IC-005092')).toMatchObject({ quantity: 1,
    unit: 'กล่อง', unitPrice: '46.00', amountCents: 4600 });
  expect(plan.totalCents).toBe(738800);
  expect(plan.cohortTotalCents).toBe(738800);
  expect(plan.varianceCents).toBe(0);
});

const historicalKids = { ...item('IC-002893', 2, 75),
  name: 'สเปรย์ช่องปาก Propoliz Kids 10 มล. สำหรับเด็ก ลดอาการเจ็บคอและระคายเคือง',
  variant: '1 ขวด 10 มล.', productMatch: { status: 'unmapped' } };
const historicalLozengeName = 'Propoliz Lozenge 1 ซอง 8 เม็ด ลูกอมโพรโพลิส ผสมน้ำผึ้ง แก้เจ็บคอระคายคอ แบบซอง กลิ่นน้ำผึ้งมะนาวและขิง/ส้ม Vit C';
const historicalOrange = { ...item('IC-003569', 1, 25), name: historicalLozengeName,
  variant: '1 ซอง วิตซี ส้ม', productMatch: { status: 'unmapped' } };
const historicalLemon = { ...historicalOrange, variant: '1 ซอง น้ำผึ้งมะนาว' };
const historicalSenhami = { ...senhamiBox(), name: 'Senhami เซนฮามี่ ยาอมสมุนไพร 20 เม็ด' };

test('historical names and variants reuse confirmed SKUs, preserve flavours and reconcile all five source lines', () => {
  const plan = buildAdaSmartCopyPlan([
    order({ items: [historicalKids, historicalOrange], sourceRows: [1139, 1140], itemSubtotal: 175 }),
    order({ orderNumber: '260901ALIAS02', items: [historicalLemon], sourceRows: [1150], itemSubtotal: 25 }),
    order({ orderNumber: '260901ALIAS03', items: [{ ...historicalSenhami, quantity: 2 }], sourceRows: [1166], itemSubtotal: 92 }),
    order({ orderNumber: '260901ALIAS04', items: [{ ...historicalSenhami, quantity: 6 }], sourceRows: [1199], itemSubtotal: 276 }),
  ], confirmed(568, 4), filters);
  expect(plan.status).toBe('ready');
  expect(plan.sourceLineCount).toBe(5);
  expect(plan.columns).toEqual({ sku: 'IC-002080\nIC-002893\nIC-003569\nIC-005092',
    quantity: '1\n2\n1\n8', unitPrice: '25.00\n75.00\n25.00\n46.00' });
  expect(plan.rows.map(row => row.unit)).toEqual(['ซอง', 'ขวด', 'ซอง', 'กล่อง']);
  expect(plan.totalCents).toBe(56800);
  expect(plan.varianceCents).toBe(0);
  expect(plan.rows[1].sources[0]).toMatchObject({ sourceRow: 1139, listingQuantity: 2,
    quantityPerSale: 1, amountCents: 15000, originalMatch: { status: 'unmapped' } });
  expect(plan.rows[3].sources.map(row => row.sourceRow)).toEqual([1166, 1199]);
});

test.each([historicalKids, historicalOrange, historicalLemon, historicalSenhami])(
  'historical copy identity corrections remain scoped to their shop, name and exact pack ($variant)', changed => {
    expect(resolveCopyProduct('dr-morepen', changed).reason).toBeTruthy();
    expect(resolveCopyProduct(filters.shopCode, { ...changed, name: 'another product' }).reason).toBeTruthy();
    expect(resolveCopyProduct(filters.shopCode, { ...changed, variant: 'unconfirmed two-pack' }).reason).toBeTruthy();
  });

test('existing canonical Propoliz flavours and packs keep their original catalogue matches', () => {
  const { matchShopeeProduct } = require('../src/modules/seamless/services/shopeeProductMatcher');
  const catalog = require('../src/modules/seamless/data/shopeeProductCatalog.v1.json');
  for (const sourceRow of [14, 15, 129, 167, 168]) {
    const record = catalog.records.find(row => row.sourceRow === sourceRow);
    const original = matchShopeeProduct(record.shopCode, { name: record.productName, variant: record.variant });
    expect(original.companySku).toBe(record.match.companySku);
    expect(original.matchSource).toBe('exact_name_variant');
    expect(resolveCopyProduct(record.shopCode, { name: record.productName, variant: record.variant,
      productMatch: original })).toMatchObject({ sku: record.match.companySku, factor: sourceRow >= 167 ? 10 : 1 });
  }
});

const confirmedSwisse = { name: 'Swisse Vitamin C 1000 mg สวิสเซ วิตามินซี 1000 มก. 60 เม็ด ผลิตภัณฑ์เสริมอาหาร',
  variant: '', quantity: 1, unitPrice: 295, productMatch: { status: 'unmapped' } };
const confirmedRoyalGrape = { name: 'Royal-D รอแยล-ดี เครื่องดื่มเกลือแร่ชนิดผง รสองุ่น 25 กรัม x 10 ซอง 1 กล่อง',
  variant: '', quantity: 1, unitPrice: 45, productMatch: { status: 'unmapped' } };
const confirmedRoyalFruit = { ...confirmedRoyalGrape,
  name: 'Royal-D รอแยล-ดี เครื่องดื่มเกลือแร่ชนิดผง รสผลไม้รวม 25 กรัม x 10 ซอง 1 กล่อง' };

test('confirmed Swisse jar and two Royal-D ten-sachet boxes preserve source amounts, units and flavour identities', () => {
  const plan = buildAdaSmartCopyPlan([
    order({ items: [confirmedSwisse], sourceRows: [1142], itemSubtotal: 295 }),
    order({ orderNumber: '260901ROYALD', items: [confirmedRoyalGrape, confirmedRoyalFruit],
      sourceRows: [1156, 1157], itemSubtotal: 90 }),
  ], confirmed(385, 2), filters);
  expect(plan.status).toBe('ready');
  expect(plan.issues).toEqual([]);
  expect(plan.sourceLineCount).toBe(3);
  expect(plan.totalQuantity).toBe(21);
  expect(plan.totalCents).toBe(38500);
  expect(plan.varianceCents).toBe(0);
  expect(plan.columns).toEqual({ sku: '630010187\nIC-004777\nIC-005091',
    quantity: '10\n1\n10', unitPrice: '4.50\n295.00\n4.50' });
  expect(plan.rows.map(row => row.unit)).toEqual(['ซอง', 'กระปุก', 'ซอง']);
  expect(plan.rows[0].sources[0]).toMatchObject({ sourceRow: 1157, listingQuantity: 1,
    quantityPerSale: 10, amountCents: 4500, originalMatch: { status: 'unmapped' },
    productName: confirmedRoyalFruit.name, priceBasis: 'source_unit_prices_exact_subtotal' });
  expect(plan.rows[1].sources[0]).toMatchObject({ sourceRow: 1142, listingQuantity: 1,
    quantityPerSale: 1, amountCents: 29500, originalMatch: { status: 'unmapped' } });
  expect(plan.rows[2].sources[0]).toMatchObject({ sourceRow: 1156, listingQuantity: 1,
    quantityPerSale: 10, amountCents: 4500, originalMatch: { status: 'unmapped' },
    productName: confirmedRoyalGrape.name });
});

test.each([confirmedSwisse, confirmedRoyalGrape, confirmedRoyalFruit])(
  'Swisse and Royal-D confirmation leaves other shops, titles and unconfirmed packs for review ($name)', changed => {
    for (const [shopCode, candidate] of [
      ['dr-morepen', changed],
      [filters.shopCode, { ...changed, name: changed.name.replace(/60 เม็ด|10 ซอง/u, '20 ซอง') }],
      [filters.shopCode, { ...changed, variant: '2 กล่อง' }],
    ]) {
      expect(resolveCopyProduct(shopCode, candidate).reason).toBeTruthy();
      const plan = buildAdaSmartCopyPlan([order({ shopCode, items: [candidate], itemSubtotal: candidate.unitPrice })],
        { ...confirmed(candidate.unitPrice), shopCode }, { ...filters, shopCode });
      expect(plan.status).toBe('review_required');
      expect(plan.columns).toBeNull();
    }
  });

const historicalMouthSpray = { name: 'Propoliz Mouth Spray สเปรย์พ่นปากและคอ โพรโพลิซ พรอพอลิส ปราศจากน้ำตาล',
  variant: '1 ขวด', quantity: 1, unitPrice: 110, productMatch: { status: 'unmapped' } };
const historicalPinkGummy = { name: 'Vita-C วิตามินซี กัมมี่ รสผลไม้รวม 3 รส | Vitamin C Gummy เคี้ยวง่าย อร่อย ทานได้ทุกวัน ซองสีชมพู',
  variant: '12 ซอง', quantity: 1, unitPrice: 168, productMatch: { status: 'unmapped' } };
const historicalChlorBox = { name: 'คลอเฟนิรามีน มาลีเอท 2mg กล่อง 10 แผง ยาสามัญประจำบ้าน Chlorpheniramine Maleate BLHUA',
  variant: '1 กล่อง 10 แผง', quantity: 1, unitPrice: 64, productMatch: { status: 'unmapped' } };
const confirmedBiotin = { name: 'Swisse Biotin Forte สวิสเซ ไบโอติน ฟอร์เต้ วิตามินซี + ซิงค์ 60 เม็ด ผลิตภัณฑ์เสริมอาหาร',
  variant: '', quantity: 1, unitPrice: 395, productMatch: { status: 'unmapped' } };

test('September 12 identities and confirmed Biotin jar keep base units and all five source amounts', () => {
  const plan = buildAdaSmartCopyPlan([
    order({ items: [historicalMouthSpray], sourceRows: [1218], itemSubtotal: 110 }),
    order({ orderNumber: '260901SPRAY02', items: [{ ...historicalMouthSpray, quantity: 2, unitPrice: 105 }],
      sourceRows: [1233], itemSubtotal: 210 }),
    order({ orderNumber: '260901PINKGUMMY', items: [historicalPinkGummy], sourceRows: [1217], itemSubtotal: 168 }),
    order({ orderNumber: '260901CHLORBOX', items: [historicalChlorBox], sourceRows: [1232], itemSubtotal: 64 }),
    order({ orderNumber: '260901BIOTIN', items: [confirmedBiotin], sourceRows: [1216], itemSubtotal: 395 }),
  ], confirmed(947, 5), filters);
  expect(plan.status).toBe('ready');
  expect(plan.sourceLineCount).toBe(5);
  expect(plan.totalQuantity).toBe(26);
  expect(plan.totalCents).toBe(94700);
  expect(plan.columns).toEqual({ sku: 'IC-000665\nIC-001292\nIC-001292\nIC-001510\nIC-005481',
    quantity: '10\n2\n1\n12\n1', unitPrice: '6.40\n106.67\n106.66\n14.00\n395.00' });
  expect(plan.rows.map(row => row.unit)).toEqual(['แผง', 'กล่อง', 'กล่อง', 'ซอง', 'กระปุก']);
  expect(plan.rows[0].sources[0]).toMatchObject({ sourceRow: 1232, listingQuantity: 1,
    quantityPerSale: 10, amountCents: 6400, originalMatch: { status: 'unmapped' } });
  expect(plan.rows[1].sources.map(row => [row.sourceRow, row.amountCents])).toEqual([[1218, 11000], [1233, 21000]]);
  expect(plan.rows[3].sources[0]).toMatchObject({ sourceRow: 1217, listingQuantity: 1,
    quantityPerSale: 12, amountCents: 16800, productName: historicalPinkGummy.name });
  expect(plan.rows[4].sources[0]).toMatchObject({ sourceRow: 1216, listingQuantity: 1,
    quantityPerSale: 1, amountCents: 39500, originalMatch: { status: 'unmapped' },
    authority: 'user_confirmed_swisse_biotin_identity_2026-09-28' });
});

test.each([
  ['dr-morepen', confirmedBiotin],
  [filters.shopCode, { ...confirmedBiotin, name: confirmedBiotin.name.replace('60 เม็ด', '30 เม็ด') }],
  [filters.shopCode, { ...confirmedBiotin, variant: '2 กระปุก' }],
])('Biotin confirmation leaves other shops, sizes and packs unresolved (%s)', (shopCode, changed) => {
  expect(resolveCopyProduct(shopCode, changed).reason).toBeTruthy();
});

test.each([historicalMouthSpray, historicalPinkGummy, historicalChlorBox])(
  'September 12 identity corrections do not broaden to another shop, formula or pack ($variant)', changed => {
    expect(resolveCopyProduct('dr-morepen', changed).reason).toBeTruthy();
    expect(resolveCopyProduct(filters.shopCode, { ...changed, variant: 'unverified pack' }).reason).toBeTruthy();
    expect(resolveCopyProduct(filters.shopCode, { ...changed, name: changed.name.replace(/Mouth Spray|สีชมพู|2mg/u,
      'different formula') }).reason).toBeTruthy();
  });

test('existing pink/yellow gummy variants and canonical mouth spray and chlorpheniramine keep their matches', () => {
  const catalog = require('../src/modules/seamless/data/shopeeProductCatalog.v1.json');
  const { matchShopeeProduct } = require('../src/modules/seamless/services/shopeeProductMatcher');
  for (const sourceRow of [33, 34, 35, 36, 84, 148, 149, 150, 164]) {
    const record = catalog.records.find(row => row.sourceRow === sourceRow);
    const original = matchShopeeProduct(record.shopCode, { name: record.productName, variant: record.variant });
    const factor = sourceRow === 36 ? 10 : Number(record.variant.replace(' ซอง', '')) || 1;
    expect(original.companySku).toBe(record.match.companySku);
    expect(resolveCopyProduct(record.shopCode, { name: record.productName, variant: record.variant,
      productMatch: original })).toMatchObject({ sku: record.match.companySku, factor });
  }
  expect(resolveCopyProduct(filters.shopCode, { ...historicalPinkGummy,
    name: historicalPinkGummy.name.replace('สีชมพู', 'สีเหลือง') }).reason).toBeTruthy();
});

test('repository uses source products and paid-date bounds after snapshot selection, no cancellation exclusion', async () => {
  pool.query.mockResolvedValueOnce({ rows: [] });
  await listPaidOrdersForCopy(filters);
  const [sql, values] = pool.query.mock.calls.at(-1);
  expect(values).toEqual(['sc-drug-store', '2026-09-01', '2026-09-01']);
  expect(sql).toContain("AT TIME ZONE 'Asia/Bangkok'");
  expect(sql.indexOf('SELECT * FROM latest')).toBeLessThan(sql.indexOf('WHERE paid_at'));
  expect(sql).not.toMatch(/UPDATE|INSERT|DELETE|excluded =|shopee_orders\b/u);
});

test('financial copy endpoint rejects non-admins and aggregate scopes before queries', async () => {
  await expect(getAdaSmartCopySummary({ appRole: 'viewer', query: filters }, {})).rejects.toMatchObject({ statusCode: 403 });
  await expect(getAdaSmartCopySummary({ appRole: 'admin', query: { ...filters, shopCode: 'all' } }, {})).rejects.toMatchObject({ statusCode: 400 });
  await expect(getAdaSmartCopySummary({ appRole: 'admin', query: { ...filters, endDate: '2026-08-31' } }, {})).rejects.toMatchObject({ statusCode: 400 });
});
