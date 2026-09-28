const { moneyCents } = require('./shopeeSalesAccounting');
const { enrichShopeeOrderItems } = require('./shopeeProductMatcher');
const rules = require('../data/shopeeAdaSmartCopyRules.v1.json');
const { selectCopyCohort } = require('./shopeeCopyBusinessDate');
const { applyCopyLineEvidence } = require('./shopeeCopyLineEvidence');

const masters = new Map(rules.masters.map(row => [row.companySku, row]));
const UNIT_LABELS = { bar: 'ก้อน', blister: 'แผง', box: 'กล่อง', can: 'กระป๋อง', jar: 'กระปุก',
  pack: 'แพ็ก', piece: 'ชิ้น', sachet: 'ซอง' };
const safeCode = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(value);
const priceText = cents => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

function resolveCopyProduct(shopCode, item) {
  const override = rules.rules.find(row => row.shopCode === shopCode
    && row.productName === item.name && row.variant === (item.variant || ''));
  const originalMatch = item.productMatch;
  // Component identity and quantity can be verified independently of price.
  // Keep the owner's bundle price review in place until a separate allocation
  // rule is approved; never assign the whole price to each component.
  if (override?.components) {
    const components = override.components.map(row => {
      const master = masters.get(row.companySku);
      return { sku: row.companySku, factor: row.quantityPerSale, unit: master?.unit, name: master?.name };
    });
    if (!components.length || components.some(row => !safeCode(row.sku) || !row.unit
      || !Number.isSafeInteger(row.factor) || row.factor < 1)) {
      return { reason: 'หลักฐาน SKU หรือจำนวนส่วนประกอบ Bundle ไม่ครบ' };
    }
    return { components, authority: override.authority, originalMatch,
      reason: `Bundle จับคู่แล้ว (${components.map(row => `${row.sku} ×${row.factor}`).join(' + ')}) ยังต้องตรวจสอบราคาแยกแต่ละสินค้า` };
  }
  let sku = override?.companySku || originalMatch?.companySku;
  let factor = override?.quantityPerSale || originalMatch?.quantityPerSale || 1;
  if (!override && originalMatch?.status === 'bundle') {
    const components = originalMatch.components || [];
    const skus = [...new Set(components.map(row => row.companySku))];
    if (originalMatch.quantityRuleStatus !== 'verified' || skus.length !== 1 || !skus[0]) {
      return { reason: 'Bundle หลาย SKU ยังไม่มีราคาที่ระบุแยกแต่ละสินค้า' };
    }
    sku = skus[0];
    factor = components.reduce((sum, row) => sum + row.quantityPerSale, 0);
  } else if (!override && originalMatch?.status !== 'matched') {
    return { reason: 'ยังจับคู่รหัส IC/SKU ไม่สำเร็จ' };
  }
  if (!safeCode(sku)) return { reason: 'รหัส IC/SKU ไม่ถูกต้อง' };
  const master = masters.get(sku);
  if (!master) return { sku, reason: 'ยังไม่มีหลักฐานหน่วยฐานของ SKU นี้ใน ERP' };
  const unitReview = rules.unitReviews.find(row => row.companySku === sku && row.variant === item.variant);
  // An evidenced exact shop/product/variant correction resolves its old unit hold.
  // Keep the hold for other identities that happen to share the same SKU/variant.
  if (unitReview && !override) return { sku, reason: unitReview.reason };
  if (!Number.isSafeInteger(factor) || factor < 1 || (!override && (
    originalMatch.quantityRuleStatus === 'requires_validation'
    || (factor > 1 && originalMatch.quantityRuleStatus !== 'verified')
  ))) return { sku, reason: 'ยังไม่ยืนยันตัวคูณจำนวนสินค้าและหน่วยฐาน' };
  const unit = UNIT_LABELS[originalMatch?.quantityUnit] || originalMatch?.quantityUnit;
  const equivalent = rules.unitEquivalences.some(row => row.companySku === sku
    && row.sourceQuantityUnit === originalMatch?.quantityUnit && row.erpUnit === master.unit);
  if (!override && !equivalent && unit && unit !== master.unit) {
    return { sku, reason: `หน่วยชุดขาย ${unit} ยังไม่ตรงกับหน่วย ERP ${master.unit}` };
  }
  return { sku, factor, unit: master.unit, name: master.name,
    authority: override?.authority || 'existing_verified_catalog', originalMatch };
}

// Financial amounts stay tied to their source line. Old immutable imports have
// unit prices but no net-sale column per item: use them only when their exact
// total equals the recorded order subtotal and no order discount needs splitting.
function resolveLineAmounts(order) {
  const merchandise = moneyCents(order.itemSubtotal);
  const support = moneyCents(order.shopeeProductDiscount);
  const seller = moneyCents(order.sellerVoucher);
  if ([merchandise, support, seller].some(value => value == null) || seller > merchandise) {
    return { reason: 'องค์ประกอบค่าสินค้าของออเดอร์ไม่ครบหรือไม่ถูกต้อง' };
  }
  const items = order.items || [];
  if (!items.length) return { reason: 'ไม่มีรายการสินค้าในไฟล์คำสั่งซื้อ' };
  const orderTotal = merchandise - seller + support;
  if (!Number.isSafeInteger(orderTotal)) return { reason: 'ยอดเงินเกินความละเอียดที่รองรับ' };
  if (items.length === 1) return { merchandise, support, seller, orderTotal,
    amounts: [orderTotal], basis: 'single_source_product_order_components' };
  if (seller) return { merchandise, support, seller, orderTotal,
    reason: 'ส่วนลดผู้ขายของออเดอร์หลายสินค้า ยังไม่มีหลักฐานแยกแต่ละรายการ' };
  const financials = order.lineFinancials;
  if (Array.isArray(financials) && financials.length === items.length) {
    const net = financials.map(row => moneyCents(row.netSale));
    const discounts = financials.map(row => moneyCents(row.shopeeProductDiscount));
    if (net.every(value => value != null) && discounts.every(value => value != null)
      && net.reduce((sum, value) => sum + value, 0) === merchandise
      && discounts.reduce((sum, value) => sum + value, 0) === support) {
      return { merchandise, support, seller, orderTotal,
        amounts: net.map((value, index) => value + discounts[index]), basis: 'source_line_components' };
    }
    return { merchandise, support, seller, orderTotal, reason: 'ยอดรายสินค้าต้นทางไม่ตรงกับองค์ประกอบทั้งออเดอร์' };
  }
  if (support) return { merchandise, support, seller, orderTotal,
    reason: 'ส่วนลดสินค้าที่ Shopee สนับสนุน ยังไม่มีหลักฐานแยกแต่ละสินค้าในออเดอร์' };
  const amounts = items.map(item => {
    const cents = moneyCents(item.unitPrice);
    const value = cents == null ? null : cents * item.quantity;
    return Number.isSafeInteger(value) ? value : null;
  });
  if (amounts.some(value => value == null) || amounts.reduce((sum, value) => sum + value, 0) !== merchandise) {
    return { merchandise, support, seller, orderTotal,
      reason: 'ราคาต้นทางรายสินค้าไม่รวมเป็นค่าสินค้าทั้งออเดอร์ ต้องตรวจราคาขายสุทธิรายรายการ' };
  }
  return { merchandise, support, seller, orderTotal, amounts, basis: 'source_unit_prices_exact_subtotal' };
}

function buildAdaSmartCopyPlan(orders, confirmedSales, filters, businessDateCorrections = [], lineFinancialEvidence = []) {
  const { shopCode, startDate, endDate } = filters;
  const issues = [];
  const groups = new Map();
  const evidence = new Map();
  const keys = new Set();
  let merchandiseCents = 0; let supportCents = 0; let sellerCents = 0;
  let cohortCents = 0; let financialComplete = true; let sourceLineCount = 0;
  const addIssue = (reason, order, item, index, sku, components) => issues.push({ reason, sku: sku || null,
    ...(components?.length ? { components } : {}),
    orderNumber: order?.orderNumber || null, sourceRow: order?.sourceRows?.[index] || null,
    productName: item?.name || null, variant: item?.variant || null, listingQuantity: item?.quantity || null });
  if (shopCode === 'all' || startDate !== endDate) {
    addIssue('เลือกหนึ่งร้านและวันเดียวสำหรับคัดลอกเข้า AdaSmart');
  }
  const lineEvidence = applyCopyLineEvidence(orders, lineFinancialEvidence, filters);
  lineEvidence.issues.forEach(issue => addIssue(issue.reason, issue.order));
  const cohort = selectCopyCohort(lineEvidence.orders, businessDateCorrections, filters);
  cohort.issues.forEach(issue => addIssue(issue.reason, issue.order));
  for (const order of cohort.orders) {
    const key = `${order.shopCode}:${order.orderNumber}`;
    if (keys.has(key)) { addIssue('พบออเดอร์ซ้ำในกลุ่มที่ใช้คำนวณ', order); continue; }
    keys.add(key);
    const items = order.items || [];
    sourceLineCount += items.length;
    if (!/^[a-f0-9]{64}$/u.test(order.sourceSha256 || '') || !order.sourceFilename
      || !Number.isFinite(Date.parse(order.observedAt)) || Date.parse(order.paidAt) > Date.parse(order.observedAt)
      || order.sourceRows?.length !== items.length) {
      addIssue('หลักฐานไฟล์คำสั่งซื้อหรือแถวต้นทางไม่ครบ', order);
    }
    evidence.set(order.sourceSha256, { sourceFilename: order.sourceFilename,
      sourceSha256: order.sourceSha256, observedAt: order.observedAt });
    const money = resolveLineAmounts(order);
    if (money.orderTotal == null) financialComplete = false;
    else {
      cohortCents += money.orderTotal;
      merchandiseCents += money.merchandise; supportCents += money.support; sellerCents += money.seller;
    }
    if (money.reason) { addIssue(money.reason, order); continue; }
    items.forEach((item, index) => {
      if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) {
        addIssue('จำนวนสินค้าในไฟล์ไม่ถูกต้อง', order, item, index); return;
      }
      const product = resolveCopyProduct(shopCode, item);
      if (product.reason) { addIssue(product.reason, order, item, index, product.sku, product.components); return; }
      const quantity = item.quantity * product.factor;
      if (!Number.isSafeInteger(quantity)) { addIssue('จำนวนหน่วยเกินที่รองรับ', order, item, index); return; }
      const group = groups.get(product.sku) || { sku: product.sku, productName: product.name, unit: product.unit,
        quantity: 0, amountCents: 0, sources: [] };
      group.quantity += quantity; group.amountCents += money.amounts[index];
      group.sources.push({ orderNumber: order.orderNumber, sourceRow: order.sourceRows?.[index],
        sourceSha256: order.sourceSha256, listingQuantity: item.quantity, quantityPerSale: product.factor,
        productName: item.name, variant: item.variant, amountCents: money.amounts[index],
        priceBasis: money.basis, authority: product.authority, originalMatch: product.originalMatch,
        businessDate: order.copyBusinessDate, dateBasis: order.copyDateBasis,
        ...(order.copyDateCorrection ? { dateCorrectionCaseId: order.copyDateCorrection.evidence.caseId } : {}),
        ...(order.copyLineEvidenceCaseId ? { lineFinancialCaseId: order.copyLineEvidenceCaseId } : {}) });
      groups.set(product.sku, group);
    });
  }
  const rows = [];
  for (const group of [...groups.values()].sort((a, b) => a.sku.localeCompare(b.sku))) {
    if (!Number.isSafeInteger(group.quantity) || !Number.isSafeInteger(group.amountCents)) {
      addIssue('ยอดรวม SKU เกินที่รองรับ', null, null, null, group.sku); continue;
    }
    const low = Math.floor(group.amountCents / group.quantity);
    const highQuantity = group.amountCents % group.quantity;
    for (const [quantity, cents] of [[highQuantity, low + 1], [group.quantity - highQuantity, low]]) {
      if (quantity) rows.push({ sku: group.sku, productName: group.productName, unit: group.unit,
        quantity, unitPrice: priceText(cents), amountCents: quantity * cents,
        splitPrice: highQuantity > 0, sources: group.sources });
    }
  }
  const readyTotalCents = rows.reduce((sum, row) => sum + row.amountCents, 0);
  const targetCents = confirmedSales?.status === 'source_backed'
    ? moneyCents(confirmedSales.salesTotal) : null;
  if (targetCents == null || confirmedSales.startDate !== startDate || confirmedSales.endDate !== endDate
    || confirmedSales.shops?.length !== 1 || confirmedSales.shops[0].shopCode !== shopCode
    || !confirmedSales.shops[0].sources?.length) addIssue('Business Insights ของร้านและวันที่เลือกยังไม่ครบ');
  if (targetCents != null && (cohortCents !== targetCents || !financialComplete)) {
    addIssue('ค่าสินค้ารวมส่วนลดที่ Shopee สนับสนุน ยังไม่ตรงกับ Business Insights');
  }
  if (confirmedSales?.orderCount !== keys.size) addIssue('จำนวนออเดอร์ที่ใช้คำนวณไม่ตรงกับ Business Insights');
  if (![readyTotalCents, cohortCents, merchandiseCents, supportCents, sellerCents].every(Number.isSafeInteger)) {
    throw new Error('Copy-plan totals exceed supported precision.');
  }
  const ready = issues.length === 0 && financialComplete && targetCents === readyTotalCents;
  return { ...filters, timezone: 'Asia/Bangkok', dateBasis: cohort.corrections.length ? 'verified_business_date' : 'paid_at',
    businessDateCorrections: cohort.corrections, lineFinancialEvidence: lineEvidence.evidence, policyVersion: rules.policyVersion,
    status: ready ? 'ready' : 'review_required', orderCount: keys.size, sourceLineCount,
    skuCount: groups.size, rowCount: rows.length, totalQuantity: rows.reduce((sum, row) => sum + row.quantity, 0),
    merchandiseCents, supportCents, sellerCents, cohortTotalCents: financialComplete ? cohortCents : null,
    totalCents: readyTotalCents, targetCents, varianceCents: targetCents == null ? null : readyTotalCents - targetCents,
    rows, issues, confirmedSales, sourceEvidence: [...evidence.values()], masterEvidence: rules.masterEvidence,
    additionalMasterEvidence: rules.additionalMasterEvidence || [],
    columns: ready ? { sku: rows.map(row => row.sku).join('\n'),
      quantity: rows.map(row => String(row.quantity)).join('\n'),
      unitPrice: rows.map(row => row.unitPrice).join('\n') } : null };
}

async function getAdaSmartCopyPlan(filters) {
  const { getOrdersForCopyCohort } = require('../db/shopeeAdaSmartCopyRepository');
  const { getConfirmedSalesSummary } = require('./shopeeConfirmedSalesService');
  const [{ orders, businessDateCorrections, lineFinancialEvidence }, confirmed] = await Promise.all([getOrdersForCopyCohort(filters), getConfirmedSalesSummary(filters)]);
  const enriched = orders.map(order => ({ ...order, items: enrichShopeeOrderItems(order.shopCode, order.items) }));
  return buildAdaSmartCopyPlan(enriched, confirmed, filters, businessDateCorrections, lineFinancialEvidence);
}

module.exports = { buildAdaSmartCopyPlan, getAdaSmartCopyPlan, resolveCopyProduct, resolveLineAmounts };
