import {
    S3Client,
    PutObjectCommand,
    HeadObjectCommand,
    GetObjectCommand,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { createReadStream, createWriteStream } from 'fs'
import { createGunzip, createGzip } from 'zlib'
import { pipeline } from 'stream/promises'
import type { Readable } from 'stream'

export interface SourceInfo {
    language: string
    version: number
    luceneVersion: string
    downloadSize: number
    downloadSizeUnpacked: number
    downloadUrl: string
    infobaseJumpFiles?: any
    hash: string
}

export interface LatestPointer {
    key: string
    etag: string
    size: number
    uploadedAt: string
    source?: SourceInfo
}

export interface PublishDbOptions {
    dbPath: string
    kind: string // e.g. "table" or "hymns" — which collection this db belongs to
    id: string // e.g. "en" (for kind "table") or a hymnal name (for kind "hymns")
    source?: SourceInfo
    gzip?: boolean // default true
}

const VALID_SEGMENT = /^[a-zA-Z0-9_-]+$/

function dbKeyFor(kind: string, id: string, gzip: boolean): string {
    return `db/${kind}/${id}.db${gzip ? '.gz' : ''}`
}

function pointerKeyFor(kind: string, id: string): string {
    return `db/${kind}/${id}.latest.json`
}

function getS3Client(): S3Client {
    const accountId = process.env.R2_ACCOUNT_ID
    const accessKeyId = process.env.R2_ACCESS_KEY_ID
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
    if (!accountId || !accessKeyId || !secretAccessKey) {
        throw new Error(
            'Missing one of R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY in your environment'
        )
    }
    return new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey },
    })
}

export async function publishDb(
    options: PublishDbOptions
): Promise<LatestPointer> {
    const { dbPath, kind, id, source, gzip = true } = options

    if (!VALID_SEGMENT.test(kind)) {
        throw new Error(
            `Invalid kind "${kind}" — expected letters/digits/underscore/hyphen only`
        )
    }
    if (!VALID_SEGMENT.test(id)) {
        throw new Error(
            `Invalid id "${id}" — expected letters/digits/underscore/hyphen only`
        )
    }

    const bucket = process.env.R2_BUCKET
    if (!bucket) throw new Error('Missing R2_BUCKET in your environment')

    const s3 = getS3Client()

    const key = dbKeyFor(kind, id, gzip)
    const body = gzip
        ? createReadStream(dbPath).pipe(createGzip())
        : createReadStream(dbPath)

    const upload = new Upload({
        client: s3,
        params: {
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: gzip ? 'application/gzip' : 'application/x-sqlite3',
        },
    })
    await upload.done()

    const head = await s3.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key })
    )

    const pointer: LatestPointer = {
        key,
        etag: (head.ETag ?? '').replace(/"/g, ''),
        size: head.ContentLength ?? 0,
        uploadedAt: new Date().toISOString(),
        ...(source ? { source } : {}),
    }

    await s3.send(
        new PutObjectCommand({
            Bucket: bucket,
            Key: pointerKeyFor(kind, id),
            Body: JSON.stringify(pointer),
            ContentType: 'application/json',
        })
    )

    return pointer
}

export async function getLatestPointer(
    kind: string,
    id: string
): Promise<LatestPointer | null> {
    const bucket = process.env.R2_BUCKET
    if (!bucket) throw new Error('Missing R2_BUCKET in your environment')

    try {
        const obj = await getS3Client().send(
            new GetObjectCommand({
                Bucket: bucket,
                Key: pointerKeyFor(kind, id),
            })
        )
        return JSON.parse(await obj.Body!.transformToString())
    } catch (error: any) {
        if (error?.name === 'NoSuchKey') return null
        throw error
    }
}

export async function downloadDb(
    kind: string,
    id: string,
    destPath: string
): Promise<void> {
    const bucket = process.env.R2_BUCKET
    if (!bucket) throw new Error('Missing R2_BUCKET in your environment')

    const obj = await getS3Client().send(
        new GetObjectCommand({ Bucket: bucket, Key: dbKeyFor(kind, id, true) })
    )
    await pipeline(
        obj.Body as Readable,
        createGunzip(),
        createWriteStream(destPath)
    )
}
