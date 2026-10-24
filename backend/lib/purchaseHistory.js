function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function amount(value, name) {
  const number = Number(value);
  if (value == null || !Number.isFinite(number) || number < 0 || number > 10000000) {
    throw invalid(`Invalid ${name}.`);
  }
  return Math.round(number * 100) / 100;
}

function text(value, maximum = 255) {
  return String(value || '').trim().slice(0, maximum);
}

// Called after receiptEligibleAmount validates every line. The original
// totalAmount field continues to mean eligible spend for older clients.
function buildReceiptSnapshot(body, items) {
  const itemTotal = Math.round(items.reduce((sum, item) => sum + Number(item.lineTotal), 0) * 100) / 100;
  const explicitTotal = body.receiptTotalAmount != null;
  return {
    version: 1,
    totalAmount: explicitTotal ? amount(body.receiptTotalAmount, 'receiptTotalAmount') : amount(itemTotal, 'receipt line total'),
    totalAmountSource: explicitTotal ? 'pos_header' : 'item_sum',
    receiptDiscount: body.receiptDiscount == null ? null : amount(body.receiptDiscount, 'receiptDiscount'),
    posCode: text(body.posCode, 50) || null,
    receiptCashierCode: text(body.receiptCashierCode) || null,
    items: items.map((item, index) => ({
      seq: Number.isSafeInteger(item.seq) && item.seq > 0 ? item.seq : index + 1,
      productCode: text(item.productCode), productName: text(item.productName),
      barcode: text(item.barcode, 128) || null,
      unitCode: text(item.unitCode, 50) || null, unitName: text(item.unitName, 100) || null,
      qty: Number(item.qty), unitPrice: Number(item.unitPrice), lineTotal: Number(item.lineTotal),
      lineDiscount: item.lineDiscount == null ? null : amount(item.lineDiscount, 'lineDiscount'),
      promotionCode: text(item.promotionCode) || null,
    })),
  };
}

function validCursorDate(value) {
  return typeof value === 'string' && value.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function parseHistoryCursor(raw) {
  if (!raw) return null;
  try {
    if (typeof raw !== 'string' || raw.length > 2048) throw Error();
    const cursor = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (cursor.v !== 1 || typeof cursor.id !== 'string' || !cursor.id || cursor.id.length > 255 ||
        !validCursorDate(cursor.soldAt) || !validCursorDate(cursor.createdAt)) throw Error();
    return cursor;
  } catch {
    throw invalid('Invalid history cursor.');
  }
}

function makeHistoryCursor(row) {
  // SQL ::text preserves PostgreSQL microseconds; JS Date would round them.
  return Buffer.from(JSON.stringify({
    v: 1, id: row.id, soldAt: row.sort_sold_at, createdAt: row.sort_created_at,
  })).toString('base64url');
}

function mapPurchase(claim, storedItems, returns) {
  const snapshot = claim.receipt_snapshot;
  const items = Array.isArray(snapshot?.items) ? snapshot.items : storedItems;
  const hasStoredTotal = claim.receipt_total_amount != null;
  const fallback = items.length
    ? Math.round(items.reduce((sum, item) => sum + Number(item.lineTotal), 0) * 100) / 100
    : Number(claim.total_amount || 0);
  return {
    claimId: claim.id, receiptNo: claim.receipt_no, branchCode: claim.branch_code,
    ...(snapshot?.documentType ? { documentType: snapshot.documentType } : {}),
    soldAt: claim.sold_at || claim.created_at,
    totalAmount: hasStoredTotal ? Number(claim.receipt_total_amount) : fallback,
    eligibleAmount: Number(claim.total_amount || 0),
    totalAmountSource: snapshot?.totalAmountSource || (hasStoredTotal ? 'pos_header' : items.length ? 'item_sum' : 'legacy_claim'),
    receiptDiscount: snapshot?.receiptDiscount ?? null,
    posCode: snapshot?.posCode || null, receiptCashierCode: snapshot?.receiptCashierCode || null,
    cashierStaffCode: claim.cashier_staff_code || null,
    awardedPoints: Number(claim.awarded_points || 0), items, returns,
  };
}

module.exports = { buildReceiptSnapshot, parseHistoryCursor, makeHistoryCursor, mapPurchase };
