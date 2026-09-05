const service = require("../services/accountingOriginalPrintService");
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
    (req.params.kind === "preview" ? "inline" : "attachment") +
      "; filename*=UTF-8''" +
      encodeURIComponent(file.filename),
  );
  res.send(file.buffer);
}
async function upload(req, res) {
  const files = Object.values(req.files || {}).flat();
  if (!files.length) throw badRequest("กรุณาเลือกไฟล์ต้นฉบับ");
  res.status(201).json(await service.createBatch(files, req.appActor));
}
module.exports = { requireAdmin, download, upload };
