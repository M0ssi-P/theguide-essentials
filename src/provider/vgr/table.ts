import type {
    LanguageRoot,
    IRepoSERMONS,
    IHubResponse,
    Sermon,
    SermonRequest,
    ISermonResponse,
    IHubSermonResponse,
    Section,
    Paragraph,
    Line,
    Segment,
} from './types.ts'
import { Style } from './types.ts'
import * as cheerio from 'cheerio'

import type { ILanguage } from '../../types/index.ts'
import { TableParser } from '../table_parser.ts'
import { languageJson } from './utils.ts'
import {
    type LuceneDoc,
    type OpenLanguageIndex,
    LUCENE_DUMP_EXE,
    queryProductId,
} from '../../pipeline.ts'
import { buildSentenceIndexById, getHasSubtitle } from '../../subtitle.ts'

type RawSection = ISermonResponse['Result']['Sections'][number] & {
    key?: string
}

const field = (doc: LuceneDoc, name: string): string | undefined => {
    const v = doc[name]
    return Array.isArray(v) ? v[0] : v
}

export default class Table extends TableParser {
    override readonly name = 'The Table'
    override readonly saveName = 'vgr'
    override readonly baseURI = 'https://branham.org'
    override readonly isDiverse = true

    private readonly tUrl = 'https://table.branham.org'
    private readonly messageBaseURL = 'https://search.messagehub.info/api'

    private readonly header = {
        'X-Requested-With': 'XMLHttpRequest',
        referer: this.baseURI,
        'Content-Type': 'application/json',
    }

    override getAllLanguages(): ILanguage[] {
        const unformatedLanguage: LanguageRoot[] = JSON.parse(languageJson)

        return unformatedLanguage.map((it) => ({
            id: null,
            iso63901: it.i,
            iso63903: it.c,
            name: it.e,
            localName: it.f,
            tag: it.i,
            textDirection: 'lt',
            hasAudio: true,
            hasText: true,
            totalVersions: 1,
            font: null,
        }))
    }

    async getAllSermons(
        language: ILanguage,
        langCode?: string | null
    ): Promise<Sermon[]> {
        const promises: Sermon[] = []
        const targetLangCode = langCode ?? 'en'

        try {
            const reqBody = { Language: targetLangCode }

            const resPromise = this.client(
                `${this.tUrl}/rest/index/allSermons`,
                {
                    method: 'POST',
                    headers: this.header,
                    data: JSON.stringify(reqBody),
                }
            ).then((r) => r.data as Promise<IRepoSERMONS>)

            const hubPromise = this.client(
                `${this.messageBaseURL}/languages/${targetLangCode}/sermons`
            ).then((r) => r.data as Promise<IHubResponse[]>)

            const [res, hub] = await Promise.all([resPromise, hubPromise])

            res.Result.Sermons.forEach((table, index) => {
                const isFoundHub = hub.find((it) => {
                    if (table.cab) {
                        const newDate = table.p
                            .split('-')[0]
                            .trim()
                            .replace(/\s+/g, '-')
                        return it.dateCode === newDate
                    } else {
                        return it.dateCode === table.p
                    }
                })

                const hasNext =
                    index !== -1 && index < res.Result.Sermons.length - 1
                        ? res.Result.Sermons[index + 1]
                        : null
                const hasPrev =
                    index !== -1 && index > 0
                        ? res.Result.Sermons[index - 1]
                        : null

                if (isFoundHub) {
                    promises.push({
                        id: isFoundHub.id,
                        date: isFoundHub.date,
                        dateCode: table.p,
                        language: language.iso63901,
                        location: isFoundHub.location,
                        nextSermonDate: hasNext?.p ?? '',
                        prevSermonDate: hasPrev?.p ?? '',
                        title: table.t,
                        sortDate: isFoundHub.sortDate,
                        minutes: table.m,
                        isCab: table.cab,
                        c: table.c,
                        i: table.i,
                        ct: table.ct,
                        updatedAt: isFoundHub.updatedOn,
                    })
                } else {
                    promises.push({
                        id: null,
                        date: '',
                        dateCode: table.p,
                        language: '',
                        location: '',
                        nextSermonDate: hasNext?.p ?? '',
                        prevSermonDate: hasPrev?.p ?? '',
                        title: table.t,
                        sortDate: '',
                        minutes: table.m,
                        isCab: table.cab,
                        c: table.c,
                        i: table.i,
                        ct: table.ct,
                        updatedAt: 12121212121212,
                    })
                }
            })
        } catch (e) {
            console.error(e)
        }

        return promises
    }

    // A sermon that is in the Lucene index but not in allSermons (e.g. sw 60-0108).
    sermonFromLucene(docs: LuceneDoc[], language: string): Sermon {
        const head = docs.find((d) => field(d, 'level') === 'sermon') ?? docs[0]
        // allSermons writes the suffix uppercase ("53-0405S"), the index lowercase
        const dateCode = (field(head, 'productId') ?? '').toUpperCase()
        const isCab = field(head, 'recordType') === 'book_chapters'
        const lastMs = Math.max(
            0,
            ...docs.flatMap((d) =>
                [...(field(d, 'html') ?? '').matchAll(/\bms="(\d+)"/g)].map(
                    (m) => parseInt(m[1], 10)
                )
            )
        )
        const [yy, mmdd = ''] = dateCode.split('-')
        const date = new Date(
            Date.UTC(
                1900 + parseInt(yy, 10),
                parseInt(mmdd.slice(0, 2), 10) - 1,
                parseInt(mmdd.slice(2, 4), 10)
            )
        )

        return {
            id: null,
            date: isNaN(date.getTime())
                ? ''
                : date.toLocaleDateString('en-US', {
                      month: 'long',
                      day: 'numeric',
                      year: 'numeric',
                      timeZone: 'UTC',
                  }),
            dateCode,
            language,
            location: cheerio
                .load(field(head, 'html') ?? '')('.place')
                .first()
                .text()
                .trim(),
            nextSermonDate: '',
            prevSermonDate: '',
            title: field(head, 'title') ?? '',
            // shortcut: no hub suffix ordering (e.g. "-4" for A), sorts by the bare date code
            sortDate: isCab ? '' : dateCode.slice(0, 7),
            minutes: Math.round(lastMs / 60000),
            isCab,
            // shortcut: c is not in the Lucene index; 0 until allSermons lists the sermon
            c: 0,
            i: parseInt(field(head, 'productIdentityId') ?? '0', 10),
            ct: isCab ? 'B' : 'S',
            updatedAt: 12121212121212,
        }
    }

    private sectionsFromLucene(docs: LuceneDoc[]): RawSection[] {
        const usedKeys = new Set<string>()
        let lastNumber: number | null = null
        return docs.map((d) => {
            const html = field(d, 'html') ?? ''
            // rebuilds sermonRequest's Paragraph ('header', '1-2', '10', '' for CAB)
            let label = ''
            if (field(d, 'level') === 'sermon') {
                label = 'header'
            } else if (field(d, 'recordType') !== 'book_chapters') {
                const numbers = (field(d, 'paragraphNumbers') ?? '')
                    .split(/\s+/)
                    .filter(Boolean)
                    .map(Number)
                // paragraphNumbers leaves out the implied 1 of the opening p.first_par
                if (lastNumber === null && /class="first_par\b/.test(html)) {
                    numbers.unshift(1)
                }
                if (numbers.length > 0) {
                    const lo = Math.min(...numbers)
                    const hi = Math.max(...numbers)
                    label = lo === hi ? `${lo}` : `${lo}-${hi}`
                    lastNumber = hi
                } else if (lastNumber !== null) {
                    // continues the previous paragraph
                    label = `${lastNumber}`
                }
            }
            // section ids hash the key, so keys must be unique within a sermon
            const key =
                label && !usedKeys.has(label)
                    ? label
                    : (field(d, 'recordId') ?? label)
            usedKeys.add(key)
            return { Content: html, IsHit: false, Paragraph: label, key }
        })
    }

    async getSermon(
        sermon: Sermon,
        language?: string | null,
        bibleV?: string | null,
        luceneIndex?: OpenLanguageIndex | null
    ): Promise<Sermon> {
        const sections: Section[] = []
        const lang = language ?? 'en'

        let hubPromise: Promise<IHubSermonResponse | null> =
            Promise.resolve(null)
        if (sermon.updatedAt !== 12121212121212 && sermon.id !== null) {
            const bibleVersion = bibleV ?? 'KJV'
            hubPromise = this.client
                .get(
                    `${this.messageBaseURL}/languages/${lang}/sermons/${sermon.dateCode}/combined/${bibleVersion}`
                )
                .then((r) => (r.status === 200 ? r.data : null))
                .catch(() => null)
        }

        let lyricsDoc: Promise<LuceneDoc[] | null> = Promise.resolve(null)
        if (luceneIndex) {
            lyricsDoc = queryProductId(
                luceneIndex,
                LUCENE_DUMP_EXE,
                sermon.dateCode
            ).catch((err) => {
                console.error(
                    `Lucene query failed for ${sermon.dateCode}:`,
                    err
                )
                return null
            })
        }

        const [hub, lyricDoc] = await Promise.all([hubPromise, lyricsDoc])

        // keep index (dump) order: one doc per sermonRequest section, header first
        const wanted = sermon.dateCode.toLowerCase()
        const docs = (lyricDoc ?? []).filter(
            (d) => field(d, 'productId')?.toLowerCase() === wanted
        )

        const hasSubtitle = getHasSubtitle(docs)

        const timingById = buildSentenceIndexById(docs, sermon.dateCode)

        let rawSections: RawSection[]
        let totalSections: number
        if (docs.length > 0) {
            rawSections = this.sectionsFromLucene(docs)
            totalSections = rawSections.length
        } else {
            const payload: SermonRequest = {
                GetAllContent: true,
                HighlightQuery: null,
                SermonProductIdentityId: sermon.i,
                Language: lang,
            }
            const res = await this.client(
                `${this.tUrl}/rest/sermons/sermonRequest`,
                {
                    method: 'POST',
                    headers: this.header,
                    data: JSON.stringify(payload),
                }
            ).then((r) => r.data as ISermonResponse)
            rawSections = res.Result.Sections
            totalSections = res.Result.TotalSections
        }

        const parseDom = (html: string) => cheerio.load(html)

        const $first = parseDom(rawSections[0]?.Content || '')
        const location: string = $first('.place').first().text().trim()

        let sectionCounter = 0
        // last paragraph number seen, reused for unnumbered paragraphs (lines.number is NOT NULL)
        let lastNumber = 0
        rawSections.forEach((it) => {
            const section: Section = {
                canHit: it.IsHit,
                isHeader: it.Paragraph === 'header',
                key: it.key ?? (it.Paragraph || 'whole'),
                paragraph: it.Paragraph || 'whole',
                content: [],
            }

            if (!section.isHeader) {
                sectionCounter++
            }

            const $ = parseDom(it.Content)
            const paragraphs = $('p').toArray()

            let blockCounter = 0

            paragraphs.forEach((i) => {
                blockCounter += 1
                const $i = $(i)
                const mainClasses = new Set(['first_par', 'normal_pn', 'q'])
                const mainClassList = [...mainClasses]

                let number: number | null = null
                if ($i.hasClass('first_par')) {
                    number = 1
                } else {
                    // parseInt ignores a trailing '.', e.g. "12." in span.qn
                    const numText =
                        $i
                            .find('span.first span.pn, span.first span.qn')
                            .first()
                            .text() || ''
                    const parsed = parseInt(numText, 10)
                    number = isNaN(parsed) ? null : parsed
                }

                const isScripture = $i.hasClass('scr')
                const isQuestion = $i.hasClass('q')

                // a section can open with an unnumbered p (CAB chapters, songs, lead-ins)
                // that continues a paragraph from the previous section: start one here
                if (
                    mainClassList.some((c) => $i.hasClass(c)) ||
                    (section.content.length === 0 && !section.isHeader)
                ) {
                    const matchingBlock =
                        number === null
                            ? undefined
                            : hub?.sermon?.blocks?.find(
                                  (bk) => bk.blockNumber === number
                              )
                    if (number !== null) lastNumber = number
                    section.content.push({
                        id: matchingBlock ? matchingBlock.blockId : null,
                        number: number ?? lastNumber,
                        isFirst: number === 1,
                        isQuestion: isQuestion,
                        text: '',
                        content: [],
                    })
                }

                if (section.content.length > 0) {
                    const targetP = section.content[section.content.length - 1]

                    targetP.content.push({
                        displayNumber: false,
                        number: targetP.number!,
                        segments: [],
                    })

                    if (
                        !mainClassList.some((toIgnore) =>
                            $i.hasClass(toIgnore)
                        ) &&
                        targetP.text.length > 0
                    ) {
                        targetP.text += '\n'
                    }

                    const stSpans = $i.find('span.st').toArray()
                    let sentenceCounter = 0
                    stSpans.forEach((x) => {
                        const $x = $(x)
                        if (!$x.text()?.trim()) return

                        sentenceCounter += 1
                        const ignoredClasses = new Set(['eagle', 'se', 'pn'])

                        // span.st id is the subtitle id in Lucene html (sermonRequest scrambles it)
                        const getTiming = () => {
                            const t = timingById.get($x.attr('id') ?? '')
                            return t
                                ? {
                                      start: t.start,
                                      end: t.end,
                                      index: [
                                          sectionCounter,
                                          blockCounter,
                                          sentenceCounter,
                                      ],
                                  }
                                : {}
                        }

                        $x.contents().each((_, node) => {
                            if (node.type === 'text') {
                                const text = (node as any).data || ''

                                if (!text) return

                                targetP.text += text
                                targetP.content[
                                    targetP.content.length - 1
                                ].segments.push({
                                    style: [Style.Normal],
                                    content: text,
                                    ...getTiming(),
                                })
                            } else if (node.type === 'tag') {
                                const $el = $(node)
                                const nodeClasses = ($el.attr('class') || '')
                                    .split(/\s+/)
                                    .filter(Boolean)

                                if (
                                    !nodeClasses.some((toIgnore: string) =>
                                        ignoredClasses.has(toIgnore)
                                    )
                                ) {
                                    // span.qn sits inside span.bold; keep the number out of the text
                                    const text =
                                        $el
                                            .clone()
                                            .find('.qn, .pn, .se, .eagle')
                                            .remove()
                                            .end()
                                            .text() || ''

                                    if (!text) return

                                    if (nodeClasses.includes('en')) {
                                        targetP.text += text
                                        targetP.content[
                                            targetP.content.length - 1
                                        ].segments.push({
                                            style: [
                                                Style.BlankTape,
                                                Style.Deemed,
                                            ],
                                            content: text,
                                            ...getTiming(),
                                        })
                                    } else if (nodeClasses.includes('bold')) {
                                        targetP.text += text
                                        targetP.content[
                                            targetP.content.length - 1
                                        ].segments.push({
                                            style: [Style.Normal, Style.Bold],
                                            content: text,
                                            ...getTiming(),
                                        })
                                    } else if (nodeClasses.includes('italic')) {
                                        targetP.text += text
                                        targetP.content[
                                            targetP.content.length - 1
                                        ].segments.push({
                                            style: [
                                                Style.Italic,
                                                isScripture
                                                    ? Style.Scripture
                                                    : Style.Nothing,
                                            ],
                                            content: text,
                                            ...getTiming(),
                                        })
                                    } else if (
                                        nodeClasses.includes('ellquell')
                                    ) {
                                        targetP.text += text
                                        targetP.content[
                                            targetP.content.length - 1
                                        ].segments.push({
                                            style: [Style.Normal],
                                            content: text,
                                            ...getTiming(),
                                        })
                                    } else {
                                        targetP.text += text
                                        targetP.content[
                                            targetP.content.length - 1
                                        ].segments.push({
                                            style: [Style.Normal],
                                            content: text,
                                            ...getTiming(),
                                        })
                                    }
                                }
                            }
                        })
                    })
                }
            })

            sections.push(section)
        })

        return {
            ...sermon,
            hasSubtitle,
            totalSections,
            sections,
            location,
        }
    }

    override search(q: string): void {
        throw new Error('Not yet implemented')
    }
}
