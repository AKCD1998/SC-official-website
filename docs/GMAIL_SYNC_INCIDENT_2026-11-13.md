# Gmail sync and shared database contention, 13 November 2026

All human times below are Bangkok time (UTC+7).

## Evidence

- Live Render service: SC-official-website, `srv-d58idfm3jp1c73bhgv40`.
- Commit `5bdf1af` at 20:21 on 12 November removed only PharmCare Gmail webhook
  failure messages sent through LINE. Print notification code was unchanged.
- At 19:54–20:05, even inserts into `pharmcare_sync_runs` timed out. At
  20:22–20:23, the application logged Supavisor `EMAXCONNSESSION`, with a
  session-mode limit of 15. Shopee sync also failed intermittently.
- Supabase logs from 18:00 on 12 November to 08:50 on 13 November contained
  statement timeouts across member fanout (2,701), HQ live sync (859), and
  applications using the postgres role (655). These establish shared contention;
  Gmail errors alone do not identify the sole initiating workload.
- `existing_member_candidate` had over one million cumulative calls, and its
  normalized-name equality scanned approximately 1,900 customer rows repeatedly.
- PharmCare was completing syncs again before this repair (verified at 08:45).
  Its Gmail watch expires 19 November. Current credentials work; the historic
  `invalid_grant` rows were from September, not this incident.

## Repair

1. Added the nonunique partial expression index
   `ada_history.history_customer_active_name_lookup` on
   `(source_id, ada_history.member_name_key(name)) WHERE active='1'`.
   Supabase applied this as `add_ada_customer_name_lookup_index`. The index is
   valid and ready, 200 kB. No customer rows, matching rules, or permissions changed.
2. PharmCare push requests share one active worker and at most one pending
   rescan. A successful run waits at least five seconds before another rescan;
   a failed run waits at least 60 seconds. The existing database advisory lock
   still protects cross-process/manual syncs. Sync failures are logged once per
   run, rather than once for each waiting webhook.
3. The main website pool defaults to four connections (previously pg's default
   ten) and a ten-second acquisition timeout. `SC_OFFICIAL_DB_POOL_MAX` accepts
   integers 2–10. This is one application's budget, not the whole database limit.
4. The operator's LINE mute remains the default. Setting
   `SEAMLESS_PHARMCARE_GMAIL_LINE_ALERTS_ENABLED=true` enables failure alerts with
   a 30-minute per-process cooldown, including failed delivery attempts. Print
   notification behavior is unchanged. No test message was sent to the group.

## Verification and limits

- Same representative normalized-name lookup: 40.891 ms before and 2.559 ms
  after, with the plan using the new index. Both results matched one row and had
  digest `512e5b05b343aa04e1a81791d4efc924`. This measures that query, not an
  end-to-end application speedup. Supabase health advisors returned no lints.
- Targeted regression tests cover push bursts, rescan preservation, failure
  backoff, the default mute, alert throttling, webhook authorization and immediate
  acknowledgement, connection bounds, sync ingestion, and the existing LINE service.
- No print jobs were created during the preceding 24 hours, so live print
  delivery cannot be established from this window alone.
- MSI can access GitHub, Render, and Supabase. `scproductdev` is offline; changes
  cannot be mirrored back to that laptop until it reconnects.
- In-memory scheduling and alert cooldown reset on process restart. This does
  not add a durable queue or detect a silent/expired Gmail watch. Other shared
  worker polling and receipt-completeness queries warrant separate tuning if
  contention persists. No database plan/compute upgrade was made.

## References

- [PostgreSQL expression indexes](https://www.postgresql.org/docs/17/indexes-expressional.html)
- [node-postgres pool limits and timeouts](https://node-postgres.com/apis/pool)
- [Supabase statement timeout diagnosis](https://supabase.com/kb/troubleshooting/canceling-statement-due-to-statement-timeout-581wFv)

## Rollback

Revert the application commit to restore the preceding webhook implementation.
The mute was already present in that version. Independently, the added index can
be removed with `DROP INDEX ada_history.history_customer_active_name_lookup`.
It has no data dependencies and is not a uniqueness constraint.
