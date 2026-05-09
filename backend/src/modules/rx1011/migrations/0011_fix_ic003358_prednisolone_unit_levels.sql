BEGIN;

-- Fix product IC-003358 / barcode 9999900089530
-- Current problem:
-- - The only unit level is labeled as "1 กล่อง x 100 แผง x 10 เม็ด"
-- - But the row is structurally a BLISTER base unit (qpb=1, unitType=BLISTER)
-- - Operational stock already behaves like blister-level stock (for example +20 means 20 blister, not 20 boxes)
--
-- Target structure:
-- - sort_order 1 / base / sellable: 1 แผง x 10 เม็ด
-- - sort_order 2 / optional larger pack: 1 กล่อง x 100 แผง x 10 เม็ด
-- - conversion: 1 กล่อง = 100 แผง

DO $$
DECLARE
  target_product_id uuid;
  blister_unit_type_id uuid;
  box_unit_type_id uuid;
  primary_unit_level_id uuid;
  box_unit_level_id uuid;
BEGIN
  SELECT id
  INTO target_product_id
  FROM products
  WHERE product_code = 'IC-003358'
  LIMIT 1;

  IF target_product_id IS NULL THEN
    RAISE EXCEPTION 'Product IC-003358 not found';
  END IF;

  SELECT id
  INTO blister_unit_type_id
  FROM unit_types
  WHERE code = 'BLISTER'
  LIMIT 1;

  IF blister_unit_type_id IS NULL THEN
    RAISE EXCEPTION 'unit_types.BLISTER not found';
  END IF;

  SELECT id
  INTO box_unit_type_id
  FROM unit_types
  WHERE code = 'BOX'
  LIMIT 1;

  IF box_unit_type_id IS NULL THEN
    RAISE EXCEPTION 'unit_types.BOX not found';
  END IF;

  SELECT pul.id
  INTO primary_unit_level_id
  FROM product_unit_levels pul
  WHERE pul.product_id = target_product_id
  ORDER BY pul.is_sellable DESC, pul.is_base DESC, pul.sort_order ASC, pul.created_at ASC
  LIMIT 1;

  IF primary_unit_level_id IS NULL THEN
    RAISE EXCEPTION 'No product_unit_levels row found for product IC-003358';
  END IF;

  UPDATE product_unit_levels
  SET
    code = 'SELLABLE',
    display_name = '1 แผง x 10 เม็ด',
    unit_type_id = blister_unit_type_id,
    is_base = true,
    is_sellable = true,
    sort_order = 1,
    unit_key = 'UL|product=IC-003358|lvl=1|parent=0|qpp=1|qpb=1|base=BLISTER|ut=BLISTER'
  WHERE id = primary_unit_level_id;

  INSERT INTO product_unit_levels (
    product_id,
    code,
    display_name,
    unit_type_id,
    unit_key,
    is_base,
    is_sellable,
    sort_order,
    barcode
  )
  VALUES (
    target_product_id,
    'BOX_100_BLISTER',
    '1 กล่อง x 100 แผง x 10 เม็ด',
    box_unit_type_id,
    'UL|product=IC-003358|lvl=2|parent=1|qpp=100|qpb=100|base=BLISTER|ut=BOX',
    false,
    false,
    2,
    null
  )
  ON CONFLICT (product_id, code) DO UPDATE
  SET
    display_name = EXCLUDED.display_name,
    unit_type_id = EXCLUDED.unit_type_id,
    unit_key = EXCLUDED.unit_key,
    is_base = EXCLUDED.is_base,
    is_sellable = EXCLUDED.is_sellable,
    sort_order = EXCLUDED.sort_order,
    barcode = EXCLUDED.barcode
  RETURNING id
  INTO box_unit_level_id;

  IF box_unit_level_id IS NULL THEN
    SELECT pul.id
    INTO box_unit_level_id
    FROM product_unit_levels pul
    WHERE pul.product_id = target_product_id
      AND pul.code = 'BOX_100_BLISTER'
    LIMIT 1;
  END IF;

  INSERT INTO product_unit_conversions (
    product_id,
    parent_unit_level_id,
    child_unit_level_id,
    multiplier
  )
  VALUES (
    target_product_id,
    primary_unit_level_id,
    box_unit_level_id,
    100
  )
  ON CONFLICT (product_id, parent_unit_level_id, child_unit_level_id) DO UPDATE
  SET multiplier = EXCLUDED.multiplier;
END
$$;

SELECT
  p.product_code,
  pul.code,
  pul.display_name,
  pul.is_base,
  pul.is_sellable,
  pul.sort_order,
  pul.barcode,
  pul.unit_key
FROM product_unit_levels pul
JOIN products p ON p.id = pul.product_id
WHERE p.product_code = 'IC-003358'
ORDER BY pul.sort_order ASC, pul.created_at ASC;

SELECT
  p.product_code,
  parent.display_name AS parent_unit,
  child.display_name AS child_unit,
  conv.multiplier
FROM product_unit_conversions conv
JOIN products p ON p.id = conv.product_id
JOIN product_unit_levels parent ON parent.id = conv.parent_unit_level_id
JOIN product_unit_levels child ON child.id = conv.child_unit_level_id
WHERE p.product_code = 'IC-003358'
ORDER BY parent.sort_order ASC, child.sort_order ASC;

COMMIT;
