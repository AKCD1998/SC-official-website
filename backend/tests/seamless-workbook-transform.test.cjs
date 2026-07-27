const ExcelJS = require("exceljs");
const { transformWorkbook } = require("../src/modules/seamless/services/workbookTransformService");

// Pure-function test, no database — mirrors ClaspSCxSeamless's own workbook-transform.test.js
// regression: extra worksheets beyond the first must be removed from the transformed workbook,
// not just left in place unused.
describe("seamless workbookTransformService", () => {
  test("transform removes extra worksheets and keeps only the transformed first sheet", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.getRow(8).getCell(1).value = "HCODE";
    sheet.getRow(9).getCell(1).value = "D1180";
    workbook.addWorksheet("Sheet2");
    workbook.addWorksheet("Sheet3");

    const buffer = await workbook.xlsx.writeBuffer();
    const result = await transformWorkbook(Buffer.from(buffer), { requestedVariant: "individual" });

    expect(result.workbook.worksheets.length).toBe(1);
    expect(result.workbook.worksheets[0].id).toBe(result.worksheet.id);
  });
});
