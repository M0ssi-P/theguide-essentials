CREATE TABLE IF NOT EXISTS version (
    id INTEGER PRIMARY KEY,
    abbreviation TEXT NOT NULL,
    local_abbreviation TEXT,
    title TEXT NOT NULL,
    local_title TEXT,
    language_tag TEXT NOT NULL,
    has_audio BOOLEAN NOT NULL DEFAULT 0,
    copyright TEXT,
    publisher TEXT
)
