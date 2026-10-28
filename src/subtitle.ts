import * as fsp from 'node:fs/promises'
import type { LuceneDoc } from './pipeline.ts'

export type ParagraphType = 'scripture' | 'narration' | 'song'

export interface SubtitleCue {
    id: string
    recordId: string
    paragraphClass: string
    paragraphType: ParagraphType
    paragraphNumber?: number
    omit?: boolean
    songGroup?: number
    startMs: number
    endMs: number
    text: string
}

export interface ParsedParagraph {
    recordId: string
    class: string
    type: ParagraphType
    paragraphNumber?: number
    omit?: boolean
    songGroup?: number
    sentences: SubtitleCue[]
}

const ANY_CLASS_SPAN = /<span\s+class="([^"]*)">([\s\S]*?)<\/span>/gi
function isStrippableSpanClass(classAttr: string): boolean {
    const tokens = classAttr.split(/\s+/).filter(Boolean)
    return tokens.some((t) => t === 'pn' || t === 'en' || t.startsWith('eagle'))
}
const ANY_TAG = /<[^>]+>/g
const RAW_PRIVATE_USE_CHAR = /[\uE000-\uF8FF]/g
const NAMED_ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
}

function decodeEntities(text: string): string {
    return text.replace(
        /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g,
        (match, body: string) => {
            if (body[0] === '#') {
                const codePoint =
                    body[1] === 'x' || body[1] === 'X'
                        ? parseInt(body.slice(2), 16)
                        : parseInt(body.slice(1), 10)
                if (Number.isNaN(codePoint)) return match
                if (codePoint >= 0xe000 && codePoint <= 0xf8ff) return ''
                return String.fromCodePoint(codePoint)
            }
            return NAMED_ENTITIES[body] ?? match
        }
    )
}

function htmlToPlainText(html: string): string {
    const withoutMetadata = html.replace(
        ANY_CLASS_SPAN,
        (full, classAttr: string) =>
            isStrippableSpanClass(classAttr) ? '' : full
    )
    const withoutTags = withoutMetadata.replace(ANY_TAG, ' ')
    const decoded = decodeEntities(withoutTags).replace(
        RAW_PRIVATE_USE_CHAR,
        ''
    )
    return decoded.replace(/\s+/g, ' ').trim()
}

function extractSentenceMarkers(
    innerHtml: string
): { index: number; tagEnd: number; id: string; ms: number }[] {
    const tagRe = /<[a-zA-Z][^>]*>/g
    const markers: { index: number; tagEnd: number; id: string; ms: number }[] =
        []

    let m: RegExpExecArray | null
    while ((m = tagRe.exec(innerHtml)) !== null) {
        const tag = m[0]
        const idMatch = /\bid="(\d+)"/.exec(tag)
        const msMatch = /\bms="(\d+)"/.exec(tag)
        if (idMatch && msMatch) {
            markers.push({
                index: m.index,
                tagEnd: m.index + tag.length,
                id: idMatch[1],
                ms: parseInt(msMatch[1], 10),
            })
        }
    }
    return markers
}

function findSongStanzaRanges(html: string): { start: number; end: number }[] {
    const divRe = /<div\s+class="song-stanza">[\s\S]*?<\/div>/gi
    const ranges: { start: number; end: number }[] = []
    let m: RegExpExecArray | null
    while ((m = divRe.exec(html)) !== null) {
        ranges.push({ start: m.index, end: m.index + m[0].length })
    }
    return ranges
}

export function extractParagraphs(
    html: string,
    recordId: string
): ParsedParagraph[] {
    const pTagRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi
    const paragraphs: ParsedParagraph[] = []
    const songRanges = findSongStanzaRanges(html)

    let m: RegExpExecArray | null
    while ((m = pTagRe.exec(html)) !== null) {
        const [, attrs, innerHtml] = m
        const matchIndex = m.index
        const classMatch = /class="([^"]*)"/.exec(attrs)
        const paragraphClass = classMatch ? classMatch[1] : ''
        const classTokens = paragraphClass.split(/\s+/).filter(Boolean)

        const omit = classTokens.includes('omit')
        const type: ParagraphType = classTokens.includes('scr')
            ? 'scripture'
            : classTokens.includes('stanza') || classTokens.includes('song')
              ? 'song'
              : 'narration'

        const songRangeIndex = songRanges.findIndex(
            (r) => matchIndex >= r.start && matchIndex < r.end
        )
        const songGroup = songRangeIndex >= 0 ? songRangeIndex + 1 : undefined

        const pnMatch = /<span\s+class="pn">(\d+)<\/span>/i.exec(innerHtml)
        const paragraphNumber = pnMatch ? parseInt(pnMatch[1], 10) : undefined

        const markers = extractSentenceMarkers(innerHtml)
        const sentences: SubtitleCue[] = []
        for (let i = 0; i < markers.length; i++) {
            const start = markers[i].tagEnd
            const end =
                i + 1 < markers.length ? markers[i + 1].index : innerHtml.length
            const text = htmlToPlainText(innerHtml.slice(start, end))
            if (!text) continue
            sentences.push({
                id: markers[i].id,
                recordId,
                paragraphClass,
                paragraphType: type,
                paragraphNumber,
                omit,
                songGroup,
                startMs: markers[i].ms,
                endMs: markers[i].ms, // filled in by chainEndTimes()
                text,
            })
        }

        if (sentences.length > 0) {
            paragraphs.push({
                recordId,
                class: paragraphClass,
                type,
                paragraphNumber,
                omit,
                songGroup,
                sentences,
            })
        }
    }

    return paragraphs
}

function firstMsInDoc(doc: LuceneDoc): number {
    const html = Array.isArray(doc.html) ? doc.html[0] : doc.html
    if (!html) return Number.POSITIVE_INFINITY
    const m = /\bms="(\d+)"/.exec(html)
    return m ? parseInt(m[1], 10) : Number.POSITIVE_INFINITY
}

/** Pulls out every doc/section for one productId, in true audio-time reading order. */
export function getDocsForProductId(
    docs: LuceneDoc[],
    productId: string
): LuceneDoc[] {
    // allSermons gives "53-0405M", the index stores "53-0405m"
    const wanted = productId.toLowerCase()
    return docs
        .filter((d) => {
            const v = d.productId
            return Array.isArray(v)
                ? v.some((x) => x.toLowerCase() === wanted)
                : v?.toLowerCase() === wanted
        })
        .sort((a, b) => firstMsInDoc(a) - firstMsInDoc(b))
}

export function getHasSubtitle(docs: LuceneDoc[]): boolean {
    for (const doc of docs) {
        const raw = Array.isArray(doc.hasSubtitle)
            ? doc.hasSubtitle[0]
            : doc.hasSubtitle
        if (typeof raw === 'string' && raw.toLowerCase() === 'true') return true
    }
    return false
}

/** Paragraph breakdown (type, paragraph number, sentence-level ms) for every doc, in reading order. */
export function buildParagraphTimeline(docs: LuceneDoc[]): ParsedParagraph[] {
    const paragraphs: ParsedParagraph[] = []
    for (const doc of docs) {
        const html = Array.isArray(doc.html) ? doc.html[0] : doc.html
        const recordId = Array.isArray(doc.recordId)
            ? doc.recordId[0]
            : doc.recordId
        if (!html) continue
        paragraphs.push(...extractParagraphs(html, recordId ?? ''))
    }
    return paragraphs
}

/** Fills in endMs on a chronologically-ordered cue list, mutating it in place. */
function chainEndTimes(cues: SubtitleCue[], lastCuePaddingMs: number): void {
    for (let i = 0; i < cues.length; i++) {
        cues[i].endMs =
            i + 1 < cues.length
                ? cues[i + 1].startMs
                : cues[i].startMs + lastCuePaddingMs
    }
}

/** Flat, end-time-computed cue list across every paragraph (what the .srt file needs). */
export function buildCueTimeline(
    docs: LuceneDoc[],
    lastCuePaddingMs = 4000
): SubtitleCue[] {
    const cues = buildParagraphTimeline(docs).flatMap((p) => p.sentences)
    chainEndTimes(cues, lastCuePaddingMs)
    return cues
}

function formatSrtTimestamp(ms: number): string {
    const h = Math.floor(ms / 3_600_000)
    const m = Math.floor((ms % 3_600_000) / 60_000)
    const s = Math.floor((ms % 60_000) / 1000)
    const msRemainder = ms % 1000
    const pad = (n: number, len = 2) => n.toString().padStart(len, '0')
    return `${pad(h)}:${pad(m)}:${pad(s)},${pad(msRemainder, 3)}`
}

export function toSrt(cues: SubtitleCue[]): string {
    return cues
        .map(
            (cue, i) =>
                `${i + 1}\n${formatSrtTimestamp(cue.startMs)} --> ${formatSrtTimestamp(cue.endMs)}\n${cue.text}\n`
        )
        .join('\n')
}

export async function writeSrtForProductId(
    allDocsJsonPath: string,
    productId: string,
    outSrtPath: string
): Promise<SubtitleCue[]> {
    const raw = await fsp.readFile(allDocsJsonPath, 'utf-8')
    const allDocs = JSON.parse(raw) as LuceneDoc[]
    const docs = getDocsForProductId(allDocs, productId)
    if (docs.length === 0) {
        throw new Error(`No documents found with productId "${productId}"`)
    }
    const cues = buildCueTimeline(docs)
    await fsp.writeFile(outSrtPath, toSrt(cues), 'utf-8')
    console.log(
        `${cues.length} cues -> ${outSrtPath} (from ${docs.length} documents)`
    )
    return cues
}

export async function writeStructuredJsonForProductId(
    allDocsJsonPath: string,
    productId: string,
    outJsonPath: string
): Promise<ParsedParagraph[]> {
    const raw = await fsp.readFile(allDocsJsonPath, 'utf-8')
    const allDocs = JSON.parse(raw) as LuceneDoc[]
    const docs = getDocsForProductId(allDocs, productId)
    if (docs.length === 0) {
        throw new Error(`No documents found with productId "${productId}"`)
    }
    const paragraphs = buildParagraphTimeline(docs)
    await fsp.writeFile(
        outJsonPath,
        JSON.stringify(paragraphs, null, 2),
        'utf-8'
    )
    console.log(
        `${paragraphs.length} paragraphs (${paragraphs.reduce((n, p) => n + p.sentences.length, 0)} sentences) -> ${outJsonPath}`
    )
    return paragraphs
}

export interface VerseTiming {
    start: number
    end: number
    startOffset: number
    endOffset: number
}

export interface VerseEntry {
    verse: string
    id: string
    paragraphType: ParagraphType
    paragraphNumber?: number
    timing: VerseTiming
}

export interface VerseFormatDoc {
    audioName: string
    productId: string
    text: string
    lyrics: VerseEntry[]
}

export function toVerseFormat(
    docs: LuceneDoc[],
    productId: string,
    audioName?: string
): VerseFormatDoc {
    const cues = buildCueTimeline(docs)
    const lyrics: VerseEntry[] = []
    const textParts: string[] = []
    let cursor = 0

    cues.forEach((cue, i) => {
        const startOffset = cursor
        textParts.push(cue.text)
        cursor += cue.text.length
        const endOffset = cursor
        textParts.push(' ')
        cursor += 1

        lyrics.push({
            verse: String(i + 1),
            id: cue.id,
            paragraphType: cue.paragraphType,
            paragraphNumber: cue.paragraphNumber,
            timing: {
                start: Math.round((cue.startMs / 1000) * 1e6) / 1e6,
                end: Math.round((cue.endMs / 1000) * 1e6) / 1e6,
                startOffset,
                endOffset,
            },
        })
    })

    return {
        audioName: audioName ?? productId,
        productId,
        text: textParts.join('').trimEnd(),
        lyrics,
    }
}

export async function writeVerseFormatForProductId(
    allDocsJsonPath: string,
    productId: string,
    outJsonPath: string,
    audioName?: string
): Promise<VerseFormatDoc> {
    const raw = await fsp.readFile(allDocsJsonPath, 'utf-8')
    const allDocs = JSON.parse(raw) as LuceneDoc[]
    const docs = getDocsForProductId(allDocs, productId)
    if (docs.length === 0) {
        throw new Error(`No documents found with productId "${productId}"`)
    }
    const result = toVerseFormat(docs, productId, audioName)
    await fsp.writeFile(outJsonPath, JSON.stringify([result], null, 2), 'utf-8')
    console.log(`${result.lyrics.length} timed entries -> ${outJsonPath}`)
    return result
}

export interface SectionBlockSentence {
    /** 1-based position of this sentence within its block (not global). */
    sentence: number
    id: string
    start: number
    end: number
    text: string
}

export interface SectionBlock {
    block: number
    class: string
    type: ParagraphType
    paragraphNumber?: number
    omit: boolean
    songGroup?: number
    text: string
    sentences: SectionBlockSentence[]
}

export interface Section {
    /** 1-based position of this section (document) within the whole productId. */
    section: number
    recordId: string
    /** The document's own "level" field, when present (e.g. "sermon" for the title/summary doc). */
    level?: string
    /** Every block's text in this section, joined with a space. */
    text: string
    blocks: SectionBlock[]
}

export interface SectionFormatDoc {
    audioName: string
    productId: string
    sections: Section[]
}

export function toSectionFormat(
    docs: LuceneDoc[],
    productId: string,
    audioName?: string,
    lastCuePaddingMs = 4000
): SectionFormatDoc {
    const blocksByDoc: ParsedParagraph[][] = docs.map((doc) => {
        const html = Array.isArray(doc.html) ? doc.html[0] : doc.html
        const recordId = Array.isArray(doc.recordId)
            ? doc.recordId[0]
            : doc.recordId
        return html ? extractParagraphs(html, recordId ?? '') : []
    })
    chainEndTimes(
        blocksByDoc.flatMap((blocks) => blocks.flatMap((b) => b.sentences)),
        lastCuePaddingMs
    )

    const sections: Section[] = docs.map((doc, docIndex) => {
        const recordId = Array.isArray(doc.recordId)
            ? doc.recordId[0]
            : (doc.recordId ?? '')
        const level = Array.isArray(doc.level) ? doc.level[0] : doc.level

        const blocks: SectionBlock[] = blocksByDoc[docIndex].map((b, i) => ({
            block: i + 1,
            class: b.class,
            type: b.type,
            paragraphNumber: b.paragraphNumber,
            omit: b.omit ?? false,
            songGroup: b.songGroup,
            text: b.sentences.map((s) => s.text).join(' '),
            sentences: b.sentences.map((s, j) => ({
                sentence: j + 1,
                id: s.id,
                start: Math.round((s.startMs / 1000) * 1e6) / 1e6,
                end: Math.round((s.endMs / 1000) * 1e6) / 1e6,
                text: s.text,
            })),
        }))

        return {
            section: docIndex + 1,
            recordId,
            level,
            text: blocks.map((b) => b.text).join(' '),
            blocks,
        }
    })

    return { audioName: audioName ?? productId, productId, sections }
}

/** docs.json -> productId -> the section/block/sentence JSON (start/end in seconds). */
export async function writeSectionFormatForProductId(
    allDocsJsonPath: string,
    productId: string,
    outJsonPath: string,
    audioName?: string
): Promise<SectionFormatDoc> {
    const raw = await fsp.readFile(allDocsJsonPath, 'utf-8')
    const allDocs = JSON.parse(raw) as LuceneDoc[]
    const docs = getDocsForProductId(allDocs, productId)
    if (docs.length === 0) {
        throw new Error(`No documents found with productId "${productId}"`)
    }
    const result = toSectionFormat(docs, productId, audioName)
    await fsp.writeFile(outJsonPath, JSON.stringify(result, null, 2), 'utf-8')
    const blockCount = result.sections.reduce((n, s) => n + s.blocks.length, 0)
    const sentenceCount = result.sections.reduce(
        (n, s) => n + s.blocks.reduce((bn, b) => bn + b.sentences.length, 0),
        0
    )
    console.log(
        `${result.sections.length} sections, ${blockCount} blocks, ${sentenceCount} sentences -> ${outJsonPath}`
    )
    return result
}

export interface IndexedSentence {
    id: string
    /** 1-based position in the section/block/sentence numbering from toSectionFormat(). */
    section: number
    block: number
    sentence: number
    recordId: string
    paragraphType: ParagraphType
    paragraphNumber?: number
    omit: boolean
    songGroup?: number
    /** Seconds, matching the "sections" schema (not ms). */
    start: number
    end: number
    text: string
}

/** Flat id -> timing/position lookup for one productId, built from the same data as toSectionFormat(). */
export function buildSentenceIndexById(
    docs: LuceneDoc[],
    productId: string,
    audioName?: string
): Map<string, IndexedSentence> {
    const sectionFormat = toSectionFormat(docs, productId, audioName)
    const index = new Map<string, IndexedSentence>()
    for (const section of sectionFormat.sections) {
        for (const block of section.blocks) {
            for (const sentence of block.sentences) {
                index.set(sentence.id, {
                    id: sentence.id,
                    section: section.section,
                    block: block.block,
                    sentence: sentence.sentence,
                    recordId: section.recordId,
                    paragraphType: block.type,
                    paragraphNumber: block.paragraphNumber,
                    omit: block.omit,
                    songGroup: block.songGroup,
                    start: sentence.start,
                    end: sentence.end,
                    text: sentence.text,
                })
            }
        }
    }
    return index
}

if (typeof require !== 'undefined' && require.main === module) {
    const [docsJsonPath, productId, outPath, format] = process.argv.slice(2)
    if (!docsJsonPath || !productId || !outPath) {
        console.error(
            'Usage: subtitles <docs.json> <productId> <output> [srt|paragraphs|verses|sections]'
        )
        process.exit(1)
    }
    const mode =
        format ??
        (outPath.toLowerCase().endsWith('.json') ? 'paragraphs' : 'srt')
    const run =
        mode === 'sections'
            ? writeSectionFormatForProductId(docsJsonPath, productId, outPath)
            : mode === 'verses'
              ? writeVerseFormatForProductId(docsJsonPath, productId, outPath)
              : mode === 'paragraphs'
                ? writeStructuredJsonForProductId(
                      docsJsonPath,
                      productId,
                      outPath
                  )
                : writeSrtForProductId(docsJsonPath, productId, outPath)
    run.catch((err) => {
        console.error(err)
        process.exit(1)
    })
}
