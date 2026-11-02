// Galeries de type nhentai, étiquettes non-genres et écran des tags plafonné :
// npx tsx --tsconfig tests/tsconfig.json tests/nhentai.test.ts
import assert from 'node:assert/strict'
import { load } from './shim/minicheerio'

const GET: Record<string, string> = {}
const requests: string[] = []
const page = (body: string, head = ''): string => `<html lang="en"><head><title>Site</title>${head}</head><body>${body}</body></html>`

// 1. Galerie type nhentai : miniatures sur t3, grandes images sur i5, formats mélangés, liste des pages dans la page
const TYPES = ['w', 'j', 'p', 'w', 'j', 'w', 'g', 'w']
const EXT: Record<string, string> = { w: 'webp', j: 'jpg', p: 'png', g: 'gif' }
const nhData = JSON.stringify({ id: 692926, media_id: '3713001', images: { pages: TYPES.map(t => ({ t, w: 1280, h: 1810 })) } })
const escaped = nhData.replace(/"/g, '\\u0022')
GET['https://nh.test/'] = page('<p>x</p>')
GET['https://nh.test/g/692926/'] = page(`<h1>Galerie</h1>
<section id="tags"><div class="tag-container field-name">Tags: <span class="tags"><a href="/tag/romance/" class="tag"><span class="name">romance</span><span class="count">12K</span></a><a href="/tag/office/" class="tag"><span class="name">office</span></a></span></div>
<div class="tag-container field-name">Artists: <span class="tags"><a href="/artist/kazuhiro/" class="tag"><span class="name">kazuhiro</span></a></span></div>
<div class="tag-container field-name">Characters: <span class="tags"><a href="/character/mio/" class="tag"><span class="name">mio</span></a></span></div>
<div class="tag-container field-name">Parodies: <span class="tags"><a href="/parody/original/" class="tag"><span class="name">original</span></a></span></div>
<div class="tag-container field-name">Groups: <span class="tags"><a href="/group/studio-x/" class="tag"><span class="name">studio x</span></a></span></div>
<div class="tag-container field-name">Languages: <span class="tags"><a href="/language/english/" class="tag"><span class="name">english</span></a></span></div></section>
<div class="thumbs">${TYPES.map((t, i) => `<div class="thumb-container"><a class="gallerythumb" href="/g/692926/${i + 1}/"><img class="lazyload" data-src="https://t3.nh.test/galleries/3713001/${i + 1}t.${EXT[t]}" width="200" height="280"></a></div>`).join('')}</div>
<script>window._gallery = JSON.parse("${escaped}");</script>`)
TYPES.forEach((t, i) => { GET[`https://nh.test/g/692926/${i + 1}/`] = page(`<section id="image-container"><a href="/g/692926/${i + 2}/"><img src="https://i5.nh.test/galleries/3713001/${i + 1}.${EXT[t]}" width="1280" height="1810"></a></section>`) })

// 2. Même galerie, sans liste des pages : la correspondance t3 -> i5 est apprise sur 3 pages
GET['https://nh2.test/'] = page('<p>x</p>')
GET['https://nh2.test/g/1/'] = page(`<h1>G</h1><div class="thumbs">${TYPES.map((t, i) => `<a href="/g/1/${i + 1}/"><img data-src="https://t3.nh2.test/galleries/77/${i + 1}t.${EXT[t]}"></a>`).join('')}</div>`)
TYPES.forEach((t, i) => { GET[`https://nh2.test/g/1/${i + 1}/`] = page(`<section id="image-container"><img src="https://i5.nh2.test/galleries/77/${i + 1}.${EXT[t]}"></section>`) })

// 3. Très grande galerie (150 pages) sans règle possible : le chapitre s'ouvre quand même, 120 pages ouvertes au plus
const RAND = (n: number): string => `p${(n * 7919) % 10007}x`
GET['https://big.test/'] = page('<p>x</p>')
GET['https://big.test/album/5/'] = page(`<h1>Big</h1><div class="thumbs">${Array.from({ length: 150 }, (_, i) => `<a href="/album/5/${i + 1}/"><img src="https://cdn.big.test/mini/${RAND(i + 1)}.jpg"></a>`).join('')}</div>`)
for (let n = 1; n <= 150; n++) GET[`https://big.test/album/5/${n}/`] = page(`<div class="viewer"><img src="https://img.big.test/full/${RAND(n)}-hd-${n}.jpg"></div>`)

// 4. Site à tags de recherche (type EAHentai) avec des liens « artist: »
GET['https://eah.test/'] = page('<p>x</p>')
GET['https://eah.test/a/9'] = page('<h1>E</h1><div class="flex"><a href="/search?p=1&q=ahegao">ahegao</a><a href="/search?p=1&q=artist:someone">someone</a><a href="/search?p=1&q=vanilla">vanilla</a></div>')

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
    createChapter: (i: any) => i, createChapterDetails: (i: any) => i, createTag: (i: any) => i, createTagSection: (i: any) => i,
    createPagedResults: (i: any) => ({ results: [], ...i }), createPartialSourceManga: (i: any) => i,
    createSourceManga: (i: any) => i, createMangaInfo: (i: any) => i
}

async function main(): Promise<void> {
    const { TagFusion } = await import('../src/TagFusion/TagFusion')
    const { encodeMangaId, encodeChapterId } = await import('../src/TagFusion/Utils')
    const src: any = new TagFusion({ load })
    await src.store.setSites(['https://nh.test', 'https://nh2.test', 'https://big.test', 'https://eah.test'])
    const pagesOf = async (site: string, path: string): Promise<string[]> =>
        (await src.getChapterDetails(encodeMangaId(site, `https://${site}${path}`), encodeChapterId(`https://${site}${path}`))).pages

    // 1. Liste des pages du site : formats mélangés, serveur différent des miniatures, 1 page ouverte
    requests.length = 0
    const nh = await pagesOf('nh.test', '/g/692926/')
    assert.deepEqual(nh, TYPES.map((t, i) => `https://i5.nh.test/galleries/3713001/${i + 1}.${EXT[t]}`))
    const opened = requests.filter(u => /\/g\/692926\/\d+\/$/.test(u)).length
    assert.equal(opened, 1, `pages de lecture ouvertes : ${opened}`)
    console.log(`✓ Galerie type nhentai : ${nh.length} pages (webp/jpg/png/gif mélangés, serveur i5 ≠ miniatures t3), 1 seule page ouverte`)

    // 2. Sans liste : correspondance t3 -> i5 apprise et vérifiée
    requests.length = 0
    const nh2 = await pagesOf('nh2.test', '/g/1/')
    assert.deepEqual(nh2, TYPES.map((t, i) => `https://i5.nh2.test/galleries/77/${i + 1}.${EXT[t]}`))
    assert.ok(requests.filter(u => /\/g\/1\/\d+\/$/.test(u)).length <= 3)
    console.log('✓ Galerie sans liste des pages : serveur des grandes images appris (t3 -> i5), formats gardés, 3 pages ouvertes')

    // 3. 150 pages sans règle possible : ouverture bornée, aucune page perdue, ordre exact
    requests.length = 0
    const big = await pagesOf('big.test', '/album/5/')
    assert.equal(big.length, 150)
    const bigOpened = requests.filter(u => /\/album\/5\/\d+\/$/.test(u)).length
    assert.ok(bigOpened <= 123, `pages ouvertes : ${bigOpened}`)
    big.forEach((u, i) => assert.ok(u.includes(RAND(i + 1)), `page ${i + 1} à la mauvaise place : ${u}`))
    console.log(`✓ Galerie de 150 pages sans règle : ${bigOpened} pages ouvertes au plus, les autres en miniature, ordre exact, rien de perdu`)

    // 4. Étiquettes qui ne sont pas des genres (artistes, personnages, parodies, groupes, langues) écartées
    const fiche = await src.getMangaDetails(encodeMangaId('nh.test', 'https://nh.test/g/692926/'))
    assert.deepEqual(fiche.mangaInfo.tags[0].tags.map((t: any) => t.label).sort(), ['office', 'romance'])
    const eah = await src.getMangaDetails(encodeMangaId('eah.test', 'https://eah.test/a/9'))
    assert.deepEqual(eah.mangaInfo.tags[0].tags.map((t: any) => t.label).sort(), ['ahegao', 'vanilla'])
    console.log('✓ Fiche : artistes, personnages, parodies, groupes et langues écartés (seulement les vrais tags)')

    // 5. Écran des tags plafonné, même avec des milliers de tags
    const many = Array.from({ length: 1500 }, (_, i) => ({ label: `tagname ${String.fromCharCode(97 + (i % 26))}${i}`.replace(/\d/g, d => 'abcdefghij'[Number(d)] as string), url: `https://nh.test/tag/x${i}/` }))
    await src.store.addTags('nh.test', many)
    const screen = await src.getSearchTags()
    const count = screen.filter((x: any) => x.id.startsWith('letter_')).reduce((n: number, x: any) => n + x.tags.length, 0)
    assert.ok(count <= 500, `${count} tags affichés`)
    assert.ok(screen.some((x: any) => x.tags.some((t: any) => t.label === 'romance' || t.label === 'Romance')), 'les tags utiles restent')
    console.log(`✓ Écran des tags : ${count} tags affichés au plus malgré 1500 tags connus (les plus utiles gardés)`)

    // 6. Les listes de pages enregistrées par les anciennes versions sont ignorées
    mem.set('tf_pages_cache', { [`nh.test|${encodeChapterId('https://nh.test/g/692926/')}`]: { p: ['https://t3.nh.test/galleries/3713001/1t.webp'], at: Date.now() } })
    const fresh: any = new TagFusion({ load })
    const again = (await fresh.getChapterDetails(encodeMangaId('nh.test', 'https://nh.test/g/692926/'), encodeChapterId('https://nh.test/g/692926/'))).pages
    assert.equal(again.length, TYPES.length)
    console.log('✓ Anciennes listes de pages en cache ignorées (nouvelle lecture correcte)')
}
main().then(() => console.log('\nGaleries nhentai et écran des tags : tout est bon')).catch(e => { console.error('ÉCHEC :', e); process.exit(1) })
