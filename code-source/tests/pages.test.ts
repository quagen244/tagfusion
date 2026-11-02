// Stabilité du chargement des pages : npx tsx --tsconfig tests/tsconfig.json tests/pages.test.ts
import assert from 'node:assert/strict'
import { load } from './shim/minicheerio'

const GET: Record<string, string> = {}
/** Réponses forcées : liste de statuts à renvoyer avant la vraie page (ex. [500, 502] puis la page) */
const FLAKY: Record<string, (number | 'throw')[]> = {}
const DOWN = new Set<string>()
const page = (body: string, title = 'Site'): string => `<html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`

// 1. Lecteur classique : la page du chapitre répond 500 puis 502 avant de marcher
GET['https://flaky.test/'] = page('<p>x</p>')
GET['https://flaky.test/manga/a/chapter-1/'] = page(`<div class="reading-content">${[1, 2, 3, 4].map(n => `<img src="https://cdn.flaky-img.test/a/1/${n}.jpg">`).join('')}</div>`)
FLAKY['https://flaky.test/manga/a/chapter-1/'] = [500, 502]

// 2. Galerie : miniatures sans rapport avec les grandes images, mais grandes images numérotées
GET['https://seq.test/'] = page('<p>x</p>')
GET['https://seq.test/g/5000/'] = page(`<h1>G</h1><div class="thumbs">${Array.from({ length: 12 }, (_, i) => `<a href="/g/5000/${i + 1}/"><img src="https://t.seq.test/x/${'abcdefghijkl'[i]}.jpg"></a>`).join('')}</div>`)
for (let n = 1; n <= 12; n++) GET[`https://seq.test/g/5000/${n}/`] = page(`<div id="image-container"><img src="https://img.seq.test/5000/${String(n).padStart(3, '0')}.webp"></div>`)

// 3. Galerie : grandes images aux noms aléatoires, une page de lecture toujours en panne
GET['https://rnd.test/'] = page('<p>x</p>')
const RND = ['qz', 'mk', 'bt', 'pl', 'xw']
GET['https://rnd.test/album/9/'] = page(`<h1>A</h1><div class="thumbs">${RND.map((k, i) => `<a href="/album/9/${i + 1}/"><img src="https://cdn.rnd.test/mini/${k}.jpg"></a>`).join('')}</div>`)
RND.forEach((k, i) => { GET[`https://rnd.test/album/9/${i + 1}/`] = page(`<div class="viewer"><img src="https://img.rnd.test/full/${k}-hd.jpg"></div>`) })
FLAKY['https://rnd.test/album/9/4/'] = [500, 500, 500, 500, 500, 500, 500, 500, 500, 500]

// 4. Liste d'images dans un script, dans le désordre
GET['https://ord.test/'] = page('<p>x</p>')
GET['https://ord.test/manga/b/chapter-2/'] = page('<div id="app"></div><script>var pages = ["https://cdn.ord.test/b/2/03.jpg","https://cdn.ord.test/b/2/01.jpg","https://cdn.ord.test/b/2/04.jpg","https://cdn.ord.test/b/2/02.jpg"];</script>')
// 4 bis. Noms sans numéros consécutifs : on ne touche pas à l'ordre
GET['https://ord.test/manga/b/chapter-3/'] = page('<div id="app"></div><script>var pages = ["https://cdn.ord.test/b/3/z.jpg","https://cdn.ord.test/b/3/a.jpg","https://cdn.ord.test/b/3/m.jpg"];</script>')

// 5. Fiche pour le test "site injoignable"
GET['https://down.test/'] = page('<p>x</p>')
GET['https://down.test/manga/c/'] = page('<h1>Titre C</h1><div class="genres"><span>Romance</span><span>Drama</span></div><ul class="chapters"><li><a href="chapter-1/">Chapter 1</a></li></ul>')
GET['https://down.test/manga/c/chapter-1/'] = page(`<div class="reading-content">${[1, 2, 3].map(n => `<img src="https://down.test/img/c/${n}.jpg">`).join('')}</div>`)

// 6. Erreurs réseau (exception) avant la réussite
GET['https://net.test/'] = page('<p>x</p>')
GET['https://net.test/manga/d/chapter-1/'] = page(`<div class="reading-content">${[1, 2].map(n => `<img src="https://img.net.test/d/${n}.png">`).join('')}</div>`)
FLAKY['https://net.test/manga/d/chapter-1/'] = ['throw', 'throw']

// --- Fausse app Paperback ---
const mem = new Map<string, unknown>()
const requests: string[] = []
const sentHeaders: Record<string, Record<string, string>> = {}
;(globalThis as any).App = {
    createSourceStateManager: () => ({ keychain: {}, store: async (k: string, v: unknown) => { mem.set(k, JSON.parse(JSON.stringify(v))) }, retrieve: async (k: string) => mem.get(k) }),
    createRequestManager: (info: any) => ({
        ...info, getDefaultUserAgent: async () => 'UA-Paperback',
        schedule: async (req: any) => {
            const r = await info.interceptor.interceptRequest(req)
            requests.push(r.url)
            sentHeaders[r.url] = { ...r.headers }
            const host = new URL(r.url).hostname
            if (DOWN.has(host)) throw new Error('connexion impossible')
            const queue = FLAKY[r.url]
            if (queue && queue.length) {
                const next = queue.shift()
                if (next === 'throw') throw new Error('délai dépassé')
                return { status: next, headers: {}, data: 'Erreur', request: r }
            }
            const body = GET[r.url]
            return body !== undefined ? { status: 200, headers: {}, data: body, request: r } : { status: 404, headers: {}, data: '', request: r }
        }
    }),
    createRequest: (i: any) => ({ headers: {}, cookies: [], ...i }),
    createChapter: (i: any) => i, createChapterDetails: (i: any) => i, createTag: (i: any) => i, createTagSection: (i: any) => i,
    createPagedResults: (i: any) => ({ results: [], ...i }), createPartialSourceManga: (i: any) => i,
    createSourceManga: (i: any) => i, createMangaInfo: (i: any) => i
}

async function main(): Promise<void> {
    const { TagFusion } = await import('../src/TagFusion/TagFusion')
    const { encodeMangaId, encodeChapterId } = await import('../src/TagFusion/Utils')
    const { orderPages } = await import('../src/TagFusion/Chapters')
    const src: any = new TagFusion({ load })
    await src.store.setSites(['https://flaky.test', 'https://seq.test', 'https://rnd.test', 'https://ord.test', 'https://down.test', 'https://net.test'])
    const pagesOf = async (site: string, manga: string, chapter: string): Promise<string[]> =>
        (await src.getChapterDetails(encodeMangaId(site, `https://${site}${manga}`), encodeChapterId(`https://${site}${chapter}`))).pages

    // 1. Erreurs serveur passagères
    assert.deepEqual(await pagesOf('flaky.test', '/manga/a/', '/manga/a/chapter-1/'), [1, 2, 3, 4].map(n => `https://cdn.flaky-img.test/a/1/${n}.jpg`))
    console.log('✓ Erreurs passagères du site (500 puis 502) : nouvel essai, les 4 pages sont là')

    // 6. Erreurs réseau
    assert.deepEqual(await pagesOf('net.test', '/manga/d/', '/manga/d/chapter-1/'), [1, 2].map(n => `https://img.net.test/d/${n}.png`))
    console.log('✓ Coupures réseau (2 échecs) : nouvel essai, toutes les pages sont là')

    // 2. Galerie : grandes images numérotées -> 3 pages ouvertes au lieu de 12
    requests.length = 0
    const seq = await pagesOf('seq.test', '/g/5000/', '/g/5000/')
    assert.deepEqual(seq, Array.from({ length: 12 }, (_, i) => `https://img.seq.test/5000/${String(i + 1).padStart(3, '0')}.webp`))
    const opened = requests.filter(u => /\/g\/5000\/\d+\/$/.test(u)).length
    assert.ok(opened <= 3, `pages de lecture ouvertes : ${opened}`)
    console.log(`✓ Galerie de 12 pages : modèle vérifié sur 3 pages réelles, ${opened} pages ouvertes seulement, ordre exact`)

    // 3. Galerie : une page toujours en panne -> sa place est gardée (miniature), rien n'est décalé
    const rnd = await pagesOf('rnd.test', '/album/9/', '/album/9/')
    assert.equal(rnd.length, 5, `nombre de pages : ${rnd.length}`)
    assert.deepEqual(rnd, ['https://img.rnd.test/full/qz-hd.jpg', 'https://img.rnd.test/full/mk-hd.jpg', 'https://img.rnd.test/full/bt-hd.jpg', 'https://cdn.rnd.test/mini/pl.jpg', 'https://img.rnd.test/full/xw-hd.jpg'])
    console.log('✓ Page de galerie en panne : sa place est gardée (miniature), les 5 pages restent dans l\'ordre')

    // 4. Désordre corrigé seulement quand c'est sûr
    assert.deepEqual(await pagesOf('ord.test', '/manga/b/', '/manga/b/chapter-2/'), [1, 2, 3, 4].map(n => `https://cdn.ord.test/b/2/0${n}.jpg`))
    assert.deepEqual(await pagesOf('ord.test', '/manga/b/', '/manga/b/chapter-3/'), ['z', 'a', 'm'].map(k => `https://cdn.ord.test/b/3/${k}.jpg`))
    assert.deepEqual(orderPages(['https://x/1.jpg', 'https://x/3.jpg', 'https://x/7.jpg']), ['https://x/1.jpg', 'https://x/3.jpg', 'https://x/7.jpg'])
    assert.deepEqual(orderPages(['https://x/a/2.jpg', 'https://y/b/1.jpg', 'https://x/a/3.jpg']), ['https://x/a/2.jpg', 'https://y/b/1.jpg', 'https://x/a/3.jpg'])
    console.log('✓ Ordre : pages numérotées dans le désordre remises en ordre ; ordre gardé dès que ce n\'est pas certain')

    // 5. Même chapitre redemandé : même liste, aucune requête
    requests.length = 0
    const again = await pagesOf('rnd.test', '/album/9/', '/album/9/')
    assert.deepEqual(again, rnd)
    assert.equal(requests.length, 0, `requêtes : ${requests.length}`)
    console.log('✓ Chapitre redemandé (préchargement, retour) : exactement la même liste, sans requête')

    // Site injoignable : le chapitre déjà lu s'ouvre quand même, et la fiche aussi
    await pagesOf('down.test', '/manga/c/', '/manga/c/chapter-1/')
    await src.getMangaDetails(encodeMangaId('down.test', 'https://down.test/manga/c/'))
    const cache = mem.get('tf_pages_cache') as Record<string, { p: string[], at: number }>
    for (const k of Object.keys(cache)) (cache[k] as { at: number }).at = 0 // cache périmé : on force une nouvelle lecture
    DOWN.add('down.test')
    const offline = await pagesOf('down.test', '/manga/c/', '/manga/c/chapter-1/')
    assert.deepEqual(offline, [1, 2, 3].map(n => `https://down.test/img/c/${n}.jpg`))
    const fiche = await src.getMangaDetails(encodeMangaId('down.test', 'https://down.test/manga/c/'))
    assert.equal(fiche.mangaInfo.titles[0], 'Titre C')
    assert.deepEqual(fiche.mangaInfo.tags[0].tags.map((t: any) => t.label).sort(), ['Drama', 'Romance'])
    DOWN.delete('down.test')
    console.log('✓ Site injoignable : le chapitre déjà lu et la fiche (titre, tags) s\'ouvrent quand même')

    // Referer des images retrouvé par un AUTRE exemplaire de l'extension (comme dans Paperback)
    const other: any = new TagFusion({ load })
    const imgReq = await other.requestManager.interceptor.interceptRequest({ url: 'https://cdn.flaky-img.test/a/1/2.jpg', method: 'GET', headers: {}, cookies: [] })
    assert.equal(imgReq.headers['referer'], 'https://flaky.test/')
    assert.match(imgReq.headers['accept'], /^image\//)
    assert.equal(imgReq.headers['user-agent'], 'UA-Paperback')
    console.log('✓ Images : site d\'origine retrouvé par un autre exemplaire de l\'extension, en-têtes d\'image envoyés')

    // Serveur d'images jamais vu, mais même domaine qu'un site : Referer du site
    const fresh: any = new TagFusion({ load })
    await fresh.store.getSites()
    const sameDomain = await fresh.requestManager.interceptor.interceptRequest({ url: 'https://img.seq.test/5000/999.webp', method: 'GET', headers: {}, cookies: [] })
    assert.equal(sameDomain.headers['referer'], 'https://seq.test/')
    console.log('✓ Serveur d\'images jamais vu, même domaine qu\'un site : bon site d\'origine annoncé')

    // Les réinitialisations vident aussi le cache des pages
    await src.resetExtension(false)
    assert.deepEqual(mem.get('tf_pages_cache'), {})
    console.log('✓ « Effacer l\'index et les tags » vide aussi le cache des pages')
}
main().then(() => console.log('\nStabilité des pages : tout est bon')).catch(e => { console.error('ÉCHEC :', e); process.exit(1) })
