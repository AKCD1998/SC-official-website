BEGIN;

CREATE TABLE IF NOT EXISTS product_lot_allowed_unit_levels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  product_lot_id uuid NOT NULL,
  unit_level_id uuid NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  source_type text NOT NULL DEFAULT 'MANUAL',
  note_text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_product_lot_allowed_unit_levels_lot
    FOREIGN KEY (product_id, product_lot_id)
    REFERENCES product_lots (product_id, id)
    ON DELETE CASCADE,
  CONSTRAINT fk_product_lot_allowed_unit_levels_unit_level
    FOREIGN KEY (product_id, unit_level_id)
    REFERENCES product_unit_levels (product_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT uq_product_lot_allowed_unit_level UNIQUE (product_lot_id, unit_level_id),
  CONSTRAINT ck_product_lot_allowed_unit_levels_source_type_not_blank
    CHECK (btrim(source_type) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_lot_allowed_unit_level_default_active
  ON product_lot_allowed_unit_levels (product_lot_id)
  WHERE is_default = true AND is_active = true;

CREATE INDEX IF NOT EXISTS idx_product_lot_allowed_unit_levels_lot_active
  ON product_lot_allowed_unit_levels (product_lot_id, is_active, is_default, unit_level_id);

CREATE INDEX IF NOT EXISTS idx_product_lot_allowed_unit_levels_product_active
  ON product_lot_allowed_unit_levels (product_id, is_active, product_lot_id);

COMMENT ON TABLE product_lot_allowed_unit_levels IS
  'Lot-level allowed packaging/unit whitelist. Transitional seed for historical lots plus future manual overrides.';

COMMENT ON COLUMN product_lot_allowed_unit_levels.source_type IS
  'Origin of this mapping row such as MANUAL or LEGACY_SECONDARY_SEED.';

WITH eligible_secondary_levels AS (
  SELECT
    pul.product_id,
    pul.id AS unit_level_id
  FROM product_unit_levels pul
  JOIN products p ON p.id = pul.product_id
  WHERE COALESCE((to_jsonb(pul) ->> 'is_active')::boolean, true) = true
    AND COALESCE(p.product_code, '') <> 'IC-999999'
    AND (
      (
        NULLIF((regexp_match(COALESCE(pul.unit_key, ''), 'lvl=([0-9]+)'))[1], '')::integer = 2
        AND NULLIF((regexp_match(COALESCE(pul.unit_key, ''), 'parent=([0-9]+)'))[1], '')::integer = 1
      )
      OR (
        COALESCE(pul.unit_key, '') = ''
        AND pul.sort_order = 2
        AND pul.is_base = false
      )
    )
),
unambiguous_secondary_levels AS (
  SELECT
    product_id,
    MIN(unit_level_id::text)::uuid AS unit_level_id
  FROM eligible_secondary_levels
  GROUP BY product_id
  HAVING COUNT(*) = 1
),
seed_target_lots AS (
  SELECT
    pl.product_id,
    pl.id AS product_lot_id,
    usl.unit_level_id
  FROM product_lots pl
  JOIN unambiguous_secondary_levels usl ON usl.product_id = pl.product_id
  WHERE NOT EXISTS (
    SELECT 1
    FROM product_lot_allowed_unit_levels plaul
    WHERE plaul.product_lot_id = pl.id
  )
)
INSERT INTO product_lot_allowed_unit_levels (
  product_id,
  product_lot_id,
  unit_level_id,
  is_default,
  is_active,
  source_type,
  note_text
)
SELECT
  stl.product_id,
  stl.product_lot_id,
  stl.unit_level_id,
  true,
  true,
  'LEGACY_SECONDARY_SEED',
  'Seeded from current true secondary packaging during historical lot whitelist rollout'
FROM seed_target_lots stl
ON CONFLICT (product_lot_id, unit_level_id) DO NOTHING;

COMMIT;
