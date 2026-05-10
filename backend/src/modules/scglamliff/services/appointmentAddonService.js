import {
  APPOINTMENT_ADDON_CODE_INCLUDED_MASK,
  APPOINTMENT_ADDON_KIND_PACKAGE_MASK_INCLUDED,
  buildAppointmentAddonLabel,
  getAppointmentAddonOption,
  isPackageMaskIncludedAddonCode,
  normalizeAppointmentAddonCode,
} from "../shared/appointmentAddonCatalog.js";

function normalizeText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function toInt(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function buildAddonError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function buildAppointmentAddonSnapshot(row) {
  if (!row) return null;
  const option = getAppointmentAddonOption(row.topping_code);
  return {
    id: normalizeText(row.id) || null,
    appointment_id: normalizeText(row.appointment_id) || null,
    topping_code: normalizeText(row.topping_code),
    addon_kind: normalizeText(row.addon_kind),
    amount_thb: toInt(row.amount_thb),
    customer_package_id: normalizeText(row.customer_package_id) || null,
    package_mask_deducted: Boolean(row.package_mask_deducted),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    title_th: normalizeText(row.title_th) || option?.title_th || "",
    title_en: normalizeText(row.title_en) || option?.title_en || "",
    category: normalizeText(row.category) || option?.category || "",
    label: option
      ? buildAppointmentAddonLabel(option, { locale: "th" })
      : normalizeText(row.title_th) || normalizeText(row.topping_code),
  };
}

export function resolveRequestedAppointmentAddonCode({
  appointmentAddonCode = "",
  usedMask = false,
  deductMask = null,
} = {}) {
  const explicitCode = normalizeAppointmentAddonCode(appointmentAddonCode);
  if (explicitCode) {
    const option = getAppointmentAddonOption(explicitCode);
    if (!option) {
      throw buildAddonError("Unsupported appointment_addon_code", 400);
    }

    const parsedDeductMask = deductMask === null || deductMask === undefined ? null : Number(deductMask);
    if (
      option.kind !== APPOINTMENT_ADDON_KIND_PACKAGE_MASK_INCLUDED &&
      (usedMask || parsedDeductMask === 1)
    ) {
      throw buildAddonError(
        "Paid appointment_addon_code cannot be combined with used_mask/deduct_mask",
        400
      );
    }

    return explicitCode;
  }

  const parsedDeductMask = deductMask === null || deductMask === undefined ? null : Number(deductMask);
  if (usedMask || parsedDeductMask === 1) {
    return APPOINTMENT_ADDON_CODE_INCLUDED_MASK;
  }

  return "";
}

export function getAppointmentAddonDeductMask(addonCode) {
  return isPackageMaskIncludedAddonCode(addonCode) ? 1 : 0;
}

export async function getAppointmentAddonByAppointmentId(
  client,
  appointmentId,
  { forUpdate = false } = {}
) {
  const lockClause = forUpdate ? " FOR UPDATE OF aa" : "";
  const result = await client.query(
    `
      SELECT
        aa.id,
        aa.appointment_id,
        aa.topping_code,
        aa.addon_kind,
        aa.amount_thb,
        aa.customer_package_id,
        aa.package_mask_deducted,
        aa.created_at,
        aa.updated_at,
        COALESCE(t.title_th, '') AS title_th,
        COALESCE(t.title_en, '') AS title_en,
        COALESCE(t.category, '') AS category
      FROM appointment_addons aa
      LEFT JOIN toppings t ON t.code = aa.topping_code
      WHERE aa.appointment_id = $1
      LIMIT 1
      ${lockClause}
    `,
    [appointmentId]
  );

  return buildAppointmentAddonSnapshot(result.rows[0] || null);
}

async function ensureToppingExistsForAddonCode(client, addonCode) {
  const result = await client.query(
    `
      SELECT code
      FROM toppings
      WHERE code = $1
      LIMIT 1
    `,
    [addonCode]
  );

  if (result.rowCount === 0) {
    throw buildAddonError(
      `Appointment addon catalog is missing topping code: ${addonCode}`,
      500
    );
  }
}

export async function upsertAppointmentAddonSelection(
  client,
  { appointmentId, addonCode, customerPackageId = "" }
) {
  const normalizedAddonCode = normalizeAppointmentAddonCode(addonCode);
  if (!normalizedAddonCode) {
    throw buildAddonError("Missing appointment_addon_code", 400);
  }

  const option = getAppointmentAddonOption(normalizedAddonCode);
  if (!option) {
    throw buildAddonError("Unsupported appointment_addon_code", 400);
  }

  await ensureToppingExistsForAddonCode(client, normalizedAddonCode);

  const normalizedCustomerPackageId = normalizeText(customerPackageId);
  const addonKind = option.kind;
  const packageMaskDeducted = addonKind === APPOINTMENT_ADDON_KIND_PACKAGE_MASK_INCLUDED;
  if (packageMaskDeducted && !normalizedCustomerPackageId) {
    throw buildAddonError(
      "customer_package_id is required for included package mask addon",
      422
    );
  }

  const amountThb = toInt(option.price_thb);
  await client.query(
    `
      INSERT INTO appointment_addons (
        id,
        appointment_id,
        topping_code,
        addon_kind,
        amount_thb,
        customer_package_id,
        package_mask_deducted,
        created_at,
        updated_at
      )
      VALUES (
        gen_random_uuid(),
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        now(),
        now()
      )
      ON CONFLICT (appointment_id)
      DO UPDATE SET
        topping_code = EXCLUDED.topping_code,
        addon_kind = EXCLUDED.addon_kind,
        amount_thb = EXCLUDED.amount_thb,
        customer_package_id = EXCLUDED.customer_package_id,
        package_mask_deducted = EXCLUDED.package_mask_deducted,
        updated_at = now()
    `,
    [
      appointmentId,
      normalizedAddonCode,
      addonKind,
      amountThb,
      normalizedCustomerPackageId || null,
      packageMaskDeducted,
    ]
  );

  await client.query(
    `
      UPDATE appointments
      SET selected_toppings = $2::jsonb,
          addons_total_thb = $3,
          updated_at = now()
      WHERE id = $1
    `,
    [appointmentId, JSON.stringify([normalizedAddonCode]), amountThb]
  );

  return getAppointmentAddonByAppointmentId(client, appointmentId, { forUpdate: false });
}

export async function clearAppointmentAddonSelection(client, appointmentId) {
  const existing = await getAppointmentAddonByAppointmentId(client, appointmentId, {
    forUpdate: true,
  });

  await client.query(
    `
      DELETE FROM appointment_addons
      WHERE appointment_id = $1
    `,
    [appointmentId]
  );

  await client.query(
    `
      UPDATE appointments
      SET selected_toppings = '[]'::jsonb,
          addons_total_thb = 0,
          updated_at = now()
      WHERE id = $1
    `,
    [appointmentId]
  );

  return {
    deleted: Boolean(existing),
    addon: existing,
  };
}
