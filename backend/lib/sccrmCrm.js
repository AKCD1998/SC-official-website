const crypto = require("crypto");
const { createId, requireEnv } = require("./sccrm");

const CLAIM_TOKEN_TTL_SECONDS = 15 * 60;

function buildSourceEventKey(kind, branchCode, docNo) {
  return `${kind}:${String(branchCode || "").trim().toUpperCase()}:${String(docNo || "").trim().toUpperCase()}`;
}

function createClaimToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function hashClaimToken(token) {
  const secret = requireEnv("SCCRM_REFRESH_TOKEN_SECRET");
  return crypto.createHmac("sha256", secret).update(`claim:${token}`).digest("hex");
}

function claimTokenExpiryDate() {
  return new Date(Date.now() + CLAIM_TOKEN_TTL_SECONDS * 1000);
}

function normalizeText(value) {
  return String(value == null ? "" : value).trim();
}

function toNullableText(value) {
  const normalized = normalizeText(value);
  return normalized || null;
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function combineDateTime(docDate, docTime, fallbackIso = null) {
  const datePart = normalizeText(docDate);
  const timePart = normalizeText(docTime);
  if (!datePart && fallbackIso) return fallbackIso;
  if (!datePart) return null;
  const safeTime = timePart || "00:00:00";
  const candidate = `${datePart.slice(0, 10)}T${safeTime}`;
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) {
    return fallbackIso;
  }
  return parsed.toISOString();
}

function buildTenderRows(rows) {
  return Array.isArray(rows) ? rows : [];
}

function buildSaleLinePayload(line, index) {
  return {
    line_no: Number(line.line_no ?? line.lineNo ?? line.FNSdtSeqNo ?? index + 1),
    product_code: toNullableText(line.product_code ?? line.productCode ?? line.FTPdtCode),
    barcode: toNullableText(line.barcode ?? line.FTSdtBarCode ?? line.FTXidBarCode),
    qty: toNumber(line.qty ?? line.FCSdtQty ?? line.FCXidQty ?? 0),
    unit_code: toNullableText(line.unit_code ?? line.unitCode ?? line.FTPunCode),
    unit_name: toNullableText(line.unit_name ?? line.unitName ?? line.FTSdtUnitName ?? line.FTXidUnitName),
    net_amount: toNumber(line.net_amount ?? line.netAmount ?? line.FCSdtNet ?? line.FCXidNet ?? 0),
    discount_amount: toNumber(line.discount_amount ?? line.discountAmount ?? line.FCSdtDis ?? 0),
    lot_no: toNullableText(line.lot_no ?? line.lotNo ?? line.FTSdtLotNo ?? line.FTXidLotNo),
    expiry_date: toNullableText(line.expiry_date ?? line.expiryDate ?? line.FDSdtExpired ?? line.FDXidExpired),
    raw_payload: line,
  };
}

function buildRefundLinePayload(line, index) {
  return {
    line_no: Number(line.line_no ?? line.lineNo ?? line.FNSdtSeqNo ?? index + 1),
    product_code: toNullableText(line.product_code ?? line.productCode ?? line.FTPdtCode),
    qty: toNumber(line.qty ?? line.FCSdtQty ?? 0),
    net_amount: toNumber(line.net_amount ?? line.netAmount ?? line.FCSdtNet ?? 0),
    lot_no: toNullableText(line.lot_no ?? line.lotNo ?? line.FTSdtLotNo),
    expiry_date: toNullableText(line.expiry_date ?? line.expiryDate ?? line.FDSdtExpired),
    raw_payload: line,
  };
}

function buildSaleEventRecord(record) {
  const branchCode = normalizeText(record.branch_code ?? record.branchCode ?? record.FTBchCode).toUpperCase();
  const docNo = normalizeText(record.doc_no ?? record.docNo ?? record.FTShdDocNo).toUpperCase();
  return {
    id: createId(),
    branch_code: branchCode,
    pos_code: toNullableText(record.pos_code ?? record.posCode ?? record.FTPosCode),
    doc_no: docNo,
    doc_type: normalizeText((record.doc_type ?? record.docType ?? record.FTShdDocType) || "1"),
    sale_at: combineDateTime(record.doc_date ?? record.docDate ?? record.FDShdDocDate, record.doc_time ?? record.docTime ?? record.FTShdDocTime, record.paid_at ?? record.paidAt ?? new Date().toISOString()),
    cashier_code: toNullableText(record.cashier_code ?? record.cashierCode ?? record.FTUsrCode),
    gross_total: toNumber(record.gross_total ?? record.grossTotal ?? record.FCShdTotal),
    net_total: toNumber(record.net_total ?? record.netTotal ?? record.FCShdGrand ?? record.sale_grand_total ?? record.saleGrandTotal),
    paid_total: toNumber(record.paid_total ?? record.paidTotal ?? record.FCShdPaid ?? record.FCShdGrand ?? record.sale_grand_total ?? record.saleGrandTotal),
    ada_customer_code: toNullableText(record.customer_code ?? record.customerCode ?? record.FTCstCode),
    source_system: toNullableText(record.source_system ?? record.sourceSystem ?? "PaaSRTSM"),
    source_event_key: toNullableText(record.source_event_key ?? record.sourceEventKey) || buildSourceEventKey("sale", branchCode, docNo),
    source_synced_at: toNullableText(record.source_synced_at ?? record.sourceSyncedAt ?? new Date().toISOString()),
    tender_rows: buildTenderRows(record.tender_rows ?? record.tenderRows),
    raw_payload: record,
    line_rows: (record.line_rows ?? record.lineRows ?? []).map(buildSaleLinePayload),
  };
}

function buildRefundEventRecord(record) {
  const branchCode = normalizeText(record.branch_code ?? record.branchCode ?? record.FTBchCode).toUpperCase();
  const refundDocNo = normalizeText(record.refund_doc_no ?? record.refundDocNo ?? record.doc_no ?? record.docNo ?? record.FTShdDocNo).toUpperCase();
  return {
    id: createId(),
    branch_code: branchCode,
    pos_code: toNullableText(record.pos_code ?? record.posCode ?? record.FTPosCode),
    refund_doc_no: refundDocNo,
    original_doc_no: normalizeText(record.original_doc_no ?? record.originalDocNo ?? record.FTShdPosCN).toUpperCase(),
    refund_at: combineDateTime(record.doc_date ?? record.docDate ?? record.FDShdDocDate, record.doc_time ?? record.docTime ?? record.FTShdDocTime, new Date().toISOString()),
    cashier_code: toNullableText(record.cashier_code ?? record.cashierCode ?? record.FTUsrCode),
    refund_total: toNumber(record.refund_total ?? record.refundTotal ?? record.FCShdGrand),
    source_system: toNullableText(record.source_system ?? record.sourceSystem ?? "PaaSRTSM"),
    source_event_key: toNullableText(record.source_event_key ?? record.sourceEventKey) || buildSourceEventKey("refund", branchCode, refundDocNo),
    source_synced_at: toNullableText(record.source_synced_at ?? record.sourceSyncedAt ?? new Date().toISOString()),
    tender_rows: buildTenderRows(record.tender_rows ?? record.tenderRows),
    raw_payload: record,
    line_rows: (record.line_rows ?? record.lineRows ?? []).map(buildRefundLinePayload),
  };
}

module.exports = {
  CLAIM_TOKEN_TTL_SECONDS,
  buildSourceEventKey,
  buildSaleEventRecord,
  buildRefundEventRecord,
  claimTokenExpiryDate,
  createClaimToken,
  hashClaimToken,
  normalizeText,
  toNullableText,
  toNumber,
};
