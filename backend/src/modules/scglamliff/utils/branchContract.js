import { getDefaultBranchId } from '../config/env.js';

const UUID_BRANCH_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const DEFAULT_BRANCH_ID = getDefaultBranchId();

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

export function normalizeBranchWriteValue(value) {
  const normalized = normalizeText(value);
  return normalized || null;
}

export function resolveCanonicalWriteBranchId(value, { defaultValue = DEFAULT_BRANCH_ID } = {}) {
  const explicitValue = normalizeBranchWriteValue(value);
  if (explicitValue) return explicitValue;
  return normalizeBranchWriteValue(defaultValue);
}

export function isUuidBranchId(value) {
  return UUID_BRANCH_ID_PATTERN.test(normalizeText(value));
}

export function parseBranchFilterQuery(value, { fieldName = 'branch_id' } = {}) {
  const normalized = normalizeText(value);
  if (!normalized) return '';

  if (!isUuidBranchId(normalized)) {
    const err = new Error(`Invalid query parameter: ${fieldName}`);
    err.status = 400;
    err.details = {
      param: fieldName,
      provided: normalized,
      expected: 'uuid',
    };
    throw err;
  }

  return normalized;
}
