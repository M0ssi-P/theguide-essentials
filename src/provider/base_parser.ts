import { BaseProvider } from './base_provider.ts'
import axios, { type AxiosInstance } from 'axios'

export const defaultHeaders: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36',
}

export abstract class BaseParser extends BaseProvider {
    client!: AxiosInstance

    constructor() {
        super()
        this.initialiseNetwork()
    }

    abstract search(q: string): void

    initialiseNetwork(): void {
        let okHttpClient = axios.create({
            headers: defaultHeaders,
        })
        this.client = okHttpClient
    }
}
