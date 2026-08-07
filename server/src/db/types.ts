import type { ColumnType, Generated } from 'kysely';
import type {
  RecurrenceRule,
  RecurrenceStatus,
  Role,
  ColumnSemantic,
  NotificationChannel,
  NotificationEvent,
  PolicyKind,
} from '@kan-do/shared';

type Created = ColumnType<Date, Date | string | undefined, never>;
type Updated = ColumnType<Date, Date | string | undefined, Date | string>;

export interface OrganizationsTable {
  id: Generated<string>;
  name: string;
  slug: string;
  active: Generated<boolean>;
  created_at: Created;
  updated_at: Updated;
}

export interface UsersTable {
  id: Generated<string>;
  org_id: string | null;
  email: string;
  display_name: string;
  role: Generated<Role>;
  password_hash: string | null;
  avatar_key: string | null;
  active: Generated<boolean>;
  created_at: Created;
  updated_at: Updated;
}

export interface IdpConfigsTable {
  id: Generated<string>;
  org_id: string;
  type: 'oidc' | 'saml';
  display_name: string;
  enabled: Generated<boolean>;
  config: unknown;
  created_at: Created;
  updated_at: Updated;
}

export interface BoardsTable {
  id: Generated<string>;
  org_id: string;
  name: string;
  created_by: string | null;
  created_at: Created;
  updated_at: Updated;
}

export interface BoardMembersTable {
  board_id: string;
  user_id: string;
  is_owner: Generated<boolean>;
}

export interface BoardColumnsTable {
  id: Generated<string>;
  board_id: string;
  /** columns are lane-scoped: each lane owns its own independent set */
  lane_id: string;
  name: string;
  position: number;
  semantic: Exclude<ColumnSemantic, null> | null;
  created_at: Created;
  updated_at: Updated;
}

export interface ColumnPoliciesTable {
  id: Generated<string>;
  column_id: string;
  kind: PolicyKind;
  label: string;
  position: Generated<number>;
  created_at: Created;
  updated_at: Updated;
}

/** Partial checklist state parked on the card between move attempts. */
export interface CardPolicyProgressTable {
  card_id: string;
  policy_id: string;
  checked_at: Created;
  checked_by: string | null;
}

/** Audit row written whenever a move bypasses policies and/or column order. */
export interface CardMoveOverridesTable {
  id: Generated<string>;
  card_id: string;
  board_id: string;
  from_column_id: string | null;
  to_column_id: string | null;
  actor_id: string | null;
  backwards: Generated<boolean>;
  /** the move crossed lanes, which is blocked by default */
  lane_move: Generated<boolean>;
  from_lane_id: string | null;
  to_lane_id: string | null;
  skipped_policies: unknown;
  reason: string | null;
  at: Created;
}

export interface LanesTable {
  id: Generated<string>;
  board_id: string;
  name: string;
  position: number;
  created_at: Created;
  updated_at: Updated;
}

export interface ExternalOwnersTable {
  id: Generated<string>;
  org_id: string;
  display_name: string;
  created_at: Created;
  updated_at: Updated;
}

export interface CategoriesTable {
  id: Generated<string>;
  org_id: string;
  name: string;
  color: string;
  created_at: Created;
  updated_at: Updated;
}

export interface CardsTable {
  id: Generated<string>;
  board_id: string;
  column_id: string;
  /** never null: a card always lives in a lane, in one of that lane's columns */
  lane_id: string;
  category_id: string | null;
  position: Generated<number>;
  title: string;
  description: string | null;
  cover_attachment_id: string | null;
  due_date: Date | null;
  recurrence_rule: RecurrenceRule | null;
  recurrence_status: Generated<RecurrenceStatus>;
  closed_at: Date | null;
  reopen_at: Date | null;
  reopened_at: Date | null;
  overdue_at: Date | null;
  is_overdue: Generated<boolean>;
  created_at: Created;
  updated_at: Updated;
}

export interface CardOwnersTable {
  card_id: string;
  kind: 'user' | 'external';
  user_id: string | null;
  external_owner_id: string | null;
}

export interface NotesTable {
  id: Generated<string>;
  card_id: string;
  author_id: string | null;
  markdown: string;
  position: Generated<number>;
  created_at: Created;
  updated_at: Updated;
}

export interface AttachmentsTable {
  id: Generated<string>;
  card_id: string;
  object_key: string;
  filename: string;
  content_type: string;
  size_bytes: string | number | bigint;
  uploaded_by: string | null;
  created_at: Created;
  updated_at: Updated;
}

export interface CardTransitionsTable {
  id: Generated<string>;
  card_id: string;
  from_column_id: string | null;
  to_column_id: string;
  actor_id: string | null;
  /** justification: mandatory for discards and for overridden moves */
  reason: string | null;
  at: Created;
}

export interface NotificationsTable {
  id: Generated<string>;
  user_id: string;
  event: NotificationEvent;
  card_id: string | null;
  title: string;
  body: string;
  read_at: Date | null;
  created_at: Created;
}

export interface NotificationSettingsTable {
  user_id: string;
  event: NotificationEvent;
  channel: NotificationChannel;
  enabled: boolean;
}

export interface PushTokensTable {
  token: string;
  user_id: string;
  platform: Generated<string>;
  created_at: Created;
}

export interface DashboardConfigsTable {
  id: Generated<string>;
  user_id: string;
  board_id: string | null;
  layout: unknown;
  created_at: Created;
  updated_at: Updated;
}

export interface NotificationLedgerTable {
  dedupe_key: string;
  created_at: Created;
}

export interface DB {
  categories: CategoriesTable;
  organizations: OrganizationsTable;
  users: UsersTable;
  idp_configs: IdpConfigsTable;
  boards: BoardsTable;
  board_members: BoardMembersTable;
  board_columns: BoardColumnsTable;
  column_policies: ColumnPoliciesTable;
  card_policy_progress: CardPolicyProgressTable;
  card_move_overrides: CardMoveOverridesTable;
  lanes: LanesTable;
  external_owners: ExternalOwnersTable;
  cards: CardsTable;
  card_owners: CardOwnersTable;
  notes: NotesTable;
  attachments: AttachmentsTable;
  card_transitions: CardTransitionsTable;
  notifications: NotificationsTable;
  notification_settings: NotificationSettingsTable;
  push_tokens: PushTokensTable;
  dashboard_configs: DashboardConfigsTable;
  notification_ledger: NotificationLedgerTable;
}
