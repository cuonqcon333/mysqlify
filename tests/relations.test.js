import { jest } from '@jest/globals';

const executeMock = jest.fn();

await jest.unstable_mockModule('../src/connection.js', () => ({
  execute: (...args) => executeMock(...args),
  getConfig: () => ({ sanitize: false, maxConditions: 20, auditLog: false }),
  connect: jest.fn(),
  disconnect: jest.fn(),
  transaction: jest.fn(),
  listen: jest.fn(),
  clearListeners: jest.fn(),
  getPool: () => ({
    getConnection: async () => ({
      beginTransaction: jest.fn(),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
      execute: (...args) => executeMock(...args)
    })
  })
}));

const { Model } = await import('../src/model.js');

class User extends Model {
  static table = 'users';
  static timestamps = false;
  posts() { return this.hasMany(Post, 'user_id'); }
  profile() { return this.hasOne(Profile, 'user_id'); }
  roles() { return this.belongsToMany(Role, 'user_roles', 'user_id', 'role_id'); }
}

class Post extends Model {
  static table = 'posts';
  static timestamps = false;
  static softDelete = true;
  author() { return this.belongsTo(User, 'user_id'); }
  comments() { return this.hasMany(Comment, 'post_id'); }
}

class Profile extends Model {
  static table = 'profiles';
  static timestamps = false;
}

class Role extends Model {
  static table = 'roles';
  static timestamps = false;
}

class Comment extends Model {
  static table = 'comments';
  static timestamps = false;
}

beforeEach(() => {
  jest.clearAllMocks();
  executeMock.mockResolvedValue([[]]); // default to empty
});

describe('Relations & Eager Loading', () => {
  test('hasMany respects owner connection (transactions)', async () => {
    // If a model is instantiated from a transaction, its lazy relation should use the same connection
    const trxExecuteMock = jest.fn().mockResolvedValue([[{ id: 10, user_id: 1 }]]);
    const trx = { _conn: { execute: trxExecuteMock } };
    const userProxy = User._withConnection(trx._conn);
    // Since proxy is not a class we can "new", we hydrate one instead
    const user = userProxy._hydrate({ id: 1 });
    
    await user.posts().get();
    
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock).toHaveBeenCalledWith(expect.any(String), expect.any(Array), trx._conn);
  });

  test('eager loading basic hasMany', async () => {
    // 2 users, expect 1 query for users, 1 query for posts
    executeMock
      .mockResolvedValueOnce([[{ id: 1 }, { id: 2 }]]) // User.with('posts').get()
      .mockResolvedValueOnce([[{ id: 10, user_id: 1 }, { id: 20, user_id: 2 }]]); // eager load posts

    const users = await User.with('posts').get();
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(users).toHaveLength(2);
    expect(users[0].posts).toBeDefined();
    expect(users[0].posts[0].id).toBe(10);
    expect(users[1].posts[0].id).toBe(20);
  });

  test('eager loading applies soft deletes on related model automatically', async () => {
    executeMock
      .mockResolvedValueOnce([[{ id: 1 }]])
      .mockResolvedValueOnce([[]]);
    
    await User.with('posts').get();
    
    // Second query should have `deleted_at IS NULL`
    const postQuery = executeMock.mock.calls[1][0];
    expect(postQuery).toContain('`deleted_at` IS NULL');
  });

  test('eager loading nested relations (posts.comments)', async () => {
    executeMock
      .mockResolvedValueOnce([[{ id: 1 }]]) // User
      .mockResolvedValueOnce([[{ id: 10, user_id: 1 }]]) // Posts
      .mockResolvedValueOnce([[{ id: 100, post_id: 10 }]]); // Comments
      
    const users = await User.with('posts.comments').get();
    expect(executeMock).toHaveBeenCalledTimes(3);
    
    expect(users[0].posts[0].comments[0].id).toBe(100);
  });

  test('belongsToMany executes correctly', async () => {
    executeMock.mockResolvedValueOnce([[{ id: 99, __pivot_fk: 1 }]]); // Roles mapped with __pivot_fk
    
    const user = new User({ id: 1 });
    // Eager load mock
    executeMock.mockReset();
    executeMock
      .mockResolvedValueOnce([[{ id: 1 }]])
      .mockResolvedValueOnce([[{ id: 99, __pivot_fk: 1 }]]);
      
    const users = await User.with('roles').get();
    expect(users[0].roles[0].id).toBe(99);
  });

  describe('Constructor Binding Invariants (Transactions)', () => {
    test('hydrated proxy instance instanceof BaseModelClass', () => {
      const trx = { _conn: {} };
      const userProxy = User._withConnection(trx._conn);
      const user = userProxy._hydrate({ id: 1, name: 'Alice' });

      expect(user instanceof User).toBe(true);
      expect(user.constructor.name).toBe('User');
    });

    test('serialization toJSON() works correctly without exposing connection', () => {
      const trx = { _conn: {} };
      const userProxy = User._withConnection(trx._conn);
      const user = userProxy._hydrate({ id: 1, name: 'Alice' });

      const json = JSON.stringify(user.toJSON ? user.toJSON() : user);
      expect(json).toContain('"name":"Alice"');
      expect(json).not.toContain('_conn');
      expect(json).not.toContain('constructor');
    });

    test('transaction nested eager load propagates constructor proxy (belongsTo, hasOne)', async () => {
      const trx = { _conn: {} };
      const userProxy = User._withConnection(trx._conn);
      
      executeMock
        .mockResolvedValueOnce([[{ id: 10, user_id: 1 }]]) // posts
        .mockResolvedValueOnce([[{ id: 1 }]]) // author (belongsTo)
        .mockResolvedValueOnce([[{ id: 99, user_id: 1 }]]); // profile (hasOne)

      const user = userProxy._hydrate({ id: 1 });
      const lazyPosts = await user.posts().get();
      
      const post = lazyPosts[0];
      expect(post._conn).toBeUndefined(); // instance doesn't have it
      expect(post.constructor._conn).toBe(trx._conn); // proxy does

      // eager load on proxy instance
      const postsProxy = Post._withConnection(trx._conn);
      executeMock.mockReset();
      executeMock
        .mockResolvedValueOnce([[{ id: 10, user_id: 1 }]])
        .mockResolvedValueOnce([[{ id: 1 }]]);

      const posts = await postsProxy.with('author').get();
      expect(executeMock).toHaveBeenCalledWith(expect.any(String), expect.any(Array), trx._conn);
      expect(posts[0].author?.id).toBe(1);
    });
  });

  describe('Lazy Eager Loading via load()', () => {
    test('load("posts") basic path', async () => {
      executeMock.mockResolvedValueOnce([[{ id: 10, user_id: 1 }]]);

      const user = User._hydrate({ id: 1 });
      await user.load('posts');

      expect(executeMock).toHaveBeenCalledTimes(1);
      expect(user.posts).toBeDefined();
      expect(user.posts[0].id).toBe(10);
    });

    test('load("posts.comments") nested path', async () => {
      executeMock
        .mockResolvedValueOnce([[{ id: 10, user_id: 1 }]]) // posts
        .mockResolvedValueOnce([[{ id: 100, post_id: 10 }]]); // comments

      const user = User._hydrate({ id: 1 });
      await user.load('posts.comments');

      expect(executeMock).toHaveBeenCalledTimes(2);
      expect(user.posts[0].comments).toBeDefined();
      expect(user.posts[0].comments[0].id).toBe(100);
    });

    test('load() inside transaction propagates connection', async () => {
      const trx = { _conn: {} };
      const userProxy = User._withConnection(trx._conn);
      
      executeMock
        .mockResolvedValueOnce([[{ id: 10, user_id: 1 }]]) // posts
        .mockResolvedValueOnce([[{ id: 1 }]]); // author (belongsTo)

      const user = userProxy._hydrate({ id: 1 });
      await user.load('posts');

      expect(executeMock).toHaveBeenCalledWith(expect.any(String), expect.any(Array), trx._conn);
      
      // Chained lazy eager load
      const post = user.posts[0];
      executeMock.mockClear();
      await post.load('author');
      
      expect(executeMock).toHaveBeenCalledWith(expect.any(String), expect.any(Array), trx._conn);
      expect(post.author.id).toBe(1);
    });

    test('load() applies soft deletes / global scopes automatically', async () => {
      executeMock.mockResolvedValueOnce([[]]);

      const user = User._hydrate({ id: 1 });
      await user.load('posts');

      // The query executed for posts should have the soft-delete check
      const postQuery = executeMock.mock.calls[0][0];
      expect(postQuery).toContain('`deleted_at` IS NULL');
    });

    test('load() with constrained lazy eager load is supported', async () => {
      const user = User._hydrate({ id: 1 });
      // Verify constrained lazy eager loading works out of the box
      executeMock.mockResolvedValueOnce([[{ id: 10, user_id: 1 }]]);
      
      await user.load({
        posts: (q) => q.where('active', 1)
      });
      
      expect(executeMock).toHaveBeenCalledTimes(1);
      const query = executeMock.mock.calls[0][0];
      expect(query).toContain('`active` = ?');
    });
  });
});
