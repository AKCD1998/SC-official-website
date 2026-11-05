# POS basic membership against the existing Supabase database

## Shared Ada contacts and medical editing — 2026-11-05

An authenticated edit may keep an Ada contact's displayed phone when another
separate account owns the same number. Under the existing per-member transaction
lock, resending that unchanged number does not claim it in `users.phone_number`;
the existing Ada directory/link remains its contact source. A genuinely changed
number still uses the unique account constraint. No person/company merge, login
transfer, Ada write or purchase reassignment occurs.

The additive `supabase/migrations/20261105014604_member_pharmacy_records.sql`
provisions the pre-existing medical API contract, enables RLS and revokes browser
role access. It does not copy the separate `crm_member_health_records` data or
rewrite members, purchases or points. Apply this scoped migration explicitly;
do not run all legacy migrations. Roll back application code without dropping
medical records. Keep medical values out of logs and rollout evidence.

POS 1.3.20 fixes Thai Windows birth-date parsing/serialization. The popup returns
its draft through **ใช้ข้อมูลนี้**; the parent member Save commits both together.
Copy tests cover shared-number edits, readback/retry, changed-number collision
rollback, distinct identities, unchanged Ada snapshots/history and RLS denial.

SCCRMonPOS uses the same `users` and `member_profiles` identities as `/join` QR
registration. No new database, table or migration is required for basic member
creation, search, detail and editing.

- `POST /api/members` and `GET /api/members/search` retain staff-device bearer auth.
- `GET /api/members/:id` and `PUT /api/members/:id` now accept that same valid,
  revocation-checked staff session. Existing POS-key-only integrations remain
  supported. When an Authorization header is supplied, an invalid/revoked staff
  session fails closed, including when a valid legacy POS key is also supplied.
- The desktop client sends its staff bearer token for detail/edit, so basic
  membership does not require distributing an additional POS API key.
- Missing `point_ledger` or `member_pharmacy_med_records` does not block basic
  profiles. Responses keep `currentPoints` for compatibility and explicitly add
  `pointsAvailable` and `pharmacyMedRecordAvailable`. The updated POS displays
  unavailable points as unavailable and prevents awarding them.
- If pharmacy storage is missing, a medical write is rejected before any basic
  edit is committed. Existing medical data and behavior are retained when that
  optional table is present. A missing medical table is not provisioned implicitly.
- New members use the bootstrap-supported `bronze` tier. Phone formatting and
  Thai +66 prefixes are normalized consistently. Unique phone/email collisions
  return 409, and edits roll back rather than partially committing.
- Updating a QR-created member retains its UUID, member code, verification state
  and recorded QR consent. Basic edits never create a second identity or issue a
  customer login token. The desktop still prompts for its configured edit PIN.

The old desktop create flow tried to parse a single-member response as an array
before its fallback, which could show a failure after a successful registration.
The updated ApiClient accepts flat, wrapped and legacy array responses, reads
both `error` and `message` errors, and retains capability flags through selection.

## Validation

`loyalty-members.test.cjs` retains legacy points/medical behavior and tests basic
availability and staff authorization. The existing opt-in local PostgreSQL
bootstrap integration test now exercises QR registration followed by POS search,
read, edit, duplicate rejection, transaction rollback and consent preservation.
It runs under the existing CI `CRM_COUNTER_POSTGRES_SMOKE=1` flag. The desktop
`tools/MemberApiCheck.csproj` tests its exact parser and can exercise the real
ApiClient with a synthetic fixture against the deployed service.

Production verification must use unique synthetic names/phones and a temporary
staff device. Supply existing credentials in memory, never on command lines or
in reports; remove only the exact created fixture identities/device afterward.
No AdaAcc write or loyalty claim is part of this verification. Deploy this backend
and use the updated SCCRMonPOS executable; replacing the executable on a terminal
is a separate step from deploying Render.
