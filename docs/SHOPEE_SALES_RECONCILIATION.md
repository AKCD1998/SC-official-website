# Shopee sales reconciliation

This change uses **official Shopee Confirmed gross sales before cancellations**
as the primary administrator headline, and separately fixes the secondary
order-date ledger and its export. It does not change
Income payout periods, print jobs, LINE notifications, Gmail history, or the
existing order-event timeline. Production rollout/import requires separate approval.

## Required primary metric: ยอดขายยืนยันแล้ว ก่อนหักยกเลิก

The user's required August 2026 figures are **SC Drug Store 154,026 THB / 613
confirmed orders**, and **DR.Morepen 17,891 THB / 36 confirmed orders**. These are
not the order-net figures 146,548 / 17,541. No amounts are hardcoded in application
logic: `confirmedSales` reads daily facts from the original `ยืนยันแล้ว` worksheet,
using `ยอดขายทั้งหมด (THB)`, and sums the requested report dates in integer satang.
Cancellations (7,478 / 350) are separate supplementary metrics, not deductions
from the headline. Returns are preserved as separate source fields too.

- `*.shopee-shop-stats.YYYYMMDD-YYYYMMDD.xlsx` embeds seller username; match it to
  the known shop profile before accepting data. Require the exact Confirmed tab,
  required headers, filename/summary date agreement, each inclusive daily date
  exactly once (including explicit zero days), and six daily/summary control sums.
- `confirmedSales.dateBasis = confirmed_report_date`. Do **not** relabel this as
  order-creation date: in the supplied SC report, Confirmed-minus-canceled and
  All-minus-canceled differ on 10 daily dates even though monthly nets match.
- No official row for any selected day/shop => combined primary `salesTotal`
  and `orderCount` are null, with missing dates and per-shop coverage. A complete
  shop remains visible when another shop is missing. No email/order-net fallback.
- Latest observed snapshot wins per shop/day. Same-observation overlapping
  sources are rejected; immutable original hashes and filenames remain auditable.
- JSON, UI and Excel use this same resolver. Admin export starts with
  `ยอดขายยืนยันแล้ว`; its daily evidence is in `ยืนยันแล้วรายวัน`, so SUM of daily
  money cannot double-count monthly summary rows. Existing `พร้อมคีย์` and
  `ต้องตรวจสอบ` remain SKU-grain. `ยอดขายรายออเดอร์` remains secondary order-net,
  explicitly not Confirmed gross. The UI explains these are different populations.
- This is an **imported official report snapshot**, not a live Shopee API sync.
  Later official revisions require an approved newly observed source import.
  Aggregate source coverage does not prove full order-level coverage or SKU mapping.
- Confirmed financial JSON/export uses the existing new-accounting admin gate;
  regular-user access is not broadened.

Read-only preview/validation (no database connection):

```powershell
node scripts/import-shopee-sales-sources.cjs --type confirmed --shop-code sc-drug-store --observed-at <documented-ISO-observation-time> --file <original-shop-stats.xlsx>
```

The same explicit apply/digest/shop/actor/DB-URL approval gates described below
apply to confirmed imports. Migrations **016 and 017** must precede code rollout.
Local fixture timestamps are not authorization to import originals into production.

## Agent HTTPS ingest

The 000-HQ downloader can send the just-downloaded original workbook to
`POST /api/agent/shopee/sales-sources` as multipart data. This route uses the
dedicated `SHOPEE_SALES_INGEST_TOKEN`; it returns 503 when the server secret is
unset and does not inherit the older print-agent auth fallback. Migration **018**
adds the privacy-safe ingest-job audit table and must be applied before enabling
the HQ uploader.

The server verifies file size/MIME/ZIP magic, recomputes SHA-256, validates the
shop/report/date/original-filename manifest, and calls the same buffer-based
Confirmed or Orders parser used by the CLI path. Source import and ingest audit
commit in one transaction. Exact replay is `unchanged`; immutable metadata
conflict is 409; malformed/incomplete source is 422. Responses and logs contain
no token or customer/order payload.

Rollout order is migration, backend code and server secret first; then install
the HQ agent code, set the same token only in the Scheduled Task environment,
and enable one shop at a time. Production deployment/import remains a separately
approved operation.

## Secondary order-net calculation and source precedence

- Join by **shop code + order number**, never order number alone or its date prefix.
- Reporting dates use Thai creation timestamps, inclusive start and exclusive next
  midnight after the selected end date.
- Prefer the latest observed original All Orders snapshot for sales status and
  financial components. Importing an older snapshot never makes it current.
- Exclude a canceled source order even when its email status still says shipment
  due. Also retain email-derived cancellation/return exclusions. Do not fabricate
  Gmail cancellation events or overwrite email history to force reconciliation.
- Per order: sum `ราคาขายสุทธิ` across lines, deduct
  `โค้ดส่วนลดชำระโดยผู้ขาย` **once**, and add the sum of `ส่วนลดจาก Shopee`.
  This is not the separate Shopee voucher column, buyer-paid amount, profit, or
  net Income transfer after platform fees.
- Financial totals/ledger use unique order keys, independent of SKU and bundle
  row expansion. The original seven-column SKU sheets contain no monetary totals.
- Existing nonempty email items retain their product identity/mapping. Raw-only
  orders use source items. Listing-quantity disagreements go to SKU review.
- Missing source discounts remain `null`, not zero. An email subtotal may be used
  only as an explicitly provisional estimate. Missing money makes the combined
  amount unavailable. `sourceBackedSalesTotal` is null while any order is
  provisional. `periodReconciliation: not_checked` means source-backed included
  orders alone do not prove completeness of a whole period.
- New discount/accounting JSON and the `ยอดขายรายออเดอร์` export sheet are
  administrator-only. Existing regular-user SKU/subtotal access is unchanged.

## Original-file import

`backend/scripts/import-shopee-sales-sources.cjs` is dry-run by default and does not
connect to a database in dry-run mode. Use original `orders` worksheets and original
`Order.all.YYYYMMDD_YYYYMMDD.xlsx` filenames. Headers, Thai dates/statuses, money,
within-order voucher consistency, shop scope, and privacy/size bounds are validated
before persistence. Unknown return statuses fail for review; a delivered order's
explanatory return-policy text is not treated as an actual return.

Run from `backend/`, replacing the example source/timestamp with verified evidence:

```powershell
node scripts/import-shopee-sales-sources.cjs --shop-code sc-drug-store --observed-at 2026-09-08T12:00:00+07:00 --file C:/approved/Order.all.20260824_20260830.xlsx
```

Repeat `--file` for additional originals from the same shop. The plan contains
source hashes, periods and counts. Original Order All files do **not** identify the
shop in their filename; the operator must verify the selected account/folder.
`--confirm-shop` is an explicit human attestation, not automated shop detection.
Use a documented actual export-observation time with a timezone. Fixture timestamps
in local verification are not evidence of production export time. Do not use an
arbitrary later timestamp to promote older evidence.

Only after approval, provide an explicit `SHOPEE_SALES_IMPORT_DATABASE_URL` through
the approved secret mechanism, plus `--apply --confirm-shop <same-shop>
--plan-sha256 <reviewed-plan-hash> --actor <operator>`. The importer never loads
`.env` or falls back to the shared application DB URL. Changed file contents or
metadata invalidate the reviewed plan digest. All files in one command import in
one transaction. Replays are idempotent, same-time overlapping snapshots are
rejected, and a global source-hash constraint prevents cross-shop file reuse even
under concurrent imports. No printing or notification code is called.

## Verification and deployment order

1. Review source changes against the deployed revisions and preserve unrelated
   canonical-worktree changes. No commit/push/deploy is implied by local tests.
2. Test migrations `016_shopee_sales_sources.sql` and
   `017_shopee_confirmed_sales.sql` in an isolated local database.
   For an approved rollout, apply them through the existing Seamless migration runner
   before deploying code that queries its new tables. Do not run a blanket shared
   migration command without reviewing the pending migration list and schema.
3. Import the approved original files, deploy the backend/frontend, and verify
   JSON + newly generated exports with the same month/shop controls.
4. Check the primary monthly/daily gross and counts against the original official
   `ยืนยันแล้ว` B/D controls; cancellations I/J and returns K/L separately.
   Separately check secondary order-ledger days against `ทั้งหมด` minus
   cancellations (and investigate actual returns). Do not assert the two date
   bases are interchangeable, even if their monthly net totals match.
5. Verify user/admin access, source coverage warnings, replay behavior, and no
   change to email history. Regenerate exports; old manually corrected files with
   a repeated whole-order money column are not retroactively repaired.

Local verifier: `backend/scripts/verify-shopee-sales-local.cjs <input.json>`.
It requires `SHOPEE_SALES_VERIFY_DATABASE_URL` pointing to loopback with no URL query
overrides, validates the pg-resolved host before connecting, and creates a unique
`*_ci` schema. It never accesses production, external email, printing or LINE.
The input JSON supplies `emailSnapshot`, `startDate`, `endDate`, `observedAt`,
optional `output`, and `shops: [{code, ordersDirectory, statisticsFile}]`.
It executes the actual SQL repository, summary, native export/reopen and atomic
import on the local database; original source files are not changed.

The verifier also tests raw-only orders, older snapshot precedence, same ID across
shops, cancellation precedence, ambiguous snapshot rejection, Thai midnight
boundaries, batch rollback and concurrent duplicate-file isolation. It retains its
local test schemas for inspection; it does not delete or truncate any existing
schema.

## August 2026 local acceptance evidence

Actual local PostgreSQL replay imports both original statistics workbooks via the
implemented parser/repository and verifies primary **154,026 / 17,891** and
**613 / 36** directly against the original Confirmed cells. All 31 days' six
metrics per shop match, and the reopened native primary export matches the API
summary. Complete primary coverage is `source_backed`, not provisional. Local
fixtures also verify missing days, real zero days, older/newer snapshot ordering,
same-time ambiguity, exact date subsets, shop isolation, idempotency and rollback.

The separate production SELECT snapshot plus 12 original All Orders workbooks
matched the secondary net monthly and all 31 daily money/count controls per shop:

| Shop | Before (email subtotal) | Secondary order-net sales | Orders after | Raw-backed / provisional |
| --- | ---: | ---: | ---: | ---: |
| SC Drug Store | 151,194 | 146,548 | 580 | 520 / 60 |
| DR.Morepen | 17,394 | 17,541 | 35 | 34 / 1 |

All 61 provisional orders are August 31: source files stop August 30. Official
daily aggregates agree, but individual raw discounts/statuses on August 31 are
not independently verified. Do not claim full raw monthly coverage or hardcode
these observed totals into application logic.

An independent auditor separately read original workbooks, recalculated in integer
satang, reviewed code/security and reran targeted tests. The secondary order-net
`accounting.sourceBackedSalesTotal` remains null as intended, while the primary
official `confirmedSales.salesTotal` is fully source-backed. These fields measure
different populations and must not be substituted for each other.
SKU review rows predate this change: SC 4, DR 15. This task does not silently edit
SKU mappings. Landscape A4/fit-width settings are tested; physical/visual print QA
was not performed, and printing remains unauthorized.

Validation run on 2026-09-08:

- Relevant backend regression: 6 suites / 112 tests passed.
- Entire frontend: 122 tests passed; production build passed.
- Local PostgreSQL 18 integration: both stores, 62 confirmed days (six metrics
  each) plus 62 secondary net daily money/count checks,
  export parity, unchanged email history and all synthetic invariants passed.
- Broader backend suite is **not entirely green**: last full run had 59 suites
  passed, 2 failed, 5 skipped (527 passed / 37 failed / 10 skipped tests).
  `backend-integration.test.cjs` fails because the shared full-server startup has
  no general test DB connection configured; `check-read-only-production-database`
  has an unchanged CRLF-sensitive workflow-text assertion on Windows. Neither
  failure is concealed or repaired by this task. Full-stack CI still needs its
  documented environment before production rollout.

The independent auditor identified and the implementation corrected Thai Unicode
normalization, new financial permission boundaries, a concurrent cross-shop file
hash race, PostgreSQL connection-query overrides in the local verifier, invalid
observation calendar dates and error redaction. Final auditor review found no
remaining blocker in the changed Shopee paths or the local verifier.

The corrected Confirmed-basis independent audit also found no remaining blocker:
fresh originals -> implemented parser matched a separate Artifact Tool extraction
for all six additive metrics on all 62 shop-days; 112 targeted tests passed. Its
export review resulted in separating monthly summary and daily evidence sheets,
removing both double-counting and repeated-header ambiguity. Production imports
must use documented September 8 statistics observation/download evidence, not an
earlier synthetic fixture timestamp. No source import, deployment or printing has
been performed on production as part of this correction.
