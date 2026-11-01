# AdaSmart copy: owner-approved allocations

The copy planner uses original merchandise, seller vouchers and Shopee-funded
product discounts, then reconciles the same shop/day and order count against
Business Insights. It does not use payout amounts, fees or balancing rows.

Migration 032 creates a private `shopee_copy_allocation_policies` ledger. An
enabled policy requires the owner's specific approval, timestamp, case reference
and the hash of the approval response. The ledger holds accounting allocation
methods separately from immutable Shopee facts and verified source line prices.
No production approval or order-specific financial data is seeded in Git.

Supported methods:

- Allocate a seller voucher in proportion to each original merchandise line's
  net sale. Largest remainder distributes whole satang; ties follow source line
  order. Documented Shopee support is added to its own product exactly once.
- Allocate the exact verified Polar bundle amount to the two blue cans and zero
  to the one free white can. Gift quantities remain separate from paid sales of
  the same SKU.
- Split an approved 350-baht Dr.Morepen meter and 25-strip bundle equally: 175
  baht per component per sale. A changed bundle price remains for review.

Bundle approvals match the exact shop, title, variant, SKU and unit factors.
Missing, disabled, ambiguous or invalid approval keeps copying blocked. Existing
unapproved bundle mappings remain identity evidence; they do not become source
price evidence merely because the owner approves an allocation.

The copy planner also reuses the financial reconciliation service's existing
seller-voucher campaign evidence for later-cancelled orders. Restoration requires
the original voucher code, an active applicable campaign, an exact satang
calculation and unchanged payment, financial and product facts. It never derives
a voucher from the difference against Business Insights. Original snapshots are
unchanged, and each restoration carries its voucher and campaign references.

All copy columns remain disabled until SKU/unit checks, original source evidence,
order count and the sum of quantity × price reconcile. Policies and campaign
restorations used for the plan are returned alongside per-source row references.
Apply migration 032 before deploying this reader. Preserve the private ledger's
before-state before enabling approvals and verify the proposed daily plans and
previously ready columns first. Disable the inserted policies to roll back their
application; do not edit original Shopee facts.

## Main component and nominal secondary lines, 1 November 2026

The owner instructed that a verified kit's main product take the remaining
source amount after allocating 0.10 THB to each subsequent SKU line per
purchased set. The policy method is
`primary_component_with_nominal_secondary_lines`. It identifies `primarySku`
explicitly because canonical component order may place another SKU first.
Each secondary component records `nominalLineCentsPerSale`; this amount is per
SKU line per set, not per ERP base unit.

For an 850.00 THB Safe AQ max III set, the approved interpretation is meter
IC-006009 ×1 = 849.80, strips IC-004131 ×1 = 0.10, and needles IC-001230 ×2 =
0.10 in total, or 0.05 per box of 50. Multiply both quantities and nominal line
amounts by the purchased set count. Preserve every source set's original total
and the usual exact-satang SKU consolidation. Ordinary paid sales of a secondary
SKU keep their own source amounts when consolidated; provenance identifies
the approved bundle allocation and the primary/secondary role.

These are accounting allocation roles. They do not label the kit contents as
Shopee free gifts. Existing positive-gift policies retain their separate gift
groups and per-gift-base-unit prices. Existing allocation methods are unchanged.

An exact, enabled, owner-approved policy and independently verified component
SKUs, ERP units and factors are still required. There is no name-based global
fallback, automatic choice of the first array entry, or approval of unknown kit
contents. Keep a contradictory pack under review even when its price method is
approved. Reject insufficient source totals and nominal amounts that cannot
keep every ERP unit positive at two decimal places. No approval is seeded in
Git; the approved response hash and exact per-kit policy remain in the existing
private ledger. This does not authorize AdaSmart entry or stock/lifecycle writes.

Live SERVER004 metadata on 1 November corrected the earlier assistant's
reversed meter/strip SKU labels. The v2 private policy moves the main-product
amount to IC-006009 while preserving component quantities, original kit totals
and every other source sale. Keep the disabled v1 record for audit; do not reuse
the earlier exported v1 prices for the three affected daily batches.

## Owner-confirmed Smart kit and exact accounting identity

The purchased 50-strip/50-needle variant has conflicting illustration and
current variation text. The owner confirmed the purchased variant and then
specified one IC-006010 meter box with its ten included strips, plus one
IC-003101 box of 50 additional strips and one IC-001230 box of 50 needles.
Use one ERP box of each component. The existing accounting supplement records
the exact shop/title/variation, Seller evidence, current POS units and the
owner's contents-confirmation hash. It does not change the physical matcher.

Each component must have an active, independently evidenced POS identity with
a unit factor of one. Reject duplicate components, conflicting or partial
listing IDs, unexpected source SKUs/barcodes, missing owner evidence, and
changed pack names. The 100-needle variant remains held and cannot borrow the
50-needle rule. Financial allocation still needs a separate enabled approval
in the existing private ledger; identity evidence alone supplies no price.

For the approved 500.00 THB kit, the main-product method allocates 499.80 to
IC-006010 and 0.10 each to IC-003101 and IC-001230. Do not substitute whole-kit
IC-003200: its current title says 50 strips while its POS BOM contains a
25-strip component. This change neither repairs that product master nor
authorizes an AdaSmart document or a physical stock/lifecycle action.
