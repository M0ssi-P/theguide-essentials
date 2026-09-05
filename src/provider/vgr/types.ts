export const Style = {
    BlankTape: 'BlankTape',
    SmCaps: 'SmCaps',
    Bold: 'Bold',
    Italic: 'Italic',
    Song: 'Song',
    Nothing: 'Nothing',
    Scripture: 'Scripture',
    Deemed: 'Deemed',
    Normal: 'Normal',
} as const

export type Style = (typeof Style)[keyof typeof Style]

export interface LanguageRoot {
    c: string // iso63903
    e: string // name
    f: string // localName
    i: string // iso63901
}

export interface IRepoSERMONS {
    Request: {
        Language: string
    }
    Result: {
        Sermons: Array<{
            c: number
            cab: boolean
            ct: string
            i: number
            m?: number | null
            p: string
            t: string
        }>
    }
}

export interface IHubResponse {
    date: string
    dateCode: string
    id: number
    languageCode: string
    location: string
    nextDateCode: string
    previousDateCode: string
    sortDate: string
    title: string
    updatedOn: number
}

export interface LanguageRequest {
    Language: string
}

export interface SermonRequest {
    GetAllContent: boolean
    HighlightQuery: string | null
    Language: string
    SermonProductIdentityId: number
}

export interface IHubSermonResponse {
    sermon: {
        id: number
        languageCode: string
        dateCode: string
        sortDate: string
        title: string
        location: string
        date: string
        updatedOn: number
        nextDateCode: string
        previousDateCode: string
        blocks: Array<{
            blockId: number
            blockNumber: number
            blockText: string
        }>
    }
}

export interface ISermonResponse {
    Request: {
        GetAllContent: boolean
        Language: string
        SermonProductIdentityId: number
    }
    Result: {
        BookTitle: string
        DateCode: string
        IsCAB: boolean
        Sections: Array<{
            Content: string
            IsHit: boolean
            Paragraph: string
        }>
        Title: string
        TotalSections: number
    }
}

export interface Segment {
    style: Style[]
    content: string
    index?: number[]
    start?: number
    end?: number
}

export interface Line {
    displayNumber: boolean
    number: number
    segments: Segment[]
}

export interface Paragraph {
    id: number | null
    number: number | null
    text: string
    isFirst: boolean
    isQuestion: boolean
    content: Line[]
}

export interface Section {
    canHit: boolean
    isHeader: boolean
    key: string
    paragraph: string
    content: Paragraph[]
}

export interface Sermon {
    id: number | null
    stringId?: string,
    date: string
    dateCode: string
    language: string | null
    location: string
    nextSermonDate?: string
    prevSermonDate?: string
    title: string
    sortDate: string
    minutes?: number | null
    isCab?: boolean,
    hasSubtitle?: boolean,
    sections?: Section[] | null
    totalSections?: number | null
    c: number
    i: number
    ct: string
    updatedAt?: number | null
}

export function getDdMmYy(sermon: Sermon): string {
    const parts = sermon.dateCode.split('-')
    const monthInt = parseInt(parts[1].replace(/\D/g, '').slice(0, 2), 10)
    const dayNum = parseInt(parts[1].replace(/\D/g, '').slice(-2), 10)

    const getOrdinal = (n: number) => {
        const s = ['th', 'st', 'nd', 'rd']
        const v = n % 100
        return n + (s[(v - 20) % 10] || s[v] || s[0])
    }

    const monthNames = [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec',
    ]
    const mon = monthNames[monthInt - 1]
    const year = `19${parts[0]}`

    return `${getOrdinal(dayNum)} ${mon} ${year}`
}
