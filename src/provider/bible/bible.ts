import type { ILanguage } from '../../types/index.ts'
import BibleParser from '../bible_parser.ts'
import FormData from 'form-data'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { parseStream } from 'music-metadata'
import path from 'path'
import {
    type IBibleVersion,
    type IChapterContent,
    type IParagraph,
} from './types.ts'
import { load } from 'cheerio'
import { start } from 'repl'
import { version } from 'os'

interface VerseMap {
    [verseNumber: string]: string
}

class Bible extends BibleParser {
    override name: string = 'The Table'
    override saveName: string = 'table'
    override baseURI: string = 'https://www.bible.com'
    isDiverse: boolean = true

    private tUrl: string = 'https://table.branham.org'
    private messageBaseURL = 'https://search.messagehub.info/api'
    __filename = fileURLToPath(import.meta.url)

    __dirname = path.dirname(this.__filename)

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

        const parsed = res.data

        return (
            parsed?.response?.data?.defaultVersions?.map((it: any) => ({
                id: it.id,
                iso63901: it.iso63901,
                iso63903: it.iso63903,
                name: it.name,
                localName: it.localName,
                tag: it.tag,
                hasAudio: it.hasAudio,
                hasText: it.hasText,
                totalVersions: it.totalVersions,
                textDirection: it.textDirection,
                font: it.font,
            })) ?? []
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
                localAbbreviation: it.localAbbreviation,
                title: it.title,
                localTitle: it.localTitle,
                audio: it.audio,
                audioCount: it.audioCount,
                text: it.text,
                language: {
                    id: it.language.id,
                    iso63901: it.language.iso63901,
                    iso63903: it.language.iso63903,
                    name: it.language.name,
                    localName: it.language.localName,
                    tag: it.language.tag,
                    hasAudio: it.language.hasAudio,
                    hasText: it.language.hasText,
                    totalVersions: it.language.totalVersions,
                    textDirection: it.language.textDirection,
                    font: it.language.font,
                },
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

        const res = await this.client.get(url)
        const html = res.data

        const res$ = load(html)
        const nextData = JSON.parse(res$('#__NEXT_DATA__').html() ?? '{}')
        const $ = load(nextData?.props?.pageProps?.chapterInfo.content ?? '')
        const audioInfo: {
            default: boolean
            id: number
            version_id: number
            title: string
            download_urls: {
                format_hls: string
                format_mp3_32k: string
            }
        }[] = nextData?.props?.pageProps?.chapterInfo.audioChapterInfo ?? []

        const next = nextData.props?.pageProps?.chapterInfo.next?.usfm ?? null
        const prev =
            nextData.props?.pageProps?.chapterInfo.previous?.usfm ?? null

        const HeadingList = ['s', 's1', 'is', 'is1', 'ms', 'ms1']
        const ParagraphList = ['p', 'q1', 'q2', 'pi', 'li1', 'm', 'pc']

        const promises: IChapterContent = { chapter: [] }

        $('div.version > div.book > div.chapter')
            .children('div')
            .each((_, el) => {
                const elem = $(el)
                const className = elem.attr('class') ?? ''

                // Heading
                if (HeadingList.includes(className)) {
                    const headingText = elem.find('span.heading').text()
                    promises.chapter!.push({
                        hasHeading: true,
                        hasSubheading: false,
                        heading: {
                            heading: headingText,
                            subHeading: null,
                            type: '',
                        },
                        content: [],
                    })
                    return
                }

                // Paragraph
                if (ParagraphList.includes(className)) {
                    if (!promises.chapter || promises.chapter.length === 0) {
                        promises.chapter?.push({
                            hasHeading: false,
                            hasSubheading: false,
                            heading: {
                                heading: null,
                                subHeading: null,
                                type: null,
                            },
                            content: [],
                        })
                    }

                    const paragraph: IParagraph = {
                        type: className,
                        verses: [],
                    }

                    elem.find('> span.verse').each((_, verseEl) => {
                        const verseSpan = $(verseEl)
                        const numberText = verseSpan
                            .find('> span.label')
                            .text()
                            .trim()
                        const number =
                            parseInt(numberText) ||
                            parseInt(
                                (verseSpan.attr('data-usfm') ?? '0')
                                    .split('.')
                                    .pop()!
                            )

                        let verseText = ''
                        $(verseEl)
                            .children()
                            .each((_, child) => {
                                const childClass = $(child).attr('class') || ''
                                if (
                                    !childClass.includes('note') &&
                                    !childClass.includes('label')
                                ) {
                                    verseText += $(child).text()
                                }
                            })
                        verseText = verseText.trim()

                        if (verseText) {
                            paragraph?.verses?.push({
                                number,
                                displayNumber: !isNaN(parseInt(numberText)),
                                content: verseText as any,
                            })
                        }
                    })

                    promises.chapter![
                        promises.chapter!.length - 1
                    ]!!.content?.push(paragraph)
                }
            })

        let duplicatesSolved: {
            [verseNumber: string]: string
        } = {}

        promises?.chapter?.forEach((section) => {
            section?.content?.forEach((paragraph) => {
                paragraph?.verses?.forEach((verse) => {
                    const verseKey = `${verse.number}`
                    if (duplicatesSolved[verseKey]) {
                        duplicatesSolved[verseKey] = duplicatesSolved[
                            verseKey
                        ] += ` ${verse.content ?? ''}`
                    } else {
                        duplicatesSolved[verseKey] =
                            verse.content?.join(' ') ?? ''
                    }
                })
            })
        })

        let text = ''
        Object.keys(duplicatesSolved)
            .sort((a, b) => parseInt(a) - parseInt(b))
            .forEach((key) => {
                text += `${duplicatesSolved[key]} `
            })

        return {
            chapterInto: duplicatesSolved,
            audioInfo,
            text: text.trim(),
            next,
            prev,
        }
    }

    async alignPerVerse(audioUrl: string, text: string) {
        const response = await this.client.get(audioUrl, {
            responseType: 'stream',
        })

        const form = new FormData()

        form.append('audio', response.data, {
            filename: 'chapter.mp3',
            contentType: 'audio/mpeg',
        })

        form.append('transcript', Buffer.from(text), {
            filename: 'transcript.txt',
            contentType: 'text/plain',
        })

        const result = await this.client.post(
            'http://localhost:8765/transcriptions?async=false',
            form,
            {
                headers: form.getHeaders(),
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
            }
        )

        return result.data
    }

    async getDurationFromStream(url: string) {
        try {
            const response = await this.client({
                method: 'get',
                url,
                responseType: 'stream',
            })
            const metadata = await parseStream(response.data, {
                mimeType: 'audio/mpeg',
            })
            return metadata.format.duration || 0
        } catch (e) {
            return 0
        }
    }

    fillGaps(words: any) {
        for (let i = 0; i < words.length; i++) {
            if (words[i].case === 'not-found-in-audio') {
                // 1. Find the last successful word before this gap
                let prev = words
                    .slice(0, i)
                    .reverse()
                    .find((w: any) => w.case === 'success')
                // 2. Find the next successful word after this gap
                let next = words
                    .slice(i + 1)
                    .find((w: any) => w.case === 'success')

                if (prev && next) {
                    let gapDuration = next.start - prev.end
                    // Find how many words are in this specific gap
                    let gapStartIndex = i
                    let gapEndIndex = i
                    while (
                        words[gapEndIndex + 1] &&
                        words[gapEndIndex + 1].case === 'not-found-in-audio'
                    ) {
                        gapEndIndex++
                    }

                    let numMissing = gapEndIndex - gapStartIndex + 1
                    let timePerWord = gapDuration / numMissing

                    // 3. Assign estimated timestamps
                    for (let j = 0; j < numMissing; j++) {
                        let targetIndex = gapStartIndex + j
                        words[targetIndex].start = prev.end + j * timePerWord
                        words[targetIndex].end =
                            words[targetIndex].start + timePerWord
                        words[targetIndex].isEstimated = true // Flag it for your own reference
                    }
                    // Skip the words we just filled
                    i = gapEndIndex
                }
            }
        }
        return {
            start: words[0]?.start ?? 0,
            end: words[words.length - 1]?.end ?? 0,
            startOffset: words[0]?.startOffset ?? 0,
            endOffset: words[words.length - 1]?.endOffset ?? 0,
        }
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
        const verses = await this.getChapter(version.id, bookUsfm, chapter)
        const verseKeys = Object.keys(verses.chapterInto)

        const verseRanges = verseKeys.map((key, index) => {
            const text = verses.chapterInto[key]
            const start = verses.text.indexOf(text ?? '')
            return {
                key: key,
                start: start,
                end: start + (text?.length ?? 0),
            }
        })

        for (const audio of verses.audioInfo) {
            const audioUrl = `https:${audio?.download_urls?.format_mp3_32k}`

            const [totalDuration, result] = await Promise.all([
                this.getDurationFromStream(audioUrl),
                this.alignPerVerse(audioUrl, verses.text),
            ])

            const versesWithWords = verseRanges.map((range) => {
                const filteredWords = result.words.filter(
                    (w: any) =>
                        w.startOffset >= range.start &&
                        w.startOffset < range.end
                )

                return {
                    verse: range.key,
                    timing: this.fillGaps(filteredWords),
                }
            })

            for (let i = 0; i < versesWithWords.length; i++) {
                let current = versesWithWords[i]!!

                if (i > 0) {
                    current.timing.start = versesWithWords[i - 1]?.timing.end
                } else {
                    current.timing.start = 0
                }

                if (current.timing.end <= current.timing.start) {
                    let nextValidVerse = versesWithWords
                        .slice(i + 1)
                        .find((v) => v.timing.end > 0)

                    if (nextValidVerse) {
                        current.timing.end = nextValidVerse.timing.start
                    } else {
                        current.timing.end = totalDuration
                    }
                }
            }

            if (versesWithWords.length > 0) {
                versesWithWords[versesWithWords.length - 1]!!.timing.end =
                    totalDuration
            }

            promises.push({
                audioName: `${book} Chapter ${chapter} `,
                title: audio.title,
                voiceId: audio.id,
                versionId: audio.version_id,
                default: audio.default,
                fileId: audioUrl.split('/').pop()?.split('.')[0] ?? '',
                next: verses.next,
                prev: verses.prev,
                lyrics: versesWithWords,
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
