# Supabase egress: Shopee004 idle reads

Evidence checked on 27 October 2026, Asia/Bangkok. Production access during the investigation was SELECT-only. The observations and local validation below describe the pre-rollout state; subsequent release status belongs to the pull-request checks and Render deployment record.

## Finding

The largest confirmed unnecessary read is in `SC-official-website`, through Supabase project `fneevjmjlgvjqcocknft` (Drugdata-master, organization SCdrugdata-master). `shopee004StockRuntime.js` schedules maintenance every 2 seconds. Before this patch, `processOne()` fetched the entire stock-control row before checking whether the dirty queue contained work. Mapping recovery also fetched plan/catalog and built identity evidence before checking its bounded candidate page.

| Production evidence | Observation |
| --- | --- |
| 27 Oct, 09:38:23 | `SELECT * ...shopee004_stock_control`: 79,430 calls / 79,420 returned rows |
| Same observation | Mapping control `SELECT mode,pos_catalog,cutover_at,plan ... FOR SHARE`: 10,006 calls / rows |
| 27 Oct, 09:46:54 | Plan: 245,382 bytes; catalog: 64,532 bytes; whole row serialized as JSON: 310,128 bytes |
| Same observation | Dirty queue: 0 orders; review positions: 76 orders. Review positions are not all necessarily mapping-recovery candidates. |
| Earlier control metadata check | Created 23 Oct 06:26:35 UTC; activated 06:26:56 UTC |
| Supabase daily usage, provider labels | Shared Pooler: 23 Oct 5.729 GB; 24 Oct 7.135 GB; 25 Oct 7.357 GB; 26 Oct 7.405 GB |

The observed daily service breakdown was approximately 99.7–100% Shared Pooler. This identifies database connection traffic, not a measured per-query billing share. Query counters are cumulative since `pg_stat_statements` reset on 26 August 2025, 20:57:21 UTC. Row JSON sizes are a payload cross-check, not PostgreSQL wire-byte or billing measurements. Do not multiply these counters into an asserted monthly bill.

HQ sync in `SCCRMonPOS/sync-agent/live/worker.cjs` is another confirmed repeated reader: three full key/hash scans every five minutes. At 09:38:23 each had 701 calls, returning cumulatively 1,007,549 customer-key/hash rows, 2,868,702 receipt-key/hash rows and 8,751,223 line-key/hash rows. Its byte contribution is not separately measured. Prioritize the large Shopee004 idle read, then measure the remaining traffic before changing HQ synchronization or restart recovery.

Sources: [organization usage](https://supabase.com/dashboard/org/qiytpdvkcnderprczjdu/usage), bounded aggregate SELECTs in the project SQL Editor (`pg_stat_statements`, `pg_stat_statements_info`, control payload lengths and queue counts), and [live source at fe79e78](https://github.com/AKCD1998/SC-official-website/blob/fe79e78dfde932fccbb6637c6368f3775a1d520d/backend/src/modules/seamless/services/shopee004StockLedger.js). The dashboard confirms Pro after the user's subscription; the billing cycle is now 27 Oct–27 Nov. Earlier Free-period usage is historical, not the new cycle's usage.

## Patch

- Read only `mode` on each worker poll. Load the four required control fields only after locking actual dirty work.
- Keep mapping recovery's existing control-row share lock, candidate limit and cursor. Defer plan/catalog and identity evidence until a page has candidates.
- Fetch fresh control and mapping evidence for actual work. No revision cache or schema migration is introduced; approvals, revocations and catalog extensions continue to be observed without restarting the worker.

Polling frequency, reservation policy, stock quantities, cutover boundaries and HQ sync are unchanged. Busy orders and nonempty mapping-recovery pages still transfer plan/catalog; this patch targets the confirmed idle waste.

## Validation and rollout boundary

- A synthetic 120-idle-poll test failed before the patch: 37,100,280 bytes of returned application-row JSON. It passes after the patch with less than 8 KiB (>99.9% reduction for this test path, not a forecast for the entire account).
- All 20 Shopee004 suites / 257 tests pass on Node 24.11.1, including isolated PostgreSQL 18.1 integration tests. Coverage includes real-database idle reads, same-worker catalog extension, reservation totals, mapping approval/revocation, concurrent workers, retry holds, cancellation/returns and restart recovery.
- A broader backend attempt reports 104 passed suites, 28 failed and 10 skipped. Failures include unavailable local `fflate` and `xlsx` packages in the reused dependency installation. A clean dependency install and the full repository CI must pass before production rollout; do not treat the scoped result as a full backend pass.
- `git diff --check` passes. The production ledger blob matches the local baseline (`22ad5c48c512846966e3b382cfdd10fe022c8d26`). The patch excludes the unrelated PR 98 baseline files reconstructed in this isolated checkout.

The investigation and local validation performed no production DML/DDL, billing change, load test or new OCR/LLM job. After an approved rollout, compare query-count deltas and Supabase Shared Pooler egress over equal elapsed windows, and check dirty backlog, review holds and reservation totals. Existing cumulative query counters will not decrease; usage reporting may lag. Roll back the code release if queue progress or reservation correctness regresses. Do not reset quota/statistics or change stock data to make the graph appear smaller.
