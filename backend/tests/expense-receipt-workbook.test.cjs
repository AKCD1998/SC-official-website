const ExcelJS = require("exceljs");
const {
  inspectExpenseReceiptWorkbook,
  normalizeThaiName,
} = require("../src/modules/seamless/services/expenseReceiptWorkbookService");
const { periodEndKey } = require("../src/modules/seamless/services/expenseReceiptService");

async function buildFixture() {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("ใบสำคัญรับเงิน");
  worksheet.getCell("A1").value = "ใบสำคัญรับเงิน";
  worksheet.getCell("H4").value = new Date(Date.UTC(2569, 8, 8));
  worksheet.getCell("B6").value = "นาย ชวิศ ดิษฐาพร";
  worksheet.getCell("G38").value = "ภก. ชวิศ ดิษฐาพร";
  worksheet.getCell("C8").value = "บริษัท เอสซี กรุ๊ป(1989) จำกัด";
  worksheet.getCell("C12").value = "12/07/26 15/07/26 SHOPEEPAY";
  worksheet.getCell("I12").value = 1605;
  worksheet.getCell("C13").value = "28/07/26 29/07/26 SHOPEE";
  worksheet.getCell("I13").value = 1893;
  worksheet.getCell("K13").value = 90;
  worksheet.getCell("C14").value = "01/08/26 02/08/26 Google Workspace";
  worksheet.getCell("I14").value = 828;
  worksheet.getCell("K14").value = 6;
  worksheet.getCell("C15").value = "04/08/26 05/08/26 RENDER.COM";
  worksheet.getCell("I15").value = 2764;
  worksheet.getCell("K15").value = 47;
  worksheet.getCell("N1").value = { formula: "SUM(I12:I31)+(SUM(K12:K31)/100)", result: 7091.43 };
  worksheet.getCell("C34").value = { formula: "N8", result: "เจ็ดพันเก้าสิบเอ็ดบาทสี่สิบสามสตางค์" };
  worksheet.pageSetup.printArea = "A1:L41";
  worksheet.pageSetup.fitToWidth = 1;
  return workbook.xlsx.writeBuffer();
}

describe("expense receipt workbook inspection", () => {
  test("extracts the claim and reports rows outside August", async () => {
    const result = await inspectExpenseReceiptWorkbook(await buildFixture(), {
      expensePeriod: "2026-08",
      expectedClaimantName: "ภก. ชวิศ ดิษฐาพร",
    });
    expect(result).toMatchObject({
      documentTitle: "ใบสำคัญรับเงิน",
      documentDate: "2026-09-08",
      claimantName: "ภก. ชวิศ ดิษฐาพร",
      totalAmount: 7091.43,
      itemCount: 4,
      firstExpenseDate: "2026-07-12",
      lastExpenseDate: "2026-08-05",
      printArea: "A1:L41",
    });
    expect(result.warnings.find((warning) => warning.code === "ITEMS_OUTSIDE_EXPENSE_PERIOD").rows)
      .toEqual([12, 13]);
  });

  test("matches common Thai honorific variants", () => {
    expect(normalizeThaiName("นาย ชวิศ ดิษฐาพร")).toBe(normalizeThaiName("ภก. ชวิศ ดิษฐาพร"));
  });

  test("uses the month end as the history date", () => {
    expect(periodEndKey("2026-08")).toBe("20260831");
    expect(periodEndKey("2024-02")).toBe("20240229");
  });
});
