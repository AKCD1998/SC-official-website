BEGIN;
ALTER TABLE shopee_document_observations
  DROP CONSTRAINT IF EXISTS shopee_document_observations_result_status_check,
  DROP CONSTRAINT IF EXISTS shopee_document_observations_reason_code_check,
  DROP CONSTRAINT IF EXISTS shopee_document_observations_status_reason_check,
  DROP CONSTRAINT IF EXISTS shopee_document_observations_window_proof_check;
ALTER TABLE shopee_document_observations
  ADD CONSTRAINT shopee_document_observations_result_status_check CHECK (result_status IN ('no_file', 'unavailable')),
  ADD CONSTRAINT shopee_document_observations_reason_code_check CHECK (reason_code IN ('SHOPEE_ETAX_NO_DOCUMENT_FOR_DATE', 'SHOPEE_ETAX_DATE_OUTSIDE_AVAILABLE_WINDOW')),
  ADD CONSTRAINT shopee_document_observations_status_reason_check CHECK (
    (result_status = 'no_file' AND reason_code = 'SHOPEE_ETAX_NO_DOCUMENT_FOR_DATE') OR
    (result_status = 'unavailable' AND reason_code = 'SHOPEE_ETAX_DATE_OUTSIDE_AVAILABLE_WINDOW')
  ),
  ADD CONSTRAINT shopee_document_observations_window_proof_check CHECK (result_status <> 'unavailable' OR COALESCE((
    jsonb_typeof(source_validation) = 'object'
    AND source_validation ?& ARRAY['portalAccount','requestedDate','portalPath','endDateUnset','pickerLowerBoundVerified','earliestAvailableDate','requestedDateDisabled']
    AND source_validation - ARRAY['portalAccount','requestedDate','portalPath','endDateUnset','pickerLowerBoundVerified','earliestAvailableDate','requestedDateDisabled'] = '{}'::jsonb
    AND source_validation->>'portalAccount' = portal_account
    AND source_validation->>'requestedDate' = date_from::text
    AND source_validation->>'portalPath' = '/tax/download'
    AND source_validation->'endDateUnset' = 'true'::jsonb
    AND source_validation->'pickerLowerBoundVerified' = 'true'::jsonb
    AND source_validation->'requestedDateDisabled' = 'true'::jsonb
    AND jsonb_typeof(source_validation->'earliestAvailableDate') = 'string'
    AND source_validation->>'earliestAvailableDate' ~ '^\d{4}-\d{2}-\d{2}$'
    AND (source_validation->>'earliestAvailableDate')::date > date_from
  ), false));
COMMENT ON TABLE shopee_document_observations IS
  'Metadata evidence of authenticated exact daily e-Tax checks: successful empty search, or disabled requested date below an observed picker lower bound. No raw report, response body, signed URL, or customer PII.';
COMMIT;
