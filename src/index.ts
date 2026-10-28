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
import { startTableStatement } from './db/config/start_statement.ts'
import { SermonsRepository } from './db/table/sermon.ts'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    downloadDb,
    getLatestPointer,
    publishDb,
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

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`)
})
