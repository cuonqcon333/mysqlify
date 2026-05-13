#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

// Auto-load .env from project root (like Laravel artisan)
(function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
})();

const args = process.argv.slice(2);
const command = args[0];
const argument = args[1];
const flags = args.slice(2);

function getFlagValue(flag) {
  const idx = flags.findIndex((f) => f === flag || f.startsWith(flag + '='));
  if (idx === -1) return null;
  const f = flags[idx];
  if (f.includes('=')) return f.split('=').slice(1).join('=');
  return flags[idx + 1] ?? null;
}

function loadProjectConfig() {
  const cfgPath = path.resolve(process.cwd(), 'mysqlify.config.cjs');
  if (fs.existsSync(cfgPath)) {
    try { return require(cfgPath); } catch { return {}; }
  }
  return {};
}

const projectCfg = loadProjectConfig();

const MIGRATIONS_DIR = path.resolve(
  process.cwd(),
  getFlagValue('--migrations-dir') ?? projectCfg.migrationsDir ?? 'migrations'
);
const MODELS_DIR = path.resolve(
  process.cwd(),
  getFlagValue('--models-dir') ?? projectCfg.modelsDir ?? 'models'
);

function pad(n) {
  return String(n).padStart(2, '0');
}

function generateTimestamp() {
  const d = new Date();
  return `${d.getFullYear()}_${pad(d.getMonth() + 1)}_${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function toTableName(name) {
  const base = name
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '')
    .replace(/^create_/, '')
    .replace(/_table$/, '');
  return base.endsWith('s') ? base : base + 's';
}

function toModelName(name) {
  return name
    .split('_')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

function readStub(stubName) {
  const local = path.join(__dirname, '..', 'stubs', stubName);
  if (fs.existsSync(local)) return fs.readFileSync(local, 'utf8');
  throw new Error(`Stub not found: ${stubName}`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Commands 

function cmdInit() {
  const cfgPath = path.resolve(process.cwd(), 'mysqlify.config.cjs');

  if (fs.existsSync(cfgPath)) {
    console.log('[mysqlify] mysqlify.config.cjs already exists — skipped.');
    process.exit(0);
  }

  const content = `// mysqlify configuration
// Docs: https://github.com/cuonqcon333/mysqlify
module.exports = {
  // Database connection
  host:     process.env.DB_HOST || 'localhost',
  port:     Number(process.env.DB_PORT) || 3306,
  user:     process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || '',

  // Directory configuration
  migrationsDir: 'migrations',   // e.g. 'src/database/migrations'
  modelsDir:     'models',       // e.g. 'src/models'

  // Optional
  // pool: { connectionLimit: 10 },
  // sanitize: false,
  // auditLog: false,
};
`;

  fs.writeFileSync(cfgPath, content, 'utf8');
  console.log('[mysqlify] Created mysqlify.config.cjs');
  console.log('[mysqlify] Edit it to set your database credentials and directory paths.');
}

function cmdMakeMigration(name) {
  if (!name) {
    console.error('Usage: mysqlify make:migration <migration_name> [--migrations-dir=<path>]');
    process.exit(1);
  }

  ensureDir(MIGRATIONS_DIR);

  const timestamp = generateTimestamp();
  const fileName = `${timestamp}_${name}.js`;
  const filePath = path.join(MIGRATIONS_DIR, fileName);

  const table = toTableName(name);
  let stub = readStub('migration.stub.js');
  stub = stub.replace(/\{\{name\}\}/g, name);
  stub = stub.replace(/\{\{table\}\}/g, table);
  stub = stub.replace(/\{\{date\}\}/g, new Date().toISOString());

  fs.writeFileSync(filePath, stub, 'utf8');
  const rel = path.relative(process.cwd(), filePath).replace(/\\/g, '/');
  console.log(`[mysqlify] Created migration: ${rel}`);
}

function cmdMakeModel(name, withMigration = false) {
  if (!name) {
    console.error('Usage: mysqlify make:model <ModelName> [--migration] [--models-dir=<path>]');
    process.exit(1);
  }

  ensureDir(MODELS_DIR);

  const modelName = toModelName(name);
  const table = modelName
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '') + 's';

  let stub = readStub('model.stub.js');
  stub = stub.replace(/\{\{ModelName\}\}/g, modelName);
  stub = stub.replace(/\{\{table\}\}/g, table);

  const fileName = `${modelName}.js`;
  const filePath = path.join(MODELS_DIR, fileName);

  if (fs.existsSync(filePath)) {
    const rel = path.relative(process.cwd(), filePath).replace(/\\/g, '/');
    console.error(`[mysqlify] Model already exists: ${rel}`);
    process.exit(1);
  }

  fs.writeFileSync(filePath, stub, 'utf8');
  const rel = path.relative(process.cwd(), filePath).replace(/\\/g, '/');
  console.log(`[mysqlify] Created model: ${rel}`);

  if (withMigration) {
    cmdMakeMigration(`create_${table}_table`);
  }
}

async function cmdMigrateUp() {
  const { migrateUp, connect } = await loadMysqlify();
  connectFromEnv(connect);
  const ran = await migrateUp(MIGRATIONS_DIR);
  if (ran.length === 0) {
    console.log('[mysqlify] Nothing to migrate.');
  } else {
    ran.forEach((f) => console.log(`[mysqlify] Migrated: ${f}`));
    console.log(`[mysqlify] ${ran.length} migration(s) run.`);
  }
  process.exit(0);
}

async function cmdMigrateRollback() {
  const { migrateRollback, connect } = await loadMysqlify();
  connectFromEnv(connect);
  const rolled = await migrateRollback(MIGRATIONS_DIR);
  if (rolled.length === 0) {
    console.log('[mysqlify] Nothing to rollback.');
  } else {
    rolled.forEach((f) => console.log(`[mysqlify] Rolled back: ${f}`));
    console.log(`[mysqlify] ${rolled.length} migration(s) rolled back.`);
  }
  process.exit(0);
}

async function cmdMigrateStatus() {
  const { migrateStatus, connect } = await loadMysqlify();
  connectFromEnv(connect);
  const status = await migrateStatus(MIGRATIONS_DIR);
  if (status.length === 0) {
    console.log('[mysqlify] No migration files found.');
    process.exit(0);
  }
  const maxLen = Math.max(...status.map((s) => s.file.length));
  console.log('\n' + 'Migration'.padEnd(maxLen + 4) + 'Status'.padEnd(12) + 'Batch');
  console.log('-'.repeat(maxLen + 24));
  for (const s of status) {
    console.log(
      s.file.padEnd(maxLen + 4) +
      s.status.padEnd(12) +
      (s.batch !== null ? String(s.batch) : '-')
    );
  }
  console.log('');
  process.exit(0);
}

async function loadMysqlify() {
  const distCjs = path.join(__dirname, '..', 'dist', 'cjs', 'index.js');
  const srcIndex = path.join(__dirname, '..', 'src', 'index.js');

  if (fs.existsSync(distCjs)) {
    return require(distCjs);
  }

  console.error('[mysqlify] dist/ not found. Run `npm run build` first, or use the src/ directly.');
  process.exit(1);
}

function connectFromEnv(connect) {
  const cfgPath = path.resolve(process.cwd(), 'mysqlify.config.cjs');

  if (fs.existsSync(cfgPath)) {
    // Re-require after .env is loaded so process.env vars are expanded correctly
    delete require.cache[require.resolve(cfgPath)];
    const cfg = require(cfgPath);
    connect(cfg.default ?? cfg);
    return;
  }

  // Fallback: read directly from env (already loaded from .env above)
  connect({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || '',
  });
}

// Router 

switch (command) {
  case 'init':
    cmdInit();
    break;

  case 'make:migration':
    cmdMakeMigration(argument);
    break;

  case 'make:model':
    cmdMakeModel(argument, flags.includes('--migration'));
    break;

  case 'migrate:up':
    cmdMigrateUp().catch((err) => {
      console.error('[mysqlify] Error:', err.message);
      process.exit(1);
    });
    break;

  case 'migrate:rollback':
    cmdMigrateRollback().catch((err) => {
      console.error('[mysqlify] Error:', err.message);
      process.exit(1);
    });
    break;

  case 'migrate:status':
    cmdMigrateStatus().catch((err) => {
      console.error('[mysqlify] Error:', err.message);
      process.exit(1);
    });
    break;

  default:
    console.log(`
mysqlify CLI

Usage:
  mysqlify init                                     Create mysqlify.config.cjs in project root
  mysqlify make:migration <name>                    Create a new migration file
  mysqlify make:model <Name>                        Create a new model file
  mysqlify make:model <Name> --migration            Create model + migration together
  mysqlify migrate:up                               Run all pending migrations
  mysqlify migrate:rollback                         Rollback the last batch
  mysqlify migrate:status                           Show migration status

Options:
  --migrations-dir=<path>   Override migrations directory for this command
  --models-dir=<path>       Override models directory for this command

Directory resolution order:
  1. --migrations-dir / --models-dir flag (highest priority)
  2. migrationsDir / modelsDir in mysqlify.config.cjs
  3. Default: migrations/ and models/

Quick start:
  npx mysqlify init                                 # generates mysqlify.config.cjs
  # edit mysqlify.config.cjs to set DB credentials and directory paths
  npx mysqlify make:migration create_users_table
  npx mysqlify migrate:up
`);
    break;
}
