import type { ILanguage } from '../types/index.ts'
import { BaseParser } from './base_parser.ts'
import type { IBibleVersion } from './bible/types.ts'

export default abstract class BibleParser extends BaseParser {
    abstract getAllLanguages(): Promise<Array<ILanguage>>

    // abstract getVersionsFromLanguage(tag: string, type?: string): Promise<Array<IBibleVersion>>;
}
