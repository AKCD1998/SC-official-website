BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM active_ingredients
    GROUP BY lower(trim(name_en))
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot normalize active_ingredients.name_en to uppercase: duplicate names detected (case-insensitive).';
  END IF;
END
$$;

UPDATE active_ingredients
SET name_en = upper(trim(name_en))
WHERE name_en IS DISTINCT FROM upper(trim(name_en));

CREATE UNIQUE INDEX IF NOT EXISTS uq_active_ingredients_name_en_ci
  ON active_ingredients (lower(trim(name_en)));

COMMIT;
