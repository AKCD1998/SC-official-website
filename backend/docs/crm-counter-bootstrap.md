# CRM counter trial setup

The counter web app uses `/api/sccrm/auth/staff-device` and `/api/crm/members`
on the Official website backend. Its database must contain the shared identity,
staff-device, member-profile, consent and health-record tables. The Seamless
startup migration runner creates none of these tables.

`scripts/provision-crm-counter.cjs` applies only the named SQL file and keeps a
separate CRM counter ledger. It never runs the historical Knex migrations,
loyalty backfills, POS mirrors, or Seamless migrations. It refuses a partially
present or unrecognized CRM schema. Reapplying a recorded setup preserves rows.

Before use, confirm the configured database is the intended empty trial CRM
database, inspect the current live build and migration ledgers, and review the
exact SQL. Keep the database URL and the existing staff PIN out of output.
The six application tables and their ledger have RLS enabled and no privileges
for PUBLIC, Supabase anon, or authenticated. Only the existing server connection
owns/uses these tables. No staff PIN, device, branch, or customer is seeded.

With the existing `SC_OFFICIAL_SUPABASE_DATABASE_URL` supplied securely and, when
needed, `CRM_BOOTSTRAP_TLS_CA_FILE` pointing to the provider's public CA:

```sh
node scripts/provision-crm-counter.cjs          # execute, verify, ROLLBACK
node scripts/provision-crm-counter.cjs --apply  # explicit reviewed commit
```

Do not disable TLS verification or copy the URL into commands/history. The script
rejects URL SSL overrides. The default dry run changes no retained database state.
This SQL file is deliberately outside both automatic migration runners.

Verify the deployed API with a synthetic staff device and synthetic member,
including rejected credentials and duplicate registration. Delete only those
explicitly created fixture rows afterward and verify no fixture remains. Never
print tokens, PINs, member identifiers, or request/response bodies. The PostgreSQL
CI test exercises these routes against an ephemeral database and rolls back.

This bootstrap covers counter registration. It does not provision website email
OTP, customer/mobile login, loyalty ledgers, POS sale/refund mirrors, or pharmacy
medical-record APIs. Before enabling real medical-data collection, separately
review the existing health route's consent enforcement and identifier storage.
Full Sync, Transfer Delta and Hourly configuration are outside this setup.
