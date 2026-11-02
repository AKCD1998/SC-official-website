# Ada points cutover

Set `SC_OFFICIAL_ADA_POINTS_MODE=ada-primary` only after the HQ point worker has
published fresh five-database observations and the pilot native readback passes.
Unset/off retains the legacy implementation. Unknown nonempty modes fail closed.
`SC_OFFICIAL_ADA_POINTS_MAX_AGE_SECONDS` defaults to 120 (allowed 5–3600).

In this mode Ada performs earning, product-specific awards, redemption and refund
point calculations. Select the customer in Ada before payment. SCCRM scanning
saves purchase history and displays the points Ada already recorded; a receipt
with no native point event receives no new SCCRM award. Redeem and standalone
earn commands direct employees to Ada. Local promotion activation is blocked.

The worker owns private `ada_points` storage in the original Supabase. The API
reads the verified `balance_cache` and original `native_events`; it never sums
the archived SCCRM ledger into Ada balances. Stale/unknown/review balances return
explicit unavailable metadata with null values, not a zero or legacy fallback.
Decimal strings preserve exact values. The POS update supports this metadata;
the separate optional Expo mobile UI still needs its display update.

Approved native-code mappings determine ownership. A phone/name match never
assigns a native point event to a member. Receipt awards use original native
points, even when an event has subsequently expired/been processed; current
balance uses the native effective contribution. Conflicting owners are held.

This repository contains no native SQL writer or provisioning credential. See
the SCCRMonPOS `sync-agent/points` operations package for source fingerprints,
copy tests, worker installation, append-only receiver receipts and pause controls.
Production readiness requires service/native/API evidence, not merely a green
test suite or an accepted Render deploy.
