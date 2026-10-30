CREATE TABLE IF NOT EXISTS paragraphs (
    id TEXT PRIMARY KEY,
    chapter_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    type TEXT NOT NULL,
    is_heading BOOLEAN NOT NULL,
    heading TEXT,
    FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
)
