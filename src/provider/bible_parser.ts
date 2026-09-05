import { ILanguage } from '../types'
import { BaseParser } from './base_parser'
import { IBibleVersion } from './bible/types'

export default abstract class BibleParser extends BaseParser {
    abstract getAllLanguages(): Promise<Array<ILanguage>>

    // abstract getVersionsFromLanguage(tag: string, type?: string): Promise<Array<IBibleVersion>>;
}
