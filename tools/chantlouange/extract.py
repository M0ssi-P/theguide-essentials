"""
Pulls the hymn books out of the Chants de Louange app (com.davidkazad.chantlouange, used with the developer's
permission) into src/datastore/songbooks/chantlouange.json, which the songbook builders read.

The app keeps every book in its code: one class per book whose buildPages() makes a Page(...) per song from string
constants, so this reads the dex and follows those constants. Run it once per new app version:

    pip install androguard
    python -I tools/chantlouange/extract.py <SongsOfPraise.xapk or base .apk> src/datastore/songbooks/chantlouange.json

Only Believe and Nyimbo za Wokovu are in the app too but come from their own sources, so they're left out.
"""
import io
import json
import re
import sys
import unicodedata
import zipfile

from loguru import logger
from androguard.core.dex import DEX, Operand

logger.remove()

# the app's book abbreviation -> our id, title, language and a description
BOOKS = {
    'CC': ('collection-de-cantiques', 'Collection De Cantiques', 'fr',
           'Cantiques en français, swahili, tshiluba et d’autres langues. Hymns in French, Swahili, Tshiluba and more.'),
    'CV': ('chant-de-victoire', 'Chant de Victoire', 'fr', 'Cantiques en français. French hymns.'),
    'CS': ('crois-seulement', 'Crois Seulement', 'fr', 'Only Believe en français. The Only Believe hymns in French.'),
    'NM': ('nyimbo-za-mungu', 'Nyimbo za Mungu', 'sw', 'Nyimbo za Mungu kwa Kiswahili. Swahili hymns.'),
    'NP': ('nyimbo-mipya', 'Nyimbo Mipya', 'lu', 'Nyimbo mipya mu Kiluba. Hymns in Kiluba.'),
    'NB': ('nyimbo-ya-bupandeji', 'Nyimbo ya Bupandeji', 'lu', 'Nyimbo ya bupandeji mu Kiluba. Hymns of salvation in Kiluba.'),
    'Bb': ('bemba-hymns', 'Bemba Hymns', 'bem', 'Inyimbo mu Cibemba, with each hymn’s English title. Bemba hymns.'),
}
SOURCE = 'Chants de Louange app (com.davidkazad.chantlouange), used with the developer’s permission'

CHORUS = re.compile(r'^(refrain|ref|ch(?:oe|œ)ur|chorus|kiitikio)\b\s*[:.]?\s*', re.I)
# a hymnal reference some songs open with ("VAM 16", "HL, 121 NM") rather than words
def is_ref(line):
    tokens = re.findall(r'[A-Za-z]+|\d+|[^\sA-Za-z\d]+', line)
    return any(t.isdigit() for t in tokens) and all(re.fullmatch(r'[A-Z][A-Za-z]{0,4}|\d+|[;,.:/]+', t) for t in tokens)
VERSE_NO = re.compile(r'^(\d{1,2})\s*[.)]\s*')
# the music key Crois Seulement prints after a title ("GRACE ETONNANTE ! Ab")
KEY = re.compile(r'\s+[A-G][b#]?m?$')


# the app's book ids in res/raw/audio_map.json ("1_103", "1_108b": book 1, song 108B) for the books with tunes
# (7 is Only Believe, whose recordings come from elsewhere)
TUNES = {'CC': 1, 'CV': 2, 'CS': 8}


def apk_of(path):
    """The base .apk, as a zip: the file itself, or the one inside an .xapk."""
    z = zipfile.ZipFile(path)
    if 'classes.dex' in z.namelist():
        return z
    base = next(n for n in z.namelist() if n.endswith('.apk') and not n.startswith('config.'))
    return zipfile.ZipFile(io.BytesIO(z.read(base)))


def ob_titles(dex):
    """The app's English Only Believe titles in order (its OB class: words, an ALL-CAPS title, sometimes a music key)."""
    c = next(c for c in DEX(dex).get_classes() if c.get_name().endswith(';') and c.get_superclassname() == 'Lcom/davidkazad/chantlouange/models/Book;'
             and any(i.get_name().startswith('const-string') and i.get_string() == 'Only Believe'
                     for m in c.get_methods() if m.get_code() for i in m.get_code().get_bc().get_instructions()))
    strs = [i.get_string() for m in c.get_methods() if m.get_code() for i in m.get_code().get_bc().get_instructions() if i.get_name().startswith('const-string')]
    return [s.strip() for s in strs[5:] if '\n' not in s and len(s) > 3 and not KEY.fullmatch(' ' + s.strip()) and s.upper() == s and re.search('[A-Z]', s)]


SMALL = {'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with'}


def title_case(t):
    # each word's first letter, past any opening quote, and each part of "Snow-White"
    up = lambda w: re.sub(r'(^|-)(\W*)(\w)', lambda m: m.group(1) + m.group(2) + m.group(3).upper(), w)
    words = t.lower().split()
    return ' '.join(w if i and w in SMALL else up(w) for i, w in enumerate(words))


# Crois Seulement is Only Believe in French, song for song, until the app's English list drifts at 222: these are
# matched by their words instead (226, "Ma richesse, ma gloire", is a French hymn with no Only Believe original)
CS_ENGLISH = {222: 'Take the Name of Jesus with You', 223: 'I’ll Fly Away', 224: 'Nearer, My God, to Thee',
              225: 'Precious Lord, Take My Hand', 226: None}


def plain(t):
    return re.sub(r'[^a-z]', '', unicodedata.normalize('NFKD', t).encode('ascii', 'ignore').decode().lower())


def place_tunes(book_ix, songs, tunes):
    """
    Each song's tune by its number ("1_108b" is song 108B). A tune filed under a bare number whose songs are all
    lettered ("2_147" while the book has 147A and 147B) goes to the one its file is named after.
    """
    by_label = {s['label'].lower(): s for s in songs}
    for key, urls in tunes.items():
        ix, label = key.split('_', 1)
        if ix != str(book_ix):
            continue
        song = by_label.get(label)
        if not song and label.isdigit():
            name = plain(urls[-1].rsplit('/', 1)[-1])
            named = [s for s in songs if str(s['number']) == label and plain(s['title'])[:15] in name]
            # a song's own lettered key ("2_147a") wins over this
            song = named[0] if len(named) == 1 and f"{ix}_{named[0]['label'].lower()}" not in tunes else None
        if song:
            song['songUrl'] = tune(urls)


def tune(urls):
    """The tune to play from a song's list: the full arrangement ("polyinstru") where there is one, else the first."""
    return next((u for u in urls if 'polyinstru' in u), urls[0]) if urls else None


def pages(dex):
    """Every book class's abbreviation and its Page(...) arguments, in order."""
    found = {}
    for c in DEX(dex).get_classes():
        if c.get_superclassname() != 'Lcom/davidkazad/chantlouange/models/Book;':
            continue
        abbr, made = None, []
        for m in c.get_methods():
            code = m.get_code()
            if not code:
                continue
            regs = {}
            for ins in code.get_bc().get_instructions():
                name, ops = ins.get_name(), ins.get_operands()
                if name.startswith('const-string'):
                    regs[ops[0][1]] = ins.get_string()
                    if m.get_name() == '<init>' and abbr is None:
                        abbr = ins.get_string()
                elif name.startswith('const') and not name.startswith('const-class'):
                    regs[ops[0][1]] = ops[1][1] if len(ops) > 1 else None
                elif name.startswith('invoke-direct') and 'models/Page;-><init>(I' in ins.get_output():
                    rs = [o[1] for o in ops if o[0] == Operand.REGISTER]
                    if 'range' in name:
                        rs = list(range(rs[0], rs[-1] + 1))
                    a = [regs.get(r) for r in rs[1:]]
                    if len(a) == 5:  # (id, number, title, content, bookId)
                        made.append(dict(number=a[1], title=a[2], content=a[3], reference='', original=''))
                    else:  # (id, number, reference, title, originalTitle, content, bookId)
                        made.append(dict(number=a[1], reference=a[2], title=a[3], original=a[4], content=a[5]))
        found[abbr] = made
    return found


def parts(text):
    """
    A song's text as verses and choruses: a new part at a blank line, a verse number or a chorus mark. Where a song
    numbers its verses, an unnumbered part after the first verse is its chorus (most of these books don't mark them).
    """
    numbered = any(VERSE_NO.match(l.strip()) for l in text.split('\n'))
    out, cur, n = [], None, 0
    for raw in text.replace('\r', '').split('\n'):
        line = re.sub(r'\s+', ' ', raw.replace('\xa0', ' ')).strip()
        if not line:
            cur = None
            continue
        if CHORUS.match(line):
            cur = {'type': 'chorus', 'n': None, 'lines': []}
            out.append(cur)
            line = CHORUS.sub('', line)
        elif (v := VERSE_NO.match(line)) and (cur is None or cur['type'] == 'chorus' or cur['lines']):
            n = int(v.group(1))
            cur = {'type': 'verse', 'n': n, 'lines': []}
            out.append(cur)
            line = line[v.end():]
        elif cur is None and numbered and out:
            cur = {'type': 'chorus', 'n': None, 'lines': []}
            out.append(cur)
        elif cur is None:
            n += 1
            cur = {'type': 'verse', 'n': n, 'lines': []}
            out.append(cur)
        if line:
            cur['lines'].append(line)
    return [{'type': p['type'], 'n': p['n'], 'text': '\n'.join(p['lines'])} for p in out if p['lines']]


def split_reference(ps):
    """
    Hymnal references moved off the words: a leading line of them ("264 HL, 121 NM") and a closing "Cfr/ IH103 CH23".
    Returns (references or None, parts).
    """
    refs = []
    first = ps[0]['text'] if len(ps) > 1 and '\n' not in ps[0]['text'] else ''
    # or a scripture the song is taken from ("Psaumes 133", "Isaya 9 : 1-6")
    if first and (is_ref(first) and ps[1]['n'] in (1, None) or re.fullmatch(r'[A-Z][^\W\d]+ \d+( ?: ?[\d, -]+)?', first)):
        refs.append(ps[0]['text'])
        ps = ps[1:]
    if len(ps) > 1 and re.match(r'^cfr\b', ps[-1]['text'], re.I):
        refs.append(re.sub(r'^cfr\W*', '', ps[-1]['text'], flags=re.I).replace('\n', ' '))
        ps = ps[:-1]
    return '; '.join(refs) or None, ps


def title_of(t, abbr):
    t = re.sub(r'\s+', ' ', t.replace('\xa0', ' ')).strip()
    if abbr == 'CS':
        t = KEY.sub('', re.sub(r'^\d+\.\s*', '', t))
    return t.rstrip(' ,;:').strip()


def book(abbr, made, tunes):
    bid, title, lang, desc = BOOKS[abbr]
    songs, seen = [], set()
    for p in made:
        label = p['number'].strip().rstrip('.').strip()
        number = int(re.match(r'\d+', label).group())
        if label in seen and label.isdigit() and str(number + 1) not in seen:
            # Bemba prints 250 as a second "249"
            number, label = number + 1, str(number + 1)
        seen.add(label)
        lead, ps = split_reference(parts(p['content']))
        reference = '; '.join(x for x in ((p['reference'] or '').strip(), lead) if x) or None
        songs.append({
            'number': number, 'label': label, 'title': title_of(p['title'], abbr),
            'englishTitle': (p['original'] or '').strip() or None,
            'reference': reference,
            'songUrl': None,
            'parts': ps,
        })
    if abbr in TUNES:
        place_tunes(TUNES[abbr], songs, tunes)
    return {'id': bid, 'title': title, 'description': desc, 'language': lang, 'source': SOURCE, 'songs': songs}


if __name__ == '__main__':
    apk = apk_of(sys.argv[1])
    found = pages(apk.read('classes.dex'))
    tunes = json.loads(apk.read('res/raw/audio_map.json'))
    books = [book(a, found[a], tunes) for a in BOOKS]
    english = ob_titles(apk.read('classes.dex'))
    for s in next(b for b in books if b['id'] == 'crois-seulement')['songs']:
        n = s['number']
        s['englishTitle'] = CS_ENGLISH[n] if n in CS_ENGLISH else title_case(english[n - 1]) if n <= len(english) else None
    for b in books:
        labels = [s['label'] for s in b['songs']]
        assert len(labels) == len(set(labels)), (b['id'], 'repeated numbers')
        assert all(s['parts'] for s in b['songs']), (b['id'], 'a song without words')
    assert parts('1. a\nb\n\nREFRAIN\nc\n2.\nd') == [
        {'type': 'verse', 'n': 1, 'text': 'a\nb'}, {'type': 'chorus', 'n': None, 'text': 'c'}, {'type': 'verse', 'n': 2, 'text': 'd'}]
    assert parts('1. a\n\nb\n\n2. c') == [
        {'type': 'verse', 'n': 1, 'text': 'a'}, {'type': 'chorus', 'n': None, 'text': 'b'}, {'type': 'verse', 'n': 2, 'text': 'c'}]
    assert parts('Chœur : x')[0]['type'] == 'chorus'
    assert split_reference(parts('VAM 16\n\n1. a'))[0] == 'VAM 16'
    assert split_reference(parts('264 HL, 121 NM\n1. a\n\n2. b\n\nCfr/ IH103 CH23')) == (
        '264 HL, 121 NM; IH103 CH23', [{'type': 'verse', 'n': 1, 'text': 'a'}, {'type': 'verse', 'n': 2, 'text': 'b'}])
    assert not is_ref('Quand l’Esprit 2')
    assert title_case('LET’S TALK ABOUT JESUS') == 'Let’s Talk About Jesus' and title_case('THE LORD OF THE HARVEST') == 'The Lord of the Harvest'
    assert title_case('ON THE WINGS OF A SNOW-WHITE DOVE') == 'On the Wings of a Snow-White Dove' and title_case('I CRIED, “HOLY”') == 'I Cried, “Holy”'
    assert tune(['a-mono-piano.mid', 'a-polyinstru.mid']) == 'a-polyinstru.mid' and tune(['x.mid', 'y.mid']) == 'x.mid'
    two = [{'number': 147, 'label': '147A', 'title': 'JÉSUS, TA SAINTE PRÉSENCE', 'songUrl': None},
           {'number': 147, 'label': '147B', 'title': 'SEIGNEUR, CE QUE JE RÉCLAME', 'songUrl': None}]
    place_tunes(2, two, {'2_147': ['x/CV_147a-polyinstru-Jesus_ta_sainte_presence.mid'], '2_147b': ['y.mid'], '1_147a': ['z.mid']})
    assert [s['songUrl'] for s in two] == ['x/CV_147a-polyinstru-Jesus_ta_sainte_presence.mid', 'y.mid']
    assert split_reference(parts('Isaya 9 : 1-6\n\n1. a\n\n2. b'))[0] == 'Isaya 9 : 1-6'
    assert title_of('1. CROIS  SEULEMENT.   C', 'CS') == 'CROIS SEULEMENT.' and title_of('ILS VIENNENT. Eb', 'CS') == 'ILS VIENNENT.'
    with open(sys.argv[2], 'w', encoding='utf-8') as f:
        json.dump({'books': books}, f, ensure_ascii=False, indent=1)
    for b in books:
        print(b['id'], len(b['songs']))
