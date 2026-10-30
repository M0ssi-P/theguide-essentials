import type { ILanguage } from '../../types/index.ts'
import BibleParser from '../bible_parser.ts'
import fs from 'fs'
import path from 'path'
import type {
    IBibleAudio,
    IBibleParagraph,
    IBibleSegment,
    IBibleVersion,
    IVerseTiming,
} from './types.ts'
import { load } from 'cheerio'
import type { AnyNode } from 'domhandler'

// footnotes and cross references are both span.note; label is the verse number
const SKIPPED = ['note', 'label']
// chapter number and parallel reference lines
const SKIPPED_PARAGRAPHS = ['label', 'cl', 'r', 'mr', 'sr']
const STYLES: Record<string, string> = {
    add: 'Italic',
    it: 'Italic',
    qs: 'Italic',
    tl: 'Italic',
    nd: 'SmallCaps',
    sc: 'SmallCaps',
    bd: 'Bold',
}

const mapLanguage = (it: any): ILanguage => ({
    id: it.id ?? null,
    iso63901: it.iso_639_1,
    iso63903: it.iso_639_3,
    name: it.name,
    localName: it.local_name,
    tag: it.language_tag,
    hasAudio: it.has_audio ?? null,
    hasText: it.has_text ?? null,
    totalVersions: it.total_versions ?? null,
    textDirection: it.text_direction,
    font: it.font ?? null,
})

class Bible extends BibleParser {
    override name: string = 'The Table'
    override saveName: string = 'table'
    override baseURI: string = 'https://www.bible.com'
    isDiverse: boolean = true

    alignerURI = 'http://localhost:8765'

    private header = {
        'X-Requested-With': 'XMLHttpRequest',
        referer: this.baseURI,
    }

    constructor(language: string = 'en') {
        super()

        this.language = language
    }

    override async getAllLanguages(): Promise<ILanguage[]> {
        const res = await this.client.get(
            `${this.baseURI}/api/bible/configuration`,
            {
                headers: this.header,
            }
        )

        return (
            res.data?.response?.data?.default_versions?.map(mapLanguage) ?? []
        )
    }

    async getVersions(
        languageTag: string,
        type: string = 'all'
    ): Promise<IBibleVersion[]> {
        const res = await this.client.get(
            `${this.baseURI}/api/bible/versions?language_tag=${languageTag}&type=${type}`
        )

        return (
            res.data?.response?.data?.versions.map((it: any) => ({
                id: it.id,
                abbreviation: it.abbreviation,
                localAbbreviation: it.local_abbreviation,
                title: it.title,
                localTitle: it.local_title,
                audio: it.audio,
                audioCount: it.audio_count,
                text: it.text,
                language: mapLanguage(it.language),
            })) ?? []
        )
    }

    async getFullVersion(versionId: number) {
        const res = await this.client.get(
            `${this.baseURI}/api/bible/version/${versionId}`
        )

        return res.data
    }

    async getChapter(versionId: number, bookUsfm: string, chapter: number) {
        const url = `${this.baseURI}/bible/${versionId}/${bookUsfm}.${chapter}`

        // bible.com is a Next.js App Router site now: ask for the raw RSC payload instead of HTML
        const res = await this.client.get(url, {
            headers: { RSC: '1' },
            responseType: 'arraybuffer',
        })
        const buf = Buffer.from(res.data)
        const rsc = buf.toString('utf8')

        // chapterInfo is a plain JSON object inside the payload; cut it out by brace matching
        const key = '"chapterInfo":'
        const start = rsc.indexOf(key + '{') + key.length
        if (start < key.length) throw new Error(`No chapterInfo in ${url}`)
        let end = start
        for (let depth = 0, inStr = false; end < rsc.length; end++) {
            const c = rsc[end]
            if (inStr) {
                if (c === '\\') end++
                else if (c === '"') inStr = false
            } else if (c === '"') inStr = true
            else if (c === '{') depth++
            else if (c === '}' && --depth === 0) break
        }
        const chapterInfo = JSON.parse(rsc.slice(start, end + 1))

        // long strings come as separate text rows: "$6d" -> "\n6d:T<hex byte length>,<text>"
        let content: string = chapterInfo.content ?? ''
        if (content.startsWith('$')) {
            const row = buf.indexOf(`\n${content.slice(1)}:T`)
            const comma = buf.indexOf(',', row)
            const len = parseInt(
                buf.toString('utf8', row + content.length + 2, comma),
                16
            )
            content =
                row < 0 ? '' : buf.toString('utf8', comma + 1, comma + 1 + len)
        }

        const $ = load(content)
        const audioInfo: IBibleAudio[] = chapterInfo.audioChapterInfo ?? []
        const next: string | null = chapterInfo.next?.usfm ?? null
        const prev: string | null = chapterInfo.previous?.usfm ?? null

        // walks an element and appends its text as segments, inheriting styles from the parents
        const collect = (
            el: AnyNode,
            style: string[],
            isJesus: boolean,
            out: IBibleSegment[]
        ) => {
            $(el)
                .contents()
                .each((_, node) => {
                    if (node.type === 'text') {
                        const last = out[out.length - 1]
                        const s = style.length ? style : ['Normal']
                        if (
                            last &&
                            last.isJesus === isJesus &&
                            last.style.join() === s.join()
                        ) {
                            last.content += node.data
                        } else {
                            out.push({ content: node.data, style: s, isJesus })
                        }
                        return
                    }
                    const classes = ($(node).attr('class') ?? '').split(/\s+/)
                    if (classes.some((c) => SKIPPED.includes(c))) return
                    const added = classes
                        .map((c) => STYLES[c])
                        .filter((s): s is string => !!s && !style.includes(s))
                    collect(
                        node,
                        [...style, ...added],
                        isJesus || classes.includes('wj'),
                        out
                    )
                })
            return out
        }

        const clean = (segments: IBibleSegment[]) => {
            segments.forEach(
                (s) => (s.content = s.content.replace(/\s+/g, ' '))
            )
            if (segments.length) {
                segments[0]!.content = segments[0]!.content.trimStart()
                const last = segments[segments.length - 1]!
                last.content = last.content.trimEnd()
            }
            return segments.filter((s) => s.content)
        }

        const paragraphs: IBibleParagraph[] = []
        const verseText = new Map<number, string>()

        $('div.chapter')
            .children('div')
            .each((_, el) => {
                const elem = $(el)
                const type = elem.attr('class') ?? ''
                if (SKIPPED_PARAGRAPHS.includes(type)) return

                const verses = elem.children('span.verse')
                if (!verses.length) {
                    // headings (s1, ms, d, qa...) and blank lines (b)
                    const heading = clean(collect(el, [], false, []))
                        .map((s) => s.content)
                        .join('')
                    paragraphs.push({
                        type,
                        isHeading: !!heading,
                        heading: heading || null,
                        lines: [],
                    })
                    return
                }

                const paragraph: IBibleParagraph = {
                    type,
                    isHeading: false,
                    heading: null,
                    lines: [],
                }
                verses.each((_, verseEl) => {
                    // "JHN.3.16", or "JHN.3.16+JHN.3.17" for combined verses
                    const usfm = $(verseEl).attr('data-usfm') ?? ''
                    const verse = parseInt(
                        usfm.split('+')[0]!.split('.')[2] ?? ''
                    )
                    const segments = clean(collect(verseEl, [], false, []))
                    if (isNaN(verse) || !segments.length) return

                    paragraph.lines.push({
                        verse,
                        displayNumber: !!$(verseEl)
                            .children('span.label')
                            .text()
                            .trim(),
                        segments,
                    })
                    const text = segments.map((s) => s.content).join('')
                    verseText.set(
                        verse,
                        [verseText.get(verse), text].filter(Boolean).join(' ')
                    )
                })
                paragraphs.push(paragraph)
            })

        const verses = [...verseText.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([verse, text]) => ({ verse, text }))

        return { paragraphs, verses, audioInfo, next, prev }
    }

    // verse timings from the MMS aligner service (tools/aligner)
    async align(
        audioUrl: string,
        language: string,
        verses: { verse: number; text: string }[]
    ): Promise<{ durationMs: number; gpuMs: number; timings: IVerseTiming[] }> {
        const res = await this.client.post(`${this.alignerURI}/align`, {
            audioUrl,
            language,
            verses,
        })

        return res.data
    }

    async generateTranscript(
        version: any,
        bookUsfm: string,
        chapter: number,
        book: string = ''
    ) {
        const promises = []

        const dataStore = path.join(
            process.cwd(),
            `src/datastore/bible/${version.abbreviation}-${version.id}/subtitles/`
        )
        const chapterInfo = await this.getChapter(version.id, bookUsfm, chapter)

        for (const audio of chapterInfo.audioInfo) {
            const audioUrl = `https:${audio?.download_urls?.format_mp3_32k}`
            const { timings } = await this.align(
                audioUrl,
                version.language?.iso_639_3 ?? 'eng',
                chapterInfo.verses
            )

            promises.push({
                audioName: `${book} Chapter ${chapter} `,
                title: audio.title,
                voiceId: audio.id,
                versionId: audio.version_id,
                default: audio.default,
                fileId: audioUrl.split('/').pop()?.split('.')[0] ?? '',
                next: chapterInfo.next,
                prev: chapterInfo.prev,
                lyrics: timings.map((t) => ({
                    verse: `${t.verse}`,
                    timing: { start: t.startMs / 1000, end: t.endMs / 1000 },
                })),
            })
        }

        const filePath = path.join(dataStore, `${bookUsfm}-${chapter}.json`)
        fs.mkdirSync(path.dirname(dataStore), { recursive: true })

        fs.writeFileSync(filePath, JSON.stringify(promises, null, 4))

        return promises
    }

    override search(q: string): void {
        throw new Error('Not yet implemented')
    }
}

export default Bible
