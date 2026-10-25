import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mock, test } from 'node:test'

function openssl(value) {
  const result = spawnSync('openssl', ['dgst', '-sha512'], { input: value, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim().split(/\s+/).at(-1)
}
function expectedHash(account, password) { return openssl(`${password}:${openssl(account)}`) }
let fetchApp
let user
let inserted
mock.module('@hono/node-server', { namedExports: { serve: ({ fetch }) => { fetchApp = fetch } } })
mock.module('memcached', { defaultExport: class {
  set(_key, _value, _ttl, callback) { callback(null) }
} })
mock.module('mysql2/promise', { namedExports: { createPool: () => ({
  async query(sql, args) {
    if (sql.startsWith('SELECT 1')) return [[]]
    if (sql.startsWith('INSERT INTO `users`')) {
      inserted = args
      user = { id: 1, account_name: args[0], passhash: args[1], del_flg: 0, authority: 0 }
      return [{ insertId: 1 }]
    }
    if (sql.startsWith('SELECT * FROM')) return [[...(user && args[0] === user.account_name ? [user] : [])]]
    throw new Error(`Unexpected query: ${sql}`)
  }
}) } })
await import('../dist/app.js')
function request(route, account, password) {
  return fetchApp(new Request(`http://localhost/${route}`, {
    method: 'POST', body: new URLSearchParams({ account_name: account, password })
  }))
}

test('login accepts existing OpenSSL hashes and rejects wrong passwords', async () => {
  for (const password of ['Valid_123', "quote' dollar$ back` slash\\", '日本語🙂\n改行', '', 'a'.repeat(4096)]) {
    user = { id: 1, account_name: 'existing_user', passhash: expectedHash('existing_user', password), del_flg: 0, authority: 0 }
    const accepted = await request('login', user.account_name, password)
    assert.equal(accepted.status, 302)
    assert.equal(accepted.headers.get('location'), '/')
    const rejected = await request('login', user.account_name, password + 'wrong')
    assert.equal(rejected.status, 302)
    assert.equal(rejected.headers.get('location'), '/login')
  }
  user = undefined
  assert.equal((await request('login', 'missing', 'Valid_123')).headers.get('location'), '/login')
})

test('registration stores the same hash and newly registered credentials can log in', async () => {
  user = undefined
  inserted = undefined
  const response = await request('register', 'new_user', 'Pass_123')
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), '/')
  assert.deepEqual(inserted, ['new_user', expectedHash('new_user', 'Pass_123')])
  assert.equal((await request('login', 'new_user', 'Pass_123')).headers.get('location'), '/')
})
