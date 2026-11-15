# Member preorder history

This adds member-bound records to the SCCRM purchase-history window. It does
not create a purchasing case, order, sale, loyalty claim or point event.

## Staff flow

1. Choose a member in purchase history and click the orange **ระบบพรีออเดอร์**.
2. **ข้อมูลประวัติพรีออเดอร์** holds paper/LINE/staff records. Add or edit products,
   original quantity/unit, recurrence, source and uncertainties. Unknown dates
   remain unknown. Unmatched products can be recorded manually.
3. **ข้อมูลบิลพรีออเดอร์จริง** proposes only that member's existing receipts with
   exact matching catalog codes. These remain **รอยืนยัน** until the employee
   explicitly confirms a selected bill. Product overlap alone is not proof.
4. A mistaken confirmation can be revoked with a reason. Nothing deletes or
   changes the original receipt, source record, customer or points.

## Contract and boundaries

All routes require the existing opaque staff-device bearer token. The private
schema is not exposed through the Supabase client API. Customer sessions and
revoked devices cannot read or write this data. Responses use `private, no-store`.

- `GET /api/members/preorders/catalog?q=` — existing trusted StockDay catalog.
- `GET /api/members/:id/preorders?cursor=` — structured notes, confirmed links,
  and candidate receipts from one existing history page (100 source claims).
- `POST /api/members/:id/preorders` — create/edit; `requestId` UUID required,
  plus `id` and current `version` when editing.
- `POST /api/members/:id/preorders/receipt-confirmations` — requestId, branchCode,
  receiptNo, fingerprint and the page sourceCursor. Re-reads that member's actual
  receipt before writing confirmation metadata.
- `POST /api/members/:id/preorders/receipt-confirmations/:linkId/revoke` —
  requestId and reason; retains the former confirmation in the audit.

Member binding uses the existing UUID, never phone/name matching. Exact product
codes can reference multiple verified identical catalog rows; no brand/strength
substitution is inferred. Actual receipt units and final paid totals are retained.
Void pairs are netted; returns stay visible. Differing copies and changed receipt
fingerprints block confirmation. Confirmations outside the fetched page explicitly
carry `verificationStatus: not_on_page`, rather than claiming fresh verification.

Requests are committed with their JSON response in one transaction. Replaying
the same request returns the stored response; changed payload/member/device gets
409. Optimistic versions protect concurrent edits and immutable versions preserve
old note content. An active branch/receipt can only be linked once globally.
Receipt-service failure leaves manual notes available; this is not an offline
terminal write queue. A failed network save preserves the open editor for retry.

## Provision and release

1. Run the synthetic copy checks below and the native Windows desktop CI.
2. Review/apply `backend/schema/memberPreorders.sql` using the project's Supabase
   migration channel. It only adds the owned private namespace, RLS and indexes;
   its marker guard rejects an unrelated namespace. It starts **disabled**.
3. Deploy this backend after the approved Git change and verify staff access,
   customer denial, and the ordinary purchase-history route.
4. Enable only this feature:
   `UPDATE sccrm_preorders.meta SET enabled=true WHERE singleton;`
5. Prepare a private import plan with the original source SHA-256, human filename,
   exact existing UUID/AR, source row, expected remark marker and structured items.
   Run `node backend/scripts/import-member-preorders.cjs PRIVATE-PLAN.json` for
   read-only preflight, then add `--apply` for the reviewed cohort. Source remarks
   are retained. Resuming skips an already imported source row and preserves staff
   corrections. No real customer or medication data belongs in Git/test fixtures.
6. Release the signed native installer through the existing fleet updater. It
   must wait for active SCCRM work. Do not close AdaPos or create test customers.
7. Check all nine migrated source records and candidate receipts. Staff, not the
   import script, confirms actual preorder bills. Check the UI using read-only
   viewing of real records; use synthetic fixtures for mutation tests.

Pause: set only `sccrm_preorders.meta.enabled=false`. The original purchase-history
view remains available. Restore the previous backend/client if necessary and keep
the private tables for audit; do not drop records or undo customer/bill data.

Audit: `histories` / `history_versions` hold current and prior source records;
`bill_links` holds confirmation/revocation snapshots; `events` holds actor/action/
time. Read them through a restricted operator connection, without dumping PII.

## Verification

`npm --prefix backend run test:member-preorders` runs unit checks. For the full
copy suite, set `SCCRM_PREORDER_TEST_DATABASE_URL` to a **fresh empty localhost**
database named `crm_preorders_test_<hex>`; production/remote URLs are rejected.
The GitHub backend CI provisions its own database and runs this automatically.

2026-11-15 local copy run: **19/19 passed**, PostgreSQL 18, 9.20 seconds including
cluster setup/closure, sampled owned RSS 249,257,984 bytes, min free RAM
3,202,396,160 bytes, no remaining owned children. The tests cover replay after
response loss, concurrent edit conflicts, paper re-import, unavailable receipts,
staff authorization, exact-code suggestions, voids, stale/conflicting copies,
wrong member rejection, explicit confirmation/revocation, feature pause and
unchanged synthetic customer/receipt/point rows. This does not prove a native UI
build or production deployment; those require their separate release checks.

Existing purchase-history, loyalty-member, Ada-point-route and member-directory
regressions also passed: **4 suites / 67 tests**, using the original default DB
contract. Their runner closed with no owned children remaining.
