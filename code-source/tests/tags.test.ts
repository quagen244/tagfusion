// Indexation des tags à l'ouverture d'une fiche : npx tsx --tsconfig tests/tsconfig.json tests/tags.test.ts
import assert from 'node:assert/strict'
import { load } from './shim/minicheerio'

// --- Pages de test réalistes -------------------------------------------------------

// Site Madara : genres (liens), tags (liens), étiquettes sans lien, et un menu de genres à ignorer
const MADARA_HOME = `<html><head><meta property="og:site_name" content="Scans Madara"></head><body class="wp-manga">
<header><nav class="main-menu"><a href="https://madara.test/manga-genre/action/">Action</a><a href="https://madara.test/manga-genre/horror/">Horror</a></nav></header>
<div class="page-item-detail"><div class="post-title"><h3><a href="https://madara.test/manga/solo-quest/">Solo Quest</a></h3></div><img data-src="https://madara.test/c/solo.jpg"></div>
</body></html>`

const MADARA_DETAILS = `<html><head><meta property="og:image" content="https://madara.test/c/solo.jpg"></head><body class="wp-manga">
<header><nav class="main-menu"><a href="https://madara.test/manga-genre/horror/">Horror</a></nav></header>
<div class="post-title"><h1><span class="manga-title-badges hot">HOT</span> Solo Quest</h1></div>
<div class="summary_image"><img data-src="https://madara.test/c/solo.jpg"></div>
<div class="summary_content">
  <div class="post-content_item"><div class="summary-heading"><h5>Status</h5></div><div class="summary-content">OnGoing</div></div>
  <div class="post-content_item"><div class="summary-heading"><h5>Genre(s)</h5></div><div class="summary-content"><div class="genres-content"><a href="https://madara.test/manga-genre/action/" rel="tag">Action</a>, <a href="https://madara.test/manga-genre/romance/" rel="tag">Romance</a></div></div></div>
  <div class="post-content_item"><div class="summary-heading"><h5>Tag(s)</h5></div><div class="summary-content"><div class="tags-content"><a href="https://madara.test/manga-tag/reincarnation/" rel="tag">Reincarnation</a></div></div></div>
</div>
<div class="manga-tags"><span>Revenge</span><span>Strong Female Lead</span><span>Sci-Fi</span></div>
<div class="summary__content"><p>Un héros solitaire.</p></div>
<aside class="sidebar"><div class="widget"><a href="https://madara.test/manga-genre/yaoi/">Yaoi</a></div></aside>
<ul class="main version-chap"><li class="wp-manga-chapter"><a href="https://madara.test/manga/solo-quest/chapter-2/">Chapter 2</a></li><li class="wp-manga-chapter"><a href="https://madara.test/manga/solo-quest/chapter-1/">Chapter 1</a></li></ul>
</body></html>`

// Site inconnu (mode universel) : tags en liste sans liens, et genres en texte brut
const GENERIC_HOME = `<html><head><title>Lecture Libre - accueil</title></head><body>
<div class="grid"><div class="card"><a href="https://libre.test/series/office-love/"><img src="/img/office.jpg" alt="Office Love"></a><h3>Office Love</h3></div></div>
</body></html>`

const GENERIC_DETAILS = `<html><head><meta property="og:image" content="https://libre.test/img/office.jpg"></head><body>
<nav><ul><li><a href="https://libre.test/genre/action/">Action</a></li></ul></nav>
<main><h1>Office Love</h1>
<div class="info"><div class="genres">Genres: Romance, Comédie, Josei</div>
<ul class="tag-list"><li>Office Workers</li><li>Slow Burn</li><li>Revenge</li></ul></div>
<div class="description">Une romance au bureau.</div>
<a href="https://libre.test/series/office-love/chapter-1/">Chapter 1</a></main>
</body></html>`

// Site qui colle le nombre d'œuvres aux tags
const COUNT_HOME = `<html><body><div class="wp-manga"></div>
<div class="page-item-detail"><div class="post-title"><h3><a href="https://compte.test/manga/love-code/">Love Code</a></h3></div><img src="https://compte.test/c/l.jpg"></div></body></html>`
const COUNT_DETAILS = `<html><body class="wp-manga"><div class="post-title"><h1>Love Code</h1></div>
<div class="genres-content"><a href="https://compte.test/manga-genre/romance/">Romance <span class="count">(1 234)</span></a><a href="https://compte.test/manga-genre/action/">Action 56</a></div>
<ul class="tag-list"><li>Revenge [12]</li><li>Office Workers · 3</li></ul></body></html>`

const PAGES: Record<string, string> = {
    'https://madara.test/': MADARA_HOME,
    'https://madara.test/manga/solo-quest/': MADARA_DETAILS,
    'https://libre.test/': GENERIC_HOME,
    'https://libre.test/series/office-love/': GENERIC_DETAILS,
    'https://compte.test/': COUNT_HOME,
    'https://compte.test/manga/love-code/': COUNT_DETAILS
}

// --- Fausse app Paperback ------------------------------------------------------------

const mem = new Map<string, unknown>()
const makeState = () => ({
    keychain: {},
    store: async (k: string, v: unknown) => { mem.set(k, JSON.parse(JSON.stringify(v))) },
    retrieve: async (k: string) => mem.get(k)
})
;(globalThis as any).App = {
    createSourceStateManager: makeState,
    createRequestManager: (info: any) => ({
        ...info,
        getDefaultUserAgent: async () => 'UA-test',
        schedule: async (req: any) => {
            const r = await info.interceptor.interceptRequest(req)
            const page = PAGES[r.url]
            return page ? { status: 200, headers: {}, data: page, request: r } : { status: 404, headers: {}, data: '', request: r }
        }
    }),
    createRequest: (i: any) => ({ headers: {}, cookies: [], ...i }),
    createTag: (i: any) => i, createTagSection: (i: any) => i, createPagedResults: (i: any) => ({ results: [], ...i }),
    createPartialSourceManga: (i: any) => i, createHomeSection: (i: any) => i,
    createSourceManga: (i: any) => i, createMangaInfo: (i: any) => i, createChapter: (i: any) => i,
    createChapterDetails: (i: any) => i
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function main(): Promise<void> {
    const { TagFusion } = await import('../src/TagFusion/TagFusion')
    const { encodeMangaId, tagIdOf } = await import('../src/TagFusion/Utils')

    // Deux exemplaires de l'extension, comme Paperback peut en créer (recherche + fiche)
    const searchSide: any = new TagFusion({ load })
    const detailsSide: any = new TagFusion({ load })
    await searchSide.store.setSites(['https://madara.test', 'https://libre.test'])

    // L'écran de recherche charge les tags une première fois (et les garde en mémoire)
    const before = await searchSide.getSearchTags()
    const beforeIds = before.flatMap((s: any) => s.tags.map((t: any) => t.id))
    assert.ok(!beforeIds.includes(tagIdOf('revenge')))
    console.log(`✓ Avant ouverture : ${beforeIds.length} tags, pas encore « Revenge »`)

    // --- On ouvre la fiche Madara dans l'autre exemplaire ---
    const madaraId = encodeMangaId('madara.test', 'https://madara.test/manga/solo-quest/')
    const manga = await detailsSide.getMangaDetails(madaraId)
    const shown = manga.mangaInfo.tags[0].tags.map((t: any) => t.label)
    assert.equal(manga.mangaInfo.titles[0], 'Solo Quest')
    for (const l of ['Action', 'Romance', 'Reincarnation', 'Revenge', 'Strong Female Lead', 'Sci-Fi']) assert.ok(shown.includes(l), `tag manquant : ${l}`)
    assert.ok(!shown.includes('Horror'), 'le menu de navigation ne doit pas compter')
    assert.ok(!shown.includes('Yaoi'), 'la barre latérale ne doit pas compter')
    console.log(`✓ Fiche Madara : ${shown.length} tags lus (liens ET étiquettes), menu et barre latérale ignorés`)
    assert.match((mem.get('tf_debug') as string[]).join('\n'), /fiche « Solo Quest » : \d+ tag\(s\) lu\(s\)/)
    console.log('✓ Le journal de diagnostic note la fiche indexée')

    // --- Fiche d'un site inconnu ---
    const libreId = encodeMangaId('libre.test', 'https://libre.test/series/office-love/')
    const libre = await detailsSide.getMangaDetails(libreId)
    const libreTags = libre.mangaInfo.tags[0].tags.map((t: any) => t.label)
    for (const l of ['Romance', 'Comédie', 'Josei', 'Office Workers', 'Slow Burn', 'Revenge']) assert.ok(libreTags.includes(l), `tag manquant : ${l}`)
    assert.ok(!libreTags.includes('Action'), 'le menu ne doit pas compter')
    console.log(`✓ Fiche en mode universel : ${libreTags.length} tags lus (liste sans liens + texte brut)`)

    // --- L'autre exemplaire voit les nouveaux tags (après un court instant) ---
    await sleep(1600)
    const after = await searchSide.getSearchTags()
    const afterTags = after.flatMap((s: any) => s.tags)
    const ids = afterTags.map((t: any) => t.id)
    for (const k of ['revenge', 'strong female lead', 'reincarnation', 'office workers', 'slow burn', 'comedy', 'sci fi']) {
        assert.ok(ids.includes(tagIdOf(k)), `tag non indexé : ${k}`)
    }
    console.log(`✓ Après ouverture : ${ids.length} tags dans la recherche, nouveaux tags bien indexés`)

    // --- Rien n'a été écrasé : les tags de recherche du site et l'index survivent ---
    await searchSide.store.updateSite('madara.test', { error: 'test' })
    const fresh: any = new TagFusion({ load })
    const unified = await fresh.store.unified()
    assert.ok(unified['reincarnation']?.sites['madara.test']?.url.includes('/manga-tag/reincarnation/'))
    assert.equal(unified['revenge']?.indexed, 2)
    assert.equal(await fresh.store.indexSize(), 2)
    console.log('✓ Aucune perte entre exemplaires, tout survit au redémarrage')

    // --- Recherche par un tag qui n'est un lien sur aucun site : trouvé grâce à l'index ---
    const r1 = await fresh.getSearchResults({ includedTags: [{ id: tagIdOf('revenge'), label: 'Revenge' }], excludedTags: [] }, undefined)
    const titles1 = r1.results.map((m: any) => m.title).sort()
    assert.deepEqual(titles1, ['Office Love', 'Solo Quest'])
    console.log('✓ Recherche « Revenge » : les 2 mangas trouvés grâce à l\'index')

    // --- Plusieurs tags + exclusion ---
    const r2 = await fresh.getSearchResults({
        includedTags: [{ id: tagIdOf('revenge'), label: 'Revenge' }, { id: tagIdOf('romance'), label: 'Romance' }],
        excludedTags: [{ id: tagIdOf('josei'), label: 'Josei' }]
    }, undefined)
    assert.deepEqual(r2.results.map((m: any) => m.title).filter((t: string) => t === 'Office Love' || t === 'Solo Quest'), ['Solo Quest'])
    console.log('✓ Revenge + Romance sans Josei : seulement « Solo Quest »')

    // --- Synonymes : « Comédie » sur un site = « Comedy » ---
    const r3 = await fresh.getSearchResults({ includedTags: [{ id: tagIdOf('comedy'), label: 'Comedy' }], excludedTags: [] }, undefined)
    assert.ok(r3.results.some((m: any) => m.title === 'Office Love'))
    console.log('✓ « Comédie » retrouvé en cherchant « Comedy »')

    // --- Aucun identifiant en double dans les résultats ---
    const allIds = [...r1.results, ...r2.results, ...r3.results].map((m: any) => m.mangaId)
    assert.equal(new Set(r1.results.map((m: any) => m.mangaId)).size, r1.results.length)
    assert.ok(allIds.every((id: string) => /^[A-Za-z0-9._-]+$/.test(id)))
    console.log('✓ Identifiants uniques et sans caractères spéciaux')

    // --- Site qui affiche le nombre d'œuvres dans ses tags ---
    await fresh.store.setSites(['https://madara.test', 'https://libre.test', 'https://compte.test'])
    const countId = encodeMangaId('compte.test', 'https://compte.test/manga/love-code/')
    const lc = await fresh.getMangaDetails(countId)
    const lcTags = lc.mangaInfo.tags[0].tags
    assert.deepEqual(lcTags.map((t: any) => t.label).sort(), ['Action', 'Office Workers', 'Revenge', 'Romance'])
    assert.ok(lcTags.every((t: any) => !/\d/.test(t.id) && !/\d/.test(t.label)), 'aucun chiffre dans les tags')
    console.log('✓ Fiche avec nombres d\'œuvres : tags propres (Romance, Action, Revenge, Office Workers)')

    await sleep(1600)
    const tagScreen = (await fresh.getSearchTags()).flatMap((s: any) => s.tags)
    assert.ok(!tagScreen.some((t: any) => t.id.startsWith('tag_') && /\d/.test(t.label)), 'aucun chiffre dans la liste des tags')
    const u2 = await fresh.store.unified()
    assert.deepEqual(Object.keys(u2.romance.sites).sort(), ['compte.test', 'madara.test'])
    console.log('✓ Liste des tags sans aucun chiffre, « Romance » réunit les deux sites')

    // Cliquer sur « Revenge » : les 3 mangas de 3 sites, pas seulement la source qui affiche des nombres
    const r4 = await fresh.getSearchResults({ includedTags: [{ id: tagIdOf('revenge'), label: 'Revenge' }], excludedTags: [] }, undefined)
    assert.deepEqual(r4.results.map((m: any) => m.title).sort(), ['Love Code', 'Office Love', 'Solo Quest'])
    // Un ancien tag avec nombre, encore en mémoire dans l'app, mène au même résultat
    const r5 = await fresh.getSearchResults({ includedTags: [{ id: tagIdOf('revenge 12'), label: 'Revenge [12]' }], excludedTags: [] }, undefined)
    assert.deepEqual(r5.results.map((m: any) => m.title).sort(), ['Love Code', 'Office Love', 'Solo Quest'])
    console.log('✓ Clic sur un tag : toutes les sources, même depuis un ancien tag avec nombre')

    // --- Chapitres de la fiche Madara ---
    const chapters = await fresh.getChapters(madaraId)
    assert.deepEqual(chapters.map((c: any) => c.chapNum), [2, 1])
    console.log('✓ Chapitres lus (du plus récent au plus ancien)')

}
main().then(() => console.log('\nIndexation des tags : tout est bon')).catch(e => { console.error('ÉCHEC :', e); process.exit(1) })
