export interface IProviderStats {
    name: string
    saveName: string
    baseURI: string
    isDiverse: boolean
    language: string
    isWorking: boolean
}

export abstract class BaseProvider {
    abstract name: string
    abstract baseURI: string
    abstract saveName: string

    isDiverse: boolean = true
    language: string = 'en'
    isWorking: boolean = true

    toStats(): IProviderStats {
        return {
            name: this.name,
            saveName: this.saveName,
            baseURI: this.baseURI,
            isDiverse: this.isDiverse,
            language: this.language,
            isWorking: this.isWorking,
        }
    }

    toString(): string {
        return JSON.stringify(this.toStats())
    }
}
