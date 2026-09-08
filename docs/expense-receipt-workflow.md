# Expense receipt workflow (ใบสำคัญรับเงิน)

The shared production backend owns this workflow. It is mounted under
`/api/expense-receipts` by `backend/src/modules/seamless/routes/index.js`.

## Storage and audit

- The original `.xlsx` bytes are stored durably in the existing Cloudflare R2 bucket under the
  Seamless `expense_receipt` key prefix. Submission fails closed when R2 is unavailable; Render's
  ephemeral local disk is not accepted.
- PostgreSQL `processing_records` stores the searchable document identity and current workflow
  state. `generated_files` links the record to the R2 object and its SHA-256 checksum.
- `operation_logs` records submission, LINE/email delivery, approval, and print completion.
  `print_jobs` retains every queued/claimed/completed print attempt.

## Authenticated API

- `GET /api/expense-receipts/preflight` checks R2, LINE, email, and the approval gate.
- `POST /api/expense-receipts` accepts one multipart field named `file`, plus
  `expensePeriod=YYYY-MM` and `expectedClaimantName`. A named human admin session is required.
- `GET /api/expense-receipts` lists this document type only.
- `GET /api/expense-receipts/:id` returns the record, downloadable files, print jobs, and ordered
  audit events.
- `POST /api/expense-receipts/:id/approve-print` requires a named human admin and exactly:

  ```json
  { "confirmation": "APPROVE_PRINT" }
  ```

Submission stores the document and audit record only: it sends no LINE message, sends no email,
and creates no print job. Expense receipts are excluded from the legacy auto-print path and generic
request-print endpoint. The final-approval request concurrently delivers the dedicated LINE Flex
message and Gmail; the print job is released only after both deliveries succeed. A partial delivery
is recorded and the same final-approval request can safely retry only the failed channel. Print
completion sends a second dedicated LINE message/email and is written to the audit history.
