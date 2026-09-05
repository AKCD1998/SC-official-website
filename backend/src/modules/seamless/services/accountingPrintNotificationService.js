const { readLineConfig } = require("../config");

function buildAccountingBatchMessage(batch, items, eventKey, item, webUrl) {
  const titles = {
    ready: "ตัวอย่างเอกสารบัญชี Shopee พร้อมตรวจ ยังไม่ได้สั่งพิมพ์",
    started: "เริ่มพิมพ์ชุดเอกสารบัญชี Shopee",
    completed: "ชุดเอกสารบัญชี Shopee ออกจากคิวพิมพ์ครบแล้ว",
  };
  let title =
    titles[eventKey] ||
    (eventKey.startsWith("paused:")
      ? "หยุดชุดงานพิมพ์เอกสารบัญชี Shopee"
      : eventKey.startsWith("resumed:")
        ? "ดำเนินการชุดงานบัญชีต่อหลังตรวจสอบ"
        : "เอกสารของร้านออกจากคิวพิมพ์ครบแล้ว");
  const done = items.filter((row) => row.status === "completed").length;
  const pages = items.reduce((sum, row) => sum + (row.page_count || 0), 0);
  const lines = [
    title,
    "ชุดงาน: " + batch.id,
    batch.title,
    "เอกสาร " +
      items.length +
      " ไฟล์ / " +
      pages +
      " หน้า A4 / 1 ชุด / หน้าเดียว",
    "ออกจากคิวแล้ว " + done + "/" + items.length + " ไฟล์",
    "เครื่อง: " + batch.printer_name + " (" + batch.agent_host + ")",
  ];
  if (["ready", "started", "completed"].includes(eventKey)) {
    lines.push(
      "ลำดับ: รายงานการเงิน → Seller Balance → รายละเอียดรายรับ → คำสั่งซื้อ",
    );
    for (const shop of batch.manifest.shops) {
      const rows = items.filter((row) => row.document.shopCode === shop.code);
      lines.push(
        shop.name +
          ": ลำดับ " +
          rows[0].sequence +
          "–" +
          rows.at(-1).sequence +
          " (" +
          rows.length +
          " ไฟล์)",
      );
      const periods = [...new Set(rows.map((row) => row.document.periodStart))];
      for (const period of periods) {
        const week = rows.filter((row) => row.document.periodStart === period);
        lines.push(
          "  " +
            period +
            " ถึง " +
            week[0].document.periodEnd +
            ": ลำดับ " +
            week[0].sequence +
            "–" +
            week.at(-1).sequence,
        );
      }
      for (const row of rows.filter((row) => row.document.carryOver)) {
        lines.push(
          "  คำสั่งซื้อยกมา " +
            row.document.start +
            " ถึง " +
            row.document.end +
            " พิมพ์ลำดับ " +
            row.sequence +
            " ใช้ประกอบรายรับ " +
            row.document.relatedPeriods.join(", "),
        );
      }
    }
  }
  if (item)
    lines.push(
      "ลำดับ " + item.sequence + "/" + items.length + ": " + item.document.shop,
      "รอบ " + item.document.periodStart + " ถึง " + item.document.periodEnd,
      item.document.documentType,
      "ไฟล์: " + item.document.filename,
    );
  if (item?.error_message)
    lines.push(
      "สาเหตุ: " + item.error_message,
      "ระบบหยุดไฟล์ถัดไปแล้ว กรุณาตรวจเอกสารที่เครื่องก่อนกดทำต่อ",
    );
  if (eventKey === "completed" || eventKey.startsWith("shop-completed:"))
    lines.push(
      "สถานะอ้างอิงคิว Windows กรุณาตรวจว่ากระดาษออกครบและอ่านได้ก่อนลงบัญชี",
    );
  if (webUrl)
    lines.push(
      "รายการไฟล์และสถานะทั้งหมด: " +
        webUrl +
        "/accounting/print-bundle?batch=" +
        batch.id,
    );
  return lines.join("\n");
}
async function sendAccountingBatchText(text, retryKey) {
  const config = readLineConfig();
  if (!config.channelAccessToken || !config.targetId)
    throw new Error("ยังไม่ได้ตั้งค่า LINE สำหรับชุดงานบัญชี");
  if (text.length > 4900) throw new Error("ข้อความ LINE ยาวเกินกำหนด");
  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + config.channelAccessToken,
      "X-Line-Retry-Key": retryKey,
    },
    body: JSON.stringify({
      to: config.targetId,
      messages: [{ type: "text", text }],
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (
    response.ok ||
    (response.status === 409 &&
      response.headers.get("x-line-accepted-request-id"))
  )
    return;
  // Do not log the request/token/group id or response body.
  throw new Error("LINE รับข้อความไม่สำเร็จ (HTTP " + response.status + ")");
}
module.exports = { buildAccountingBatchMessage, sendAccountingBatchText };
