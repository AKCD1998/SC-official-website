const ExcelJS = require("exceljs");
const { copyWorksheet, transformWorkbook } = require("../src/modules/seamless/services/workbookTransformService");

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

  test("copyWorksheet (used to build the preview workbook) preserves merged ranges", async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("REP");

    // A vertical 3-row merge, matching the real header shape (e.g. A8:A10 = "ลำดับที่").
    worksheet.getCell("A8").value = "ลำดับที่";
    worksheet.mergeCells("A8:A10");

    // A horizontal group-header merge with its own sub-header row beneath, matching M8:P8.
    worksheet.getCell("M8").value = "เรียกเก็บ";
    worksheet.mergeCells("M8:P8");
    worksheet.getCell("M9").value = "จำนวน";

    const targetWorkbook = new ExcelJS.Workbook();
    const copiedSheet = copyWorksheet(worksheet, targetWorkbook, "preview-copy");

    expect(new Set(copiedSheet.model.merges)).toEqual(new Set(["A8:A10", "M8:P8"]));

    // With the merge actually applied, only the master cell of each range reports the value —
    // the previous bug copied the "echoed" value into every cell as an independent literal,
    // leaving no merge at all and visibly duplicated text in every row.
    expect(copiedSheet.getCell("A8").value).toBe("ลำดับที่");
    expect(copiedSheet.getCell("A8").master.address).toBe("A8");
    expect(copiedSheet.getCell("A9").master.address).toBe("A8");
    expect(copiedSheet.getCell("A10").master.address).toBe("A8");
  });
});
