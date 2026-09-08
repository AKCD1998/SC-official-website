const {
  buildExpenseReceiptPrintCompletionMessage,
  buildExpenseReceiptPrintOrderEmail,
  buildExpenseReceiptPrintOrderLineMessage,
  formatExpensePeriod,
} = require("../src/modules/seamless/services/expenseReceiptNotificationService");

const record = {
  filename: "expense_receipt_august_2026.xlsx",
  metadata: {
    source: "expense_receipt",
    trackingCode: "ER-202608-ABC12345",
    expensePeriod: "2026-08",
    claimantName: "ภก. ชวิศ ดิษฐาพร",
    totalAmount: 7091.43,
    itemCount: 4,
  },
};

describe("expense receipt notification templates", () => {
  test("approval LINE message names the document and print order", () => {
    const message = buildExpenseReceiptPrintOrderLineMessage(record);
    const text = JSON.stringify(message);
    expect(message.type).toBe("flex");
    expect(message.altText).toMatch(/ใบสำคัญรับเงิน/);
    expect(text).toMatch(/ER-202608-ABC12345/);
    expect(text).toMatch(/อนุมัติแล้ว/);
    expect(text).toMatch(/สำนักงานใหญ่/);
  });

  test("approval email is specific and accompanies the print order", () => {
    const email = buildExpenseReceiptPrintOrderEmail(record);
    expect(email.subject).toMatch(/^\[ใบสำคัญรับเงิน\]/);
    expect(email.subject).toMatch(/สั่งพิมพ์/);
    expect(email.subject).toMatch(/สิงหาคม 2569/);
    expect(email.text).toMatch(/สำนักงานใหญ่/);
  });

  test("print completion keeps the expense-receipt identity", () => {
    const message = buildExpenseReceiptPrintCompletionMessage(
      { printerName: "Brother MFC-T4500DW", agentHost: "HQ000" },
      record,
    );
    const text = JSON.stringify(message);
    expect(message.altText).toMatch(/ใบสำคัญรับเงิน/);
    expect(text).toMatch(/พิมพ์แล้ว/);
    expect(text).toMatch(/Brother MFC-T4500DW/);
  });

  test("formats August 2026 as Thai Buddhist year", () => {
    expect(formatExpensePeriod("2026-08")).toBe("สิงหาคม 2569");
  });
});
