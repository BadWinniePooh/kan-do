/* eslint-disable camelcase */
/**
 * Blockers: a reason a card cannot progress right now.
 *
 * Strictly dependent on a card — no parent card, no blocker (CASCADE, and there
 * is no nullable card_id to orphan one). A card may collect many over its life;
 * the one(s) without an `ended_at` are active and hold the card in place.
 *
 * Comments mirror the card's existing `notes`: raw markdown, edited and
 * rendered with the same pattern.
 */

exports.up = (pgm) => {
  pgm.createTable('card_blockers', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    card_id: { type: 'uuid', notNull: true, references: 'cards', onDelete: 'CASCADE' },
    reason: { type: 'text', notNull: true },
    started_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    /** null while the blocker is still active */
    ended_at: { type: 'timestamptz' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    resolved_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('card_blockers', 'card_blockers_end_after_start', {
    check: 'ended_at IS NULL OR ended_at >= started_at',
  });
  pgm.createIndex('card_blockers', ['card_id']);
  // "is this card blocked right now" is asked for every card on every board
  // render — keep it a cheap partial index scan
  pgm.createIndex('card_blockers', ['card_id'], { name: 'card_blockers_active_index', where: 'ended_at IS NULL' });

  pgm.createTable('card_blocker_comments', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    blocker_id: { type: 'uuid', notNull: true, references: 'card_blockers', onDelete: 'CASCADE' },
    author_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    markdown: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('card_blocker_comments', ['blocker_id']);

  // moving a blocked card is a fourth overridable gate, audited like the rest;
  // the blockers are denormalised so the record survives their deletion
  pgm.addColumns('card_move_overrides', {
    blocked: { type: 'boolean', notNull: true, default: false },
    blockers: { type: 'jsonb', notNull: true, default: '[]' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('card_move_overrides', ['blocked', 'blockers']);
  pgm.dropTable('card_blocker_comments');
  pgm.dropTable('card_blockers');
};
