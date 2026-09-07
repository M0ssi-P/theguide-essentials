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
