/**
 * Migration: make users.email nullable
 *
 * LINE's OAuth API does not return an email address.  When a new user signs up
 * via LINE, the backend tries to INSERT into users with email = NULL, which
 * previously failed because the column was NOT NULL.
 *
 * This migration drops the NOT NULL constraint so that LINE (and any future
 * provider that doesn't supply email) can create accounts without an email.
 * Google / email-signup paths are unaffected — they always supply an email.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.raw(`ALTER TABLE users ALTER COLUMN email DROP NOT NULL`);
};

exports.down = async function down(knex) {
  // Restore NOT NULL — will fail if any rows have NULL email; run cleanup first.
  await knex.raw(`ALTER TABLE users ALTER COLUMN email SET NOT NULL`);
};
