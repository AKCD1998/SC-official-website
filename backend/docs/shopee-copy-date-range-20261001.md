# AdaSmart copy: inclusive date ranges, 2026-10-01

The copy view formerly accepted only one shop and one day, even though Business Insights and the source repository supported ranges. Selecting a month left the copy table unavailable. It now accepts one shop and an inclusive Bangkok date range, consolidating the selected source SKU quantities and amounts into one aligned set of copy columns.

## Reconciliation

- `selectCopyCohort` selects verified business dates inside both bounds. The existing repository already loads orders and private evidence on both sides of corrections, including paid dates outside the range. Corrected orders are included once; source facts stay immutable.
- Prices use the existing merchandise, seller-discount and Shopee-support rules. Aggregate original amounts and ERP quantities across the entire range, retaining paid/gift separation, then apply the established two-price exact-cent split. No rounded discount or balancing SKU is introduced.
- Every selected day is independently passed through the same single-day builder with its own BI daily evidence, date corrections, line evidence and approved allocation context. Opposing daily money or order-count differences cannot cancel out to authorize a range.
- Missing BI evidence is different from an explicit report with zero sales/orders. Either a daily failure or an inconsistent daily-versus-range BI total blocks all copy columns.
- Range responses include `dailyReconciliation`, giving dates, totals, order counts, variance, status and review reasons. Existing single-day response values and columns are preserved.

The admin-only, no-store API still rejects all-shop scope and invalid/reversed dates. There are no database migrations, source writes or AdaSmart document changes. The original product table and Excel export retain their established semantics.

## Review and validation ledger

- Eight range tests cover weighted exact-cent consolidation, explicit zero days, missing BI, opposing daily money/count errors, inconsistent BI aggregates, Bangkok boundaries, cross-range corrections, wrong mapping and duplicate orders.
- Route tests cover authenticated range requests and reversed dates; the former single-day restriction test now exercises invalid bounds.
- Backend focused validation: four suites / 115 tests pass. Initial local run exposed the obsolete range-rejection assertion; it was corrected. An unrelated first-route cold-start timeout was rechecked with a local timeout allowance; no production timeout or test source timeout changed.
- Independent frozen-data audit: all 122 old day/shop plans retain their copy columns, quantities, prices, source amounts, totals and counts. Eight ranges across both shops, including a full 30-day month and evidence-sensitive boundary days, match the sum of the old daily SKU paid/gift amounts and ERP quantities. A missing next-day report remains blocked.
- Frontend validates complete daily coverage and date order before enabling range copying, labels both bounds and exposes daily review results. Client suite: 144 tests pass. Build, GitHub CI and production checks are recorded by the root deployment ledger outside Git.

Deployment order: shared backend first, then ClaspSCxSeamless client. An old client still serves existing day requests while the backend updates. Rollback the client and these controller/selector/builder changes to restore single-day copy behavior; stored orders, BI reports and prior evidence remain intact.
