import { execute, getConfig, transaction as _transaction, listen as _listen, clearListeners as _clearListeners } from './connection.js';
import {
  validateIdentifier,
  validateIdentifiers,
  validateDataObject,
  applyFillable,
  applyGuarded,
  applyHidden,
  sanitizeOutput,
  MysqlifySecurityError,
} from './security.js';

function toMysqlDatetime(val) {
  const d = val instanceof Date ? val : new Date(val);
  if (isNaN(d.getTime())) return null;
  // Use local time parts — mysql2 driver interprets DATETIME strings as local time.
  // toISOString() returns UTC which causes timezone offset errors when MySQL server
  // is not in UTC (e.g. storing '2026-05-13 23:35:57' when source was UTC+7 22:35:57).
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

// Matches ISO 8601: 2026-05-13T02:04:24.604Z or 2026-05-13T02:04:24+07:00
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function serializeValues(data) {
  const result = {};
  for (const key of Object.keys(data)) {
    const val = data[key];
    if (val instanceof Date) {
      // Native Date → MySQL DATETIME
      result[key] = toMysqlDatetime(val);
    } else if (typeof val === 'string' && ISO_DATE_RE.test(val)) {
      // ISO 8601 string → MySQL DATETIME
      result[key] = toMysqlDatetime(val);
    } else if (val !== null && typeof val === 'object') {
      // Plain objects + Arrays → JSON string
      result[key] = JSON.stringify(val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

export class QueryBuilder {
  constructor() {
    this._table = null;
    this._selects = [];
    this._wheres = [];
    this._orWheres = [];
    this._joins = [];
    this._orderBys = [];
    this._groupBys = [];
    this._havings = [];
    this._limitVal = null;
    this._offsetVal = null;
    this._bindings = [];
    this._fillable = null;
    this._guarded = null;
    this._hidden = null;
    this._sanitize = null;
    this._softDeleteCol = null;
    this._includeTrashed = false;
    this._onlyTrashed = false;
    this._conn = null;
  }

  _useConnection(conn) {
    this._conn = conn;
    return this;
  }

  // Table 

  table(name) {
    validateIdentifier(name, 'table name');
    this._table = name;
    return this;
  }

  from(name) {
    return this.table(name);
  }

  // Select 

  select(...columns) {
    if (columns.length === 1 && Array.isArray(columns[0])) {
      columns = columns[0];
    }
    // Validate columns, supporting 'table.*', 'column AS alias', and functions
    for (const col of columns) {
      if (col === '*') continue;  // SELECT *
      if (col.includes('(')) continue;  // Function call like COUNT(*)
      
      // Handle 'column AS alias' or 'column as alias'
      const asMatch = col.match(/^(.+?)\s+(?:AS|as)\s+(.+)$/);
      if (asMatch) {
        const baseCol = asMatch[1].trim();
        // Validate base column (e.g. 'users.id' or 'id')
        if (baseCol !== '*' && !baseCol.endsWith('.*')) {
          validateIdentifier(baseCol, 'column');
        } else if (baseCol.endsWith('.*')) {
          // Validate 'table.*' → validate 'table' part
          const tablePart = baseCol.slice(0, -2);
          validateIdentifier(tablePart, 'table');
        }
        continue;
      }
      
      // Handle 'table.*'
      if (col.endsWith('.*')) {
        const tablePart = col.slice(0, -2);
        validateIdentifier(tablePart, 'table');
        continue;
      }
      
      // Regular column
      validateIdentifier(col, 'column');
    }
    this._selects.push(...columns);
    return this;
  }

  // Where 

  where(column, operatorOrValue, value) {
    const config = getConfig();
    if (this._wheres.length + this._orWheres.length >= config.maxConditions) {
      throw new MysqlifySecurityError(
        `Query complexity limit reached (maxConditions: ${config.maxConditions}).`
      );
    }
    const { col, op, val } = this._parseWhere(column, operatorOrValue, value);
    this._wheres.push({ col, op, val });
    return this;
  }

  orWhere(column, operatorOrValue, value) {
    const { col, op, val } = this._parseWhere(column, operatorOrValue, value);
    this._orWheres.push({ col, op, val, type: 'OR' });
    return this;
  }

  whereIn(column, values) {
    validateIdentifier(column, 'column');
    if (!Array.isArray(values) || values.length === 0) {
      throw new MysqlifySecurityError('whereIn requires a non-empty array of values.');
    }
    this._wheres.push({ col: column, op: 'IN', val: values });
    return this;
  }

  whereNotIn(column, values) {
    validateIdentifier(column, 'column');
    if (!Array.isArray(values) || values.length === 0) {
      throw new MysqlifySecurityError('whereNotIn requires a non-empty array of values.');
    }
    this._wheres.push({ col: column, op: 'NOT IN', val: values });
    return this;
  }

  whereNull(column) {
    validateIdentifier(column, 'column');
    this._wheres.push({ col: column, op: 'IS NULL', val: null });
    return this;
  }

  whereNotNull(column) {
    validateIdentifier(column, 'column');
    this._wheres.push({ col: column, op: 'IS NOT NULL', val: null });
    return this;
  }

  whereBetween(column, [min, max]) {
    validateIdentifier(column, 'column');
    this._wheres.push({ col: column, op: 'BETWEEN', val: [min, max] });
    return this;
  }

  whereRaw(expression, bindings = []) {
    this._wheres.push({ raw: expression, rawBindings: bindings, op: 'RAW' });
    return this;
  }

  selectRaw(expression) {
    this._selects.push({ raw: expression });
    return this;
  }

  _parseWhere(column, operatorOrValue, value) {
    validateIdentifier(column, 'column');
    let op = '=';
    let val = operatorOrValue;
    if (value !== undefined) {
      op = String(operatorOrValue).toUpperCase();
      val = value;
      const allowed = ['=', '!=', '<>', '<', '>', '<=', '>=', 'LIKE', 'NOT LIKE'];
      if (!allowed.includes(op)) {
        throw new MysqlifySecurityError(`Operator "${op}" is not allowed.`);
      }
    }
    return { col: column, op, val };
  }

  // Joins 

  join(table, col1, col2, type = 'INNER') {
    validateIdentifier(table, 'table name');
    validateIdentifier(col1, 'column');
    validateIdentifier(col2, 'column');
    this._joins.push({ table, col1, col2, type: type.toUpperCase() });
    return this;
  }

  leftJoin(table, col1, col2) {
    return this.join(table, col1, col2, 'LEFT');
  }

  rightJoin(table, col1, col2) {
    return this.join(table, col1, col2, 'RIGHT');
  }

  // Order / Group / Having 

  orderBy(column, direction = 'ASC') {
    validateIdentifier(column, 'column');
    const dir = direction.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    this._orderBys.push({ column, dir });
    return this;
  }

  groupBy(...columns) {
    validateIdentifiers(columns, 'column');
    this._groupBys.push(...columns);
    return this;
  }

  having(column, operatorOrValue, value) {
    const { col, op, val } = this._parseWhere(column, operatorOrValue, value);
    this._havings.push({ col, op, val });
    return this;
  }

  // Limit / Offset 

  limit(n) {
    this._limitVal = parseInt(n, 10);
    return this;
  }

  offset(n) {
    this._offsetVal = parseInt(n, 10);
    return this;
  }

  // Security helpers 

  fillable(fields) {
    this._fillable = fields;
    return this;
  }

  guarded(fields) {
    this._guarded = fields;
    return this;
  }

  hidden(fields) {
    this._hidden = fields;
    return this;
  }

  sanitize(enabled = true) {
    this._sanitize = enabled;
    return this;
  }

  // Build SQL 

  _buildSelect() {
    const cols = this._selects.length > 0
      ? this._selects.map((c) => (typeof c === 'object' && c.raw ? c.raw : c)).join(', ')
      : '*';
    let sql = `SELECT ${cols} FROM \`${this._table}\``;
    const params = [];

    for (const j of this._joins) {
      // Wrap table.column properly: users.id → `users`.`id`
      const wrapCol = (col) => {
        if (col.includes('.')) {
          const parts = col.split('.');
          return parts.map(p => `\`${p}\``).join('.');
        }
        return `\`${col}\``;
      };
      sql += ` ${j.type} JOIN \`${j.table}\` ON ${wrapCol(j.col1)} = ${wrapCol(j.col2)}`;
    }

    const { whereClause, whereParams } = this._buildWhere();
    if (whereClause) {
      sql += ` WHERE ${whereClause}`;
      params.push(...whereParams);
    }

    if (this._groupBys.length > 0) {
      sql += ` GROUP BY ${this._groupBys.map((c) => `\`${c}\``).join(', ')}`;
    }

    if (this._havings.length > 0) {
      const { whereClause: hClause, whereParams: hParams } = this._buildConditions(this._havings);
      sql += ` HAVING ${hClause}`;
      params.push(...hParams);
    }

    if (this._orderBys.length > 0) {
      sql += ` ORDER BY ${this._orderBys.map((o) => `\`${o.column}\` ${o.dir}`).join(', ')}`;
    }

    if (this._limitVal !== null) {
      sql += ` LIMIT ${this._limitVal}`;
    }

    if (this._offsetVal !== null) {
      sql += ` OFFSET ${this._offsetVal}`;
    }

    return { sql, params };
  }

  _buildWhere() {
    const all = [];

    for (const w of this._wheres) {
      all.push({ ...w, type: 'AND' });
    }
    for (const w of this._orWheres) {
      all.push(w);
    }

    if (this._softDeleteCol && !this._includeTrashed && !this._onlyTrashed) {
      all.push({ col: this._softDeleteCol, op: 'IS NULL', val: null, type: 'AND' });
    }
    if (this._onlyTrashed) {
      all.push({ col: this._softDeleteCol, op: 'IS NOT NULL', val: null, type: 'AND' });
    }

    return this._buildConditions(all);
  }

  _buildConditions(conditions) {
    if (conditions.length === 0) return { whereClause: '', whereParams: [] };

    const parts = [];
    const params = [];

    for (let i = 0; i < conditions.length; i++) {
      const { col, op, val, type } = conditions[i];
      const prefix = i === 0 ? '' : ` ${type || 'AND'} `;

      if (op === 'RAW') {
        parts.push(`${prefix}${conditions[i].raw}`);
        params.push(...(conditions[i].rawBindings ?? []));
      } else if (op === 'IS NULL' || op === 'IS NOT NULL') {
        parts.push(`${prefix}\`${col}\` ${op}`);
      } else if (op === 'IN' || op === 'NOT IN') {
        const placeholders = val.map(() => '?').join(', ');
        parts.push(`${prefix}\`${col}\` ${op} (${placeholders})`);
        params.push(...val);
      } else if (op === 'BETWEEN') {
        parts.push(`${prefix}\`${col}\` BETWEEN ? AND ?`);
        params.push(val[0], val[1]);
      } else {
        parts.push(`${prefix}\`${col}\` ${op} ?`);
        params.push(val);
      }
    }

    return { whereClause: parts.join(''), whereParams: params };
  }

  // Execute helpers 

  _shouldSanitize() {
    if (this._sanitize !== null) return this._sanitize;
    return getConfig().sanitize ?? false;
  }

  _postProcess(rows) {
    let data = rows;
    if (this._hidden) {
      data = applyHidden(data, this._hidden);
    }
    if (this._shouldSanitize()) {
      data = sanitizeOutput(data);
    }
    return data;
  }

  // Terminal Methods 

  async get() {
    const { sql, params } = this._buildSelect();
    const [rows] = await execute(sql, params, this._conn);
    return this._postProcess(rows);
  }

  async first() {
    this.limit(1);
    const rows = await this.get();
    return rows[0] ?? null;
  }

  async find(id) {
    const pk = 'id';
    return this.where(pk, id).first();
  }

  async count() {
    this._selects = ['COUNT(*) as aggregate'];
    const { sql, params } = this._buildSelect();
    const [rows] = await execute(sql, params, this._conn);
    return Number(rows[0]?.aggregate ?? 0);
  }

  async sum(column) {
    validateIdentifier(column, 'column');
    this._selects = [`SUM(\`${column}\`) as aggregate`];
    const { sql, params } = this._buildSelect();
    const [rows] = await execute(sql, params, this._conn);
    return Number(rows[0]?.aggregate ?? 0);
  }

  async avg(column) {
    validateIdentifier(column, 'column');
    this._selects = [`AVG(\`${column}\`) as aggregate`];
    const { sql, params } = this._buildSelect();
    const [rows] = await execute(sql, params, this._conn);
    return Number(rows[0]?.aggregate ?? 0);
  }

  async max(column) {
    validateIdentifier(column, 'column');
    this._selects = [`MAX(\`${column}\`) as aggregate`];
    const { sql, params } = this._buildSelect();
    const [rows] = await execute(sql, params, this._conn);
    return rows[0]?.aggregate ?? null;
  }

  async min(column) {
    validateIdentifier(column, 'column');
    this._selects = [`MIN(\`${column}\`) as aggregate`];
    const { sql, params } = this._buildSelect();
    const [rows] = await execute(sql, params, this._conn);
    return rows[0]?.aggregate ?? null;
  }

  async paginate(page = 1, perPage = 15) {
    const offset = (page - 1) * perPage;
    const countBuilder = this._clone();
    const total = await countBuilder.count();

    this.limit(perPage).offset(offset);
    const data = await this.get();

    return {
      data,
      total,
      page,
      perPage,
      lastPage: Math.ceil(total / perPage),
    };
  }

  async insert(data) {
    validateDataObject(data);
    let filtered = data;
    if (this._fillable) filtered = applyFillable(filtered, this._fillable);
    if (this._guarded) filtered = applyGuarded(filtered, this._guarded);

    const keys = Object.keys(filtered);
    if (keys.length === 0) {
      throw new MysqlifySecurityError('No data to insert after fillable/guarded filtering.');
    }
    validateIdentifiers(keys, 'column');

    const serialized = serializeValues(filtered);
    const cols = keys.map((k) => `\`${k}\``).join(', ');
    const placeholders = keys.map(() => '?').join(', ');
    const values = keys.map((k) => serialized[k]);

    const sql = `INSERT INTO \`${this._table}\` (${cols}) VALUES (${placeholders})`;
    const [result] = await execute(sql, values, this._conn);
    return result.insertId;
  }

  async upsert(data, updateKeysOrOptions) {
    validateDataObject(data);
    const allKeys = Object.keys(data);

    let updateKeys;

    if (Array.isArray(updateKeysOrOptions)) {
      // Legacy: upsert(data, ['col1', 'col2'])
      updateKeys = updateKeysOrOptions;
      if (updateKeys.length === 0) {
        throw new MysqlifySecurityError('upsert requires a non-empty array of columns to update on conflict.');
      }
    } else if (updateKeysOrOptions && typeof updateKeysOrOptions === 'object') {
      // Options-style: upsert(data, { conflictFields?, update? })
      const { conflictFields = [], update } = updateKeysOrOptions;
      if (update && Array.isArray(update) && update.length > 0) {
        updateKeys = update;
      } else {
        // Auto: update all columns except conflictFields
        updateKeys = allKeys.filter((k) => !conflictFields.includes(k));
      }
      if (updateKeys.length === 0) {
        throw new MysqlifySecurityError('upsert: no columns to update after excluding conflictFields.');
      }
    } else {
      throw new MysqlifySecurityError('upsert requires updateKeys array or options object as second argument.');
    }

    validateIdentifiers(allKeys, 'column');
    validateIdentifiers(updateKeys, 'column');

    const serialized = serializeValues(data);
    const cols = allKeys.map((k) => `\`${k}\``).join(', ');
    const placeholders = allKeys.map(() => '?').join(', ');
    const values = allKeys.map((k) => serialized[k]);
    const onDuplicate = updateKeys.map((k) => `\`${k}\` = VALUES(\`${k}\`)`).join(', ');

    const sql = `INSERT INTO \`${this._table}\` (${cols}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${onDuplicate}`;
    const [result] = await execute(sql, values, this._conn);
    return { insertId: result.insertId, affectedRows: result.affectedRows };
  }

  async insertMany(rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new MysqlifySecurityError('insertMany requires a non-empty array of objects.');
    }
    rows.forEach((r) => validateDataObject(r));

    const keys = Object.keys(rows[0]);
    if (keys.length === 0) throw new MysqlifySecurityError('No columns to insert.');
    validateIdentifiers(keys, 'column');

    const cols = keys.map((k) => `\`${k}\``).join(', ');
    const rowPlaceholders = keys.map(() => '?').join(', ');
    const placeholders = rows.map(() => `(${rowPlaceholders})`).join(', ');
    const values = rows.flatMap((r) => {
      const serialized = serializeValues(r);
      return keys.map((k) => serialized[k] ?? null);
    });

    const sql = `INSERT INTO \`${this._table}\` (${cols}) VALUES ${placeholders}`;
    const [result] = await execute(sql, values, this._conn);
    return result.affectedRows;
  }

  async upsertMany(rows, updateKeysOrOptions) {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new MysqlifySecurityError('upsertMany requires a non-empty array of objects.');
    }
    rows.forEach((r) => validateDataObject(r));

    const keys = Object.keys(rows[0]);
    if (keys.length === 0) throw new MysqlifySecurityError('No columns to upsert.');
    validateIdentifiers(keys, 'column');

    // Resolve updateKeys — accept array or options object { conflictFields?, update? }
    let updateKeys;
    if (Array.isArray(updateKeysOrOptions)) {
      updateKeys = updateKeysOrOptions;
    } else if (updateKeysOrOptions && typeof updateKeysOrOptions === 'object') {
      const { conflictFields = [], update } = updateKeysOrOptions;
      updateKeys = (update && update.length > 0)
        ? update
        : keys.filter((k) => !conflictFields.includes(k));
    } else {
      throw new MysqlifySecurityError(
        'upsertMany requires an updateKeys array or options object ({ conflictFields?, update? }) as second argument.'
      );
    }

    if (updateKeys.length === 0) {
      throw new MysqlifySecurityError('upsertMany: no columns to update after excluding conflictFields.');
    }
    validateIdentifiers(updateKeys, 'column');

    const cols = keys.map((k) => `\`${k}\``).join(', ');
    const rowPlaceholders = keys.map(() => '?').join(', ');
    const placeholders = rows.map(() => `(${rowPlaceholders})`).join(', ');
    const values = rows.flatMap((r) => {
      const serialized = serializeValues(r);
      return keys.map((k) => serialized[k] ?? null);
    });
    const onDuplicate = updateKeys.map((k) => `\`${k}\` = VALUES(\`${k}\`)`).join(', ');

    const sql = `INSERT INTO \`${this._table}\` (${cols}) VALUES ${placeholders} ON DUPLICATE KEY UPDATE ${onDuplicate}`;
    const [result] = await execute(sql, values, this._conn);
    return { affectedRows: result.affectedRows };
  }

  async update(data) {
    validateDataObject(data);
    let filtered = data;
    if (this._fillable) filtered = applyFillable(filtered, this._fillable);
    if (this._guarded) filtered = applyGuarded(filtered, this._guarded);

    const keys = Object.keys(filtered);
    if (keys.length === 0) {
      throw new MysqlifySecurityError('No data to update after fillable/guarded filtering.');
    }
    validateIdentifiers(keys, 'column');

    const serialized = serializeValues(filtered);
    const setClause = keys.map((k) => `\`${k}\` = ?`).join(', ');
    const values = keys.map((k) => serialized[k]);

    const { whereClause, whereParams } = this._buildWhere();
    let sql = `UPDATE \`${this._table}\` SET ${setClause}`;
    if (whereClause) {
      sql += ` WHERE ${whereClause}`;
      values.push(...whereParams);
    }

    const [result] = await execute(sql, values, this._conn);
    return result.affectedRows;
  }

  async delete() {
    if (this._softDeleteCol) {
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      return this.update({ [this._softDeleteCol]: now });
    }
    const { whereClause, whereParams } = this._buildWhere();
    let sql = `DELETE FROM \`${this._table}\``;
    if (whereClause) {
      sql += ` WHERE ${whereClause}`;
    }
    const [result] = await execute(sql, whereParams, this._conn);
    return result.affectedRows;
  }

  async restore() {
    if (!this._softDeleteCol) return 0;
    return this._clone()
      .table(this._table)
      ._copyFilters(this)
      .update({ [this._softDeleteCol]: null });
  }

  async increment(column, amount = 1) {
    validateIdentifier(column, 'column');
    const { whereClause, whereParams } = this._buildWhere();
    let sql = `UPDATE \`${this._table}\` SET \`${column}\` = \`${column}\` + ?`;
    const values = [amount];
    if (whereClause) { sql += ` WHERE ${whereClause}`; values.push(...whereParams); }
    const [result] = await execute(sql, values, this._conn);
    return result.affectedRows;
  }

  async decrement(column, amount = 1) {
    validateIdentifier(column, 'column');
    const { whereClause, whereParams } = this._buildWhere();
    let sql = `UPDATE \`${this._table}\` SET \`${column}\` = \`${column}\` - ?`;
    const values = [amount];
    if (whereClause) { sql += ` WHERE ${whereClause}`; values.push(...whereParams); }
    const [result] = await execute(sql, values, this._conn);
    return result.affectedRows;
  }

  toSQL() {
    const { sql, params } = this._buildSelect();
    return { sql, params };
  }

  withTrashed() {
    this._includeTrashed = true;
    return this;
  }

  onlyTrashed() {
    this._onlyTrashed = true;
    return this;
  }

  _setSoftDelete(col) {
    this._softDeleteCol = col;
    return this;
  }

  // Clone helper 

  _clone() {
    const qb = new QueryBuilder();
    qb._table = this._table;
    qb._selects = [...this._selects];
    qb._wheres = [...this._wheres];
    qb._orWheres = [...this._orWheres];
    qb._joins = [...this._joins];
    qb._orderBys = [...this._orderBys];
    qb._groupBys = [...this._groupBys];
    qb._havings = [...this._havings];
    qb._limitVal = this._limitVal;
    qb._offsetVal = this._offsetVal;
    qb._fillable = this._fillable;
    qb._guarded = this._guarded;
    qb._hidden = this._hidden;
    qb._sanitize = this._sanitize;
    qb._softDeleteCol = this._softDeleteCol;
    return qb;
  }

  _copyFilters(source) {
    this._wheres = [...source._wheres];
    this._orWheres = [...source._orWheres];
    return this;
  }
}

/**
 * DB facade — entry point for all queries.
 */
export const DB = {
  table(name) {
    return new QueryBuilder().table(name);
  },

  from(name) {
    return new QueryBuilder().table(name);
  },

  async raw(sql, bindings = []) {
    if (!Array.isArray(bindings)) {
      throw new MysqlifySecurityError(
        'DB.raw() requires bindings to be an array. Never pass raw user input as the SQL string.'
      );
    }
    const [rows] = await execute(sql, bindings);
    return rows;
  },

  /**
   * Register a listener that fires after every executed query.
   * @param {(info: { sql: string, params: any[], time: number }) => void} fn
   */
  listen(fn) {
    _listen(fn);
    return this;
  },

  /**
   * Remove all registered query listeners.
   */
  clearListeners() {
    _clearListeners();
    return this;
  },

  async transaction(callback) {
    return _transaction(async (trx) => {
      const trxDB = {
        table(name) {
          return new QueryBuilder().table(name)._useConnection(trx._conn);
        },
        from(name) {
          return new QueryBuilder().table(name)._useConnection(trx._conn);
        },
        model(ModelClass) {
          return ModelClass._withConnection(trx._conn);
        },
        async raw(sql, bindings = []) {
          if (!Array.isArray(bindings)) {
            throw new MysqlifySecurityError(
              'DB.raw() requires bindings to be an array. Never pass raw user input as the SQL string.'
            );
          }
          const [rows] = await trx.execute(sql, bindings);
          return rows;
        },
        execute: trx.execute,
      };
      return callback(trxDB);
    });
  },
};
