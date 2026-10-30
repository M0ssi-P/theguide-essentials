CREATE TABLE IF NOT EXISTS audio (
    id TEXT PRIMARY KEY,
    voice_id INTEGER NOT NULL,
    chapter_id TEXT NOT NULL,
    title TEXT NOT NULL,
    is_default BOOLEAN NOT NULL,
    mp3_url TEXT NOT NULL,
    hls_url TEXT,
    duration_ms INTEGER,
    FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
)
