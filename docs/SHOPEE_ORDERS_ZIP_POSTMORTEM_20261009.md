# Native Orders ZIP omitted from daily AdaSmart copy

On 9 October 2026, SC Drug Store's 8 October Business Insights was present (164 orders, THB 57,199), but its Orders source was missing. The copy view correctly stayed blocked at three carry-over orders, THB 706. This was incomplete source coverage, not a mismatch in the four displayed copy rows.

The downloader searched 20 pages of report history and failed. A screenshot of the actual report list revealed the requested native `Order.all.20260908_20261008.zip` on the first page. The Orders scanner recognized only XLSX, so it ignored this ZIP. Merely increasing the history limit would not fix the format omission. The agent now recognizes ZIP, validates its Excel members, and uses proven newest-first timestamp boundaries while retaining pending/duplicate protections and exact shop/period checks. Recovery reused the already accepted export; it did not submit another Shopee report. The installed agent was patched from its current source, preserving the separately installed intraday observation work.

The recovered ZIP contains native `Order.all.20260908_20261008_part_1_of_2.xlsx` (5,000 orders) and `...part_2_of_2.xlsx` (89 orders). Reading all 5,089 orders yields 164 with an 8 October Bangkok payment date, and their item subtotal minus seller voucher plus Shopee product support totals THB 57,199. Eight of these paid orders are now cancelled in the later snapshot; their source statuses remain intact and the existing Business Insights cohort rules determine inclusion. No financial value or SKU rule is changed by this fix.

The backend also accepted only XLSX for Orders. It now accepts native ZIP only for this report type and requires:

- An exact native archive/member period, complete numbered part sequence, bounded member count and decompressed size, and valid Orders worksheet/header/date/financial cells.
- All members to validate before starting the database transaction. Duplicate or split orders across files remain rejected instead of importing an incomplete order.
- The original ZIP filename/hash in the ingest audit and each original workbook filename/hash and physical worksheet row in the source tables. Audit metadata links all members to the parent ZIP; neither a synthesized workbook nor fabricated original filename is used.
- Atomic member import and the same immutable Job ID replay contract. Other report types retain their previous format requirements.

Regression tests cover native multipart import/replay, missing or inconsistent parts, mismatched periods, unsafe paths, duplicate/split orders, bad financial cells, wrong hashes, and nested archive expansion limits. The raw production workbooks and customer/order evidence are retained privately, outside this repository.

The complete archive exposed one additional mapping omission: the selected Swisse variant changed from `ฟอเต้ สีเทา` to `ไบโอติน สีเทา`. The native workbook's selected-variation SKU explicitly identifies `IC-005481`, the existing verified 60-tablet jar (barcode `9311770608275`). An exact alias now reuses that verified identity and one-jar sale factor. Its evidence records the original member hash and physical row; unrelated variants and unverified pack changes remain blocked. The item's original THB 395 value is retained.

Deployment and post-import financial/copy verification are recorded in the private incident ledger. Rollback restores the previous application commit; newly imported source evidence is append-only and must not be deleted as a code rollback.
