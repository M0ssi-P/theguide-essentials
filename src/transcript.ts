import Bible from './provider/bible/bible.ts'
import fs from 'fs'
import path from 'path'

const chunk = (arr: any[], size: number) =>
    Array.from({ length: Math.ceil(arr.length / size) }, (v, i) =>
        arr.slice(i * size, i * size + size)
    )

;(async () => {
    const bible = new Bible('en')
    const version = await bible.getFullVersion(114)

    for (const book of version.books) {
        if (!book.audio) continue

        const dataStore = path.join(
            process.cwd(),
            `src/datastore/bible/${version.abbreviation}-${version.id}/subtitles/`
        )

        console.log(`\n📖 Starting Book: ${book.human}`)
        const chapterChunks = chunk(book.chapters, 2)

        for (let i = 0; i < chapterChunks.length; i++) {
            const batch = chapterChunks[i]
            console.log(
                `⏳ Batch ${i + 1}/${chapterChunks.length} (${book.human})`
            )

            await Promise.allSettled(
                batch!!.map(async (chapter) => {
                    const filePath = path.join(
                        dataStore,
                        `${book.usfm}-${chapter.human}.json`
                    )

                    if (fs.existsSync(filePath)) {
                        console.log(`   ⏭️ Skipped: ${chapter.human}`)
                        return
                    }

                    try {
                        await bible.generateTranscript(
                            version,
                            book.usfm,
                            parseInt(chapter.human),
                            book.human
                        )
                        console.log(`   ✅ Done: ${chapter.human}`)
                    } catch (err: any) {
                        console.error(
                            `   ❌ Failed: ${chapter.human} -> ${err.message}`
                        )
                    }
                })
            )
            await new Promise((resolve) => setTimeout(resolve, 2000))
        }
    }
    console.log('🏁 Finished all books.')
})()
