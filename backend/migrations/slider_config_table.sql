-- Stores custom slider image URLs for the SC Official Website homepage slider.
-- One row per slide. When a row exists, its image_url overrides the frontend default.
-- Run once against the main DATABASE_URL (same DB used by backend/db.js).

CREATE TABLE IF NOT EXISTS slider_config (
  slide_id   TEXT        PRIMARY KEY,
  image_url  TEXT        NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
