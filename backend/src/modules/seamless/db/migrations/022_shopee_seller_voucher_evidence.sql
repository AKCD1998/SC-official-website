BEGIN;

-- NULL means an older immutable Order All source has not yet been replayed
-- through the voucher-code parser.  [] means the exact source was parsed and
-- contained no voucher code for that order.
ALTER TABLE shopee_sales_order_facts
  ADD COLUMN IF NOT EXISTS voucher_codes jsonb;

ALTER TABLE shopee_sales_order_facts
  DROP CONSTRAINT IF EXISTS shopee_sales_order_facts_voucher_codes_check;
ALTER TABLE shopee_sales_order_facts
  ADD CONSTRAINT shopee_sales_order_facts_voucher_codes_check
  CHECK (voucher_codes IS NULL OR jsonb_typeof(voucher_codes) = 'array');

COMMENT ON COLUMN shopee_sales_order_facts.voucher_codes IS
  'Privacy-safe voucher identifiers parsed from the exact Order All bytes. NULL is not equivalent to an observed empty list.';

CREATE TABLE IF NOT EXISTS shopee_seller_voucher_evidence (
  shop_code text NOT NULL CHECK (shop_code IN ('sc-drug-store', 'dr-morepen')),
  voucher_id text NOT NULL CHECK (voucher_id ~ '^SVC-[0-9]{10,30}$'),
  voucher_name text NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz NOT NULL CHECK (valid_to >= valid_from),
  discount_rate numeric(9,8) NOT NULL CHECK (discount_rate > 0 AND discount_rate <= 1),
  max_discount numeric(14,2) NOT NULL CHECK (max_discount >= 0),
  min_spend numeric(14,2) NOT NULL CHECK (min_spend >= 0),
  applies_to_all_products boolean NOT NULL,
  source_url text NOT NULL CHECK (source_url LIKE 'https://seller.shopee.co.th/%'),
  source_observed_at timestamptz NOT NULL,
  source_observed_precision text NOT NULL CHECK (source_observed_precision IN ('timestamp', 'date')),
  source_notes text NOT NULL,
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_code, voucher_id, valid_from)
);

CREATE INDEX IF NOT EXISTS idx_shopee_seller_voucher_evidence_period
  ON shopee_seller_voucher_evidence (shop_code, valid_from, valid_to, voucher_id);

COMMENT ON TABLE shopee_seller_voucher_evidence IS
  'Explicit Shopee Seller Centre campaign evidence. A voucher code alone never authorizes a financial restoration.';

-- Direct Seller Centre voucher-detail evidence observed during the accounting
-- review.  The UI displayed the end as 23:59, so valid_to represents the end
-- of that displayed minute.  The observation was recorded at date precision;
-- midnight is a storage convention, not a claimed screen-capture time.
INSERT INTO shopee_seller_voucher_evidence (
  shop_code, voucher_id, voucher_name, valid_from, valid_to,
  discount_rate, max_discount, min_spend, applies_to_all_products,
  source_url, source_observed_at, source_observed_precision, source_notes, recorded_by
) VALUES (
  'sc-drug-store',
  'SVC-1489610191827020',
  'VCMT BAU 24-30 Aug',
  '2026-08-24 00:00:00+07',
  '2026-08-30 23:59:59.999+07',
  0.05,
  10.00,
  110.00,
  true,
  'https://seller.shopee.co.th/portal/marketing/vouchers/view?edit=1489610191827020',
  '2026-09-10 00:00:00+07',
  'date',
  'Seller Centre voucher detail confirms 5%, maximum THB 10, minimum spend THB 110, all products, valid 24-30 Aug 2026. Observation is date-precision.',
  'accounting-review'
)
ON CONFLICT (shop_code, voucher_id, valid_from) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM shopee_seller_voucher_evidence
    WHERE shop_code = 'sc-drug-store'
      AND voucher_id = 'SVC-1489610191827020'
      AND voucher_name = 'VCMT BAU 24-30 Aug'
      AND valid_from = '2026-08-24 00:00:00+07'::timestamptz
      AND valid_to = '2026-08-30 23:59:59.999+07'::timestamptz
      AND discount_rate = 0.05
      AND max_discount = 10.00
      AND min_spend = 110.00
      AND applies_to_all_products = true
      AND source_url = 'https://seller.shopee.co.th/portal/marketing/vouchers/view?edit=1489610191827020'
      AND source_observed_at = '2026-09-10 00:00:00+07'::timestamptz
      AND source_observed_precision = 'date'
      AND source_notes = 'Seller Centre voucher detail confirms 5%, maximum THB 10, minimum spend THB 110, all products, valid 24-30 Aug 2026. Observation is date-precision.'
      AND recorded_by = 'accounting-review'
  ) THEN
    RAISE EXCEPTION 'Existing seller-voucher campaign evidence conflicts with migration 022';
  END IF;
END $$;

COMMIT;
