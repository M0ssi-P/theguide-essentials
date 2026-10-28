import Database from 'better-sqlite3'
import { xz } from '@napi-rs/lzma'
import * as fsp from 'node:fs/promises'
import type { Sermon } from '../../provider/vgr/types.ts'
import type Table from '../../provider/vgr/table.ts'
import {
    type OpenLanguageIndex,
    LUCENE_DUMP_EXE,
    listProductIds,
    queryProductId,
} from '../../pipeline.ts'
import { SermonsRepository } from './sermon.ts'

export interface JumpFile {
    fromVersion: number
    version: number
    downloadUrl: string
    hash: string
    size: number
}

export function importFullSermon(
    sermonsRepo: SermonsRepository,
    db: Database.Database,
    fullSermon: Sermon,
    lang: string
): void {
    const insertTransaction = db.transaction(() => {
        sermonsRepo.importSermon(fullSermon, lang, (sermonId) => {
            for (const section of fullSermon.sections!!) {
                sermonsRepo.importSections(section, sermonId, (sectionId) => {
                    for (const [p, paragraph] of section.content.entries()) {
                        sermonsRepo.importParagraphs(
                            paragraph,
                            sectionId,
                            p,
                            (paragraphId) => {
                                for (const [l, line] of paragraph.content.entries()) {
                                    sermonsRepo.importLine(line, paragraphId, l)
                                }
                            }
                        )
                    }
                })
            }
        })
    })

    insertTransaction()
}

// Returns the jumps leading from `from` to `to`, or null if the chain is broken.
export function buildJumpChain(
    jumps: JumpFile[],
    from: number,
    to: number
): JumpFile[] | null {
    const chain: JumpFile[] = []
    let current = from
    while (current < to) {
        const next = jumps.find((j) => j.fromVersion === current)
        if (!next) return null
        chain.push(next)
        current = next.version
    }
    return current === to ? chain : null
}

// Reads changed + new sermon date codes (lowercase, e.g. '61-0516m') from an xz-compressed jump db.
export async function readJumpDateCodes(
    xzData: Uint8Array,
    tempDbPath: string
): Promise<Set<string>> {
    await fsp.writeFile(tempDbPath, await xz.decompress(xzData))
    const jumpDb = new Database(tempDbPath, { readonly: true })
    try {
        const rows = jumpDb
            .prepare(
                `SELECT sermon_code_id FROM foreign_sermon_changes
                 UNION SELECT sermon_code_id FROM foreign_new_sermon_translation`
            )
            .all() as { sermon_code_id: string }[]
        return new Set(
            rows.map((r) => r.sermon_code_id.split('_')[0].toLowerCase())
        )
    } finally {
        jumpDb.close()
    }
}

// Sermons in the Lucene index that allSermons doesn't list (e.g. sw 60-0108), optionally limited to `only` (lowercase codes).
export async function indexOnlySermons(
    table: Table,
    sermons: Sermon[],
    index: OpenLanguageIndex,
    lang: string,
    only?: Set<string>
): Promise<Sermon[]> {
    const known = new Set(sermons.map((s) => s.dateCode.toLowerCase()))
    const extra: Sermon[] = []
    for (const productId of await listProductIds(index, LUCENE_DUMP_EXE)) {
        const code = productId.toLowerCase()
        if (known.has(code) || (only && !only.has(code))) continue
        const docs = await queryProductId(index, LUCENE_DUMP_EXE, productId)
        if (docs.length > 0) extra.push(table.sermonFromLucene(docs, lang))
    }
    return extra
}

// shortcut: neighbours' next/prev_sermon_date aren't refreshed when a new sermon is inserted; run /init-db if that matters.
export async function refreshSermons(
    db: Database.Database,
    table: Table,
    sermons: Sermon[],
    dateCodes: Set<string>,
    lang: string,
    index: OpenLanguageIndex | null
): Promise<{ changed: number; added: number; missing: string[] }> {
    db.pragma('foreign_keys = ON')
    const sermonsRepo = new SermonsRepository(db)
    const deleteStmt = db.prepare(
        'DELETE FROM sermons WHERE language_id = ? AND lower(date_code) = ?'
    )
    let changed = 0
    let added = 0
    const missing = new Set(dateCodes)

    for (const sermon of sermons) {
        const code = sermon.dateCode.toLowerCase()
        if (!dateCodes.has(code)) continue
        missing.delete(code)

        const fullSermon = await table.getSermon(sermon, lang, 'KJV', index)
        db.transaction(() => {
            if (deleteStmt.run(lang, code).changes > 0) changed++
            else added++
            importFullSermon(sermonsRepo, db, fullSermon, lang)
        })()
        console.log(`Refreshed ${sermon.dateCode}`)
    }

    // codes in the jump that neither allSermons nor the Lucene index has can't be fetched
    return { changed, added, missing: [...missing] }
}
