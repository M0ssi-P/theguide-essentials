
export interface ILanguage {
    id: number | null;
    dbId?: string | null;
    iso63901: string | null;
    iso63903: string | null;
    name: string;
    localName: string;
    tag: string;
    hasAudio: number | boolean | null; // Set as boolean | null if strict boolean
    hasText: boolean | null;
    totalVersions: number | null;
    textDirection: string;
    font: string | null;
}