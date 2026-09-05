const { serviceUnavailable } = require("../errors");
function accountingPrintEnabled(req, res, next) {
  if (process.env.SEAMLESS_ACCOUNTING_BATCH_ENABLED !== "true") {
    return next(serviceUnavailable("ชุดพิมพ์เอกสารต้นฉบับยังไม่ได้เปิดใช้งาน"));
  }
  next();
}
module.exports = { accountingPrintEnabled };
