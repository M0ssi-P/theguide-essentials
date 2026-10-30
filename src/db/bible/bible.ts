import Database from 'better-sqlite3'
import { generateIdFromName } from '../table/sermon.ts'
import type {
    IBibleAudio,
    IBibleParagraph,
    IVerseTiming,
} from '../../provider/bible/types.ts'

export class BibleRepository {
    private db: Database.Database

    private readonly insertVersionStmt: Database.Statement
    private readonly insertBookStmt: Database.Statement
    private readonly insertChapterStmt: Database.Statement
    private readonly insertParagraphStmt: Database.Statement
    private readonly insertLineStmt: Database.Statement
    private readonly insertAudioStmt: Database.Statement
    private readonly insertTimingStmt: Database.Statement

    constructor(db: Database.Database) {
        this.db = db

        this.insertVersionStmt = db.prepare(`
            INSERT OR REPLACE INTO version (
                id, abbreviation, local_abbreviation, title, local_title,
                language_tag, has_audio, copyright, publisher
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)

        this.insertBookStmt = db.prepare(`
            INSERT OR IGNORE INTO books (
                id, usfm, position, human, human_long, abbreviation, canon, has_audio
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)

        this.insertChapterStmt = db.prepare(`
            INSERT OR IGNORE INTO chapters (
                id, book_id, number, usfm, next_usfm, prev_usfm
            ) VALUES (?, ?, ?, ?, ?, ?)
        `)

        this.insertParagraphStmt = db.prepare(`
            INSERT OR IGNORE INTO paragraphs (
                id, chapter_id, position, type, is_heading, heading
            ) VALUES (?, ?, ?, ?, ?, ?)
        `)

        this.insertLineStmt = db.prepare(`
            INSERT OR IGNORE INTO lines (
                id, paragraph_id, position, verse, display_number, segments
            ) VALUES (?, ?, ?, ?, ?, ?)
        `)

        this.insertAudioStmt = db.prepare(`
            INSERT OR IGNORE INTO audio (
                id, voice_id, chapter_id, title, is_default, mp3_url, hls_url, duration_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)

        this.insertTimingStmt = db.prepare(`
            INSERT OR IGNORE INTO audio_timings (
                audio_id, chapter_id, verse, start_ms, end_ms
            ) VALUES (?, ?, ?, ?, ?)
        `)
    }

    // version is the raw /api/bible/version/{id} response
    importVersion(version: any, languageTag: string): void {
        this.insertVersionStmt.run(
            version.id,
            version.abbreviation,
            version.local_abbreviation,
            version.title,
            version.local_title,
            languageTag,
            version.audio ? 1 : 0,
            version.copyright_long?.text ??
                version.copyright_short?.text ??
                null,
            version.publisher?.name ?? null
        )
    }

    importBook(book: any, versionId: number, position: number): string {
        const generatedId = generateIdFromName(
            `${versionId}:book:${position}:${book.usfm}`
        )

        this.insertBookStmt.run(
            generatedId,
            book.usfm,
            position,
            book.human,
            book.human_long,
            book.abbreviation,
            book.canon,
            book.audio ? 1 : 0
        )

        return generatedId
    }

    importChapter(
        bookId: string,
        usfm: string,
        number: number,
        chapter: {
            paragraphs: IBibleParagraph[]
            next: string | null
            prev: string | null
        }
    ): string {
        const chapterId = generateIdFromName(`${bookId}:chapter:${usfm}`)

        this.db.transaction(() => {
            this.insertChapterStmt.run(
                chapterId,
                bookId,
                number,
                usfm,
                chapter.next,
                chapter.prev
            )
            for (const [p, paragraph] of chapter.paragraphs.entries()) {
                const paragraphId = generateIdFromName(
                    `${chapterId}:paragraph:${p}`
                )
                this.insertParagraphStmt.run(
                    paragraphId,
                    chapterId,
                    p,
                    paragraph.type,
                    paragraph.isHeading ? 1 : 0,
                    paragraph.heading
                )
                for (const [l, line] of paragraph.lines.entries()) {
                    this.insertLineStmt.run(
                        generateIdFromName(`${paragraphId}:line:${l}`),
                        paragraphId,
                        l,
                        line.verse,
                        line.displayNumber ? 1 : 0,
                        JSON.stringify(line.segments)
                    )
                }
            }
        })()

        return chapterId
    }

    importAudio(
        chapterId: string,
        audio: IBibleAudio,
        durationMs: number | null,
        timings: IVerseTiming[]
    ): void {
        const audioId = generateIdFromName(`${chapterId}:audio:${audio.id}`)

        this.db.transaction(() => {
            this.insertAudioStmt.run(
                audioId,
                audio.id,
                chapterId,
                audio.title,
                audio.default ? 1 : 0,
                `https:${audio.download_urls.format_mp3_32k}`,
                audio.download_urls.format_hls
                    ? `https:${audio.download_urls.format_hls}`
                    : null,
                durationMs
            )
            for (const t of timings) {
                this.insertTimingStmt.run(
                    audioId,
                    chapterId,
                    t.verse,
                    t.startMs,
                    t.endMs
                )
            }
        })()
    }
}
