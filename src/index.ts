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
import { publishDb, type SourceInfo } from './rs/client-r3.ts'

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

    let table = new Table()
    let languages = table.getAllLanguages()
    let en = languages.find((x) => x.tag === 'sw')
    if (!en) {
        res.status(500).json({
            status: 'error',
            message: 'English language not found',
        })
        return
    }

    let sermons = await table.getAllSermons(en, "sw")
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sermons-db-'))
    const dbPath = path.join(tempDir, 'table-sw.db')
    const db = new Database(dbPath)

    const tableUpdateChecker = await table.client
        .get('https://updater.branham.org/api/table/catalog')
        .then((r) => r.data)

    let checker: SourceInfo = tableUpdateChecker['swa']

    const index = await openLanguageIndex({
        zipUrl: checker.downloadUrl,
    })

    try {
        startTableStatement(db)
        createUpdatedAtTrigger(db)

        let sermonsRepo = new SermonsRepository(db)

        for (const sermon of sermons) {
            console.log(
                `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)} MB before ${sermon.dateCode}`
            )
            let fullSermon = await table.getSermon(sermon, 'sw', 'KJV', index)

            const insertTransaction = db.transaction(() => {
                sermonsRepo.importSermon(fullSermon, 'en', (sermonId) => {
                    for (const section of fullSermon.sections!!) {
                        sermonsRepo.importSections(
                            section,
                            sermonId,
                            (sectionId) => {
                                for (const paragraph of section.content) {
                                    sermonsRepo.importParagraphs(
                                        paragraph,
                                        sectionId,
                                        (paragraphId) => {
                                            for (const line of paragraph.content) {
                                                sermonsRepo.importLine(
                                                    line,
                                                    paragraphId
                                                )
                                            }
                                        }
                                    )
                                }
                            }
                        )
                    }
                })
            })

            insertTransaction()
        }

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

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`)
})
