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
