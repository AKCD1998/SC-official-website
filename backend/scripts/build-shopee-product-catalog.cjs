const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const ExcelJS = require("exceljs");

const CATALOG_VERSION = "shopee-company-sku-2026-09-02";

function addSkuRows(overrides, companySku, rows) {
  rows.forEach((rowNumber) => {
    overrides.set(rowNumber, { status: "matched", companySku });
  });
}

function buildDrMorepenOverrides() {
  const overrides = new Map();
  addSkuRows(overrides, "IC-005998", [7]);
  addSkuRows(overrides, "IC-003233", [13]);
  addSkuRows(overrides, "IC-003232", [15]);
  addSkuRows(overrides, "IC-003230", [16]);
  addSkuRows(overrides, "IC-004912", [17]);
  addSkuRows(overrides, "IC-005661", [21]);
  overrides.set(14, {
    status: "bundle",
    sellerBundleKey: "DR-BND-BG03-STRIP25-X3-V1",
    components: [
      { companySku: "IC-003478", quantityPerSale: 3 },
    ],
    quantityRuleStatus: "verified",
  });
  [11, 12].forEach((rowNumber) => {
    overrides.set(rowNumber, {
      status: "bundle",
      components: [
        { companySku: "IC-003230", quantityPerSale: null },
        { companySku: "IC-003478", quantityPerSale: null },
      ],
      quantityRuleStatus: "requires_validation",
    });
  });
  return overrides;
}

function buildScDrugStoreOverrides() {
  const overrides = new Map();

  addSkuRows(overrides, "IC-001849", [33, 34, 35]);
  addSkuRows(overrides, "IC-005547", [42, 43]);
  addSkuRows(overrides, "IC-005546", [64]);
  addSkuRows(overrides, "IC-000246", [69]);
  addSkuRows(overrides, "IC-000245", [70]);
  addSkuRows(overrides, "IC-000178", [85]);
  addSkuRows(overrides, "IC-000304", [98]);
  addSkuRows(overrides, "630010253", [99]);
  addSkuRows(overrides, "IC-001359", [159]);
  addSkuRows(overrides, "IC-005549", [174]);
  addSkuRows(overrides, "630010038", [181]);
  addSkuRows(overrides, "630010065", [183]);
  addSkuRows(overrides, "630010040", [184]);
  addSkuRows(overrides, "630010066", [185]);
  addSkuRows(overrides, "IC-003778", [197]);
  addSkuRows(overrides, "IC-000398", [198]);
  addSkuRows(overrides, "IC-001048", [199]);
  addSkuRows(overrides, "IC-004787", [202]);

  addSkuRows(overrides, "IC-002111", [8, 9]);
  addSkuRows(overrides, "IC-001928", [10, 11, 12]);
  addSkuRows(overrides, "IC-005369", [18]);
  addSkuRows(overrides, "IC-005557", [20]);
  addSkuRows(overrides, "IC-006023", [21]);
  addSkuRows(overrides, "IC-002516", [24, 50, 58]);
  addSkuRows(overrides, "IC-000665", [36, 84]);
  addSkuRows(overrides, "IC-004199", [37, 62]);
  addSkuRows(overrides, "IC-002353", [38, 39, 40, 41, 56, 57]);
  addSkuRows(overrides, "IC-000129", [44, 45]);
  addSkuRows(overrides, "IC-004143", [46]);
  addSkuRows(overrides, "IC-002484", [51]);
  addSkuRows(overrides, "IC-002300", [52, 55]);
  addSkuRows(overrides, "IC-002485", [53, 54]);
  addSkuRows(overrides, "IC-003387", [65, 66]);
  addSkuRows(overrides, "IC-005439", [78]);
  addSkuRows(overrides, "IC-005480", [90]);
  addSkuRows(overrides, "IC-003840", [144]);
  addSkuRows(overrides, "IC-005056", [145]);
  addSkuRows(overrides, "IC-003560", [153]);
  addSkuRows(overrides, "IC-003493", [154]);
  addSkuRows(overrides, "IC-000343", [162]);
  addSkuRows(overrides, "IC-005510", [163]);
  addSkuRows(overrides, "IC-000711", [165]);
  addSkuRows(overrides, "IC-004860", [173]);
  addSkuRows(overrides, "IC-005370", [180]);
  addSkuRows(overrides, "IC-002109", [193]);
  addSkuRows(overrides, "IC-000067", [194]);
  addSkuRows(overrides, "IC-000330", [195, 196]);
  addSkuRows(overrides, "IC-005438", [203]);
  addSkuRows(overrides, "IC-005600", [204]);
  addSkuRows(overrides, "IC-000066", [206, 207]);

  overrides.set(115, {
    status: "bundle",
    sellerBundleKey: "SC-BND-CANDYPOP-MIX3-V1",
    components: [
      { companySku: "IC-005598", quantityPerSale: 1 },
      { companySku: "IC-005323", quantityPerSale: 1 },
      { companySku: "IC-005294", quantityPerSale: 1 },
    ],
    quantityRuleStatus: "verified",
  });
  overrides.set(182, {
    status: "visibility_only",
    reasonCode: "never_sold_visibility_listing",
  });

  return overrides;
}

const SOURCE_SPECS = [
  {
    shopCode: "dr-morepen",
    argument: "dr-morepen",
    expectedSha256: "3fcdb038f511593dd831bebf1d682e8ef6ec37c67aa740107a4456e5f9686100",
    firstDataRow: 7,
    expectedRecordCount: 15,
    overrides: buildDrMorepenOverrides(),
  },
  {
    shopCode: "sc-drug-store",
    argument: "sc-drug-store",
    expectedSha256: "01d65d9358d992bf734b2189c9a812571c8f20d261bb436f1bb3e593e566c2b1",
    firstDataRow: 7,
    expectedRecordCount: 212,
    overrides: buildScDrugStoreOverrides(),
  },
];

function readArgument(name) {
  const direct = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (direct) return direct.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : "";
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function cellText(row, columnNumber) {
  return String(row.getCell(columnNumber).text || "").trim();
}

function identityKey(record) {
  return JSON.stringify([
    record.shopCode,
    record.productName.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase(),
    record.variant.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase(),
  ]);
}

async function readSource(spec, filePath) {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) throw new Error(`Shopee source file not found: ${resolvedPath}`);

  const actualSha256 = sha256File(resolvedPath);
  if (actualSha256 !== spec.expectedSha256) {
    throw new Error(
      `Shopee source hash mismatch for ${spec.shopCode}: expected ${spec.expectedSha256}, got ${actualSha256}`,
    );
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(resolvedPath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error(`Shopee source has no worksheet: ${resolvedPath}`);

  const records = [];
  const lastDataRow = spec.firstDataRow + spec.expectedRecordCount - 1;
  for (let rowNumber = spec.firstDataRow; rowNumber <= lastDataRow; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const productId = cellText(row, 1);
    const productName = cellText(row, 2);
    const variationId = cellText(row, 3);
    const variant = cellText(row, 4);
    const existingSku = cellText(row, 6);
    if (!productId || !productName || !variationId) {
      throw new Error(`${spec.shopCode} row ${rowNumber} is missing product identity fields.`);
    }

    const override = spec.overrides.get(rowNumber);
    const match = override || (existingSku ? { status: "matched", companySku: existingSku } : null);
    if (!match) throw new Error(`${spec.shopCode} row ${rowNumber} has no confirmed product mapping.`);

    records.push({
      shopCode: spec.shopCode,
      sourceRow: rowNumber,
      productId,
      variationId,
      productName,
      variant,
      match,
    });
  }

  if (records.length !== spec.expectedRecordCount) {
    throw new Error(`${spec.shopCode} expected ${spec.expectedRecordCount} records, got ${records.length}.`);
  }

  return {
    source: {
      shopCode: spec.shopCode,
      filename: path.basename(resolvedPath),
      sha256: actualSha256,
      worksheet: worksheet.name,
      firstDataRow: spec.firstDataRow,
      lastDataRow,
    },
    records,
  };
}

async function main() {
  const outputPath = path.resolve(
    readArgument("output") || path.join(
      __dirname,
      "..",
      "src",
      "modules",
      "seamless",
      "data",
      "shopeeProductCatalog.v1.json",
    ),
  );

  const results = [];
  for (const spec of SOURCE_SPECS) {
    const sourcePath = readArgument(spec.argument);
    if (!sourcePath) throw new Error(`Missing required --${spec.argument} workbook path.`);
    results.push(await readSource(spec, sourcePath));
  }

  const records = results.flatMap((result) => result.records);
  const identities = new Map();
  records.forEach((record) => {
    const key = identityKey(record);
    if (identities.has(key)) {
      throw new Error(
        `Duplicate normalized Shopee product identity at rows ${identities.get(key).sourceRow} and ${record.sourceRow}.`,
      );
    }
    identities.set(key, record);
  });

  const catalog = {
    schemaVersion: 1,
    catalogVersion: CATALOG_VERSION,
    ownerDecisionDate: "2026-09-02",
    sources: results.map((result) => result.source),
    records,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    outputPath,
    catalogVersion: CATALOG_VERSION,
    recordCount: records.length,
    statuses: records.reduce((counts, record) => {
      counts[record.match.status] = (counts[record.match.status] || 0) + 1;
      return counts;
    }, {}),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
