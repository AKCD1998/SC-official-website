/**
 * Migration: persist POS member demographic fields on users.
 *
 * Adds the fields already used by the WinForms POS member form so
 * GET/PUT/POST /api/members can round-trip them reliably.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS sex varchar(20),
      ADD COLUMN IF NOT EXISTS dob date,
      ADD COLUMN IF NOT EXISTS remark text
  `);
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.raw(`
    ALTER TABLE users
      DROP COLUMN IF EXISTS remark,
      DROP COLUMN IF EXISTS dob,
      DROP COLUMN IF EXISTS sex
  `);
};
