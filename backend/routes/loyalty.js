const express = require("express");
const pool    = require("../db");
const { createId, generateMemberCode, hashOpaqueToken, normalizePhone, parseBearerToken } = require("../lib/sccrm");

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

function mapMemberRow(row) {
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

      return res.json(mapMemberRow(row));
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
              await pool.query(
                        `UPDATE users SET ${setClauses.join(", ")} WHERE id = $${idx}::uuid`,
                        params,
                      );
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

      return res.json({
              ok: true,
              ...mapMemberRow(row),
      });
    } catch (error) {
          return res.status(500).json({ error: error.message || "Failed to update member." });
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
              if (awardedPoints > 0) {
                        await client.query(
                                    `INSERT INTO point_ledger (id, user_id, amount, type, reference_id, note, created_by, created_at)
                                               VALUES ($1, $2::uuid, $3, 'purchase', $4, $5, 'cashier', NOW())`,
                                    [createId(), memberId, awardedPoints, claimId, `Earned from receipt ${receiptNo}`],
                                  );
              }

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
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to create member." });
  }
});

module.exports = router;
