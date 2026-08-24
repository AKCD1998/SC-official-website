BEGIN;

-- Parsed, privacy-safe Shopee order timeline. Gmail remains the source of evidence, but the app
-- stores only business fields needed for order tracking. Raw email bodies, subjects, buyer
-- usernames, addresses, phone numbers, and recipient names must never be written here.
CREATE TABLE IF NOT EXISTS shopee_orders (
  order_number text PRIMARY KEY CHECK (order_number ~ '^[A-Z0-9]{8,40}$'),
  current_status text NOT NULL CHECK (current_status IN (
    'order_confirmed',
    'shipment_due',
    'seller_return_delivery',
    'order_cancelled'
  )),
  ordered_at timestamptz,
  shipping_deadline date,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  item_count integer NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  total_quantity integer NOT NULL DEFAULT 0 CHECK (total_quantity >= 0),
  item_subtotal numeric(14, 2),
  shipping_fee numeric(14, 2),
  total_amount numeric(14, 2),
  delivery_method text,
  first_event_at timestamptz NOT NULL,
  last_event_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE shopee_orders IS 'Privacy-safe current state derived from Shopee notification emails. One row per order number; raw Gmail content and buyer PII are intentionally excluded.';
COMMENT ON COLUMN shopee_orders.items IS 'Parsed product name, variant, quantity, and unit price only. Never include buyer/recipient fields or unbounded raw email text.';

CREATE INDEX IF NOT EXISTS idx_shopee_orders_last_event_at
  ON shopee_orders (last_event_at DESC, order_number DESC);
CREATE INDEX IF NOT EXISTS idx_shopee_orders_current_status
  ON shopee_orders (current_status, last_event_at DESC);
CREATE INDEX IF NOT EXISTS idx_shopee_orders_shipping_deadline
  ON shopee_orders (shipping_deadline) WHERE shipping_deadline IS NOT NULL;

DROP TRIGGER IF EXISTS trg_shopee_orders_updated_at ON shopee_orders;
CREATE TRIGGER trg_shopee_orders_updated_at
BEFORE UPDATE ON shopee_orders
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS shopee_order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number text NOT NULL REFERENCES shopee_orders(order_number) ON DELETE CASCADE,
  mailbox_account text NOT NULL,
  gmail_message_id text NOT NULL,
  gmail_thread_id text,
  event_type text NOT NULL CHECK (event_type IN (
    'order_confirmed',
    'shipment_due',
    'seller_return_delivery',
    'order_cancelled'
  )),
  occurred_at timestamptz NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mailbox_account, gmail_message_id)
);

COMMENT ON TABLE shopee_order_events IS 'Append-only, Gmail-message-idempotent Shopee order events. details is bounded parsed evidence only; never raw body/subject or buyer PII.';

CREATE INDEX IF NOT EXISTS idx_shopee_order_events_order_occurred_at
  ON shopee_order_events (order_number, occurred_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_shopee_order_events_gmail_message
  ON shopee_order_events (mailbox_account, gmail_message_id);

COMMIT;
