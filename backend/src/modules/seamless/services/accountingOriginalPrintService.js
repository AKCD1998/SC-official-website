const crypto = require("node:crypto");
const pool = require("../../../../db");
const { getTables } = require("../tables");
const {
  badRequest,
  conflict,
  notFound,
  serviceUnavailable,
} = require("../errors");
const storage = require("./fileStorageService");
const { readLineConfig } = require("../config");
const {
  parseOriginalFiles,
  inspectPdf,
  hash,
  filenameOf,
} = require("./accountingOriginalManifest");
const {
  sendAccountingBatchText,
  buildAccountingBatchMessage,
} = require("./accountingPrintNotificationService");

const LANE_LOCK = "accounting-original-print-lane-v1";
const uuid = (value) => {
  if (!/^[a-f0-9-]{36}$/i.test(String(value || "")))
    throw badRequest("รหัสชุดงานไม่ถูกต้อง");
  return value;
};
function targetConfig() {
  return {
    agentHost: process.env.SEAMLESS_ACCOUNTING_AGENT_HOST || "",
    printerName: process.env.SEAMLESS_ACCOUNTING_PRINTER_NAME || "",
    webUrl: (process.env.SEAMLESS_ACCOUNTING_WEB_URL || "").replace(/\/+$/, ""),
  };
}
function digestFor(batch, items) {
  return hash(
    JSON.stringify({
      fingerprint: batch.fingerprint,
      agentHost: batch.agent_host,
      printerName: batch.printer_name,
      items: items.map((item) => [
        item.id,
        item.sequence,
        item.source_file.checksumSha256,
        item.preview_file?.checksumSha256,
        item.page_count,
      ]),
      printSettings: "paper=A4,fit,simplex,1x",
    }),
  );
}
function createService({
  db = pool,
  tables = getTables,
  fileStorage = storage,
  parseFiles = parseOriginalFiles,
  pdfInfo = inspectPdf,
  notify = sendAccountingBatchText,
  target = targetConfig,
  lineConfig = readLineConfig,
} = {}) {
  async function transaction(action) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        LANE_LOCK,
      ]);
      const value = await action(client, tables());
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async function getRow(client, id, lock = false) {
    const t = tables();
    const result = await client.query(
      "SELECT * FROM " +
        t.accountingPrintBatches +
        " WHERE id=$1" +
        (lock ? " FOR UPDATE" : ""),
      [uuid(id)],
    );
    if (!result.rows.length) throw notFound("ไม่พบชุดงาน");
    return result.rows[0];
  }
  async function getItems(client, batchId) {
    return (
      await client.query(
        "SELECT * FROM " +
          tables().accountingPrintItems +
          " WHERE batch_id=$1 ORDER BY sequence",
        [batchId],
      )
    ).rows;
  }
  function publicItem(item) {
    const prefix =
      "/app/accounting-print-bundles/" + item.batch_id + "/items/" + item.id;
    return {
      id: item.id,
      ...item.document,
      sequence: item.sequence,
      status: item.status,
      pageCount: item.page_count,
      warnings: item.warnings,
      printLayout: item.preview_file?.printLayout || null,
      error: item.error_message,
      attempt: item.attempt,
      history: item.history,
      completedAt: item.completed_at,
      originalUrl: prefix + "/original",
      previewUrl: item.preview_file ? prefix + "/preview" : null,
    };
  }
  async function getBatch(id, client = db) {
    const batch = await getRow(client, id);
    const items = await getItems(client, id);
    const events = (
      await client.query(
        "SELECT event_key, message, attempts, sent_at, last_error FROM " +
          tables().accountingPrintNotifications +
          " WHERE batch_id=$1 ORDER BY event_sequence",
        [id],
      )
    ).rows;
    return {
      id: batch.id,
      title: batch.title,
      status: batch.status,
      manifest: batch.manifest,
      createdAt: batch.created_at,
      agentHost: batch.agent_host,
      printerName: batch.printer_name,
      pauseReason: batch.pause_reason,
      approvedAt: batch.approved_at,
      digest: digestFor(batch, items),
      items: items.map(publicItem),
      notifications: events,
      totalPages: items.reduce((sum, item) => sum + (item.page_count || 0), 0),
      completedCount: items.filter((item) => item.status === "completed")
        .length,
    };
  }
  async function listBatches() {
    return (
      await db.query(
        "SELECT id,title,status,created_at,manifest->>'fileCount' AS file_count FROM " +
          tables().accountingPrintBatches +
          " ORDER BY created_at DESC LIMIT 50",
      )
    ).rows;
  }
  async function event(client, batch, eventKey, item = null) {
    const items = await getItems(client, batch.id);
    const message = buildAccountingBatchMessage(
      batch,
      items,
      eventKey,
      item,
      target().webUrl,
    );
    await client.query(
      "INSERT INTO " +
        tables().accountingPrintNotifications +
        " (batch_id,event_key,message) VALUES ($1,$2,$3) ON CONFLICT (batch_id,event_key) DO NOTHING",
      [batch.id, eventKey, message],
    );
  }
  async function flushNotifications() {
    // Short row lock plus LINE's retry key makes an accepted response safe to retry after
    // a network failure. Stop at the first failure so event ordering is preserved per batch.
    for (let index = 0; index < 10; index++) {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const t = tables().accountingPrintNotifications;
        const result = await client.query(
          "SELECT n.* FROM " +
            t +
            " n WHERE sent_at IS NULL AND next_attempt_at<=now() " +
            "AND NOT EXISTS (SELECT 1 FROM " +
            t +
            " older WHERE older.batch_id=n.batch_id AND older.sent_at IS NULL " +
            "AND older.event_sequence<n.event_sequence) ORDER BY event_sequence LIMIT 1 FOR UPDATE SKIP LOCKED",
        );
        if (!result.rows.length) {
          await client.query("COMMIT");
          return;
        }
        const row = result.rows[0];
        let error = null;
        // LINE retains retry keys for 24 hours. Never silently generate a new key and duplicate an uncertain send.
        if (
          row.first_attempt_at &&
          Date.now() - new Date(row.first_attempt_at).getTime() > 23 * 3600000
        ) {
          error = "เกินช่วงลองส่ง LINE ซ้ำอัตโนมัติ กรุณาตรวจประวัติการส่ง";
        } else {
          try {
            await notify(row.message, row.retry_key);
          } catch (failure) {
            error = String(failure.message).slice(0, 500);
          }
        }
        await client.query(
          "UPDATE " +
            t +
            " SET attempts=attempts+1,first_attempt_at=COALESCE(first_attempt_at,now())," +
            "sent_at=CASE WHEN $2::text IS NULL THEN now() ELSE NULL END,last_error=$2," +
            "next_attempt_at=now()+interval '2 minutes' WHERE id=$1",
          [row.id, error],
        );
        await client.query("COMMIT");
        if (error) return;
      } catch (error) {
        await client.query("ROLLBACK");
        return;
      } finally {
        client.release();
      }
    }
  }
  function capabilities() {
    const config = target(),
      line = lineConfig();
    return {
      ...config,
      lineConfigured: !!(line.channelAccessToken && line.targetId),
    };
  }
  async function createBatch(files, actor) {
    const config = target();
    if (!config.agentHost || !config.printerName)
      throw serviceUnavailable(
        "ยังไม่ได้ตั้งค่าเครื่องสาขาและเครื่องพิมพ์สำหรับชุดเอกสารบัญชี",
      );
    const manifest = await parseFiles(files);
    const id = await transaction(async (client, t) => {
      const duplicate = (
        await client.query(
          "SELECT id FROM " +
            t.accountingPrintBatches +
            " WHERE fingerprint=$1",
          [manifest.fingerprint],
        )
      ).rows[0];
      if (duplicate) return duplicate.id;
      const batch = (
        await client.query(
          "INSERT INTO " +
            t.accountingPrintBatches +
            " (fingerprint,title,manifest,agent_host,printer_name,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
          [
            manifest.fingerprint,
            "เอกสารบัญชี Shopee " +
              manifest.periodStart +
              " ถึง " +
              manifest.periodEnd,
            JSON.stringify(manifest),
            config.agentHost,
            config.printerName,
            actor || "",
          ],
        )
      ).rows[0];
      for (const doc of manifest.items) {
        const file = files.find(
          (file) =>
            file.fieldname === doc.shopCode &&
            filenameOf(file) === doc.filename,
        );
        const stored = await fileStorage.writeStoredFile(
          "accounting_original",
          doc.filename,
          file.buffer,
        );
        if (
          process.env.NODE_ENV === "production" &&
          stored.storageProvider !== "r2" &&
          process.env.SEAMLESS_ACCOUNTING_ALLOW_LOCAL_STORAGE !== "true"
        ) {
          throw serviceUnavailable(
            "ชุดงานต้องเก็บใน R2 หรือพื้นที่ถาวรก่อน จึงจะปิดคอมผู้ส่งได้อย่างปลอดภัย",
          );
        }
        if (stored.checksumSha256 !== doc.checksumSha256)
          throw conflict("ข้อมูลไฟล์เปลี่ยนขณะอัปโหลด");
        await client.query(
          "INSERT INTO " +
            t.accountingPrintItems +
            " (batch_id,sequence,document,source_file) VALUES ($1,$2,$3,$4)",
          [batch.id, doc.sequence, JSON.stringify(doc), JSON.stringify(stored)],
        );
      }
      return batch.id;
    });
    return getBatch(id);
  }
  async function approveBatch(id, digest, actor) {
    await transaction(async (client, t) => {
      const batch = await getRow(client, id, true);
      if (
        ["queued", "printing", "completed"].includes(batch.status) &&
        batch.approved_digest === digest
      )
        return;
      if (batch.status !== "review") throw conflict("ชุดงานยังไม่พร้อมอนุมัติ");
      const items = await getItems(client, id);
      if (
        items.some(
          (item) =>
            item.status !== "ready" || !item.preview_file || !item.page_count,
        )
      )
        throw conflict("ตัวอย่างพิมพ์ยังไม่ครบ");
      if (digest !== digestFor(batch, items))
        throw conflict("รายการที่ตรวจเปลี่ยนแล้ว กรุณาโหลดหน้าใหม่");
      const line = lineConfig();
      if (!line.channelAccessToken || !line.targetId)
        throw serviceUnavailable("ยังไม่ได้ตั้งค่าการแจ้งเตือน LINE");
      if (!target().webUrl)
        throw serviceUnavailable(
          "ยังไม่ได้ตั้งค่าลิงก์หน้าเว็บสำหรับแจ้ง LINE",
        );
      const other = await client.query(
        "SELECT id FROM " +
          t.accountingPrintBatches +
          " WHERE id<>$1 AND status IN ('queued','printing','paused') LIMIT 1",
        [id],
      );
      if (other.rows.length)
        throw conflict(
          "มีชุดงานกำลังพิมพ์หรือหยุดรออยู่ กรุณาจัดการชุดเดิมก่อน",
        );
      const legacy = await client.query(
        "SELECT id FROM " +
          t.printJobs +
          " WHERE agent_host IS NOT NULL AND status IN ('queued','downloading','sent_to_spooler','printing') LIMIT 1",
      );
      if (legacy.rows.length)
        throw conflict("เครื่องกำลังทำงานพิมพ์อื่น กรุณารอจนเสร็จ");
      await client.query(
        "UPDATE " +
          t.accountingPrintBatches +
          " SET status='queued',approved_digest=$2,approved_by=$3,approved_at=now(),updated_at=now() WHERE id=$1",
        [id, digest, actor || ""],
      );
    });
    return getBatch(id);
  }
  async function pause(client, batch, item, message, uncertain) {
    const t = tables();
    await client.query(
      "UPDATE " +
        t.accountingPrintItems +
        " SET status=$2,error_message=$3,lease_until=NULL WHERE id=$1",
      [item.id, uncertain ? "uncertain" : "failed", message],
    );
    await client.query(
      "UPDATE " +
        t.accountingPrintBatches +
        " SET status='paused',pause_reason=$2,updated_at=now() WHERE id=$1",
      [batch.id, message],
    );
    await event(client, batch, "paused:" + item.sequence + ":" + item.attempt, {
      ...item,
      error_message: message,
    });
  }
  async function recoverExpiredWork(client, t) {
    const stale = (
      await client.query(
        "SELECT * FROM " +
          t.accountingPrintItems +
          " WHERE status IN ('preparing','printing','submitted') AND lease_until<now() FOR UPDATE",
      )
    ).rows;
    for (const item of stale) {
      const batch = await getRow(client, item.batch_id);
      if (item.status === "preparing") {
        await client.query(
          "UPDATE " +
            t.accountingPrintItems +
            " SET status='pending',claim_token=NULL,lease_until=NULL WHERE id=$1",
          [item.id],
        );
      } else
        await pause(
          client,
          batch,
          item,
          "เครื่องสาขาขาดการติดต่อระหว่างพิมพ์ ต้องตรวจเอกสารก่อนทำต่อ",
          true,
        );
    }
  }
  async function maintain() {
    await transaction(recoverExpiredWork);
    await flushNotifications();
  }
  async function claimWork(body) {
    if (body.protocol !== 1 || !body.agentHost || !body.printerName)
      throw badRequest("Print Agent ไม่รองรับชุดงานรุ่นนี้");
    const result = await transaction(async (client, t) => {
      await recoverExpiredWork(client, t);
      const active = (
        await client.query(
          "SELECT * FROM " +
            t.accountingPrintBatches +
            " WHERE status IN ('queued','printing','paused') ORDER BY created_at,id LIMIT 1 FOR UPDATE",
        )
      ).rows[0];
      const inFlight = (
        await client.query(
          "SELECT id FROM " +
            t.accountingPrintItems +
            " WHERE status IN ('preparing','printing','submitted') LIMIT 1",
        )
      ).rows.length;
      if (inFlight) return { work: null, holdLegacy: true };
      const batch =
        active ||
        (
          await client.query(
            "SELECT * FROM " +
              t.accountingPrintBatches +
              " WHERE status='preparing' AND agent_host=$1 AND printer_name=$2 ORDER BY created_at,id LIMIT 1 FOR UPDATE",
            [body.agentHost, body.printerName],
          )
        ).rows[0];
      if (!batch) return { work: null, holdLegacy: false };
      if (
        batch.status === "paused" ||
        batch.agent_host !== body.agentHost ||
        batch.printer_name !== body.printerName
      )
        return { work: null, holdLegacy: !!active };
      const legacy = await client.query(
        "SELECT id FROM " +
          t.printJobs +
          " WHERE agent_host IS NOT NULL AND status IN ('queued','downloading','sent_to_spooler','printing') LIMIT 1",
      );
      if (legacy.rows.length) return { work: null, holdLegacy: true };
      const items = await getItems(client, batch.id);
      const preparing = batch.status === "preparing";
      const item = items.find((item) =>
        preparing ? item.status === "pending" : item.status !== "completed",
      );
      if (!item || (!preparing && item.status !== "ready"))
        return { work: null, holdLegacy: !!active };
      if (!preparing && batch.status === "queued") {
        await client.query(
          "UPDATE " +
            t.accountingPrintBatches +
            " SET status='printing',updated_at=now() WHERE id=$1",
          [batch.id],
        );
        await event(client, batch, "started");
      }
      const token = crypto.randomUUID();
      await client.query(
        "UPDATE " +
          t.accountingPrintItems +
          " SET status=$2,attempt=attempt+1,claim_token=$3,lease_until=now()+interval '3 minutes',error_message=NULL,spooler_job_id=NULL WHERE id=$1",
        [item.id, preparing ? "preparing" : "printing", token],
      );
      const file = preparing ? item.source_file : item.preview_file;
      return {
        holdLegacy: true,
        work: {
          id: item.id,
          batchId: batch.id,
          token,
          action: preparing ? "prepare" : "print",
          sequence: item.sequence,
          filename: item.document.filename,
          checksumSha256: file.checksumSha256,
          downloadUrl:
            "/api/agent/accounting-print-batches/" +
            batch.id +
            "/items/" +
            item.id +
            (preparing ? "/original" : "/preview"),
          printerName: batch.printer_name,
          pageCount: item.page_count,
          attempt: item.attempt + 1,
        },
      };
    });
    await flushNotifications();
    return result;
  }
  async function owned(client, id, token) {
    const item = (
      await client.query(
        "SELECT * FROM " +
          tables().accountingPrintItems +
          " WHERE id=$1 FOR UPDATE",
        [uuid(id)],
      )
    ).rows[0];
    if (!item || !token || item.claim_token !== token)
      throw conflict("งานนี้ไม่ได้เป็นของการทำงานรอบนี้");
    return item;
  }
  async function updateWork(id, body, preview) {
    await transaction(async (client, t) => {
      const item = await owned(client, id, body.token);
      const batch = await getRow(client, item.batch_id);
      if (body.event === "heartbeat") {
        if (!["preparing", "printing", "submitted"].includes(item.status))
          throw conflict("งานนี้หยุดแล้ว");
        await client.query(
          "UPDATE " +
            t.accountingPrintItems +
            " SET lease_until=now()+interval '3 minutes' WHERE id=$1",
          [id],
        );
        return;
      }
      if (body.event === "preview") {
        if (item.status === "ready" && item.preview_file) return; // response-loss retry
        if (item.status !== "preparing" || !preview?.buffer)
          throw conflict("งานนี้ไม่ได้รอสร้างตัวอย่าง");
        const info = await pdfInfo(preview.buffer);
        let printLayout=body.printLayout;
        if(typeof printLayout==='string') {
          try { printLayout=JSON.parse(printLayout); } catch { throw badRequest('อ่านรายละเอียดรูปแบบพิมพ์ไม่ได้'); }
        }
        if(item.document.kind!=='statement' && (!info.isA4Landscape || printLayout?.version!=='shopee-a4-landscape-reference-v2'))
          throw badRequest('ตัวอย่าง Excel ต้องเป็น A4 แนวนอนจากรูปแบบพิมพ์รุ่นที่ตรวจแล้ว กรุณาอัปเดต Print Agent');
        const stored = await fileStorage.writeStoredFile(
          "accounting_preview",
          item.id + ".pdf",
          preview.buffer,
        );
        if (
          item.document.kind === "statement" &&
          stored.checksumSha256 !== item.source_file.checksumSha256
        )
          throw badRequest("ตัวอย่างรายงานการเงิน PDF ต้องตรงกับไฟล์ต้นฉบับ");
        const warnings = [
          ...info.warnings,
          ...(Array.isArray(printLayout?.warnings)?printLayout.warnings:[]),
          ...(info.pageCount > 100
            ? ["ไฟล์นี้มีมากกว่า 100 หน้า โปรดตรวจจำนวนกระดาษก่อนอนุมัติ"]
            : []),
        ];
        await client.query(
          "UPDATE " +
            t.accountingPrintItems +
            " SET status='ready',preview_file=$2,page_count=$3,warnings=$4,lease_until=NULL WHERE id=$1",
          [
            id,
            JSON.stringify({...stored,...(printLayout?{printLayout}:{})}),
            info.pageCount,
            JSON.stringify(warnings),
          ],
        );
        if (
          (await getItems(client, batch.id)).every(
            (item) => item.status === "ready",
          )
        ) {
          await client.query(
            "UPDATE " +
              t.accountingPrintBatches +
              " SET status='review',updated_at=now() WHERE id=$1",
            [batch.id],
          );
          await event(client, batch, "ready");
        }
        return;
      }
      if (body.event === "submitting") {
        if (item.status !== "printing")
          throw conflict("งานนี้ไม่ได้รอส่งเข้าเครื่องพิมพ์");
        // Persist BEFORE invoking the spooler. A crash on either side of submission is uncertain.
        await client.query(
          "UPDATE " +
            t.accountingPrintItems +
            " SET status='submitted',lease_until=now()+interval '3 minutes' WHERE id=$1",
          [id],
        );
        return;
      }
      if (body.event === "spooler") {
        if (item.status !== "submitted" || !Number.isInteger(body.spoolerJobId))
          throw conflict("ไม่พบหมายเลขงานพิมพ์");
        await client.query(
          "UPDATE " +
            t.accountingPrintItems +
            " SET spooler_job_id=$2 WHERE id=$1",
          [id, body.spoolerJobId],
        );
        return;
      }
      if (body.event === "completed") {
        if (item.status === "completed") return;
        if (item.status !== "submitted" || item.spooler_job_id === null)
          throw conflict("ยังไม่มีหลักฐานติดตามคิวพิมพ์");
        await completeItem(client, batch, item, "spooler-cleared");
        return;
      }
      if (body.event === "failed") {
        if (["failed", "uncertain"].includes(item.status)) return;
        if (!["preparing", "printing", "submitted"].includes(item.status))
          throw conflict("งานนี้ไม่อยู่ระหว่างดำเนินการ");
        await pause(
          client,
          batch,
          item,
          String(body.message || "ดำเนินการไม่สำเร็จ").slice(0, 600),
          item.status === "submitted",
        );
        return;
      }
      throw badRequest("สถานะงานไม่ถูกต้อง");
    });
    await flushNotifications();
    return { ok: true };
  }
  async function completeItem(client, batch, item, evidence) {
    const t = tables();
    await client.query(
      "UPDATE " +
        t.accountingPrintItems +
        " SET status='completed',completed_at=now(),lease_until=NULL,error_message=NULL," +
        "history=history || $2::jsonb WHERE id=$1",
      [
        item.id,
        JSON.stringify([
          {
            event: "completed",
            evidence,
            at: new Date().toISOString(),
            attempt: item.attempt,
          },
        ]),
      ],
    );
    const items = await getItems(client, batch.id);
    if (items.every((item) => item.status === "completed")) {
      await client.query(
        "UPDATE " +
          t.accountingPrintBatches +
          " SET status='completed',pause_reason=NULL,updated_at=now() WHERE id=$1",
        [batch.id],
      );
      await event(client, batch, "completed");
    } else if (
      items
        .filter((row) => row.document.shopCode === item.document.shopCode)
        .every((row) => row.status === "completed")
    ) {
      await event(
        client,
        batch,
        "shop-completed:" + item.document.shopCode,
        item,
      );
    }
  }
  async function resolvePaused(id, body, actor) {
    await transaction(async (client, t) => {
      const batch = await getRow(client, id, true);
      if (batch.status !== "paused")
        throw conflict("ชุดงานไม่ได้หยุดรอตรวจสอบ");
      const items = await getItems(client, id);
      const item = items.find((item) =>
        ["failed", "uncertain"].includes(item.status),
      );
      if (!item || body.itemId !== item.id)
        throw conflict("ไฟล์ที่หยุดเปลี่ยนแล้ว กรุณาโหลดใหม่");
      if (!String(body.reason || "").trim())
        throw badRequest("กรุณาระบุผลตรวจสอบก่อนทำต่อ");
      if (!["retry", "confirm-printed"].includes(body.action))
        throw badRequest("เลือกวิธีทำต่อ");
      if (body.action === "confirm-printed" && item.status !== "uncertain")
        throw badRequest("งานนี้ยังไม่เคยส่งพิมพ์");
      await client.query(
        "UPDATE " +
          t.accountingPrintItems +
          " SET history=history || $2::jsonb WHERE id=$1",
        [
          item.id,
          JSON.stringify([
            {
              event: body.action,
              actor: actor || "",
              reason: String(body.reason).slice(0, 600),
              at: new Date().toISOString(),
            },
          ]),
        ],
      );
      if (body.action === "confirm-printed")
        await completeItem(client, batch, item, "operator-confirmed");
      else
        await client.query(
          "UPDATE " +
            t.accountingPrintItems +
            " SET status=$2,claim_token=NULL,lease_until=NULL,error_message=NULL WHERE id=$1",
          [item.id, item.preview_file ? "ready" : "pending"],
        );
      const remaining = await getItems(client, id);
      if (remaining.some((item) => item.status !== "completed")) {
        await client.query(
          "UPDATE " +
            t.accountingPrintBatches +
            " SET status=$2,pause_reason=NULL,updated_at=now() WHERE id=$1",
          [id, batch.approved_at ? "printing" : "preparing"],
        );
        await event(
          client,
          batch,
          "resumed:" + item.sequence + ":" + item.attempt,
          item,
        );
      }
    });
    await flushNotifications();
    return getBatch(id);
  }
  async function getFile(batchId, itemId, kind) {
    uuid(batchId);
    uuid(itemId);
    const item = (
      await db.query(
        "SELECT * FROM " +
          tables().accountingPrintItems +
          " WHERE id=$1 AND batch_id=$2",
        [itemId, batchId],
      )
    ).rows[0];
    if (!item) throw notFound("ไม่พบไฟล์");
    const file = kind === "preview" ? item.preview_file : item.source_file;
    if (!file) throw notFound("ยังไม่มีตัวอย่างพิมพ์");
    return {
      buffer: await fileStorage.readStoredFile(
        file.storageProvider,
        file.storagePath,
        file.storageBucket,
      ),
      filename:
        kind === "preview"
          ? item.document.filename.replace(/\.[^.]+$/, "") + ".pdf"
          : item.document.filename,
      mimeType:
        kind === "preview" || item.document.kind === "statement"
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };
  }
  return {
    createBatch,
    getBatch,
    listBatches,
    approveBatch,
    claimWork,
    updateWork,
    resolvePaused,
    getFile,
    flushNotifications,
    capabilities,
    maintain,
  };
}
module.exports = { ...createService(), createService, LANE_LOCK, digestFor };
