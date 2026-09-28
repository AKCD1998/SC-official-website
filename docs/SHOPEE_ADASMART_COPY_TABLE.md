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
`shopeeAdaSmartCopyRules.v1.json`. That registry contains 144 evidenced ERP SKU master units
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
The user's 2026-09-28 confirmation also maps the exact Gaviscon product's `ชมพู 1 กล่อง`
variant to IC-003778 at twelve ERP sachets per box. An exact evidenced copy rule resolves
that identity's old unit hold; the hold still applies to other identities sharing its
SKU/variant. The reported barcode `885360035639` is retained as pending confirmation
because it differs from the exported sachet barcode `8850360035622`; it is not used to
resolve products or change a master barcode. The twelve-sachet conversion is independently
authorized by the user's explicit pack confirmation.
The green-box variant IC-001048 also has an ERP sachet unit but previously defaulted to
one sachet per source box. Keep it under unit review until its exact pack factor is evidenced;
the pink-box confirmation alone does not establish the green box's contents.
Senhami's exact twenty-tablet product with no variant maps to IC-005092 at one ERP box
per sale. Its box unit and barcode `8851802020374` match row 5727 of the same hashed ERP
export and the user's screenshot. Do not multiply that quantity by twenty tablets.
Unrecognized SKUs or unverified unit conversions continue to require review.

Group identical ERP SKUs without changing total quantity or satang. If division by quantity is
fractional at two decimals, emit a higher-cent-price row first and the remaining lower-cent-price
row. Preserve repeated SKU rows and return aligned strings only when every check passes.

## Validation

- 141 relevant backend tests pass: builder, repository, route permissions, legacy sales summary,
  accounting, matcher and reconciliation route.
- Production database validation ran inside a REPEATABLE READ READ ONLY transaction and rolled
  back. SC Drug Store 2026-09-01 through 2026-09-08 paid cohorts match every day's BI total/count.
- Original ready cases before the green-box unit review: 01 Sep 47 orders / 18 rows /
  243 units / 12,208.00; 03 Sep 52 orders / 27 rows / 143 units / 12,822.00;
  05 Sep 64 orders / 28 rows / 929 units / 23,815.00.
- After the confirmed Oreda box mapping, SC Drug Store 09 Sep reconciles 134 paid orders /
  141 source lines / 37 copy rows / 36,733.00 with no review issues in a read-only production
  snapshot. The three newly resolved lines are four boxes, forty ERP sachets and 100.00.
  Combined with the existing Oreda sales, IC-004371 is 130 sachets / 289.00, represented as
  40 at 2.23 and 90 at 2.22 to preserve the exact amount.
- The confirmed pink-box factor resolves its unit issues on 02, 04, 06, 07, 08 and 10 Sep.
  Read-only rechecks retain every 01-10 Sep paid cohort's order count, source-line count and
  independent BI target. Days 01, 04, 05, 06, 07, 08 and 09 are ready. Days 02, 03 and 10
  now correctly require the green-box factor rather than copying one sachet per box.
- 10 Sep's three pink lines are 11 boxes / 132 sachets / 4,510.00, emitted as 88 at 34.17
  and 44 at 34.16. Senhami is one ERP box at 46.00. The full paid cohort is 64 orders /
  70 source lines / 23,554.00. Copying remains blocked on the green source line (eight
  boxes / 2,832.00) while its factor is unresolved; the supported table is 26 rows / 20,722.00.
- DR.Morepen 01 Sep has independently evidenced zero sales/orders; there are no values to copy.
- The broader `backend-integration.test.cjs` server-start checks cannot complete on this local
  checkout without a local database: existing startup migrations fail before listening. No
  production credentials were supplied to those startup tests. The new route's authenticated
  integration tests run with mocked repositories and pass.

Deploy this backend before its matching ClaspSCxSeamless frontend. Rollback is a revert of the
feature commit; no data repair is required because this endpoint never writes data.
