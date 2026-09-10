const repository = require('../db/shopeeFinancialReconciliationRepository');
const { listConfirmedSalesDays } = require('../db/shopeeConfirmedSalesRepository');
const { datesInRange } = require('./shopeeConfirmedSalesService');
const { moneyCents } = require('./shopeeSalesAccounting');
const { INCOME_COMPONENT_SPECS } = require('./shopeeOfficialDocumentService');
const { requireShopeeShopScope, SHOPEE_SHOP_PROFILES } = require('./shopeeShops');

const SHOP_CODES = Object.keys(SHOPEE_SHOP_PROFILES);

function cents(value, label) {
  const text = String(value ?? '').trim();
  const negative = text.startsWith('-');
  const result = moneyCents(negative ? text.slice(1) : value);
  if (result === null) throw new Error(`Invalid ${label} monetary value.`);
  return negative ? -result : result;
}

function amount(value) {
  return value == null ? null : value / 100;
}

function bangkokDate(value) {
  if (!value) return null;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) throw new Error('Invalid lineage timestamp.');
  return new Date(instant.getTime() + 7 * 3600000).toISOString().slice(0, 10);
}

function orderKey(row) {
  return `${row.shopCode}:${row.orderNumber}`;
}

function groupBy(items, keyFrom) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFrom(item);
    const values = groups.get(key) || [];
    values.push(item);
    groups.set(key, values);
  }
  return groups;
}

function salesCents(snapshot) {
  return cents(snapshot.itemSubtotal, 'order subtotal')
    - cents(snapshot.sellerVoucher, 'seller voucher')
    + cents(snapshot.shopeeProductDiscount, 'Shopee discount');
}

function campaignEvidenceRef(rule) {
  return {
    voucherId: rule.voucherId,
    voucherName: rule.voucherName,
    validFrom: rule.validFrom,
    validTo: rule.validTo,
    discountRate: rule.discountRate,
    maxDiscount: rule.maxDiscount,
    minSpend: rule.minSpend,
    appliesToAllProducts: rule.appliesToAllProducts,
    sourceUrl: rule.sourceUrl,
    sourceObservedAt: rule.sourceObservedAt,
    sourceObservedPrecision: rule.sourceObservedPrecision,
    sourceNotes: rule.sourceNotes,
    recordedBy: rule.recordedBy,
    recordedAt: rule.recordedAt,
  };
}

function sellerVoucherRestoration(snapshots, basis, latest, rules) {
  const sourceAmountCents = cents(basis.sellerVoucher, 'seller voucher');
  const base = {
    sourceAmount: amount(sourceAmountCents),
    restoredAmount: 0,
    effectiveAmount: amount(sourceAmountCents),
    voucherCodes: null,
    voucherCodeEvidence: null,
    campaignEvidence: null,
  };
  if (sourceAmountCents > 0) return { ...base, status: 'source_recorded' };
  if (!latest.excluded) return { ...base, status: 'not_applicable_not_cancelled' };

  // NULL means this immutable source predates voucher-code parsing.  An empty
  // array means the exact bytes were replayed and explicitly contained none.
  const codeSnapshots = snapshots.filter((row) => Array.isArray(row.voucherCodes));
  if (!codeSnapshots.length) return { ...base, status: 'source_not_enriched' };
  const distinctCodeLists = [...new Set(codeSnapshots.map((row) => JSON.stringify(row.voucherCodes)))];
  if (distinctCodeLists.length !== 1) return { ...base, status: 'conflicting_voucher_code_snapshots' };
  const voucherCodes = JSON.parse(distinctCodeLists[0]);
  const voucherCodeEvidence = evidenceRef(codeSnapshots[0]);
  const withCodes = { ...base, voucherCodes, voucherCodeEvidence };
  if (!voucherCodes.length) return { ...withCodes, status: 'not_applicable_no_voucher_code' };

  const paidAt = Date.parse(basis.paidAt);
  if (!Number.isFinite(paidAt)) return { ...withCodes, status: 'payment_timestamp_missing' };
  const matchingRules = rules.filter((rule) => rule.shopCode === basis.shopCode
    && voucherCodes.includes(rule.voucherId)
    && paidAt >= Date.parse(rule.validFrom)
    && paidAt <= Date.parse(rule.validTo));
  if (!matchingRules.length) return { ...withCodes, status: 'missing_explicit_campaign_evidence' };
  if (matchingRules.length !== 1) return { ...withCodes, status: 'ambiguous_campaign_evidence' };
  const rule = matchingRules[0];
  const campaignEvidence = campaignEvidenceRef(rule);
  if (!rule.appliesToAllProducts) {
    return { ...withCodes, campaignEvidence, status: 'product_eligibility_not_proven' };
  }
  const subtotalCents = cents(basis.itemSubtotal, 'order subtotal');
  const minSpendCents = cents(rule.minSpend, 'voucher minimum spend');
  if (subtotalCents < minSpendCents) {
    return { ...withCodes, campaignEvidence, status: 'not_applicable_below_minimum' };
  }
  const uncappedCents = subtotalCents * Number(rule.discountRate);
  const maxDiscountCents = cents(rule.maxDiscount, 'voucher maximum discount');
  const exactDiscountCents = uncappedCents >= maxDiscountCents ? maxDiscountCents : uncappedCents;
  const roundedCents = Math.round(exactDiscountCents);
  // Once the cap binds its value is exact. Otherwise, do not invent a
  // sub-satang rounding convention that is absent from campaign evidence.
  if (Math.abs(exactDiscountCents - roundedCents) > 1e-7) {
    return { ...withCodes, campaignEvidence, status: 'fractional_satang_rule_unproven' };
  }
  const restoredCents = roundedCents;
  if (!Number.isSafeInteger(restoredCents) || restoredCents <= 0) {
    return { ...withCodes, campaignEvidence, status: 'invalid_campaign_calculation' };
  }
  return {
    ...withCodes,
    campaignEvidence,
    status: 'restored_from_explicit_campaign_evidence',
    restoredAmount: amount(restoredCents),
    effectiveAmount: amount(sourceAmountCents + restoredCents),
  };
}

function evidenceRef(row) {
  const result = {
    sourceFilename: row.sourceFilename,
    sourceSha256: row.sourceSha256,
    observedAt: row.observedAt,
    sourceRows: row.sourceRows || (row.sourceRow ? [row.sourceRow] : []),
  };
  if (row.metricEvidence) {
    result.metricEvidence = Object.fromEntries(Object.entries(row.metricEvidence).map(([metric, source]) => [
      metric,
      source ? {
        sourceFilename: source.sourceFilename,
        sourceSha256: source.sourceSha256,
        observedAt: source.observedAt,
        sourceRows: source.sourceRows || (source.sourceRow ? [source.sourceRow] : []),
      } : null,
    ]));
  }
  return result;
}

function sourceEvidenceRef(row) {
  return {
    ...evidenceRef(row),
    startDate: row.startDate,
    endDate: row.endDate,
    sourceRowCount: row.sourceRowCount ?? row.orderCount ?? null,
  };
}

function latestUnique(items, keyFrom, rankFrom = () => 0) {
  const latest = new Map();
  for (const item of [...items].sort((a, b) => (
    String(a.observedAt).localeCompare(String(b.observedAt))
      || rankFrom(a) - rankFrom(b)
      || String(a.sourceSha256).localeCompare(String(b.sourceSha256))
      || Number(a.sourceRow || 0) - Number(b.sourceRow || 0)
  ))) {
    latest.set(keyFrom(item), item);
  }
  return [...latest.values()];
}

function incomeIdentity(row, { includeState = true } = {}) {
  return `${orderKey(row)}:${includeState ? `${row.reportType}:` : ''}${row.returnRequestNumber || ''}`;
}

function balanceIdentity(row) {
  return `${orderKey(row)}:${row.transactionAt || ''}:${row.transactionType || ''}:${row.direction || ''}`;
}

function sumMoney(rows, valueFrom, label) {
  return amount(rows.reduce((sum, row) => sum + cents(valueFrom(row), label), 0));
}

function incomeComponentBridge(rows) {
  const components = INCOME_COMPONENT_SPECS.map(({ key, label, additive }) => {
    const present = rows.filter((row) => row.components?.[key] != null);
    return {
      key,
      label,
      additive,
      amount: present.length ? sumMoney(present, (row) => row.components[key], label) : null,
    };
  });
  const residualRows = rows.filter((row) => row.components?.unexplainedResidual != null);
  const unexplainedResidual = residualRows.length === rows.length
    ? sumMoney(rows, (row) => row.components.unexplainedResidual, 'income unexplained residual') : null;
  return {
    basis: 'signed_shopee_income_components',
    payoutAmount: sumMoney(rows, (row) => row.payoutAmount, 'income payout'),
    additiveComponentTotal: rows.every((row) => row.components?.additiveTotal != null)
      ? sumMoney(rows, (row) => row.components.additiveTotal, 'income component total') : null,
    unexplainedResidual,
    status: !rows.length ? 'not_applicable' : unexplainedResidual == null ? 'incomplete'
      : cents(unexplainedResidual, 'income unexplained residual') === 0 ? 'reconciled' : 'unresolved',
    components,
    evidence: rows.map((row) => row.evidence || evidenceRef(row)),
  };
}

function incomeStateSummary(rows) {
  return {
    factCount: rows.length,
    linkedOrderCount: new Set(rows.map(orderKey)).size,
    payoutAmount: sumMoney(rows, (row) => row.payoutAmount, 'income payout'),
    componentBridge: incomeComponentBridge(rows),
    evidence: rows.map((row) => row.evidence || evidenceRef(row)),
  };
}

function compactIncomeFact(row) {
  return {
    shopCode: row.shopCode,
    orderNumber: row.orderNumber,
    reportType: row.reportType,
    returnRequestNumber: row.returnRequestNumber,
    transferredAt: row.transferredAt,
    payoutAmount: row.payoutAmount,
    components: row.components,
    evidence: evidenceRef(row),
  };
}

function buildOrderLedger({ orderSnapshots, incomeFacts = [], balanceFacts = [], returnFacts = [],
  sellerVoucherEvidence = [] }, filters) {
  const snapshotsByOrder = groupBy(orderSnapshots, orderKey);
  const incomeByOrder = groupBy(latestUnique(incomeFacts,
    (row) => incomeIdentity(row)), orderKey);
  const balanceByOrder = groupBy(latestUnique(balanceFacts,
    balanceIdentity), orderKey);
  const returnsByOrder = groupBy(latestUnique(returnFacts, (row) => `${orderKey(row)}:${row.eventKey}`), orderKey);
  const ledger = [];
  for (const [key, snapshots] of snapshotsByOrder.entries()) {
    const ordered = [...snapshots].sort((left, right) => (
      left.observedAt.localeCompare(right.observedAt)
        || left.sourceSha256.localeCompare(right.sourceSha256)
    ));
    // The earliest snapshot that still has a payment timestamp is the least
    // altered official financial evidence available for a later-cancelled order.
    // We never allocate an aggregate variance back onto an order without proof.
    const basis = ordered.find((row) => row.paidAt != null);
    if (!basis) continue;
    const paidDate = bangkokDate(basis.paidAt);
    if (paidDate < filters.startDate || paidDate > filters.endDate) continue;
    const latest = ordered.at(-1);
    const voucherRestoration = sellerVoucherRestoration(ordered, basis, latest, sellerVoucherEvidence);
    const grossCents = salesCents(basis)
      - cents(voucherRestoration.restoredAmount, 'restored seller voucher');
    const cancellationCents = latest.excluded ? grossCents : 0;
    const linkedIncome = incomeByOrder.get(key) || [];
    const latestIncome = latestUnique(
      linkedIncome,
      (row) => incomeIdentity(row, { includeState: false }),
      // A transferred fact is the terminal lifecycle state. Paired pending and
      // transferred exports can share one observation timestamp, so do not let
      // unrelated SHA ordering decide which state is exposed as latest.
      (row) => row.reportType === 'income-transferred' ? 1 : 0,
    );
    const linkedBalance = balanceByOrder.get(key) || [];
    const linkedReturns = returnsByOrder.get(key) || [];
    ledger.push({
      shopCode: basis.shopCode,
      orderNumber: basis.orderNumber,
      orderedAt: basis.orderedAt,
      paidAt: basis.paidAt,
      paymentDate: paidDate,
      completedAt: latest.completedAt || basis.completedAt,
      latestStatus: latest.status,
      creditNoteRequired: latest.excluded === true,
      grossSalesAmount: amount(grossCents),
      cancellationAmount: amount(cancellationCents),
      currentNetAmount: amount(grossCents - cancellationCents),
      basisRule: 'earliest_paid_official_order_snapshot',
      basisEvidence: evidenceRef(basis),
      latestStatusEvidence: evidenceRef(latest),
      snapshotCount: ordered.length,
      sellerVoucherRestoration: voucherRestoration,
      returnEvents: linkedReturns.map((row) => ({
        eventType: row.eventType, eventAt: row.eventAt, amount: row.amount,
        amountLabel: row.amountLabel, status: row.status, reason: row.reason,
        evidence: evidenceRef(row),
      })),
      payout: {
        income: {
          facts: linkedIncome.map(compactIncomeFact),
          latestState: latestIncome.map(compactIncomeFact),
        },
        sellerBalanceAmount: amount(linkedBalance
          .filter((row) => row.status === 'ทำรายการสำเร็จ')
          .reduce((sum, row) => sum + cents(row.amount, 'Seller Balance'), 0)),
        sellerBalanceEvidence: linkedBalance.map(evidenceRef),
      },
    });
  }
  return ledger.sort((a, b) => a.shopCode.localeCompare(b.shopCode)
    || a.paymentDate.localeCompare(b.paymentDate) || a.orderNumber.localeCompare(b.orderNumber));
}

function stage({ officialAmountCents, reconstructedAmountCents, officialOrderCount,
  reconstructedOrderCount, complete, metric, dateBasis }) {
  const comparable = complete && officialAmountCents != null && reconstructedAmountCents != null
    && officialOrderCount != null && reconstructedOrderCount != null;
  const varianceCents = officialAmountCents == null || reconstructedAmountCents == null
    ? null : reconstructedAmountCents - officialAmountCents;
  const orderVariance = officialOrderCount == null || reconstructedOrderCount == null
    ? null : reconstructedOrderCount - officialOrderCount;
  return {
    metric,
    dateBasis,
    officialAmount: amount(officialAmountCents),
    reconstructedAmount: amount(reconstructedAmountCents),
    variance: amount(varianceCents),
    officialOrderCount,
    reconstructedOrderCount,
    orderVariance,
    status: !complete ? 'incomplete'
      : comparable && varianceCents === 0 && orderVariance === 0 ? 'reconciled' : 'unresolved',
  };
}

function sourceCoversCreationDate(source, date) {
  const observedAt = Date.parse(source.observedAt);
  const completedDay = Date.parse(`${date}T17:00:00.000Z`);
  return source.startDate <= date && source.endDate >= date
    && Number.isFinite(observedAt) && observedAt >= completedDay;
}

function summarizeSellerVoucherRestoration(orders) {
  const restored = orders.filter((row) => (
    row.sellerVoucherRestoration.status === 'restored_from_explicit_campaign_evidence'
  ));
  const campaigns = [...new Map(restored.map((row) => {
    const campaign = row.sellerVoucherRestoration.campaignEvidence;
    return [`${row.shopCode}:${campaign.voucherId}:${campaign.validFrom}`, campaign];
  })).values()];
  return {
    basis: 'order_level_voucher_code_and_explicit_seller_centre_campaign_evidence',
    restoredAmount: sumMoney(restored, (row) => row.sellerVoucherRestoration.restoredAmount,
      'restored seller voucher'),
    restoredOrderCount: restored.length,
    orderNumbers: restored.map((row) => row.orderNumber),
    campaigns,
    orders: restored.map((row) => ({
      orderNumber: row.orderNumber,
      orderedAt: row.orderedAt,
      paymentDate: row.paymentDate,
      sourceAmount: row.sellerVoucherRestoration.sourceAmount,
      restoredAmount: row.sellerVoucherRestoration.restoredAmount,
      effectiveAmount: row.sellerVoucherRestoration.effectiveAmount,
      voucherCodes: row.sellerVoucherRestoration.voucherCodes,
      voucherCodeEvidence: row.sellerVoucherRestoration.voucherCodeEvidence,
      voucherId: row.sellerVoucherRestoration.campaignEvidence.voucherId,
    })),
  };
}

function dailyRowsForShop({ shopCode, dates, officialRows, ledger, orderSources = [], returnSources = [] }) {
  const officialByDate = new Map(officialRows.filter((row) => row.shopCode === shopCode)
    .map((row) => [row.date, row]));
  const ordersByDate = groupBy(ledger.filter((row) => row.shopCode === shopCode), (row) => row.paymentDate);
  return dates.map((date) => {
    const official = officialByDate.get(date);
    const orders = ordersByDate.get(date) || [];
    const orderCreationSources = orderSources.filter((row) => row.shopCode === shopCode
      && sourceCoversCreationDate(row, date));
    const carryOverOrders = orders.filter((row) => bangkokDate(row.orderedAt) < date);
    const carryOverSourceHashes = new Set(carryOverOrders.map((row) => row.basisEvidence.sourceSha256));
    const orderCarryOverSources = orderSources.filter((row) => row.shopCode === shopCode
      && carryOverSourceHashes.has(row.sourceSha256));
    const missingCarryOverSourceHashes = [...carryOverSourceHashes]
      .filter((sha256) => !orderCarryOverSources.some((source) => source.sourceSha256 === sha256));
    const returnCoverageSources = returnSources.filter((row) => row.shopCode === shopCode
      && sourceCoversCreationDate(row, date));
    const grossCents = orders.reduce((sum, row) => sum + cents(row.grossSalesAmount, 'gross sales'), 0);
    const cancelled = orders.filter((row) => row.creditNoteRequired);
    const cancelledCents = cancelled.reduce((sum, row) => sum + cents(row.cancellationAmount, 'cancellation'), 0);
    const officialGross = official ? cents(official.salesTotal, 'official sales') : null;
    const officialCancelled = official?.cancelledSales == null ? null : cents(official.cancelledSales, 'official cancellations');
    const officialReturned = official?.returnedSales == null ? null : cents(official.returnedSales, 'official returns');
    const officialNet = [officialGross, officialCancelled, officialReturned].every((value) => value != null)
      ? officialGross - officialCancelled - officialReturned : null;
    // Return/refund exports retain Shopee's source-column amount label. Until
    // that label is proven to be the confirmed-sales amount we expose it as
    // event evidence, never as a silent subtraction from sales.
    const returnOrders = orders.filter((row) => row.returnEvents.some((event) => event.eventType === 'return_refund'));
    // A positive Business Insights return cannot be reconstructed from the
    // exceptional-case file's "total refund" column: Shopee does not document
    // it as the same sales basis. Zero requires no monetary allocation.
    const reconstructedReturns = officialReturned === 0 && official?.returnedOrderCount === 0 ? 0 : null;
    const reconstructedNet = reconstructedReturns == null ? null : grossCents - cancelledCents;
    // Order All periods are creation-date windows, not payment-date windows.
    // Reconciliation requires a creation-date source covering the day, plus
    // the exact BI amount/count checks below. Known paid-on-day carry-over
    // orders must also retain their prior-period source; no fixed lag is assumed.
    const sourceCoverageComplete = Boolean(official) && orderCreationSources.length > 0
      && missingCarryOverSourceHashes.length === 0;
    const salesBatch = stage({
      officialAmountCents: officialGross,
      reconstructedAmountCents: grossCents,
      officialOrderCount: official?.orderCount ?? null,
      reconstructedOrderCount: orders.length,
      complete: sourceCoverageComplete,
      metric: 'ยอดขาย (คำสั่งซื้อที่ได้รับการยืนยัน)',
      dateBasis: 'เวลาการชำระสินค้า (Asia/Bangkok)',
    });
    const creditNotes = stage({
      officialAmountCents: officialCancelled,
      reconstructedAmountCents: cancelledCents,
      officialOrderCount: official?.cancelledOrderCount ?? null,
      reconstructedOrderCount: cancelled.length,
      complete: sourceCoverageComplete && officialCancelled != null && official?.cancelledOrderCount != null,
      metric: 'ยอดขายที่ยกเลิก',
      dateBasis: 'เวลาการชำระสินค้าของรายการขายเดิม; สถานะล่าสุดกำหนดยอดยกเลิก',
    });
    const returns = stage({
      officialAmountCents: officialReturned,
      reconstructedAmountCents: reconstructedReturns,
      officialOrderCount: official?.returnedOrderCount ?? null,
      reconstructedOrderCount: reconstructedReturns == null ? (returnCoverageSources.length ? returnOrders.length : null) : 0,
      complete: sourceCoverageComplete && officialReturned != null && official?.returnedOrderCount != null,
      metric: 'ยอดขายที่คืนเงิน/คืนสินค้า',
      dateBasis: 'เวลาการชำระสินค้าของรายการขายเดิม; หลักฐานคืนเงินเก็บเป็นเหตุการณ์แยก',
    });
    const confirmedNet = stage({
      officialAmountCents: officialNet,
      reconstructedAmountCents: reconstructedNet,
      officialOrderCount: official && official.cancelledOrderCount != null
        ? official.orderCount - official.cancelledOrderCount - (official.returnedOrderCount || 0) : null,
      reconstructedOrderCount: reconstructedNet == null ? null : orders.length - cancelled.length,
      complete: sourceCoverageComplete && officialNet != null,
      metric: 'ยอดขายยืนยันแล้วสุทธิหลังยกเลิกและคืนเงิน/คืนสินค้า',
      dateBasis: 'เวลาการชำระสินค้าของรายการขายเดิม',
    });
    const unresolved = [];
    if (!official) unresolved.push({ reasonCode: 'missing_business_insights_day', message: 'ขาด Business Insights ของวันนี้', orderNumbers: [] });
    if (!orderCreationSources.length) unresolved.push({
      reasonCode: 'missing_order_all_creation_coverage',
      message: 'ขาดไฟล์ Order All ตามช่วงวันที่สร้างคำสั่งซื้อของวันนี้ จึงห้ามสรุปว่าประชากรออเดอร์ครบ',
      orderNumbers: [],
    });
    if (missingCarryOverSourceHashes.length) unresolved.push({
      reasonCode: 'missing_order_all_carry_over_source',
      message: 'มีออเดอร์ที่สร้างก่อนช่วงแต่ชำระในวันนี้ และขาดหลักฐาน Order All ของช่วงวันที่สร้างเดิม',
      orderNumbers: carryOverOrders.filter((row) => missingCarryOverSourceHashes
        .includes(row.basisEvidence.sourceSha256)).map((row) => row.orderNumber),
    });
    if (salesBatch.status === 'unresolved') unresolved.push({
      reasonCode: 'gross_snapshot_variance',
      message: 'ยอดรายออเดอร์จาก snapshot ที่มีอยู่ไม่ตรงกับยอดควบคุม; ห้ามกระจายส่วนต่างกลับเข้าออเดอร์โดยไม่มีหลักฐาน',
      orderNumbers: cancelled.map((row) => row.orderNumber),
    });
    const blockedVoucherEvidence = cancelled.filter((row) => [
      'source_not_enriched',
      'conflicting_voucher_code_snapshots',
      'missing_explicit_campaign_evidence',
      'ambiguous_campaign_evidence',
      'product_eligibility_not_proven',
      'fractional_satang_rule_unproven',
      'invalid_campaign_calculation',
      'payment_timestamp_missing',
    ].includes(row.sellerVoucherRestoration.status));
    if (salesBatch.status === 'unresolved' && blockedVoucherEvidence.length) unresolved.push({
      reasonCode: 'seller_voucher_restoration_not_proven',
      message: 'ไม่คืนส่วนลดผู้ขายจนกว่าจะมีทั้ง voucher code จาก bytes ต้นฉบับและหลักฐาน campaign ที่ใช้ได้กับออเดอร์',
      orderNumbers: blockedVoucherEvidence.map((row) => row.orderNumber),
    });
    if (officialReturned > 0 && reconstructedReturns == null) unresolved.push({
      reasonCode: 'return_amount_basis_unproven',
      message: 'มียอดคืนสินค้าใน Business Insights แต่ยังไม่มีหลักฐานว่าจำนวนเงินในไฟล์คืนเงินใช้ฐานยอดขายเดียวกัน',
      orderNumbers: orders.filter((row) => row.returnEvents.length).map((row) => row.orderNumber),
    });
    return {
      shopCode,
      date,
      status: [salesBatch, creditNotes, returns, confirmedNet].every((value) => value.status === 'reconciled')
        ? 'reconciled'
        : [salesBatch, creditNotes, returns, confirmedNet].some((value) => value.status === 'unresolved')
          ? 'unresolved' : 'incomplete',
      salesBatch,
      creditNotes,
      returns,
      confirmedNet,
      sellerVoucherRestoration: summarizeSellerVoucherRestoration(orders),
      unresolved,
      provenance: {
        businessInsights: official ? evidenceRef(official) : null,
        orderCreationSources: orderCreationSources.map(sourceEvidenceRef),
        orderCarryOverSources: orderCarryOverSources.map(sourceEvidenceRef),
        orderFactSources: [...new Map(orders.map((row) => [row.basisEvidence.sourceSha256, row.basisEvidence])).values()],
        returnSources: returnCoverageSources.map(sourceEvidenceRef),
      },
    };
  });
}

function monday(date) {
  const instant = new Date(`${date}T00:00:00Z`);
  const offset = (instant.getUTCDay() + 6) % 7;
  instant.setUTCDate(instant.getUTCDate() - offset);
  return instant.toISOString().slice(0, 10);
}

function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

function aggregateStage(rows, name) {
  const stages = rows.map((row) => row[name]);
  const sum = (field) => stages.every((value) => value[field] != null)
    ? stages.reduce((total, value) => total + cents(value[field], field), 0) : null;
  const count = (field) => stages.every((value) => value[field] != null)
    ? stages.reduce((total, value) => total + value[field], 0) : null;
  const officialAmountCents = sum('officialAmount');
  const reconstructedAmountCents = sum('reconstructedAmount');
  const result = stage({
    officialAmountCents,
    reconstructedAmountCents,
    officialOrderCount: count('officialOrderCount'),
    reconstructedOrderCount: count('reconstructedOrderCount'),
    complete: stages.every((value) => value.status !== 'incomplete'),
    metric: stages[0]?.metric,
    dateBasis: stages[0]?.dateBasis,
  });
  // Offsetting daily errors must not make a week/month look reconciled.
  if (!stages.every((value) => value.status === 'reconciled')) {
    result.status = stages.some((value) => value.status === 'unresolved') ? 'unresolved' : 'incomplete';
  }
  result.allContributingDaysReconciled = stages.every((value) => value.status === 'reconciled');
  return result;
}

function aggregateSellerVoucherRestoration(rows) {
  const orders = rows.flatMap((row) => row.sellerVoucherRestoration.orders);
  const campaigns = [...new Map(rows.flatMap((row) => row.sellerVoucherRestoration.campaigns)
    .map((campaign) => [`${campaign.voucherId}:${campaign.validFrom}`, campaign])).values()];
  return {
    basis: 'order_level_voucher_code_and_explicit_seller_centre_campaign_evidence',
    restoredAmount: sumMoney(orders, (row) => row.restoredAmount, 'restored seller voucher'),
    restoredOrderCount: orders.length,
    orderNumbers: orders.map((row) => row.orderNumber),
    campaigns,
    orders,
  };
}

function aggregateRows(daily, keyFrom, type) {
  return [...groupBy(daily, (row) => `${row.shopCode}:${keyFrom(row.date)}`).entries()].map(([key, rows]) => {
    const [, bucket] = key.split(':');
    const periodStart = type === 'week' ? bucket : `${bucket}-01`;
    const periodEnd = type === 'week' ? addDays(bucket, 6)
      : new Date(Date.UTC(Number(bucket.slice(0, 4)), Number(bucket.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const result = {
      shopCode: rows[0].shopCode,
      periodStart,
      periodEnd,
      coveredStartDate: rows[0].date,
      coveredEndDate: rows.at(-1).date,
      salesBatch: aggregateStage(rows, 'salesBatch'),
      creditNotes: aggregateStage(rows, 'creditNotes'),
      returns: aggregateStage(rows, 'returns'),
      confirmedNet: aggregateStage(rows, 'confirmedNet'),
      sellerVoucherRestoration: aggregateSellerVoucherRestoration(rows),
      unresolved: rows.flatMap((row) => row.unresolved.map((item) => ({ ...item, date: row.date }))),
    };
    result.status = [result.salesBatch, result.creditNotes, result.returns, result.confirmedNet]
      .every((value) => value.status === 'reconciled') ? 'reconciled'
      : [result.salesBatch, result.creditNotes, result.returns, result.confirmedNet]
        .some((value) => value.status === 'unresolved') ? 'unresolved' : 'incomplete';
    return result;
  }).sort((a, b) => a.shopCode.localeCompare(b.shopCode) || a.periodStart.localeCompare(b.periodStart));
}

function summarizePayout(orders) {
  const incomeFacts = orders.flatMap((row) => row.payout.income.facts);
  const latestIncome = orders.flatMap((row) => row.payout.income.latestState);
  return {
    metric: 'รายรับและเงินโอนจาก Shopee',
    comparisonRule: 'ไม่เปรียบให้เท่ากับยอดขาย; ใช้อธิบายค่าธรรมเนียม รายการปรับยอด และรอบโอนเท่านั้น',
    orderCount: orders.length,
    income: {
      // Pending and transferred are two lifecycle states. They remain separate
      // even when both snapshots contain the same order.
      pending: incomeStateSummary(incomeFacts.filter((row) => row.reportType === 'income-pending')),
      transferred: incomeStateSummary(incomeFacts.filter((row) => row.reportType === 'income-transferred')),
      latestState: {
        pending: incomeStateSummary(latestIncome.filter((row) => row.reportType === 'income-pending')),
        transferred: incomeStateSummary(latestIncome.filter((row) => row.reportType === 'income-transferred')),
      },
    },
    sellerBalanceLinkedOrderCount: orders.filter((row) => row.payout.sellerBalanceEvidence.length).length,
    sellerBalanceAmount: amount(orders.reduce((sum, row) => sum + cents(row.payout.sellerBalanceAmount, 'balance total'), 0)),
    missingIncomeOrderNumbers: orders.filter((row) => (
      row.payout.income.latestState.length === 0
    )).map((row) => row.orderNumber),
    missingSellerBalanceOrderNumbers: orders.filter((row) => !row.payout.sellerBalanceEvidence.length).map((row) => row.orderNumber),
  };
}

function periodRelationship(source, filters) {
  if (source.startDate === filters.startDate && source.endDate === filters.endDate) return 'exact';
  if (source.startDate <= filters.startDate && source.endDate >= filters.endDate) return 'contains_requested_period';
  if (source.endDate < filters.startDate) return 'before_requested_sales_period';
  if (source.startDate > filters.endDate) return 'after_requested_sales_period';
  return 'overlaps_requested_period';
}

function summarizeDownstreamControls(evidence, shopCode, filters) {
  const statements = (evidence.downstreamControls?.financialStatements || [])
    .filter((row) => row.shopCode === shopCode)
    .map((row) => ({
      periodStart: row.startDate,
      periodEnd: row.endDate,
      periodRelationship: periodRelationship(row, filters),
      transferredTotal: row.transferredTotal,
      pageCount: row.pageCount,
      evidence: sourceEvidenceRef(row),
    }));
  const sellerBalanceAdjustments = (evidence.downstreamControls?.sellerBalanceSources || [])
    .filter((row) => row.shopCode === shopCode)
    .map((row) => ({
      periodStart: row.startDate,
      periodEnd: row.endDate,
      periodRelationship: periodRelationship(row, filters),
      adjustmentAmount: row.control?.adjustmentTotal ?? null,
      adjustmentCount: row.control?.adjustmentCount ?? null,
      evidence: sourceEvidenceRef(row),
    }));
  const unlinkedSources = (evidence.downstreamControls?.unlinkedSources || [])
    .filter((row) => row.shopCode === shopCode)
    .map((row) => ({
      reportType: row.reportType,
      periodStart: row.startDate,
      periodEnd: row.endDate,
      periodRelationship: periodRelationship(row, filters),
      evidence: sourceEvidenceRef(row),
    }));
  return {
    status: statements.length && sellerBalanceAdjustments.length ? 'unresolved' : 'incomplete',
    comparisonRule: 'downstream_controls_are_not_compared_until_income_statement_and_balance_periods_are_exactly_linked',
    reasonCode: statements.length && sellerBalanceAdjustments.length
      ? 'downstream_period_linkage_not_proven' : 'missing_downstream_control_source',
    financialStatements: statements,
    sellerBalanceAdjustments,
    unlinkedSources,
  };
}

function buildFinancialReconciliation({ officialDaily, evidence, filters }) {
  const scope = requireShopeeShopScope(filters.shopCode);
  const shops = scope === 'all' ? SHOP_CODES : [scope];
  const dates = datesInRange(filters.startDate, filters.endDate);
  const orders = buildOrderLedger(evidence, filters).filter((row) => shops.includes(row.shopCode));
  const daily = shops.flatMap((shopCode) => dailyRowsForShop({
    shopCode,
    dates,
    officialRows: officialDaily,
    ledger: orders,
    orderSources: evidence.orderSources || [],
    returnSources: evidence.returnSources || [],
  }));
  const weekly = aggregateRows(daily, monday, 'week');
  const monthly = aggregateRows(daily, (date) => date.slice(0, 7), 'month');
  const shopResults = shops.map((shopCode) => {
    const shopDaily = daily.filter((row) => row.shopCode === shopCode);
    const shopOrders = orders.filter((row) => row.shopCode === shopCode);
    const period = {
      shopCode,
      periodStart: filters.startDate,
      periodEnd: filters.endDate,
      salesBatch: aggregateStage(shopDaily, 'salesBatch'),
      creditNotes: aggregateStage(shopDaily, 'creditNotes'),
      returns: aggregateStage(shopDaily, 'returns'),
      confirmedNet: aggregateStage(shopDaily, 'confirmedNet'),
      sellerVoucherRestoration: summarizeSellerVoucherRestoration(shopOrders),
    };
    period.status = [period.salesBatch, period.creditNotes, period.returns, period.confirmedNet]
      .every((value) => value.status === 'reconciled') ? 'reconciled'
      : [period.salesBatch, period.creditNotes, period.returns, period.confirmedNet]
        .some((value) => value.status === 'unresolved') ? 'unresolved' : 'incomplete';
    return {
      ...period,
      sourceCoverage: {
        businessInsightsCoveredDays: shopDaily.filter((row) => row.provenance.businessInsights).length,
        orderAllCreationCoveredDays: shopDaily.filter((row) => row.provenance.orderCreationSources.length).length,
        expectedDays: dates.length,
        orderSourceCount: new Set(shopDaily.flatMap((row) => [
          ...row.provenance.orderCreationSources,
          ...row.provenance.orderCarryOverSources,
        ])
          .map((row) => row.sourceSha256)).size,
        returnSourceCount: new Set(shopDaily.flatMap((row) => row.provenance.returnSources)
          .map((row) => row.sourceSha256)).size,
      },
      payoutBridge: summarizePayout(shopOrders),
      downstreamControls: summarizeDownstreamControls(evidence, shopCode, filters),
      unresolved: shopDaily.flatMap((row) => row.unresolved.map((item) => ({ ...item, date: row.date }))),
    };
  });
  return {
    version: 1,
    timezone: 'Asia/Bangkok',
    startDate: filters.startDate,
    endDate: filters.endDate,
    shopCode: scope,
    status: shopResults.every((shop) => shop.status === 'reconciled') ? 'reconciled'
      : shopResults.some((shop) => shop.status === 'unresolved') ? 'unresolved' : 'incomplete',
    dateBasis: {
      salesBatch: 'เวลาการชำระสินค้า',
      orderedAt: 'วันที่ทำการสั่งซื้อ (เก็บแยก ไม่ใช้จัดช่วง Business Insights)',
      payout: 'รอบรายงานการเงิน/เวลาโอน',
    },
    policy: {
      officialControl: 'Business Insights — ยอดขาย (คำสั่งซื้อที่ได้รับการยืนยัน)',
      salesBatchIncludesLaterCancellation: true,
      creditNoteIsSeparate: true,
      residualAllocation: 'forbidden_without_order_level_evidence',
      sellerVoucherRestoration: 'requires_exact_order_voucher_code_and_active_explicit_campaign_evidence',
      sellerVoucherDateBasis: 'paid_at_instant',
    },
    shops: shopResults,
    aggregates: { daily, weekly, monthly },
    orders,
  };
}

async function getShopeeFinancialReconciliation(filters) {
  const [officialDaily, evidence] = await Promise.all([
    listConfirmedSalesDays(filters),
    repository.listReconciliationEvidence(filters),
  ]);
  return buildFinancialReconciliation({ officialDaily, evidence, filters });
}

module.exports = {
  aggregateRows,
  bangkokDate,
  buildFinancialReconciliation,
  buildOrderLedger,
  getShopeeFinancialReconciliation,
};
