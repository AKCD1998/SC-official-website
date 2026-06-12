/**
 * Migration: member pharmacy medical records.
 *
 * Keeps pharmacy-specific medical data separate from the main loyalty member
 * identity/profile records.
 *
 * Note: member_id is stored as TEXT to match the POS-facing contract. The
 * loyalty member identity currently uses UUID ids in the users table, so this
 * table uses a logical link by id value rather than a physical FK constraint.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable("member_pharmacy_med_records", (table) => {
    table.text("member_id").primary();

    table.text("pid_document_type").nullable();
    table.text("pid_document_number_raw").nullable();
    table.text("pid_document_number_normalized").nullable();

    table.decimal("weight_kg", 5, 2).nullable();
    table.decimal("height_cm", 5, 2).nullable();
    table.integer("bp_systolic").nullable();
    table.integer("bp_diastolic").nullable();
    table.text("blood_type").nullable();
    table.text("blood_rh").nullable();

    table.boolean("has_diabetes").notNullable().defaultTo(false);
    table.boolean("has_hypertension").notNullable().defaultTo(false);
    table.boolean("has_hyperlipidemia").notNullable().defaultTo(false);
    table.boolean("has_heart_disease").notNullable().defaultTo(false);
    table.boolean("has_kidney_disease").notNullable().defaultTo(false);
    table.boolean("has_liver_disease").notNullable().defaultTo(false);
    table.boolean("has_thyroid_disease").notNullable().defaultTo(false);
    table.text("other_conditions").nullable();

    table.text("drug_allergies").nullable();
    table.text("food_allergies").nullable();
    table.text("current_medications").nullable();
    table.text("medical_history").nullable();

    table.boolean("is_smoker").notNullable().defaultTo(false);
    table.boolean("drinks_alcohol").notNullable().defaultTo(false);
    table.boolean("is_pregnant").notNullable().defaultTo(false);
    table.boolean("is_breastfeeding").notNullable().defaultTo(false);

    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_member_pharmacy_med_records_member_id
      ON member_pharmacy_med_records (member_id)
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_member_pharmacy_med_records_pid_document
      ON member_pharmacy_med_records (pid_document_type, pid_document_number_normalized)
      WHERE pid_document_type IS NOT NULL
        AND pid_document_number_normalized IS NOT NULL
  `);
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS uq_member_pharmacy_med_records_pid_document`);
  await knex.raw(`DROP INDEX IF EXISTS idx_member_pharmacy_med_records_member_id`);
  await knex.schema.dropTableIfExists("member_pharmacy_med_records");
};
