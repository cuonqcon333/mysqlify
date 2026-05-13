import { jest } from '@jest/globals';

const mockConn = {
  beginTransaction: jest.fn().mockResolvedValue(),
  commit: jest.fn().mockResolvedValue(),
  rollback: jest.fn().mockResolvedValue(),
  release: jest.fn(),
  execute: jest.fn().mockResolvedValue([[{ id: 1 }]]),
};

const mockPool = {
  getConnection: jest.fn().mockResolvedValue(mockConn),
  execute: jest.fn(),
};

await jest.unstable_mockModule('../src/connection.js', () => ({
  execute: jest.fn(),
  getConfig: () => ({ sanitize: false, maxConditions: 20, auditLog: false }),
  connect: jest.fn(),
  disconnect: jest.fn(),
  getPool: jest.fn().mockReturnValue(mockPool),
  transaction: async (callback) => {
    const conn = await mockPool.getConnection();
    await conn.beginTransaction();
    try {
      const trx = {
        execute: (sql, params = []) => conn.execute(sql, params),
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
  },
}));

const { transaction } = await import('../src/connection.js');

beforeEach(() => {
  jest.clearAllMocks();
  mockConn.beginTransaction.mockResolvedValue();
  mockConn.commit.mockResolvedValue();
  mockConn.rollback.mockResolvedValue();
  mockConn.execute.mockResolvedValue([[{ id: 1 }]]);
  mockPool.getConnection.mockResolvedValue(mockConn);
});

describe('transaction()', () => {
  test('commits on success and returns callback result', async () => {
    const result = await transaction(async (trx) => {
      await trx.execute('INSERT INTO orders (total) VALUES (?)', [99]);
      return 'done';
    });

    expect(result).toBe('done');
    expect(mockConn.beginTransaction).toHaveBeenCalled();
    expect(mockConn.commit).toHaveBeenCalled();
    expect(mockConn.rollback).not.toHaveBeenCalled();
    expect(mockConn.release).toHaveBeenCalled();
  });

  test('rollbacks on error and rethrows', async () => {
    await expect(
      transaction(async (trx) => {
        await trx.execute('INSERT INTO orders (total) VALUES (?)', [99]);
        throw new Error('something went wrong');
      })
    ).rejects.toThrow('something went wrong');

    expect(mockConn.beginTransaction).toHaveBeenCalled();
    expect(mockConn.rollback).toHaveBeenCalled();
    expect(mockConn.commit).not.toHaveBeenCalled();
    expect(mockConn.release).toHaveBeenCalled();
  });

  test('release() is always called even on error', async () => {
    await expect(
      transaction(async () => { throw new Error('fail'); })
    ).rejects.toThrow();

    expect(mockConn.release).toHaveBeenCalledTimes(1);
  });

  test('multiple queries in one transaction use same connection', async () => {
    await transaction(async (trx) => {
      await trx.execute('INSERT INTO users (name) VALUES (?)', ['Alice']);
      await trx.execute('INSERT INTO orders (user_id) VALUES (?)', [1]);
    });

    expect(mockConn.execute).toHaveBeenCalledTimes(2);
    expect(mockConn.execute).toHaveBeenNthCalledWith(1, 'INSERT INTO users (name) VALUES (?)', ['Alice']);
    expect(mockConn.execute).toHaveBeenNthCalledWith(2, 'INSERT INTO orders (user_id) VALUES (?)', [1]);
    expect(mockConn.commit).toHaveBeenCalledTimes(1);
  });
});
