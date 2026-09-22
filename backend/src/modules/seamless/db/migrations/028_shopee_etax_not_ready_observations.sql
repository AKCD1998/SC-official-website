BEGIN;
ALTER TABLE shopee_document_observations
  DROP CONSTRAINT IF EXISTS shopee_document_observations_result_status_check,
  DROP CONSTRAINT IF EXISTS shopee_document_observations_reason_code_check,
  DROP CONSTRAINT IF EXISTS shopee_document_observations_status_reason_check,
  DROP CONSTRAINT IF EXISTS shopee_document_observations_not_ready_proof_check;
ALTER TABLE shopee_document_observations
  ADD CONSTRAINT shopee_document_observations_result_status_check
    CHECK (result_status IN ('no_file', 'unavailable', 'not_ready')),
  ADD CONSTRAINT shopee_document_observations_reason_code_check
    CHECK (reason_code IN ('SHOPEE_ETAX_NO_DOCUMENT_FOR_DATE', 'SHOPEE_ETAX_DATE_OUTSIDE_AVAILABLE_WINDOW', 'SHOPEE_ETAX_DOCUMENT_NOT_READY')),
  ADD CONSTRAINT shopee_document_observations_status_reason_check CHECK (
    (result_status = 'no_file' AND reason_code = 'SHOPEE_ETAX_NO_DOCUMENT_FOR_DATE') OR
    (result_status = 'unavailable' AND reason_code = 'SHOPEE_ETAX_DATE_OUTSIDE_AVAILABLE_WINDOW') OR
    (result_status = 'not_ready' AND reason_code = 'SHOPEE_ETAX_DOCUMENT_NOT_READY')
  ),
  ADD CONSTRAINT shopee_document_observations_not_ready_proof_check CHECK (result_status <> 'not_ready' OR COALESCE((
    jsonb_typeof(source_validation) = 'object'
    AND source_validation ?& ARRAY['portalAccount','selectedDate','exactDailyRangeVerified','resultRowCount','searchResponseVerified','searchEndpoint','documentStatusText','retryExhausted','attemptsObserved']
    AND source_validation - ARRAY['portalAccount','selectedDate','exactDailyRangeVerified','resultRowCount','searchResponseVerified','searchEndpoint','documentStatusText','retryExhausted','attemptsObserved'] = '{}'::jsonb
    AND source_validation->>'portalAccount' = portal_account
    AND source_validation->>'selectedDate' = date_from::text
    AND source_validation->'exactDailyRangeVerified' = 'true'::jsonb
    AND source_validation->'resultRowCount' = '1'::jsonb
    AND source_validation->'searchResponseVerified' = 'true'::jsonb
    AND source_validation->>'searchEndpoint' = '/api/v1/seller/tax-documents/list'
    AND jsonb_typeof(source_validation->'documentStatusText') = 'string'
    AND length(btrim(source_validation->>'documentStatusText')) BETWEEN 1 AND 200
    AND source_validation->'retryExhausted' = 'true'::jsonb
    AND jsonb_typeof(source_validation->'attemptsObserved') = 'number'
    AND (source_validation->>'attemptsObserved')::integer >= 4
  ), false));
COMMENT ON TABLE shopee_document_observations IS
  'Metadata evidence of authenticated exact daily e-Tax checks: empty search, unavailable date, or a row still not downloadable after bounded retries. No raw report, signed URL, or customer PII.';
COMMIT;
