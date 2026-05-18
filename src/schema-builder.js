import { execute } from './connection.js';
import { validateIdentifier } from './security.js';

/**
 * Column definition builder - used inside schema.create() callbacks.
 */
class ColumnDefinition {
  constructor(name, type) {
    this._name = name;
    this._type = type;
    this._nullable = true;
    this._defaultVal = undefined;
    this._unsigned = false;
    this._unique = false;
    this._index = false;
    this._primary = false;
    this._autoIncrement = false;
    this._references = null;  // { column, table, onDelete, onUpdate }
    this._comment = null;
    this._change = false;
  }

  nullable() {
    this._nullable = true;
    return this;
  }

  notNullable() {
    this._nullable = false;
    return this;
  }

  default(val) {
    this._defaultVal = val;
    return this;
  }

  unsigned() {
    this._unsigned = true;
    return this;
  }

  unique() {
    this._unique = true;
    return this;
  }

  index() {
    this._index = true;
    return this;
  }

  references(column, onTable) {
    validateIdentifier(column, 'column');
    if (onTable) validateIdentifier(onTable, 'table');
    this._references = {
      column,
      table: onTable ?? null,
      onDelete: 'RESTRICT',
      onUpdate: 'RESTRICT',
    };
    return this;
  }

  inTable(tableName) {
    validateIdentifier(tableName, 'table');
    if (!this._references) {
      throw new Error('.inTable() must be called after .references()');
    }
    this._references.table = tableName;
    return this;
  }

  onDelete(action) {
    if (!this._references) {
      throw new Error('.onDelete() must be called after .references()');
    }
    this._references.onDelete = action.toUpperCase();
    return this;
  }

  onUpdate(action) {
    if (!this._references) {
      throw new Error('.onUpdate() must be called after .references()');
    }
    this._references.onUpdate = action.toUpperCase();
    return this;
  }

  comment(text) {
    this._comment = text;
    return this;
  }

  change() {
    this._change = true;
    return this;
  }

  _toSQL() {
    let sql = `\`${this._name}\` ${this._type}`;
    const isNumeric = /^(INT|BIGINT|TINYINT|SMALLINT|MEDIUMINT|FLOAT|DOUBLE|DECIMAL)/i.test(this._type);
    if (this._unsigned && isNumeric) sql += ' UNSIGNED';
    if (!this._nullable) {
      sql += ' NOT NULL';
    } else {
      sql += ' NULL';
    }
    if (this._autoIncrement) sql += ' AUTO_INCREMENT';
    if (this._defaultVal !== undefined) {
      const isSqlExpression = typeof this._defaultVal === 'string' &&
        /^(CURRENT_TIMESTAMP|CURRENT_TIMESTAMP\(\)|NOW\(\)|CURRENT_DATE|CURRENT_TIME|CURRENT_USER)/i.test(this._defaultVal);
      const val = isSqlExpression
        ? this._defaultVal
        : typeof this._defaultVal === 'string'
          ? `'${this._defaultVal.replace(/'/g, "\\'")}'`
          : this._defaultVal === null
            ? 'NULL'
            : this._defaultVal === true
              ? '1'
              : this._defaultVal === false
                ? '0'
                : this._defaultVal;
      sql += ` DEFAULT ${val}`;
    }
    if (this._comment) {
      sql += ` COMMENT '${this._comment.replace(/'/g, "\\'")}'`;
    }
    return sql;
  }
}

/**
 * Blueprint - table schema definition collector.
 */
class Blueprint {
  constructor(tableName) {
    this._tableName = tableName;
    this._columns = [];
    this._primaries = [];
    this._uniques = [];
    this._indexes = [];
    this._foreignKeys = [];
    this._dropColumns = [];
    this._renameColumns = [];
  }

  id(name = 'id') {
    validateIdentifier(name, 'column');
    const col = new ColumnDefinition(name, 'BIGINT(20)');
    col._unsigned = true;
    col._autoIncrement = true;
    col._primary = true;
    col._nullable = false;
    this._columns.push(col);
    this._primaries.push(name);
    return col;
  }

  string(name, length = 255) {
    validateIdentifier(name, 'column');
    const col = new ColumnDefinition(name, `VARCHAR(${length})`);
    this._columns.push(col);
    return col;
  }

  text(name) {
    validateIdentifier(name, 'column');
    const col = new ColumnDefinition(name, 'TEXT');
    this._columns.push(col);
    return col;
  }

  longText(name) {
    validateIdentifier(name, 'column');
    const col = new ColumnDefinition(name, 'LONGTEXT');
    this._columns.push(col);
    return col;
  }

  integer(name, length = 11) {
    validateIdentifier(name, 'column');
    const col = new ColumnDefinition(name, `INT(${length})`);
    this._columns.push(col);
    return col;
  }

  bigInteger(name) {
    validateIdentifier(name, 'column');
    const col = new ColumnDefinition(name, 'BIGINT(20)');
    this._columns.push(col);
    return col;
  }

  tinyInteger(name) {
    validateIdentifier(name, 'column');
    const col = new ColumnDefinition(name, 'TINYINT(4)');
    this._columns.push(col);
    return col;
  }

  boolean(name) {
    validateIdentifier(name, 'column');
    const col = new ColumnDefinition(name, 'TINYINT(1)');
    this._columns.push(col);
    return col;
  }

  decimal(name, precision = 8, scale = 2) {
    validateIdentifier(name, 'column');
    const col = new ColumnDefinition(name, `DECIMAL(${precision},${scale})`);
    this._columns.push(col);
    return col;
  }

  float(name, precision = 8, scale = 2) {
    validateIdentifier(name, 'column');
    const col = new ColumnDefinition(name, `FLOAT(${precision},${scale})`);
    this._columns.push(col);
    return col;
  }

  double(name) {
    validateIdentifier(name, 'column');
    const col = new ColumnDefinition(name, 'DOUBLE');
    this._columns.push(col);
    return col;
  }

  date(name) {
    validateIdentifier(name, 'column');
    const col = new ColumnDefinition(name, 'DATE');
    this._columns.push(col);
    return col;
  }

  datetime(name) {
    validateIdentifier(name, 'column');
    const col = new ColumnDefinition(name, 'DATETIME');
    this._columns.push(col);
    return col;
  }

  timestamp(name) {
    validateIdentifier(name, 'column');
    const col = new ColumnDefinition(name, 'TIMESTAMP');
    this._columns.push(col);
    return col;
  }

  timestamps() {
    const created = new ColumnDefinition('created_at', 'DATETIME');
    const updated = new ColumnDefinition('updated_at', 'DATETIME');
    this._columns.push(created, updated);
  }

  softDeletes() {
    const col = new ColumnDefinition('deleted_at', 'DATETIME');
    this._columns.push(col);
    return col;
  }

  json(name) {
    validateIdentifier(name, 'column');
    const col = new ColumnDefinition(name, 'JSON');
    this._columns.push(col);
    return col;
  }

  enum(name, values) {
    validateIdentifier(name, 'column');
    const enumVals = values.map((v) => `'${String(v).replace(/'/g, "\\'")}'`).join(', ');
    const col = new ColumnDefinition(name, `ENUM(${enumVals})`);
    this._columns.push(col);
    return col;
  }

  unique(columns) {
    if (typeof columns === 'string') columns = [columns];
    validateIdentifier(columns.join('_'), 'index');
    this._uniques.push(columns);
  }

  index(columns) {
    if (typeof columns === 'string') columns = [columns];
    this._indexes.push(columns);
  }

  foreign(column) {
    validateIdentifier(column, 'column');
    const fk = {
      column,
      references: null,
      on: null,
      onDelete: 'RESTRICT',
      onUpdate: 'RESTRICT',
    };
    const builder = {
      references(col) { fk.references = col; return builder; },
      on(table) { fk.on = table; return builder; },
      onDelete(action) { fk.onDelete = action.toUpperCase(); return builder; },
      onUpdate(action) { fk.onUpdate = action.toUpperCase(); return builder; },
    };
    this._foreignKeys.push(fk);
    return builder;
  }

  dropColumn(columns) {
    const cols = typeof columns === 'string' ? [columns] : columns;
    for (const c of cols) {
      validateIdentifier(c, 'column');
      this._dropColumns.push(c);
    }
  }

  renameColumn(from, to) {
    validateIdentifier(from, 'column');
    validateIdentifier(to, 'column');
    this._renameColumns.push({ from, to });
  }

  _toSQL() {
    const parts = [];

    for (const col of this._columns) {
      parts.push('  ' + col._toSQL());
    }

    if (this._primaries.length > 0) {
      parts.push(`  PRIMARY KEY (\`${this._primaries.join('`, `')}\`)`);
    }

    for (const cols of this._uniques) {
      const idxName = `${this._tableName}_${cols.join('_')}_unique`;
      parts.push(`  UNIQUE KEY \`${idxName}\` (\`${cols.join('`, `')}\`)`);
    }

    for (const col of this._columns) {
      if (col._unique && !this._primaries.includes(col._name)) {
        const idxName = `${this._tableName}_${col._name}_unique`;
        parts.push(`  UNIQUE KEY \`${idxName}\` (\`${col._name}\`)`);
      }
      if (col._index) {
        const idxName = `${this._tableName}_${col._name}_index`;
        parts.push(`  KEY \`${idxName}\` (\`${col._name}\`)`);
      }
    }

    for (const idx of this._indexes) {
      const idxName = `${this._tableName}_${idx.join('_')}_index`;
      parts.push(`  KEY \`${idxName}\` (\`${idx.join('`, `')}\`)`);
    }

    // Foreign keys from column-level .references().inTable()
    for (const col of this._columns) {
      if (col._references && col._references.table) {
        const fkName = `${this._tableName}_${col._name}_foreign`;
        parts.push(
          `  CONSTRAINT \`${fkName}\` FOREIGN KEY (\`${col._name}\`) REFERENCES \`${col._references.table}\` (\`${col._references.column}\`) ON DELETE ${col._references.onDelete} ON UPDATE ${col._references.onUpdate}`
        );
      }
    }

    // Foreign keys from explicit .foreign() calls
    for (const fk of this._foreignKeys) {
      if (fk.references && fk.on) {
        const fkName = `${this._tableName}_${fk.column}_foreign`;
        parts.push(
          `  CONSTRAINT \`${fkName}\` FOREIGN KEY (\`${fk.column}\`) REFERENCES \`${fk.on}\` (\`${fk.references}\`) ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate}`
        );
      }
    }

    return `CREATE TABLE IF NOT EXISTS \`${this._tableName}\` (\n${parts.join(',\n')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`;
  }
}

/**
 * Schema builder - facade for table operations.
 */
export const Schema = {
  async create(tableName, callback) {
    validateIdentifier(tableName, 'table name');
    const blueprint = new Blueprint(tableName);
    callback(blueprint);
    const sql = blueprint._toSQL();
    await execute(sql, []);
  },

  async drop(tableName) {
    validateIdentifier(tableName, 'table name');
    await execute(`DROP TABLE IF EXISTS \`${tableName}\``, []);
  },

  async dropIfExists(tableName) {
    return this.drop(tableName);
  },

  async rename(from, to) {
    validateIdentifier(from, 'table name');
    validateIdentifier(to, 'table name');
    await execute(`RENAME TABLE \`${from}\` TO \`${to}\``, []);
  },

  async hasTable(tableName) {
    validateIdentifier(tableName, 'table name');
    const [rows] = await execute(
      `SELECT COUNT(*) as cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`,
      [tableName]
    );
    return Number(rows[0]?.cnt ?? 0) > 0;
  },

  async hasColumn(tableName, columnName) {
    validateIdentifier(tableName, 'table name');
    validateIdentifier(columnName, 'column');
    const [rows] = await execute(
      `SELECT COUNT(*) as cnt FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [tableName, columnName]
    );
    return Number(rows[0]?.cnt ?? 0) > 0;
  },

  async table(tableName, callback) {
    validateIdentifier(tableName, 'table name');
    const blueprint = new Blueprint(tableName);
    callback(blueprint);

    // ADD or MODIFY columns
    for (const col of blueprint._columns) {
      if (col._change) {
        await execute(
          `ALTER TABLE \`${tableName}\` MODIFY COLUMN ${col._toSQL()}`,
          []
        );
      } else {
        await execute(
          `ALTER TABLE \`${tableName}\` ADD COLUMN ${col._toSQL()}`,
          []
        );
        // Column-level unique / index
        if (col._unique) {
          const idxName = `${tableName}_${col._name}_unique`;
          await execute(
            `ALTER TABLE \`${tableName}\` ADD UNIQUE KEY \`${idxName}\` (\`${col._name}\`)`,
            []
          );
        } else if (col._index) {
          const idxName = `${tableName}_${col._name}_index`;
          await execute(
            `ALTER TABLE \`${tableName}\` ADD KEY \`${idxName}\` (\`${col._name}\`)`,
            []
          );
        }
        // Column-level foreign key
        if (col._references && col._references.table) {
          const fkName = `${tableName}_${col._name}_foreign`;
          await execute(
            `ALTER TABLE \`${tableName}\` ADD CONSTRAINT \`${fkName}\` FOREIGN KEY (\`${col._name}\`) REFERENCES \`${col._references.table}\` (\`${col._references.column}\`) ON DELETE ${col._references.onDelete} ON UPDATE ${col._references.onUpdate}`,
            []
          );
        }
      }
    }

    // DROP columns
    for (const colName of blueprint._dropColumns) {
      await execute(
        `ALTER TABLE \`${tableName}\` DROP COLUMN \`${colName}\``,
        []
      );
    }

    // RENAME columns
    for (const rename of blueprint._renameColumns) {
      await execute(
        `ALTER TABLE \`${tableName}\` RENAME COLUMN \`${rename.from}\` TO \`${rename.to}\``,
        []
      );
    }

    // Composite unique keys
    for (const cols of blueprint._uniques) {
      const idxName = `${tableName}_${cols.join('_')}_unique`;
      await execute(
        `ALTER TABLE \`${tableName}\` ADD UNIQUE KEY \`${idxName}\` (\`${cols.join('\`, \`')}\`)`,
        []
      );
    }

    // Composite plain indexes
    for (const idx of blueprint._indexes) {
      const idxName = `${tableName}_${idx.join('_')}_index`;
      await execute(
        `ALTER TABLE \`${tableName}\` ADD KEY \`${idxName}\` (\`${idx.join('\`, \`')}\`)`,
        []
      );
    }

    // Explicit foreign keys via blueprint.foreign()
    for (const fk of blueprint._foreignKeys) {
      if (fk.references && fk.on) {
        const fkName = `${tableName}_${fk.column}_foreign`;
        await execute(
          `ALTER TABLE \`${tableName}\` ADD CONSTRAINT \`${fkName}\` FOREIGN KEY (\`${fk.column}\`) REFERENCES \`${fk.on}\` (\`${fk.references}\`) ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate}`,
          []
        );
      }
    }
  },
};
