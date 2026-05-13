export class MysqlifySecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MysqlifySecurityError';
  }
}

const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const HTML_ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  '/': '&#x2F;',
};

/**
 * Validate a SQL identifier (table name, column name).
 * Throws MysqlifySecurityError if invalid.
 * @param {string} identifier
 * @param {string} [context]
 * @returns {string}
 */
export function validateIdentifier(identifier, context = 'identifier') {
  if (typeof identifier !== 'string' || identifier.trim() === '') {
    throw new MysqlifySecurityError(
      `Invalid ${context}: must be a non-empty string.`
    );
  }
  const parts = identifier.split('.');
  for (const part of parts) {
    if (!IDENTIFIER_PATTERN.test(part)) {
      throw new MysqlifySecurityError(
        `Invalid ${context} "${identifier}": only alphanumeric characters and underscores are allowed.`
      );
    }
  }
  return identifier;
}

/**
 * Validate multiple identifiers at once.
 * @param {string[]} identifiers
 * @param {string} [context]
 */
export function validateIdentifiers(identifiers, context = 'identifier') {
  for (const id of identifiers) {
    validateIdentifier(id, context);
  }
}

/**
 * HTML-escape a string value to prevent XSS.
 * @param {string} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"'/]/g, (char) => HTML_ESCAPE_MAP[char]);
}

/**
 * Sanitize an object's string values (HTML-escape).
 * @param {object|object[]} data
 * @returns {object|object[]}
 */
export function sanitizeOutput(data) {
  if (Array.isArray(data)) {
    return data.map(sanitizeOutput);
  }
  if (data !== null && typeof data === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = typeof value === 'string' ? escapeHtml(value) : value;
    }
    return result;
  }
  return data;
}

/**
 * Filter an object's keys using a fillable whitelist.
 * @param {object} data
 * @param {string[]} fillable
 * @returns {object}
 */
export function applyFillable(data, fillable) {
  if (!fillable || fillable.length === 0) return data;
  const result = {};
  for (const key of fillable) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      result[key] = data[key];
    }
  }
  return result;
}

/**
 * Filter an object's keys using a guarded blacklist.
 * @param {object} data
 * @param {string[]} guarded
 * @returns {object}
 */
export function applyGuarded(data, guarded) {
  if (!guarded || guarded.length === 0) return data;
  const result = { ...data };
  for (const key of guarded) {
    delete result[key];
  }
  return result;
}

/**
 * Remove hidden fields from a result row or rows.
 * @param {object|object[]} data
 * @param {string[]} hidden
 * @returns {object|object[]}
 */
export function applyHidden(data, hidden) {
  if (!hidden || hidden.length === 0) return data;
  if (Array.isArray(data)) {
    return data.map((row) => applyHidden(row, hidden));
  }
  if (data !== null && typeof data === 'object') {
    const result = { ...data };
    for (const key of hidden) {
      delete result[key];
    }
    return result;
  }
  return data;
}

/**
 * Validate that a data object for insert/update is a plain object
 * and has no keys containing dangerous characters.
 * @param {object} data
 */
export function validateDataObject(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new MysqlifySecurityError(
      'Data must be a plain object for insert/update operations.'
    );
  }
  for (const key of Object.keys(data)) {
    if (!IDENTIFIER_PATTERN.test(key)) {
      throw new MysqlifySecurityError(
        `Invalid column key "${key}": only alphanumeric characters and underscores are allowed.`
      );
    }
  }
}
