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

function jsonError(res, status, message) {
  return res.status(status).json({ error: message });
}

function readJsonCondition(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
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
       FROM staff_devices
       WHERE token_hash=$1 AND revoked_at IS NULL`,
      [tokenHash]
    );
    if (!device) return jsonError(res, 401, "Invalid or revoked staff device token.");
    await pool.query(
      `UPDATE staff_devices SET last_seen_at=NOW() WHERE id=$1`,
      [device.id]
    );
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
    if (payload.customerId !== req.params.id && payload.customerId !== req.params.customer_id) {
      return jsonError(res, 403, "Forbidden.");
    }
    req.customerAuth = payload;
    return next();
  } catch {
    return requireStaff(req, res, next);
  }
}

async function getCustomerBalance(customerId) {
  const row = await queryOne(
    `SELECT COALESCE(SUM(amount), 0) AS balance
     FROM point_ledger
     WHERE customer_id=$1`,
    [customerId]
  );
  return Number(row?.balance || 0);
}

async function getCustomerLifetimeEarned(customerId) {
  const row = await queryOne(
    `SELECT COALESCE(SUM(amount), 0) AS earned
     FROM point_ledger
     WHERE customer_id=$1 AND amount > 0`,
    [customerId]
  );
  return Number(row?.earned || 0);
}

async function recalculateTier(customerId) {
  const lifetimeEarned = await getCustomerLifetimeEarned(customerId);
  const tier = calculateTier(lifetimeEarned);
  await pool.query(`UPDATE customers SET tier=$2, updated_at=NOW() WHERE id=$1`, [
    customerId,
    tier,
  ]);
  return tier;
}

async function getActivePromotions() {
  const result = await pool.query(
    `SELECT id, name, type, value, condition_json, starts_at, ends_at
     FROM promotions
     WHERE is_active=TRUE
       AND (starts_at IS NULL OR starts_at <= NOW())
       AND (ends_at IS NULL OR ends_at >= NOW())
     ORDER BY starts_at ASC NULLS FIRST, created_at ASC`
  );
  return result.rows.map((row) => ({
    ...row,
    condition_json: readJsonCondition(row.condition_json),
  }));
}

async function findCustomerByIdentity({ lineUid, googleUid, email, phone }) {
  if (lineUid) {
    const found = await queryOne(`SELECT * FROM customers WHERE line_uid=$1`, [lineUid]);
    if (found) return found;
  }
  if (googleUid) {
    const found = await queryOne(`SELECT * FROM customers WHERE google_uid=$1`, [googleUid]);
    if (found) return found;
  }
  if (email) {
    const found = await queryOne(`SELECT * FROM customers WHERE lower(email)=lower($1)`, [email]);
    if (found) return found;
  }
  if (phone) {
    const found = await queryOne(`SELECT * FROM customers WHERE phone=$1`, [phone]);
    if (found) return found;
  }
  return null;
}

async function issueCustomerSession(customer, deviceLabel) {
  const accessToken = issueCustomerAccessToken(customer);
  const refreshToken = createOpaqueToken();
  await pool.query(
    `INSERT INTO customer_refresh_tokens (
      id, customer_id, token_hash, device_label, expires_at, created_at, last_used_at
    ) VALUES ($1,$2,$3,$4,$5,NOW(),NOW())`,
    [createId(), customer.id, hashOpaqueToken(refreshToken), deviceLabel || null, refreshExpiryDate()]
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

async function createCustomerWithCredentials({ phone, fullName, email, password, lineUid, googleUid }) {
  const customerId = createId();
  const passwordHash = await hashPassword(password);
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO customers (
        id, phone, full_name, email, line_uid, google_uid, tier, is_active, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,'bronze',TRUE,NOW(),NOW())`,
      [customerId, phone, fullName || null, email || null, lineUid || null, googleUid || null]
    );
    await client.query(
      `INSERT INTO customer_credentials (
        customer_id, password_hash, email_verified_at, created_at, updated_at
      ) VALUES ($1,$2,$3,NOW(),NOW())`,
      [customerId, passwordHash, email ? new Date() : null]
    );
  });
  return findCustomerByIdentity({ phone });
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
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
    redirect_uri: process.env.SCCRM_LINE_REDIRECT_URI || "",
    client_id: process.env.SCCRM_LINE_CHANNEL_ID || "",
    client_secret: process.env.SCCRM_LINE_CHANNEL_SECRET || "",
  });
  const tokenPayload = await fetchJson("https://api.line.me/oauth2/v2.1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const profile = await fetchJson("https://api.line.me/v2/profile", {
    headers: { Authorization: `Bearer ${tokenPayload.access_token}` },
  });
  return {
    lineUid: profile.userId,
    fullName: profile.displayName || null,
  };
}

async function exchangeGoogleCode(code) {
  const params = new URLSearchParams({
    code,
    client_id: process.env.SCCRM_GOOGLE_CLIENT_ID || "",
    client_secret: process.env.SCCRM_GOOGLE_CLIENT_SECRET || "",
    redirect_uri: process.env.SCCRM_GOOGLE_REDIRECT_URI || "",
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
  return {
    googleUid: profile.sub,
    fullName: profile.name || null,
    email: profile.email || null,
  };
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

router.post("/auth/register", async (req, res) => {
  const { step } = req.body || {};
  try {
    if (step === "send-otp") {
      const email = String(req.body.email || "").trim().toLowerCase();
      if (!isEmail(email)) return jsonError(res, 400, "Valid email is required.");

      const existing = await queryOne(`SELECT id FROM customers WHERE lower(email)=lower($1)`, [email]);
      if (existing) return jsonError(res, 409, "Email already registered.");

      const otp = generateOtp();
      await pool.query(
        `INSERT INTO customer_email_verifications (
          id, customer_email, otp_hash, expires_at, used_at, attempt_count, created_at
        ) VALUES ($1,$2,$3,$4,NULL,0,NOW())`,
        [createId(), email, hashOtp(email, otp), emailOtpExpiryDate()]
      );
      await sendVerificationEmail(email, otp);
      return res.json({ ok: true });
    }

    if (step === "complete-email-signup") {
      const email = String(req.body.email || "").trim().toLowerCase();
      const otp = String(req.body.otp || "").trim();
      const phone = normalizePhone(req.body.phone);
      const fullName = String(req.body.fullName || "").trim();
      const password = String(req.body.password || "");

      if (!isEmail(email) || !otp || !phone || !password) {
        return jsonError(res, 400, "email, otp, phone, and password are required.");
      }
      if (password.length < 8) return jsonError(res, 400, "Password must be at least 8 characters.");

      const verification = await queryOne(
        `SELECT id, otp_hash, expires_at, used_at, attempt_count
         FROM customer_email_verifications
         WHERE customer_email=$1
         ORDER BY created_at DESC
         LIMIT 1`,
        [email]
      );
      if (!verification) return jsonError(res, 400, "No verification request found.");
      if (verification.used_at) return jsonError(res, 400, "Verification code already used.");
      if (verification.attempt_count >= EMAIL_OTP_ATTEMPT_LIMIT) {
        return jsonError(res, 429, "Too many attempts. Request a new code.");
      }
      if (new Date(verification.expires_at).getTime() < Date.now()) {
        return jsonError(res, 400, "Verification code expired.");
      }
      if (verification.otp_hash !== hashOtp(email, otp)) {
        await pool.query(
          `UPDATE customer_email_verifications SET attempt_count=attempt_count+1 WHERE id=$1`,
          [verification.id]
        );
        return jsonError(res, 400, "Invalid verification code.");
      }

      const existingPhone = await queryOne(`SELECT id FROM customers WHERE phone=$1`, [phone]);
      if (existingPhone) return jsonError(res, 409, "Phone already registered.");

      const customer = await createCustomerWithCredentials({
        phone,
        fullName,
        email,
        password,
      });
      await pool.query(`UPDATE customer_email_verifications SET used_at=NOW() WHERE id=$1`, [verification.id]);

      return res.json({
        ok: true,
        customer,
        ...(await issueCustomerSession(customer, req.body.deviceLabel || "email-signup")),
      });
    }

    if (step === "complete-social-signup") {
      const phone = normalizePhone(req.body.phone);
      const password = String(req.body.password || "");
      const fullName = String(req.body.fullName || "").trim();
      const email = req.body.email ? String(req.body.email).trim().toLowerCase() : null;
      if (!phone || !password || !req.body.onboardingToken) {
        return jsonError(res, 400, "onboardingToken, phone, and password are required.");
      }
      const onboarding = verifyAccessToken(req.body.onboardingToken, "sccrm-onboarding");

      const existingPhone = await queryOne(`SELECT id FROM customers WHERE phone=$1`, [phone]);
      if (existingPhone) return jsonError(res, 409, "Phone already registered.");

      const customer = await createCustomerWithCredentials({
        phone,
        fullName: fullName || onboarding.fullName || null,
        email: email || onboarding.email || null,
        password,
        lineUid: onboarding.lineUid || null,
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
      ? "Customer already exists."
      : error.message || "Registration failed.";
    return jsonError(res, 500, message);
  }
});

router.post("/auth/login", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!isEmail(email) || !password) return jsonError(res, 400, "email and password are required.");

    const customer = await queryOne(
      `SELECT c.*, cc.password_hash
       FROM customers c
       JOIN customer_credentials cc ON cc.customer_id = c.id
       WHERE lower(c.email)=lower($1)`,
      [email]
    );
    if (!customer) return jsonError(res, 400, "Invalid email or password.");

    const ok = await comparePassword(password, customer.password_hash);
    if (!ok) return jsonError(res, 400, "Invalid email or password.");

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
      `SELECT rt.id, rt.customer_id, rt.expires_at, rt.revoked_at, c.*
       FROM customer_refresh_tokens rt
       JOIN customers c ON c.id = rt.customer_id
       WHERE rt.token_hash=$1`,
      [tokenHash]
    );
    if (!stored || stored.revoked_at) return jsonError(res, 401, "Invalid refresh token.");
    if (new Date(stored.expires_at).getTime() < Date.now()) {
      return jsonError(res, 401, "Refresh token expired.");
    }

    const nextRefreshToken = createOpaqueToken();
    await pool.query(
      `UPDATE customer_refresh_tokens
       SET token_hash=$2, expires_at=$3, last_used_at=NOW()
       WHERE id=$1`,
      [stored.id, hashOpaqueToken(nextRefreshToken), refreshExpiryDate()]
    );

    return res.json({
      ok: true,
      accessToken: issueCustomerAccessToken(stored),
      refreshToken: nextRefreshToken,
    });
  } catch (error) {
    return jsonError(res, 500, error.message || "Refresh failed.");
  }
});

router.post("/auth/staff-device", async (req, res) => {
  try {
    const deviceId = String(req.body?.deviceId || "").trim();
    const deviceName = String(req.body?.deviceName || "").trim();
    const pin = String(req.body?.pin || "");
    if (!deviceId || !deviceName || !pin) {
      return jsonError(res, 400, "deviceId, deviceName, and pin are required.");
    }
    if (!process.env.SCCRM_STAFF_PIN) return jsonError(res, 500, "SCCRM_STAFF_PIN is not configured.");
    if (pin !== process.env.SCCRM_STAFF_PIN) return jsonError(res, 401, "Invalid PIN.");

    const allowedNames = String(process.env.SCCRM_ALLOWED_STAFF_DEVICE_NAMES || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (allowedNames.length > 0 && !allowedNames.includes(deviceName)) {
      return jsonError(res, 403, "Device name is not allowed.");
    }

    const staffToken = createOpaqueToken();
    const tokenHash = hashOpaqueToken(staffToken);
    const existing = await queryOne(`SELECT id FROM staff_devices WHERE device_id=$1`, [deviceId]);
    if (existing) {
      await pool.query(
        `UPDATE staff_devices
         SET device_name=$2, token_hash=$3, revoked_at=NULL, last_seen_at=NOW()
         WHERE id=$1`,
        [existing.id, deviceName, tokenHash]
      );
    } else {
      await pool.query(
        `INSERT INTO staff_devices (
          id, device_id, device_name, token_hash, last_seen_at, revoked_at, created_at
        ) VALUES ($1,$2,$3,$4,NOW(),NULL,NOW())`,
        [createId(), deviceId, deviceName, tokenHash]
      );
    }
    return res.json({ ok: true, staffToken });
  } catch (error) {
    return jsonError(res, 500, error.message || "Failed to register staff device.");
  }
});

router.get("/customers/search", requireStaff, async (req, res) => {
  try {
    const phone = normalizePhone(req.query.phone);
    if (!phone) return jsonError(res, 400, "phone is required.");
    const customer = await queryOne(
      `SELECT id, phone, full_name, email, tier, is_active, created_at, updated_at
       FROM customers
       WHERE phone=$1`,
      [phone]
    );
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
    const customer = await queryOne(
      `SELECT id, phone, full_name, email, tier, is_active, created_at, updated_at
       FROM customers
       WHERE id=$1`,
      [req.params.id]
    );
    if (!customer) return jsonError(res, 404, "Customer not found.");
    const transactions = await pool.query(
      `SELECT id, total_amount, point_earned, source, pos_ref_id, created_at
       FROM transactions
       WHERE customer_id=$1
       ORDER BY created_at DESC
       LIMIT 10`,
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

router.post("/customers", requireStaff, async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    const fullName = String(req.body?.fullName || "").trim();
    const email = req.body?.email ? String(req.body.email).trim().toLowerCase() : null;
    if (!phone || !fullName) return jsonError(res, 400, "phone and fullName are required.");
    const existing = await findCustomerByIdentity({ phone, email });
    if (existing) return jsonError(res, 409, "Customer already exists.");

    const id = createId();
    await pool.query(
      `INSERT INTO customers (
        id, phone, full_name, email, tier, is_active, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,'bronze',TRUE,NOW(),NOW())`,
      [id, phone, fullName, email]
    );
    const customer = await queryOne(`SELECT * FROM customers WHERE id=$1`, [id]);
    return res.status(201).json({ ok: true, customer });
  } catch (error) {
    return jsonError(res, 500, error.message || "Failed to create customer.");
  }
});

router.patch("/customers/:id", requireStaffOrSameCustomer, async (req, res) => {
  try {
    const fullName = req.body?.fullName === undefined ? null : String(req.body.fullName || "").trim();
    const email = req.body?.email === undefined ? null : String(req.body.email || "").trim().toLowerCase();
    const isActive = req.body?.isActive;

    const customer = await queryOne(`SELECT * FROM customers WHERE id=$1`, [req.params.id]);
    if (!customer) return jsonError(res, 404, "Customer not found.");

    await pool.query(
      `UPDATE customers
       SET full_name=COALESCE($2, full_name),
           email=COALESCE($3, email),
           is_active=COALESCE($4, is_active),
           updated_at=NOW()
       WHERE id=$1`,
      [
        req.params.id,
        fullName || null,
        email || null,
        typeof isActive === "boolean" ? isActive : null,
      ]
    );

    return res.json({
      ok: true,
      customer: await queryOne(
        `SELECT id, phone, full_name, email, tier, is_active, created_at, updated_at
         FROM customers WHERE id=$1`,
        [req.params.id]
      ),
    });
  } catch (error) {
    return jsonError(res, 500, error.message || "Failed to update customer.");
  }
});

router.post("/points/earn", requireStaff, async (req, res) => {
  try {
    const customerId = String(req.body?.customer_id || "").trim();
    const amountThb = Number(req.body?.amount_thb);
    const referenceId = req.body?.reference_id ? String(req.body.reference_id).trim() : null;
    if (!customerId || !Number.isFinite(amountThb) || amountThb < 0) {
      return jsonError(res, 400, "customer_id and non-negative amount_thb are required.");
    }
    const customer = await queryOne(`SELECT * FROM customers WHERE id=$1`, [customerId]);
    if (!customer) return jsonError(res, 404, "Customer not found.");

    const promotions = await getActivePromotions();
    const points = resolvePointsWithPromotions(amountThb, promotions);
    const transactionId = createId();
    const ledgerId = createId();

    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO transactions (
          id, customer_id, total_amount, point_earned, source, pos_ref_id, created_at
        ) VALUES ($1,$2,$3,$4,'manual',$5,NOW())`,
        [transactionId, customerId, amountThb, points, referenceId]
      );
      await client.query(
        `INSERT INTO point_ledger (
          id, customer_id, amount, type, reference_id, note, created_by, created_at
        ) VALUES ($1,$2,$3,'purchase',$4,$5,$6,NOW())`,
        [ledgerId, customerId, points, transactionId, "Manual earn", req.staffDevice.device_id]
      );
    });

    const tier = await recalculateTier(customerId);
    return res.status(201).json({
      ok: true,
      transactionId,
      pointsAwarded: points,
      balance: await getCustomerBalance(customerId),
      tier,
    });
  } catch (error) {
    return jsonError(res, 500, error.message || "Failed to earn points.");
  }
});

router.post("/points/redeem", requireStaff, async (req, res) => {
  try {
    const customerId = String(req.body?.customer_id || "").trim();
    const points = Number(req.body?.points);
    const rewardName = String(req.body?.reward_name || "").trim();
    if (!customerId || !Number.isInteger(points) || points <= 0 || !rewardName) {
      return jsonError(res, 400, "customer_id, positive points, and reward_name are required.");
    }
    const customer = await queryOne(`SELECT id FROM customers WHERE id=$1`, [customerId]);
    if (!customer) return jsonError(res, 404, "Customer not found.");

    const balance = await getCustomerBalance(customerId);
    if (balance < points) return jsonError(res, 400, "Insufficient points.");

    const redemptionId = createId();
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO redemptions (id, customer_id, points_used, reward_name, created_at)
         VALUES ($1,$2,$3,$4,NOW())`,
        [redemptionId, customerId, points, rewardName]
      );
      await client.query(
        `INSERT INTO point_ledger (
          id, customer_id, amount, type, reference_id, note, created_by, created_at
        ) VALUES ($1,$2,$3,'redeem',$4,$5,$6,NOW())`,
        [createId(), customerId, -points, redemptionId, rewardName, req.staffDevice.device_id]
      );
    });

    const tier = await recalculateTier(customerId);
    return res.status(201).json({
      ok: true,
      redemptionId,
      balance: await getCustomerBalance(customerId),
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
      customerId: req.params.customer_id,
      balance: await getCustomerBalance(req.params.customer_id),
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
       FROM point_ledger
       WHERE customer_id=$1
       ORDER BY created_at DESC`,
      [req.params.customer_id]
    );
    return res.json({ ok: true, items: result.rows });
  } catch (error) {
    return jsonError(res, 500, error.message || "Failed to load history.");
  }
});

router.get("/promotions/active", async (_req, res) => {
  try {
    return res.json({ ok: true, promotions: await getActivePromotions() });
  } catch (error) {
    return jsonError(res, 500, error.message || "Failed to load promotions.");
  }
});

router.post("/promotions", requireStaff, async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const type = String(req.body?.type || "").trim();
    const value = Number(req.body?.value);
    const conditionJson = readJsonCondition(req.body?.condition_json);
    if (!name || !type || !Number.isFinite(value)) {
      return jsonError(res, 400, "name, type, and numeric value are required.");
    }
    const id = createId();
    await pool.query(
      `INSERT INTO promotions (
        id, name, type, value, condition_json, starts_at, ends_at, is_active, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())`,
      [
        id,
        name,
        type,
        value,
        JSON.stringify(conditionJson),
        req.body?.starts_at || null,
        req.body?.ends_at || null,
        req.body?.is_active === undefined ? true : !!req.body.is_active,
      ]
    );
    return res.status(201).json({ ok: true, promotionId: id });
  } catch (error) {
    return jsonError(res, 500, error.message || "Failed to create promotion.");
  }
});

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

    const summary = {
      imported: 0,
      skipped_duplicates: 0,
      unmatched_customers: 0,
      errors: [],
    };

    for (let index = 0; index < rows.length; index += 1) {
      const { normalized, errors } = normalizeImportRow(rows[index]);
      if (errors.length > 0) {
        summary.errors.push({ index, errors });
        continue;
      }

      const existing = await queryOne(`SELECT id FROM transactions WHERE pos_ref_id=$1`, [
        normalized.pos_ref_id,
      ]);
      if (existing) {
        summary.skipped_duplicates += 1;
        continue;
      }

      const customer = normalized.phone
        ? await queryOne(`SELECT id FROM customers WHERE phone=$1`, [normalized.phone])
        : null;
      const promotions = customer ? await getActivePromotions() : [];
      const points = customer ? resolvePointsWithPromotions(normalized.total_amount, promotions) : 0;
      const transactionId = createId();

      await withTransaction(async (client) => {
        await client.query(
          `INSERT INTO transactions (
            id, customer_id, total_amount, point_earned, source, pos_ref_id, created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            transactionId,
            customer?.id || null,
            normalized.total_amount,
            points,
            normalized.source,
            normalized.pos_ref_id,
            normalized.created_at,
          ]
        );
        if (customer) {
          await client.query(
            `INSERT INTO point_ledger (
              id, customer_id, amount, type, reference_id, note, created_by, created_at
            ) VALUES ($1,$2,$3,'purchase',$4,$5,'system',$6)`,
            [
              createId(),
              customer.id,
              points,
              transactionId,
              "POS import",
              normalized.created_at,
            ]
          );
        }
      });

      if (customer) {
        await recalculateTier(customer.id);
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
