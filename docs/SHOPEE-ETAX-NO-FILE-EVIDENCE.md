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

## Observed date outside the available window (migration 026)

The same endpoint also accepts `resultStatus: "unavailable"`, `reasonCode: "SHOPEE_ETAX_DATE_OUTSIDE_AVAILABLE_WINDOW"`, with the same exact top-level fields and this different exact proof object:

```json
{
  "portalAccount": "mu3f314od9",
  "requestedDate": "2026-03-17",
  "portalPath": "/tax/download",
  "endDateUnset": true,
  "pickerLowerBoundVerified": true,
  "earliestAvailableDate": "2026-03-18",
  "requestedDateDisabled": true
}
```

`dateFrom = dateTo = requestedDate < earliestAvailableDate`. The observed bound must be a real valid date, not future relative to the observation in Bangkok. The authenticated shop/account must be attested, the picker inspected with end date unset, and the requested date actually disabled below the observed lower bound. Authentication failures, empty UI, and inferred rolling-window dates must never generate this proof. No proof from one shop is valid for the other.

The response preserves `resultStatus: "unavailable"`. The server validates and stores the supplied bounded attestation; it does not independently inspect the browser. A later fresh check requires a new job ID. Existing `no_file` canonical hashes remain unchanged.

Status cells retain `unavailable` with reason and `earliestAvailableDate`, labeled `ตรวจแล้ว: Shopee ไม่เปิดให้เลือกวันที่นี้ (นอกช่วงย้อนหลัง)`. This means the date was checked, not that its accounting data is complete. Rows expose `outsideWindowCount`; actual files always win. Generic income-pending unavailable remains unchanged. Verified unavailable dates count toward checked coverage and never toward imported file or financial totals.

Rollout: migration `026_shopee_etax_available_window.sql` preserves existing evidence and extends status/reason/proof constraints. Dispatch `shopee-etax-window-migrate.yml` with `APPLY_026_SHOPEE_ETAX_WINDOW`; verify schema constraints and a real agent receipt before closing the rollout.
