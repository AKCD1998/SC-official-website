-- Preserve the POS paid total separately from the existing eligible point total.
-- Immutable item/header snapshots retain original order and available POS fields.
-- No historic amount is guessed or rewritten.
ALTER TABLE public.loyalty_claims
 ADD COLUMN receipt_total_amount numeric(14,2) CHECK(receipt_total_amount>=0),
 ADD COLUMN receipt_snapshot jsonb;
CREATE INDEX loyalty_claims_member_history_idx ON public.loyalty_claims
 (user_id,(COALESCE(sold_at,created_at)) DESC,created_at DESC,id DESC);
CREATE INDEX loyalty_claim_items_claim_idx ON public.loyalty_claim_items(claim_id);
INSERT INTO public.crm_counter_schema_migrations(filename) VALUES('202610210002_purchase_history.sql');
