const pool = require("../../../../db");
const { getTables } = require("../tables");
const {
  DEFAULT_USER_FINANCIAL_VISIBILITY,
  normalizeUserFinancialVisibility,
} = require("../services/shopeeFinancialVisibilityService");

function mapSettings(row) {
  if (!row) {
    return {
      ...DEFAULT_USER_FINANCIAL_VISIBILITY,
      updatedAt: null,
      updatedBy: "",
    };
  }
  return {
    ...normalizeUserFinancialVisibility({
      shippingFee: row.user_can_view_shipping_fee,
      totalAmount: row.user_can_view_total_amount,
      unitPrice: row.user_can_view_unit_price,
    }),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    updatedBy: String(row.updated_by || ""),
  };
}

async function getUserFinancialVisibility() {
  const tables = getTables();
  const result = await pool.query(
    `
      SELECT
        user_can_view_unit_price,
        user_can_view_shipping_fee,
        user_can_view_total_amount,
        updated_at,
        updated_by
      FROM ${tables.shopeeFinancialVisibilitySettings}
      WHERE setting_key = 'user'
      LIMIT 1
    `,
  );
  return mapSettings(result.rows[0]);
}

async function updateUserFinancialVisibility(settings, updatedBy) {
  const tables = getTables();
  const normalized = normalizeUserFinancialVisibility(settings);
  const actor = String(updatedBy || "admin").normalize("NFKC").trim().slice(0, 200) || "admin";
  const result = await pool.query(
    `
      INSERT INTO ${tables.shopeeFinancialVisibilitySettings} (
        setting_key,
        user_can_view_unit_price,
        user_can_view_shipping_fee,
        user_can_view_total_amount,
        updated_at,
        updated_by
      ) VALUES ('user', $1, $2, $3, now(), $4)
      ON CONFLICT (setting_key) DO UPDATE SET
        user_can_view_unit_price = EXCLUDED.user_can_view_unit_price,
        user_can_view_shipping_fee = EXCLUDED.user_can_view_shipping_fee,
        user_can_view_total_amount = EXCLUDED.user_can_view_total_amount,
        updated_at = now(),
        updated_by = EXCLUDED.updated_by
      RETURNING
        user_can_view_unit_price,
        user_can_view_shipping_fee,
        user_can_view_total_amount,
        updated_at,
        updated_by
    `,
    [normalized.unitPrice, normalized.shippingFee, normalized.totalAmount, actor],
  );
  return mapSettings(result.rows[0]);
}

module.exports = {
  getUserFinancialVisibility,
  mapSettings,
  updateUserFinancialVisibility,
};
