import Database from 'better-sqlite3'

export function createUpdatedAtTrigger(db: Database.Database): void {
    const sqlStatements: string[] = [
        `
      CREATE TRIGGER IF NOT EXISTS update_languages_updated_at
      AFTER UPDATE ON languages
      FOR EACH ROW
      WHEN (OLD.updated_at IS NOT NEW.updated_at)
      BEGIN
          UPDATE languages SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
      END;
    `,
        `
      CREATE TRIGGER IF NOT EXISTS update_sermons_updated_at
      AFTER UPDATE ON sermons
      FOR EACH ROW
      WHEN (OLD.updated_at IS NOT NEW.updated_at)
      BEGIN
          UPDATE sermons SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
      END;
    `,
        `
      CREATE TRIGGER IF NOT EXISTS update_sections_updated_at
      AFTER UPDATE ON sections
      FOR EACH ROW
      WHEN (OLD.updated_at IS NOT NEW.updated_at)
      BEGIN
          UPDATE sections SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
      END;
    `,
        `
      CREATE TRIGGER IF NOT EXISTS update_paragraphs_updated_at
      AFTER UPDATE ON paragraphs
      FOR EACH ROW
      WHEN (OLD.updated_at IS NOT NEW.updated_at)
      BEGIN
          UPDATE paragraphs SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
      END;
    `,
        `
      CREATE TRIGGER IF NOT EXISTS update_lines_updated_at
      AFTER UPDATE ON lines
      FOR EACH ROW
      WHEN (OLD.updated_at IS NOT NEW.updated_at)
      BEGIN
          UPDATE lines SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
      END;
    `,
    ]

    const executeTriggers = db.transaction(() => {
        for (const sql of sqlStatements) {
            db.exec(sql)
        }
    })

    executeTriggers()
}
