# Central SCCRM point promotions

The existing Supabase database remains the source of member identity and now
stores promotion rules, receipt claims and the append-only point ledger. This
feature covers loyalty points, not AdaPos sale-price discounts.

## Contract and compatibility

- Public catalog: `GET /api/sccrm/promotions/active?branchCode=005`.
- Public estimate: `GET /api/sccrm/promotions/quote?branchCode=005&amount=250`.
- Browser portal: `/sccrm/promotions`; management: `/sccrm/promotions/admin`.
- Base rate is the existing desktop rate: 25 eligible THB per point. The older
  mobile/manual endpoint previously used /10; it now uses the same /25 engine.
  Historical ledger rows are not restated.
- `multiplier`, `fixed_bonus` and `threshold` use the existing promotion shapes.
  Optional conditions: `minimum_spend`, `bonus_points`, `branch_codes`. Unknown
  conditions/types fail instead of silently granting an unsupported benefit.
- Active rules are ordered by start, creation time and UUID. Rules stack in
  that order. Dates use server/database time; end time is exclusive. Promotions
  are evaluated when a claim is processed, rather than accepting a backdated
  client time. A branch-restricted rule requires that branch context.
- Existing `POST /api/loyalty/claims` fields and response fields remain. An old
  client's `previewPoints` is diagnostic only. The server revalidates eligible
  line totals, excludes the existing `เภสัช` name prefix, calculates the final
  award, and persists rules/revision with the claim and award mirror. Per-member
  locking and the receipt unique constraint prevent duplicate/concurrent awards.
- A central outage fails the request; it never silently substitutes base points
  for a promotion. Catalog responses are `no-store`. Browser/new desktop estimates
  refresh every 30 seconds and every actual award rechecks current rules.
- No minimum app version or forced binary update is introduced. The published
  **1.1.0 executable is unchanged** and can award the same central points. It has
  no promotion screen: use the shared browser portal and note that its old local
  estimate excludes bonuses. The final success message uses the server award.
  Version 1.2.0 adds portal links and a central estimate inside the receipt screen.

## Operator permissions and initial account

`SCCRM_PROMOTION_ADMIN_EMAILS` is a service-scoped comma-separated allowlist.
Existing website JWT login and a matching existing `users` account are required
for GET/POST `/api/sccrm/promotions` and PUT `/api/sccrm/promotions/:id`. A staff
device token cannot publish rules. This intentionally tightens the dormant
legacy POST endpoint that previously accepted any staff device.

For an allowlisted email with no existing account, the operator can issue an
initial setup file using `issue-promotion-admin-setup.cjs EMAIL PRIVATE_HTML_PATH`.
Supply the existing database/JWT settings and a trusted CA file via the process
environment. The generated file contains a credential: keep it private, never
commit/upload it, and give it only to the intended owner. Its link expires in one
hour. The owner enters a password in the HTTPS page; the link cannot reset an
existing account. The setup signature uses a key derived specifically for this
purpose, so the invitation cannot authenticate other website APIs. The browser
removes the fragment from history immediately and keeps passwords/tokens only
in memory. No activation email is sent by this command.

## Additive provisioning

`provision-central-promotions.cjs` defaults to a transaction that is rolled back.
Use `--apply` only after reviewing the dry run and existing schema. It requires
the existing CRM bootstrap, refuses a partial/unrecognized loyalty schema,
records an idempotency marker, creates 14 empty loyalty/promotion/POS-mirror
tables, enables RLS and revokes browser-role grants. The schema is based on the
repository's existing unified, cashier-claim and POS-mirror migrations. It does
not run old backfills, recreate identities, seed business promotions, or access
AdaAcc. Use strict TLS and `CRM_BOOTSTRAP_TLS_CA_FILE` for the operator connection.

Application rollback leaves additive tables and immutable awards intact. Disable
or edit a promotion for future awards; a binary rollback does not undo historical
ledger entries. Do not run the old points-backfill migration after promotions
have been awarded: it would destroy the original award basis.

## Verification

`central-promotions.test.cjs` covers rules, authorization, setup-token boundaries,
cache behavior and central outages. The opt-in existing PostgreSQL bootstrap
suite exercises provisioning, real SQL claims and preserved snapshots.

`verify-promotion-compatibility.cjs --local unused unused HELPER OLD_EXE NEW_EXE`
starts an isolated local PostgreSQL fixture database (cluster port 55441), real
Express handlers and two separate .NET helper processes. The helper loads each
exact executable's `ApiClient` rather than recompiling an imitation. Supply the
published 1.1.0 binary and the current 1.2.0 binary. Local tests also exercise
initial password setup, login, promotion create/update and single-use setup.

Live mode is opt-in:
`--live PRIVATE_ENV_PATH TRUSTED_CA_PATH HELPER OLD_EXE NEW_EXE`.
It uses the deployed API plus strict-TLS database readback; checks the 1.1.0
release hash; creates random test-only branch rules, QR member, two devices and
six claims; verifies 20 / 35 / 10 points under changed rules; rejects replay;
checks immutable snapshots and unchanged binaries; deletes only exact owned
fixture rows. It never changes a real promotion/member or installs a POS app.
Live fixture rules are created by the operator DB session and are excluded from
all ordinary branches. Account setup/management are tested locally; production
admin onboarding is completed by the owner using the private setup file.
