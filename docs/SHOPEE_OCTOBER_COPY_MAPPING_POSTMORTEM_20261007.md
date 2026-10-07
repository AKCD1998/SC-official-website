# Shopee copy mapping review — 7 October 2026

## Problem and evidence

The 1–6 October review found 22 unresolved SC Drug Store product/variant
identities. Existing SKU evidence covered some products but not their new
combined listing names or newly sold variants. SOS S1-B was missing from the
structural model parser; Propoliz structural reuse supported sprays only.
DR.Morepen's six daily plans were already ready, including its explicitly
zero-sales day. This was not a mapping failure affecting both shops.

Identity and base units were checked against `StockDay-all-branches-20261007.xlsx`
(sheet `ทุกสาขา`, sync 2026-10-07T01:21:09.675000Z, SHA-256
`5e9729a0138db359dedc1aac393e400e88d7571548b5b695d72e439264ec4cd9`),
the shop's current Seller Centre listing variants, and SOS manufacturer's
[S-series](https://www.bangkokwellbeing.co.th/products-sosplus-ผ้าก๊อสปิดแผลพร้อมใช้-s-series)
and [T-series](https://www.bangkokwellbeing.co.th/products-sosplus-พลาสเตอร์ปิดแผลกันน้ำ-tseries)
package specifications. Stock balances and ERP prices were not used to set
historical sales quantities or amounts.

## Changes

- Add durable exact identity evidence for 20 single-SKU variants and two Polar
  bundle variants. Each rule retains the listing identity, master barcode/unit,
  provenance and quantity basis. This includes the Klean&Kare 500 mL crate of
  **24 bottles**, Vita-C 25-sachet variants and Propoliz box of ten sachets.
- Recognize SOS **S1-B** separately from red T1-B. Preserve series, dimensions,
  retail box and piece-count checks.
- Add typed Propoliz lozenge reuse for verified original honey-lemon, Vit C orange
  and X eight-tablet packages. Formula, eight-tablet contents, sachet/blister and
  box contents must agree. Unsupported formulas and altered packs remain held.
- Allow the renamed Polar blue pair / white gift listing to reuse the existing
  owner's allocation only through its exact verified component vector. No
  approval can be inherited by a different gift SKU or altered quantities.
- Keep Polar blue 280 mL ×2 / blue 80 mL ×1 mapped but price-held pending the
  owner's separate allocation answer. A white-gift approval does not authorize
  a blue-gift price allocation.
- Klean&Kare's seller GTIN 8854060609121 differs from StockDay barcode
  8854060609114. The owner explicitly confirmed IC-004060 and 24 bottles per
  crate on 7 October; retain both observations and the hashed confirmation.
  This confirmation does not edit the ERP barcode or authorize other packs.
- Bump the matcher version so cached copy results cannot reuse an old digest.

## Separate business-date issue

Two SC days also had an order-membership discrepancy. Original Business Insights
product-overview hourly workbooks were downloaded for both dates. Of their 48
hourly controls, 46 matched the paid-order cohort exactly. The two differences
matched one unique order's amount and its order/paid hours on opposite sides of
midnight. This is independent hourly evidence, not merely choosing an order to
force the daily total to match.

The prepared correction uses the existing private business-date ledger. It is
bound to immutable order identity, timestamps, source quantities and financial
components through `sourceFactFingerprint`. Original order facts, imported
workbooks and BI totals are preserved. Source drift invalidates the correction.
Original reports, hourly controls, source facts, DB preview and rollback record
are retained in the private October review output, not copied into this document.

## Validation and limits

- The frozen October snapshot evaluates all twelve daily plans and both ranges.
  Ten days are ready after the evidenced changes; the two remaining SC days
  contain only the blue-gift price hold described above.
- All 122 previously ready daily plans retain identical copy columns, quantities,
  amounts and source membership. Eight previous range controls also agree with
  their daily plans.
- Regression tests cover new structural spellings, wrong series, changed box
  contents, wrong formula/wrap and approval isolation for the renamed bundle.
- New wording is remembered through version-controlled rules and typed evidence
  reuse. A genuinely new formula, ambiguous package or unapproved multi-SKU
  allocation still requires review; there is no universal name similarity guess.

Rollback the matcher/mapping change by reverting its commit. Disable only the
specific fingerprint- and case-matching private date correction to reverse that
ledger change; do not rewrite raw source orders or disable unrelated cases.
