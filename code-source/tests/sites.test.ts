// Structures de type AsmHentai et EAHentai : npx tsx --tsconfig tests/tsconfig.json tests/sites.test.ts
import assert from 'node:assert/strict'
import { load } from './shim/minicheerio'

const GET: Record<string, string> = {}
const page = (body: string, title = 'Site'): string => `<html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`

// --- Type AsmHentai : fiche /g/ID/, miniatures vers /gallery/ID/N/, 3 affichées sur 6 ---
GET['https://asm.test/'] = page('<div class="gallery"><a href="/g/694069/"><img src="https://images.asm.test/015/694069/cover.jpg" alt="Galerie A"></a><h3>Galerie A</h3></div>'
    + '<div class="gallery"><a href="/g/694068/"><img src="https://images.asm.test/015/694068/cover.jpg" alt="Galerie B"></a><h3>Galerie B</h3></div>'
    + '<div class="pagination"><a href="?page=2">2</a> … 2303 pages</div>', 'AsmHentai - Free Hentai')
GET['https://asm.test/g/694069/'] = page(`<h1>Galerie A</h1>
<div class="tags"><a href="/tag/romance/" class="tag">Romance <span>(1234)</span></a><a href="/tag/office/" class="tag">Office</a></div>
<div class="pages"><h3>Pages: 6</h3></div>
<div class="preview_thumbs">${[1, 2, 3].map(n => `<div class="preview_thumb"><a href="/gallery/694069/${n}/"><img data-src="https://images.asm.test/015/694069/${n}t.jpg" src="data:image/gif;base64,xx"></a></div>`).join('')}</div>
<div class="related"><a href="/g/111111/"><img src="https://images.asm.test/001/111111/cover.jpg"></a></div>
<div class="footer">Showing 2303 pages of galleries</div>`, 'Galerie A - AsmHentai')
for (const n of [1, 2, 3]) GET[`https://asm.test/gallery/694069/${n}/`] = page(`<div class="reader_overlay"></div><img class="lazy no_image" data-src="https://images.asm.test/015/694069/${n}.jpg">`)

// --- Type EAHentai : tags = liens de recherche, dans une zone sans classe "tag" ; galerie /a/ID/0.. ---
GET['https://eah.test/'] = page(`<div class="flex flex-wrap gap-2"><a href="/search?p=1&q=age%20progression">age progression</a><a href="/search?p=1&q=ahegao">ahegao</a><a href="/search?p=1&q=office">office</a></div>
<div class="grid"><a href="/a/76980"><img src="https://i.eah.test/file/g/abc/thumbnail/image1t.jpg" alt="Galerie E"></a><a href="/a/77148"><img src="https://i.eah.test/file/g/def/thumbnail/image1t.jpg" alt="Galerie F"></a></div>
<a href="/?page=1#latest-section">Next →</a>`, 'EAHentai')
GET['https://eah.test/a/76980'] = page(`<h1>Galerie E</h1>
<div class="flex flex-wrap gap-1"><a href="/search?p=1&q=age%20progression">age progression</a><a href="/search?p=1&q=ahegao">ahegao</a><a href="/search?p=1&q=big%20ass">big ass</a></div>
<p>6 pages • 4 showing</p>
<div class="grid">${[0, 1, 2, 3].map(n => `<a href="/a/76980/${n}"><img src="https://i.eah.test/file/g/abc/thumbnail/image${n + 1}t.jpg"></a>`).join('')}</div>
<span>+2 more pages</span>`, 'Galerie E - EAHentai')
for (const n of [0, 1, 2, 3]) GET[`https://eah.test/a/76980/${n}`] = page(`<div class="mx-auto"><img src="https://i.eah.test/file/g/abc/image${n + 1}.jpg" width="1280" height="1800"></div>`)
GET['https://eah.test/a/77148'] = page('<h1>Galerie F</h1><div class="flex"><a href="/search?p=1&q=ahegao">ahegao</a></div>', 'Galerie F - EAHentai')
// Liste d'un tag, paginée avec "Next →"
GET['https://eah.test/search?p=1&q=ahegao'] = page('<div class="grid"><a href="/a/76980"><img src="https://i.eah.test/c1.jpg" alt="Galerie E"></a><a href="/a/90001"><img src="https://i.eah.test/c2.jpg" alt="Galerie G"></a></div><a href="/search?p=2&q=ahegao">Next →</a>', 'Search - EAHentai')
GET['https://eah.test/search?p=2&q=ahegao'] = page('<div class="grid"><a href="/a/90002"><img src="https://i.eah.test/c3.jpg" alt="Galerie H"></a><a href="/a/90003"><img src="https://i.eah.test/c4.jpg" alt="Galerie I"></a></div>', 'Search - EAHentai')

// --- Nom de site "Index :: Site" ---
GET['https://nexus.test/'] = page('<p>x</p>', 'Index :: Nexus')

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
    createChapter: (i: any) => i, createChapterDetails: (i: any) => i, createTag: (i: any) => i, createTagSection: (i: any) => i,
    createPagedResults: (i: any) => ({ results: [], ...i }), createPartialSourceManga: (i: any) => i,
    createSourceManga: (i: any) => i, createMangaInfo: (i: any) => i
}

async function main(): Promise<void> {
    const { TagFusion } = await import('../src/TagFusion/TagFusion')
    const { encodeMangaId, encodeChapterId, tagIdOf } = await import('../src/TagFusion/Utils')
    const src: any = new TagFusion({ load })
    await src.store.setSites(['https://asm.test', 'https://eah.test', 'https://nexus.test'])
    await src.discoverAll(true)

    // --- AsmHentai : chapitre unique + 6 pages en taille réelle (3 affichées, 3 reconstituées) ---
    const asmId = encodeMangaId('asm.test', 'https://asm.test/g/694069/')
    const asmCh = await src.getChapters(asmId)
    assert.equal(asmCh.length, 1, `chapitres : ${asmCh.length}`)
    const asmPages = (await src.getChapterDetails(asmId, asmCh[0].id)).pages
    assert.deepEqual(asmPages, [1, 2, 3, 4, 5, 6].map(n => `https://images.asm.test/015/694069/${n}.jpg`))
    console.log('✓ Type AsmHentai : chapitre unique, 6 pages en taille réelle (3 affichées + 3 reconstituées, « 2303 pages » ignoré)')

    // --- EAHentai : tags = liens de recherche, affichés sur la fiche ---
    const eahId = encodeMangaId('eah.test', 'https://eah.test/a/76980')
    const eah = await src.getMangaDetails(eahId)
    const eahTags = eah.mangaInfo.tags[0].tags.map((t: any) => t.label).sort()
    assert.deepEqual(eahTags, ['age progression', 'ahegao', 'big ass'])
    console.log('✓ Type EAHentai : tags de la fiche affichés (liens de recherche « /search?q= »)')

    // --- EAHentai : galerie numérotée à partir de 0, 4 affichées sur 6, miniature dans /thumbnail/ ---
    const eahCh = await src.getChapters(eahId)
    assert.equal(eahCh.length, 1)
    const eahPages = (await src.getChapterDetails(eahId, encodeChapterId('https://eah.test/a/76980'))).pages
    assert.deepEqual(eahPages, [1, 2, 3, 4, 5, 6].map(n => `https://i.eah.test/file/g/abc/image${n}.jpg`))
    console.log('✓ Type EAHentai : galerie numérotée depuis 0, 6 pages (4 affichées + 2 reconstituées), miniatures « /thumbnail/…t.jpg » converties')

    // --- EAHentai : recherche par tag, pagination « Next → » suivie ---
    const u = await src.store.unified()
    assert.ok(u.ahegao?.sites['eah.test']?.url.includes('/search?p=1&q=ahegao'), 'tag de recherche découvert avec sa page')
    const titles: string[] = []
    let meta: unknown = undefined
    let guard = 0
    do {
        const r = await src.getSearchResults({ includedTags: [{ id: tagIdOf('ahegao'), label: 'ahegao' }], excludedTags: [] }, meta)
        titles.push(...r.results.map((m: any) => m.title))
        meta = r.metadata
    } while (meta !== undefined && guard++ < 10)
    for (const t of ['Galerie E', 'Galerie G', 'Galerie H', 'Galerie I']) assert.ok(titles.includes(t), `manque ${t} (obtenu : ${titles.join(', ')})`)
    console.log('✓ Type EAHentai : recherche par tag sur 2 pages (bouton « Next → »), tous les mangas sortent')

    // --- Noms de sites ---
    const info = await src.store.getSiteInfo()
    assert.equal(info['nexus.test'].name, 'Nexus')
    assert.equal(info['asm.test'].name, 'AsmHentai')
    console.log('✓ Noms de sites : « Index :: Nexus » -> « Nexus », « AsmHentai - Free Hentai » -> « AsmHentai »')
}
main().then(() => console.log('\nSites de type AsmHentai / EAHentai : tout est bon')).catch(e => { console.error('ÉCHEC :', e); process.exit(1) })
