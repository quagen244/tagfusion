// Catalogue complet de chaque site et annuaires de tags paginés : npx tsx --tsconfig tests/tsconfig.json tests/catalog.test.ts
import assert from 'node:assert/strict'
import { load } from './shim/minicheerio'

const GET: Record<string, string> = {}
const requests: string[] = []
const page = (body: string, title = 'Site'): string => `<html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`
const card = (host: string, slug: string, title: string): string =>
    `<div class="item"><a href="https://${host}/manga/${slug}/"><img src="https://${host}/img/${slug}.jpg" alt="${title}"></a><h3>${title}</h3></div>`
const fiche = (title: string, tags: string[]): string => page(`<h1>${title}</h1><div class="genres">${tags.map(t => `<span>${t}</span>`).join('')}</div>`)

// --- browse.test : pas de /manga/, accueil = 6 nouveautés sans pagination, le menu « Browse » mène au catalogue (3 pages) ---
const B = 'browse.test'
GET[`https://${B}/`] = page(`<nav><a href="/browse">Browse</a><a href="/about">About</a></nav>` + [1, 2, 3, 4, 5, 6].map(n => card(B, `m${n}`, `Browse ${n}`)).join(''), 'Browse Scans')
for (let p = 1; p <= 3; p++) {
    const url = p === 1 ? `https://${B}/browse` : `https://${B}/browse?page=${p}`
    GET[url] = page(Array.from({ length: 10 }, (_, i) => card(B, `m${(p - 1) * 10 + i + 1}`, `Browse ${(p - 1) * 10 + i + 1}`)).join('') + (p < 3 ? `<a rel="next" href="/browse?page=${p + 1}">Next</a>` : ''))
}
// Tags sans lien sur les fiches : « Isekai » sur 1 fiche sur 7
for (let n = 1; n <= 30; n++) GET[`https://${B}/manga/m${n}/`] = fiche(`Browse ${n}`, n % 7 === 0 ? ['Isekai', 'Drama'] : ['Drama'])

// --- latest.test : /manga/ existe mais sans pagination (5 mangas), « Latest » du menu est paginé ---
const L = 'latest.test'
GET[`https://${L}/`] = page(`<header><a href="/latest">Latest Updates</a></header>` + [1, 2, 3].map(n => card(L, `x${n}`, `Latest ${n}`)).join(''), 'Latest Scans')
GET[`https://${L}/manga/`] = page([1, 2, 3, 4, 5].map(n => card(L, `x${n}`, `Latest ${n}`)).join(''))
GET[`https://${L}/latest`] = page(Array.from({ length: 12 }, (_, i) => card(L, `x${i + 1}`, `Latest ${i + 1}`)).join('') + '<a rel="next" href="/latest?page=2">Next</a>')
GET[`https://${L}/latest?page=2`] = page(Array.from({ length: 12 }, (_, i) => card(L, `x${i + 13}`, `Latest ${i + 13}`)).join(''))
for (let n = 1; n <= 24; n++) GET[`https://${L}/manga/x${n}/`] = fiche(`Latest ${n}`, n % 6 === 0 ? ['Isekai'] : ['Comedy'])

// --- tags.test : annuaire de tags paginé (3 pages de 12), et un annuaire « All Tags » lié depuis le menu ---
const T = 'tags.test'
const tagWord = (i: number): string => `tag${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`
GET[`https://${T}/`] = page(`<nav><a href="/all-tags">All Tags</a></nav>` + [1, 2, 3, 4].map(n => card(T, `t${n}`, `Tags ${n}`)).join(''), 'Tags Scans')
for (let p = 1; p <= 3; p++) {
    const url = p === 1 ? `https://${T}/tags` : `https://${T}/tags?page=${p}`
    GET[url] = page(`<div class="tag-list">${Array.from({ length: 12 }, (_, i) => `<a href="/tag/${tagWord((p - 1) * 12 + i)}/">${tagWord((p - 1) * 12 + i)}</a>`).join('')}</div>` + (p < 3 ? `<a rel="next" href="/tags?page=${p + 1}">Next</a>` : ''))
}
GET[`https://${T}/all-tags`] = page(`<div class="tag-list">${['vanilla', 'netorare', 'harem'].map(t => `<a href="/tag/${t}/">${t}</a>`).join('')}</div>`)

const mem = new Map<string, unknown>()
;(globalThis as any).App = {
    createSourceStateManager: () => ({ keychain: {}, store: async (k: string, v: unknown) => { mem.set(k, JSON.parse(JSON.stringify(v))) }, retrieve: async (k: string) => mem.get(k) }),
    createRequestManager: (info: any) => ({
        ...info, getDefaultUserAgent: async () => 'UA',
        schedule: async (req: any) => {
            const r = await info.interceptor.interceptRequest(req)
            requests.push(r.url)
            const body = GET[r.url]
            return body !== undefined ? { status: 200, headers: {}, data: body, request: r } : { status: 404, headers: {}, data: '', request: r }
        }
    }),
    createRequest: (i: any) => ({ headers: {}, cookies: [], ...i }),
    createTag: (i: any) => i, createTagSection: (i: any) => i, createPagedResults: (i: any) => ({ results: [], ...i }),
    createPartialSourceManga: (i: any) => i, createHomeSection: (i: any) => i, createSourceManga: (i: any) => i, createMangaInfo: (i: any) => i
}

async function main(): Promise<void> {
    const { TagFusion } = await import('../src/TagFusion/TagFusion')
    const { tagIdOf, encodeMangaId } = await import('../src/TagFusion/Utils')
    const src: any = new TagFusion({ load })
    await src.store.setSites([`https://${B}`, `https://${L}`, `https://${T}`])
    // Catalogue enregistré par une ancienne version (« aucun ») : il est recherché à nouveau
    await src.store.updateSite(B, { base: `https://${B}`, catalog: '' })
    await src.discoverAll(true)

    // 1. Le bon catalogue de chaque site
    assert.equal((await src.store.site(B))?.catalog, `https://${B}/browse`, 'browse.test : le catalogue du menu « Browse »')
    assert.equal((await src.store.site(L))?.catalog, `https://${L}/latest`, 'latest.test : la liste paginée « Latest » plutôt que /manga/ (5 mangas)')
    console.log('✓ Catalogue complet trouvé : « Browse » du menu (aucune adresse habituelle), « Latest » paginé plutôt qu\'une liste courte ; ancien « aucun catalogue » réexaminé')

    // 2. Annuaires de tags : toutes les pages, et l'annuaire du menu
    const u = await src.store.unified()
    for (let i = 0; i < 36; i++) assert.ok(u[tagWord(i)]?.sites[T]?.url, `tag ${tagWord(i)} manquant`)
    for (const t of ['vanilla', 'netorare', 'harem']) assert.ok(u[t]?.sites[T]?.url, `tag ${t} (annuaire « All Tags ») manquant`)
    console.log('✓ Annuaires de tags : les 3 pages de « /tags » (36 tags) et l\'annuaire « All Tags » du menu (3 tags)')

    // 3. Un tag que les sites n'affichent que sur les fiches : TOUT le catalogue de chaque site est fouillé
    // (il faut avoir vu le tag une fois sur chaque site, sinon ces sites passent en dernier)
    await src.getMangaDetails(encodeMangaId(B, `https://${B}/manga/m7/`))
    await src.getMangaDetails(encodeMangaId(L, `https://${L}/manga/x6/`))
    const titles: string[] = []
    let meta: unknown = undefined
    let calls = 0
    do {
        const r = await src.getSearchResults({ includedTags: [{ id: tagIdOf('isekai'), label: 'Isekai' }], excludedTags: [] }, meta)
        titles.push(...r.results.map((x: any) => x.title))
        meta = r.metadata
    } while (meta !== undefined && ++calls < 40)
    const want = [...[7, 14, 21, 28].map(n => `Browse ${n}`), ...[6, 12, 18, 24].map(n => `Latest ${n}`)]
    assert.deepEqual([...new Set(titles)].sort(), want.sort())
    assert.ok(requests.includes(`https://${B}/browse?page=3`) && requests.includes(`https://${L}/latest?page=2`), 'catalogues lus jusqu\'à la dernière page')
    console.log(`✓ Tag présent seulement sur les fiches : les catalogues entiers (3 pages et 2 pages) fouillés, les ${want.length} mangas trouvés`)
}
main().then(() => console.log('\nCatalogues complets : tout est bon')).catch(e => { console.error('ÉCHEC :', e); process.exit(1) })
