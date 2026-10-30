CREATE TABLE IF NOT EXISTS chapters (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    usfm TEXT NOT NULL UNIQUE,
    next_usfm TEXT,
    prev_usfm TEXT,
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
)
