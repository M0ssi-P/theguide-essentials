import Database from 'better-sqlite3'
import { loadSql } from '../../utils/index.ts'

export function startTableStatement(db: Database.Database): void {
    const sqlStatements: string[] = [
        loadSql('languages.sql'),
        loadSql('sermons.sql'),
        loadSql('sections.sql'),
        loadSql('paragraphs.sql'),
        loadSql('lines.sql'),
    ]

    const executeStatements = db.transaction(() => {
        for (const sql of sqlStatements) {
            db.exec(sql)
        }
    })

    executeStatements()
}

export function startBibleStatement(db: Database.Database): void {
    const sqlStatements: string[] = [
        'version.sql',
        'books.sql',
        'chapters.sql',
        'paragraphs.sql',
        'lines.sql',
        'audio.sql',
        'audio_timings.sql',
        'indexes.sql',
    ].map((file) => loadSql(file, 'bible'))

    const executeStatements = db.transaction(() => {
        for (const sql of sqlStatements) {
            db.exec(sql)
        }
    })

    executeStatements()
}
