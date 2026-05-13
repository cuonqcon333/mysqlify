import {
  validateIdentifier,
  validateDataObject,
  applyFillable,
  applyGuarded,
  applyHidden,
  sanitizeOutput,
  escapeHtml,
  MysqlifySecurityError,
} from '../src/security.js';

describe('MysqlifySecurityError', () => {
  test('is instance of Error', () => {
    const err = new MysqlifySecurityError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('MysqlifySecurityError');
    expect(err.message).toBe('test');
  });
});

describe('validateIdentifier', () => {
  test('accepts valid identifiers', () => {
    expect(validateIdentifier('users')).toBe('users');
    expect(validateIdentifier('user_id')).toBe('user_id');
    expect(validateIdentifier('table123')).toBe('table123');
    expect(validateIdentifier('schema.table')).toBe('schema.table');
  });

  test('rejects SQL injection attempts', () => {
    expect(() => validateIdentifier('users; DROP TABLE users--')).toThrow(MysqlifySecurityError);
    expect(() => validateIdentifier("users' OR '1'='1")).toThrow(MysqlifySecurityError);
    expect(() => validateIdentifier('users UNION SELECT')).toThrow(MysqlifySecurityError);
    expect(() => validateIdentifier('')).toThrow(MysqlifySecurityError);
    expect(() => validateIdentifier('col-name')).toThrow(MysqlifySecurityError);
    expect(() => validateIdentifier('col name')).toThrow(MysqlifySecurityError);
  });

  test('rejects non-string input', () => {
    expect(() => validateIdentifier(null)).toThrow(MysqlifySecurityError);
    expect(() => validateIdentifier(undefined)).toThrow(MysqlifySecurityError);
    expect(() => validateIdentifier(123)).toThrow(MysqlifySecurityError);
  });
});

describe('validateDataObject', () => {
  test('accepts valid plain objects', () => {
    expect(() => validateDataObject({ name: 'John', email: 'j@x.com' })).not.toThrow();
    expect(() => validateDataObject({ user_id: 1 })).not.toThrow();
  });

  test('rejects non-objects', () => {
    expect(() => validateDataObject(null)).toThrow(MysqlifySecurityError);
    expect(() => validateDataObject('string')).toThrow(MysqlifySecurityError);
    expect(() => validateDataObject([1, 2])).toThrow(MysqlifySecurityError);
  });

  test('rejects keys with special characters', () => {
    expect(() => validateDataObject({ 'col; DROP TABLE': 1 })).toThrow(MysqlifySecurityError);
    expect(() => validateDataObject({ 'col-name': 1 })).toThrow(MysqlifySecurityError);
  });
});

describe('escapeHtml', () => {
  test('escapes dangerous HTML characters', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;&#x2F;script&gt;'
    );
    expect(escapeHtml('"quoted"')).toBe('&quot;quoted&quot;');
    expect(escapeHtml("it's")).toBe("it&#x27;s");
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  test('returns non-string values as-is after conversion', () => {
    expect(escapeHtml(123)).toBe('123');
  });
});

describe('sanitizeOutput', () => {
  test('sanitizes string values in object', () => {
    const result = sanitizeOutput({ name: '<John>', bio: 'Safe' });
    expect(result.name).toBe('&lt;John&gt;');
    expect(result.bio).toBe('Safe');
  });

  test('sanitizes array of objects', () => {
    const rows = [{ name: '<a>' }, { name: 'b' }];
    const result = sanitizeOutput(rows);
    expect(result[0].name).toBe('&lt;a&gt;');
    expect(result[1].name).toBe('b');
  });

  test('does not modify non-string values', () => {
    const result = sanitizeOutput({ count: 5, active: true, val: null });
    expect(result.count).toBe(5);
    expect(result.active).toBe(true);
    expect(result.val).toBeNull();
  });
});

describe('applyFillable', () => {
  test('only keeps fillable fields', () => {
    const data = { name: 'John', email: 'j@x.com', admin: true };
    const result = applyFillable(data, ['name', 'email']);
    expect(result).toEqual({ name: 'John', email: 'j@x.com' });
    expect(result.admin).toBeUndefined();
  });

  test('returns all data if fillable is empty', () => {
    const data = { name: 'John' };
    expect(applyFillable(data, [])).toEqual(data);
    expect(applyFillable(data, null)).toEqual(data);
  });
});

describe('applyGuarded', () => {
  test('removes guarded fields', () => {
    const data = { name: 'John', password: 'secret', role: 'admin' };
    const result = applyGuarded(data, ['password', 'role']);
    expect(result).toEqual({ name: 'John' });
  });

  test('returns all data if guarded is empty', () => {
    const data = { name: 'John' };
    expect(applyGuarded(data, [])).toEqual(data);
  });
});

describe('applyHidden', () => {
  test('removes hidden fields from single object', () => {
    const row = { id: 1, name: 'John', password: 'hashed' };
    const result = applyHidden(row, ['password']);
    expect(result.password).toBeUndefined();
    expect(result.name).toBe('John');
  });

  test('removes hidden fields from array of objects', () => {
    const rows = [
      { id: 1, password: 'a' },
      { id: 2, password: 'b' },
    ];
    const result = applyHidden(rows, ['password']);
    expect(result[0].password).toBeUndefined();
    expect(result[1].password).toBeUndefined();
  });

  test('returns data unchanged if hidden is empty', () => {
    const row = { id: 1, name: 'John' };
    expect(applyHidden(row, [])).toEqual(row);
  });
});
