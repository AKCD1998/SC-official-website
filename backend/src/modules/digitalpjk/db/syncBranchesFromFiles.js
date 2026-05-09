import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, hasDatabase, pool } from "./pool.js";
import { loadBranchConfigs } from "../services/branchConfigService.js";

const UPSERT_BRANCH_SQL = `
  INSERT INTO branches (
    branch_code,
    pharmacy_name_th,
    branch_name_th,
    address_no,
    soi,
    district,
    province,
    postcode,
    phone,
    license_no,
    location_text,
    operator_title,
    operator_work_hours
  )
  VALUES (
    $1, $2, $3, $4, $5, $6,
    $7, $8, $9, $10, $11, $12, $13
  )
  ON CONFLICT (branch_code) DO UPDATE
  SET
    pharmacy_name_th = EXCLUDED.pharmacy_name_th,
    branch_name_th = EXCLUDED.branch_name_th,
    address_no = EXCLUDED.address_no,
    soi = EXCLUDED.soi,
    district = EXCLUDED.district,
    province = EXCLUDED.province,
    postcode = EXCLUDED.postcode,
    phone = EXCLUDED.phone,
    license_no = EXCLUDED.license_no,
    location_text = EXCLUDED.location_text,
    operator_title = EXCLUDED.operator_title,
    operator_work_hours = EXCLUDED.operator_work_hours,
    updated_at = NOW()
  RETURNING id, branch_code;
`;

function toNullableText(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized === "-") {
    return null;
  }

  return normalized;
}

async function upsertOneBranch(client, branch) {
  const params = [
    String(branch.branch_code).trim(),
    String(branch.pharmacy_name_th).trim(),
    String(branch.branch_name_th).trim(),
    toNullableText(branch.address_no),
    toNullableText(branch.soi),
    toNullableText(branch.district),
    toNullableText(branch.province),
    toNullableText(branch.postcode),
    toNullableText(branch.phone),
    toNullableText(branch.license_no),
    toNullableText(branch.location_text),
    toNullableText(branch.operator_title),
    toNullableText(branch.operator_work_hours),
  ];

  const result = await client.query(UPSERT_BRANCH_SQL, params);
  return result.rows[0];
}

export async function syncBranchesFromFiles(clientArg = null) {
  if (!hasDatabase()) {
    throw new Error("DIGITALPJK_DATABASE_URL is required to sync branches from files.");
  }

  const branches = await loadBranchConfigs();
  const ownsClient = !clientArg;
  const client = clientArg || (await pool.connect());

  try {
    if (ownsClient) {
      await client.query("BEGIN");
    }

    const synced = [];
    for (const branch of branches) {
      synced.push(await upsertOneBranch(client, branch));
    }

    if (ownsClient) {
      await client.query("COMMIT");
    }

    console.log(`Synced ${synced.length} branches from files.`);
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
  syncBranchesFromFiles()
    .catch((error) => {
      console.error("Branch sync failed:", error.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool();
    });
}
