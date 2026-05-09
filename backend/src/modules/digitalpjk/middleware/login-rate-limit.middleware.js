const attemptsByIp = new Map();

function getWindowMs() {
  const parsed = Number(process.env.DIGITALPJK_LOGIN_RATE_LIMIT_WINDOW_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
}

function getMaxAttempts() {
  const parsed = Number(process.env.DIGITALPJK_LOGIN_RATE_LIMIT_MAX);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

function normalizeIp(req) {
  return req.ip || req.headers["x-forwarded-for"] || "unknown";
}

export function loginRateLimit(req, res, next) {
  const windowMs = getWindowMs();
  const maxAttempts = getMaxAttempts();
  const now = Date.now();
  const ip = normalizeIp(req);

  const current = attemptsByIp.get(ip);
  if (!current || now - current.windowStart >= windowMs) {
    attemptsByIp.set(ip, { windowStart: now, count: 1 });
    return next();
  }

  if (current.count >= maxAttempts) {
    const retryAfterSeconds = Math.ceil((windowMs - (now - current.windowStart)) / 1000);
    res.setHeader("Retry-After", String(retryAfterSeconds));
    return res.status(429).json({ error: "Too many login attempts. Please try again later." });
  }

  current.count += 1;
  attemptsByIp.set(ip, current);

  return next();
}
