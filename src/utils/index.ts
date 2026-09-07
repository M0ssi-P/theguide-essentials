import * as fs from 'fs'
import * as path from 'path'

export function loadSql(resource: string, forDb: string = 'tb'): string {
    const filePath = path.resolve(process.cwd(), 'src', 'sql', forDb, resource)
    return fs.readFileSync(filePath, 'utf-8')
}