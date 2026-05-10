function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function resolvedMetaStaffName(meta = {}) {
  const direct = normalizeText(meta.staff_name);
  if (direct) return direct;
  const afterValue = normalizeText(meta?.after?.staff_name);
  if (afterValue) return afterValue;
  return '';
}

function resolvedMetaStaffId(meta = {}) {
  const direct = normalizeText(meta.staff_id);
  if (direct) return direct;
  const afterValue = normalizeText(meta?.after?.staff_id);
  if (afterValue) return afterValue;
  return '';
}

function assertEventStaffIdentity(meta = {}, contextLabel = 'appointment event') {
  const staffName = resolvedMetaStaffName(meta);
  const staffId = resolvedMetaStaffId(meta);
  if (staffName || staffId) {
    return { staffName, staffId };
  }

  const err = new Error(`${contextLabel} requires meta.staff_name or meta.staff_id`);
  err.status = 422;
  err.code = 'SSOT_EVENT_STAFF_REQUIRED';
  throw err;
}

export { assertEventStaffIdentity, normalizeText };
