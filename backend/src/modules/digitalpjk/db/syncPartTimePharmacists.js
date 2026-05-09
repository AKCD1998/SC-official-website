import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, hasDatabase, pool } from "./pool.js";

const PART_TIME_PHARMACIST_ROWS = [
  { license_id_number: 32515, title_and_name: "ภญ. ปิยวดี ตั้งวิชิตฤกษ์" },
  { license_id_number: 31167, title_and_name: "ภก. ทรงพล ลิ้มพิสูจน์" },
  { license_id_number: 30753, title_and_name: "ภญ. ณัฐพัชร กระจ่าง" },
  { license_id_number: 42243, title_and_name: "ภญ. วริศรา ผ่องพุทธ" },
  { license_id_number: 35084, title_and_name: "ภก. ธนัท สังขรักษ์" },
  { license_id_number: 45834, title_and_name: "ภญ. ธัญญา วงศ์ชัย" },
  { license_id_number: 52309, title_and_name: "ภญ. เบญจวรรณ ฟักขำ" },
  { license_id_number: 51181, title_and_name: "ภญ. มนัสวี ประเสริฐศุภกุล" },
  { license_id_number: 40596, title_and_name: "ภก. ธนพล แสงทับทิม" },
  { license_id_number: 38604, title_and_name: "ภญ. ทิพวรรณ เรืองสุข" },
  { license_id_number: 49649, title_and_name: "ภญ. ทิพยาภา ปานศุภวงศ์" },
  { license_id_number: 51337, title_and_name: "ภญ. วรรณพร ฉัตรวิชชานนท์" },
  { license_id_number: 45976, title_and_name: "ภก. ชวิศ ดิษฐาพร" },
];

const UPSERT_PART_TIME_PHARMACIST_SQL = `
  INSERT INTO part_time_pharmacists (
    license_id_number,
    pharmacist_title,
    pharmacist_name
  )
  VALUES ($1, $2, $3)
  ON CONFLICT (license_id_number) DO UPDATE
  SET
    pharmacist_title = EXCLUDED.pharmacist_title,
    pharmacist_name = EXCLUDED.pharmacist_name,
    updated_at = NOW()
  RETURNING license_id_number;
`;

function parseTitleAndName(titleAndName) {
  const normalized = String(titleAndName || "").trim().replace(/\s+/g, " ");
  const firstSpaceIndex = normalized.indexOf(" ");

  if (!normalized || firstSpaceIndex <= 0 || firstSpaceIndex === normalized.length - 1) {
    throw new Error(`Invalid pharmacist name format: "${titleAndName}"`);
  }

  return {
    pharmacist_title: normalized.slice(0, firstSpaceIndex),
    pharmacist_name: normalized.slice(firstSpaceIndex + 1),
  };
}

function assertUniqueLicenseNumbers(rows) {
  const seen = new Set();

  for (const row of rows) {
    const license = Number(row.license_id_number);
    if (!Number.isInteger(license) || license <= 0) {
      throw new Error(`Invalid license_id_number: "${row.license_id_number}"`);
    }

    if (seen.has(license)) {
      throw new Error(`Duplicate license_id_number in seed data: ${license}`);
    }

    seen.add(license);
  }
}

async function upsertOnePartTimePharmacist(client, row) {
  const { pharmacist_title, pharmacist_name } = parseTitleAndName(row.title_and_name);
  const params = [Number(row.license_id_number), pharmacist_title, pharmacist_name];
  const result = await client.query(UPSERT_PART_TIME_PHARMACIST_SQL, params);
  return result.rows[0];
}

export async function syncPartTimePharmacists(clientArg = null) {
  if (!hasDatabase()) {
    throw new Error("DIGITALPJK_DATABASE_URL is required to sync part-time pharmacists.");
  }

  assertUniqueLicenseNumbers(PART_TIME_PHARMACIST_ROWS);

  const ownsClient = !clientArg;
  const client = clientArg || (await pool.connect());

  try {
    if (ownsClient) {
      await client.query("BEGIN");
    }

    const synced = [];
    for (const row of PART_TIME_PHARMACIST_ROWS) {
      synced.push(await upsertOnePartTimePharmacist(client, row));
    }

    if (ownsClient) {
      await client.query("COMMIT");
    }

    console.log(`Synced ${synced.length} part-time pharmacists.`);
    return synced;
  } catch (error) {
    if (ownsClient) {
      await client.query("ROLLBACK");
    }

    throw error;
  } finally {
    if (ownsClient) {
      client.release();
    }
  }
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  syncPartTimePharmacists()
    .catch((error) => {
      console.error("Part-time pharmacist sync failed:", error.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool();
    });
}
