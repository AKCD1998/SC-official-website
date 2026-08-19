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

function buildFlexContents(job, record) {
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
  return `📄 ${record.filename} — ${status}`;
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
