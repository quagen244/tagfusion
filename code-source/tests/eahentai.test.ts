// EAHentai, reproduit d'après le vrai site : npx tsx --tsconfig tests/tsconfig.json tests/eahentai.test.ts
import assert from 'node:assert/strict'
import { load } from './shim/minicheerio'
import { EAH, album, galleryPage, readerPage, fullUrl } from './fixtures/eahentai'

const GET: Record<string, string> = {}
const requests: string[] = []

// 74 pages (la dernière en PNG), 24 miniatures affichées, « +50 more pages »
const A = album(77148, 'b036b3bc9a314282958f1d7a4c2755dc', '[Nanahoshi12mg] Natsu Inaka Megane Shimai', 74, n => n === 74 ? `image${n}.png` : `image${n}.webp`, ['ahegao', 'big breasts', 'glasses'])
// 81 pages, noms « 001.jpg » et formats mélangés
const B = album(77184, '5d2917e8a3e744afb3e3b4ec00170a0d', '[Artist] Long Story', 81, n => `${String(n).padStart(3, '0')}.${n % 7 === 0 ? 'webp' : 'jpg'}`, ['vanilla'])
// 12 pages : toutes les miniatures affichées
const C = album(77200, 'ad1468545b314bc0a31a2f6bc405a500', '[Artist] Short One', 12, n => `image${n}.webp`, ['comedy'])
// Galeries suggérées (citées dans les données de la page) : ne doivent jamais se mélanger
const R1 = album(77153, 'db987b2b525b464c9e3bc1c8837f15bd', 'Related One', 30, n => `image${n}.webp`, [])
const R2 = album(77154, '1849c1e1b35f4480bfcf8d312bcc2692', 'Related Two', 20, n => `${String(n).padStart(2, '0')}.jpg`, [])

GET[`${EAH}/`] = `<html><body><div class="grid">${[A, B, C].map(a => `<a href="/a/${a.id}"><img src="https://i.eahentai.com/file/ea-gallery/galleries/${a.hash}/thumbnail/image1t.jpg" alt="${a.title}"></a>`).join('')}</div></body></html>`
for (const a of [A, B, C]) {
    GET[`${EAH}/a/${a.id}`] = galleryPage(a, [R1, R2])
    a.files.forEach((_, n) => { GET[`${EAH}/a/${a.id}/${n}`] = readerPage(a, n) })
}

;(globalThis as any).App = {
    createSourceStateManager: () => { const m = new Map(); return { keychain: {}, store: async (k: string, v: unknown) => { m.set(k, JSON.parse(JSON.stringify(v))) }, retrieve: async (k: string) => m.get(k) } },
    createRequestManager: (info: any) => ({
        ...info, getDefaultUserAgent: async () => 'UA',
        schedule: async (req: any) => {
            const r = await info.interceptor.interceptRequest(req)
            requests.push(r.url)
            const b = GET[r.url]
            return b !== undefined ? { status: 200, headers: {}, data: b, request: r } : { status: 404, headers: {}, data: '', request: r }
        }
    }),
    createRequest: (i: any) => ({ headers: {}, cookies: [], ...i }), createChapter: (i: any) => i, createChapterDetails: (i: any) => i, createTag: (i: any) => i, createTagSection: (i: any) => i,
    createPagedResults: (i: any) => ({ results: [], ...i }), createPartialSourceManga: (i: any) => i, createSourceManga: (i: any) => i, createMangaInfo: (i: any) => i, createHomeSection: (i: any) => i
}

async function main(): Promise<void> {
    const { TagFusion } = await import('../src/TagFusion/TagFusion')
    const { encodeMangaId, encodeChapterId, decodeChapterId } = await import('../src/TagFusion/Utils')
    const src: any = new TagFusion({ load })
    await src.store.setSites([EAH])
    const idOf = (a: { id: number }): string => encodeMangaId('eahentai.com', `${EAH}/a/${a.id}`)

    for (const [a, label] of [[A, '74 pages, 24 miniatures affichées, dernière page en PNG'], [B, '81 pages « 001.jpg », formats mélangés'], [C, '12 pages, toutes affichées']] as const) {
        const chs = await src.getChapters(idOf(a))
        assert.equal(chs.length, 1, `${a.title} : ${chs.length} chapitres (${chs.slice(0, 4).map((c: any) => decodeChapterId(c.id)).join(', ')})`)
        assert.equal(decodeChapterId(chs[0].id), `/a/${a.id}`)
        // Nouvel exemplaire : rien en cache, la vraie suite de requêtes
        const fresh: any = new TagFusion({ load })
        await fresh.store.setSites([EAH])
        requests.length = 0
        const pages = (await fresh.getChapterDetails(idOf(a), chs[0].id)).pages
        assert.deepEqual(pages, a.files.map((_, i) => fullUrl(a, i)), `${a.title} : pages`)
        assert.ok(!pages.some((u: string) => /thumbnail|db987b2b|1849c1e1/.test(u)), 'ni miniatures ni pages des galeries suggérées')
        // (la page d'accueil n'est lue qu'une fois, pour reconnaître le site)
        const reqs = requests.filter(u => u !== `${EAH}/`)
        assert.deepEqual(reqs, [`${EAH}/a/${a.id}`], `requêtes : ${reqs.join(', ')}`)
        console.log(`✓ ${label} : 1 chapitre, les ${pages.length} pages exactes dans l'ordre, une seule page lue (la fiche)`)
    }

    // Chapitres enregistrés par l'ancienne version (une « page de lecture » par chapitre) : la galerie entière
    const old = (await src.getChapterDetails(idOf(A), encodeChapterId(`${EAH}/a/77148/5`))).pages
    assert.deepEqual(old, A.files.map((_, i) => fullUrl(A, i)))
    console.log(`✓ Ancien chapitre « /a/77148/5 » (versions précédentes) : les ${old.length} pages au lieu de 5`)

    // Fiche : vrais tags seulement
    const d = await src.getMangaDetails(idOf(A))
    // (« Doujinshi » = le type de la galerie, gardé comme tag, comme sur E-Hentai)
    assert.deepEqual(d.mangaInfo.tags[0].tags.map((t: any) => t.label).sort(), ['Doujinshi', 'ahegao', 'big breasts', 'glasses'])
    assert.equal(d.mangaInfo.titles[0], A.title)
    console.log('✓ Fiche : titre, tags et type (artiste et parodie écartés)')
}
main().then(() => console.log('\nEAHentai : tout est bon')).catch(e => { console.error('ÉCHEC :', e); process.exit(1) })
