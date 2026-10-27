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

    await connection.query('INSERT INTO users (id, account_name, passhash, del_flg) VALUES (1, ?, ?, 0), (2, ?, ?, 1), (3, ?, ?, 0), (4, ?, ?, 0)',
      ['visible', '', 'banned', '', 'other', '', 'empty', ''])
    // The newest ten posts are hidden. LIMIT before filtering would return ten
    // visible posts, and an unbounded query would return more than one page.
    for (let id = 1; id <= 40; id++) {
      await connection.query('INSERT INTO posts (id, user_id, body, mime, imgdata, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, id > 30 ? 2 : id === 25 ? 3 : 1, `body_${id}`, 'image/png', Buffer.alloc(0), new Date(Date.UTC(2020, 0, 1, 0, 0, id))])
    }
    const commentedPosts = [1, 21, 25, 30, 35]
    for (const postId of commentedPosts) {
      for (let i = 0; i < 7; i++) {
        await connection.query('INSERT INTO comments (post_id, user_id, comment, created_at) VALUES (?, ?, ?, ?)',
          [postId, [1, 3, 2][i % 3], `p${postId}_c${i}`, new Date(Date.UTC(2020, 0, 2, 0, 0, i))])
      }
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
    function checkComments(html, all = false) {
      for (const match of html.matchAll(/class="isu-post" id="pid_(\d+)"([\s\S]*?)(?=class="isu-post" id="pid_|$)/g)) {
        const id = Number(match[1])
        const fragment = match[2]
        const hasComments = commentedPosts.includes(id)
        assert.equal(Number(fragment.match(/comments:\s*<b>(\d+)<\/b>/)[1]), hasComments ? 7 : 0)
        assert.deepEqual([...fragment.matchAll(/class="isu-comment-text">(.*?)<\/span>/g)].map((m) => m[1]),
          hasComments ? Array.from({ length: all ? 7 : 3 }, (_, i) => `p${id}_c${i + (all ? 0 : 4)}`) : [])
        assert.deepEqual([...fragment.matchAll(/class="isu-comment-account-name">(.*?)<\/a>/g)].map((m) => m[1]),
          hasComments ? (all ? ['visible', 'other', 'banned', 'visible', 'other', 'banned', 'visible'] : ['other', 'banned', 'visible']) : [])
      }
    }
    await t.test('all lists preserve total counts, latest three, author mapping, and bounded SQL calls', async () => {
      for (const [path, maxQueries] of [['/', 4], ['/posts?max_created_at=2021-01-01T00:00:00Z', 5], ['/@visible', 8]]) {
        const { response, html, ids } = await request(path)
        assert.equal(response.status, 200, html)
        assert.equal(ids.length, 20)
        checkComments(html)
        assert.ok(queries.length <= maxQueries, `${path}: ${queries.length} queries`)
        const commentSelect = queries.find(({ sql }) => sql.startsWith('(SELECT'))
        assert.ok(commentSelect)
        assert.ok(commentSelect.rows <= 60)
      }
    })
    await t.test('profile totals include posts outside the displayed page and comments on hidden posts', async () => {
      const { html } = await request('/@visible')
      assert.match(html, /class="isu-post-count">29<\/span>/)
      assert.match(html, /class="isu-comment-count">15<\/span>/)
      assert.match(html, /class="isu-commented-count">21<\/span>/)
      assert.deepEqual((await request('/@empty')).ids, [])
      assert.equal((await request('/@banned')).response.status, 404)
    })
    await t.test('detail shows every comment; hidden and missing posts stay 404', async () => {
      for (const id of [1, 25, 30]) {
        const { response, html, ids } = await request(`/posts/${id}`)
        assert.equal(response.status, 200, html)
        assert.deepEqual(ids, [id])
        checkComments(html, true)
        assert.equal(queries.length, 4)
      }
      const empty = await request('/posts/2')
      assert.equal(empty.response.status, 200)
      checkComments(empty.html, true)
      for (const id of [35, 99999]) assert.equal((await request(`/posts/${id}`)).response.status, 404)
    })
    await t.test('a newly added comment appears on the next request', async () => {
      await connection.query('INSERT INTO comments (post_id, user_id, comment, created_at) VALUES (30, 3, ?, ?)',
        ['fresh_comment', new Date('2020-01-03T00:00:00Z')])
      for (const path of ['/', '/posts?max_created_at=2021-01-01T00:00:00Z', '/@visible', '/posts/30']) {
        const { html } = await request(path)
        assert.match(html, /fresh_comment/)
        assert.match(html, /comments:\s*<b>8<\/b>/)
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
