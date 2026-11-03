-- Add source metadata only. Existing members, event dates and counts stay intact.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '15s';
ALTER TABLE crm_reporting.member_registrations
  ADD COLUMN IF NOT EXISTS referral_code text,
  ADD COLUMN IF NOT EXISTS pos_code text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='crm_reporting.member_registrations'::regclass
    AND conname='member_registrations_referral_origin_check') THEN
    ALTER TABLE crm_reporting.member_registrations ADD CONSTRAINT member_registrations_referral_origin_check CHECK (
      (referral_code IS NULL AND pos_code IS NULL) OR
      (referral_code IS NOT NULL AND pos_code IS NOT NULL AND branch_code IS NOT NULL AND source='qr'
        AND pos_code IN ('001','002') AND referral_code = branch_code || '-' || pos_code)
    );
  END IF;
END $$;
COMMENT ON COLUMN crm_reporting.member_registrations.referral_code IS
  'Public QR origin, resolved by server allowlist; records source, not authenticated physical location.';
