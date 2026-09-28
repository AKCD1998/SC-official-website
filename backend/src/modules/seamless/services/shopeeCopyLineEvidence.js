const { sourceFactFingerprint, localDate, validDate } = require('./shopeeCopyBusinessDate');

// This evidence supplements old immutable imports which retained an order-level
// Shopee amount but no exact line attribution. It cannot supply unrelated prices
// or bypass the existing sum-of-components checks in resolveLineAmounts.
function applyCopyLineEvidence(orders, records, filters) {
  const relevant = records.filter(r => r.shopCode === filters.shopCode && r.enabled !== false
    && [r.businessDate, r.paidBusinessDate].some(date => date >= filters.startDate && date <= filters.endDate));
  const byOrder = new Map(orders.filter(o => o.shopCode === filters.shopCode).map(o => [o.orderNumber,o]));
  const seen = new Set(); const issues = []; const audit = []; const financials = new Map();
  for (const record of relevant) {
    const order = byOrder.get(record.orderNumber);
    const valid = record.enabled === true && !seen.has(record.orderNumber) && order
      && validDate(record.businessDate) && validDate(record.paidBusinessDate)
      && localDate(order.paidAt) === record.paidBusinessDate
      && sourceFactFingerprint(order) === record.sourceFactFingerprint
      && Number.isFinite(Date.parse(record.verifiedAt)) && Boolean(record.verifiedBy)
      && record.evidence?.kind === 'daily_product_line_reconciliation' && Boolean(record.evidence.caseId)
      && record.evidence.sources?.some(s => s.reportType === 'shopee_confirmed_product_report'
        && s.date === record.businessDate && /^[a-f0-9]{64}$/u.test(s.sourceSha256 || '') && s.sourceFilename)
      && Array.isArray(record.lineFinancials) && record.lineFinancials.length === order.items.length;
    seen.add(record.orderNumber);
    if (!valid) issues.push({ reason:'หลักฐานแบ่งค่าสินค้ารายรายการไม่ครบหรือข้อมูลต้นทางเปลี่ยนแล้ว',
      order:order || { orderNumber:record.orderNumber } });
    else financials.set(record.orderNumber,record);
    audit.push({ ...record,applied:Boolean(valid),sourceSha256:order?.sourceSha256 || null });
  }
  return { orders:orders.map(order => {
    const record = order.shopCode === filters.shopCode && financials.get(order.orderNumber);
    return record ? { ...order,lineFinancials:record.lineFinancials,copyLineEvidenceCaseId:record.evidence.caseId } : order;
  }), issues, evidence:audit };
}

module.exports = { applyCopyLineEvidence };
