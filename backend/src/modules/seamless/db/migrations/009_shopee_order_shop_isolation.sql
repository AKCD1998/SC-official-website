BEGIN;

-- Legacy rows cannot be attributed to a Shopee shop from the bounded persistence fields in
-- migration 008. Quarantine them under a non-routable sentinel instead of guessing from an
-- order number, Gmail account, subject, or message body. Application writes accept only the
-- two supported real shop codes, so this value is migration-only until a separately reviewed
-- evidence-based reconciliation is available.
ALTER TABLE shopee_orders ADD COLUMN shop_code text;
ALTER TABLE shopee_order_events ADD COLUMN shop_code text;
ALTER TABLE shopee_order_events ADD COLUMN canonical_message_key text;

UPDATE shopee_orders
SET shop_code = 'legacy-unattributed'
WHERE shop_code IS NULL;

UPDATE shopee_order_events
SET
  shop_code = 'legacy-unattributed',
  canonical_message_key = 'legacy:' || md5(lower(mailbox_account) || ':' || gmail_message_id)
WHERE shop_code IS NULL OR canonical_message_key IS NULL;

ALTER TABLE shopee_orders
  ALTER COLUMN shop_code SET NOT NULL,
  ADD CONSTRAINT shopee_orders_shop_code_check
    CHECK (shop_code IN ('sc-drug-store', 'dr-morepen', 'legacy-unattributed'));

ALTER TABLE shopee_order_events
  ALTER COLUMN shop_code SET NOT NULL,
  ALTER COLUMN canonical_message_key SET NOT NULL,
  ADD CONSTRAINT shopee_order_events_shop_code_check
    CHECK (shop_code IN ('sc-drug-store', 'dr-morepen', 'legacy-unattributed')),
  ADD CONSTRAINT shopee_order_events_canonical_message_key_check
    CHECK (canonical_message_key ~ '^(sha256:[a-f0-9]{64}|legacy:[a-f0-9]{32})$');

ALTER TABLE shopee_order_events
  DROP CONSTRAINT shopee_order_events_order_number_fkey;

ALTER TABLE shopee_orders
  DROP CONSTRAINT shopee_orders_pkey,
  ADD CONSTRAINT shopee_orders_pkey PRIMARY KEY (shop_code, order_number);

ALTER TABLE shopee_order_events
  ADD CONSTRAINT shopee_order_events_shop_order_fkey
    FOREIGN KEY (shop_code, order_number)
    REFERENCES shopee_orders (shop_code, order_number)
    ON DELETE CASCADE,
  ADD CONSTRAINT shopee_order_events_canonical_message_key_key
    UNIQUE (canonical_message_key);

DROP INDEX IF EXISTS idx_shopee_orders_last_event_at;
DROP INDEX IF EXISTS idx_shopee_orders_current_status;
DROP INDEX IF EXISTS idx_shopee_orders_shipping_deadline;
DROP INDEX IF EXISTS idx_shopee_order_events_order_occurred_at;

CREATE INDEX idx_shopee_orders_shop_last_event_at
  ON shopee_orders (shop_code, last_event_at DESC, order_number DESC);
CREATE INDEX idx_shopee_orders_shop_status
  ON shopee_orders (shop_code, current_status, last_event_at DESC, order_number DESC);
CREATE INDEX idx_shopee_orders_shop_shipping_deadline
  ON shopee_orders (shop_code, shipping_deadline)
  WHERE shipping_deadline IS NOT NULL;
CREATE INDEX idx_shopee_order_events_shop_order_occurred_at
  ON shopee_order_events (shop_code, order_number, occurred_at ASC, id ASC);

COMMENT ON TABLE shopee_orders IS 'Privacy-safe Shopee order state keyed by shop_code and order_number. Legacy migration rows remain quarantined as legacy-unattributed until evidence-based reconciliation.';
COMMENT ON TABLE shopee_order_events IS 'Append-only, shop-scoped Shopee events with a privacy-safe canonical hash used for cross-mailbox deduplication. Never store raw headers, subject, body, or buyer PII.';
COMMENT ON COLUMN shopee_order_events.canonical_message_key IS 'Versioned SHA-256 key derived from stable email identity, or a migration-only legacy hash. Raw Message-ID and subject are not persisted.';

COMMIT;
