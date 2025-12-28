const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const dotenv = require("dotenv");

dotenv.config();

console.log("ENV CHECK:", {
  CORS_ORIGIN: process.env.CORS_ORIGIN,
  MAIL_USER: process.env.MAIL_USER ? "SET" : "MISSING",
  MAIL_APP_PASSWORD: process.env.MAIL_APP_PASSWORD ? "SET" : "MISSING",
  MAIL_TO: process.env.MAIL_TO ? "SET" : "MISSING",
});

// ตั้งค่า transporter สำหรับส่งอีเมล
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_APP_PASSWORD
      },
    });


const app = express();
const allowed = (process.env.CORS_ORIGIN || "")
  .split(",")
    .map(s => s.trim())
    .filter(Boolean);

app.use(cors({ 
  origin: (origin, callBack) => {
    // อนุญาตคำขอถ้าไม่มี origin (เช่น Postman) หรือถ้า origin อยู่ในรายการที่อนุญาต
    if (!origin) return callBack(null, true);
    if (allowed.includes(origin)) {
      return callBack(null, true);
    }
    return callBack(new Error("Not allowed by CORS"), false);
  } }));
app.use(express.json());

// เช็กว่าเซิร์ฟเวอร์ทำงานอยู่
app.get("/", (req, res) => {
  res.send("Server is running");
});

app.get("/health", (req, res) => res.json({ ok: true }));


// รับข้อความจากฟอร์ม
app.post("/api/contact", async (req, res) => {
  try {
    const {name, email, message} = req.body;

    if (!name || !email || !message) {
      return res.status(400).json({ error: "All fields are required." });
    }
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!emailOk) {
      return res.status(400).json({ error: "Invalid email." });
    }

    

    await transporter.sendMail({
      from: `"SC official website" <${process.env.MAIL_USER}>`,
      to: process.env.MAIL_TO,
      replyTo: email,
      subject:`[SC Website] Contact from ${name}`,
      text: `Name: ${name}\nEmail: ${email}\n\nMessage: ${message}`,
  });

  res.json({ ok: true });
  } catch (error) {
    console.error("Error sending email:", error);
    res.status(500).json({ error: "Failed to send message." });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => { console.log(`Server is running on port ${port}`); });

