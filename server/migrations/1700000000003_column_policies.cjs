/* eslint-disable camelcase */
/**
 * Column policies: per-column checklists gating card movement.
 *  - column_policies      : the checklist definitions (enter / leave, ordered)
 *  - card_policy_progress : partial tick state kept on the card between attempts
 *  - card_move_overrides  : audit of every deliberate override (skipped
 *                           policies, forced backwards moves) for reporting
 */

exports.up = (pgm) => {
  pgm.createType('policy_kind', ['enter', 'leave']);

  pgm.createTable('column_policies', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    column_id: { type: 'uuid', notNull: true, references: 'board_columns', onDelete: 'CASCADE' },
    kind: { type: 'policy_kind', notNull: true },
    label: { type: 'text', notNull: true },
    position: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('column_policies', ['column_id', 'kind']);

  pgm.createTable('card_policy_progress', {
    card_id: { type: 'uuid', notNull: true, references: 'cards', onDelete: 'CASCADE' },
    policy_id: { type: 'uuid', notNull: true, references: 'column_policies', onDelete: 'CASCADE' },
    checked_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    checked_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
  });
  pgm.addConstraint('card_policy_progress', 'card_policy_progress_pk', { primaryKey: ['card_id', 'policy_id'] });

  pgm.createTable('card_move_overrides', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    card_id: { type: 'uuid', notNull: true, references: 'cards', onDelete: 'CASCADE' },
    board_id: { type: 'uuid', notNull: true, references: 'boards', onDelete: 'CASCADE' },
    from_column_id: { type: 'uuid', references: 'board_columns', onDelete: 'SET NULL' },
    to_column_id: { type: 'uuid', references: 'board_columns', onDelete: 'SET NULL' },
    actor_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    backwards: { type: 'boolean', notNull: true, default: false },
    // denormalised {policyId, kind, label, columnId} — the audit must survive
    // the policy (or the column) being deleted later
    skipped_policies: { type: 'jsonb', notNull: true, default: '[]' },
    reason: { type: 'text' },
    at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('card_move_overrides', ['board_id', 'at']);
  pgm.createIndex('card_move_overrides', ['card_id']);
};

exports.down = (pgm) => {
  pgm.dropTable('card_move_overrides');
  pgm.dropTable('card_policy_progress');
  pgm.dropTable('column_policies');
  pgm.dropType('policy_kind');
};
