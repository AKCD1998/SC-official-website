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

function buildMessageText(job, record) {
  const dateLine = record.branchCodes
    ? `วันที่รายงาน: ${formatReportDateKey(record.reportDate)} | สาขา ${record.branchCodes}`
    : `วันที่รายงาน: ${formatReportDateKey(record.reportDate)}`;

  const lines = [
    "📄 ปริ้นเอกสารส่งพี่เอแล้ว",
    `ไฟล์: ${record.filename}`,
    dateLine,
    `ปริ้นเมื่อ: ${formatTimestamp(job.completedAt)}`,
    `เครื่องปริ้น: ${job.printerName || "-"} (${job.agentHost || "-"})`,
    "สถานะ: สำเร็จ ✅",
    "กรุณารับเอกสารที่เครื่องปริ้น หากหาไม่พบสามารถกดขอปริ้นใหม่ในเว็บได้",
    "(การขอปริ้นใหม่จะถูกบันทึกเป็นสถิติการจัดการเอกสารของทีม)",
  ];

  if (job.isReprint) {
    lines.push(
      `⚠️ นี่คือการปริ้นซ้ำครั้งที่ ${job.attemptNo} ของเอกสารนี้ (เหตุผล: ${job.reprintReason || "ไม่ระบุ"})`,
    );
  }

  return lines.join("\n");
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
      messages: [{ type: "text", text: buildMessageText(job, record) }],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`LINE push failed with status ${response.status}: ${body}`);
  }

  return { skipped: false };
}

module.exports = { sendPrintNotification };
