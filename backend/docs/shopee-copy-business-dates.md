# Verified business dates for the AdaSmart copy table

Order All payment dates remain the default. A daily confirmed product report can
establish a different business date for specific orders only after reconciling
their exact identity, quantities, order membership and original amounts against
both affected dates. Matching shop totals alone is not enough. Do not use order
creation dates or a generic COD rule to fill a missing confirmation timestamp.

Migration `029_shopee_copy_business_dates.sql` adds a private PostgreSQL ledger.
Apply it before deploying this code. It contains no seed data. Record approved,
verified cases privately with the shop, exact order number, original paid date,
evidenced business date, semantic source fingerprint, verifier and hashed report
references. Keep raw workbooks and the before/after audit outside public Git.
Source timestamps and financial facts are not updated.

Migration `030_shopee_copy_line_evidence.sql` separately persists exact line
attribution where an old import lacks it. Bind each allocation to the same source
fingerprint and independent product-report evidence. The existing order component
sums still must match exactly. Neither ledger has a public mutation endpoint.

The copy repository fetches the paid-date cohort plus both sides of each enabled
correction in one query. The builder checks the source fingerprint before
selecting the business date, then applies the existing SKU, unit, financial,
Business Insights total and order-count gates. Missing or changed source facts,
or incomplete correction evidence, disable all three copy columns on both dates.
An unchanged later file import remains valid even when its filename, row numbers
or delivery/cancellation status change.

The admin response includes correction dates and evidence for moved-in and
moved-out orders, and each included product source records its business date.
The original creation-date product table, exports and financial timeline are
unaffected. Disabling a ledger record reverses the selection without changing
source data; the existing discrepancy then requires review again.
