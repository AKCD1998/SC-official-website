-- Example analytics and audit queries for KY10/11 schema
-- Replace bind placeholders (:product_id, :pid, :from_ts, :to_ts) with actual values in your SQL client.

-- 1) Stock on hand by branch and product
SELECT
  l.code AS branch_code,
  l.name AS branch_name,
  p.product_code,
  p.trade_name,
  SUM(soh.quantity_on_hand) AS qty_on_hand,
  ut.code AS base_unit
FROM stock_on_hand soh
JOIN locations l ON l.id = soh.branch_id
JOIN products p ON p.id = soh.product_id
JOIN product_unit_levels pul ON pul.id = soh.base_unit_level_id
JOIN unit_types ut ON ut.id = pul.unit_type_id
WHERE l.location_type = 'BRANCH'
GROUP BY
  l.code,
  l.name,
  p.product_code,
  p.trade_name,
  ut.code
ORDER BY l.code, p.trade_name;

-- 2) Stock on hand by branch and lot
SELECT
  l.code AS branch_code,
  p.trade_name,
  pl.lot_no,
  pl.exp_date,
  soh.quantity_on_hand,
  ut.code AS base_unit
FROM stock_on_hand soh
JOIN locations l ON l.id = soh.branch_id
JOIN products p ON p.id = soh.product_id
LEFT JOIN product_lots pl ON pl.id = soh.lot_id
JOIN product_unit_levels pul ON pul.id = soh.base_unit_level_id
JOIN unit_types ut ON ut.id = pul.unit_type_id
WHERE l.location_type = 'BRANCH'
ORDER BY l.code, p.trade_name, pl.exp_date NULLS LAST, pl.lot_no;

-- 3) Movement ledger for a product across branches/locations
SELECT
  sm.occurred_at,
  sm.movement_type,
  p.trade_name,
  pl.lot_no,
  from_l.code AS from_location_code,
  from_l.name AS from_location_name,
  to_l.code AS to_location_code,
  to_l.name AS to_location_name,
  sm.quantity,
  ut.code AS unit_code,
  u.username AS created_by_username,
  sm.note_text
FROM stock_movements sm
JOIN products p ON p.id = sm.product_id
JOIN product_unit_levels pul ON pul.id = sm.unit_level_id
JOIN unit_types ut ON ut.id = pul.unit_type_id
LEFT JOIN product_lots pl ON pl.id = sm.lot_id
LEFT JOIN locations from_l ON from_l.id = sm.from_location_id
LEFT JOIN locations to_l ON to_l.id = sm.to_location_id
JOIN users u ON u.id = sm.created_by
WHERE sm.product_id = :product_id
ORDER BY sm.occurred_at, sm.created_at, sm.id;

-- 4) Dispensing history for one PID within date range
SELECT
  dh.dispensed_at,
  pa.pid,
  pa.full_name AS patient_name,
  l.code AS branch_code,
  l.name AS branch_name,
  ph.username AS pharmacist_username,
  p.trade_name,
  dl.quantity,
  ut.code AS unit_code,
  pl.lot_no,
  dh.note_text AS header_note,
  dl.note_text AS line_note
FROM dispense_headers dh
JOIN patients pa ON pa.id = dh.patient_id
JOIN locations l ON l.id = dh.branch_id
JOIN users ph ON ph.id = dh.pharmacist_user_id
JOIN dispense_lines dl ON dl.header_id = dh.id
JOIN products p ON p.id = dl.product_id
JOIN product_unit_levels pul ON pul.id = dl.unit_level_id
JOIN unit_types ut ON ut.id = pul.unit_type_id
LEFT JOIN product_lots pl ON pl.id = dl.lot_id
WHERE pa.pid = :pid
  AND dh.dispensed_at >= :from_ts
  AND dh.dispensed_at < :to_ts
ORDER BY dh.dispensed_at DESC, dl.line_no;

-- 5) Detect rule violations per visit (PER_VISIT)
-- Note:
-- This query compares rules against line unit_type directly.
-- If users dispense with different unit levels (e.g., BOX) and want conversion to BLISTER/BOTTLE,
-- convert quantity first using product_unit_conversions before evaluating rules.
WITH visit_line_units AS (
  SELECT
    dh.id AS dispense_header_id,
    dh.dispensed_at,
    pa.pid,
    pa.full_name AS patient_name,
    df.dosage_form_group,
    ut.id AS unit_type_id,
    ut.code AS unit_code,
    SUM(dl.quantity) AS dispensed_qty
  FROM dispense_headers dh
  JOIN patients pa ON pa.id = dh.patient_id
  JOIN dispense_lines dl ON dl.header_id = dh.id
  JOIN products p ON p.id = dl.product_id
  JOIN dosage_forms df ON df.id = p.dosage_form_id
  JOIN product_unit_levels pul ON pul.id = dl.unit_level_id
  JOIN unit_types ut ON ut.id = pul.unit_type_id
  GROUP BY
    dh.id,
    dh.dispensed_at,
    pa.pid,
    pa.full_name,
    df.dosage_form_group,
    ut.id,
    ut.code
)
SELECT
  v.dispense_header_id,
  v.dispensed_at,
  v.pid,
  v.patient_name,
  v.dosage_form_group,
  v.dispensed_qty,
  v.unit_code AS dispensed_unit,
  r.rule_name,
  r.max_qty,
  rut.code AS rule_unit
FROM visit_line_units v
JOIN dispensing_rules r
  ON r.is_active = true
  AND r.rule_scope = 'DOSAGE_FORM_GROUP'
  AND r.rule_period = 'PER_VISIT'
  AND r.dosage_form_group = v.dosage_form_group
  AND r.unit_type_id = v.unit_type_id
JOIN unit_types rut ON rut.id = r.unit_type_id
WHERE v.dispensed_qty > r.max_qty
ORDER BY v.dispensed_at DESC, v.dispense_header_id;

-- 6A) Get all products currently in KY10
SELECT
  p.id,
  p.product_code,
  p.trade_name
FROM products p
JOIN product_report_groups prg ON prg.product_id = p.id
JOIN report_groups rg ON rg.id = prg.report_group_id
WHERE rg.code = 'KY10'
  AND rg.is_active = true
  AND prg.effective_from <= CURRENT_DATE
  AND (prg.effective_to IS NULL OR prg.effective_to >= CURRENT_DATE)
ORDER BY p.trade_name;

-- 6B) Get all products currently in KY11
SELECT
  p.id,
  p.product_code,
  p.trade_name
FROM products p
JOIN product_report_groups prg ON prg.product_id = p.id
JOIN report_groups rg ON rg.id = prg.report_group_id
WHERE rg.code = 'KY11'
  AND rg.is_active = true
  AND prg.effective_from <= CURRENT_DATE
  AND (prg.effective_to IS NULL OR prg.effective_to >= CURRENT_DATE)
ORDER BY p.trade_name;

-- 6C) Get products that are currently both KY10 and KY11
WITH active_groups AS (
  SELECT
    prg.product_id,
    rg.code
  FROM product_report_groups prg
  JOIN report_groups rg ON rg.id = prg.report_group_id
  WHERE rg.is_active = true
    AND prg.effective_from <= CURRENT_DATE
    AND (prg.effective_to IS NULL OR prg.effective_to >= CURRENT_DATE)
    AND rg.code IN ('KY10', 'KY11')
)
SELECT
  p.id,
  p.product_code,
  p.trade_name
FROM products p
JOIN active_groups ag ON ag.product_id = p.id
GROUP BY p.id, p.product_code, p.trade_name
HAVING COUNT(DISTINCT ag.code) = 2
ORDER BY p.trade_name;

-- 6D) Dispensing history filtered to KY11 products in a date range
SELECT
  dh.dispensed_at,
  pa.pid,
  pa.full_name AS patient_name,
  l.code AS branch_code,
  p.product_code,
  p.trade_name,
  dl.quantity,
  ut.code AS unit_code,
  ph.username AS pharmacist_username
FROM dispense_headers dh
JOIN patients pa ON pa.id = dh.patient_id
JOIN locations l ON l.id = dh.branch_id
JOIN users ph ON ph.id = dh.pharmacist_user_id
JOIN dispense_lines dl ON dl.header_id = dh.id
JOIN products p ON p.id = dl.product_id
JOIN product_unit_levels pul ON pul.id = dl.unit_level_id
JOIN unit_types ut ON ut.id = pul.unit_type_id
JOIN product_report_groups prg ON prg.product_id = p.id
JOIN report_groups rg ON rg.id = prg.report_group_id
WHERE rg.code = 'KY11'
  AND rg.is_active = true
  AND dh.dispensed_at >= :from_ts
  AND dh.dispensed_at < :to_ts
  AND prg.effective_from <= dh.dispensed_at::date
  AND (prg.effective_to IS NULL OR prg.effective_to >= dh.dispensed_at::date)
ORDER BY dh.dispensed_at DESC, dl.line_no;

-- 6E) Detect products missing current report classification
SELECT
  p.id,
  p.product_code,
  p.trade_name
FROM products p
LEFT JOIN product_report_groups prg
  ON prg.product_id = p.id
  AND prg.effective_from <= CURRENT_DATE
  AND (prg.effective_to IS NULL OR prg.effective_to >= CURRENT_DATE)
LEFT JOIN report_groups rg
  ON rg.id = prg.report_group_id
  AND rg.is_active = true
WHERE p.is_active = true
GROUP BY p.id, p.product_code, p.trade_name
HAVING COUNT(rg.id) = 0
ORDER BY p.trade_name;
