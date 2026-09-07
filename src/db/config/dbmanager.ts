import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import os from 'os'

class DBManager {
    private connections = new Map<string, Database.Database>()
    private dbDir = path.join(process.cwd(), 'TheGuide/db')

    constructor() {
        if (!fs.existsSync(this.dbDir)) {
            fs.mkdirSync(this.dbDir, { recursive: true })
        }
    }

    public connection(dbPath: string): Database.Database {
        let conn = this.connections.get(dbPath)

        if (!conn) {
            const dbFile = path.join(this.dbDir, dbPath)

            fs.mkdirSync(path.dirname(dbFile), { recursive: true })

            conn = new Database(dbFile)

            conn.pragma('foreign_keys = ON')

            console.log(`✅ Connected to SQLite database at: ${dbFile}`)
            this.connections.set(dbPath, conn)
        }

        return conn
    }

    public closeConnection(dbName: string): void {
        const conn = this.connections.get(dbName)

        if (conn) {
            try {
                conn.close()
                this.connections.delete(dbName)
                console.log(`🔒 Closed DB: ${dbName}`)
            } catch (e) {
                console.error(`Failed to close DB ${dbName}:`, e)
            }
        }
    }

    public closeAll(): void {
        for (const [name, conn] of this.connections.entries()) {
            try {
                conn.close()
                console.log(`🔒 Closed DB: ${name}`)
            } catch (e) {
                console.error(`Failed to close DB ${name}:`, e)
            }
        }
        this.connections.clear()
    }
}

export const DB = new DBManager()