const ExcelJS = require("exceljs");
const path = require("node:path");
const pool = require("../../../../db");
const { appConfig } = require("../appConfig");
const { readR2Config } = require("../config");
const { createBatch, recordBatchResult } = require("../db/batchRepository");
const {
  createGeneratedFile,
  findSourceUploadByChecksum,
  getGeneratedFileById,
  updateGeneratedFile,
} = require("../db/generatedFileRepository");
const { logOperation } = require("../db/operationLogRepository");
const {
  findProcessingRecordByFilename,
  upsertProcessingRecordFromPreview,
} = require("../processingRecords");
const { createPreviewSheet, listPreviewSheets } = require("../db/previewSheetRepository");
const {
  createWorkbookUpload,
  updateWorkbookUpload,
} = require("../db/workbookUploadRepository");
const {
  buildApiUrl,
  readStoredFile,
  sha256,
  writeStoredFile,
} = require("./fileStorageService");
const { buildOutputFilename } = require("./workbookRules");
const {
  copyWorksheet,
  transformWorkbook,
} = require("./workbookTransformService");
const { badRequest, conflict } = require("../errors");
const {
  normalizeBranchCodes,
  normalizeString,
  parseFormatterMode,
} = require("../validators");

const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function validateUploadFile(file) {
  if (!file) {
    throw badRequest("Workbook file is required.");
  }

  const originalFilename = normalizeString(file.originalname);
  if (!/\.xlsx$/i.test(originalFilename)) {
    throw badRequest("Only .xlsx files are supported.");
  }

  if (!file.buffer || !file.buffer.length) {
    throw badRequest("The uploaded workbook is empty.");
  }

  if (file.buffer.length > appConfig.maxUploadBytes) {
    throw badRequest(`The uploaded workbook is too large. The current limit is ${appConfig.maxUploadMb}MB.`);
  }
}

function toBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function nowKeyParts(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  return {
    dateKey: `${year}${month}${day}`,
    timeKey: `${hours}${minutes}${seconds}`,
  };
}

function buildPreviewFilename(formatterMode, batchFileCount) {
  const { dateKey, timeKey } = nowKeyParts();
  const batchMode = Number(batchFileCount) > 1 ? "multi" : "single";

  return {
    filename: `Preview-${formatterMode}-${batchMode}-${dateKey}-${timeKey}.xlsx`,
    batchMode,
  };
}

function baseSheetName(filename) {
  return (
    path
      .basename(String(filename || "Processed workbook"), ".xlsx")
      .replace(/[[\]*/\\?:]/g, "-")
      .trim()
      .slice(0, 80) || "Processed workbook"
  );
}

function buildUniqueSheetName(workbook, filename) {
  const baseName = baseSheetName(filename);
  const existingNames = new Set(workbook.worksheets.map((sheet) => sheet.name));

  if (!existingNames.has(baseName)) {
    return baseName;
  }

  for (let index = 2; index < 1000; index += 1) {
    const suffix = ` (${index})`;
    const candidate = `${baseName.slice(0, 80 - suffix.length)}${suffix}`;
    if (!existingNames.has(candidate)) {
      return candidate;
    }
  }

  return `${baseName.slice(0, 72)} ${Date.now()}`;
}

function reportDateForRecord(filenameResult, outputFilename) {
  return filenameResult.parsedDate || outputFilename;
}

function mergeBranchCodes(existingBranchCodes, nextBranchCode) {
  return normalizeBranchCodes([existingBranchCodes, nextBranchCode].filter(Boolean));
}

function fileDownloadUrl(fileId) {
  return buildApiUrl(`/api/files/${fileId}/download`);
}

async function writeWorkbookToStoredFile(kind, filename, workbook, options) {
  const buffer = toBuffer(await workbook.xlsx.writeBuffer());
  return writeStoredFile(kind, filename, buffer, options);
}

async function loadPreviewWorkbook(previewFile) {
  const workbook = new ExcelJS.Workbook();
  const bucket = previewFile.metadata?.storageBucket || undefined;
  const buffer = await readStoredFile(previewFile.storageProvider, previewFile.storagePath, bucket);
  await workbook.xlsx.load(buffer);
  return workbook;
}

async function createOrUpdatePreview({
  client,
  previewWorkbookId,
  batchId,
  uploadId,
  processingRecordId,
  formatterMode,
  batchFileCount,
  outputFilename,
  sourceWorksheet,
  writeOptions,
}) {
  let previewFile = null;
  let previewWorkbook = null;
  let previewFilename = "";
  let sheetOrder = 1;

  if (previewWorkbookId) {
    previewFile = await getGeneratedFileById(previewWorkbookId, client);
    if (previewFile.fileKind !== "preview_workbook") {
      throw badRequest("previewWorkbookId must point to a preview workbook generated file.");
    }

    previewWorkbook = await loadPreviewWorkbook(previewFile);
    const previewSheets = await listPreviewSheets(previewFile.id, client);
    sheetOrder = previewSheets.length + 1;
    previewFilename = previewFile.filename;
  } else {
    const previewName = buildPreviewFilename(formatterMode, batchFileCount);
    previewFilename = previewName.filename;
    previewWorkbook = new ExcelJS.Workbook();
    previewWorkbook.creator = "Seamless X PERN";
    previewWorkbook.created = new Date();
  }

  const previewSheetName = buildUniqueSheetName(previewWorkbook, outputFilename);
  const previewSheet = copyWorksheet(sourceWorksheet, previewWorkbook, previewSheetName);
  const storedPreview = await writeWorkbookToStoredFile(
    "preview_workbook",
    previewFilename,
    previewWorkbook,
    writeOptions,
  );

  if (previewFile) {
    previewFile = await updateGeneratedFile(
      previewFile.id,
      {
        storageProvider: storedPreview.storageProvider,
        storagePath: storedPreview.storagePath,
        fileSizeBytes: storedPreview.fileSizeBytes,
        checksumSha256: storedPreview.checksumSha256,
      },
      client,
    );
  } else {
    previewFile = await createGeneratedFile(
      {
        batchId,
        uploadId,
        processingRecordId,
        fileKind: "preview_workbook",
        filename: previewFilename,
        mimeType: XLSX_MIME_TYPE,
        storageProvider: storedPreview.storageProvider,
        storagePath: storedPreview.storagePath,
        fileSizeBytes: storedPreview.fileSizeBytes,
        checksumSha256: storedPreview.checksumSha256,
        metadata: {
          formatterMode,
          batchFileCount,
          storageBucket: storedPreview.storageBucket,
        },
      },
      client,
    );
  }

  const url = fileDownloadUrl(previewFile.id);
  previewFile = await updateGeneratedFile(
    previewFile.id,
    {
      downloadUrl: url,
      viewUrl: url,
    },
    client,
  );

  return {
    previewFile,
    previewSheet,
    previewSheetName,
    sheetOrder,
  };
}

async function processSingleWorkbook({
  file,
  formatterMode,
  previewWorkbookId,
  batchId,
  batchFileCount,
}) {
  validateUploadFile(file);

  const requestedVariant = parseFormatterMode(formatterMode, { allowEmpty: false });
  const originalFilename = file.originalname;
  const sourceChecksumSha256 = sha256(file.buffer);
  const client = await pool.connect();
  let activeBatchId = batchId || "";

  try {
    await client.query("BEGIN");

    const duplicateSourceUpload = await findSourceUploadByChecksum(sourceChecksumSha256, client);
    if (duplicateSourceUpload) {
      throw conflict("This workbook was already uploaded previously.", {
        code: "DUPLICATE_UPLOAD",
        checksumSha256: sourceChecksumSha256,
        existingGeneratedFileId: duplicateSourceUpload.id,
        existingOriginalFilename: duplicateSourceUpload.originalFilename || duplicateSourceUpload.filename,
        existingUploadedAt: duplicateSourceUpload.uploadCreatedAt || duplicateSourceUpload.createdAt,
        existingProcessingRecord: duplicateSourceUpload.processingRecordRef,
      });
    }

    const { shopeeBucket } = readR2Config();
    const shopeeStorageOptions =
      requestedVariant === "shopee" && shopeeBucket ? { bucket: shopeeBucket } : undefined;

    const sourceStoredFile = await writeStoredFile(
      "source_upload",
      originalFilename,
      file.buffer,
      shopeeStorageOptions,
    );
    const transformResult = await transformWorkbook(file.buffer, {
      requestedVariant,
      originalFilename,
    });
    const filenameResult = buildOutputFilename(
      transformResult.worksheet,
      originalFilename,
      transformResult.effectiveVariant,
      transformResult.metadata || {},
    );
    const outputFilename = filenameResult.filename;
    const warnings = [...transformResult.warnings, ...filenameResult.warnings];
    const outputBuffer = toBuffer(await transformResult.workbook.xlsx.writeBuffer());
    const processedStoredFile = await writeStoredFile(
      "processed_xlsx",
      outputFilename,
      outputBuffer,
      shopeeStorageOptions,
    );

    if (!activeBatchId) {
      const previewName = buildPreviewFilename(requestedVariant, batchFileCount);
      const batch = await createBatch(
        {
          formatterMode: requestedVariant,
          batchMode: previewName.batchMode,
          status: "processing",
          fileCount: Number(batchFileCount) || 1,
        },
        client,
      );
      activeBatchId = batch.id;
    }

    const upload = await createWorkbookUpload(
      {
        batchId: activeBatchId,
        originalFilename,
        mimeType: file.mimetype || XLSX_MIME_TYPE,
        fileSizeBytes: file.buffer.length,
        requestedVariant,
        status: "processing",
      },
      client,
    );

    await createGeneratedFile(
      {
        batchId: activeBatchId,
        uploadId: upload.id,
        fileKind: "source_upload",
        filename: originalFilename,
        mimeType: file.mimetype || XLSX_MIME_TYPE,
        storageProvider: sourceStoredFile.storageProvider,
        storagePath: sourceStoredFile.storagePath,
        fileSizeBytes: sourceStoredFile.fileSizeBytes,
        checksumSha256: sourceChecksumSha256,
        metadata: {
          importedFrom: "user_upload",
          storageBucket: sourceStoredFile.storageBucket,
        },
      },
      client,
    );

    let processedFile = await createGeneratedFile(
      {
        batchId: activeBatchId,
        uploadId: upload.id,
        fileKind: "processed_xlsx",
        filename: outputFilename,
        mimeType: XLSX_MIME_TYPE,
        storageProvider: processedStoredFile.storageProvider,
        storagePath: processedStoredFile.storagePath,
        fileSizeBytes: processedStoredFile.fileSizeBytes,
        checksumSha256: processedStoredFile.checksumSha256,
        metadata: {
          originalFilename,
          requestedVariant,
          detectedVariant: transformResult.detectedVariant,
          effectiveVariant: transformResult.effectiveVariant,
          deletedColumns: transformResult.deletedColumns,
          highlightCount: transformResult.highlightCount,
          storageBucket: processedStoredFile.storageBucket,
          transformMetadata: transformResult.metadata || {},
        },
      },
      client,
    );
    const processedUrl = fileDownloadUrl(processedFile.id);
    processedFile = await updateGeneratedFile(
      processedFile.id,
      {
        downloadUrl: processedUrl,
        viewUrl: processedUrl,
      },
      client,
    );

    const previewResult = await createOrUpdatePreview({
      client,
      previewWorkbookId,
      batchId: activeBatchId,
      uploadId: upload.id,
      processingRecordId: null,
      formatterMode: requestedVariant,
      batchFileCount,
      outputFilename,
      sourceWorksheet: transformResult.worksheet,
      writeOptions: shopeeStorageOptions,
    });
    const existingRecord = await findProcessingRecordByFilename(previewResult.previewFile.filename, client);
    const branchCodes = mergeBranchCodes(existingRecord && existingRecord.branchCodes, filenameResult.branchCode);
    const registryResult = await upsertProcessingRecordFromPreview(
      {
        filename: previewResult.previewFile.filename,
        reportDate: reportDateForRecord(filenameResult, outputFilename),
        reportType: requestedVariant,
        driveFileId: previewResult.previewFile.id,
        driveFileUrl: previewResult.previewFile.viewUrl || previewResult.previewFile.downloadUrl,
        sourceUploadName: originalFilename,
        notes: "Created by PERN workbook processing.",
        branchCodes,
        metadata: {
          batchId: activeBatchId,
          uploadId: upload.id,
          previewFileId: previewResult.previewFile.id,
          outputFileId: processedFile.id,
          outputFilename,
          outputDownloadUrl: processedFile.downloadUrl,
          detectedVariant: transformResult.detectedVariant,
          effectiveVariant: transformResult.effectiveVariant,
          parsedDate: filenameResult.parsedDate || "",
          rawDateSource: filenameResult.rawDateSource || "",
          rawBranchSource: filenameResult.rawBranchSource || "",
          printPolicy: transformResult.metadata?.printPolicy || "auto",
          transformSummary: transformResult.metadata || {},
        },
      },
      client,
    );

    await updateGeneratedFile(processedFile.id, { processingRecordId: registryResult.record.id }, client);
    await updateWorkbookUpload(
      upload.id,
      {
        processingRecordId: registryResult.record.id,
        detectedVariant: transformResult.detectedVariant,
        effectiveVariant: transformResult.effectiveVariant,
        status: "processed",
        warnings,
        deletedColumns: transformResult.deletedColumns,
        highlightCount: transformResult.highlightCount,
        transformSummary: {
          outputFilename,
          previewSheetName: previewResult.previewSheetName,
          branchCode: filenameResult.branchCode || "",
          parsedDate: filenameResult.parsedDate || "",
          ...(transformResult.metadata || {}),
        },
      },
      client,
    );
    await createPreviewSheet(
      {
        previewFileId: previewResult.previewFile.id,
        uploadId: upload.id,
        processingRecordId: registryResult.record.id,
        sheetName: previewResult.previewSheetName,
        sheetOrder: previewResult.sheetOrder,
        metadata: {
          outputFilename,
        },
      },
      client,
    );
    await recordBatchResult(activeBatchId, { success: true }, client);
    await logOperation(
      {
        action: "workbook_processed",
        message: `Processed ${originalFilename}`,
        processingRecordId: registryResult.record.id,
        batchId: activeBatchId,
        uploadId: upload.id,
        generatedFileId: processedFile.id,
        metadata: {
          outputFilename,
          previewFileId: previewResult.previewFile.id,
          warnings,
        },
      },
      client,
    );

    await client.query("COMMIT");

    return {
      ok: true,
      batchId: activeBatchId,
      filename: outputFilename,
      variant: transformResult.effectiveVariant,
      requestedVariant,
      detectedVariant: transformResult.detectedVariant,
      warnings,
      deletedColumns: transformResult.deletedColumns,
      highlightCount: transformResult.highlightCount,
      driveFileId: processedFile.id,
      downloadUrl: processedFile.downloadUrl,
      viewUrl: processedFile.viewUrl,
      previewSpreadsheetId: previewResult.previewFile.id,
      previewUrl: previewResult.previewFile.viewUrl || previewResult.previewFile.downloadUrl,
      previewSheetId: previewResult.previewSheet.id,
      previewSheetName: previewResult.previewSheetName,
      processingRecordId: registryResult.record.id,
      transformSummary: transformResult.metadata || {},
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function processWorkbooks({ files, formatterMode, previewWorkbookId, batchId, batchFileCount }) {
  const uploadFiles = Array.isArray(files) ? files : [];

  if (!uploadFiles.length) {
    throw badRequest("At least one workbook file is required.");
  }

  if (uploadFiles.length > appConfig.maxBatchFiles) {
    throw badRequest(`Please upload no more than ${appConfig.maxBatchFiles} files at a time.`);
  }

  const successes = [];
  const failures = [];
  let activePreviewWorkbookId = normalizeString(previewWorkbookId);
  let activeBatchId = normalizeString(batchId);

  for (const file of uploadFiles) {
    try {
      const result = await processSingleWorkbook({
        file,
        formatterMode,
        previewWorkbookId: activePreviewWorkbookId,
        batchId: activeBatchId,
        batchFileCount: Number(batchFileCount) || uploadFiles.length,
      });

      activePreviewWorkbookId = result.previewSpreadsheetId;
      activeBatchId = result.batchId;
      successes.push(result);
    } catch (error) {
      failures.push({
        fileName: file && file.originalname ? file.originalname : "workbook.xlsx",
        message: error.message || "Workbook processing failed.",
        code: error.details?.code || error.code || "WORKBOOK_PROCESSING_FAILED",
        details: error.details || null,
      });
    }
  }

  return {
    ok: failures.length === 0,
    successes,
    failures,
    previewState: {
      id: activePreviewWorkbookId,
      url: successes.length ? successes[successes.length - 1].previewUrl : "",
      batchId: activeBatchId,
    },
  };
}

module.exports = { processWorkbooks };
