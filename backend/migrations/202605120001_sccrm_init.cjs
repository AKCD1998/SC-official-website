/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.raw(
    "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'customer_tier') THEN CREATE TYPE customer_tier AS ENUM ('bronze', 'silver', 'gold'); END IF; END $$;"
  );
  await knex.raw(
    "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'point_ledger_type') THEN CREATE TYPE point_ledger_type AS ENUM ('purchase', 'redeem', 'adjustment', 'expire', 'promotion'); END IF; END $$;"
  );
  await knex.raw(
    "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'transaction_source') THEN CREATE TYPE transaction_source AS ENUM ('pos_import', 'manual', 'online'); END IF; END $$;"
  );
  await knex.raw(
    "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'promotion_type') THEN CREATE TYPE promotion_type AS ENUM ('multiplier', 'fixed_bonus', 'threshold'); END IF; END $$;"
  );

  await knex.schema.createTable("customers", (table) => {
    table.uuid("id").primary();
    table.string("phone", 32).notNullable().unique();
    table.string("full_name", 255);
    table.string("email", 255).unique();
    table.string("line_uid", 255).unique();
    table.string("google_uid", 255).unique();
    table
      .specificType("tier", "customer_tier")
      .notNullable()
      .defaultTo("bronze");
    table.boolean("is_active").notNullable().defaultTo(true);
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable("customer_credentials", (table) => {
    table.uuid("customer_id").primary().references("id").inTable("customers").onDelete("CASCADE");
    table.string("password_hash", 255).notNullable();
    table.timestamp("email_verified_at", { useTz: true });
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable("customer_email_verifications", (table) => {
    table.uuid("id").primary();
    table.string("customer_email", 255).notNullable().index();
    table.string("otp_hash", 255).notNullable();
    table.timestamp("expires_at", { useTz: true }).notNullable();
    table.timestamp("used_at", { useTz: true });
    table.integer("attempt_count").notNullable().defaultTo(0);
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable("customer_refresh_tokens", (table) => {
    table.uuid("id").primary();
    table.uuid("customer_id").notNullable().references("id").inTable("customers").onDelete("CASCADE");
    table.string("token_hash", 255).notNullable().unique();
    table.string("device_label", 255);
    table.timestamp("expires_at", { useTz: true }).notNullable();
    table.timestamp("revoked_at", { useTz: true });
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("last_used_at", { useTz: true });
  });

  await knex.schema.createTable("staff_devices", (table) => {
    table.uuid("id").primary();
    table.string("device_id", 255).notNullable().unique();
    table.string("device_name", 255).notNullable();
    table.string("token_hash", 255).notNullable().unique();
    table.timestamp("last_seen_at", { useTz: true });
    table.timestamp("revoked_at", { useTz: true });
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable("transactions", (table) => {
    table.uuid("id").primary();
    table.uuid("customer_id").references("id").inTable("customers").onDelete("SET NULL");
    table.decimal("total_amount", 12, 2).notNullable();
    table.integer("point_earned").notNullable().defaultTo(0);
    table.specificType("source", "transaction_source").notNullable();
    table.string("pos_ref_id", 255).unique();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable("promotions", (table) => {
    table.uuid("id").primary();
    table.string("name", 255).notNullable();
    table.specificType("type", "promotion_type").notNullable();
    table.decimal("value", 12, 2).notNullable();
    table.jsonb("condition_json").notNullable().defaultTo("{}");
    table.timestamp("starts_at", { useTz: true });
    table.timestamp("ends_at", { useTz: true });
    table.boolean("is_active").notNullable().defaultTo(true);
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable("redemptions", (table) => {
    table.uuid("id").primary();
    table.uuid("customer_id").notNullable().references("id").inTable("customers").onDelete("CASCADE");
    table.integer("points_used").notNullable();
    table.string("reward_name", 255).notNullable();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable("point_ledger", (table) => {
    table.uuid("id").primary();
    table.uuid("customer_id").notNullable().references("id").inTable("customers").onDelete("CASCADE");
    table.integer("amount").notNullable();
    table.specificType("type", "point_ledger_type").notNullable();
    table.string("reference_id", 255);
    table.string("note", 255);
    table.string("created_by", 255).notNullable();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(["customer_id", "created_at"]);
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists("point_ledger");
  await knex.schema.dropTableIfExists("redemptions");
  await knex.schema.dropTableIfExists("promotions");
  await knex.schema.dropTableIfExists("transactions");
  await knex.schema.dropTableIfExists("staff_devices");
  await knex.schema.dropTableIfExists("customer_refresh_tokens");
  await knex.schema.dropTableIfExists("customer_email_verifications");
  await knex.schema.dropTableIfExists("customer_credentials");
  await knex.schema.dropTableIfExists("customers");

  await knex.raw("DROP TYPE IF EXISTS promotion_type");
  await knex.raw("DROP TYPE IF EXISTS transaction_source");
  await knex.raw("DROP TYPE IF EXISTS point_ledger_type");
  await knex.raw("DROP TYPE IF EXISTS customer_tier");
};
