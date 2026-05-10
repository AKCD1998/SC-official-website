// Generic Cloudflare R2 storage for SC Official Website.
// Credentials come from R2_* env vars (reused from the cancelled scGlamLiff OCR project;
// the old SCGLAMLIFF_R2_* vars remain untouched — this is a clean parallel set).
//
// Falls back to local disk when R2 is not configured (development use).

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')
const fs = require('fs')
const path = require('path')

const r2Configured = !!(
  process.env.R2_ENDPOINT &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET
)

const client = r2Configured
  ? new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    })
  : null

const LOCAL_FALLBACK_DIR = path.join(__dirname, '..', 'uploads', 'slider')

/**
 * Upload a buffer to Cloudflare R2, or to local disk when R2 is not configured.
 * Returns the public URL of the uploaded file.
 *
 * @param {string} key       R2 object key, e.g. "slider/slider-slide-1-1234567890.png"
 * @param {Buffer} buffer    File content
 * @param {string} mimeType  e.g. "image/png"
 * @returns {Promise<string>} Public URL
 */
async function uploadFile(key, buffer, mimeType) {
  if (r2Configured) {
    await client.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
      })
    )
    const base = (process.env.R2_PUBLIC_BASE_URL || '').replace(/\/$/, '')
    return `${base}/${key}`
  }

  // Local disk fallback — only used when R2 env vars are absent (e.g. local dev)
  fs.mkdirSync(LOCAL_FALLBACK_DIR, { recursive: true })
  const filename = path.basename(key)
  fs.writeFileSync(path.join(LOCAL_FALLBACK_DIR, filename), buffer)
  return `/uploads/slider/${filename}`
}

module.exports = { uploadFile, r2Configured }
