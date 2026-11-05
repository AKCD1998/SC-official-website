-- Add the storage already defined by 202606120002_member_pharmacy_med_records.cjs.
-- No customer/profile, Ada, purchase or point rows are rewritten or copied.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '15s';
CREATE TABLE IF NOT EXISTS public.member_pharmacy_med_records (
  member_id text PRIMARY KEY,
  pid_document_type text, pid_document_number_raw text, pid_document_number_normalized text,
  weight_kg numeric(5,2), height_cm numeric(5,2), bp_systolic integer, bp_diastolic integer,
  blood_type text, blood_rh text,
  has_diabetes boolean NOT NULL DEFAULT false,
  has_hypertension boolean NOT NULL DEFAULT false,
  has_hyperlipidemia boolean NOT NULL DEFAULT false,
  has_heart_disease boolean NOT NULL DEFAULT false,
  has_kidney_disease boolean NOT NULL DEFAULT false,
  has_liver_disease boolean NOT NULL DEFAULT false,
  has_thyroid_disease boolean NOT NULL DEFAULT false,
  other_conditions text, drug_allergies text, food_allergies text,
  current_medications text, medical_history text,
  is_smoker boolean NOT NULL DEFAULT false,
  drinks_alcohol boolean NOT NULL DEFAULT false,
  is_pregnant boolean NOT NULL DEFAULT false,
  is_breastfeeding boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_member_pharmacy_med_records_member_id
  ON public.member_pharmacy_med_records(member_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_member_pharmacy_med_records_pid_document
  ON public.member_pharmacy_med_records(pid_document_type,pid_document_number_normalized)
  WHERE pid_document_type IS NOT NULL AND pid_document_number_normalized IS NOT NULL;
ALTER TABLE public.member_pharmacy_med_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.member_pharmacy_med_records FROM PUBLIC;
DO $$
DECLARE browser_role text;
BEGIN
  FOREACH browser_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=browser_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.member_pharmacy_med_records FROM %I',browser_role);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    REVOKE ALL ON TABLE public.member_pharmacy_med_records FROM service_role;
    GRANT SELECT,INSERT,UPDATE ON TABLE public.member_pharmacy_med_records TO service_role;
  END IF;
END $$;
