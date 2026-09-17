# Shopee e-Tax observed no-file evidence

`POST /api/agent/shopee/document-observations` (under the same deployment prefix as `sales-sources`) accepts JSON with the existing dedicated `SHOPEE_SALES_INGEST_TOKEN` bearer.

Exact example (replace the observed evidence, never synthesize a successful check):

```json
{
  "shopCode": "dr-morepen",
  "reportType": "etax-receipt-invoice",
  "dateFrom": "2026-09-16",
  "dateTo": "2026-09-16",
  "portalAccount": "mu3f314od9",
  "jobId": "dr-etax-20260916-check-1",
  "observedAt": "2026-09-17T09:00:00.000Z",
  "resultStatus": "no_file",
  "reasonCode": "SHOPEE_ETAX_NO_DOCUMENT_FOR_DATE",
  "sourceValidation": {
    "portalAccount": "mu3f314od9",
    "selectedDate": "2026-09-16",
    "exactDailyRangeVerified": true,
    "resultRowCount": 0,
    "searchResponseVerified": true,
    "searchEndpoint": "/api/v1/seller/tax-documents/list"
  }
}
```

The account must equal `142wuxqhgi` for `sc-drug-store` or `mu3f314od9` for `dr-morepen`. The agent must attest the profile and exact successful empty daily search response. A missing table, closed browser, authentication page, or failed request is not evidence of no document.

Response: `{ "status": "recorded" | "already_recorded", "jobId": "...", "resultStatus": "no_file", "recordedAt": "..." }`. Replaying the same canonical payload is idempotent. Changing evidence under the same job ID returns 409. Use a new job ID for a later check.

Migration 025 creates a separate append-only-by-service metadata ledger; no raw PDF, ZIP, response body, signed URL, customer details, or fabricated source hash is accepted. A content-ingested document always wins over no-file observations for the same day. Never-attempted dates remain missing/waiting according to schedule; only evidenced empty dates are `no_file`. No-file counts toward checked coverage but not downloaded file count or financial totals.

Rollout: merge tested code, run `shopee-observation-migrate.yml` with `APPLY_025_SHOPEE_OBSERVATIONS`, verify the ledger/schema, then verify a real agent POST and status cell. Existing full-document data remains unchanged.
