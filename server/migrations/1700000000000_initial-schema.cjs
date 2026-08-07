/* eslint-disable camelcase */
/** Initial Kan-Do schema. Reversible: every object dropped in down(). */

exports.up = (pgm) => {
  pgm.createExtension('pgcrypto', { ifNotExists: true });

  pgm.createType('user_role', ['global_admin', 'org_admin', 'user']);
  pgm.createType('column_semantic', ['open', 'done']);
  pgm.createType('recurrence_status', ['open', 'awaiting_reopen', 'reopened', 'overdue']);
  pgm.createType('idp_type', ['oidc', 'saml']);
  pgm.createType('owner_kind', ['user', 'external']);
  pgm.createType('notification_event', ['overdue', 'reopen']);
  pgm.createType('notification_channel', ['inapp', 'email', 'push']);

  const id = { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') };
  const timestamps = {
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  };

  pgm.createTable('organizations', {
    id,
    name: { type: 'text', notNull: true },
    slug: { type: 'text', notNull: true, unique: true },
    active: { type: 'boolean', notNull: true, default: true },
    ...timestamps,
  });

  pgm.createTable('users', {
    id,
    org_id: { type: 'uuid', references: 'organizations', onDelete: 'CASCADE' }, // null for global admins
    email: { type: 'text', notNull: true },
    display_name: { type: 'text', notNull: true },
    role: { type: 'user_role', notNull: true, default: 'user' },
    password_hash: { type: 'text' }, // null for SSO-only accounts
    avatar_key: { type: 'text' },    // S3 object key
    active: { type: 'boolean', notNull: true, default: true },
    ...timestamps,
  });
  pgm.createIndex('users', ['org_id']);
  pgm.createIndex('users', ['org_id', 'email'], { unique: true, where: 'org_id IS NOT NULL' });
  pgm.createIndex('users', ['email'], { unique: true, where: 'org_id IS NULL' });

  pgm.createTable('idp_configs', {
    id,
    org_id: { type: 'uuid', notNull: true, references: 'organizations', onDelete: 'CASCADE' },
    type: { type: 'idp_type', notNull: true },
    display_name: { type: 'text', notNull: true },
    enabled: { type: 'boolean', notNull: true, default: true },
    /**
     * oidc: { issuer, clientId, clientSecret, scopes? }
     * saml: { entryPoint, issuer, cert, audience? }
     */
    config: { type: 'jsonb', notNull: true },
    ...timestamps,
  });
  pgm.createIndex('idp_configs', ['org_id']);

  pgm.createTable('boards', {
    id,
    org_id: { type: 'uuid', notNull: true, references: 'organizations', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    ...timestamps,
  });
  pgm.createIndex('boards', ['org_id']);

  pgm.createTable('board_members', {
    board_id: { type: 'uuid', notNull: true, references: 'boards', onDelete: 'CASCADE' },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    is_owner: { type: 'boolean', notNull: true, default: false },
  });
  pgm.addConstraint('board_members', 'board_members_pk', { primaryKey: ['board_id', 'user_id'] });
  pgm.createIndex('board_members', ['user_id']);

  pgm.createTable('board_columns', {
    id,
    board_id: { type: 'uuid', notNull: true, references: 'boards', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    position: { type: 'integer', notNull: true },
    semantic: { type: 'column_semantic' }, // null = plain column
    ...timestamps,
  });
  pgm.createIndex('board_columns', ['board_id', 'position']);

  pgm.createTable('lanes', {
    id,
    board_id: { type: 'uuid', notNull: true, references: 'boards', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    position: { type: 'integer', notNull: true },
    ...timestamps,
  });
  pgm.createIndex('lanes', ['board_id', 'position']);

  pgm.createTable('external_owners', {
    id,
    org_id: { type: 'uuid', notNull: true, references: 'organizations', onDelete: 'CASCADE' },
    display_name: { type: 'text', notNull: true },
    ...timestamps,
  });
  pgm.createIndex('external_owners', ['org_id']);

  pgm.createTable('cards', {
    id,
    board_id: { type: 'uuid', notNull: true, references: 'boards', onDelete: 'CASCADE' },
    column_id: { type: 'uuid', notNull: true, references: 'board_columns', onDelete: 'RESTRICT' },
    lane_id: { type: 'uuid', references: 'lanes', onDelete: 'SET NULL' },
    position: { type: 'double precision', notNull: true, default: 0 },
    title: { type: 'text', notNull: true },
    description: { type: 'text' },
    cover_attachment_id: { type: 'uuid' }, // FK added after attachments exists
    due_date: { type: 'timestamptz' },
    /** RecurrenceRule JSON from @kan-do/shared; null = non-recurring */
    recurrence_rule: { type: 'jsonb' },
    recurrence_status: { type: 'recurrence_status', notNull: true, default: 'open' },
    closed_at: { type: 'timestamptz' },
    reopen_at: { type: 'timestamptz' },
    reopened_at: { type: 'timestamptz' },
    overdue_at: { type: 'timestamptz' },
    is_overdue: { type: 'boolean', notNull: true, default: false },
    ...timestamps,
  });
  pgm.createIndex('cards', ['board_id']);
  pgm.createIndex('cards', ['column_id']);
  pgm.createIndex('cards', ['board_id', 'column_id', 'position']);
  // scheduler scans: due reopens / due overdue checks
  pgm.createIndex('cards', ['reopen_at'], { where: "recurrence_status = 'awaiting_reopen'" });
  pgm.createIndex('cards', ['overdue_at'], { where: "recurrence_status = 'reopened'" });
  pgm.createIndex('cards', ['due_date'], { where: 'due_date IS NOT NULL AND is_overdue = false' });

  pgm.createTable('card_owners', {
    card_id: { type: 'uuid', notNull: true, references: 'cards', onDelete: 'CASCADE' },
    kind: { type: 'owner_kind', notNull: true },
    user_id: { type: 'uuid', references: 'users', onDelete: 'CASCADE' },
    external_owner_id: { type: 'uuid', references: 'external_owners', onDelete: 'CASCADE' },
  });
  pgm.addConstraint('card_owners', 'card_owners_one_ref', {
    check: "(kind = 'user' AND user_id IS NOT NULL AND external_owner_id IS NULL) OR (kind = 'external' AND external_owner_id IS NOT NULL AND user_id IS NULL)",
  });
  pgm.createIndex('card_owners', ['card_id']);

  pgm.createTable('notes', {
    id,
    card_id: { type: 'uuid', notNull: true, references: 'cards', onDelete: 'CASCADE' },
    author_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    markdown: { type: 'text', notNull: true },
    position: { type: 'integer', notNull: true, default: 0 },
    ...timestamps,
  });
  pgm.createIndex('notes', ['card_id', 'position']);

  pgm.createTable('attachments', {
    id,
    card_id: { type: 'uuid', notNull: true, references: 'cards', onDelete: 'CASCADE' },
    object_key: { type: 'text', notNull: true },
    filename: { type: 'text', notNull: true },
    content_type: { type: 'text', notNull: true },
    size_bytes: { type: 'bigint', notNull: true },
    uploaded_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    ...timestamps,
  });
  pgm.createIndex('attachments', ['card_id']);
  pgm.addConstraint('cards', 'cards_cover_fk', {
    foreignKeys: {
      columns: 'cover_attachment_id',
      references: 'attachments(id)',
      onDelete: 'SET NULL',
    },
  });

  pgm.createTable('card_transitions', {
    id: { type: 'bigserial', primaryKey: true },
    card_id: { type: 'uuid', notNull: true, references: 'cards', onDelete: 'CASCADE' },
    from_column_id: { type: 'uuid' },
    to_column_id: { type: 'uuid', notNull: true },
    actor_id: { type: 'uuid' }, // null = system (recurrence reopen)
    at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('card_transitions', ['card_id', 'at']);

  pgm.createTable('notifications', {
    id,
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    event: { type: 'notification_event', notNull: true },
    card_id: { type: 'uuid', references: 'cards', onDelete: 'CASCADE' },
    title: { type: 'text', notNull: true },
    body: { type: 'text', notNull: true },
    read_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('notifications', ['user_id', 'created_at']);

  pgm.createTable('notification_settings', {
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    event: { type: 'notification_event', notNull: true },
    channel: { type: 'notification_channel', notNull: true },
    enabled: { type: 'boolean', notNull: true, default: true },
  });
  pgm.addConstraint('notification_settings', 'notification_settings_pk', {
    primaryKey: ['user_id', 'event', 'channel'],
  });

  pgm.createTable('push_tokens', {
    token: { type: 'text', primaryKey: true },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    platform: { type: 'text', notNull: true, default: 'android' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('push_tokens', ['user_id']);

  pgm.createTable('dashboard_configs', {
    id,
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    board_id: { type: 'uuid', references: 'boards', onDelete: 'CASCADE' }, // null = org-wide view
    /** [{ id, widget: 'cycle'|'lead'|'waiting'|'perColumn'|'throughput', w, h, x, y }] */
    layout: { type: 'jsonb', notNull: true, default: '[]' },
    ...timestamps,
  });
  pgm.createIndex('dashboard_configs', ['user_id', 'board_id'], { unique: true, where: 'board_id IS NOT NULL' });
  pgm.createIndex('dashboard_configs', ['user_id'], { unique: true, where: 'board_id IS NULL' });

  /** Processed-notification ledger: dedupe so workers never double-fire. */
  pgm.createTable('notification_ledger', {
    dedupe_key: { type: 'text', primaryKey: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('notification_ledger');
  pgm.dropTable('dashboard_configs');
  pgm.dropTable('push_tokens');
  pgm.dropTable('notification_settings');
  pgm.dropTable('notifications');
  pgm.dropTable('card_transitions');
  pgm.dropConstraint('cards', 'cards_cover_fk');
  pgm.dropTable('attachments');
  pgm.dropTable('notes');
  pgm.dropTable('card_owners');
  pgm.dropTable('cards');
  pgm.dropTable('external_owners');
  pgm.dropTable('lanes');
  pgm.dropTable('board_columns');
  pgm.dropTable('board_members');
  pgm.dropTable('boards');
  pgm.dropTable('idp_configs');
  pgm.dropTable('users');
  pgm.dropTable('organizations');
  for (const t of ['notification_channel', 'notification_event', 'owner_kind', 'idp_type', 'recurrence_status', 'column_semantic', 'user_role']) {
    pgm.dropType(t);
  }
};
