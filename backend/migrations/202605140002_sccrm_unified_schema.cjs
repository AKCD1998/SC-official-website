/**
 * Migration: SCCRM unified schema (Option B — shared identity)
 *
 * This replaces the earlier unrun migration (202605120001_sccrm_init.cjs).
 * That file created a standalone `customers` table separate from `users`.
 * This migration instead builds the CRM layer on top of the existing `users`
 * table so that one SC Group account works across the website, the mobile app,
 * and future LINE / Google integrations.
 *
 * Identity layer:   users              (already exists — managed by auth.js)
 * Auth link layer:  user_auth_providers (created in migration 202605140001)
 * Loyalty layer:    member_profiles     (created here — linked to users.id)
 * History layer:    point_ledger        (created here — linked to users.id)
 *
 * Table overview:
 *   member_profiles          one-to-one with users; holds tier, member_code, is_active
 *   customer_email_verifs    OTP records for SCCRM email signup (email-keyed, no user FK)
 *   customer_refresh_tokens  rotating opaque tokens; FK → users.id
 *   staff_devices            SCCRM staff device auth (opaque token, hashed)
 *   transactions             purchase records; FK → users.id (nullable — unmatched POS)
 *   promotions               point multiplier / bonus rules (no user FK)
 *   redemptions              point redemption records; FK → users.id
 *   point_ledger             append-only ledger; FK → users.id
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  // ── Enum types (idempotent guard) ────────────────────────────────────────
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'customer_tier') THEN
        CREATE TYPE customer_tier AS ENUM ('bronze', 'silver', 'gold');
      END IF;
    END $$
  `);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'point_ledger_type') THEN
        CREATE TYPE point_ledger_type AS ENUM ('purchase', 'redeem', 'adjustment', 'expire', 'promotion');
      END IF;
    END $$
  `);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'transaction_source') THEN
        CREATE TYPE transaction_source AS ENUM ('pos_import', 'manual', 'online');
      END IF;
    END $$
  `);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'promotion_type') THEN
        CREATE TYPE promotion_type AS ENUM ('multiplier', 'fixed_bonus', 'threshold');
      END IF;
    END $$
  `);

  // ── member_profiles ──────────────────────────────────────────────────────
  // One-to-one with users. Holds the CRM / loyalty layer.
  // member_code: 'SCM-' + first 8 hex chars of users.id (uppercase, hyphens stripped)
  await knex.schema.createTable("member_profiles", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table
      .uuid("user_id")
      .notNullable()
      .unique()
      .references("id")
      .inTable("users")
      .onDelete("CASCADE");
    table.string("member_code", 50).notNullable().unique();
    table
      .specificType("tier", "customer_tier")
      .notNullable()
      .defaultTo("bronze");
    table.boolean("is_active").notNullable().defaultTo(true);
    table
      .timestamp("created_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
    table
      .timestamp("updated_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
  });

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_member_profiles_member_code
      ON member_profiles (member_code)
  `);

  // ── customer_email_verifications ─────────────────────────────────────────
  // OTP records for SCCRM email signup flow.
  // Keyed by email string (not user_id) because the user row doesn't exist yet
  // when the OTP is sent.
  await knex.schema.createTable("customer_email_verifications", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.string("customer_email", 255).notNullable().index();
    table.string("otp_hash", 255).notNullable();
    table.timestamp("expires_at", { useTz: true }).notNullable();
    table.timestamp("used_at", { useTz: true }).nullable();
    table.integer("attempt_count").notNullable().defaultTo(0);
    table
      .timestamp("created_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
  });

  // ── customer_refresh_tokens ──────────────────────────────────────────────
  // Rotating opaque refresh tokens for SCCRM customer sessions.
  // FK points to users.id (not a separate customers table).
  await knex.schema.createTable("customer_refresh_tokens", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table
      .uuid("user_id")
      .notNullable()
      .references("id")
      .inTable("users")
      .onDelete("CASCADE");
    table.string("token_hash", 255).notNullable().unique();
    table.string("device_label", 255).nullable();
    table.timestamp("expires_at", { useTz: true }).notNullable();
    table.timestamp("revoked_at", { useTz: true }).nullable();
    table
      .timestamp("created_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
    table.timestamp("last_used_at", { useTz: true }).nullable();
  });

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_customer_refresh_tokens_user_id
      ON customer_refresh_tokens (user_id)
  `);

  // ── staff_devices ────────────────────────────────────────────────────────
  // SCCRM staff device auth. Each physical device gets one opaque token.
  // No user FK — staff auth is device-based, not account-based.
  await knex.schema.createTable("staff_devices", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.string("device_id", 255).notNullable().unique();
    table.string("device_name", 255).notNullable();
    table.string("token_hash", 255).notNullable().unique();
    table.timestamp("last_seen_at", { useTz: true }).nullable();
    table.timestamp("revoked_at", { useTz: true }).nullable();
    table
      .timestamp("created_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
  });

  // ── promotions ───────────────────────────────────────────────────────────
  // Point multiplier / bonus / threshold rules. Not user-specific.
  await knex.schema.createTable("promotions", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.string("name", 255).notNullable();
    table.specificType("type", "promotion_type").notNullable();
    table.decimal("value", 12, 2).notNullable();
    table.jsonb("condition_json").notNullable().defaultTo("{}");
    table.timestamp("starts_at", { useTz: true }).nullable();
    table.timestamp("ends_at", { useTz: true }).nullable();
    table.boolean("is_active").notNullable().defaultTo(true);
    table
      .timestamp("created_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
    table
      .timestamp("updated_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
  });

  // ── transactions ─────────────────────────────────────────────────────────
  // Purchase records. user_id is nullable so POS import rows without a matched
  // member can still be recorded (SET NULL on delete preserves history).
  await knex.schema.createTable("transactions", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table
      .uuid("user_id")
      .nullable()
      .references("id")
      .inTable("users")
      .onDelete("SET NULL");
    table.decimal("total_amount", 12, 2).notNullable();
    table.integer("point_earned").notNullable().defaultTo(0);
    table.specificType("source", "transaction_source").notNullable();
    table.string("pos_ref_id", 255).nullable().unique();
    table
      .timestamp("created_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
  });

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_transactions_user_id
      ON transactions (user_id)
  `);

  // ── redemptions ──────────────────────────────────────────────────────────
  await knex.schema.createTable("redemptions", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table
      .uuid("user_id")
      .notNullable()
      .references("id")
      .inTable("users")
      .onDelete("CASCADE");
    table.integer("points_used").notNullable();
    table.string("reward_name", 255).notNullable();
    table
      .timestamp("created_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
  });

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_redemptions_user_id
      ON redemptions (user_id)
  `);

  // ── point_ledger ─────────────────────────────────────────────────────────
  // Append-only ledger. amount > 0 = earn, amount < 0 = redeem/expire.
  // created_by stores the device_id string of the staff device that created the entry.
  await knex.schema.createTable("point_ledger", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table
      .uuid("user_id")
      .notNullable()
      .references("id")
      .inTable("users")
      .onDelete("CASCADE");
    table.integer("amount").notNullable();
    table.specificType("type", "point_ledger_type").notNullable();
    table.string("reference_id", 255).nullable();
    table.string("note", 255).nullable();
    table.string("created_by", 255).notNullable(); // staff device_id or 'system'
    table
      .timestamp("created_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
    table.index(["user_id", "created_at"]);
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists("point_ledger");
  await knex.schema.dropTableIfExists("redemptions");
  await knex.schema.dropTableIfExists("transactions");
  await knex.schema.dropTableIfExists("staff_devices");
  await knex.schema.dropTableIfExists("promotions");
  await knex.schema.dropTableIfExists("customer_refresh_tokens");
  await knex.schema.dropTableIfExists("customer_email_verifications");
  await knex.schema.dropTableIfExists("member_profiles");

  await knex.raw("DROP TYPE IF EXISTS promotion_type");
  await knex.raw("DROP TYPE IF EXISTS transaction_source");
  await knex.raw("DROP TYPE IF EXISTS point_ledger_type");
  await knex.raw("DROP TYPE IF EXISTS customer_tier");
};
