import type { RecurrenceRule, RecurrenceStatus, Role, PolicyKind, PolicyRef, MoveBlockedDetails } from '@kan-do/shared';

export type { PolicyKind, PolicyRef, MoveBlockedDetails };

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
  name: string;
  position: number;
  semantic: 'open' | 'done' | null;
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

/** What the move dialog renders before a move is attempted. */
export interface MoveRequirements {
  backwards: boolean;
  applicable: PolicyRef[];
  checkedIds: string[];
  fromColumn: { id: string; name: string; position: number } | null;
  toColumn: { id: string; name: string; position: number };
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
