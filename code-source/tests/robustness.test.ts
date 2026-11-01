// Robustesse, réinitialisation et défilement infini : npx tsx --tsconfig tests/tsconfig.json tests/robustness.test.ts
import assert from 'node:assert/strict'
import { load } from './shim/minicheerio'

const GET: Record<string, string> = {}
const page = (body: string): string => `<html lang="en"><head></head><body>${body}</body></html>`
const card = (site: string, slug: string, title: string): string =>
    `<div class="item"><a href="https://${site}/manga/${slug}/"><img src="https://${site}/c/${slug}.jpg" alt="${title}"></a><h3>${title}</h3></div>`
const details = (title: string, tags: string[], chapters = 2): string => page(`<h1>${title}</h1>
<div class="genres">${tags.map(t => `<span>${t}</span>`).join('')}</div>
<ul class="chapters">${Array.from({ length: chapters }, (_, i) => `<li><a href="chapter-${chapters - i}/">Chapter ${chapters - i}</a></li>`).join('')}</ul>`)

// --- Site A : a une page pour le tag "romance" (2 pages de liste, puis fin) ---
GET['https://alpha.test/'] = page('<a href="https://alpha.test/genre/romance/">Romance</a>' + card('alpha.test', 'a0', 'Alpha Zero') + card('alpha.test', 'x1', 'Xa') + card('alpha.test', 'x2', 'Xb') + card('alpha.test', 'x3', 'Xc'))
GET['https://alpha.test/genre/romance/'] = page(card('alpha.test', 'a1', 'Alpha One') + card('alpha.test', 'a2', 'Alpha Two'))
GET['https://alpha.test/genre/romance/page/2/'] = page(card('alpha.test', 'a3', 'Alpha Three') + card('alpha.test', 'a4', 'Alpha Four'))
GET['https://alpha.test/genre/romance/page/3/'] = page('<p>Rien</p>')

// --- Site B : aucune page de tag, seulement un catalogue paginé ; les tags sont sur les fiches ---
GET['https://beta.test/'] = page('<p>Accueil</p>')
GET['https://beta.test/manga/'] = page(card('beta.test', 'b1', 'Beta One') + card('beta.test', 'b2', 'Beta Two') + card('beta.test', 'b3', 'Beta Three') + card('beta.test', 'b4', 'Beta Four'))
GET['https://beta.test/manga/page/2/'] = page(card('beta.test', 'b5', 'Beta Five') + card('beta.test', 'b6', 'Beta Six') + card('beta.test', 'b7', 'Beta Seven') + card('beta.test', 'b8', 'Beta Eight'))
GET['https://beta.test/manga/page/3/'] = page('<p>Fin du catalogue</p>')
const betaTags: Record<string, string[]> = {
    b1: ['Romance', 'Drama'], b2: ['Action'], b3: ['Romance (12)'], b4: ['Horror'],
    b5: ['Comedy'], b6: ['Romantic', 'Comedy'], b7: ['Action'], b8: ['Romance']
}
for (const [slug, tags] of Object.entries(betaTags)) GET[`https://beta.test/manga/${slug}/`] = details(`Beta ${slug}`, tags)

// --- 6 sites de plus sans page de tag (catalogue seulement) ---
const CRAWL_SITES = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']
for (const c of CRAWL_SITES) {
    GET[`https://${c}.test/`] = page('<p>x</p>')
    GET[`https://${c}.test/manga/`] = page([1, 2, 3, 4].map(n => card(`${c}.test`, `${c}m${n}`, `${c.toUpperCase()} Manga ${n}`)).join(''))
    for (const n of [1, 2, 3, 4]) GET[`https://${c}.test/manga/${c}m${n}/`] = details(`${c} ${n}`, n === 2 ? ['Romance'] : ['Action'])
}

// --- Grand site : 60 mangas pour le tag, 6 pages de liste de 10 ---
GET['https://big.test/'] = page('<a href="https://big.test/genre/romance/">Romance</a>' + card('big.test', 'z1', 'Z1') + card('big.test', 'z2', 'Z2') + card('big.test', 'z3', 'Z3') + card('big.test', 'z4', 'Z4'))
for (let p = 1; p <= 7; p++) {
    const url = p === 1 ? 'https://big.test/genre/romance/' : `https://big.test/genre/romance/page/${p}/`
    GET[url] = p <= 6 ? page(Array.from({ length: 10 }, (_, i) => card('big.test', `big${(p - 1) * 10 + i + 1}`, `Big ${(p - 1) * 10 + i + 1}`)).join('')) : page('<p>Fin</p>')
}

// --- Fiches pour les tests de chapitres ---
GET['https://legacy.test/'] = page('<p>x</p>')
GET['https://legacy.test/manga/old_one/'] = details('Old One', ['Action'], 3)
GET['https://badpct.test/'] = page('<p>x</p>')
GET['https://badpct.test/manga/caf/'] = page('<h1>Café</h1><ul class="chapters"><li><a href="/manga/caf/chapter-2-%E9t%E9/">Chapter 2</a></li><li><a href="/manga/caf/chapter-1-100%/">Chapter 1</a></li></ul>')

// --- Fausse app Paperback ---
const mem = new Map<string, unknown>()
const requests: string[] = []
let indexWrites = 0
;(globalThis as any).App = {
    createSourceStateManager: () => ({ keychain: {}, store: async (k: string, v: unknown) => { if (k === 'tf_manga_index') indexWrites++; mem.set(k, JSON.parse(JSON.stringify(v))) }, retrieve: async (k: string) => mem.get(k) }),
    createRequestManager: (info: any) => ({
        ...info,
        getDefaultUserAgent: async () => 'UA',
        schedule: async (req: any) => {
            requests.push(req.url)
            const r = await info.interceptor.interceptRequest(req)
            const body = GET[r.url]
            return body !== undefined ? { status: 200, headers: {}, data: body, request: r } : { status: 404, headers: {}, data: '', request: r }
        }
    }),
    createRequest: (i: any) => ({ headers: {}, cookies: [], ...i }),
    createChapter: (i: any) => i, createChapterDetails: (i: any) => i, createTag: (i: any) => i, createTagSection: (i: any) => i,
    createPagedResults: (i: any) => ({ results: [], ...i }), createPartialSourceManga: (i: any) => i,
    createSourceManga: (i: any) => i, createMangaInfo: (i: any) => i, createHomeSection: (i: any) => i,
    createDUISection: (i: any) => i, createDUINavigationButton: (i: any) => i, createDUIForm: (i: any) => i,
    createDUIInputField: (i: any) => i, createDUIBinding: (i: any) => i, createDUIButton: (i: any) => i,
    createDUIMultilineLabel: (i: any) => i
}

async function main(): Promise<void> {
    const { TagFusion } = await import('../src/TagFusion/TagFusion')
    const { decodeMangaId, decodeChapterId, encodeMangaId, tagIdOf } = await import('../src/TagFusion/Utils')
    const src: any = new TagFusion({ load })
    await src.store.setSites(['https://alpha.test', 'https://beta.test', 'https://legacy.test', 'https://badpct.test'])

    // --- Anciens identifiants des premières versions ---
    assert.deepEqual(decodeMangaId('legacy.test::/manga/old_one/'), { siteId: 'legacy.test', path: '/manga/old_one/' })
    assert.equal(decodeChapterId('/manga/old_one/chapter-1/'), '/manga/old_one/chapter-1/')
    const legacyChapters = await src.getChapters('legacy.test::/manga/old_one/')
    assert.deepEqual(legacyChapters.map((c: any) => c.chapNum), [3, 2, 1])
    console.log('✓ Mangas enregistrés par les anciennes versions : chapitres affichés (3)')

    // --- Identifiant illisible : liste vide, pas d'erreur ---
    assert.deepEqual(await src.getChapters('n_importe quoi %%'), [])
    console.log('✓ Identifiant illisible : liste vide, aucune erreur')

    // --- Adresses avec "%" mal formé ---
    const bad = await src.getChapters(encodeMangaId('badpct.test', 'https://badpct.test/manga/caf/'))
    assert.deepEqual(bad.map((c: any) => c.chapNum), [2, 1])
    console.log('✓ Adresses de chapitres mal encodées (%E9, 100%) : aucune erreur, 2 chapitres')

    // --- Site injoignable : liste vide, journal renseigné ---
    assert.deepEqual(await src.getChapters(encodeMangaId('absent.test', 'https://absent.test/manga/x/')), [])
    assert.match((mem.get('tf_debug') as string[]).join('\n'), /chapitres absent\.test .*erreur/)
    console.log('✓ Site injoignable : liste vide, erreur notée dans le journal')

    // --- Le moteur du site plante : la lecture universelle prend le relais ---
    const engines = await import('../src/TagFusion/Engines')
    const original = engines.GenericEngine.getChapters
    ;(engines.GenericEngine as any).getChapters = async () => { throw new Error('panne simulée') }
    const rescued = await src.getChapters(encodeMangaId('legacy.test', 'https://legacy.test/manga/old_one/'))
    ;(engines.GenericEngine as any).getChapters = original
    assert.equal(rescued.length, 3)
    console.log('✓ Moteur du site en panne : la lecture universelle prend le relais (3 chapitres)')

    // --- Diagnostic depuis les réglages ---
    await src.diagnoseManga('legacy.test/manga/old_one/')
    const diag = (mem.get('tf_debug') as string[]).join('\n')
    assert.match(diag, /diagnostic : https:\/\/legacy\.test\/manga\/old_one\//)
    assert.match(diag, /liens de la fiche : 3/)
    assert.match(diag, /diagnostic : 3 chapitre\(s\) — 3 Chapter 3/)
    console.log('✓ Diagnostic : méthode utilisée, nombre et premiers chapitres écrits dans le journal')

    // --- Défilement infini : tous les mangas "Romance" des deux sites, page après page ---
    const tag = { id: tagIdOf('romance'), label: 'Romance' }
    await src.discoverAll(true)
    requests.length = 0
    const seenTitles: string[] = []
    const firstIds: string[] = []
    let metadata: unknown = undefined
    let pages = 0
    do {
        const r = await src.getSearchResults({ includedTags: [tag], excludedTags: [] }, metadata)
        assert.ok(r.results.length > 0 || r.metadata === undefined, 'jamais de page vide tant que la liste continue')
        seenTitles.push(...r.results.map((m: any) => m.title))
        firstIds.push(...r.results.map((m: any) => m.mangaId))
        metadata = r.metadata
        pages++
    } while (metadata !== undefined && pages < 20)
    const expected = ['Alpha One', 'Alpha Two', 'Alpha Three', 'Alpha Four', 'Beta One', 'Beta Three', 'Beta Six', 'Beta Eight']
    assert.deepEqual([...seenTitles].sort(), [...expected].sort())
    assert.equal(new Set(seenTitles).size, seenTitles.length, 'aucun doublon')
    console.log(`✓ Défilement infini : ${seenTitles.length} mangas Romance sur ${pages} pages (page du tag + catalogue complet), sans doublon`)
    console.log('   (Romance (12) et Romantic du catalogue reconnus comme Romance)')

    // --- Deuxième recherche : tout est indexé, plus besoin de relire les fiches ---
    const firstRunRequests = requests.length
    requests.length = 0
    metadata = undefined
    const again: string[] = []
    pages = 0
    do {
        const r = await src.getSearchResults({ includedTags: [tag], excludedTags: [] }, metadata)
        again.push(...r.results.map((m: any) => m.mangaId))
        metadata = r.metadata
        pages++
    } while (metadata !== undefined && pages < 20)
    assert.deepEqual([...again].sort(), [...firstIds].sort(), 'exactement les mêmes mangas')
    assert.equal(new Set(again).size, again.length, 'aucun doublon')
    assert.ok(!requests.some(u => /beta\.test\/manga\/b\d\/$/.test(u)), 'aucune fiche relue')
    assert.ok(requests.length < firstRunRequests, `moins de requêtes (${requests.length} contre ${firstRunRequests})`)
    console.log(`✓ Deuxième recherche : même résultat, ${requests.length} requêtes au lieu de ${firstRunRequests} (fiches déjà indexées)`)

    // --- Aucune tâche ne continue après la réponse à l'app (cause de « JSManagedValue was released ») ---
    const quiet = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
        await fn()
        const after = requests.length
        await new Promise(r => setTimeout(r, 300))
        assert.equal(requests.length, after, `${label} : des requêtes partent encore après la réponse`)
    }
    await src.store.updateSite('beta.test', { discoveredAt: undefined })
    await quiet('écran de recherche', () => src.getSearchTags())
    await quiet('recherche', () => src.getSearchResults({ includedTags: [tag], excludedTags: [] }, undefined))
    await quiet('fiche', () => src.getMangaDetails(encodeMangaId('beta.test', 'https://beta.test/manga/b1/')))
    await quiet('chapitres', () => src.getChapters(encodeMangaId('beta.test', 'https://beta.test/manga/b1/')))
    await quiet('page d\'accueil', () => src.getHomePageSections(() => undefined))
    await quiet('bouton Charger les tags', async () => { const menu = await src.getSourceMenu(); const rows = await menu.rows(); await rows.find((r: any) => r.id === 'discover').onTap() })
    console.log('✓ Aucune requête après la réponse à l\'app (recherche, fiche, chapitres, accueil, réglages)')

    // --- Beaucoup de sites sans page de tag : la première page reste rapide et légère ---
    await src.resetExtension(false)
    await src.store.setSites(['https://alpha.test', ...CRAWL_SITES.map(c => `https://${c}.test`)])
    await src.discoverAll(true)
    requests.length = 0
    indexWrites = 0
    let r = await src.getSearchResults({ includedTags: [tag], excludedTags: [] }, undefined)
    assert.ok(r.results.length > 0, 'la première page affiche des mangas')
    assert.ok(requests.length <= 60, `première page trop lourde : ${requests.length} requêtes`)
    assert.equal(r.results.length, 10, 'moins de 24 mangas en tout : la première page les montre tous')
    assert.ok(indexWrites <= 8, `trop d'écritures de l'index : ${indexWrites} (une par lot de 10 fiches attendue)`)
    console.log(`✓ 7 sites dont 6 sans page de tag : 1re page pleine (${r.results.length} mangas) en ${requests.length} requêtes, ${indexWrites} écriture(s) de l'index`)
    const all: string[] = r.results.map((m: any) => m.title)
    let meta2 = r.metadata
    let guard = 0
    while (meta2 !== undefined && guard++ < 30) {
        r = await src.getSearchResults({ includedTags: [tag], excludedTags: [] }, meta2)
        assert.ok(r.results.length > 0 || r.metadata === undefined, 'jamais de page vide tant que la liste continue')
        all.push(...r.results.map((m: any) => m.title))
        meta2 = r.metadata
    }
    const wanted = ['Alpha One', 'Alpha Two', 'Alpha Three', 'Alpha Four', ...CRAWL_SITES.map(c => `${c.toUpperCase()} Manga 2`)]
    assert.deepEqual([...all].sort(), [...wanted].sort())
    console.log(`✓ En faisant défiler : les ${wanted.length} mangas Romance des 7 sites, sans doublon`)

    // --- Défilement infini sur un grand site : des fournées pleines jusqu'à la fin ---
    await src.store.setSites(['https://big.test'])
    await src.discoverAll(true)
    const batches: number[] = []
    const bigIds = new Set<string>()
    let bm: unknown = undefined
    let bguard = 0
    do {
        const br = await src.getSearchResults({ includedTags: [tag], excludedTags: [] }, bm)
        batches.push(br.results.length)
        for (const m of br.results) bigIds.add(m.mangaId)
        bm = br.metadata
    } while (bm !== undefined && bguard++ < 20)
    assert.equal(bigIds.size, 60, `les 60 mangas doivent sortir (obtenu ${bigIds.size})`)
    assert.ok((batches[0] ?? 0) >= 24 && (batches[1] ?? 0) >= 24, `fournées trop petites : ${batches.join(', ')}`)
    assert.equal(batches.slice(0, -1).filter(n => n === 0).length, 0, 'aucune page vide avant la fin')
    console.log(`✓ Grand site (60 mangas pour le tag) : fournées de ${batches.join(' + ')} en faisant défiler, tous affichés`)

    // --- Réinitialisation partielle : index et tags effacés, sites gardés ---
    assert.ok(await src.store.indexSize() > 0)
    await src.resetExtension(false)
    assert.equal(await src.store.indexSize(), 0)
    assert.equal(Object.keys(await src.store.unified()).length, 0)
    assert.equal((await src.store.getSites()).length, 1)
    console.log('✓ « Effacer l\'index et les tags » : index vide, tags vides, sites conservés')

    // --- Réinitialisation complète ---
    await src.store.setRepos(['https://x.github.io/r/versioning.json'])
    await src.resetExtension(true)
    assert.equal((await src.store.getSites()).length, 0)
    assert.equal((await src.store.getRepos()).length, 0)
    const fresh: any = new TagFusion({ load })
    assert.equal((await fresh.store.getSites()).length, 0)
    assert.equal(await fresh.store.indexSize(), 0)
    console.log('✓ « Tout réinitialiser » : sites, dépôts, index et tags effacés (même après redémarrage)')
}
main().then(() => console.log('\nRobustesse, réinitialisation et défilement : tout est bon')).catch(e => { console.error('ÉCHEC :', e); process.exit(1) })
