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
GET['https://vol.test/manga/saga/'] = page('<h1>Saga</h1><ul class="chapters"><li><a href="/manga/saga/v2c15">Vol.2 Ch.15 : Retour</a></li><li><a href="/manga/saga/v2c14">Vol.2 Ch.14 : Départ</a></li></ul>')

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

// --- Fausse app Paperback ---
const mem = new Map<string, unknown>()
;(globalThis as any).App = {
    createSourceStateManager: () => ({ keychain: {}, store: async (k: string, v: unknown) => { mem.set(k, JSON.parse(JSON.stringify(v))) }, retrieve: async (k: string) => mem.get(k) }),
    createRequestManager: (info: any) => ({
        ...info,
        getDefaultUserAgent: async () => 'UA',
        schedule: async (req: any) => {
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
    const sites = ['madara-ajax', 'themesia', 'slug', 'readid', 'separate', 'select', 'next', 'vol', 'nonum', 'madara'].map(s => `https://${s}.test`)
    await src.store.setSites(sites)

    const chaptersOf = async (site: string, path: string): Promise<any[]> => src.getChapters(encodeMangaId(site, `https://${site}${path}`))
    const nums = (chs: any[]) => chs.map(c => c.chapNum)
    const paths = (chs: any[]) => chs.map(c => decodeChapterId(c.id))
    const check = (chs: any[]): void => {
        assert.equal(new Set(chs.map(c => c.id)).size, chs.length, 'identifiants uniques')
        assert.ok(chs.every(c => /^[A-Za-z0-9._-]+$/.test(c.id)), 'identifiants sans caractères spéciaux')
        assert.ok(chs.every(c => c.time instanceof Date && !isNaN(c.time.getTime())), 'dates valides')
        assert.ok(chs.every(c => Number.isFinite(c.chapNum)), 'numéros valides')
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
    assert.deepEqual(c.map(x => [x.volume, x.chapNum, x.name]), [[2, 15, 'Retour'], [2, 14, 'Départ']]); console.log('✓ 8. Volumes et titres : « Vol. 2 Ch. 15 Retour »')

    c = await chaptersOf('nonum.test', '/manga/myth/'); check(c)
    assert.equal(c.length, 3); assert.deepEqual(c.map(x => x.name), ['Épilogue', '', 'Prologue'])
    assert.deepEqual(nums(c), [1.5, 1, 0]); console.log('✓ 9. Chapitres sans numéro : Épilogue après le 1, Prologue = 0')

    c = await chaptersOf('madara.test', '/manga/solo/'); check(c)
    assert.deepEqual(nums(c), [2, 1]); console.log('✓ 10. Madara classique : inchangé')

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
}
main().then(() => console.log('\nChapitres et pages : tout est bon')).catch(e => { console.error('ÉCHEC :', e); process.exit(1) })
