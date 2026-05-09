BEGIN;

CREATE SEQUENCE IF NOT EXISTS incident_report_running_no_seq START WITH 1 INCREMENT BY 1;

CREATE TABLE IF NOT EXISTS incident_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  running_no bigint NOT NULL UNIQUE DEFAULT nextval('incident_report_running_no_seq'),
  incident_code varchar(40) NOT NULL UNIQUE,
  incident_type varchar(80) NOT NULL,
  incident_reason varchar(160) NOT NULL,
  incident_description text NOT NULL,
  branch_id uuid NOT NULL REFERENCES locations (id),
  branch_code_snapshot varchar(30) NOT NULL,
  branch_name_snapshot text NOT NULL,
  reporter_user_id uuid NOT NULL REFERENCES users (id),
  acknowledged_by_admin_user_id uuid REFERENCES users (id),
  happened_at timestamptz NOT NULL,
  reported_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  closed_at timestamptz,
  status varchar(20) NOT NULL DEFAULT 'OPEN',
  smartcard_session_id varchar(120),
  dispense_attempt_id varchar(120),
  note_text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_incident_reports_status
    CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'CLOSED')),
  CONSTRAINT ck_incident_reports_closed_requires_acknowledged
    CHECK (closed_at IS NULL OR acknowledged_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_incident_reports_branch_happened_at
  ON incident_reports (branch_id, happened_at DESC);

CREATE INDEX IF NOT EXISTS idx_incident_reports_status_reported_at
  ON incident_reports (status, reported_at DESC);

CREATE INDEX IF NOT EXISTS idx_incident_reports_reporter_reported_at
  ON incident_reports (reporter_user_id, reported_at DESC);

CREATE INDEX IF NOT EXISTS idx_incident_reports_type_happened_at
  ON incident_reports (incident_type, happened_at DESC);

CREATE INDEX IF NOT EXISTS idx_incident_reports_reported_at
  ON incident_reports (reported_at DESC);

CREATE TABLE IF NOT EXISTS incident_report_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_report_id uuid NOT NULL REFERENCES incident_reports (id) ON DELETE CASCADE,
  line_no integer NOT NULL CHECK (line_no > 0),
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
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_incident_report_items_line UNIQUE (incident_report_id, line_no),
  CONSTRAINT fk_incident_report_items_product_lot
    FOREIGN KEY (product_id, lot_id)
    REFERENCES product_lots (product_id, id),
  CONSTRAINT fk_incident_report_items_product_unit_level
    FOREIGN KEY (product_id, unit_level_id)
    REFERENCES product_unit_levels (product_id, id)
);

CREATE INDEX IF NOT EXISTS idx_incident_report_items_incident_line
  ON incident_report_items (incident_report_id, line_no);

CREATE INDEX IF NOT EXISTS idx_incident_report_items_product
  ON incident_report_items (product_id);

CREATE INDEX IF NOT EXISTS idx_incident_report_items_lot
  ON incident_report_items (lot_id);

COMMENT ON TABLE incident_reports IS
  'Admin-only audit/governance records for abnormal events that must stay separate from dispense, patient, and stock transactions.';

COMMENT ON TABLE incident_report_items IS
  'Optional item rows attached to an incident report, storing product/lot snapshots for historical traceability.';

COMMENT ON COLUMN incident_reports.incident_code IS
  'Human-readable running identifier such as INC-000001.';

COMMENT ON COLUMN incident_reports.branch_code_snapshot IS
  'Branch code copied at report time so historical incident records stay readable even if master data changes.';

COMMENT ON COLUMN incident_report_items.product_name_snapshot IS
  'Product name copied at report time to preserve the historical context of the incident.';

COMMIT;
