const THAI_MONTHS = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];

function formatExpensePeriod(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value || ""));
  if (!match) return String(value || "-");
  const month = Number(match[2]);
  return `${THAI_MONTHS[month - 1] || match[2]} ${Number(match[1]) + 543}`;
}

function formatAmount(value) {
  return new Intl.NumberFormat("th-TH", {
    style: "currency",
    currency: "THB",
    minimumFractionDigits: 2,
  }).format(Number(value) || 0);
}

function field(label, value) {
  return {
    type: "box",
    layout: "baseline",
    spacing: "sm",
    contents: [
      { type: "text", text: label, weight: "bold", size: "sm", flex: 4, wrap: true },
      { type: "text", text: String(value || "-"), size: "sm", flex: 7, wrap: true },
    ],
  };
}

function bubble(title, rows, statusText, statusColor = "#9A6700") {
  return {
    type: "bubble",
    header: {
      type: "box",
      layout: "vertical",
      backgroundColor: "#9C5B15",
      paddingAll: "16px",
      contents: [{ type: "text", text: title, color: "#FFFFFF", weight: "bold", size: "lg", wrap: true }],
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        ...rows,
        { type: "separator", margin: "md" },
        { type: "text", text: statusText, color: statusColor, weight: "bold", wrap: true, margin: "md" },
      ],
    },
  };
}

function metadataRows(record) {
  const metadata = record.metadata || {};
  return [
    field("เลขติดตาม", metadata.trackingCode),
    field("ผู้ขอเบิก", metadata.claimantName),
    field("รอบค่าใช้จ่าย", formatExpensePeriod(metadata.expensePeriod)),
    field("ยอดรวม", formatAmount(metadata.totalAmount)),
    field("จำนวนรายการ", `${metadata.itemCount || 0} รายการ`),
  ];
}

function buildExpenseReceiptPrintOrderLineMessage(record) {
  return {
    type: "flex",
    altText: `ใบสำคัญรับเงิน ${record.metadata?.trackingCode || ""} — สั่งพิมพ์สำนักงานใหญ่`,
    contents: bubble(
      "🧾 ใบสำคัญรับเงิน — อนุมัติสั่งพิมพ์",
      metadataRows(record),
      "สถานะ: อนุมัติแล้ว กำลังส่งคำสั่งพิมพ์ไปสำนักงานใหญ่",
      "#0A7A3D",
    ),
  };
}

function buildExpenseReceiptPrintCompletionMessage(job, record) {
  return {
    type: "flex",
    altText: `ใบสำคัญรับเงิน ${record.metadata?.trackingCode || ""} — พิมพ์แล้ว`,
    contents: bubble(
      "🖨️ ใบสำคัญรับเงิน — พิมพ์แล้ว",
      [
        ...metadataRows(record),
        field("เครื่องพิมพ์", `${job.printerName || "-"} (${job.agentHost || "-"})`),
      ],
      "สถานะ: พิมพ์ที่สำนักงานใหญ่สำเร็จ",
      "#0A7A3D",
    ),
  };
}

function buildExpenseReceiptPrintOrderEmail(record, options = {}) {
  const metadata = record.metadata || {};
  const period = formatExpensePeriod(metadata.expensePeriod);
  const subject = `[ใบสำคัญรับเงิน][สั่งพิมพ์] ${period} — ${metadata.claimantName || record.filename}`;
  const lines = [
    "อนุมัติใบสำคัญรับเงินและส่งคำสั่งพิมพ์ไปสำนักงานใหญ่แล้ว",
    `เลขติดตาม: ${metadata.trackingCode || "-"}`,
    `ผู้ขอเบิก: ${metadata.claimantName || "-"}`,
    `รอบค่าใช้จ่าย: ${period}`,
    `ยอดรวม: ${formatAmount(metadata.totalAmount)}`,
    `จำนวนรายการ: ${metadata.itemCount || 0} รายการ`,
    "",
    "สถานะปัจจุบัน: อนุมัติแล้วและกำลังเข้าคิวพิมพ์ที่สำนักงานใหญ่",
  ];
  if (options.downloadUrl) lines.push(`ตรวจสอบ/ดาวน์โหลด: ${options.downloadUrl}`);
  return { subject, text: lines.join("\n") };
}

module.exports = {
  buildExpenseReceiptPrintCompletionMessage,
  buildExpenseReceiptPrintOrderEmail,
  buildExpenseReceiptPrintOrderLineMessage,
  formatAmount,
  formatExpensePeriod,
};
