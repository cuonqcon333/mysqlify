import { QueryBuilder } from './query-builder.js';
import { applyFillable, applyGuarded, applyHidden, validateDataObject } from './security.js';
import { execute } from './connection.js';

/**
 * Base Model class - Eloquent-style ORM for mysqlify.
 *
 * Usage:
 *   class User extends Model {
 *     static table = 'users';
 *     static fillable = ['name', 'email'];
 *     static hidden = ['password'];
 *     static timestamps = true;
 *     static softDelete = false;
 *   }
 */
const _bootedClasses = new Set();

export class Model {
  static table = null;
  static primaryKey = 'id';
  static timestamps = true;
  static softDelete = false;
  static fillable = [];
  static guarded = [];
  static hidden = [];
  static casts = {};
  static aliases = {};  // { dbColumn: 'responseKey' } e.g. { access_token: 'accessToken' }
  static snakeCase = false; // opt-in: auto camelCase input keys → snake_case DB columns
  static appends = [];  // computed accessor keys included in toJSON()

  // Boot system 

  static _bootIfNeeded() {
    if (_bootedClasses.has(this)) return;
    _bootedClasses.add(this);
    if (typeof this.boot === 'function') this.boot();
  }

  /**
   * Called by the Proxy below to handle direct scope calls on the class.
   * e.g. User.active() → User._callScope('active')
   */
  static _callScope(scopeName, args) {
    const fullName = 'scope' + scopeName[0].toUpperCase() + scopeName.slice(1);
    const qb = this._query();
    this[fullName](qb, ...args);
    return this._wrapQueryBuilder(qb);
  }

  static _hooks = {};

  static on(event, fn) {
    const key = `${this.name}:${event}`;
    if (!Model._hooks[key]) Model._hooks[key] = [];
    Model._hooks[key].push(fn);
  }

  /**
   * Register a class-based observer.
   * The observer class can define any of: creating, created, updating, updated,
   * deleting, deleted, saving, saved, restoring, restored.
   *
   * @example
   * class UserObserver {
   *   created(user) { console.log('created', user.id); }
   *   deleting(user) { if (user.is_admin) return false; } // return false to cancel
   * }
   * User.observe(new UserObserver());
   * // or pass the class itself:
   * User.observe(UserObserver);
   */
  static observe(observer) {
    const instance = typeof observer === 'function' ? new observer() : observer;
    const events = [
      'creating', 'created', 'updating', 'updated',
      'saving', 'saved', 'deleting', 'deleted',
      'restoring', 'restored',
    ];
    for (const event of events) {
      if (typeof instance[event] === 'function') {
        this.on(event, (model) => instance[event](model));
      }
    }
    return this;
  }

  static async _fire(event, instance) {
    const key = `${this.name}:${event}`;
    const fns = Model._hooks[key] ?? [];
    for (const fn of fns) {
      const result = await fn(instance);
      if (result === false) return false;
    }
    return true;
  }

  constructor(attributes = {}) {
    this._original = { ...attributes };
    this._attributes = { ...attributes };
    this._exists = false;
    // Use mutators if defined (set <Key>(v) setter on prototype)
    for (const [key, val] of Object.entries(attributes)) {
      this[key] = val;
    }
  }

  // ── Global Scopes ──────────────────────────────────────────────────────────

  static _globalScopes = null; // Map<name, fn> — per-class, lazy init
  static _skipGlobalScopes = null; // Set<name> — per-call skip list

  /**
   * Register a global scope applied to every query on this model.
   * @param {string} name  Unique name (used for removal)
   * @param {(qb: QueryBuilder) => void} fn
   */
  static addGlobalScope(name, fn) {
    if (!this._globalScopes || !Object.prototype.hasOwnProperty.call(this, '_globalScopes')) {
      this._globalScopes = new Map();
    }
    this._globalScopes.set(name, fn);
    return this;
  }

  /**
   * Permanently remove a global scope from this model.
   */
  static removeGlobalScope(name) {
    this._globalScopes?.delete(name);
    return this;
  }

  /**
   * Returns a wrapper that skips the given global scope(s) for ONE query chain.
   * e.g. User.withoutGlobalScope('tenant').get()
   */
  static withoutGlobalScope(...names) {
    const qb = this._query({ skipScopes: new Set(names) });
    return this._wrapQueryBuilder(qb);
  }

  // Internal: build a QueryBuilder for this model 

  static _query(opts = null) {
    const conn = opts?.conn ?? (typeof opts === 'object' && opts !== null && !opts.conn ? null : opts);
    const skipScopes = opts?.skipScopes ?? null;
    const tableName = this._resolveTable();
    const qb = new QueryBuilder().table(tableName);

    const actualConn = typeof opts === 'object' && opts !== null ? opts.conn ?? null : opts;
    if (actualConn) qb._useConnection(actualConn);

    if (this.softDelete) {
      qb._setSoftDelete('deleted_at');
    }

    // Apply global scopes
    if (this._globalScopes) {
      for (const [name, fn] of this._globalScopes) {
        if (skipScopes && skipScopes.has(name)) continue;
        fn(qb);
      }
    }

    return qb;
  }

  static _withConnection(conn) {
    const ModelClass = this;
    const proxy = Object.create(ModelClass);
    proxy._conn = conn;
    proxy._query = (opts = null) => ModelClass._query({ conn, ...(opts ?? {}) });
    proxy._hydrate = (row) => ModelClass._hydrate(row);
    proxy._hydrateAll = (rows) => ModelClass._hydrateAll(rows);
    proxy._wrapQueryBuilder = (qb) => ModelClass._wrapQueryBuilder(qb);
    proxy._resolveTable = () => ModelClass._resolveTable();
    return proxy;
  }

  static _normalizeInput(data) {
    return this.snakeCase ? _keysToSnake(data) : data;
  }

  static _resolveTable() {
    if (this.table) return this.table;
    return this.name
      .replace(/([A-Z])/g, '_$1')
      .toLowerCase()
      .replace(/^_/, '') + 's';
  }

  static _hydrate(row) {
    if (!row) return null;
    const casted = _applyCasts(row, this.casts);
    // Attach DB column values under alias keys so internal code can access both
    const aliasMap = this.aliases ?? {};
    for (const [dbCol, aliasKey] of Object.entries(aliasMap)) {
      if (dbCol in casted) casted[aliasKey] = casted[dbCol];
    }
    const instance = new this(casted);
    instance._exists = true;
    // Make hidden fields non-enumerable: internal access (instance.password) still works,
    // but spread ({...instance}), Object.entries(), and JSON.stringify() won't expose them.
    // Expand hidden to cover both DB col and alias key so either name works.
    const aliasMapH = this.aliases ?? {};
    const dbToAlias = aliasMapH;                                           // { access_token: 'accessToken' }
    const aliasToDb = Object.fromEntries(Object.entries(aliasMapH).map(([db, a]) => [a, db]));
    const hiddenFields = this.hidden ?? [];
    const hiddenExpanded = new Set(hiddenFields);
    for (const field of hiddenFields) {
      if (dbToAlias[field]) hiddenExpanded.add(dbToAlias[field]);  // hide access_token → also hide accessToken
      if (aliasToDb[field]) hiddenExpanded.add(aliasToDb[field]);  // hide accessToken → also hide access_token
    }
    for (const field of hiddenExpanded) {
      if (field in instance) {
        Object.defineProperty(instance, field, {
          value: instance[field],
          writable: true,
          enumerable: false,
          configurable: true,
        });
      }
    }
    return instance;
  }

  static _hydrateAll(rows) {
    return rows.map((row) => this._hydrate(row));
  }

  // Static Query API 

  static async all() {
    const rows = await this._query().get();
    return new Collection(this._hydrateAll(rows));
  }

  static async find(id) {
    const row = await this._query().where(this.primaryKey, id).first();
    return this._hydrate(row);
  }

  static where(column, operatorOrValue, value) {
    const qb = this._query();
    qb.where(column, operatorOrValue, value);
    return this._wrapQueryBuilder(qb);
  }

  static orWhere(column, operatorOrValue, value) {
    const qb = this._query();
    qb.orWhere(column, operatorOrValue, value);
    return this._wrapQueryBuilder(qb);
  }

  static whereIn(column, values) {
    const qb = this._query();
    qb.whereIn(column, values);
    return this._wrapQueryBuilder(qb);
  }

  static whereNull(column) {
    const qb = this._query();
    qb.whereNull(column);
    return this._wrapQueryBuilder(qb);
  }

  static whereNotNull(column) {
    return this._wrapQueryBuilder(this._query().whereNotNull(column));
  }

  static whereNotIn(column, values) {
    return this._wrapQueryBuilder(this._query().whereNotIn(column, values));
  }

  static whereBetween(column, range) {
    return this._wrapQueryBuilder(this._query().whereBetween(column, range));
  }

  static whereRaw(expression, bindings = []) {
    return this._wrapQueryBuilder(this._query().whereRaw(expression, bindings));
  }

  static selectRaw(expression) {
    return this._wrapQueryBuilder(this._query().selectRaw(expression));
  }

  static join(table, col1, col2) {
    return this._wrapQueryBuilder(this._query().join(table, col1, col2));
  }

  static leftJoin(table, col1, col2) {
    return this._wrapQueryBuilder(this._query().leftJoin(table, col1, col2));
  }

  static rightJoin(table, col1, col2) {
    return this._wrapQueryBuilder(this._query().rightJoin(table, col1, col2));
  }

  static groupBy(...columns) {
    return this._wrapQueryBuilder(this._query().groupBy(...columns));
  }

  static offset(n) {
    return this._wrapQueryBuilder(this._query().offset(n));
  }

  static having(column, operatorOrValue, value) {
    return this._wrapQueryBuilder(this._query().having(column, operatorOrValue, value));
  }

  static async increment(column, amount = 1) {
    return this._query().increment(column, amount);
  }

  static async decrement(column, amount = 1) {
    return this._query().decrement(column, amount);
  }

  static select(...columns) {
    const qb = this._query();
    qb.select(...columns);
    return this._wrapQueryBuilder(qb);
  }

  static orderBy(column, dir) {
    return this._wrapQueryBuilder(this._query().orderBy(column, dir));
  }

  static limit(n) {
    return this._wrapQueryBuilder(this._query().limit(n));
  }

  static async count() {
    return this._query().count();
  }

  static async sum(col) {
    return this._query().sum(col);
  }

  static async avg(col) {
    return this._query().avg(col);
  }

  static async max(col) {
    return this._query().max(col);
  }

  static async min(col) {
    return this._query().min(col);
  }

  static async paginate(page = 1, perPage = 15) {
    const result = await this._query().paginate(page, perPage);
    result.data = this._hydrateAll(result.data);
    return result;
  }

  static async create(data) {
    this._bootIfNeeded();
    validateDataObject(data);
    let filtered = { ...this._normalizeInput(data) };
    if (this.fillable && this.fillable.length > 0) {
      filtered = applyFillable(filtered, this.fillable);
    }
    if (this.guarded && this.guarded.length > 0) {
      filtered = applyGuarded(filtered, this.guarded);
    }

    const instance = new this(filtered);
    if (await this._fire('creating', instance) === false) return null;

    // re-sync filtered from instance so hook mutations are included
    filtered = {};
    for (const [k, v] of Object.entries(instance)) {
      if (!k.startsWith('_')) filtered[k] = v;
    }
    if (this.fillable && this.fillable.length > 0) {
      filtered = applyFillable(filtered, this.fillable);
    }
    if (this.guarded && this.guarded.length > 0) {
      filtered = applyGuarded(filtered, this.guarded);
    }

    if (this.timestamps) {
      const now = _now();
      filtered.created_at = now;
      filtered.updated_at = now;
    }

    const insertId = await this._query().insert(filtered);
    const created = await this.find(insertId);
    await this._fire('created', created);
    return created;
  }

  static async findOrFail(id) {
    const instance = await this.find(id);
    if (!instance) {
      throw new Error(`${this.name} with id ${id} not found.`);
    }
    return instance;
  }

  static async findMany(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const rows = await this._query().whereIn(this.primaryKey, ids).get();
    return this._hydrateAll(rows);
  }

  static async firstOrCreate(conditions, extra = {}) {
    const qb = this._query();
    for (const [col, val] of Object.entries(conditions)) {
      qb.where(col, val);
    }
    const row = await qb.first();
    if (row) return this._hydrate(row);
    return this.create({ ...conditions, ...extra });
  }

  static async updateOrCreate(conditions, data = {}) {
    const qb = this._query();
    for (const [col, val] of Object.entries(conditions)) {
      qb.where(col, val);
    }
    const row = await qb.first();
    if (row) {
      const instance = this._hydrate(row);
      await instance.update(data);
      return instance;
    }
    return this.create({ ...conditions, ...data });
  }

  static async createMany(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const now = _now();
    const prepared = rows.map((r) => {
      let filtered = { ...this._normalizeInput(r) };
      if (this.fillable && this.fillable.length > 0) filtered = applyFillable(filtered, this.fillable);
      if (this.guarded && this.guarded.length > 0) filtered = applyGuarded(filtered, this.guarded);
      if (this.timestamps) { filtered.created_at = now; filtered.updated_at = now; }
      return filtered;
    });
    await this._query().insertMany(prepared);
    return prepared;
  }

  static async insertMany(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    const now = _now();
    const prepared = rows.map((r) => {
      let filtered = { ...this._normalizeInput(r) };
      if (this.fillable && this.fillable.length > 0) filtered = applyFillable(filtered, this.fillable);
      if (this.guarded && this.guarded.length > 0) filtered = applyGuarded(filtered, this.guarded);
      if (this.timestamps) { filtered.created_at = now; filtered.updated_at = now; }
      return filtered;
    });
    return this._query().insertMany(prepared);
  }

  static async upsertMany(rows, updateKeysOrOptions = []) {
    if (!Array.isArray(rows) || rows.length === 0) return { inserted: 0, updated: 0, rows: new Collection([]) };
    this._bootIfNeeded();
    const now = _now();
    const prepared = rows.map((r) => {
      let filtered = { ...this._normalizeInput(r) };
      if (this.fillable && this.fillable.length > 0) filtered = applyFillable(filtered, this.fillable);
      if (this.guarded && this.guarded.length > 0) filtered = applyGuarded(filtered, this.guarded);
      if (this.timestamps) {
        if (!filtered.created_at) filtered.created_at = now;
        filtered.updated_at = now;
      }
      return filtered;
    });

    // Resolve updateKeys + conflictFields from options
    const firstRow = prepared[0];
    const allKeys = Object.keys(firstRow);
    let updateKeys;
    let conflictFields = [];
    if (Array.isArray(updateKeysOrOptions)) {
      updateKeys = updateKeysOrOptions;
      if (updateKeys.length === 0) updateKeys = allKeys.filter((k) => k !== this.primaryKey);
      if (this.timestamps && !updateKeys.includes('updated_at')) updateKeys = [...updateKeys, 'updated_at'];
    } else {
      conflictFields = updateKeysOrOptions.conflictFields ?? [];
      const { update } = updateKeysOrOptions;
      updateKeys = (update && update.length > 0)
        ? update
        : allKeys.filter((k) => k !== this.primaryKey && !conflictFields.includes(k));
      if (this.timestamps && !updateKeys.includes('updated_at')) updateKeys = [...updateKeys, 'updated_at'];
    }

    // MySQL: affectedRows=1 per INSERT, affectedRows=2 per UPDATE, affectedRows=0 per no-op
    const result = await this._query().upsertMany(prepared, updateKeys);
    const affectedRows = result.affectedRows ?? 0;
    // MySQL affectedRows semantics: INSERT = 1, UPDATE = 2, no-op = 0
    // Total rows = i + u, affectedRows = i + 2u → u = affectedRows - totalRows
    const totalRows = prepared.length;
    const updatedCount = Math.max(0, affectedRows - totalRows);
    const insertedCount = totalRows - updatedCount;

    // Re-fetch the upserted rows to return hydrated instances
    // Strategy: if conflictFields are known, use tuple IN; otherwise fallback to primary key range
    let fetchedRows;
    if (conflictFields.length > 0 && conflictFields.length === 1) {
      // Single conflict field: WHERE col IN (...)
      const col = conflictFields[0];
      const vals = [...new Set(prepared.map((r) => r[col]).filter((v) => v != null))];
      fetchedRows = vals.length
        ? this._hydrateAll(await this._query().whereIn(col, vals).get())
        : [];
    } else if (conflictFields.length > 1) {
      // Multiple conflict fields: WHERE (col1, col2, ...) IN ((v1, v2), ...)
      const colList = conflictFields.map((c) => `\`${c}\``).join(', ');
      const rowPlaceholders = prepared.map(() => `(${conflictFields.map(() => '?').join(', ')})`).join(', ');
      const bindings = prepared.flatMap((r) => conflictFields.map((c) => r[c] ?? null));
      const rawExpr = `(${colList}) IN (${rowPlaceholders})`;
      fetchedRows = this._hydrateAll(await this._query().whereRaw(rawExpr, bindings).get());
    } else {
      // No conflict fields known — fetch last N rows by primary key DESC
      fetchedRows = this._hydrateAll(
        await this._query().orderBy(this.primaryKey, 'desc').limit(totalRows).get()
      );
    }

    return {
      inserted: insertedCount,
      updated: updatedCount,
      rows: new Collection(fetchedRows),
    };
  }

  static async upsert(data, updateKeysOrOptions = []) {
    this._bootIfNeeded();
    validateDataObject(data);
    let filtered = { ...this._normalizeInput(data) };
    if (this.fillable && this.fillable.length > 0) filtered = applyFillable(filtered, this.fillable);
    if (this.guarded && this.guarded.length > 0) filtered = applyGuarded(filtered, this.guarded);
    if (this.timestamps) {
      const now = _now();
      if (!filtered.created_at) filtered.created_at = now;
      filtered.updated_at = now;
    }

    let updateKeys;

    if (Array.isArray(updateKeysOrOptions)) {
      // Legacy API: upsert(data, ['col1', 'col2'])
      updateKeys = updateKeysOrOptions;
      if (this.timestamps && !updateKeys.includes('updated_at')) {
        updateKeys = [...updateKeys, 'updated_at'];
      }
      return this._query().upsert(filtered, updateKeys);
    }

    // Sequelize-style API: upsert(data, { conflictFields?, update? })
    const options = updateKeysOrOptions;
    const allKeys = Object.keys(filtered);
    const conflictFields = options.conflictFields ?? [];

    if (options.update && Array.isArray(options.update)) {
      updateKeys = options.update;
    } else {
      // Auto: update all columns except conflictFields and primary key
      const pk = this.primaryKey;
      updateKeys = allKeys.filter((k) => k !== pk && !conflictFields.includes(k));
    }

    if (this.timestamps && !updateKeys.includes('updated_at')) {
      updateKeys = [...updateKeys, 'updated_at'];
    }

    const result = await this._query().upsert(filtered, updateKeys);
    // MySQL: affectedRows=1 → INSERT, affectedRows=2 → UPDATE, affectedRows=0 → no-op
    const created = result.affectedRows === 1;
    const pk = this.primaryKey;
    const pkVal = result.insertId || filtered[pk];
    const instance = pkVal ? await this.find(pkVal) : null;
    return [instance, created];
  }

  static withTrashed() {
    return this._wrapQueryBuilder(this._query().withTrashed());
  }

  static onlyTrashed() {
    return this._wrapQueryBuilder(this._query().onlyTrashed());
  }

  /**
   * Entry point for scope-only chains: User.active().get()
   * Also used internally so scopes defined without where() still chain.
   */
  static query() {
    return this._wrapQueryBuilder(this._query());
  }

  /**
   * findBy(column, value) — dynamic finder shorthand
   * e.g. User.findBy('email', 'a@x.com')
   */
  static async findBy(column, value) {
    const row = await this._query().where(column, value).first();
    return this._hydrate(row);
  }

  /**
   * Wraps a QueryBuilder so that .get() and .first() return hydrated Model instances.
   * Also exposes local scopes defined as static scopeXxx(q) methods.
   */
  static _wrapQueryBuilder(qb) {
    const ModelClass = this;
    const wrapper = {
      _qb: qb,

      where(col, op, val) { qb.where(col, op, val); return this; },
      orWhere(col, op, val) { qb.orWhere(col, op, val); return this; },
      whereIn(col, vals) { qb.whereIn(col, vals); return this; },
      whereNull(col) { qb.whereNull(col); return this; },
      whereNotNull(col) { qb.whereNotNull(col); return this; },
      whereBetween(col, range) { qb.whereBetween(col, range); return this; },
      whereRaw(expr, bindings) { qb.whereRaw(expr, bindings); return this; },
      select(...cols) { qb.select(...cols); return this; },
      join(table, col1, col2, type) { qb.join(table, col1, col2, type); return this; },
      leftJoin(table, col1, col2) { qb.leftJoin(table, col1, col2); return this; },
      rightJoin(table, col1, col2) { qb.rightJoin(table, col1, col2); return this; },
      orderBy(col, dir) { qb.orderBy(col, dir); return this; },
      groupBy(...cols) { qb.groupBy(...cols); return this; },
      limit(n) { qb.limit(n); return this; },
      offset(n) { qb.offset(n); return this; },
      withTrashed() { qb.withTrashed(); return this; },
      onlyTrashed() { qb.onlyTrashed(); return this; },
      hidden(fields) { qb.hidden(fields); return this; },
      sanitize(enabled) { qb.sanitize(enabled); return this; },
      fillable(fields) { qb.fillable(fields); return this; },
      guarded(fields) { qb.guarded(fields); return this; },

      async get() {
        const rows = await qb.get();
        return new Collection(ModelClass._hydrateAll(rows));
      },
      async first() {
        const row = await qb.first();
        return ModelClass._hydrate(row);
      },
      async count() { return qb.count(); },
      async sum(col) { return qb.sum(col); },
      async avg(col) { return qb.avg(col); },
      async max(col) { return qb.max(col); },
      async min(col) { return qb.min(col); },
      async paginate(page, perPage) {
        const result = await qb.paginate(page, perPage);
        result.data = new Collection(ModelClass._hydrateAll(result.data));
        return result;
      },
      async update(data) { return qb.update(data); },
      async delete() { return qb.delete(); },
      async restore() { return qb.restore(); },
      async upsertMany(rows, opts) { return qb.upsertMany(rows, opts); },
    };

    // Local Scopes: auto-proxy scopeXxx static methods as camelCase chainable calls
    const proxy = new Proxy(wrapper, {
      get(target, prop) {
        if (typeof prop !== 'string') return target[prop];
        if (prop in target) return target[prop];
        // e.g. .active() → ModelClass.scopeActive(qb)
        const scopeName = 'scope' + prop[0].toUpperCase() + prop.slice(1);
        if (typeof ModelClass[scopeName] === 'function') {
          return (...args) => {
            ModelClass[scopeName](qb, ...args);
            return proxy;
          };
        }
      },
    });
    return proxy;
  }

  // Instance Methods 

  async save() {
    const ModelClass = this.constructor;
    ModelClass._bootIfNeeded();
    const pk = ModelClass.primaryKey;
    const pkVal = this[pk];

    let data = { ...this };
    delete data._original;
    delete data._attributes;
    delete data._exists;

    if (ModelClass.timestamps) {
      const now = _now();
      if (!this._exists) {
        data.created_at = now;
      }
      data.updated_at = now;
    }

    if (!this._exists || pkVal === undefined || pkVal === null) {
      if (ModelClass.fillable && ModelClass.fillable.length > 0) {
        data = applyFillable(data, ModelClass.fillable);
      }
      if (ModelClass.guarded && ModelClass.guarded.length > 0) {
        data = applyGuarded(data, ModelClass.guarded);
      }
      if (await ModelClass._fire('creating', this) === false) return this;
      const insertId = await ModelClass._query().insert(data);
      this[pk] = insertId;
      this._exists = true;
      await ModelClass._fire('created', this);
      return this;
    }

    let dirty = this.getDirty();
    delete dirty[pk];
    if (Object.keys(dirty).length === 0 && !ModelClass.timestamps) return this;

    if (ModelClass.fillable && ModelClass.fillable.length > 0) {
      dirty = applyFillable(dirty, ModelClass.fillable);
    }
    if (ModelClass.guarded && ModelClass.guarded.length > 0) {
      dirty = applyGuarded(dirty, ModelClass.guarded);
    }
    if (ModelClass.timestamps) {
      dirty.updated_at = _now();
    }
    if (Object.keys(dirty).length === 0) return this;

    if (await ModelClass._fire('updating', this) === false) return this;
    await ModelClass._query().where(pk, pkVal).update(dirty);
    this._original = { ...this._original, ...dirty };
    await ModelClass._fire('updated', this);
    return this;
  }

  async update(data) {
    const ModelClass = this.constructor;
    ModelClass._bootIfNeeded();
    const pk = ModelClass.primaryKey;
    const pkVal = this[pk];
    if (pkVal === undefined || pkVal === null) {
      throw new Error('Cannot call update() on a model instance without a primary key.');
    }
    validateDataObject(data);
    let filtered = { ...data };
    if (ModelClass.fillable && ModelClass.fillable.length > 0) {
      filtered = applyFillable(filtered, ModelClass.fillable);
    }
    if (ModelClass.guarded && ModelClass.guarded.length > 0) {
      filtered = applyGuarded(filtered, ModelClass.guarded);
    }
    if (ModelClass.timestamps) {
      filtered.updated_at = _now();
    }
    if (await ModelClass._fire('updating', this) === false) return this;
    await ModelClass._query().where(pk, pkVal).update(filtered);
    Object.assign(this, filtered);
    await ModelClass._fire('updated', this);
    return this;
  }

  async delete() {
    return this.destroy();
  }

  async fresh() {
    const ModelClass = this.constructor;
    const pk = ModelClass.primaryKey;
    const pkVal = this[pk];
    const row = await ModelClass._query().where(pk, pkVal).first();
    if (!row) return null;
    const casted = _applyCasts(row, ModelClass.casts ?? {});
    Object.assign(this, casted);
    this._original = { ...casted };
    this._attributes = { ...casted };
    return this;
  }

  fill(data) {
    Object.assign(this, data);
    return this;
  }

  getDirty() {
    const dirty = {};
    // Use Reflect.ownKeys to include non-enumerable (hidden) fields — Object.entries skips them
    for (const key of Reflect.ownKeys(this)) {
      if (typeof key !== 'string') continue; // skip symbols
      if (key.startsWith('_')) continue;
      const val = this[key];
      if (!(key in this._original) || this._original[key] !== val) {
        dirty[key] = val;
      }
    }
    return dirty;
  }

  isDirty(...keys) {
    const dirty = this.getDirty();
    if (keys.length === 0) return Object.keys(dirty).length > 0;
    return keys.some((k) => k in dirty);
  }

  isClean(...keys) {
    return !this.isDirty(...keys);
  }

  async destroy() {
    const ModelClass = this.constructor;
    ModelClass._bootIfNeeded();
    const pk = ModelClass.primaryKey;
    const pkVal = this[pk];
    if (pkVal === undefined || pkVal === null) return 0;
    if (await ModelClass._fire('deleting', this) === false) return 0;
    const result = await ModelClass._query().where(pk, pkVal).delete();
    this._exists = false;
    await ModelClass._fire('deleted', this);
    return result;
  }

  async restore() {
    const ModelClass = this.constructor;
    ModelClass._bootIfNeeded();
    if (!ModelClass.softDelete) return 0;
    const pk = ModelClass.primaryKey;
    const pkVal = this[pk];
    if (await ModelClass._fire('restoring', this) === false) return 0;
    const [result] = await execute(
      `UPDATE \`${ModelClass._resolveTable()}\` SET deleted_at = NULL WHERE \`${pk}\` = ?`,
      [pkVal]
    );
    await ModelClass._fire('restored', this);
    return result.affectedRows;
  }

  toJSON() {
    const ModelClass = this.constructor;
    const aliasMap = ModelClass.aliases ?? {};
    const reverseAlias = Object.fromEntries(
      Object.entries(aliasMap).map(([db, alias]) => [db, alias])
    );
    const data = {};
    for (const [key, val] of Object.entries(this)) {
      if (key.startsWith('_')) continue;
      // Skip DB column if an alias exists — will be output under alias key
      if (reverseAlias[key]) continue;
      data[key] = _tryParseJson(val);
    }
    // Output aliased fields under their alias keys
    for (const [dbCol, aliasKey] of Object.entries(aliasMap)) {
      if (dbCol in this) data[aliasKey] = _tryParseJson(this[dbCol]);
    }
    // Include appended computed accessors (getter methods on the instance)
    for (const key of (ModelClass.appends ?? [])) {
      data[key] = typeof this[key] !== 'undefined' ? this[key] : null;
    }
    const casted = _applyCasts(data, ModelClass.casts ?? {});
    // Expand hidden to cover both DB col and alias key names before stripping.
    const aliasMapJ = ModelClass.aliases ?? {};
    const aliasToDbJ = Object.fromEntries(Object.entries(aliasMapJ).map(([db, a]) => [a, db]));
    const hiddenRaw = ModelClass.hidden ?? [];
    const hiddenExpanded = new Set(hiddenRaw);
    for (const field of hiddenRaw) {
      if (aliasMapJ[field]) hiddenExpanded.add(aliasMapJ[field]);   // db col → alias
      if (aliasToDbJ[field]) hiddenExpanded.add(aliasToDbJ[field]); // alias → db col
    }
    // hidden strips at serialization only — internal code still has full access
    return applyHidden(casted, [...hiddenExpanded]);
  }

  getAttribute(key) {
    return this._attributes[key];
  }

  setAttribute(key, value) {
    this._attributes[key] = value;
    this[key] = value;
    return this;
  }

  toArray() {
    return this.toJSON();
  }

  // ── Relationship helpers (instance-method style) ─────────────────────────

  /**
   * Define a has-one relation on an instance.
   * Usage: profile() { return this.hasOne(Profile, 'user_id'); }
   */
  hasOne(RelatedModel, foreignKey, localKey) {
    const ModelClass = this.constructor;
    const fk = foreignKey ?? `${_snakeCase(ModelClass.name)}_id`;
    const lk = localKey ?? ModelClass.primaryKey;
    return new _RelationDescriptor('hasOne', RelatedModel, fk, lk, null, null, this);
  }

  /**
   * Define a has-many relation on an instance.
   * Usage: posts() { return this.hasMany(Post, 'user_id'); }
   */
  hasMany(RelatedModel, foreignKey, localKey) {
    const ModelClass = this.constructor;
    const fk = foreignKey ?? `${_snakeCase(ModelClass.name)}_id`;
    const lk = localKey ?? ModelClass.primaryKey;
    return new _RelationDescriptor('hasMany', RelatedModel, fk, lk, null, null, this);
  }

  /**
   * Define a belongs-to relation on an instance.
   * Usage: author() { return this.belongsTo(User, 'user_id'); }
   */
  belongsTo(RelatedModel, foreignKey, ownerKey) {
    const ModelClass = this.constructor;
    const fk = foreignKey ?? `${_snakeCase(RelatedModel.name)}_id`;
    const ok = ownerKey ?? RelatedModel.primaryKey;
    return new _RelationDescriptor('belongsTo', RelatedModel, fk, ok, null, null, this);
  }

  /**
   * Define a belongs-to-many (pivot) relation on an instance.
   * Usage: roles() { return this.belongsToMany(Role, 'user_roles', 'user_id', 'role_id'); }
   */
  belongsToMany(RelatedModel, pivotTable, localFk, relatedFk) {
    const ModelClass = this.constructor;
    const lfk = localFk ?? `${_snakeCase(ModelClass.name)}_id`;
    const rfk = relatedFk ?? `${_snakeCase(RelatedModel.name)}_id`;
    return new _RelationDescriptor('belongsToMany', RelatedModel, lfk, ModelClass.primaryKey, pivotTable, rfk, this);
  }

  // ── Static helpers (backward-compat) ─────────────────────────────────────

  static hasOne(RelatedModel, foreignKey, localKey) {
    const pk = localKey ?? this.primaryKey;
    return (instance) =>
      RelatedModel.where(foreignKey ?? `${_snakeCase(this.name)}_id`, instance[pk]).first();
  }

  static hasMany(RelatedModel, foreignKey, localKey) {
    const pk = localKey ?? this.primaryKey;
    return (instance) =>
      RelatedModel.where(foreignKey ?? `${_snakeCase(this.name)}_id`, instance[pk]).get();
  }

  static belongsTo(RelatedModel, foreignKey, ownerKey) {
    const fk = foreignKey ?? `${_snakeCase(RelatedModel.name)}_id`;
    const ok = ownerKey ?? RelatedModel.primaryKey;
    return (instance) => RelatedModel.where(ok, instance[fk]).first();
  }

  static belongsToMany(RelatedModel, pivotTable, localFk, relatedFk) {
    const ModelClass = this;
    const localFkCol = localFk ?? `${_snakeCase(ModelClass.name)}_id`;
    const relatedFkCol = relatedFk ?? `${_snakeCase(RelatedModel.name)}_id`;
    return async (instance) => {
      const pk = instance[ModelClass.primaryKey];
      const relatedTable = RelatedModel._resolveTable();
      const sql = `
        SELECT \`${relatedTable}\`.* FROM \`${relatedTable}\`
        INNER JOIN \`${pivotTable}\` ON \`${pivotTable}\`.\`${relatedFkCol}\` = \`${relatedTable}\`.\`${RelatedModel.primaryKey}\`
        WHERE \`${pivotTable}\`.\`${localFkCol}\` = ?
      `;
      const [rows] = await execute(sql, [pk]);
      return RelatedModel._hydrateAll(rows);
    };
  }

  // ── with() — eager loading entry point ──────────────────────────────────

  /**
   * Eager-load relations.
   *
   * Signatures:
   *   Model.with('posts')                         // simple
   *   Model.with('posts', 'profile')              // multiple
   *   Model.with('posts.comments')                // nested
   *   Model.with({ posts: q => q.where(...) })    // constrained
   */
  static with(...relations) {
    const eagerMap = _parseEagerArgs(relations);
    const qb = this._query();
    const ModelClass = this;
    const wrapper = this._wrapQueryBuilder(qb);

    // Override get/first/paginate on the wrapper to inject eager loading
    const origGet = wrapper.get.bind(wrapper);
    const origFirst = wrapper.first.bind(wrapper);
    const origPaginate = wrapper.paginate.bind(wrapper);

    wrapper.get = async () => {
      const collection = await origGet();
      await ModelClass._loadRelations(Array.from(collection), eagerMap);
      return collection;
    };
    wrapper.first = async () => {
      const instance = await origFirst();
      if (instance) await ModelClass._loadRelations([instance], eagerMap);
      return instance;
    };
    wrapper.paginate = async (page, perPage) => {
      const result = await origPaginate(page, perPage);
      await ModelClass._loadRelations(Array.from(result.data), eagerMap);
      return result;
    };

    return wrapper;
  }

  /**
   * Load a named relation on an already-hydrated instance (lazy eager load).
   * await user.load('posts')
   */
  async load(...relations) {
    const ModelClass = this.constructor;
    const eagerMap = _parseEagerArgs(relations);
    await ModelClass._loadRelations([this], eagerMap);
    return this;
  }

  /**
   * Internal: resolve and attach relations for a batch of instances.
   */
  static async _loadRelations(instances, eagerMap) {
    if (!instances.length) return;
    for (const [relationName, constraint] of Object.entries(eagerMap)) {
      const dotIdx = relationName.indexOf('.');
      if (dotIdx !== -1) {
        // Nested: 'posts.comments' — load 'posts' first, then 'comments' on results
        const parent = relationName.slice(0, dotIdx);
        const nested = relationName.slice(dotIdx + 1);
        // load parent first (if not already loaded)
        if (!instances[0]?.[parent]) {
          await this._loadRelations(instances, { [parent]: null });
        }
        // collect nested instances
        const nestedInstances = instances.flatMap((i) => {
          const rel = i[parent];
          return Array.isArray(rel) ? rel : rel ? [rel] : [];
        });
        if (nestedInstances.length) {
          const RelatedModel = nestedInstances[0].constructor;
          await RelatedModel._loadRelations(nestedInstances, { [nested]: null });
        }
        continue;
      }

      // Resolve descriptor by calling the relation method on a dummy instance
      const dummy = new this();
      if (typeof dummy[relationName] !== 'function') {
        throw new Error(`Relation '${relationName}' not found on ${this.name}. Define it as an instance method.`);
      }
      const descriptor = dummy[relationName]();
      descriptor._currentRelationName = relationName;
      await descriptor._eagerLoad(instances, constraint);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// _parseEagerArgs: normalize with() arguments into { relationName: constraintFn|null }
// ─────────────────────────────────────────────────────────────────────────────
function _parseEagerArgs(args) {
  const map = {};
  for (const arg of args) {
    if (typeof arg === 'string') {
      map[arg] = null;
    } else if (arg && typeof arg === 'object') {
      for (const [k, v] of Object.entries(arg)) {
        map[k] = typeof v === 'function' ? v : null;
      }
    }
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// _RelationDescriptor — carries relation metadata + executes batch eager load
// ─────────────────────────────────────────────────────────────────────────────
class _RelationDescriptor {
  constructor(type, RelatedModel, fk, lk, pivotTable, pivotFk, ownerInstance) {
    this.type = type;
    this.RelatedModel = RelatedModel;
    this.fk = fk;   // foreign key on the related side (hasOne/hasMany) or on owner (belongsTo)
    this.lk = lk;   // local key on the owner (PK usually)
    this.pivotTable = pivotTable;
    this.pivotFk = pivotFk;
    this.owner = ownerInstance;
  }

  /** Execute this relation on the owner instance directly (non-eager) */
  async get() {
    const instance = this.owner;
    switch (this.type) {
      case 'hasOne':
        return this.RelatedModel.where(this.fk, instance[this.lk]).first();
      case 'hasMany':
        return this.RelatedModel.where(this.fk, instance[this.lk]).get();
      case 'belongsTo':
        return this.RelatedModel.where(this.lk, instance[this.fk]).first();
      case 'belongsToMany': {
        const { RelatedModel, fk, lk, pivotTable, pivotFk } = this;
        const pkVal = instance[lk];
        const relatedTable = RelatedModel._resolveTable();
        const sql = `SELECT \`${relatedTable}\`.* FROM \`${relatedTable}\`
          INNER JOIN \`${pivotTable}\` ON \`${pivotTable}\`.\`${pivotFk}\` = \`${relatedTable}\`.\`${RelatedModel.primaryKey}\`
          WHERE \`${pivotTable}\`.\`${fk}\` = ?`;
        const [rows] = await execute(sql, [pkVal]);
        return RelatedModel._hydrateAll(rows);
      }
    }
  }

  /**
   * Batch eager-load this relation for an array of parent instances.
   * Attaches results directly onto each instance under the relation name.
   */
  async _eagerLoad(instances, constraint) {
    const { type, RelatedModel, fk, lk, pivotTable, pivotFk } = this;

    // Infer the property name from calling context — passed by _loadRelations
    // We derive it lazily by inspecting what key each instance will receive.
    // The key is set by the caller after this returns.

    if (type === 'hasOne' || type === 'hasMany') {
      const parentKeys = [...new Set(instances.map((i) => i[lk]).filter((v) => v != null))];
      if (!parentKeys.length) return;

      let qb = RelatedModel._query().whereIn(fk, parentKeys);
      if (constraint) constraint(qb);

      const related = RelatedModel._hydrateAll(await qb.get());
      const grouped = {};
      for (const r of related) {
        const key = r[fk];
        if (type === 'hasMany') {
          if (!grouped[key]) grouped[key] = new Collection();
          grouped[key].push(r);
        } else {
          grouped[key] = r;
        }
      }
      for (const inst of instances) {
        inst._relData = inst._relData ?? {};
        const val = grouped[inst[lk]] ?? (type === 'hasMany' ? new Collection() : null);
        inst._relData[this._currentRelationName] = val;
        inst[this._currentRelationName] = val;
      }

    } else if (type === 'belongsTo') {
      const fkVals = [...new Set(instances.map((i) => i[fk]).filter((v) => v != null))];
      if (!fkVals.length) return;

      let qb = RelatedModel._query().whereIn(lk, fkVals);
      if (constraint) constraint(qb);

      const related = RelatedModel._hydrateAll(await qb.get());
      const byKey = {};
      for (const r of related) byKey[r[lk]] = r;

      for (const inst of instances) {
        inst._relData = inst._relData ?? {};
        const val = byKey[inst[fk]] ?? null;
        inst._relData[this._currentRelationName] = val;
        inst[this._currentRelationName] = val;
      }

    } else if (type === 'belongsToMany') {
      const parentKeys = [...new Set(instances.map((i) => i[lk]).filter((v) => v != null))];
      if (!parentKeys.length) return;

      const relatedTable = RelatedModel._resolveTable();
      const inPlaceholders = parentKeys.map(() => '?').join(', ');
      let sql = `SELECT \`${relatedTable}\`.*, \`${pivotTable}\`.\`${fk}\` AS __pivot_fk
        FROM \`${relatedTable}\`
        INNER JOIN \`${pivotTable}\`
          ON \`${pivotTable}\`.\`${pivotFk}\` = \`${relatedTable}\`.\`${RelatedModel.primaryKey}\`
        WHERE \`${pivotTable}\`.\`${fk}\` IN (${inPlaceholders})`;

      const [rows] = await execute(sql, parentKeys);
      const grouped = {};
      for (const row of rows) {
        const key = row.__pivot_fk;
        delete row.__pivot_fk;
        if (!grouped[key]) grouped[key] = new Collection();
        grouped[key].push(RelatedModel._hydrate(row));
      }
      for (const inst of instances) {
        const val = grouped[inst[lk]] ?? new Collection();
        inst._relData = inst._relData ?? {};
        inst._relData[this._currentRelationName] = val;
        inst[this._currentRelationName] = val;
      }
    }
  }
}

/**
 * Collection — a fluent wrapper around an array of Model instances.
 * Returned by .get() and .paginate().
 * Extends Array so all native array methods work (forEach, map, filter, etc.)
 */
export class Collection extends Array {
  constructor(items = []) {
    // When called internally by native Array methods (filter, map, slice),
    // items may be a number (the length). Guard against that.
    if (typeof items === 'number') {
      super(items);
    } else {
      super(...items);
    }
  }

  // Ensure native array methods (filter, map, slice) return plain Array, not Collection
  // so we avoid the constructor(number) issue from Array species re-use.
  static get [Symbol.species]() { return Array; }

  /** Extract a single column from all items */
  pluck(key) {
    return Array.from(this, (item) => item[key]);
  }

  /** Group items into an object keyed by a column value */
  groupBy(key) {
    const result = {};
    for (const item of this) {
      const k = item[key];
      if (!(k in result)) result[k] = new Collection();
      result[k].push(item);
    }
    return result;
  }

  /** Key items into an object — one item per unique key value */
  keyBy(key) {
    const result = {};
    for (const item of this) result[item[key]] = item;
    return result;
  }

  /** Return first item, or null */
  first() {
    return this[0] ?? null;
  }

  /** Return last item, or null */
  last() {
    return this[this.length - 1] ?? null;
  }

  /** Chunk into arrays of size n */
  chunk(size) {
    const chunks = [];
    for (let i = 0; i < this.length; i += size) {
      chunks.push(new Collection(this.slice(i, i + size)));
    }
    return chunks;
  }

  /** Return unique items by column */
  unique(key) {
    if (!key) return new Collection([...new Set(this)]);
    const seen = new Set();
    return new Collection(Array.from(this).filter((item) => {
      const v = item[key];
      if (seen.has(v)) return false;
      seen.add(v);
      return true;
    }));
  }

  /** Sum a numeric column */
  sum(key) {
    return Array.from(this).reduce((acc, item) => acc + (Number(item[key]) || 0), 0);
  }

  /** Count — alias for .length */
  count() {
    return this.length;
  }

  /** Convert to plain array of toJSON() objects */
  toArray() {
    return Array.from(this, (item) => (typeof item.toJSON === 'function' ? item.toJSON() : item));
  }

  toJSON() {
    return this.toArray();
  }
}

function _tryParseJson(val) {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try { return JSON.parse(trimmed); } catch { return val; }
  }
  return val;
}

function _applyCasts(row, casts) {
  if (!casts || Object.keys(casts).length === 0) return row;
  const result = { ...row };
  for (const [key, type] of Object.entries(casts)) {
    if (!(key in result) || result[key] === null || result[key] === undefined) continue;
    const val = result[key];
    switch (type) {
      case 'integer':
      case 'int':
        result[key] = parseInt(val, 10);
        break;
      case 'float':
      case 'double':
      case 'decimal':
        result[key] = parseFloat(val);
        break;
      case 'boolean':
      case 'bool':
        result[key] = Boolean(Number(val));
        break;
      case 'string':
        result[key] = String(val);
        break;
      case 'json':
      case 'array':
      case 'object':
        result[key] = typeof val === 'string' ? JSON.parse(val) : val;
        break;
      case 'date':
        result[key] = new Date(val).toISOString().slice(0, 10);
        break;
      case 'datetime':
        result[key] = new Date(val).toISOString().slice(0, 19).replace('T', ' ');
        break;
      default:
        break;
    }
  }
  return result;
}

function _now() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function _snakeCase(str) {
  return str
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}

function _keysToSnake(obj) {
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    result[_snakeCase(k)] = v;
  }
  return result;
}
