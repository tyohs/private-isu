import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import ejs from 'ejs'

let fetchApp
let posts = []
let comments = []
let queries = []
const created = new Date('2026-01-01T00:00:00Z')
const author = { id: 1, account_name: 'author', passhash: '', authority: 0, del_flg: 0, created_at: created }

mock.module('@hono/node-server', { namedExports: { serve: ({ fetch }) => { fetchApp = fetch } } })
mock.module('memcached', { defaultExport: class {
  set(_key, _value, _ttl, callback) { callback(null) }
} })
mock.module('mysql2/promise', {
  namedExports: {
    createPool: () => ({
      async query(sql, args) {
        queries.push({ sql, args })
        if (sql.includes('LEFT JOIN `users`')) return [structuredClone(posts)]
        if (sql.includes('GROUP BY `post_id`')) {
          // Reverse DB row order to ensure counts are matched by ID, not position.
          return [args[0].toReversed().flatMap((id) => {
            const count = comments.filter((comment) => comment.post_id === id).length
            return count ? [{ post_id: id, count }] : []
          })]
        }
        if (sql.includes('FROM `comments`') && sql.includes('LIMIT 3')) {
          return [structuredClone(comments.filter((comment) => comment.post_id === args[0]).slice(-3).reverse())]
        }
        if (sql.includes('FROM `users`') && sql.includes('IN (?)')) return [[author]]
        throw new Error(`Unexpected query: ${sql}`)
      }
    })
  }
})

await import('../dist/app.js')

for (const counts of [[], [0], [7], Array.from({ length: 20 }, (_, i) => i % 5)]) {
  test(`homepage preserves totals and latest comments for ${JSON.stringify(counts)}`, async () => {
    posts = counts.map((_, i) => ({
      ...author, id: i + 1, user_id: author.id, body: `post${i + 1}`, mime: 'image/png',
      post_created_at: created, user_created_at: created
    }))
    comments = counts.flatMap((count, i) => Array.from({ length: count }, (_, j) => ({
      id: 100 * (i + 1) + j, post_id: i + 1, user_id: author.id,
      comment: `comment_${i + 1}_${j}`, created_at: new Date(created.getTime() + j * 1000)
    })))
    queries = []
    const response = await fetchApp(new Request('http://localhost/'))
    const html = await response.text()
    assert.equal(response.status, 200, html)
    assert.equal([...html.matchAll(/class="isu-post" id="pid_/g)].length, counts.length)
    assert.deepEqual([...html.matchAll(/comments:\s*<b>(\d+)<\/b>/g)].map((match) => Number(match[1])), counts)
    assert.deepEqual([...html.matchAll(/class="isu-comment-text">(.*?)<\/span>/g)].map((match) => match[1]),
      counts.flatMap((count, i) => Array.from({ length: Math.min(count, 3) }, (_, j) => `comment_${i + 1}_${Math.max(0, count - 3) + j}`)))
    const grouped = queries.filter(({ sql }) => sql.includes('GROUP BY `post_id`'))
    assert.equal(grouped.length, counts.length ? 1 : 0)
    if (counts.length) assert.deepEqual(grouped[0].args, [posts.map(({ id }) => id)])
    assert.equal(queries.length, 1 + (counts.length ? 1 : 0) + counts.length + Number(counts.some(Boolean)))
  })
}

test('compiled templates are reused while post and comment contents stay fresh', async () => {
  ejs.clearCache()
  const compile = mock.method(ejs, 'compile')
  try {
    posts = [{ ...author, id: 1, user_id: author.id, body: 'before_body', mime: 'image/png',
      post_created_at: created, user_created_at: created }]
    comments = [{ id: 1, post_id: 1, user_id: author.id, comment: 'before_comment', created_at: created }]
    const before = await (await fetchApp(new Request('http://localhost/'))).text()
    const compiled = compile.mock.callCount()
    assert.ok(compiled > 0)
    assert.match(before, /before_body/)
    assert.match(before, /before_comment/)
    posts[0].body = 'after_body'
    comments[0].comment = 'after_comment'
    const after = await (await fetchApp(new Request('http://localhost/'))).text()
    assert.equal(compile.mock.callCount(), compiled)
    assert.match(after, /after_body/)
    assert.match(after, /after_comment/)
    assert.doesNotMatch(after, /before_body|before_comment/)
  } finally {
    compile.mock.restore()
    ejs.clearCache()
  }
})
