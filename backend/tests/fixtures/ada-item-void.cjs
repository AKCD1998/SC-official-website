// Anonymized shape of a paid AdaFront sale: remove two bottles, then sell one.
function saleWithItemVoid() {
  const medicine = { productCode: 'MEDICINE-FIXTURE', productName: 'เภสัช ยาน้ำ fixture',
    barcode: 'SYNTHETIC-MEDICINE', unitCode: '004', unitName: 'ขวด', unitPrice: 85,
    lineDiscount: 0, promotionCode: null };
  return [
    { ...medicine, seq: 1, qty: 2, lineTotal: 170 },
    { ...medicine, seq: 2, productName: 'Void - ' + medicine.productName, qty: -2, lineTotal: -170 },
    { seq: 3, productCode: 'SALINE-FIXTURE', productName: 'น้ำเกลือ fixture', barcode: 'SYNTHETIC-SALINE',
      unitCode: '004', unitName: 'ขวด', qty: 2, unitPrice: 45, lineTotal: 90, lineDiscount: 0, promotionCode: null },
    { ...medicine, seq: 4, qty: 1, lineTotal: 85 },
  ];
}
module.exports = { saleWithItemVoid };
