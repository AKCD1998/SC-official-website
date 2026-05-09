\set ON_ERROR_STOP on
BEGIN;

-- 0021_repair_corrupted_packaging_display_names.sql
-- Purpose:
-- - Repair corrupted packaging labels such as `1 ????? x 5 ??? x 10 ????`.
-- - Rebuild the display name from:
--   - the current row's unit type Thai label
--   - qpp from unit_key
--   - the parent packaging label for the same product
--
-- Safety:
-- - Only updates rows whose current display_name contains `?` or the replacement character.
-- - Requires a parsable parent level, qpp token, and a non-corrupted parent label.
-- - Runs in one transaction and is idempotent after labels are repaired.

CREATE TEMP TABLE tmp_corrupted_packaging_label_repairs ON COMMIT DROP AS
WITH corrupted_rows AS (
  SELECT
    pul.id AS unit_level_id,
    pul.product_id,
    p.product_code,
    pul.code,
    pul.display_name,
    pul.unit_key,
    ut.name_th AS unit_name_th,
    NULLIF((regexp_match(COALESCE(pul.unit_key, ''), 'parent=([0-9]+)'))[1], '')::int AS parent_level,
    NULLIF((regexp_match(COALESCE(pul.unit_key, ''), 'qpp=([0-9]+(?:\.[0-9]+)?)'))[1], '')::numeric AS quantity_per_parent
  FROM product_unit_levels pul
  JOIN products p ON p.id = pul.product_id
  LEFT JOIN unit_types ut ON ut.id = pul.unit_type_id
  WHERE pul.display_name LIKE '%?%'
     OR pul.display_name LIKE '%' || U&'\FFFD' || '%'
),
resolved_parent AS (
  SELECT
    row.unit_level_id,
    row.product_id,
    row.product_code,
    row.code,
    row.display_name,
    row.unit_key,
    row.unit_name_th,
    row.parent_level,
    row.quantity_per_parent,
    parent_unit.id AS parent_unit_level_id,
    parent_unit.display_name AS parent_display_name
  FROM corrupted_rows row
  LEFT JOIN LATERAL (
    SELECT
      parent_pul.id,
      parent_pul.display_name
    FROM product_unit_levels parent_pul
    WHERE parent_pul.product_id = row.product_id
      AND NULLIF((regexp_match(COALESCE(parent_pul.unit_key, ''), 'lvl=([0-9]+)'))[1], '')::int = row.parent_level
    ORDER BY
      parent_pul.is_base DESC,
      parent_pul.is_sellable DESC,
      parent_pul.sort_order ASC,
      parent_pul.created_at ASC
    LIMIT 1
  ) parent_unit ON true
),
repair_candidates AS (
  SELECT
    unit_level_id,
    product_id,
    product_code,
    code,
    display_name AS corrupted_display_name,
    parent_unit_level_id,
    parent_display_name,
    CASE
      WHEN quantity_per_parent = trunc(quantity_per_parent) THEN trunc(quantity_per_parent)::text
      ELSE trim(trailing '.' FROM trim(trailing '0' FROM quantity_per_parent::text))
    END AS quantity_per_parent_text,
    regexp_replace(btrim(parent_display_name), '^1[[:space:]]+', '') AS parent_display_name_without_leading_one,
    unit_name_th
  FROM resolved_parent
  WHERE COALESCE(unit_name_th, '') <> ''
    AND COALESCE(parent_display_name, '') <> ''
    AND parent_level IS NOT NULL
    AND parent_level > 0
    AND quantity_per_parent IS NOT NULL
    AND unit_name_th NOT LIKE '%?%'
    AND parent_display_name NOT LIKE '%?%'
    AND parent_display_name NOT LIKE '%' || U&'\FFFD' || '%'
)
SELECT
  unit_level_id,
  product_id,
  product_code,
  code,
  corrupted_display_name,
  parent_unit_level_id,
  parent_display_name,
  format(
    '1 %s x %s %s',
    unit_name_th,
    COALESCE(NULLIF(quantity_per_parent_text, ''), '1'),
    parent_display_name_without_leading_one
  ) AS repaired_display_name
FROM repair_candidates;

SELECT COUNT(*) AS dry_run_corrupted_packaging_label_repair_rows
FROM tmp_corrupted_packaging_label_repairs;

SELECT
  product_code,
  code,
  corrupted_display_name,
  parent_display_name,
  repaired_display_name
FROM tmp_corrupted_packaging_label_repairs
ORDER BY product_code, code;

UPDATE product_unit_levels pul
SET display_name = repair.repaired_display_name
FROM tmp_corrupted_packaging_label_repairs repair
WHERE pul.id = repair.unit_level_id
  AND pul.display_name IS DISTINCT FROM repair.repaired_display_name;

SELECT COUNT(*) AS remaining_corrupted_packaging_label_rows
FROM product_unit_levels
WHERE display_name LIKE '%?%'
   OR display_name LIKE '%' || U&'\FFFD' || '%';

COMMIT;
