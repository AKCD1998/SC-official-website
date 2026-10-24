const express = require("express");
const pool    = require("../db");
const { createId, generateMemberCode, hashOpaqueToken, normalizePhone, parseBearerToken } = require("../lib/sccrm");
const { buildSourceEventKey } = require("../lib/sccrmCrm");
const { getActivePromotions, quotePoints, receiptEligibleAmount } = require('../lib/sccrmPromotions');
const { buildReceiptSnapshot } = require('../lib/purchaseHistory');
const { getMemberPurchaseHistory } = require('../lib/memberPurchaseHistory');
const adaMirror = require('../lib/adaMemberMirror');

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

// POS staff already authenticate with the shared staff-device session for
// member creation/search. Use that same revocation-checked session for profiles.
// Existing branch integrations may continue to use their configured POS key.
function requireMemberAccess(req, res, next) {
    if (req.headers.authorization) return requireStaff(req, res, next);
    return requirePosApiKey(req, res, next);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function queryOne(sql, params, db = pool) {
    const { rows } = await db.query(sql, params);
    return rows[0] || null;
}

async function memberStorageCapabilities() {
    const row = await queryOne(`SELECT
        to_regclass('public.point_ledger') IS NOT NULL AS points_available,
        to_regclass('public.member_pharmacy_med_records') IS NOT NULL AS pharmacy_available`);
    return {
        pointsAvailable: Boolean(row?.points_available),
        pharmacyMedRecordAvailable: Boolean(row?.pharmacy_available),
    };
}

function memberPointsSql(capabilities) {
    return capabilities.pointsAvailable
        ? "COALESCE((SELECT SUM(pl.amount) FROM point_ledger pl WHERE pl.user_id = u.id::uuid), 0)"
        : "0::bigint";
}

function normalizeMemberPhone(value) {
    const phone = normalizePhone(value);
    if (/^\+66\d{9}$/.test(phone)) return `0${phone.slice(3)}`;
    if (/^66\d{9}$/.test(phone)) return `0${phone.slice(2)}`;
    return phone;
}

function requireAvailablePharmacyStorage(capabilities, input) {
    if (!capabilities.pharmacyMedRecordAvailable && input != null) {
        const error = new Error("Pharmacy records are not available. Save basic member details without pharmacy_med_record.");
        error.status = 503;
        throw error;
    }
}

function memberFailureStatus(error) {
    if (error.status) return error.status;
    if (error.code === "23505") return 409;
    return /pharmacy_med_record/.test(error.message || "") ? 400 : 500;
}

async function getMemberProfile(memberId, capabilities, db = pool) {
    const row = await queryOne(`SELECT u.id, u.full_name, u.phone_number AS phone,
        u.email, u.sex, u.dob::text AS dob, u.remark, u.created_at,
        m.member_code, m.tier, m.is_active, m.updated_at,
        ${memberPointsSql(capabilities)} AS current_points
        FROM users u JOIN member_profiles m ON m.user_id = u.id
        WHERE u.id = $1::uuid`, [memberId], db);
    if(row && !row.phone && adaMirror.enabled())row.phone=(await queryOne('SELECT phone_number FROM ada_history.directory WHERE id=$1::uuid',[memberId],db))?.phone_number||null;
    return row || await adaMirror.legacyProfile(db, memberId);
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

async function getPharmacyMedRecord(memberId, db = pool) {
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
        [String(memberId)], db,
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
    const snapshot = payload.receiptSnapshot;
    const receiptTotal = snapshot.totalAmount;

    await client.query(
        `INSERT INTO crm_pos_sale_events
              (id, branch_code, pos_code, doc_no, doc_type, sale_at, cashier_code,
               gross_total, net_total, paid_total, ada_customer_code, claim_status,
               source_system, source_event_key, source_synced_at, tender_rows, raw_payload, created_at, updated_at)
         VALUES
              ($1, $2, $11, $3, '1', $4, $5,
               $6, $7, $8, NULL, 'claimed',
               'SCCRMonPOS', $9, NOW(), '[]'::jsonb, $10::jsonb, NOW(), NOW())
         ON CONFLICT (source_event_key) DO UPDATE SET
               branch_code = EXCLUDED.branch_code,
               pos_code = EXCLUDED.pos_code,
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
            snapshot.receiptCashierCode || payload.cashierStaffCode,
            receiptTotal + (snapshot.receiptDiscount || 0),
            receiptTotal,
            receiptTotal,
            sourceEventKey,
            JSON.stringify({
                mirrored_from: "loyalty_claims",
                loyalty_claim_id: payload.claimId,
                preview_points: payload.previewPoints,
                eligible_amount: payload.totalAmount,
                receipt_snapshot: snapshot,
            }),
            snapshot.posCode,
        ],
    );

    await client.query(`DELETE FROM crm_pos_sale_line_events WHERE sale_event_id = $1`, [saleEventId]);
    for (let index = 0; index < snapshot.items.length; index += 1) {
        const item = snapshot.items[index];
        // eslint-disable-next-line no-await-in-loop
        await client.query(
            `INSERT INTO crm_pos_sale_line_events
                  (id, sale_event_id, line_no, product_code, barcode, qty, unit_code, unit_name, net_amount, discount_amount, lot_no, expiry_date, raw_payload, created_at)
             VALUES
                  ($1, $2, $3, $4, $8, $5, $10, $11, $6, $9, NULL, NULL, $7::jsonb, NOW())`,
            [
                createId(),
                saleEventId,
                index + 1,
                String(item.productCode || "").trim() || null,
                Number(item.qty || 0),
                Number(item.lineTotal || 0),
                JSON.stringify(item),
                item.barcode,
                item.lineDiscount || 0,
                item.unitCode || null,
                item.unitName || null,
            ],
        );
    }

    return saleEventId;
}

async function mirrorPosAward(client, saleEventId, memberId, awardedPoints, ledgerEntryId, promotions) {
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
              ($1, $2, $3, $4, $6::jsonb, $5, NOW())`,
        [awardId, saleEventId, memberId, Number(awardedPoints), ledgerEntryId, JSON.stringify(promotions || [])],
    );
    return awardId;
}

function buildMemberResponse(row, pharmacyMedRecordRow, capabilities = {}) {
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
        ...capabilities,
    };
}

// ── GET /api/members/search?q=... ─────────────────────────────────────────────
// Cashier types a phone number, name, email, or member code.
// Returns up to 20 matching active members with their current point balance.

router.get("/search", requireStaff, async (req, res) => {
    try {
        const raw = String(req.query.q || "").trim();
        if (!raw) return res.json([]);
        const q = /^[+\d\s().-]+$/.test(raw) ? normalizeMemberPhone(raw) : raw;
        const capabilities = await memberStorageCapabilities();
        const { rows } = await pool.query(`SELECT u.id, u.phone_number AS phone,
            u.full_name, u.email, m.member_code, m.tier,
            ${memberPointsSql(capabilities)} AS current_points
            FROM users u JOIN member_profiles m ON m.user_id = u.id AND m.is_active = TRUE
            WHERE LOWER(COALESCE(u.phone_number, '')) LIKE $1
               OR LOWER(COALESCE(u.full_name, '')) LIKE $1
               OR LOWER(COALESCE(u.email, '')) LIKE $1
               OR LOWER(COALESCE(m.member_code, '')) LIKE $1
            ORDER BY CASE
                WHEN LOWER(COALESCE(u.phone_number, '')) = $2 THEN 0
                WHEN LOWER(COALESCE(m.member_code, '')) = $2 THEN 1
                WHEN LOWER(COALESCE(u.phone_number, '')) LIKE $3 THEN 2
                ELSE 3 END, u.full_name ASC
            LIMIT 20`, [`%${q.toLowerCase()}%`, q.toLowerCase(), `${q.toLowerCase()}%`]);
        const members = rows.map(row => ({
            id: row.id, displayName: row.full_name || "", phone: row.phone || null,
            email: row.email || null, memberCode: row.member_code || null,
            currentPoints: Number(row.current_points || 0), ...capabilities,
        }));
        const legacy = await adaMirror.searchLegacy(pool, q, capabilities);
        return res.json([...members,...legacy.map(row=>({...row,...capabilities}))].filter((row,index,all)=>all.findIndex(other=>other.id===row.id)===index).slice(0,20));
    } catch (error) {
        return res.status(500).json({ error: error.message || "Member search failed." });
    }
});

// ── GET /api/members/:id ──────────────────────────────────────────────────────
// WinForms POS fetches a single member by UUID.
// Auth: existing staff-device session, or the legacy x-pos-api-key header.

router.get("/:id", requireMemberAccess, async (req, res) => {
    try {
        const capabilities = await memberStorageCapabilities();
        const row = await getMemberProfile(req.params.id, capabilities);
        if (!row) return res.status(404).json({ error: "Member not found." });
        const medical = capabilities.pharmacyMedRecordAvailable
            ? await getPharmacyMedRecord(req.params.id) : null;
        return res.json(buildMemberResponse(row, medical, capabilities));
    } catch (error) {
        return res.status(500).json({ error: error.message || "Failed to fetch member." });
    }
});

// ── GET /api/members/:id/purchase-history ─────────────────────────────────────
// WinForms POS fetches a member's claimed-purchase history with returns.
// Auth: revocable staff-device session, or the existing legacy POS key.
// NOTE: only bills the cashier linked to this member (via a loyalty claim) appear —
// AdaPos sales carry no member, so unclaimed purchases cannot be attributed here.
router.get("/:id/purchase-history", requireMemberAccess, async (req, res) => {
    try {
        return res.json(await getMemberPurchaseHistory(req.params.id, req.query));
    } catch (error) {
        return res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to fetch purchase history." });
    }
});

// ── PUT /api/members/:id ──────────────────────────────────────────────────────
// WinForms POS updates member profile fields (name, phone, email, sex, dob, remark).
// Auth: existing staff-device session, or the legacy x-pos-api-key header.
// Only fields present in the body are updated.

router.put("/:id", requireMemberAccess, async (req, res) => {
    try {
        const memberId = req.params.id;
        const body = req.body || {};
        const capabilities = await memberStorageCapabilities();
        requireAvailablePharmacyStorage(capabilities, body.pharmacy_med_record);
        const medical = normalizePharmacyMedRecord(body.pharmacy_med_record);
        const existing = await queryOne(
            `SELECT u.id FROM users u JOIN member_profiles m ON m.user_id = u.id WHERE u.id = $1::uuid`, [memberId]);
        if (!existing && !await adaMirror.legacyProfile(pool,memberId)) return res.status(404).json({ error: "Member not found." });

        const values = {
            full_name: body.name !== undefined ? String(body.name || "").trim() : undefined,
            phone_number: body.phone !== undefined ? normalizeMemberPhone(body.phone) : undefined,
            email: body.email !== undefined ? String(body.email || "").trim().toLowerCase() || null : undefined,
            sex: body.sex !== undefined ? normalizeMemberSex(body.sex) : undefined,
            dob: body.dob !== undefined ? normalizeMemberDob(body.dob) : undefined,
            remark: body.remark !== undefined ? String(body.remark || "").trim() || null : undefined,
        };
        if (values.full_name === "" || values.phone_number === "") {
            return res.status(400).json({ error: "name and phone must not be empty." });
        }
        const entries = Object.entries(values).filter(([, value]) => value !== undefined);
        const params = entries.map(([, value]) => value);
        const client = await pool.connect();
        let row, medicalRow;
        try {
            await client.query("BEGIN");
            await adaMirror.ensureLegacyMember(client,memberId);
            if (entries.length) {
                await client.query(`UPDATE users SET ${entries.map(([key], i) => `${key} = $${i + 1}`).join(", ")}
                    WHERE id = $${params.length + 1}::uuid`, [...params, memberId]);
                await client.query("UPDATE member_profiles SET updated_at = NOW() WHERE user_id = $1", [memberId]);
            }
            if (capabilities.pharmacyMedRecordAvailable) await upsertPharmacyMedRecord(client, memberId, medical);
            row = await getMemberProfile(memberId, capabilities, client);
            medicalRow = capabilities.pharmacyMedRecordAvailable ? await getPharmacyMedRecord(memberId, client) : null;
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally { client.release(); }
        return res.json({ ok: true, ...buildMemberResponse(row, medicalRow, capabilities) });
    } catch (error) {
        const message = error.code === "23505" ? "Phone or email already registered." : error.message || "Failed to update member.";
        return res.status(memberFailureStatus(error)).json({ error: message });
    }
});

// The receipt belongs to its stored member, regardless of the POS selection.
// Existing clients still submit claims through the unchanged POST below.
router.get("/claims/status", requireStaff, async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  const branchCode = normalizeDocRef(req.query.branchCode);
  const receiptNo = normalizeDocRef(req.query.receiptNo);
  if (typeof req.query.branchCode !== "string" || !/^[A-Z0-9_-]{1,50}$/.test(branchCode) ||
      typeof req.query.receiptNo !== "string" || !receiptNo || receiptNo.length > 100) {
    return res.status(400).json({ error: "branchCode and receiptNo are required." });
  }
  if (req.staffDevice.branch_code && normalizeDocRef(req.staffDevice.branch_code) !== branchCode) {
    return res.status(403).json({ error: "Receipt branch does not match staff device." });
  }
  try {
    const { rows } = await pool.query(
      `SELECT lc.id, lc.created_at, lc.user_id, u.full_name, m.member_code
       FROM loyalty_claims lc
       LEFT JOIN users u ON u.id = lc.user_id
       LEFT JOIN member_profiles m ON m.user_id = lc.user_id
       WHERE lc.branch_code = $1 AND lc.receipt_no = $2 LIMIT 1`,
      [branchCode, receiptNo],
    );
    const claim = rows[0];
    return res.json({
      ok: true, branchCode, receiptNo, claimed: Boolean(claim),
      ...(claim ? {
        claimId: claim.id, claimedAt: claim.created_at,
        member: { id: claim.user_id, displayName: claim.full_name || "", memberCode: claim.member_code || "" },
      } : {}),
    });
  } catch {
    return res.status(500).json({ error: "Failed to check receipt status." });
  }
});

// ── POST /api/loyalty/claims ──────────────────────────────────────────────────
// Cashier submits a receipt on behalf of a selected member.
// Awards points and returns updated balance.

router.post("/claims", requireStaff, async (req, res) => {
    try {
          const receiptNo = normalizeDocRef(req.body?.receiptNo);
          const branchCode = normalizeDocRef(req.body?.branchCode);
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

      const eligible = receiptEligibleAmount(items);
      const snapshot=buildReceiptSnapshot(req.body,items);
      if (Math.abs(eligible - totalAmount) > 0.011) return res.status(400).json({ message: 'totalAmount must equal eligible receipt lines.' });
      if (req.staffDevice.branch_code && normalizeDocRef(req.staffDevice.branch_code) !== normalizeDocRef(branchCode)) return res.status(403).json({ message: 'Receipt branch does not match staff device.' });
          const client = await pool.connect();

      try {
              await client.query("BEGIN");
              // Serialize awards for this member, including concurrent devices.
              await client.query('SELECT user_id FROM member_profiles WHERE user_id=$1::uuid FOR UPDATE', [memberId]);
              const promotions = await getActivePromotions(client, branchCode);
              const quote = quotePoints(eligible, promotions);
              const awardedPoints = quote.awardedPoints;

            // Duplicate receipt check
            const dup = await client.query(
                      `SELECT id FROM loyalty_claims WHERE branch_code = $1 AND receipt_no = $2`,
                      [branchCode, receiptNo],
                    );
              if (dup.rowCount > 0) {
                        await client.query("ROLLBACK");
                        return res.status(409).json({ message: "Receipt already claimed." });
              }

              await adaMirror.ensureLegacyMember(client,memberId);

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
                                             total_amount, preview_points, awarded_points, user_id, promotion_snapshot, promotion_revision,receipt_total_amount,receipt_snapshot)
                                                      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11,$12,$13::jsonb)`,
                        [claimId, receiptNo, branchCode, cashierStaffCode, soldAt,
                                   Number(totalAmount), previewPoints, awardedPoints, memberId, JSON.stringify(quote.appliedPromotions), quote.revision,snapshot.totalAmount,JSON.stringify(snapshot)],
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
                        receiptSnapshot:snapshot,
                        previewPoints,
                        claimId,
                        items,
            });
            await mirrorPosAward(client, saleEventId, memberId, awardedPoints, ledgerEntryId, quote.appliedPromotions);

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
                      promotionRevision: quote.revision,
                      appliedPromotions: quote.appliedPromotions,
            });
      } catch (error) {
              await client.query("ROLLBACK");
              throw error;
      } finally {
              client.release();
      }
    } catch (error) {
          const status = error.status || (error.code === '23505' ? 409 : 500);
          return res.status(status).json({ error: status === 409 ? 'Receipt already claimed.' : error.message || "Failed to create loyalty claim." });
    }
});

// ── POST /api/members ─────────────────────────────────────────────────────────
// Cashier registers a new loyalty member at the POS.
// Creates a users + member_profiles row. Never writes to AdaAcc.

router.post("/", requireStaff, async (req, res) => {
  try {
    const fullName   = String(req.body?.fullName ?? req.body?.name ?? "").trim();
    const phone      = normalizeMemberPhone(req.body?.phone || "");
    const email      = String(req.body?.email     || "").trim() || null;
    const sex        = normalizeMemberSex(req.body?.sex);
    const dob        = normalizeMemberDob(req.body?.dob);
    const remark     = String(req.body?.remark || "").trim() || null;
    const capabilities = await memberStorageCapabilities();
    requireAvailablePharmacyStorage(capabilities, req.body?.pharmacy_med_record);
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
         VALUES ($1, $2, $3, 'bronze', TRUE, NOW(), NOW())`,
        [createId(), userId, memberCode],
      );

      if (capabilities.pharmacyMedRecordAvailable) await upsertPharmacyMedRecord(client, userId, pharmacyMedRecord);

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
        pharmacy_med_record: capabilities.pharmacyMedRecordAvailable && pharmacyMedRecord !== undefined ? pharmacyMedRecord : null,
        ...capabilities,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    const message = error.code === "23505" ? "Phone or email already registered." : error.message || "Failed to create member.";
    return res.status(memberFailureStatus(error)).json({ error: message });
  }
});

module.exports = router;
