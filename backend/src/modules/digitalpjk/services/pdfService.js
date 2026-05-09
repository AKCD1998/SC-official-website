import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb } from "pdf-lib";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN_X = 52;
const FONT_PATH = path.join(__dirname, "..", "assets", "fonts", "THSarabunNew.ttf");
const TEXT_COLOR = rgb(0.12, 0.12, 0.12);

function toText(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
}

function drawDottedLine(page, x, y, width) {
  const segment = 2.2;
  const gap = 2.1;

  for (let offset = 0; offset < width; offset += segment + gap) {
    const next = Math.min(segment, width - offset);
    page.drawLine({
      start: { x: x + offset, y },
      end: { x: x + offset + next, y },
      thickness: 0.7,
      color: TEXT_COLOR,
    });
  }
}

function drawCenteredTitle(page, text, y, font, size = 24) {
  const content = toText(text);
  const textWidth = font.widthOfTextAtSize(content, size);
  page.drawText(content, {
    x: (A4_WIDTH - textWidth) / 2,
    y,
    size,
    font,
    color: TEXT_COLOR,
  });
}

function drawField({ page, label, value, y, font, lineX = 210, lineWidth = 330 }) {
  const labelText = toText(label);
  const valueText = toText(value);

  page.drawText(labelText, {
    x: MARGIN_X,
    y,
    size: 20,
    font,
    color: TEXT_COLOR,
  });

  drawDottedLine(page, lineX, y + 2, lineWidth);

  page.drawText(valueText, {
    x: lineX + 4,
    y,
    size: 20,
    font,
    color: TEXT_COLOR,
  });
}

function drawDateLine(page, documentDate, font, y) {
  const thai = documentDate?.thai || {};
  const day = toText(thai.day);
  const monthNameTh = toText(thai.monthNameTh);
  const yearBE = toText(thai.yearBE);

  page.drawText("วันที่", {
    x: MARGIN_X,
    y,
    size: 20,
    font,
    color: TEXT_COLOR,
  });
  drawDottedLine(page, MARGIN_X + 40, y + 2, 65);
  page.drawText(day, {
    x: MARGIN_X + 46,
    y,
    size: 20,
    font,
    color: TEXT_COLOR,
  });

  page.drawText("เดือน", {
    x: MARGIN_X + 120,
    y,
    size: 20,
    font,
    color: TEXT_COLOR,
  });
  drawDottedLine(page, MARGIN_X + 167, y + 2, 150);
  page.drawText(monthNameTh, {
    x: MARGIN_X + 173,
    y,
    size: 20,
    font,
    color: TEXT_COLOR,
  });

  page.drawText("พ.ศ.", {
    x: MARGIN_X + 328,
    y,
    size: 20,
    font,
    color: TEXT_COLOR,
  });
  drawDottedLine(page, MARGIN_X + 360, y + 2, 80);
  page.drawText(yearBE, {
    x: MARGIN_X + 366,
    y,
    size: 20,
    font,
    color: TEXT_COLOR,
  });
}

async function loadThaiFont(pdfDoc) {
  const fontBytes = await readFile(FONT_PATH);
  const marker = fontBytes.subarray(0, 80).toString("utf8");

  if (marker.includes("PLACEHOLDER FONT FILE")) {
    throw new Error(
      `Thai font placeholder detected at "${FONT_PATH}". Replace it with a valid THSarabunNew.ttf file.`
    );
  }

  pdfDoc.registerFontkit(fontkit);

  try {
    return await pdfDoc.embedFont(fontBytes, { subset: false });
  } catch (error) {
    throw new Error(
      `Unable to embed Thai font from "${FONT_PATH}". Ensure THSarabunNew.ttf is valid. (${error.message})`
    );
  }
}

function mapExtraFields(extraFields) {
  if (!extraFields || typeof extraFields !== "object" || Array.isArray(extraFields)) {
    return [];
  }

  return Object.entries(extraFields)
    .filter(([key, value]) => key && value !== null && value !== undefined && `${value}`.trim() !== "")
    .slice(0, 8)
    .map(([key, value]) => ({
      key: toText(key),
      value: toText(value),
    }));
}

async function maybeWriteSamplePdf(pdfBytes) {
  if (process.env.DIGITALPJK_PDF_WRITE_SAMPLE !== "true") {
    return null;
  }

  const outputDir = process.env.DIGITALPJK_PDF_SAMPLE_DIR || os.tmpdir();
  await mkdir(outputDir, { recursive: true });

  const samplePath = path.join(outputDir, `digitalPjkform-sample-${Date.now()}.pdf`);
  await writeFile(samplePath, pdfBytes);
  return samplePath;
}

export async function generateThaiFormPdf(payload) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);
  const font = await loadThaiFont(pdfDoc);

  drawCenteredTitle(page, "แบบคำร้องขออนุญาตเกี่ยวกับการขายยา", 780, font, 24);
  drawCenteredTitle(page, "(เอกสารสำหรับใช้งานภายใน)", 755, font, 20);

  drawField({
    page,
    label: "ข้าพเจ้า",
    value: payload.ceoNameTh,
    y: 705,
    font,
  });
  drawField({
    page,
    label: "ชื่อสถานที่ขายยา",
    value: `${toText(payload.pharmacyNameTh)} ${toText(payload.branchNameTh)}`.trim(),
    y: 670,
    font,
  });
  drawField({
    page,
    label: "ตรอก/ซอย",
    value: payload.soi,
    y: 635,
    font,
  });
  drawField({
    page,
    label: "ตั้งอยู่เลขที่",
    value: payload.addressNo,
    y: 600,
    font,
  });
  drawField({
    page,
    label: "อำเภอ/เขต",
    value: payload.district,
    y: 565,
    font,
  });
  drawField({
    page,
    label: "จังหวัด",
    value: payload.province,
    y: 530,
    font,
  });
  drawField({
    page,
    label: "รหัสไปรษณีย์",
    value: payload.postcode,
    y: 495,
    font,
  });
  drawField({
    page,
    label: "โทรศัพท์",
    value: payload.phone,
    y: 460,
    font,
  });
  drawField({
    page,
    label: "ใบอนุญาตเลขที่",
    value: payload.licenseNo,
    y: 425,
    font,
  });
  drawField({
    page,
    label: "มี นาย/นาง/นางสาว",
    value: payload.operatorTitle,
    y: 390,
    font,
  });
  drawField({
    page,
    label: "เป็นผู้มีหน้าที่ปฏิบัติการ เวลาปฏิบัติการ",
    value: payload.operatorWorkHours,
    y: 355,
    font,
    lineX: 355,
    lineWidth: 185,
  });
  drawField({
    page,
    label: "เขียนที่",
    value: payload.locationText,
    y: 320,
    font,
  });

  drawDateLine(page, payload.documentDate, font, 285);

  page.drawText(`สาขา: ${toText(payload.branchCode)}`, {
    x: MARGIN_X,
    y: 250,
    size: 17,
    font,
    color: TEXT_COLOR,
  });

  const extraEntries = mapExtraFields(payload.extraFields);
  if (extraEntries.length > 0) {
    page.drawText("ข้อมูลเพิ่มเติม", {
      x: MARGIN_X,
      y: 220,
      size: 18,
      font,
      color: TEXT_COLOR,
    });

    extraEntries.forEach((entry, index) => {
      page.drawText(`${entry.key}: ${entry.value}`, {
        x: MARGIN_X + 10,
        y: 198 - index * 18,
        size: 15,
        font,
        color: TEXT_COLOR,
      });
    });
  }

  const pdfBytes = await pdfDoc.save();
  const samplePath = await maybeWriteSamplePdf(pdfBytes);

  return {
    pdfBytes,
    samplePath,
  };
}
