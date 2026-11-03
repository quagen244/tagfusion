// Accueil « découverte » : npx tsx --tsconfig tests/tsconfig.json tests/discovery.test.ts
import assert from 'node:assert/strict'
import { load } from './shim/minicheerio'

const GET: Record<string, string> = {}
const page = (body: string, title = 'Site'): string => `<html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`
const card = (site: string, slug: string, title: string): string =>
    `<div class="item"><a href="https://${site}/manga/${slug}/"><img src="https://${site}/c/${slug}.jpg" alt="${title}"></a><h3>${title}</h3></div>`
const SITES = ['one.test', 'two.test', 'three.test']
for (const s of SITES) {
    GET[`https://${s}/`] = page(Array.from({ length: 30 }, (_, i) => card(s, `n${i}`, `${s} Latest ${i}`)).join(''), `${s.toUpperCase()} Scans`)
    GET[`https://${s}/manga/`] = page(Array.from({ length: 20 }, (_, i) => card(s, `k${i}`, `${s} Catalog ${i}`)).join('') + '<a rel="next" href="/manga/?page=2">Next</a>')
    GET[`https://${s}/manga/?page=2`] = page(Array.from({ length: 20 }, (_, i) => card(s, `k${20 + i}`, `${s} Catalog ${20 + i}`)).join(''))
}

const mem = new Map<string, unknown>()
;(globalThis as any).App = {
    createSourceStateManager: () => ({ keychain: {}, store: async (k: string, v: unknown) => { mem.set(k, JSON.parse(JSON.stringify(v))) }, retrieve: async (k: string) => mem.get(k) }),
    createRequestManager: (info: any) => ({
        ...info, getDefaultUserAgent: async () => 'UA',
        schedule: async (req: any) => {
            const r = await info.interceptor.interceptRequest(req)
            const body = GET[r.url]
            return body !== undefined ? { status: 200, headers: {}, data: body, request: r } : { status: 404, headers: {}, data: '', request: r }
        }
    }),
    createRequest: (i: any) => ({ headers: {}, cookies: [], ...i }),
    createTag: (i: any) => i, createTagSection: (i: any) => i, createPagedResults: (i: any) => ({ results: [], ...i }),
    createPartialSourceManga: (i: any) => i, createHomeSection: (i: any) => i
}

const GENRES = ['Romance', 'Comedy', 'Drama', 'Action', 'Fantasy', 'Horror', 'School Life', 'Isekai', 'Mystery', 'Sports', 'Yuri', 'Slice of Life']

async function main(): Promise<void> {
    const { TagFusion } = await import('../src/TagFusion/TagFusion')
    const { encodeMangaId } = await import('../src/TagFusion/Utils')
    const src: any = new TagFusion({ load })
    await src.store.setSites(SITES.map(s => `https://${s}`))
    // 300 mangas indexés sur 3 sites ; sur « one.test », chaque fiche a aussi des boutons lus comme des tags
    const entries = []
    for (let n = 0; n < 300; n++) {
        const s = SITES[n % 3] as string
        const l = [GENRES[n % 12] as string, GENRES[(n * 7 + 3) % 12] as string, 'English']
        if (s === 'one.test') l.push('Cancel', 'Help', 'Open in new tab', "Show this gallery's tags", 'Galleryinfo')
        entries.push({ id: encodeMangaId(s, `https://${s}/manga/i${n}/`), entry: { s, u: `https://${s}/manga/i${n}/`, t: `Indexed ${n}`, i: `https://${s}/c/i${n}.jpg`, l } })
    }
    await src.store.indexMany(entries)

    const home = async (): Promise<any[]> => { const out: any[] = []; await src.getHomePageSections((x: any) => out.push(JSON.parse(JSON.stringify(x)))); return out }
    const a = await home()
    const titles = a.map(x => x.title)

    // Aucune rangée absurde
    for (const bad of ['Cancel', 'Help', 'Open in new tab', 'Show this gallery\'s tags', 'Galleryinfo', 'English']) {
        assert.ok(!titles.some(t => t.toLowerCase() === bad.toLowerCase()), `rangée « ${bad} » : ${titles.join(' | ')}`)
    }
    console.log(`✓ Pas de rangée « Cancel », « Help », « Open in new tab », « Show this gallery's tags » ni de reste de page : ${titles.join(' | ')}`)

    // Chaque manga n'apparaît qu'une fois sur tout l'accueil
    const all = a.flatMap(x => x.items.map((i: any) => i.mangaId))
    assert.equal(new Set(all).size, all.length, `${all.length - new Set(all).size} manga(s) en double sur l'accueil`)
    const allTitles = a.flatMap(x => x.items.map((i: any) => i.title))
    assert.equal(new Set(allTitles).size, allTitles.length, 'titres en double')
    console.log(`✓ ${all.length} mangas sur l'accueil, aucun en double d'une rangée à l'autre`)

    // « Au hasard » juste après « À la une », mêlant les 3 sites ; « À la une » mêle aussi les sites
    assert.equal(a[0].id, 'home_featured')
    assert.equal(a[1].id, 'home_random')
    assert.equal(a[1].title, 'Au hasard')
    assert.ok(a[1].items.length >= 15)
    for (const s of SITES) {
        assert.ok(a[1].items.some((i: any) => i.mangaId.startsWith(encodeMangaId(s, `https://${s}/`).slice(0, 6))) || a[1].items.some((i: any) => i.subtitle?.includes(s.split('.')[0] as string) || i.subtitle === s), `« Au hasard » sans ${s}`)
    }
    const featSites = new Set(a[0].items.map((i: any) => i.subtitle))
    assert.ok(featSites.size >= 3, `« À la une » : ${[...featSites].join(', ')}`)
    console.log('✓ « Au hasard » juste après « À la une », les deux mêlant les 3 sites')

    // Chaque actualisation : un autre tirage
    const b = await home()
    const randA = a[1].items.map((i: any) => i.mangaId).join('|')
    const randB = b.find(x => x.id === 'home_random').items.map((i: any) => i.mangaId).join('|')
    assert.notEqual(randA, randB, '« Au hasard » identique après actualisation')
    const featA = a[0].items.map((i: any) => i.mangaId).join('|')
    const featB = b[0].items.map((i: any) => i.mangaId).join('|')
    assert.notEqual(featA, featB, '« À la une » identique après actualisation')
    console.log('✓ Actualisation : « Au hasard » et « À la une » changent à chaque fois')

    // Les rangées des sites ne répètent pas ce qui est déjà plus haut
    const siteRows = a.filter(x => x.id.startsWith('home_site_'))
    assert.equal(siteRows.length, 3)
    console.log('✓ Rangées « Nouveautés » des 3 sites, sans répéter le reste de l\'accueil')

    // « Voir plus » de « Au hasard » : tout l'index puis les catalogues, sans jamais de doublon
    const seen: string[] = []
    let meta: unknown = undefined
    let calls = 0
    do {
        const r = await src.getViewMoreItems('home_random', meta)
        seen.push(...r.results.map((x: any) => x.mangaId));
        meta = r.metadata
    } while (meta !== undefined && ++calls < 40)
    assert.equal(new Set(seen).size, seen.length, 'doublons dans « Au hasard »')
    assert.equal(seen.filter(id => /\/manga\/i\d+\//.test(require('../src/TagFusion/Utils').decodeMangaId(id).path)).length, 300, 'tout l\'index')
    assert.equal(seen.filter(id => /\/manga\/k\d+\//.test(require('../src/TagFusion/Utils').decodeMangaId(id).path)).length, 120, 'tous les catalogues (2 pages × 3 sites)')
    console.log(`✓ « Voir plus » de « Au hasard » : ${seen.length} mangas (tout l'index puis les catalogues des 3 sites), aucun doublon, puis fin`)
}
main().then(() => console.log('\nAccueil découverte : tout est bon')).catch(e => { console.error('ÉCHEC :', e); process.exit(1) })
