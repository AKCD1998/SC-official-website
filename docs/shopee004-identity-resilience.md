# SC004 stock identity and unit evidence

The [29 October follow-up](shopee004-mapping-review-20261029.md) records the fresh
21-order review, 15 verified versioned mappings, source receipts and the separate
Seamless display patch. Its production recovery status is dated explicitly;
the historical candidate counts below are not the current exception queue.

This candidate adds a storage-independent rule contract and a whole-store
preaudit. It does not create another reservation ledger or approve a dispatch,
cancellation, return, opening balance or stock-count adjustment.

## Observed on 23 October 2026

Seller Centre's all-status product export generated at 17:34 Bangkok contains
358 listings and 652 unique listing/variation pairs. A second export generated
at 17:44 provides descriptions for all 358 listings. No conflicting duplicate
variation identities were observed. These are catalog coverage counts, not a
statement that every variation has an approved stock-unit mapping.

The existing read-only metadata reader retrieved 352 requested POS products
from SERVER004/AdaAcc. All 352 existed and were active. The metadata read took
741.725 ms. It read no stock balances and made no POS writes. The current durable
ledger's POS contract contained 241 products when inspected.

The existing reviewed email matcher resolved a quantity rule for 356 of the 652
export variations. Of those, three have a Seller SKU that contradicts the old
mapped POS component. The other 296 are absent from the current reviewed catalog.
Among these 296, 234 have an exact active POS SKU candidate and 62 do not. An exact
SKU candidate does not approve a pack factor or a bundle's components. 104 of the
296 contain explicit pack or bundle language in their variation names.

Two of the three conflicts exchange the Seller SKUs for the 30- and 100-capsule
Lecithin options. The remaining conflict concerns two different POS records for
an eight-piece I-Herb product. They require an explicit evidenced choice; this
candidate does not change a live Seller listing or silently overwrite a mapping.

A private, unapplied bootstrap proposal binds 353 of the already reviewed,
non-conflicting variations to their current stable listing/variation identities.
Each candidate passes the new rule validator and the old stock-line validator
against the freshly read POS metadata. Provenance is retained as an existing
reviewed stock rule rather than relabelled as new description evidence. The
proposal also includes 39 historical exact aliases from the old catalog when
the stable identity and reviewed components/quantities still agree. Two other
historical aliases were left out because that equality was not proven.
All 353 candidates can append without an active identity or alias conflict.
These checks did not activate any candidate or modify an old reservation.

The remaining 299 variations comprise 296 without a reviewed quantity mapping
and the three explicit Seller SKU conflicts. Their descriptions, exact POS
candidates and unresolved evidence are prepared for review. Similarity does not
approve any of them. A raw description being present does not mean its sale-unit
meaning has been verified.

The full source workbook, descriptions, POS metadata and proposed matches remain
in private local audit inputs. They are not committed here. Only aggregate facts
are included in this document. No production mapping approval was made during
the audit, so the number of newly active versioned rules remains zero.

## Rule and evidence contract

`shopee004IdentityRules.js` exports:

- `validateIdentityRule(rule, {posCatalog, evidenceRefs})` validates a candidate
  against server-owned trusted evidence and the existing supported POS contract.
- `resolveIdentityRule({rule, item, posCatalog, evidenceRefs})` returns the existing
  `matched` or `bundle` shape, or a bounded `unmapped` reason.
- `createIdentityRuleMatcher({rules, posCatalog, evidenceRefs})` captures one
  immutable snapshot and returns a synchronous matcher. It returns `null` only
  when no exact rule applies, allowing the caller to use the old matcher.
  An explicit conflict or revoked rule must never fall through to the old rule.
  Its `.baseUnit(shop, productCode)` method supplies reviewed bundle units.
- `appendIdentityRule(...)` and `revokeIdentityRule(...)` prepare a new immutable
  revision with an optimistic expected version. They do not write storage.
- `auditStoreCatalog(...)` checks the full exported catalog before orders arrive.
  It returns private detailed records and a separately publishable aggregate.

A rule has schema `shopee004-identity-rule-v1`, one shop/branch scope, a stable
listing/variation pair, immutable rule identity, revision, active/revoked state,
approved exact aliases, seller SKU anchors, component POS codes and quantities,
and evidence references. A seller-owned SKU may differ from the POS code if an
explicit rule independently anchors that relationship. Names are never fuzzy
approval keys.

The caller supplies a **server-owned Map** of verified facts, not the evidence
objects from an HTTP request. Every referenced fact must have the exact shop,
branch, listing, variation and an observation time. The rule needs independent
seller catalog identity, exact quantity/component evidence, and a POS unit fact
for every component. Each alias also needs exact quantity evidence. Adding a new
pack name to a catalog does not reuse an old factor by itself. An existing
approved rule is recorded truthfully as `reviewed_stock_rule`, with mandatory
`reviewedRuleVersion`, `reviewedRuleReference`, `reviewAuthority` and
`auditReference`; it must not be relabelled as a freshly verified Seller Centre
description. A raw description alone has no approved quantity contract.

Both supported POS factors must equal one. Shared-stock aliases require the same
active master and factor checks already used by the stock reader. The module
does not invent conversion support for a positive but unsupported factor.

## Recovery integration

The main owner supplies storage and authenticated routes. They must append the
rule and operation audit in one transaction, check the expected exception/rule
revision, and queue only affected current, original and held identities. Mapping
approval must not approve a cancellation or release an old hold. Revocation must
fence affected products and retain history and holds until the existing ledger
reconciles them safely.

Use a registry revision to trigger semantic recovery after approved evidence
changes. Do not poll the same ambiguous unit forever as a transport retry. Fuzzy
or AI suggestions may be displayed with null quantity/unit; they cannot be
turned into verified facts by selecting a convenient name.

An incomplete export does not establish that a missing listing was deleted.
Missing active rule identities are reported as drift and never revoked
automatically. Conflicting duplicate listing/variation observations are fenced.

## Verification and release boundary

The 47 focused tests use synthetic identities and metadata. They cover stable-ID
conflicts, exact old/new aliases, pack drift, bundles, all four shared-alias cases,
unsupported conversion factors, evidence forgery, immutable snapshots,
revocation, optimistic conflicts and proactive audit coverage. They do not prove
that all live catalog units are settled or that a future order will be mapped.

Production integration needs the main owner's single migration, trusted evidence
storage, protected admin workflow, bounded recovery integration and a reviewed
bootstrap plan. This document grants no production schema, flag, mapping,
lifecycle or stock-balance write authority. Hourly, Full Sync, Transfer Delta,
their credentials, schedules, cohorts and automations remain unchanged.
