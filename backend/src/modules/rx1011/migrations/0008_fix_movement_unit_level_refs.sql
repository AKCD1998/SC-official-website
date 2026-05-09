\set ON_ERROR_STOP on
BEGIN;

-- 0008_fix_movement_unit_level_refs.sql
-- Purpose:
-- - Keep Products page (SELLABLE unit) and Receiving movement history labels consistent.
-- - Re-point stock_movements.unit_level_id to SELLABLE only when structural equivalence is proven.
-- - If equivalence is not proven, do NOT rewrite movement history; attempt safe Thai label repair only.
--
-- Safety:
-- - Targeted product list is explicit (start with IC-002604, extend by adding rows).
-- - Every UPDATE has a preceding COUNT(*) with the same WHERE clause.
-- - Runs in a single transaction and does not delete data.

CREATE TEMP TABLE tmp_target_products (
  product_code text PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO tmp_target_products (product_code)
VALUES
  ('IC-002604');

-- SELLABLE picker mirrors productsController ordering:
-- ORDER BY is_sellable DESC, is_base DESC, sort_order ASC, created_at ASC LIMIT 1
CREATE TEMP TABLE tmp_sellable_pick ON COMMIT DROP AS
SELECT
  tp.product_code,
  p.id AS product_id,
  picked.id AS sellable_unit_level_id,
  picked.code AS sellable_code,
  picked.display_name AS sellable_display_name,
  picked.unit_key AS sellable_unit_key,
  picked.unit_type_id AS sellable_unit_type_id
FROM tmp_target_products tp
JOIN products p
  ON p.product_code = tp.product_code
JOIN LATERAL (
  SELECT pul.*
  FROM product_unit_levels pul
  WHERE pul.product_id = p.id
  ORDER BY pul.is_sellable DESC, pul.is_base DESC, pul.sort_order ASC, pul.created_at ASC
  LIMIT 1
) picked ON true;

SELECT COUNT(*) AS dry_run_target_products_resolved
FROM tmp_sellable_pick;

SELECT
  product_code,
  product_id,
  sellable_unit_level_id,
  sellable_code,
  sellable_display_name,
  sellable_unit_key
FROM tmp_sellable_pick
ORDER BY product_code;

-- Distinct movement-referenced unit levels that differ from SELLABLE.
CREATE TEMP TABLE tmp_legacy_refs ON COMMIT DROP AS
WITH distinct_refs AS (
  SELECT DISTINCT
    s.product_code,
    s.product_id,
    s.sellable_unit_level_id,
    s.sellable_display_name,
    s.sellable_unit_key,
    s.sellable_unit_type_id,
    sm.unit_level_id AS legacy_unit_level_id
  FROM tmp_sellable_pick s
  JOIN stock_movements sm
    ON sm.product_id = s.product_id
  WHERE sm.unit_level_id <> s.sellable_unit_level_id
)
SELECT
  dr.product_code,
  dr.product_id,
  dr.sellable_unit_level_id,
  dr.sellable_display_name,
  dr.sellable_unit_key,
  dr.sellable_unit_type_id,
  pul.id AS legacy_unit_level_id,
  pul.code AS legacy_code,
  pul.display_name AS legacy_display_name,
  pul.unit_key AS legacy_unit_key,
  pul.unit_type_id AS legacy_unit_type_id,
  ut_legacy.name_th AS legacy_unit_name_th,
  ut_legacy.name_en AS legacy_unit_name_en,
  ut_sell.name_th AS sellable_unit_name_th,
  ut_sell.name_en AS sellable_unit_name_en,
  (
    pul.unit_key IS NOT NULL
    AND dr.sellable_unit_key IS NOT NULL
    AND pul.unit_key = dr.sellable_unit_key
  ) AS equivalent_by_unit_key,
  (regexp_match(pul.unit_key, 'qpp=([^|]+)'))[1] AS qpp_text
FROM distinct_refs dr
JOIN product_unit_levels pul
  ON pul.id = dr.legacy_unit_level_id
LEFT JOIN unit_types ut_legacy
  ON ut_legacy.id = pul.unit_type_id
LEFT JOIN unit_types ut_sell
  ON ut_sell.id = dr.sellable_unit_type_id;

SELECT COUNT(*) AS dry_run_distinct_legacy_refs
FROM tmp_legacy_refs;

SELECT
  product_code,
  legacy_unit_level_id,
  legacy_code,
  legacy_display_name,
  legacy_unit_key,
  sellable_unit_level_id,
  sellable_display_name,
  sellable_unit_key,
  equivalent_by_unit_key
FROM tmp_legacy_refs
ORDER BY product_code, legacy_code;

-- -------------------------------
-- UPDATE #1: Re-point movement refs ONLY when equivalent_by_unit_key = true
-- -------------------------------
SELECT COUNT(*) AS dry_run_movement_repoint_count
FROM stock_movements sm
JOIN tmp_legacy_refs lr
  ON sm.product_id = lr.product_id
 AND sm.unit_level_id = lr.legacy_unit_level_id
WHERE lr.equivalent_by_unit_key = true;

UPDATE stock_movements sm
SET unit_level_id = lr.sellable_unit_level_id
FROM tmp_legacy_refs lr
WHERE sm.product_id = lr.product_id
  AND sm.unit_level_id = lr.legacy_unit_level_id
  AND lr.equivalent_by_unit_key = true;

SELECT COUNT(*) AS post_update_remaining_equivalent_refs
FROM stock_movements sm
JOIN tmp_legacy_refs lr
  ON sm.product_id = lr.product_id
 AND sm.unit_level_id = lr.legacy_unit_level_id
WHERE lr.equivalent_by_unit_key = true;

-- Prepare safe Thai label updates for non-equivalent refs only.
-- We only update if:
-- - both legacy and SELLABLE Thai unit names exist and are not corrupted
-- - qpp can be parsed from unit_key
-- - current label is fallback/corrupted (avoid overwriting good labels)
CREATE TEMP TABLE tmp_safe_label_updates ON COMMIT DROP AS
SELECT
  lr.product_code,
  lr.legacy_unit_level_id,
  format(
    '1 %s = %s %s',
    lr.legacy_unit_name_th,
    COALESCE(
      NULLIF(
        regexp_replace(
          regexp_replace((NULLIF(lr.qpp_text, '')::numeric)::text, E'(\\.\\d*?)0+$', E'\\1'),
          E'\\.$',
          ''
        ),
        ''
      ),
      '1'
    ),
    lr.sellable_unit_name_th
  ) AS inferred_display_name
FROM tmp_legacy_refs lr
WHERE lr.equivalent_by_unit_key = false
  AND COALESCE(lr.legacy_unit_name_th, '') <> ''
  AND COALESCE(lr.sellable_unit_name_th, '') <> ''
  AND lr.legacy_unit_name_th NOT LIKE '%?%'
  AND lr.sellable_unit_name_th NOT LIKE '%?%'
  AND NULLIF(lr.qpp_text, '') IS NOT NULL
  AND (
    lr.legacy_display_name IS NULL
    OR btrim(lr.legacy_display_name) = ''
    OR lr.legacy_display_name LIKE '%?%'
    OR lr.legacy_display_name ILIKE '1 unit = % base'
  );

-- -------------------------------
-- UPDATE #2: Repair legacy display_name only when safe inference is possible
-- -------------------------------
SELECT COUNT(*) AS dry_run_safe_label_update_count
FROM product_unit_levels pul
JOIN tmp_safe_label_updates slu
  ON pul.id = slu.legacy_unit_level_id
WHERE pul.display_name IS DISTINCT FROM slu.inferred_display_name;

UPDATE product_unit_levels pul
SET display_name = slu.inferred_display_name
FROM tmp_safe_label_updates slu
WHERE pul.id = slu.legacy_unit_level_id
  AND pul.display_name IS DISTINCT FROM slu.inferred_display_name;

SELECT COUNT(*) AS post_update_remaining_safe_label_rows
FROM product_unit_levels pul
JOIN tmp_safe_label_updates slu
  ON pul.id = slu.legacy_unit_level_id
WHERE pul.display_name IS DISTINCT FROM slu.inferred_display_name;

-- Report rows that still need manual label curation.
SELECT
  lr.product_code,
  lr.legacy_unit_level_id,
  lr.legacy_code,
  lr.legacy_display_name,
  lr.legacy_unit_name_th,
  lr.sellable_unit_name_th,
  'manual label needed (not equivalent or Thai inference unavailable)' AS note
FROM tmp_legacy_refs lr
LEFT JOIN tmp_safe_label_updates slu
  ON slu.legacy_unit_level_id = lr.legacy_unit_level_id
WHERE lr.equivalent_by_unit_key = false
  AND slu.legacy_unit_level_id IS NULL
ORDER BY lr.product_code, lr.legacy_code;

-- ---------------------------------------
-- Verification section
-- ---------------------------------------
SELECT
  p.product_code,
  sm.id AS movement_id,
  sm.occurred_at,
  sm.quantity,
  pul.id AS movement_unit_level_id,
  COALESCE(NULLIF(trim(pul.display_name), ''), pul.code, 'unit') AS movement_unit_label,
  sp.sellable_unit_level_id,
  sp.sellable_display_name AS sellable_label,
  (pul.id = sp.sellable_unit_level_id) AS movement_points_to_sellable,
  (COALESCE(NULLIF(trim(pul.display_name), ''), pul.code, 'unit') = sp.sellable_display_name) AS label_matches_sellable
FROM tmp_sellable_pick sp
JOIN products p
  ON p.id = sp.product_id
LEFT JOIN LATERAL (
  SELECT sm.*
  FROM stock_movements sm
  WHERE sm.product_id = sp.product_id
  ORDER BY sm.occurred_at DESC, sm.created_at DESC
  LIMIT 1
) sm ON true
LEFT JOIN product_unit_levels pul
  ON pul.id = sm.unit_level_id
ORDER BY p.product_code;

SELECT COUNT(*) AS verify_rows_with_question_mark
FROM product_unit_levels
WHERE display_name LIKE '%?%';

COMMIT;
