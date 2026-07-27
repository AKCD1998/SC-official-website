const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createReadStream } = require("node:fs");
const { readPublicBaseUrl, readStorageDir } = require("../config");
const r2Storage = require("./r2StorageService");

function storageRoot() {
  return path.resolve(process.cwd(), readStorageDir());
}

function safeSegment(value) {
  return (
    String(value || "file")
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160) || "file"
  );
}

async function ensureDirectory(...segments) {
  const directory = path.join(storageRoot(), ...segments.map(safeSegment));
  await fs.mkdir(directory, { recursive: true });
  return directory;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function writeStoredFile(kind, filename, buffer) {
  const uniqueName = `${Date.now()}-${crypto.randomUUID()}-${safeSegment(filename)}`;
  const checksumSha256 = sha256(buffer);

  if (r2Storage.r2Configured) {
    const key = r2Storage.buildKey(safeSegment(kind), uniqueName);
    await r2Storage.uploadBuffer(key, buffer);

    return {
      storageProvider: "r2",
      storagePath: key,
      fileSizeBytes: buffer.length,
      checksumSha256,
    };
  }

  const directory = await ensureDirectory(kind);
  const filePath = path.join(directory, uniqueName);
  await fs.writeFile(filePath, buffer);

  return {
    storageProvider: "local",
    storagePath: filePath,
    fileSizeBytes: buffer.length,
    checksumSha256,
  };
}

async function readStoredFile(storageProvider, storagePath) {
  if (storageProvider === "r2") {
    return r2Storage.getObjectBuffer(storagePath);
  }

  return fs.readFile(storagePath);
}

async function createStoredFileStream(storageProvider, storagePath) {
  if (storageProvider === "r2") {
    return r2Storage.getObjectStream(storagePath);
  }

  return createReadStream(storagePath);
}

function buildApiUrl(pathname) {
  const base = readPublicBaseUrl().replace(/\/+$/, "");
  return base ? `${base}${pathname}` : pathname;
}

module.exports = {
  buildApiUrl,
  createStoredFileStream,
  readStoredFile,
  sha256,
  writeStoredFile,
};
