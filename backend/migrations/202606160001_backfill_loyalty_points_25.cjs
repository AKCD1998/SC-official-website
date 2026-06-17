/**
 * Data backfill: recompute loyalty points under the 1-point-per-25-THB rule.
 *
 * Earlier claims were awarded at floor(total/100). After switching the earn
 * rule to floor(total/25) (loyalty.js computeAwardedPoints), historical rows
 * still hold the old 4x-smaller values. This migration restates them so the
 * history view, the award mirror, the reversals, and the point_ledger balance
 * are all consistent with /25.
 *
 * SAFE TO RUN ONLY because no redemption/spend feature exists yet — balances
 * are purely (earned − reversed). TAKE A DB SNAPSHOT BEFORE RUNNING.
 *
 * Idempotent: every value is set to an absolute recomputed target, so running
 * it again produces the same result. Wrapped in a single transaction.
 *
 * @param {import('knex').Knex} knex
 */
const { randomUUID } = require("crypto");

const BAHT_PER_POINT = 25;

exports.up = async function up(knex) {
  await knex.transaction(async (trx) => {
    let claimsUpdated = 0;
    let ledgerEarnUpserts = 0;
    let reversalsUpdated = 0;
    let reversalsInserted = 0;

    // ── 1) Restate each claim's awarded_points + its 'purchase' ledger entry ──
    const claims = await trx("loyalty_claims")
      .select("id", "user_id", "branch_code", "receipt_no", "total_amount", "awarded_points");

    for (const c of claims) {
      const newAward = Math.max(0, Math.floor(Number(c.total_amount) / BAHT_PER_POINT));

      await trx("loyalty_claims").where({ id: c.id }).update({ awarded_points: newAward });
      claimsUpdated += 1;

      const existing = await trx("point_ledger")
        .where({ reference_id: c.id, type: "purchase" })
        .first("id");

      if (newAward > 0) {
        if (existing) {
          await trx("point_ledger").where({ id: existing.id }).update({ amount: newAward });
        } else {
          await trx("point_ledger").insert({
            id: randomUUID(),
            user_id: c.user_id,
            amount: newAward,
            type: "purchase",
            reference_id: c.id,
            note: `Earned from receipt ${c.receipt_no}`,
            created_by: "cashier",
            created_at: knex.fn.now(),
          });
        }
        ledgerEarnUpserts += 1;
      } else if (existing) {
        // total < 25 THB now earns 0 — drop any stale earn entry.
        await trx("point_ledger").where({ id: existing.id }).del();
      }
    }

    // ── 2) Sync the award mirror used by the reversal calculation ──
    await trx.raw(`
      UPDATE crm_loyalty_awards a
         SET points_awarded = lc.awarded_points
        FROM crm_pos_sale_events s
        JOIN loyalty_claims lc
          ON UPPER(BTRIM(lc.branch_code)) = s.branch_code
         AND UPPER(BTRIM(lc.receipt_no)) = s.doc_no
       WHERE a.sale_event_id = s.id
    `);

    // ── 3) Recompute reversals from the new award (same proportional method as
    //       the live endpoint), per original bill in created order with a cap ──
    const refunds = await trx("crm_pos_refund_events as r")
      .join("crm_pos_sale_events as s", function () {
        this.on("s.branch_code", "r.branch_code").andOn("s.doc_no", "r.original_doc_no");
      })
      .join("crm_loyalty_awards as a", "a.sale_event_id", "s.id")
      .leftJoin("crm_loyalty_reversals as rev", "rev.refund_event_id", "r.id")
      .select(
        "r.id as refund_event_id",
        "r.refund_doc_no",
        "r.original_doc_no",
        "r.refund_total",
        "s.paid_total",
        "a.id as award_id",
        "a.points_awarded",
        "a.customer_account_id",
        "rev.id as reversal_id",
        "rev.ledger_entry_id"
      )
      .orderBy([{ column: "a.id" }, { column: "r.created_at" }]);

    const usedByAward = {};
    for (const rf of refunds) {
      const award = Number(rf.points_awarded || 0);
      const saleTotal = Math.max(0, Number(rf.paid_total || 0));
      const refundTotal = Math.max(0, Number(rf.refund_total || 0));
      const ratio = saleTotal > 0 ? Math.min(1, refundTotal / saleTotal) : 0;
      const requested = Math.min(award, Math.floor(award * ratio));
      const used = usedByAward[rf.award_id] || 0;
      const available = Math.max(0, award - used);
      const rev = Math.min(available, requested);
      usedByAward[rf.award_id] = used + rev;

      if (rf.reversal_id) {
        await trx("crm_loyalty_reversals").where({ id: rf.reversal_id }).update({ points_reversed: rev });
        if (rf.ledger_entry_id) {
          await trx("point_ledger").where({ id: rf.ledger_entry_id }).update({ amount: -rev });
        }
        reversalsUpdated += 1;
      } else if (rev > 0) {
        // Refund earned no reversal under /100 but crosses the threshold under /25.
        const ledgerId = randomUUID();
        await trx("point_ledger").insert({
          id: ledgerId,
          user_id: rf.customer_account_id,
          amount: -rev,
          type: "adjustment",
          reference_id: rf.refund_event_id,
          note: `Refund reversal for ${rf.refund_doc_no || rf.original_doc_no}`,
          created_by: "system",
          created_at: knex.fn.now(),
        });
        await trx("crm_loyalty_reversals").insert({
          id: randomUUID(),
          refund_event_id: rf.refund_event_id,
          customer_account_id: rf.customer_account_id,
          points_reversed: rev,
          original_award_id: rf.award_id,
          ledger_entry_id: ledgerId,
          created_at: knex.fn.now(),
        });
        reversalsInserted += 1;
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `[backfill /25] claims=${claimsUpdated}, earn-ledger upserts=${ledgerEarnUpserts}, ` +
      `reversals updated=${reversalsUpdated}, reversals inserted=${reversalsInserted}`
    );
  });
};

exports.down = async function down() {
  // One-way data correction; reverting to the /100 values is not meaningful.
};
