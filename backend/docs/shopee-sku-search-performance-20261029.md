# Shopee order SKU search — 29 October 2026

Searching all SC order history for `IC-001849` took 59.065 seconds on release `931e38e`. The endpoint read and enriched every order before filtering and paginating. Its official-report branch processed 223,676 report-version rows even though most order keys already existed in email/live data; the old search transferred about 12.4 MB from PostgreSQL and looked up payment evidence for unrelated orders.

The reader now walks distinct report order keys through the existing `(shop_code,order_number)` index, excludes email/live keys, and loads the latest payload only for official-only orders. `jsonb_populate_record` is evaluated once per synthetic row in `FROM`. The recursive strict tuple comparison advances until no key remains, including empty history. This uses the [PostgreSQL loose index scan pattern](https://wiki.postgresql.org/wiki/Loose_indexscan); it adds no schema, index, cache, or registry.

Exact IC searches first select a coarse superset using raw text and names derived from existing catalog/alias rules. The existing complete matcher still filters, sorts and counts globally before pagination. Nine-digit SKU searches keep all raw numeric fields searchable. Exact SKU queries skip localized date/currency formatting and load the original latest non-null payment proof only for the selected page, within one read-only repeatable-read transaction. General text/date/money search semantics and financial visibility remain unchanged.

An additional existing defect was found during verification: physical copy variants such as TYLENOL `630010105` displayed a verified stock identity but were missing from the search alias candidates. Search candidates now also include existing copy/owner rules. Every alias must still pass the same canonical stock matcher, evidence guard and POS unit checks; accounting-only or conflicting candidates cannot authorize a match. No match data, approval, worker or stock contract is changed.

## Verification

- Local regression: 409 tests across 20 suites passed, including the additional numeric-alias test. After the alias-reader change, all four affected repository/identity/PostgreSQL suites were rerun (48 tests passed). Complete backend CI is required before release.
- An isolated loopback PostgreSQL test covers email, live-only and official-only rows; latest non-null payment proof; global filtering/sorting/pagination; shop/status scope; empty history; and multiple report versions across shops.
- A production read-only repeatable-read comparison found identical complete relation rows for all 11,795 orders against `931e38e`. Representative IC and numeric searches compare complete response payloads using the same verified aliases and same snapshot. Release acceptance records the final results separately.
- A candidate `IC-001849` profile read 357 candidate rows /362,592 bytes and returned nine actual orders in 4.673 seconds (local application against production database; not a production HTTP timing). The original eight orders remain; the ninth was a new incoming order, not created by this patch.

## Release boundary

Backend only. No frontend or StockDay deployment is required. No migration, environment/flag change, background job, lifecycle approval, reservation mutation, opening balance/cutover change, or Hourly/Full Sync/Transfer Delta change is part of this patch. Actual HTTP timing, live page screenshots and before/after protected-state comparisons must be recorded after deployment, separately from candidate measurements. Rollback is the preceding backend commit; no data rollback or rebaseline is needed for these read-path changes.
