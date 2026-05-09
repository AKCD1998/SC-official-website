BEGIN;

-- 0007_unit_level_code_stability.sql
-- Goal:
-- 1) Introduce a stable, ASCII-safe identity key for product unit levels (unit_key).
-- 2) Backfill unit_key for existing data from structural relations (sort order + conversion path + base/unit type).
-- 3) Repair only definitely corrupted display_name values that contain '?'.
--
-- Notes:
-- - This migration is intentionally additive and backward-compatible.
-- - Existing product_unit_levels.code is not dropped/retyped in this migration.
-- - If your migration runner supports down migrations, create a paired rollback file.
--   This project currently uses forward-only SQL files.

ALTER TABLE product_unit_levels
  ADD COLUMN IF NOT EXISTS unit_key text;

COMMENT ON COLUMN product_unit_levels.unit_key IS
  'Stable structural key for unit levels. ASCII-safe and collision-resistant across legacy sanitized code collisions.';

-- Dry-run visibility for operators:
SELECT COUNT(*) AS dry_run_unit_level_rows
FROM product_unit_levels;

WITH RECURSIVE base_rows AS (
  SELECT
    p.id AS product_id,
    COALESCE(
      (
        SELECT pul.id
        FROM product_unit_levels pul
        WHERE pul.product_id = p.id
          AND pul.is_base = true
        ORDER BY pul.sort_order ASC, pul.created_at ASC
        LIMIT 1
      ),
      (
        SELECT pul.id
        FROM product_unit_levels pul
        WHERE pul.product_id = p.id
        ORDER BY pul.sort_order ASC, pul.created_at ASC
        LIMIT 1
      )
    ) AS base_unit_level_id
  FROM products p
),
conversion_paths AS (
  SELECT
    br.product_id,
    br.base_unit_level_id AS unit_level_id,
    1::numeric AS qpb
  FROM base_rows br
  WHERE br.base_unit_level_id IS NOT NULL

  UNION ALL

  SELECT
    cp.product_id,
    conv.child_unit_level_id AS unit_level_id,
    cp.qpb * conv.multiplier AS qpb
  FROM conversion_paths cp
  JOIN product_unit_conversions conv
    ON conv.product_id = cp.product_id
   AND conv.parent_unit_level_id = cp.unit_level_id
),
best_qpb AS (
  SELECT
    product_id,
    unit_level_id,
    MAX(qpb) AS qpb
  FROM conversion_paths
  GROUP BY product_id, unit_level_id
),
direct_parent AS (
  SELECT
    conv.child_unit_level_id AS unit_level_id,
    parent.sort_order AS parent_level_no,
    conv.multiplier AS qpp
  FROM product_unit_conversions conv
  JOIN product_unit_levels parent
    ON parent.id = conv.parent_unit_level_id
),
raw_struct AS (
  SELECT
    pul.id,
    regexp_replace(
      upper(COALESCE(p.product_code, p.id::text)),
      '[^A-Z0-9_-]+',
      '_',
      'g'
    ) AS product_token,
    pul.sort_order AS lvl,
    COALESCE(dp.parent_level_no, 0) AS parent_lvl,
    COALESCE(dp.qpp, 1::numeric) AS qpp_numeric,
    COALESCE(bq.qpb, dp.qpp, 1::numeric) AS qpb_numeric,
    regexp_replace(
      upper(COALESCE(base_ut.code, ut.code, 'UNIT')),
      '[^A-Z0-9_-]+',
      '_',
      'g'
    ) AS base_token,
    regexp_replace(
      upper(COALESCE(ut.code, 'UNIT')),
      '[^A-Z0-9_-]+',
      '_',
      'g'
    ) AS unit_type_token
  FROM product_unit_levels pul
  JOIN products p
    ON p.id = pul.product_id
  LEFT JOIN direct_parent dp
    ON dp.unit_level_id = pul.id
  LEFT JOIN best_qpb bq
    ON bq.product_id = pul.product_id
   AND bq.unit_level_id = pul.id
  LEFT JOIN base_rows br
    ON br.product_id = pul.product_id
  LEFT JOIN product_unit_levels base_pul
    ON base_pul.id = br.base_unit_level_id
  LEFT JOIN unit_types base_ut
    ON base_ut.id = base_pul.unit_type_id
  LEFT JOIN unit_types ut
    ON ut.id = pul.unit_type_id
),
computed_keys AS (
  SELECT
    rs.id,
    format(
      'UL|product=%s|lvl=%s|parent=%s|qpp=%s|qpb=%s|base=%s|ut=%s',
      rs.product_token,
      rs.lvl::text,
      rs.parent_lvl::text,
      COALESCE(
        NULLIF(
          regexp_replace(
            regexp_replace(rs.qpp_numeric::text, E'(\\.\\d*?)0+$', E'\\1'),
            E'\\.$',
            ''
          ),
          ''
        ),
        '1'
      ),
      COALESCE(
        NULLIF(
          regexp_replace(
            regexp_replace(rs.qpb_numeric::text, E'(\\.\\d*?)0+$', E'\\1'),
            E'\\.$',
            ''
          ),
          ''
        ),
        '1'
      ),
      rs.base_token,
      rs.unit_type_token
    ) AS unit_key
  FROM raw_struct rs
),
updated AS (
  UPDATE product_unit_levels pul
  SET unit_key = ck.unit_key
  FROM computed_keys ck
  WHERE pul.id = ck.id
    AND pul.unit_key IS DISTINCT FROM ck.unit_key
  RETURNING pul.id
)
SELECT COUNT(*) AS backfilled_unit_key_rows
FROM updated;

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_unit_levels_product_unit_key_unique
  ON product_unit_levels (product_id, unit_key)
  WHERE unit_key IS NOT NULL;

-- Dry-run: corrupted label rows.
SELECT COUNT(*) AS dry_run_corrupted_display_name_rows
FROM product_unit_levels
WHERE display_name LIKE '%?%';

WITH corrupted AS (
  SELECT
    pul.id,
    pul.display_name,
    COALESCE(conv.multiplier, 1::numeric) AS qpp_from_conversion,
    (regexp_match(pul.display_name, E'=\\s*([0-9]+(?:\\.[0-9]+)?)'))[1] AS qpp_from_label
  FROM product_unit_levels pul
  LEFT JOIN product_unit_conversions conv
    ON conv.child_unit_level_id = pul.id
  WHERE pul.display_name LIKE '%?%'
),
repaired AS (
  SELECT
    c.id,
    format(
      '1 unit = %s base',
      COALESCE(
        NULLIF(
          regexp_replace(
            regexp_replace(
              COALESCE(
                c.qpp_from_conversion,
                NULLIF(c.qpp_from_label, '')::numeric,
                1::numeric
              )::text,
              E'(\\.\\d*?)0+$',
              E'\\1'
            ),
            E'\\.$',
            ''
          ),
          ''
        ),
        '1'
      )
    ) AS next_display_name
  FROM corrupted c
),
updated_labels AS (
  UPDATE product_unit_levels pul
  SET display_name = r.next_display_name
  FROM repaired r
  WHERE pul.id = r.id
    AND pul.display_name LIKE '%?%'
    AND pul.display_name IS DISTINCT FROM r.next_display_name
  RETURNING pul.id
)
SELECT COUNT(*) AS updated_corrupted_display_name_rows
FROM updated_labels;

COMMIT;
