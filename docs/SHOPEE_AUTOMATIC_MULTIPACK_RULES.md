# Shopee automatic same-SKU multipack rules

## Current rule

Rule version: `same-sku-explicit-unit-anchor-v1`

The matcher derives `quantityPerSale` without adding a manual rule for each listing variation only when all of the following are true:

1. The records belong to the same Shopee shop and use the same Company SKU.
2. A separate catalog record explicitly sells `1` of the same packaging unit.
3. The target variation contains exactly one multiplier candidate for that anchored unit.
4. The multiplier is an integer from 2 through 100.

Recognized packaging units are box, sachet, can, jar, bar, pack, piece, and blister, including their current Thai and English aliases. Weight, volume, strength, and tablet counts are not treated as stock-unit multipliers.

Examples that qualify automatically:

- Myda `1 ก้อน` and `6 ก้อน` on the same SKU -> `quantityPerSale = 6`
- Entrasol `1 กระป๋อง` and `2 กระป๋อง` on the same SKU -> `quantityPerSale = 2`
- Air-X `1 แผง` and `1 กล่อง 50 แผง` on the same SKU -> `quantityPerSale = 50`
- One Gerd `1 ซอง` and `1 กล่อง 12 ซอง` on the same SKU -> `quantityPerSale = 12`

The current catalog produces 45 verified automatic multipack rules. Existing orders are re-matched when read, so historical sales summaries use the rule without rewriting stored order JSON.

## Fail-closed behavior

When the same SKU has differing pack sizes but no explicit one-unit anchor, the matcher does not guess a multiplier. It returns `quantityRuleStatus = requires_validation`; sales summary keeps the original listing quantity, and AdaSmart dry-run validation blocks the line from automatic stock effects.

The current catalog has 35 such variations.

## Deferred follow-up

Do not add aliases or quantity multipliers for these until the ERP stock unit is confirmed:

- Vita-C tablets: `IC-002516`, `IC-002353`, `IC-002300`, `IC-002485`, and `IC-002484`
- Vita-C Gummy: `IC-001849` and EXP `IC-001510`
- Historical Vita-C Gummy EXP product-name aliases that no longer exactly match the current catalog
- FESDRA `IC-002928`: box versus blister units
- Durex Fetherlite `IC-000068`: 3 pieces versus 12 pieces
- Oreda `IC-004371`: conflicting 10/50-sachet listing text
- Chlorpheniramine `IC-000665`: box versus blister wording without an explicit variation anchor

Once a deferred SKU's ERP base unit is confirmed, prefer storing one reusable SKU-level base-unit definition. New variations can then be parsed against that definition rather than adding a manual rule per variation.
