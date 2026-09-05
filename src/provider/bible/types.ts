import { ILanguage } from '../../types'

export interface IBibleVersionHTMLorText {
    html: string | null
    text: string | null
}

export interface IBibleVersionChapter {
    toc: boolean
    usfm: string
    human: string
    canonical: boolean
}

export interface IBibleVersionBook {
    hasText: boolean
    hasAudio: boolean
    usfm: string
    canon: string
    human: string
    humanLong: string
    abbreviation: string
    chapters: IBibleVersionChapter[]
}

export interface IBibleVersionPublisher {
    id: number
    name: string
    localName?: string | null
    url?: string | null
    description?: string | null
}

export interface IBibleVersion {
    id: number
    abbreviation: string
    localAbbreviation: string
    title: string
    localTitle: string
    audio: boolean
    audioCount: number
    text: boolean
    language: ILanguage
    copyrightShort?: IBibleVersionHTMLorText | null
    copyrightLong?: IBibleVersionHTMLorText | null
    readerFooter?: IBibleVersionHTMLorText | null
    publisher?: IBibleVersionPublisher | null
    books?: IBibleVersionBook[] | null
}

export enum Paragraph {
    Normal = 'Normal',
    PC = 'PC',
    LI = 'LI',
    Q1 = 'Q1',
    Q2 = 'Q2',
    M = 'M',
}

export enum VerseLineEnum {
    Reference = 'Reference',
    Word = 'Word',
}

export enum VerseLineDisplay {
    Normal = 'Normal',
    Italic = 'Italic',
    SmallCaps = 'SmallCaps',
    BdSmallCaps = 'BdSmallCaps',
}

export interface HeadingObject {
    heading?: string | null
    subHeading?: string | null
    type?: string | null
}

export interface IBibleVerseLine {
    type: VerseLineEnum
    isJesus: boolean
    display: VerseLineDisplay
    content?: string | null
    reference?: string | null
}

export interface IBibleVerse {
    number: number
    displayNumber?: boolean
    content?: IBibleVerseLine[]
}

export interface IParagraph {
    type?: string | null
    verses?: IBibleVerse[]
}

export interface ChapterSection {
    hasHeading?: boolean
    hasSubheading?: boolean
    heading?: HeadingObject | null
    content?: IParagraph[]
}

export interface DownloadUrls {
    formattedMp3: string
    formattedHls: string
}

export interface ChapterAud {
    id: number
    versionId: number
    title: string
    hasTiming: boolean
    dramatized: boolean
    default: boolean
    playOrDwnLoad: DownloadUrls
}

export interface IChapterContent {
    version?: IBibleVersion | null
    audio?: ChapterAud[] | null
    chapter?: ChapterSection[]
}
