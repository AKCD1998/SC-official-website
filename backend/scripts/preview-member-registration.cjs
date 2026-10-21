// Local-only preview: never loads .env or falls back to a deployed database.
const express = require("express");
const { Pool } = require("pg");
const fs = require("node:fs");
const path = require("node:path");
const { createPublicMemberRegistration } = require("../routes/publicMemberRegistration");

async function main() {
  const raw = process.env.SCCRM_PUBLIC_TEST_DATABASE_URL;
  const url = new URL(raw || "http://invalid");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || !url.pathname.startsWith("/crm_public_registration_test_")) {
    throw new Error("Preview requires a local crm_public_registration_test_* database");
  }
  const pool = new Pool({ connectionString: raw, ssl: false });
  await pool.query("SELECT id FROM public.users LIMIT 0");
  const app = express();
  for (const [route, filename] of [["/join", "index.html"], ["/join/qr", "qr.html"]]) {
    app.get(route, (_req, res) => {
      const html = fs.readFileSync(path.join(__dirname, "../public/member-registration", filename), "utf8");
      res.set("Cache-Control", "no-store");
      res.send(html.replace("<!-- local-preview-banner -->", '<p class="preview-note">ตัวอย่างในเครื่อง · ข้อมูลที่กรอกจะบันทึกเฉพาะฐานทดสอบ<br>QR บนป้ายเป็นลิงก์สำหรับใช้หลังเปิดระบบจริง</p>'));
    });
  }
  app.use("/join", createPublicMemberRegistration({ pool }));
  const port = Number(process.env.SCCRM_PUBLIC_PREVIEW_PORT || 4318);
  const server = app.listen(port, "127.0.0.1", () => {
    console.log(`Local preview: http://127.0.0.1:${port}/join`);
  });
  async function stop() {
    server.close();
    await pool.end();
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch(() => { console.error("Could not start local member-registration preview"); process.exitCode = 1; });
