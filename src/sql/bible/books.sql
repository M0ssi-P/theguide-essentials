CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    usfm TEXT NOT NULL UNIQUE,
    position INTEGER NOT NULL,
    human TEXT NOT NULL,
    human_long TEXT,
    abbreviation TEXT,
    canon TEXT NOT NULL,
    has_audio BOOLEAN NOT NULL DEFAULT 0
)
