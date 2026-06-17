const express = require('express');
const pool = require('../db');
const {
  createId,
  generateMemberCode,
  normalizePhone,
  hashOpaqueToken,
} = require('../lib/sccrm');

const router = express.Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jsonError(res, status, message) {
  return res.status(status).json({ error: message });
}

async function queryOne(sql, params) {
  const result = await pool.query(sql, params);
  return result.rows[0] || null;
}

async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────

async function requireStaff(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return jsonError(res, 401, 'Missing staff token.');
    const device = await queryOne(
      `SELECT sd.id, sd.device_id, sd.device_name, sd.branch_id,
              b.name AS branch_name, b.code AS branch_code
       FROM   staff_devices sd
       LEFT   JOIN branches b ON b.id = sd.branch_id
       WHERE  sd.token_hash = $1 AND sd.revoked_at IS NULL`,
      [hashOpaqueToken(token)]
    );
    if (!device) return jsonError(res, 401, 'Invalid or revoked staff token.');
    await pool.query(`UPDATE staff_devices SET last_seen_at = NOW() WHERE id = $1`, [device.id]);
    req.staffDevice = device;
    return next();
  } catch (err) {
    return jsonError(res, 500, err.message || 'Staff auth failed.');
  }
}

// ─── POST /api/crm/members ────────────────────────────────────────────────────
// Staff registers a new CRM member at the counter.
// Tables touched: users, member_profiles, crm_member_consents

router.post('/members', requireStaff, async (req, res) => {
  try {
    const {
      name,
      phone: rawPhone,
      email,
      dob,
      sex,
      remark,
      consents = {},
      consent_version = 'v1.0',
    } = req.body || {};

    const phone    = normalizePhone(rawPhone);
    const fullName = String(name || '').trim();

    if (!phone)    return jsonError(res, 400, 'phone is required.');
    if (!fullName) return jsonError(res, 400, 'name is required.');
    if (!dob)      return jsonError(res, 400, 'dob (date of birth) is required.');
    if (!consents.pdpa_general) {
      return jsonError(res, 400, 'pdpa_general consent is required for registration.');
    }

    // Duplicate checks
    const dupPhone = await queryOne(`SELECT id FROM users WHERE phone_number = $1`, [phone]);
    if (dupPhone) return jsonError(res, 409, 'เบอร์โทรนี้มีในระบบแล้ว');

    if (email) {
      const dupEmail = await queryOne(
        `SELECT id FROM users WHERE lower(email) = lower($1)`, [email]
      );
      if (dupEmail) return jsonError(res, 409, 'อีเมลนี้มีในระบบแล้ว');
    }

    const userId     = createId();
    const memberCode = generateMemberCode(userId);

    await withTransaction(async (client) => {
      // 1. SC Group account (no password — customer can set later via app)
      await client.query(
        `INSERT INTO users
           (id, phone_number, full_name, email, dob, sex,
            password_hash, is_verified, verified_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, TRUE, NOW(), NOW())`,
        [userId, phone, fullName, email || null, dob || null, sex || null]
      );

      // 2. Loyalty / member layer
      await client.query(
        `INSERT INTO member_profiles
           (id, user_id, member_code, tier, is_active, remark, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'bronze', TRUE, $3, NOW(), NOW())`,
        [userId, memberCode, remark || null]
      );

      // 3. PDPA consent record
      await client.query(
        `INSERT INTO crm_member_consents
           (id, user_id, consent_version,
            pdpa_general, pdpa_health, marketing_email, marketing_sms,
            consented_at, recorded_by_device_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)`,
        [
          createId(), userId, consent_version,
          !!consents.pdpa_general,
          !!consents.pdpa_health,
          !!consents.marketing_email,
          !!consents.marketing_sms,
          req.staffDevice.device_id,
        ]
      );
    });

    return res.status(201).json({
      ok: true,
      data: {
        id:         userId,
        memberCode,
        phone,
        name:       fullName,
      },
    });
  } catch (err) {
    if (/duplicate key/i.test(String(err.message))) {
      return jsonError(res, 409, 'เบอร์โทรหรืออีเมลนี้มีในระบบแล้ว');
    }
    console.error('[crmMembers] POST /members error:', err);
    return jsonError(res, 500, err.message || 'Registration failed.');
  }
});

// ─── PUT /api/crm/members/:id/health ─────────────────────────────────────────
// Save/update health record for a member.
// Requires pdpa_health consent (enforced by the frontend — not re-checked here).
// Uses UPSERT so calling twice is safe.

router.put('/members/:id/health', requireStaff, async (req, res) => {
  try {
    const userId = req.params.id;
    const member = await queryOne(`SELECT id FROM users WHERE id = $1`, [userId]);
    if (!member) return jsonError(res, 404, 'Member not found.');

    const {
      pidDocumentType,
      pidDocumentNumberRaw,
      hasDiabetes        = false,
      hasHypertension    = false,
      hasHyperlipidemia  = false,
      hasHeartDisease    = false,
      hasKidneyDisease   = false,
      hasLiverDisease    = false,
      hasThyroidDisease  = false,
      otherConditions,
      drugAllergies,
      currentMedications,
    } = req.body || {};

    await pool.query(
      `INSERT INTO crm_member_health_records
         (id, user_id,
          pid_document_type, pid_document_number,
          has_diabetes, has_hypertension, has_hyperlipidemia,
          has_heart_disease, has_kidney_disease, has_liver_disease, has_thyroid_disease,
          other_conditions, drug_allergies, current_medications,
          recorded_by_device_id, created_at, updated_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET pid_document_type     = EXCLUDED.pid_document_type,
             pid_document_number   = EXCLUDED.pid_document_number,
             has_diabetes          = EXCLUDED.has_diabetes,
             has_hypertension      = EXCLUDED.has_hypertension,
             has_hyperlipidemia    = EXCLUDED.has_hyperlipidemia,
             has_heart_disease     = EXCLUDED.has_heart_disease,
             has_kidney_disease    = EXCLUDED.has_kidney_disease,
             has_liver_disease     = EXCLUDED.has_liver_disease,
             has_thyroid_disease   = EXCLUDED.has_thyroid_disease,
             other_conditions      = EXCLUDED.other_conditions,
             drug_allergies        = EXCLUDED.drug_allergies,
             current_medications   = EXCLUDED.current_medications,
             recorded_by_device_id = EXCLUDED.recorded_by_device_id,
             updated_at            = NOW()`,
      [
        createId(), userId,
        pidDocumentType    || null,
        pidDocumentNumberRaw || null,
        !!hasDiabetes, !!hasHypertension, !!hasHyperlipidemia,
        !!hasHeartDisease, !!hasKidneyDisease, !!hasLiverDisease, !!hasThyroidDisease,
        otherConditions    || null,
        drugAllergies      || null,
        currentMedications || null,
        req.staffDevice.device_id,
      ]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error('[crmMembers] PUT /members/:id/health error:', err);
    return jsonError(res, 500, err.message || 'Failed to save health record.');
  }
});

module.exports = router;
