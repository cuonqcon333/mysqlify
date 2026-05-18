# @caplab/mysqlify

Fluent MySQL/MariaDB query builder for Node.js - async/await first, Eloquent-style Models, transactions, lifecycle hooks, migrations, and security built-in.

[![npm](https://img.shields.io/npm/v/@caplab/mysqlify)](https://www.npmjs.com/package/@caplab/mysqlify)
[![license](https://img.shields.io/npm/l/@caplab/mysqlify)](https://github.com/cuonqcon333/mysqlify/blob/main/LICENSE)

## Features

- **Fluent Query Builder** - Chainable API supporting `.select()`, `.where()`, `.join()`, `.leftJoin()`, `.rightJoin()`, aggregates, and pagination.
- **Eloquent-style Models** - Define models with `fillable`, `guarded`, `hidden` fields, attributes casting, custom aliases, auto `snakeCase` mapping, and computed `appends`.
- **Relationship Eager Loading** - Highly optimized N+1 prevention supporting `hasOne`, `hasMany`, `belongsTo`, `belongsToMany` relations with `with()` and nested eager loading (`posts.comments`).
- **Dynamic Lazy Eager Loading** - Hydrate relations on-demand on existing model instances using `await user.load('posts')`.
- **Automatic Dirty Tracking** - `isDirty()`, `isClean()`, and `getDirty()` ensure `.save()` only writes modified fields to the database.
- **Transactions** - Built-in pool connection orchestration with auto-commit/rollback inside `DB.transaction()`, including transaction-bound models.
- **Lifecycle Hooks & Observers** - Class-based observers or static hooks for `creating`, `created`, `updating`, `updated`, `saving`, `saved`, `deleting`, `deleted`, `restoring`, `restored`.
- **Global & Local Scopes** - Auto-filter every query with `addGlobalScope()`, or construct chainable shortcuts with `static scopeActive(q)`.
- **Collection Helpers** - Collection instance returned by `.get()` provides clean array manipulation utilities (`pluck()`, `groupBy()`, `keyBy()`, `chunk()`, `unique()`, `sum()`).
- **Migrations & CLI** - Command-line migration orchestrator and model scaffolding generator.
- **Enterprise Security** - Parameterized queries against SQL injection, strict identifier alphanumeric whitelist checks, optional output XSS HTML-escaping (`sanitize: true`), and mass assignment protection.

---

## Compatibility & Version Floors

While the core query builder and ORM features are broadly compatible with older engines, some advanced schema and batch operations require newer MySQL/MariaDB version floors:

*   **Core Query / Model Features:** Broadly compatible with **MySQL 5.7+** and **MariaDB 10.0+**.
*   **`renameColumn()`**: Requires **MySQL 8.0.1+** or **MariaDB 10.5.2+** (due to native `RENAME COLUMN` support).
*   **`upsertMany()`**: Compatible with **MySQL 5.7+** / **MariaDB 10.0+**. Uses `VALUES(col)` which is deprecated in MySQL 8.0.20+ (triggers warning but executes successfully; constituting accepted portability debt).
*   **`JSON` columns**: Documented compatibility floor of **MySQL 5.7.8+** or **MariaDB 10.2.7+**, runtime-verified on MySQL 5.7 / 8.0 / MariaDB 10.5.
*   **`DEFAULT CURRENT_TIMESTAMP` on DATETIME**: Documented compatibility floor of **MySQL 5.6.5+** or **MariaDB 10.0.1+**, runtime-verified on MySQL 5.7 / 8.0 / MariaDB 10.5.

---

## Installation

```bash
npm install @caplab/mysqlify
```

---

## Connection & Pool Configuration

Initialize connection pools using environment variables or in-code parameters.

### Option 1 - Environment Variables (Zero Config)

Set the following variables in your `.env` file, and `mysqlify` will auto-connect using these values:

```env
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASS=secret
DB_NAME=myapp
```

### Option 2 - Explicit Code Connection

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
	sanitize: false,         // Set to true to globally auto escape HTML output strings (XSS defense)
	maxConditions: 20,       // Max conditions allowed inside WHERE chain (Query complexity limit)
	auditLog: false,         // Set to true to print queries
	logger: console.log,     // Custom logger callback
});
```

---

## Fluent Query Builder API

`DB.table()` returns a `QueryBuilder` instance supporting a chainable API.

```js
import { DB } from "@caplab/mysqlify";

// 1. SELECT operations
const users = await DB.table("users")
  .select("id", "email", "role as userRole")
  .where("active", 1)
  .orderBy("created_at", "DESC")
  .get();

// 2. WHERE methods
const result = await DB.table("products")
  .where("price", ">=", 100)
  .orWhere("category", "electronics")
  .whereIn("status", ["active", "pending"])
  .whereNotIn("tags", ["archived"])
  .whereNull("deleted_at")
  .whereNotNull("published_at")
  .whereBetween("stock", [10, 50])
  .whereRaw("YEAR(created_at) = ?", [2026])
  .get();

// 3. JOIN methods (INNER, LEFT, RIGHT)
const orders = await DB.table("orders")
  .join("users", "orders.user_id", "users.id")
  .leftJoin("payments", "orders.id", "payments.order_id")
  .rightJoin("shipments", "orders.id", "shipments.order_id")
  .select("orders.*", "users.name as userName")
  .get();

// 4. Aggregates & Helpers
const count = await DB.table("users").count();
const totalSales = await DB.table("orders").where("status", "completed").sum("amount");
const avgPrice = await DB.table("products").avg("price");
const maxPrice = await DB.table("products").max("price");
const minPrice = await DB.table("products").min("price");

// 5. Paginated retrieval
const pagination = await DB.table("posts").paginate(1, 15);
// Returns: { data: [...], total: 100, page: 1, perPage: 15, lastPage: 7 }

// 6. DB write operations
const insertId = await DB.table("users").insert({ name: "John", email: "john@example.com" });

const affectedRows = await DB.table("users").where("id", 1).update({ name: "Jane" });

await DB.table("users").where("id", 1).delete();

// Atomic increment/decrement
await DB.table("wallets").where("user_id", 1).increment("balance", 50);
await DB.table("wallets").where("user_id", 1).decrement("balance", 20);

// 7. Batch operations
await DB.table("tags").insertMany([{ name: "nodejs" }, { name: "mysql" }]);

// INSERT ... ON DUPLICATE KEY UPDATE
await DB.table("tokens").upsert(
	{ acct_id: "abc", access_token: "tok1", refresh_token: "ref1" },
	["access_token", "refresh_token"] // Columns to update on conflict
);
```

---

## Eloquent-style Models

Define active-record entities by extending `Model`.

```js
import { Model } from "@caplab/mysqlify";

export class User extends Model {
	static table = "users";            // Defaults to pluralized SnakeCase model name ('users')
	static primaryKey = "id";          // Defaults to 'id'
	static timestamps = true;          // Auto syncs created_at / updated_at
	static softDelete = false;         // Enable soft delete filters
	static snakeCase = false;          // Opt-in: Converts camelCase inputs to snake_case DB columns
	static fillable = ["name", "email", "password"]; // Whitelist for mass assignment
	static guarded = [];               // Blacklist for mass assignment
	static hidden = ["password"];      // Excluded from toJSON() serialization
	static casts = {
		is_admin: "boolean",
		settings: "json",
		tags: "array",
		joined_at: "date",
	};
	static aliases = {
		access_token: "accessToken",   // Maps db column name to response property name
	};
	static appends = ["fullName"];     // Append computed fields to toJSON() output

	// Computed getter
	get fullName() {
		return `${this.first_name ?? ""} ${this.last_name ?? ""}`.trim();
	}
}
```

### Model API

```js
// Static Finder Shorthands
const users = await User.all();
const user = await User.find(1);
const user = await User.findBy("email", "john@example.com"); // Shorthand lookup
const user = await User.findOrFail(1); // Throws error if not found

// Dynamic Scopes and filtering
const activeAdmins = await User.where("active", 1).where("role", "admin").get();

// Model Hydration and Manipulation
const newUser = await User.create({ name: "Bob", email: "bob@example.com" });

const userInstance = await User.find(1);
userInstance.name = "Alice";
await userInstance.save(); // Only dirty fields are sent via UPDATE!

// Reload fresh state from DB
await userInstance.fresh();

// Deletes
await userInstance.delete(); // or userInstance.destroy()
```

---

## Dirty Tracking

`mysqlify` tracks object mutations automatically. Calling `.save()` will only issue updates for columns that have actually changed.

```js
const user = await User.find(1); // { name: 'Bob', email: 'bob@example.com' }

user.name = "Jane";

user.isDirty();        // true
user.isDirty("name");  // true
user.isDirty("email"); // false
user.isClean("email"); // true
user.getDirty();       // { name: 'Jane' }

await user.save();     // Generates: UPDATE `users` SET `name` = ? WHERE `id` = ?
```

---

## Global & Local Scopes

### Local Scopes

Re-use common query constraints by declaring static methods prefixed with `scope`:

```js
class Post extends Model {
	static scopePublished(q) {
		q.where("status", "published");
	}
	static scopeByCategory(q, catId) {
		q.where("category_id", catId);
	}
}

// Chain local scopes together seamlessly
const posts = await Post.query().published().byCategory(5).get();
```

### Global Scopes

Automatically apply constraints to every query launched on the Model:

```js
class Post extends Model {
	static boot() {
		// Automatically filters by tenant on every query
		this.addGlobalScope("tenant", (q) => q.where("tenant_id", 1));
	}
}

// Default queries automatically contain the WHERE clause:
const posts = await Post.all();

// Bypass global scopes when needed:
const allTenantsPosts = await Post.withoutGlobalScope("tenant").get();

// Permanently remove a scope
Post.removeGlobalScope("tenant");
```

---

## Lifecycle Hooks & Observers

Register listeners around database actions. Supported events: `creating`, `created`, `updating`, `updated`, `saving`, `saved`, `deleting`, `deleted`, `restoring`, `restored`.

### Static Hook Registration

```js
class User extends Model {
	static boot() {
		User.on("creating", (instance) => {
			if (!instance.uuid) instance.uuid = generateUuid();
		});
		User.on("deleting", (instance) => {
			if (instance.is_admin) return false; // Cancel deletion!
		});
	}
}
```

### Class-Based Observers

```js
class UserObserver {
	creating(user) {
		user.status = "pending";
	}
	created(user) {
		mailer.sendWelcome(user.email);
	}
}

// Register observer
User.observe(UserObserver); // or User.observe(new UserObserver());
```

---

## Relationships & Eager Loading

Declare relations as instance methods returning relation descriptors:

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
	tags() {
		return this.belongsToMany(Tag, "post_tags", "post_id", "tag_id"); // pivot table
	}
}
```

### Eager Loading with `with()`

Eager loading aggregates related records in just **2 queries** to completely prevent N+1 issues:

```js
// Simple eager loading
const users = await User.with("posts").get();

// Multiple eager load relations
const users = await User.with("posts", "profile").get();

// Nested eager loading (Load posts and load comments for each post)
const users = await User.with("posts.comments").get();

// Constrained eager loading
const users = await User.with({
	posts: (q) => q.where("active", 1).orderBy("created_at", "DESC")
}).get();
```

### Lazy Eager Loading with `load()`

Lazy load relations on already-fetched Model instances:

```js
const user = await User.find(1);

await user.load("posts");                     // Basic lazy load
await user.load("posts.comments", "profile"); // Multiple and nested lazy load
await user.load({
	posts: (q) => q.where("active", 1)         // Constrained lazy eager load
});
```

---

## Transaction Safety

`DB.transaction()` provides an auto-commit/rollback block on database errors. Model instances bound inside the transaction block participate natively.

```js
import { DB } from "@caplab/mysqlify";

await DB.transaction(async (trx) => {
	// 1. Transaction-bound query builders
	const orderId = await trx.table("orders").insert({ user_id: 1, total: 200 });
	await trx.table("order_items").insert({ order_id: orderId, item_id: 5 });

	// 2. Transaction-bound Model operations
	const TrxUser = trx.model(User); // Binds the User model constructor to this transaction
	const user = await TrxUser.find(1);
	await user.update({ last_purchase: new Date() });

	// If any exception is thrown, the transaction is rolled back automatically.
});
```

---

## Collection Utilities

`.get()` and `.all()` queries return a `Collection` instance (extending native `Array`), offering clean data manipulation utilities:

```js
const users = await User.where("role", "member").get(); // Returns Collection

const emails = users.pluck("email");           // pluck: ['a@x.com', 'b@x.com']
const grouped = users.groupBy("role");         // groupBy: { member: [...] }
const keyed = users.keyBy("id");               // keyBy: { 1: user, 2: user }
const sumAge = users.sum("age");               // sum: 125
const uniqueUsers = users.unique("country");   // unique: Deduplicated collection
const chunks = users.chunk(10);                // chunk: Array of Collection chunks
const first = users.first();                   // Returns first item
const last = users.last();                     // Returns last item
```

---

## Migrations & Schema Builder

`mysqlify` comes with a Laravel-inspired DDL builder and command-line runner.

### Column Definition Matrix

| Method | MySQL DDL Type |
|---|---|
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
| `table.json('col')` | `JSON` |
| `table.enum('col', ['a','b'])` | `ENUM('a','b')` |
| `table.timestamps()` | `created_at DATETIME NULL`, `updated_at DATETIME NULL` |
| `table.softDeletes()` | `deleted_at DATETIME NULL` |

### Column Modifiers

Columns support modifiers including: `.nullable()`, `.notNullable()`, `.unsigned()`, `.unique()`, `.index()`, `.references(col, table)`, `.comment(text)`, `.change()`.

> [!NOTE]
> **Dynamic Defaults / SQL Expressions:** When using `.default(val)` with SQL functions like `CURRENT_TIMESTAMP`, `NOW()`, `CURRENT_DATE`, etc., the system automatically detects these dynamic expressions and outputs them unquoted in the generated DDL statements (e.g. `DEFAULT CURRENT_TIMESTAMP`). All other string values are automatically escaped and quoted as string literals (e.g. `DEFAULT 'active'`).

### Example Migration

```js
export async function up(schema) {
	await schema.create("users", (table) => {
		table.id();
		table.string("email", 191).notNullable().unique();
		table.boolean("active").default(true);
		table.timestamp("created_at").nullable().default("CURRENT_TIMESTAMP");
	});
}

export async function down(schema) {
	await schema.drop("users");
}
```

### Table-level & Foreign Constraints

```js
table.unique(["col_a", "col_b"]); // Composite unique index
table.index(["col_a", "col_b"]);  // Composite index
table.foreign("user_id").references("id").on("users").onDelete("CASCADE"); // Foreign constraints
```

### Alter Alterations

Modify, drop, or rename columns inside `Schema.table()`:

```js
export async function up(schema) {
	await schema.table("users", (table) => {
		// Modify column datatype/attributes
		table.string("email", 255).nullable().change();

		// Drop column
		table.dropColumn("bio");

		// Rename column (Requires MySQL 8.0+ / MariaDB 10.5.2+)
		table.renameColumn("first_name", "firstName");
	});
}
```

---

## Command Line Interface (CLI)

Generate CLI configurations:

```bash
npx mysqlify init
```

Generates a default config `mysqlify.config.cjs`:

```js
module.exports = {
	host: process.env.DB_HOST || "localhost",
	port: Number(process.env.DB_PORT) || 3306,
	user: process.env.DB_USER || "root",
	password: process.env.DB_PASS || "",
	database: process.env.DB_NAME || "",
	migrationsDir: "migrations",
	modelsDir: "models",
};
```

### Available CLI Commands

```bash
npx mysqlify make:migration create_users_table      # Generate migration
npx mysqlify make:model User                        # Generate model
npx mysqlify make:model User --migration            # Generate both
npx mysqlify migrate:up                             # Run pending migrations
npx mysqlify migrate:rollback                       # Rollback last migration batch
npx mysqlify migrate:status                         # View migration table status
```

---

## Security Shield

Security is enforced internally by design:

*   **SQL Injection Prevention:** Every query uses parameterized inputs (`?`). String values are escaped properly.
*   **Strict Identifiers Whitelisting:** Table and column names are rigorously validated against `^[a-zA-Z_][a-zA-Z0-9_]*$` to reject malicious inputs.
*   **XSS Protection:** Enabling `sanitize: true` automatically filters string outputs to escape risky HTML tags.
*   **Mass Assignment Shield:** Whitelist inputs with `fillable` or blacklist with `guarded`.
*   **Data Leakage Defense:** Define `hidden` attributes to exclude sensitive keys from serialization (`toJSON()`).

---

## Testing Workflow

The test suite is structured to separate isolated unit tests from Docker-dependent integration tests:

| Command | Action / Target | Prerequisites |
|---|---|---|
| **`npm test`** | Runs **256 unit tests** in isolation (excludes integration tests). | None. |
| **`npm run test:integration`** | Runs **12 integration tests** on real databases. | Running Docker containers. |
| **`npm run test:all`** | Runs the entire suite (unit + integration). | Running Docker containers. |
| **`npm run docker:up`** | Spins up MySQL 5.7, MySQL 8.0, and MariaDB 10.5 in the background. | Docker installed. |
| **`npm run docker:down`** | Tears down all integration containers and cleans up. | Docker installed. |

```bash
# Start integration environment
npm run docker:up

# Execute everything
npm run test:all

# Clean up
npm run docker:down
```

---

## Known Caveats & Portability Notes

*   **`renameColumn()` Compatibility Constraint:** Attempting to use `renameColumn()` on older engine versions (such as MySQL 5.7 or MariaDB < 10.5.2) will fail with a SQL syntax error, as native `RENAME COLUMN` is not supported on those engines.
*   **`upsertMany()` Deprecation Warnings:** On MySQL 8.0.20+, using `upsertMany()` will trigger a deprecation warning in database logs due to its reliance on `VALUES(col)` inside `ON DUPLICATE KEY UPDATE`. It executes successfully, but remains accepted portability debt.
*   **`MysqlifySecurityError`:** Thrown globally whenever a security vulnerability (such as a forbidden query complexity threshold or invalid table/column identifier format) is detected.

---

## License

MIT - [github.com/cuonqcon333/mysqlify](https://github.com/cuonqcon333/mysqlify)
