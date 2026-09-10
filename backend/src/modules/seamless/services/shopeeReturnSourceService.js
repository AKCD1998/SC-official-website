const { unzipSync } = require("fflate");
const XLSX = require("xlsx");
const {
  addDays,
  amount,
  cents,
  compactDate,
  exactColumns,
  excelRows,
  parseBangkokTimestamp,
  sourceBase,
  text,
  validateCompletedPeriod,
} = require("./shopeeOfficialDocumentService");

const MAX_ENTRY_COUNT = 12;
const MAX_ENTRY_BYTES = 40 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 80 * 1024 * 1024;
const ORDER_PATTERN = /^[A-Z0-9]{8,40}$/u;
const REQUEST_PATTERN = /^[A-Z0-9]{8,40}$/u;
const COMMON_HEADERS = Object.freeze({
  orderNumber: "หมายเลขคำสั่งซื้อ",
  orderStatus: "สถานะการสั่งซื้อ",
  orderedAt: "วันที่ทำการสั่งซื้อ",
  itemNetSales: "ราคาขายสุทธิ",
});
const CANCELLED_HEADERS = Object.freeze({
  ...COMMON_HEADERS,
  reason: "เหตุผลในการยกเลิกคำสั่งซื้อ",
  returnStatus: "สถานะการคืนเงินหรือคืนสินค้า",
});
const FAILED_DELIVERY_HEADERS = Object.freeze({
  ...COMMON_HEADERS,
  deliveryStatus: "จัดส่งไม่สำเร็จ",
});
const RETURN_HEADERS = Object.freeze({
  requestNumber: "หมายเลขคำขอคืนเงิน/คืนสินค้า",
  orderNumber: "หมายเลขคำสั่งซื้อ",
  orderedAt: "วันที่สร้างคำสั่งซื้อ",
  requestedAt: "เวลายื่นคำขอคืนเงิน/คืนสินค้า",
  returnStatus: "สถานะการคืนเงินหรือคืนสินค้า",
  returnType: "ประเภทการคืนสินค้า",
  reason: "เหตุผลในการขอคืนสินค้า",
  refundAmount: "จำนวนเงินคืนทั้งหมด",
});

function cleanReason(value) {
  const result = text(value)
    .replace(/<br\s*\/?>/giu, " ")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[redacted-email]")
    .replace(/(?<!\d)(?:\+?66|0)[\s-]?\d(?:[\s-]?\d){7,9}(?!\d)/gu, "[redacted-phone]")
    .replace(/\s+/gu, " ")
    .trim();
  if (result.length > 500) throw new Error("Shopee return reason exceeds the privacy-safe limit.");
  return result || null;
}

function assertOrderInPeriod(orderedAt, startDate, endDate) {
  const date = new Date(new Date(orderedAt).getTime() + 7 * 3600000).toISOString().slice(0, 10);
  if (date < startDate || date > endDate) throw new Error("Exceptional-case order is outside the source period.");
}

async function readXlsxRows(bytes) {
  const { rows } = await excelRows(Buffer.from(bytes), "orders");
  return rows;
}

function readXlsRows(bytes) {
  const workbook = XLSX.read(Buffer.from(bytes), {
    type: "buffer",
    raw: true,
    cellDates: false,
    cellFormula: false,
    sheetRows: 100001,
  });
  if (workbook.SheetNames.length !== 1) throw new Error("Return/refund XLS must contain exactly one worksheet.");
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  for (const [address, cell] of Object.entries(sheet)) {
    if (address[0] !== "!" && cell?.f) throw new Error("Formula cells are not supported in return/refund XLS.");
  }
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
  if (rows.length > 100000 || Math.max(0, ...rows.map((row) => row.length)) > 100) {
    throw new Error("Return/refund worksheet exceeds supported bounds.");
  }
  return rows;
}

function parseOrderExceptionRows(rows, {
  endDate,
  entryFilename,
  eventType,
  shopCode,
  startDate,
}) {
  const expectedHeaders = eventType === "cancelled" ? CANCELLED_HEADERS : FAILED_DELIVERY_HEADERS;
  const columns = exactColumns((rows[0] || []).map(text), expectedHeaders);
  const groups = new Map();
  for (const [offset, row] of rows.slice(1).entries()) {
    if (row.every((value) => !text(value))) continue;
    const sourceRow = offset + 2;
    const orderNumber = text(row[columns.orderNumber]).toUpperCase();
    if (!ORDER_PATTERN.test(orderNumber)) throw new Error(`Invalid exceptional-case order at row ${sourceRow}.`);
    const orderedAt = parseBangkokTimestamp(row[columns.orderedAt], "exceptional-case order date");
    assertOrderInPeriod(orderedAt, startDate, endDate);
    const status = eventType === "cancelled"
      ? text(row[columns.orderStatus])
      : text(row[columns.deliveryStatus]);
    if (!status) throw new Error("Exceptional-case status is missing.");
    const reason = eventType === "cancelled" ? cleanReason(row[columns.reason]) : null;
    const valueCents = cents(row[columns.itemNetSales], "exceptional-case net sales");
    if (valueCents < 0) throw new Error("Exceptional-case net sales must not be negative.");
    const existing = groups.get(orderNumber);
    if (!existing) {
      groups.set(orderNumber, {
        shopCode,
        eventKey: `${eventType}:${orderNumber}`,
        eventType,
        orderNumber,
        returnRequestNumber: null,
        orderedAt,
        eventAt: null,
        status,
        reason,
        amountLabel: "ราคาขายสุทธิ",
        amountCents: valueCents,
        entryFilename,
        sourceRows: [sourceRow],
      });
      continue;
    }
    if (existing.orderedAt !== orderedAt || existing.status !== status || existing.reason !== reason) {
      throw new Error(`Conflicting exceptional-case rows for ${orderNumber}.`);
    }
    existing.amountCents += valueCents;
    existing.sourceRows.push(sourceRow);
  }
  return [...groups.values()].map(({ amountCents, ...fact }) => ({ ...fact, amount: amount(amountCents) }));
}

function parseReturnRefundRows(rows, { endDate, entryFilename, shopCode, startDate }) {
  const columns = exactColumns((rows[0] || []).map(text), RETURN_HEADERS);
  const groups = new Map();
  for (const [offset, row] of rows.slice(1).entries()) {
    if (row.every((value) => !text(value))) continue;
    const sourceRow = offset + 2;
    const requestNumber = text(row[columns.requestNumber]).toUpperCase();
    const orderNumber = text(row[columns.orderNumber]).toUpperCase();
    if (!REQUEST_PATTERN.test(requestNumber) || !ORDER_PATTERN.test(orderNumber)) {
      throw new Error(`Invalid return/refund identity at row ${sourceRow}.`);
    }
    const orderedAt = parseBangkokTimestamp(row[columns.orderedAt], "return/refund order date");
    assertOrderInPeriod(orderedAt, startDate, endDate);
    const eventAt = parseBangkokTimestamp(row[columns.requestedAt], "return/refund request date");
    const status = text(row[columns.returnStatus]);
    if (!status) throw new Error("Return/refund status is missing.");
    const reason = cleanReason(row[columns.reason]);
    const refundCents = cents(row[columns.refundAmount], "total refund amount");
    if (refundCents < 0) throw new Error("Total refund amount must not be negative.");
    const key = `${requestNumber}:${orderNumber}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        shopCode,
        eventKey: `return_refund:${key}`,
        eventType: "return_refund",
        orderNumber,
        returnRequestNumber: requestNumber,
        orderedAt,
        eventAt,
        status,
        reason,
        returnType: text(row[columns.returnType]) || null,
        amountLabel: "จำนวนเงินคืนทั้งหมด",
        amountCents: refundCents,
        entryFilename,
        sourceRows: [sourceRow],
      });
      continue;
    }
    if (existing.orderedAt !== orderedAt || existing.eventAt !== eventAt || existing.status !== status
      || existing.amountCents !== refundCents) {
      throw new Error(`Conflicting return/refund rows for ${requestNumber}.`);
    }
    existing.sourceRows.push(sourceRow);
  }
  return [...groups.values()].map(({ amountCents, returnType, ...fact }) => ({
    ...fact,
    reason: [returnType, fact.reason].filter(Boolean).join(" — ").slice(0, 500) || null,
    amount: amount(amountCents),
  }));
}

function unzipShopeeReport(buffer) {
  let count = 0;
  let totalBytes = 0;
  const entries = unzipSync(new Uint8Array(buffer), {
    filter(file) {
      count += 1;
      if (count > MAX_ENTRY_COUNT || file.name.includes("/") || file.name.includes("\\")
        || file.name.startsWith(".") || file.originalSize < 1 || file.originalSize > MAX_ENTRY_BYTES) {
        throw new Error("Unsafe or unsupported exceptional-case ZIP entry.");
      }
      totalBytes += file.originalSize;
      if (totalBytes > MAX_UNCOMPRESSED_BYTES) throw new Error("Exceptional-case ZIP expands beyond the supported limit.");
      return true;
    },
  });
  const emptyArchive = Buffer.isBuffer(buffer)
    && buffer.length === 22
    && buffer.readUInt32LE(0) === 0x06054b50
    && buffer.subarray(4).every((byte) => byte === 0);
  if (!count && Object.keys(entries).length === 0 && emptyArchive) return entries;
  if (!count || Object.keys(entries).length !== count) throw new Error("Exceptional-case ZIP is empty or incomplete.");
  return entries;
}

function validateParts(partsByType) {
  for (const parts of partsByType.values()) {
    const expected = parts[0].partCount;
    if (parts.some((part) => part.partCount !== expected) || parts.length !== expected) {
      throw new Error("Exceptional-case ZIP part count is incomplete.");
    }
    const numbers = parts.map((part) => part.partNumber).sort((a, b) => a - b);
    if (numbers.some((number, index) => number !== index + 1)) throw new Error("Exceptional-case ZIP parts are not contiguous.");
  }
}

function mergePartFacts(facts) {
  const merged = new Map();
  for (const fact of facts) {
    const existing = merged.get(fact.eventKey);
    if (!existing) {
      merged.set(fact.eventKey, { ...fact, sourceRows: [...fact.sourceRows] });
      continue;
    }
    if (existing.eventType !== fact.eventType || existing.orderNumber !== fact.orderNumber
      || existing.orderedAt !== fact.orderedAt || existing.eventAt !== fact.eventAt
      || existing.status !== fact.status || existing.reason !== fact.reason
      || existing.amountLabel !== fact.amountLabel) {
      throw new Error(`Conflicting exceptional-case parts for ${fact.eventKey}.`);
    }
    if (fact.eventType === "return_refund") {
      if (cents(existing.amount, existing.amountLabel) !== cents(fact.amount, fact.amountLabel)) {
        throw new Error(`Conflicting return/refund amounts for ${fact.eventKey}.`);
      }
    } else {
      existing.amount = amount(cents(existing.amount, existing.amountLabel)
        + cents(fact.amount, fact.amountLabel));
    }
    existing.entryFilename = [...new Set([
      ...existing.entryFilename.split(";"),
      ...fact.entryFilename.split(";"),
    ])].sort().join(";");
    existing.sourceRows.push(...fact.sourceRows);
  }
  return [...merged.values()];
}

async function readReturnSourceBuffer(buffer, options) {
  const base = sourceBase({ buffer, ...options });
  const parent = /^Order\.return_refund_cancel\.(\d{8})_(\d{8})(?: ?\(\d+\))?\.zip$/iu.exec(base.sourceFilename);
  if (!parent) throw new Error("Expected original Order.return_refund_cancel ZIP filename.");
  const startDate = compactDate(parent[1]);
  const exclusiveEndDate = compactDate(parent[2]);
  const endDate = addDays(exclusiveEndDate, -1);
  validateCompletedPeriod(startDate, endDate, base.observedAt);
  if (addDays(startDate, 31) < exclusiveEndDate || exclusiveEndDate <= startDate) {
    throw new Error("Exceptional-case ZIP period is outside the supported range.");
  }
  const entries = unzipShopeeReport(buffer);
  const partsByType = new Map();
  for (const [entryFilename, bytes] of Object.entries(entries)) {
    const match = /^Order\.(cancelled|failed_delivery|return_refund)\.(\d{8})_(\d{8})_part_(\d+)_of_(\d+)\.(xlsx|xls)$/iu.exec(entryFilename);
    if (!match || compactDate(match[2]) !== startDate || compactDate(match[3]) !== exclusiveEndDate) {
      throw new Error("Unexpected exceptional-case ZIP filename or period.");
    }
    const eventType = match[1].toLowerCase();
    const expectedExtension = eventType === "return_refund" ? "xls" : "xlsx";
    if (match[6].toLowerCase() !== expectedExtension) throw new Error("Unexpected exceptional-case workbook format.");
    const part = { entryFilename, bytes, eventType, partNumber: Number(match[4]), partCount: Number(match[5]) };
    if (!Number.isSafeInteger(part.partNumber) || !Number.isSafeInteger(part.partCount)
      || part.partNumber < 1 || part.partNumber > part.partCount || part.partCount > MAX_ENTRY_COUNT) {
      throw new Error("Invalid exceptional-case ZIP part number.");
    }
    const values = partsByType.get(eventType) || [];
    values.push(part);
    partsByType.set(eventType, values);
  }
  validateParts(partsByType);
  const partFacts = [];
  for (const [eventType, parts] of [...partsByType.entries()].sort()) {
    for (const part of parts.sort((left, right) => left.partNumber - right.partNumber)) {
      const rows = eventType === "return_refund" ? readXlsRows(part.bytes) : await readXlsxRows(part.bytes);
      partFacts.push(...(eventType === "return_refund"
        ? parseReturnRefundRows(rows, { startDate, endDate, shopCode: base.shopCode, entryFilename: part.entryFilename })
        : parseOrderExceptionRows(rows, { startDate, endDate, shopCode: base.shopCode,
          entryFilename: part.entryFilename, eventType })));
    }
  }
  const facts = mergePartFacts(partFacts);
  const counts = Object.fromEntries(["cancelled", "failed_delivery", "return_refund"]
    .map((eventType) => [eventType, facts.filter((fact) => fact.eventType === eventType).length]));
  const amounts = Object.fromEntries(Object.keys(counts).map((eventType) => [eventType,
    facts.filter((fact) => fact.eventType === eventType)
      .reduce((sum, fact) => sum + cents(fact.amount, fact.amountLabel), 0) / 100]));
  return {
    ...base,
    reportType: "return-refund-cancel",
    startDate,
    endDate,
    control: { counts, amounts, entryFilenames: Object.keys(entries).sort() },
    facts,
  };
}

module.exports = {
  CANCELLED_HEADERS,
  FAILED_DELIVERY_HEADERS,
  RETURN_HEADERS,
  parseOrderExceptionRows,
  parseReturnRefundRows,
  mergePartFacts,
  readReturnSourceBuffer,
  unzipShopeeReport,
};
