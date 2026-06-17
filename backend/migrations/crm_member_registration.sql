-- Migration: CRM member registration fields
-- Run once against SC_OFFICIAL_DATABASE_URL (Render PostgreSQL)

-- 1. Add dob and sex to the shared users table
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS dob DATE,
  ADD COLUMN IF NOT EXISTS sex VARCHAR(10);

-- 2. Add remark to member_profiles (staff note recorded at registration)
ALTER TABLE member_profiles
  ADD COLUMN IF NOT EXISTS remark TEXT;

-- 3. PDPA / consent log
CREATE TABLE IF NOT EXISTS crm_member_consents (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  consent_version       VARCHAR(20) NOT NULL DEFAULT 'v1.0',
  pdpa_general          BOOLEAN NOT NULL DEFAULT FALSE,
  pdpa_health           BOOLEAN NOT NULL DEFAULT FALSE,
  marketing_email       BOOLEAN NOT NULL DEFAULT FALSE,
  marketing_sms         BOOLEAN NOT NULL DEFAULT FALSE,
  consented_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_by_device_id TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS crm_member_consents_user_id_idx
  ON crm_member_consents (user_id);

-- 4. Health records (pharmacist aid — staff-visible only)
--    pid_document_number stored as-is for Phase 1; encrypt at rest before production
CREATE TABLE IF NOT EXISTS crm_member_health_records (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pid_document_type     VARCHAR(20),
  pid_document_number   TEXT,
  has_diabetes          BOOLEAN NOT NULL DEFAULT FALSE,
  has_hypertension      BOOLEAN NOT NULL DEFAULT FALSE,
  has_hyperlipidemia    BOOLEAN NOT NULL DEFAULT FALSE,
  has_heart_disease     BOOLEAN NOT NULL DEFAULT FALSE,
  has_kidney_disease    BOOLEAN NOT NULL DEFAULT FALSE,
  has_liver_disease     BOOLEAN NOT NULL DEFAULT FALSE,
  has_thyroid_disease   BOOLEAN NOT NULL DEFAULT FALSE,
  other_conditions      TEXT,
  drug_allergies        TEXT,
  current_medications   TEXT,
  recorded_by_device_id TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS crm_member_health_records_user_id_idx
  ON crm_member_health_records (user_id);
