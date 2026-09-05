import { BaseParser } from './base_parser.ts'
import { type ILanguage } from '../types/index.ts'

export abstract class TableParser extends BaseParser {
    abstract getAllLanguages(): Array<ILanguage>
}