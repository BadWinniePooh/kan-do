import type {
  RecurrenceRule,
  RecurrenceStatus,
  Role,
  PolicyKind,
  PolicyRef,
  MoveBlockedDetails,
  ColumnSemantic,
  BlockerRef,
} from '@kan-do/shared';

export type { PolicyKind, PolicyRef, MoveBlockedDetails, ColumnSemantic, BlockerRef };

/** A reason a card cannot progress. Dependent on its card. */
export interface Blocker {
  id: string;
  card_id: string;
  reason: string;
  started_at: string;
  /** null while still active */
  ended_at: string | null;
  created_by_name?: string | null;
  resolved_by_name?: string | null;
  comments?: BlockerComment[];
}

export interface BlockerComment {
  id: string;
  blocker_id: string;
  markdown: string;
  created_at: string;
  author_name?: string | null;
}

export interface Me {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  orgId: string | null;
  orgSlug: string | null;
  orgName: string | null;
  avatarUrl: string | null;
}

export interface Board {
  id: string;
  org_id: string;
  name: string;
}

export interface Column {
  id: string;
  board_id: string;
  /** columns are lane-scoped — each lane owns its own independent set */
  lane_id: string;
  name: string;
  position: number;
  semantic: ColumnSemantic;
}

export interface Lane {
  id: string;
  name: string;
  position: number;
}

export interface Category {
  id: string;
  name: string;
  color: string;
}

/** A checklist item gating movement into ('enter') or out of ('leave') a column. */
export interface ColumnPolicy {
  id: string;
  column_id: string;
  kind: PolicyKind;
  label: string;
  position: number;
}

export interface MoveColumnRef {
  id: string;
  name: string;
  position: number;
  laneId: string;
  laneName: string;
  semantic: ColumnSemantic;
}

/** What the move dialog renders before a move is attempted. */
export interface MoveRequirements {
  backwards: boolean;
  /** the move crosses lanes — blocked by default */
  laneMove: boolean;
  /** the target is a discard column */
  discarding: boolean;
  /** unresolved blockers holding the card in place */
  activeBlockers: BlockerRef[];
  /** a written justification is mandatory for this move */
  requiresReason: boolean;
  applicable: PolicyRef[];
  checkedIds: string[];
  fromColumn: MoveColumnRef | null;
  toColumn: MoveColumnRef;
}

/** One entry of a card's audit timeline. */
export type AuditEntry =
  | { kind: 'created'; at: string; actorName: string | null; column: AuditColumn | null }
  | {
      kind: 'moved';
      at: string;
      actorName: string | null;
      from: AuditColumn | null;
      to: AuditColumn | null;
      laneChanged: boolean;
      discarded: boolean;
      reason: string | null;
    }
  | {
      kind: 'override';
      at: string;
      actorName: string | null;
      from: AuditColumn | null;
      to: AuditColumn | null;
      backwards: boolean;
      laneMove: boolean;
      skipped: { label: string; kind: string; columnName?: string }[];
      bypassedBlockers: { reason: string }[];
      reason: string | null;
    }
  | { kind: 'blocked'; at: string; actorName: string | null; blockerId: string; reason: string }
  | { kind: 'unblocked'; at: string; actorName: string | null; blockerId: string; reason: string };

export interface AuditColumn {
  id: string;
  name: string;
  laneName: string | null;
  semantic: ColumnSemantic;
}

export interface CardAudit {
  card: { id: string; title: string; createdAt: string };
  timeline: AuditEntry[];
}

export interface Card {
  id: string;
  board_id: string;
  column_id: string;
  lane_id: string | null;
  category_id: string | null;
  position: number;
  title: string;
  description: string | null;
  cover_attachment_id: string | null;
  due_date: string | null;
  recurrence_rule: RecurrenceRule | null;
  recurrence_status: RecurrenceStatus;
  is_overdue: boolean;
  reopen_at: string | null;
  overdue_at: string | null;
}

export interface OwnerRow {
  card_id?: string;
  kind: 'user' | 'external';
  user_id: string | null;
  external_owner_id: string | null;
  user_name: string | null;
  user_avatar: string | null;
  external_name: string | null;
}

export interface BoardDetail {
  board: Board;
  columns: Column[];
  lanes: Lane[];
  members: { id: string; display_name: string; avatar_key: string | null; is_owner: boolean }[];
  cards: Card[];
  owners: (OwnerRow & { card_id: string })[];
  categories: Category[];
  policies: ColumnPolicy[];
  /** ticked policies per card, so readiness shows without attempting a move */
  policyProgress: { card_id: string; policy_id: string }[];
  /** unresolved blockers, so a blocked card is obvious on the board itself */
  blockers: { id: string; card_id: string; reason: string; started_at: string }[];
}

export interface Note {
  id: string;
  markdown: string;
  created_at: string;
}

export interface Attachment {
  id: string;
  filename: string;
  content_type: string;
  url: string;
}

export interface CardDetail {
  card: Card;
  notes: Note[];
  attachments: Attachment[];
  owners: OwnerRow[];
  transitions: { from_column_id: string | null; to_column_id: string; at: string }[];
}

export interface AppNotification {
  id: string;
  event: 'overdue' | 'reopen';
  card_id: string | null;
  title: string;
  body: string;
  read_at: string | null;
  created_at: string;
}
