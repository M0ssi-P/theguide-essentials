import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import AdmZip from 'adm-zip'

const execFileAsync = promisify(execFile)

const XOR_KEY = 155

export const LUCENE_DUMP_EXE = 'lucene-dump/bin/Release/net8.0/LuceneDump.exe'

export interface PipelineOptions {
    zipUrl: string
    workDir: string
    luceneDumpExePath: string
}

export interface LuceneDoc {
    [field: string]: string | string[]
}

async function downloadZip(zipUrl: string, destZipPath: string): Promise<void> {
    const res = await fetch(zipUrl)
    if (!res.ok || !res.body) {
        throw new Error(`Failed to download ${zipUrl}: HTTP ${res.status}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    await fsp.writeFile(destZipPath, buf)
}

function unzip(zipPath: string, destDir: string): void {
    const zip = new AdmZip(zipPath)
    zip.extractAllTo(destDir, /* overwrite */ true)
}

async function decryptFolder(
    encryptedDir: string,
    decryptedDir: string
): Promise<void> {
    await fsp.mkdir(decryptedDir, { recursive: true })
    const entries = await fsp.readdir(encryptedDir, { withFileTypes: true })

    for (const entry of entries) {
        const srcPath = path.join(encryptedDir, entry.name)
        const destPath = path.join(decryptedDir, entry.name)

        if (entry.isDirectory()) {
            await decryptFolder(srcPath, destPath)
            continue
        }

        const bytes = await fsp.readFile(srcPath)
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] ^= XOR_KEY
        }
        await fsp.writeFile(destPath, bytes)
        console.log(`Decrypted: ${entry.name}`)
    }
}

async function runLuceneDump(
    luceneDumpExePath: string,
    indexDir: string,
    jsonOutPath: string
): Promise<void> {
    const { stdout, stderr } = await execFileAsync(luceneDumpExePath, [
        indexDir,
        jsonOutPath,
    ])
    if (stdout.trim()) console.log(stdout.trim())
    if (stderr.trim()) console.error(stderr.trim())
}

async function readDocs(jsonOutPath: string): Promise<LuceneDoc[]> {
    const raw = await fsp.readFile(jsonOutPath, 'utf-8')
    return JSON.parse(raw) as LuceneDoc[]
}

async function runLuceneDumpToMemory(
    luceneDumpExePath: string,
    indexDir: string,
    productId?: string
): Promise<LuceneDoc[]> {
    const args = productId ? [indexDir, '-', productId] : [indexDir, '-']
    const { stdout, stderr } = await execFileAsync(luceneDumpExePath, args, {
        maxBuffer: 512 * 1024 * 1024,
    })
    if (stderr.trim()) console.error(stderr.trim())
    return JSON.parse(stdout) as LuceneDoc[]
}

export async function runPipeline(opts: PipelineOptions): Promise<LuceneDoc[]> {
    await fsp.mkdir(opts.workDir, { recursive: true })

    const zipPath = path.join(opts.workDir, 'index.zip')
    const encryptedDir = path.join(opts.workDir, 'encrypted')
    const decryptedDir = path.join(opts.workDir, 'decrypted')
    const jsonOutPath = path.join(opts.workDir, 'docs.json')

    console.log('Downloading...')
    await downloadZip(opts.zipUrl, zipPath)

    console.log('Unzipping...')
    unzip(zipPath, encryptedDir)

    console.log('Decrypting...')
    await decryptFolder(encryptedDir, decryptedDir)

    console.log('Parsing Lucene index (native helper)...')
    await runLuceneDump(opts.luceneDumpExePath, decryptedDir, jsonOutPath)

    console.log('Loading documents...')
    const docs = await readDocs(jsonOutPath)
    console.log(`Loaded ${docs.length} documents.`)
    return docs
}

export interface FetchDocsOptions {
    zipUrl: string
    luceneDumpExePath: string
    productId?: string
    tempDir?: string
}

export interface OpenLanguageIndex {
    indexDir: string
    tempDir: string
}

export interface OpenLanguageIndexOptions {
    zipUrl: string
    tempDir?: string
}

export async function openLanguageIndex(
    opts: OpenLanguageIndexOptions
): Promise<OpenLanguageIndex> {
    const tempDir =
        opts.tempDir ?? (await fsp.mkdtemp(path.join(os.tmpdir(), 'lucene-')))
    const zipPath = path.join(tempDir, 'index.zip')
    const encryptedDir = path.join(tempDir, 'encrypted')
    const decryptedDir = path.join(tempDir, 'decrypted')

    console.log('Downloading language index...')
    await downloadZip(opts.zipUrl, zipPath)

    console.log('Unzipping...')
    unzip(zipPath, encryptedDir)

    console.log('Decrypting...')
    await decryptFolder(encryptedDir, decryptedDir)

    await fsp.rm(zipPath, { force: true })
    await fsp.rm(encryptedDir, { recursive: true, force: true })

    console.log(`Language index ready at ${decryptedDir}`)
    return { indexDir: decryptedDir, tempDir }
}

export async function queryProductId(
    index: OpenLanguageIndex,
    luceneDumpExePath: string,
    productId?: string
): Promise<LuceneDoc[]> {
    return runLuceneDumpToMemory(luceneDumpExePath, index.indexDir, productId)
}

/** Distinct productId values in the index (e.g. "53-0405s", "cab 01 - revelation"). */
export async function listProductIds(
    index: OpenLanguageIndex,
    luceneDumpExePath: string
): Promise<string[]> {
    const { stdout, stderr } = await execFileAsync(
        luceneDumpExePath,
        [index.indexDir, '--ids'],
        { maxBuffer: 64 * 1024 * 1024 }
    )
    if (stderr.trim()) console.error(stderr.trim())
    return JSON.parse(stdout) as string[]
}

export async function closeLanguageIndex(
    index: OpenLanguageIndex
): Promise<void> {
    await fsp.rm(index.tempDir, { recursive: true, force: true })
}

export async function fetchDocsInMemory(
    opts: FetchDocsOptions
): Promise<LuceneDoc[]> {
    const index = await openLanguageIndex({
        zipUrl: opts.zipUrl,
        tempDir: opts.tempDir,
    })
    try {
        const docs = await queryProductId(
            index,
            opts.luceneDumpExePath,
            opts.productId
        )
        console.log(
            `Loaded ${docs.length} documents (no intermediate files left behind).`
        )
        return docs
    } finally {
        await closeLanguageIndex(index)
    }
}

if (typeof require !== 'undefined' && require.main === module) {
    const [zipUrl, workDir, luceneDumpExePath] = process.argv.slice(2)
    if (!zipUrl || !workDir || !luceneDumpExePath) {
        console.error(
            'Usage: pipeline <zipUrl> <workDir> <path-to-LuceneDump.exe>'
        )
        process.exit(1)
    }
    runPipeline({ zipUrl, workDir, luceneDumpExePath })
        .then((docs) => {
            // Example: print the first document's fields.
            if (docs[0]) console.log(JSON.stringify(docs[0], null, 2))
        })
        .catch((err) => {
            console.error(err)
            process.exit(1)
        })
}
