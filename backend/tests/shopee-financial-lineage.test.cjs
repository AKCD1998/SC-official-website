const fs = require('node:fs');
const path = require('node:path');
const {
  buildFinancialReconciliation,
} = require('../src/modules/seamless/services/shopeeFinancialReconciliationService');
const {
  HEADERS,
  parseSalesSourceRows,
} = require('../src/modules/seamless/services/shopeeSalesSourceService');

const hash = (letter) => letter.repeat(64);
const observedAt = '2026-09-10T02:00:00.000Z';

function sourceRow({ orderNumber, orderedAt, paidAt, completedAt = '-', status = 'สำเร็จแล้ว', amount = 100 }) {
  const values = {
    orderNumber, status, orderedAt, paidAt, completedAt,
    name: 'สินค้าทดสอบ', variant: 'กล่อง', quantity: 1,
    unitPrice: amount, itemSubtotal: amount, shopeeProductDiscount: 0, sellerVoucher: 0,
  };
  return Object.keys(HEADERS).map((key) => values[key]);
}

function snapshot({ shopCode, orderNumber, paidAt, amount, excluded = false,
  orderedAt = '2026-08-31T16:59:00.000Z', observed = '2026-09-01T00:00:00.000Z',
  source = 'a', voucherCodes }) {
  return {
    shopCode, orderNumber,
    orderedAt, paidAt,
    completedAt: null, status: excluded ? 'ยกเลิกแล้ว' : 'สำเร็จแล้ว', excluded,
    itemSubtotal: amount, sellerVoucher: 0, shopeeProductDiscount: 0,
    voucherCodes,
    sourceRows: [2], sourceFilename: `Order.all.20260801_20260831${source}.xlsx`,
    sourceSha256: hash(source), observedAt: observed, importedAt: observed,
  };
}

function official(shopCode, date, salesTotal, orderCount, cancelledSales, cancelledOrderCount) {
  return {
    shopCode, date, salesTotal, orderCount, cancelledSales, cancelledOrderCount,
    returnedSales: 0, returnedOrderCount: 0, sourceRow: 5,
    sourceFilename: `${shopCode}.shopee-shop-stats.20260901-20260901.xlsx`,
    sourceSha256: hash(shopCode === 'sc-drug-store' ? 'c' : 'd'), observedAt, importedAt: observedAt,
  };
}

function voucherEvidence() {
  return {
    shopCode: 'sc-drug-store',
    voucherId: 'SVC-1489610191827020',
    voucherName: 'VCMT BAU 24-30 Aug',
    validFrom: '2026-08-23T17:00:00.000Z',
    validTo: '2026-08-30T16:59:59.999Z',
    discountRate: 0.05,
    maxDiscount: 10,
    minSpend: 110,
    appliesToAllProducts: true,
    sourceUrl: 'https://seller.shopee.co.th/portal/marketing/vouchers/view?edit=1489610191827020',
    sourceObservedAt: '2026-09-09T17:00:00.000Z',
    sourceObservedPrecision: 'date',
    sourceNotes: 'Seller Centre voucher detail; observation recorded at date precision.',
    recordedBy: 'accounting-review',
    recordedAt: observedAt,
  };
}

function orderCoverage(...shopCodes) {
  return shopCodes.map((shopCode, index) => ({
    shopCode,
    startDate: '2026-09-01',
    endDate: '2026-09-02',
    orderCount: 0,
    sourceFilename: `Order.all.20260901_20260902${index || ''}.xlsx`,
    sourceSha256: hash(index ? 'p' : 'o'),
    observedAt,
    importedAt: observedAt,
  }));
}

function completeOrderSources(snapshots, ...shopCodes) {
  const carried = [...new Map(snapshots.map((row) => [row.sourceSha256, {
    shopCode: row.shopCode,
    startDate: '2026-08-31',
    endDate: '2026-08-31',
    orderCount: 1,
    sourceFilename: row.sourceFilename,
    sourceSha256: row.sourceSha256,
    observedAt: observedAt,
    importedAt: observedAt,
  }])).values()];
  return [...orderCoverage(...shopCodes), ...carried];
}

test('Order All parser persists payment/completed timestamps and keeps never-paid cancellation outside Sales batch', () => {
  const parsed = parseSalesSourceRows([
    Object.values(HEADERS),
    sourceRow({ orderNumber: 'ORDERPAID001', orderedAt: '2026-08-31 23:59', paidAt: '2026-09-01 00:01', completedAt: '2026-09-03 11:00' }),
    sourceRow({ orderNumber: 'ORDERNEVER01', orderedAt: '2026-08-31 23:58', paidAt: '-', status: 'ยกเลิกแล้ว' }),
  ], {
    shopCode: 'sc-drug-store',
    sourceFilename: 'Order.all.20260801_20260831.xlsx',
    sourceSha256: hash('a'), observedAt,
  });
  expect(parsed.facts[0]).toMatchObject({
    paidAt: '2026-08-31T17:01:00.000Z',
    completedAt: '2026-09-03T04:00:00.000Z',
  });
  expect(parsed.facts[1].paidAt).toBeNull();
});

test('reconciliation uses payment day, keeps cancelled orders in gross, and creates a separate credit-note bridge', () => {
  const orderSnapshots = [
    snapshot({ shopCode: 'dr-morepen', orderNumber: 'DRPAID000001', paidAt: '2026-08-31T17:01:00.000Z', amount: 90, source: 'a' }),
    snapshot({ shopCode: 'dr-morepen', orderNumber: 'DRCANCEL0001', paidAt: '2026-08-31T18:00:00.000Z', amount: 10, source: 'b' }),
    snapshot({ shopCode: 'dr-morepen', orderNumber: 'DRCANCEL0001', paidAt: '2026-08-31T18:00:00.000Z', amount: 10, excluded: true, observed: '2026-09-05T00:00:00.000Z', source: 'c' }),
    snapshot({ shopCode: 'dr-morepen', orderNumber: 'DRNEVER00001', paidAt: null, amount: 999, excluded: true, source: 'd' }),
  ];
  const evidence = { orderSnapshots, orderSources: completeOrderSources(orderSnapshots, 'dr-morepen'),
    incomeFacts: [], balanceFacts: [], returnFacts: [] };
  const result = buildFinancialReconciliation({
    officialDaily: [official('dr-morepen', '2026-09-01', 100, 2, 10, 1)],
    evidence,
    filters: { shopCode: 'dr-morepen', startDate: '2026-09-01', endDate: '2026-09-01' },
  });
  expect(result.status).toBe('reconciled');
  expect(result.orders).toHaveLength(2);
  expect(result.orders.find((row) => row.orderNumber === 'DRCANCEL0001')).toMatchObject({
    grossSalesAmount: 10, creditNoteRequired: true, cancellationAmount: 10,
  });
  expect(result.shops[0]).toMatchObject({
    salesBatch: { officialAmount: 100, reconstructedAmount: 100, status: 'reconciled' },
    creditNotes: { officialAmount: 10, reconstructedAmount: 10, status: 'reconciled' },
    confirmedNet: { officialAmount: 90, reconstructedAmount: 90, status: 'reconciled' },
  });
});

test('SC-style gross residual stays unresolved with candidate orders and never becomes a plug', () => {
  const voucherCodes = ['SVC-1489610191827020'];
  const orderSnapshots = [
    snapshot({ shopCode: 'sc-drug-store', orderNumber: 'SCACTIVE0001', paidAt: '2026-08-31T17:01:00.000Z', amount: 80, source: 'a' }),
    snapshot({ shopCode: 'sc-drug-store', orderNumber: 'SCCANCEL001', paidAt: '2026-08-31T18:00:00.000Z', amount: 40, source: 'b', voucherCodes }),
    snapshot({ shopCode: 'sc-drug-store', orderNumber: 'SCCANCEL001', paidAt: '2026-08-31T18:00:00.000Z', amount: 40, excluded: true, observed: '2026-09-05T00:00:00.000Z', source: 'c', voucherCodes }),
  ];
  const evidence = { orderSnapshots, orderSources: completeOrderSources(orderSnapshots, 'sc-drug-store'),
    incomeFacts: [], balanceFacts: [], returnFacts: [] };
  const result = buildFinancialReconciliation({
    officialDaily: [official('sc-drug-store', '2026-09-01', 100, 2, 20, 1)],
    evidence,
    filters: { shopCode: 'sc-drug-store', startDate: '2026-09-01', endDate: '2026-09-01' },
  });
  expect(result.status).toBe('unresolved');
  expect(result.shops[0].salesBatch).toMatchObject({ reconstructedAmount: 120, officialAmount: 100, variance: 20, status: 'unresolved' });
  expect(result.shops[0].creditNotes).toMatchObject({ reconstructedAmount: 40, officialAmount: 20, variance: 20, status: 'unresolved' });
  expect(result.shops[0].confirmedNet).toMatchObject({ reconstructedAmount: 80, officialAmount: 80, variance: 0, status: 'reconciled' });
  expect(result.shops[0].unresolved[0].orderNumbers).toContain('SCCANCEL001');
  expect(result.orders.find((row) => row.orderNumber === 'SCCANCEL001').sellerVoucherRestoration.status)
    .toBe('missing_explicit_campaign_evidence');
  expect(result.shops[0].unresolved).toContainEqual(expect.objectContaining({
    reasonCode: 'seller_voucher_restoration_not_proven', orderNumbers: ['SCCANCEL001'],
  }));
  expect(JSON.stringify(result)).not.toMatch(/plug|forced|allocatedResidual/iu);
});

test('explicit Seller Centre voucher evidence restores 11 cancelled orders at order grain and reconciles every rollup', () => {
  const ordersByPaymentDay = {
    '2026-08-25': ['2608259QFHDAH8', '260825ASAD4CXS'],
    '2026-08-28': ['260828G1PS9JAG', '260828G5BHQHJF', '260829JFTV2H9J'],
    '2026-08-29': ['260829MV5WEYNS'],
    '2026-08-30': ['260830P1WJ855H', '260830P760EXGG', '260830PM5S4EAU', '260830PUU8HW00', '260830Q428SY3J'],
  };
  const orderSnapshots = Object.entries(ordersByPaymentDay).flatMap(([date, orderNumbers]) => (
    orderNumbers.map((orderNumber, index) => snapshot({
      shopCode: 'sc-drug-store',
      orderNumber,
      orderedAt: `${date}T03:${String(index).padStart(2, '0')}:00.000Z`,
      paidAt: `${date}T04:${String(index).padStart(2, '0')}:00.000Z`,
      amount: 200,
      excluded: true,
      observed: observedAt,
      source: 'v',
      voucherCodes: ['SVC-1489610191827020'],
    }))
  ));
  const dates = ['24', '25', '26', '27', '28', '29', '30'].map((day) => `2026-08-${day}`);
  const officialDaily = dates.map((date) => {
    const count = ordersByPaymentDay[date]?.length || 0;
    return official('sc-drug-store', date, count * 190, count, count * 190, count);
  });
  const evidence = {
    orderSnapshots,
    orderSources: [{
      shopCode: 'sc-drug-store', startDate: '2026-08-24', endDate: '2026-08-30',
      orderCount: 11, sourceFilename: 'Order.all.20260824_20260830.xlsx',
      sourceSha256: hash('v'), observedAt, importedAt: observedAt,
    }],
    sellerVoucherEvidence: [voucherEvidence()],
    incomeFacts: [], balanceFacts: [], returnFacts: [],
  };
  const result = buildFinancialReconciliation({
    officialDaily,
    evidence,
    filters: { shopCode: 'sc-drug-store', startDate: '2026-08-24', endDate: '2026-08-30' },
  });

  expect(result.status).toBe('reconciled');
  expect(result.aggregates.daily.map((row) => row.sellerVoucherRestoration.restoredAmount))
    .toEqual([0, 20, 0, 0, 30, 10, 50]);
  expect(result.aggregates.daily.every((row) => row.status === 'reconciled')).toBe(true);
  expect(result.aggregates.weekly[0]).toMatchObject({
    status: 'reconciled',
    salesBatch: { reconstructedAmount: 2090, officialAmount: 2090, variance: 0 },
    creditNotes: { reconstructedAmount: 2090, officialAmount: 2090, variance: 0 },
    sellerVoucherRestoration: { restoredAmount: 110, restoredOrderCount: 11 },
  });
  expect(result.aggregates.monthly[0]).toMatchObject({
    status: 'reconciled', sellerVoucherRestoration: { restoredAmount: 110, restoredOrderCount: 11 },
  });
  expect(result.shops[0].sellerVoucherRestoration).toMatchObject({
    restoredAmount: 110,
    restoredOrderCount: 11,
    campaigns: [expect.objectContaining({
      voucherId: 'SVC-1489610191827020', voucherName: 'VCMT BAU 24-30 Aug',
      discountRate: 0.05, maxDiscount: 10, minSpend: 110,
      sourceObservedPrecision: 'date',
    })],
  });
  expect(result.orders[0]).toMatchObject({
    grossSalesAmount: 190,
    cancellationAmount: 190,
    currentNetAmount: 0,
    sellerVoucherRestoration: {
      status: 'restored_from_explicit_campaign_evidence',
      sourceAmount: 0,
      restoredAmount: 10,
      effectiveAmount: 10,
      voucherCodes: ['SVC-1489610191827020'],
      voucherCodeEvidence: { sourceSha256: hash('v'), sourceRows: [2] },
      campaignEvidence: { sourceUrl: voucherEvidence().sourceUrl },
    },
  });
  expect(JSON.stringify(result)).not.toMatch(/allocatedResidual|aggregateAdjustment/iu);
});

test('seller-voucher campaign validity uses paidAt when the order was created before the campaign', () => {
  const order = snapshot({
    shopCode: 'sc-drug-store', orderNumber: '260823PAIDNEXT',
    orderedAt: '2026-08-23T16:50:00.000Z',
    paidAt: '2026-08-23T17:05:00.000Z',
    amount: 200, excluded: true, observed: observedAt, source: 'q',
    voucherCodes: ['SVC-1489610191827020'],
  });
  const result = buildFinancialReconciliation({
    officialDaily: [official('sc-drug-store', '2026-08-24', 190, 1, 190, 1)],
    evidence: {
      orderSnapshots: [order], sellerVoucherEvidence: [voucherEvidence()],
      orderSources: [
        { shopCode: 'sc-drug-store', startDate: '2026-08-23', endDate: '2026-08-23',
          orderCount: 1, sourceFilename: order.sourceFilename, sourceSha256: order.sourceSha256,
          observedAt, importedAt: observedAt },
        { shopCode: 'sc-drug-store', startDate: '2026-08-24', endDate: '2026-08-24',
          orderCount: 0, sourceFilename: 'Order.all.20260824_20260824.xlsx', sourceSha256: hash('w'),
          observedAt, importedAt: observedAt },
      ],
      incomeFacts: [], balanceFacts: [], returnFacts: [],
    },
    filters: { shopCode: 'sc-drug-store', startDate: '2026-08-24', endDate: '2026-08-24' },
  });
  expect(result.status).toBe('reconciled');
  expect(result.orders[0].sellerVoucherRestoration).toMatchObject({
    status: 'restored_from_explicit_campaign_evidence', restoredAmount: 10,
  });
});

test('weekly/monthly status is derived from daily checks and offsetting variances cannot create a false pass', () => {
  const orderSnapshots = [
    snapshot({ shopCode: 'sc-drug-store', orderNumber: 'SCONE0000001', paidAt: '2026-08-31T17:01:00.000Z', amount: 120, source: 'a' }),
    snapshot({ shopCode: 'sc-drug-store', orderNumber: 'SCTWO0000001', paidAt: '2026-09-01T17:01:00.000Z', amount: 80, source: 'b' }),
  ];
  const evidence = { orderSnapshots, orderSources: completeOrderSources(orderSnapshots, 'sc-drug-store'),
    incomeFacts: [], balanceFacts: [], returnFacts: [] };
  const officialDaily = [
    official('sc-drug-store', '2026-09-01', 100, 1, 0, 0),
    { ...official('sc-drug-store', '2026-09-02', 100, 1, 0, 0), sourceRow: 6 },
  ];
  const result = buildFinancialReconciliation({ officialDaily, evidence,
    filters: { shopCode: 'sc-drug-store', startDate: '2026-09-01', endDate: '2026-09-02' } });
  expect(result.shops[0].salesBatch.variance).toBe(0);
  expect(result.shops[0].salesBatch.status).toBe('unresolved');
  expect(result.aggregates.weekly[0].salesBatch).toMatchObject({ variance: 0, status: 'unresolved', allContributingDaysReconciled: false });
  expect(result.aggregates.monthly[0].salesBatch.status).toBe('unresolved');
});

test('shop key isolates identical order numbers and payout evidence remains a bridge, not a sales equality assertion', () => {
  const rows = ['sc-drug-store', 'dr-morepen'].map((shopCode, index) => snapshot({
    shopCode, orderNumber: 'SAMEORDER001', paidAt: '2026-08-31T17:01:00.000Z', amount: 100 + index, source: index ? 'b' : 'a',
  }));
  const evidence = {
    orderSnapshots: rows,
    orderSources: completeOrderSources(rows, 'sc-drug-store', 'dr-morepen'),
    incomeFacts: [{ shopCode: 'sc-drug-store', orderNumber: 'SAMEORDER001', payoutAmount: 80,
      reportType: 'income-transferred', transferredAt: '2026-09-06T00:00:00.000Z',
      sourceRow: 7, sourceFilename: 'income.xlsx', sourceSha256: hash('e'), observedAt }],
    balanceFacts: [], returnFacts: [],
  };
  const result = buildFinancialReconciliation({
    officialDaily: [official('sc-drug-store', '2026-09-01', 100, 1, 0, 0), official('dr-morepen', '2026-09-01', 101, 1, 0, 0)],
    evidence, filters: { shopCode: 'all', startDate: '2026-09-01', endDate: '2026-09-01' },
  });
  expect(result.status).toBe('reconciled');
  expect(result.orders).toHaveLength(2);
  expect(result.shops.find((row) => row.shopCode === 'sc-drug-store').payoutBridge)
    .toMatchObject({ income: { latestState: { transferred: { linkedOrderCount: 1, payoutAmount: 80 } } } });
  expect(result.shops.find((row) => row.shopCode === 'dr-morepen').payoutBridge)
    .toMatchObject({ income: { latestState: { transferred: { linkedOrderCount: 0, payoutAmount: 0 } } } });
});

test('a BI zero day without explicit Order All coverage remains incomplete', () => {
  const result = buildFinancialReconciliation({
    officialDaily: [official('sc-drug-store', '2026-09-01', 0, 0, 0, 0)],
    evidence: { orderSnapshots: [], orderSources: [], incomeFacts: [], balanceFacts: [], returnFacts: [] },
    filters: { shopCode: 'sc-drug-store', startDate: '2026-09-01', endDate: '2026-09-01' },
  });
  expect(result.status).toBe('incomplete');
  expect(result.aggregates.daily[0]).toMatchObject({
    status: 'incomplete',
    salesBatch: { status: 'incomplete' },
    unresolved: [expect.objectContaining({ reasonCode: 'missing_order_all_creation_coverage' })],
  });
  expect(result.aggregates.weekly[0].status).toBe('incomplete');
  expect(result.aggregates.monthly[0].status).toBe('incomplete');
});

test('an order created before the range but paid inside it requires its prior creation-period source', () => {
  const carried = snapshot({ shopCode: 'sc-drug-store', orderNumber: 'SCCARRYOVER01',
    paidAt: '2026-08-31T17:01:00.000Z', amount: 100, source: 'a' });
  const result = buildFinancialReconciliation({
    officialDaily: [official('sc-drug-store', '2026-09-01', 100, 1, 0, 0)],
    evidence: {
      orderSnapshots: [carried],
      // This source covers orders created on the payment day, but is not the
      // prior source that produced the known carry-over order.
      orderSources: orderCoverage('sc-drug-store'),
      incomeFacts: [], balanceFacts: [], returnFacts: [],
    },
    filters: { shopCode: 'sc-drug-store', startDate: '2026-09-01', endDate: '2026-09-01' },
  });
  expect(result.status).toBe('incomplete');
  expect(result.aggregates.daily[0].unresolved).toContainEqual(expect.objectContaining({
    reasonCode: 'missing_order_all_carry_over_source',
    orderNumbers: ['SCCARRYOVER01'],
  }));
});

test('mutable payout and balance amounts are superseded by stable business identity, never double-counted', () => {
  const order = snapshot({ shopCode: 'sc-drug-store', orderNumber: 'SCIDENTITY01',
    paidAt: '2026-08-31T17:01:00.000Z', amount: 100, source: 'a' });
  const income = (payoutAmount, sourceSha256, observed) => ({
    shopCode: 'sc-drug-store', orderNumber: order.orderNumber, returnRequestNumber: null,
    payoutAmount, components: {}, reportType: 'income-transferred',
    transferredAt: '2026-09-06T00:00:00.000Z', sourceRow: 7,
    sourceFilename: 'income.xlsx', sourceSha256, observedAt: observed,
  });
  const balance = (value, sourceSha256, observed) => ({
    shopCode: 'sc-drug-store', orderNumber: order.orderNumber, amount: value,
    transactionAt: '2026-09-06T01:00:00.000Z', transactionType: 'order-income',
    direction: 'เงินเข้า', status: 'ทำรายการสำเร็จ', sourceRow: 19,
    sourceFilename: 'balance.xlsx', sourceSha256, observedAt: observed,
  });
  const result = buildFinancialReconciliation({
    officialDaily: [official('sc-drug-store', '2026-09-01', 100, 1, 0, 0)],
    evidence: {
      orderSnapshots: [order], orderSources: completeOrderSources([order], 'sc-drug-store'), returnFacts: [],
      incomeFacts: [income(70, hash('e'), '2026-09-08T00:00:00.000Z'), income(80, hash('f'), observedAt)],
      balanceFacts: [balance(70, hash('g'), '2026-09-08T00:00:00.000Z'), balance(80, hash('h'), observedAt)],
    },
    filters: { shopCode: 'sc-drug-store', startDate: '2026-09-01', endDate: '2026-09-01' },
  });
  expect(result.orders[0].payout).toMatchObject({
    income: { facts: [expect.objectContaining({ payoutAmount: 80 })] },
    sellerBalanceAmount: 80,
  });
  expect(result.orders[0].payout.income.facts).toHaveLength(1);
});

test('pending and transferred Income remain separate while latest lifecycle state selects transferred once', () => {
  const order = snapshot({ shopCode: 'sc-drug-store', orderNumber: 'SCLIFECYCLE1',
    paidAt: '2026-08-31T17:01:00.000Z', amount: 100, source: 'a' });
  const baseIncome = { shopCode: 'sc-drug-store', orderNumber: order.orderNumber,
    returnRequestNumber: null, payoutAmount: 80, components: {
      productRegularAmount: 100, commissionFee: -20, additiveTotal: 80,
      unexplainedResidual: 0, reconciliationStatus: 'reconciled',
    }, sourceRow: 7, sourceStartDate: '2026-09-01', sourceEndDate: '2026-09-07',
    transferredAt: null, sourceFilename: 'income.xlsx' };
  const result = buildFinancialReconciliation({
    officialDaily: [official('sc-drug-store', '2026-09-01', 100, 1, 0, 0)],
    evidence: {
      orderSnapshots: [order], orderSources: completeOrderSources([order], 'sc-drug-store'), balanceFacts: [], returnFacts: [],
      incomeFacts: [
        { ...baseIncome, reportType: 'income-pending', sourceSha256: hash('z'), observedAt },
        { ...baseIncome, reportType: 'income-transferred', transferredAt: '2026-09-09T00:00:00.000Z',
          sourceSha256: hash('j'), observedAt },
      ],
      downstreamControls: {
        financialStatements: [{ shopCode: 'sc-drug-store', reportType: 'financial-statement',
          startDate: '2026-09-01', endDate: '2026-09-07', transferredTotal: 80, pageCount: 1,
          sourceFilename: 'weekly_report_20260901.pdf', sourceSha256: hash('k'), observedAt }],
        sellerBalanceSources: [{ shopCode: 'sc-drug-store', reportType: 'seller-balance',
          startDate: '2026-09-01', endDate: '2026-09-07', control: { adjustmentTotal: -5, adjustmentCount: 1 },
          sourceFilename: 'balance.xlsx', sourceSha256: hash('l'), observedAt }],
        unlinkedSources: [],
      },
    },
    filters: { shopCode: 'sc-drug-store', startDate: '2026-09-01', endDate: '2026-09-01' },
  });
  expect(result.shops[0].payoutBridge.income).toMatchObject({
    pending: { factCount: 1, payoutAmount: 80 },
    transferred: { factCount: 1, payoutAmount: 80 },
    latestState: {
      pending: { factCount: 0, payoutAmount: 0 },
      transferred: { factCount: 1, payoutAmount: 80 },
    },
  });
  expect(result.shops[0].payoutBridge).not.toHaveProperty('incomeAmount');
  expect(result.shops[0].payoutBridge.income.latestState.transferred.componentBridge).toMatchObject({
    payoutAmount: 80,
    additiveComponentTotal: 80,
    unexplainedResidual: 0,
    status: 'reconciled',
    evidence: [expect.objectContaining({ sourceSha256: hash('j') })],
  });
  expect(result.shops[0].payoutBridge.income.latestState.transferred.componentBridge.components)
    .toContainEqual(expect.objectContaining({ key: 'commissionFee', label: 'ค่าคอมมิชชั่น', amount: -20 }));
  expect(result.shops[0].downstreamControls).toMatchObject({
    status: 'unresolved',
    financialStatements: [{ periodStart: '2026-09-01', periodEnd: '2026-09-07',
      periodRelationship: 'contains_requested_period', transferredTotal: 80 }],
    sellerBalanceAdjustments: [{ adjustmentAmount: -5, adjustmentCount: 1 }],
  });
});

test('returns are a separate unresolved stage when the refund amount basis is not proven', () => {
  const order = snapshot({ shopCode: 'sc-drug-store', orderNumber: 'SCRETURN0001',
    paidAt: '2026-08-31T17:01:00.000Z', amount: 100, source: 'a' });
  const result = buildFinancialReconciliation({
    officialDaily: [{ ...official('sc-drug-store', '2026-09-01', 100, 1, 0, 0),
      returnedSales: 25, returnedOrderCount: 1 }],
    evidence: {
      orderSnapshots: [order], orderSources: completeOrderSources([order], 'sc-drug-store'), incomeFacts: [], balanceFacts: [],
      returnSources: [{ shopCode: 'sc-drug-store', startDate: '2026-09-01', endDate: '2026-09-01',
        sourceRowCount: 1, sourceFilename: 'returns.zip', sourceSha256: hash('r'), observedAt }],
      returnFacts: [{ shopCode: 'sc-drug-store', orderNumber: order.orderNumber,
        eventKey: 'return_refund:R1', eventType: 'return_refund', amount: 25,
        amountLabel: 'จำนวนเงินคืนทั้งหมด', sourceRows: [2], sourceFilename: 'returns.zip',
        sourceSha256: hash('r'), observedAt }],
    },
    filters: { shopCode: 'sc-drug-store', startDate: '2026-09-01', endDate: '2026-09-01' },
  });
  expect(result.status).toBe('unresolved');
  expect(result.shops[0]).toMatchObject({
    returns: { officialAmount: 25, reconstructedAmount: null, status: 'unresolved' },
    confirmedNet: { reconstructedAmount: null, status: 'unresolved' },
  });
  expect(result.orders[0].returnEvents).toHaveLength(1);
});

test('return reconciliation uses original confirmed value and Shopee lifecycle count semantics', () => {
  const orderSnapshots = [
    snapshot({ shopCode: 'sc-drug-store', orderNumber: 'SCRETURN0980',
      paidAt: '2026-08-31T17:01:00.000Z', amount: 980, source: 'a' }),
    snapshot({ shopCode: 'sc-drug-store', orderNumber: 'SCRETURN0175',
      paidAt: '2026-08-31T18:01:00.000Z', amount: 175, source: 'b' }),
    snapshot({ shopCode: 'sc-drug-store', orderNumber: 'SCCANCELREQ355',
      paidAt: '2026-08-31T19:01:00.000Z', amount: 355, source: 'e' }),
  ];
  const officialDay = {
    ...official('sc-drug-store', '2026-09-01', 1510, 3, 0, 0),
    returnedSales: 1155,
    returnedOrderCount: 1,
  };
  const result = buildFinancialReconciliation({
    officialDaily: [officialDay],
    evidence: {
      orderSnapshots,
      orderSources: completeOrderSources(orderSnapshots, 'sc-drug-store'),
      incomeFacts: [],
      balanceFacts: [],
      returnSources: [{
        shopCode: 'sc-drug-store', startDate: '2026-09-01', endDate: '2026-09-01',
        sourceRowCount: 3, sourceFilename: 'Order.return_refund_cancel.20260901_20260901.zip',
        sourceSha256: hash('r'), observedAt,
      }],
      returnFacts: [
        { shopCode: 'sc-drug-store', orderNumber: 'SCRETURN0980', eventKey: 'return_refund:R980',
          eventType: 'return_refund', status: 'กำลังส่งคืน', amount: 715,
          amountLabel: 'จำนวนเงินคืนทั้งหมด', sourceRows: [2], sourceFilename: 'returns.zip',
          sourceSha256: hash('r'), observedAt },
        { shopCode: 'sc-drug-store', orderNumber: 'SCRETURN0175', eventKey: 'return_refund:R175',
          eventType: 'return_refund', status: 'อนุมัติคำขอเคลม', amount: 175,
          amountLabel: 'จำนวนเงินคืนทั้งหมด', sourceRows: [3], sourceFilename: 'returns.zip',
          sourceSha256: hash('r'), observedAt },
        { shopCode: 'sc-drug-store', orderNumber: 'SCCANCELREQ355', eventKey: 'return_refund:R355',
          eventType: 'return_refund', status: 'ยกเลิกคำขอ', amount: 284,
          amountLabel: 'จำนวนเงินคืนทั้งหมด', sourceRows: [4], sourceFilename: 'returns.zip',
          sourceSha256: hash('r'), observedAt },
      ],
    },
    filters: { shopCode: 'sc-drug-store', startDate: '2026-09-01', endDate: '2026-09-01' },
  });
  expect(result.status).toBe('reconciled');
  expect(result.shops[0].returns).toMatchObject({
    officialAmount: 1155,
    reconstructedAmount: 1155,
    officialOrderCount: 1,
    reconstructedOrderCount: 1,
    status: 'reconciled',
  });
  expect(result.aggregates.daily[0].returns).toMatchObject({
    amountOrderNumbers: ['SCRETURN0175', 'SCRETURN0980'],
    countedOrderNumbers: ['SCRETURN0175'],
  });
  expect(result.shops[0].confirmedNet).toMatchObject({
    officialAmount: 355,
    reconstructedAmount: 355,
    officialOrderCount: 2,
    reconstructedOrderCount: 2,
    status: 'reconciled',
  });
});

test('lineage migration adds separate indexed timestamps without destructive rewrites', () => {
  const sql = fs.readFileSync(path.resolve(__dirname,
    '../src/modules/seamless/db/migrations/021_shopee_financial_lineage.sql'), 'utf8');
  expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS paid_at timestamptz/iu);
  expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS completed_at timestamptz/iu);
  expect(sql).toMatch(/idx_shopee_sales_facts_paid_at/iu);
  expect(sql).not.toMatch(/DROP TABLE|DELETE FROM|TRUNCATE/iu);
});

test('seller-voucher migration stores explicit campaign provenance without an aggregate monetary plug', () => {
  const sql = fs.readFileSync(path.resolve(__dirname,
    '../src/modules/seamless/db/migrations/022_shopee_seller_voucher_evidence.sql'), 'utf8');
  expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS voucher_codes jsonb/iu);
  expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS shopee_seller_voucher_evidence/iu);
  expect(sql).toMatch(/SVC-1489610191827020/iu);
  expect(sql).toMatch(/VCMT BAU 24-30 Aug/iu);
  expect(sql).toMatch(/2026-08-24 00:00:00\+07/iu);
  expect(sql).toMatch(/2026-08-30 23:59:59\.999\+07/iu);
  expect(sql).toMatch(/\b0\.05\b[\s\S]*\b10\.00\b[\s\S]*\b110\.00\b/iu);
  expect(sql).toMatch(/seller\.shopee\.co\.th\/portal\/marketing\/vouchers\/view\?edit=1489610191827020/iu);
  expect(sql).toMatch(/IF NOT EXISTS[\s\S]*RAISE EXCEPTION 'Existing seller-voucher campaign evidence conflicts/iu);
  expect(sql).not.toMatch(/UPDATE[\s\S]+(?:110\.00|110\b)/iu);
  expect(sql).not.toMatch(/DROP TABLE|DELETE FROM|TRUNCATE/iu);
});

test('rollout runbook migrates before backend and documents explicit new-job exact-source enrichment', () => {
  const runbook = fs.readFileSync(path.resolve(__dirname,
    '../docs/SHOPEE-FINANCIAL-LINEAGE-TH.md'), 'utf8');
  expect(runbook.indexOf('2. รัน migration 021 และ 022')).toBeLessThan(runbook.indexOf('3. deploy backend รุ่นใหม่'));
  expect(runbook).toMatch(/jobId` เดิมคืน `unchanged` แบบ zero-write/u);
  expect(runbook).toMatch(/job ID ใหม่เป็นการสั่งให้ repository ตรวจ bytes\/SHA เดิม/u);
  expect(runbook).toMatch(/Order All เป็น \*\*ช่วงวันที่สร้างคำสั่งซื้อ\*\*/u);
  expect(runbook).toMatch(/ชำระ 31 ส\.ค\. แต่โอนในรอบ 1–7 ก\.ย\./u);
  expect(runbook).toMatch(/SVC-1489610191827020/u);
  expect(runbook).toMatch(/ห้ามคืนส่วนลดจาก voucher code เพียงอย่างเดียว/u);
});
