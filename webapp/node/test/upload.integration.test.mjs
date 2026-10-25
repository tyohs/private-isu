import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { createConnection } from 'mysql2/promise'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { writeImage } from '../dist/image-store.js'

test('uploads preserve binary data against an isolated MySQL schema', { skip: process.env.ISUCONP_INTEGRATION_TEST !== '1' }, async (t) => {
  const sourceSchema = process.env.ISUCONP_DB_NAME || 'isuconp'
  const testSchema = `private_isu_test_${randomUUID().replaceAll('-', '')}`
  const directory = await mkdtemp(path.join(tmpdir(), 'private-isu-upload-'))
  let connection
  let createdSchema = false
  let fetchApp
  let writes = 0
  let failImageWrite = false
  try {
    connection = await createConnection({
      host: process.env.ISUCONP_DB_HOST || 'localhost',
      port: Number(process.env.ISUCONP_DB_PORT) || 3306,
      user: process.env.ISUCONP_DB_USER || 'root',
      password: process.env.ISUCONP_DB_PASSWORD,
      database: sourceSchema,
      charset: 'utf8mb4'
    })
    await connection.query(`CREATE DATABASE \`${testSchema}\``)
    createdSchema = true
    await connection.query(`USE \`${testSchema}\``)
    for (const table of ['users', 'posts']) {
      await connection.query(`CREATE TABLE \`${table}\` LIKE ${connection.escapeId(sourceSchema)}.\`${table}\``)
    }
    await connection.query('INSERT INTO users (id, account_name, passhash, del_flg) VALUES (1, ?, ?, 0)', ['uploader', ''])
    mock.module('@hono/node-server', { namedExports: { serve: ({ fetch }) => { fetchApp = fetch } } })
    mock.module('memcached', { defaultExport: class {
      get(_key, callback) { callback(null, JSON.stringify({ userId: 1, csrfToken: 'upload-test-token' })) }
      set(_key, _value, _ttl, callback) { callback(null) }
    } })
    mock.module('mysql2/promise', { namedExports: { createPool: () => ({
      query: (...args) => connection.query(...args),
      execute: async (...args) => { writes++; return connection.execute(...args) }
    }) } })
    mock.module('../dist/image-store.js', { namedExports: {
      clearUploadedImages: async () => {},
      writeImage: async (id, mime, data) => {
        if (failImageWrite) throw new Error('injected image write failure')
        await writeImage(id, mime, data, directory)
      }
    } })
    await import('../dist/app.js')
    async function upload(data, mime, { csrf = 'upload-test-token', cookie = true, body = '日本語🚀\u0000\'"\\' } = {}) {
      const form = new FormData()
      if (data !== undefined) form.set('file', new File([data], 'upload', { type: mime }))
      form.set('body', body)
      form.set('csrf_token', csrf)
      return fetchApp(new Request('http://localhost/', { method: 'POST', body: form, headers: cookie ? { cookie: 'sid=upload-test-session' } : {} }))
    }
    async function countPosts() {
      const [[row]] = await connection.query('SELECT COUNT(*) AS n FROM posts')
      return row.n
    }
    await t.test('JPEG, PNG and GIF keep every byte, Unicode and SQL-special text', async () => {
      const data = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
      const body = '日本語🚀\u0000\'"\\'
      for (const [mime, extension] of [['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/gif', 'gif']]) {
        const response = await upload(data, mime, { body })
        assert.equal(response.status, 302)
        const id = Number(response.headers.get('location').split('/').at(-1))
        const [[row]] = await connection.query('SELECT user_id, mime, body, imgdata FROM posts WHERE id = ?', [id])
        assert.equal(row.user_id, 1)
        assert.equal(row.mime, mime)
        assert.equal(row.body, body)
        assert.deepEqual(row.imgdata, data)
        assert.deepEqual(await readFile(path.join(directory, `${id}.${extension}`)), data)
        // Real image handler, with the same isolated DB and filesystem writer.
        await unlink(path.join(directory, `${id}.${extension}`))
        const image = await fetchApp(new Request(`http://localhost/image/${id}.${extension}`))
        assert.equal(image.status, 200)
        assert.equal(image.headers.get('content-type'), mime)
        assert.deepEqual(Buffer.from(await image.arrayBuffer()), data)
        assert.deepEqual(await readFile(path.join(directory, `${id}.${extension}`)), data)
      }
      assert.equal(writes, 3)
    })
    await t.test('exactly ten MiB is accepted without truncation', async () => {
      const data = Buffer.alloc(10 * 1024 * 1024, 0xff)
      const response = await upload(data, 'image/png')
      assert.equal(response.status, 302)
      const id = Number(response.headers.get('location').split('/').at(-1))
      const [[row]] = await connection.query('SELECT imgdata FROM posts WHERE id = ?', [id])
      assert.deepEqual(row.imgdata, data)
      assert.deepEqual(await readFile(path.join(directory, `${id}.png`)), data)
    })
    await t.test('invalid uploads, CSRF and anonymous requests never insert', async () => {
      const before = await countPosts()
      const beforeWrites = writes
      assert.equal((await upload(Buffer.alloc(10 * 1024 * 1024 + 1), 'image/png')).status, 302)
      assert.equal((await upload(Buffer.from('x'), 'text/plain')).status, 302)
      assert.equal((await upload(undefined, '')).status, 302)
      assert.equal((await upload(Buffer.from('x'), 'image/png', { csrf: 'wrong' })).status, 422)
      const anonymous = await upload(Buffer.from('x'), 'image/png', { cookie: false })
      assert.equal(anonymous.status, 302)
      assert.equal(anonymous.headers.get('location'), '/login')
      assert.equal(await countPosts(), before)
      assert.equal(writes, beforeWrites)
    })
    await t.test('a failed file write still leaves the DB image readable', async () => {
      const data = Buffer.from([0, 255, 39, 92])
      failImageWrite = true
      const originalError = console.error
      console.error = () => {}
      try {
        const response = await upload(data, 'image/gif')
        assert.equal(response.status, 302)
        const id = Number(response.headers.get('location').split('/').at(-1))
        const image = await fetchApp(new Request(`http://localhost/image/${id}.gif`))
        assert.equal(image.status, 200)
        assert.deepEqual(Buffer.from(await image.arrayBuffer()), data)
      } finally { console.error = originalError; failImageWrite = false }
    })
  } finally {
    mock.restoreAll()
    try {
      if (createdSchema) await connection.query(`DROP DATABASE \`${testSchema}\``)
    } finally {
      if (connection) await connection.end()
      await rm(directory, { recursive: true, force: true })
    }
  }
})
