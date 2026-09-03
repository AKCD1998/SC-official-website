const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");
const ExcelJS = require("exceljs");
const request = require("supertest");

const {
  createAdaSmartShopeeController,
} = require("../src/modules/seamless/controllers/adaSmartShopeeController");
const { errorHandler } = require("../src/modules/seamless/middleware/errorHandler");
const {
  CYCLE_CONTRACT_REVISION,
} = require("../src/modules/seamless/services/shopeeAccountingCycles");
const {
  SOURCE_HEADERS,
} = require("../src/modules/seamless/services/shopeeWorkbookTransform");
const {
  buildIncludedRowsManifest,
} = require("../src/modules/seamless/services/shopeeIncludedRowsManifest");
const {
  createAdaSmartShopeeValidationService,
} = require("../src/modules/seamless/services/adaSmartShopeeValidationService");

const PROCESSING_RECORD_ID = "11111111-1111-4111-8111-111111111111";
const UPLOAD_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_ID = "33333333-3333-4333-8333-333333333333";
const ERP_CHECKSUM = "e".repeat(64);
const ORDER_A = "26082871YK8C01";
const ORDER_B = "26082871YK8C02";
const DR_PRODUCT = "Dr.Morepen Pregnancy Test Kit ชุดตรวจการตั้งครรภ์ ที่ตรวจครรภ์ HCG แบบปัสสาวะ รู้ผลใน 5 นาที 25 Tests/กล่อง";
const DR_STRIP_PRODUCT = "Gluco One แผ่นตรวจน้ำตาลในเลือด Dr.Morepen  BG-03 Test Strip (25/50 ชิ้น) สำหรับเครื่อง BG-03 เท่านั้น";
const SC_PRODUCT = "1 ซอง Strepsils HHR ยาอมบรรเทาอาการเจ็บคอ 8 เม็ด";
const SC_VISIBILITY_PRODUCT = SC_PRODUCT;
const SC_MYDA_MULTIPACK_PRODUCT = "สบู่ไมด้า Myda Soap Sulfur 2.5% สบู่ซัลเฟอร์ (แพ็ค 6 ก้อน) 30g / 80g ของแท้ 100%";

function hash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function buildWorkbook(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("orders");
  const headers = [...Object.values(SOURCE_HEADERS), "ชื่อผู้ใช้ (ผู้ซื้อ)", "หมายเลขโทรศัพท์"];
  sheet.addRow(headers);
  const columnByHeader = new Map(headers.map((header, index) => [header, index + 1]));

  rows.forEach((source) => {
    const values = [];
    const set = (header, value) => { values[columnByHeader.get(header)] = value; };
    set(SOURCE_HEADERS.orderNumber, source.orderNumber);
    set(SOURCE_HEADERS.status, source.status || "สำเร็จแล้ว");
    set(SOURCE_HEADERS.orderDate, "2026-08-28 10:00:00");
    set(SOURCE_HEADERS.productName, source.name);
    set(SOURCE_HEADERS.sku, source.excelSku || "");
    set(SOURCE_HEADERS.variation, source.variant || "");
    set(SOURCE_HEADERS.quantity, source.quantity);
    set(SOURCE_HEADERS.netSale, 100);
    set(SOURCE_HEADERS.sellerVoucher, 0);
    set(SOURCE_HEADERS.commission, 10);
    set(SOURCE_HEADERS.transactionFee, 2);
    set(SOURCE_HEADERS.completedAt, "2026-08-28 11:00:00");
    values[columnByHeader.get("ชื่อผู้ใช้ (ผู้ซื้อ)")] = source.buyer || "PRIVATE BUYER";
    values[columnByHeader.get("หมายเลขโทรศัพท์")] = source.phone || "0899999999";
    sheet.addRow(values);
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function timelineOrder(orderNumber, items, overrides = {}) {
  return {
    currentStatus: "order_confirmed",
    items,
    lastEventAt: "2026-08-28T04:00:00.000Z",
    orderNumber,
    shopCode: overrides.shopCode || "dr-morepen",
    ...overrides,
  };
}

function erpRecord(companySku, barcodes) {
  return { barcodes, companySku };
}

function createHarness({
  cycleOverrides = {},
  customerPolicy = {
    approved: true,
    customerCode: "CUS-SHOPEE-004",
    policyKey: "branch-004:shopee-credit-customer",
    revision: "approved-test-policy-v1",
  },
  existingEffects = [],
  includedRowIndexes = null,
  queueEnabled = true,
  records = [erpRecord("IC-005998", ["8850000000001"])],
  rows,
  shopCode = "dr-morepen",
  sourceFileProcessingRecordId = PROCESSING_RECORD_ID,
  timeline,
} = {}) {
  let queueCalls = 0;
  let queuedConfirmation = null;
  const ready = (async () => {
    const sourceBuffer = await buildWorkbook(rows);
    const selectedIndexes = Array.isArray(includedRowIndexes)
      ? includedRowIndexes
      : rows.map((_row, index) => index);
    const includedRowsManifest = buildIncludedRowsManifest(selectedIndexes.map((index) => ({
      excelSku: rows[index].excelSku || "",
      orderNumber: rows[index].orderNumber,
      productName: rows[index].name,
      quantity: rows[index].quantity,
      sourceRowNumber: index + 2,
      status: rows[index].status || "สำเร็จแล้ว",
      variant: rows[index].variant || "",
    })));
    const cycle = {
      checkpointEligible: true,
      cycleContractRevision: CYCLE_CONTRACT_REVISION,
      cycleKey: "2026-08-24_to_2026-09-13",
      periodEnd: "2026-09-13",
      periodStart: "2026-08-24",
      shopCode,
      includedRowsManifest,
      ...cycleOverrides,
    };
    const stored = {
      record: {
        id: PROCESSING_RECORD_ID,
        metadata: { shopCode, transformSummary: cycle },
        reportType: "shopee",
      },
      sourceBuffer,
      sourceUpload: {
        checksumSha256: hash(sourceBuffer),
        filename: "same-source-name.xlsx",
        id: SOURCE_ID,
        metadata: { shopCode },
        processingRecordId: sourceFileProcessingRecordId,
        uploadId: UPLOAD_ID,
        uploadProcessingRecordId: PROCESSING_RECORD_ID,
        uploadRequestedVariant: "shopee",
        uploadStatus: "processed",
        uploadTransformSummary: cycle,
      },
    };
    const service = createAdaSmartShopeeValidationService({
      findExistingEffects: async () => existingEffects,
      getCustomerPolicy: async () => customerPolicy,
      getQueueEnabled: async () => queueEnabled,
      getTimelineOrders: async () => timeline,
      loadStoredContext: async () => stored,
      queueDryRunPlan: async (plan, confirmation) => {
        queueCalls += 1;
        queuedConfirmation = confirmation;
        return {
          createdCount: plan.summary.readyCount,
          duplicateCount: 0,
          jobs: plan.orders.filter((order) => order.status === "ready").map((order) => ({
            id: "44444444-4444-4444-8444-444444444444",
            orderNumber: order.orderNumber,
            status: "queued_dry_run",
          })),
        };
      },
      resolveErpProducts: async () => ({ records, sourceChecksum: ERP_CHECKSUM }),
    });
    return { service };
  })();
  return {
    get queueCalls() { return queueCalls; },
    get queuedConfirmation() { return queuedConfirmation; },
    ready,
  };
}

test("keeps SC Drug Store and DR.Morepen identities isolated even for the same order number", async () => {
  const drRows = [{ name: DR_PRODUCT, orderNumber: ORDER_A, quantity: 1 }];
  const dr = createHarness({
    rows: drRows,
    timeline: [timelineOrder(ORDER_A, [{ name: DR_PRODUCT, quantity: 1, variant: "" }])],
  });
  const drPreview = await (await dr.ready).service.createValidationPreview(PROCESSING_RECORD_ID);

  const scRows = [{ name: SC_PRODUCT, orderNumber: ORDER_A, quantity: 1, variant: "ส้ม 8 เม็ด" }];
  const sc = createHarness({
    records: [erpRecord("630010065", ["8850000000065"])],
    rows: scRows,
    shopCode: "sc-drug-store",
    timeline: [timelineOrder(
      ORDER_A,
      [{ name: SC_PRODUCT, quantity: 1, variant: "ส้ม 8 เม็ด" }],
      { shopCode: "sc-drug-store" },
    )],
  });
  const scPreview = await (await sc.ready).service.createValidationPreview(PROCESSING_RECORD_ID);

  assert.equal(drPreview.shop.code, "dr-morepen");
  assert.equal(scPreview.shop.code, "sc-drug-store");
  assert.equal(drPreview.orders[0].safeLines[0].companySku, "IC-005998");
  assert.equal(scPreview.orders[0].safeLines[0].companySku, "630010065");
  assert.notEqual(drPreview.planDigest, scPreview.planDigest);

  const crossed = createHarness({
    rows: drRows,
    timeline: [timelineOrder(
      ORDER_A,
      [{ name: DR_PRODUCT, quantity: 1, variant: "" }],
      { shopCode: "sc-drug-store" },
    )],
  });
  await assert.rejects(
    () => (async () => (await crossed.ready).service.createValidationPreview(PROCESSING_RECORD_ID))(),
    (error) => error.statusCode === 409
      && error.details?.code === "ADASMART_TIMELINE_IDENTITY_CONFLICT",
  );
});

test("groups a multi-line order and accepts blank Excel SKU when the catalog supplies Company SKU", async () => {
  const rows = [
    { name: DR_PRODUCT, orderNumber: ORDER_A, quantity: 2 },
    {
      name: DR_STRIP_PRODUCT,
      orderNumber: ORDER_A,
      quantity: 1,
      variant: "แผ่นตรวจ 25 1 กล่อง",
    },
  ];
  const harness = createHarness({
    records: [
      erpRecord("IC-003478", ["8850000003478"]),
      erpRecord("IC-005998", ["8850000005998"]),
    ],
    rows,
    timeline: [timelineOrder(ORDER_A, rows.map((row) => ({
      name: row.name,
      quantity: row.quantity,
      variant: row.variant || "",
    })))],
  });
  const preview = await (await harness.ready).service.createValidationPreview(PROCESSING_RECORD_ID);

  assert.equal(preview.summary.totalOrderCount, 1);
  assert.equal(preview.summary.readyCount, 1);
  assert.deepEqual(preview.orders[0].safeLines.map((line) => [line.companySku, line.quantity]), [
    ["IC-003478", 1],
    ["IC-005998", 2],
  ]);
});

test("expands a verified same-SKU multipack before building AdaSmart safe lines", async () => {
  const rows = [{
    excelSku: "IC-003493",
    name: SC_MYDA_MULTIPACK_PRODUCT,
    orderNumber: ORDER_A,
    quantity: 2,
    variant: "80 กรัม 6 ก้อน",
  }];
  const harness = createHarness({
    records: [erpRecord("IC-003493", ["8850000003493"])],
    rows,
    shopCode: "sc-drug-store",
    timeline: [timelineOrder(ORDER_A, [{
      name: SC_MYDA_MULTIPACK_PRODUCT,
      quantity: 2,
      variant: "80 กรัม 6 ก้อน",
    }], { shopCode: "sc-drug-store" })],
  });
  const preview = await (await harness.ready).service.createValidationPreview(PROCESSING_RECORD_ID);

  assert.equal(preview.orders[0].status, "ready");
  assert.deepEqual(preview.orders[0].safeLines, [{
    barcode: "8850000003493",
    companySku: "IC-003493",
    quantity: 12,
  }]);
});

test("cancelled orders are never ready", async () => {
  const rows = [{ name: DR_PRODUCT, orderNumber: ORDER_A, quantity: 1, status: "ยกเลิกแล้ว" }];
  const harness = createHarness({ rows, timeline: [] });
  const preview = await (await harness.ready).service.createValidationPreview(PROCESSING_RECORD_ID);
  assert.equal(preview.orders[0].status, "cancelled");
  assert.equal(preview.summary.cancelledCount, 1);
  assert.equal(preview.summary.readyCount, 0);
});

test("blocks Excel/catalog conflicts and unmapped, visibility-only, and unverified bundle rows", async () => {
  const bundleProduct = DR_STRIP_PRODUCT;
  const rows = [
    { excelSku: "IC-WRONG", name: DR_PRODUCT, orderNumber: ORDER_A, quantity: 1 },
    { name: "not in approved catalog", orderNumber: ORDER_B, quantity: 1 },
    { name: SC_VISIBILITY_PRODUCT, orderNumber: "26082871YK8C03", quantity: 1, variant: "เลมอน ไม่มีน้ำตาล" },
    { name: bundleProduct, orderNumber: "26082871YK8C04", quantity: 1, variant: "เครื่อง + แผ่นตรวจ25" },
  ];
  const timeline = rows.map((row) => timelineOrder(row.orderNumber, [{
    name: row.name,
    quantity: row.quantity,
    variant: row.variant || "",
  }]));
  const harness = createHarness({ rows, timeline });
  const preview = await (await harness.ready).service.createValidationPreview(PROCESSING_RECORD_ID);
  const statuses = Object.fromEntries(preview.orders.map((order) => [order.orderNumber, order.status]));
  assert.equal(statuses[ORDER_A], "excel_catalog_sku_conflict");
  assert.equal(statuses[ORDER_B], "unmapped_product");
  // The visibility-only row belongs to the other shop, so exact shop matching fails closed as unmapped.
  assert.equal(statuses["26082871YK8C03"], "unmapped_product");
  assert.equal(statuses["26082871YK8C04"], "bundle_requires_validation");
});

test("marks the actual SC visibility-only listing without fabricating a SKU", async () => {
  const rows = [{
    name: SC_VISIBILITY_PRODUCT,
    orderNumber: ORDER_A,
    quantity: 1,
    variant: "เลมอน ไม่มีน้ำตาล",
  }];
  const harness = createHarness({
    records: [],
    rows,
    shopCode: "sc-drug-store",
    timeline: [timelineOrder(ORDER_A, [{
      name: SC_VISIBILITY_PRODUCT,
      quantity: 1,
      variant: "เลมอน ไม่มีน้ำตาล",
    }], { shopCode: "sc-drug-store" })],
  });
  const preview = await (await harness.ready).service.createValidationPreview(PROCESSING_RECORD_ID);
  assert.equal(preview.orders[0].status, "visibility_only");
  assert.deepEqual(preview.orders[0].safeLines, []);
});

test("unreadable quantity fails instead of becoming zero", async () => {
  const harness = createHarness({
    rows: [{ name: DR_PRODUCT, orderNumber: ORDER_A, quantity: "not-a-number" }],
    timeline: [],
  });
  await assert.rejects(
    () => (async () => (await harness.ready).service.createValidationPreview(PROCESSING_RECORD_ID))(),
    (error) => error.statusCode === 400 && error.details?.code === "ADASMART_QUANTITY_INVALID",
  );
});

test("validates only rows selected by the immutable applyCycle manifest", async () => {
  const rows = [
    { name: DR_PRODUCT, orderNumber: ORDER_A, quantity: 1 },
    { name: DR_PRODUCT, orderNumber: ORDER_B, quantity: "not-a-number" },
  ];
  const harness = createHarness({
    includedRowIndexes: [0],
    rows,
    timeline: [timelineOrder(ORDER_A, [{ name: DR_PRODUCT, quantity: 1, variant: "" }])],
  });
  const preview = await (await harness.ready).service.createValidationPreview(PROCESSING_RECORD_ID);

  assert.deepEqual(preview.orders.map((order) => order.orderNumber), [ORDER_A]);
  assert.equal(preview.cycle.includedRowCount, 1);
  assert.equal(preview.summary.readyCount, 1);
});

test("fails closed when the stored applyCycle manifest is missing", async () => {
  const harness = createHarness({
    cycleOverrides: { includedRowsManifest: undefined },
    rows: [{ name: DR_PRODUCT, orderNumber: ORDER_A, quantity: 1 }],
    timeline: [],
  });
  await assert.rejects(
    () => (async () => (await harness.ready).service.createValidationPreview(PROCESSING_RECORD_ID))(),
    (error) => error.statusCode === 409
      && error.details?.code === "ADASMART_INCLUDED_ROWS_MANIFEST_MISSING",
  );
});

test("rejects a source generated file owned by another processing record", async () => {
  const harness = createHarness({
    rows: [{ name: DR_PRODUCT, orderNumber: ORDER_A, quantity: 1 }],
    sourceFileProcessingRecordId: "99999999-9999-4999-8999-999999999999",
    timeline: [timelineOrder(ORDER_A, [{ name: DR_PRODUCT, quantity: 1, variant: "" }])],
  });

  await assert.rejects(
    () => (async () => (await harness.ready).service.createValidationPreview(PROCESSING_RECORD_ID))(),
    (error) => error.statusCode === 404,
  );
  assert.equal(harness.queueCalls, 0);
});

test("blocks missing and ambiguous barcodes while exposing only safe lines", async () => {
  const baseRows = [{ name: DR_PRODUCT, orderNumber: ORDER_A, quantity: 1 }];
  const baseTimeline = [timelineOrder(ORDER_A, [{ name: DR_PRODUCT, quantity: 1, variant: "" }])];
  const missing = createHarness({ records: [], rows: baseRows, timeline: baseTimeline });
  const missingPreview = await (await missing.ready).service.createValidationPreview(PROCESSING_RECORD_ID);
  assert.equal(missingPreview.orders[0].status, "barcode_missing");
  assert.deepEqual(missingPreview.orders[0].safeLines, []);

  const ambiguous = createHarness({
    records: [erpRecord("IC-005998", ["8850000000001", "8850000000002"])],
    rows: baseRows,
    timeline: baseTimeline,
  });
  const ambiguousPreview = await (await ambiguous.ready).service.createValidationPreview(PROCESSING_RECORD_ID);
  assert.equal(ambiguousPreview.orders[0].status, "barcode_ambiguous");
  assert.deepEqual(ambiguousPreview.orders[0].safeLines, []);
});

test("blocks timeline order missing and timeline line mismatch", async () => {
  const rows = [
    { name: DR_PRODUCT, orderNumber: ORDER_A, quantity: 1 },
    { name: DR_PRODUCT, orderNumber: ORDER_B, quantity: 2 },
  ];
  const harness = createHarness({
    rows,
    timeline: [timelineOrder(ORDER_B, [{ name: DR_PRODUCT, quantity: 1, variant: "" }])],
  });
  const preview = await (await harness.ready).service.createValidationPreview(PROCESSING_RECORD_ID);
  const statuses = Object.fromEntries(preview.orders.map((order) => [order.orderNumber, order.status]));
  assert.equal(statuses[ORDER_A], "timeline_order_missing");
  assert.equal(statuses[ORDER_B], "timeline_line_mismatch");
});

test("PII from source or dependency objects never appears in preview or console output", async () => {
  const pii = ["PRIVATE BUYER", "0899999999", "PRIVATE ADDRESS", "TRACK-SECRET"];
  const calls = [];
  const originalMethods = { error: console.error, log: console.log, warn: console.warn };
  console.error = (...args) => calls.push(args.join(" "));
  console.log = (...args) => calls.push(args.join(" "));
  console.warn = (...args) => calls.push(args.join(" "));
  try {
    const rows = [{
      buyer: pii[0],
      name: DR_PRODUCT,
      orderNumber: ORDER_A,
      phone: pii[1],
      quantity: 1,
    }];
    const harness = createHarness({
      rows,
      timeline: [timelineOrder(ORDER_A, [{
        address: pii[2],
        name: DR_PRODUCT,
        quantity: 1,
        trackingNumber: pii[3],
        variant: "",
      }])],
    });
    const preview = await (await harness.ready).service.createValidationPreview(PROCESSING_RECORD_ID);
    const combined = `${JSON.stringify(preview)} ${calls.join(" ")}`;
    pii.forEach((secret) => assert.doesNotMatch(combined, new RegExp(secret)));
  } finally {
    Object.assign(console, originalMethods);
  }
});

test("confirmation rejects stale digests and queue-disabled mode before persistence", async () => {
  const rows = [{ name: DR_PRODUCT, orderNumber: ORDER_A, quantity: 1 }];
  const timelineItems = [{ name: DR_PRODUCT, quantity: 1, variant: "" }];
  const timeline = [timelineOrder(ORDER_A, timelineItems)];
  const enabled = createHarness({ rows, timeline });
  const enabledService = (await enabled.ready).service;
  const reviewedPreview = await enabledService.createValidationPreview(PROCESSING_RECORD_ID);
  const repeatedPreview = await enabledService.createValidationPreview(PROCESSING_RECORD_ID);
  assert.equal(reviewedPreview.planDigest, repeatedPreview.planDigest);
  await assert.rejects(
    () => enabledService.confirmDryRunQueue(PROCESSING_RECORD_ID, "a".repeat(64)),
    (error) => error.statusCode === 409 && error.details?.code === "ADASMART_PLAN_STALE",
  );
  timelineItems[0].quantity = 2;
  await assert.rejects(
    () => enabledService.confirmDryRunQueue(PROCESSING_RECORD_ID, reviewedPreview.planDigest),
    (error) => error.statusCode === 409 && error.details?.code === "ADASMART_PLAN_STALE",
  );
  assert.equal(enabled.queueCalls, 0);

  const disabled = createHarness({ queueEnabled: false, rows, timeline });
  await assert.rejects(
    () => (async () => (await disabled.ready).service.confirmDryRunQueue(
      PROCESSING_RECORD_ID,
      "a".repeat(64),
    ))(),
    (error) => error.statusCode === 503
      && error.details?.code === "ADASMART_SHOPEE_QUEUE_DISABLED",
  );
  assert.equal(disabled.queueCalls, 0);
});

test("confirmation forwards the named human actor and digested customer identity", async () => {
  const rows = [{ name: DR_PRODUCT, orderNumber: ORDER_A, quantity: 1 }];
  const harness = createHarness({
    rows,
    timeline: [timelineOrder(ORDER_A, [{ name: DR_PRODUCT, quantity: 1, variant: "" }])],
  });
  const service = (await harness.ready).service;
  const preview = await service.createValidationPreview(PROCESSING_RECORD_ID);

  assert.equal(preview.policies.customerCode, "CUS-SHOPEE-004");
  assert.equal(preview.policies.customerPolicyKey, "branch-004:shopee-credit-customer");
  const result = await service.confirmDryRunQueue(
    PROCESSING_RECORD_ID,
    preview.planDigest,
    { actor: "root-admin", authSource: "admin_basic" },
  );

  assert.equal(result.createdCount, 1);
  assert.equal(harness.queueCalls, 1);
  assert.deepEqual(harness.queuedConfirmation, {
    actor: "root-admin",
    authSource: "admin_basic",
  });
});

test("Timeline revision changes invalidate a plan even when line reconciliation stays ready", async () => {
  const rows = [{ name: DR_PRODUCT, orderNumber: ORDER_A, quantity: 1 }];
  const timeline = [timelineOrder(ORDER_A, [{ name: DR_PRODUCT, quantity: 1, variant: "" }])];
  const harness = createHarness({ rows, timeline });
  const service = (await harness.ready).service;
  const first = await service.createValidationPreview(PROCESSING_RECORD_ID);
  assert.equal(first.summary.readyCount, 1);

  timeline[0].currentStatus = "shipment_due";
  timeline[0].lastEventAt = "2026-08-28T05:00:00.000Z";
  const changed = await service.createValidationPreview(PROCESSING_RECORD_ID);
  assert.equal(changed.summary.readyCount, 1);
  assert.notEqual(changed.timeline.sourceDigest, first.timeline.sourceDigest);
  assert.notEqual(changed.planDigest, first.planDigest);
});

test("an ineligible or unrevisioned accounting cycle is blocked", async () => {
  const rows = [{ name: DR_PRODUCT, orderNumber: ORDER_A, quantity: 1 }];
  const timeline = [timelineOrder(ORDER_A, [{ name: DR_PRODUCT, quantity: 1, variant: "" }])];
  const harness = createHarness({
    cycleOverrides: { checkpointEligible: false, cycleContractRevision: "" },
    rows,
    timeline,
  });
  const preview = await (await harness.ready).service.createValidationPreview(PROCESSING_RECORD_ID);
  assert.equal(preview.orders[0].status, "cycle_not_eligible");
  assert.equal(preview.canConfirmDryRun, false);
});

test("duplicate effects and missing customer policy fail closed", async () => {
  const rows = [{ name: DR_PRODUCT, orderNumber: ORDER_A, quantity: 1 }];
  const timeline = [timelineOrder(ORDER_A, [{ name: DR_PRODUCT, quantity: 1, variant: "" }])];
  const duplicate = createHarness({
    existingEffects: [{
      effectKey: JSON.stringify(["004", "dr-morepen", ORDER_A, "standard_credit_quotation"]),
    }],
    rows,
    timeline,
  });
  const duplicatePreview = await (await duplicate.ready).service.createValidationPreview(PROCESSING_RECORD_ID);
  assert.equal(duplicatePreview.orders[0].status, "duplicate_effect");

  const noCustomer = createHarness({ customerPolicy: { approved: false, revision: null }, rows, timeline });
  const noCustomerPreview = await (await noCustomer.ready).service.createValidationPreview(PROCESSING_RECORD_ID);
  assert.equal(noCustomerPreview.orders[0].status, "customer_policy_missing");
  assert.equal(noCustomerPreview.canConfirmDryRun, false);

  const incompleteCustomer = createHarness({
    customerPolicy: { approved: true, revision: "revision-without-canonical-customer" },
    rows,
    timeline,
  });
  const incompletePreview = await (await incompleteCustomer.ready).service
    .createValidationPreview(PROCESSING_RECORD_ID);
  assert.equal(incompletePreview.orders[0].status, "customer_policy_missing");
  assert.equal(incompletePreview.policies.customerCode, null);
});

test("queue contract uses effect-level uniqueness and ON CONFLICT idempotency", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const migration = fs.readFileSync(path.join(
    __dirname,
    "../src/modules/seamless/db/migrations/012_adasmart_shopee_dry_run_queue.sql",
  ), "utf8");
  const repository = fs.readFileSync(path.join(
    __dirname,
    "../src/modules/seamless/db/adaSmartShopeeJobRepository.js",
  ), "utf8");
  assert.match(migration, /UNIQUE \(branch_code, shop_code, order_number, document_type\)/u);
  assert.match(migration, /customer_policy_key text NOT NULL/u);
  assert.match(migration, /customer_code text NOT NULL/u);
  assert.match(migration, /customer_policy_revision text NOT NULL\s+CHECK/u);
  assert.match(migration, /confirmed_by text NOT NULL/u);
  assert.match(migration, /confirmation_auth_source text NOT NULL/u);
  assert.match(migration, /actor text NOT NULL/u);
  assert.match(migration, /auth_source text NOT NULL/u);
  assert.match(repository, /ON CONFLICT \(branch_code, shop_code, order_number, document_type\) DO NOTHING/u);
  assert.doesNotMatch(repository, /AdaSmart\.exe|Save|AdaAcc/u);
});

test("admin-only controller accepts only processingRecordId for preview", async () => {
  let previewCalls = 0;
  let confirmCalls = 0;
  let receivedConfirmation = null;
  const controller = createAdaSmartShopeeController({
    async confirmDryRunQueue(_processingRecordId, _planDigest, confirmation) {
      confirmCalls += 1;
      receivedConfirmation = confirmation;
      return { ok: true };
    },
    async createValidationPreview(processingRecordId) {
      previewCalls += 1;
      return { planDigest: "a".repeat(64), processing: { processingRecordId } };
    },
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.appRole = req.get("x-test-role") || "user";
    req.appAuthSource = req.get("x-test-auth-source") || "basic_user";
    req.appActor = req.get("x-test-actor") || "";
    next();
  });
  app.post("/api/app/shopee/adasmart/validation-preview", controller.createValidationPreview);
  app.post("/api/app/shopee/adasmart/confirm", controller.confirmDryRunQueue);
  app.use(errorHandler);

  const denied = await request(app)
    .post("/api/app/shopee/adasmart/validation-preview")
    .set("x-test-role", "user")
    .send({ processingRecordId: PROCESSING_RECORD_ID });
  assert.equal(denied.status, 403);
  assert.equal(previewCalls, 0);

  const extraInput = await request(app)
    .post("/api/app/shopee/adasmart/validation-preview")
    .set("x-test-role", "admin")
    .set("x-test-auth-source", "admin_basic")
    .send({ processingRecordId: PROCESSING_RECORD_ID, shopCode: "dr-morepen" });
  assert.equal(extraInput.status, 400);
  assert.equal(previewCalls, 0);

  const allowed = await request(app)
    .post("/api/app/shopee/adasmart/validation-preview")
    .set("x-test-role", "admin")
    .set("x-test-auth-source", "admin_basic")
    .send({ processingRecordId: PROCESSING_RECORD_ID });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers["cache-control"], "no-store");
  assert.equal(previewCalls, 1);

  const defaultOpen = await request(app)
    .post("/api/app/shopee/adasmart/validation-preview")
    .set("x-test-role", "admin")
    .set("x-test-auth-source", "local_default_open")
    .send({ processingRecordId: PROCESSING_RECORD_ID });
  assert.equal(defaultOpen.status, 403);
  assert.equal(previewCalls, 1);

  const internalPreview = await request(app)
    .post("/api/app/shopee/adasmart/validation-preview")
    .set("x-test-role", "admin")
    .set("x-test-auth-source", "internal_token")
    .send({ processingRecordId: PROCESSING_RECORD_ID });
  const internalConfirm = await request(app)
    .post("/api/app/shopee/adasmart/confirm")
    .set("x-test-role", "admin")
    .set("x-test-auth-source", "internal_token")
    .send({ planDigest: "a".repeat(64), processingRecordId: PROCESSING_RECORD_ID });
  assert.equal(internalPreview.status, 403);
  assert.equal(internalConfirm.status, 403);
  assert.equal(confirmCalls, 0);

  const allowedConfirm = await request(app)
    .post("/api/app/shopee/adasmart/confirm")
    .set("x-test-role", "admin")
    .set("x-test-auth-source", "admin_basic")
    .set("x-test-actor", "root-admin")
    .send({ planDigest: "a".repeat(64), processingRecordId: PROCESSING_RECORD_ID });
  assert.equal(allowedConfirm.status, 200);
  assert.equal(confirmCalls, 1);
  assert.deepEqual(receivedConfirmation, { actor: "root-admin", authSource: "admin_basic" });
});
