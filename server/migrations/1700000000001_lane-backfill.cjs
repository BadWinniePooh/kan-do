/* eslint-disable camelcase */
/**
 * Lane invariant backfill: any card without a lane on a board that HAS lanes
 * was invisible in every lane view. Assign such cards to their board's first
 * lane (lowest position, oldest first as tiebreaker).
 *
 * down() is intentionally a no-op: this is a data repair — the pre-repair
 * NULLs carried no information worth restoring, and reverting would re-hide
 * cards. The schema is unchanged in both directions.
 */

exports.up = (pgm) => {
  pgm.sql(`
    UPDATE cards c
    SET lane_id = (
      SELECT l.id FROM lanes l
      WHERE l.board_id = c.board_id
      ORDER BY l.position, l.created_at
      LIMIT 1
    ),
    updated_at = now()
    WHERE c.lane_id IS NULL
      AND EXISTS (SELECT 1 FROM lanes l WHERE l.board_id = c.board_id)
  `);
};

exports.down = () => {
  /* data repair — nothing to revert */
};
