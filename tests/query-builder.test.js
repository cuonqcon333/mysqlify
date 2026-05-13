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

const { QueryBuilder, DB } = await import('../src/query-builder.js');
const { MysqlifySecurityError } = await import('../src/security.js');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('QueryBuilder — SQL generation', () => {
  test('basic SELECT *', () => {
    const qb = new QueryBuilder().table('users');
    const { sql, params } = qb._buildSelect();
    expect(sql).toBe('SELECT * FROM `users`');
    expect(params).toEqual([]);
  });

  test('SELECT with columns', () => {
    const qb = new QueryBuilder().table('users').select('id', 'name');
    const { sql } = qb._buildSelect();
    expect(sql).toContain('SELECT id, name');
  });

  test('WHERE clause', () => {
    const qb = new QueryBuilder().table('users').where('id', 1);
    const { sql, params } = qb._buildSelect();
    expect(sql).toContain('WHERE `id` = ?');
    expect(params).toEqual([1]);
  });

  test('WHERE with operator', () => {
    const qb = new QueryBuilder().table('orders').where('total', '>=', 100);
    const { sql, params } = qb._buildSelect();
    expect(sql).toContain('`total` >= ?');
    expect(params).toContain(100);
  });

  test('WHERE IN', () => {
    const qb = new QueryBuilder().table('users').whereIn('id', [1, 2, 3]);
    const { sql, params } = qb._buildSelect();
    expect(sql).toContain('`id` IN (?, ?, ?)');
    expect(params).toEqual([1, 2, 3]);
  });

  test('WHERE NULL', () => {
    const qb = new QueryBuilder().table('users').whereNull('deleted_at');
    const { sql } = qb._buildSelect();
    expect(sql).toContain('`deleted_at` IS NULL');
  });

  test('WHERE BETWEEN', () => {
    const qb = new QueryBuilder().table('orders').whereBetween('total', [10, 100]);
    const { sql, params } = qb._buildSelect();
    expect(sql).toContain('BETWEEN ? AND ?');
    expect(params).toEqual([10, 100]);
  });

  test('ORDER BY', () => {
    const qb = new QueryBuilder().table('users').orderBy('name', 'DESC');
    const { sql } = qb._buildSelect();
    expect(sql).toContain('ORDER BY `name` DESC');
  });

  test('LIMIT and OFFSET', () => {
    const qb = new QueryBuilder().table('users').limit(10).offset(20);
    const { sql } = qb._buildSelect();
    expect(sql).toContain('LIMIT 10');
    expect(sql).toContain('OFFSET 20');
  });

  test('JOIN', () => {
    const qb = new QueryBuilder()
      .table('posts')
      .join('users', 'posts.user_id', 'users.id');
    const { sql } = qb._buildSelect();
    expect(sql).toContain('INNER JOIN `users` ON `posts.user_id` = `users.id`');
  });

  test('LEFT JOIN', () => {
    const qb = new QueryBuilder()
      .table('posts')
      .leftJoin('users', 'posts.user_id', 'users.id');
    const { sql } = qb._buildSelect();
    expect(sql).toContain('LEFT JOIN');
  });

  test('multiple WHERE chained', () => {
    const qb = new QueryBuilder()
      .table('users')
      .where('active', 1)
      .where('role', 'admin');
    const { sql, params } = qb._buildSelect();
    expect(sql).toContain('`active` = ?');
    expect(sql).toContain('`role` = ?');
    expect(params).toEqual([1, 'admin']);
  });
});

describe('QueryBuilder — Security', () => {
  test('rejects invalid table name', () => {
    expect(() => new QueryBuilder().table('users; DROP TABLE users')).toThrow(MysqlifySecurityError);
  });

  test('rejects invalid column name in where', () => {
    expect(() => new QueryBuilder().table('users').where("col' OR '1'='1", 1)).toThrow(MysqlifySecurityError);
  });

  test('rejects invalid operator in where', () => {
    expect(() => new QueryBuilder().table('users').where('id', 'INVALID_OP', 1)).toThrow(MysqlifySecurityError);
  });

  test('rejects invalid column in whereIn', () => {
    expect(() => new QueryBuilder().table('users').whereIn('col; DROP', [1])).toThrow(MysqlifySecurityError);
  });

  test('rejects invalid data keys in insert', async () => {
    mockExecute.mockResolvedValue([{ insertId: 1 }]);
    const qb = new QueryBuilder().table('users');
    await expect(qb.insert({ 'bad-key': 'value' })).rejects.toThrow(MysqlifySecurityError);
  });

  test('DB.raw rejects non-array bindings', async () => {
    await expect(DB.raw('SELECT 1', 'not-array')).rejects.toThrow(MysqlifySecurityError);
  });

  test('maxConditions limit throws after N wheres', () => {
    const qb = new QueryBuilder().table('users');
    expect(() => {
      for (let i = 0; i < 25; i++) {
        qb.where('id', i);
      }
    }).toThrow(MysqlifySecurityError);
  });
});

describe('QueryBuilder — CRUD execution', () => {
  test('get() calls execute with correct SQL', async () => {
    mockExecute.mockResolvedValue([[{ id: 1, name: 'John' }]]);
    const rows = await new QueryBuilder().table('users').where('id', 1).get();
    expect(mockExecute).toHaveBeenCalledWith(
      expect.stringContaining('SELECT * FROM `users`'),
      expect.arrayContaining([1]),
      null
    );
    expect(rows).toEqual([{ id: 1, name: 'John' }]);
  });

  test('first() returns single row', async () => {
    mockExecute.mockResolvedValue([[{ id: 1 }]]);
    const row = await new QueryBuilder().table('users').where('id', 1).first();
    expect(row).toEqual({ id: 1 });
  });

  test('first() returns null when no rows', async () => {
    mockExecute.mockResolvedValue([[]]);
    const row = await new QueryBuilder().table('users').where('id', 999).first();
    expect(row).toBeNull();
  });

  test('insert() calls execute and returns insertId', async () => {
    mockExecute.mockResolvedValue([{ insertId: 42 }]);
    const id = await new QueryBuilder().table('users').insert({ name: 'John' });
    expect(mockExecute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO `users`'),
      expect.arrayContaining(['John']),
      null
    );
    expect(id).toBe(42);
  });

  test('update() returns affectedRows', async () => {
    mockExecute.mockResolvedValue([{ affectedRows: 1 }]);
    const affected = await new QueryBuilder().table('users').where('id', 1).update({ name: 'Jane' });
    expect(affected).toBe(1);
  });

  test('delete() returns affectedRows', async () => {
    mockExecute.mockResolvedValue([{ affectedRows: 1 }]);
    const affected = await new QueryBuilder().table('users').where('id', 1).delete();
    expect(affected).toBe(1);
  });

  test('count() returns number', async () => {
    mockExecute.mockResolvedValue([[{ aggregate: 5 }]]);
    const count = await new QueryBuilder().table('users').count();
    expect(count).toBe(5);
  });

  test('paginate() returns structured result', async () => {
    mockExecute
      .mockResolvedValueOnce([[{ aggregate: 30 }]])
      .mockResolvedValueOnce([[{ id: 1 }, { id: 2 }]]);
    const result = await new QueryBuilder().table('users').paginate(1, 2);
    expect(result.total).toBe(30);
    expect(result.page).toBe(1);
    expect(result.perPage).toBe(2);
    expect(result.lastPage).toBe(15);
    expect(result.data).toHaveLength(2);
  });
});

describe('QueryBuilder — JSON auto-serialization', () => {
  test('insert: object value is JSON.stringify-ed automatically', async () => {
    mockExecute.mockResolvedValue([{ insertId: 1 }]);
    const payload = { accessToken: 'abc', refreshToken: 'xyz' };
    await new QueryBuilder().table('accounts').insert({ user_id: 1, extra: payload });

    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('`extra`');
    expect(params).toContain(JSON.stringify(payload));
    expect(typeof params[params.indexOf(JSON.stringify(payload))]).toBe('string');
  });

  test('insert: array value is JSON.stringify-ed automatically', async () => {
    mockExecute.mockResolvedValue([{ insertId: 2 }]);
    const tags = ['mysql', 'node', 'orm'];
    await new QueryBuilder().table('posts').insert({ title: 'Hello', tags });

    const [, params] = mockExecute.mock.calls[0];
    expect(params).toContain(JSON.stringify(tags));
  });

  test('insert: null stays null (not serialized)', async () => {
    mockExecute.mockResolvedValue([{ insertId: 3 }]);
    await new QueryBuilder().table('accounts').insert({ user_id: 1, extra: null });

    const [, params] = mockExecute.mock.calls[0];
    expect(params).toContain(null);
  });

  test('insert: primitive string is NOT double-encoded', async () => {
    mockExecute.mockResolvedValue([{ insertId: 4 }]);
    await new QueryBuilder().table('users').insert({ name: 'John' });

    const [, params] = mockExecute.mock.calls[0];
    expect(params).toContain('John');
    expect(params).not.toContain('"John"');
  });

  test('update: object value is JSON.stringify-ed automatically', async () => {
    mockExecute.mockResolvedValue([{ affectedRows: 1 }]);
    const meta = { role: 'admin', level: 3 };
    await new QueryBuilder().table('users').where('id', 1).update({ meta });

    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('`meta`');
    expect(params[0]).toBe(JSON.stringify(meta));
  });
});

describe('QueryBuilder — fillable/hidden', () => {
  test('fillable filters insert data', async () => {
    mockExecute.mockResolvedValue([{ insertId: 1 }]);
    await new QueryBuilder()
      .table('users')
      .fillable(['name'])
      .insert({ name: 'John', admin: true });

    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('`name`');
    expect(sql).not.toContain('`admin`');
    expect(params).toContain('John');
    expect(params).not.toContain(true);
  });

  test('hidden removes fields from result', async () => {
    mockExecute.mockResolvedValue([[{ id: 1, name: 'John', password: 'hashed' }]]);
    const rows = await new QueryBuilder()
      .table('users')
      .hidden(['password'])
      .get();
    expect(rows[0].password).toBeUndefined();
    expect(rows[0].name).toBe('John');
  });
});

describe('whereRaw / selectRaw / toSQL', () => {
  test('whereRaw() injects raw SQL into WHERE clause', async () => {
    mockExecute.mockResolvedValue([[]]);
    await new QueryBuilder().table('orders').whereRaw('YEAR(created_at) = ?', [2026]).get();
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('YEAR(created_at) = ?');
    expect(params).toContain(2026);
  });

  test('selectRaw() injects raw expression into SELECT', async () => {
    mockExecute.mockResolvedValue([[]]);
    await new QueryBuilder().table('orders').selectRaw('COUNT(*) as total').get();
    const [sql] = mockExecute.mock.calls[0];
    expect(sql).toContain('COUNT(*) as total');
  });

  test('toSQL() returns sql and params without executing', () => {
    const { sql, params } = new QueryBuilder()
      .table('users')
      .where('active', 1)
      .orderBy('name')
      .toSQL();
    expect(sql).toContain('SELECT * FROM `users`');
    expect(sql).toContain('WHERE `active` = ?');
    expect(params).toContain(1);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe('insertMany / upsert / increment / decrement', () => {
  test('insertMany() generates batch INSERT with multiple value sets', async () => {
    mockExecute.mockResolvedValue([{ affectedRows: 3 }]);
    const affected = await new QueryBuilder().table('tags').insertMany([
      { name: 'a' },
      { name: 'b' },
      { name: 'c' },
    ]);
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('INSERT INTO `tags`');
    expect(sql.match(/\(\?\)/g)).toHaveLength(3);
    expect(params).toEqual(['a', 'b', 'c']);
    expect(affected).toBe(3);
  });

  test('upsert() generates INSERT ... ON DUPLICATE KEY UPDATE', async () => {
    mockExecute.mockResolvedValue([{ insertId: 1, affectedRows: 1 }]);
    const result = await new QueryBuilder().table('tokens').upsert(
      { acct_id: 'abc', access_token: 'tok1' },
      ['access_token']
    );
    const [sql] = mockExecute.mock.calls[0];
    expect(sql).toContain('INSERT INTO `tokens`');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(sql).toContain('`access_token` = VALUES(`access_token`)');
    expect(result.insertId).toBe(1);
  });

  test('increment() generates SET col = col + n', async () => {
    mockExecute.mockResolvedValue([{ affectedRows: 1 }]);
    await new QueryBuilder().table('wallets').where('user_id', 1).increment('balance', 50);
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('`balance` = `balance` + ?');
    expect(params).toContain(50);
    expect(params).toContain(1);
  });

  test('decrement() generates SET col = col - n', async () => {
    mockExecute.mockResolvedValue([{ affectedRows: 1 }]);
    await new QueryBuilder().table('wallets').where('user_id', 1).decrement('balance', 20);
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('`balance` = `balance` - ?');
    expect(params).toContain(20);
  });
});

describe('DB.transaction()', () => {
  test('calls underlying transaction() with trxDB exposing table/raw/execute', async () => {
    const mockTrxFn = jest.fn().mockImplementation(async (cb) => {
      const mockConn = { execute: mockExecute };
      const trxDB = {
        table: (name) => new QueryBuilder().table(name)._useConnection(mockConn),
        execute: (sql, params) => mockExecute(sql, params),
      };
      return cb(trxDB);
    });

    const { transaction: mockTransaction } = await import('../src/connection.js');
    mockTransaction.mockImplementation(mockTrxFn);

    mockExecute.mockResolvedValue([{ insertId: 1 }]);

    await DB.transaction(async (trx) => {
      await trx.table('orders').insert({ total: 99 });
    });

    expect(mockTrxFn).toHaveBeenCalledTimes(1);
  });
});

// ─── DB.listen() / Query logging ─────────────────────────────────────────────

describe('DB.listen()', () => {
  test('listen() delegates to connection.listen', async () => {
    const { listen: mockListen } = await import('../src/connection.js');
    const fn = jest.fn();
    DB.listen(fn);
    expect(mockListen).toHaveBeenCalledWith(fn);
  });

  test('clearListeners() delegates to connection.clearListeners', async () => {
    const { clearListeners: mockClear } = await import('../src/connection.js');
    DB.clearListeners();
    expect(mockClear).toHaveBeenCalled();
  });
});

// ─── Date / Datetime serialization ───────────────────────────────────────────

describe('Date serialization — timezone-safe', () => {
  // Helper: build expected local datetime string from a Date
  function localDatetime(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return (
      d.getFullYear() + '-' +
      pad(d.getMonth() + 1) + '-' +
      pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' +
      pad(d.getMinutes()) + ':' +
      pad(d.getSeconds())
    );
  }

  test('Date object is serialized as local time, not UTC', async () => {
    mockExecute.mockResolvedValue([{ insertId: 1, affectedRows: 1 }]);
    const d = new Date('2026-05-13T23:35:57.887Z');
    await DB.table('tokens').insert({ expires_at: d });
    const [, params] = mockExecute.mock.calls[0];
    expect(params[0]).toBe(localDatetime(d));
    // Must NOT be the UTC ISO string
    expect(params[0]).not.toContain('T');
    expect(params[0]).not.toContain('Z');
  });

  test('ISO string is serialized as local time, not raw UTC', async () => {
    mockExecute.mockResolvedValue([{ insertId: 1, affectedRows: 1 }]);
    const isoString = '2026-05-13T23:35:57.887Z';
    const expected = localDatetime(new Date(isoString));
    await DB.table('tokens').insert({ expires_at: isoString });
    const [, params] = mockExecute.mock.calls[0];
    expect(params[0]).toBe(expected);
  });

  test('serialized format matches YYYY-MM-DD HH:mm:ss pattern', async () => {
    mockExecute.mockResolvedValue([{ insertId: 1, affectedRows: 1 }]);
    await DB.table('events').insert({ starts_at: new Date() });
    const [, params] = mockExecute.mock.calls[0];
    expect(params[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});
