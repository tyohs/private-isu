import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { clearUploadedImages, exportImages, writeImage } from '../dist/image-store.js'

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'private-isu-images-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('binary data and MIME extensions are preserved; invalid names create no files', async (t) => {
  const directory = await temporaryDirectory(t)
  const data = Buffer.from([0, 255, 1, 128])
  for (const [id, mime, ext] of [[1, 'image/jpeg', 'jpg'], [2, 'image/png', 'png'], [3, 'image/gif', 'gif']]) {
    await writeImage(id, mime, data, directory)
    assert.deepEqual(await readFile(path.join(directory, `${id}.${ext}`)), data)
  }
  for (const [id, mime] of [[0, 'image/png'], [-1, 'image/png'], [1.5, 'image/png'], [4, '../../outside'], [5, 'image/jpg']]) {
    await writeImage(id, mime, data, directory)
  }
  assert.deepEqual((await readdir(directory)).sort(), ['1.jpg', '2.png', '3.gif'])
})

test('readers observe a complete image while an existing file is replaced', async (t) => {
  const directory = await temporaryDirectory(t)
  const oldData = Buffer.alloc(2 * 1024 * 1024, 1)
  const newData = Buffer.alloc(2 * 1024 * 1024, 2)
  await writeImage(1, 'image/jpeg', oldData, directory)
  let completed = false
  const writing = writeImage(1, 'image/jpeg', newData, directory).finally(() => { completed = true })
  do {
    const observed = await readFile(path.join(directory, '1.jpg'))
    assert.ok(observed.equals(oldData) || observed.equals(newData))
  } while (!completed)
  await writing
  assert.deepEqual(await readFile(path.join(directory, '1.jpg')), newData)
  assert.deepEqual(await readdir(directory), ['1.jpg'])
})

test('failed publication removes its temporary file', async (t) => {
  const directory = await temporaryDirectory(t)
  await mkdir(path.join(directory, '1.jpg'))
  await assert.rejects(writeImage(1, 'image/jpeg', Buffer.from('image'), directory))
  assert.deepEqual(await readdir(directory), ['1.jpg'])
})

test('initialization removes only generated images for posts above 10000', async (t) => {
  const directory = await temporaryDirectory(t)
  for (const name of ['1.jpg', '10000.png', '10001.jpg', '10002.png', '10003.gif', 'notes.txt', '010001.jpg']) {
    await writeFile(path.join(directory, name), name)
  }
  await clearUploadedImages(directory)
  assert.deepEqual((await readdir(directory)).sort(), ['010001.jpg', '1.jpg', '10000.png', 'notes.txt'])
  await clearUploadedImages(directory)
})

test('export uses bounded batches and preserves images across sparse IDs', async (t) => {
  const directory = await temporaryDirectory(t)
  const posts = Array.from({ length: 23 }, (_, index) => ({
    id: index * 7 + 1,
    mime: index === 11 ? 'application/octet-stream' : 'image/png',
    imgdata: Buffer.from([index, 0, 255])
  }))
  const cursors = []
  const db = {
    async query(sql, [lastId]) {
      assert.match(sql, /WHERE `id` > \? ORDER BY `id` LIMIT 10$/)
      cursors.push(lastId)
      return [posts.filter((post) => post.id > lastId).slice(0, 10)]
    }
  }
  assert.equal(await exportImages(db, directory), 22)
  assert.deepEqual(cursors, [0, 64, 134, 155])
  for (const post of posts.filter((post) => post.mime === 'image/png')) {
    assert.deepEqual(await readFile(path.join(directory, `${post.id}.png`)), post.imgdata)
  }
})
