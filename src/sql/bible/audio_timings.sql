CREATE TABLE IF NOT EXISTS audio_timings (
    audio_id TEXT NOT NULL,
    chapter_id TEXT NOT NULL,
    verse INTEGER NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    FOREIGN KEY (audio_id) REFERENCES audio(id) ON DELETE CASCADE,
    FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
)
