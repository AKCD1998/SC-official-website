# Read-only AdaSmart copy columns for Shopee

`GET /api/app/shopee/orders/sales-summary/adasmart-copy?shopCode=sc-drug-store&startDate=2026-09-01&endDate=2026-09-01`

This financial endpoint uses the existing admin authentication and `Cache-Control: no-store`.
It rejects all-shop scopes, date ranges, and non-admin callers. It performs SELECT queries only
and does not save, approve, queue or type into AdaSmart. No database migration is required.

## Cohort and price rules

Select the latest immutable Order All snapshot per shop/order, then filter payment timestamps
with inclusive Bangkok-day boundaries. Keep later-cancelled/returned paid orders in the original
Business Insights gross confirmed-sales cohort. Use the source's own product rows rather than
email product rows. Compare its order count and merchandise minus recorded seller voucher plus
Shopee-funded product discount with independently imported Business Insights for the same shop/day.
Missing reports, missing hashes/rows, mismatched counts or amounts prevent all copy columns.

Single-product orders have exact attribution of every recorded component. For multiple products,
use explicit line financial components only if they reconcile to the order components. Older
imports lack those line components: source unit prices may be used only when their integer-satang
sum equals the recorded subtotal and there is no seller voucher or Shopee support to allocate.
Otherwise require review; never distribute an order total, use master prices or add a balancing item.

Resolve existing catalog SKU matches and verified pack factors against ERP-unit evidence in
`shopeeAdaSmartCopyRules.v1.json`. That registry contains 143 existing catalog SKU master units
from the hashed SC004 export, exact source-product corrections evidenced during the user's daily
workflow, and the user's 2026-09-26 accounting consolidation of the specific Strepsils lemon variant
into honey-lemon SKU 630010066. Original source identity and prior match remain in row evidence.
These are copy-plan rules; they do not modify global catalog/product-master records.
The user's 2026-09-28 confirmation maps SC Drug Store's exact Oreda RO orange 5.5 g
product and `1 กล่อง 10 ซอง` variant to IC-004371, ten ERP sachets per purchased box.
The registry records box barcode 8852914302211 separately from ERP sachet barcode
8852914302204 and retains the confirming ERP screenshot's SHA-256. The existing
`10Pcs` rule remains ten sachets; other shops, product names and pack sizes are not
covered by this confirmation. Source money is preserved when converting quantities.
Unrecognized SKUs or unverified unit conversions require review. In particular, Gaviscon pink
boxes remain unresolved against ERP sachets; no assumed box count is allowed.

Group identical ERP SKUs without changing total quantity or satang. If division by quantity is
fractional at two decimals, emit a higher-cent-price row first and the remaining lower-cent-price
row. Preserve repeated SKU rows and return aligned strings only when every check passes.

## Validation

- 135 relevant backend tests pass: builder, repository, route permissions, legacy sales summary,
  accounting, matcher and reconciliation route.
- Production database validation ran inside a REPEATABLE READ READ ONLY transaction and rolled
  back. SC Drug Store 2026-09-01 through 2026-09-08 paid cohorts match every day's BI total/count.
- Ready cases: 01 Sep 47 orders / 18 rows / 243 units / 12,208.00; 03 Sep 52 orders / 27 rows /
  143 units / 12,822.00; 05 Sep 64 orders / 28 rows / 929 units / 23,815.00.
- After the confirmed Oreda box mapping, SC Drug Store 09 Sep reconciles 134 paid orders /
  141 source lines / 37 copy rows / 36,733.00 with no review issues in a read-only production
  snapshot. The three newly resolved lines are four boxes, forty ERP sachets and 100.00.
  Combined with the existing Oreda sales, IC-004371 is 130 sachets / 289.00, represented as
  40 at 2.23 and 90 at 2.22 to preserve the exact amount.
- Other checked SC days require the existing Gaviscon box-to-sachet review. DR.Morepen 01 Sep has
  independently evidenced zero sales/orders; there are no values to copy.
- The broader `backend-integration.test.cjs` server-start checks cannot complete on this local
  checkout without a local database: existing startup migrations fail before listening. No
  production credentials were supplied to those startup tests. The new route's authenticated
  integration tests run with mocked repositories and pass.

Deploy this backend before its matching ClaspSCxSeamless frontend. Rollback is a revert of the
feature commit; no data repair is required because this endpoint never writes data.
