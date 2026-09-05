const crypto = require("node:crypto");
const ExcelJS = require("exceljs");
const { PDFDocument } = require("pdf-lib");
const { badRequest } = require("../errors");

const SHOPS = [
  { code: "sc-drug-store", name: "SC Drug Store", seller: "142wuxqhgi" },
  { code: "dr-morepen", name: "DR.Morepen", seller: "mu3f314od9" },
];
const LABELS = {
  statement: "รายงานการเงิน",
  balance: "Seller Balance",
  income: "รายละเอียดรายรับของฉัน",
  orders: "คำสั่งซื้อทั้งหมด",
};
const hash = (buffer) =>
  crypto.createHash("sha256").update(buffer).digest("hex");
const day = (value) => {
  const result =
    value instanceof Date
      ? value.toISOString().slice(0, 10)
      : String(value || "").slice(0, 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(result) ||
    Number.isNaN(Date.parse(result)) ||
    new Date(result).toISOString().slice(0, 10) !== result
  ) {
    throw badRequest("วันที่ในเอกสารไม่ถูกต้อง");
  }
  return result;
};
const shift = (value, days) =>
  new Date(Date.parse(day(value)) + days * 86400000).toISOString().slice(0, 10);
const weekStart = (value) =>
  shift(value, -((new Date(value).getUTCDay() + 6) % 7));
const compact = (value) =>
  day(value.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"));
const text = (cell) => cell?.text?.trim() || "";
function filenameOf(file) {
  let name = String(file.originalname || "");
  if (!/[\u0e00-\u0e7f]/.test(name) && /[\u0080-\u00ff]/.test(name)) {
    const decoded = Buffer.from(name, "latin1").toString("utf8");
    if (!decoded.includes("\ufffd")) name = decoded;
  }
  return name.split(/[\\/]/).pop();
}
async function pdfText(buffer) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: false,
  });
  const pdf = await task.promise;
  try {
    const page = await pdf.getPage(1);
    return (await page.getTextContent()).items
      .map((item) => item.str || "")
      .join(" ");
  } finally {
    await task.destroy();
  }
}
async function inspectPdf(buffer) {
  const pdf = await PDFDocument.load(buffer);
  if (!pdf.getPageCount()) throw badRequest("PDF ไม่มีหน้าเอกสาร");
  const sizes = [
    ...new Set(
      pdf.getPages().map((page) => {
        const size = page.getSize();
        return [Math.round(size.width), Math.round(size.height)]
          .sort((a, b) => a - b)
          .join("x");
      }),
    ),
  ];
  return {
    pageCount: pdf.getPageCount(),
    isA4Landscape: pdf.getPages().every(page => {
      const {width,height}=page.getSize();
      return Math.abs(width-841.89)<2 && Math.abs(height-595.28)<2;
    }),
    warnings: sizes.some((size) => size !== "595x842")
      ? ["ขนาดหน้าต้นฉบับไม่ใช่ A4 ทั้งหมด ระบบจะย่อ/ขยายแต่ละหน้าให้พอดี A4"]
      : [],
  };
}
function requireCell(sheet, ref, expected) {
  if (!sheet || text(sheet.getCell(ref)) !== expected)
    throw badRequest("โครงสร้างหัวตารางไม่ตรงกับรายงาน Shopee: " + ref);
}
function namedPeriod(filename) {
  const match = /(\d{8})_(\d{8})(?:\s*\(\d+\))?\.xlsx$/i.exec(filename);
  if (!match) throw badRequest("อ่านช่วงวันที่จากชื่อไฟล์ไม่ได้: " + filename);
  return [compact(match[1]), compact(match[2])];
}
async function inspectOriginal(file, shop) {
  const filename = filenameOf(file);
  const base = {
    filename,
    shopCode: shop.code,
    shop: shop.name,
    checksumSha256: hash(file.buffer),
    size: file.buffer.length,
  };
  if (/^weekly_report_\d{8}(?:\s*\(\d+\))?\.pdf$/i.test(filename)) {
    const contents = await pdfText(file.buffer);
    if (!contents.includes(shop.seller))
      throw badRequest("รายงานการเงินอยู่ผิดร้าน: " + filename);
    const dates = contents.match(/\b20\d{2}-\d{2}-\d{2}\b/g);
    if (!dates || dates.length < 2)
      throw badRequest("อ่านรอบบัญชีจาก PDF ไม่ได้: " + filename);
    return {
      ...base,
      kind: "statement",
      start: day(dates[0]),
      end: day(dates[1]),
      ...(await inspectPdf(file.buffer)),
    };
  }
  const [start, end] = namedPeriod(filename);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(file.buffer);
  } catch {
    throw badRequest("อ่าน Excel ไม่ได้: " + filename);
  }
  if (/^Income\..+\.th\./i.test(filename)) {
    const sheet = workbook.getWorksheet("Income");
    requireCell(sheet, "B6", "หมายเลขคำสั่งซื้อ");
    requireCell(sheet, "E6", "วันที่ทำการสั่งซื้อ");
    requireCell(sheet, "K6", "วันที่โอนชำระเงินสำเร็จ");
    if (text(sheet.getCell("A2")) !== shop.seller)
      throw badRequest("รายรับอยู่ผิดร้าน: " + filename);
    if (
      day(sheet.getCell("B2").value) !== start ||
      day(sheet.getCell("C2").value) !== end
    )
      throw badRequest("วันที่ในรายรับไม่ตรงชื่อไฟล์: " + filename);
    const orders = [];
    for (let row = 7; row <= sheet.rowCount; row++) {
      const id = text(sheet.getCell(row, 2));
      if (!id) continue;
      const created = day(sheet.getCell(row, 5).value);
      const paid = day(sheet.getCell(row, 11).value);
      if (paid < start || paid > end)
        throw badRequest("มีรายรับนอกช่วงวันที่: " + filename);
      orders.push({ id, created });
    }
    return { ...base, kind: "income", start, end, orders };
  }
  if (/^my_balance_transaction_report\.shopee\./i.test(filename)) {
    const sheet = workbook.worksheets[0];
    requireCell(sheet, "A6", "ชื่อผู้ใช้ของผู้ขาย");
    if (text(sheet.getCell("B6")) !== shop.seller)
      throw badRequest("Seller Balance อยู่ผิดร้าน: " + filename);
    if (
      day(sheet.getCell("B7").value) !== start ||
      day(sheet.getCell("B8").value) !== end
    )
      throw badRequest("วันที่ Seller Balance ไม่ตรงชื่อไฟล์: " + filename);
    return { ...base, kind: "balance", start, end };
  }
  if (/^Order\.all\./i.test(filename)) {
    const sheet = workbook.getWorksheet("orders");
    requireCell(sheet, "A1", "หมายเลขคำสั่งซื้อ");
    requireCell(sheet, "G1", "วันที่ทำการสั่งซื้อ");
    const orders = [];
    for (let row = 2; row <= sheet.rowCount; row++) {
      const id = text(sheet.getCell(row, 1));
      if (!id) continue;
      const created = day(sheet.getCell(row, 7).value);
      if (created < start || created > end)
        throw badRequest("คำสั่งซื้อมีวันสร้างอยู่นอกชื่อไฟล์: " + filename);
      orders.push({ id, created });
    }
    return { ...base, kind: "orders", start, end, orders };
  }
  throw badRequest("ไม่ใช่ไฟล์ต้นฉบับ Shopee ที่รองรับ: " + filename);
}

function arrangeManifest(documents) {
  const items = [];
  const shops = [];
  const checksums = new Set();
  let commonPeriods;
  for (const shop of SHOPS) {
    const docs = documents.filter((doc) => doc.shopCode === shop.code);
    if (!docs.length) continue;
    const keys = new Set();
    for (const doc of docs) {
      const key = [doc.kind, doc.start, doc.end].join(":");
      if (keys.has(key) || checksums.has(doc.checksumSha256))
        throw badRequest("พบไฟล์ซ้ำหรือไฟล์เดียวกันในสองร้าน: " + doc.filename);
      keys.add(key);
      checksums.add(doc.checksumSha256);
      if (weekStart(doc.start) !== doc.start || shift(doc.start, 6) !== doc.end)
        throw badRequest(
          "รายงานต้องเป็นรอบวันจันทร์ถึงอาทิตย์: " + doc.filename,
        );
    }
    const statements = docs
      .filter((doc) => doc.kind === "statement")
      .sort((a, b) => a.start.localeCompare(b.start));
    if (!statements.length)
      throw badRequest("ร้าน " + shop.name + " ไม่มีรายงานการเงิน");
    const periods = statements.map((doc) => [doc.start, doc.end]);
    if (
      commonPeriods &&
      JSON.stringify(commonPeriods) !== JSON.stringify(periods)
    )
      throw badRequest("รอบรายงานการเงินของสองร้านไม่ตรงกัน");
    commonPeriods = periods;
    statements.forEach((doc, index) => {
      if (index && shift(statements[index - 1].end, 1) !== doc.start)
        throw badRequest("ขาดรายงานการเงินบางสัปดาห์");
    });
    const used = new Set();
    const orderFiles = docs.filter((doc) => doc.kind === "orders");
    const orderMap = new Map();
    for (const doc of orderFiles)
      for (const order of doc.orders || []) {
        const previous = orderMap.get(order.id);
        if (previous && previous.doc !== doc)
          throw badRequest("คำสั่งซื้อซ้ำข้ามไฟล์: " + order.id);
        orderMap.set(order.id, { doc, created: order.created });
      }
    let covered = 0;
    const linked = new Map(orderFiles.map((doc) => [doc, new Set()]));
    const missingWeeks = new Set();
    const missingOrders = [];
    for (const income of docs.filter((doc) => doc.kind === "income"))
      for (const order of income.orders || []) {
        const match = orderMap.get(order.id);
        if (!match) {
          missingWeeks.add(weekStart(order.created));
          missingOrders.push(order.id);
        } else {
          if (match.created !== order.created)
            throw badRequest("วันสร้างคำสั่งซื้อไม่ตรงกับ Income: " + order.id);
          linked.get(match.doc).add(income.start);
          covered++;
        }
      }
    if (missingOrders.length)
      throw badRequest(
        "คำสั่งซื้อไม่ครบสำหรับ " +
          shop.name +
          " ต้องเพิ่มไฟล์คำสั่งซื้อช่วง " +
          [...missingWeeks]
            .sort()
            .map((start) => start + " ถึง " + shift(start, 6))
            .join(", "),
        {
          missingOrderCount: missingOrders.length,
          missingOrders,
          missingWeeks: [...missingWeeks].sort(),
        },
      );
    const push = (doc, periodStart) => {
      used.add(doc);
      const { orders, ...metadata } = doc;
      items.push({
        ...metadata,
        sequence: items.length + 1,
        periodStart,
        periodEnd: shift(periodStart, 6),
        documentType: LABELS[doc.kind],
        carryOver: doc.kind === "orders" && doc.start < periods[0][0],
        relatedPeriods: [...(linked.get(doc) || [])].sort(),
        orderCount: orders
          ? new Set(orders.map((row) => row.id)).size
          : undefined,
      });
    };
    for (const statement of statements) {
      push(statement, statement.start);
      for (const kind of ["balance", "income"]) {
        const match = docs.find(
          (doc) =>
            doc.kind === kind &&
            doc.start === statement.start &&
            doc.end === statement.end,
        );
        if (!match)
          throw badRequest(
            "ขาด " +
              LABELS[kind] +
              " ของ " +
              shop.name +
              " รอบ " +
              statement.start,
          );
        push(match, statement.start);
      }
      // A carry-over source is printed once at the first accounting week that uses it.
      const carry = orderFiles.filter(
        (doc) =>
          !used.has(doc) &&
          doc.start < periods[0][0] &&
          [...linked.get(doc)].sort()[0] === statement.start,
      );
      carry
        .sort((a, b) => a.start.localeCompare(b.start))
        .forEach((doc) => push(doc, statement.start));
      const main = orderFiles.find(
        (doc) => doc.start === statement.start && doc.end === statement.end,
      );
      if (!main)
        throw badRequest(
          "ขาดคำสั่งซื้อรอบหลัก " + shop.name + " " + statement.start,
        );
      push(main, statement.start);
    }
    if (used.size !== docs.length)
      throw badRequest(
        "มีไฟล์ที่ไม่เกี่ยวข้องกับรอบบัญชี: " +
          docs
            .filter((doc) => !used.has(doc))
            .map((doc) => doc.filename)
            .join(", "),
      );
    shops.push({
      code: shop.code,
      name: shop.name,
      total: docs.length,
      incomeOrdersCovered: covered,
      periodCount: periods.length,
    });
  }
  if (!items.length) throw badRequest("กรุณาเลือกไฟล์ต้นฉบับ");
  return {
    version: 1,
    shops,
    periodStart: commonPeriods[0][0],
    periodEnd: commonPeriods.at(-1)[1],
    fileCount: items.length,
    items,
    fingerprint: hash(
      JSON.stringify(
        items.map(({ shopCode, kind, start, end, checksumSha256 }) => ({
          shopCode,
          kind,
          start,
          end,
          checksumSha256,
        })),
      ),
    ),
  };
}
async function parseOriginalFiles(files) {
  if (!Array.isArray(files) || !files.length || files.length > 100)
    throw badRequest("เลือกไฟล์ 1–100 ไฟล์");
  if (
    files.reduce((sum, file) => sum + file.buffer.length, 0) >
    100 * 1024 * 1024
  )
    throw badRequest("ชุดงานต้องไม่เกิน 100 MB");
  const docs = [];
  for (const file of files) {
    const shop = SHOPS.find((shop) => shop.code === file.fieldname);
    if (!shop) throw badRequest("ไม่พบร้านค้าที่เลือกให้ไฟล์");
    docs.push(await inspectOriginal(file, shop));
  }
  // Order exports contain buyer details but no reliable seller identifier. The user assigns
  // their shop through separate upload controls; income coverage detects swapped complete sets.
  return arrangeManifest(docs);
}
module.exports = {
  SHOPS,
  LABELS,
  hash,
  day,
  shift,
  inspectPdf,
  inspectOriginal,
  arrangeManifest,
  parseOriginalFiles,
  filenameOf,
};
