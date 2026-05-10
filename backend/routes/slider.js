const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const express = require('express')
const multer = require('multer')
const jwt = require('jsonwebtoken')
const pool = require('../db')
const { uploadFile } = require('../lib/r2Storage')

const router = express.Router()

// Run DB migration on first import so the table always exists before queries hit it.
;(async () => {
  try {
    const sql = fs.readFileSync(
      path.join(__dirname, '..', 'migrations', 'slider_config_table.sql'),
      'utf8'
    )
    await pool.query(sql)
  } catch (err) {
    console.error('[slider] Failed to run slider_config migration:', err.message)
  }
})()

// ── Allowed slide IDs ────────────────────────────────────────────────────────
const ALLOWED_SLIDE_IDS = new Set(['slide-1', 'slide-2', 'slide-3'])

// ── File type whitelist ──────────────────────────────────────────────────────
const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const MIME_TO_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null

  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png'
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }

  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }

  return null
}

// ── Multer — memory storage so files go straight to R2 (no temp disk writes) ─
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter(_req, file, cb) {
    if (ALLOWED_MIMES.has(file.mimetype)) return cb(null, true)
    cb(new Error('Invalid file type. Allowed: PNG, JPG, WebP.'))
  },
})

// ── Admin email check ────────────────────────────────────────────────────────
function isAdminEmail(email) {
  const list = (process.env.SITE_ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  return list.includes((email || '').toLowerCase())
}

// ── Optionally decode JWT without throwing ───────────────────────────────────
function tryDecodeJwt(req) {
  try {
    const auth = req.headers.authorization || ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
    if (!token || !process.env.JWT_SECRET) return null
    return jwt.verify(token, process.env.JWT_SECRET)
  } catch {
    return null
  }
}

// ── Middleware: require valid JWT + admin email ───────────────────────────────
function requireAdmin(req, res, next) {
  const payload = tryDecodeJwt(req)
  if (!payload) return res.status(401).json({ error: 'Missing or invalid token.' })
  if (!isAdminEmail(payload.email)) return res.status(403).json({ error: 'Forbidden.' })
  req.user = payload
  return next()
}

// ── GET /api/slider/config ────────────────────────────────────────────────────
// Public endpoint. Returns custom image URLs from DB + isAdmin flag if logged in.
router.get('/config', async (req, res) => {
  try {
    const payload = tryDecodeJwt(req)
    const isAdmin = payload ? isAdminEmail(payload.email) : false

    const result = await pool.query('SELECT slide_id, image_url FROM slider_config')
    const slides = {}
    for (const row of result.rows) {
      slides[row.slide_id] = row.image_url
    }

    return res.json({ isAdmin, slides })
  } catch (err) {
    console.error('[slider] GET /config error:', err.message)
    return res.status(500).json({ error: 'Failed to load slider config.' })
  }
})

// ── POST /api/slider/upload/:slideId ─────────────────────────────────────────
// Protected: valid JWT required, email must be in SITE_ADMIN_EMAILS.
router.post('/upload/:slideId', requireAdmin, (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      const status = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE' ? 413 : 400
      return res.status(status).json({ error: err.message })
    }
    next()
  })
}, async (req, res) => {
  const { slideId } = req.params

  if (!ALLOWED_SLIDE_IDS.has(slideId)) {
    return res.status(400).json({ error: 'Invalid slideId.' })
  }

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' })
  }

  // Re-validate mime server-side (do not trust Content-Type header alone)
  if (!ALLOWED_MIMES.has(req.file.mimetype)) {
    return res.status(400).json({ error: 'Invalid file type. Allowed: PNG, JPG, WebP.' })
  }

  const detectedMime = detectImageMime(req.file.buffer)
  if (!detectedMime || detectedMime !== req.file.mimetype) {
    return res.status(400).json({ error: 'Invalid image content. Allowed: PNG, JPG, WebP.' })
  }

  try {
    const ext = MIME_TO_EXT[detectedMime]
    const key = `slider/${slideId}-${Date.now()}-${crypto.randomUUID()}.${ext}`
    const imageUrl = await uploadFile(key, req.file.buffer, detectedMime)

    await pool.query(
      `INSERT INTO slider_config (slide_id, image_url, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (slide_id) DO UPDATE SET image_url = $2, updated_at = NOW()`,
      [slideId, imageUrl]
    )

    return res.json({ ok: true, imageUrl })
  } catch (err) {
    console.error('[slider] Upload error:', err.message)
    return res.status(500).json({ error: 'Upload failed. Please try again.' })
  }
})

module.exports = router
module.exports._test = {
  ALLOWED_MIMES,
  detectImageMime,
  isAdminEmail,
}
