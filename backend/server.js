const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const sgMail = require("@sendgrid/mail");

dotenv.config();

// ==== ENV CHECK ====
console.log("ENV CHECK:", {
  CORS_ORIGIN: process.env.CORS_ORIGIN,
  MAIL_USER: process.env.MAIL_USER ? "SET" : "MISSING", // ใช้เป็น "from" ของเว็บ
  MAIL_TO: process.env.MAIL_TO ? "SET" : "MISSING",
  SENDGRID_API_KEY: process.env.SENDGRID_API_KEY ? "SET" : "MISSING",
});

// ==== SendGrid setup ====
if (!process.env.SENDGRID_API_KEY) {
  console.error("Missing SENDGRID_API_KEY");
}
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// (optional) quick sanity check (ไม่ยิงจริง แค่บอกให้รู้ว่า key มี)
console.log("SendGrid configured:", !!process.env.SENDGRID_API_KEY);

// ==== App ====
const app = express();

const allowed = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callBack) => {
      if (!origin) return callBack(null, true);
      if (allowed.includes(origin)) return callBack(null, true);
      return callBack(new Error("Not allowed by CORS"), false);
    },
  })
);

app.use(express.json());

// health checks
app.get("/", (req, res) => res.send("Server is running"));
app.get("/health", (req, res) => res.json({ ok: true }));

// contact endpoint
app.post("/api/contact", async (req, res) => {
  try {
    const { name, email, message } = req.body;

    if (!name || !email || !message) {
      return res.status(400).json({ error: "All fields are required." });
    }

    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!emailOk) {
      return res.status(400).json({ error: "Invalid email." });
    }

    // IMPORTANT:
    // - SendGrid "from" ควรเป็นอีเมลที่คุณ verify ใน SendGrid (Single Sender หรือ Domain Auth)
    // - replyTo ใช้อีเมลผู้กรอกฟอร์มได้เหมือนเดิม
    const msg = {
  to: process.env.MAIL_TO,
  from: {
    email: process.env.MAIL_USER, // ต้องเป็น Single Sender ที่ verify แล้ว
    name: "SC official website",
  },
  replyTo: email, // อีเมลคนกรอกฟอร์ม
  subject: `[SC Website] Contact from ${name}`,
  text: `Name: ${name}\nEmail: ${email}\n\nMessage: ${message}`,
};


    // ส่งเมลผ่าน SendGrid
    const resp = await sgMail.send(msg);

    // log เบาๆ
    console.log("SendGrid send ok:", {
      statusCode: resp?.[0]?.statusCode,
      messageId: resp?.[0]?.headers?.["x-message-id"],
    });

    return res.json({ ok: true });
  } catch (error) {
    // SendGrid error จะมี response.body ช่วย debug
    console.error("Error sending email:", {
      message: error?.message,
      code: error?.code,
      statusCode: error?.response?.statusCode,
      body: error?.response?.body,
    });
    return res.status(500).json({ error: "Failed to send message." });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server is running on port ${port}`));
