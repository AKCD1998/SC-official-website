const PLAN_MODE_VALUES = new Set(['one_off', 'package']);

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function parseMeta(rawMeta) {
  if (!rawMeta) return {};
  if (typeof rawMeta === 'object' && !Array.isArray(rawMeta)) return rawMeta;
  if (typeof rawMeta === 'string') {
    try {
      const parsed = JSON.parse(rawMeta);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      return {};
    }
  }
  return {};
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function toTimestampValue(event) {
  const eventAt = normalizeText(event?.event_at || event?.eventAt || event?.created_at || event?.createdAt);
  const parsed = Date.parse(eventAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizePlanMode(value) {
  const raw = normalizeText(value).toLowerCase();
  if (!raw) return '';
  if (raw === 'oneoff') return 'one_off';
  return PLAN_MODE_VALUES.has(raw) ? raw : '';
}

function readEventField(meta, key) {
  const after = meta?.after && typeof meta.after === 'object' ? meta.after : null;
  if (after && hasOwn(after, key)) return after[key];
  if (hasOwn(meta, key)) return meta[key];
  return undefined;
}

function hasExplicitPackageUnlink(meta) {
  const after = meta?.after && typeof meta.after === 'object' ? meta.after : null;
  return Boolean(
    meta?.unlink_package === true ||
      meta?.package_unlinked === true ||
      (after && (after.unlink_package === true || after.package_unlinked === true))
  );
}

function sortEventsDesc(events) {
  return [...events].sort((left, right) => {
    const timeDiff = toTimestampValue(right) - toTimestampValue(left);
    if (timeDiff !== 0) return timeDiff;
    return normalizeText(right?.id).localeCompare(normalizeText(left?.id));
  });
}

// Event sourcing resolver:
// For each field, freeze the first non-empty value found from newest -> oldest.
// Null/empty in newer events does not delete historical linkage unless unlink is explicit.
export function resolveAppointmentFields(events = []) {
  const ordered = sortEventsDesc(Array.isArray(events) ? events : []);

  let packageResolved = false;
  let modeResolved = false;
  let textResolved = false;

  let packageId = '';
  let treatmentPlanMode = '';
  let treatmentItemText = '';

  for (const event of ordered) {
    const meta = parseMeta(event?.meta);

    if (!packageResolved) {
      if (hasExplicitPackageUnlink(meta)) {
        packageId = '';
        packageResolved = true;
      } else {
        const rawPackage = readEventField(meta, 'package_id');
        const normalizedPackage = normalizeText(rawPackage);
        if (normalizedPackage) {
          packageId = normalizedPackage;
          packageResolved = true;
        }
      }
    }

    if (!modeResolved) {
      const rawMode = readEventField(meta, 'treatment_plan_mode');
      const normalizedMode = normalizePlanMode(rawMode);
      if (normalizedMode) {
        treatmentPlanMode = normalizedMode;
        modeResolved = true;
      }
    }

    if (!textResolved) {
      const rawText = readEventField(meta, 'treatment_item_text');
      const normalizedText = normalizeText(rawText);
      if (normalizedText) {
        treatmentItemText = normalizedText;
        textResolved = true;
      }
    }

    if (packageResolved && modeResolved && textResolved) break;
  }

  if (!treatmentPlanMode && packageId) {
    treatmentPlanMode = 'package';
  }

  return {
    package_id: packageId,
    treatment_plan_mode: treatmentPlanMode,
    treatment_item_text: treatmentItemText,
  };
}

export function resolveAppointmentFieldsByAppointmentId(rows = []) {
  const grouped = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const appointmentId = normalizeText(row?.appointment_id || row?.appointmentId);
    if (!appointmentId) continue;
    if (!grouped.has(appointmentId)) {
      grouped.set(appointmentId, []);
    }
    grouped.get(appointmentId).push(row);
  }

  const resolved = new Map();
  for (const [appointmentId, events] of grouped.entries()) {
    resolved.set(appointmentId, resolveAppointmentFields(events));
  }
  return resolved;
}
