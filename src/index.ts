import dotenv from 'dotenv'
import express from 'express'
import bodyParser from 'body-parser'
import cors from 'cors'
import morgan from 'morgan'
import Table from './provider/vgr/table.ts'
import {
    closeLanguageIndex,
    openLanguageIndex,
    queryProductId,
} from './pipeline.ts'
import { buildSentenceIndexById, getDocsForProductId } from './subtitle.ts'
import Database from 'better-sqlite3'
import { createUpdatedAtTrigger } from './db/config/update_at_trigger.ts'
import {
    startBibleStatement,
    startTableStatement,
} from './db/config/start_statement.ts'
import { SermonsRepository } from './db/table/sermon.ts'
import { BibleRepository } from './db/bible/bible.ts'
import Bible from './provider/bible/bible.ts'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    bibleKeyId,
    deleteBibleVersion,
    downloadDb,
    getBibleLanguages,
    getLatestPointer,
    publishDb,
    upsertBibleLanguage,
    upsertBibleVersion,
    type LatestPointer,
    type SourceInfo,
} from './rs/client-r3.ts'
import {
    buildJumpChain,
    importFullSermon,
    indexOnlySermons,
    readJumpDateCodes,
    refreshSermons,
    type JumpFile,
} from './db/table/update.ts'

dotenv.config()
const app = express()

app.use(bodyParser.json())
app.use(cors())
app.use(morgan('dev'))

const PORT = process.env.PORT || 8000

app.get('/init-db', async (req, res) => {
    const adminToken = process.env.ADMIN_TOKEN
    const workerUrl = process.env.WORKER_URL
    if (!adminToken || !workerUrl) {
        res.status(401).json({
            status: 'error',
            message: 'ADMIN_TOKEN or WORKER_URL is not configured',
        })
        return
    }

    console.log(workerUrl, adminToken)

    const lang = String(req.query.lang ?? 'en')
    let table = new Table()
    let languages = table.getAllLanguages()
    let en = languages.find((x) => x.tag === lang)
    if (!en) {
        res.status(400).json({
            status: 'error',
            message: `Unknown lang "${lang}"`,
        })
        return
    }

    let sermons = await table.getAllSermons(en, lang)
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sermons-db-'))
    const dbPath = path.join(tempDir, `table-${lang}.db`)
    const db = new Database(dbPath)

    const tableUpdateChecker = await table.client
        .get('https://updater.branham.org/api/table/catalog')
        .then((r) => r.data)

    let checker: SourceInfo = tableUpdateChecker[en.iso63903]

    const index = await openLanguageIndex({
        zipUrl: checker.downloadUrl,
    })

    try {
        startTableStatement(db)
        createUpdatedAtTrigger(db)

        let sermonsRepo = new SermonsRepository(db)

        sermons.push(...(await indexOnlySermons(table, sermons, index, lang)))

        for (const sermon of sermons) {
            console.log(
                `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)} MB before ${sermon.dateCode}`
            )
            let fullSermon = await table.getSermon(sermon, lang, 'KJV', index)

            importFullSermon(sermonsRepo, db, fullSermon, lang)
        }

        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_sections_sermon_id ON sections(sermon_id);
            CREATE INDEX IF NOT EXISTS idx_paragraphs_section_id ON paragraphs(section_id);
            CREATE INDEX IF NOT EXISTS idx_lines_paragraph_id ON lines(paragraph_id);
            CREATE INDEX IF NOT EXISTS idx_sermons_language_id ON sermons(language_id);
            ANALYZE;
        `)

        db.close()

        delete checker['infobaseJumpFiles']

        const res = await publishDb({
            kind: 'table',
            dbPath,
            source: checker,
            id: checker.language,
        })

        console.log('Published database to worker:', res)
    } catch (error) {
        console.error('Error publishing database to worker:', error)
        if (db.open) db.close()
        await closeLanguageIndex(index)
        await fsp.rm(tempDir, { recursive: true, force: true })
    } finally {
        console.error('Cleaning up resources...')
        if (db.open) db.close()
        await closeLanguageIndex(index)
        await fsp.rm(tempDir, { recursive: true, force: true })
    }

    res.json({
        status: 'success',
        message: 'Database initialized with sermons and related data.',
    })
})

app.get('/update-db', async (req, res) => {
    const lang = String(req.query.lang ?? '')
    const dryRun = req.query.dryRun === '1'

    const table = new Table()
    const language = table.getAllLanguages().find((x) => x.iso63901 === lang)
    if (!language?.iso63903) {
        res.status(400).json({
            status: 'error',
            message: `Unknown lang "${lang}"`,
        })
        return
    }

    const catalog = await table.client
        .get('https://updater.branham.org/api/table/catalog')
        .then((r) => r.data)
    const entry: SourceInfo = catalog[language.iso63903]
    if (!entry) {
        res.status(404).json({
            status: 'error',
            message: `No catalog entry for ${language.iso63903}`,
        })
        return
    }

    const pointer = await getLatestPointer('table', entry.language)
    if (!pointer?.source) {
        res.status(404).json({
            status: 'error',
            message: 'No published DB, run /init-db first',
        })
        return
    }
    const fromVersion = pointer.source.version
    if (fromVersion >= entry.version) {
        res.json({ status: 'up-to-date', version: fromVersion })
        return
    }

    const chain = buildJumpChain(
        (entry.infobaseJumpFiles ?? []) as JumpFile[],
        fromVersion,
        entry.version
    )
    if (!chain) {
        res.status(409).json({
            status: 'error',
            message: `No jump chain from ${fromVersion} to ${entry.version}, run /init-db`,
        })
        return
    }

    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sermons-update-'))
    const dbPath = path.join(tempDir, `table-${lang}.db`)
    let db: Database.Database | null = null
    let index: Awaited<ReturnType<typeof openLanguageIndex>> | null = null

    try {
        const dateCodes = new Set<string>()
        for (const jump of chain) {
            const data = await table.client
                .get(jump.downloadUrl, { responseType: 'arraybuffer' })
                .then((r) => new Uint8Array(r.data))
            const codes = await readJumpDateCodes(
                data,
                path.join(tempDir, `jump-${jump.version}.db`)
            )
            codes.forEach((c) => dateCodes.add(c))
        }

        await downloadDb('table', entry.language, dbPath)
        db = new Database(dbPath)
        index = await openLanguageIndex({ zipUrl: entry.downloadUrl })

        const sermons = await table.getAllSermons(language, lang)
        sermons.push(
            ...(await indexOnlySermons(table, sermons, index, lang, dateCodes))
        )
        const counts = await refreshSermons(
            db,
            table,
            sermons,
            dateCodes,
            lang,
            index
        )
        console.log(`Updated ${fromVersion} -> ${entry.version}:`, counts)
        db.close()

        if (!dryRun) {
            delete entry['infobaseJumpFiles']
            await publishDb({
                kind: 'table',
                dbPath,
                source: entry,
                id: entry.language,
            })
        }

        res.json({
            status: 'success',
            from: fromVersion,
            to: entry.version,
            ...counts,
            ...(dryRun ? { dbPath } : {}),
        })
    } catch (error) {
        console.error('Error updating database:', error)
        res.status(500).json({ status: 'error', message: String(error) })
    } finally {
        if (db?.open) db.close()
        if (index) await closeLanguageIndex(index)
        // dry run keeps the updated db for inspection
        if (!dryRun) await fsp.rm(tempDir, { recursive: true, force: true })
    }
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// the languages that have a published version in R2 (added by /init-bible, removed by DELETE /bible)
app.get('/bible/languages', async (req, res) => {
    try {
        const languages = await getBibleLanguages()
        res.json({ status: 'success', count: languages.length, languages })
    } catch (error) {
        console.error('Error reading bible languages:', error)
        res.status(500).json({ status: 'error', message: String(error) })
    }
})

// DELETE /bible?lang=eng&version=KJV
app.delete('/bible', async (req, res) => {
    const lang = String(req.query.lang ?? '')
    const version = String(req.query.version ?? '')
    if (!lang || !version) {
        res.status(400).json({
            status: 'error',
            message: 'lang and version are required',
        })
        return
    }

    try {
        // accept "en" as well as the folder's tag "eng"
        const tag =
            (await getBibleLanguages()).find(
                (l) => l.tag === lang || l.iso63901 === lang
            )?.tag ?? lang
        const result = await deleteBibleVersion(tag, version)
        if (!result) {
            res.status(404).json({
                status: 'error',
                message: `No published version "${version}" for ${tag}`,
            })
            return
        }
        res.json({
            status: 'success',
            deleted: result.deleted.key,
            remainingVersions: result.remaining,
            languageRemoved: result.remaining === 0,
        })
    } catch (error) {
        console.error('Error deleting bible version:', error)
        res.status(500).json({ status: 'error', message: String(error) })
    }
})

app.get('/init-bible', async (req, res) => {
    const lang = String(req.query.lang ?? 'en')
    const versionQuery = String(req.query.version ?? '').toLowerCase()
    const dryRun = req.query.dryRun === '1'
    // for testing: only build these books, e.g. books=PSA,JHN
    const onlyBooks = req.query.books
        ? String(req.query.books).toUpperCase().split(',')
        : null
    const startedAt = Date.now()

    const bible = new Bible()
    const language = (await bible.getAllLanguages()).find(
        (x) => x.tag === lang || x.iso63901 === lang
    )
    if (!language?.tag) {
        res.status(400).json({
            status: 'error',
            message: `Unknown lang "${lang}"`,
        })
        return
    }

    // without a version, build the language's default one
    const picked = (await bible.getVersions(language.tag)).find((v) =>
        versionQuery
            ? v.abbreviation.toLowerCase() === versionQuery ||
              `${v.id}` === versionQuery
            : v.id === language.id
    )
    if (!picked) {
        res.status(404).json({
            status: 'error',
            message: `No version "${versionQuery}" for ${language.tag}`,
        })
        return
    }

    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bible-db-'))
    const dbPath = path.join(tempDir, `bible-${picked.id}.db`)
    const db = new Database(dbPath)

    try {
        const version = await bible.getFullVersion(picked.id)
        startBibleStatement(db)
        const repo = new BibleRepository(db)
        repo.importVersion(version, language.tag)

        const chapters: {
            bookId: string
            book: string
            usfm: string
            number: number
        }[] = []
        for (const [position, book] of version.books.entries()) {
            if (!book.text || (onlyBooks && !onlyBooks.includes(book.usfm)))
                continue
            const bookId = repo.importBook(book, version.id, position)
            for (const chapter of book.chapters) {
                // intro chapters (BOOK.INTRO1) are not canonical
                if (!chapter.canonical) continue
                chapters.push({
                    bookId,
                    book: book.usfm,
                    usfm: chapter.usfm,
                    number: parseInt(chapter.usfm.split('.')[1]),
                })
            }
        }

        const fetchChapter = async (
            c: (typeof chapters)[number],
            attempt = 1
        ): Promise<Awaited<ReturnType<Bible['getChapter']>>> => {
            try {
                return await bible.getChapter(version.id, c.book, c.number)
            } catch (error) {
                if (attempt >= 3) throw error
                await sleep(2000 * attempt)
                return fetchChapter(c, attempt + 1)
            }
        }

        // fail fast instead of building a version with no audio timings
        await bible.client.get(`${bible.alignerURI}/health`).catch(() => {
            throw new Error(
                `Aligner not reachable at ${bible.alignerURI}, start tools/aligner first`
            )
        })

        let gpuMs = 0
        let failedAlignments = 0
        const pending: Promise<void>[] = []
        for (let i = 0; i < chapters.length; i += 4) {
            const batch = chapters.slice(i, i + 4)
            const fetched = await Promise.all(batch.map((c) => fetchChapter(c)))

            for (const [j, chapter] of fetched.entries()) {
                const c = batch[j]!
                const chapterId = repo.importChapter(
                    c.bookId,
                    c.usfm,
                    c.number,
                    chapter
                )
                for (const audio of chapter.audioInfo) {
                    pending.push(
                        bible
                            .align(
                                `https:${audio.download_urls.format_mp3_32k}`,
                                language.iso63903 ?? language.tag,
                                chapter.verses
                            )
                            .then((r) => {
                                gpuMs += r.gpuMs
                                repo.importAudio(
                                    chapterId,
                                    audio,
                                    r.durationMs,
                                    r.timings
                                )
                            })
                            .catch((error) => {
                                failedAlignments++
                                console.error(
                                    `Alignment failed for ${c.usfm} voice ${audio.id}:`,
                                    String(error)
                                )
                                repo.importAudio(chapterId, audio, null, [])
                            })
                    )
                }
            }
            console.log(`${i + batch.length}/${chapters.length} chapters`)

            // alignment runs behind the fetching; cap the backlog so the GPU stays busy without piling up downloads
            while (pending.length > 8) await pending.shift()
            await sleep(300)
        }
        await Promise.all(pending)

        db.exec('ANALYZE')
        const counts = Object.fromEntries(
            [
                'version',
                'books',
                'chapters',
                'paragraphs',
                'lines',
                'audio',
                'audio_timings',
            ].map((t) => [
                t,
                (
                    db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as {
                        n: number
                    }
                ).n,
            ])
        )
        db.close()

        if (failedAlignments > 0 && !dryRun) {
            throw new Error(
                `${failedAlignments} audio alignments failed, not publishing (rerun, or use dryRun to inspect)`
            )
        }

        const key = bibleKeyId(version.abbreviation, version.id)
        let pointer: LatestPointer | null = null
        if (!dryRun) {
            pointer = await publishDb({
                kind: 'bible',
                folder: `bible/${language.tag}`,
                id: key,
                dbPath,
            })
            await upsertBibleVersion(language.tag, {
                id: version.id,
                abbreviation: version.abbreviation,
                title: version.title,
                localTitle: version.local_title,
                hasAudio: !!version.audio,
                key: pointer.key,
                etag: pointer.etag,
                size: pointer.size,
                uploadedAt: pointer.uploadedAt,
            })
            await upsertBibleLanguage(language)
        }

        res.json({
            status: 'success',
            version: version.abbreviation,
            key,
            chapters: chapters.length,
            counts,
            failedAlignments,
            gpuMs,
            wallMs: Date.now() - startedAt,
            ...(dryRun ? { dbPath } : { pointer }),
        })
    } catch (error) {
        console.error('Error building bible database:', error)
        res.status(500).json({ status: 'error', message: String(error) })
    } finally {
        if (db.open) db.close()
        // dry run keeps the db for inspection
        if (!dryRun) await fsp.rm(tempDir, { recursive: true, force: true })
    }
})

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`)
})
