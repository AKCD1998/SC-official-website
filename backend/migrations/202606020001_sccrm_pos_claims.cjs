/**
 * Migration: SCCRM POS sale/refund mirroring + post-sale claim flow
 *
 * Adds CRM-owned POS evidence and claim tables on top of the shared users/member
 * model. These tables are append-only or upsert-safe mirrors of verified POS
 * events pushed from PaaSRTSM.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable("crm_pos_sale_events", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.string("branch_code", 20).notNullable();
    table.string("pos_code", 50).nullable();
    table.string("doc_no", 255).notNullable();
    table.string("doc_type", 20).notNullable();
    table.timestamp("sale_at", { useTz: true }).notNullable();
    table.string("cashier_code", 255).nullable();
    table.decimal("gross_total", 12, 2).notNullable().defaultTo(0);
    table.decimal("net_total", 12, 2).notNullable().defaultTo(0);
    table.decimal("paid_total", 12, 2).notNullable().defaultTo(0);
    table.string("ada_customer_code", 255).nullable();
    table.string("claim_status", 20).notNullable().defaultTo("unclaimed");
    table.string("source_system", 100).nullable();
    table.string("source_event_key", 255).notNullable().unique();
    table.timestamp("source_synced_at", { useTz: true }).nullable();
    table.jsonb("tender_rows").notNullable().defaultTo("[]");
    table.jsonb("raw_payload").notNullable().defaultTo("{}");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(["branch_code", "doc_no"]);
  });

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_crm_pos_sale_events_sale_at
      ON crm_pos_sale_events (sale_at DESC)
  `);

  await knex.schema.createTable("crm_pos_sale_line_events", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table
      .uuid("sale_event_id")
      .notNullable()
      .references("id")
      .inTable("crm_pos_sale_events")
      .onDelete("CASCADE");
    table.integer("line_no").notNullable();
    table.string("product_code", 255).notNullable();
    table.string("barcode", 255).nullable();
    table.decimal("qty", 12, 2).notNullable().defaultTo(0);
    table.string("unit_code", 100).nullable();
    table.string("unit_name", 255).nullable();
    table.decimal("net_amount", 12, 2).notNullable().defaultTo(0);
    table.decimal("discount_amount", 12, 2).notNullable().defaultTo(0);
    table.string("lot_no", 255).nullable();
    table.date("expiry_date").nullable();
    table.jsonb("raw_payload").notNullable().defaultTo("{}");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(["sale_event_id", "line_no", "product_code"]);
  });

  await knex.schema.createTable("crm_pos_refund_events", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.string("branch_code", 20).notNullable();
    table.string("pos_code", 50).nullable();
    table.string("refund_doc_no", 255).notNullable();
    table.string("original_doc_no", 255).notNullable();
    table.timestamp("refund_at", { useTz: true }).notNullable();
    table.string("cashier_code", 255).nullable();
    table.decimal("refund_total", 12, 2).notNullable().defaultTo(0);
    table.string("source_system", 100).nullable();
    table.string("source_event_key", 255).notNullable().unique();
    table.timestamp("source_synced_at", { useTz: true }).nullable();
    table.jsonb("tender_rows").notNullable().defaultTo("[]");
    table.jsonb("raw_payload").notNullable().defaultTo("{}");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(["branch_code", "refund_doc_no"]);
  });

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_crm_pos_refund_events_original_doc
      ON crm_pos_refund_events (branch_code, original_doc_no)
  `);

  await knex.schema.createTable("crm_pos_refund_line_events", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table
      .uuid("refund_event_id")
      .notNullable()
      .references("id")
      .inTable("crm_pos_refund_events")
      .onDelete("CASCADE");
    table.integer("line_no").notNullable();
    table.string("product_code", 255).notNullable();
    table.decimal("qty", 12, 2).notNullable().defaultTo(0);
    table.decimal("net_amount", 12, 2).notNullable().defaultTo(0);
    table.string("lot_no", 255).nullable();
    table.date("expiry_date").nullable();
    table.jsonb("raw_payload").notNullable().defaultTo("{}");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(["refund_event_id", "line_no", "product_code"]);
  });

  await knex.schema.createTable("crm_sale_claim_tokens", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.string("branch_code", 20).notNullable();
    table.string("doc_no", 255).notNullable();
    table.string("token_hash", 255).notNullable().unique();
    table.string("source_event_key", 255).notNullable();
    table.timestamp("expires_at", { useTz: true }).notNullable();
    table.timestamp("issued_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("used_at", { useTz: true }).nullable();
  });

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_crm_sale_claim_tokens_doc
      ON crm_sale_claim_tokens (branch_code, doc_no, issued_at DESC)
  `);

  await knex.schema.createTable("crm_sale_claims", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table
      .uuid("sale_event_id")
      .notNullable()
      .references("id")
      .inTable("crm_pos_sale_events")
      .onDelete("CASCADE");
    table
      .uuid("customer_account_id")
      .notNullable()
      .references("id")
      .inTable("users")
      .onDelete("CASCADE");
    table
      .uuid("claim_token_id")
      .notNullable()
      .references("id")
      .inTable("crm_sale_claim_tokens")
      .onDelete("RESTRICT");
    table.string("claim_channel", 50).notNullable().defaultTo("mobile");
    table.timestamp("claimed_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(["sale_event_id"]);
  });

  await knex.schema.createTable("crm_loyalty_awards", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table
      .uuid("sale_event_id")
      .notNullable()
      .references("id")
      .inTable("crm_pos_sale_events")
      .onDelete("CASCADE");
    table
      .uuid("customer_account_id")
      .notNullable()
      .references("id")
      .inTable("users")
      .onDelete("CASCADE");
    table.integer("points_awarded").notNullable();
    table.jsonb("promotion_snapshot").notNullable().defaultTo("[]");
    table
      .uuid("ledger_entry_id")
      .notNullable()
      .references("id")
      .inTable("point_ledger")
      .onDelete("CASCADE");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(["sale_event_id"]);
  });

  await knex.schema.createTable("crm_loyalty_reversals", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table
      .uuid("refund_event_id")
      .notNullable()
      .references("id")
      .inTable("crm_pos_refund_events")
      .onDelete("CASCADE");
    table
      .uuid("customer_account_id")
      .notNullable()
      .references("id")
      .inTable("users")
      .onDelete("CASCADE");
    table.integer("points_reversed").notNullable();
    table
      .uuid("original_award_id")
      .notNullable()
      .references("id")
      .inTable("crm_loyalty_awards")
      .onDelete("CASCADE");
    table
      .uuid("ledger_entry_id")
      .notNullable()
      .references("id")
      .inTable("point_ledger")
      .onDelete("CASCADE");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(["refund_event_id"]);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists("crm_loyalty_reversals");
  await knex.schema.dropTableIfExists("crm_loyalty_awards");
  await knex.schema.dropTableIfExists("crm_sale_claims");
  await knex.schema.dropTableIfExists("crm_sale_claim_tokens");
  await knex.schema.dropTableIfExists("crm_pos_refund_line_events");
  await knex.schema.dropTableIfExists("crm_pos_refund_events");
  await knex.schema.dropTableIfExists("crm_pos_sale_line_events");
  await knex.schema.dropTableIfExists("crm_pos_sale_events");
};
