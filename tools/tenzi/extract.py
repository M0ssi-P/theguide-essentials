"""
Pulls Tenzi za Rohoni out of its app (TenzizaRohoni APK, used with permission) into src/datastore/songbooks:
tenzi-za-rohoni.json for the songbook builder, and tenzi-za-rohoni/audio/<n>.mid, the app's tunes, which the
songbook route uploads beside the book.

The app ships a SQLite database (assets/tenzi.db): songs(title_no, title, title_en, has_audio) and
verses(title_no, verse_no, verse_text), where verse_text is HTML: an orange "N. " verse number, <br> line breaks and
the chorus inside a verse as <em>…</em>. Run it once per new app version:

    python -I tools/tenzi/extract.py <TenzizaRohoni.apk> src/datastore/songbooks
"""
import html
import json
import os
import re
import sqlite3
import sys
import tempfile
import zipfile

# the app's own typos in its English titles
TITLE_FIXES = {'Whe praise Thee, O God': 'We praise Thee, O God'}


def text(h):
    """HTML to plain lines: <br> breaks, no tags, entities decoded, each line trimmed."""
    h = re.sub(r'<br\s*/?>', '\n', h, flags=re.I)
    t = html.unescape(re.sub(r'<[^>]+>', '', h))
    return '\n'.join(l for l in (re.sub(r'\s+', ' ', x).strip() for x in t.split('\n')) if l)


def parts(rows):
    """A song's verse rows as parts: a verse ("N. " stripped) and, where a row holds the chorus (<em>), a chorus after it."""
    out = []
    for h in rows:
        chorus = re.findall(r'<em>(.*?)</em>', h, flags=re.S | re.I)
        verse = re.sub(r'<em>.*?</em>', '', h, flags=re.S | re.I)
        m = re.match(r'\s*<font[^>]*>\s*(\d+)\.\s*</font>', verse, flags=re.I)
        if m:
            verse = verse[m.end():]
        v = text(verse)
        if v:
            out.append({'type': 'verse', 'n': int(m.group(1)) if m else len([p for p in out if p['type'] == 'verse']) + 1, 'text': v})
        # some choruses are italicised line by line: one chorus all the same
        c = '\n'.join(t for t in map(text, chorus) if t)
        if c:
            out.append({'type': 'chorus', 'n': None, 'text': c})
    return out


def main(apk_path, out_dir):
    apk = zipfile.ZipFile(apk_path)
    with tempfile.TemporaryDirectory() as tmp:
        db_path = os.path.join(tmp, 'tenzi.db')
        with open(db_path, 'wb') as f:
            f.write(apk.read('assets/tenzi.db'))
        db = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
        try:
            verses = {}
            for no, h in db.execute('SELECT title_no, verse_text FROM verses ORDER BY title_no, verse_no'):
                verses.setdefault(no, []).append(h)
            songs = []
            for no, title, en, has_audio in db.execute('SELECT title_no, title, title_en, has_audio FROM songs ORDER BY title_no'):
                en = (en or '').strip() or None
                songs.append({
                    'number': no, 'title': text(title), 'englishTitle': TITLE_FIXES.get(en, en),
                    'hasTune': f'assets/songs/{no}.mid' in apk.namelist(), 'parts': parts(verses.get(no, [])),
                })
        finally:
            db.close()
    audio = os.path.join(out_dir, 'tenzi-za-rohoni', 'audio')
    os.makedirs(audio, exist_ok=True)
    for s in songs:
        if s['hasTune']:
            with open(os.path.join(audio, f"{s['number']}.mid"), 'wb') as f:
                f.write(apk.read(f"assets/songs/{s['number']}.mid"))
    assert all(s['parts'] for s in songs), 'a song without words'
    with open(os.path.join(out_dir, 'tenzi-za-rohoni.json'), 'w', encoding='utf-8') as f:
        json.dump({'songs': songs}, f, ensure_ascii=False, indent=1)
    return songs


if __name__ == '__main__':
    got = parts(['<font color="#FF6F00">1. </font>Twamsifu Mungu,<br> Aliyetufia. <em><font color="#7e8acd">Aleluya!<br/> Amin.</font></em>',
                 '<font color="#FF6F00">2. </font> Pili &amp; tena'])
    assert got == [{'type': 'verse', 'n': 1, 'text': 'Twamsifu Mungu,\nAliyetufia.'}, {'type': 'chorus', 'n': None, 'text': 'Aleluya!\nAmin.'},
                   {'type': 'verse', 'n': 2, 'text': 'Pili & tena'}], got
    assert parts(['a <em>Yesu,</em><br><em>Usinipite.</em>'])[1]['text'] == 'Yesu,\nUsinipite.'
    songs = main(sys.argv[1], sys.argv[2])
    print(len(songs), 'songs,', sum(s['hasTune'] for s in songs), 'tunes,', sum(1 for s in songs if s['englishTitle']), 'English titles,',
          sum(1 for s in songs if any(p['type'] == 'chorus' for p in s['parts'])), 'with a chorus')
