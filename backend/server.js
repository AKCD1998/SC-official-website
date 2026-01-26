const path = require("path");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
dotenv.config();
const sgMail = require("@sendgrid/mail");
const authRoutes = require("./routes/auth");


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
const port = process.env.PORT || 3000;
const clientBuildPath = process.env.CLIENT_BUILD_DIR
  ? path.resolve(process.env.CLIENT_BUILD_DIR)
  : path.join(__dirname, "..", "frontend-react", "dist");

const allowed = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const localOrigins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
const allowedSet = new Set([...allowed, ...localOrigins].filter(Boolean));
const allowAll = allowedSet.size === 0;

app.use('/api', cors({
  origin: (origin, callBack) => {
    if (!origin || allowAll) return callBack(null, true);
    if (allowedSet.has(origin)) return callBack(null, true);
    return callBack(new Error("Not allowed by CORS"), false);
  },
  credentials: true,
}));

app.use(express.json());

//=============AUTH SIGN UP================
app.use('/api/auth', authRoutes);
app.get("/api/auth/ping", (req, res) => res.json({ ok: true }));
app.get("/api/health", (req, res) => res.json({ ok: true }));

//==============================================

// health checks
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

if (process.env.NODE_ENV === "production") {
  app.use(express.static(clientBuildPath));

  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(clientBuildPath, "index.html"));
  });
} else {
  app.get("/", (req, res) => res.send("Server is running"));
}

app.listen(port, () => console.log(`Server is running on port ${port}`));
