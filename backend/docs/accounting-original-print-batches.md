# Accounting originals: deployment and verification

Status: production rollout authorized by the user on 2026-09-05, including commit/push/deploy, migration, 000-HQ agent update and sequenced printing with LINE. Authorization is not evidence of completed deployment or printing. Branch-generated previews must pass verification before queue approval. Companion frontend/agent lives in ClaspSCxSeamless, branch `feat/accounting-print-bundle-20260905`; its `docs/24-accounting-original-print-batches.md` is the Thai operator/rollout guide.

## Change boundary

- Migration 015 adds `accounting_print_batches`, `accounting_print_items`, `accounting_print_notifications` in the existing Seamless schema. No legacy records are rewritten.
- App routes `/api/app/accounting-print-bundles` require existing session auth; upload/approve/resolve require admin. Downloads stay authenticated and do not expose storage paths.
- Internal agent routes `/api/agent/accounting-print-batches` use the existing internal token plus a versioned claim protocol, host/printer match and per-claim UUID token.
- Added `pdfjs-dist@4.10.38` for first-page statement text, with eval disabled; uses existing PDF-lib for page validation and ExcelJS for workbook inspection. Verify target Node supports the dependency (tested on Node 24).
- The existing legacy print claim shares the accounting global advisory lock. Active accounting batches block legacy spooler jobs. A background maintenance timer recovers expired claims and retries LINE independently of the branch PC.

## Configuration

Defaults keep both new routes disabled. Set only after code/migration/storage/agent review:

```dotenv
SEAMLESS_ACCOUNTING_BATCH_ENABLED=false
SEAMLESS_ACCOUNTING_AGENT_HOST=000-HQ
SEAMLESS_ACCOUNTING_PRINTER_NAME=Brother MFC-T4500DW
SEAMLESS_ACCOUNTING_WEB_URL=https://YOUR-ACTUAL-FRONTEND
SEAMLESS_ACCOUNTING_ALLOW_LOCAL_STORAGE=false
```

Use existing `SEAMLESS_LINE_*` target/token and R2 storage settings. Do not print tokens, group IDs, signed URLs or connection strings in logs. Production source upload rejects non-R2 storage unless an operator explicitly certifies persistent local storage via the escape-hatch flag. Provision storage before accepting uploads. Uploaded XLSX files include buyer data; restrict storage and app access and apply the existing accounting retention policy. No automatic data deletion is introduced.

Upload accepts separate `sc-drug-store` and `dr-morepen` fields, max 50 files per field, 20 MB per file / 100 MB combined. Original statements, balance and income identify their seller; Orders have no reliable embedded shop ID, so shop assignment comes from the separate user-selected field and coverage checks. Content checks cover seller, weekly periods and order/date coverage, not a new full financial-amount reconciliation.

## Approval and recovery invariants

- Upload is atomic for the database and idempotent by fingerprint. A failed storage write can leave an unreferenced storage object; no batch can become printable from a partially committed upload. Do not remove such objects automatically without a retention/audit check.
- All original previews must exist before `review`; approval requires the exact digest of filenames/source and preview hashes, item order, target and page counts.
- XLSX previews must have every page A4 landscape and include `printLayout.version=shopee-a4-landscape-reference-v2`; older/portrait previews are rejected. Layout metadata is stored beside the preview and exposed for column review. The agent formats print-only copies with ExcelJS 4.4.0; deploy its package/lockfile and run npm ci, not just copy JS files. Original PDF bytes and all source XLSX files remain unchanged.
- No claims that print before approval. Exactly one active accounting item globally; stale prepare claims requeue, stale print claims pause as uncertain. Each spooler submission is persisted first.
- LINE has its own durable outbox, stable retry key and per-batch ordering. Failed notifications do not change completed print status or trigger a physical reprint. Retry stops after 23 hours; this exceptional state requires operator inspection because a manual expired-outbox recovery UI is not implemented.
- API states distinguish completed Windows queue tracking from physical paper confirmation. Manual recovery requires admin identity/reason and acts only on the paused item.
- Rollback must not disable legacy gating while a batch is active. Stop the scheduled agent safely and resolve the current spooler state before reverting flags/code. Preserve new tables and stored files.

## Tests (no external sends)

From `backend/`:

```powershell
npm test -- tests/accounting-print-bundle.test.cjs tests/accounting-original-routes.test.cjs
# Loopback-only disposable test DB; creates and drops only its uniquely named test schema.
$env:ACCOUNTING_TEST_DATABASE_URL='postgresql://LOCAL_TEST_USER@127.0.0.1:LOCAL_PORT/postgres'
node scripts/test-accounting-originals-postgres.cjs
```

`scripts/audit-accounting-originals.cjs` reads the source folders without changing originals. Regression on the user's 42 originals passed: five accounting weeks, two shops, 272/272 + 32/32 Income orders covered, including carry-over.

Current local v2 previews total 145 pages (20 statement, 16 balance, 42 income, 67 orders), replacing the rejected 1,264-page v1 layout. Agent audit compares all selected cells and retained sheets against originals, preserving 304 Income rows and 735 raw Orders rows. PDF checks include all-page landscape geometry and every selected Income/Orders header on each data page; visual samples were checked, not every page visually. The user subsequently authorized rollout and printing; verify production previews rather than assuming authorization resolves all layout concerns. Current focused tests: backend 11, local PostgreSQL 6, agent 45, client 118; client build passes. Production outcomes are recorded separately after execution.

`scripts/review-accounting-originals-local.cjs <client-dist>` is an explicitly localhost-only development preview with fixed local test DB configuration. It serves copies of the user-provided source folders, disables all mutation/printing routes and substitutes a LINE sender that only reports disabled. Never deploy this script or expose port 5119 externally. Its `.local-accounting/` files and `tmp/` test databases are gitignored.

Full-suite check also identified an unrelated pre-existing CRLF-sensitive `check-read-only-production-database` workflow-text assertion on Windows. The 44 backend integration tests pass when configured against the disposable local PostgreSQL DB; never point these integration tests at production.

Rollout: permission including printing and LINE has been granted. Run migration via the normal runner, verify its ledger, preserve existing R2/LINE settings, upgrade the branch agent without overwriting `.env`, enable flags, then upload and verify branch-generated previews before applying the approved print instruction. Preflight found migrations 001–014 recorded, no active legacy/spooler jobs, and created a schema-only backup before additive migration 015. Actual 000-HQ agent directory is `C:\Users\Administrator\Desktop\ClaspSCxSeamless\print-agent`; preserve the existing scheduled task principal and configuration.
