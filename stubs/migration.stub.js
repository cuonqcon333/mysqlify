/**
 * Migration: {{name}}
 * Generated: {{date}}
 */

/**
 * @param {import('@caplab/mysqlify').Schema} schema
 */
export async function up(schema) {
  await schema.create('{{table}}', (table) => {
    table.id();
    table.timestamps();
  });
}

/**
 * @param {import('@caplab/mysqlify').Schema} schema
 */
export async function down(schema) {
  await schema.drop('{{table}}');
}
