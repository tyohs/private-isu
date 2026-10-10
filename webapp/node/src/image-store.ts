import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool, RowDataPacket } from 'mysql2/promise'

export const imageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/image')

export function imageFilename(id: number, mime: string): string | undefined {
  if (!Number.isSafeInteger(id) || id <= 0) return undefined
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : mime === 'image/gif' ? 'gif' : undefined
  return ext ? `${id}.${ext}` : undefined
}

export async function writeImage(id: number, mime: string, data: Buffer, directory = imageDirectory): Promise<void> {
  const filename = imageFilename(id, mime)
  if (!filename) return
  await mkdir(directory, { recursive: true })
  // nginx only sees the completed file after an atomic rename.
  const temporaryPath = path.join(directory, `.${filename}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporaryPath, data, { mode: 0o644, flag: 'wx' })
    await rename(temporaryPath, path.join(directory, filename))
  } finally {
    await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

export async function clearUploadedImages(directory = imageDirectory): Promise<void> {
  await mkdir(directory, { recursive: true })
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const match = /^([1-9][0-9]*)\.(jpg|png|gif)$/.exec(entry.name)
    if (entry.isFile() && match && Number(match[1]) > 10000) {
      await unlink(path.join(directory, entry.name))
    }
  }
}

export async function exportImages(db: Pick<Pool, 'query'>, directory = imageDirectory): Promise<number> {
  let lastId = 0
  let count = 0
  while (true) {
    // Bound memory use instead of loading every BLOB at once.
    const [posts] = await db.query<RowDataPacket[]>(
      'SELECT `id`, `mime`, `imgdata` FROM `posts` WHERE `id` > ? ORDER BY `id` LIMIT 10',
      [lastId]
    )
    if (posts.length === 0) return count
    for (const post of posts) {
      if (imageFilename(post.id, post.mime)) {
        await writeImage(post.id, post.mime, post.imgdata, directory)
        count++
      }
      lastId = post.id
    }
  }
}
