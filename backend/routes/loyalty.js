const express = require("express");
const pool    = require("../db");
const { createId, generateMemberCode, hashOpaqueToken, normalizePhone, parseBearerToken } = require("../lib/sccrm");
const { buildSourceEventKey } = require("../lib/sccrmCrm");

const router = express.Router();

// ── Auth ──────────────────────────────────────────────────────────────────────

async function requireStaff(req, res, next) {
    try {
          const token = parseBearerToken(req.headers.authorization);
          if (!token) return res.status(401).json({ error: "Missing token." });
          const tokenHash = hashOpaqueToken(token);
          const { rows } = await pool.query(
                  `SELECT sd.id, sd.device_id, sd.device_name, sd.branch_id,
                                b.name AS branch_name, b.code AS branch_code
                                       FROM staff_devices sd
                                              LEFT JOIN branches b ON b.id = sd.branch_id
                                                     WHERE sd.token_hash = $1 AND sd.revoked_at IS NULL`,
                  [tokenHash],
                );
          if (!rows[0]) return res.status(401).json({ error: "Invalid or revoked staff device token." });
          await pool.query(`UPDATE staff_devices SET last_seen_at = NOW() WHERE id = $1`, [rows[0].id]);
          req.staffDevice = rows[0];
          return next();
    } catch (error) {
          return res.status(500).json({ error: error.message || "Failed to verify staff device." });
    }
}

// ── POS API Key Auth (for WinForms POS / branch sync) ────────────────────────
// Accepts the shared secret via x-pos-api-key header.
// Falls back to BRANCH_STOCK_SYNC_TOKEN for backward compat.

function requirePosApiKey(req, res, next) {
    const provided = req.headers["x-pos-api-key"];
    if (!provided) return res.status(401).json({ error: "Missing x-pos-api-key header." });

  const validKeys = [
        process.env.POS_API_KEY,
        process.env.BRANCH_STOCK_SYNC_TOKEN,
      ].filter(Boolean);

  if (validKeys.length === 0) {
        return res.status(500).json({ error: "POS_API_KEY is not configured on the server." });
  }

  if (!validKeys.includes(provided)) {
        return res.status(401).json({ error: "Invalid x-pos-api-key." });
  }

  return next();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function queryOne(sql, params) {
    const { rows } = await pool.query(sql, params);
    return rows[0] || null;
}

function computeAwardedPoints(totalAmount) {
    return Math.max(0, Math.floor(Number(totalAmount) / 100));
}

function normalizeDocRef(value) {
    return String(value || "").trim().toUpperCase();
}

function normalizeMemberSex(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) return null;
    if (["1", "male", "m"].includes(raw)) return "male";
    if (["2", "female", "f"].includes(raw)) return "female";
    return null;
}

function normalizeMemberDob(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function normalizeNullableText(value) {
    const raw = String(value || "").trim();
    return raw || null;
}

function normalizeUppercaseText(value) {
    const raw = normalizeNullableText(value);
    return raw ? raw.toUpperCase() : null;
}

function parseOptionalDecimal(value, fieldName) {
    if (value === undefined || value === null || value === "") return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${fieldName} must be a valid number.`);
    return parsed;
}

function parseOptionalInteger(value, fieldName) {
    if (value === undefined || value === null || value === "") return null;
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) throw new Error(`${fieldName} must be an integer.`);
    return parsed;
}

function parseBooleanFlag(value) {
    if (value === undefined || value === null || value === "") return false;
    if (typeof value === "boolean") return value;
    const raw = String(value).trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(raw)) return true;
    if (["false", "0", "no", "n"].includes(raw)) return false;
    return Boolean(value);
}

function getNestedValue(source, camelKey, snakeKey) {
    if (!source || typeof source !== "object") return undefined;
    if (Object.prototype.hasOwnProperty.call(source, camelKey)) return source[camelKey];
    if (snakeKey && Object.prototype.hasOwnProperty.call(source, snakeKey)) return source[snakeKey];
    return undefined;
}

function normalizePidDocumentType(value) {
    const raw = normalizeNullableText(value);
    if (!raw) return null;

    const upper = raw.toUpperCase();
    const aliases = {
        THAI_ID: "THAI_ID",
        "สัญชาติไทย": "THAI_ID",
        ALIEN_ID: "ALIEN_ID",
        "ไม่มีสัญชาติไทย": "ALIEN_ID",
        PASSPORT: "PASSPORT",
        "พาสปอร์ต": "PASSPORT",
        OTHER: "OTHER",
        "อื่น ๆ": "OTHER",
        "อื่นๆ": "OTHER",
    };

    return aliases[upper] || aliases[raw] || null;
}

function isValidThaiNationalId(value) {
    if (!/^\d{13}$/.test(value)) return false;
    let sum = 0;
    for (let i = 0; i < 12; i += 1) {
        sum += Number(value[i]) * (13 - i);
    }
    return ((11 - (sum % 11)) % 10) === Number(value[12]);
}

function normalizePidDocument(documentType, rawValue) {
    const raw = rawValue == null ? null : String(rawValue);
    if (!documentType && !normalizeNullableText(raw)) {
        return { documentType: null, rawValue: null, normalizedValue: null };
    }

    if (!documentType) {
        throw new Error("pharmacy_med_record.pidDocumentType is required when pid document data is provided.");
    }

    const trimmedRaw = raw == null ? null : raw.trim();
    if (!trimmedRaw) {
        return { documentType, rawValue: null, normalizedValue: null };
    }

    if (documentType === "THAI_ID" || documentType === "ALIEN_ID") {
        const normalized = trimmedRaw.replace(/\s+/g, "");
        if (!/^\d{13}$/.test(normalized)) {
            throw new Error(`pharmacy_med_record.${documentType === "THAI_ID" ? "pidDocumentNumberRaw" : "pidDocumentNumberRaw"} must contain exactly 13 digits.`);
        }
        if (documentType === "THAI_ID" && !isValidThaiNationalId(normalized)) {
            throw new Error("pharmacy_med_record.pidDocumentNumberRaw failed Thai national ID checksum validation.");
        }
        return { documentType, rawValue: trimmedRaw, normalizedValue: normalized };
    }

    if (documentType === "PASSPORT") {
        const normalized = trimmedRaw.replace(/\s+/g, "").toUpperCase();
        if (!/^[A-Z0-9]+$/.test(normalized)) {
            throw new Error("pharmacy_med_record.pidDocumentNumberRaw must contain uppercase letters and numbers only for PASSPORT.");
        }
        return { documentType, rawValue: trimmedRaw, normalizedValue: normalized };
    }

    if (documentType === "OTHER") {
        return { documentType, rawValue: trimmedRaw, normalizedValue: trimmedRaw };
    }

    throw new Error("pharmacy_med_record.pidDocumentType is invalid.");
}

function normalizePharmacyMedRecord(input) {
    if (input === undefined) return undefined;
    if (input === null) {
        return {
            pidDocumentType: null,
            pidDocumentNumberRaw: null,
            pidDocumentNumberNormalized: null,
            weightKg: null,
            heightCm: null,
            bpSystolic: null,
            bpDiastolic: null,
            bloodType: null,
            bloodRh: null,
            hasDiabetes: false,
            hasHypertension: false,
            hasHyperlipidemia: false,
            hasHeartDisease: false,
            hasKidneyDisease: false,
            hasLiverDisease: false,
            hasThyroidDisease: false,
            otherConditions: null,
            drugAllergies: null,
            foodAllergies: null,
            currentMedications: null,
            medicalHistory: null,
            isSmoker: false,
            drinksAlcohol: false,
            isPregnant: false,
            isBreastfeeding: false,
        };
    }

    if (typeof input !== "object" || Array.isArray(input)) {
        throw new Error("pharmacy_med_record must be an object.");
    }

    const documentType = normalizePidDocumentType(
        getNestedValue(input, "pidDocumentType", "pid_document_type"),
    );
    const documentRaw = getNestedValue(input, "pidDocumentNumberRaw", "pid_document_number_raw");
    const normalizedDocument = normalizePidDocument(documentType, documentRaw);

    return {
        pidDocumentType: normalizedDocument.documentType,
        pidDocumentNumberRaw: normalizedDocument.rawValue,
        pidDocumentNumberNormalized: normalizedDocument.normalizedValue,
        weightKg: parseOptionalDecimal(getNestedValue(input, "weightKg", "weight_kg"), "pharmacy_med_record.weightKg"),
        heightCm: parseOptionalDecimal(getNestedValue(input, "heightCm", "height_cm"), "pharmacy_med_record.heightCm"),
        bpSystolic: parseOptionalInteger(getNestedValue(input, "bpSystolic", "bp_systolic"), "pharmacy_med_record.bpSystolic"),
        bpDiastolic: parseOptionalInteger(getNestedValue(input, "bpDiastolic", "bp_diastolic"), "pharmacy_med_record.bpDiastolic"),
        bloodType: normalizeUppercaseText(getNestedValue(input, "bloodType", "blood_type")),
        bloodRh: normalizeNullableText(getNestedValue(input, "bloodRh", "blood_rh")),
        hasDiabetes: parseBooleanFlag(getNestedValue(input, "hasDiabetes", "has_diabetes")),
        hasHypertension: parseBooleanFlag(getNestedValue(input, "hasHypertension", "has_hypertension")),
        hasHyperlipidemia: parseBooleanFlag(getNestedValue(input, "hasHyperlipidemia", "has_hyperlipidemia")),
        hasHeartDisease: parseBooleanFlag(getNestedValue(input, "hasHeartDisease", "has_heart_disease")),
        hasKidneyDisease: parseBooleanFlag(getNestedValue(input, "hasKidneyDisease", "has_kidney_disease")),
        hasLiverDisease: parseBooleanFlag(getNestedValue(input, "hasLiverDisease", "has_liver_disease")),
        hasThyroidDisease: parseBooleanFlag(getNestedValue(input, "hasThyroidDisease", "has_thyroid_disease")),
        otherConditions: normalizeNullableText(getNestedValue(input, "otherConditions", "other_conditions")),
        drugAllergies: normalizeNullableText(getNestedValue(input, "drugAllergies", "drug_allergies")),
        foodAllergies: normalizeNullableText(getNestedValue(input, "foodAllergies", "food_allergies")),
        currentMedications: normalizeNullableText(getNestedValue(input, "currentMedications", "current_medications")),
        medicalHistory: normalizeNullableText(getNestedValue(input, "medicalHistory", "medical_history")),
        isSmoker: parseBooleanFlag(getNestedValue(input, "isSmoker", "is_smoker")),
        drinksAlcohol: parseBooleanFlag(getNestedValue(input, "drinksAlcohol", "drinks_alcohol")),
        isPregnant: parseBooleanFlag(getNestedValue(input, "isPregnant", "is_pregnant")),
        isBreastfeeding: parseBooleanFlag(getNestedValue(input, "isBreastfeeding", "is_breastfeeding")),
    };
}

function mapPharmacyMedRecordRow(row) {
    if (!row) return null;
    return {
        pidDocumentType: row.pid_document_type || null,
        pidDocumentNumberRaw: row.pid_document_number_raw || null,
        pidDocumentNumberNormalized: row.pid_document_number_normalized || null,
        weightKg: row.weight_kg != null ? Number(row.weight_kg) : null,
        heightCm: row.height_cm != null ? Number(row.height_cm) : null,
        bpSystolic: row.bp_systolic != null ? Number(row.bp_systolic) : null,
        bpDiastolic: row.bp_diastolic != null ? Number(row.bp_diastolic) : null,
        bloodType: row.blood_type || null,
        bloodRh: row.blood_rh || null,
        hasDiabetes: Boolean(row.has_diabetes),
        hasHypertension: Boolean(row.has_hypertension),
        hasHyperlipidemia: Boolean(row.has_hyperlipidemia),
        hasHeartDisease: Boolean(row.has_heart_disease),
        hasKidneyDisease: Boolean(row.has_kidney_disease),
        hasLiverDisease: Boolean(row.has_liver_disease),
        hasThyroidDisease: Boolean(row.has_thyroid_disease),
        otherConditions: row.other_conditions || null,
        drugAllergies: row.drug_allergies || null,
        foodAllergies: row.food_allergies || null,
        currentMedications: row.current_medications || null,
        medicalHistory: row.medical_history || null,
        isSmoker: Boolean(row.is_smoker),
        drinksAlcohol: Boolean(row.drinks_alcohol),
        isPregnant: Boolean(row.is_pregnant),
        isBreastfeeding: Boolean(row.is_breastfeeding),
    };
}

async function getPharmacyMedRecord(memberId) {
    return queryOne(
        `SELECT member_id,
                pid_document_type,
                pid_document_number_raw,
                pid_document_number_normalized,
                weight_kg,
                height_cm,
                bp_systolic,
                bp_diastolic,
                blood_type,
                blood_rh,
                has_diabetes,
                has_hypertension,
                has_hyperlipidemia,
                has_heart_disease,
                has_kidney_disease,
                has_liver_disease,
                has_thyroid_disease,
                other_conditions,
                drug_allergies,
                food_allergies,
                current_medications,
                medical_history,
                is_smoker,
                drinks_alcohol,
                is_pregnant,
                is_breastfeeding,
                created_at,
                updated_at
           FROM member_pharmacy_med_records
          WHERE member_id = $1`,
        [String(memberId)],
    );
}

async function upsertPharmacyMedRecord(client, memberId, normalizedRecord) {
    if (normalizedRecord === undefined) return;

    await client.query(
        `INSERT INTO member_pharmacy_med_records (
              member_id,
              pid_document_type,
              pid_document_number_raw,
              pid_document_number_normalized,
              weight_kg,
              height_cm,
              bp_systolic,
              bp_diastolic,
              blood_type,
              blood_rh,
              has_diabetes,
              has_hypertension,
              has_hyperlipidemia,
              has_heart_disease,
              has_kidney_disease,
              has_liver_disease,
              has_thyroid_disease,
              other_conditions,
              drug_allergies,
              food_allergies,
              current_medications,
              medical_history,
              is_smoker,
              drinks_alcohol,
              is_pregnant,
              is_breastfeeding,
              created_at,
              updated_at
          ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
              $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
              $21, $22, $23, $24, $25, $26, NOW(), NOW()
          )
          ON CONFLICT (member_id) DO UPDATE SET
              pid_document_type = EXCLUDED.pid_document_type,
              pid_document_number_raw = EXCLUDED.pid_document_number_raw,
              pid_document_number_normalized = EXCLUDED.pid_document_number_normalized,
              weight_kg = EXCLUDED.weight_kg,
              height_cm = EXCLUDED.height_cm,
              bp_systolic = EXCLUDED.bp_systolic,
              bp_diastolic = EXCLUDED.bp_diastolic,
              blood_type = EXCLUDED.blood_type,
              blood_rh = EXCLUDED.blood_rh,
              has_diabetes = EXCLUDED.has_diabetes,
              has_hypertension = EXCLUDED.has_hypertension,
              has_hyperlipidemia = EXCLUDED.has_hyperlipidemia,
              has_heart_disease = EXCLUDED.has_heart_disease,
              has_kidney_disease = EXCLUDED.has_kidney_disease,
              has_liver_disease = EXCLUDED.has_liver_disease,
              has_thyroid_disease = EXCLUDED.has_thyroid_disease,
              other_conditions = EXCLUDED.other_conditions,
              drug_allergies = EXCLUDED.drug_allergies,
              food_allergies = EXCLUDED.food_allergies,
              current_medications = EXCLUDED.current_medications,
              medical_history = EXCLUDED.medical_history,
              is_smoker = EXCLUDED.is_smoker,
              drinks_alcohol = EXCLUDED.drinks_alcohol,
              is_pregnant = EXCLUDED.is_pregnant,
              is_breastfeeding = EXCLUDED.is_breastfeeding,
              updated_at = NOW()`,
        [
            String(memberId),
            normalizedRecord.pidDocumentType,
            normalizedRecord.pidDocumentNumberRaw,
            normalizedRecord.pidDocumentNumberNormalized,
            normalizedRecord.weightKg,
            normalizedRecord.heightCm,
            normalizedRecord.bpSystolic,
            normalizedRecord.bpDiastolic,
            normalizedRecord.bloodType,
            normalizedRecord.bloodRh,
            normalizedRecord.hasDiabetes,
            normalizedRecord.hasHypertension,
            normalizedRecord.hasHyperlipidemia,
            normalizedRecord.hasHeartDisease,
            normalizedRecord.hasKidneyDisease,
            normalizedRecord.hasLiverDisease,
            normalizedRecord.hasThyroidDisease,
            normalizedRecord.otherConditions,
            normalizedRecord.drugAllergies,
            normalizedRecord.foodAllergies,
            normalizedRecord.currentMedications,
            normalizedRecord.medicalHistory,
            normalizedRecord.isSmoker,
            normalizedRecord.drinksAlcohol,
            normalizedRecord.isPregnant,
            normalizedRecord.isBreastfeeding,
        ],
    );
}

async function mirrorPosSaleClaim(client, payload) {
    const branchCode = normalizeDocRef(payload.branchCode);
    const receiptNo = normalizeDocRef(payload.receiptNo);
    if (!branchCode || !receiptNo) return null;

    const sourceEventKey = buildSourceEventKey("sale", branchCode, receiptNo);
    const existingSaleResult = await client.query(
        `SELECT id
           FROM crm_pos_sale_events
          WHERE source_event_key = $1`,
        [sourceEventKey],
    );
    const saleEventId = existingSaleResult.rows[0]?.id || createId();

    await client.query(
        `INSERT INTO crm_pos_sale_events
              (id, branch_code, pos_code, doc_no, doc_type, sale_at, cashier_code,
               gross_total, net_total, paid_total, ada_customer_code, claim_status,
               source_system, source_event_key, source_synced_at, tender_rows, raw_payload, created_at, updated_at)
         VALUES
              ($1, $2, NULL, $3, '1', $4, $5,
               $6, $7, $8, NULL, 'claimed',
               'SCCRMonPOS', $9, NOW(), '[]'::jsonb, $10::jsonb, NOW(), NOW())
         ON CONFLICT (source_event_key) DO UPDATE SET
               branch_code = EXCLUDED.branch_code,
               doc_no = EXCLUDED.doc_no,
               sale_at = EXCLUDED.sale_at,
               cashier_code = EXCLUDED.cashier_code,
               gross_total = EXCLUDED.gross_total,
               net_total = EXCLUDED.net_total,
               paid_total = EXCLUDED.paid_total,
               claim_status = 'claimed',
               source_synced_at = NOW(),
               raw_payload = EXCLUDED.raw_payload,
               updated_at = NOW()`,
        [
            saleEventId,
            branchCode,
            receiptNo,
            payload.soldAt || new Date().toISOString(),
            payload.cashierStaffCode,
            Number(payload.totalAmount || 0),
            Number(payload.totalAmount || 0),
            Number(payload.totalAmount || 0),
            sourceEventKey,
            JSON.stringify({
                mirrored_from: "loyalty_claims",
                loyalty_claim_id: payload.claimId,
                preview_points: payload.previewPoints,
            }),
        ],
    );

    await client.query(`DELETE FROM crm_pos_sale_line_events WHERE sale_event_id = $1`, [saleEventId]);
    for (let index = 0; index < payload.items.length; index += 1) {
        const item = payload.items[index];
        // eslint-disable-next-line no-await-in-loop
        await client.query(
            `INSERT INTO crm_pos_sale_line_events
                  (id, sale_event_id, line_no, product_code, barcode, qty, unit_code, unit_name, net_amount, discount_amount, lot_no, expiry_date, raw_payload, created_at)
             VALUES
                  ($1, $2, $3, $4, NULL, $5, NULL, NULL, $6, 0, NULL, NULL, $7::jsonb, NOW())`,
            [
                createId(),
                saleEventId,
                index + 1,
                String(item.productCode || "").trim() || null,
                Number(item.qty || 0),
                Number(item.lineTotal || 0),
                JSON.stringify(item),
            ],
        );
    }

    return saleEventId;
}

async function mirrorPosAward(client, saleEventId, memberId, awardedPoints, ledgerEntryId) {
    if (!saleEventId || !ledgerEntryId || !Number.isFinite(Number(awardedPoints)) || Number(awardedPoints) <= 0)
        return null;

    const existingAwardResult = await client.query(
        `SELECT id
           FROM crm_loyalty_awards
          WHERE sale_event_id = $1`,
        [saleEventId],
    );
    if (existingAwardResult.rows[0]) return existingAwardResult.rows[0].id;

    const awardId = createId();
    await client.query(
        `INSERT INTO crm_loyalty_awards
              (id, sale_event_id, customer_account_id, points_awarded, promotion_snapshot, ledger_entry_id, created_at)
         VALUES
              ($1, $2, $3, $4, '[]'::jsonb, $5, NOW())`,
        [awardId, saleEventId, memberId, Number(awardedPoints), ledgerEntryId],
    );
    return awardId;
}

function buildMemberResponse(row, pharmacyMedRecordRow) {
    return {
        id: row.id,
        name: row.full_name || "",
        displayName: row.full_name || "",
        phone: row.phone || null,
        email: row.email || null,
        sex: row.sex || null,
        dob: row.dob || null,
        remark: row.remark || null,
        memberCode: row.member_code || null,
        tier: row.tier || null,
        isActive: row.is_active,
        currentPoints: Number(row.current_points || 0),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        pharmacy_med_record: mapPharmacyMedRecordRow(pharmacyMedRecordRow),
    };
}

// ── GET /api/members/search?q=... ─────────────────────────────────────────────
// Cashier types a phone number, name, email, or member code.
// Returns up to 20 matching active members with their current point balance.

router.get("/search", requireStaff, async (req, res) => {
    try {
          const q = String(req.query.q || "").trim();
          if (!q) return res.json([]);

      const pattern = `%${q.toLowerCase()}%`;

      const { rows } = await pool.query(
              `SELECT u.id,
                            u.phone_number AS phone,
                                          u.full_name,
                                                        u.email,
                                                                      m.member_code,
                                                                                    m.tier,
                                                                                                  COALESCE((
                                                                                                                  SELECT SUM(pl.amount)
                                                                                                                                  FROM point_ledger pl
                                                                                                                                                  WHERE pl.user_id = u.id::uuid
                                                                                                                                                                ), 0) AS current_points
                                                                                                                                                                       FROM users u
                                                                                                                                                                              JOIN member_profiles m ON m.user_id = u.id AND m.is_active = TRUE
                                                                                                                                                                                     WHERE LOWER(COALESCE(u.phone_number, '')) LIKE $1
                                                                                                                                                                                               OR LOWER(COALESCE(u.full_name, '')) LIKE $1
                                                                                                                                                                                                         OR LOWER(COALESCE(u.email, '')) LIKE $1
                                                                                                                                                                                                                   OR LOWER(COALESCE(m.member_code, '')) LIKE $1
                                                                                                                                                                                                                          ORDER BY
                                                                                                                                                                                                                                   CASE
                                                                                                                                                                                                                                              WHEN LOWER(COALESCE(u.phone_number, '')) = $2 THEN 0
                                                                                                                                                                                                                                                         WHEN LOWER(COALESCE(m.member_code, '')) = $2 THEN 1
                                                                                                                                                                                                                                                                    WHEN LOWER(COALESCE(u.phone_number, '')) LIKE $3 THEN 2
                                                                                                                                                                                                                                                                               ELSE 3
                                                                                                                                                                                                                                                                                        END,
                                                                                                                                                                                                                                                                                                 u.full_name ASC
                                                                                                                                                                                                                                                                                                        LIMIT 20`,
              [pattern, q.toLowerCase(), `${q.toLowerCase()}%`],
            );

      return res.json(rows.map((r) => ({
              id: r.id,
              displayName: r.full_name || "",
              phone: r.phone || null,
              email: r.email || null,
              memberCode: r.member_code || null,
              currentPoints: Number(r.current_points || 0),
      })));
    } catch (error) {
          return res.status(500).json({ error: error.message || "Member search failed." });
    }
});

// ── GET /api/members/:id ──────────────────────────────────────────────────────
// WinForms POS fetches a single member by UUID.
// Auth: x-pos-api-key header (POS_API_KEY / BRANCH_STOCK_SYNC_TOKEN env var).

router.get("/:id", requirePosApiKey, async (req, res) => {
    try {
          const memberId = req.params.id;

      const row = await queryOne(
              `SELECT u.id,
                            u.full_name,
                                          u.phone_number AS phone,
                                                        u.email,
                                                                      u.sex,
                                                                                    u.dob::text AS dob,
                                                                                                  u.remark,
                                                                                                                u.created_at,
                                                                                                                              m.member_code,
                                                                                                                                            m.tier,
                                                                                                                                                          m.is_active,
                                                                                                                                                                        m.updated_at,
                                                                                                                                            COALESCE((
                                                                                                                                                            SELECT SUM(pl.amount)
                                                                                                                                                                            FROM point_ledger pl
                                                                                                                                                                                            WHERE pl.user_id = u.id::uuid
                                                                                                                                                                                                          ), 0) AS current_points
                                                                                                                                                                                                                 FROM users u
                                                                                                                                                                                                                        JOIN member_profiles m ON m.user_id = u.id
                                                                                                                                                                                                                               WHERE u.id = $1::uuid`,
              [memberId],
            );

      if (!row) return res.status(404).json({ error: "Member not found." });

      const pharmacyMedRecordRow = await getPharmacyMedRecord(memberId);
      return res.json(buildMemberResponse(row, pharmacyMedRecordRow));
    } catch (error) {
          return res.status(500).json({ error: error.message || "Failed to fetch member." });
    }
});

// ── PUT /api/members/:id ──────────────────────────────────────────────────────
// WinForms POS updates member profile fields (name, phone, email, sex, dob, remark).
// Auth: x-pos-api-key header (POS_API_KEY / BRANCH_STOCK_SYNC_TOKEN env var).
// Only fields present in the body are updated (COALESCE pattern).

router.put("/:id", requirePosApiKey, async (req, res) => {
    try {
          const memberId = req.params.id;
          const pharmacyMedRecord = normalizePharmacyMedRecord(req.body.pharmacy_med_record);

      // Check member exists
      const existing = await queryOne(
              `SELECT u.id FROM users u JOIN member_profiles m ON m.user_id = u.id WHERE u.id = $1::uuid`,
              [memberId],
            );
          if (!existing) return res.status(404).json({ error: "Member not found." });

      const name = req.body.name !== undefined ? String(req.body.name || "").trim() || null : undefined;
          const phone = req.body.phone !== undefined ? String(req.body.phone || "").trim() || null : undefined;
          const email = req.body.email !== undefined ? String(req.body.email || "").trim().toLowerCase() || null : undefined;
          const sex = req.body.sex !== undefined ? normalizeMemberSex(req.body.sex) : undefined;
          const dob = req.body.dob !== undefined ? normalizeMemberDob(req.body.dob) : undefined;
          const remark = req.body.remark !== undefined ? String(req.body.remark || "").trim() || null : undefined;

      // Build dynamic SET clause — only update provided fields
      const setClauses = [];
          const params = [];
          let idx = 1;

      if (name !== undefined)  { setClauses.push(`full_name = $${idx++}`);     params.push(name); }
          if (phone !== undefined) { setClauses.push(`phone_number = $${idx++}`);  params.push(phone); }
          if (email !== undefined) { setClauses.push(`email = $${idx++}`);         params.push(email); }
          if (sex !== undefined) { setClauses.push(`sex = $${idx++}`);             params.push(sex); }
          if (dob !== undefined) { setClauses.push(`dob = $${idx++}`);             params.push(dob); }
          if (remark !== undefined) { setClauses.push(`remark = $${idx++}`);       params.push(remark); }

      if (setClauses.length > 0) {
              params.push(memberId);
      }

      const client = await pool.connect();
      try {
              await client.query("BEGIN");

              if (setClauses.length > 0) {
                        await client.query(
                                    `UPDATE users SET ${setClauses.join(", ")} WHERE id = $${idx}::uuid`,
                                    params,
                                  );
              }

              await upsertPharmacyMedRecord(client, memberId, pharmacyMedRecord);
              await client.query("COMMIT");
      } catch (error) {
              await client.query("ROLLBACK");
              throw error;
      } finally {
              client.release();
      }

      // Fetch and return the updated record
      const row = await queryOne(
              `SELECT u.id,
                            u.full_name,
                                          u.phone_number AS phone,
                                                        u.email,
                                                                      u.sex,
                                                                                    u.dob::text AS dob,
                                                                                                  u.remark,
                                                                                                                u.created_at,
                                                                                                                              m.member_code,
                                                                                                                                            m.tier,
                                                                                                                                                          m.is_active,
                                                                                                                                                                        m.updated_at,
                                                                                                                                            COALESCE((
                                                                                                                                                            SELECT SUM(pl.amount)
                                                                                                                                                                            FROM point_ledger pl
                                                                                                                                                                                            WHERE pl.user_id = u.id::uuid
                                                                                                                                                                                                          ), 0) AS current_points
                                                                                                                                                                                                                 FROM users u
                                                                                                                                                                                                                        JOIN member_profiles m ON m.user_id = u.id
                                                                                                                                                                                                                               WHERE u.id = $1::uuid`,
              [memberId],
            );

      const pharmacyMedRecordRow = await getPharmacyMedRecord(memberId);
      return res.json({
              ok: true,
              ...buildMemberResponse(row, pharmacyMedRecordRow),
      });
    } catch (error) {
          const status = /pharmacy_med_record/.test(error.message || "") ? 400 : 500;
          return res.status(status).json({ error: error.message || "Failed to update member." });
    }
});

// ── POST /api/loyalty/claims ──────────────────────────────────────────────────
// Cashier submits a receipt on behalf of a selected member.
// Awards points and returns updated balance.

router.post("/claims", requireStaff, async (req, res) => {
    try {
          const receiptNo = String(req.body?.receiptNo || "").trim();
          const branchCode = String(req.body?.branchCode || "").trim();
          const memberId = String(req.body?.memberId || "").trim();
          const cashierStaffCode = String(req.body?.cashierStaffCode || "").trim() || null;
          const soldAt = req.body?.soldAt || null;
          const items = req.body?.items;
          const totalAmount = Number(req.body?.totalAmount);
          const previewPoints = req.body?.previewPoints != null ? Number(req.body.previewPoints) : null;

      if (!receiptNo) return res.status(400).json({ message: "receiptNo is required." });
          if (!branchCode) return res.status(400).json({ message: "branchCode is required." });
          if (!memberId) return res.status(400).json({ message: "memberId is required." });
          if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ message: "Receipt items are required." });
          if (!Number.isFinite(totalAmount) || totalAmount < 0) return res.status(400).json({ message: "totalAmount must be a non-negative number." });

      const awardedPoints = computeAwardedPoints(totalAmount);
          const client = await pool.connect();

      try {
              await client.query("BEGIN");

            // Duplicate receipt check
            const dup = await client.query(
                      `SELECT id FROM loyalty_claims WHERE branch_code = $1 AND receipt_no = $2`,
                      [branchCode, receiptNo],
                    );
              if (dup.rowCount > 0) {
                        await client.query("ROLLBACK");
                        return res.status(409).json({ message: "Receipt already claimed." });
              }

            // Member must exist and be active
            const memberRow = await client.query(
                      `SELECT u.id, u.full_name,
                                      m.member_code,
                                                      COALESCE((SELECT SUM(pl.amount) FROM point_ledger pl WHERE pl.user_id = u.id::uuid), 0) AS current_points
                                                               FROM users u
                                                                        JOIN member_profiles m ON m.user_id = u.id AND m.is_active = TRUE
                                                                                 WHERE u.id = $1::uuid`,
                      [memberId],
                    );
              if (!memberRow.rowCount) {
                        await client.query("ROLLBACK");
                        return res.status(404).json({ message: "Member not found." });
              }
              const member = memberRow.rows[0];

            // Insert claim header
            const claimId = createId();
              await client.query(
                        `INSERT INTO loyalty_claims
                                  (id, receipt_no, branch_code, cashier_staff_code, sold_at,
                                             total_amount, preview_points, awarded_points, user_id)
                                                      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                        [claimId, receiptNo, branchCode, cashierStaffCode, soldAt,
                                   Number(totalAmount), previewPoints, awardedPoints, memberId],
                      );

            // Insert line items
            for (const item of items) {
                      // eslint-disable-next-line no-await-in-loop
                await client.query(
                            `INSERT INTO loyalty_claim_items (id, claim_id, product_code, product_name, qty, unit_price, line_total)
                                       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                            [
                                          createId(),
                                          claimId,
                                          String(item.productCode || "").trim() || null,
                                          String(item.productName || "").trim() || null,
                                          Number(item.qty || 0),
                                          Number(item.unitPrice || 0),
                                          Number(item.lineTotal || 0),
                                        ],
                          );
            }

            // Write to point_ledger (source of truth)
            const newBalance = Number(member.current_points) + awardedPoints;
            let ledgerEntryId = null;
              if (awardedPoints > 0) {
                        ledgerEntryId = createId();
                        await client.query(
                                    `INSERT INTO point_ledger (id, user_id, amount, type, reference_id, note, created_by, created_at)
                                               VALUES ($1, $2::uuid, $3, 'purchase', $4, $5, 'cashier', NOW())`,
                                    [ledgerEntryId, memberId, awardedPoints, claimId, `Earned from receipt ${receiptNo}`],
                                  );
              }

            const saleEventId = await mirrorPosSaleClaim(client, {
                        branchCode,
                        receiptNo,
                        soldAt,
                        cashierStaffCode,
                        totalAmount,
                        previewPoints,
                        claimId,
                        items,
            });
            await mirrorPosAward(client, saleEventId, memberId, awardedPoints, ledgerEntryId);

            await client.query("COMMIT");

            return res.status(201).json({
                      ok: true,
                      claimId,
                      receiptNo,
                      member: {
                                  id: memberId,
                                  displayName: member.full_name || "",
                                  currentPoints: newBalance,
                      },
                      awardedPoints,
                      newPointsBalance: newBalance,
            });
      } catch (error) {
              await client.query("ROLLBACK");
              throw error;
      } finally {
              client.release();
      }
    } catch (error) {
          return res.status(500).json({ error: error.message || "Failed to create loyalty claim." });
    }
});

// ── POST /api/members ─────────────────────────────────────────────────────────
// Cashier registers a new loyalty member at the POS.
// Creates a users + member_profiles row. Never writes to AdaAcc.

router.post("/", requireStaff, async (req, res) => {
  try {
    const fullName   = String(req.body?.fullName ?? req.body?.name ?? "").trim();
    const phone      = normalizePhone(req.body?.phone || "");
    const email      = String(req.body?.email     || "").trim() || null;
    const sex        = normalizeMemberSex(req.body?.sex);
    const dob        = normalizeMemberDob(req.body?.dob);
    const remark     = String(req.body?.remark || "").trim() || null;
    const pharmacyMedRecord = normalizePharmacyMedRecord(req.body?.pharmacy_med_record);

    if (!fullName) return res.status(400).json({ message: "fullName is required." });
    if (!phone)    return res.status(400).json({ message: "phone is required." });

    const existing = await queryOne(`SELECT id FROM users WHERE phone_number = $1`, [phone]);
    if (existing) return res.status(409).json({ message: "เบอร์โทรนี้มีในระบบแล้ว" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const userId = createId();
      await client.query(
        `INSERT INTO users (id, phone_number, full_name, email, sex, dob, remark, password_hash, is_verified, verified_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, '', TRUE, NOW(), NOW())`,
        [userId, phone, fullName, email, sex, dob, remark],
      );

      const memberCode = generateMemberCode(userId);
      await client.query(
        `INSERT INTO member_profiles (id, user_id, member_code, tier, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, 'general', TRUE, NOW(), NOW())`,
        [createId(), userId, memberCode],
      );

      await upsertPharmacyMedRecord(client, userId, pharmacyMedRecord);

      await client.query("COMMIT");

      return res.status(201).json({
        ok:            true,
        id:            userId,
        name:          fullName,
        displayName:   fullName,
        phone,
        email,
        sex,
        dob,
        remark,
        memberCode,
        currentPoints: 0,
        pharmacy_med_record: pharmacyMedRecord === undefined ? null : pharmacyMedRecord,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    const status = /pharmacy_med_record/.test(error.message || "") ? 400 : 500;
    return res.status(status).json({ error: error.message || "Failed to create member." });
  }
});

module.exports = router;
