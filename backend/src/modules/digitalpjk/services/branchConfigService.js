import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const BRANCH_CONFIG_DIR = path.join(__dirname, "..", "data", "branches");

const REQUIRED_FIELDS = [
  "pharmacy_name_th",
  "branch_name_th",
  "address_no",
  "soi",
  "district",
  "province",
  "postcode",
  "phone",
  "license_no",
  "location_text",
  "operator_title",
  "operator_work_hours",
];

let cachedBranchConfigs = [];

function getBranchCodeFromFilename(filename) {
  const match = filename.match(/^(\d+)\.json$/);
  if (!match) {
    throw new Error(
      `Invalid branch config file name "${filename}". Expected numeric format like 001.json.`
    );
  }

  return match[1];
}

function assertValidBranchConfig(filename, config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`Invalid JSON in "${filename}". Expected an object.`);
  }

  for (const field of REQUIRED_FIELDS) {
    if (typeof config[field] !== "string") {
      throw new Error(`Invalid "${field}" in "${filename}". Expected a string.`);
    }
  }
}

async function loadBranchConfigFile(filename) {
  const filePath = path.join(BRANCH_CONFIG_DIR, filename);
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);

  assertValidBranchConfig(filename, parsed);

  return {
    branch_code: getBranchCodeFromFilename(filename),
    ...parsed,
  };
}

export async function loadBranchConfigs() {
  const files = (await readdir(BRANCH_CONFIG_DIR))
    .filter((name) => name.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b));

  if (files.length === 0) {
    throw new Error(`No branch config files found in "${BRANCH_CONFIG_DIR}".`);
  }

  const loaded = [];
  const seenBranchCodes = new Set();

  for (const file of files) {
    const config = await loadBranchConfigFile(file);
    if (seenBranchCodes.has(config.branch_code)) {
      throw new Error(`Duplicate branch_code "${config.branch_code}" from file "${file}".`);
    }

    seenBranchCodes.add(config.branch_code);
    loaded.push(config);
  }

  cachedBranchConfigs = loaded;
  return loaded;
}

export function getBranchConfigs() {
  return cachedBranchConfigs;
}
