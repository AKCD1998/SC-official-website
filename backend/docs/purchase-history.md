# Member-linked purchase history

SCCRMonPOS confirms a selected member's paid receipt with `POST /api/loyalty/claims`.
The claim, all receipt lines, optional point award and POS mirror commit in one
transaction. `(branch_code, receipt_no)` is unique: replay cannot reassign a bill
to another member or award it twice. A zero-eligible-spend bill is still a purchase
and stores its full items with zero awarded points, without a point-ledger entry.

`GET /api/members/:id/purchase-history` accepts the existing revocable staff-device
bearer session, including installations without a shared POS API key. The legacy
key-only path remains supported. An invalid bearer never falls back to a key.
QR and employee registrations use the same `users`/`member_profiles` identities.

## Receipt contract

The existing `totalAmount` request field and `loyalty_claims.total_amount` remain
**eligible spend**. SCCRMonPOS 1.3.1 adds `receiptTotalAmount` from AdaPos GrandTotal,
`receiptDiscount`, `posCode`, `receiptCashierCode`, and per-item `seq`, `barcode`,
`lineDiscount`, `promotionCode`. All available receipt items, including excluded
pharmacy lines, are snapshotted in their original array order. Point calculations
still use eligible lines and the server's current promotion rules.

History returns `totalAmount` as the original paid receipt total, plus separate
`eligibleAmount`, the above metadata, `claimId` and `totalAmountSource`:

- `pos_header`: original POS header supplied by the client.
- `item_sum`: older client or historical record; sum of stored lines. May differ
  from the paid total when there was a receipt-level discount.
- `legacy_claim`: no stored items/header; only the old eligible amount is known.

The desktop marks estimated historical totals with `*`. The additive migration
does not rewrite or invent missing historic header values, item order or metadata.
Bills never linked and confirmed in SCCRMonPOS cannot be attributed to a member.
Resetting points, if later explicitly requested, must preserve purchase claims,
items and receipt snapshots. This implementation does not reset any points.

## Paging and member switching

`limit` defaults to 100, capped at 500. Responses add `hasMore` and `nextCursor`.
Pass the opaque cursor back as `?cursor=...` with the same member and page limit.
The keyset orders by sold/creation time and claim ID; cursor text retains database
microseconds. The desktop's **โหลดบิลก่อนหน้า** button appends older pages.
Each history load is tied to a generation so late responses cannot replace the
currently selected member. A new/no-match search clears the old member's details.

## Provisioning and rollback

After reviewing `202610210002_purchase_history.sql`, run
`node scripts/provision-purchase-history.cjs` for a rollback-only dry run, then
the same command with `--apply`. Use the existing scoped Supabase database URL
and verified provider CA in `CRM_BOOTSTRAP_TLS_CA_FILE`; never disable TLS checks.
The script runs only this additive migration, with short lock/statement timeouts,
checks both tables retain RLS, verifies both indexes, and refuses partial schemas.
It changes no existing business rows. Provision before deploying the route code.
Application rollback can keep these nullable columns and indexes in place.

## Verification

The PostgreSQL regression suite exercises provisioning, metadata/readback,
zero-point bills, duplicate prevention, member separation, 105 tied-timestamp
records with keyset paging, old requests and a rolled-back points-only reset.
Mock contract tests also cover revoked/anonymous sessions and malformed cursors.

`scripts/verify-purchase-history.cjs --local <PurchaseHistoryCheck.exe> <output>`
creates and removes its own isolated local PostgreSQL database. The Windows
helper operates actual search, selection and confirmation buttons, opens history,
switches members, loads 108 records and reopens the form in another process.
It instantiates components with synthetic receipts and **no AdaPos watcher**;
it does not run Program.Main, install an application or claim branch-device
installation/startup verification. Actual company-device enforcement is unchanged.

Opt-in production verification uses
`--live <private-env-file> <provider-ca-file> <helper> <output>`. It uses nonce-scoped
QR/employee members and staff-device/receipt fixtures in the existing Supabase,
checks DB readback and HTTP permissions, then removes only those exact fixtures.
No real POS receipt, customer record, AdaAcc database, promotion or balance is
modified by this verifier. Reports and synthetic screenshots go only to output.
