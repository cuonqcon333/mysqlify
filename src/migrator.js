import { execute } from './connection.js';
import { Schema } from './schema-builder.js';
import { readdir } from 'fs/promises';
import { existsSync as fs } from 'fs';
import { resolve, join } from 'path';
import { pathToFileURL } from 'url';

const MIGRATIONS_TABLE = 'mysqlify_migrations';

async function ensureMigrationsTable() {
  await Schema.create(MIGRATIONS_TABLE, (table) => {
    table.id();
    table.string('migration', 255);
    table.integer('batch');
    table.timestamp('executed_at').nullable().default(null);
  });
}

function stripExt(filename) {
  return filename.replace(/\.(js|cjs|mjs)$/, '');
}

async function getRanMigrations() {
  const [rows] = await execute(
    `SELECT migration, batch FROM \`${MIGRATIONS_TABLE}\` ORDER BY id ASC`,
    []
  );
  return rows;
}

async function getMigrationFiles(migrationsDir) {
  const dir = resolve(migrationsDir);
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith('.js') || f.endsWith('.cjs') || f.endsWith('.mjs'))
    .sort();
}

/**
 * Run all pending migrations.
 * @param {string} migrationsDir
 * @returns {Promise<string[]>} list of run migrations
 */
export async function migrateUp(migrationsDir = './migrations') {
  await ensureMigrationsTable();

  const ran = await getRanMigrations();
  const ranNames = new Set(ran.map((r) => r.migration));

  const files = await getMigrationFiles(migrationsDir);
  const pending = files.filter((f) => !ranNames.has(stripExt(f)));

  if (pending.length === 0) {
    return [];
  }

  const [batchRows] = await execute(
    `SELECT COALESCE(MAX(batch), 0) + 1 as next_batch FROM \`${MIGRATIONS_TABLE}\``,
    []
  );
  const batch = Number(batchRows[0]?.next_batch ?? 1);

  const executed = [];
  for (const file of pending) {
    const filePath = join(resolve(migrationsDir), file);
    const fileUrl = pathToFileURL(filePath).href;
    const migration = await import(fileUrl);
    const upFn = migration.up ?? migration.default?.up;

    if (typeof upFn !== 'function') {
      throw new Error(`Migration "${file}" does not export an "up" function.`);
    }

    await upFn(Schema);

    await execute(
      `INSERT INTO \`${MIGRATIONS_TABLE}\` (migration, batch, executed_at) VALUES (?, ?, NOW())`,
      [stripExt(file), batch]
    );

    executed.push(stripExt(file));
  }

  return executed;
}

/**
 * Rollback the last batch of migrations.
 * @param {string} migrationsDir
 * @returns {Promise<string[]>} list of rolled back migrations
 */
export async function migrateRollback(migrationsDir = './migrations') {
  await ensureMigrationsTable();

  const [batchRows] = await execute(
    `SELECT MAX(batch) as last_batch FROM \`${MIGRATIONS_TABLE}\``,
    []
  );
  const lastBatch = batchRows[0]?.last_batch;
  if (!lastBatch) return [];

  const [rows] = await execute(
    `SELECT migration FROM \`${MIGRATIONS_TABLE}\` WHERE batch = ? ORDER BY id DESC`,
    [lastBatch]
  );

  const rolledBack = [];
  for (const row of rows) {
    const base = join(resolve(migrationsDir), row.migration);
    const filePath = [base + '.js', base + '.cjs', base + '.mjs'].find((p) => fs(p)) ?? (base + '.js');
    const fileUrl = pathToFileURL(filePath).href;

    let migration;
    try {
      migration = await import(fileUrl);
    } catch {
      continue;
    }

    const downFn = migration.down ?? migration.default?.down;
    if (typeof downFn === 'function') {
      await downFn(Schema);
    }

    await execute(
      `DELETE FROM \`${MIGRATIONS_TABLE}\` WHERE migration = ?`,
      [row.migration]
    );

    rolledBack.push(row.migration);  // already stripped
  }

  return rolledBack;
}

/**
 * Get migration status.
 * @param {string} migrationsDir
 * @returns {Promise<Array<{file, status, batch}>>}
 */
export async function migrateStatus(migrationsDir = './migrations') {
  await ensureMigrationsTable();

  const ran = await getRanMigrations();
  const ranMap = new Map(ran.map((r) => [r.migration, r.batch]));
  const files = await getMigrationFiles(migrationsDir);

  return files.map((file) => ({
    file: stripExt(file),
    status: ranMap.has(stripExt(file)) ? 'Ran' : 'Pending',
    batch: ranMap.get(stripExt(file)) ?? null,
  }));
}
