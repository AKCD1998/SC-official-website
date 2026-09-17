BEGIN;

ALTER TABLE shopee_sales_ingest_jobs
  DROP CONSTRAINT IF EXISTS shopee_sales_ingest_jobs_report_type_check;
ALTER TABLE shopee_sales_ingest_jobs
  ADD CONSTRAINT shopee_sales_ingest_jobs_report_type_check CHECK (report_type IN (
    'business-insights',
    'orders',
    'financial-statement',
    'seller-balance',
    'income-transferred',
    'income-pending',
    'return-refund-cancel',
    'etax-receipt-invoice'
  ));

ALTER TABLE shopee_official_document_sources
  DROP CONSTRAINT IF EXISTS shopee_official_document_sources_report_type_check;
ALTER TABLE shopee_official_document_sources
  ADD CONSTRAINT shopee_official_document_sources_report_type_check CHECK (report_type IN (
    'financial-statement',
    'seller-balance',
    'income-transferred',
    'income-pending',
    'return-refund-cancel',
    'etax-receipt-invoice'
  ));

COMMENT ON TABLE shopee_official_document_sources IS
  'Immutable audit for official Shopee Finance, return/refund/cancel, and e-Tax exports. Raw e-Tax archives and customer PII remain on the isolated HQ agent; this table stores only validated provenance and aggregate controls.';

COMMIT;

