import { jest } from '@jest/globals';

const mockExecute = jest.fn();

await jest.unstable_mockModule('../src/connection.js', () => ({
  execute: mockExecute,
  getConfig: () => ({ sanitize: false, maxConditions: 20, auditLog: false }),
  connect: jest.fn(),
  disconnect: jest.fn(),
  getPool: jest.fn(),
  transaction: jest.fn(),
  listen: jest.fn(),
  clearListeners: jest.fn(),
}));

const { Schema } = await import('../src/schema-builder.js');

beforeEach(() => {
  jest.clearAllMocks();
  mockExecute.mockResolvedValue([[], []]);
});

// ─── P1#8: Schema.table() — full ALTER TABLE support ────────────────────────

describe('Schema.table() — add column only', () => {
  test('adds a single column via ALTER TABLE ADD COLUMN', async () => {
    await Schema.table('users', (t) => {
      t.string('nickname', 100).notNullable();
    });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [sql] = mockExecute.mock.calls[0];
    expect(sql).toContain('ALTER TABLE `users`');
    expect(sql).toContain('ADD COLUMN');
    expect(sql).toContain('`nickname`');
    expect(sql).toContain('VARCHAR(100)');
  });

  test('adds multiple columns — one ALTER per column', async () => {
    await Schema.table('orders', (t) => {
      t.string('note');
      t.integer('priority');
    });
    // 2 ADD COLUMN calls
    const sqls = mockExecute.mock.calls.map(([s]) => s);
    expect(sqls.filter((s) => s.includes('ADD COLUMN'))).toHaveLength(2);
  });
});

describe('Schema.table() — column-level unique / index', () => {
  test('column.unique() fires ADD COLUMN then ADD UNIQUE KEY', async () => {
    await Schema.table('users', (t) => {
      t.string('handle').unique();
    });
    const sqls = mockExecute.mock.calls.map(([s]) => s);
    expect(sqls[0]).toContain('ADD COLUMN `handle`');
    expect(sqls[1]).toContain('ADD UNIQUE KEY');
    expect(sqls[1]).toContain('`users_handle_unique`');
    expect(sqls[1]).toContain('(`handle`)');
  });

  test('column.index() fires ADD COLUMN then ADD KEY', async () => {
    await Schema.table('posts', (t) => {
      t.integer('views').index();
    });
    const sqls = mockExecute.mock.calls.map(([s]) => s);
    expect(sqls[0]).toContain('ADD COLUMN `views`');
    expect(sqls[1]).toContain('ADD KEY');
    expect(sqls[1]).toContain('`posts_views_index`');
  });
});

describe('Schema.table() — composite unique / index (no new column)', () => {
  test('blueprint.unique([...]) fires ADD UNIQUE KEY without ADD COLUMN', async () => {
    await Schema.table('tokens', (t) => {
      t.unique(['user_id', 'provider']);
    });
    const sqls = mockExecute.mock.calls.map(([s]) => s);
    // No ADD COLUMN
    expect(sqls.every((s) => !s.includes('ADD COLUMN'))).toBe(true);
    // Must have ADD UNIQUE KEY
    expect(sqls.some((s) => s.includes('ADD UNIQUE KEY'))).toBe(true);
    expect(sqls.some((s) => s.includes('`user_id`') && s.includes('`provider`'))).toBe(true);
  });

  test('blueprint.index([...]) fires ADD KEY without ADD COLUMN', async () => {
    await Schema.table('logs', (t) => {
      t.index(['created_at', 'level']);
    });
    const sqls = mockExecute.mock.calls.map(([s]) => s);
    expect(sqls.every((s) => !s.includes('ADD COLUMN'))).toBe(true);
    expect(sqls.some((s) => s.includes('ADD KEY'))).toBe(true);
    expect(sqls.some((s) => s.includes('`created_at`'))).toBe(true);
  });
});

describe('Schema.table() — foreign key via blueprint.foreign()', () => {
  test('blueprint.foreign().references().on() fires ADD CONSTRAINT FOREIGN KEY', async () => {
    await Schema.table('posts', (t) => {
      t.foreign('user_id').references('id').on('users').onDelete('CASCADE');
    });
    const sqls = mockExecute.mock.calls.map(([s]) => s);
    expect(sqls.some((s) => s.includes('ADD CONSTRAINT'))).toBe(true);
    const fkSql = sqls.find((s) => s.includes('FOREIGN KEY'));
    expect(fkSql).toContain('`posts_user_id_foreign`');
    expect(fkSql).toContain('REFERENCES `users` (`id`)');
    expect(fkSql).toContain('ON DELETE CASCADE');
  });

  test('incomplete foreign (missing on()) is silently skipped', async () => {
    await Schema.table('posts', (t) => {
      t.foreign('orphan_id').references('id'); // no .on()
    });
    const sqls = mockExecute.mock.calls.map(([s]) => s);
    expect(sqls.every((s) => !s.includes('FOREIGN KEY'))).toBe(true);
  });
});

describe('Schema.table() — column-level references().inTable()', () => {
  test('column.references().inTable() fires ADD COLUMN then ADD CONSTRAINT', async () => {
    await Schema.table('orders', (t) => {
      t.bigInteger('customer_id').references('id', 'customers').onDelete('CASCADE');
    });
    const sqls = mockExecute.mock.calls.map(([s]) => s);
    expect(sqls[0]).toContain('ADD COLUMN `customer_id`');
    const fkSql = sqls.find((s) => s.includes('ADD CONSTRAINT'));
    expect(fkSql).toBeDefined();
    expect(fkSql).toContain('REFERENCES `customers` (`id`)');
    expect(fkSql).toContain('ON DELETE CASCADE');
  });
});

// ─── P1#7: migrate rollback — fs alias fix (unit only, no real FS) ───────────

describe('migrator.js — existsSync alias used correctly', () => {
  test('migrateRollback code imports existsSync correctly (fs module check)', async () => {
    // Read the source file and verify the fix is present
    const { readFile } = await import('fs/promises');
    const { resolve } = await import('path');
    const { fileURLToPath } = await import('url');
    const src = await readFile(
      resolve('src/migrator.js'),
      'utf8'
    );
    // Fix: must use fs(p) not fs.existsSync(p)
    expect(src).toContain('import { existsSync as fs }');
    expect(src).toContain('.find((p) => fs(p))');
    expect(src).not.toContain('fs.existsSync');
  });
});

// ─── Schema.table() Advanced Operations (MODIFY, DROP, RENAME) ───────────────

describe('Schema.table() — MODIFY COLUMN', () => {
  test('modifies a column via ColumnDefinition.change()', async () => {
    await Schema.table('users', (t) => {
      t.string('email', 191).nullable().change();
    });
    const sqls = mockExecute.mock.calls.map(([s]) => s);
    expect(sqls.some((s) => s.includes('MODIFY COLUMN'))).toBe(true);
    const modifySql = sqls.find((s) => s.includes('MODIFY COLUMN'));
    expect(modifySql).toContain('ALTER TABLE `users` MODIFY COLUMN `email` VARCHAR(191) NULL');
  });
});

describe('Schema.table() — DROP COLUMN', () => {
  test('drops a single column via blueprint.dropColumn()', async () => {
    await Schema.table('users', (t) => {
      t.dropColumn('bio');
    });
    const sqls = mockExecute.mock.calls.map(([s]) => s);
    expect(sqls.some((s) => s.includes('DROP COLUMN'))).toBe(true);
    const dropSql = sqls.find((s) => s.includes('DROP COLUMN'));
    expect(dropSql).toContain('ALTER TABLE `users` DROP COLUMN `bio`');
  });

  test('drops multiple columns via array in blueprint.dropColumn()', async () => {
    await Schema.table('users', (t) => {
      t.dropColumn(['bio', 'avatar']);
    });
    const sqls = mockExecute.mock.calls.map(([s]) => s);
    const dropSqls = sqls.filter((s) => s.includes('DROP COLUMN'));
    expect(dropSqls).toHaveLength(2);
    expect(dropSqls[0]).toContain('DROP COLUMN `bio`');
    expect(dropSqls[1]).toContain('DROP COLUMN `avatar`');
  });
});

describe('Schema.table() — RENAME COLUMN', () => {
  test('renames a column via blueprint.renameColumn()', async () => {
    await Schema.table('users', (t) => {
      t.renameColumn('first_name', 'firstName');
    });
    const sqls = mockExecute.mock.calls.map(([s]) => s);
    expect(sqls.some((s) => s.includes('RENAME COLUMN'))).toBe(true);
    const renameSql = sqls.find((s) => s.includes('RENAME COLUMN'));
    expect(renameSql).toContain('ALTER TABLE `users` RENAME COLUMN `first_name` TO `firstName`');
  });
});
