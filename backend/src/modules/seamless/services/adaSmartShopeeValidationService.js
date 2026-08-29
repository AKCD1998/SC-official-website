const crypto = require("node:crypto");
const ExcelJS = require("exceljs");
const processingRecords = require("../processingRecords");
const generatedFileRepository = require("../db/generatedFileRepository");
const shopeeOrderRepository = require("../db/shopeeOrderRepository");
const adaSmartJobRepository = require("../db/adaSmartShopeeJobRepository");
const { readAdaSmartShopeeConfig } = require("../config");
const {
  badRequest,
  conflict,
  notFound,
  serviceUnavailable,
} = require("../errors");
const {
  normalizeShopeeOrderNumber,
} = require("../shopeeOrderValidation");
const {
  CYCLE_CONTRACT_REVISION,
  SHOPEE_CANCELLED_STATUS,
} = require("./shopeeAccountingCycles");
const {
  getShopeeProductCatalogDigest,
  getShopeeProductCatalogSummary,
  matchShopeeProduct,
  normalizeShopeeProductText,
} = require("./shopeeProductMatcher");
const {
  getShopeeShopProfile,
  normalizeShopeeShopCode,
} = require("./shopeeShops");
const {
  findShopeeHeader,
  SOURCE_HEADERS,
} = require("./shopeeWorkbookTransform");
const {
  buildIncludedRowsManifest,
  includedRowsManifestsEqual,
  parseIncludedRowsManifest,
} = require("./shopeeIncludedRowsManifest");
const {
  resolveCompanySkusAgainstErp,
} = require("./erpProductCatalogVerifier");
const {
  readStoredFile,
  sha256,
} = require("./fileStorageService");

const BRANCH_CODE = "004";
const DOCUMENT_TYPE = "standard_credit_quotation";
const PLAN_SCHEMA_VERSION = 2;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const BARCODE_PATTERN = /^[0-9]{6,32}$/u;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const CUSTOMER_POLICY_MISSING = Object.freeze({
  approved: false,
  customerCode: null,
  policyKey: null,
  revision: null,
});
const EMPTY_ERP_SOURCE_CHECKSUM = crypto.createHash("sha256").update("[]").digest("hex");

const BLOCK_REASON_PRIORITY = Object.freeze([
  "timeline_order_missing",
  "timeline_line_mismatch",
  "unmapped_product",
  "visibility_only",
  "bundle_requires_validation",
  "excel_catalog_sku_conflict",
  "barcode_missing",
  "barcode_ambiguous",
  "duplicate_effect",
  "customer_policy_missing",
  "cycle_not_eligible",
]);

function normalizeCellText(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text.normalize("NFKC").trim();
    if (Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text || "").join("").normalize("NFKC").trim();
    }
    if (Object.prototype.hasOwnProperty.call(value, "result")) {
      return normalizeCellText(value.result);
    }
  }
  return String(value).normalize("NFKC").trim();
}

function normalizeCompanySku(value) {
  return normalizeCellText(value).toUpperCase();
}

function parseStrictQuantity(value, sourceRowNumber) {
  let parsed = null;
  if (typeof value === "number") {
    parsed = value;
  } else {
    const normalized = normalizeCellText(value).replace(/,/gu, "");
    if (/^[0-9]+$/u.test(normalized)) parsed = Number(normalized);
  }
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw badRequest(
      `AdaSmart validation requires a positive integer quantity on source row ${sourceRowNumber}.`,
      { code: "ADASMART_QUANTITY_INVALID", sourceRowNumber },
    );
  }
  return parsed;
}

async function readAdaSmartSourceRows(buffer, includedRowsManifest) {
  const verifiedManifest = parseIncludedRowsManifest(includedRowsManifest);
  if (!verifiedManifest) {
    throw conflict("Stored Shopee included-row manifest is missing or invalid.", {
      code: "ADASMART_INCLUDED_ROWS_MANIFEST_MISSING",
    });
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets.find((candidate) => findShopeeHeader(candidate));
  if (!worksheet) {
    throw badRequest("The stored source is not a strict Shopee Order.all workbook.", {
      code: "ADASMART_SOURCE_HEADERS_INVALID",
    });
  }

  const header = findShopeeHeader(worksheet);
  const columns = Object.fromEntries(
    Object.entries(SOURCE_HEADERS).map(([key, label]) => [key, header.indexes.get(label)]),
  );
  const requestedSourceRows = new Set(verifiedManifest.sourceRowNumbers);
  const rows = [];

  for (let rowNumber = header.rowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    // Apply the immutable accounting selection before strict business validation. An invalid
    // value on a carryover/out-of-cycle row must not block this cycle or re-enter the plan.
    if (!requestedSourceRows.has(rowNumber)) continue;
    const row = worksheet.getRow(rowNumber);
    const rawOrderNumber = normalizeCellText(row.getCell(columns.orderNumber).value);
    if (!rawOrderNumber) continue;
    const orderNumber = normalizeShopeeOrderNumber(rawOrderNumber);
    const status = normalizeCellText(row.getCell(columns.status).value);
    const productName = normalizeCellText(row.getCell(columns.productName).value);
    if (!orderNumber || !status || !productName) {
      throw badRequest(`AdaSmart validation found incomplete business identity on source row ${rowNumber}.`, {
        code: "ADASMART_SOURCE_ROW_INVALID",
        sourceRowNumber: rowNumber,
      });
    }
    rows.push({
      excelSku: normalizeCompanySku(row.getCell(columns.sku).value),
      orderNumber,
      productName,
      quantity: parseStrictQuantity(row.getCell(columns.quantity).value, rowNumber),
      sourceRowNumber: rowNumber,
      status,
      variant: normalizeCellText(row.getCell(columns.variation).value),
    });
  }

  if (rows.length !== verifiedManifest.rowCount) {
    throw conflict("Stored Shopee source no longer contains every included accounting row.", {
      code: "ADASMART_INCLUDED_ROWS_MISSING",
    });
  }
  const recomputedManifest = buildIncludedRowsManifest(rows);
  if (!includedRowsManifestsEqual(recomputedManifest, verifiedManifest)) {
    throw conflict("Stored Shopee included-row digest does not match the accounting transform.", {
      code: "ADASMART_INCLUDED_ROWS_DIGEST_CONFLICT",
    });
  }
  return rows;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalDigest(value) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function normalizeCustomerPolicy(value) {
  const clean = (candidate, maxLength) => {
    const text = String(candidate || "").normalize("NFKC").trim();
    return text && text.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(text) ? text : null;
  };
  const customerCode = clean(value?.customerCode, 100);
  const policyKey = clean(value?.policyKey, 160);
  const revision = clean(value?.revision, 160);
  const approved = value?.approved === true && Boolean(customerCode && policyKey && revision);
  return approved
    ? { approved: true, customerCode, policyKey, revision }
    : CUSTOMER_POLICY_MISSING;
}

function requireConfirmationContext(value) {
  const actor = String(value?.actor || "").normalize("NFKC").trim();
  const authSource = String(value?.authSource || "").trim();
  if (!actor || actor.length > 128 || /[\u0000-\u001f\u007f]/u.test(actor)
    || !["session", "admin_basic"].includes(authSource)) {
    throw badRequest("AdaSmart confirmation requires a named human admin identity.", {
      code: "ADASMART_CONFIRMATION_ACTOR_INVALID",
    });
  }
  return { actor, authSource };
}

function groupSourceRows(rows) {
  const grouped = new Map();
  rows.forEach((row) => {
    const existing = grouped.get(row.orderNumber) || [];
    existing.push(row);
    grouped.set(row.orderNumber, existing);
  });
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([orderNumber, orderRows]) => ({ orderNumber, rows: orderRows }));
}

function matchSignature(match) {
  if (match?.status === "matched") return `matched:${normalizeCompanySku(match.companySku)}`;
  if (match?.status === "bundle") {
    const components = (match.components || [])
      .map((component) => `${normalizeCompanySku(component.companySku)}:${component.quantityPerSale}`)
      .sort()
      .join(",");
    return `bundle:${match.quantityRuleStatus || "requires_validation"}:${components}`;
  }
  return `${match?.status || "unmapped"}:${match?.reasonCode || "unknown"}`;
}

function lineIdentity(item, match) {
  const quantity = Number(item?.quantity);
  if (!Number.isSafeInteger(quantity) || quantity < 1) return "";
  return JSON.stringify([
    normalizeShopeeProductText(item?.productName ?? item?.name),
    normalizeShopeeProductText(item?.variant),
    quantity,
    matchSignature(match),
  ]);
}

function lineMultiset(items, shopCode, source = false) {
  const multiset = new Map();
  for (const item of items) {
    const productItem = source
      ? { name: item.productName, variant: item.variant }
      : item;
    const match = matchShopeeProduct(shopCode, productItem);
    const key = lineIdentity(item, match);
    if (!key) return null;
    multiset.set(key, (multiset.get(key) || 0) + 1);
  }
  return multiset;
}

function multisetsEqual(left, right) {
  if (!left || !right || left.size !== right.size) return false;
  return [...left.entries()].every(([key, count]) => right.get(key) === count);
}

function addReason(order, reason) {
  if (!order._blockReasons.includes(reason)) order._blockReasons.push(reason);
}

function analyzeProductContributions(order, shopCode) {
  order.rows.forEach((row) => {
    const match = matchShopeeProduct(shopCode, {
      name: row.productName,
      variant: row.variant,
    });

    if (match.status === "unmapped") {
      addReason(order, "unmapped_product");
      return;
    }
    if (match.status === "visibility_only") {
      addReason(order, "visibility_only");
      return;
    }
    if (match.status === "bundle") {
      const validComponents = (match.components || []).every((component) => (
        normalizeCompanySku(component.companySku)
        && Number.isSafeInteger(component.quantityPerSale)
        && component.quantityPerSale > 0
      ));
      if (match.quantityRuleStatus !== "verified" || !validComponents) {
        addReason(order, "bundle_requires_validation");
        return;
      }
      if (row.excelSku) {
        addReason(order, "excel_catalog_sku_conflict");
        return;
      }
      match.components.forEach((component) => {
        order._contributions.push({
          companySku: normalizeCompanySku(component.companySku),
          quantity: row.quantity * component.quantityPerSale,
        });
      });
      return;
    }

    const companySku = normalizeCompanySku(match.companySku);
    if (row.excelSku && row.excelSku !== companySku) {
      addReason(order, "excel_catalog_sku_conflict");
      return;
    }
    order._contributions.push({ companySku, quantity: row.quantity });
  });
}

function aggregateContributions(contributions) {
  const totals = new Map();
  contributions.forEach((line) => {
    const next = (totals.get(line.companySku) || 0) + line.quantity;
    if (!Number.isSafeInteger(next) || next < 1) {
      throw badRequest("AdaSmart validation quantity exceeds the supported integer range.", {
        code: "ADASMART_QUANTITY_OVERFLOW",
      });
    }
    totals.set(line.companySku, next);
  });
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([companySku, quantity]) => ({ companySku, quantity }));
}

function buildPreliminaryOrders(groups, timelineOrders, shopCode) {
  const timelineByOrder = new Map((timelineOrders || []).map((order) => [order.orderNumber, order]));

  return groups.map((group) => {
    const timeline = timelineByOrder.get(group.orderNumber) || null;
    const statuses = new Set(group.rows.map((row) => row.status));
    const sourceCancelled = statuses.size === 1 && statuses.has(SHOPEE_CANCELLED_STATUS);
    const timelineCancelled = timeline?.currentStatus === "order_cancelled";
    const order = {
      orderNumber: group.orderNumber,
      rows: group.rows,
      _blockReasons: [],
      _contributions: [],
      _reconciled: false,
      _cancelled: sourceCancelled || timelineCancelled,
    };

    if (order._cancelled) return order;
    if (statuses.has(SHOPEE_CANCELLED_STATUS)) addReason(order, "timeline_line_mismatch");
    if (!timeline) {
      addReason(order, "timeline_order_missing");
    } else {
      const sourceLines = lineMultiset(group.rows, shopCode, true);
      const timelineLines = lineMultiset(timeline.items || [], shopCode, false);
      order._reconciled = multisetsEqual(sourceLines, timelineLines);
      if (!order._reconciled) addReason(order, "timeline_line_mismatch");
    }

    analyzeProductContributions(order, shopCode);
    return order;
  });
}

function validateTimelineOrders(timelineOrders, shopCode, orderNumbers) {
  if (!Array.isArray(timelineOrders)) {
    throw conflict("Shopee Timeline returned an invalid validation snapshot.", {
      code: "ADASMART_TIMELINE_INVALID",
    });
  }
  const requested = new Set(orderNumbers);
  const seen = new Set();
  timelineOrders.forEach((order) => {
    const orderNumber = normalizeShopeeOrderNumber(order?.orderNumber);
    if (!orderNumber
      || !requested.has(orderNumber)
      || seen.has(orderNumber)
      || normalizeShopeeShopCode(order?.shopCode) !== shopCode) {
      throw conflict("Shopee Timeline identity does not match the stored source.", {
        code: "ADASMART_TIMELINE_IDENTITY_CONFLICT",
      });
    }
    seen.add(orderNumber);
  });
  return timelineOrders;
}

function timelineSnapshotDigest(timelineOrders, shopCode) {
  return canonicalDigest(timelineOrders
    .map((order) => ({
      currentStatus: String(order.currentStatus || ""),
      eventCount: Number(order.eventCount || 0),
      itemLines: (order.items || [])
        .map((item) => lineIdentity(item, matchShopeeProduct(shopCode, item)))
        .sort(),
      lastEventAt: String(order.lastEventAt || ""),
      orderNumber: order.orderNumber,
      shopCode,
    }))
    .sort((left, right) => left.orderNumber.localeCompare(right.orderNumber, "en")));
}

function requireCycleContext(record, sourceUpload) {
  const recordSummary = record?.metadata?.transformSummary || {};
  const uploadSummary = sourceUpload?.uploadTransformSummary || {};
  const keys = ["cycleKey", "periodStart", "periodEnd"];
  keys.forEach((key) => {
    if (!recordSummary[key] || recordSummary[key] !== uploadSummary[key]) {
      throw conflict("Stored Shopee cycle metadata is missing or inconsistent.", {
        code: "ADASMART_CYCLE_IDENTITY_CONFLICT",
      });
    }
  });
  if (!ISO_DATE_PATTERN.test(recordSummary.periodStart)
    || !ISO_DATE_PATTERN.test(recordSummary.periodEnd)
    || recordSummary.periodStart > recordSummary.periodEnd
    || recordSummary.cycleKey !== `${recordSummary.periodStart}_to_${recordSummary.periodEnd}`) {
    throw conflict("Stored Shopee cycle metadata cannot be resolved reliably.", {
      code: "ADASMART_CYCLE_INVALID",
    });
  }

  const recordRevision = String(recordSummary.cycleContractRevision || "").trim();
  const uploadRevision = String(uploadSummary.cycleContractRevision || "").trim();
  if (recordRevision !== uploadRevision) {
    throw conflict("Stored Shopee cycle revisions do not agree.", {
      code: "ADASMART_CYCLE_REVISION_CONFLICT",
    });
  }
  const checkpointEligible = recordSummary.checkpointEligible === true
    && uploadSummary.checkpointEligible === true;
  const recordManifest = parseIncludedRowsManifest(recordSummary.includedRowsManifest);
  const uploadManifest = parseIncludedRowsManifest(uploadSummary.includedRowsManifest);
  if (!recordManifest || !uploadManifest) {
    throw conflict("Stored Shopee included-row manifest is missing or invalid.", {
      code: "ADASMART_INCLUDED_ROWS_MANIFEST_MISSING",
    });
  }
  if (!includedRowsManifestsEqual(recordManifest, uploadManifest)) {
    throw conflict("Stored Shopee included-row manifests do not agree.", {
      code: "ADASMART_INCLUDED_ROWS_MANIFEST_CONFLICT",
    });
  }
  return {
    cycle: {
      checkpointEligible,
      cycleContractRevision: recordRevision || null,
      cycleKey: recordSummary.cycleKey,
      includedRowCount: recordManifest.rowCount,
      includedRowsDigest: recordManifest.contentDigestSha256,
      periodEnd: recordSummary.periodEnd,
      periodStart: recordSummary.periodStart,
    },
    includedRowsManifest: recordManifest,
  };
}

function requireStoredIdentity(processingRecordId, record, sourceUpload, sourceBuffer) {
  if (!record || record.id !== processingRecordId || record.reportType !== "shopee") {
    throw notFound("Shopee source upload was not found for the processing record.");
  }
  if (!sourceUpload
    || sourceUpload.processingRecordId !== processingRecordId
    || sourceUpload.uploadProcessingRecordId !== processingRecordId
    || sourceUpload.uploadRequestedVariant !== "shopee"
    || sourceUpload.uploadStatus !== "processed") {
    throw notFound("Shopee source upload was not found for the processing record.");
  }

  const persistedChecksum = String(sourceUpload.checksumSha256 || "").toLowerCase();
  const computedChecksum = sha256(sourceBuffer).toLowerCase();
  if (!DIGEST_PATTERN.test(persistedChecksum) || persistedChecksum !== computedChecksum) {
    throw conflict("Stored Shopee source checksum validation failed.", {
      code: "ADASMART_SOURCE_CHECKSUM_CONFLICT",
    });
  }

  const shopCandidates = [
    sourceUpload.metadata?.shopCode,
    record.metadata?.shopCode,
    sourceUpload.uploadTransformSummary?.shopCode,
  ].map(normalizeShopeeShopCode);
  if (shopCandidates.some((value) => !value)
    || new Set(shopCandidates).size !== 1) {
    throw conflict("Stored Shopee shop identity is missing or inconsistent.", {
      code: "ADASMART_SHOP_IDENTITY_CONFLICT",
    });
  }

  const transformContext = requireCycleContext(record, sourceUpload);
  return {
    cycle: transformContext.cycle,
    includedRowsManifest: transformContext.includedRowsManifest,
    processing: {
      processingRecordId,
      sourceChecksumSha256: persistedChecksum,
      sourceUploadId: sourceUpload.id,
      uploadId: sourceUpload.uploadId,
    },
    shopCode: shopCandidates[0],
  };
}

async function defaultLoadStoredContext(processingRecordId) {
  const [record, sourceUpload] = await Promise.all([
    processingRecords.getProcessingRecordById(processingRecordId),
    generatedFileRepository.findSourceUploadByProcessingRecordId(processingRecordId),
  ]);
  if (!sourceUpload) throw notFound("Shopee source upload was not found for the processing record.");
  const sourceBuffer = await readStoredFile(
    sourceUpload.storageProvider,
    sourceUpload.storagePath,
    sourceUpload.metadata?.storageBucket || undefined,
  );
  return { record, sourceBuffer, sourceUpload };
}

async function defaultResolveErpProducts(companySkus) {
  const config = readAdaSmartShopeeConfig();
  if (!config.erpProductCatalogResolveUrl || !config.erpProductCatalogToken) {
    throw serviceUnavailable("ERP product catalog integration is not configured for AdaSmart validation.", {
      code: "ADASMART_ERP_CATALOG_UNAVAILABLE",
    });
  }
  return resolveCompanySkusAgainstErp({
    companySkus,
    internalToken: config.erpProductCatalogToken,
    resolveUrl: config.erpProductCatalogResolveUrl,
  });
}

function getDefaultCustomerPolicy() {
  // No customer code or customer-selection policy is approved for Branch 004 yet. Do not infer
  // one from another branch, a workbook, AdaSmart UI, or environment configuration.
  return CUSTOMER_POLICY_MISSING;
}

function validateErpResolution(resolution, requestedSkus) {
  if (!resolution || !DIGEST_PATTERN.test(String(resolution.sourceChecksum || ""))) {
    throw serviceUnavailable("ERP product catalog returned no verifiable checksum.", {
      code: "ADASMART_ERP_CATALOG_INVALID",
    });
  }
  const requested = new Set(requestedSkus);
  const records = new Map();
  for (const record of resolution.records || []) {
    const companySku = normalizeCompanySku(record.companySku);
    if (!requested.has(companySku) || records.has(companySku)) {
      throw serviceUnavailable("ERP product catalog returned an invalid Company SKU set.", {
        code: "ADASMART_ERP_CATALOG_INVALID",
      });
    }
    records.set(companySku, {
      barcodes: Array.isArray(record.barcodes)
        ? [...new Set(record.barcodes.map((barcode) => normalizeCellText(barcode)).filter(Boolean))].sort()
        : [],
      companySku,
    });
  }
  return { records, sourceChecksum: String(resolution.sourceChecksum) };
}

function finalizeOrders({
  cycleEligible,
  customerPolicy,
  erpRecords,
  existingEffects,
  orders,
  shopCode,
}) {
  const existingKeys = new Set((existingEffects || []).map((effect) => effect.effectKey));
  const barcodeOwners = new Map();

  orders.forEach((order) => {
    order._aggregated = order._reconciled && !order._cancelled
      ? aggregateContributions(order._contributions)
      : [];
    order._aggregated.forEach((line) => {
      const record = erpRecords.get(line.companySku);
      if (record?.barcodes?.length === 1 && BARCODE_PATTERN.test(record.barcodes[0])) {
        const owners = barcodeOwners.get(record.barcodes[0]) || new Set();
        owners.add(line.companySku);
        barcodeOwners.set(record.barcodes[0], owners);
      }
    });
  });

  return orders.map((order) => {
    if (order._cancelled) {
      return { blockReasons: [], orderNumber: order.orderNumber, safeLines: [], status: "cancelled" };
    }

    const safeLines = [];
    order._aggregated.forEach((line) => {
      const record = erpRecords.get(line.companySku);
      if (!record || record.barcodes.length === 0) {
        addReason(order, "barcode_missing");
        return;
      }
      if (record.barcodes.length !== 1
        || !BARCODE_PATTERN.test(record.barcodes[0])
        || barcodeOwners.get(record.barcodes[0])?.size !== 1) {
        addReason(order, "barcode_ambiguous");
        return;
      }
      safeLines.push({
        barcode: record.barcodes[0],
        companySku: line.companySku,
        quantity: line.quantity,
      });
    });

    if (existingKeys.has(adaSmartJobRepository.effectKey(shopCode, order.orderNumber))) {
      addReason(order, "duplicate_effect");
    }
    if (!customerPolicy.approved || !String(customerPolicy.revision || "").trim()) {
      addReason(order, "customer_policy_missing");
    }
    if (!cycleEligible) addReason(order, "cycle_not_eligible");

    const blockReasons = BLOCK_REASON_PRIORITY.filter((reason) => order._blockReasons.includes(reason));
    return {
      blockReasons,
      orderNumber: order.orderNumber,
      safeLines,
      status: blockReasons[0] || "ready",
    };
  });
}

function summarizeOrders(orders) {
  const blockedByReason = {};
  orders.forEach((order) => {
    order.blockReasons.forEach((reason) => {
      blockedByReason[reason] = (blockedByReason[reason] || 0) + 1;
    });
  });
  const readyCount = orders.filter((order) => order.status === "ready").length;
  const cancelledCount = orders.filter((order) => order.status === "cancelled").length;
  return {
    blockedByReason,
    blockedCount: orders.length - readyCount - cancelledCount,
    cancelledCount,
    readyCount,
    totalOrderCount: orders.length,
  };
}

function createAdaSmartShopeeValidationService(overrides = {}) {
  const dependencies = {
    findExistingEffects: adaSmartJobRepository.listExistingEffects,
    getCustomerPolicy: getDefaultCustomerPolicy,
    getQueueEnabled: () => readAdaSmartShopeeConfig().queueEnabled,
    getTimelineOrders: shopeeOrderRepository.findOrdersForAdaSmartValidation,
    loadStoredContext: defaultLoadStoredContext,
    queueDryRunPlan: adaSmartJobRepository.queueDryRunPlan,
    resolveErpProducts: defaultResolveErpProducts,
    ...overrides,
  };

  async function createValidationPreview(processingRecordId) {
    const stored = await dependencies.loadStoredContext(processingRecordId);
    const identity = requireStoredIdentity(
      processingRecordId,
      stored.record,
      stored.sourceUpload,
      stored.sourceBuffer,
    );
    const sourceRows = await readAdaSmartSourceRows(
      stored.sourceBuffer,
      identity.includedRowsManifest,
    );
    const grouped = groupSourceRows(sourceRows);
    const orderNumbers = grouped.map((group) => group.orderNumber);
    const [timelineOrders, existingEffects, customerPolicy, queueEnabled] = await Promise.all([
      dependencies.getTimelineOrders(identity.shopCode, orderNumbers),
      dependencies.findExistingEffects(identity.shopCode, orderNumbers),
      dependencies.getCustomerPolicy({ branchCode: BRANCH_CODE, shopCode: identity.shopCode }),
      dependencies.getQueueEnabled(),
    ]);
    const verifiedTimelineOrders = validateTimelineOrders(
      timelineOrders,
      identity.shopCode,
      orderNumbers,
    );
    const preliminary = buildPreliminaryOrders(grouped, verifiedTimelineOrders, identity.shopCode);
    const timelineDigest = timelineSnapshotDigest(verifiedTimelineOrders, identity.shopCode);
    const requestedSkus = [...new Set(preliminary
      .filter((order) => order._reconciled && !order._cancelled)
      .flatMap((order) => order._contributions.map((line) => line.companySku)))]
      .sort((left, right) => left.localeCompare(right, "en"));
    let erpSourceChecksum = EMPTY_ERP_SOURCE_CHECKSUM;
    let erpRecords = new Map();
    if (requestedSkus.length) {
      const verified = validateErpResolution(
        await dependencies.resolveErpProducts(requestedSkus),
        requestedSkus,
      );
      erpSourceChecksum = verified.sourceChecksum;
      erpRecords = verified.records;
    }

    const verifiedCustomerPolicy = normalizeCustomerPolicy(customerPolicy);
    const cycleEligible = identity.cycle.checkpointEligible
      && identity.cycle.cycleContractRevision === CYCLE_CONTRACT_REVISION;
    const orders = finalizeOrders({
      cycleEligible,
      customerPolicy: verifiedCustomerPolicy,
      erpRecords,
      existingEffects,
      orders: preliminary,
      shopCode: identity.shopCode,
    });
    const summary = summarizeOrders(orders);
    const catalogSummary = getShopeeProductCatalogSummary();
    const hasCriticalPolicyGap = !verifiedCustomerPolicy.approved
      || !cycleEligible;
    const digestPayload = {
      branchCode: BRANCH_CODE,
      catalog: {
        catalogDigest: getShopeeProductCatalogDigest(),
        catalogVersion: catalogSummary.catalogVersion,
        erpSourceChecksum,
      },
      cycle: identity.cycle,
      documentType: DOCUMENT_TYPE,
      dryRunOnly: true,
      hasCriticalPolicyGap,
      orders,
      policies: {
        customerCode: verifiedCustomerPolicy.customerCode,
        customerPolicyKey: verifiedCustomerPolicy.policyKey,
        customerPolicyRevision: verifiedCustomerPolicy.revision,
        customerPolicyStatus: verifiedCustomerPolicy.approved ? "approved" : "missing",
      },
      processing: identity.processing,
      queue: { enabled: Boolean(queueEnabled), mode: "dry_run" },
      schemaVersion: PLAN_SCHEMA_VERSION,
      shop: {
        code: identity.shopCode,
        displayName: getShopeeShopProfile(identity.shopCode).displayName,
      },
      summary,
      timeline: {
        matchedOrderCount: verifiedTimelineOrders.length,
        sourceDigest: timelineDigest,
      },
    };
    const planDigest = canonicalDigest(digestPayload);
    return {
      ...digestPayload,
      canConfirmDryRun: Boolean(queueEnabled) && summary.readyCount > 0 && !hasCriticalPolicyGap,
      generatedAt: new Date().toISOString(),
      planDigest,
    };
  }

  async function confirmDryRunQueue(processingRecordId, suppliedPlanDigest, confirmation) {
    if (!await dependencies.getQueueEnabled()) {
      throw serviceUnavailable("AdaSmart Shopee dry-run queue is disabled.", {
        code: "ADASMART_SHOPEE_QUEUE_DISABLED",
      });
    }
    const preview = await createValidationPreview(processingRecordId);
    const supplied = String(suppliedPlanDigest || "").trim().toLowerCase();
    if (!DIGEST_PATTERN.test(supplied) || supplied !== preview.planDigest) {
      throw conflict("AdaSmart validation plan is stale; create a new preview.", {
        code: "ADASMART_PLAN_STALE",
      });
    }
    if (!preview.canConfirmDryRun) {
      throw conflict("AdaSmart validation plan is not eligible for dry-run queueing.", {
        code: "ADASMART_PLAN_BLOCKED",
      });
    }

    const confirmationContext = requireConfirmationContext(confirmation);
    const queued = await dependencies.queueDryRunPlan(preview, confirmationContext);
    return {
      branchCode: BRANCH_CODE,
      createdCount: queued.createdCount,
      documentType: DOCUMENT_TYPE,
      dryRun: true,
      duplicateCount: queued.duplicateCount,
      jobs: queued.jobs,
      ok: true,
      status: "queued_dry_run",
    };
  }

  return { confirmDryRunQueue, createValidationPreview };
}

const defaultService = createAdaSmartShopeeValidationService();

module.exports = {
  BLOCK_REASON_PRIORITY,
  BRANCH_CODE,
  DOCUMENT_TYPE,
  canonicalDigest,
  createAdaSmartShopeeValidationService,
  confirmDryRunQueue: defaultService.confirmDryRunQueue,
  createValidationPreview: defaultService.createValidationPreview,
  readAdaSmartSourceRows,
};
