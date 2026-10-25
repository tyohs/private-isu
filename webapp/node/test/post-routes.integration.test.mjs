import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { createConnection } from 'mysql2/promise'
import { randomUUID } from 'node:crypto'

// Opt in inside local Compose with CREATE/DROP DATABASE privileges. Clone only
// table definitions into a unique test schema; never write application data.
test('post routes against an isolated MySQL schema', { skip: process.env.ISUCONP_INTEGRATION_TEST !== '1' }, async (t) => {
  const sourceSchema = process.env.ISUCONP_DB_NAME || 'isuconp'
  const testSchema = `private_isu_test_${randomUUID().replaceAll('-', '')}`
  const connection = await createConnection({
    host: process.env.ISUCONP_DB_HOST || 'localhost',
    port: Number(process.env.ISUCONP_DB_PORT) || 3306,
    user: process.env.ISUCONP_DB_USER || 'root',
    password: process.env.ISUCONP_DB_PASSWORD,
    database: sourceSchema,
    charset: 'utf8mb4'
  })
  let fetchApp
  let queries = []
  let createdSchema = false
  try {
    await connection.query(`CREATE DATABASE \`${testSchema}\``)
    createdSchema = true
    await connection.query(`USE \`${testSchema}\``)
    for (const table of ['users', 'posts', 'comments']) {
      await connection.query(`CREATE TABLE \`${table}\` LIKE ${connection.escapeId(sourceSchema)}.\`${table}\``)
    }
    mock.module('@hono/node-server', { namedExports: { serve: ({ fetch }) => { fetchApp = fetch } } })
    mock.module('memcached', { defaultExport: class { set(_key, _value, _ttl, callback) { callback(null) } } })
    mock.module('mysql2/promise', { namedExports: { createPool: () => ({ async query(sql, args) {
      const result = await connection.query(sql, args)
      queries.push({ sql, rows: result[0].length })
      return result
    } }) } })
    await import('../dist/app.js')

    await connection.query('INSERT INTO users (id, account_name, passhash, del_flg) VALUES (1, ?, ?, 0), (2, ?, ?, 1)',
      ['visible', '', 'banned', ''])
    // The newest ten posts are hidden. LIMIT before filtering would return ten
    // visible posts, and an unbounded query would return more than one page.
    for (let id = 1; id <= 40; id++) {
      await connection.query('INSERT INTO posts (id, user_id, body, mime, imgdata, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, id > 30 ? 2 : 1, `body_${id}`, 'image/png', Buffer.alloc(0), new Date(Date.UTC(2020, 0, 1, 0, 0, id))])
    }
    async function request(path) {
      queries = []
      const response = await fetchApp(new Request(`http://localhost${path}`))
      const html = await response.text()
      return { response, html, ids: [...html.matchAll(/class="isu-post" id="pid_(\d+)"/g)].map((m) => Number(m[1])) }
    }
    await t.test('filters banned posts before LIMIT and bounds rows returned by SQL', async () => {
      const { response, ids } = await request('/posts?max_created_at=2021-01-01T00:00:00Z')
      assert.equal(response.status, 200)
      assert.deepEqual(ids, Array.from({ length: 20 }, (_, i) => 30 - i))
      assert.equal(queries[0].rows, 20)
    })
    await t.test('cutoff is inclusive; fewer than twenty and empty pages still work', async () => {
      const cutoff = await request('/posts?max_created_at=2020-01-01T00:00:05Z')
      assert.equal(cutoff.response.status, 200)
      assert.deepEqual(cutoff.ids, [5, 4, 3, 2, 1])
      for (const path of ['/posts', '/posts?max_created_at=', '/posts?max_created_at=2019-01-01T00:00:00Z']) {
        const result = await request(path)
        assert.equal(result.response.status, 200)
        assert.deepEqual(result.ids, [])
      }
    })
    await t.test('equal timestamps keep the visible page size without promising a tie order', async () => {
      await connection.query('UPDATE posts SET created_at = ?', [new Date('2020-01-01T00:00:00Z')])
      const { ids } = await request('/posts?max_created_at=2020-01-01T00:00:00Z')
      assert.equal(ids.length, 20)
      assert.equal(new Set(ids).size, 20)
      assert.ok(ids.every((id) => id <= 30))
    })
    await t.test('all hidden authors produce an empty page', async () => {
      await connection.query('UPDATE users SET del_flg = 1')
      const { response, ids } = await request('/posts?max_created_at=2021-01-01T00:00:00Z')
      assert.equal(response.status, 200)
      assert.deepEqual(ids, [])
    })
  } finally {
    mock.restoreAll()
    try {
      if (createdSchema) await connection.query(`DROP DATABASE \`${testSchema}\``)
    } finally { await connection.end() }
  }
})
