/**
 * Migration: make users.password_hash nullable + create user_auth_providers
 *
 * Why password_hash becomes nullable:
 *   The users table was originally built for email/password accounts only.
 *   The shared SC Group identity model requires that LINE-only or Google-only
 *   accounts can exist without a password hash. Email signup still always
 *   provides a hash at the application level — the DB just stops enforcing it.
 *
 * Why user_auth_providers:
 *   One user can authenticate via multiple providers (email+password, LINE,
 *   Google). This table records each provider link independently so account
 *   merging and future SSO are possible without schema changes.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  // 1. Make password_hash nullable — safe for existing rows (values preserved)
  await knex.raw(`
    ALTER TABLE users
      ALTER COLUMN password_hash DROP NOT NULL
  `);

  // 2. Index phone_number for fast staff search-by-phone
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_users_phone_number
      ON users (phone_number)
  `);

  // 3. OAuth provider links
  //    provider: 'email' | 'line' | 'google'
  //    provider_user_id: LINE userId / Google sub (null for email provider)
  await knex.schema.createTable("user_auth_providers", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table
      .uuid("user_id")
      .notNullable()
      .references("id")
      .inTable("users")
      .onDelete("CASCADE");
    table.string("provider", 20).notNullable();       // 'email' | 'line' | 'google'
    table.string("provider_user_id", 255).nullable(); // null for email provider
    table
      .timestamp("created_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
    table.unique(["provider", "provider_user_id"]);
  });

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_user_auth_providers_user_id
      ON user_auth_providers (user_id)
  `);
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists("user_auth_providers");

  await knex.raw(`DROP INDEX IF EXISTS idx_users_phone_number`);

  // Restore NOT NULL — will fail if any rows now have NULL password_hash.
  // Safe to run only if no OAuth-only users were created after the up migration.
  await knex.raw(`
    ALTER TABLE users
      ALTER COLUMN password_hash SET NOT NULL
  `);
};
