const AUTOMATIC_QUANTITY_RULE_VERSION = "same-sku-explicit-unit-anchor-v1";
const MAX_AUTOMATIC_UNITS_PER_SALE = 100;

const PACKAGING_UNIT_ALIASES = new Map([
  ["กล่อง", "box"],
  ["ซอง", "sachet"],
  ["กระป๋อง", "can"],
  ["กระปุก", "jar"],
  ["ก้อน", "bar"],
  ["แพ็ค", "pack"],
  ["แพ๊ค", "pack"],
  ["แพค", "pack"],
  ["ชิ้น", "piece"],
  ["แผง", "blister"],
  ["bx", "box"],
  ["box", "box"],
  ["boxes", "box"],
  ["pack", "pack"],
  ["packs", "pack"],
  ["pcs", "piece"],
]);

const PACKAGING_QUANTITY_PATTERN = /(\d+)(?:\s*\+\s*(\d+))?\s*(กล่อง|ซอง|กระป๋อง|กระปุก|ก้อน|แพ็ค|แพ๊ค|แพค|ชิ้น|แผง|bx|boxes?|packs?|pcs)/giu;

function normalizeQuantityText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\u00a0/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function extractPackagingQuantities(value) {
  const quantitiesByUnit = new Map();
  const text = normalizeQuantityText(value);
  const matcher = new RegExp(
    PACKAGING_QUANTITY_PATTERN.source,
    PACKAGING_QUANTITY_PATTERN.flags,
  );

  for (const match of text.matchAll(matcher)) {
    const baseQuantity = Number(match[1]);
    const bonusQuantity = match[2] ? Number(match[2]) : 0;
    const quantity = baseQuantity + bonusQuantity;
    const unit = PACKAGING_UNIT_ALIASES.get(match[3]);
    if (!unit || !Number.isSafeInteger(quantity) || quantity <= 0) continue;
    const quantities = quantitiesByUnit.get(unit) || new Set();
    quantities.add(quantity);
    quantitiesByUnit.set(unit, quantities);
  }

  return quantitiesByUnit;
}

function packagingQuantitiesForRecord(record) {
  const variantQuantities = extractPackagingQuantities(record?.variant);
  if (variantQuantities.size) return variantQuantities;
  return extractPackagingQuantities(record?.productName);
}

function matchedSkuGroupKey(record) {
  return JSON.stringify([
    String(record?.shopCode || "").trim().toLowerCase(),
    String(record?.match?.companySku || "").trim().toUpperCase(),
  ]);
}

function hasExplicitUnitAnchor(records, targetRecord, unit) {
  return records.some((record) => (
    record !== targetRecord
    && packagingQuantitiesForRecord(record).get(unit)?.has(1)
  ));
}

function buildGroupQuantityProfile(records) {
  const profile = new Map();
  records.forEach((record) => {
    packagingQuantitiesForRecord(record).forEach((quantities, unit) => {
      const groupQuantities = profile.get(unit) || new Set();
      quantities.forEach((quantity) => groupQuantities.add(quantity));
      profile.set(unit, groupQuantities);
    });
  });
  return profile;
}

function buildAutomaticQuantityRules(records = []) {
  const matchedGroups = new Map();
  records.forEach((record) => {
    if (record?.match?.status !== "matched" || !record?.match?.companySku) return;
    const key = matchedSkuGroupKey(record);
    const group = matchedGroups.get(key) || [];
    group.push(record);
    matchedGroups.set(key, group);
  });

  const rules = new Map();
  matchedGroups.forEach((group) => {
    if (group.length < 2) return;
    const groupProfile = buildGroupQuantityProfile(group);

    group.forEach((record) => {
      const recordQuantities = packagingQuantitiesForRecord(record);
      const verifiedCandidates = [];

      recordQuantities.forEach((quantities, unit) => {
        if (quantities.size !== 1) return;
        const [quantityPerSale] = quantities;
        if (
          quantityPerSale <= 1
          || quantityPerSale > MAX_AUTOMATIC_UNITS_PER_SALE
          || !hasExplicitUnitAnchor(group, record, unit)
        ) return;
        verifiedCandidates.push({ quantityPerSale, quantityUnit: unit });
      });

      if (verifiedCandidates.length === 1) {
        rules.set(record, Object.freeze({
          isMultipack: true,
          quantityPerSale: verifiedCandidates[0].quantityPerSale,
          quantityRuleSource: "catalog_same_sku_explicit_unit_anchor",
          quantityRuleStatus: "verified",
          quantityUnit: verifiedCandidates[0].quantityUnit,
        }));
        return;
      }

      const hasUnanchoredPackVariation = [...recordQuantities.entries()].some(([unit, quantities]) => (
        [...quantities].some((quantity) => quantity > 1)
        && (groupProfile.get(unit)?.size || 0) > 1
      ));
      if (verifiedCandidates.length > 1 || hasUnanchoredPackVariation) {
        rules.set(record, Object.freeze({
          isMultipack: true,
          quantityRuleSource: verifiedCandidates.length > 1
            ? "catalog_same_sku_multiple_unit_anchors"
            : "catalog_same_sku_missing_unit_anchor",
          quantityRuleStatus: "requires_validation",
        }));
      }
    });
  });

  return rules;
}

module.exports = {
  AUTOMATIC_QUANTITY_RULE_VERSION,
  MAX_AUTOMATIC_UNITS_PER_SALE,
  buildAutomaticQuantityRules,
  extractPackagingQuantities,
  normalizeQuantityText,
  packagingQuantitiesForRecord,
};
