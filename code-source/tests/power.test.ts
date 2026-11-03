// Index agrandi et découpé, tags des vignettes, recherche exhaustive : npx tsx --tsconfig tests/tsconfig.json tests/power.test.ts
import assert from 'node:assert/strict'
import { load } from './shim/minicheerio'

const GET: Record<string, string> = {}
const FAIL: Record<string, number> = {}
const requests: string[] = []
const writes: string[] = []
const page = (body: string, title = 'Site'): string => `<html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`
const card = (host: string, slug: string, title: string, tags: string[] = []): string =>
    `<div class="item"><a href="https://${host}/manga/${slug}/"><img src="https://${host}/c/${slug}.jpg" alt="${title}"></a><h3>${title}</h3>${tags.length ? `<div class="tags">${tags.map(t => `<span class="tag">${t}</span>`).join('')}</div>` : ''}</div>`

// --- syn.test : « Yuri » et « Girls Love » sont deux pages du site, fusionnées en un seul tag ---
GET['https://syn.test/'] = page(`<a href="/genre/yuri/">Yuri</a><a href="/genre/girls-love/">Girls Love</a><a href="/genre/drama/">Drama</a>`)
GET['https://syn.test/genre/yuri/'] = page([1, 2, 3].map(n => card('syn.test', `y${n}`, `Yuri ${n}`)).join(''))
GET['https://syn.test/genre/girls-love/'] = page([4, 5].map(n => card('syn.test', `y${n}`, `Yuri ${n}`)).join('') + card('syn.test', 'y1', 'Yuri 1'))
GET['https://syn.test/genre/drama/'] = page(card('syn.test', 'd1', 'Drama 1'))

// --- flaky.test : la page 2 du tag tombe en panne (500) plusieurs fois, puis répond ---
GET['https://flaky.test/'] = page('<a href="/genre/action/">Action</a>')
for (let p = 1; p <= 3; p++) {
    const url = p === 1 ? 'https://flaky.test/genre/action/' : `https://flaky.test/genre/action/?page=${p}`
    GET[url] = page(Array.from({ length: 10 }, (_, i) => card('flaky.test', `a${(p - 1) * 10 + i + 1}`, `Action ${(p - 1) * 10 + i + 1}`)).join('')
        + (p < 3 ? `<a class="next" href="/genre/action/?page=${p + 1}">Next</a>` : ''))
}
FAIL['https://flaky.test/genre/action/?page=2'] = 4 // 1er appel : 3 essais en échec ; 2e appel : 1 échec puis la page

// --- cards.test : tags affichés sur les vignettes de la page d'accueil ---
GET['https://cards.test/'] = page(Array.from({ length: 6 }, (_, i) => card('cards.test', `k${i + 1}`, `Card ${i + 1}`, i % 2 === 0 ? ['Comedy', 'School'] : ['Comedy'])).join(''))

const mem = new Map<string, unknown>()
;(globalThis as any).App = {
    createSourceStateManager: () => ({
        keychain: {},
        store: async (k: string, v: unknown) => { writes.push(k); mem.set(k, JSON.parse(JSON.stringify(v))) },
        retrieve: async (k: string) => mem.get(k)
    }),
    createRequestManager: (info: any) => ({
        ...info, getDefaultUserAgent: async () => 'UA',
        schedule: async (req: any) => {
            const r = await info.interceptor.interceptRequest(req)
            requests.push(r.url)
            if (FAIL[r.url]) { FAIL[r.url]--; return { status: 500, headers: {}, data: 'oops', request: r } }
            const body = GET[r.url]
            return body !== undefined ? { status: 200, headers: {}, data: body, request: r } : { status: 404, headers: {}, data: '', request: r }
        }
    }),
    createRequest: (i: any) => ({ headers: {}, cookies: [], ...i }),
    createChapter: (i: any) => i, createChapterDetails: (i: any) => i, createTag: (i: any) => i, createTagSection: (i: any) => i,
    createPagedResults: (i: any) => ({ results: [], ...i }), createPartialSourceManga: (i: any) => i,
    createSourceManga: (i: any) => i, createMangaInfo: (i: any) => i, createHomeSection: (i: any) => i
}

async function main(): Promise<void> {
    const { TagFusion } = await import('../src/TagFusion/TagFusion')
    const { Store } = await import('../src/TagFusion/Store')
    const { tagIdOf, safeEncode, siteTagIdOf } = await import('../src/TagFusion/Utils')
    const t = (k: string) => ({ id: tagIdOf(k), label: k })
    const only = (site: string) => ({ id: siteTagIdOf(site), label: site })

    // ---------- 1. Index : ancien format relu, puis réparti en morceaux ----------
    mem.set('tf_manga_index', { 'old.test\n/manga/x/': { s: 'old.test', u: 'https://old.test/manga/x/', t: 'Ancien', i: '', l: ['Romance'], at: 1 } })
    const st: any = new Store((globalThis as any).App.createSourceStateManager())
    assert.equal(await st.indexSize(), 1, 'ancien index relu')
    await st.indexMany([{ id: 'old.test\n/manga/y/', entry: { s: 'old.test', u: 'https://old.test/manga/y/', t: 'Nouveau', i: '', l: ['Romance'] } }])
    assert.deepEqual(mem.get('tf_manga_index'), {}, 'ancien index vidé après répartition')
    const shards = [...mem.keys()].filter(k => /^tf_manga_index_\d$/.test(k))
    assert.equal(shards.length, 8)
    assert.equal(await new Store((globalThis as any).App.createSourceStateManager()).indexSize(), 2)
    console.log('✓ Index : l\'ancien format est relu puis réparti en 8 morceaux, rien n\'est perdu')

    // ---------- 2. 12 000 mangas, écritures légères ----------
    writes.length = 0
    await st.indexMany([{ id: 'one.test\n/manga/1/', entry: { s: 'one.test', u: 'https://one.test/manga/1/', t: 'Un', i: '', l: ['Romance'] } }])
    assert.equal(writes.filter(k => /^tf_manga_index_\d$/.test(k)).length, 1, `morceaux réécrits pour 1 manga : ${writes.join(', ')}`)
    const many = Array.from({ length: 12500 }, (_, i) => ({ id: `big.test\n/manga/${i}/`, entry: { s: 'big.test', u: `https://big.test/manga/${i}/`, t: `Big ${i}`, i: '', l: ['Romance', i % 2 ? 'Comedy' : 'Drama'] } }))
    for (let i = 0; i < many.length; i += 2500) await st.indexMany(many.slice(i, i + 2500))
    assert.equal(await st.indexSize(), 12000, 'plafond de 12 000 (les plus anciens partent)')
    assert.ok(await st.getIndexed('big.test\n/manga/12499/'), 'le plus récent est gardé')
    await st.indexMany([{ id: 'one.test\n/manga/1/', entry: { s: 'one.test', u: 'https://one.test/manga/1/', t: 'Un', i: '', l: ['Romance'] } }])
    console.log('✓ Index : 12 000 mangas gardés (contre 3 000 avant), ajouter un manga ne réécrit qu\'un morceau sur 8')

    // Index plein : une vignette seule part la première
    await st.notePartial([{ id: 'p.test\n/manga/0/', entry: { s: 'p.test', u: 'https://p.test/manga/0/', t: 'Vu', i: '', l: ['Horror'] } }])
    assert.equal(await st.getIndexed('p.test\n/manga/0/'), undefined, 'index plein : la vignette ne pousse pas dehors une fiche lue')
    assert.equal(await st.indexSize(), 12000)

    // ---------- 3. Vignettes : jamais à la place d'une fiche lue, et pas comme preuve d'absence ----------
    mem.clear()
    st.index = undefined
    await st.indexMany([{ id: 'one.test\n/manga/1/', entry: { s: 'one.test', u: 'https://one.test/manga/1/', t: 'Un', i: '', l: ['Romance'] } }])
    await st.notePartial([{ id: 'one.test\n/manga/1/', entry: { s: 'one.test', u: 'https://one.test/manga/1/', t: 'Un', i: '', l: ['Horror'] } }])
    assert.deepEqual((await st.getIndexed('one.test\n/manga/1/')).l, ['Romance'], 'fiche lue intacte')
    await st.notePartial([{ id: 'p.test\n/manga/1/', entry: { s: 'p.test', u: 'https://p.test/manga/1/', t: 'Vu', i: '', l: ['Horror'] } }])
    await st.notePartial([{ id: 'p.test\n/manga/1/', entry: { s: 'p.test', u: 'https://p.test/manga/1/', t: 'Vu', i: '', l: ['Gore'] } }])
    assert.deepEqual((await st.getIndexed('p.test\n/manga/1/')).l.sort(), ['Gore', 'Horror'], 'vignettes complétées')
    assert.equal((await st.searchIndex(['horror'], [], ['p.test'])).length, 1, 'trouvé par ses tags de vignette')
    assert.equal((await st.searchIndex(['horror'], ['comedy'], ['p.test'])).length, 0, 'pas renvoyé avec une exclusion (tags peut-être incomplets)')
    assert.equal((await st.searchIndex([], [], ['p.test'])).length, 0, 'pas dans « À la une »')
    await st.indexMany([{ id: 'p.test\n/manga/1/', entry: { s: 'p.test', u: 'https://p.test/manga/1/', t: 'Vu', i: '', l: ['Horror', 'Comedy'] } }])
    assert.equal((await st.getIndexed('p.test\n/manga/1/')).p, undefined, 'la fiche lue remplace la vignette')
    console.log('✓ Vignettes : complétées, jamais à la place d\'une fiche lue, jamais utilisées pour prouver l\'absence d\'un tag')

    // ---------- 4. Recherche : l'index parcouru en entier, page après page ----------
    mem.clear()
    const src: any = new TagFusion({ load })
    await src.store.setSites(['https://syn.test', 'https://flaky.test', 'https://cards.test'])
    await src.discoverAll(true)
    await src.store.indexMany(Array.from({ length: 150 }, (_, i) => ({ id: `idx.test\n/manga/${i}/`, entry: { s: 'syn.test', u: `https://syn.test/manga/i${i}/`, t: `Indexed ${i}`, i: '', l: ['Drama'] } })))
    const run = async (inc: any[], exc: any[] = []): Promise<string[]> => {
        const titles: string[] = []
        let meta: unknown = undefined
        let calls = 0
        do {
            const r = await src.getSearchResults({ includedTags: inc, excludedTags: exc }, meta)
            titles.push(...r.results.map((m: any) => m.title))
            meta = r.metadata
        } while (meta !== undefined && ++calls < 50)
        assert.equal(new Set(titles).size, titles.length, `doublons : ${titles.filter((x, i) => titles.indexOf(x) !== i).slice(0, 3).join(', ')}`)
        return titles
    }
    const drama = await run([t('drama'), only('syn.test')])
    for (let i = 0; i < 150; i++) assert.ok(drama.includes(`Indexed ${i}`), `manque Indexed ${i}`)
    assert.ok(drama.includes('Drama 1'))
    console.log(`✓ Recherche : les 150 mangas de l'index (et plus seulement les 100 premiers) + ceux du site, sans doublon`)

    // ---------- 5. Synonymes : toutes les pages du tag sur le site ----------
    await src.store.setMergesText('girls love=yuri')
    const yuri = await run([t('yuri'), only('syn.test')])
    assert.deepEqual(yuri.sort(), ['Yuri 1', 'Yuri 2', 'Yuri 3', 'Yuri 4', 'Yuri 5'])
    console.log('✓ Synonymes : « Yuri » et « Girls Love » sont deux pages du site, les deux sont fouillées (5 mangas)')

    // ---------- 6. Panne passagère au milieu : le site n'est pas abandonné ----------
    const action = await run([t('action'), only('flaky.test')])
    assert.equal(action.length, 30, `${action.length} mangas sur 30`)
    console.log('✓ Page en panne (500) au milieu : redemandée au tour suivant, les 30 mangas sont là')

    // ---------- 7. Tags des vignettes retenus (sans ouvrir de fiche) puis utilisés par la recherche ----------
    await src.getViewMoreItems('home_site_' + safeEncode('cards.test'), undefined)
    requests.length = 0
    const both = await run([t('comedy'), t('school'), only('cards.test')])
    assert.deepEqual(both.sort(), ['Card 1', 'Card 3', 'Card 5'])
    // Les vignettes 1, 3, 5 montrent les deux tags : acceptées sans ouvrir leur fiche.
    // Les vignettes 2, 4, 6 ne montrent que « Comedy » : leur fiche est vérifiée (la vignette peut ne pas tout montrer).
    const opened = requests.filter(u => /cards\.test\/manga\//.test(u))
    assert.ok(!opened.some(u => /\/k[135]\/$/.test(u)), `fiches ouvertes inutilement : ${opened.join(', ')}`)
    console.log(`✓ Tags des vignettes : retenus en parcourant le site ; « Comedy + School » accepte les 3 bonnes vignettes sans ouvrir leur fiche (${opened.length} fiche(s) vérifiée(s) pour les autres)`)
}
main().then(() => console.log('\nIndex agrandi et recherche exhaustive : tout est bon')).catch(e => { console.error('ÉCHEC :', e); process.exit(1) })
