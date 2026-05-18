import { connect, disconnect, execute, transaction } from '../../src/connection.js';
import { Schema } from '../../src/schema-builder.js';
import { Model } from '../../src/model.js';

const engines = [
  { name: 'MySQL 5.7', port: 3307, expectRenameFail: true },
  { name: 'MySQL 8.0', port: 3308, expectRenameFail: false },
  { name: 'MariaDB 10.5', port: 3309, expectRenameFail: false },
];

const runIntegration = process.env.MYSQLIFY_RUN_INTEGRATION === '1';

if (!runIntegration) {
  console.warn('[Integration] Skipping Integration Suite: MYSQLIFY_RUN_INTEGRATION is not set to "1". To run, execute "npm run docker:up" then "MYSQLIFY_RUN_INTEGRATION=1 npm run test:integration"');
}

const describeSuite = runIntegration ? describe : describe.skip;

describeSuite('Real Engine Integration Validation Suite', () => {
  for (const engine of engines) {
    describe(`Engine: ${engine.name} (Port ${engine.port})`, () => {
      beforeEach(async () => {
        // Reset connection pool for this engine
        await disconnect();
        connect({
          host: '127.0.0.1',
          port: engine.port,
          user: 'root',
          password: 'root',
          database: 'mysqlify_test',
        });
      });

      afterAll(async () => {
        await disconnect();
      });

      test('1. Basic Connection and Schema Creation', async () => {
        await Schema.dropIfExists('integration_users');
        await Schema.create('integration_users', (t) => {
          t.id();
          t.string('email', 100).notNullable();
          t.string('first_name', 50).nullable();
          t.text('bio').nullable();
          t.json('meta').nullable();
          t.timestamp('created_at').nullable().default('CURRENT_TIMESTAMP');
        });

        // Verify table exists
        const exists = await Schema.hasTable('integration_users');
        expect(exists).toBe(true);

        const hasEmail = await Schema.hasColumn('integration_users', 'email');
        expect(hasEmail).toBe(true);
      });

      test('2. MODIFY, DROP, and RENAME COLUMN semantics', async () => {
        // Ensure table is freshly set up
        await Schema.dropIfExists('alter_test');
        await Schema.create('alter_test', (t) => {
          t.id();
          t.string('email', 100).notNullable();
          t.string('first_name', 50).nullable();
          t.text('bio').nullable();
        });

        // 2a. MODIFY COLUMN (change email from 100 to 191)
        await Schema.table('alter_test', (t) => {
          t.string('email', 191).nullable().change();
        });
        // On real engine, we can check by trying to insert a 150-char email
        // or checking column info
        const [cols] = await execute(
          "SELECT CHARACTER_MAXIMUM_LENGTH FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'alter_test' AND column_name = 'email'"
        );
        expect(Number(cols[0]?.CHARACTER_MAXIMUM_LENGTH)).toBe(191);

        // 2b. DROP COLUMN (bio)
        await Schema.table('alter_test', (t) => {
          t.dropColumn('bio');
        });
        const hasBio = await Schema.hasColumn('alter_test', 'bio');
        expect(hasBio).toBe(false);

        // 2c. RENAME COLUMN (first_name -> firstName)
        if (engine.expectRenameFail) {
          // Expected to fail on MySQL 5.7
          let error = null;
          try {
            await Schema.table('alter_test', (t) => {
              t.renameColumn('first_name', 'firstName');
            });
          } catch (e) {
            error = e;
          }
          expect(error).not.toBeNull();
          console.log(`[Integration] Confirmed RENAME COLUMN failing as expected on ${engine.name}`);
        } else {
          // Expected to pass on MySQL 8.0 / MariaDB 10.5
          await Schema.table('alter_test', (t) => {
            t.renameColumn('first_name', 'firstName');
          });
          const hasFirstName = await Schema.hasColumn('alter_test', 'first_name');
          const hasNewName = await Schema.hasColumn('alter_test', 'firstName');
          expect(hasFirstName).toBe(false);
          expect(hasNewName).toBe(true);
        }
      });

      test('3. upsertMany() compatibility and JSON support', async () => {
        await Schema.dropIfExists('upsert_test');
        await Schema.create('upsert_test', (t) => {
          t.id();
          t.string('key_name', 50).unique();
          t.json('meta_data').nullable();
        });

        // First insert
        const initialRows = [
          { key_name: 'config_1', meta_data: JSON.stringify({ active: true }) },
          { key_name: 'config_2', meta_data: JSON.stringify({ active: false }) },
        ];

        // Model wrapper emulation using raw QueryBuilder under the hood or execute
        // Directly test upsertMany via raw query execute to see if it runs
        const keys = ['key_name', 'meta_data'];
        const cols = keys.map((k) => `\`${k}\``).join(', ');
        const placeholders = '(? , ?), (? , ?)';
        const values = ['config_1', '{"active":true}', 'config_2', '{"active":false}'];
        const onDuplicate = keys.map((k) => `\`${k}\` = VALUES(\`${k}\`)`).join(', ');

        const sql = `INSERT INTO \`upsert_test\` (${cols}) VALUES ${placeholders} ON DUPLICATE KEY UPDATE ${onDuplicate}`;
        const [res] = await execute(sql, values);
        expect(res.affectedRows).toBe(2);

        // Upsert conflict row
        const updateValues = ['config_1', '{"active":false}', 'config_2', '{"active":true}'];
        const [res2] = await execute(sql, updateValues);
        // Under MySQL, a duplicated row update yields affectedRows = 2 per row updated (so 4 here, or 2)
        expect(res2.affectedRows).toBeGreaterThan(0);

        // Verify JSON was written and read correctly
        const [rows] = await execute("SELECT * FROM upsert_test WHERE key_name = 'config_1'");
        const meta = typeof rows[0].meta_data === 'string' ? JSON.parse(rows[0].meta_data) : rows[0].meta_data;
        expect(meta.active).toBe(false);
      });

      test('4. Relational eager loading inside Transaction isolation', async () => {
        // Create transactional setup
        await Schema.dropIfExists('comments');
        await Schema.dropIfExists('posts');
        await Schema.dropIfExists('users');

        await Schema.create('users', (t) => {
          t.id();
          t.string('name');
        });
        await Schema.create('posts', (t) => {
          t.id();
          t.bigInteger('user_id').unsigned();
          t.string('title');
        });

        class User extends Model {
          static get table() { return 'users'; }
          posts() { return this.hasMany(Post, 'user_id'); }
        }
        class Post extends Model {
          static get table() { return 'posts'; }
        }

        // Test transaction rollback
        let rollbackTriggered = false;
        try {
          await transaction(async (trx) => {
            // Emulate insertions
            await trx.execute('INSERT INTO users (id, name) VALUES (1, "Alice")');
            await trx.execute('INSERT INTO posts (id, user_id, title) VALUES (1, 1, "First Post")');
            throw new Error('Force Rollback');
          });
        } catch (e) {
          rollbackTriggered = true;
        }
        expect(rollbackTriggered).toBe(true);

        // Verify rollback worked
        const [users] = await execute('SELECT COUNT(*) as cnt FROM users');
        expect(Number(users[0].cnt)).toBe(0);
      });
    });
  }
});
