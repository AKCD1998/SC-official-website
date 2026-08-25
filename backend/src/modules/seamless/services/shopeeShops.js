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

function requireShopeeShopCode(value) {
  if (!String(value || "").trim()) {
    throw badRequest("กรุณาเลือกร้าน Shopee ก่อนอัปโหลดไฟล์", {
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

module.exports = {
  SHOPEE_SHOP_PROFILES,
  getShopeeShopProfile,
  normalizeShopeeShopCode,
  requireShopeeShopCode,
};
