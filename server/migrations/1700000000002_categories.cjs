/* eslint-disable camelcase */
/** Card categories: org-scoped name+color, one category per card. */

exports.up = (pgm) => {
  pgm.createTable('categories', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    org_id: { type: 'uuid', notNull: true, references: 'organizations', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    color: { type: 'text', notNull: true }, // hex, chosen from the app's preset palette
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('categories', ['org_id']);
  pgm.addConstraint('categories', 'categories_org_name_unique', { unique: ['org_id', 'name'] });

  pgm.addColumns('cards', {
    category_id: { type: 'uuid', references: 'categories', onDelete: 'SET NULL' },
  });
  pgm.createIndex('cards', ['category_id']);
};

exports.down = (pgm) => {
  pgm.dropColumns('cards', ['category_id']);
  pgm.dropTable('categories');
};
