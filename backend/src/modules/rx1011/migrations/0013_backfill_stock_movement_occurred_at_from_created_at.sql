-- 0013_backfill_stock_movement_occurred_at_from_created_at.sql
-- Purpose:
-- - Backfill historical stock movements whose original occurred_at diverged from created_at
--   before the system-enforced "use DB now() on create" policy.
-- - Preserve originals by writing corrected_occurred_at instead of overwriting occurred_at.
-- - Record one audit row per backfilled movement.

DO $$
DECLARE
  actor_id uuid;
BEGIN
  SELECT id
  INTO actor_id
  FROM users
  WHERE lower(username) = 'system'
  ORDER BY created_at ASC
  LIMIT 1;

  IF actor_id IS NULL THEN
    SELECT id
    INTO actor_id
    FROM users
    WHERE role = 'ADMIN'
    ORDER BY created_at ASC
    LIMIT 1;
  END IF;

  IF actor_id IS NULL THEN
    RAISE EXCEPTION
      'Cannot backfill stock movement occurred_at corrections: no system/admin user found';
  END IF;

  WITH target AS (
    SELECT
      sm.id,
      sm.occurred_at AS original_occurred_at,
      sm.corrected_occurred_at AS previous_corrected_occurred_at,
      COALESCE(sm.corrected_occurred_at, sm.occurred_at) AS previous_effective_occurred_at,
      sm.created_at AS new_effective_occurred_at
    FROM stock_movements sm
    WHERE sm.corrected_occurred_at IS NULL
      AND sm.occurred_at IS DISTINCT FROM sm.created_at
  ),
  updated AS (
    UPDATE stock_movements sm
    SET corrected_occurred_at = target.new_effective_occurred_at
    FROM target
    WHERE sm.id = target.id
    RETURNING sm.id
  )
  INSERT INTO stock_movement_occurred_at_audits (
    movement_id,
    original_occurred_at,
    previous_corrected_occurred_at,
    previous_effective_occurred_at,
    new_corrected_occurred_at,
    new_effective_occurred_at,
    reason_text,
    edited_by
  )
  SELECT
    target.id,
    target.original_occurred_at,
    target.previous_corrected_occurred_at,
    target.previous_effective_occurred_at,
    target.new_effective_occurred_at,
    target.new_effective_occurred_at,
    'Backfilled to created_at after enforcing system-generated occurred_at on create; original occurred_at preserved for audit.',
    actor_id
  FROM target
  JOIN updated ON updated.id = target.id;
END
$$;
