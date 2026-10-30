import Database from 'better-sqlite3'
import { createHash } from 'crypto'
import type {
    Line,
    Paragraph,
    Section,
    Sermon,
} from '../../provider/vgr/types.ts'

export function generateIdFromName(name: string): string {
    return createHash('sha256').update(name).digest('hex').substring(0, 16)
}

export class SermonsRepository {
    private db: Database.Database

    private readonly insertSermonStmt: Database.Statement
    private readonly updateSermonStmt: Database.Statement
    private readonly insertSectionStmt: Database.Statement
    private readonly insertParagraphStmt: Database.Statement
    private readonly insertLineStmt: Database.Statement
    private readonly getThisDayStmt: Database.Statement

    constructor(db: Database.Database) {
        this.db = db

        this.insertSermonStmt = db.prepare(`
            INSERT OR IGNORE INTO sermons (
                id, language_id, date, date_code, language, location,
                next_sermon_date, prev_sermon_date, title, sort_date,
                minutes, is_cab, has_subtitle, total_sections, c, i, ct
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)

        this.updateSermonStmt = db.prepare(`
            UPDATE sermons SET
            total_sections = ?,
            has_subtitle = ?,
            location = ?
            WHERE id = ?
        `)

        this.insertSectionStmt = db.prepare(`
            INSERT OR IGNORE INTO sections (
                id, sermon_id, can_hit, is_header, key, paragraph
            ) VALUES (?, ?, ?, ?, ?, ?)
        `)

        this.insertParagraphStmt = db.prepare(`
            INSERT OR IGNORE INTO paragraphs (
                id, section_id, hub_id, number, is_first, text
            ) VALUES (?, ?, ?, ?, ?, ?)
        `)

        this.insertLineStmt = db.prepare(`
            INSERT OR IGNORE INTO lines (
                id, paragraph_id, display_number, number, segments
            ) VALUES (?, ?, ?, ?, ?)
        `)

        this.getThisDayStmt = db.prepare(`
            SELECT * FROM sermons WHERE SUBSTR(date_code, LENGTH(date_code) - 3, 4) = ?
        `)
    }

    importSermon(
        sermon: Sermon,
        lang: String,
        getId: (id: string) => void
    ): void {
        const generatedId = generateIdFromName(
            `${lang}:${sermon.title}:${sermon.dateCode}`
        )

        this.insertSermonStmt.run(
            generatedId,
            lang,
            sermon.date,
            sermon.dateCode,
            sermon.language,
            sermon.location,
            sermon.nextSermonDate,
            sermon.prevSermonDate,
            sermon.title,
            sermon.sortDate,
            sermon.minutes,
            sermon.isCab ? 1 : 0,
            sermon.hasSubtitle ? 1 : 0,
            sermon.totalSections,
            sermon.c,
            sermon.i,
            sermon.ct
        )

        getId(generatedId)
    }

    refillSermon(sermon: Sermon, id: string): void {
        this.updateSermonStmt.run(
            sermon.totalSections,
            sermon.hasSubtitle ? 1 : 0,
            sermon.location,
            id
        )
    }

    importSections(
        section: Section,
        sermonId: string,
        idMapper: (id: string) => void
    ): void {
        const generatedId = generateIdFromName(
            `${sermonId}:section:${section.key}`
        )

        this.insertSectionStmt.run(
            generatedId,
            sermonId,
            section.canHit ? 1 : 0,
            section.isHeader ? 1 : 0,
            section.key,
            section.paragraph
        )

        idMapper(generatedId)
    }

    importParagraphs(
        paragraph: Paragraph,
        sectionId: string,
        position: number,
        idMapper: (id: string) => void
    ): void {
        // position keeps paragraphs that share a number (unnumbered ones) from colliding
        const generatedId = generateIdFromName(
            `${sectionId}:paragraph:${position}:${paragraph.number}:${paragraph.id}`
        )

        this.insertParagraphStmt.run(
            generatedId,
            sectionId,
            paragraph.id,
            paragraph.number,
            paragraph.isFirst ? 1 : 0,
            paragraph.text
        )

        idMapper(generatedId)
    }

    importLine(line: Line, paragraphId: string, position: number): void {
        // every line of a paragraph has the paragraph's number, so the id needs its position
        const generatedId = generateIdFromName(
            `${paragraphId}:line:${position}`
        )

        this.insertLineStmt.run(
            generatedId,
            paragraphId,
            line.displayNumber ? 1 : 0,
            line.number,
            JSON.stringify(line.segments)
        )
    }

    getThisDay(dateCode: string): Sermon[] {
        const mmdd = dateCode.replace(/\D/g, '').slice(-4)
        const rows = this.getThisDayStmt.all(mmdd) as Record<string, any>[]

        return rows.map((rs) => ({
            id: null,
            stringId: rs.id,
            date: rs.date,
            dateCode: rs.date_code,
            language: rs.language,
            location: rs.location,
            nextSermonDate: rs.next_sermon_date,
            prevSermonDate: rs.prev_sermon_date,
            title: rs.title,
            sortDate: rs.sort_date,
            minutes: rs.minutes,
            isCab: Boolean(rs.is_cab),
            totalSections: rs.total_sections,
            c: rs.c,
            i: rs.i,
            ct: rs.ct,
        }))
    }
}
