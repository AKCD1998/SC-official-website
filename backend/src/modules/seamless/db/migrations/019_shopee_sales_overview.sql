BEGIN;
ALTER TABLE shopee_confirmed_daily_facts
  ALTER COLUMN cancelled_sales DROP NOT NULL,
  ALTER COLUMN cancelled_order_count DROP NOT NULL,
  ALTER COLUMN returned_sales DROP NOT NULL,
  ALTER COLUMN returned_order_count DROP NOT NULL;
COMMENT ON TABLE shopee_confirmed_daily_facts IS
  'Official Shopee Business Insights facts. The legacy Confirmed sheet includes cancellation/return fields; the current Sales Overview report does not, so unavailable fields remain NULL rather than fabricated zeroes.';
COMMIT;
