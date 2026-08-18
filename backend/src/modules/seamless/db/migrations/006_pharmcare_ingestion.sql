-- NOTE on the duplicate "006" prefix: 006_add_shopee_document_type.sql (Shopee workstream) and
-- this file (PharmCare workstream) were authored around the same time in different features and
-- both shipped as the sixth migration. This is intentional, not a bug: the runner keys applied
-- migrations by FULL filename in schema_migrations, and production already applied BOTH under
-- these exact names — renaming this file now would desync migration state and re-apply it.
-- New migrations must take the next free number (007+).

BEGIN;

-- PharmCare finance email ingestion (Milestone 1: read-only inbox). Deliberately kept separate
-- from processing_records/generated_files/print_jobs — PharmCare documents are not workbooks and
-- must not be forced into the existing report_type='individual'/'summary' shape. See
-- docs/13-pharmcare-finance-email-automation.md and docs/14-pharmcare-sonnet-implementation-plan.md.

CREATE TABLE IF NOT EXISTS pharmcare_email_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_account text NOT NULL,
  gmail_message_id text NOT NULL,
  gmail_thread_id text,
  route text NOT NULL CHECK (route IN ('direct', 'gmail_filter_forward', 'manual_forward')),
  visible_from text,
  visible_to text,
  visible_cc text,
  raw_subject text,
  normalized_subject text,
  original_from text,
  original_subject text,
  original_date text,
  received_at timestamptz,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'manual_review' CHECK (status IN ('classified', 'manual_review', 'failed')),
  classifier_version text,
  error_code text,
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mailbox_account, gmail_message_id)
);

COMMENT ON TABLE pharmcare_email_messages IS 'One row per ingested Gmail message from the PharmCare automation mailbox; message-level idempotency key is (mailbox_account, gmail_message_id).';
COMMENT ON COLUMN pharmcare_email_messages.route IS 'direct is reserved for a future true direct-delivery path; today every message is gmail_filter_forward or manual_forward.';
COMMENT ON COLUMN pharmcare_email_messages.original_from IS 'Resolved original sender: the visible From for gmail_filter_forward, or the parsed forwarded-block From for manual_forward.';
COMMENT ON COLUMN pharmcare_email_messages.original_date IS 'Free-text Date header parsed from a manual forward block; not a typed timestamp because format varies by mail client.';

CREATE INDEX IF NOT EXISTS idx_pharmcare_email_messages_status ON pharmcare_email_messages (status);
CREATE INDEX IF NOT EXISTS idx_pharmcare_email_messages_route ON pharmcare_email_messages (route);
CREATE INDEX IF NOT EXISTS idx_pharmcare_email_messages_received_at ON pharmcare_email_messages (received_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_pharmcare_email_messages_ingested_at ON pharmcare_email_messages (ingested_at DESC);

DROP TRIGGER IF EXISTS trg_pharmcare_email_messages_updated_at ON pharmcare_email_messages;
CREATE TRIGGER trg_pharmcare_email_messages_updated_at
BEFORE UPDATE ON pharmcare_email_messages
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS pharmcare_email_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES pharmcare_email_messages(id) ON DELETE CASCADE,
  gmail_attachment_id text NOT NULL,
  original_filename text NOT NULL,
  mime_type text,
  file_size_bytes bigint CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
  checksum_sha256 char(64) CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-fA-F]{64}$'),
  storage_provider text NOT NULL DEFAULT 'local' CHECK (storage_provider IN ('local', 'r2')),
  storage_path text,
  duplicate_of_attachment_id uuid REFERENCES pharmcare_email_attachments(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'stored' CHECK (status IN ('stored', 'duplicate', 'failed')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, gmail_attachment_id)
);

COMMENT ON TABLE pharmcare_email_attachments IS 'Every attachment seen per ingested message. duplicate_of_attachment_id links a byte-identical attachment (same SHA-256) that arrived on a different message/forward path back to the canonical stored copy, without discarding the evidence that it also arrived here.';
COMMENT ON COLUMN pharmcare_email_attachments.checksum_sha256 IS 'Not unique: the same document legitimately arrives on multiple messages (gmail filter + manual forward); duplicate_of_attachment_id records that relationship instead.';

CREATE INDEX IF NOT EXISTS idx_pharmcare_email_attachments_message_id ON pharmcare_email_attachments (message_id);
CREATE INDEX IF NOT EXISTS idx_pharmcare_email_attachments_checksum_sha256 ON pharmcare_email_attachments (checksum_sha256);
CREATE INDEX IF NOT EXISTS idx_pharmcare_email_attachments_status ON pharmcare_email_attachments (status);

DROP TRIGGER IF EXISTS trg_pharmcare_email_attachments_updated_at ON pharmcare_email_attachments;
CREATE TRIGGER trg_pharmcare_email_attachments_updated_at
BEFORE UPDATE ON pharmcare_email_attachments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS pharmcare_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES pharmcare_email_messages(id) ON DELETE CASCADE,
  attachment_id uuid REFERENCES pharmcare_email_attachments(id) ON DELETE SET NULL,
  document_type text NOT NULL CHECK (document_type IN ('e_credit_invoice', 'settlement_mrr', 'settlement_sfr', 'receipt_link_pending', 'contract', 'unknown')),
  document_number text,
  partner_code text,
  period_start date,
  period_end date,
  half text CHECK (half IS NULL OR half IN ('H1', 'H2')),
  source_url text,
  review_status text NOT NULL DEFAULT 'auto_classified' CHECK (review_status IN ('auto_classified', 'manual_review', 'duplicate', 'conflict')),
  duplicate_of_document_id uuid REFERENCES pharmcare_documents(id) ON DELETE SET NULL,
  classifier_version text,
  reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE pharmcare_documents IS 'One row per classified financial/contract document evidenced by a message+attachment (or a no-attachment receipt/tax link). attachment_id is null for receipt_link_pending rows.';
COMMENT ON COLUMN pharmcare_documents.document_number IS 'Business dedup key such as a CIV number; same document_number with a different checksum on the linked attachment is a conflict, not an automatic overwrite.';
COMMENT ON COLUMN pharmcare_documents.reason_codes IS 'Evidence codes from the classifier (e.g. filename_pattern_match, sender_not_allowlisted) — never just a pass/fail boolean, so review and audit can see why.';

CREATE INDEX IF NOT EXISTS idx_pharmcare_documents_message_id ON pharmcare_documents (message_id);
CREATE INDEX IF NOT EXISTS idx_pharmcare_documents_attachment_id ON pharmcare_documents (attachment_id);
CREATE INDEX IF NOT EXISTS idx_pharmcare_documents_document_type ON pharmcare_documents (document_type);
CREATE INDEX IF NOT EXISTS idx_pharmcare_documents_document_number ON pharmcare_documents (document_number);
CREATE INDEX IF NOT EXISTS idx_pharmcare_documents_review_status ON pharmcare_documents (review_status);
CREATE INDEX IF NOT EXISTS idx_pharmcare_documents_created_at ON pharmcare_documents (created_at DESC);

DROP TRIGGER IF EXISTS trg_pharmcare_documents_updated_at ON pharmcare_documents;
CREATE TRIGGER trg_pharmcare_documents_updated_at
BEFORE UPDATE ON pharmcare_documents
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
