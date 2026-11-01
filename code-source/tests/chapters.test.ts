// Lecture universelle des chapitres et des pages : npx tsx --tsconfig tests/tsconfig.json tests/chapters.test.ts
import assert from 'node:assert/strict'
import { load } from './shim/minicheerio'

const GET: Record<string, string> = {}
const POST: Record<string, string> = {}
const page = (body: string, head = ''): string => `<html><head>${head}</head><body>${body}</body></html>`
const generic = '<div class="site">Lecture</div>'

// 1. Madara récent : les chapitres arrivent par une requête à part
GET['https://madara-ajax.test/'] = page('<div class="wp-manga"></div>')
GET['https://madara-ajax.test/manga/hero/'] = page('<div class="wp-manga"><div class="post-title"><h1>Hero</h1></div><div id="manga-chapters-holder" data-id="77"></div></div>')
POST['https://madara-ajax.test/manga/hero/ajax/chapters/'] = '<ul><li class="wp-manga-chapter"><a href="https://madara-ajax.test/manga/hero/chapter-3/">Chapter 3</a><span class="chapter-release-date"><i>2 days ago</i></span></li><li class="wp-manga-chapter"><a href="https://madara-ajax.test/manga/hero/chapter-2/">Chapter 2</a></li><li class="wp-manga-chapter"><a href="https://madara-ajax.test/manga/hero/chapter-1/">Chapter 1</a></li></ul>'

// 2. Thème MangaReader
GET['https://themesia.test/'] = page('<script>var ts_reader = {}</script>')
GET['https://themesia.test/manga/blade/'] = page('<h1 class="entry-title">Blade</h1><div id="chapterlist"><ul><li data-num="2"><a href="https://themesia.test/blade-chapter-2/"><span class="chapternum">Chapter 2</span><span class="chapterdate">October 3, 2024</span></a></li><li data-num="1"><a href="https://themesia.test/blade-chapter-1/"><span class="chapternum">Chapter 1</span></a></li></ul></div>')

// 3. Site inconnu : chapitres "/love-code-chapter-N/" + barre "dernières sorties" d'autres mangas (plus nombreuse)
GET['https://slug.test/'] = page(generic)
GET['https://slug.test/series/love-code/'] = page(`<h1>Love Code</h1>
<div class="chapter-list"><a href="/love-code-chapter-3/">Chapter 3 - The End 2 days ago NEW</a><a href="/love-code-chapter-2/">Chapter 2</a><a href="/love-code-chapter-1/">Chapter 1</a></div>
<aside><div class="latest-list"><a href="/other-chapter-99/">Chapter 99</a><a href="/other-chapter-98/">Chapter 98</a><a href="/zeta-chapter-5/">Chapter 5</a><a href="/beta-chapter-7/">Chapter 7</a><a href="/gamma-chapter-1/">Chapter 1</a></div></aside>`)

// 4. Adresses sans le mot "chapter", reconnues par le texte "Ch. N"
GET['https://readid.test/'] = page(generic)
GET['https://readid.test/manga/quiet/'] = page('<h1>Quiet</h1><ul class="episodes"><li><a href="/read/8f3a2/">Ch. 2</a> <small>03/10/2024</small></li><li><a href="/read/1c9d0/">Ch. 1</a></li></ul>')

// 5. Page "tous les chapitres" séparée et paginée
GET['https://separate.test/'] = page(generic)
GET['https://separate.test/title/abc/'] = page('<h1>Abc</h1><a href="/title/abc/chapters">Voir tous les chapitres</a>')
GET['https://separate.test/title/abc/chapters'] = page('<ul class="list"><li><a href="/title/abc/chapter-4">Chapitre 4</a></li><li><a href="/title/abc/chapter-3">Chapitre 3</a></li></ul><div class="pagination"><a href="/title/abc/chapters?page=2">2</a></div>')
GET['https://separate.test/title/abc/chapters?page=2'] = page('<ul class="list"><li><a href="/title/abc/chapter-2">Chapitre 2</a></li><li><a href="/title/abc/chapter-1">Chapitre 1</a></li></ul>')

// 6. Fiche avec un simple bouton "Lire" : la liste est dans le menu déroulant du lecteur
GET['https://select.test/'] = page(generic)
GET['https://select.test/comic/xyz/'] = page('<h1>Xyz</h1><a class="btn" href="/comic/xyz/1">Lire maintenant</a>')
GET['https://select.test/comic/xyz/1'] = page('<select id="chap"><option value="/comic/xyz/4">Chapitre 4</option><option value="/comic/xyz/3">Chapitre 3</option><option value="/comic/xyz/2">Chapitre 2</option><option value="/comic/xyz/1" selected>Chapitre 1</option></select><div class="reader"><img src="/p/1.jpg"><img src="/p/2.jpg"></div>')

// 7. Site moderne : chapitres uniquement dans __NEXT_DATA__
GET['https://next.test/'] = page(generic)
GET['https://next.test/manga/nova/'] = page('<div id="__next"></div>', `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { manga: { title: 'Nova', chapters: [
    { title: 'Chapter 3', url: '/manga/nova/chapter-3', created_at: '2024-03-01' },
    { title: 'Chapter 2', url: '/manga/nova/chapter-2', created_at: '2024-02-01' },
    { title: 'Chapter 1', url: '/manga/nova/chapter-1', created_at: '2024-01-01' }] } } } })}</script>`)

// 8. Volumes et titres de chapitres
GET['https://vol.test/'] = page(generic)
GET['https://vol.test/manga/saga/'] = page('<h1>Saga</h1><ul class="chapters"><li><a href="/manga/saga/v2c15">Vol.2 Ch.15 : Retour</a></li><li><a href="/manga/saga/v2c14">Vol.2 Ch.14 : Départ</a></li></ul>').replace('<html>', '<html lang="fr-FR">')

// 9. Chapitres sans numéro (prologue, épilogue)
GET['https://nonum.test/'] = page(generic)
GET['https://nonum.test/manga/myth/'] = page('<h1>Myth</h1><ul class="chapters"><li><a href="/manga/myth/chapter-epilogue/">Épilogue</a></li><li><a href="/manga/myth/chapter-1/">Chapter 1</a></li><li><a href="/manga/myth/chapter-prologue/">Prologue</a></li></ul>')

// 10. Madara classique (chapitres sur la fiche) : ne doit pas changer
GET['https://madara.test/'] = page('<div class="wp-manga"></div>')
GET['https://madara.test/manga/solo/'] = page('<div class="wp-manga"><ul><li class="wp-manga-chapter"><a href="https://madara.test/manga/solo/chapter-2/">Chapter 2</a></li><li class="wp-manga-chapter"><a href="https://madara.test/manga/solo/chapter-1/">Chapter 1</a></li></ul></div>')

// --- Pages de lecture ---
GET['https://slug.test/love-code-chapter-1/'] = page(`<header><img src="/logo.png"></header>
<div class="reading"><img data-src="/up/1.jpg" src="data:image/gif;base64,xx"><img data-src="/up/2.jpg"><img data-src="/up/3.jpg"><img src="/ads/banner.jpg" width="60" height="60"></div>`)
GET['https://readid.test/read/1c9d0/'] = page('<div id="app"></div><script>var images = ["\\/img\\/p1.jpg","\\/img\\/p2.jpg","\\/img\\/p3.jpg","\\/img\\/p4.jpg"];</script>')
GET['https://vol.test/manga/saga/v2c14'] = page('<div class="viewer"><noscript><img src="https://cdn.vol.test/s/1.webp"><img src="https://cdn.vol.test/s/2.webp"></noscript></div>')
GET['https://themesia.test/blade-chapter-1/'] = page('<div id="readerarea"></div><script>ts_reader.run({"sources":[{"source":"Server 1","images":["https:\\/\\/cdn.th.test\\/a.jpg","https:\\/\\/cdn.th.test\\/b.jpg"]}]});</script>')


// 11. Lignes de chapitres sans lien (data-href / onclick)
GET['https://datahref.test/'] = page(generic)
GET['https://datahref.test/m/rows/'] = page('<h1>Rows</h1><div class="chapter-box"><div class="chapter-row" data-href="/m/rows/chapter-3">Chapter 3</div><div class="chapter-row" data-href="/m/rows/chapter-2">Chapter 2</div><div class="chapter-row" onclick="location.href=\'/m/rows/chapter-1\'">Chapter 1</div></div>')

// 12. Grille de numéros seuls
GET['https://grid.test/'] = page(generic)
GET['https://grid.test/manga/num/'] = page('<h1>Num</h1><div class="grid"><a href="/manga/num/5">5</a><a href="/manga/num/4">4</a><a href="/manga/num/3">3</a><a href="/manga/num/2">2</a><a href="/manga/num/1">1</a></div>')

// 13. Site Next.js récent : chapitres seulement dans "self.__next_f" (avec d'autres mangas dedans)
GET['https://rsc.test/'] = page(generic)
GET['https://rsc.test/series/storm/'] = page('<div id="root"></div><script>self.__next_f.push([1,"{\\"chapters\\":[{\\"href\\":\\"/series/storm/chapter-3\\"},{\\"href\\":\\"/series/storm/chapter-2\\"},{\\"href\\":\\"/series/storm/chapter-1\\"}],\\"popular\\":[{\\"href\\":\\"/series/other/chapter-50\\"}]}"])</script>')

// 14. Liste chargée depuis /ajax/… (réponse JSON contenant du HTML)
GET['https://ajaxattr.test/'] = page(generic)
GET['https://ajaxattr.test/m/aj/'] = page('<h1>Aj</h1><div id="chapters" data-url="/ajax/manga/55/chapters"></div>')
GET['https://ajaxattr.test/ajax/manga/55/chapters'] = JSON.stringify({ status: true, html: '<ul><li><a href="/m/aj/chapter-2">Chapter 2</a></li><li><a href="/m/aj/chapter-1">Chapter 1</a></li></ul>' })

// 15. Identifiant du manga dans un script : API la plus répandue
GET['https://bookid.test/'] = page(generic)
GET['https://bookid.test/bk/'] = page('<h1>Bk</h1><script>var bookId = 9876; var bookSlug = "bk";</script>')
GET['https://bookid.test/api/manga/9876/chapters?source=detail'] = '<ul class="chapter-list"><li><a href="/bk/chapter-3">Chapter 3</a></li><li><a href="/bk/chapter-2">Chapter 2</a></li><li><a href="/bk/chapter-1">Chapter 1</a></li></ul>'

// 16. API JSON sans adresses complètes (seulement des identifiants de chapitre)
GET['https://jsonapi.test/'] = page(generic)
GET['https://jsonapi.test/manga/kai/'] = page('<h1>Kai</h1><script>fetch("/api/series/42/chapters").then(r => r.json())</script>')
GET['https://jsonapi.test/api/series/42/chapters'] = JSON.stringify({ data: [{ chapter_name: 'Chapter 2', chapter_slug: 'chapter-2', created_at: 1704067200 }, { chapter_name: 'Chapter 1', chapter_slug: 'chapter-1', created_at: 1701388800 }] })

// 17. Liste du plus ancien au plus récent
GET['https://asc.test/'] = page(generic)
GET['https://empty.test/'] = page(generic)
GET['https://empty.test/manga/void/'] = page('<h1>Void</h1><p>Aucun chapitre pour le moment.</p><a href="/">Accueil</a><a href="/manga/other/">Autre manga</a>')
GET['https://asc.test/manga/up/'] = page('<h1>Up</h1><ul class="chapters"><li><a href="/manga/up/chapter-1">Chapter 1</a></li><li><a href="/manga/up/chapter-2">Chapter 2</a></li><li><a href="/manga/up/chapter-3">Chapter 3</a></li></ul>')

// --- Pages : nouveaux lecteurs ---
GET['https://rsc.test/series/storm/chapter-1'] = page('<div id="root"><img src="https://rsc.test/covers/storm.jpg"></div><script>self.__next_f.push([1,"{\\"images\\":[{\\"src\\":\\"https://cdn.rsc.test/storm/c1/01.jpg\\"},{\\"src\\":\\"https://cdn.rsc.test/storm/c1/02.jpg\\"},{\\"src\\":\\"https://cdn.rsc.test/storm/c1/03.jpg\\"}],\\"cover\\":\\"https://cdn.rsc.test/covers/storm.jpg\\"}"])</script>')
GET['https://ajaxattr.test/m/aj/chapter-1'] = page('<div id="reader"></div><script>var data = "WyJodHRwczovL2ltZy5iNjQudGVzdC9jaDEvMDAxLndlYnAiLCAiaHR0cHM6Ly9pbWcuYjY0LnRlc3QvY2gxLzAwMi53ZWJwIiwgImh0dHBzOi8vaW1nLmI2NC50ZXN0L2NoMS8wMDMud2VicCIsICJodHRwczovL2ltZy5iNjQudGVzdC9jaDEvMDA0LndlYnAiXQ=="; var pages = JSON.parse(atob(data));</script>')
GET['https://grid.test/manga/num/1'] = page('<div class="reader"><img src="/scan/num1-p1.jpg" alt="page"></div><select class="pages"><option value="/manga/num/1">1</option><option value="/manga/num/1/2">2</option><option value="/manga/num/1/3">3</option></select>')
GET['https://grid.test/manga/num/1/2'] = page('<div class="reader"><img src="/scan/num1-p2.jpg"></div>')
GET['https://grid.test/manga/num/1/3'] = page('<div class="reader"><img src="/scan/num1-p3.jpg"></div>')

// --- Fausse app Paperback ---
const mem = new Map<string, unknown>()
const requests: string[] = []
;(globalThis as any).App = {
    createSourceStateManager: () => ({ keychain: {}, store: async (k: string, v: unknown) => { mem.set(k, JSON.parse(JSON.stringify(v))) }, retrieve: async (k: string) => mem.get(k) }),
    createRequestManager: (info: any) => ({
        ...info,
        getDefaultUserAgent: async () => 'UA',
        schedule: async (req: any) => {
            requests.push(req.url)
            const r = await info.interceptor.interceptRequest(req)
            const body = (r.method === 'POST' ? POST : GET)[r.url]
            return body !== undefined ? { status: 200, headers: {}, data: body, request: r } : { status: 404, headers: {}, data: '', request: r }
        }
    }),
    createRequest: (i: any) => ({ headers: {}, cookies: [], ...i }),
    createChapter: (i: any) => i, createChapterDetails: (i: any) => i, createTag: (i: any) => i, createTagSection: (i: any) => i
}

async function main(): Promise<void> {
    const { TagFusion } = await import('../src/TagFusion/TagFusion')
    const { encodeMangaId, decodeChapterId } = await import('../src/TagFusion/Utils')
    const src: any = new TagFusion({ load })
    const sites = ['madara-ajax', 'themesia', 'slug', 'readid', 'separate', 'select', 'next', 'vol', 'nonum', 'madara', 'datahref', 'grid', 'rsc', 'ajaxattr', 'bookid', 'jsonapi', 'asc', 'empty'].map(s => `https://${s}.test`)
    await src.store.setSites(sites)

    const chaptersOf = async (site: string, path: string): Promise<any[]> => src.getChapters(encodeMangaId(site, `https://${site}${path}`))
    const nums = (chs: any[]) => chs.map(c => c.chapNum)
    const paths = (chs: any[]) => chs.map(c => decodeChapterId(c.id))
    const check = (chs: any[]): void => {
        assert.equal(new Set(chs.map(c => c.id)).size, chs.length, 'identifiants uniques')
        assert.ok(chs.every(c => /^[A-Za-z0-9._-]+$/.test(c.id)), 'identifiants sans caractères spéciaux')
        assert.ok(chs.every(c => c.time instanceof Date && !isNaN(c.time.getTime())), 'dates valides')
        assert.ok(chs.every(c => Number.isFinite(c.chapNum)), 'numéros valides')
        assert.ok(chs.every(c => typeof c.langCode === 'string' && c.langCode.length >= 2), 'langue renseignée')
        assert.ok(chs.every(c => typeof c.name === 'string' && c.name.length > 0), 'nom toujours rempli')
        assert.ok(chs.every(c => c.volume === undefined || c.volume > 0), 'pas de volume 0')
    }

    let c = await chaptersOf('madara-ajax.test', '/manga/hero/'); check(c)
    assert.deepEqual(nums(c), [3, 2, 1]); console.log('✓ 1. Madara récent (chapitres chargés à part) : 3 chapitres')

    c = await chaptersOf('themesia.test', '/manga/blade/'); check(c)
    assert.deepEqual(nums(c), [2, 1]); assert.equal(c[0].time.getFullYear(), 2024); console.log('✓ 2. Thème MangaReader : 2 chapitres avec date')

    c = await chaptersOf('slug.test', '/series/love-code/'); check(c)
    assert.deepEqual(paths(c), ['/love-code-chapter-3/', '/love-code-chapter-2/', '/love-code-chapter-1/'])
    assert.equal(c[0].name, 'The End'); assert.ok(Date.now() - c[0].time.getTime() > 1.5 * 864e5)
    console.log('✓ 3. Site inconnu : les 3 bons chapitres, barre « dernières sorties » ignorée, titre « The End », date lue')

    c = await chaptersOf('readid.test', '/manga/quiet/'); check(c)
    assert.deepEqual(nums(c), [2, 1]); assert.equal(c[0].time.getFullYear(), 2024); console.log('✓ 4. Adresses sans « chapter » (/read/8f3a2/) : reconnues par « Ch. N »')

    c = await chaptersOf('separate.test', '/title/abc/'); check(c)
    assert.deepEqual(nums(c), [4, 3, 2, 1]); console.log('✓ 5. Page « tous les chapitres » séparée et paginée : 4 chapitres')

    c = await chaptersOf('select.test', '/comic/xyz/'); check(c)
    assert.deepEqual(nums(c), [4, 3, 2, 1]); console.log('✓ 6. Simple bouton « Lire » : liste récupérée dans le menu du lecteur')

    c = await chaptersOf('next.test', '/manga/nova/'); check(c)
    assert.deepEqual(nums(c), [3, 2, 1]); assert.equal(c[2].time.getMonth(), 0); console.log('✓ 7. Site moderne (données cachées __NEXT_DATA__) : 3 chapitres datés')

    c = await chaptersOf('vol.test', '/manga/saga/'); check(c)
    assert.deepEqual(c.map(x => [x.volume, x.chapNum, x.name]), [[2, 15, 'Retour'], [2, 14, 'Départ']])
    assert.equal(c[0].langCode, 'fr'); console.log('✓ 8. Volumes, titres et langue du site : « Vol. 2 Ch. 15 Retour », langue fr')

    c = await chaptersOf('nonum.test', '/manga/myth/'); check(c)
    assert.equal(c.length, 3); assert.deepEqual(c.map(x => x.name), ['Épilogue', 'Chapter 1', 'Prologue'])
    assert.deepEqual(nums(c), [1.5, 1, 0]); console.log('✓ 9. Chapitres sans numéro : Épilogue après le 1, Prologue = 0')

    c = await chaptersOf('madara.test', '/manga/solo/'); check(c)
    assert.deepEqual(nums(c), [2, 1]); console.log('✓ 10. Madara classique : inchangé')


    c = await chaptersOf('datahref.test', '/m/rows/'); check(c)
    assert.deepEqual(nums(c), [3, 2, 1]); console.log('✓ 11. Lignes sans lien (data-href, onclick) : 3 chapitres')

    c = await chaptersOf('grid.test', '/manga/num/'); check(c)
    assert.deepEqual(nums(c), [5, 4, 3, 2, 1]); console.log('✓ 12. Grille de numéros seuls : 5 chapitres')

    c = await chaptersOf('rsc.test', '/series/storm/'); check(c)
    assert.deepEqual(paths(c), ['/series/storm/chapter-3', '/series/storm/chapter-2', '/series/storm/chapter-1']); console.log('✓ 13. Site Next.js récent (self.__next_f) : 3 chapitres, autres mangas ignorés')

    c = await chaptersOf('ajaxattr.test', '/m/aj/'); check(c)
    assert.deepEqual(nums(c), [2, 1]); console.log('✓ 14. Liste chargée depuis /ajax/… (JSON contenant du HTML) : 2 chapitres')

    c = await chaptersOf('bookid.test', '/bk/'); check(c)
    assert.deepEqual(nums(c), [3, 2, 1]); console.log('✓ 15. Identifiant du manga dans un script → API : 3 chapitres')

    c = await chaptersOf('jsonapi.test', '/manga/kai/'); check(c)
    assert.deepEqual(paths(c), ['/manga/kai/chapter-2', '/manga/kai/chapter-1']); assert.equal(c[0].time.getUTCFullYear(), 2024)
    console.log('✓ 16. API JSON sans adresses : adresses reconstruites, dates lues')

    c = await chaptersOf('asc.test', '/manga/up/'); check(c)
    assert.deepEqual(nums(c), [3, 2, 1]); console.log('✓ 17. Liste du plus ancien au plus récent : remise dans le bon ordre')

    requests.length = 0
    c = await chaptersOf('empty.test', '/manga/void/')
    assert.deepEqual(c, []); assert.ok(requests.length <= 8, `trop de requêtes : ${requests.length}`)
    console.log(`✓ 18. Aucun chapitre sur le site : liste vide, pas de plantage, ${requests.length} requête(s) seulement`)

    requests.length = 0
    c = await chaptersOf('slug.test', '/series/love-code/')
    assert.equal(c.length, 3); assert.ok(requests.length <= 1, `requêtes inutiles : ${requests.join(', ')}`)
    console.log(`✓ 19. Site normal : ${requests.length} requête(s), aucune requête inutile`)

    // --- Pages ---
    const pagesOf = async (site: string, mangaPath: string, chapterPath: string): Promise<string[]> => {
        const { encodeChapterId } = await import('../src/TagFusion/Utils')
        return (await src.getChapterDetails(encodeMangaId(site, `https://${site}${mangaPath}`), encodeChapterId(`https://${site}${chapterPath}`))).pages
    }
    assert.deepEqual(await pagesOf('slug.test', '/series/love-code/', '/love-code-chapter-1/'), ['https://slug.test/up/1.jpg', 'https://slug.test/up/2.jpg', 'https://slug.test/up/3.jpg'])
    console.log('✓ Pages : images en chargement différé, logo et pub ignorés')
    assert.deepEqual(await pagesOf('readid.test', '/manga/quiet/', '/read/1c9d0/'), [1, 2, 3, 4].map(n => `https://readid.test/img/p${n}.jpg`))
    console.log('✓ Pages : liste dans un script, chemins relatifs avec « \\/ »')
    assert.deepEqual(await pagesOf('vol.test', '/manga/saga/', '/manga/saga/v2c14'), ['https://cdn.vol.test/s/1.webp', 'https://cdn.vol.test/s/2.webp'])
    console.log('✓ Pages : images cachées dans <noscript>')
    assert.deepEqual(await pagesOf('themesia.test', '/manga/blade/', '/blade-chapter-1/'), ['https://cdn.th.test/a.jpg', 'https://cdn.th.test/b.jpg'])
    console.log('✓ Pages : lecteur MangaReader (ts_reader)')

    assert.deepEqual(await pagesOf('rsc.test', '/series/storm/', '/series/storm/chapter-1'), [1, 2, 3].map(n => `https://cdn.rsc.test/storm/c1/0${n}.jpg`))
    console.log('✓ Pages : lecteur Next.js (images seulement dans le script), couverture ignorée')
    assert.deepEqual(await pagesOf('ajaxattr.test', '/m/aj/', '/m/aj/chapter-1'), [1, 2, 3, 4].map(n => `https://img.b64.test/ch1/00${n}.webp`))
    console.log('✓ Pages : liste codée en base64')
    assert.deepEqual(await pagesOf('grid.test', '/manga/num/', '/manga/num/1'), [1, 2, 3].map(n => `https://grid.test/scan/num1-p${n}.jpg`))
    console.log('✓ Pages : vieux lecteur « une image par page » (3 pages suivies)')
}
main().then(() => console.log('\nChapitres et pages : tout est bon')).catch(e => { console.error('ÉCHEC :', e); process.exit(1) })
