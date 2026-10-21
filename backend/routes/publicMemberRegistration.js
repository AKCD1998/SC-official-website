const express = require("express");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { CONSENT_VERSION, validatePublicRegistration } = require("../lib/publicMemberRegistration");

const publicDirectory = path.join(__dirname, "../public/member-registration");
const received = { ok: true, message: "รับข้อมูลเรียบร้อยแล้ว" };

// Bounded, process-local protection. This sub-app alone trusts the last reverse
// proxy (Render); the shared backend's existing proxy/auth settings are unchanged.
function createRateLimiter({ now, maxRequests, windowMs }) {
  const clients = new Map();
  return (req, res, next) => {
    const time = now();
    for (const [address, entry] of clients) {
      if (entry.expiresAt <= time) clients.delete(address);
    }
    const address = req.ip;
    let entry = clients.get(address);
    if (!entry) {
      if (clients.size >= 5000) {
        res.set("Retry-After", "60");
        return res.status(429).json({ error: "มีผู้ใช้งานจำนวนมาก กรุณาลองใหม่อีกสักครู่" });
      }
      entry = { count: 0, expiresAt: time + windowMs };
      clients.set(address, entry);
    }
    entry.count += 1;
    if (entry.count > maxRequests) {
      res.set("Retry-After", String(Math.ceil((entry.expiresAt - time) / 1000)));
      return res.status(429).json({ error: "ส่งข้อมูลบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่" });
    }
    return next();
  };
}

function createPublicMemberRegistration({ pool, now = Date.now, maxRequests = 30, windowMs = 15 * 60 * 1000 }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((_req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    });
    next();
  });

  app.get("/", (_req, res) => res.sendFile(path.join(publicDirectory, "index.html")));
  app.get("/qr", (_req, res) => res.sendFile(path.join(publicDirectory, "qr.html")));
  app.use("/assets", express.static(publicDirectory, { index: false, dotfiles: "deny" }));
  app.post("/submit", createRateLimiter({ now, maxRequests, windowMs }),
    (req, res, next) => {
      const origin = req.get("origin");
      if (origin && origin !== `${req.protocol}://${req.get("host")}`) {
        return res.status(403).json({ error: "กรุณาเปิดแบบฟอร์มจากลิงก์หรือ QR ของร้าน" });
      }
      if (!req.is("application/json")) return res.status(415).json({ error: "รูปแบบข้อมูลไม่ถูกต้อง" });
      return next();
    },
    express.json({ limit: "4kb" }),
    async (req, res) => {
      const validated = validatePublicRegistration(req.body);
      if (validated.error) return res.status(400).json(validated);
      let client;
      let transactionStarted = false;
      try {
        client = await pool.connect();
        await client.query("BEGIN");
        transactionStarted = true;
        const userId = randomUUID();
        const { rows } = await client.query(
          `INSERT INTO users (id, full_name, phone_number, password_hash, is_verified, created_at)
           VALUES ($1, $2, $3, NULL, FALSE, NOW())
           ON CONFLICT (phone_number) WHERE phone_number IS NOT NULL DO NOTHING
           RETURNING id`,
          [userId, validated.value.fullName, validated.value.phone],
        );
        if (rows.length) {
          const memberCode = `SCM-${userId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
          await client.query(
            `INSERT INTO member_profiles (id, user_id, member_code, tier, is_active, remark, created_at, updated_at)
             VALUES ($1, $2, $3, 'bronze', TRUE, $4, NOW(), NOW())`,
            [randomUUID(), userId, memberCode, "ลงทะเบียนด้วยตนเองผ่าน QR"],
          );
          await client.query(
            `INSERT INTO crm_member_consents
              (id, user_id, consent_version, pdpa_general, pdpa_health, marketing_email, marketing_sms, consented_at)
             VALUES ($1, $2, $3, TRUE, FALSE, FALSE, FALSE, NOW())`,
            [randomUUID(), userId, CONSENT_VERSION],
          );
        }
        await client.query("COMMIT");
        transactionStarted = false;
        // Same result for new/existing numbers: never expose another customer's
        // name, membership identifier or account existence on a public endpoint.
        return res.json(received);
      } catch (error) {
        if (client && transactionStarted) {
          try { await client.query("ROLLBACK"); } catch { /* Connection may already be closed. */ }
        }
        console.error("[publicMemberRegistration] save failed", { code: error.code || "unavailable" });
        return res.status(503).json({ error: "ขณะนี้ยังบันทึกข้อมูลไม่ได้ กรุณาลองอีกครั้ง หรือแจ้งพนักงาน" });
      } finally {
        if (client) client.release();
      }
    });
  app.use((error, _req, res, _next) => {
    if (error.type === "entity.too.large") return res.status(413).json({ error: "ข้อมูลมีขนาดใหญ่เกินไป" });
    if (error.type === "entity.parse.failed") return res.status(400).json({ error: "รูปแบบข้อมูลไม่ถูกต้อง" });
    console.error("[publicMemberRegistration] request failed", { code: error.code || "unavailable" });
    return res.status(503).json({ error: "ระบบไม่พร้อมใช้งาน กรุณาลองใหม่อีกครั้ง" });
  });
  return app;
}

module.exports = { createPublicMemberRegistration };
