/* eslint-disable camelcase */
/**
 * Columns become lane-scoped: every lane owns its own independent column set
 * (own names, own order, own policies) instead of sharing one board-wide list.
 *
 * Conversion for existing data — nothing may lose its place:
 *  1. boards with no lanes get one ("Default"), since a column now needs a lane;
 *  2. every card gets a lane;
 *  3. each shared column is CLONED into every lane of its board, preserving
 *     name, position and semantic;
 *  4. each clone gets its own copy of the original's policies;
 *  5. cards, transition history and the override audit are repointed at the
 *     clone belonging to the card's own lane, so card placement and every
 *     metric computed from card_transitions survive unchanged;
 *  6. the shared originals are dropped.
 *
 * Historical rows are remapped using the card's CURRENT lane — lane changes
 * were never recorded before this migration, so it is the only lane a past
 * transition can be attributed to.
 *
 * Also lands here: a reason on every transition (discards and overrides must
 * justify themselves) and the lane-move fields on the override audit.
 */

exports.up = (pgm) => {
  // 1. a column needs a lane, so every board needs at least one lane
  pgm.sql(`
    INSERT INTO lanes (board_id, name, position)
    SELECT b.id, 'Default', 0 FROM boards b
    WHERE NOT EXISTS (SELECT 1 FROM lanes l WHERE l.board_id = b.id)
  `);

  // 2. and every card needs to be in one
  pgm.sql(`
    UPDATE cards c
    SET lane_id = (SELECT l.id FROM lanes l WHERE l.board_id = c.board_id ORDER BY l.position, l.created_at LIMIT 1),
        updated_at = now()
    WHERE c.lane_id IS NULL
  `);

  pgm.addColumns('board_columns', {
    lane_id: { type: 'uuid', references: 'lanes', onDelete: 'CASCADE' },
  });

  // 3. one clone of every shared column per lane on its board
  pgm.sql(`
    CREATE TEMP TABLE col_clone ON COMMIT DROP AS
    SELECT bc.id AS old_id, l.id AS lane_id, gen_random_uuid() AS new_id,
           bc.board_id, bc.name, bc.position, bc.semantic, bc.created_at
    FROM board_columns bc
    JOIN lanes l ON l.board_id = bc.board_id
    WHERE bc.lane_id IS NULL
  `);
  pgm.sql(`
    INSERT INTO board_columns (id, board_id, lane_id, name, position, semantic, created_at, updated_at)
    SELECT new_id, board_id, lane_id, name, position, semantic, created_at, now() FROM col_clone
  `);

  // 4. policies follow their column into every lane
  pgm.sql(`
    INSERT INTO column_policies (column_id, kind, label, position, created_at, updated_at)
    SELECT cc.new_id, p.kind, p.label, p.position, p.created_at, now()
    FROM column_policies p
    JOIN col_clone cc ON cc.old_id = p.column_id
  `);

  // 5a. cards land on their own lane's clone — placement is preserved exactly
  pgm.sql(`
    UPDATE cards c SET column_id = cc.new_id
    FROM col_clone cc
    WHERE cc.old_id = c.column_id AND cc.lane_id = c.lane_id
  `);

  // 5b. transition history is the metrics source of truth; repoint it too
  pgm.sql(`
    UPDATE card_transitions t SET to_column_id = cc.new_id
    FROM col_clone cc, cards c
    WHERE c.id = t.card_id AND cc.old_id = t.to_column_id AND cc.lane_id = c.lane_id
  `);
  pgm.sql(`
    UPDATE card_transitions t SET from_column_id = cc.new_id
    FROM col_clone cc, cards c
    WHERE c.id = t.card_id AND cc.old_id = t.from_column_id AND cc.lane_id = c.lane_id
  `);

  // 5c. and the override audit, so past overrides still name a real column
  pgm.sql(`
    UPDATE card_move_overrides o SET to_column_id = cc.new_id
    FROM col_clone cc, cards c
    WHERE c.id = o.card_id AND cc.old_id = o.to_column_id AND cc.lane_id = c.lane_id
  `);
  pgm.sql(`
    UPDATE card_move_overrides o SET from_column_id = cc.new_id
    FROM col_clone cc, cards c
    WHERE c.id = o.card_id AND cc.old_id = o.from_column_id AND cc.lane_id = c.lane_id
  `);
  // card_move_overrides.skipped_policies is deliberately left as-is: it is a
  // denormalised snapshot of what was skipped at the time (that is why it
  // carries labels, not just ids) and already tolerates the policy being gone.

  // 6. the shared originals are gone; their policies cascade with them
  pgm.sql(`DELETE FROM board_columns WHERE lane_id IS NULL`);

  pgm.alterColumn('board_columns', 'lane_id', { notNull: true });
  pgm.createIndex('board_columns', ['lane_id', 'position']);

  // a card always belongs to a lane now, and a lane holding cards may not be
  // deleted out from under them (the service refuses first, with a clear error)
  pgm.alterColumn('cards', 'lane_id', { notNull: true });
  pgm.dropConstraint('cards', 'cards_lane_id_fkey');
  pgm.addConstraint('cards', 'cards_lane_id_fkey', {
    foreignKeys: { columns: 'lane_id', references: 'lanes(id)', onDelete: 'RESTRICT' },
  });

  // every move can carry a justification: mandatory for discards and overrides
  pgm.addColumns('card_transitions', { reason: { type: 'text' } });

  // cross-lane moves are blocked by default and audited like any other override
  pgm.addColumns('card_move_overrides', {
    lane_move: { type: 'boolean', notNull: true, default: false },
    from_lane_id: { type: 'uuid', references: 'lanes', onDelete: 'SET NULL' },
    to_lane_id: { type: 'uuid', references: 'lanes', onDelete: 'SET NULL' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('card_move_overrides', ['lane_move', 'from_lane_id', 'to_lane_id']);
  pgm.dropColumns('card_transitions', ['reason']);
  pgm.dropConstraint('cards', 'cards_lane_id_fkey');
  pgm.addConstraint('cards', 'cards_lane_id_fkey', {
    foreignKeys: { columns: 'lane_id', references: 'lanes(id)', onDelete: 'SET NULL' },
  });
  pgm.alterColumn('cards', 'lane_id', { notNull: false });

  /*
   * Collapsing back to one column set per board is lossy by nature — a shared
   * list cannot represent lanes whose columns diverged. Each board keeps its
   * first lane's columns; every other lane's columns are matched to them by
   * position and everything pointing at them is repointed first. Columns that
   * find no counterpart are left in place and the DELETE will fail loudly
   * rather than silently stranding cards.
   */
  pgm.sql(`
    CREATE TEMP TABLE col_merge ON COMMIT DROP AS
    SELECT bc.id AS old_id,
           (SELECT k.id FROM board_columns k
              JOIN lanes kl ON kl.id = k.lane_id
             WHERE k.board_id = bc.board_id AND k.position = bc.position
             ORDER BY kl.position, kl.created_at LIMIT 1) AS keep_id
      FROM board_columns bc
  `);
  pgm.sql(`UPDATE cards c SET column_id = m.keep_id FROM col_merge m WHERE m.old_id = c.column_id AND m.keep_id IS NOT NULL`);
  pgm.sql(`UPDATE card_transitions t SET to_column_id = m.keep_id FROM col_merge m WHERE m.old_id = t.to_column_id AND m.keep_id IS NOT NULL`);
  pgm.sql(`UPDATE card_transitions t SET from_column_id = m.keep_id FROM col_merge m WHERE m.old_id = t.from_column_id AND m.keep_id IS NOT NULL`);
  pgm.sql(`DELETE FROM board_columns bc USING col_merge m WHERE m.old_id = bc.id AND m.keep_id IS NOT NULL AND m.keep_id <> bc.id`);
  pgm.dropIndex('board_columns', ['lane_id', 'position']);
  pgm.dropColumns('board_columns', ['lane_id']);
};
