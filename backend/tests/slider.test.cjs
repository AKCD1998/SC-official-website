const express = require('express')
const jwt = require('jsonwebtoken')
const request = require('supertest')

jest.mock('../db', () => ({
  query: jest.fn(() => Promise.resolve({ rows: [], rowCount: 0 })),
}))

jest.mock('../lib/r2Storage', () => ({
  uploadFile: jest.fn(),
  r2Configured: true,
}))

const pool = require('../db')
const { uploadFile } = require('../lib/r2Storage')
const sliderRouter = require('../routes/slider')

const JWT_SECRET = 'slider-test-secret'
const pngBuffer = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('test-image'),
])

function createApp() {
  const app = express()
  app.use('/api/slider', sliderRouter)
  return app
}

function tokenFor(email) {
  return jwt.sign({ userId: 123, email, fullName: 'Test User' }, JWT_SECRET, {
    expiresIn: '1h',
  })
}

beforeEach(() => {
  process.env.JWT_SECRET = JWT_SECRET
  process.env.SITE_ADMIN_EMAILS = 'admin@example.com,owner@example.com'

  uploadFile.mockReset()
  uploadFile.mockResolvedValue('/uploads/slider/new-image.png')

  pool.query.mockReset()
  pool.query.mockImplementation((sql) => {
    const text = String(sql)
    if (text.includes('SELECT slide_id')) {
      return Promise.resolve({
        rows: [{ slide_id: 'slide-1', image_url: '/uploads/slider/current.png' }],
        rowCount: 1,
      })
    }
    if (text.includes('INSERT INTO slider_config')) {
      return Promise.resolve({ rows: [], rowCount: 1 })
    }
    return Promise.resolve({ rows: [], rowCount: 0 })
  })
})

afterAll(() => {
  delete process.env.JWT_SECRET
  delete process.env.SITE_ADMIN_EMAILS
})

describe('homepage slider route', () => {
  test('GET /config returns public slide config and admin flag for allowed email', async () => {
    const response = await request(createApp())
      .get('/api/slider/config')
      .set('Authorization', `Bearer ${tokenFor('admin@example.com')}`)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      isAdmin: true,
      slides: { 'slide-1': '/uploads/slider/current.png' },
    })
  })

  test('POST /upload rejects missing auth before accepting files', async () => {
    const response = await request(createApp())
      .post('/api/slider/upload/slide-1')
      .attach('image', pngBuffer, { filename: 'slide.png', contentType: 'image/png' })

    expect(response.status).toBe(401)
    expect(uploadFile).not.toHaveBeenCalled()
  })

  test('POST /upload rejects logged-in users who are not slider admins', async () => {
    const response = await request(createApp())
      .post('/api/slider/upload/slide-1')
      .set('Authorization', `Bearer ${tokenFor('visitor@example.com')}`)
      .attach('image', pngBuffer, { filename: 'slide.png', contentType: 'image/png' })

    expect(response.status).toBe(403)
    expect(uploadFile).not.toHaveBeenCalled()
  })

  test('POST /upload rejects files with spoofed image MIME type', async () => {
    const response = await request(createApp())
      .post('/api/slider/upload/slide-1')
      .set('Authorization', `Bearer ${tokenFor('admin@example.com')}`)
      .attach('image', Buffer.from('not an image'), {
        filename: 'slide.png',
        contentType: 'image/png',
      })

    expect(response.status).toBe(400)
    expect(response.body.error).toMatch(/Invalid image content/)
    expect(uploadFile).not.toHaveBeenCalled()
  })

  test('POST /upload rejects unknown slide IDs', async () => {
    const response = await request(createApp())
      .post('/api/slider/upload/not-a-slide')
      .set('Authorization', `Bearer ${tokenFor('admin@example.com')}`)
      .attach('image', pngBuffer, { filename: 'slide.png', contentType: 'image/png' })

    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'Invalid slideId.' })
    expect(uploadFile).not.toHaveBeenCalled()
  })

  test('POST /upload stores valid admin image uploads and persists config', async () => {
    const response = await request(createApp())
      .post('/api/slider/upload/slide-1')
      .set('Authorization', `Bearer ${tokenFor('owner@example.com')}`)
      .attach('image', pngBuffer, { filename: 'slide.png', contentType: 'image/png' })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true, imageUrl: '/uploads/slider/new-image.png' })
    expect(uploadFile).toHaveBeenCalledWith(
      expect.stringMatching(/^slider\/slide-1-\d+-[a-f0-9-]+\.png$/),
      pngBuffer,
      'image/png'
    )
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO slider_config'),
      ['slide-1', '/uploads/slider/new-image.png']
    )
  })
})
