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



function hashResetOtp(email, code) {
  // you can reuse OTP_SECRET, or make a separate RESET_OTP_SECRET
  if (!process.env.OTP_SECRET) throw new Error("OTP_SECRET missing");
  return crypto
    .createHmac("sha256", process.env.OTP_SECRET)
    .update(`RESET:${email}:${code}`)
    .digest("hex");
}

function hashResetToken(token) {
  if (!process.env.OTP_SECRET) throw new Error("OTP_SECRET missing");
  return crypto
    .createHmac("sha256", process.env.OTP_SECRET)
    .update(`RT:${token}`)
    .digest("hex");
}

// 6) Forgot password: request OTP
// POST /api/auth/forgot-password { email }
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required." });
    if (!isEmail(email)) return res.status(400).json({ error: "Invalid email." });

    const qUser = await pool.query(
      "select id, email, is_verified from users where email=$1",
      [email]
    );

    if (qUser.rowCount === 0) {
      return res.status(404).json({ error: "ไม่พบอีเมลนี้ในระบบ" });
    }

    const user = qUser.rows[0];
    if (!user.is_verified) {
      return res.status(403).json({ error: "อีเมลนี้ยังไม่ได้รับการยืนยัน" });
    }

    const otp = generate6DigitCode();
    const otp_hash = hashResetOtp(email, otp);
    const ttl = 15; // minutes

    await pool.query(
      `
      insert into password_resets (email, otp_hash, expires_at, attempts, reset_token_hash, reset_token_expires_at)
      values ($1, $2, now() + interval '${ttl} minutes', 0, null, null)
      on conflict (email)
      do update set otp_hash=excluded.otp_hash,
                    expires_at=excluded.expires_at,
                    attempts=0,
                    reset_token_hash=null,
                    reset_token_expires_at=null
      `,
      [email, otp_hash]
    );

    await sgMail.send({
      to: email,
      from: { email: process.env.MAIL_USER, name: "SC official website" },
      subject: "Password reset code",
      text: `รหัสรีเซ็ตรหัสผ่านของคุณคือ: ${otp}\nรหัสนี้หมดอายุใน ${ttl} นาที`,
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error("forgot-password error:", e);
    return res.status(500).json({ error: "Internal server error." });
  }
});

// 7) Verify OTP and issue resetToken
// POST /api/auth/verify-reset-otp { email, otp }
router.post("/verify-reset-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: "Email and otp are required." });
    if (!isEmail(email)) return res.status(400).json({ error: "Invalid email." });

    const q = await pool.query(
      `
      select otp_hash, expires_at, attempts
      from password_resets
      where email=$1
      `,
      [email]
    );

    if (q.rowCount === 0) return res.status(400).json({ error: "ยังไม่ได้ขอรหัส OTP" });

    const pr = q.rows[0];

    if (new Date(pr.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: "OTP หมดอายุแล้ว กรุณาขอใหม่" });
    }

    if (pr.attempts >= 5) {
      return res.status(429).json({ error: "ลองผิดเกินกำหนด กรุณาขอ OTP ใหม่" });
    }

    const otp_hash = hashResetOtp(email, String(otp).trim());
    if (otp_hash !== pr.otp_hash) {
      await pool.query(
        "update password_resets set attempts=attempts+1 where email=$1",
        [email]
      );
      return res.status(400).json({ error: "OTP ไม่ถูกต้อง" });
    }

    // issue reset token (short-lived)
    const resetToken = crypto.randomBytes(24).toString("hex");
    const reset_token_hash = hashResetToken(resetToken);

    await pool.query(
      `
      update password_resets
      set reset_token_hash=$2,
          reset_token_expires_at=now() + interval '20 minutes'
      where email=$1
      `,
      [email, reset_token_hash]
    );

    return res.json({ ok: true, resetToken });
  } catch (e) {
    console.error("verify-reset-otp error:", e);
    return res.status(500).json({ error: "Internal server error." });
  }
});

// 8) Reset password using resetToken
// POST /api/auth/reset-password { email, resetToken, newPassword }
router.post("/reset-password", async (req, res) => {
  try {
    const { email, resetToken, newPassword } = req.body;

    if (!email || !resetToken || !newPassword) {
      return res.status(400).json({ error: "Email, resetToken, and newPassword are required." });
    }
    if (!isEmail(email)) return res.status(400).json({ error: "Invalid email." });
    if (newPassword.length < 8) return res.status(400).json({ error: "Password must be at least 8 chars." });

    const q = await pool.query(
      `
      select reset_token_hash, reset_token_expires_at
      from password_resets
      where email=$1
      `,
      [email]
    );

    if (q.rowCount === 0) return res.status(400).json({ error: "ไม่มีคำขอรีเซ็ตรหัสผ่าน" });

    const pr = q.rows[0];
    if (!pr.reset_token_hash) return res.status(400).json({ error: "ยังไม่ผ่านการยืนยัน OTP" });

    if (!pr.reset_token_expires_at || new Date(pr.reset_token_expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: "resetToken หมดอายุ กรุณาทำใหม่" });
    }

    const incoming_hash = hashResetToken(resetToken);
    if (incoming_hash !== pr.reset_token_hash) {
      return res.status(400).json({ error: "Invalid reset token" });
    }

    const password_hash = await bcrypt.hash(newPassword, 10);

    await pool.query("update users set password_hash=$2 where email=$1", [email, password_hash]);
    await pool.query("delete from password_resets where email=$1", [email]);

    return res.json({ ok: true });
  } catch (e) {
    console.error("reset-password error:", e);
    return res.status(500).json({ error: "Internal server error." });
  }
});


module.exports = router;


