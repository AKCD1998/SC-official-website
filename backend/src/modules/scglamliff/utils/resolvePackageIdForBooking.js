function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

export function inferSmoothPackageHint(raw) {
  const text = normalizeText(raw).toLowerCase();
  if (!text || !text.includes('smooth')) return null;

  // Accept both progress-like strings (1/3) and descriptive strings (3 sessions / 3x).
  const sessionProgressMatch = text.match(/(\d+)\s*\/\s*(\d+)/);
  let sessionsTotal = sessionProgressMatch ? Number(sessionProgressMatch[2]) : 1;
  if (!sessionProgressMatch) {
    const sessionTextMatch = text.match(/\b(\d+)\s*(?:x|sessions?)\b/);
    if (sessionTextMatch) {
      const parsed = Number(sessionTextMatch[1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        sessionsTotal = parsed;
      }
    }
  }
  if (!Number.isFinite(sessionsTotal) || sessionsTotal <= 0) return null;

  const priceCandidates = [...text.matchAll(/\b(\d{3,4})\b/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value >= 100);
  const price = priceCandidates.length > 0 ? priceCandidates[0] : null;

  let maskTotal = 0;
  const maskProgressMatch = text.match(/(\d+)\s*\/\s*(\d+)\s*mask/);
  if (maskProgressMatch) {
    const total = Number(maskProgressMatch[2]);
    if (Number.isFinite(total) && total >= 0) {
      maskTotal = total;
    }
  } else {
    const maskMatch = text.match(/\b(\d+)\s*mask\b/) || text.match(/\bmask\s*(\d+)\b/);
    if (maskMatch) {
      const total = Number(maskMatch[1]);
      if (Number.isFinite(total) && total >= 0) {
        maskTotal = total;
      }
    }
  }

  return { sessionsTotal, price, maskTotal };
}

export function isPackageStyleTreatmentText(raw) {
  const hint = inferSmoothPackageHint(raw);
  if (!hint) return false;
  return Number(hint.sessionsTotal) > 1 || Number(hint.maskTotal) > 0;
}

export async function resolvePackageIdForBooking(client, { explicitPackageId, treatmentItemText }) {
  const packageId = normalizeText(explicitPackageId);
  if (packageId) {
    const pkg = await client.query('SELECT id FROM packages WHERE id = $1 LIMIT 1', [packageId]);
    if (pkg.rowCount === 0) {
      const err = new Error('Package not found');
      err.status = 400;
      throw err;
    }
    return packageId;
  }

  const hint = inferSmoothPackageHint(treatmentItemText);
  if (!hint) return null;

  const { sessionsTotal, price, maskTotal } = hint;

  if (price) {
    const packageCode = `SMOOTH_C${sessionsTotal}_${price}_M${maskTotal}`;
    const byCode = await client.query(
      "SELECT id FROM packages WHERE UPPER(COALESCE(code, '')) = UPPER($1) LIMIT 1",
      [packageCode]
    );
    if (byCode.rowCount > 0) return byCode.rows[0].id;
  }

  const params = [sessionsTotal];
  const whereParts = ["LOWER(COALESCE(code, '')) LIKE 'smooth%'", 'COALESCE(sessions_total, 0) = $1'];

  if (price) {
    params.push(price);
    whereParts.push(`COALESCE(price_thb, 0) = $${params.length}`);
  }

  if (sessionsTotal > 1) {
    params.push(maskTotal);
    whereParts.push(`COALESCE(mask_total, 0) = $${params.length}`);
  }

  const fallback = await client.query(
    `
      SELECT id
      FROM packages
      WHERE ${whereParts.join(' AND ')}
      ORDER BY price_thb ASC NULLS LAST, id ASC
      LIMIT 1
    `,
    params
  );

  return fallback.rowCount > 0 ? fallback.rows[0].id : null;
}
