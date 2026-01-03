const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const sgMail = require("@sendgrid/mail");
const pool = require("../db");
const requireAuth = require("../middleware/requireAuth");

const router = express.Router();

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

function isEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generate6DigitCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function hashOtp(email, code) {
  if (!process.env.OTP_SECRET) throw new Error("OTP_SECRET missing");
  return crypto
    .createHmac("sha256", process.env.OTP_SECRET)
    .update(`${email}:${code}`)
    .digest("hex");
}

// 1) Request OTP
// POST /api/auth/start-signup { email }
router.post("/start-signup", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required." });
    if (!isEmail(email)) return res.status(400).json({ error: "Invalid email." });

    // already registered?
    const exists = await pool.query("select id from users where email=$1", [email]);
    if (exists.rowCount > 0) return res.status(409).json({ error: "Email already registered." });

    // simple anti-spam: 60s cooldown
    const recent = await pool.query(
      `select id from email_verifications
       where email=$1 and created_at > now() - interval '60 seconds'
       order by created_at desc limit 1`,
      [email]
    );
    if (recent.rowCount > 0) {
      return res.status(429).json({ error: "Please wait a bit before requesting another code." });
    }

    const code = generate6DigitCode();
    const code_hash = hashOtp(email, code);
    const ttl = Number(process.env.OTP_TTL_MINUTES || 10);

    await pool.query(
      `insert into email_verifications (email, code_hash, expires_at)
       values ($1,$2, now() + ($3 || ' minutes')::interval)`,
      [email, code_hash, ttl]
    );

    await sgMail.send({
      to: email,
      from: { email: process.env.MAIL_USER, name: "SC official website" },
      subject: "Your verification code",
      text: `Your verification code is: ${code}\nThis code expires in ${ttl} minutes.`,
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error("start-signup error:", e);
    return res.status(500).json({ error: "Internal server error." });
  }
});

// 2) Verify OTP
// POST /api/auth/verify-email { email, code }
router.post("/verify-email", async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: "Email and code are required." });
    if (!isEmail(email)) return res.status(400).json({ error: "Invalid email." });

    const code_hash = hashOtp(email, String(code).trim());

    const q = await pool.query(
      `select id, attempt_count
       from email_verifications
       where email=$1 and used_at is null and expires_at > now()
       order by created_at desc
       limit 1`,
      [email]
    );
    if (q.rowCount === 0) return res.status(400).json({ error: "No valid code. Request a new one." });

    const row = q.rows[0];
    if (row.attempt_count >= 5) {
      return res.status(429).json({ error: "Too many attempts. Request a new code." });
    }

    const match = await pool.query(
      `select id from email_verifications where id=$1 and code_hash=$2`,
      [row.id, code_hash]
    );

    if (match.rowCount === 0) {
      await pool.query(`update email_verifications set attempt_count=attempt_count+1 where id=$1`, [row.id]);
      return res.status(400).json({ error: "Invalid code." });
    }

    await pool.query(`update email_verifications set used_at=now() where id=$1`, [row.id]);
    return res.json({ ok: true });
  } catch (e) {
    console.error("verify-email error:", e);
    return res.status(500).json({ error: "Internal server error." });
  }
});

// 3) Finish signup (create user)
// POST /api/auth/finish-signup { fullName, email, password }
router.post("/finish-signup", async (req, res) => {
  try {
    const { fullName, email, password } = req.body;

    if (!fullName || !email || !password)
      return res.status(400).json({ error: "Full name, email, and password are required." });
    if (!isEmail(email)) return res.status(400).json({ error: "Invalid email." });
    if (password.length < 8)
      return res.status(400).json({ error: "Password must be at least 8 characters long." });

    // must have verified in last 15 minutes
    const ok = await pool.query(
      `select id from email_verifications
       where email=$1 and used_at is not null and used_at > now() - interval '15 minutes'
       order by used_at desc limit 1`,
      [email]
    );
    if (ok.rowCount === 0) return res.status(403).json({ error: "Email not verified." });

    const exists = await pool.query("select id from users where email=$1", [email]);
    if (exists.rowCount > 0) return res.status(409).json({ error: "Email already registered." });

    const password_hash = await bcrypt.hash(password, 10);

    await pool.query(
      `insert into users (full_name, email, password_hash, is_verified, verified_at)
      values ($1,$2,$3,true,now())`,
      [fullName, email, password_hash]
    );


    return res.json({ ok: true });
  } catch (e) {
    console.error("finish-signup error:", e);
    return res.status(500).json({ error: "Internal server error." });
  }
});

// 4) Login
// POST /api/auth/login { email, password }
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password are required." });

    const q = await pool.query(
      "select id, email, password_hash, full_name from users where email=$1",
      [email]
    );
    if (q.rowCount === 0) return res.status(400).json({ error: "Invalid email or password." });

    const user = q.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(400).json({ error: "Invalid email or password." });

    if (!process.env.JWT_SECRET) return res.status(500).json({ error: "JWT secret not configured." });

    const token = jwt.sign(
      { userId: user.id, email: user.email, fullName: user.full_name },
      process.env.JWT_SECRET,
      { expiresIn: "3h" }
    );

    return res.json({ token });
  } catch (e) {
    console.error("login error:", e);
    return res.status(500).json({ error: "Internal server error." });
  }
});


// middleware/requireAuth.js
// 5) who am i (test JWT)
// GET /api/auth/me (needs Authorization: Bearer <token>)
router.get("/me", requireAuth, async (req, res) => {
  //req.user มาจาก JWT payload ที่ middleware requireAuth ใส่ไว้
  return res.json({ ok: true, user: req.user });
});


module.exports = router;


