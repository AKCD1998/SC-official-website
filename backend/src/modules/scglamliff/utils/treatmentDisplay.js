import {
  formatTreatmentDisplay as formatCatalogTreatmentDisplay,
  normalizeText,
  resolveCanonicalTreatmentName,
  toNonNegativeInt,
} from './formatTreatmentDisplay.js';

function formatTreatmentDisplay({
  treatmentName = '',
  treatmentNameEn = '',
  treatmentNameTh = '',
  treatmentCode = '',
  treatmentSessions = 1,
  treatmentMask = 0,
  treatmentPrice = null,
  name_en = '',
  name_th = '',
  treatment_code = '',
  sessions_included = 1,
  mask_included = 0,
  price_thb = null,
} = {}) {
  const nameEn = normalizeText(treatmentNameEn || name_en || treatmentName);
  const nameTh = normalizeText(treatmentNameTh || name_th);
  const code = normalizeText(treatmentCode || treatment_code);

  return formatCatalogTreatmentDisplay({
    name_en: nameEn,
    name_th: nameTh,
    treatment_code: code,
    sessions_included:
      treatmentSessions !== undefined && treatmentSessions !== null
        ? treatmentSessions
        : sessions_included,
    mask_included: treatmentMask !== undefined && treatmentMask !== null ? treatmentMask : mask_included,
    price_thb: treatmentPrice !== undefined && treatmentPrice !== null ? treatmentPrice : price_thb,
    fallback_name: treatmentName,
  });
}

function parseLegacyTreatmentText(text, { fallbackName = '', fallbackCode = '' } = {}) {
  const raw = normalizeText(text);
  if (!raw) return null;
  const lowered = raw.toLowerCase();

  let sessions = null;
  let mask = null;
  let price = null;

  const slashSessions = lowered.match(/\b\d+\s*\/\s*(\d+)\b/);
  if (slashSessions) {
    sessions = toNonNegativeInt(slashSessions[1], null);
  }
  if (!Number.isFinite(sessions)) {
    const xSessions = lowered.match(/\b(\d+)\s*x\b/);
    if (xSessions) sessions = toNonNegativeInt(xSessions[1], null);
  }
  if (!Number.isFinite(sessions)) {
    const sessionWord = lowered.match(/\b(\d+)\s*(sessions|session|ครั้ง)\b/);
    if (sessionWord) sessions = toNonNegativeInt(sessionWord[1], null);
  }

  const maskPair = lowered.match(/mask\s*(\d+)\s*\/\s*(\d+)/);
  if (maskPair) {
    mask = toNonNegativeInt(maskPair[2], null);
  }
  if (!Number.isFinite(mask)) {
    const maskSingle = lowered.match(/mask\s*(\d+)/);
    if (maskSingle) mask = toNonNegativeInt(maskSingle[1], null);
  }
  if (!Number.isFinite(mask)) {
    const reverseMask = lowered.match(/\b(\d+)\s*mask\b/);
    if (reverseMask) mask = toNonNegativeInt(reverseMask[1], null);
  }

  const parenPrice = lowered.match(/\((\d{2,6})\)/);
  if (parenPrice) {
    price = toNonNegativeInt(parenPrice[1], null);
  }
  if (!Number.isFinite(price)) {
    const numbers = [...lowered.matchAll(/\b(\d{2,6})\b/g)]
      .map((entry) => toNonNegativeInt(entry[1], null))
      .filter((value) => Number.isFinite(value));

    const candidates = numbers.filter((value) => value > 20 && value !== sessions && value !== mask);
    if (candidates.length > 0) {
      price = Math.max(...candidates);
    } else if (numbers.length === 1 && numbers[0] > 20) {
      price = numbers[0];
    }
  }

  const thaiSmoothRegex = /บำบัดผิวใส|เรียบเนียน/;
  let treatmentName = '';
  if (lowered.includes('smooth') || thaiSmoothRegex.test(raw)) {
    treatmentName = 'Smooth';
  } else {
    const words = raw
      .split(/[^A-Za-z\u0E00-\u0E7F]+/g)
      .map((word) => normalizeText(word))
      .filter(Boolean)
      .filter((word) => {
        const l = word.toLowerCase();
        return l !== 'mask' && l !== 'thb' && l !== 'บาท' && l !== 'free';
      });

    if (words.length > 0) {
      treatmentName = words.slice(0, 3).join(' ');
    }
  }

  const resolvedName = resolveCanonicalTreatmentName({
    name_en: treatmentName,
    name_th: fallbackName,
    treatment_code: fallbackCode,
    fallback_name: fallbackName,
  });
  const resolvedSessions = Number.isFinite(sessions) && sessions > 0 ? sessions : 1;
  const resolvedMask = Number.isFinite(mask) && mask >= 0 ? mask : 0;
  const resolvedPrice = Number.isFinite(price) ? price : null;

  return {
    treatment_name: resolvedName,
    treatment_sessions: resolvedSessions,
    treatment_mask: resolvedMask,
    treatment_price: resolvedPrice,
    treatment_display: formatTreatmentDisplay({
      treatmentName: resolvedName,
      treatmentCode: fallbackCode,
      treatmentSessions: resolvedSessions,
      treatmentMask: resolvedMask,
      treatmentPrice: resolvedPrice,
    }),
  };
}

function resolveTreatmentDisplay({
  treatmentId = '',
  treatmentName = '',
  treatmentNameEn = '',
  treatmentNameTh = '',
  treatmentCode = '',
  treatmentSessions = 1,
  treatmentMask = 0,
  treatmentPrice = null,
  legacyText = '',
} = {}) {
  const hasCatalogId = Boolean(normalizeText(treatmentId));
  const parsedLegacy = parseLegacyTreatmentText(legacyText, {
    fallbackName: treatmentName,
    fallbackCode: treatmentCode,
  });

  if (hasCatalogId) {
    const catalogSessions = toNonNegativeInt(treatmentSessions, null);
    const catalogMask = toNonNegativeInt(treatmentMask, null);
    const catalogPrice = toNonNegativeInt(treatmentPrice, null);
    const hasCatalogMetadata =
      Number.isFinite(catalogSessions) || Number.isFinite(catalogMask) || Number.isFinite(catalogPrice);

    const resolvedName = resolveCanonicalTreatmentName({
      name_en: treatmentNameEn || treatmentName,
      name_th: treatmentNameTh,
      treatment_code: treatmentCode,
      fallback_name: treatmentName,
    });
    const sessionsRaw = Number.isFinite(catalogSessions)
      ? catalogSessions
      : parsedLegacy?.treatment_sessions ?? 1;
    const sessions = sessionsRaw > 0 ? sessionsRaw : 1;
    const mask = Number.isFinite(catalogMask)
      ? catalogMask
      : parsedLegacy?.treatment_mask ?? 0;
    const price = Number.isFinite(catalogPrice)
      ? catalogPrice
      : parsedLegacy?.treatment_price ?? null;

    return {
      treatment_name: resolvedName,
      treatment_sessions: sessions,
      treatment_mask: mask,
      treatment_price: Number.isFinite(price) ? price : null,
      treatment_display: formatTreatmentDisplay({
        treatmentName: resolvedName,
        treatmentCode,
        treatmentSessions: sessions,
        treatmentMask: mask,
        treatmentPrice: price,
      }),
      treatment_display_source: hasCatalogMetadata
        ? 'catalog'
        : parsedLegacy
          ? 'catalog_with_legacy_defaults'
          : 'catalog_name_only',
    };
  }

  if (parsedLegacy) {
    return {
      ...parsedLegacy,
      treatment_display_source: 'legacy_text',
    };
  }

  const fallbackName = resolveCanonicalTreatmentName({
    name_en: treatmentName,
    name_th: '',
    treatment_code: treatmentCode,
    fallback_name: treatmentName,
  });
  return {
    treatment_name: fallbackName,
    treatment_sessions: 1,
    treatment_mask: 0,
    treatment_price: null,
    treatment_display: fallbackName,
    treatment_display_source: 'legacy_text',
  };
}

export {
  formatTreatmentDisplay,
  parseLegacyTreatmentText,
  resolveTreatmentDisplay,
  normalizeText,
};
