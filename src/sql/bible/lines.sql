CREATE TABLE IF NOT EXISTS lines (
    id TEXT PRIMARY KEY,
    paragraph_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    verse INTEGER NOT NULL,
    display_number BOOLEAN NOT NULL,
    segments TEXT NOT NULL,
    FOREIGN KEY (paragraph_id) REFERENCES paragraphs(id) ON DELETE CASCADE
)
