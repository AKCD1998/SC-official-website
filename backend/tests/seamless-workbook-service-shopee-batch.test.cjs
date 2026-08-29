const crypto = require("node:crypto");
const mockExcelJS = require("exceljs");

let mockBatchSequence = 0;
let mockFileSequence = 0;
let mockOutputSequence = 0;
let mockProcessingSequence = 0;
let mockSheetSequence = 0;
let mockUploadSequence = 0;
const mockGeneratedFiles = new Map();
const mockStoredBuffers = new Map();

const mockClient = {
  query: jest.fn(async () => ({ rows: [] })),
  release: jest.fn(),
};

const mockCreateProcessingRecordFromPreview = jest.fn(async (input) => ({
  action: "created",
  ok: true,
  record: { id: `processing-${++mockProcessingSequence}`, metadata: input.metadata },
}));
const mockFindProcessingRecordByFilename = jest.fn();
const mockUpsertProcessingRecordFromPreview = jest.fn();
const mockUpdateWorkbookUpload = jest.fn(async (id, patch) => ({ id, ...patch }));

jest.mock("../db", () => ({ connect: jest.fn(async () => mockClient) }));
jest.mock("../src/modules/seamless/appConfig", () => ({
  appConfig: { maxBatchFiles: 10, maxUploadBytes: 10 * 1024 * 1024, maxUploadMb: 10 },
}));
jest.mock("../src/modules/seamless/config", () => ({
  readR2Config: jest.fn(() => ({ shopeeBucket: "" })),
}));
jest.mock("../src/modules/seamless/db/batchRepository", () => ({
  createBatch: jest.fn(async () => ({ id: `batch-${++mockBatchSequence}` })),
  recordBatchResult: jest.fn(async () => null),
}));
jest.mock("../src/modules/seamless/db/generatedFileRepository", () => ({
  createGeneratedFile: jest.fn(async (input) => {
    const value = { id: `file-${++mockFileSequence}`, metadata: {}, ...input };
    mockGeneratedFiles.set(value.id, value);
    return value;
  }),
  findSourceUploadByChecksum: jest.fn(async () => null),
  getGeneratedFileById: jest.fn(async (id) => mockGeneratedFiles.get(id)),
  updateGeneratedFile: jest.fn(async (id, patch) => {
    const value = { ...mockGeneratedFiles.get(id), ...patch };
    mockGeneratedFiles.set(id, value);
    return value;
  }),
}));
jest.mock("../src/modules/seamless/db/operationLogRepository", () => ({
  logOperation: jest.fn(async () => null),
}));
jest.mock("../src/modules/seamless/processingRecords", () => ({
  createProcessingRecordFromPreview: mockCreateProcessingRecordFromPreview,
  findProcessingRecordByFilename: mockFindProcessingRecordByFilename,
  upsertProcessingRecordFromPreview: mockUpsertProcessingRecordFromPreview,
}));
jest.mock("../src/modules/seamless/db/previewSheetRepository", () => ({
  createPreviewSheet: jest.fn(async () => ({ id: `sheet-${++mockSheetSequence}` })),
  listPreviewSheets: jest.fn(async () => [{ id: "existing-sheet" }]),
}));
jest.mock("../src/modules/seamless/db/workbookUploadRepository", () => ({
  createWorkbookUpload: jest.fn(async () => ({ id: `upload-${++mockUploadSequence}` })),
  updateWorkbookUpload: mockUpdateWorkbookUpload,
}));
jest.mock("../src/modules/seamless/services/fileStorageService", () => ({
  buildApiUrl: jest.fn((path) => path),
  readStoredFile: jest.fn(async (_provider, storagePath) => mockStoredBuffers.get(storagePath)),
  sha256: jest.fn((value) => crypto.createHash("sha256").update(value).digest("hex")),
  writeStoredFile: jest.fn(async (kind, filename, value) => {
    const buffer = Buffer.from(value);
    const storagePath = `${kind}/${filename}/${mockStoredBuffers.size + 1}`;
    mockStoredBuffers.set(storagePath, buffer);
    return {
      checksumSha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      fileSizeBytes: buffer.length,
      storagePath,
      storageProvider: "test",
    };
  }),
}));
jest.mock("../src/modules/seamless/services/workbookRules", () => ({
  buildOutputFilename: jest.fn(() => ({
    branchCode: "004",
    filename: `processed-${++mockOutputSequence}.xlsx`,
    parsedDate: "20260828",
    warnings: [],
  })),
}));
jest.mock("../src/modules/seamless/services/shopeeShops", () => ({
  requireShopeeShopCode: jest.fn(() => "dr-morepen"),
}));
jest.mock("../src/modules/seamless/services/workbookTransformService", () => ({
  copyWorksheet: jest.fn((_source, targetWorkbook, name) => {
    const sheet = targetWorkbook.addWorksheet(name);
    sheet.addRow(["preview"]);
    return sheet;
  }),
  transformWorkbook: jest.fn(async () => {
    const workbook = new mockExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("master");
    worksheet.addRow(["processed"]);
    return {
      deletedColumns: [],
      detectedVariant: "shopee",
      effectiveVariant: "shopee",
      highlightCount: 0,
      metadata: { checkpointEligible: true },
      warnings: [],
      workbook,
      worksheet,
    };
  }),
}));

const { processWorkbooks } = require("../src/modules/seamless/services/workbookService");

beforeEach(() => {
  mockBatchSequence = 0;
  mockFileSequence = 0;
  mockOutputSequence = 0;
  mockProcessingSequence = 0;
  mockSheetSequence = 0;
  mockUploadSequence = 0;
  mockGeneratedFiles.clear();
  mockStoredBuffers.clear();
  jest.clearAllMocks();
});

test("a two-file Shopee batch keeps one processing record per source upload", async () => {
  const files = ["A", "B"].map((suffix) => ({
    buffer: Buffer.from(`workbook-${suffix}`),
    mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    originalname: `Order.all.20260824_20260913-${suffix}.xlsx`,
  }));

  const result = await processWorkbooks({
    batchFileCount: 2,
    files,
    formatterMode: "shopee",
    shopCode: "dr-morepen",
  });

  expect(result.ok).toBe(true);
  expect(result.successes).toHaveLength(2);
  expect(result.successes.map((item) => item.processingRecordId)).toEqual([
    "processing-1",
    "processing-2",
  ]);
  expect(new Set(result.successes.map((item) => item.previewSpreadsheetId)).size).toBe(1);
  expect(mockCreateProcessingRecordFromPreview).toHaveBeenCalledTimes(2);
  expect(mockFindProcessingRecordByFilename).not.toHaveBeenCalled();
  expect(mockUpsertProcessingRecordFromPreview).not.toHaveBeenCalled();
  expect(mockUpdateWorkbookUpload.mock.calls.map(([_id, patch]) => patch.processingRecordId)).toEqual([
    "processing-1",
    "processing-2",
  ]);
});
