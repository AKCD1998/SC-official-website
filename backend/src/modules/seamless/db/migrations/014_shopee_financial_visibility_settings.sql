BEGIN;

CREATE TABLE IF NOT EXISTS shopee_financial_visibility_settings (
  setting_key text PRIMARY KEY,
  user_can_view_unit_price boolean NOT NULL DEFAULT false,
  user_can_view_shipping_fee boolean NOT NULL DEFAULT false,
  user_can_view_total_amount boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL DEFAULT 'system',
  CONSTRAINT shopee_financial_visibility_singleton_check
    CHECK (setting_key = 'user')
);

INSERT INTO shopee_financial_visibility_settings (
  setting_key,
  user_can_view_unit_price,
  user_can_view_shipping_fee,
  user_can_view_total_amount,
  updated_by
) VALUES ('user', false, false, false, 'migration-default')
ON CONFLICT (setting_key) DO NOTHING;

COMMIT;
