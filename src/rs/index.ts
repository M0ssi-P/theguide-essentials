export interface Env {
    BUCKET: R2Bucket
    ADMIN_TOKEN: string
}

const JSON_HEADERS = { 'content-type': 'application/json' }
const CORS_HEADERS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,HEAD,PUT,DELETE,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,if-none-match',
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...JSON_HEADERS, ...CORS_HEADERS },
    })
}

function notFound(): Response {
    return json({ error: 'not found' }, 404)
}

function unauthorized(): Response {
    return json({ error: 'unauthorized' }, 401)
}

function requireAuth(request: Request, env: Env): Response | null {
    if (!env.ADMIN_TOKEN)
        return json({ error: 'server misconfigured: ADMIN_TOKEN not set' }, 500)
    const auth = request.headers.get('authorization') ?? ''
    if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return unauthorized()
    return null
}

interface FileMeta {
    key: string
    size: number
    etag: string
    uploaded: string
    contentType: string | null
}

function fileMeta(obj: R2Object): FileMeta {
    return {
        key: obj.key,
        size: obj.size,
        etag: obj.httpEtag,
        uploaded: obj.uploaded.toISOString(),
        contentType: obj.httpMetadata?.contentType ?? null,
    }
}

function metaHeaders(obj: R2Object): Headers {
    const headers = new Headers(CORS_HEADERS)
    headers.set('etag', obj.httpEtag)
    headers.set('last-modified', obj.uploaded.toUTCString())
    headers.set('content-length', String(obj.size))
    if (obj.httpMetadata?.contentType)
        headers.set('content-type', obj.httpMetadata.contentType)
    return headers
}

async function putFile(
    request: Request,
    env: Env,
    key: string
): Promise<Response> {
    const authErr = requireAuth(request, env)
    if (authErr) return authErr
    if (!request.body) return json({ error: 'empty body' }, 400)

    const contentType =
        request.headers.get('content-type') ?? 'application/octet-stream'
    const obj = await env.BUCKET.put(key, request.body, {
        httpMetadata: { contentType },
    })
    if (!obj) return json({ error: 'upload failed' }, 500)
    return json(fileMeta(obj))
}

async function getFile(
    request: Request,
    env: Env,
    key: string
): Promise<Response> {
    const obj = await env.BUCKET.get(key)
    if (!obj) return notFound()

    const ifNoneMatch = request.headers.get('if-none-match')
    if (ifNoneMatch && ifNoneMatch === obj.httpEtag) {
        return new Response(null, { status: 304, headers: metaHeaders(obj) })
    }
    return new Response(obj.body, { headers: metaHeaders(obj) })
}

async function headFile(env: Env, key: string): Promise<Response> {
    const obj = await env.BUCKET.head(key)
    if (!obj) return notFound()
    return new Response(null, { headers: metaHeaders(obj) })
}

async function deleteFile(
    request: Request,
    env: Env,
    key: string
): Promise<Response> {
    const authErr = requireAuth(request, env)
    if (authErr) return authErr
    await env.BUCKET.delete(key)
    return json({ deleted: key })
}

async function listFolder(env: Env, prefix: string): Promise<Response> {
    const normalized = prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix
    const files: FileMeta[] = []
    const folders = new Set<string>()
    let cursor: string | undefined
    do {
        const page = await env.BUCKET.list({
            prefix: normalized,
            delimiter: '/',
            cursor,
        })
        for (const obj of page.objects) files.push(fileMeta(obj))
        for (const p of page.delimitedPrefixes) folders.add(p)
        cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    return json({ prefix: normalized, folders: [...folders], files })
}

async function deleteFolder(
    request: Request,
    env: Env,
    prefix: string
): Promise<Response> {
    const authErr = requireAuth(request, env)
    if (authErr) return authErr
    const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`

    let deleted = 0
    let cursor: string | undefined
    do {
        const page = await env.BUCKET.list({ prefix: normalized, cursor })
        const keys = page.objects.map((o) => o.key)
        if (keys.length) {
            await env.BUCKET.delete(keys) // R2 accepts up to 1000 keys per delete() call
            deleted += keys.length
        }
        cursor = page.truncated ? page.cursor : undefined
    } while (cursor)

    return json({ deletedPrefix: normalized, deletedCount: deleted })
}

const LATEST_POINTER_KEY = 'db/latest.json'
const DB_VERSION_PREFIX = 'db/sermons-'
const KEEP_VERSIONS = 3

interface SourceInfo {
    language: string
    version: number
    luceneVersion: string
    downloadSize: number
    downloadSizeUnpacked: number
    downloadUrl: string
    hash: string
}

const SOURCE_INFO_FIELDS: Array<keyof SourceInfo> = [
    'language',
    'version',
    'luceneVersion',
    'downloadSize',
    'downloadSizeUnpacked',
    'downloadUrl',
    'hash',
]

interface LatestPointer {
    key: string
    etag: string
    size: number
    uploadedAt: string
    source?: SourceInfo
}

function parseSourceInfo(request: Request): SourceInfo | undefined {
    const raw = request.headers.get('x-source-meta')
    if (!raw) return undefined

    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        throw new Error('invalid X-Source-Meta header: not valid JSON')
    }
    if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('invalid X-Source-Meta header: expected a JSON object')
    }

    const p = parsed as Record<string, unknown>
    for (const field of SOURCE_INFO_FIELDS) {
        if (p[field] === undefined || p[field] === null) {
            throw new Error(`invalid X-Source-Meta header: missing "${field}"`)
        }
    }

    return {
        language: String(p.language),
        version: Number(p.version),
        luceneVersion: String(p.luceneVersion),
        downloadSize: Number(p.downloadSize),
        downloadSizeUnpacked: Number(p.downloadSizeUnpacked),
        downloadUrl: String(p.downloadUrl),
        hash: String(p.hash),
    }
}

async function publishDb(request: Request, env: Env): Promise<Response> {
    const authErr = requireAuth(request, env)
    if (authErr) return authErr
    if (!request.body) return json({ error: 'empty body' }, 400)

    let source: SourceInfo | undefined
    try {
        source = parseSourceInfo(request)
    } catch (err) {
        return json({ error: (err as Error).message }, 400)
    }

    const versionedKey = `${DB_VERSION_PREFIX}${Date.now()}.db`
    const obj = await env.BUCKET.put(versionedKey, request.body, {
        httpMetadata: { contentType: 'application/x-sqlite3' },
    })
    if (!obj) return json({ error: 'upload failed' }, 500)

    const pointer: LatestPointer = {
        key: versionedKey,
        etag: obj.httpEtag,
        size: obj.size,
        uploadedAt: obj.uploaded.toISOString(),
        ...(source ? { source } : {}),
    }

    await env.BUCKET.put(LATEST_POINTER_KEY, JSON.stringify(pointer), {
        httpMetadata: { contentType: 'application/json' },
    })

    await pruneOldDbVersions(env, versionedKey)
    return json(pointer)
}

async function pruneOldDbVersions(env: Env, currentKey: string): Promise<void> {
    const page = await env.BUCKET.list({ prefix: DB_VERSION_PREFIX })
    const versions = page.objects
        .filter((o) => o.key !== currentKey)
        .sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())
    const toDelete = versions
        .slice(Math.max(KEEP_VERSIONS - 1, 0))
        .map((o) => o.key)
    if (toDelete.length) await env.BUCKET.delete(toDelete)
}

async function getLatestPointer(env: Env): Promise<LatestPointer | null> {
    const obj = await env.BUCKET.get(LATEST_POINTER_KEY)
    if (!obj) return null
    return JSON.parse(await obj.text()) as LatestPointer
}

async function dbLatest(env: Env): Promise<Response> {
    const pointer = await getLatestPointer(env)
    if (!pointer) return notFound()
    return json(pointer)
}

async function dbDownload(request: Request, env: Env): Promise<Response> {
    const pointer = await getLatestPointer(env)
    if (!pointer) return notFound()
    return request.method === 'HEAD'
        ? headFile(env, pointer.key)
        : getFile(request, env, pointer.key)
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const { pathname } = new URL(request.url)
        const method = request.method.toUpperCase()

        if (method === 'OPTIONS')
            return new Response(null, { headers: CORS_HEADERS })

        try {
            if (pathname === '/table/db/publish' && method === 'POST')
                return await publishDb(request, env)
            if (pathname === '/table/db/latest' && method === 'GET')
                return await dbLatest(env)
            if (
                pathname === '/table/db/download' &&
                (method === 'GET' || method === 'HEAD')
            ) {
                return await dbDownload(request, env)
            }

            if (pathname.startsWith('/folders/')) {
                const prefix = decodeURIComponent(
                    pathname.slice('/folders/'.length)
                )
                if (method === 'GET') return await listFolder(env, prefix)
                if (method === 'DELETE')
                    return await deleteFolder(request, env, prefix)
            }

            if (pathname.startsWith('/files/')) {
                const key = decodeURIComponent(pathname.slice('/files/'.length))
                if (!key) return notFound()
                if (method === 'PUT') return await putFile(request, env, key)
                if (method === 'GET') return await getFile(request, env, key)
                if (method === 'HEAD') return await headFile(env, key)
                if (method === 'DELETE')
                    return await deleteFile(request, env, key)
            }

            return notFound()
        } catch (err) {
            return json({ error: String(err) }, 500)
        }
    },
}
