BEGIN;

-- Normalize selected box/blister products so Receiving can default to the
-- smallest usable unit (blister) while preserving existing movement/stock refs
-- on the original row id.

DO $$
DECLARE
  blister_unit_type_id uuid;
  box_unit_type_id uuid;
  target record;
  target_product_id uuid;
  primary_unit_level_id uuid;
  box_unit_level_id uuid;
BEGIN
  SELECT id INTO blister_unit_type_id
  FROM unit_types
  WHERE code = 'BLISTER'
  LIMIT 1;

  IF blister_unit_type_id IS NULL THEN
    RAISE EXCEPTION 'unit_types.BLISTER not found';
  END IF;

  SELECT id INTO box_unit_type_id
  FROM unit_types
  WHERE code = 'BOX'
  LIMIT 1;

  IF box_unit_type_id IS NULL THEN
    RAISE EXCEPTION 'unit_types.BOX not found';
  END IF;

  FOR target IN
    SELECT *
    FROM (
      VALUES
        ('IC-002205', '1 แผง x 10 เม็ด', '1 กล่อง x 3 แผง x 10 เม็ด', 3::numeric),
        ('IC-005120', '1 แผง x 4 เม็ด', '1 กล่อง x 25 แผง x 4 เม็ด', 25::numeric),
        ('IC-001159', '1 แผง x 4 เม็ด', '1 กล่อง x 25 แผง x 4 เม็ด', 25::numeric),
        ('IC-000474', '1 แผง x 10 เม็ด', '1 กล่อง x 100 แผง x 10 เม็ด', 100::numeric),
        ('IC-000491', '1 แผง x 10 เม็ด', '1 กล่อง x 10 แผง x 10 เม็ด', 10::numeric),
        ('IC-000541', '1 แผง x 10 เม็ด', '1 กล่อง x 50 แผง x 10 เม็ด', 50::numeric),
        ('IC-000542', '1 แผง x 10 เม็ด', '1 กล่อง x 50 แผง x 10 เม็ด', 50::numeric),
        ('IC-001288', '1 แผง x 10 เม็ด', '1 กล่อง x 20 แผง x 10 เม็ด', 20::numeric),
        ('IC-001674', '1 แผง x 10 เม็ด', '1 กล่อง x 3 แผง x 10 เม็ด', 3::numeric),
        ('IC-002343', '1 แผง x 10 เม็ด', '1 กล่อง x 25 แผง x 10 เม็ด', 25::numeric),
        ('IC-002918', '1 แผง x 10 เม็ด', '1 กล่อง x 100 แผง x 10 เม็ด', 100::numeric),
        ('IC-003023', '1 แผง x 10 เม็ด', '1 กล่อง x 50 แผง x 10 เม็ด', 50::numeric),
        ('IC-003245', '1 แผง x 10 เม็ด', '1 กล่อง x 10 แผง x 10 เม็ด', 10::numeric),
        ('IC-003429', '1 แผง x 10 เม็ด', '1 กล่อง x 10 แผง x 10 เม็ด', 10::numeric),
        ('IC-005159', '1 แผง x 10 เม็ด', '1 กล่อง x 50 แผง x 10 เม็ด', 50::numeric),
        ('IC-005607', '1 แผง x 10 เม็ด', '1 กล่อง x 1 แผง x 10 เม็ด', 1::numeric),
        ('IC-005622', '1 แผง x 10 เม็ด', '1 กล่อง x 1 แผง x 10 เม็ด', 1::numeric)
    ) AS t(product_code, base_display_name, box_display_name, box_multiplier)
  LOOP
    SELECT id
    INTO target_product_id
    FROM products
    WHERE product_code = target.product_code
    LIMIT 1;

    IF target_product_id IS NULL THEN
      RAISE EXCEPTION 'Product % not found', target.product_code;
    END IF;

    SELECT pul.id
    INTO primary_unit_level_id
    FROM product_unit_levels pul
    WHERE pul.product_id = target_product_id
    ORDER BY pul.is_sellable DESC, pul.is_base DESC, pul.sort_order ASC, pul.created_at ASC
    LIMIT 1;

    IF primary_unit_level_id IS NULL THEN
      RAISE EXCEPTION 'No product_unit_levels row found for product %', target.product_code;
    END IF;

    UPDATE product_unit_levels
    SET
      code = 'SELLABLE',
      display_name = target.base_display_name,
      unit_type_id = blister_unit_type_id,
      is_base = true,
      is_sellable = true,
      sort_order = 1,
      unit_key = format(
        'UL|product=%s|lvl=1|parent=0|qpp=1|qpb=1|base=BLISTER|ut=BLISTER',
        target.product_code
      )
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
      format('BOX_%s_BLISTER', replace(target.box_multiplier::text, '.0', '')),
      target.box_display_name,
      box_unit_type_id,
      format(
        'UL|product=%s|lvl=2|parent=1|qpp=%s|qpb=%s|base=BLISTER|ut=BOX',
        target.product_code,
        replace(target.box_multiplier::text, '.0', ''),
        replace(target.box_multiplier::text, '.0', '')
      ),
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
        AND pul.code = format('BOX_%s_BLISTER', replace(target.box_multiplier::text, '.0', ''))
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
      target.box_multiplier
    )
    ON CONFLICT (product_id, parent_unit_level_id, child_unit_level_id) DO UPDATE
    SET multiplier = EXCLUDED.multiplier;
  END LOOP;
END
$$;

SELECT
  p.product_code,
  pul.code,
  pul.display_name,
  ut.code AS unit_type_code,
  pul.is_base,
  pul.is_sellable,
  pul.sort_order,
  NULLIF((regexp_match(COALESCE(pul.unit_key, ''), 'qpb=([0-9]+(?:\.[0-9]+)?)'))[1], '')::numeric AS qpb
FROM product_unit_levels pul
JOIN products p ON p.id = pul.product_id
LEFT JOIN unit_types ut ON ut.id = pul.unit_type_id
WHERE p.product_code IN (
  'IC-002205','IC-005120','IC-001159','IC-000474','IC-000491','IC-000541','IC-000542',
  'IC-001288','IC-001674','IC-002343','IC-002918','IC-003023','IC-003245','IC-003429',
  'IC-005159','IC-005607','IC-005622'
)
ORDER BY p.product_code, pul.sort_order ASC, pul.created_at ASC;

SELECT
  p.product_code,
  parent.display_name AS parent_unit,
  child.display_name AS child_unit,
  conv.multiplier
FROM product_unit_conversions conv
JOIN products p ON p.id = conv.product_id
JOIN product_unit_levels parent ON parent.id = conv.parent_unit_level_id
JOIN product_unit_levels child ON child.id = conv.child_unit_level_id
WHERE p.product_code IN (
  'IC-002205','IC-005120','IC-001159','IC-000474','IC-000491','IC-000541','IC-000542',
  'IC-001288','IC-001674','IC-002343','IC-002918','IC-003023','IC-003245','IC-003429',
  'IC-005159','IC-005607','IC-005622'
)
ORDER BY p.product_code, parent.sort_order ASC, child.sort_order ASC;

COMMIT;
