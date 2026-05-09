\set ON_ERROR_STOP on
BEGIN;

-- 0009_stock_movements_quantity_base_ssot.sql
-- SSOT decision:
-- - stock_movements.quantity_base (signed base-unit quantity) is the canonical stock ledger value.
-- - stock_movements.quantity + unit_level_id remain for UI/history display.
-- - unit conversion source of truth stays in product_unit_levels.unit_key (qpb token).
-- - This migration is reconciliation-first (Option 2), no data wipe.

ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS quantity_base numeric(18,6);

ALTER TABLE stock_movements
  ALTER COLUMN quantity_base SET DEFAULT 0;

-- Guard: conversion must be resolvable before backfill.
SELECT COUNT(*) AS dry_run_missing_qpb_rows
FROM stock_movements sm
JOIN product_unit_levels pul
  ON pul.id = sm.unit_level_id
WHERE COALESCE((regexp_match(pul.unit_key, 'qpb=([0-9]+(?:\\.[0-9]+)?)'))[1], '') = '';

DO $$
DECLARE
  missing_qpb_count bigint;
BEGIN
  SELECT COUNT(*)
  INTO missing_qpb_count
  FROM stock_movements sm
  JOIN product_unit_levels pul
    ON pul.id = sm.unit_level_id
  WHERE COALESCE((regexp_match(pul.unit_key, 'qpb=([0-9]+(?:\\.[0-9]+)?)'))[1], '') = '';

  IF missing_qpb_count > 0 THEN
    RAISE EXCEPTION
      'Cannot backfill stock_movements.quantity_base; missing/invalid qpb in unit_key for % rows',
      missing_qpb_count;
  END IF;
END
$$;

-- Backfill quantity_base (signed):
-- RECEIVE / TRANSFER_IN => positive
-- TRANSFER_OUT / DISPENSE => negative
SELECT COUNT(*) AS dry_run_quantity_base_backfill_rows
FROM stock_movements sm
JOIN product_unit_levels pul
  ON pul.id = sm.unit_level_id
WHERE (sm.quantity_base IS NULL OR sm.quantity_base = 0)
  AND COALESCE((regexp_match(pul.unit_key, 'qpb=([0-9]+(?:\\.[0-9]+)?)'))[1], '') <> '';

UPDATE stock_movements sm
SET quantity_base =
  (
    CASE
      WHEN sm.movement_type::text IN ('TRANSFER_OUT', 'DISPENSE') THEN -1
      ELSE 1
    END
  )
  * sm.quantity
  * NULLIF((regexp_match(pul.unit_key, 'qpb=([0-9]+(?:\\.[0-9]+)?)'))[1], '')::numeric
FROM product_unit_levels pul
WHERE pul.id = sm.unit_level_id
  AND (sm.quantity_base IS NULL OR sm.quantity_base = 0)
  AND COALESCE((regexp_match(pul.unit_key, 'qpb=([0-9]+(?:\\.[0-9]+)?)'))[1], '') <> '';

SELECT COUNT(*) AS post_backfill_zero_or_null_quantity_base_rows
FROM stock_movements
WHERE quantity_base IS NULL OR quantity_base = 0;

ALTER TABLE stock_movements
  ALTER COLUMN quantity_base SET NOT NULL;

ALTER TABLE stock_on_hand
  ALTER COLUMN quantity_on_hand TYPE numeric(18,6);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_stock_movements_quantity_base_nonzero'
      AND conrelid = 'stock_movements'::regclass
  ) THEN
    ALTER TABLE stock_movements
      ADD CONSTRAINT ck_stock_movements_quantity_base_nonzero
      CHECK (quantity_base <> 0)
      NOT VALID;
  END IF;
END
$$;

ALTER TABLE stock_movements
  VALIDATE CONSTRAINT ck_stock_movements_quantity_base_nonzero;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_stock_movements_quantity_base_sign'
      AND conrelid = 'stock_movements'::regclass
  ) THEN
    ALTER TABLE stock_movements
      ADD CONSTRAINT ck_stock_movements_quantity_base_sign
      CHECK (
        (
          movement_type::text IN ('RECEIVE', 'TRANSFER_IN')
          AND quantity_base > 0
        )
        OR (
          movement_type::text IN ('TRANSFER_OUT', 'DISPENSE')
          AND quantity_base < 0
        )
        OR movement_type::text = 'ADJUST'
      )
      NOT VALID;
  END IF;
END
$$;

ALTER TABLE stock_movements
  VALIDATE CONSTRAINT ck_stock_movements_quantity_base_sign;

-- Enforce product/unit-level pair consistency at DB level.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'stock_movements'::regclass
      AND contype = 'f'
      AND confrelid = 'product_unit_levels'::regclass
      AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (product_id, unit_level_id)%'
  ) THEN
    ALTER TABLE stock_movements
      ADD CONSTRAINT fk_stock_movements_product_unit_level_pair
      FOREIGN KEY (product_id, unit_level_id)
      REFERENCES product_unit_levels (product_id, id);
  END IF;
END
$$;

-- Trigger guard rail:
-- - validates product/unit-level match
-- - validates qpb exists in unit_key
-- - recomputes NEW.quantity_base from quantity + movement_type (+ conversion)
CREATE OR REPLACE FUNCTION trg_stock_movements_set_quantity_base()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  unit_key_text text;
  qpb numeric;
BEGIN
  SELECT pul.unit_key
  INTO unit_key_text
  FROM product_unit_levels pul
  WHERE pul.id = NEW.unit_level_id
    AND pul.product_id = NEW.product_id
  LIMIT 1;

  IF unit_key_text IS NULL THEN
    RAISE EXCEPTION
      'unit_level_id % does not belong to product_id %',
      NEW.unit_level_id,
      NEW.product_id;
  END IF;

  qpb := NULLIF((regexp_match(unit_key_text, 'qpb=([0-9]+(?:\\.[0-9]+)?)'))[1], '')::numeric;
  IF qpb IS NULL OR qpb <= 0 THEN
    RAISE EXCEPTION
      'unit_level_id % has invalid qpb in unit_key: %',
      NEW.unit_level_id,
      unit_key_text;
  END IF;

  NEW.quantity_base := NEW.quantity * qpb;
  IF NEW.movement_type::text IN ('TRANSFER_OUT', 'DISPENSE') THEN
    NEW.quantity_base := -NEW.quantity_base;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS before_stock_movements_set_quantity_base ON stock_movements;
CREATE TRIGGER before_stock_movements_set_quantity_base
BEFORE INSERT OR UPDATE OF movement_type, quantity, unit_level_id, product_id
ON stock_movements
FOR EACH ROW
EXECUTE FUNCTION trg_stock_movements_set_quantity_base();

-- Reconcile stock_on_hand cache from canonical movement ledger (quantity_base).
SELECT COUNT(*) AS dry_run_products_missing_base_unit
FROM products p
WHERE NOT EXISTS (
  SELECT 1
  FROM product_unit_levels pul
  WHERE pul.product_id = p.id
    AND pul.is_base = true
);

SELECT
  p.product_code
FROM products p
WHERE NOT EXISTS (
  SELECT 1
  FROM product_unit_levels pul
  WHERE pul.product_id = p.id
    AND pul.is_base = true
)
ORDER BY p.product_code;

CREATE TEMP TABLE tmp_stock_on_hand_rebuild ON COMMIT DROP AS
WITH movement_branch AS (
  SELECT
    CASE
      WHEN sm.quantity_base > 0 THEN sm.to_location_id
      ELSE sm.from_location_id
    END AS branch_id,
    sm.product_id,
    sm.lot_id,
    SUM(sm.quantity_base) AS qty_base
  FROM stock_movements sm
  GROUP BY
    CASE
      WHEN sm.quantity_base > 0 THEN sm.to_location_id
      ELSE sm.from_location_id
    END,
    sm.product_id,
    sm.lot_id
),
base_unit AS (
  SELECT DISTINCT ON (pul.product_id)
    pul.product_id,
    pul.id AS base_unit_level_id
  FROM product_unit_levels pul
  ORDER BY pul.product_id, pul.is_base DESC, pul.sort_order ASC, pul.created_at ASC
)
SELECT
  mb.branch_id,
  mb.product_id,
  mb.lot_id,
  bu.base_unit_level_id,
  mb.qty_base
FROM movement_branch mb
JOIN base_unit bu
  ON bu.product_id = mb.product_id
WHERE mb.branch_id IS NOT NULL
  AND mb.qty_base <> 0;

SELECT COUNT(*) AS dry_run_negative_stock_groups
FROM tmp_stock_on_hand_rebuild
WHERE qty_base < 0;

DO $$
DECLARE
  negative_stock_count bigint;
BEGIN
  SELECT COUNT(*)
  INTO negative_stock_count
  FROM tmp_stock_on_hand_rebuild
  WHERE qty_base < 0;

  IF negative_stock_count > 0 THEN
    RAISE EXCEPTION
      'Cannot reconcile stock_on_hand: % groups would be negative',
      negative_stock_count;
  END IF;
END
$$;

SELECT COUNT(*) AS dry_run_delete_stock_on_hand_rows
FROM stock_on_hand;

DELETE FROM stock_on_hand;

SELECT COUNT(*) AS dry_run_insert_stock_on_hand_rows
FROM tmp_stock_on_hand_rebuild
WHERE qty_base > 0;

INSERT INTO stock_on_hand (
  branch_id,
  product_id,
  lot_id,
  base_unit_level_id,
  quantity_on_hand,
  updated_at
)
SELECT
  branch_id,
  product_id,
  lot_id,
  base_unit_level_id,
  qty_base,
  now()
FROM tmp_stock_on_hand_rebuild
WHERE qty_base > 0;

-- Verification queries
SELECT COUNT(*) AS verify_zero_base_with_nonzero_qty
FROM stock_movements
WHERE quantity <> 0
  AND quantity_base = 0;

SELECT
  p.product_code,
  SUM(sm.quantity_base) AS sum_quantity_base
FROM stock_movements sm
JOIN products p
  ON p.id = sm.product_id
WHERE p.product_code IN ('IC-002604', 'BAR-1771935381242')
GROUP BY p.product_code
ORDER BY p.product_code;

SELECT COUNT(*) AS verify_unitkey_or_label_has_question_mark
FROM product_unit_levels
WHERE COALESCE(unit_key, '') LIKE '%?%'
   OR COALESCE(display_name, '') LIKE '%?%';

COMMIT;
