import { Hono, type Context, type Next } from 'hono'
import { serve } from '@hono/node-server'
import { getCookie, setCookie } from 'hono/cookie'
import { serveStatic } from '@hono/node-server/serve-static'
import ejs from 'ejs'
import Memcached from 'memcached'
import { createPool, Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import crypto from 'crypto'
import path from 'path'
import { fileURLToPath } from 'url'
import { clearUploadedImages, writeImage } from './image-store.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

type Variables = {
  session: SessionData
  sessionId: string
}

const app = new Hono<{ Variables: Variables }>()
type AppContext = Context<{ Variables: Variables }>
type RenderParams = Record<string, unknown>
type CommentOptions = { allComments?: boolean }
type ParsedBodyValue = string | File | (string | File)[] | undefined
type ParsedBody = Record<string, ParsedBodyValue>

const POSTS_PER_PAGE = 20
const UPLOAD_LIMIT = 10 * 1024 * 1024

const db: Pool = createPool({
  host: process.env.ISUCONP_DB_HOST || 'localhost',
  port: Number(process.env.ISUCONP_DB_PORT) || 3306,
  user: process.env.ISUCONP_DB_USER || 'root',
  password: process.env.ISUCONP_DB_PASSWORD,
  database: process.env.ISUCONP_DB_NAME || 'isuconp',
  connectionLimit: 4,
  charset: 'utf8mb4'
})

interface User {
  id: number
  account_name: string
  passhash: string
  authority: number
  del_flg: number
  created_at: Date
  csrfToken?: string
}

interface Post {
  id: number
  user_id: number
  imgdata: Buffer
  body: string
  mime: string
  created_at: Date
  comment_count?: number
  comments?: Comment[]
  user?: User
}

interface Comment {
  id: number
  post_id: number
  user_id: number
  comment: string
  created_at: Date
  user?: User
}

interface CountRow {
  count: number
}

interface SessionData {
  userId?: number
  csrfToken?: string
  flashNotice?: string
}

const memcachedAddress = process.env.ISUCONP_MEMCACHED_ADDRESS || 'localhost:11211'
const memcached = new Memcached(memcachedAddress)
const SESSION_KEY_PREFIX = 'isuconp-node.session:'
const DEFAULT_SESSION_TTL = 24 * 60 * 60
const parsedTtl = Number(process.env.ISUCONP_SESSION_TTL)
const SESSION_TTL = Number.isFinite(parsedTtl) && parsedTtl > 0 ? Math.floor(parsedTtl) : DEFAULT_SESSION_TTL

function generateSessionId(): string {
  return crypto.randomBytes(16).toString('hex')
}

async function getSessionFromStore(sid: string): Promise<SessionData | undefined> {
  return new Promise((resolve) => {
    memcached.get(SESSION_KEY_PREFIX + sid, (err, data) => {
      if (err) {
        console.error('memcached get error', err)
        resolve(undefined)
        return
      }
      if (!data) {
        resolve(undefined)
        return
      }
      try {
        let raw: string
        if (typeof data === 'string') {
          raw = data
        } else if (Buffer.isBuffer(data)) {
          raw = data.toString('utf8')
        } else {
          resolve(undefined)
          return
        }
        resolve(JSON.parse(raw) as SessionData)
      } catch (e) {
        console.error('memcached parse error', e)
        resolve(undefined)
      }
    })
  })
}

async function saveSessionToStore(sid: string, session: SessionData): Promise<void> {
  return new Promise<void>((resolve) => {
    memcached.set(SESSION_KEY_PREFIX + sid, JSON.stringify(session), SESSION_TTL, (err) => {
      if (err) {
        console.error('memcached set error', err)
      }
      resolve()
    })
  })
}

async function deleteSessionFromStore(sid: string): Promise<void> {
  return new Promise<void>((resolve) => {
    memcached.del(SESSION_KEY_PREFIX + sid, (err) => {
      if (err) {
        console.error('memcached delete error', err)
      }
      resolve()
    })
  })
}

const SESSION_COOKIE_NAME = 'sid'

async function destroySession(c: AppContext): Promise<void> {
  const sid = c.get('sessionId')
  if (sid) {
    await deleteSessionFromStore(sid)
  }
  setCookie(c, SESSION_COOKIE_NAME, '', { maxAge: 0, path: '/' })
}

app.use('*', async (c: AppContext, next: Next): Promise<void> => {
  const existingSid = getCookie(c, SESSION_COOKIE_NAME)
  const sessionFromStore = existingSid ? await getSessionFromStore(existingSid) : undefined
  let session = sessionFromStore
  let isSessionDirty = false
  let sessionId: string
  if (session) {
    sessionId = existingSid as string
  } else {
    sessionId = generateSessionId()
    session = {}
    isSessionDirty = true
    setCookie(c, SESSION_COOKIE_NAME, sessionId, { httpOnly: true, path: '/' })
  }
  const sessionTarget = session as SessionData
  // Dirty tracking only observes direct property replacements; nested mutations require
  // assigning a new object back onto the session to persist.
  const trackedSession = new Proxy(sessionTarget, {
    set(target, prop, value) {
      const current = Reflect.get(target, prop)
      if (current !== value) {
        isSessionDirty = true
      }
      return Reflect.set(target, prop, value)
    },
    deleteProperty(target, prop) {
      if (Reflect.has(target, prop)) {
        isSessionDirty = true
      }
      return Reflect.deleteProperty(target, prop)
    }
  }) as SessionData
  c.set('session', trackedSession)
  c.set('sessionId', sessionId)
  try {
    await next()
  } finally {
    const latestSession = c.get('session') as SessionData | undefined
    if (latestSession === trackedSession && isSessionDirty) {
      await saveSessionToStore(sessionId, sessionTarget)
    }
  }
})

function digest(src: string): string {
  return crypto.createHash('sha512').update(src, 'utf8').digest('hex')
}

function validateUser(accountName: string, password: string): boolean {
  return /^[0-9a-zA-Z_]{3,}$/.test(accountName) && /^[0-9a-zA-Z_]{6,}$/.test(password)
}

function calculatePasshash(accountName: string, password: string): string {
  const salt = digest(accountName)
  return digest(`${password}:${salt}`)
}

const escapeMap: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}

function escapeHtml(src: string): string {
  return src.replace(/[&<>"']/g, (char) => escapeMap[char] || char)
}

function formatBody(body: string): string {
  return escapeHtml(body).replace(/\r?\n/g, '<br>')
}

async function tryLogin(accountName: string, password: string): Promise<User | undefined> {
  const [rows] = await db.query<RowDataPacket[]>('SELECT * FROM users WHERE account_name = ? AND del_flg = 0', [accountName])
  const user = rows[0] as User
  if (!user) return undefined
  const passhash = calculatePasshash(accountName, password)
  if (passhash === user.passhash) return user
  return undefined
}

async function dbInitialize(): Promise<void> {
  const sqls = [
    'DELETE FROM users WHERE id > 1000',
    'DELETE FROM posts WHERE id > 10000',
    'DELETE FROM comments WHERE id > 100000',
    'UPDATE users SET del_flg = 0'
  ]
  await Promise.all(sqls.map((sql) => db.query<ResultSetHeader>(sql)))
  await db.query<ResultSetHeader>('UPDATE users SET del_flg = 1 WHERE id % 50 = 0')
}

function imageUrl(post: Pick<Post, 'id' | 'mime'>): string {
  let ext = ''
  switch (post.mime) {
    case 'image/jpeg':
      ext = '.jpg'
      break
    case 'image/png':
      ext = '.png'
      break
    case 'image/gif':
      ext = '.gif'
      break
  }
  return `/image/${post.id}${ext}`
}

async function makePosts(posts: Post[], options: CommentOptions = {}): Promise<Post[]> {
  const authorIds = [...new Set(posts.filter((post) => !post.user).map((post) => post.user_id))]
  if (authorIds.length > 0) {
    const [rows] = await db.query<RowDataPacket[]>('SELECT * FROM `users` WHERE `id` IN (?)', [authorIds])
    const authors = new Map((rows as User[]).map((user) => [user.id, user]))
    for (const post of posts) post.user ??= authors.get(post.user_id)
  }
  const visible = posts.filter((post) => post.user?.del_flg === 0).slice(0, POSTS_PER_PAGE)
  if (visible.length === 0) return []
  const postIds = visible.map((post) => post.id)
  const counts = new Map<number, number>()
  if (!options.allComments) {
    const [rows] = await db.query<RowDataPacket[]>(
      'SELECT `post_id`, COUNT(*) AS `count` FROM `comments` WHERE `post_id` IN (?) GROUP BY `post_id`', [postIds]
    )
    for (const row of rows) counts.set(row.post_id, row.count)
  }

  // Each branch retains the indexed LIMIT 3; do not fetch every comment and
  // discard the surplus in JavaScript. The outer ORDER BY orders UNION results.
  const commentQuery = options.allComments
    ? 'SELECT * FROM `comments` WHERE `post_id` IN (?) ORDER BY `post_id`, `created_at` DESC'
    : postIds.map(() => '(SELECT * FROM `comments` WHERE `post_id` = ? ORDER BY `created_at` DESC LIMIT 3)')
      .join(' UNION ALL ') + ' ORDER BY `post_id`, `created_at` DESC'
  const [rows] = await db.query<RowDataPacket[]>(commentQuery, options.allComments ? [postIds] : postIds)
  const comments = rows as Comment[]
  const commentUserIds = [...new Set(comments.map((comment) => comment.user_id))]
  const commentsByPost = new Map<number, Comment[]>()
  if (commentUserIds.length > 0) {
    const [userRows] = await db.query<RowDataPacket[]>('SELECT * FROM `users` WHERE `id` IN (?)', [commentUserIds])
    const users = new Map((userRows as User[]).map((user) => [user.id, user]))
    for (const comment of comments) {
      comment.user = users.get(comment.user_id)
      const group = commentsByPost.get(comment.post_id) ?? []
      group.push(comment)
      commentsByPost.set(comment.post_id, group)
    }
  }
  for (const post of visible) {
    post.comments = (commentsByPost.get(post.id) ?? []).reverse()
    post.comment_count = options.allComments ? post.comments.length : counts.get(post.id) ?? 0
  }
  return visible
}

async function render(c: AppContext, view: string, params: RenderParams): Promise<Response> {
  const session = c.get('session') as SessionData
  const messages = { notice: session.flashNotice }
  session.flashNotice = undefined
  const html = await ejs.renderFile(path.join(__dirname, '../views', view), { ...params, messages, formatBody }, { cache: true })
  return c.html(html)
}

async function getSessionUser(c: AppContext): Promise<User | undefined> {
  const session = c.get('session') as SessionData
  if (!session.userId) return undefined
  const [rows] = await db.query<RowDataPacket[]>('SELECT * FROM `users` WHERE `id` = ?', [session.userId])
  const user = rows[0] as User
  if (user) user.csrfToken = session.csrfToken
  return user
}

function ensureString(value: ParsedBodyValue): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const first = value[0]
    if (typeof first === 'string') return first
  }
  return ''
}

const hasFileConstructor = typeof File !== 'undefined'

function ensureFile(value: ParsedBodyValue): File | undefined {
  if (!hasFileConstructor) return undefined
  if (value instanceof File) return value
  if (Array.isArray(value)) {
    const first = value[0]
    if (first instanceof File) return first
  }
  return undefined
}

function ensureStringArray(value: ParsedBodyValue): string[] {
  if (typeof value === 'undefined') return []
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string')
  }
  if (typeof value === 'string') return [value]
  return []
}

app.get('/initialize', async (c: AppContext) => {
  try {
    await dbInitialize()
    await clearUploadedImages()
    return c.text('OK')
  } catch (e) {
    console.error(e)
    return c.text(String(e), 500)
  }
})

app.get('/login', async (c: AppContext) => {
  const me = await getSessionUser(c)
  if (me) return c.redirect('/')
  return render(c, 'login.ejs', { me })
})

app.post('/login', async (c: AppContext) => {
  const me = await getSessionUser(c)
  if (me) return c.redirect('/')
  const body = (await c.req.parseBody()) as ParsedBody
  try {
    const user = await tryLogin(ensureString(body.account_name), ensureString(body.password))
    const session = c.get('session') as SessionData
    if (user) {
      session.userId = user.id
      session.csrfToken = crypto.randomBytes(16).toString('hex')
      return c.redirect('/')
    } else {
      session.flashNotice = 'アカウント名かパスワードが間違っています'
      return c.redirect('/login')
    }
  } catch (e) {
    console.error(e)
    return c.text(String(e instanceof Error ? e.message : e), 500)
  }
})

app.get('/register', async (c: AppContext) => {
  const me = await getSessionUser(c)
  if (me) return c.redirect('/')
  return render(c, 'register.ejs', { me })
})

app.post('/register', async (c: AppContext) => {
  const me = await getSessionUser(c)
  if (me) return c.redirect('/')
  const body = (await c.req.parseBody()) as ParsedBody
  const accountName = ensureString(body.account_name)
  const password = ensureString(body.password)
  const session = c.get('session') as SessionData
  if (!validateUser(accountName, password)) {
    session.flashNotice = 'アカウント名は3文字以上、パスワードは6文字以上である必要があります'
    return c.redirect('/register')
  }
  const [rows] = await db.query<RowDataPacket[]>('SELECT 1 FROM users WHERE `account_name` = ?', [accountName])
  if (rows[0]) {
    session.flashNotice = 'アカウント名がすでに使われています'
    return c.redirect('/register')
  }
  const passhash = calculatePasshash(accountName, password)
  await db.query('INSERT INTO `users` (`account_name`, `passhash`) VALUES (?, ?)', [accountName, passhash])
  const [meRow] = await db.query<RowDataPacket[]>('SELECT * FROM `users` WHERE `account_name` = ?', [accountName])
  const newUser = meRow[0] as User
  session.userId = newUser.id
  session.csrfToken = crypto.randomBytes(16).toString('hex')
  return c.redirect('/')
})

app.get('/logout', async (c: AppContext) => {
  await destroySession(c)
  return c.redirect('/')
})

app.get('/', async (c: AppContext) => {
  try {
    const me = await getSessionUser(c)

    // Keep the timeline driven by newest posts; a user-first join can collect
    // and sort every visible post after the profile's user_id index is added.
    const [postUsers] = await db.query<RowDataPacket[]>(
      'SELECT p.`id`, p.`user_id`, p.`body`, p.`created_at` as post_created_at, p.`mime`, '
      + 'u.`account_name`, u.`passhash`, u.`authority`, u.`del_flg`, u.`created_at`as user_created_at '
      + 'FROM `posts`as p '
      + 'STRAIGHT_JOIN `users` as u '
      + 'ON p.`user_id` = u.`id` '
      + 'WHERE u.`del_flg` = 0 '
      + 'ORDER BY p.`created_at` DESC '
      + 'LIMIT 20'
    )

    const posts: Post[] = postUsers.map((row) => ({
      id: row.id,
      user_id: row.user_id,
      imgdata: Buffer.alloc(0),
      body: row.body,
      mime: row.mime,
      created_at: row.post_created_at,
      user: {
        id: row.user_id,
        account_name: row.account_name,
        passhash: row.passhash,
        authority: row.authority,
        del_flg: row.del_flg,
        created_at: row.user_created_at
      }
    }))
    const enriched = await makePosts(posts)

    return render(c, 'index.ejs', { posts: enriched, me, imageUrl })
  } catch (e) {
    console.error(e)
    return c.text(String(e instanceof Error ? e.message : e), 500)
  }
})

app.get('/:accountName{@[A-Za-z0-9_]+}', async (c: AppContext) => {
  try {
    const accountName = c.req.param('accountName')!.slice(1)
    const [urows] = await db.query<RowDataPacket[]>('SELECT * FROM `users` WHERE `account_name` = ? AND `del_flg` = 0', [accountName])
    const user = urows[0] as User
    if (!user) return c.text('not_found', 404)
    const [postRowData] = await db.query<RowDataPacket[]>(
      'SELECT `id`, `user_id`, `body`, `mime`, `created_at` FROM `posts` WHERE `user_id` = ? ORDER BY `created_at` DESC LIMIT ?',
      [user.id, POSTS_PER_PAGE]
    )
    const posts = await makePosts((postRowData as Post[]).map((post) => ({ ...post, user })))
    const [commentCountRows] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM `comments` WHERE `user_id` = ?', [user.id])
    const commentCount = (commentCountRows[0] as CountRow | undefined)?.count ?? 0
    const [[postCountRow]] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM `posts` WHERE `user_id` = ?', [user.id])
    const postCount = (postCountRow as CountRow).count
    let commentedCount = 0
    if (postCount > 0) {
      const [countRows] = await db.query<RowDataPacket[]>(
        'SELECT COUNT(*) AS count FROM `comments` AS c INNER JOIN `posts` AS p ON p.`id` = c.`post_id` WHERE p.`user_id` = ?',
        [user.id]
      )
      commentedCount = (countRows[0] as CountRow | undefined)?.count ?? 0
    }
    const me = await getSessionUser(c)
    return render(c, 'user.ejs', { me, user, posts, post_count: postCount, comment_count: commentCount, commented_count: commentedCount, imageUrl })
  } catch (e) {
    console.error(e)
    return c.text('ERROR', 500)
  }
})

app.get('/posts', async (c: AppContext) => {
  const maxCreatedAtParam = c.req.query('max_created_at')
  let maxCreatedAt: Date | null = null
  if (typeof maxCreatedAtParam === 'string' && maxCreatedAtParam.length > 0) {
    const parsed = new Date(maxCreatedAtParam)
    if (Number.isNaN(parsed.getTime())) {
      throw new Error('Invalid max_created_at')
    }
    maxCreatedAt = parsed
  }
  // Scan posts in date order and filter hidden authors before filling the page.
  const [postRows] = await db.query<RowDataPacket[]>(
    'SELECT p.`id`, p.`user_id`, p.`body`, p.`mime`, p.`created_at` '
    + 'FROM `posts` AS p STRAIGHT_JOIN `users` AS u ON u.`id` = p.`user_id` '
    + 'WHERE p.`created_at` <= ? AND u.`del_flg` = 0 '
    + 'ORDER BY p.`created_at` DESC LIMIT ?',
    [maxCreatedAt, POSTS_PER_PAGE]
  )
  const posts = postRows as Post[]
  const me = await getSessionUser(c)
  const enriched = await makePosts(posts)
  return render(c, 'posts.ejs', { me, imageUrl, posts: enriched })
})

app.get('/posts/:id', async (c: AppContext) => {
  const id = c.req.param('id')
  const [postRows] = await db.query<RowDataPacket[]>('SELECT `id`, `user_id`, `body`, `mime`, `created_at` FROM `posts` WHERE `id` = ?', [id])
  const posts = postRows as Post[]
  const enriched = await makePosts(posts, { allComments: true })
  const post = enriched[0]
  if (!post) return c.text('not found', 404)
  const me = await getSessionUser(c)
  return render(c, 'post.ejs', { imageUrl, post, me })
})

app.post('/', async (c: AppContext) => {
  const me = await getSessionUser(c)
  if (!me) return c.redirect('/login')
  const body = (await c.req.parseBody()) as ParsedBody
  const session = c.get('session') as SessionData
  if (body.csrf_token !== session.csrfToken) return c.text('invalid CSRF Token', 422)
  const file = ensureFile(body.file)
  if (!file) {
    session.flashNotice = '画像が必須です'
    return c.redirect('/')
  }
  let mime = file.type
  if (!(mime.includes('jpeg') || mime.includes('png') || mime.includes('gif'))) {
    session.flashNotice = '投稿できる画像形式はjpgとpngとgifだけです'
    return c.redirect('/')
  }
  if (file.size > UPLOAD_LIMIT) {
    session.flashNotice = 'ファイルサイズが大きすぎます'
    return c.redirect('/')
  }
  const buffer = Buffer.from(await file.arrayBuffer())
  const [result] = await db.query<ResultSetHeader>('INSERT INTO `posts` (`user_id`, `mime`, `imgdata`, `body`) VALUES (?,?,?,?)', [me.id, mime, buffer, ensureString(body.body)])
  const insertId = result.insertId
  try {
    await writeImage(insertId, mime, buffer)
  } catch (e) {
    // The DB image route still works when the file cannot be saved.
    console.error('image file write failed', e)
  }
  return c.redirect(`/posts/${encodeURIComponent(String(insertId))}`)
})

app.get('/image/:filename{[0-9]+\\.(png|jpg|gif)}', async (c: AppContext) => {
  try {
    const [idString, ext] = c.req.param('filename')!.split('.')
    const id = Number(idString)
    if (id === 0) {
      return new Response('', { status: 200 })
    }
    const [posts] = await db.query<RowDataPacket[]>('SELECT * FROM `posts` WHERE `id` = ?', [id])
    const post = (posts as Post[])[0]
    if (!post) return c.text('image not found', 404)
    if ((ext === 'jpg' && post.mime === 'image/jpeg') || (ext === 'png' && post.mime === 'image/png') || (ext === 'gif' && post.mime === 'image/gif')) {
      try {
        await writeImage(id, post.mime, post.imgdata)
      } catch (e) {
        console.error('image file write failed', e)
      }
      return new Response(new Uint8Array(post.imgdata), { headers: { 'Content-Type': post.mime } })
    }
    return c.text('image not found', 404)
  } catch (e) {
    console.error(e)
    return c.text(String(e instanceof Error ? e.message : e), 500)
  }
})

app.post('/comment', async (c: AppContext) => {
  const me = await getSessionUser(c)
  if (!me) return c.redirect('/login')
  const body = (await c.req.parseBody()) as ParsedBody
  const session = c.get('session') as SessionData
  if (body.csrf_token !== session.csrfToken) return c.text('invalid CSRF Token', 422)
  const postIdString = ensureString(body.post_id)
  if (!/^[0-9]+$/.test(postIdString)) return c.text('post_idは整数のみです')
  await db.query<ResultSetHeader>('INSERT INTO `comments` (`post_id`, `user_id`, `comment`) VALUES (?,?,?)', [Number(postIdString), me.id, ensureString(body.comment)])
  return c.redirect(`/posts/${encodeURIComponent(postIdString)}`)
})

app.get('/admin/banned', async (c: AppContext) => {
  const me = await getSessionUser(c)
  if (!me) return c.redirect('/login')
  if (me.authority === 0) return c.text('authority is required', 403)
  const [userRows] = await db.query<RowDataPacket[]>('SELECT * FROM `users` WHERE `authority` = 0 AND `del_flg` = 0 ORDER BY `created_at` DESC')
  const users = userRows as User[]
  return render(c, 'banned.ejs', { me, users })
})

app.post('/admin/banned', async (c: AppContext) => {
  const me = await getSessionUser(c)
  if (!me) return c.redirect('/')
  if (me.authority === 0) return c.text('authority is required', 403)
  const body = (await c.req.parseBody()) as ParsedBody
  const session = c.get('session') as SessionData
  if (body.csrf_token !== session.csrfToken) return c.text('invalid CSRF Token', 422)
  const query = 'UPDATE `users` SET `del_flg` = ? WHERE `id` = ?'
  const ids = ensureStringArray(body.uid)
  await Promise.all(ids.map((id) => db.query<ResultSetHeader>(query, [1, id])))
  return c.redirect('/admin/banned')
})

app.use('/*', serveStatic({ root: '../public' }))

serve(
  { fetch: app.fetch, port: 8080 },
  (info: { port: number }) => {
    console.log(`server started on ${info.port}`)
  }
)
