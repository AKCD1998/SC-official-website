const { badRequest } = require("../errors");

const SHOPEE_SHOP_PROFILES = Object.freeze({
  "sc-drug-store": Object.freeze({
    code: "sc-drug-store",
    displayName: "SC Drug Store",
    outputSlug: "sc-drug-store",
  }),
  "dr-morepen": Object.freeze({
    code: "dr-morepen",
    displayName: "DR.Morepen",
    outputSlug: "dr-morepen",
  }),
});

const SHOPEE_ALL_SHOPS_SCOPE = "all";

const SHOP_CODE_ALIASES = Object.freeze({
  "sc-drug-store": "sc-drug-store",
  "sc-drugstore": "sc-drug-store",
  scdrugstore: "sc-drug-store",
  "dr-morepen": "dr-morepen",
  drmorepen: "dr-morepen",
});

function normalizeShopeeShopCode(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");

  return SHOP_CODE_ALIASES[normalized] || "";
}

function getShopeeShopProfile(value) {
  const shopCode = normalizeShopeeShopCode(value);
  return shopCode ? SHOPEE_SHOP_PROFILES[shopCode] : null;
}

function normalizeShopeeShopScope(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === SHOPEE_ALL_SHOPS_SCOPE) return SHOPEE_ALL_SHOPS_SCOPE;
  return normalizeShopeeShopCode(value);
}

function requireShopeeShopCode(value) {
  if (!String(value || "").trim()) {
    throw badRequest("กรุณาเลือกร้าน Shopee", {
      code: "SHOPEE_SHOP_REQUIRED",
      supportedShopCodes: Object.keys(SHOPEE_SHOP_PROFILES),
    });
  }

  const profile = getShopeeShopProfile(value);
  if (!profile) {
    throw badRequest("ร้าน Shopee ที่เลือกไม่รองรับ", {
      code: "SHOPEE_SHOP_UNSUPPORTED",
      shopCode: value,
      supportedShopCodes: Object.keys(SHOPEE_SHOP_PROFILES),
    });
  }

  return profile.code;
}

function requireShopeeShopScope(value) {
  if (!String(value || "").trim()) {
    throw badRequest("กรุณาเลือกร้าน Shopee", {
      code: "SHOPEE_SHOP_REQUIRED",
      supportedShopCodes: Object.keys(SHOPEE_SHOP_PROFILES),
      supportedShopScopes: [SHOPEE_ALL_SHOPS_SCOPE, ...Object.keys(SHOPEE_SHOP_PROFILES)],
    });
  }

  const scope = normalizeShopeeShopScope(value);
  if (!scope) {
    throw badRequest("ร้าน Shopee ที่เลือกไม่รองรับ", {
      code: "SHOPEE_SHOP_UNSUPPORTED",
      shopCode: value,
      supportedShopCodes: Object.keys(SHOPEE_SHOP_PROFILES),
      supportedShopScopes: [SHOPEE_ALL_SHOPS_SCOPE, ...Object.keys(SHOPEE_SHOP_PROFILES)],
    });
  }

  return scope;
}

module.exports = {
  SHOPEE_ALL_SHOPS_SCOPE,
  SHOPEE_SHOP_PROFILES,
  getShopeeShopProfile,
  normalizeShopeeShopCode,
  normalizeShopeeShopScope,
  requireShopeeShopCode,
  requireShopeeShopScope,
};
