# mysqlify

Fluent MySQL/MariaDB query builder for Node.js - async/await first, Eloquent-style Models, transactions, lifecycle hooks, migrations, and security built-in.

[![npm](https://img.shields.io/npm/v/@caplab/mysqlify)](https://www.npmjs.com/package/@caplab/mysqlify)
[![license](https://img.shields.io/npm/l/@caplab/mysqlify)](https://github.com/cuonqcon333/mysqlify/blob/main/LICENSE)

## Features

- **Fluent Query Builder** - chainable API, `await` friendly
- **Eloquent-style Models** - `fillable`, `hidden`, `casts`, `timestamps`, `softDelete`
- **Eager Loading** - `with('posts')`, `with('posts.comments')`, `with({ posts: q => ... })`, `load()`
- **Local Scopes** - `static scopeActive(q)` -> `User.query().active().get()`
- **Accessors / Mutators** - `get fullName()`, `set password()`, `static appends`
- **Collection** - `pluck()`, `groupBy()`, `keyBy()`, `chunk()`, `unique()`, `sum()`
- **Global Scopes** - `addGlobalScope()`, `withoutGlobalScope()` - auto WHERE on every query
- **Observers** - `User.observe(UserObserver)` - class-based lifecycle hooks
- **Query Logging** - `DB.listen(({ sql, time }) => ...)` - profile every query
- **Lifecycle Hooks** - `boot()`, `creating/created`, `updating/updated`, `deleting/deleted`, `restoring/restored`
- **Transactions** - `DB.transaction()` with auto-commit/rollback, Models participate too
- **Dirty tracking** - `isDirty()`, `getDirty()`, `save()` only sends changed fields
- **Batch operations** - `insertMany()`, `createMany()`, `upsert()`, `upsertMany()`
- **Field aliases** - map DB columns to response keys (`access_token` -> `accessToken`)
- **Auto snake_case** - opt-in camelCase input -> snake_case DB column conversion
- **Date auto-convert** - `Date`, ISO strings auto-serialized to MySQL `DATETIME`
- **Helpers** - `firstOrCreate()`, `updateOrCreate()`, `findOrFail()`, `findMany()`, `findBy()`
- **Migrations** - Laravel-style `up/down`, CLI runner
- **Security built-in** - SQL injection prevention, XSS sanitization, mass assignment protection
- **Dual CJS + ESM** - works with both `require()` and `import`
- **Zero extra runtime deps** - only `mysql2`

---

## Compatibility & Version Floors

While the core query builder and ORM features are broadly compatible with older engines, some advanced schema and batch operations require newer MySQL/MariaDB version floors:

*   **Core Query / Model Features:** Broadly compatible with **MySQL 5.7+** and **MariaDB 10.0+**.
*   **`renameColumn()`**: Requires **MySQL 8.0.1+** or **MariaDB 10.5.2+** (due to native `RENAME COLUMN` support).
*   **`upsertMany()`**: Compatible with **MySQL 5.7+** / **MariaDB 10.0+**. Note that it uses `VALUES(col)` which is deprecated in MySQL 8.0.20+ (triggers warning in logs but executes successfully; future versions of MySQL will deprecate it, constituting accepted portability debt).
*   **`JSON` columns**: Documented compatibility floor of **MySQL 5.7.8+** or **MariaDB 10.2.7+**, runtime-verified on MySQL 5.7 / 8.0 / MariaDB 10.5.
*   **`DEFAULT CURRENT_TIMESTAMP` on DATETIME**: Documented compatibility floor of **MySQL 5.6.5+** or **MariaDB 10.0.1+**, runtime-verified on MySQL 5.7 / 8.0 / MariaDB 10.5.

---

## Installation

```bash
npm install @caplab/mysqlify
```

---

## Quick Start

### Connect

```js
import { connect } from "@caplab/mysqlify";

connect({
	host: "localhost",
	user: "root",
	password: "secret",
	database: "myapp",
});
```

Or use environment variables - `DB_HOST`, `DB_USER`, `DB_PASS`, `DB_NAME`, `DB_PORT`.

---

## DB / Configuration

### Option 1 - `mysqlify.config.cjs` (recommended)

Generate with `npx mysqlify init`, then edit:

```js
module.exports = {
	host: process.env.DB_HOST || "localhost",
	port: Number(process.env.DB_PORT) || 3306,
	user: process.env.DB_USER || "root",
	password: process.env.DB_PASS || "",
	database: process.env.DB_NAME || "",

	migrationsDir: "src/database/migrations",
	modelsDir: "src/models",

	pool: { connectionLimit: 10 },
	sanitize: false,
	auditLog: false,
	logger: null,
};
```

### Option 2 - `connect()` in code

```js
import { connect } from "@caplab/mysqlify";

connect({
	host: "localhost",
	port: 3306,
	user: "root",
	password: "secret",
	database: "myapp",
	pool: {
		connectionLimit: 10,
		acquireTimeout: 10000,
	},
	sanitize: false,
	maxConditions: 20,
	auditLog: false,
	logger: null,
});
```

---

## Query Builder

```js
import { DB } from "@caplab/mysqlify";

// Fetch all
const users = await DB.table("users").get();

// With conditions
const admins = await DB.table("users").where("role", "admin").where("active", 1).orderBy("name").get();

// First row
const user = await DB.table("users").where("id", 1).first();

// Insert
const insertId = await DB.table("users").insert({ name: "John", email: "j@x.com" });

// Batch insert (single query)
await DB.table("tags").insertMany([{ name: "nodejs" }, { name: "mysql" }]);

// Upsert - INSERT ... ON DUPLICATE KEY UPDATE
await DB.table("tokens").upsert(
	{ acct_id: "abc", access_token: "tok1", refresh_token: "ref1" },
	["access_token", "refresh_token"], // columns to update on conflict
);

// Update
const affected = await DB.table("users").where("id", 1).update({ name: "Jane" });

// Atomic increment / decrement
await DB.table("wallets").where("user_id", 1).increment("balance", 50);
await DB.table("wallets").where("user_id", 1).decrement("balance", 20);

// Delete
await DB.table("users").where("id", 1).delete();

// Aggregates
const count = await DB.table("users").count();
const total = await DB.table("orders").where("user_id", 1).sum("amount");
const avg = await DB.table("products").avg("price");
const max = await DB.table("products").max("price");
const min = await DB.table("products").min("price");

// Pagination
const result = await DB.table("posts").orderBy("created_at", "DESC").paginate(1, 15);

// Raw query (always use bindings)
const rows = await DB.raw("SELECT * FROM users WHERE id = ?", [1]);

// Debug - get SQL without executing
const { sql, params } = DB.table("users").where("active", 1).toSQL();
```

---

## Models

```js
import { Model } from "@caplab/mysqlify";

export class User extends Model {
	static table = "users";
	static primaryKey = "id";
	static timestamps = true; // auto created_at / updated_at
	static softDelete = false;
	static fillable = ["name", "email", "password"];
	static hidden = ["password"]; // excluded from toJSON() / res.json()
	static casts = {
		is_admin: "boolean", // 1/0 -> true/false
		score: "float", // '9.5' -> 9.5
		settings: "json", // '{"k":"v"}' -> { k: 'v' }
		tags: "array", // '["a","b"]' -> ['a', 'b']
		joined_at: "date", // -> 'YYYY-MM-DD'
	};
}
```

### Static API

```js
const users = await User.all();
const user = await User.find(1);
const user = await User.findOrFail(1); // throws if not found
const users = await User.findMany([1, 2, 3]); // batch fetch by ids
const first = await User.where("active", 1).first();
```

---

## Relations, Eager Loading & `load()`

Define relations as instance methods on your models:

```js
class User extends Model {
	posts() {
		return this.hasMany(Post, "user_id");
	}
	profile() {
		return this.hasOne(Profile, "user_id");
	}
}

class Post extends Model {
	author() {
		return this.belongsTo(User, "user_id");
	}
	comments() {
		return this.hasMany(Comment, "post_id");
	}
	tags() {
		return this.belongsToMany(Tag, "post_tags", "post_id", "tag_id");
	}
}
```

### Eager Loading with `with()`

```js
// Simple eager load
const users = await User.with("posts").get();

// Nested eager load
const users = await User.with("posts.comments").get();

// Constrained eager load
const users = await User.with({
	posts: (q) => q.where("published", 1).orderBy("created_at", "desc"),
}).get();
```

### Lazy Eager Loading with `load()`

Lazy load relations on already-fetched Model instances:

```js
const user = await User.find(1);

// Basic lazy load
await user.load("posts");

// Multiple and nested relations
await user.load("posts.comments", "profile");

// Constrained lazy eager load
await user.load({
	posts: (q) => q.where("active", 1)
});
```

---

## Transactions

`DB.transaction()` auto-commits on success and auto-rollbacks on any error.

```js
import { DB } from "@caplab/mysqlify";

await DB.transaction(async (trx) => {
	const orderId = await trx.table("orders").insert({ user_id: 1, total: 150 });
	await trx.table("order_items").insert({ order_id: orderId, product_id: 5, qty: 2 });
	await trx.table("wallets").where("user_id", 1).decrement("balance", 150);
});
```

---

## Migrations & Schema Builder

Create migrations using the CLI:

```bash
npx mysqlify make:migration create_users_table
```

```js
export async function up(schema) {
	await schema.create("users", (table) => {
		table.id();
		table.string("name", 100).notNullable();
		table.string("email").notNullable().unique();
		table.boolean("active").default(true);
		table.timestamp("created_at").nullable().default("CURRENT_TIMESTAMP");
	});
}

export async function down(schema) {
	await schema.drop("users");
}
```

> [!NOTE]
> **Dynamic Defaults / SQL Expressions:** When using `.default(val)` with SQL functions like `CURRENT_TIMESTAMP`, `NOW()`, `CURRENT_DATE`, etc., the system automatically detects these dynamic expressions and outputs them unquoted in the generated DDL statements (e.g. `DEFAULT CURRENT_TIMESTAMP`). All other string values are automatically escaped and quoted as string literals (e.g. `DEFAULT 'active'`).

---

## Advanced Alter Operations

Modify, drop, or rename columns inside `Schema.table()` using Laravel-like syntax:

```js
export async function up(schema) {
	await schema.table("users", (table) => {
		// 1. Modify an existing column
		table.string("email", 191).nullable().change();

		// 2. Rename a column (Requires MySQL 8.0+ / MariaDB 10.5.2+)
		table.renameColumn("first_name", "firstName");

		// 3. Drop a column
		table.dropColumn("bio");
	});
}
```

---

## Known Caveats & Portability Notes

*   **`renameColumn()` Compatibility Constraint:** Attempting to use `renameColumn()` on older engine versions (such as MySQL 5.7 or MariaDB < 10.5.2) will fail with a SQL syntax error, as native `RENAME COLUMN` is not supported on those engines.
*   **`upsertMany()` Deprecation Warnings:** On MySQL 8.0.20+, using `upsertMany()` will trigger a deprecation warning in database logs due to its reliance on `VALUES(col)` inside `ON DUPLICATE KEY UPDATE`. It executes successfully, but remains accepted portability debt.

---

## Developer Experience & Integration Workflow

The test suite is structured to separate isolated unit tests from Docker-dependent integration tests:

| Command | Action / Target | Prerequisites |
|---|---|---|
| **`npm test`** | Runs **256 unit tests** in isolation (excludes integration tests). | None. |
| **`npm run test:integration`** | Runs **12 integration tests** on real databases. | Running Docker containers. |
| **`npm run test:all`** | Runs the entire suite (unit + integration). | Running Docker containers. |
| **`npm run docker:up`** | Spins up MySQL 5.7, MySQL 8.0, and MariaDB 10.5 in the background. | Docker installed. |
| **`npm run docker:down`** | Tears down all integration containers and cleans up. | Docker installed. |

To execute the integration matrix locally, use the following lifecycle commands:

```bash
# 1. Start database engines
npm run docker:up

# 2. Execute tests
npm run test              # Run unit tests only
npm run test:integration  # Run integration tests only
# OR
npm run test:all          # Run everything

# 3. Clean up and stop database engines
npm run docker:down
```

---

## License

MIT - [github.com/cuonqcon333/mysqlify](https://github.com/cuonqcon333/mysqlify)
