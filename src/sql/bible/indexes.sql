CREATE INDEX IF NOT EXISTS idx_chapters_book_id ON chapters(book_id);
CREATE INDEX IF NOT EXISTS idx_paragraphs_chapter_id ON paragraphs(chapter_id);
CREATE INDEX IF NOT EXISTS idx_lines_paragraph_id ON lines(paragraph_id);
CREATE INDEX IF NOT EXISTS idx_lines_verse ON lines(verse);
CREATE INDEX IF NOT EXISTS idx_audio_chapter_id ON audio(chapter_id);
CREATE INDEX IF NOT EXISTS idx_audio_voice_id ON audio(voice_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_audio_timings_audio_chapter_verse ON audio_timings(audio_id, chapter_id, verse);
CREATE INDEX IF NOT EXISTS idx_audio_timings_chapter_verse ON audio_timings(chapter_id, verse);
