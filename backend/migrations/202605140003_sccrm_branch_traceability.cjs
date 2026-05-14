/**
 * Migration: SCCRM branch traceability
 *
 * Adds the branches table and wires branch_id + staff_device_id into
 * transactions so every point earn can be traced to a physical store location.
 *
 * All new columns are nullable so old transactions (branch_id IS NULL) remain
 * valid — backward compat is preserved by design.
 *
 * Schema additions:
 *   branches          — master list of ศิริชัยเภสัช branch locations
 *   staff_devices.branch_id        — which branch this POS terminal belongs to
 *   transactions.branch_id         — branch where the earn happened (nullable)
 *   transactions.staff_device_id   — exact staff_devices.id that processed it
 *
 * branch_name is always derived via JOIN on branches.name — never duplicated.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  // ── branches ─────────────────────────────────────────────────────────────
  // Master list of physical store locations.
  // code: short human-readable identifier, e.g. 'HQ', 'BKK-01', 'CNX-01'.
  await knex.schema.createTable("branches", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.string("name", 100).notNullable();
    table.string("code", 20).notNullable().unique();
    table.text("address").nullable();
    table.string("phone", 20).nullable();
    table.boolean("is_active").notNullable().defaultTo(true);
    table
      .timestamp("created_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
  });

  // ── staff_devices.branch_id ───────────────────────────────────────────────
  // Nullable — existing devices are not assigned to a branch yet.
  // Set when the device authenticates and supplies a branchId.
  await knex.schema.alterTable("staff_devices", (table) => {
    table
      .uuid("branch_id")
      .nullable()
      .references("id")
      .inTable("branches")
      .onDelete("SET NULL");
  });

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_staff_devices_branch_id
      ON staff_devices (branch_id)
  `);

  // ── transactions.branch_id ────────────────────────────────────────────────
  // Nullable — old transactions stay valid (branch_id IS NULL).
  await knex.schema.alterTable("transactions", (table) => {
    table
      .uuid("branch_id")
      .nullable()
      .references("id")
      .inTable("branches")
      .onDelete("SET NULL");

    // Which specific staff_devices row processed this earn.
    table
      .uuid("staff_device_id")
      .nullable()
      .references("id")
      .inTable("staff_devices")
      .onDelete("SET NULL");
  });

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_transactions_branch_id
      ON transactions (branch_id)
  `);
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.alterTable("transactions", (table) => {
    table.dropColumn("staff_device_id");
    table.dropColumn("branch_id");
  });

  await knex.schema.alterTable("staff_devices", (table) => {
    table.dropColumn("branch_id");
  });

  await knex.schema.dropTableIfExists("branches");
};
