const MAX_AMOUNT = 10000000;
const VOID_PREFIX = /^Void\s*-\s*/i;
const invalid = message => Object.assign(new Error(message), { status: 400, code: 'INVALID_RECEIPT_VOID' });
const text = (value, limit = 255) => String(value ?? '').trim().slice(0, limit);
const cents = value => Math.sign(value) * Math.round(Math.abs(value) * 100);

// Older installed POS clients send Ada's original line AND its reversal. A
// negative line is not a returned sale: accept only an exact, preceding full
// item-removal pair, never just drop negatives or net unrelated SKUs together.
// Native Monitor financial literals exclude status 4/5. Legacy payloads lack
// that status, so require independent identity, quantity and amount evidence.
function normalizeReceiptItems(rawItems) {
  if (!Array.isArray(rawItems) || !rawItems.length || rawItems.length > 1000) {
    throw invalid('Receipt items are required (maximum 1000).');
  }
  const sourceItems = rawItems.map((item, index) => {
    if (!item || Array.isArray(item) || typeof item !== 'object') throw invalid('Invalid receipt line.');
    const qty = Number(item.qty), unitPrice = Number(item.unitPrice), lineTotal = Number(item.lineTotal);
    const lineDiscount = item.lineDiscount == null ? null : Number(item.lineDiscount);
    if (!Number.isFinite(qty) || qty === 0 || !Number.isFinite(unitPrice) || unitPrice < 0 ||
        !Number.isFinite(lineTotal) || Math.abs(lineTotal) > MAX_AMOUNT ||
        (qty > 0 && lineTotal < 0) || (qty < 0 && lineTotal > 0) ||
        (lineDiscount != null && (!Number.isFinite(lineDiscount) || Math.abs(lineDiscount) > MAX_AMOUNT))) {
      throw invalid('รายการสินค้าไม่สมบูรณ์ กรุณาโหลดบิลใหม่');
    }
    return {
      seq: Number.isSafeInteger(item.seq) && item.seq > 0 ? item.seq : index + 1,
      productCode: text(item.productCode), productName: text(item.productName),
      barcode: text(item.barcode, 128) || null,
      unitCode: text(item.unitCode, 50) || null, unitName: text(item.unitName, 100) || null,
      qty, unitPrice, lineTotal, lineDiscount,
      promotionCode: text(item.promotionCode) || null,
    };
  });
  const hasVoid = sourceItems.some(item => item.qty < 0);
  if (!hasVoid) return { items: rawItems, lineAdjustments: null };
  // Never establish identity by comparing truncated prefixes of distinct data.
  const limits = { productCode: 255, productName: 255, barcode: 128, unitCode: 50, unitName: 100, promotionCode: 255 };
  if (rawItems.some(item => Object.entries(limits).some(([field, limit]) => text(item[field], limit + 1).length > limit))) {
    throw invalid('ข้อมูลรายการ Void ยาวเกินรูปแบบที่รองรับ กรุณาตรวจบิลใน Ada');
  }
  if (sourceItems.some((item, index) => index > 0 && item.seq <= sourceItems[index - 1].seq)) {
    throw invalid('ลำดับรายการ Void ไม่สมบูรณ์ กรุณาโหลดบิลใหม่');
  }

  const remaining = [], pairs = [];
  for (const item of sourceItems) {
    if (item.qty > 0) { remaining.push(item); continue; }
    const name = item.productName.replace(VOID_PREFIX, '').trim();
    if (!VOID_PREFIX.test(item.productName) || !item.productCode || !name) {
      throw invalid('ไม่พบรายการต้นทางของ Void กรุณาตรวจบิลใน Ada');
    }
    const match = remaining.findLastIndex(original => original.productCode === item.productCode &&
      original.productName === name && original.barcode === item.barcode &&
      original.unitCode === item.unitCode && original.unitName === item.unitName &&
      original.unitPrice === item.unitPrice && original.qty === -item.qty &&
      cents(original.lineTotal) === -cents(item.lineTotal) &&
      Math.abs(cents(original.lineDiscount ?? 0)) === Math.abs(cents(item.lineDiscount ?? 0)) &&
      original.promotionCode === item.promotionCode);
    if (match < 0) throw invalid('รายการ Void ไม่ตรงกับสินค้าต้นทาง กรุณาตรวจบิลใน Ada');
    const [original] = remaining.splice(match, 1);
    pairs.push({ originalSeq: original.seq, voidSeq: item.seq });
  }
  if (!remaining.length) throw invalid('บิลนี้ยกเลิกสินค้าทั้งหมด ไม่มีรายการซื้อให้บันทึก');
  return {
    items: remaining,
    // Private receipt audit only; customer history continues to expose items
    // that were actually sold, while all whitelisted source lines remain here.
    lineAdjustments: { version: 1, policy: 'ada-exact-item-void-pairs', sourceItems, pairs },
  };
}

module.exports = { normalizeReceiptItems };
