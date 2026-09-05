const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const { Pool } = require("pg");
const { PDFDocument } = require("pdf-lib");
const connectionString = process.env.ACCOUNTING_TEST_DATABASE_URL;
if (
  !connectionString ||
  !["127.0.0.1", "localhost"].includes(new URL(connectionString).hostname)
) {
  throw new Error(
    "ACCOUNTING_TEST_DATABASE_URL must point to a local disposable test database",
  );
}
process.env.SC_OFFICIAL_SUPABASE_DATABASE_URL = connectionString;
const {
  createService,
  digestFor,
} = require("../src/modules/seamless/services/accountingOriginalPrintService");
const {
  arrangeManifest,
  hash,
} = require("../src/modules/seamless/services/accountingOriginalManifest");
const schema = "accounting_batch_" + Date.now() + "_ci";
const db = new Pool({ connectionString });
const tables = () =>
  Object.fromEntries(
    [
      ["accountingPrintBatches", "accounting_print_batches"],
      ["accountingPrintItems", "accounting_print_items"],
      ["accountingPrintNotifications", "accounting_print_notifications"],
      ["printJobs", "print_jobs"],
    ].map(([key, value]) => [key, '"' + schema + '"."' + value + '"']),
  );
const buffers = new Map();
let pdfBuffer;
const target = () => ({
  agentHost: "TEST-HOST",
  printerName: "FAKE-PRINTER",
  webUrl: "https://example.invalid",
});
const messages = [];
const printLayout={version:'shopee-a4-landscape-reference-v2',warnings:[]};
let failLine = false;
const store = {
  async writeStoredFile(kind, name, buffer) {
    const storagePath = kind + "/" + name + "/" + hash(buffer);
    buffers.set(storagePath, buffer);
    return {
      storageProvider: "local",
      storagePath,
      checksumSha256: hash(buffer),
      fileSizeBytes: buffer.length,
    };
  },
  async readStoredFile(provider, storagePath) {
    return buffers.get(storagePath);
  },
};
let currentManifest;
const service = createService({
  db,
  tables,
  fileStorage: store,
  parseFiles: async () => currentManifest,
  target,
  lineConfig: () => ({
    channelAccessToken: "test-only",
    targetId: "test-only",
  }),
  notify: async (text, key) => {
    if (failLine) throw new Error("LINE unavailable");
    messages.push({ text, key });
  },
});
const identity = {
  protocol: 1,
  agentHost: "TEST-HOST",
  printerName: "FAKE-PRINTER",
};
let fixtureNumber = 0;
async function fixture(twoShops = false) {
  fixtureNumber++;
  const documents = [],
    files = [];
  for (const shopCode of twoShops
    ? ["sc-drug-store", "dr-morepen"]
    : ["sc-drug-store"]) {
    for (const kind of ["statement", "balance", "income", "orders"]) {
      const bytes =
        kind === "statement"
          ? pdfBuffer
          : Buffer.from(fixtureNumber + shopCode + kind);
      const filename =
        fixtureNumber +
        "-" +
        shopCode +
        "-" +
        kind +
        (kind === "statement" ? ".pdf" : ".xlsx");
      documents.push({
        shopCode,
        shop: shopCode,
        kind,
        start: "2026-07-27",
        end: "2026-08-02",
        filename,
        checksumSha256: hash(bytes),
        orders:
          kind === "income" || kind === "orders"
            ? [{ id: shopCode + "-1", created: "2026-07-28" }]
            : undefined,
      });
      files.push({
        fieldname: shopCode,
        originalname: filename,
        buffer: bytes,
      });
    }
  }
  // Different valid PDF bytes per shop, matching real documents.
  if (twoShops) {
    const doc = documents.find(
      (doc) => doc.shopCode === "dr-morepen" && doc.kind === "statement",
    );
    const pdf = await PDFDocument.load(pdfBuffer);
    pdf.setTitle("other shop");
    const buffer = Buffer.from(await pdf.save());
    doc.checksumSha256 = hash(buffer);
    files.find((file) => file.originalname === doc.filename).buffer = buffer;
  }
  currentManifest = arrangeManifest(documents);
  return files;
}
async function prepare(batch) {
  for (let i = 0; i < batch.items.length; i++) {
    const { work } = await service.claimWork(identity);
    assert.equal(work.action, "prepare");
    assert.equal(work.sequence, i + 1);
    const item = batch.items[i];
    const buffer =
      item.kind === "statement"
        ? await service
            .getFile(batch.id, item.id, "original")
            .then((file) => file.buffer)
        : pdfBuffer;
    await service.updateWork(
      work.id,
      { event: "preview", token: work.token, printLayout },
      { buffer },
    );
  }
  const final = await service.getBatch(batch.id);
  assert.equal(final.status, "review");
  return final;
}
async function printOne(work) {
  await service.updateWork(work.id, { event: "submitting", token: work.token });
  await service.updateWork(work.id, {
    event: "spooler",
    token: work.token,
    spoolerJobId: work.sequence,
  });
  await service.updateWork(work.id, { event: "completed", token: work.token });
}
test.before(async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([841.89, 595.28]);
  pdfBuffer = Buffer.from(await pdf.save());
  await db.query('CREATE SCHEMA "' + schema + '"');
  const client = await db.connect();
  try {
    await client.query('SET search_path TO "' + schema + '",public');
    await client.query(
      "CREATE TABLE print_jobs (id uuid,agent_host text,status text)",
    );
    const migration = await fs.readFile(
      path.join(
        __dirname,
        "../src/modules/seamless/db/migrations/015_accounting_original_print_batches.sql",
      ),
      "utf8",
    );
    await client.query(migration);
  } finally {
    client.release();
  }
});
test.after(async () => {
  await db.query('DROP SCHEMA "' + schema + '" CASCADE');
  await db.end();
  await require("../db").end();
});
test("atomic original upload, duplicate recovery, ordered claims, approval digest, and one notification per milestone", async () => {
  const files = await fixture(true);
  let batch = await service.createBatch(files, "admin");
  const duplicate = await service.createBatch(files, "admin");
  assert.equal(duplicate.id, batch.id);
  assert.equal(batch.items.length, 8);
  const original = await service.getFile(
    batch.id,
    batch.items[0].id,
    "original",
  );
  assert.deepEqual(original.buffer, files[0].buffer);
  await assert.rejects(
    service.approveBatch(batch.id, batch.digest, "admin"),
    /ยังไม่พร้อม/,
  );
  batch = await prepare(batch);
  await assert.rejects(
    service.approveBatch(batch.id, "stale-digest", "admin"),
    /เปลี่ยน/,
  );
  await service.approveBatch(batch.id, batch.digest, "admin");
  await service.approveBatch(batch.id, batch.digest, "admin"); // same approval response lost
  assert.equal(
    (await service.claimWork({ ...identity, agentHost: "WRONG" })).work,
    null,
  );
  const [claim1, claim2] = await Promise.all([
    service.claimWork(identity),
    service.claimWork(identity),
  ]);
  const work = claim1.work || claim2.work;
  assert.equal([claim1, claim2].filter((result) => result.work).length, 1);
  await assert.rejects(
    service.updateWork(work.id, { token: "wrong", event: "completed" }),
    /รอบนี้/,
  );
  await assert.rejects(
    service.updateWork(work.id, { token: work.token, event: "completed" }),
    /หลักฐาน/,
  );
  await printOne(work);
  await service.updateWork(work.id, { token: work.token, event: "completed" }); // idempotent completion
  for (let seq = 2; seq <= 8; seq++) {
    const { work: next } = await service.claimWork(identity);
    assert.equal(next.sequence, seq);
    await printOne(next);
  }
  const result = await service.getBatch(batch.id);
    assert.equal(result.status, "completed");
    assert.equal(result.notifications.some(row => row.event_key.startsWith("resumed:")), false);
  assert.equal(result.completedCount, 8);
  assert.equal(result.notifications.length, 4);
  assert.equal(
    result.notifications.filter((row) => row.event_key === "started").length,
    1,
  );
  assert.ok(result.notifications.every((row) => row.sent_at));
  assert.equal(messages.length, 4);
});
test("ambiguous spool submission pauses the batch, never auto-reprints, and allows an audited operator resolution", async () => {
  let batch = await prepare(
    await service.createBatch(await fixture(), "admin"),
  );
  await service.approveBatch(batch.id, batch.digest, "admin");
  const { work } = await service.claimWork(identity);
  await service.updateWork(work.id, { event: "submitting", token: work.token });
  await service.updateWork(work.id, {
    event: "failed",
    token: work.token,
    message: "network lost",
  });
  let result = await service.getBatch(batch.id);
  assert.equal(result.status, "paused");
  assert.equal(result.items[0].status, "uncertain");
  assert.equal((await service.claimWork(identity)).work, null);
  await assert.rejects(
    service.resolvePaused(
      batch.id,
      { itemId: work.id, action: "retry", reason: "" },
      "admin",
    ),
    /ระบุ/,
  );
  await service.resolvePaused(
    batch.id,
    {
      itemId: work.id,
      action: "confirm-printed",
      reason: "ตรวจแล้วกระดาษออกครบ",
    },
    "admin",
  );
  for (let seq = 2; seq <= 4; seq++) {
    const { work: next } = await service.claimWork(identity);
    assert.equal(next.sequence, seq);
    await printOne(next);
  }
  result = await service.getBatch(batch.id);
  assert.equal(result.status, "completed");
  assert.equal(
    result.items[0].history.find((row) => row.event === "confirm-printed")
      .actor,
    "admin",
  );
});
test("expired print claim pauses without retry; heartbeat and replaced token fence older workers", async () => {
  let batch = await service.createBatch(await fixture(), "admin");
  const { work: old } = await service.claimWork(identity);
  await db.query(
    "UPDATE " +
      tables().accountingPrintItems +
      " SET lease_until=now()-interval '1 minute' WHERE id=$1",
    [old.id],
  );
  const { work: newer } = await service.claimWork(identity);
  assert.equal(old.id, newer.id);
  assert.notEqual(old.token, newer.token);
  await assert.rejects(
    service.updateWork(
      old.id,
      { event: "preview", token: old.token },
      { buffer: pdfBuffer },
    ),
    /รอบนี้/,
  );
  await service.updateWork(
    newer.id,
    { event: "preview", token: newer.token },
    { buffer: pdfBuffer },
  );
  for (let seq = 2; seq <= 4; seq++) {
    const { work } = await service.claimWork(identity);
    await service.updateWork(
      work.id,
      { event: "preview", token: work.token, printLayout },
      { buffer: pdfBuffer },
    );
  }
  batch = await service.getBatch(batch.id);
  await service.approveBatch(batch.id, batch.digest, "admin");
  const { work } = await service.claimWork(identity);
  await service.updateWork(work.id, { event: "heartbeat", token: work.token });
  await db.query(
    "UPDATE " +
      tables().accountingPrintItems +
      " SET lease_until=now()-interval '1 minute' WHERE id=$1",
    [work.id],
  );
  await service.maintain(); // server detects a disconnected agent without waiting for another agent poll
  batch = await service.getBatch(batch.id);
  assert.equal(batch.items[0].status, "uncertain");
  assert.equal((await service.claimWork(identity)).work, null);
  await service.resolvePaused(
    batch.id,
    { itemId: work.id, action: "retry", reason: "ตรวจแล้วไม่ได้พิมพ์" },
    "admin",
  );
  for (let seq = 1; seq <= 4; seq++) {
    const { work: next } = await service.claimWork(identity);
    assert.equal(next.sequence, seq);
    await printOne(next);
  }
});
test("LINE failure is visible, retries use the same key, and successful printing is never repeated", async () => {
  failLine = true;
  let batch = await prepare(
    await service.createBatch(await fixture(), "admin"),
  );
  assert.match(batch.notifications[0].last_error, /LINE unavailable/);
  const event = await db.query(
    "SELECT retry_key FROM " +
      tables().accountingPrintNotifications +
      " WHERE batch_id=$1",
    [batch.id],
  );
  failLine = false;
  await db.query(
    "UPDATE " +
      tables().accountingPrintNotifications +
      " SET next_attempt_at=now() WHERE batch_id=$1",
    [batch.id],
  );
  await service.flushNotifications();
  assert.equal(messages.at(-1).key, event.rows[0].retry_key);
  await service.approveBatch(batch.id, batch.digest, "admin");
  for (let seq = 1; seq <= 4; seq++) {
    const { work } = await service.claimWork(identity);
    await printOne(work);
  }
  batch = await service.getBatch(batch.id);
  assert.equal(batch.status, "completed");
  assert.equal((await service.claimWork(identity)).work, null);
});
test("failed storage insert rolls back the entire batch; no partial batch can print", async () => {
  const files = await fixture();
  const failing = createService({
    db,
    tables,
    target,
    parseFiles: async () => currentManifest,
    fileStorage: {
      ...store,
      writeStoredFile: async () => {
        throw new Error("storage failure");
      },
    },
  });
  const before = await service.listBatches();
  await assert.rejects(failing.createBatch(files, "admin"), /storage failure/);
  assert.equal((await service.listBatches()).length, before.length);
});
test('Excel previews reject portrait and missing layout version before approval',async()=>{
  const batch=await service.createBatch(await fixture(),'admin');
  let {work}=await service.claimWork(identity);
  await service.updateWork(work.id,{event:'preview',token:work.token},{buffer:pdfBuffer});
  ({work}=await service.claimWork(identity));
  const pdf=await PDFDocument.create();pdf.addPage([595.28,841.89]);
  await assert.rejects(service.updateWork(work.id,{event:'preview',token:work.token,printLayout},{buffer:Buffer.from(await pdf.save())}),/แนวนอน/);
  await assert.rejects(service.updateWork(work.id,{event:'preview',token:work.token},{buffer:pdfBuffer}),/อัปเดต|รูปแบบ|แนวนอน/);
  await service.updateWork(work.id,{event:'preview',token:work.token,printLayout:JSON.stringify(printLayout)},{buffer:pdfBuffer});
  const result=await service.getBatch(batch.id);
  assert.equal(result.items[1].printLayout.version,printLayout.version);
  assert.equal(result.status,'preparing');
});
