const { moneyCents } = require('./shopeeSalesAccounting');

function resolveCopySellerVoucher(order, snapshots = [], campaigns = []) {
  if (moneyCents(order.sellerVoucher) !== 0 || !order.excluded) return {};
  const history = snapshots.filter(row => row.shopCode === order.shopCode && row.orderNumber === order.orderNumber)
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt)
      || a.sourceSha256.localeCompare(b.sourceSha256));
  if (!history.length) return {};
  const basis = history.find(row => row.paidAt != null);
  if (!basis) return {};
  const { sellerVoucherRestoration } = require('./shopeeFinancialReconciliationService');
  const restoration = sellerVoucherRestoration(history, basis, history.at(-1), campaigns);
  if (restoration.status !== 'restored_from_explicit_campaign_evidence') {
    // Existing cancelled sales without a seller code remain unchanged. A known
    // code must have an unambiguous campaign calculation before copying.
    if (['conflicting_voucher_code_snapshots', 'missing_explicit_campaign_evidence',
      'ambiguous_campaign_evidence', 'product_eligibility_not_proven', 'fractional_satang_rule_unproven',
      'invalid_campaign_calculation', 'payment_timestamp_missing'].includes(restoration.status)) {
      return { reason: 'หลักฐานคูปองร้านค้าของออเดอร์ที่ยกเลิกยังไม่ครบหรือขัดกัน', restoration };
    }
    return {};
  }
  // Never repair a changed price, payment date or product identity by a voucher.
  const sourceItems = row => JSON.stringify((row.items || []).map(item => [item.name, item.variant || '', item.quantity, item.unitPrice]));
  const latest = history.at(-1);
  if (latest.sourceSha256 !== order.sourceSha256 || !latest.excluded
    || Date.parse(basis.paidAt) !== Date.parse(order.paidAt)
    || moneyCents(basis.itemSubtotal) !== moneyCents(order.itemSubtotal)
    || moneyCents(basis.shopeeProductDiscount) !== moneyCents(order.shopeeProductDiscount)
    || sourceItems(basis) !== sourceItems(order)) {
    return { reason: 'ข้อมูลสินค้า เงิน หรือวันชำระเปลี่ยนจากหลักฐานคูปองร้านค้า ต้องตรวจสอบก่อน', restoration };
  }
  return { sellerCents: moneyCents(restoration.effectiveAmount), restoration };
}

module.exports = { resolveCopySellerVoucher };
