const {
  buildAutomaticQuantityRules,
  extractPackagingQuantities,
} = require("../src/modules/seamless/services/shopeeAutomaticQuantityRules");

function record(sourceRow, companySku, variant, productName = "สินค้าทดสอบ") {
  return {
    match: { companySku, status: "matched" },
    productName,
    shopCode: "sc-drug-store",
    sourceRow,
    variant,
  };
}

function quantityObject(value) {
  return Object.fromEntries([...extractPackagingQuantities(value)].map(([unit, quantities]) => (
    [unit, [...quantities]]
  )));
}

test("extracts Thai and English packaging quantities without treating weights as units", () => {
  expect(quantityObject("80 กรัม 6 ก้อน")).toEqual({ bar: [6] });
  expect(quantityObject("24+1 ซอง")).toEqual({ sachet: [25] });
  expect(quantityObject("EXP ปกติ 3 bx")).toEqual({ box: [3] });
  expect(quantityObject("1 กล่อง 50 แผง")).toEqual({ box: [1], blister: [50] });
});

test("infers only a same-unit multiplier with a separate explicit one-unit anchor", () => {
  const oneBox = record(1, "IC-TEST", "1 กล่อง");
  const threeBoxes = record(2, "IC-TEST", "3 กล่อง");
  const rules = buildAutomaticQuantityRules([oneBox, threeBoxes]);

  expect(rules.get(oneBox)).toBeUndefined();
  expect(rules.get(threeBoxes)).toEqual({
    isMultipack: true,
    quantityPerSale: 3,
    quantityRuleSource: "catalog_same_sku_explicit_unit_anchor",
    quantityRuleStatus: "verified",
    quantityUnit: "box",
  });
});

test("uses the product name only when the variation has no packaging quantity", () => {
  const oneSachet = record(1, "IC-TEST", "", "1 ซอง 6 เม็ด สินค้าทดสอบ");
  const fiveSachets = record(2, "IC-TEST", "", "1 กล่อง 5 ซอง สินค้าทดสอบ");
  const rules = buildAutomaticQuantityRules([oneSachet, fiveSachets]);

  expect(rules.get(fiveSachets)).toMatchObject({
    quantityPerSale: 5,
    quantityUnit: "sachet",
  });
});

test("fails closed when pack sizes vary without an explicit one-unit anchor", () => {
  const sixSachets = record(1, "IC-TEST", "6 ซอง");
  const twelveSachets = record(2, "IC-TEST", "12 ซอง");
  const rules = buildAutomaticQuantityRules([sixSachets, twelveSachets]);

  expect(rules.get(sixSachets)).toMatchObject({
    isMultipack: true,
    quantityRuleStatus: "requires_validation",
  });
  expect(rules.get(twelveSachets)).toMatchObject({
    isMultipack: true,
    quantityRuleStatus: "requires_validation",
  });
  expect(rules.get(sixSachets)).not.toHaveProperty("quantityPerSale");
});
