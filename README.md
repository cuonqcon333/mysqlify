# mysqlify

Fluent MySQL/MariaDB query builder for Node.js - async/await first, Eloquent-style Models, transactions, lifecycle hooks, migrations, and security built-in.

[![npm](https://img.shields.io/npm/v/@caplab/mysqlify)](https://www.npmjs.com/package/@caplab/mysqlify)
[![license](https://img.shields.io/npm/l/@caplab/mysqlify)](https://github.com/cuonqcon333/mysqlify/blob/main/LICENSE)

> **GitHub:** https://github.com/cuonqcon333/mysqlify

## Features

- **Fluent Query Builder** - chainable API, `await` friendly
- **Eloquent-style Models** - `fillable`, `hidden`, `casts`, `timestamps`, `softDelete`
- **Lifecycle Hooks** - `boot()`, `creating/created`, `updating/updated`, `deleting/deleted`, `restoring/restored`
- **Transactions** - `DB.transaction()` with auto-commit/rollback, Models participate too
- **Dirty tracking** - `isDirty()`, `getDirty()`, `save()` only sends changed fields
- **Batch operations** - `insertMany()`, `createMany()`, `upsert()`
- **Helpers** - `firstOrCreate()`, `updateOrCreate()`, `findOrFail()`, `findMany()`
- **Migrations** - Laravel-style `up/down`, CLI runner
- **Security built-in** - SQL injection prevention, XSS sanitization, mass assignment protection
- **Dual CJS + ESM** - works with both `require()` and `import`
- **Zero extra runtime deps** - only `mysql2`

---

## Installation

```bash
npm install @caplab/mysqlify
```

---

## Quick Start

### Connect

```js
// ESM
import { connect } from '@caplab/mysqlify';

// CJS
const { connect } = require('@caplab/mysqlify');

connect({
  host: 'localhost',
  user: 'root',
  password: 'secret',
  database: 'myapp',
});
```

Or use environment variables - `DB_HOST`, `DB_USER`, `DB_PASS`, `DB_NAME`, `DB_PORT`.

---

## Query Builder

```js
import { DB } from '@caplab/mysqlify';

// Fetch all
const users = await DB.table('users').get();

// With conditions
const admins = await DB.table('users')
  .where('role', 'admin')
  .where('active', 1)
  .orderBy('name')
  .get();

// First row
const user = await DB.table('users').where('id', 1).first();

// Insert
const insertId = await DB.table('users').insert({ name: 'John', email: 'j@x.com' });

// Batch insert (single query)
await DB.table('tags').insertMany([
  { name: 'nodejs' },
  { name: 'mysql' },
]);

// Upsert - INSERT ... ON DUPLICATE KEY UPDATE
await DB.table('tokens').upsert(
  { acct_id: 'abc', access_token: 'tok1', refresh_token: 'ref1' },
  ['access_token', 'refresh_token']   // columns to update on conflict
);

// Update
const affected = await DB.table('users').where('id', 1).update({ name: 'Jane' });

// Atomic increment / decrement
await DB.table('wallets').where('user_id', 1).increment('balance', 50);
await DB.table('wallets').where('user_id', 1).decrement('balance', 20);

// Delete
await DB.table('users').where('id', 1).delete();

// Aggregates
const count = await DB.table('users').count();
const total = await DB.table('orders').where('user_id', 1).sum('amount');
const avg   = await DB.table('products').avg('price');
const max   = await DB.table('products').max('price');
const min   = await DB.table('products').min('price');

// Pagination
const result = await DB.table('posts').orderBy('created_at', 'DESC').paginate(1, 15);
// { data: [...], total: 100, page: 1, perPage: 15, lastPage: 7 }

// Raw query (always use bindings - never string concat)
const rows = await DB.raw('SELECT * FROM users WHERE id = ?', [1]);

// Debug - get SQL without executing
const { sql, params } = DB.table('users').where('active', 1).toSQL();
```

### WHERE methods

```js
.where('col', value)
.where('col', '>=', value)
.orWhere('col', value)
.whereIn('col', [1, 2, 3])
.whereNotIn('col', [1, 2])
.whereNull('col')
.whereNotNull('col')
.whereBetween('col', [10, 100])
.whereRaw('YEAR(created_at) = ?', [2026])   // raw expression
```

### SELECT / ORDER / GROUP

```js
.select('id', 'name', 'email')
.selectRaw('COUNT(*) as total, SUM(amount) as revenue')
.orderBy('created_at', 'DESC')
.groupBy('status')
.having('total', '>', 100)
.limit(10)
.offset(20)
```

### Joins

```js
DB.table('posts')
  .join('users', 'posts.user_id', 'users.id')
  .leftJoin('categories', 'posts.category_id', 'categories.id')
  .select('posts.*', 'users.name')
  .get();
```

---

## Transactions

`DB.transaction()` auto-commits on success and auto-rollbacks on any error. The connection is always released back to the pool.

```js
import { DB } from '@caplab/mysqlify';

await DB.transaction(async (trx) => {
  // trx.table() - QueryBuilder on the same connection
  const orderId = await trx.table('orders').insert({ user_id: 1, total: 150 });
  await trx.table('order_items').insert({ order_id: orderId, product_id: 5, qty: 2 });
  await trx.table('wallets').where('user_id', 1).decrement('balance', 150);

  // trx.raw() for raw SQL
  await trx.raw('UPDATE inventory SET qty = qty - 1 WHERE product_id = ?', [5]);

  // Any throw → entire transaction is rolled back automatically
});
```

### Models in transactions

```js
await DB.transaction(async (trx) => {
  const TrxAccount = trx.model(Account);   // Account model bound to this connection
  const TrxOrder   = trx.model(Order);

  const account = await TrxAccount.where('user_id', userId).first();
  await account.update({ access_token: newToken });

  await TrxOrder.create({ user_id: userId, total: 99 });
});
```

---

## Models

```js
import { Model } from '@caplab/mysqlify';

export class User extends Model {
  static table      = 'users';
  static primaryKey = 'id';
  static timestamps = true;           // auto created_at / updated_at
  static softDelete = false;
  static fillable   = ['name', 'email', 'password'];
  static hidden     = ['password'];   // excluded from toJSON() / res.json()
  static casts      = {
    is_admin:   'boolean',            // 1/0 → true/false
    score:      'float',              // '9.5' → 9.5
    settings:   'json',               // '{"k":"v"}' → { k: 'v' }
    tags:       'array',              // '["a","b"]' → ['a', 'b']
    joined_at:  'date',               // → 'YYYY-MM-DD'
  };
}
```

### Static API

```js
// Basic
const users  = await User.all();
const user   = await User.find(1);
const user   = await User.findOrFail(1);          // throws if not found
const users  = await User.findMany([1, 2, 3]);    // batch fetch by ids
const first  = await User.where('active', 1).first();
const count  = await User.where('role', 'admin').count();
const page   = await User.paginate(1, 20);

// Create
const user = await User.create({ name: 'John', email: 'j@x.com' });
await User.createMany([
  { name: 'Alice', email: 'a@x.com' },
  { name: 'Bob',   email: 'b@x.com' },
]);

// Find or create / update or create
const user = await User.firstOrCreate(
  { email: 'j@x.com' },        // search conditions
  { name: 'John' }              // extra fields if creating
);

const account = await Account.updateOrCreate(
  { acct_id: subId, user_id: 1 },          // search conditions
  { access_token: tok, extra: tokenData }   // fields to set
);

// Bulk update / delete
await User.where('active', 0).update({ role: 'guest' });
await User.where('role', 'guest').delete();
```

### Instance API

```js
const user = await User.find(1);

// Direct assignment then save (only dirty fields are sent to DB)
user.name = 'Updated';
user.email = 'new@x.com';
await user.save();

// Explicit update with data object
await user.update({ name: 'Updated', email: 'new@x.com' });

// fill() + save() chain
await user.fill({ name: 'Updated' }).save();

// Reload from DB
await user.fresh();

// Delete
await user.delete();   // or user.destroy()

// Serialization
user.toJSON();    // plain object, hidden fields removed, JSON strings auto-parsed
user.toArray();   // alias for toJSON()
```

### Dirty tracking

```js
const user = await User.find(1);
// { name: 'Alice', email: 'a@x.com' }

user.name = 'Bob';

user.isDirty()          // true
user.isDirty('name')    // true
user.isDirty('email')   // false
user.isClean('email')   // true
user.getDirty()         // { name: 'Bob' }

await user.save();      // UPDATE `users` SET `name` = ? WHERE `id` = ?
                        // Only changed fields - email is NOT sent
```

### Attribute Casting

Values are automatically converted when loading from the database:

```js
static casts = {
  quantity:     'integer',    // '3' → 3
  price:        'float',      // '9.99' → 9.99
  is_active:    'boolean',    // 1 → true, 0 → false
  metadata:     'json',       // '{"k":"v"}' → { k: 'v' }
  tags:         'array',      // '["a","b"]' → ['a', 'b']
  published_at: 'date',       // → 'YYYY-MM-DD'
  created_at:   'datetime',   // → 'YYYY-MM-DD HH:MM:SS'
};
```

> JSON/array columns are also **auto-serialized** on insert/update - no need to `JSON.stringify()` manually.

> `toJSON()` / `res.json()` auto-parses any string that looks like a JSON object or array - even without `casts`.

### Soft Deletes

```js
class Post extends Model {
  static softDelete = true;
}

await Post.where('id', 1).delete();       // sets deleted_at = NOW()
await Post.withTrashed().get();           // includes soft-deleted
await Post.onlyTrashed().get();           // only soft-deleted
await Post.where('id', 1).restore();      // clears deleted_at
```

### Model Boot & Lifecycle Hooks

`boot()` runs **once** the first time a Model class is used. Define it to register hooks and configure model-level behavior - auto-generating IDs, setting default values, enforcing invariants, sending notifications, or anything else that should happen automatically around database operations.

```js
import { Model } from '@caplab/mysqlify';
import { snowflake } from './lib/snowflake.js';

class Event extends Model {
  static table    = 'events';
  static fillable = ['event_id', 'type', 'payload'];

  static boot() {
    // Auto-generate a Snowflake ID before every INSERT
    Event.on('creating', (instance) => {
      instance.event_id = snowflake.generate();
    });

    // Write an audit trail after every DELETE
    Event.on('deleted', async (instance) => {
      await AuditLog.create({ action: 'deleted', model: 'Event', ref: instance.event_id });
    });
  }
}
```

#### All available hooks

| Hook | Fires | Returning `false` |
|---|---|---|
| `creating` | before INSERT | cancels insert, returns `null` |
| `created` | after INSERT succeeds | - |
| `updating` | before UPDATE | cancels update |
| `updated` | after UPDATE succeeds | - |
| `deleting` | before DELETE | cancels delete |
| `deleted` | after DELETE succeeds | - |
| `restoring` | before soft-delete restore | cancels restore |
| `restored` | after restore succeeds | - |

#### More use-cases

```js
class Post extends Model {
  static fillable = ['title', 'slug', 'body'];

  static boot() {
    // Auto-slug from title
    Post.on('creating', (instance) => {
      if (!instance.slug) {
        instance.slug = instance.title.toLowerCase().replace(/\s+/g, '-');
      }
    });

    // Prevent editing published posts
    Post.on('updating', (instance) => {
      if (instance.status === 'published') return false;
    });
  }
}
```

#### Register hooks outside the class

`Model.on()` is also available at runtime, useful for plugins or tests:

```js
User.on('created', async (user) => {
  await mailer.sendWelcome(user.email);
});
```

---

### Relationships

```js
class User extends Model {
  static getPosts   = Model.hasMany(Post, 'user_id');
  static getProfile = Model.hasOne(Profile, 'user_id');
}

class Post extends Model {
  static getAuthor = Model.belongsTo(User, 'user_id');
}

class User extends Model {
  static getRoles = Model.belongsToMany(Role, 'user_roles', 'user_id', 'role_id');
}

const user  = await User.find(1);
const posts = await User.getPosts(user);    // Post[]
const roles = await User.getRoles(user);    // Role[]
```

---

## CLI

### Quick start — `init`

Run once in your project root to generate a config file:

```bash
npx mysqlify init
```

This creates `mysqlify.config.cjs`:

```js
// mysqlify.config.cjs
module.exports = {
  // Database connection
  host:     process.env.DB_HOST || 'localhost',
  port:     Number(process.env.DB_PORT) || 3306,
  user:     process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || '',

  // Directory paths — change to wherever you want files generated
  migrationsDir: 'migrations',   // e.g. 'src/database/migrations'
  modelsDir:     'models',       // e.g. 'src/models'

  // Optional
  // pool: { connectionLimit: 10 },
  // sanitize: false,
  // auditLog: false,
};
```

After that, all CLI commands read directories and DB config from this file automatically — no flags needed.

### Directory resolution order

| Priority | Source |
|---|---|
| 1 | `--migrations-dir=<path>` / `--models-dir=<path>` flag |
| 2 | `migrationsDir` / `modelsDir` in `mysqlify.config.cjs` |
| 3 | Default `migrations/` and `models/` |

### All commands

```bash
npx mysqlify init                                          # create mysqlify.config.cjs
npx mysqlify make:migration <name>                         # create migration file
npx mysqlify make:model <Name>                             # create model file
npx mysqlify make:model <Name> --migration                 # create model + migration
npx mysqlify migrate:up                                    # run all pending migrations
npx mysqlify migrate:rollback                              # rollback last batch
npx mysqlify migrate:status                                # show migration status

# Override directory per-command
npx mysqlify make:migration create_users_table --migrations-dir=src/db/migrations
npx mysqlify migrate:up --migrations-dir=src/db/migrations
```

---

## Migrations

### Create migration

```bash
npx mysqlify make:migration create_users_table
```

```js
// migrations/2026_05_12_120000_create_users_table.js
export async function up(schema) {
  await schema.create('users', (table) => {
    table.id();
    table.string('name', 100).notNullable();
    table.string('email').notNullable().unique();
    table.string('password');
    table.boolean('active').default(true);
    table.json('settings');               // nullable by default
    table.timestamps();
  });
}

export async function down(schema) {
  await schema.drop('users');
}
```

### Composite UNIQUE + Foreign Key

```js
export async function up(schema) {
  await schema.create('accounts', (table) => {
    table.id();
    table.bigInteger('user_id').unsigned().notNullable();
    table.string('provider', 50).notNullable();
    table.string('provider_account_id').notNullable();
    table.text('access_token');
    table.timestamps();

    // Composite UNIQUE across two columns
    table.unique(['provider', 'provider_account_id']);

    // Foreign key with cascade
    table.foreign('user_id')
      .references('id')
      .on('users')
      .onDelete('CASCADE')
      .onUpdate('CASCADE');
  });
}
```

### Schema column types

| Method | MySQL type |
|--------|----------|
| `table.id()` | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY` |
| `table.string('col', 255)` | `VARCHAR(255)` |
| `table.text('col')` | `TEXT` |
| `table.longText('col')` | `LONGTEXT` |
| `table.integer('col')` | `INT(11)` |
| `table.bigInteger('col')` | `BIGINT(20)` |
| `table.tinyInteger('col')` | `TINYINT(4)` |
| `table.boolean('col')` | `TINYINT(1)` |
| `table.decimal('col', 8, 2)` | `DECIMAL(8,2)` |
| `table.float('col')` | `FLOAT` |
| `table.double('col')` | `DOUBLE` |
| `table.date('col')` | `DATE` |
| `table.datetime('col')` | `DATETIME` |
| `table.timestamp('col')` | `TIMESTAMP` |
| `table.timestamps()` | `created_at DATETIME NULL, updated_at DATETIME NULL` |
| `table.softDeletes()` | `deleted_at DATETIME NULL` |
| `table.json('col')` | `JSON` |
| `table.enum('col', ['a','b'])` | `ENUM('a','b')` |

Column modifiers: `.nullable()`, `.notNullable()`, `.default(val)`, `.unsigned()`, `.unique()`, `.index()`, `.references('id', 'users')`, `.comment('text')`

> All columns are **nullable by default**. `.unsigned()` only applies to numeric types — it is silently ignored on `string`, `text`, etc.

### Table-level constraints

```js
table.unique(['col_a', 'col_b']);          // composite UNIQUE
table.index(['col_a', 'col_b']);           // composite INDEX
table.foreign('col').references('id').on('other_table').onDelete('CASCADE');
```

### Run migrations

```bash
npx mysqlify migrate:up         # run all pending
npx mysqlify migrate:rollback   # rollback last batch
npx mysqlify migrate:status     # show migration table
```

### Create model + migration together

```bash
npx mysqlify make:model Post --migration
```

---

## Security

Security is **enforced automatically** - not optional.

| Threat | Protection |
|--------|-----------|
| **SQL Injection** | All values use parameterized queries (`?`), never string concat |
| **Identifier injection** | Table/column names validated against `[a-zA-Z0-9_]` |
| **XSS** | `.sanitize(true)` HTML-escapes string output |
| **Mass assignment** | `fillable` whitelist / `guarded` blacklist |
| **Data leakage** | `hidden` removes sensitive fields from `toJSON()` |
| **Query abuse** | `maxConditions` limit (default 20) on `.where()` chains |
| **Pool exhaustion** | `acquireTimeout` throws instead of hanging forever |

```js
// Global sanitize
connect({ sanitize: true });

// Per-query
await DB.table('posts').sanitize(true).get();

// Mass assignment protection
await DB.table('users')
  .fillable(['name', 'email'])
  .insert(req.body);  // only name + email pass through

// Audit logging
connect({
  auditLog: true,
  logger: (msg) => myLogger.info(msg),
});
```

---

## Config

### Option 1 — `mysqlify.config.cjs` (recommended)

Generate with `npx mysqlify init`, then edit:

```js
module.exports = {
  host:     process.env.DB_HOST || 'localhost',
  port:     Number(process.env.DB_PORT) || 3306,
  user:     process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || '',

  migrationsDir: 'src/database/migrations',
  modelsDir:     'src/models',

  pool: { connectionLimit: 10 },
  sanitize: false,
  auditLog: false,
  logger: null,
};
```

### Option 2 — `connect()` in code

```js
import { connect } from '@caplab/mysqlify';

connect({
  host: 'localhost',
  port: 3306,
  user: 'root',
  password: 'secret',
  database: 'myapp',
  pool: {
    connectionLimit: 10,
    acquireTimeout: 10000,
  },
  sanitize: false,
  maxConditions: 20,
  auditLog: false,
  logger: null,         // (msg: string) => void
});
```

### Option 3 — Environment variables

```env
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASS=secret
DB_NAME=myapp
```

---

## CJS vs ESM

```js
// CommonJS
const { DB, Model, connect, transaction } = require('@caplab/mysqlify');

// ES Modules
import { DB, Model, connect, transaction } from '@caplab/mysqlify';
```

Both fully supported - the package ships `dist/cjs` and `dist/esm` builds.

---

## License

MIT - [github.com/cuonqcon333/mysqlify](https://github.com/cuonqcon333/mysqlify)
