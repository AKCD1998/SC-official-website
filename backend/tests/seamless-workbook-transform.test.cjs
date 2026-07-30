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

  test("copyWorksheet (used to build the preview workbook) preserves pageSetup and frozen view", async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("REP");
    worksheet.getCell("A1").value = "test";
    worksheet.pageSetup = { ...worksheet.pageSetup, orientation: "landscape", scale: 100 };
    worksheet.views = [{ state: "frozen", ySplit: 10 }];

    const targetWorkbook = new ExcelJS.Workbook();
    const copiedSheet = copyWorksheet(worksheet, targetWorkbook, "preview-copy");

    // Real bug: the preview workbook (the file users actually download/print first) silently
    // reverted to Portrait even though the processed_xlsx output was correctly landscape,
    // because copyWorksheet only copied cells/columns/merges, never these worksheet-level
    // properties.
    expect(copiedSheet.pageSetup.orientation).toBe("landscape");
    expect(copiedSheet.views).toEqual([{ state: "frozen", ySplit: 10 }]);
  });

  test.each(["individual", "summary"])(
    "transformWorkbook sets landscape page setup matching the legacy reference output (%s)",
    async (variant) => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Sheet1");
      sheet.getRow(5).getCell(1).value = "ATK";
      sheet.getRow(8).getCell(1).value = "HCODE";
      sheet.getRow(9).getCell(1).value = "D1180";

      const buffer = await workbook.xlsx.writeBuffer();
      const result = await transformWorkbook(Buffer.from(buffer), { requestedVariant: variant });

      // Verified directly against a real reprocessed report: fitToPage:false/scale:100
      // let the last column protrude onto a second page for wide (individual) tables, so
      // fitToPage/fitToWidth is used instead to guarantee the print engine always fits the
      // page to one page wide, regardless of the manual column-width squeeze's estimate.
      expect(result.worksheet.pageSetup.orientation).toBe("landscape");
      expect(result.worksheet.pageSetup.fitToPage).toBe(true);
      expect(result.worksheet.pageSetup.fitToWidth).toBe(1);
      expect(result.worksheet.pageSetup.fitToHeight).toBe(0);
      expect(result.worksheet.pageSetup.paperSize).toBe(9);
      expect(result.worksheet.pageSetup.margins).toEqual({
        left: 0.7,
        right: 0.7,
        top: 0.75,
        bottom: 0.75,
        header: 0,
        footer: 0,
      });
    },
  );

  test("transformWorkbook adds a report title banner for individual reports (branch + date, no header overlap)", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.getCell("C5").value = "2569/กรกฎาคม   27";
    sheet.getRow(8).getCell(1).value = "HCODE";
    sheet.getRow(9).getCell(1).value = "D5811";

    const buffer = await workbook.xlsx.writeBuffer();
    const result = await transformWorkbook(Buffer.from(buffer), { requestedVariant: "individual" });

    expect(result.worksheet.getCell("H1").value).toBe("รายคน สาขา 004 วันที่ 27/07/2026");
    expect(result.worksheet.getCell("H1").font).toMatchObject({ bold: true, size: 48 });
    // Individual's real header starts at row 8 — the title must stay within rows 1-5.
    expect(result.worksheet.model.merges.some((range) => /^H1:[A-Z]+5$/.test(range))).toBe(true);
  });

  test("transformWorkbook adds a report title banner for summary reports (branch + date, no header overlap)", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.getCell("C3").value = "29/07/2569 เวลา 16:56";
    sheet.getCell("C11").value = "D5811";
    // ATK sits well to the right of C3/C11 — collectSummaryColumnMatches deletes ATK and
    // everything to its right, so placing it at column 1 would wipe out the C3/C11 fixture data.
    sheet.getRow(5).getCell(10).value = "ATK";

    const buffer = await workbook.xlsx.writeBuffer();
    const result = await transformWorkbook(Buffer.from(buffer), { requestedVariant: "summary" });

    expect(result.worksheet.getCell("H1").value).toBe("สรุป สาขา 004 วันที่ 29/07/2026");
    // Summary's real header starts at row 5 — the title must stop at row 4, not overlap it.
    expect(result.worksheet.model.merges.some((range) => /^H1:[A-Z]+4$/.test(range))).toBe(true);
  });
});
