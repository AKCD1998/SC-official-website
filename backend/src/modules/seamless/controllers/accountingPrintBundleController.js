const service = require("../services/accountingOriginalPrintService");
const sourceOriginalService = require("../services/accountingSourceOriginalService");
const { forbidden, badRequest } = require("../errors");
function requireAdmin(req, res, next) {
  if (req.appRole !== "admin")
    return next(forbidden("เฉพาะผู้ดูแลเท่านั้นที่จัดชุดและสั่งพิมพ์ได้"));
  next();
}
async function download(req, res) {
  if (!["original", "preview"].includes(req.params.kind))
    throw badRequest("ประเภทไฟล์ไม่ถูกต้อง");
  const file = await service.getFile(
    req.params.id,
    req.params.itemId,
    req.params.kind,
  );
  res.type(file.mimeType);
  res.set("Cache-Control", "private, no-store");
  res.set(
    "Content-Disposition",
    (req.params.kind === "preview" || req.query.disposition === "inline" ? "inline" : "attachment") +
      "; filename*=UTF-8''" +
      encodeURIComponent(file.filename),
  );
  res.send(file.buffer);
}
async function downloadSourceOriginal(req, res) {
  const file = await sourceOriginalService.getSourceOriginal(req.params.sourceId);
  res.type(file.mimeType);
  res.set("Cache-Control", "private, no-store");
  res.set(
    "Content-Disposition",
    "inline; filename*=UTF-8''" + encodeURIComponent(file.filename),
  );
  res.send(file.buffer);
}
async function uploadSourceOriginals(req, res) {
  if (!req.files?.length) throw badRequest("กรุณาเลือก PDF รายงานการเงินต้นฉบับ");
  res.status(201).json(await sourceOriginalService.uploadSourceOriginals(
    req.files,
    req.params.shopCode,
    req.appActor,
  ));
}
async function upload(req, res) {
  const files = Object.values(req.files || {}).flat();
  if (!files.length) throw badRequest("กรุณาเลือกไฟล์ต้นฉบับ");
  res.status(201).json(await service.createBatch(files, req.appActor));
}
module.exports = {
  download,
  downloadSourceOriginal,
  requireAdmin,
  upload,
  uploadSourceOriginals,
};
