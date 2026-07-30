const fs = require("node:fs/promises");
const { createStoredFileStream, readStoredFile } = require("../services/fileStorageService");
const { sendGeneratedFileEmail } = require("../services/emailService");
const { getGeneratedFileById } = require("../db/generatedFileRepository");
const { badRequest, notFound } = require("../errors");
const { readEmailConfig } = require("../config");
const { isValidEmailList, normalizeString } = require("../validators");

async function downloadGeneratedFile(req, res) {
  const file = await getGeneratedFileById(req.params.id);

  if (!file.storagePath) {
    throw notFound(`Generated file has no storage path for id: ${req.params.id}`);
  }

  let stream;
  try {
    if (file.storageProvider !== "r2") {
      await fs.access(file.storagePath);
    }
    stream = await createStoredFileStream(file.storageProvider, file.storagePath);
  } catch (error) {
    throw notFound(`Generated file content not found for id: ${req.params.id}`);
  }

  res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(file.filename)}"`);

  stream.pipe(res);
}

async function sendGeneratedFileByEmail(req, res) {
  const file = await getGeneratedFileById(req.params.id);

  if (!file.storagePath) {
    throw notFound(`Generated file has no storage path for id: ${req.params.id}`);
  }

  const requestedTo = normalizeString(req.body && req.body.to);
  const to = requestedTo || readEmailConfig().docsRecipientEmail;

  if (!to || !isValidEmailList(to)) {
    throw badRequest("A valid recipient email address is required.");
  }

  let buffer;
  try {
    buffer = await readStoredFile(file.storageProvider, file.storagePath);
  } catch (error) {
    throw notFound(`Generated file content not found for id: ${req.params.id}`);
  }

  await sendGeneratedFileEmail({
    to,
    subject: `[ClaspSCxSeamless] ${file.filename}`,
    text: `แนบไฟล์เอกสาร: ${file.filename}`,
    filename: file.filename,
    mimeType: file.mimeType,
    buffer,
  });

  res.json({ ok: true, message: `ส่งไฟล์ไปยัง ${to} แล้ว`, to, fileId: file.id });
}

module.exports = { downloadGeneratedFile, sendGeneratedFileByEmail };
