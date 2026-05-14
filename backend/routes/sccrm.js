/**
 * SCCRM API routes — unified identity architecture (Option B)
 *
 * Identity layer : users               (SC Group account — shared with website)
 * Auth links     : user_auth_providers (email / LINE / Google links)
 * Loyalty layer  : member_profiles     (tier, member_code, is_active)
 * Tokens         : customer_refresh_tokens (FK → users.id)
 * Ledger         : point_ledger        (FK → users.id)
 *
 * API surface is unchanged from the mobile app's perspective:
 *   - All URLs remain /api/sccrm/...
 *   - All request/response shapes remain the same
 *   - JWT payload still contains { scope, customerId, phone, email }
 *     where customerId = users.id
 */

const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const sgMail = require("@sendgrid/mail");
const pool = require("../db");
const {
  comparePassword,
  createId,
  createOpaqueToken,
  emailOtpExpiryDate,
  generateMemberCode,
  generateOtp,
  hashOpaqueToken,
  hashOtp,
  hashPassword,
  isEmail,
  issueCustomerAccessToken,
  issueOnboardingToken,
  normalizeImportRow,
  normalizePhone,
  parseBearerToken,
  parseImportCsv,
  refreshExpiryDate,
  resolvePointsWithPromotions,
  verifyAccessToken,
  calculateTier,
  EMAIL_OTP_ATTEMPT_LIMIT,
} = require("../lib/sccrm");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ─── Utility helpers ─────────────────────────────────────────────────────────

function jsonError(res, status, message) {
  return res.status(status).json({ error: message });
}

function readJsonCondition(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

async function queryOne(sql, params) {
  const result = await pool.query(sql, params);
  return result.rows[0] || null;
}

async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// ─── Customer view ────────────────────────────────────────────────────────────
// A "customer" as seen by the mobile app is a JOIN of users + member_profiles.
// phone_number is aliased to phone to keep the API surface unchanged.
// All routes that return a customer should use one of these two functions.

async function getCustomerView(whereClause, params) {
  return queryOne(
    `SELECT u.id,
            u.phone_number        AS phone,
            u.full_name,
            u.email,
            u.created_at,
            m.updated_at,
            m.tier,
            m.is_active,
            m.member_code
     FROM   users u
     JOIN   member_profiles m ON m.user_id = u.id
     WHERE  ${whereClause}`,
    params
  );
}

async function getCustomerViewById(userId) {
  return getCustomerView("u.id = $1", [userId]);
}

// ─── Point helpers ────────────────────────────────────────────────────────────

async function getCustomerBalance(userId) {
  const row = await queryOne(
    `SELECT COALESCE(SUM(amount), 0) AS balance
     FROM   point_ledger
     WHERE  user_id = $1`,
    [userId]
  );
  return Number(row?.balance || 0);
}

async function getCustomerLifetimeEarned(userId) {
  const row = await queryOne(
    `SELECT COALESCE(SUM(amount), 0) AS earned
     FROM   point_ledger
     WHERE  user_id = $1 AND amount > 0`,
    [userId]
  );
  return Number(row?.earned || 0);
}

async function recalculateTier(userId) {
  const lifetimeEarned = await getCustomerLifetimeEarned(userId);
  const tier = calculateTier(lifetimeEarned);
  await pool.query(
    `UPDATE member_profiles
     SET    tier = $2, updated_at = NOW()
     WHERE  user_id = $1`,
    [userId, tier]
  );
  return tier;
}

// ─── Promotion helpers ────────────────────────────────────────────────────────

async function getActivePromotions() {
  const result = await pool.query(
    `SELECT id, name, type, value, condition_json, starts_at, ends_at
     FROM   promotions
     WHERE  is_active = TRUE
       AND  (starts_at IS NULL OR starts_at <= NOW())
       AND  (ends_at   IS NULL OR ends_at   >= NOW())
     ORDER  BY starts_at ASC NULLS FIRST, created_at ASC`
  );
  return result.rows.map((row) => ({
    ...row,
    condition_json: readJsonCondition(row.condition_json),
  }));
}

// ─── Identity helpers ─────────────────────────────────────────────────────────

// Find an existing user+member by any known identity signal.
// Returns the full customer view or null.
async function findCustomerByIdentity({ lineUid, googleUid, email, phone }) {
  if (lineUid) {
    const found = await getCustomerView(
      `EXISTS (
         SELECT 1 FROM user_auth_providers p
         WHERE p.user_id = u.id
           AND p.provider = 'line'
           AND p.provider_user_id = $1
       )`,
      [lineUid]
    );
    if (found) return found;
  }
  if (googleUid) {
    const found = await getCustomerView(
      `EXISTS (
         SELECT 1 FROM user_auth_providers p
         WHERE p.user_id = u.id
           AND p.provider = 'google'
           AND p.provider_user_id = $1
       )`,
      [googleUid]
    );
    if (found) return found;
  }
  if (email) {
    const found = await getCustomerView("lower(u.email) = lower($1)", [email]);
    if (found) return found;
  }
  if (phone) {
    const found = await getCustomerView("u.phone_number = $1", [phone]);
    if (found) return found;
  }
  return null;
}

// Create a new SC Group user + member_profile in a single transaction.
// phone is required. password is optional (null for staff-created accounts).
// lineUid / googleUid are stored in user_auth_providers.
async function createUserWithMemberProfile({
  phone,
  fullName,
  email,
  password,
  lineUid,
  googleUid,
}) {
  const userId = createId();
  const passwordHash = password ? await hashPassword(password) : null;
  const memberCode = generateMemberCode(userId);

  await withTransaction(async (client) => {
    // 1. Create the SC Group account
    await client.query(
      `INSERT INTO users (id, phone_number, full_name, email, password_hash, is_verified, verified_at, created_at)
       VALUES ($1, $2, $3, $4, $5, TRUE, NOW(), NOW())`,
      [userId, phone, fullName || null, email || null, passwordHash]
    );

    // 2. Create the loyalty/member layer
    await client.query(
      `INSERT INTO member_profiles (id, user_id, member_code, tier, is_active, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'bronze', TRUE, NOW(), NOW())`,
      [userId, memberCode]
    );

    // 3. Record auth provider links
    if (email) {
      await client.query(
        `INSERT INTO user_auth_providers (user_id, provider, provider_user_id, created_at)
         VALUES ($1, 'email', NULL, NOW())
         ON CONFLICT (provider, provider_user_id) DO NOTHING`,
        [userId]
      );
    }
    if (lineUid) {
      await client.query(
        `INSERT INTO user_auth_providers (user_id, provider, provider_user_id, created_at)
         VALUES ($1, 'line', $2, NOW())`,
        [userId, lineUid]
      );
    }
    if (googleUid) {
      await client.query(
        `INSERT INTO user_auth_providers (user_id, provider, provider_user_id, created_at)
         VALUES ($1, 'google', $2, NOW())`,
        [userId, googleUid]
      );
    }
  });

  return getCustomerViewById(userId);
}

// ─── Session helpers ──────────────────────────────────────────────────────────

async function issueCustomerSession(customer, deviceLabel) {
  // issueCustomerAccessToken expects { id, phone, email }
  // customer view already has id, phone (aliased from phone_number), email
  const accessToken = issueCustomerAccessToken(customer);
  const refreshToken = createOpaqueToken();
  await pool.query(
    `INSERT INTO customer_refresh_tokens
       (id, user_id, token_hash, device_label, expires_at, created_at, last_used_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
    [
      createId(),
      customer.id,
      hashOpaqueToken(refreshToken),
      deviceLabel || null,
      refreshExpiryDate(),
    ]
  );
  return { accessToken, refreshToken };
}

async function sendVerificationEmail(email, otp) {
  if (!process.env.SENDGRID_API_KEY || !process.env.MAIL_USER) {
    throw new Error("SendGrid is not configured.");
  }
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  await sgMail.send({
    to: email,
    from: { email: process.env.MAIL_USER, name: "SCCRM" },
    subject: "Your SCCRM verification code",
    text: `Your SCCRM verification code is ${otp}. It expires in 10 minutes.`,
  });
}

// ─── Middleware ───────────────────────────────────────────────────────────────

async function requireCustomer(req, res, next) {
  try {
    const token = parseBearerToken(req.headers.authorization);
    if (!token) return jsonError(res, 401, "Missing token.");
    req.customerAuth = verifyAccessToken(token, "customer");
    return next();
  } catch {
    return jsonError(res, 401, "Invalid or expired token.");
  }
}

async function requireStaff(req, res, next) {
  try {
    const token = parseBearerToken(req.headers.authorization);
    if (!token) return jsonError(res, 401, "Missing token.");
    const tokenHash = hashOpaqueToken(token);
    const device = await queryOne(
      `SELECT id, device_id, device_name
       FROM   staff_devices
       WHERE  token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash]
    );
    if (!device) return jsonError(res, 401, "Invalid or revoked staff device token.");
    await pool.query(`UPDATE staff_devices SET last_seen_at = NOW() WHERE id = $1`, [device.id]);
    req.staffDevice = device;
    return next();
  } catch (error) {
    return jsonError(res, 500, error.message || "Failed to verify staff device.");
  }
}

async function requireStaffOrSameCustomer(req, res, next) {
  const bearer = parseBearerToken(req.headers.authorization);
  if (!bearer) return jsonError(res, 401, "Missing token.");
  try {
    const payload = verifyAccessToken(bearer, "customer");
    const targetId = req.params.id || req.params.customer_id;
    if (payload.customerId !== targetId) return jsonError(res, 403, "Forbidden.");
    req.customerAuth = payload;
    return next();
  } catch {
    return requireStaff(req, res, next);
  }
}

// ─── OAuth helpers ────────────────────────────────────────────────────────────

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  if (!response.ok) {
    const message = payload.error_description || payload.message || payload.raw || `Request failed: ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

async function exchangeLineCode(code) {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri:   process.env.SCCRM_LINE_REDIRECT_URI   || "",
    client_id:      process.env.SCCRM_LINE_CHANNEL_ID      || "",
    client_secret:  process.env.SCCRM_LINE_CHANNEL_SECRET  || "",
  });
  const tokenPayload = await fetchJson("https://api.line.me/oauth2/v2.1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const profile = await fetchJson("https://api.line.me/v2/profile", {
    headers: { Authorization: `Bearer ${tokenPayload.access_token}` },
  });
  return { lineUid: profile.userId, fullName: profile.displayName || null };
}

async function exchangeGoogleCode(code) {
  const params = new URLSearchParams({
    code,
    client_id:      process.env.SCCRM_GOOGLE_CLIENT_ID     || "",
    client_secret:  process.env.SCCRM_GOOGLE_CLIENT_SECRET || "",
    redirect_uri:   process.env.SCCRM_GOOGLE_REDIRECT_URI  || "",
    grant_type: "authorization_code",
  });
  const tokenPayload = await fetchJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const profile = await fetchJson("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${tokenPayload.access_token}` },
  });
  return { googleUid: profile.sub, fullName: profile.name || null, email: profile.email || null };
}

function ensureProviderEnv(provider) {
  const required =
    provider === "line"
      ? ["SCCRM_LINE_CHANNEL_ID", "SCCRM_LINE_CHANNEL_SECRET", "SCCRM_LINE_REDIRECT_URI"]
      : ["SCCRM_GOOGLE_CLIENT_ID", "SCCRM_GOOGLE_CLIENT_SECRET", "SCCRM_GOOGLE_REDIRECT_URI"];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`${key} is not configured.`);
  }
}

// ─── Routes: social auth ──────────────────────────────────────────────────────

router.post("/auth/line-callback", async (req, res) => {
  try {
    ensureProviderEnv("line");
    const { code, deviceLabel } = req.body || {};
    if (!code) return jsonError(res, 400, "code is required.");
    const identity = await exchangeLineCode(code);
    const customer = await findCustomerByIdentity(identity);
    if (customer) {
      return res.json({
        ok: true,
        onboardingRequired: false,
        customer,
        ...(await issueCustomerSession(customer, deviceLabel || "line-login")),
      });
    }
    const onboardingToken = issueOnboardingToken({
      provider: "line",
      lineUid: identity.lineUid,
      fullName: identity.fullName,
      email: null,
    });
    return res.json({ ok: true, onboardingRequired: true, onboardingToken, profile: identity });
  } catch (error) {
    return jsonError(res, 500, error.message || "Failed LINE callback.");
  }
});

router.post("/auth/google-callback", async (req, res) => {
  try {
    ensureProviderEnv("google");
    const { code, deviceLabel } = req.body || {};
    if (!code) return jsonError(res, 400, "code is required.");
    const identity = await exchangeGoogleCode(code);
    const customer = await findCustomerByIdentity(identity);
    if (customer) {
      return res.json({
        ok: true,
        onboardingRequired: false,
        customer,
        ...(await issueCustomerSession(customer, deviceLabel || "google-login")),
      });
    }
    const onboardingToken = issueOnboardingToken({
      provider: "google",
      googleUid: identity.googleUid,
      fullName: identity.fullName,
      email: identity.email,
    });
    return res.json({ ok: true, onboardingRequired: true, onboardingToken, profile: identity });
  } catch (error) {
    return jsonError(res, 500, error.message || "Failed Google callback.");
  }
});

// ─── Routes: email auth ───────────────────────────────────────────────────────

router.post("/auth/register", async (req, res) => {
  const { step } = req.body || {};
  try {
    // ── Step 1: send OTP ──────────────────────────────────────────────────
    if (step === "send-otp") {
      const email = String(req.body.email || "").trim().toLowerCase();
      if (!isEmail(email)) return jsonError(res, 400, "Valid email is required.");

      const existing = await queryOne(
        `SELECT id FROM users WHERE lower(email) = lower($1)`,
        [email]
      );
      if (existing) return jsonError(res, 409, "Email already registered.");

      const otp = generateOtp();
      await pool.query(
        `INSERT INTO customer_email_verifications
           (id, customer_email, otp_hash, expires_at, used_at, attempt_count, created_at)
         VALUES ($1, $2, $3, $4, NULL, 0, NOW())`,
        [createId(), email, hashOtp(email, otp), emailOtpExpiryDate()]
      );
      await sendVerificationEmail(email, otp);
      return res.json({ ok: true });
    }

    // ── Step 2: complete email signup ────────────────────────────────────
    if (step === "complete-email-signup") {
      const email    = String(req.body.email    || "").trim().toLowerCase();
      const otp      = String(req.body.otp      || "").trim();
      const phone    = normalizePhone(req.body.phone);
      const fullName = String(req.body.fullName || "").trim();
      const password = String(req.body.password || "");

      if (!isEmail(email) || !otp || !phone || !password) {
        return jsonError(res, 400, "email, otp, phone, and password are required.");
      }
      if (password.length < 8) return jsonError(res, 400, "Password must be at least 8 characters.");

      const verification = await queryOne(
        `SELECT id, otp_hash, expires_at, used_at, attempt_count
         FROM   customer_email_verifications
         WHERE  customer_email = $1
         ORDER  BY created_at DESC
         LIMIT  1`,
        [email]
      );
      if (!verification)                                       return jsonError(res, 400, "No verification request found.");
      if (verification.used_at)                                return jsonError(res, 400, "Verification code already used.");
      if (verification.attempt_count >= EMAIL_OTP_ATTEMPT_LIMIT) return jsonError(res, 429, "Too many attempts. Request a new code.");
      if (new Date(verification.expires_at).getTime() < Date.now()) return jsonError(res, 400, "Verification code expired.");
      if (verification.otp_hash !== hashOtp(email, otp)) {
        await pool.query(
          `UPDATE customer_email_verifications SET attempt_count = attempt_count + 1 WHERE id = $1`,
          [verification.id]
        );
        return jsonError(res, 400, "Invalid verification code.");
      }

      const existingPhone = await queryOne(`SELECT id FROM users WHERE phone_number = $1`, [phone]);
      if (existingPhone) return jsonError(res, 409, "Phone already registered.");

      const customer = await createUserWithMemberProfile({ phone, fullName, email, password });
      await pool.query(
        `UPDATE customer_email_verifications SET used_at = NOW() WHERE id = $1`,
        [verification.id]
      );
      return res.json({
        ok: true,
        customer,
        ...(await issueCustomerSession(customer, req.body.deviceLabel || "email-signup")),
      });
    }

    // ── Step 3: complete social signup ───────────────────────────────────
    if (step === "complete-social-signup") {
      const phone    = normalizePhone(req.body.phone);
      const password = String(req.body.password || "");
      const fullName = String(req.body.fullName || "").trim();
      const email    = req.body.email ? String(req.body.email).trim().toLowerCase() : null;
      if (!phone || !req.body.onboardingToken) {
        return jsonError(res, 400, "onboardingToken and phone are required.");
      }
      const onboarding = verifyAccessToken(req.body.onboardingToken, "sccrm-onboarding");

      const existingPhone = await queryOne(`SELECT id FROM users WHERE phone_number = $1`, [phone]);
      if (existingPhone) return jsonError(res, 409, "Phone already registered.");

      const customer = await createUserWithMemberProfile({
        phone,
        fullName: fullName || onboarding.fullName || null,
        email:    email    || onboarding.email    || null,
        password: password || null,
        lineUid:  onboarding.lineUid   || null,
        googleUid: onboarding.googleUid || null,
      });
      return res.json({
        ok: true,
        customer,
        ...(await issueCustomerSession(customer, req.body.deviceLabel || "social-signup")),
      });
    }

    return jsonError(res, 400, "Unsupported register step.");
  } catch (error) {
    const message = /duplicate key/i.test(String(error.message))
      ? "Account already exists."
      : error.message || "Registration failed.";
    return jsonError(res, 500, message);
  }
});

router.post("/auth/login", async (req, res) => {
  try {
    const email    = String(req.body?.email    || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!isEmail(email) || !password) return jsonError(res, 400, "email and password are required.");

    // Fetch user + member_profile together
    const row = await queryOne(
      `SELECT u.id,
              u.phone_number  AS phone,
              u.full_name,
              u.email,
              u.password_hash,
              u.created_at,
              m.updated_at,
              m.tier,
              m.is_active,
              m.member_code
       FROM   users u
       JOIN   member_profiles m ON m.user_id = u.id
       WHERE  lower(u.email) = lower($1)`,
      [email]
    );
    if (!row) return jsonError(res, 400, "Invalid email or password.");

    // Account exists but was created via social login only
    if (!row.password_hash) {
      return jsonError(res, 400, "This account uses social login. Please sign in with LINE or Google.");
    }

    const ok = await comparePassword(password, row.password_hash);
    if (!ok) return jsonError(res, 400, "Invalid email or password.");

    // Strip password_hash before building the customer object
    const { password_hash, ...customer } = row;
    return res.json({
      ok: true,
      customer,
      ...(await issueCustomerSession(customer, req.body.deviceLabel || "email-login")),
    });
  } catch (error) {
    return jsonError(res, 500, error.message || "Login failed.");
  }
});

router.post("/auth/refresh", async (req, res) => {
  try {
    const refreshToken = String(req.body?.refreshToken || "");
    if (!refreshToken) return jsonError(res, 400, "refreshToken is required.");
    const tokenHash = hashOpaqueToken(refreshToken);

    const stored = await queryOne(
      `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked_at,
              u.phone_number AS phone, u.email,
              m.tier, m.is_active, m.member_code
       FROM   customer_refresh_tokens rt
       JOIN   users           u ON u.id = rt.user_id
       JOIN   member_profiles m ON m.user_id = rt.user_id
       WHERE  rt.token_hash = $1`,
      [tokenHash]
    );
    if (!stored || stored.revoked_at) return jsonError(res, 401, "Invalid refresh token.");
    if (new Date(stored.expires_at).getTime() < Date.now()) {
      return jsonError(res, 401, "Refresh token expired.");
    }

    const nextRefreshToken = createOpaqueToken();
    await pool.query(
      `UPDATE customer_refresh_tokens
       SET    token_hash = $2, expires_at = $3, last_used_at = NOW()
       WHERE  id = $1`,
      [stored.id, hashOpaqueToken(nextRefreshToken), refreshExpiryDate()]
    );

    // issueCustomerAccessToken needs { id, phone, email }
    const customer = { id: stored.user_id, phone: stored.phone, email: stored.email };
    return res.json({
      ok: true,
      accessToken: issueCustomerAccessToken(customer),
      refreshToken: nextRefreshToken,
    });
  } catch (error) {
    return jsonError(res, 500, error.message || "Refresh failed.");
  }
});

// ─── Routes: staff device ─────────────────────────────────────────────────────

router.post("/auth/staff-device", async (req, res) => {
  try {
    const deviceId   = String(req.body?.deviceId   || "").trim();
    const deviceName = String(req.body?.deviceName || "").trim();
    const pin        = String(req.body?.pin        || "");
    if (!deviceId || !deviceName || !pin) {
      return jsonError(res, 400, "deviceId, deviceName, and pin are required.");
    }
    if (!process.env.SCCRM_STAFF_PIN) return jsonError(res, 500, "SCCRM_STAFF_PIN is not configured.");
    if (pin !== process.env.SCCRM_STAFF_PIN) return jsonError(res, 401, "Invalid PIN.");

    const allowedNames = String(process.env.SCCRM_ALLOWED_STAFF_DEVICE_NAMES || "")
      .split(",").map((v) => v.trim()).filter(Boolean);
    if (allowedNames.length > 0 && !allowedNames.includes(deviceName)) {
      return jsonError(res, 403, "Device name is not allowed.");
    }

    const staffToken = createOpaqueToken();
    const tokenHash  = hashOpaqueToken(staffToken);
    const existing   = await queryOne(`SELECT id FROM staff_devices WHERE device_id = $1`, [deviceId]);
    if (existing) {
      await pool.query(
        `UPDATE staff_devices
         SET    device_name = $2, token_hash = $3, revoked_at = NULL, last_seen_at = NOW()
         WHERE  id = $1`,
        [existing.id, deviceName, tokenHash]
      );
    } else {
      await pool.query(
        `INSERT INTO staff_devices (id, device_id, device_name, token_hash, last_seen_at, revoked_at, created_at)
         VALUES ($1, $2, $3, $4, NOW(), NULL, NOW())`,
        [createId(), deviceId, deviceName, tokenHash]
      );
    }
    return res.json({ ok: true, staffToken });
  } catch (error) {
    return jsonError(res, 500, error.message || "Failed to register staff device.");
  }
});

// ─── Routes: customers ────────────────────────────────────────────────────────

router.get("/customers/search", requireStaff, async (req, res) => {
  try {
    const rawPhone    = req.query.phone;
    const memberCode  = req.query.member_code;

    let customer = null;

    if (memberCode) {
      customer = await getCustomerView("m.member_code = $1", [memberCode.toUpperCase()]);
    } else if (rawPhone) {
      const phone = normalizePhone(rawPhone);
      if (!phone) return jsonError(res, 400, "phone or member_code is required.");
      customer = await getCustomerView("u.phone_number = $1", [phone]);
    } else {
      return jsonError(res, 400, "phone or member_code is required.");
    }

    if (!customer) return res.json({ ok: true, customer: null });
    return res.json({
      ok: true,
      customer: { ...customer, balance: await getCustomerBalance(customer.id) },
    });
  } catch (error) {
    return jsonError(res, 500, error.message || "Search failed.");
  }
});

router.get("/customers/:id", requireStaffOrSameCustomer, async (req, res) => {
  try {
    const customer = await getCustomerViewById(req.params.id);
    if (!customer) return jsonError(res, 404, "Customer not found.");

    const transactions = await pool.query(
      `SELECT id, total_amount, point_earned, source, pos_ref_id, created_at
       FROM   transactions
       WHERE  user_id = $1
       ORDER  BY created_at DESC
       LIMIT  10`,
      [req.params.id]
    );
    return res.json({
      ok: true,
      customer: {
        ...customer,
        balance: await getCustomerBalance(customer.id),
        recentTransactions: transactions.rows,
      },
    });
  } catch (error) {
    return jsonError(res, 500, error.message || "Failed to load customer.");
  }
});

// Staff creates a customer manually (no password — customer sets one later via app)
router.post("/customers", requireStaff, async (req, res) => {
  try {
    const phone    = normalizePhone(req.body?.phone);
    const fullName = String(req.body?.fullName || "").trim();
    const email    = req.body?.email ? String(req.body.email).trim().toLowerCase() : null;
    if (!phone || !fullName) return jsonError(res, 400, "phone and fullName are required.");

    const existing = await findCustomerByIdentity({ phone, email });
    if (existing) return jsonError(res, 409, "Customer already exists.");

    const customer = await createUserWithMemberProfile({
      phone,
      fullName,
      email,
      password: null, // staff-created accounts have no password initially
    });
    return res.status(201).json({ ok: true, customer });
  } catch (error) {
    return jsonError(res, 500, error.message || "Failed to create customer.");
  }
});

router.patch("/customers/:id", requireStaffOrSameCustomer, async (req, res) => {
  try {
    const fullName = req.body?.fullName === undefined ? null : String(req.body.fullName || "").trim();
    const email    = req.body?.email    === undefined ? null : String(req.body.email    || "").trim().toLowerCase();
    const isActive = req.body?.isActive;

    const existing = await getCustomerViewById(req.params.id);
    if (!existing) return jsonError(res, 404, "Customer not found.");

    // Update identity fields on users
    await pool.query(
      `UPDATE users
       SET    full_name  = COALESCE($2, full_name),
              email      = COALESCE($3, email),
              updated_at = NOW()
       WHERE  id = $1`,
      [req.params.id, fullName || null, email || null]
    );

    // Update CRM fields on member_profiles
    if (typeof isActive === "boolean") {
      await pool.query(
        `UPDATE member_profiles
         SET    is_active  = $2,
                updated_at = NOW()
         WHERE  user_id = $1`,
        [req.params.id, isActive]
      );
    }

    return res.json({ ok: true, customer: await getCustomerViewById(req.params.id) });
  } catch (error) {
    return jsonError(res, 500, error.message || "Failed to update customer.");
  }
});

// ─── Routes: points ───────────────────────────────────────────────────────────

router.post("/points/earn", requireStaff, async (req, res) => {
  try {
    const userId      = String(req.body?.customer_id || "").trim();
    const amountThb   = Number(req.body?.amount_thb);
    const referenceId = req.body?.reference_id ? String(req.body.reference_id).trim() : null;
    if (!userId || !Number.isFinite(amountThb) || amountThb < 0) {
      return jsonError(res, 400, "customer_id and non-negative amount_thb are required.");
    }

    const customer = await getCustomerViewById(userId);
    if (!customer) return jsonError(res, 404, "Customer not found.");

    const promotions    = await getActivePromotions();
    const points        = resolvePointsWithPromotions(amountThb, promotions);
    const transactionId = createId();

    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO transactions (id, user_id, total_amount, point_earned, source, pos_ref_id, created_at)
         VALUES ($1, $2, $3, $4, 'manual', $5, NOW())`,
        [transactionId, userId, amountThb, points, referenceId]
      );
      await client.query(
        `INSERT INTO point_ledger (id, user_id, amount, type, reference_id, note, created_by, created_at)
         VALUES ($1, $2, $3, 'purchase', $4, 'Manual earn', $5, NOW())`,
        [createId(), userId, points, transactionId, req.staffDevice.device_id]
      );
    });

    const tier = await recalculateTier(userId);
    return res.status(201).json({
      ok: true,
      transactionId,
      pointsAwarded: points,
      balance: await getCustomerBalance(userId),
      tier,
    });
  } catch (error) {
    return jsonError(res, 500, error.message || "Failed to earn points.");
  }
});

router.post("/points/redeem", requireStaff, async (req, res) => {
  try {
    const userId     = String(req.body?.customer_id || "").trim();
    const points     = Number(req.body?.points);
    const rewardName = String(req.body?.reward_name || "").trim();
    if (!userId || !Number.isInteger(points) || points <= 0 || !rewardName) {
      return jsonError(res, 400, "customer_id, positive points, and reward_name are required.");
    }

    const customer = await queryOne(`SELECT id FROM users WHERE id = $1`, [userId]);
    if (!customer) return jsonError(res, 404, "Customer not found.");

    const balance = await getCustomerBalance(userId);
    if (balance < points) return jsonError(res, 400, "Insufficient points.");

    const redemptionId = createId();
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO redemptions (id, user_id, points_used, reward_name, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [redemptionId, userId, points, rewardName]
      );
      await client.query(
        `INSERT INTO point_ledger (id, user_id, amount, type, reference_id, note, created_by, created_at)
         VALUES ($1, $2, $3, 'redeem', $4, $5, $6, NOW())`,
        [createId(), userId, -points, redemptionId, rewardName, req.staffDevice.device_id]
      );
    });

    const tier = await recalculateTier(userId);
    return res.status(201).json({
      ok: true,
      redemptionId,
      balance: await getCustomerBalance(userId),
      tier,
    });
  } catch (error) {
    return jsonError(res, 500, error.message || "Failed to redeem points.");
  }
});

router.get("/points/:customer_id/balance", requireStaffOrSameCustomer, async (req, res) => {
  try {
    return res.json({
      ok: true,
      customerId:     req.params.customer_id,
      balance:        await getCustomerBalance(req.params.customer_id),
      lifetimeEarned: await getCustomerLifetimeEarned(req.params.customer_id),
    });
  } catch (error) {
    return jsonError(res, 500, error.message || "Failed to load balance.");
  }
});

router.get("/points/:customer_id/history", requireStaffOrSameCustomer, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, amount, type, reference_id, note, created_by, created_at
       FROM   point_ledger
       WHERE  user_id = $1
       ORDER  BY created_at DESC`,
      [req.params.customer_id]
    );
    return res.json({ ok: true, items: result.rows });
  } catch (error) {
    return jsonError(res, 500, error.message || "Failed to load history.");
  }
});

// ─── Routes: promotions ───────────────────────────────────────────────────────

router.get("/promotions/active", async (_req, res) => {
  try {
    return res.json({ ok: true, promotions: await getActivePromotions() });
  } catch (error) {
    return jsonError(res, 500, error.message || "Failed to load promotions.");
  }
});

router.post("/promotions", requireStaff, async (req, res) => {
  try {
    const name          = String(req.body?.name  || "").trim();
    const type          = String(req.body?.type  || "").trim();
    const value         = Number(req.body?.value);
    const conditionJson = readJsonCondition(req.body?.condition_json);
    if (!name || !type || !Number.isFinite(value)) {
      return jsonError(res, 400, "name, type, and numeric value are required.");
    }
    const id = createId();
    await pool.query(
      `INSERT INTO promotions
         (id, name, type, value, condition_json, starts_at, ends_at, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
      [
        id, name, type, value,
        JSON.stringify(conditionJson),
        req.body?.starts_at || null,
        req.body?.ends_at   || null,
        req.body?.is_active === undefined ? true : !!req.body.is_active,
      ]
    );
    return res.status(201).json({ ok: true, promotionId: id });
  } catch (error) {
    return jsonError(res, 500, error.message || "Failed to create promotion.");
  }
});

// ─── Routes: POS import ───────────────────────────────────────────────────────

router.post("/import/pos", requireStaff, upload.single("file"), async (req, res) => {
  try {
    let rows = [];
    if (Array.isArray(req.body?.transactions)) {
      rows = req.body.transactions;
    } else if (Array.isArray(req.body)) {
      rows = req.body;
    } else if (req.file) {
      rows = parseImportCsv(req.file.buffer.toString("utf8"));
    } else {
      return jsonError(res, 400, "Provide a JSON array or CSV file.");
    }

    const summary = { imported: 0, skipped_duplicates: 0, unmatched_customers: 0, errors: [] };

    for (let index = 0; index < rows.length; index += 1) {
      const { normalized, errors } = normalizeImportRow(rows[index]);
      if (errors.length > 0) { summary.errors.push({ index, errors }); continue; }

      const existing = await queryOne(`SELECT id FROM transactions WHERE pos_ref_id = $1`, [normalized.pos_ref_id]);
      if (existing) { summary.skipped_duplicates += 1; continue; }

      const user = normalized.phone
        ? await queryOne(`SELECT id FROM users WHERE phone_number = $1`, [normalized.phone])
        : null;

      const promotions   = user ? await getActivePromotions() : [];
      const points       = user ? resolvePointsWithPromotions(normalized.total_amount, promotions) : 0;
      const transactionId = createId();

      await withTransaction(async (client) => {
        await client.query(
          `INSERT INTO transactions (id, user_id, total_amount, point_earned, source, pos_ref_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [transactionId, user?.id || null, normalized.total_amount, points, normalized.source, normalized.pos_ref_id, normalized.created_at]
        );
        if (user) {
          await client.query(
            `INSERT INTO point_ledger (id, user_id, amount, type, reference_id, note, created_by, created_at)
             VALUES ($1, $2, $3, 'purchase', $4, 'POS import', 'system', $5)`,
            [createId(), user.id, points, transactionId, normalized.created_at]
          );
        }
      });

      if (user) {
        await recalculateTier(user.id);
      } else {
        summary.unmatched_customers += 1;
      }
      summary.imported += 1;
    }

    return res.json({ ok: true, summary });
  } catch (error) {
    return jsonError(res, 500, error.message || "Import failed.");
  }
});

module.exports = router;
