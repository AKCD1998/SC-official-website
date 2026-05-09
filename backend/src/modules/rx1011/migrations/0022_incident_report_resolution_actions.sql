BEGIN;

CREATE TABLE IF NOT EXISTS incident_report_resolution_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_report_id uuid NOT NULL REFERENCES incident_reports (id) ON DELETE CASCADE,
  line_no integer NOT NULL CHECK (line_no > 0),
  action_type varchar(40) NOT NULL,
  product_id uuid NOT NULL REFERENCES products (id),
  lot_id uuid REFERENCES product_lots (id),
  unit_level_id uuid REFERENCES product_unit_levels (id),
  product_code_snapshot varchar(80),
  product_name_snapshot text NOT NULL,
  lot_no_snapshot varchar(120),
  exp_date_snapshot date,
  qty numeric(12,3) NOT NULL CHECK (qty > 0),
  unit_label_snapshot text,
  note_text text,
  patient_pid_snapshot varchar(30),
  patient_full_name_snapshot text,
  patient_english_name_snapshot text,
  patient_birth_date_snapshot date,
  patient_sex_snapshot varchar(20),
  patient_card_issue_place_snapshot text,
  patient_card_issued_date_snapshot date,
  patient_card_expiry_date_snapshot date,
  patient_address_text_snapshot text,
  applied_stock_movement_id uuid REFERENCES stock_movements (id),
  applied_dispense_header_id uuid REFERENCES dispense_headers (id),
  applied_dispense_line_id uuid REFERENCES dispense_lines (id),
  applied_by_user_id uuid REFERENCES users (id),
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_incident_report_resolution_actions_line UNIQUE (incident_report_id, line_no),
  CONSTRAINT ck_incident_report_resolution_actions_type
    CHECK (action_type IN ('STOCK_IN', 'STOCK_OUT', 'RETROSPECTIVE_DISPENSE')),
  CONSTRAINT ck_incident_report_resolution_actions_product_lot
    FOREIGN KEY (product_id, lot_id)
    REFERENCES product_lots (product_id, id),
  CONSTRAINT ck_incident_report_resolution_actions_product_unit_level
    FOREIGN KEY (product_id, unit_level_id)
    REFERENCES product_unit_levels (product_id, id),
  CONSTRAINT ck_incident_report_resolution_actions_dispense_refs
    CHECK (
      (applied_dispense_line_id IS NULL AND applied_dispense_header_id IS NULL)
      OR applied_dispense_header_id IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_incident_report_resolution_actions_incident_line
  ON incident_report_resolution_actions (incident_report_id, line_no);

CREATE INDEX IF NOT EXISTS idx_incident_report_resolution_actions_stock_movement
  ON incident_report_resolution_actions (applied_stock_movement_id);

CREATE INDEX IF NOT EXISTS idx_incident_report_resolution_actions_dispense_header
  ON incident_report_resolution_actions (applied_dispense_header_id);

COMMENT ON TABLE incident_report_resolution_actions IS
  'Applied corrective actions linked to a single incident report, including stock-only corrections and retrospective dispense creation.';

COMMENT ON COLUMN incident_report_resolution_actions.action_type IS
  'STOCK_IN/STOCK_OUT adjust inventory only; RETROSPECTIVE_DISPENSE creates dispense rows plus stock movement tied back to the incident.';

COMMIT;
