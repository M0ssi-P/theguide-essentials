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

import type { ILanguage } from '../../types/index.ts'
import { TableParser } from '../table_parser.ts'
import { languageJson } from './utils.ts'
import {
    type LuceneDoc,
    type OpenLanguageIndex,
    queryProductId,
} from '../../pipeline.ts'
import {
    buildSentenceIndexById,
    getDocsForProductId,
    getHasSubtitle,
} from '../../subtitle.ts'

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

    async getSermon(
        sermon: Sermon,
        language?: string | null,
        bibleV?: string | null,
        luceneIndex?: OpenLanguageIndex | null
    ): Promise<Sermon> {
        const sections: Section[] = []
        const lang = language ?? 'en'

        const payload: SermonRequest = {
            GetAllContent: true,
            HighlightQuery: null,
            SermonProductIdentityId: sermon.i,
            Language: lang,
        }

        const resPromise = this.client(
            `${this.tUrl}/rest/sermons/sermonRequest`,
            {
                method: 'POST',
                headers: this.header,
                data: JSON.stringify(payload),
            }
        ).then((r) => r.data as Promise<ISermonResponse>)

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
                'lucene-dump/bin/Release/net8.0/LuceneDump.exe',
                sermon.dateCode
            ).catch((err) => {
                console.error(
                    `Lucene query failed for ${sermon.dateCode}:`,
                    err
                )
                return null
            })
        }

        const [res, hub, lyricDoc] = await Promise.all([
            resPromise,
            hubPromise,
            lyricsDoc,
        ])

        const docs = lyricDoc
            ? getDocsForProductId(lyricDoc, sermon!.dateCode)
            : null

        const hasSubtitle = docs ? getHasSubtitle(docs) : false

        const timingById = docs
            ? buildSentenceIndexById(docs, sermon!.dateCode)
            : null

        const orderedLines =
            timingById && timingById.size > 0
                ? [...timingById.values()].sort(
                      (a, b) =>
                          a.section - b.section ||
                          a.block - b.block ||
                          a.sentence - b.sentence
                  )
                : []

        const totalSections = res.Result.TotalSections

        const parseDom = (html: string) => {
            if (typeof window !== 'undefined' && window.DOMParser) {
                return new DOMParser().parseFromString(html, 'text/html')
            }
            throw new Error(
                'DOMParser is unavailable. If running in Node.js, inject a HTML parser such as jsdom.'
            )
        }

        const firstDoc = parseDom(res.Result.Sections[0]?.Content || '')
        const placeEl = firstDoc.querySelector('.place')
        const location: string = placeEl
            ? (placeEl.textContent || '').trim()
            : ''

        let sectionCounter = 0
        res.Result.Sections.forEach((it) => {
            const section: Section = {
                canHit: it.IsHit,
                isHeader: it.Paragraph === 'header',
                key: it.Paragraph || 'whole',
                paragraph: it.Paragraph || 'whole',
                content: [],
            }

            if (!section.isHeader) {
                sectionCounter++
            }

            const body = parseDom(it.Content)
            const paragraphs = Array.from(body.querySelectorAll('p'))

            let blockCounter = 0

            paragraphs.forEach((i) => {
                blockCounter += 1
                const classList = Array.from(i.classList)
                const mainClasses = new Set(['first_par', 'normal_pn', 'q'])

                let number: number | null = null
                if (classList.includes('first_par')) {
                    number = 1
                } else if (classList.includes('p')) {
                    const qnText =
                        i.querySelector('span.first span.qn')?.textContent || ''
                    const parsed = parseInt(qnText.slice(0, -1), 10)
                    number = isNaN(parsed) ? null : parsed
                } else {
                    const pnText =
                        i.querySelector('span.first span.pn')?.textContent || ''
                    const parsed = parseInt(pnText, 10)
                    number = isNaN(parsed) ? null : parsed
                }

                const isScripture = classList.includes('scr')
                const isQuestion = classList.includes('q')

                if (classList.some((c) => mainClasses.has(c))) {
                    const matchingBlock = hub?.sermon?.blocks?.find(
                        (bk) => bk.blockNumber === number
                    )
                    section.content.push({
                        id: matchingBlock ? matchingBlock.blockId : null,
                        number: number,
                        isFirst: number === 1,
                        isQuestion: isQuestion,
                        text: '',
                        content: [],
                    })
                }

                if (
                    section.content.length > 0 &&
                    section.content[section.content.length - 1].number !== null
                ) {
                    const targetP = section.content[section.content.length - 1]

                    targetP.content.push({
                        displayNumber: false,
                        number: targetP.number!,
                        segments: [],
                    })

                    if (
                        !classList.some((toIgnore) =>
                            mainClasses.has(toIgnore)
                        ) &&
                        targetP.text.length > 0
                    ) {
                        targetP.text += '\n'
                    }

                    const stSpans = Array.from(i.querySelectorAll('span.st'))
                    let sentenceCounter = 0
                    stSpans.forEach((x) => {
                        if (!x.textContent?.trim()) return

                        sentenceCounter += 1
                        const ignoredClasses = new Set(['eagle', 'se', 'pn'])

                        const getTiming = () => {
                            const findTiming = orderedLines.find(
                                (line) =>
                                    line.section === sectionCounter &&
                                    line.block === blockCounter &&
                                    line.sentence === sentenceCounter
                            )

                            const index = [
                                sectionCounter,
                                blockCounter,
                                sentenceCounter,
                            ]

                            if (findTiming) {
                                return {
                                    start: findTiming.start,
                                    end: findTiming.end,
                                    index,
                                }
                            } else {
                                return {}
                            }
                        }

                        Array.from(x.childNodes).forEach((node) => {
                            if (node.nodeType === 3) {
                                // TextNode
                                const text = node.textContent || ''

                                if (!text.trim()) return

                                targetP.text += text
                                targetP.content[
                                    targetP.content.length - 1
                                ].segments.push({
                                    style: [Style.Normal],
                                    content: text,
                                    ...getTiming(),
                                })
                            } else if (node.nodeType === 1) {
                                // Element
                                const el = node as Element
                                const nodeClasses = Array.from(el.classList)

                                if (
                                    !nodeClasses.some((toIgnore) =>
                                        ignoredClasses.has(toIgnore)
                                    )
                                ) {
                                    const text = el.textContent || ''

                                    if (!text.trim()) return

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
