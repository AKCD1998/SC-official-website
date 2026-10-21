-- Additive SCCRM loyalty storage. Existing users/member_profiles are unchanged.
-- Based on 202605140002 (ledger/promotions), loyalty_cashier_claims.sql, and
-- 202606020001 (POS mirrors). Never run unrelated historical/backfill migrations.
CREATE TABLE public.promotions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(255) NOT NULL,
 type varchar(30) NOT NULL CHECK(type IN ('multiplier','fixed_bonus','threshold')),
 value numeric(12,2) NOT NULL CHECK(value>=0), condition_json jsonb NOT NULL DEFAULT '{}',
 starts_at timestamptz, ends_at timestamptz, is_active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(starts_at IS NULL OR ends_at IS NULL OR ends_at>starts_at)
);
CREATE TABLE public.point_ledger (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 amount integer NOT NULL, type varchar(30) NOT NULL CHECK(type IN ('purchase','redeem','adjustment','expire','promotion')),
 reference_id varchar(255), note varchar(255), created_by varchar(255) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX central_point_ledger_user_date ON public.point_ledger(user_id,created_at);

-- loyalty_cashier_claims.sql
-- Cashier-initiated loyalty claim tables for SCCRMonPOS desktop flow.
-- Points source-of-truth remains point_ledger (FK to users.id).
-- These tables add receipt detail and duplicate-claim prevention.

CREATE TABLE loyalty_claims (
  id                 TEXT PRIMARY KEY,
  receipt_no         TEXT NOT NULL,
  branch_code        TEXT NOT NULL,
  cashier_staff_code TEXT,
  sold_at            TIMESTAMPTZ,
  total_amount       NUMERIC(14, 2) NOT NULL,
  preview_points     INTEGER,
  awarded_points     INTEGER NOT NULL DEFAULT 0,
  user_id            UUID NOT NULL REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT loyalty_claims_branch_receipt_unique UNIQUE (branch_code, receipt_no)
);

CREATE INDEX idx_loyalty_claims_user_id ON loyalty_claims (user_id);

CREATE TABLE loyalty_claim_items (
  id           TEXT PRIMARY KEY,
  claim_id     TEXT NOT NULL REFERENCES loyalty_claims(id) ON DELETE CASCADE,
  product_code TEXT,
  product_name TEXT,
  qty          NUMERIC(14, 4) NOT NULL DEFAULT 0,
  unit_price   NUMERIC(14, 2) NOT NULL DEFAULT 0,
  line_total   NUMERIC(14, 2) NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.loyalty_claims ADD COLUMN promotion_snapshot jsonb NOT NULL DEFAULT '[]';
ALTER TABLE public.loyalty_claims ADD COLUMN promotion_revision varchar(64);

create table "crm_pos_sale_events" ("id" uuid default gen_random_uuid(), "branch_code" varchar(20) not null, "pos_code" varchar(50) null, "doc_no" varchar(255) not null, "doc_type" varchar(20) not null, "sale_at" timestamptz not null, "cashier_code" varchar(255) null, "gross_total" decimal(12, 2) not null default '0', "net_total" decimal(12, 2) not null default '0', "paid_total" decimal(12, 2) not null default '0', "ada_customer_code" varchar(255) null, "claim_status" varchar(20) not null default 'unclaimed', "source_system" varchar(100) null, "source_event_key" varchar(255) not null, "source_synced_at" timestamptz null, "tender_rows" jsonb not null default '[]', "raw_payload" jsonb not null default '{}', "created_at" timestamptz not null default CURRENT_TIMESTAMP, "updated_at" timestamptz not null default CURRENT_TIMESTAMP, constraint "crm_pos_sale_events_pkey" primary key ("id"));
alter table "crm_pos_sale_events" add constraint "crm_pos_sale_events_source_event_key_unique" unique ("source_event_key");
alter table "crm_pos_sale_events" add constraint "crm_pos_sale_events_branch_code_doc_no_unique" unique ("branch_code", "doc_no");

    CREATE INDEX IF NOT EXISTS idx_crm_pos_sale_events_sale_at
      ON crm_pos_sale_events (sale_at DESC)
  ;
create table "crm_pos_sale_line_events" ("id" uuid default gen_random_uuid(), "sale_event_id" uuid not null, "line_no" integer not null, "product_code" varchar(255) not null, "barcode" varchar(255) null, "qty" decimal(12, 2) not null default '0', "unit_code" varchar(100) null, "unit_name" varchar(255) null, "net_amount" decimal(12, 2) not null default '0', "discount_amount" decimal(12, 2) not null default '0', "lot_no" varchar(255) null, "expiry_date" date null, "raw_payload" jsonb not null default '{}', "created_at" timestamptz not null default CURRENT_TIMESTAMP, constraint "crm_pos_sale_line_events_pkey" primary key ("id"));
alter table "crm_pos_sale_line_events" add constraint "crm_pos_sale_line_events_sale_event_id_foreign" foreign key ("sale_event_id") references "crm_pos_sale_events" ("id") on delete CASCADE;
alter table "crm_pos_sale_line_events" add constraint "crm_pos_sale_line_events_sale_event_id_line_no_product_code_unique" unique ("sale_event_id", "line_no", "product_code");
create table "crm_pos_refund_events" ("id" uuid default gen_random_uuid(), "branch_code" varchar(20) not null, "pos_code" varchar(50) null, "refund_doc_no" varchar(255) not null, "original_doc_no" varchar(255) not null, "refund_at" timestamptz not null, "cashier_code" varchar(255) null, "refund_total" decimal(12, 2) not null default '0', "source_system" varchar(100) null, "source_event_key" varchar(255) not null, "source_synced_at" timestamptz null, "tender_rows" jsonb not null default '[]', "raw_payload" jsonb not null default '{}', "created_at" timestamptz not null default CURRENT_TIMESTAMP, "updated_at" timestamptz not null default CURRENT_TIMESTAMP, constraint "crm_pos_refund_events_pkey" primary key ("id"));
alter table "crm_pos_refund_events" add constraint "crm_pos_refund_events_source_event_key_unique" unique ("source_event_key");
alter table "crm_pos_refund_events" add constraint "crm_pos_refund_events_branch_code_refund_doc_no_unique" unique ("branch_code", "refund_doc_no");

    CREATE INDEX IF NOT EXISTS idx_crm_pos_refund_events_original_doc
      ON crm_pos_refund_events (branch_code, original_doc_no)
  ;
create table "crm_pos_refund_line_events" ("id" uuid default gen_random_uuid(), "refund_event_id" uuid not null, "line_no" integer not null, "product_code" varchar(255) not null, "qty" decimal(12, 2) not null default '0', "net_amount" decimal(12, 2) not null default '0', "lot_no" varchar(255) null, "expiry_date" date null, "raw_payload" jsonb not null default '{}', "created_at" timestamptz not null default CURRENT_TIMESTAMP, constraint "crm_pos_refund_line_events_pkey" primary key ("id"));
alter table "crm_pos_refund_line_events" add constraint "crm_pos_refund_line_events_refund_event_id_foreign" foreign key ("refund_event_id") references "crm_pos_refund_events" ("id") on delete CASCADE;
alter table "crm_pos_refund_line_events" add constraint "crm_pos_refund_line_events_refund_event_id_line_no_product_code_unique" unique ("refund_event_id", "line_no", "product_code");
create table "crm_sale_claim_tokens" ("id" uuid default gen_random_uuid(), "branch_code" varchar(20) not null, "doc_no" varchar(255) not null, "token_hash" varchar(255) not null, "source_event_key" varchar(255) not null, "expires_at" timestamptz not null, "issued_at" timestamptz not null default CURRENT_TIMESTAMP, "used_at" timestamptz null, constraint "crm_sale_claim_tokens_pkey" primary key ("id"));
alter table "crm_sale_claim_tokens" add constraint "crm_sale_claim_tokens_token_hash_unique" unique ("token_hash");

    CREATE INDEX IF NOT EXISTS idx_crm_sale_claim_tokens_doc
      ON crm_sale_claim_tokens (branch_code, doc_no, issued_at DESC)
  ;
create table "crm_sale_claims" ("id" uuid default gen_random_uuid(), "sale_event_id" uuid not null, "customer_account_id" uuid not null, "claim_token_id" uuid not null, "claim_channel" varchar(50) not null default 'mobile', "claimed_at" timestamptz not null default CURRENT_TIMESTAMP, constraint "crm_sale_claims_pkey" primary key ("id"));
alter table "crm_sale_claims" add constraint "crm_sale_claims_sale_event_id_foreign" foreign key ("sale_event_id") references "crm_pos_sale_events" ("id") on delete CASCADE;
alter table "crm_sale_claims" add constraint "crm_sale_claims_customer_account_id_foreign" foreign key ("customer_account_id") references "users" ("id") on delete CASCADE;
alter table "crm_sale_claims" add constraint "crm_sale_claims_claim_token_id_foreign" foreign key ("claim_token_id") references "crm_sale_claim_tokens" ("id") on delete RESTRICT;
alter table "crm_sale_claims" add constraint "crm_sale_claims_sale_event_id_unique" unique ("sale_event_id");
create table "crm_loyalty_awards" ("id" uuid default gen_random_uuid(), "sale_event_id" uuid not null, "customer_account_id" uuid not null, "points_awarded" integer not null, "promotion_snapshot" jsonb not null default '[]', "ledger_entry_id" uuid not null, "created_at" timestamptz not null default CURRENT_TIMESTAMP, constraint "crm_loyalty_awards_pkey" primary key ("id"));
alter table "crm_loyalty_awards" add constraint "crm_loyalty_awards_sale_event_id_foreign" foreign key ("sale_event_id") references "crm_pos_sale_events" ("id") on delete CASCADE;
alter table "crm_loyalty_awards" add constraint "crm_loyalty_awards_customer_account_id_foreign" foreign key ("customer_account_id") references "users" ("id") on delete CASCADE;
alter table "crm_loyalty_awards" add constraint "crm_loyalty_awards_ledger_entry_id_foreign" foreign key ("ledger_entry_id") references "point_ledger" ("id") on delete CASCADE;
alter table "crm_loyalty_awards" add constraint "crm_loyalty_awards_sale_event_id_unique" unique ("sale_event_id");
create table "crm_loyalty_reversals" ("id" uuid default gen_random_uuid(), "refund_event_id" uuid not null, "customer_account_id" uuid not null, "points_reversed" integer not null, "original_award_id" uuid not null, "ledger_entry_id" uuid not null, "created_at" timestamptz not null default CURRENT_TIMESTAMP, constraint "crm_loyalty_reversals_pkey" primary key ("id"));
alter table "crm_loyalty_reversals" add constraint "crm_loyalty_reversals_refund_event_id_foreign" foreign key ("refund_event_id") references "crm_pos_refund_events" ("id") on delete CASCADE;
alter table "crm_loyalty_reversals" add constraint "crm_loyalty_reversals_customer_account_id_foreign" foreign key ("customer_account_id") references "users" ("id") on delete CASCADE;
alter table "crm_loyalty_reversals" add constraint "crm_loyalty_reversals_original_award_id_foreign" foreign key ("original_award_id") references "crm_loyalty_awards" ("id") on delete CASCADE;
alter table "crm_loyalty_reversals" add constraint "crm_loyalty_reversals_ledger_entry_id_foreign" foreign key ("ledger_entry_id") references "point_ledger" ("id") on delete CASCADE;
alter table "crm_loyalty_reversals" add constraint "crm_loyalty_reversals_refund_event_id_unique" unique ("refund_event_id");
CREATE TABLE public.transactions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
 total_amount numeric(12,2) NOT NULL, point_earned integer NOT NULL DEFAULT 0,
 source varchar(30) NOT NULL CHECK(source IN ('pos_import','manual','online')), pos_ref_id varchar(255) UNIQUE,
 branch_id uuid REFERENCES public.branches(id), staff_device_id uuid REFERENCES public.staff_devices(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.redemptions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 points_used integer NOT NULL CHECK(points_used>0), reward_name varchar(255) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE relation_name text; browser_role text;
BEGIN
 FOREACH relation_name IN ARRAY ARRAY['promotions','point_ledger','loyalty_claims','loyalty_claim_items','crm_pos_sale_events','crm_pos_sale_line_events','crm_pos_refund_events','crm_pos_refund_line_events','crm_sale_claim_tokens','crm_sale_claims','crm_loyalty_awards','crm_loyalty_reversals','transactions','redemptions'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',relation_name);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC',relation_name);
  FOREACH browser_role IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=browser_role) THEN
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I',relation_name,browser_role);
   END IF;
  END LOOP;
 END LOOP;
END $$;
INSERT INTO public.crm_counter_schema_migrations(filename) VALUES('202610210001_central_promotions.sql');
