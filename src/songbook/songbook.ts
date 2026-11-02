import axios from 'axios'
import * as cheerio from 'cheerio'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    getJson,
    publishDb,
    putFileIfChanged,
    putJson,
} from '../rs/client-r3.ts'

/*
 * Songbooks for the apps' song store. Every book is one SQLite database on R2 (songbooks/<id>.db.gz, with
 * songbooks/<id>.latest.json beside it), and songbooks/index.json lists them all. The format is the same for every
 * book, so new books only need a builder below.
 */

export interface Part {
    type: 'verse' | 'chorus'
    n: number | null
    text: string
}

export interface Song {
    number: number
    /** The number as printed when it carries a letter ("25B"); the songs sharing 25 sort by it. */
    label?: string
    /** The same song in other hymn books ("SAF 239 ; SSS 237"). */
    reference?: string | null
    title: string
    englishTitle: string | null
    category: string
    author: string | null
    year: string | null
    songUrl: string | null
    parts: Part[]
}

export interface Songbook {
    id: string
    title: string
    description: string
    language: string // BCP-47
    source: string
    songs: Song[]
}

export interface IndexEntry {
    id: string
    title: string
    description: string
    language: string
    songCount: number
    hasAudio: number
    file: string
    size: number
    version: string
    updated: string
}

/** The categories every book shares: id, English, Swahili. */
export const CATEGORIES: [string, string, string][] = [
    ['praise', 'Praise and worship', 'Sifa na kuabudu'],
    ['blood-cross', 'The blood and the cross', 'Damu na msalaba'],
    ['passion', 'Suffering and death of Christ', 'Mateso ya Kristo'],
    ['resurrection', 'Resurrection', 'Kufufuka'],
    ['christmas', 'Christmas', 'Noeli'],
    ['holy-spirit', 'Holy Spirit and Pentecost', 'Roho Mtakatifu'],
    ['prayer', 'Prayer and revival', 'Maombi na uamsho'],
    ['salvation', 'Salvation and testimony', 'Wokovu na ushuhuda'],
    ['invitation', 'Invitation', 'Mwaliko'],
    ['faith-trust', 'Faith, trust and comfort', 'Imani na faraja'],
    ['consecration', 'Surrender and holiness', 'Kujitoa na utakatifu'],
    ['fellowship', 'The church and fellowship', 'Kanisa na ushirika'],
    ['mission', 'Harvest and mission', 'Mavuno na utume'],
    ['pilgrim', 'Pilgrim life', 'Safari ya msafiri'],
    ['heaven', 'Heaven', 'Mbinguni'],
    ['second-coming', 'The second coming', 'Kurudi kwa Yesu'],
    ['children', 'Children', 'Watoto'],
    [
        'occasions',
        'Weddings, dedications, partings',
        'Arusi, kuweka wakfu, kuagana',
    ],
    ['psalms', 'Psalms and scripture songs', 'Zaburi'],
    ['unknown', 'Unknown', 'Haijulikani'],
]

const SCHEMA = `
CREATE TABLE book (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, language TEXT NOT NULL, version TEXT NOT NULL, source TEXT);
CREATE TABLE category (id TEXT PRIMARY KEY, name_en TEXT NOT NULL, name_sw TEXT NOT NULL, sort INTEGER NOT NULL);
-- label is the song's number as printed ("25", or "25B" where a book prints two songs under 25); number sorts it
CREATE TABLE song (book_id TEXT NOT NULL, number INTEGER NOT NULL, label TEXT NOT NULL, title TEXT NOT NULL, english_title TEXT, category TEXT NOT NULL REFERENCES category(id),
    author TEXT, year TEXT, song_url TEXT, reference TEXT, PRIMARY KEY (book_id, label));
CREATE TABLE verse (book_id TEXT NOT NULL, label TEXT NOT NULL, pos INTEGER NOT NULL, type TEXT NOT NULL CHECK (type IN ('verse', 'chorus')), n INTEGER, text TEXT NOT NULL,
    PRIMARY KEY (book_id, label, pos));
CREATE INDEX song_category ON song(book_id, category);
`

/** A content hash: the same songs give the same version, so a rerun with nothing new uploads nothing. */
export function versionOf(book: Songbook): string {
    return createHash('sha1')
        .update(JSON.stringify(book))
        .digest('hex')
        .slice(0, 12)
}

/** Writes [book] as a fresh database at [file]. */
export function buildDb(book: Songbook, file: string, version: string): void {
    const db = new Database(file)
    try {
        db.exec(SCHEMA)
        db.transaction(() => {
            db.prepare('INSERT INTO book VALUES (?, ?, ?, ?, ?, ?)').run(
                book.id,
                book.title,
                book.description,
                book.language,
                version,
                book.source
            )
            const cat = db.prepare('INSERT INTO category VALUES (?, ?, ?, ?)')
            CATEGORIES.forEach(([id, en, sw], i) => cat.run(id, en, sw, i))
            const song = db.prepare(
                'INSERT INTO song VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            )
            const verse = db.prepare(
                'INSERT INTO verse VALUES (?, ?, ?, ?, ?, ?)'
            )
            for (const s of book.songs) {
                const label = s.label ?? String(s.number)
                song.run(
                    book.id,
                    s.number,
                    label,
                    s.title,
                    s.englishTitle,
                    s.category,
                    s.author,
                    s.year,
                    s.songUrl,
                    s.reference ?? null
                )
                s.parts.forEach((p, pos) =>
                    verse.run(book.id, label, pos, p.type, p.n, p.text)
                )
            }
        })()
    } finally {
        db.close()
    }
}

// ---------- Only Believe ----------

const SV_URL = 'https://svfellowship.info/song-book/'
const AUDIO_PAGES = [
    'https://thelivinggodtabernacle.org/malachi-4-5-6/hymns/',
    'https://thelivinggodtabernacle.org/malachi-4-5-6/hymns/2-2/',
    'https://thelivinggodtabernacle.org/only-believe-songs/',
]
// read as bytes and decoded as UTF-8 (the pages' curly quotes came out garbled otherwise)
const fetchHtml = (url: string) =>
    axios
        .get<ArrayBuffer>(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (The Guide songbook builder)',
            },
            responseType: 'arraybuffer',
        })
        .then((r) => Buffer.from(r.data).toString('utf8'))

/** A paragraph's lines, keeping its <br> line breaks. */
function lines($: cheerio.CheerioAPI, el: any): string[] {
    const html = ($(el).html() ?? '').replace(/<br\s*\/?>/gi, '\n')
    return cheerio
        .load(`<div>${html}</div>`)('div')
        .text()
        .split('\n')
        .map((l) => l.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
}

/**
 * The songs on svfellowship.info: each starts with a <p> holding <a name="N"> (or, where the page's anchor shortcode
 * broke, the text "[wpanchor id=N]"), then its heading "N Title" (bold or plain), then its verses and choruses as <p>s.
 */
export function parseSv(html: string): Song[] {
    const $ = cheerio.load(html)
    const songs: Song[] = []
    let cur: Song | null = null
    let verses = 0
    $('.entry-content p').each((_, el) => {
        let ls = lines($, el)
        // songs 8-105 have malformed anchors (`</a name="8">`) that cheerio drops, so a bold "8 Title" first line counts too
        const bold = $(el).find('strong').first().text().trim()
        const anchor =
            $(el).find('a[name]').attr('name') ??
            /^\[wpanchor id=\D*(\d+)/.exec(ls[0] ?? '')?.[1] ??
            (bold && bold === ls[0]
                ? /^(\d+)\.?\s+\S/.exec(bold)?.[1]
                : undefined)
        if (anchor && /^\d+$/.test(anchor)) {
            ls = ls.filter((l) => !l.startsWith('[wpanchor'))
            const heading = ls[0] ?? ''
            // the heading's number ("387 We Are Heirs"): a few anchors on the page carry the wrong one
            const number = Number(/^(\d+)/.exec(heading)?.[1] ?? anchor)
            const title = heading.replace(/^\d+\.?\s*/, '').trim()
            // placeholders ("935" alone, "999 Sorry. The song is not yet on this page.") start no song
            if (!title || /not yet on this page/i.test(ls.join(' '))) {
                cur = null
                return
            }
            cur = {
                number,
                title,
                englishTitle: null,
                category: 'unknown',
                author: null,
                year: null,
                songUrl: null,
                parts: [],
            }
            songs.push(cur)
            verses = 0
            // a few songs start their first verse in the same paragraph as the heading
            const rest = ls.slice(1)
            if (rest.length)
                cur.parts.push({
                    type: 'verse',
                    n: ++verses,
                    text: rest.join('\n'),
                })
            return
        }
        if (!cur) return
        if (!ls.length) return
        if (/^chorus:?$/i.test(ls[0])) {
            if (ls.length > 1)
                cur.parts.push({
                    type: 'chorus',
                    n: null,
                    text: ls.slice(1).join('\n'),
                })
        } else
            cur.parts.push({ type: 'verse', n: ++verses, text: ls.join('\n') })
    })
    return songs
}

export interface Recording {
    url: string
    title: string
}

/** The recordings on the Living God Tabernacle pages: number -> mp3 and its title ("0001 Only Believe"). */
export function parseAudio(html: string): Map<number, Recording> {
    const found = new Map<number, Recording>()
    const link = /<a href=['"]([^'"]+\.mp3)['"]>\s*(\d{1,4})\b\s*([^<]*)<\/a>/gi
    for (const m of html.matchAll(link))
        if (!found.has(Number(m[2])))
            found.set(Number(m[2]), { url: m[1], title: m[3].trim() })
    return found
}

const words = (t: string) =>
    t
        .toLowerCase()
        .replace(/&#?\w+;/g, '')
        .replace(/[^a-z0-9 ]/g, '')
        .replace(/\s+/g, ' ')
        .trim()

export async function onlyBelieve(): Promise<{
    book: Songbook
    report: Record<string, unknown>
}> {
    const audio = new Map<number, Recording>()
    for (const page of AUDIO_PAGES)
        for (const [n, r] of parseAudio(await fetchHtml(page)))
            if (!audio.has(n)) audio.set(n, r)
    // one song per number: a repeat of the same song is dropped; when two different songs share a number, the one
    // the recording of that number is titled after keeps it (else the first), and the other gets a new number after
    // the end of the book
    const byNumber = new Map<number, Song>()
    const repeats: number[] = []
    const moved: Song[] = []
    const clashes: {
        number: number
        kept: string
        moved: string
        to?: number
    }[] = []
    for (const s of parseSv(await fetchHtml(SV_URL))) {
        const had = byNumber.get(s.number)
        if (!had) {
            byNumber.set(s.number, s)
            continue
        }
        if (words(had.title) === words(s.title)) {
            repeats.push(s.number)
            continue
        }
        const rec = audio.get(s.number)
        const keepNew =
            !!rec &&
            words(rec.title) === words(s.title) &&
            words(rec.title) !== words(had.title)
        if (keepNew) byNumber.set(s.number, s)
        moved.push(keepNew ? had : s)
        clashes.push({
            number: s.number,
            kept: keepNew ? s.title : had.title,
            moved: keepNew ? had.title : s.title,
        })
    }
    let next = Math.max(...byNumber.keys()) + 1
    moved.forEach((s, i) => {
        s.number = next++
        clashes[i].to = s.number
        byNumber.set(s.number, s)
    })
    // songs whose new number is past every recording keep no audio; matching below is by number, so they get none
    const songs = [...byNumber.values()].sort((a, b) => a.number - b.number)
    const numbers = new Set(songs.map((s) => s.number))
    for (const s of songs) s.songUrl = audio.get(s.number)?.url ?? null
    // a moved song keeps a recording only when one carries exactly its title
    for (const s of moved)
        s.songUrl =
            [...audio.values()].find((r) => words(r.title) === words(s.title))
                ?.url ?? null
    // recordings whose title differs from the song it was matched to, to check by hand
    const titleMismatch = songs
        .filter(
            (s) =>
                s.songUrl &&
                words(audio.get(s.number)!.title) !== words(s.title)
        )
        .map((s) => ({
            number: s.number,
            song: s.title,
            recording: audio.get(s.number)!.title,
        }))
    const pick = (n: number) => songs.find((s) => s.number === n)
    const sample = [
        songs[0]?.number,
        songs[Math.floor(songs.length / 2)]?.number,
        songs[songs.length - 1]?.number,
    ]
        .filter((n): n is number => n !== undefined)
        .map((n) => ({
            number: n,
            title: pick(n)?.title,
            parts: pick(n)?.parts.length,
            songUrl: pick(n)?.songUrl,
        }))
    return {
        book: {
            id: 'only-believe',
            title: 'Only Believe',
            description:
                'The Only Believe songs, with recordings of how they are sung.',
            language: 'en',
            source: `${SV_URL} (words); thelivinggodtabernacle.org (recordings)`,
            songs,
        },
        report: {
            songs: songs.length,
            withAudio: songs.filter((s) => s.songUrl).length,
            audioFiles: audio.size,
            audioWithoutSong: [...audio.keys()]
                .filter((n) => !numbers.has(n))
                .sort((a, b) => a - b),
            repeats,
            clashes,
            titleMismatch,
            songsWithoutParts: songs
                .filter((s) => !s.parts.length)
                .map((s) => s.number),
            sample,
        },
    }
}

// ---------- Nyimbo za Wokovu ----------

// the hymn book's topics, by song number
const NYIMBO_CATEGORIES =
    '1-3=blood-cross,4=passion,5-13=blood-cross,14=prayer,15=holy-spirit,16-24=prayer,25=holy-spirit,26-29=consecration,30=second-coming,31=pilgrim,32-42=salvation,43=fellowship,44-45=salvation,46-55=faith-trust,56-59=consecration,60-61=fellowship,62-63=consecration,64=faith-trust,65-71=heaven,72=pilgrim,73=heaven,74-77=pilgrim,78-87=heaven,88-92=praise,93-103=second-coming,104-106=christmas,107-113=passion,114-120=blood-cross,121-139=praise,140=faith-trust,141=praise,142-143=salvation,144-145=praise,146=salvation,147=praise,148-151=holy-spirit,152-153=resurrection,154-165=faith-trust,166-168=fellowship,169-171=faith-trust,172=fellowship,173-174=faith-trust,175-187=mission,188-207=invitation,208-210=mission,211-216=invitation,217=second-coming,218-228=children,229-233=blood-cross,234=heaven,235=salvation,236-242=consecration,243-245=faith-trust,246-247=praise,248=faith-trust,249=passion,250=salvation,251-252=praise,253=second-coming,254=praise,255=christmas,256=resurrection,257=second-coming,258-260=heaven,261-265=pilgrim,266-268=prayer,269-270=faith-trust,271=mission,272=consecration,273-278=faith-trust,279=fellowship,280-283=praise,284=resurrection,285=psalms,286-287=occasions,288=prayer,289=heaven,290=second-coming,291-292=blood-cross,293=heaven,294=holy-spirit,295=praise,296=salvation,297=prayer,298-299=praise,300=occasions,301=praise,302=faith-trust,303-305=praise,306=holy-spirit,307=heaven,308-309=praise,310-311=invitation,312=psalms,313=pilgrim,314-315=prayer,316=christmas,317-319=salvation,320=faith-trust,321=praise,322=pilgrim,323=faith-trust,324=second-coming,325=occasions,326-327=second-coming,328=faith-trust,329=prayer,330=mission,331=heaven,332-334=pilgrim,335=consecration,336=salvation,337=praise,338=children,339=heaven,340=mission,341=praise,342=heaven,343=praise,344=second-coming,345=praise,346-347=faith-trust,348=pilgrim,349=heaven,350=praise,351=consecration,352=prayer,353=faith-trust,354=consecration,355=blood-cross,356=salvation,357-358=prayer,359=praise,360=mission'

export function categoryRanges(spec: string): Map<number, string> {
    const map = new Map<number, string>()
    for (const part of spec.split(',')) {
        const [range, id] = part.split('=')
        const [a, b] = range.split('-').map(Number)
        for (let n = a; n <= (b ?? a); n++) map.set(n, id)
    }
    return map
}

interface Extracted {
    songs: {
        number: number
        title: string
        author: string | null
        authorDates: string | null
        parts: {
            type: 'verse' | 'chorus'
            number: number | null
            lines: string[]
        }[]
    }[]
}

/** From the extraction of the Nyimbo za Wokovu app (src/datastore/songbooks), with the developer's permission. */
export async function nyimboZaWokovu(): Promise<{
    book: Songbook
    report: Record<string, unknown>
}> {
    const file = path.join(
        import.meta.dirname,
        '..',
        'datastore',
        'songbooks',
        'nyimbo-za-wokovu.json'
    )
    const data = JSON.parse(await fsp.readFile(file, 'utf8')) as Extracted
    const categories = categoryRanges(NYIMBO_CATEGORIES)
    const songs: Song[] = data.songs.map((s) => ({
        number: s.number,
        title: s.title,
        englishTitle: null,
        category: categories.get(s.number) ?? 'unknown',
        author:
            s.author && s.author !== 'Mtungaji hajulikani' ? s.author : null,
        year: s.authorDates,
        songUrl: null,
        parts: s.parts.map((p) => ({
            type: p.type,
            n: p.number,
            text: p.lines.join('\n'),
        })),
    }))
    return {
        book: {
            id: 'nyimbo-za-wokovu',
            title: 'Nyimbo za Wokovu',
            description:
                'Nyimbo 360 za wokovu kwa Kiswahili. 360 Swahili hymns of salvation.',
            language: 'sw',
            source: "Nyimbo za Wokovu app (com.kags.nyimbozawokovu), used with the developer's permission",
            songs,
        },
        report: {
            songs: songs.length,
            uncategorised: songs
                .filter((s) => s.category === 'unknown')
                .map((s) => s.number),
            withAuthor: songs.filter((s) => s.author).length,
        },
    }
}

// ---------- Chants de Louange ----------

/** A built book, and [files] to put on R2 beside it (a book's own tunes) before the book goes up. */
type Built = {
    book: Songbook
    report: Record<string, unknown>
    files?: { key: string; path: string; contentType: string }[]
}

/**
 * One of the books from the Chants de Louange app (src/datastore/songbooks/chantlouange.json, made by
 * tools/chantlouange/extract.py), with the developer's permission. They carry no categories or authors; songUrl is the
 * app's tune for the song (mostly MIDI) where it has one.
 */
function chantLouange(id: string): () => Promise<Built> {
    return async () => {
        const file = path.join(
            import.meta.dirname,
            '..',
            'datastore',
            'songbooks',
            'chantlouange.json'
        )
        const data = JSON.parse(await fsp.readFile(file, 'utf8')) as {
            books: (Omit<Songbook, 'songs'> & {
                songs: Omit<Song, 'category' | 'author' | 'year'>[]
            })[]
        }
        const b = data.books.find((x) => x.id === id)
        if (!b) throw new Error(`${id} isn't in chantlouange.json`)
        const songs: Song[] = b.songs.map((s) => ({
            ...s,
            category: 'unknown',
            author: null,
            year: null,
            songUrl: s.songUrl ?? null,
        }))
        return {
            book: { ...b, songs },
            report: {
                songs: songs.length,
                lettered: songs.filter((s) => s.label !== String(s.number))
                    .length,
                withChorus: songs.filter((s) =>
                    s.parts.some((p) => p.type === 'chorus')
                ).length,
                withEnglishTitle: songs.filter((s) => s.englishTitle).length,
                withReference: songs.filter((s) => s.reference).length,
                withTune: songs.filter((s) => s.songUrl).length,
                mostParts: Math.max(...songs.map((s) => s.parts.length)),
            },
        }
    }
}

// ---------- Tenzi za Rohoni ----------

// where the apps read R2 files from (FileStore.BASE in the apps)
const FILE_STORE = 'https://theguide-file-store.vrg-theguide.workers.dev/files'

/**
 * From the Tenzi za Rohoni app (src/datastore/songbooks/tenzi-za-rohoni.json and its tunes, made by
 * tools/tenzi/extract.py). Its MIDI tunes ship inside the app, so they're published too, at
 * songbooks/tenzi-za-rohoni/audio/<n>.mid.
 */
async function tenziZaRohoni(): Promise<Built> {
    const dir = path.join(import.meta.dirname, '..', 'datastore', 'songbooks')
    const data = JSON.parse(
        await fsp.readFile(path.join(dir, 'tenzi-za-rohoni.json'), 'utf8')
    ) as {
        songs: {
            number: number
            title: string
            englishTitle: string | null
            hasTune: boolean
            parts: Part[]
        }[]
    }
    const tuneKey = (n: number) => `songbooks/tenzi-za-rohoni/audio/${n}.mid`
    const songs: Song[] = data.songs.map((s) => ({
        number: s.number,
        title: s.title,
        englishTitle: s.englishTitle,
        category: 'unknown',
        author: null,
        year: null,
        songUrl: s.hasTune ? `${FILE_STORE}/${tuneKey(s.number)}` : null,
        parts: s.parts,
    }))
    return {
        book: {
            id: 'tenzi-za-rohoni',
            title: 'Tenzi za Rohoni',
            description:
                'Tenzi za Rohoni kwa Kiswahili, pamoja na sauti za tenzi. Swahili hymns, with their tunes.',
            language: 'sw',
            source: 'Tenzi za Rohoni app (Mpya tenzi 16), used with permission',
            songs,
        },
        files: data.songs
            .filter((s) => s.hasTune)
            .map((s) => ({
                key: tuneKey(s.number),
                path: path.join(
                    dir,
                    'tenzi-za-rohoni',
                    'audio',
                    `${s.number}.mid`
                ),
                contentType: 'audio/midi',
            })),
        report: {
            songs: songs.length,
            withChorus: songs.filter((s) =>
                s.parts.some((p) => p.type === 'chorus')
            ).length,
            withEnglishTitle: songs.filter((s) => s.englishTitle).length,
            withTune: songs.filter((s) => s.songUrl).length,
            mostParts: Math.max(...songs.map((s) => s.parts.length)),
        },
    }
}

export const BUILDERS: Record<string, () => Promise<Built>> = {
    'only-believe': onlyBelieve,
    'nyimbo-za-wokovu': nyimboZaWokovu,
    'tenzi-za-rohoni': tenziZaRohoni,
    ...Object.fromEntries(
        [
            'collection-de-cantiques',
            'chant-de-victoire',
            'crois-seulement',
            'nyimbo-za-mungu',
            'nyimbo-mipya',
            'nyimbo-ya-bupandeji',
            'bemba-hymns',
        ].map((id) => [id, chantLouange(id)])
    ),
}

// ---------- publishing ----------

const INDEX_KEY = 'songbooks/index.json'

/**
 * Builds [id] and publishes it: songbooks/<id>.db.gz and its .latest.json, then the book's line in
 * songbooks/index.json (last, so the apps never list a file that isn't there). Unchanged books are skipped
 * unless [force]; a dry run only builds the database and says where.
 */
export async function publishSongbook(
    id: string,
    opts: { dryRun?: boolean; force?: boolean } = {}
) {
    const builder = BUILDERS[id]
    if (!builder)
        throw new Error(
            `Unknown songbook "${id}" (known: ${Object.keys(BUILDERS).join(', ')})`
        )
    const { book, report, files = [] } = await builder()
    const version = versionOf(book)
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `songbook-${id}-`))
    const file = path.join(dir, `${id}.db`)
    buildDb(book, file, version)
    // every file the book points at must be there
    for (const f of files) await fsp.access(f.path)
    if (opts.dryRun)
        return {
            status: 'dry-run',
            id,
            version,
            dbPath: file,
            files: files.length,
            ...report,
        }

    try {
        // the book's own files first (unchanged ones are skipped), so a song never points at a file that isn't up yet
        let uploaded = 0
        for (const f of files)
            if (
                await putFileIfChanged(
                    f.key,
                    await fsp.readFile(f.path),
                    f.contentType
                )
            )
                uploaded++
        if (files.length)
            Object.assign(report, {
                filesUploaded: uploaded,
                filesUnchanged: files.length - uploaded,
            })
        const index = (await getJson<IndexEntry[]>(INDEX_KEY)) ?? []
        const had = index.find((e) => e.id === id)
        if (had?.version === version && !opts.force)
            return { status: 'unchanged', id, version, ...report }
        const pointer = await publishDb({
            dbPath: file,
            kind: 'songbook',
            id,
            folder: 'songbooks',
        })
        const entry: IndexEntry = {
            id,
            title: book.title,
            description: book.description,
            language: book.language,
            songCount: book.songs.length,
            hasAudio: book.songs.filter((s) => s.songUrl).length,
            file: pointer.key,
            size: pointer.size,
            version,
            updated: pointer.uploadedAt,
        }
        // re-read just before writing, so a book published meanwhile isn't dropped
        const latest = (await getJson<IndexEntry[]>(INDEX_KEY)) ?? []
        await putJson(
            INDEX_KEY,
            [...latest.filter((e) => e.id !== id), entry].sort((a, b) =>
                a.title.localeCompare(b.title)
            )
        )
        return { status: 'published', ...entry, ...report }
    } finally {
        await fsp.rm(dir, { recursive: true, force: true })
    }
}
