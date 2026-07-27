# Testing the `seamless` module (auto-print agent, LINE notify, appAuth)

This backend's other modules test with mocked SQL (see `tests/seamless-processing-records.test.cjs`).
The `seamless` module's auto-print-agent/LINE/appAuth code deliberately does **not** follow that
convention for its own tests — it hits a real disposable PostgreSQL instance instead. This is not
an oversight; it's inherited discipline from where this code originated (`ClaspSCxSeamless`,
`docs/10-print-agent-tasks.md` / `docs/11-print-agent-review-ledger.md`), where mocked SQL
repeatedly failed to catch real concurrency bugs across 12 rounds of review:

- **R7**: a queued print-job row was never consumed by the agent, so a document could re-enter
  the print queue forever after a reprint completed.
- **R11**: two truly concurrent `POST /api/agent/print-jobs` calls for the same document created
  two separate database rows.
- **R12**: after R11's DB-level fix, every concurrent caller still received an indistinguishable
  HTTP 201 "success" — the losing caller(s) would have downloaded and physically printed the
  document a second time, even though the database only ever held one row.

None of these would have been caught by a hand-written SQL-pattern mock — each was only found by
firing real concurrent HTTP requests at a real Postgres transaction and inspecting the actual rows
afterward. Keep testing this module against a real database.

## Local test environment

```bash
# Start a disposable Postgres (Docker Desktop must be running)
docker rm -f seamless-test-pg 2>/dev/null
docker run -d --name seamless-test-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=seamless_test -p 55450:5432 postgres:16-alpine

# Apply the seamless module's own migrations (reads/writes clasp_scx_seamless.schema_migrations)
cd backend
DATABASE_URL="postgres://postgres:postgres@localhost:55450/seamless_test" npm run seamless:migrate

# Run just the seamless suite against it
DATABASE_URL="postgres://postgres:postgres@localhost:55450/seamless_test" npx jest tests/seamless-*.test.cjs --runInBand

# Run the FULL backend suite — everything else uses mocks and is unaffected either way
npx jest --runInBand

# Clean up
docker rm -f seamless-test-pg
```

`DATABASE_URL` must be exported in the **same shell invocation** that runs `npm run seamless:migrate`
/ `npx jest` — this repo's `db.js` prefers `SC_OFFICIAL_SUPABASE_DATABASE_URL` /
`SC_OFFICIAL_DATABASE_URL` / `DATABASE_URL` in that order, and `dotenv.config()` will not override
an already-exported shell variable, so an inline `DATABASE_URL=... command` (not a separate
`export` line beforehand) is the reliable pattern — confirmed the hard way during the initial port:
a separate `export` line followed by `command &` did not reliably propagate into the backgrounded
`node` process in this environment, while `VAR=value command` did every time.

When `DATABASE_URL` isn't set at all, the DB-backed tests in `tests/seamless-agent-api.test.cjs`
skip automatically (`describe.skip`) rather than fail — this is intentional so `npm test` stays
safe to run without a database, matching the rest of this backend's test suite.

## Concurrency regression discipline

Any change to `services/printAgentService.js`'s `createAgentPrintJob` (the claim-or-create +
advisory-lock + 409-conflict logic) must be re-verified by:

1. Running the existing regression test in `tests/seamless-agent-api.test.cjs`
   ("10 truly concurrent POST /api/agent/print-jobs...") — it asserts exactly one 201 winner and
   nine 409 losers, not just "one database row."
2. Running the full suite **three times consecutively on the same unreset database** — several
   past regressions here were test-isolation flakiness that only showed up on a second run against
   state left behind by the first.

## What's intentionally NOT covered by automated tests yet

- Real LibreOffice/SumatraPDF printing on เครื่อง 000 (the print-agent CLI itself lives in the
  `print-agent/` folder of the `ClaspSCxSeamless` repo and is unchanged by this port — only its
  `.env`'s `API_BASE_URL`/`INTERNAL_API_TOKEN` point here now).
- Printer `JobStatus`/offline detection and 90-day log retention (tracked as a known gap in
  `ClaspSCxSeamless/docs/10-print-agent-tasks.md`, not implemented there or here).
