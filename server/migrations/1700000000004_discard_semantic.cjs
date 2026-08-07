/* eslint-disable camelcase */
/**
 * New optional column semantic: 'discard'. A discard-mapped column holds cards
 * that are finished but reverted — NOT completed work, so metrics must never
 * count them as done.
 *
 * Alone in its own migration and outside a transaction: Postgres refuses to use
 * an enum value added in the same transaction that added it, so the value has
 * to be committed before any later migration or the app can reference it.
 * There is no reversible ALTER TYPE ... DROP VALUE, so down() is a no-op.
 */
exports.noTransaction = true;

exports.up = (pgm) => {
  pgm.sql(`ALTER TYPE column_semantic ADD VALUE IF NOT EXISTS 'discard'`);
};

exports.down = () => {
  /* Postgres cannot drop an enum value; nothing to revert */
};
