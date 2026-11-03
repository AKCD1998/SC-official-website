# Manual SCCRM fleet updates

`/api/sccrm-fleet` serves a separate operational queue. It does not modify member,
receipt, point, branch assignment or Ada records. The companion desktop change
and SCProductDev console are documented in SCCRMonPOS `docs/FLEET_CONTROL.md`.

## Provisioning

1. Apply only `backend/supabase/migrations/20261103060203_sccrm_fleet_manual_updates.sql`
   to the existing SCCRM database. It creates the private `sccrm_fleet` schema,
   with RLS and no browser-role access. Leave `settings.enabled=false` initially.
2. Build and initialize the SCProductDev console using its native repository
   helper. Register its generated non-secret `id`, `station` and `token_hash` in
   `sccrm_fleet.admin_keys` with a parameterized administrative query. The raw
   random bearer credential stays in the current user's DPAPI-protected file.
3. Deploy the API, verify anonymous requests are rejected, and use the console
   to inspect all eight approved nodes. No POS is considered enrolled until an
   authenticated fleet-capable client reports its installed binary.
4. Bootstrap one terminal after its staff have saved their SCCRM work. Previous
   versions through 1.3.13 do not have the command receiver. Preserve its existing
   installation folder, session and Ada configuration; leave AdaPos running.
5. Publish a reviewed, signed fleet-capable release using the native publisher.
   Enable command handoff from the console and request a pilot transition.
   Verify the terminal's new running hash and continued AdaPos operation before
   enabling other terminals. SQL queue acceptance alone is not end-to-end proof.

## Protocol and boundaries

Admin requests use a separately revocable bearer credential. A release is fetched
from the fixed SCCRMonPOS channel and verified with the existing publisher RSA
public key, source-clean metadata, fixed download URL and protocol version.
Each explicit `requestId` persists its immutable release and node targets.
Repeating a request after a lost response returns the same batch, including when
the recommended release has subsequently changed. A second overlapping command
does not replace active work. Unenrolled terminals are reported separately.

Clients use their existing revocable staff-device token, receive only their own
job and cannot move a previously enrolled identity to another node. The native
client additionally verifies its compiled device policy and signed release.
Commands contain no shell program, configuration edits or arbitrary paths.

The client polls every 15 seconds and may stage files while busy. Restart waits
for pending receipt/member/API/QR/refund work, then checks readiness again after
the final network acknowledgement. The helper closes/reopens only SCCRM. Success
requires the exact requested executable hash reported by the running new client.
Offline jobs persist for 14 days; queue/client restart and repeated reports do not
create duplicate work. An offline terminal does not prevent another from updating.

## Status, pause and recovery

The console shows branch/POS, current version, last heartbeat, command state and
target version. A successful state means the client reported its running hash;
no heartbeat or an accepted command alone is not success.

Click **พักคำสั่งอัปเดต** to stop new installation handoffs. A helper already given
a local replacement finishes. This setting affects only fleet updates; the
member/points sync services, AdaPos and Shopee automation continue normally.
An emergency administrative pause is the scoped statement:

```sql
UPDATE sccrm_fleet.settings SET enabled=false WHERE id=1;
```

Read operational status from `sccrm_fleet.devices`, `jobs` and `events` without
reading native session files or customer data. Revoke only this console key using
its exact `admin_keys.id`; never reset POS tokens or the release signing key.
Retain queue tables and executable backups on rollback. Recommending an earlier
signed fleet-capable release still requires an explicit new operator command.

## Verification

The isolated test suite requires a fresh loopback PostgreSQL database named
`crm_fleet_test_*` through `SC_OFFICIAL_FLEET_TEST_DATABASE_URL`. It refuses remote
URLs and existing fleet schemas. Tests cover offline/reconnect, client restart,
lost acknowledgement, repeated requests, concurrent-command exclusion, busy
handoff deferral, pause, exact-hash success, wrong/revoked identities, browser
privileges, and preservation of an independent existing-data sentinel. Real POS
acceptance is recorded separately after deployment.
