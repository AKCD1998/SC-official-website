# Shopee Order All ingest memory fix — 4 November 2026

A native two-member, month-long Order All ZIP repeatedly exhausted the web service JavaScript heap while loading full ExcelJS document workbooks. All three uploads ended with HTTP502 before a successful ingest audit, leaving the last report date missing although the downloader retained the original file.

The reader now uses the existing SheetJS dependency in dense mode and selects only the `orders` worksheet. It passes raw values to the unchanged source parser, retaining source row numbers, date cells and merged values, and rejecting formulas, rich text, hyperlinks and error cells as before. An OOXML package check keeps CSV/ODS from being accepted through the more general reader. Native ZIP member validation, immutable file hashes, order grouping, source money, transaction and replay rules are unchanged.

Validation compared the full parsed result for the retained 4,215,619-byte native ZIP against the former reader: 8,161 orders, 10,151 product lines and two member sources were identical, including line-level net sales, Shopee support, vouchers, timestamps and source rows. No real customer data is checked into tests or documentation.

| Local benchmark | Former reader | Dense reader |
| --- | ---: | ---: |
| Peak process RSS | about543MiB | about238MiB |
| Heap used after reading/comparison | about271MiB | about83MiB |
| Successful constrained run | larger heap required | old-space192MiB / semi-space8MiB |

These are isolated local benchmarks, not claims about whole-service production memory. Production logs showed heap exhaustion near244MiB; the service memory limit is512MiB. Verify the exact retained job after rollout rather than downloading again or changing report periods.

Focused tests cover sparse rows, worksheet selection, 1904 date workbooks, merged values, structured cell rejection, disguised file formats, native ZIP lineage, atomic import and idempotent replay. A synthetic wide7,000-order workbook must parse successfully in a separate process under the constrained heap. Local checks:53passed, one PostgreSQL-dependent test skipped; CI runs the configured full suite.

This patch does not change lifecycle, opening balances, cutover, stock matching/reservation rules, POS masters, Hourly/Full Sync/Transfer Delta or downloader schedules. Recovery should reuse the retained original file, download job ID, original filename, observation time and SHA-256 through the existing ingest queue. Do not mark missing e-Tax as no-file without a fresh exact portal result.

Dense-mode reference: [SheetJS large datasets](https://docs.sheetjs.com/docs/demos/bigdata/stream/).

