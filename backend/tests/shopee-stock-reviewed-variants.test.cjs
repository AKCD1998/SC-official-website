const data = require('../src/modules/seamless/data/shopeeStockReviewedVariants.v1.json');
const { mapShopeeStockLines } = require('../src/modules/seamless/services/shopeeStockReservationShadow');
const { resolveStockProductMatch } = require('../src/modules/seamless/services/shopeeStockProductMatch');
const { matchShopeeProduct } = require('../src/modules/seamless/services/shopeeProductMatcher');
const pos = new Map(data.rules.flatMap(r => r.components).map(c => [c.companySku, {
  companySku: c.companySku, productName: c.posProductName, active: true,
  stockCode: c.companySku, stockFactor: 1, smallFactor: 1, smallUnit: c.quantityUnit,
}]));
const item = r => ({ name: r.productName, variant: r.variant, quantity: 2 });
const find = (text, variant) => data.rules.find(r => r.productName.includes(text) && r.variant === variant);

test.each(data.rules.map((r, i) => [i + 1, r]))('reviewed stock variant %i maps and rejects conflicting source evidence', (_n, r) => {
  const source = item(r), result = mapShopeeStockLines({ items: [source], posCatalog: pos });
  expect(result.status).toBe('mapped');
  expect(result.lines).toEqual(r.components.map(c => ({ stockCode: c.companySku,
    quantity: 2 * c.quantityPerSale })).sort((a, b) => a.stockCode.localeCompare(b.stockCode)));
  expect(resolveStockProductMatch('another-shop', source).matchSource).not.toBe('reviewed_exact_stock_variant');
  for (const extra of [{ productId: 'contradictory', variationId: 'contradictory' },
    { listingVariationId: 'partial-id' }, { sourceBarcode: 'unreviewed' }, { sourceSku: 'different-sku' }]) {
    expect(mapShopeeStockLines({ items: [{ ...source, ...extra }], posCatalog: pos }).status).toBe('blocked');
  }
  const invalidPos = new Map(pos); const c = r.components[0];
  invalidPos.set(c.companySku, { ...pos.get(c.companySku), smallUnit: 'different-unit' });
  expect(mapShopeeStockLines({ items: [source], posCatalog: invalidPos }).reasonCounts.sale_unit_pos_mismatch).toBe(1);
});

test('outer packages use bottles/sachets/blisters, not the contents of those retail units', () => {
  for (const [r, factor] of [[find('ศิริบัญชา', '450มล. 6ขวด'), 6],
    [find('Mybacin OTC', 'มะนาว 20×8'), 20], [find('Bakamol', '50 แผง 1 กล่อง'), 50],
    [find('UNISON', 'ผู้ใหญ่20มล.'), 10], [find('Longmed KLEAN GAUZE', '3 นิ้ว'), 10],
    [find('Softmed', '3x3 นิ้ว'), 1]]) {
    expect(resolveStockProductMatch('sc-drug-store', item(r))).toMatchObject({ quantityPerSale: factor });
  }
});

test('white Polar bundle retains the free small can as its own stock component', () => {
  const r = find('Polar Spray', 'ฝาขาว 2 แถม ฝาขาว');
  expect(mapShopeeStockLines({ items: [{ ...item(r), quantity: 1 }], posCatalog: pos }).lines)
    .toEqual([{ stockCode: 'IC-005185', quantity: 2 }, { stockCode: 'IC-005557', quantity: 1 }]);
});

test('owner-confirmed old Strepsils label keeps its physical label warning', () => {
  const r = find('1 ซอง Strepsils HHR  ', 'เลมอน ไม่มีน้ำตาล');
  expect(mapShopeeStockLines({ items: [item(r)], posCatalog: pos }))
    .toMatchObject({ status: 'mapped', sourceLabelMismatchItems: 1,
      lines: [{ stockCode: '630010066', quantity: 2 }] });
});

test('literal email residue is allowed only for the four individually reviewed single-option titles', () => {
  expect(data.rules.filter(r => r.variant === 'จำนวน:')).toHaveLength(4);
  const r = find('Berocca Performance', 'จำนวน:');
  expect(mapShopeeStockLines({ items: [{ ...item(r), variant: 'จำนวน: 2 กล่อง' }], posCatalog: pos }).status).toBe('blocked');
});

test('unknown cases and ambiguous device kits remain blocked', () => {
  for (const source of [
    { name: 'Klean&Kare Normal Kare น้ำเกลือคลีนแอนด์แคร์ ฝาแหลม 500 มล. / 1000 มล. (แบบยกลัง)', variant: '1000 มล. ยกลังใหม่' },
    { name: 'Sinocare Safe AQ max III เครื่องตรวจน้ำตาลในเลือด ชุดเครื่อง+แผ่น50+เข็ม100 / เครื่อง / แผ่นตรวจ 50 ชิ้น', variant: 'เครื่องแผ่น40เข็ม100' },
  ]) expect(mapShopeeStockLines({ items: [{ ...source, quantity: 1 }], posCatalog: pos }).status).toBe('blocked');
});

test('owner-confirmed max III bundle never subtracts the ten strips already inside the standard kit', () => {
  const r = find('Sinocare Safe AQ max III', 'เครื่องแผ่น50เข็ม100');
  expect(mapShopeeStockLines({ items: [{ ...item(r), quantity: 1 }], posCatalog: pos }).lines)
    .toEqual([{ stockCode: 'IC-001230', quantity: 2 }, { stockCode: 'IC-004131', quantity: 1 }, { stockCode: 'IC-006009', quantity: 1 }]);
});

test('Seller Centre descriptions and packaging images resolve the five remaining evidenced options', () => {
  for (const [r, factor] of [[find('Klean&Kare Normal Kare', '1000 มล. ยกลัง แหลม'), 12],
    [find('Royal-D', 'สตรอเบอร์รี'), 10], [find('Vita-C ไวต้า-ซี วิตามินซี', 'ชิววี่ ขาว'), 20],
    [find('Sinocare Safe AQ Smart', 'เครื่องอย่างเดียว'), 1],
    [find('SOS Plus', 'PU 12x12 ซม.'), 1]]) {
    expect(resolveStockProductMatch('sc-drug-store', item(r))).toMatchObject({ quantityPerSale: factor });
  }
  const pu = find('SOS Plus', 'PU 12x12 ซม.');
  expect(mapShopeeStockLines({ items: [item(pu)], posCatalog: pos })).toMatchObject({ status: 'mapped', sourceLabelMismatchItems: 1 });
});

test('reviewed stock corrections leave general catalog/accounting matching unchanged', () => {
  const r = find('ศิริบัญชา', '450มล. 6ขวด');
  expect(matchShopeeProduct('sc-drug-store', item(r)).status).toBe('unmapped');
  expect(mapShopeeStockLines({ items: [{ ...item(r), productMatch: { status: 'matched', companySku: 'forged', quantityPerSale: 999 } }], posCatalog: pos }).lines)
    .toEqual([{ stockCode: 'IC-000270', quantity: 12 }]);
});
