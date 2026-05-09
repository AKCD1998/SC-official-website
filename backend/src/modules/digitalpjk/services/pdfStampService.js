import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FONT_PATH = path.join(__dirname, "..", "assets", "fonts", "THSarabunNew.ttf");
const TEMPLATE_DIR = path.join(__dirname, "..", "assets", "templates");

const TEMPLATE_KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;
const DEFAULT_TEXT_SIZE = 16;
const DEFAULT_TEXT_COLOR = rgb(0.12, 0.12, 0.12);
const GRID_LINE_COLOR = rgb(0.78, 0.83, 0.9);
const GRID_MAJOR_LINE_COLOR = rgb(0.47, 0.56, 0.7);
const GRID_LABEL_COLOR = rgb(0.11, 0.2, 0.36);
const GRID_MARKER_COLOR = rgb(0.72, 0.13, 0.13);

export const DEFAULT_TEMPLATE_KEY = "form_gor_gor_1";

class TemplateError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "TemplateError";
    this.statusCode = statusCode;
  }
}

function toNonEmptyString(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
}

function normalizeTemplateKey(rawTemplateKey) {
  const value = toNonEmptyString(rawTemplateKey || DEFAULT_TEMPLATE_KEY);
  const templateKey = value.endsWith(".pdf") ? value.slice(0, -4) : value;

  if (!templateKey) {
    return DEFAULT_TEMPLATE_KEY;
  }

  if (!TEMPLATE_KEY_PATTERN.test(templateKey)) {
    throw new TemplateError(
      400,
      "Invalid templateKey. Use only letters, numbers, underscores, and dashes."
    );
  }

  return templateKey;
}

async function ensureFileExists(filePath, missingMessage) {
  try {
    await access(filePath);
  } catch (_error) {
    throw new TemplateError(404, missingMessage);
  }
}

async function loadTemplateAssets(rawTemplateKey) {
  const templateKey = normalizeTemplateKey(rawTemplateKey);
  const templatePath = path.join(TEMPLATE_DIR, `${templateKey}.pdf`);
  const fieldsPath = path.join(TEMPLATE_DIR, `${templateKey}.fields.json`);

  await Promise.all([
    ensureFileExists(
      templatePath,
      `Template PDF not found: ${templateKey}.pdf (expected in backend/src/assets/templates)`
    ),
    ensureFileExists(
      fieldsPath,
      `Field mapping not found: ${templateKey}.fields.json (expected in backend/src/assets/templates)`
    ),
  ]);

  const [templateBytes, fieldsRaw] = await Promise.all([
    readFile(templatePath),
    readFile(fieldsPath, "utf8"),
  ]);

  let mapping;
  try {
    mapping = JSON.parse(fieldsRaw);
  } catch (error) {
    throw new TemplateError(
      500,
      `Invalid JSON in ${path.basename(fieldsPath)}: ${error.message}`
    );
  }

  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    throw new TemplateError(500, `${path.basename(fieldsPath)} must contain an object.`);
  }

  if (!mapping.fields || typeof mapping.fields !== "object" || Array.isArray(mapping.fields)) {
    throw new TemplateError(
      500,
      `${path.basename(fieldsPath)} must define a "fields" object.`
    );
  }

  return {
    templateKey,
    templateBytes,
    mapping,
  };
}

async function loadThaiFont(pdfDoc) {
  let fontBytes;
  try {
    fontBytes = await readFile(FONT_PATH);
  } catch (_error) {
    throw new TemplateError(500, `Thai font file not found at "${FONT_PATH}".`);
  }

  const marker = fontBytes.subarray(0, 80).toString("utf8");
  if (marker.includes("PLACEHOLDER FONT FILE")) {
    throw new TemplateError(
      500,
      `Thai font placeholder detected at "${FONT_PATH}". Replace it with a valid THSarabunNew.ttf file.`
    );
  }

  pdfDoc.registerFontkit(fontkit);

  try {
    return await pdfDoc.embedFont(fontBytes, { subset: false });
  } catch (error) {
    throw new TemplateError(
      500,
      `Unable to embed Thai font from "${FONT_PATH}". Ensure THSarabunNew.ttf is valid. (${error.message})`
    );
  }
}

function parseFieldColor(fieldConfig) {
  const color = fieldConfig?.color;
  if (Array.isArray(color) && color.length === 3) {
    const [r, g, b] = color.map((part) => Number(part));
    if ([r, g, b].every((part) => Number.isFinite(part) && part >= 0 && part <= 1)) {
      return rgb(r, g, b);
    }
  }

  return DEFAULT_TEXT_COLOR;
}

function resolveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveFieldSize(fieldConfig, payload) {
  const branchCode = toNonEmptyString(payload?.branchCode);
  const branchSizes =
    fieldConfig?.branchSizes &&
    typeof fieldConfig.branchSizes === "object" &&
    !Array.isArray(fieldConfig.branchSizes)
      ? fieldConfig.branchSizes
      : null;

  if (branchCode && branchSizes && Object.prototype.hasOwnProperty.call(branchSizes, branchCode)) {
    return resolveNumber(branchSizes[branchCode], DEFAULT_TEXT_SIZE);
  }

  return resolveNumber(fieldConfig?.size, DEFAULT_TEXT_SIZE);
}

function getByPath(objectValue, dottedPath) {
  const pathText = toNonEmptyString(dottedPath);
  if (!pathText) {
    return undefined;
  }

  return pathText.split(".").reduce((current, segment) => {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    return current[segment];
  }, objectValue);
}

function resolveSourceValue(payload, normalizedValues, dottedPath) {
  const fromPayload = getByPath(payload, dottedPath);
  if (fromPayload !== undefined) {
    return fromPayload;
  }

  return getByPath(normalizedValues, dottedPath);
}

function computeAlignedX(text, font, size, fieldConfig) {
  const baseX = resolveNumber(fieldConfig?.x, 0);
  const maxWidth = resolveNumber(fieldConfig?.maxWidth, null);
  const align = toNonEmptyString(fieldConfig?.align).toLowerCase();

  if (!maxWidth || !align) {
    return baseX;
  }

  const textWidth = font.widthOfTextAtSize(text, size);
  const clampedTextWidth = Math.min(textWidth, maxWidth);

  if (align === "center") {
    return baseX + Math.max((maxWidth - clampedTextWidth) / 2, 0);
  }

  if (align === "right") {
    return baseX + Math.max(maxWidth - clampedTextWidth, 0);
  }

  return baseX;
}

function countUniquePharmacistAttachments(subPharmacistSlots) {
  if (!Array.isArray(subPharmacistSlots)) {
    return 0;
  }

  const uniqueKeys = new Set();

  subPharmacistSlots.forEach((slot) => {
    if (!slot || typeof slot !== "object") {
      return;
    }

    const normalizedName = toNonEmptyString(slot.pharmacistName).toLowerCase();
    const normalizedLicense = toNonEmptyString(slot.pharmacistLicense).toLowerCase();
    const fallbackId = toNonEmptyString(slot.pharmacistId).toLowerCase();

    const dedupeKey =
      normalizedName && normalizedLicense
        ? `${normalizedName}|${normalizedLicense}`
        : fallbackId || `${normalizedName}|${normalizedLicense}`;

    if (!dedupeKey) {
      return;
    }

    uniqueKeys.add(dedupeKey);
  });

  return uniqueKeys.size;
}

function buildStampValues(payload) {
  // Normalized value dictionary used by fields.json keys.
  const extraFields =
    payload?.extraFields &&
    typeof payload.extraFields === "object" &&
    !Array.isArray(payload.extraFields)
      ? payload.extraFields
      : {};

  const pharmacyDisplayName =
    toNonEmptyString(payload?.pharmacyDisplayName) ||
    [toNonEmptyString(payload?.pharmacyNameTh), toNonEmptyString(payload?.branchNameTh)]
      .filter(Boolean)
      .join(" ");

  const thaiDate = payload?.documentDate?.thai || {};
  const pharmacistAttachmentCount = countUniquePharmacistAttachments(
    payload?.subPharmacistSlots
  );

  const ceoNameTh = toNonEmptyString(payload?.ceoNameTh);
  const licenseeNameTh = toNonEmptyString(payload?.licenseeNameTh) || ceoNameTh;

  return {
    ...extraFields,
    ceoNameTh,
    licenseeNameTh,
    fullName: ceoNameTh,
    pharmacyDisplayName,
    pharmacyName: pharmacyDisplayName,
    pharmacyNameTh: toNonEmptyString(payload?.pharmacyNameTh),
    branchNameTh: toNonEmptyString(payload?.branchNameTh),
    soi: toNonEmptyString(payload?.soi),
    addressNo: toNonEmptyString(payload?.addressNo),
    district: toNonEmptyString(payload?.district),
    province: toNonEmptyString(payload?.province),
    postcode: toNonEmptyString(payload?.postcode),
    phone: toNonEmptyString(payload?.phone),
    licenseNo: toNonEmptyString(payload?.licenseNo),
    locationText: toNonEmptyString(payload?.locationText),
    operatorTitle: toNonEmptyString(payload?.operatorTitle),
    operatorWorkHours: toNonEmptyString(payload?.operatorWorkHours),
    branchCode: toNonEmptyString(payload?.branchCode),
    dateISO: toNonEmptyString(payload?.documentDate?.dateISO),
    dateDay: toNonEmptyString(thaiDate?.day),
    dateMonthNameTh: toNonEmptyString(thaiDate?.monthNameTh),
    dateYearBE: toNonEmptyString(thaiDate?.yearBE),
    pharmacistAttachmentCount: String(pharmacistAttachmentCount),
  };
}

function drawMappedField(page, font, value, fieldConfig, payload) {
  const text = toNonEmptyString(value);
  if (!text) {
    return;
  }

  const size = resolveFieldSize(fieldConfig, payload);
  const x = computeAlignedX(text, font, size, fieldConfig);
  const y = resolveNumber(fieldConfig?.y, 0);
  const maxWidth = resolveNumber(fieldConfig?.maxWidth, undefined);
  const lineHeight = resolveNumber(fieldConfig?.lineHeight, size + 2);
  const color = parseFieldColor(fieldConfig);

  page.drawText(text, {
    x,
    y,
    size,
    font,
    color,
    maxWidth,
    lineHeight,
  });
}

function resolveFieldValue(fieldName, fieldConfig, payload, normalizedValues) {
  if (Object.prototype.hasOwnProperty.call(fieldConfig, "value")) {
    return fieldConfig.value;
  }

  if (Array.isArray(fieldConfig?.sources)) {
    return fieldConfig.sources.map((sourcePath) =>
      resolveSourceValue(payload, normalizedValues, sourcePath)
    );
  }

  if (Object.prototype.hasOwnProperty.call(fieldConfig, "source")) {
    return resolveSourceValue(payload, normalizedValues, fieldConfig.source);
  }

  return normalizedValues[fieldName];
}

function formatThaiDateShort(value) {
  if (!value) {
    return "-";
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  const day = date.getDate();
  const month = date.getMonth() + 1;
  const yearBE = date.getFullYear() + 543;
  return `${day}/${month}/${yearBE}`;
}

function formatTimeRange(value, payload, normalizedValues, fieldConfig) {
  let startRaw;
  let endRaw;

  if (Array.isArray(value)) {
    [startRaw, endRaw] = value;
  } else if (Array.isArray(fieldConfig?.sources)) {
    [startRaw, endRaw] = fieldConfig.sources.map((sourcePath) =>
      resolveSourceValue(payload, normalizedValues, sourcePath)
    );
  }

  const start = toNonEmptyString(startRaw);
  const end = toNonEmptyString(endRaw);
  if (!start || !end) {
    return "-";
  }

  return `${start} - ${end}`;
}

function applyFieldFormat(value, fieldConfig, payload, normalizedValues) {
  const format = toNonEmptyString(fieldConfig?.format).toLowerCase();
  if (!format) {
    return value;
  }

  if (format === "thaidateshort") {
    return formatThaiDateShort(value);
  }

  if (format === "timerange") {
    return formatTimeRange(value, payload, normalizedValues, fieldConfig);
  }

  return value;
}

export async function stampTemplatePdf({ templateKey, payload }) {
  const { templateKey: resolvedTemplateKey, templateBytes, mapping } =
    await loadTemplateAssets(templateKey);

  const pdfDoc = await PDFDocument.load(templateBytes);
  const thaiFont = await loadThaiFont(pdfDoc);
  const pages = pdfDoc.getPages();
  const defaultPageIndex = resolveNumber(mapping.page, 0);
  const values = buildStampValues(payload || {});

  Object.entries(mapping.fields).forEach(([fieldName, fieldConfig]) => {
    if (!fieldConfig || typeof fieldConfig !== "object" || Array.isArray(fieldConfig)) {
      return;
    }

    const pageIndex = resolveNumber(fieldConfig.page, defaultPageIndex);
    const page = pages[pageIndex];
    if (!page) {
      return;
    }

    const rawFieldValue = resolveFieldValue(fieldName, fieldConfig, payload || {}, values);
    const fieldValue = applyFieldFormat(rawFieldValue, fieldConfig, payload || {}, values);
    drawMappedField(page, thaiFont, fieldValue, fieldConfig, payload || {});
  });

  const pdfBytes = await pdfDoc.save();
  return { pdfBytes, templateKey: resolvedTemplateKey };
}

function drawDebugGrid(page, font, pageIndex) {
  // pdf-lib uses a bottom-left origin, so labels/markers are drawn in that space.
  const { width, height } = page.getSize();
  const step = 20;
  const markerStep = 100;

  for (let x = 0; x <= width; x += step) {
    const isMajor = x % markerStep === 0;
    page.drawLine({
      start: { x, y: 0 },
      end: { x, y: height },
      thickness: isMajor ? 0.8 : 0.3,
      color: isMajor ? GRID_MAJOR_LINE_COLOR : GRID_LINE_COLOR,
    });

    page.drawText(String(x), {
      x: Math.min(x + 1, width - 18),
      y: 2,
      size: 5.2,
      font,
      color: GRID_LABEL_COLOR,
    });
  }

  for (let y = 0; y <= height; y += step) {
    const isMajor = y % markerStep === 0;
    page.drawLine({
      start: { x: 0, y },
      end: { x: width, y },
      thickness: isMajor ? 0.8 : 0.3,
      color: isMajor ? GRID_MAJOR_LINE_COLOR : GRID_LINE_COLOR,
    });

    page.drawText(String(y), {
      x: 2,
      y: Math.min(y + 1, height - 8),
      size: 5.2,
      font,
      color: GRID_LABEL_COLOR,
    });
  }

  for (let x = 0; x <= width; x += markerStep) {
    for (let y = 0; y <= height; y += markerStep) {
      page.drawCircle({
        x,
        y,
        size: 1.8,
        color: GRID_MARKER_COLOR,
      });

      page.drawText(`(${x},${y})`, {
        x: Math.min(x + 2, width - 34),
        y: Math.min(y + 2, height - 7),
        size: 4.6,
        font,
        color: GRID_MARKER_COLOR,
      });
    }
  }

  page.drawText(`debug-grid page=${pageIndex} origin=(0,0)`, {
    x: 8,
    y: height - 12,
    size: 8,
    font,
    color: GRID_LABEL_COLOR,
  });
}

export async function generateTemplateDebugGridPdf(rawTemplateKey) {
  const { templateKey, templateBytes } = await loadTemplateAssets(rawTemplateKey);
  const pdfDoc = await PDFDocument.load(templateBytes);
  const debugFont = await pdfDoc.embedFont(StandardFonts.Helvetica);

  pdfDoc.getPages().forEach((page, pageIndex) => {
    drawDebugGrid(page, debugFont, pageIndex);
  });

  const pdfBytes = await pdfDoc.save();
  return { pdfBytes, templateKey };
}
