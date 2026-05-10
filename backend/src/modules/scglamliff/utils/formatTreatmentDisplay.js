function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function toNonNegativeInt(value, fallback = null) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, parsed);
}

function toTitleCase(value) {
  const text = normalizeText(value);
  if (!text) return '';
  return text
    .split(/\s+/)
    .map((word) => {
      if (!word) return '';
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

function deriveNameFromCode(code) {
  const rawCode = normalizeText(code);
  if (!rawCode) return '';

  const normalized = rawCode.toLowerCase();
  if (normalized === 'smooth' || normalized.startsWith('smooth_') || normalized.startsWith('smooth-')) {
    return 'Smooth';
  }

  const firstToken = rawCode.split(/[_-]/)[0] || rawCode;
  const stripped = firstToken.replace(/[^A-Za-z0-9\s]/g, '');
  return toTitleCase(stripped);
}

function isThaiSmoothName(value) {
  const text = normalizeText(value);
  if (!text) return false;
  return /บำบัดผิวใส|เรียบเนียน/.test(text);
}

function resolveCanonicalTreatmentName({
  name_en = '',
  name_th = '',
  treatment_code = '',
  fallback_name = '',
} = {}) {
  const codeName = deriveNameFromCode(treatment_code);
  if (codeName === 'Smooth') return codeName;

  const nameEn = normalizeText(name_en);
  if (nameEn) return nameEn;

  const fallback = normalizeText(fallback_name);
  if (fallback) {
    if (isThaiSmoothName(fallback)) return 'Smooth';
    return fallback;
  }

  const nameTh = normalizeText(name_th);
  if (nameTh) {
    if (isThaiSmoothName(nameTh)) return 'Smooth';
    return nameTh;
  }

  if (codeName) return codeName;
  return 'Treatment';
}

function formatTreatmentDisplay({
  name_en = '',
  name_th = '',
  treatment_code = '',
  price_thb = null,
  sessions_included = 1,
  mask_included = 0,
  fallback_name = '',
} = {}) {
  const name = resolveCanonicalTreatmentName({
    name_en,
    name_th,
    treatment_code,
    fallback_name,
  });

  const sessionsRaw = toNonNegativeInt(sessions_included, 1);
  const sessions = sessionsRaw > 0 ? sessionsRaw : 1;
  const mask = toNonNegativeInt(mask_included, 0) || 0;
  const price = toNonNegativeInt(price_thb, null);
  const priceText = Number.isFinite(price) && price > 0 ? ` (${price})` : '';

  if (sessions <= 1 && mask <= 0) {
    return `${name}${priceText}`;
  }

  return `${sessions}x ${name}${priceText} | Mask ${mask}`;
}

export {
  formatTreatmentDisplay,
  normalizeText,
  resolveCanonicalTreatmentName,
  toNonNegativeInt,
};
