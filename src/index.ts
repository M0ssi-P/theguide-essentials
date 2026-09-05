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
import { JSDOM } from 'jsdom'
import { buildSentenceIndexById, getDocsForProductId } from './subtitle.ts'

dotenv.config()
const app = express()

app.use(bodyParser.json())
app.use(cors())
app.use(morgan('dev'))

const PORT = process.env.PORT || 8000

const dom = new JSDOM('')
globalThis.window = dom.window as unknown as Window & typeof globalThis
globalThis.DOMParser = dom.window.DOMParser

app.get('/init-db', async (req, res) => {
    let table = new Table()
    let languages = table.getAllLanguages()
    let en = languages.find((x) => x.tag === 'en')
    if (!en) {
        res.status(500).json({
            status: 'error',
            message: 'English language not found',
        })
        return
    }
    let sermons = await table.getAllSermons(en)
    let sermon = sermons.find((x) => x.dateCode === '63-0318')

    const tableUpdateChecker = await table.client
        .get('https://updater.branham.org/api/table/catalog')
        .then((r) => r.data)

    const index = await openLanguageIndex({
        zipUrl: tableUpdateChecker['eng'].downloadUrl,
    })

    let fullSermon = await table.getSermon(sermon!, 'en', 'KJV', index)

    await closeLanguageIndex(index)
    res.json({
        status: 'success',
        sermon: sermon || null,
        fullSermon: fullSermon || null,
    })
})

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`)
})
