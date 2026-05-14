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

const { Model } = await import('../src/model.js');

class User extends Model {
  static table = 'users';
  static primaryKey = 'id';
  static timestamps = false;
  static fillable = ['name', 'email'];
  static hidden = ['password'];
  static softDelete = false;
}

class Post extends Model {
  static table = 'posts';
  static timestamps = false;
  static softDelete = true;
  static fillable = ['title', 'body', 'user_id'];
  static hidden = [];
}

class Account extends Model {
  static table = 'accounts';
  static timestamps = false;
  static softDelete = false;
  static fillable = [];
  static guarded = [];
}

class Order extends Model {
  static table = 'orders';
  static timestamps = false;
  static softDelete = false;
  static fillable = [];
  static guarded = [];
  static casts = {
    total: 'float',
    quantity: 'integer',
    is_paid: 'boolean',
    meta: 'json',
    tags: 'array',
    created_date: 'date',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Model._resolveTable()', () => {
  test('uses explicit static table', () => {
    expect(User._resolveTable()).toBe('users');
  });

  test('auto-infers table name from class name', () => {
    class BlogPost extends Model {}
    expect(BlogPost._resolveTable()).toBe('blog_posts');
  });
});

describe('Model.all()', () => {
  test('fetches all rows and returns hydrated instances', async () => {
    mockExecute.mockResolvedValue([[{ id: 1, name: 'John', password: 'x' }]]);
    const users = await User.all();
    expect(users).toHaveLength(1);
    expect(users[0]).toBeInstanceOf(User);
    expect(users[0].name).toBe('John');
  });
});

describe('Model.find()', () => {
  test('fetches single row by id', async () => {
    mockExecute.mockResolvedValue([[{ id: 1, name: 'John' }]]);
    const user = await User.find(1);
    expect(user).toBeInstanceOf(User);
    expect(user.id).toBe(1);
  });

  test('returns null when not found', async () => {
    mockExecute.mockResolvedValue([[]]);
    const user = await User.find(999);
    expect(user).toBeNull();
  });
});

describe('Model.create()', () => {
  test('inserts and returns instance', async () => {
    mockExecute
      .mockResolvedValueOnce([{ insertId: 5 }])
      .mockResolvedValueOnce([[{ id: 5, name: 'Jane', email: 'j@x.com' }]]);

    const user = await User.create({ name: 'Jane', email: 'j@x.com', admin: true });
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('INSERT INTO `users`');
    expect(params).toContain('Jane');
    expect(params).not.toContain(true);
    expect(user).toBeInstanceOf(User);
    expect(user.id).toBe(5);
  });
});

describe('Model.create() — JSON auto-serialization', () => {
  test('object field is JSON.stringify-ed before insert', async () => {
    mockExecute
      .mockResolvedValueOnce([{ insertId: 10 }])
      .mockResolvedValueOnce([[{ id: 10, user_id: 1, extra: '{"role":"admin"}' }]]);

    const extra = { role: 'admin' };
    await Account.create({ user_id: 1, extra });

    const [, params] = mockExecute.mock.calls[0];
    expect(params).toContain(JSON.stringify(extra));
    expect(typeof params[params.indexOf(JSON.stringify(extra))]).toBe('string');
  });

  test('null field stays null after insert', async () => {
    mockExecute
      .mockResolvedValueOnce([{ insertId: 11 }])
      .mockResolvedValueOnce([[{ id: 11, user_id: 2, extra: null }]]);

    await Account.create({ user_id: 2, extra: null });

    const [, params] = mockExecute.mock.calls[0];
    expect(params).toContain(null);
  });
});

describe('Model.where() chaining', () => {
  test('returns wrapped query builder and resolves .get()', async () => {
    mockExecute.mockResolvedValue([[{ id: 1, name: 'John' }]]);
    const users = await User.where('active', 1).get();
    expect(users[0]).toBeInstanceOf(User);
    expect(mockExecute).toHaveBeenCalledWith(
      expect.stringContaining('WHERE `active` = ?'),
      expect.arrayContaining([1]),
      null
    );
  });

  test('.first() returns single instance', async () => {
    mockExecute.mockResolvedValue([[{ id: 2, name: 'Jane' }]]);
    const user = await User.where('email', 'j@x.com').first();
    expect(user).toBeInstanceOf(User);
    expect(user.name).toBe('Jane');
  });
});

describe('Model — direct assignment then save()', () => {
  test('account.field = value then save() sends updated value', async () => {
    mockExecute.mockResolvedValue([{ affectedRows: 1 }]);
    const account = new Account({ id: 5, user_id: 1, acct_id: 'old' });
    account._exists = true;
    account.acct_id = 'new-id';
    account.access_token = 'token-abc';
    await account.save();
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('UPDATE `accounts`');
    expect(params).toContain('new-id');
    expect(params).toContain('token-abc');
    expect(params).toContain(5);
  });

  test('field assignment respects fillable — blocked fields not sent', async () => {
    mockExecute.mockResolvedValue([{ affectedRows: 1 }]);
    const user = new User({ id: 3, name: 'A', email: 'a@x.com' });
    user._exists = true;
    user.name = 'B';
    user.admin = true;
    await user.save();
    const [sql, params] = mockExecute.mock.calls[0];
    expect(params).toContain('B');
    expect(sql).not.toContain('`admin`');
  });
});

describe('Model instance methods — update/delete/fresh/fill', () => {
  test('instance.update(data) issues UPDATE with pk WHERE and merges into instance', async () => {
    mockExecute.mockResolvedValue([{ affectedRows: 1 }]);
    const user = new User({ id: 7, name: 'Old', email: 'old@x.com' });
    user._exists = true;
    const result = await user.update({ name: 'New' });
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('UPDATE `users`');
    expect(sql).toContain('WHERE `id` = ?');
    expect(params).toContain('New');
    expect(params).toContain(7);
    expect(user.name).toBe('New');
    expect(result).toBe(user);
  });

  test('instance.update(data) respects fillable', async () => {
    mockExecute.mockResolvedValue([{ affectedRows: 1 }]);
    const user = new User({ id: 8, name: 'A', email: 'a@x.com' });
    user._exists = true;
    await user.update({ name: 'B', admin: true });
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).not.toContain('`admin`');
    expect(params).toContain('B');
  });

  test('instance.delete() calls destroy() and sets _exists false', async () => {
    mockExecute.mockResolvedValue([{ affectedRows: 1 }]);
    const user = new User({ id: 9, name: 'X', email: 'x@x.com' });
    user._exists = true;
    await user.delete();
    const [sql] = mockExecute.mock.calls[0];
    expect(sql).toContain('`id` = ?');
    expect(user._exists).toBe(false);
  });

  test('instance.fresh() re-fetches from DB and updates instance', async () => {
    mockExecute.mockResolvedValue([[{ id: 3, name: 'Refreshed', email: 'r@x.com' }]]);
    const user = new User({ id: 3, name: 'Stale', email: 'old@x.com' });
    user._exists = true;
    const result = await user.fresh();
    expect(result).toBe(user);
    expect(user.name).toBe('Refreshed');
  });

  test('instance.fill(data) assigns fields and returns this', () => {
    const user = new User({ id: 1, name: 'A', email: 'a@x.com' });
    const result = user.fill({ name: 'B', email: 'b@x.com' });
    expect(result).toBe(user);
    expect(user.name).toBe('B');
    expect(user.email).toBe('b@x.com');
  });

  test('instance.fill().update() chain works', async () => {
    mockExecute.mockResolvedValue([{ affectedRows: 1 }]);
    const user = new User({ id: 10, name: 'A', email: 'a@x.com' });
    user._exists = true;
    await user.fill({ name: 'Chained' }).update({ name: 'Chained' });
    expect(user.name).toBe('Chained');
  });
});

describe('Model instance.save()', () => {
  test('INSERT when _exists is false', async () => {
    mockExecute
      .mockResolvedValueOnce([{ insertId: 10 }])
      .mockResolvedValueOnce([[{ id: 10, name: 'New' }]]);

    const user = new User({ name: 'New', email: 'n@x.com' });
    await user.save();

    const [sql] = mockExecute.mock.calls[0];
    expect(sql).toContain('INSERT INTO `users`');
    expect(user.id).toBe(10);
    expect(user._exists).toBe(true);
  });

  test('UPDATE when _exists is true', async () => {
    mockExecute.mockResolvedValue([{ affectedRows: 1 }]);

    const user = new User({ id: 5, name: 'Old', email: 'o@x.com' });
    user._exists = true;
    user.name = 'Updated';
    await user.save();

    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('UPDATE `users`');
    expect(params).toContain('Updated');
  });
});

describe('Model instance.destroy()', () => {
  test('deletes the record', async () => {
    mockExecute.mockResolvedValue([{ affectedRows: 1 }]);
    const user = new User({ id: 3 });
    user._exists = true;
    const result = await user.destroy();
    expect(result).toBe(1);
    expect(user._exists).toBe(false);
  });
});

describe('Model instance.toJSON()', () => {
  test('hides hidden fields', () => {
    const user = new User({ id: 1, name: 'John', password: 'hashed' });
    const json = user.toJSON();
    expect(json.password).toBeUndefined();
    expect(json.name).toBe('John');
  });

  test('does not include internal _ properties', () => {
    const user = new User({ id: 1, name: 'John' });
    const json = user.toJSON();
    expect(json._original).toBeUndefined();
    expect(json._attributes).toBeUndefined();
    expect(json._exists).toBeUndefined();
  });
});

describe('Model casts', () => {
  test('float cast converts string to number', async () => {
    mockExecute.mockResolvedValue([[{ id: 1, total: '99.50', quantity: '3', is_paid: 1, meta: '{"note":"ok"}', tags: '["a","b"]', created_date: '2026-05-12T00:00:00.000Z' }]]);
    const order = await Order.find(1);
    expect(order.total).toBe(99.5);
    expect(typeof order.total).toBe('number');
  });

  test('integer cast converts string to int', async () => {
    mockExecute.mockResolvedValue([[{ id: 1, total: '10.00', quantity: '5', is_paid: 0, meta: null, tags: null, created_date: null }]]);
    const order = await Order.find(1);
    expect(order.quantity).toBe(5);
    expect(typeof order.quantity).toBe('number');
  });

  test('boolean cast: 1 → true, 0 → false', async () => {
    mockExecute.mockResolvedValue([[{ id: 1, total: '0', quantity: '1', is_paid: 1, meta: null, tags: null, created_date: null }]]);
    const order1 = await Order.find(1);
    expect(order1.is_paid).toBe(true);

    mockExecute.mockResolvedValue([[{ id: 2, total: '0', quantity: '1', is_paid: 0, meta: null, tags: null, created_date: null }]]);
    const order2 = await Order.find(2);
    expect(order2.is_paid).toBe(false);
  });

  test('json cast parses JSON string to object', async () => {
    mockExecute.mockResolvedValue([[{ id: 1, total: '0', quantity: '1', is_paid: 0, meta: '{"role":"admin","level":3}', tags: null, created_date: null }]]);
    const order = await Order.find(1);
    expect(order.meta).toEqual({ role: 'admin', level: 3 });
    expect(typeof order.meta).toBe('object');
  });

  test('array cast parses JSON array string', async () => {
    mockExecute.mockResolvedValue([[{ id: 1, total: '0', quantity: '1', is_paid: 0, meta: null, tags: '["mysql","node"]', created_date: null }]]);
    const order = await Order.find(1);
    expect(order.tags).toEqual(['mysql', 'node']);
    expect(Array.isArray(order.tags)).toBe(true);
  });

  test('date cast formats to YYYY-MM-DD', async () => {
    mockExecute.mockResolvedValue([[{ id: 1, total: '0', quantity: '1', is_paid: 0, meta: null, tags: null, created_date: '2026-05-12T06:30:00.000Z' }]]);
    const order = await Order.find(1);
    expect(order.created_date).toBe('2026-05-12');
  });

  test('null values are not cast (stay null)', async () => {
    mockExecute.mockResolvedValue([[{ id: 1, total: null, quantity: null, is_paid: null, meta: null, tags: null, created_date: null }]]);
    const order = await Order.find(1);
    expect(order.total).toBeNull();
    expect(order.meta).toBeNull();
    expect(order.is_paid).toBeNull();
  });

  test('json cast skips parsing if already object', async () => {
    mockExecute.mockResolvedValue([[{ id: 1, total: '0', quantity: '1', is_paid: 0, meta: { role: 'admin' }, tags: null, created_date: null }]]);
    const order = await Order.find(1);
    expect(order.meta).toEqual({ role: 'admin' });
  });

  test('create(): casts applied on returned instance', async () => {
    mockExecute
      .mockResolvedValueOnce([{ insertId: 20 }])
      .mockResolvedValueOnce([[{ id: 20, total: '49.99', quantity: '2', is_paid: 1, meta: '{"promo":true}', tags: null, created_date: null }]]);

    const order = await Order.create({ total: 49.99, quantity: 2, is_paid: true });
    expect(order.total).toBe(49.99);
    expect(order.quantity).toBe(2);
    expect(order.is_paid).toBe(true);
    expect(order.meta).toEqual({ promo: true });
  });

  test('where().get(): casts applied on all rows', async () => {
    mockExecute.mockResolvedValue([[
      { id: 1, total: '10.00', quantity: '1', is_paid: 1, meta: null, tags: null, created_date: null },
      { id: 2, total: '20.50', quantity: '3', is_paid: 0, meta: null, tags: null, created_date: null },
    ]]);
    const orders = await Order.where('is_paid', 1).get();
    expect(orders[0].total).toBe(10.0);
    expect(orders[0].is_paid).toBe(true);
    expect(orders[1].total).toBe(20.5);
    expect(orders[1].is_paid).toBe(false);
  });

  test('where().first(): casts applied on single result', async () => {
    mockExecute.mockResolvedValue([[{ id: 5, total: '7.77', quantity: '1', is_paid: 0, meta: '{"note":"x"}', tags: null, created_date: null }]]);
    const order = await Order.where('id', 5).first();
    expect(order.total).toBe(7.77);
    expect(order.meta).toEqual({ note: 'x' });
  });

  test('paginate(): casts applied on paginated data', async () => {
    mockExecute
      .mockResolvedValueOnce([[{ aggregate: 2 }]])
      .mockResolvedValueOnce([[
        { id: 1, total: '5.00', quantity: '1', is_paid: 1, meta: null, tags: null, created_date: null },
        { id: 2, total: '15.00', quantity: '2', is_paid: 0, meta: null, tags: null, created_date: null },
      ]]);
    const result = await Order.paginate(1, 2);
    expect(result.data[0].total).toBe(5.0);
    expect(result.data[0].is_paid).toBe(true);
    expect(result.data[1].is_paid).toBe(false);
  });

  test('save() new instance: casts applied on returned instance', async () => {
    mockExecute.mockResolvedValue([{ insertId: 30 }]);
    const order = new Order({ total: '99.00', quantity: '1', is_paid: 1, meta: null, tags: null, created_date: null });
    const saved = await order.save();
    expect(saved).toBe(order);
    expect(saved.id).toBe(30);
  });

  test('toJSON(): JSON string column auto-parsed to object without casts', async () => {
    mockExecute.mockResolvedValue([[{ id: 1, user_id: 1, extra: '{"token":"abc","scope":"read"}' }]]);
    const account = await Account.find(1);
    const json = account.toJSON();
    expect(typeof json.extra).toBe('object');
    expect(json.extra).toEqual({ token: 'abc', scope: 'read' });
  });

  test('toJSON(): JSON array string auto-parsed to array without casts', async () => {
    mockExecute.mockResolvedValue([[{ id: 1, user_id: 1, extra: '["a","b","c"]' }]]);
    const account = await Account.find(1);
    const json = account.toJSON();
    expect(Array.isArray(json.extra)).toBe(true);
    expect(json.extra).toEqual(['a', 'b', 'c']);
  });

  test('toJSON(): plain string NOT parsed as JSON', async () => {
    mockExecute.mockResolvedValue([[{ id: 1, user_id: 1, extra: null, acct_id: 'hello world' }]]);
    const account = await Account.find(1);
    const json = account.toJSON();
    expect(json.acct_id).toBe('hello world');
    expect(typeof json.acct_id).toBe('string');
  });
});

describe('isDirty / isClean / getDirty', () => {
  test('isDirty() returns false on fresh hydrated instance', async () => {
    mockExecute.mockResolvedValue([[{ id: 1, name: 'Alice', email: 'a@x.com' }]]);
    const user = await User.find(1);
    expect(user.isDirty()).toBe(false);
    expect(user.isClean()).toBe(true);
  });

  test('isDirty() returns true after field assignment', async () => {
    mockExecute.mockResolvedValue([[{ id: 1, name: 'Alice', email: 'a@x.com' }]]);
    const user = await User.find(1);
    user.name = 'Bob';
    expect(user.isDirty()).toBe(true);
    expect(user.isDirty('name')).toBe(true);
    expect(user.isDirty('email')).toBe(false);
    expect(user.isClean('email')).toBe(true);
  });

  test('getDirty() returns only changed fields', async () => {
    mockExecute.mockResolvedValue([[{ id: 1, name: 'Alice', email: 'a@x.com' }]]);
    const user = await User.find(1);
    user.name = 'Bob';
    expect(user.getDirty()).toEqual({ name: 'Bob' });
  });

  test('save() sends only dirty fields on UPDATE', async () => {
    mockExecute.mockResolvedValue([[{ id: 1, name: 'Alice', email: 'a@x.com' }]]);
    const user = await User.find(1);
    user.name = 'Bob';

    mockExecute.mockClear();
    mockExecute.mockResolvedValue([{ affectedRows: 1 }]);
    await user.save();

    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('`name`');
    expect(sql).not.toContain('`email`');
    expect(params).toContain('Bob');
  });

  test('save() skips UPDATE if nothing is dirty', async () => {
    mockExecute.mockResolvedValue([[{ id: 1, name: 'Alice', email: 'a@x.com' }]]);
    const user = await User.find(1);

    mockExecute.mockClear();
    await user.save();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe('findOrFail / findMany / firstOrCreate / updateOrCreate / createMany', () => {
  test('findOrFail() returns instance when found', async () => {
    mockExecute.mockResolvedValue([[{ id: 1, name: 'Alice', email: 'a@x.com' }]]);
    const user = await User.findOrFail(1);
    expect(user).toBeInstanceOf(User);
  });

  test('findOrFail() throws when not found', async () => {
    mockExecute.mockResolvedValue([[]]);
    await expect(User.findOrFail(999)).rejects.toThrow('User with id 999 not found');
  });

  test('findMany() returns array of instances', async () => {
    mockExecute.mockResolvedValue([[{ id: 1, name: 'A', email: 'a@x.com' }, { id: 2, name: 'B', email: 'b@x.com' }]]);
    const users = await User.findMany([1, 2]);
    expect(users).toHaveLength(2);
    expect(users[0]).toBeInstanceOf(User);
    const [sql] = mockExecute.mock.calls[0];
    expect(sql).toContain('IN');
  });

  test('findMany() with empty array returns []', async () => {
    const users = await User.findMany([]);
    expect(users).toEqual([]);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test('firstOrCreate() returns existing record', async () => {
    mockExecute.mockResolvedValue([[{ id: 1, name: 'Alice', email: 'a@x.com' }]]);
    const user = await User.firstOrCreate({ email: 'a@x.com' });
    expect(user).toBeInstanceOf(User);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  test('firstOrCreate() creates when not found', async () => {
    mockExecute
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ insertId: 5 }])
      .mockResolvedValueOnce([[{ id: 5, name: 'New', email: 'new@x.com' }]]);
    const user = await User.firstOrCreate({ email: 'new@x.com' }, { name: 'New' });
    expect(user).toBeInstanceOf(User);
    expect(user.id).toBe(5);
  });

  test('updateOrCreate() updates existing record', async () => {
    mockExecute
      .mockResolvedValueOnce([[{ id: 1, name: 'Old', email: 'a@x.com' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    const user = await User.updateOrCreate({ email: 'a@x.com' }, { name: 'New' });
    expect(user).toBeInstanceOf(User);
    const calls = mockExecute.mock.calls;
    expect(calls[1][0]).toContain('UPDATE');
  });

  test('updateOrCreate() creates when not found', async () => {
    mockExecute
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ insertId: 10 }])
      .mockResolvedValueOnce([[{ id: 10, name: 'New', email: 'new@x.com' }]]);
    const user = await User.updateOrCreate({ email: 'new@x.com' }, { name: 'New' });
    expect(user).toBeInstanceOf(User);
    expect(user.id).toBe(10);
  });

  test('createMany() batch inserts and returns prepared rows', async () => {
    mockExecute.mockResolvedValue([{ affectedRows: 2 }]);
    const result = await User.createMany([
      { name: 'A', email: 'a@x.com' },
      { name: 'B', email: 'b@x.com' },
    ]);
    expect(result).toHaveLength(2);
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('INSERT INTO `users`');
    expect(sql).toContain('VALUES');
    expect(params).toContain('A');
    expect(params).toContain('B');
    expect(params).toContain('a@x.com');
    expect(params).toContain('b@x.com');
  });
});

describe('Model soft delete', () => {
  test('.delete() sets deleted_at instead of hard delete', async () => {
    mockExecute.mockResolvedValue([{ affectedRows: 1 }]);
    const affected = await Post.where('id', 1).delete();
    const [sql] = mockExecute.mock.calls[0];
    expect(sql).toContain('UPDATE `posts`');
    expect(sql).toContain('deleted_at');
  });

  test('.withTrashed() includes deleted records', async () => {
    mockExecute.mockResolvedValue([[{ id: 1, title: 'Test', deleted_at: '2026-01-01' }]]);
    const posts = await Post.withTrashed().get();
    const [sql] = mockExecute.mock.calls[0];
    expect(sql).not.toContain('deleted_at IS NULL');
    expect(posts).toHaveLength(1);
  });

  test('default query excludes deleted records', async () => {
    mockExecute.mockResolvedValue([[]]);
    await Post.all();
    const [sql] = mockExecute.mock.calls[0];
    expect(sql).toContain('deleted_at');
    expect(sql).toContain('IS NULL');
  });
});

describe('Model boot() + lifecycle hooks', () => {
  beforeEach(() => {
    mockExecute.mockReset();
    Model._hooks = {};
  });

  test('static boot() is called once on first DB operation', async () => {
    const bootFn = jest.fn();
    class Widget extends Model {
      static table = 'widgets';
      static timestamps = false;
      static fillable = ['name'];
      static boot() { bootFn(); }
    }

    mockExecute
      .mockResolvedValueOnce([{ insertId: 1 }])
      .mockResolvedValueOnce([[{ id: 1, name: 'Gear' }]]);

    await Widget.create({ name: 'Gear' });
    await Widget.create({ name: 'Gear2' }).catch(() => {});

    expect(bootFn).toHaveBeenCalledTimes(1);
  });

  test('on("creating") hook fires before insert and receives instance', async () => {
    const handler = jest.fn();
    class Product extends Model {
      static table = 'products';
      static timestamps = false;
      static fillable = ['name', 'slug'];
      static boot() {
        Product.on('creating', (instance) => {
          instance.slug = instance.name.toLowerCase().replace(/ /g, '-');
          handler(instance);
        });
      }
    }

    mockExecute
      .mockResolvedValueOnce([{ insertId: 1 }])
      .mockResolvedValueOnce([[{ id: 1, name: 'My Item', slug: 'my-item' }]]);

    await Product.create({ name: 'My Item' });
    expect(handler).toHaveBeenCalledTimes(1);
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('INSERT');
    expect(params).toContain('my-item');
  });

  test('on("creating") returning false cancels insert', async () => {
    class Blocked extends Model {
      static table = 'blocked';
      static timestamps = false;
      static fillable = ['name'];
      static boot() {
        Blocked.on('creating', () => false);
      }
    }

    const result = await Blocked.create({ name: 'x' });
    expect(result).toBeNull();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test('on("created") fires after successful insert', async () => {
    const afterCreate = jest.fn();
    class Tag extends Model {
      static table = 'tags';
      static timestamps = false;
      static fillable = ['name'];
      static boot() {
        Tag.on('created', (instance) => afterCreate(instance));
      }
    }

    mockExecute
      .mockResolvedValueOnce([{ insertId: 5 }])
      .mockResolvedValueOnce([[{ id: 5, name: 'node' }]]);

    const tag = await Tag.create({ name: 'node' });
    expect(afterCreate).toHaveBeenCalledWith(tag);
  });

  test('on("updating") and on("updated") fire around instance.update()', async () => {
    const before = jest.fn();
    const after  = jest.fn();
    class Item extends Model {
      static table = 'items';
      static timestamps = false;
      static fillable = ['name'];
      static boot() {
        Item.on('updating', before);
        Item.on('updated',  after);
      }
    }

    mockExecute.mockResolvedValue([[{ id: 1, name: 'Old' }]]);
    const item = await Item.find(1);
    mockExecute.mockReset();
    mockExecute.mockResolvedValue([{ affectedRows: 1 }]);

    await item.update({ name: 'New' });
    expect(before).toHaveBeenCalledWith(item);
    expect(after).toHaveBeenCalledWith(item);
  });

  test('on("updating") returning false cancels update', async () => {
    class Readonly extends Model {
      static table = 'readonly';
      static timestamps = false;
      static fillable = ['name'];
      static boot() {
        Readonly.on('updating', () => false);
      }
    }

    mockExecute.mockResolvedValue([[{ id: 1, name: 'Old' }]]);
    const inst = await Readonly.find(1);
    mockExecute.mockReset();

    await inst.update({ name: 'New' });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test('on("deleting") and on("deleted") fire around destroy()', async () => {
    const before = jest.fn();
    const after  = jest.fn();
    class Note extends Model {
      static table = 'notes';
      static timestamps = false;
      static fillable = ['body'];
      static boot() {
        Note.on('deleting', before);
        Note.on('deleted',  after);
      }
    }

    mockExecute.mockResolvedValue([[{ id: 1, body: 'hi' }]]);
    const note = await Note.find(1);
    mockExecute.mockReset();
    mockExecute.mockResolvedValue([{ affectedRows: 1 }]);

    await note.destroy();
    expect(before).toHaveBeenCalledWith(note);
    expect(after).toHaveBeenCalledWith(note);
  });

  test('boot() with snowflake-style id auto-generation', async () => {
    let counter = 0;
    const fakeSnowflake = () => `sf_${++counter}`;

    class Event extends Model {
      static table = 'events';
      static primaryKey = 'event_id';
      static timestamps = false;
      static fillable = ['event_id', 'type'];
      static boot() {
        Event.on('creating', (instance) => {
          instance.event_id = fakeSnowflake();
        });
      }
    }

    mockExecute
      .mockResolvedValueOnce([{ insertId: 0 }])
      .mockResolvedValueOnce([[{ event_id: 'sf_1', type: 'click' }]]);

    await Event.create({ type: 'click' });
    const [, params] = mockExecute.mock.calls[0];
    expect(params).toContain('sf_1');
  });
});

describe('Model.insertMany() + Model.upsert()', () => {
  beforeEach(() => {
    mockExecute.mockReset();
    Model._hooks = {};
  });

  class Product extends Model {
    static table = 'products';
    static timestamps = false;
    static fillable = ['name', 'price'];
  }

  class Item extends Model {
    static table = 'items';
    static timestamps = true;
    static fillable = ['sku', 'qty', 'updated_at', 'created_at'];
  }

  test('Model.insertMany() sends bulk INSERT', async () => {
    mockExecute.mockResolvedValue([{ affectedRows: 2 }]);
    const count = await Product.insertMany([
      { name: 'A', price: 10 },
      { name: 'B', price: 20 },
    ]);
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO `products`/i);
    expect(sql).toContain('VALUES');
    expect(params).toContain('A');
    expect(params).toContain('B');
    expect(count).toBe(2);
  });

  test('Model.insertMany() respects fillable', async () => {
    mockExecute.mockResolvedValue([{ affectedRows: 1 }]);
    await Product.insertMany([{ name: 'A', price: 10, secret: 'x' }]);
    const [, params] = mockExecute.mock.calls[0];
    expect(params).not.toContain('x');
  });

  test('Model.insertMany() auto-injects timestamps', async () => {
    mockExecute.mockResolvedValue([{ affectedRows: 1 }]);
    await Item.insertMany([{ sku: 'SKU1', qty: 5 }]);
    const [sql] = mockExecute.mock.calls[0];
    expect(sql).toContain('created_at');
    expect(sql).toContain('updated_at');
  });

  test('Model.upsert() generates ON DUPLICATE KEY UPDATE', async () => {
    mockExecute.mockResolvedValue([{ insertId: 1, affectedRows: 1 }]);
    const result = await Product.upsert({ name: 'A', price: 10 }, ['price']);
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(sql).toContain('`price` = VALUES(`price`)');
    expect(params).toContain('A');
    expect(result).toMatchObject({ insertId: 1 });
  });

  test('Model.upsert() auto-appends updated_at to updateKeys when timestamps=true', async () => {
    mockExecute.mockResolvedValue([{ insertId: 0, affectedRows: 2 }]);
    await Item.upsert({ sku: 'SKU1', qty: 5 }, ['qty']);
    const [sql] = mockExecute.mock.calls[0];
    expect(sql).toContain('`updated_at` = VALUES(`updated_at`)');
  });

  test('Model.upsert() with options object — explicit update list', async () => {
    mockExecute
      .mockResolvedValueOnce([{ insertId: 1, affectedRows: 1 }])
      .mockResolvedValueOnce([[{ id: 1, name: 'A', price: 10 }]]);
    const [instance, created] = await Product.upsert(
      { name: 'A', price: 10 },
      { conflictFields: ['name'], update: ['price'] }
    );
    const [sql] = mockExecute.mock.calls[0];
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(sql).toContain('`price` = VALUES(`price`)');
    expect(created).toBe(true);
    expect(instance).toBeTruthy();
  });

  test('Model.upsert() with options object — auto update (exclude conflictFields)', async () => {
    mockExecute
      .mockResolvedValueOnce([{ insertId: 0, affectedRows: 2 }])
      .mockResolvedValueOnce([[{ id: 1, name: 'A', price: 99 }]]);
    const [instance, created] = await Product.upsert(
      { name: 'A', price: 99 },
      { conflictFields: ['name'] }
    );
    const [sql] = mockExecute.mock.calls[0];
    expect(sql).toContain('`price` = VALUES(`price`)');
    expect(sql).not.toContain('`name` = VALUES(`name`)');
    expect(created).toBe(false);
  });
});

// ─── Collection ─────────────────────────────────────────────────────────────

const { Collection } = await import('../src/model.js');

describe('Collection', () => {
  const items = [
    { id: 1, role: 'admin', score: 10 },
    { id: 2, role: 'user',  score: 5  },
    { id: 3, role: 'admin', score: 20 },
  ];
  const col = new Collection(items);

  test('pluck() returns array of values', () => {
    expect(col.pluck('id')).toEqual([1, 2, 3]);
  });

  test('groupBy() groups correctly', () => {
    const grouped = col.groupBy('role');
    expect(grouped['admin'].length).toBe(2);
    expect(grouped['user'].length).toBe(1);
  });

  test('keyBy() maps by key', () => {
    const keyed = col.keyBy('id');
    expect(keyed[2].role).toBe('user');
  });

  test('first() returns first item', () => {
    expect(col.first().id).toBe(1);
  });

  test('last() returns last item', () => {
    expect(col.last().id).toBe(3);
  });

  test('sum() aggregates column', () => {
    expect(col.sum('score')).toBe(35);
  });

  test('count() returns length', () => {
    expect(col.count()).toBe(3);
  });

  test('filter() returns Collection', () => {
    const admins = col.filter((i) => i.role === 'admin');
    expect(admins.length).toBe(2);
  });

  test('chunk() splits into subarrays', () => {
    const chunks = col.chunk(2);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(2);
    expect(chunks[1].length).toBe(1);
  });

  test('unique() removes duplicates by key', () => {
    const unique = col.unique('role');
    expect(unique.length).toBe(2);
  });
});

// ─── Local Scopes ────────────────────────────────────────────────────────────

class ScopedUser extends Model {
  static table = 'users';
  static timestamps = false;
  static fillable = ['name', 'role'];
  static guarded = [];

  static scopeActive(q) { q.where('active', 1); }
  static scopeRole(q, role) { q.where('role', role); }
}

describe('Local Scopes', () => {
  test('.query().active() applies where clause', async () => {
    mockExecute.mockResolvedValue([[{ id: 1, name: 'Alice', active: 1 }]]);
    await ScopedUser.query().active().get();
    const [sql] = mockExecute.mock.calls[0];
    expect(sql).toContain('`active` = ?');
  });

  test('.query().role(\'admin\') passes arguments to scope', async () => {
    mockExecute.mockResolvedValue([[{ id: 1, name: 'Bob', role: 'admin' }]]);
    await ScopedUser.query().role('admin').get();
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('`role` = ?');
    expect(params).toContain('admin');
  });

  test('scopes are chainable', async () => {
    mockExecute.mockResolvedValue([[]]);
    await ScopedUser.query().active().role('admin').get();
    const [sql] = mockExecute.mock.calls[0];
    expect(sql).toContain('`active` = ?');
    expect(sql).toContain('`role` = ?');
  });
});

// ─── Accessors / appends ─────────────────────────────────────────────────────

class Person extends Model {
  static table = 'people';
  static timestamps = false;
  static fillable = [];
  static guarded = [];
  static appends = ['fullName'];

  get fullName() {
    return `${this.first_name} ${this.last_name}`;
  }
}

describe('Accessors / appends', () => {
  test('accessor is accessible on instance', () => {
    const row = { id: 1, first_name: 'John', last_name: 'Doe' };
    const instance = Person._hydrate(row);
    expect(instance.fullName).toBe('John Doe');
  });

  test('appended field is included in toJSON()', () => {
    const row = { id: 1, first_name: 'John', last_name: 'Doe' };
    const instance = Person._hydrate(row);
    const json = instance.toJSON();
    expect(json.fullName).toBe('John Doe');
  });
});

// ─── findBy ──────────────────────────────────────────────────────────────────

describe('Model.findBy()', () => {
  test('queries by given column', async () => {
    mockExecute.mockResolvedValue([[{ id: 1, name: 'Alice', email: 'a@x.com' }]]);
    const user = await User.findBy('email', 'a@x.com');
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('`email` = ?');
    expect(params).toContain('a@x.com');
    expect(user).toBeTruthy();
  });
});

// ─── Hidden fix: internal access should work, output should strip ───────────

class Secret extends Model {
  static table = 'secrets';
  static timestamps = false;
  static fillable = [];
  static guarded = [];
  static hidden = ['password', 'token'];
}

describe('Model hidden — internal access preserved, output stripped', () => {
  test('instance retains hidden fields internally', () => {
    const row = { id: 1, name: 'Alice', password: 'hash', token: 'abc' };
    const instance = Secret._hydrate(row);
    expect(instance.password).toBe('hash');
    expect(instance.token).toBe('abc');
  });

  test('toJSON() strips hidden fields from output', () => {
    const row = { id: 1, name: 'Alice', password: 'hash', token: 'abc' };
    const instance = Secret._hydrate(row);
    const json = instance.toJSON();
    expect(json.password).toBeUndefined();
    expect(json.token).toBeUndefined();
    expect(json.name).toBe('Alice');
  });

  test('hidden fields are non-enumerable — spread operator does not leak them', () => {
    const row = { id: 1, name: 'Alice', password: 'hash', token: 'abc' };
    const instance = Secret._hydrate(row);
    const spread = { ...instance };
    expect(spread.password).toBeUndefined();
    expect(spread.token).toBeUndefined();
    expect(spread.name).toBe('Alice');
  });

  test('hidden fields are non-enumerable — Object.entries does not leak them', () => {
    const row = { id: 1, name: 'Alice', password: 'hash', token: 'abc' };
    const instance = Secret._hydrate(row);
    const keys = Object.entries(instance).map(([k]) => k).filter(k => !k.startsWith('_'));
    expect(keys).not.toContain('password');
    expect(keys).not.toContain('token');
  });

  test('hidden fields still accessible internally via direct property access', () => {
    const row = { id: 1, name: 'Alice', password: 'hash', token: 'abc' };
    const instance = Secret._hydrate(row);
    expect(instance.password).toBe('hash');
    expect(instance.token).toBe('abc');
  });

  test('JSON.stringify does not leak hidden fields', () => {
    const row = { id: 1, name: 'Alice', password: 'hash', token: 'abc' };
    const instance = Secret._hydrate(row);
    const parsed = JSON.parse(JSON.stringify(instance));
    expect(parsed.password).toBeUndefined();
    expect(parsed.token).toBeUndefined();
    expect(parsed.name).toBe('Alice');
  });
});

// ─── Aliases ────────────────────────────────────────────────────────────────

class Token extends Model {
  static table = 'tokens';
  static timestamps = false;
  static fillable = [];
  static guarded = [];
  static aliases = { access_token: 'accessToken', refresh_token: 'refreshToken' };
}

describe('Model aliases', () => {
  test('instance has both DB key and alias key', () => {
    const row = { id: 1, access_token: 'aaa', refresh_token: 'bbb' };
    const instance = Token._hydrate(row);
    expect(instance.access_token).toBe('aaa');
    expect(instance.accessToken).toBe('aaa');
  });

  test('toJSON() outputs alias key, not DB column key', () => {
    const row = { id: 1, access_token: 'aaa', refresh_token: 'bbb' };
    const instance = Token._hydrate(row);
    const json = instance.toJSON();
    expect(json.accessToken).toBe('aaa');
    expect(json.refreshToken).toBe('bbb');
    expect(json.access_token).toBeUndefined();
    expect(json.refresh_token).toBeUndefined();
  });
});

// ─── snakeCase opt-in ────────────────────────────────────────────────────────

class Metric extends Model {
  static table = 'metrics';
  static timestamps = false;
  static fillable = [];
  static guarded = [];
  static snakeCase = true;
}

describe('Model snakeCase', () => {
  test('create() converts camelCase keys to snake_case', async () => {
    mockExecute
      .mockResolvedValueOnce([{ insertId: 5, affectedRows: 1 }])
      .mockResolvedValueOnce([[{ id: 5, max_tokens: 100, user_id: 1 }]]);
    await Metric.create({ maxTokens: 100, userId: 1 });
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('`max_tokens`');
    expect(sql).toContain('`user_id`');
    expect(params).toContain(100);
  });
});

// ─── upsertMany ─────────────────────────────────────────────────────────────

class Sync extends Model {
  static table = 'sync_items';
  static timestamps = false;
  static fillable = [];
  static guarded = [];
}

describe('Model.upsertMany()', () => {
  test('generates single batch INSERT ... ON DUPLICATE KEY UPDATE', async () => {
    mockExecute
      .mockResolvedValueOnce([{ affectedRows: 4 }])  // upsert
      .mockResolvedValueOnce([[              // fetch back
        { id: 1, provider: 'google', email: 'a@g.com', status: 'active' },
        { id: 2, provider: 'google', email: 'b@g.com', status: 'active' },
      ]]);
    await Sync.upsertMany(
      [
        { provider: 'google', email: 'a@g.com', status: 'active' },
        { provider: 'google', email: 'b@g.com', status: 'active' },
      ],
      ['status']
    );
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('INSERT INTO `sync_items`');
    expect(sql).toContain('VALUES (?, ?, ?), (?, ?, ?)');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(sql).toContain('`status` = VALUES(`status`)');
    expect(params).toHaveLength(6);
  });

  test('upsertMany with options object — auto exclude conflictFields', async () => {
    mockExecute
      .mockResolvedValueOnce([{ affectedRows: 2 }])
      .mockResolvedValueOnce([[{ id: 1, provider: 'google', email: 'a@g.com', status: 'active' }]]);
    await Sync.upsertMany(
      [{ provider: 'google', email: 'a@g.com', status: 'active' }],
      { conflictFields: ['provider', 'email'] }
    );
    const [sql] = mockExecute.mock.calls[0];
    expect(sql).toContain('`status` = VALUES(`status`)');
    expect(sql).not.toContain('`provider` = VALUES(`provider`)');
    expect(sql).not.toContain('`email` = VALUES(`email`)');
  });

  test('upsertMany returns { inserted, updated, rows } with hydrated instances', async () => {
    mockExecute
      // 2 rows: affectedRows=3 → 1 INSERT (1) + 1 UPDATE (2) = 3
      .mockResolvedValueOnce([{ affectedRows: 3 }])
      .mockResolvedValueOnce([[  // fetch back by tuple IN
        { id: 1, provider: 'google', email: 'a@g.com', status: 'active' },
        { id: 2, provider: 'google', email: 'b@g.com', status: 'active' },
      ]]);
    const result = await Sync.upsertMany(
      [
        { provider: 'google', email: 'a@g.com', status: 'active' },
        { provider: 'google', email: 'b@g.com', status: 'active' },
      ],
      { conflictFields: ['provider', 'email'] }
    );
    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].email).toBe('a@g.com');
    // fetch query uses tuple IN
    const [fetchSql] = mockExecute.mock.calls[1];
    expect(fetchSql).toContain('(`provider`, `email`) IN');
  });
});

// ─── Global Scopes ───────────────────────────────────────────────────────────

class TenantUser extends Model {
  static table = 'users';
  static timestamps = false;
  static fillable = [];
  static guarded = [];
}

describe('Global Scopes', () => {
  beforeEach(() => {
    TenantUser.removeGlobalScope('tenant');
    mockExecute.mockClear();
  });

  test('addGlobalScope applies WHERE to every query', async () => {
    TenantUser.addGlobalScope('tenant', (q) => q.where('tenant_id', 42));
    mockExecute.mockResolvedValue([[{ id: 1, name: 'Alice', tenant_id: 42 }]]);
    await TenantUser.where('active', 1).get();
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('`tenant_id` = ?');
    expect(params).toContain(42);
  });

  test('withoutGlobalScope skips the named scope', async () => {
    TenantUser.addGlobalScope('tenant', (q) => q.where('tenant_id', 42));
    mockExecute.mockResolvedValue([[]]);
    await TenantUser.withoutGlobalScope('tenant').get();
    const [sql] = mockExecute.mock.calls[0];
    expect(sql).not.toContain('tenant_id');
  });

  test('removeGlobalScope permanently removes it', async () => {
    TenantUser.addGlobalScope('tenant', (q) => q.where('tenant_id', 42));
    TenantUser.removeGlobalScope('tenant');
    mockExecute.mockResolvedValue([[]]);
    await TenantUser.all();
    const [sql] = mockExecute.mock.calls[0];
    expect(sql).not.toContain('tenant_id');
  });
});

// ─── Observer system ─────────────────────────────────────────────────────────

class ObservedModel extends Model {
  static table = 'observed';
  static timestamps = false;
  static fillable = ['name'];
  static guarded = [];
}

describe('Observer system', () => {
  beforeEach(() => {
    Model._hooks = {};
  });

  test('observe() registers lifecycle hooks from a class', async () => {
    const calls = [];
    class MyObserver {
      created(inst) { calls.push(['created', inst.name]); }
      deleting(inst) { calls.push(['deleting', inst.name]); }
    }
    ObservedModel.observe(new MyObserver());

    mockExecute
      .mockResolvedValueOnce([{ insertId: 1, affectedRows: 1 }])  // insert
      .mockResolvedValueOnce([[{ id: 1, name: 'Test' }]]);          // find after create

    await ObservedModel.create({ name: 'Test' });
    expect(calls[0]).toEqual(['created', 'Test']);
  });

  test('observe() accepts a class constructor', () => {
    const calls = [];
    class MyObserver {
      creating(inst) { calls.push('creating'); }
    }
    ObservedModel.observe(MyObserver);
    const key = 'ObservedModel:creating';
    expect(Model._hooks[key]).toBeDefined();
    expect(Model._hooks[key].length).toBe(1);
  });

  test('observer returning false cancels operation', async () => {
    class BlockObserver {
      deleting() { return false; }
    }
    ObservedModel.observe(new BlockObserver());

    const instance = ObservedModel._hydrate({ id: 1, name: 'Test' });
    instance._exists = true;
    const result = await instance.destroy();
    expect(result).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

// ─── Eager Loading with() ────────────────────────────────────────────────────

class EagerPost extends Model {
  static table = 'posts';
  static timestamps = false;
  static fillable = [];
  static guarded = [];

  author() { return this.belongsTo(EagerUser, 'user_id'); }
  comments() { return this.hasMany(EagerComment, 'post_id'); }
}

class EagerComment extends Model {
  static table = 'comments';
  static timestamps = false;
  static fillable = [];
  static guarded = [];
}

class EagerUser extends Model {
  static table = 'users';
  static timestamps = false;
  static fillable = [];
  static guarded = [];

  posts()   { return this.hasMany(EagerPost, 'user_id'); }
  profile() { return this.hasOne(EagerProfile, 'user_id'); }
}

class EagerProfile extends Model {
  static table = 'profiles';
  static timestamps = false;
  static fillable = [];
  static guarded = [];
}

describe('Eager Loading with()', () => {
  test('hasMany: attaches relation collection to each parent', async () => {
    // First query: SELECT * FROM users (1 user)
    // Second query: SELECT * FROM posts WHERE user_id IN (1)
    mockExecute
      .mockResolvedValueOnce([[{ id: 1, name: 'Alice' }]])
      .mockResolvedValueOnce([[
        { id: 10, title: 'Post A', user_id: 1 },
        { id: 11, title: 'Post B', user_id: 1 },
      ]]);

    const users = await EagerUser.with('posts').get();
    expect(users[0].posts).toBeDefined();
    expect(users[0].posts.length).toBe(2);
    expect(users[0].posts[0].title).toBe('Post A');

    // Second call must use WHERE IN
    const [sql, params] = mockExecute.mock.calls[1];
    expect(sql).toContain('WHERE `user_id` IN');
    expect(params).toContain(1);
  });

  test('hasOne: attaches single related instance', async () => {
    mockExecute
      .mockResolvedValueOnce([[{ id: 1, name: 'Alice' }]])
      .mockResolvedValueOnce([[{ id: 5, bio: 'Dev', user_id: 1 }]]);

    const users = await EagerUser.with('profile').get();
    expect(users[0].profile).toBeDefined();
    expect(users[0].profile.bio).toBe('Dev');
  });

  test('belongsTo: attaches parent to each related', async () => {
    mockExecute
      .mockResolvedValueOnce([[{ id: 10, title: 'Post A', user_id: 1 }]])
      .mockResolvedValueOnce([[{ id: 1, name: 'Alice' }]]);

    const posts = await EagerPost.with('author').get();
    expect(posts[0].author).toBeDefined();
    expect(posts[0].author.name).toBe('Alice');
  });

  test('constrained with(): applies extra where to relation query', async () => {
    mockExecute
      .mockResolvedValueOnce([[{ id: 1, name: 'Alice' }]])
      .mockResolvedValueOnce([[{ id: 10, title: 'Post A', user_id: 1, published: 1 }]]);

    await EagerUser.with({ posts: (q) => q.where('published', 1) }).get();

    const [sql] = mockExecute.mock.calls[1];
    expect(sql).toContain('`published` = ?');
  });

  test('multiple relations loaded in one call', async () => {
    mockExecute
      .mockResolvedValueOnce([[{ id: 1, name: 'Alice' }]])
      .mockResolvedValueOnce([[{ id: 10, title: 'Post A', user_id: 1 }]])
      .mockResolvedValueOnce([[{ id: 5, bio: 'Dev', user_id: 1 }]]);

    const users = await EagerUser.with('posts', 'profile').get();
    expect(users[0].posts.length).toBe(1);
    expect(users[0].profile.bio).toBe('Dev');
  });

  test('instance.load() lazy-loads a relation', async () => {
    mockExecute
      .mockResolvedValueOnce([[{ id: 10, title: 'Post A', user_id: 1 }, { id: 11, title: 'Post B', user_id: 1 }]]);

    const user = EagerUser._hydrate({ id: 1, name: 'Alice' });
    await user.load('posts');

    expect(user.posts).toBeDefined();
    expect(user.posts.length).toBe(2);
  });

  test('hasMany: empty parents get empty Collection', async () => {
    mockExecute
      .mockResolvedValueOnce([[{ id: 2, name: 'Bob' }]])
      .mockResolvedValueOnce([[]]);  // no posts for user 2

    const users = await EagerUser.with('posts').get();
    expect(users[0].posts.length).toBe(0);
  });
});
