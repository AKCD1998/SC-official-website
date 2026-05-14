const bcrypt = require("bcrypt");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { parse } = require("csv-parse/sync");

const CUSTOMER_ACCESS_TTL_SECONDS = 15 * 60;
const CUSTOMER_REFRESH_TTL_DAYS = 30;
const ONBOARDING_TTL_SECONDS = 15 * 60;
const EMAIL_OTP_TTL_MINUTES = 10;
const EMAIL_OTP_ATTEMPT_LIMIT = 5;

function nowIso() {
  return new Date().toISOString();
}

function createId() {
  return crypto.randomUUID();
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function normalizePhone(phone) {
  return String(phone || "").replace(/[^\d+]/g, "").trim();
}

function isEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function hashValue(prefix, value) {
  const secret = requireEnv("SCCRM_REFRESH_TOKEN_SECRET");
  return crypto.createHmac("sha256", secret).update(`${prefix}:${value}`).digest("hex");
}

function hashOtp(email, otp) {
  return hashValue("email-otp", `${String(email).toLowerCase()}:${String(otp).trim()}`);
}

function hashOpaqueToken(token) {
  return hashValue("opaque-token", token);
}

function issueCustomerAccessToken(customer) {
  const secret = requireEnv("SCCRM_ACCESS_JWT_SECRET");
  return jwt.sign(
    {
      scope: "customer",
      customerId: customer.id,
      phone: customer.phone,
      email: customer.email || null,
    },
    secret,
    { expiresIn: CUSTOMER_ACCESS_TTL_SECONDS }
  );
}

function issueOnboardingToken(payload) {
  const secret = requireEnv("SCCRM_ACCESS_JWT_SECRET");
  return jwt.sign({ scope: "sccrm-onboarding", ...payload }, secret, {
    expiresIn: ONBOARDING_TTL_SECONDS,
  });
}

function verifyAccessToken(token, expectedScope) {
  const secret = requireEnv("SCCRM_ACCESS_JWT_SECRET");
  const payload = jwt.verify(token, secret);
  if (expectedScope && payload.scope !== expectedScope) {
    throw new Error("Unexpected token scope.");
  }
  return payload;
}

function createOpaqueToken() {
  return crypto.randomBytes(32).toString("hex");
}

function refreshExpiryDate() {
  return new Date(Date.now() + CUSTOMER_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
}

function emailOtpExpiryDate() {
  return new Date(Date.now() + EMAIL_OTP_TTL_MINUTES * 60 * 1000);
}

function calculateBasePoints(totalAmount) {
  const numeric = Number(totalAmount);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.floor(numeric / 10);
}

function applyPromotionRule(basePoints, promotion, totalAmount) {
  const value = Number(promotion.value || 0);
  if (promotion.type === "multiplier") {
    return Math.max(0, Math.floor(basePoints * value));
  }
  if (promotion.type === "fixed_bonus") {
    return Math.max(0, basePoints + Math.floor(value));
  }
  if (promotion.type === "threshold") {
    const condition = promotion.condition_json || {};
    const minimumSpend = Number(condition.minimum_spend || 0);
    const bonusPoints = Number(condition.bonus_points || value || 0);
    if (Number(totalAmount) >= minimumSpend) {
      return Math.max(0, basePoints + Math.floor(bonusPoints));
    }
  }
  return basePoints;
}

function resolvePointsWithPromotions(totalAmount, promotions) {
  let points = calculateBasePoints(totalAmount);
  for (const promotion of promotions) {
    points = applyPromotionRule(points, promotion, totalAmount);
  }
  return points;
}

function calculateTier(lifetimePoints) {
  if (lifetimePoints >= 5000) return "gold";
  if (lifetimePoints >= 1000) return "silver";
  return "bronze";
}

function normalizeImportRow(row) {
  const normalized = {
    pos_ref_id: String(row.pos_ref_id || row.posRefId || row.reference_id || "").trim(),
    phone: normalizePhone(row.phone || row.customer_phone || row.customerPhone || ""),
    total_amount: Number(row.total_amount ?? row.totalAmount ?? row.amount ?? row.total ?? NaN),
    created_at: row.created_at || row.createdAt || row.date || row.occurred_at || null,
    source: String(row.source || "pos_import").trim() || "pos_import",
  };

  const errors = [];
  if (!normalized.pos_ref_id) errors.push("pos_ref_id is required");
  if (!Number.isFinite(normalized.total_amount) || normalized.total_amount < 0) {
    errors.push("total_amount must be a non-negative number");
  }
  if (!normalized.created_at) errors.push("created_at is required");
  if (!normalized.source) normalized.source = "pos_import";

  return { normalized, errors };
}

function parseImportCsv(csvText) {
  return parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
}

function parseBearerToken(headerValue) {
  const auth = String(headerValue || "");
  return auth.startsWith("Bearer ") ? auth.slice(7) : null;
}

async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// Derives the public member code from a users.id UUID.
// Format: 'SCM-' + first 8 hex characters of the UUID (hyphens stripped, uppercase).
// Example: 'a1b2c3d4-...' → 'SCM-A1B2C3D4'
// This value is stable for the lifetime of the account and is safe to show on
// member cards and barcodes — it is not the internal UUID.
function generateMemberCode(userId) {
  return "SCM-" + userId.replace(/-/g, "").substring(0, 8).toUpperCase();
}

module.exports = {
  CUSTOMER_ACCESS_TTL_SECONDS,
  CUSTOMER_REFRESH_TTL_DAYS,
  EMAIL_OTP_ATTEMPT_LIMIT,
  applyPromotionRule,
  calculateBasePoints,
  calculateTier,
  comparePassword,
  createId,
  generateMemberCode,
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
  nowIso,
  parseBearerToken,
  parseImportCsv,
  refreshExpiryDate,
  requireEnv,
  resolvePointsWithPromotions,
  verifyAccessToken,
};
