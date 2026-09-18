const pool = require("../../../../db");
const { getTables } = require("../tables");
const { badRequest, conflict, notFound, serviceUnavailable } = require("../errors");
const fileStorage = require("./fileStorageService");
const {
  SHOPS,
  filenameOf,
  inspectOriginal,
} = require("./accountingOriginalManifest");

function sourceId(value) {
  if (!/^[a-f0-9-]{36}$/iu.test(String(value || ""))) {
    throw badRequest("รหัสไฟล์ต้นฉบับไม่ถูกต้อง");
  }
  return value;
}

function publicSource(row) {
  return {
    id: row.id,
    endDate: String(row.end_date).slice(0, 10),
    filename: row.source_filename,
    kind: row.document_kind,
    originalUrl: `/app/accounting-print-bundles/source-originals/${row.id}`,
    pageCount: row.page_count,
    periodType: row.period_type,
    shopCode: row.shop_code,
    startDate: String(row.start_date).slice(0, 10),
  };
}

function createService({
  db = pool,
  inspectSource = inspectOriginal,
  storage = fileStorage,
} = {}) {
  async function uploadSourceOriginals(files, shopCode, actor) {
    const shop = SHOPS.find((candidate) => candidate.code === shopCode);
    if (!shop) throw badRequest("ไม่พบร้านค้าที่เลือก");
    if (!Array.isArray(files) || !files.length || files.length > 20) {
      throw badRequest("เลือก PDF รายงานการเงิน 1–20 ไฟล์");
    }
    if (files.reduce((sum, file) => sum + Number(file.buffer?.length || 0), 0) > 100 * 1024 * 1024) {
      throw badRequest("ไฟล์ต้นฉบับรวมกันต้องไม่เกิน 100 MB");
    }

    const documents = [];
    for (const file of files) {
      const document = await inspectSource(file, shop);
      if (document.kind !== "statement" || !["weekly", "monthly"].includes(document.periodType)) {
        throw badRequest(`รองรับเฉพาะ PDF รายงานการเงินรายสัปดาห์หรือรายเดือน: ${filenameOf(file)}`);
      }
      documents.push({ document, file });
    }

    const storedDocuments = [];
    for (const { document, file } of documents) {
      const stored = await storage.writeStoredFile(
        "accounting_source_original",
        document.filename,
        file.buffer,
      );
      if (
        process.env.NODE_ENV === "production"
        && stored.storageProvider !== "r2"
        && process.env.SEAMLESS_ACCOUNTING_ALLOW_LOCAL_STORAGE !== "true"
      ) {
        throw serviceUnavailable("ไฟล์ต้นฉบับต้องเก็บใน R2 หรือพื้นที่ถาวร");
      }
      if (stored.checksumSha256 !== document.checksumSha256) {
        throw conflict("ข้อมูลไฟล์เปลี่ยนขณะอัปโหลด");
      }
      storedDocuments.push({ document, stored });
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const table = getTables().accountingSourceOriginals;
      const rows = [];
      for (const { document, stored } of storedDocuments) {
        const existing = (await client.query(
          `SELECT * FROM ${table}
            WHERE source_sha256=$1
               OR (shop_code=$2 AND document_kind='statement' AND period_type=$3
                   AND start_date=$4::date AND end_date=$5::date)
            ORDER BY (source_sha256=$1) DESC
            LIMIT 1
            FOR UPDATE`,
          [
            document.checksumSha256,
            document.shopCode,
            document.periodType,
            document.start,
            document.end,
          ],
        )).rows[0];
        if (existing) {
          if (existing.source_sha256 !== document.checksumSha256) {
            throw conflict(
              `มีไฟล์ต้นฉบับ ${document.periodType === "monthly" ? "รายเดือน" : "รายสัปดาห์"}`
              + ` ของร้านนี้ในช่วง ${document.start} ถึง ${document.end} อยู่แล้ว`,
            );
          }
          rows.push(existing);
          continue;
        }
        rows.push((await client.query(
          `INSERT INTO ${table}
             (shop_code,document_kind,period_type,start_date,end_date,source_filename,
              source_sha256,source_file,page_count,uploaded_by)
           VALUES ($1,'statement',$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING *`,
          [
            document.shopCode,
            document.periodType,
            document.start,
            document.end,
            document.filename,
            document.checksumSha256,
            JSON.stringify(stored),
            document.pageCount,
            actor || "",
          ],
        )).rows[0]);
      }
      await client.query("COMMIT");
      return { sources: rows.map(publicSource) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function getSourceOriginal(id) {
    const row = (await db.query(
      `SELECT * FROM ${getTables().accountingSourceOriginals} WHERE id=$1`,
      [sourceId(id)],
    )).rows[0];
    if (!row) throw notFound("ไม่พบไฟล์ต้นฉบับ");
    return {
      buffer: await storage.readStoredFile(
        row.source_file.storageProvider,
        row.source_file.storagePath,
        row.source_file.storageBucket,
      ),
      filename: row.source_filename,
      mimeType: "application/pdf",
    };
  }

  return { getSourceOriginal, uploadSourceOriginals };
}

module.exports = { ...createService(), createService };
