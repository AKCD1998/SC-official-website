const { readLineConfig } = require("../config");

function formatReportDateKey(reportDateKey) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(reportDateKey || "");
  return match ? `${match[3]}/${match[2]}/${match[1]}` : reportDateKey || "";
}

const bangkokTimestampFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Bangkok",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatTimestamp(isoString) {
  const date = new Date(isoString || "");

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const parts = bangkokTimestampFormatter.formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});

  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
}

// LINE's plain `type: "text"` messages don't render Markdown — "**bold**" shows as literal
// asterisks. Real bold/spacing needs a Flex Message (a JSON layout tree LINE renders natively).
function buildFieldRow(emoji, label, value) {
  return {
    type: "box",
    layout: "baseline",
    spacing: "sm",
    contents: [
      { type: "text", text: `${emoji} ${label}:`, weight: "bold", size: "sm", flex: 4, wrap: true },
      { type: "text", text: String(value || "-"), size: "sm", flex: 6, wrap: true },
    ],
  };
}

// PharmCare Thai labels are duplicated (not imported) from client/src/components/
// pharmcareLabels.js — that file lives in the ClaspSCxSeamless frontend repo, unreachable from
// this backend. Keep in sync by hand if PharmCare adds a document type.
const PHARMCARE_DOCUMENT_TYPE_LABELS = {
  e_credit_invoice: "E-Credit Invoice",
  settlement_mrr: "Settlement (MRR)",
  settlement_sfr: "Settlement (SFR)",
  receipt_link_pending: "ใบเสร็จ/ใบกำกับภาษี (รอลิงก์)",
  contract: "สัญญา",
  unknown: "ไม่ทราบประเภท",
};

// isPharmcareSource(record) is true for a processing_records row created by
// pharmcarePrintService.js (metadata.source === 'pharmcare') — every other row (the vast
// majority: Seamless workbooks, Shopee orders) falls through to the original template
// unchanged. See docs/22-pharmcare-print-integration-spec.md for why a shared table is reused
// here instead of a separate one.
function isPharmcareSource(record) {
  return record?.metadata?.source === "pharmcare";
}

// A thin colored strip is the actual "tell them apart while scrolling" mechanism — same bubble
// skeleton below (title → separator → field rows → status → footer) as the Seamless template,
// just PharmCare teal (#1DADA8, the real brand color already used for the /pharmcare/* frontend
// theme) instead of Seamless's green, so the two read as "same family, different module" rather
// than needing to actually read the text to tell them apart.
function buildAccentStrip(color) {
  return { type: "box", layout: "vertical", height: "6px", backgroundColor: color, contents: [] };
}

function buildPharmcareFlexContents(job, record) {
  const documentType = record.metadata?.pharmcareDocumentType;
  const documentNumber = record.metadata?.pharmcareDocumentNumber;

  const bodyContents = [
    {
      type: "text",
      text: "💊 ปริ้นเอกสาร PharmCare ส่งพี่เอแล้ว",
      weight: "bold",
      size: "lg",
      wrap: true,
    },
    { type: "separator", margin: "md" },
    {
      type: "box",
      layout: "vertical",
      margin: "md",
      spacing: "sm",
      contents: [
        buildFieldRow("📁", "ไฟล์", record.filename),
        buildFieldRow("🏷️", "ประเภทเอกสาร", PHARMCARE_DOCUMENT_TYPE_LABELS[documentType] || documentType || "-"),
        ...(documentNumber ? [buildFieldRow("🔖", "เลขเอกสาร", documentNumber)] : []),
      ],
    },
    { type: "separator", margin: "md" },
    {
      type: "box",
      layout: "vertical",
      margin: "md",
      spacing: "sm",
      contents: [
        buildFieldRow("🖨️", "ปริ้นเมื่อ", formatTimestamp(job.completedAt)),
        buildFieldRow("🖨️", "เครื่องปริ้น", `${job.printerName || "-"} (${job.agentHost || "-"})`),
      ],
    },
    { type: "separator", margin: "md" },
    {
      type: "text",
      text: "✅ สถานะ: สำเร็จ",
      weight: "bold",
      color: "#0A7A3D",
      margin: "md",
      wrap: true,
    },
    {
      type: "text",
      text: 'กรุณารับเอกสารที่เครื่องปริ้น หากหาไม่พบ สามารถกด "ขอปริ้นใหม่" ในหน้า PharmCare Inbox ได้',
      wrap: true,
      size: "sm",
      margin: "md",
    },
  ];

  if (job.isReprint) {
    bodyContents.push(
      { type: "separator", margin: "md" },
      {
        type: "box",
        layout: "vertical",
        margin: "md",
        spacing: "xs",
        contents: [
          { type: "text", text: "⚠️ หมายเหตุ", weight: "bold", color: "#A33124", wrap: true },
          {
            type: "text",
            text: `นี่คือการปริ้นซ้ำครั้งที่ ${job.attemptNo} ของเอกสารนี้`,
            wrap: true,
            size: "sm",
          },
          {
            type: "text",
            text: `เหตุผล: ${job.reprintReason || "ไม่ระบุ"}`,
            wrap: true,
            size: "sm",
          },
        ],
      },
    );
  }

  return {
    type: "bubble",
    header: buildAccentStrip("#1DADA8"),
    body: {
      type: "box",
      layout: "vertical",
      contents: bodyContents,
    },
  };
}

function buildFlexContents(job, record) {
  if (isPharmcareSource(record)) {
    return buildPharmcareFlexContents(job, record);
  }

  const bodyContents = [
    {
      type: "text",
      text: "📄 ปริ้นเอกสารส่งพี่เอแล้ว",
      weight: "bold",
      size: "lg",
      wrap: true,
    },
    { type: "separator", margin: "md" },
    {
      type: "box",
      layout: "vertical",
      margin: "md",
      spacing: "sm",
      contents: [
        buildFieldRow("📁", "ไฟล์", record.filename),
        buildFieldRow("📅", "วันที่รายงาน", formatReportDateKey(record.reportDate)),
        ...(record.branchCodes ? [buildFieldRow("🏪", "สาขา", record.branchCodes)] : []),
      ],
    },
    { type: "separator", margin: "md" },
    {
      type: "box",
      layout: "vertical",
      margin: "md",
      spacing: "sm",
      contents: [
        buildFieldRow("🖨️", "ปริ้นเมื่อ", formatTimestamp(job.completedAt)),
        buildFieldRow("🖨️", "เครื่องปริ้น", `${job.printerName || "-"} (${job.agentHost || "-"})`),
      ],
    },
    { type: "separator", margin: "md" },
    {
      type: "text",
      text: "✅ สถานะ: สำเร็จ",
      weight: "bold",
      color: "#0A7A3D",
      margin: "md",
      wrap: true,
    },
    {
      type: "text",
      text: 'กรุณารับเอกสารที่เครื่องปริ้น หากหาไม่พบ สามารถกด "ขอปริ้นใหม่" ในเว็บไซต์ได้',
      wrap: true,
      size: "sm",
      margin: "md",
    },
    {
      type: "text",
      text: "📝 การขอปริ้นใหม่จะถูกบันทึกเป็นสถิติการจัดการเอกสารของทีม",
      wrap: true,
      size: "xs",
      color: "#888888",
      margin: "sm",
    },
  ];

  if (job.isReprint) {
    bodyContents.push(
      { type: "separator", margin: "md" },
      {
        type: "box",
        layout: "vertical",
        margin: "md",
        spacing: "xs",
        contents: [
          { type: "text", text: "⚠️ หมายเหตุ", weight: "bold", color: "#A33124", wrap: true },
          {
            type: "text",
            text: `นี่คือการปริ้นซ้ำครั้งที่ ${job.attemptNo} ของเอกสารนี้`,
            wrap: true,
            size: "sm",
          },
          {
            type: "text",
            text: `เหตุผล: ${job.reprintReason || "ไม่ระบุ"}`,
            wrap: true,
            size: "sm",
          },
        ],
      },
    );
  }

  return {
    type: "bubble",
    header: buildAccentStrip("#0D7A56"),
    body: {
      type: "box",
      layout: "vertical",
      contents: bodyContents,
    },
  };
}

// Shown in push notification previews and by any LINE client that can't render Flex —
// must stay short, plain text, no formatting.
function buildAltText(job, record) {
  const status = job.isReprint ? `ปริ้นซ้ำครั้งที่ ${job.attemptNo}` : "ปริ้นสำเร็จ";
  const prefix = isPharmcareSource(record) ? "💊" : "📄";
  return `${prefix} ${record.filename} — ${status}`;
}

async function sendPrintNotification(job, record) {
  const lineConfig = readLineConfig();

  if (!lineConfig.channelAccessToken || !lineConfig.targetId) {
    return {
      skipped: true,
      reason: "SEAMLESS_LINE_CHANNEL_ACCESS_TOKEN or SEAMLESS_LINE_TARGET_ID is not configured.",
    };
  }

  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${lineConfig.channelAccessToken}`,
    },
    body: JSON.stringify({
      to: lineConfig.targetId,
      messages: [
        {
          type: "flex",
          altText: buildAltText(job, record),
          contents: buildFlexContents(job, record),
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`LINE push failed with status ${response.status}: ${body}`);
  }

  return { skipped: false };
}

// Generic plain-text alert, reusing the same LINE config/target as print notifications — used
// for operational alerts (e.g. PharmCare Gmail sync failures) that don't have a print job/record
// to build a Flex message around. Same skip-if-unconfigured behavior as sendPrintNotification.
async function sendTextAlert(text) {
  const lineConfig = readLineConfig();

  if (!lineConfig.channelAccessToken || !lineConfig.targetId) {
    return {
      skipped: true,
      reason: "SEAMLESS_LINE_CHANNEL_ACCESS_TOKEN or SEAMLESS_LINE_TARGET_ID is not configured.",
    };
  }

  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${lineConfig.channelAccessToken}`,
    },
    body: JSON.stringify({
      to: lineConfig.targetId,
      messages: [{ type: "text", text: String(text).slice(0, 4900) }], // LINE's text message limit is 5000 chars
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`LINE push failed with status ${response.status}: ${body}`);
  }

  return { skipped: false };
}

module.exports = { sendPrintNotification, sendTextAlert };
