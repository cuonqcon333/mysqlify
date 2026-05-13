import mysql from 'mysql2/promise';

let _pool = null;
let _config = {};
const _queryListeners = [];

/**
 * Register a listener for every executed query.
 * Callback receives { sql, params, time } where time is ms.
 * @param {(info: { sql: string, params: any[], time: number }) => void} fn
 */
export function listen(fn) {
  _queryListeners.push(fn);
}

/**
 * Remove all registered query listeners.
 */
export function clearListeners() {
  _queryListeners.length = 0;
}

const DEFAULT_CONFIG = {
  host: 'localhost',
  port: 3306,
  user: 'root',
  password: '',
  database: '',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  acquireTimeout: 10000,
};

/**
 * Initialize the connection pool.
 * @param {object} [config]
 * @param {string} [config.host]
 * @param {number} [config.port]
 * @param {string} [config.user]
 * @param {string} [config.password]
 * @param {string} [config.database]
 * @param {object} [config.pool]
 * @param {boolean} [config.sanitize]
 * @param {number} [config.maxConditions]
 * @param {boolean} [config.auditLog]
 * @param {Function} [config.logger]
 * @returns {object} pool
 */
export function connect(config = {}) {
  const poolConfig = {
    host: config.host || process.env.DB_HOST || DEFAULT_CONFIG.host,
    port: Number(config.port || process.env.DB_PORT || DEFAULT_CONFIG.port),
    user: config.user || process.env.DB_USER || DEFAULT_CONFIG.user,
    password: config.password ?? process.env.DB_PASS ?? DEFAULT_CONFIG.password,
    database: config.database || process.env.DB_NAME || DEFAULT_CONFIG.database,
    waitForConnections: DEFAULT_CONFIG.waitForConnections,
    connectionLimit: config.pool?.connectionLimit ?? DEFAULT_CONFIG.connectionLimit,
    queueLimit: config.pool?.queueLimit ?? DEFAULT_CONFIG.queueLimit,
    connectTimeout: config.pool?.acquireTimeout ?? DEFAULT_CONFIG.acquireTimeout,
  };

  _config = {
    sanitize: config.sanitize ?? false,
    maxConditions: config.maxConditions ?? 20,
    auditLog: config.auditLog ?? false,
    logger: config.logger ?? null,
  };

  _pool = mysql.createPool(poolConfig);
  return _pool;
}

/**
 * Get the active pool. Auto-connects with env defaults if not initialized.
 * @returns {object}
 */
export function getPool() {
  if (!_pool) {
    connect();
  }
  return _pool;
}

/**
 * Get global config options.
 * @returns {object}
 */
export function getConfig() {
  return _config;
}

/**
 * Execute a SQL query using the pool.
 * @param {string} sql
 * @param {any[]} [params]
 * @returns {Promise<[any[], any]>}
 */
export async function execute(sql, params = [], conn = null) {
  const runner = conn || getPool();
  const config = getConfig();

  const hasListeners = _queryListeners.length > 0;
  const hasAuditLog = config.auditLog;

  const start = (hasListeners || hasAuditLog) ? Date.now() : 0;
  const result = await runner.execute(sql, params);
  const time = start ? Date.now() - start : 0;

  if (hasAuditLog) {
    const logFn = config.logger ?? ((msg) => console.log('[mysqlify]', msg));
    logFn(`QUERY (${time}ms): ${sql} | PARAMS: ${JSON.stringify(params)}`);
  }

  if (hasListeners) {
    const info = { sql, params, time };
    for (const fn of _queryListeners) fn(info);
  }

  return result;
}

/**
 * Run a callback inside a MySQL transaction.
 * Auto-commits on success, auto-rollbacks on error.
 * @param {(trx: object) => Promise<any>} callback
 * @returns {Promise<any>}
 */
export async function transaction(callback) {
  const pool = getPool();
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  try {
    const trx = {
      execute: (sql, params = []) => execute(sql, params, conn),
      commit: () => conn.commit(),
      rollback: () => conn.rollback(),
      _conn: conn,
    };
    const result = await callback(trx);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Close the pool (useful for cleanup/testing).
 * @returns {Promise<void>}
 */
export async function disconnect() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
