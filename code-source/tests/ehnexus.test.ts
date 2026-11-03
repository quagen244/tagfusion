// E-Hentai et HentaiNexus, d'après leurs structures relevées sur les vrais sites :
// npx tsx --tsconfig tests/tsconfig.json tests/ehnexus.test.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { load } from './shim/minicheerio'

const GET: Record<string, string> = {}
const STATUS: Record<string, number[]> = {}
const requests: string[] = []
const page = (body: string, title = 'Site'): string => `<html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`

// =========================== E-Hentai ===========================
const EH = 'https://e-hentai.org'
const ehRow = (gid: number, token: string, title: string, tag: string): string => `<tr>
<td class="gl1c glcat"><div class="cn ct2" onclick="document.location='${EH}/doujinshi'">Doujinshi</div></td>
<td class="gl2c"><div class="glthumb"><div><img style="height:40px" alt="${title}" data-src="https://ehgt.org/w/01/abc/${gid}-cover.webp" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></div></div><div class="gldown"><img src="https://ehgt.org/g/t.png" alt="T" title="Show torrents"></div></td>
<td class="gl3c glname"><a href="${EH}/g/${gid}/${token}/"><div class="glink">${title}</div><div><div class="gt" title="female:${tag}">${tag}</div><div class="gt" title="language:english">english</div></div></a></td>
<td class="gl4c glhide"><div><a href="${EH}/uploader/entor">entor</a></div><div>45 pages</div></td></tr>`
const ehList = (rows: string, next: string): string => page(`<div class="ido"><table class="itg gltc"><tr><th>Category</th><th>Title</th></tr>${rows}</table></div>
<script>var prevurl="";
var nexturl="${next}";</script>`, 'E-Hentai Galleries')

GET[`${EH}/`] = ehList(ehRow(3000001, 'abc123def0', 'Gallery Forty-Five', 'big breasts') + ehRow(3000002, 'ffeedd0011', 'Flagged Gallery', 'big breasts'), `${EH}/?next=3000000`)
GET[`${EH}/?next=3000000`] = ehList(ehRow(2999999, 'aa11bb22cc', 'Older Gallery', 'vanilla'), '')

// Galerie de 45 pages : 3 pages de miniatures (?p=0, 1, 2) de 20, 20 et 5
const G = `${EH}/g/3000001/abc123def0/`
const viewer = (gid: number, n: number): string => `${EH}/s/${(gid * 31 + n * 7919).toString(16)}/${gid}-${n}`
const ehGallery = (p: number, from: number, to: number): string => page(`<div id="gd1"><div style="width:250px;height:353px;background:transparent url(https://ehgt.org/w/01/abc/3000001-cover.webp) 0 0 no-repeat"></div></div>
<div id="gd2"><h1 id="gn">Gallery Forty-Five</h1><h1 id="gj">ギャラリー</h1></div>
<div id="gdd"><table><tr><td class="gdt1">Posted:</td><td class="gdt2">2026-08-15 05:47</td></tr><tr><td class="gdt1">Language:</td><td class="gdt2">English</td></tr><tr><td class="gdt1">Length:</td><td class="gdt2">45 pages</td></tr></table></div>
<div id="taglist"><table>
<tr><td class="tc">language:</td><td><div id="td_language:english" class="gt"><a id="ta_language:english" href="${EH}/tag/language:english">english</a></div></td></tr>
<tr><td class="tc">artist:</td><td><div id="td_artist:someone" class="gt"><a id="ta_artist:someone" href="${EH}/tag/artist:someone">someone</a></div></td></tr>
<tr><td class="tc">female:</td><td><div id="td_female:big_breasts" class="gt"><a id="ta_female:big_breasts" href="${EH}/tag/female:big+breasts">big breasts</a></div><div id="td_female:glasses" class="gtl"><a id="ta_female:glasses" href="${EH}/tag/female:glasses">glasses</a></div></td></tr>
<tr><td class="tc">other:</td><td><div id="td_other:full_color" class="gt"><a id="ta_other:full_color" href="${EH}/tag/other:full+color">full color</a></div></td></tr>
</table></div>
<div class="gtb"><p class="gpc">Showing ${from} - ${to} of 45 images</p>
<table class="ptt"><tr><td${p === 0 ? ' class="ptdd"' : ''}>${p === 0 ? '&lt;' : `<a href="${G}${p === 1 ? '' : `?p=${p - 1}`}">&lt;</a>`}</td>
<td${p === 0 ? ' class="ptds"' : ''}><a href="${G}">1</a></td><td${p === 1 ? ' class="ptds"' : ''}><a href="${G}?p=1">2</a></td><td${p === 2 ? ' class="ptds"' : ''}><a href="${G}?p=2">3</a></td>
<td>${p === 2 ? '&gt;' : `<a href="${G}?p=${p + 1}">&gt;</a>`}</td></tr></table></div>
<div id="gdt" class="gt100">${Array.from({ length: to - from + 1 }, (_, i) => from + i).map(n => `<a href="${viewer(3000001, n)}"><div title="Page ${n}: ${String(n).padStart(3, '0')}.webp" style="width:100px;height:142px;background:transparent url(https://ehgt.org/m/003/3000001-0${Math.floor((n - 1) / 20)}.webp) -${((n - 1) % 20) * 100}px 0 no-repeat"></div></a>`).join('')}</div>
<script>var gid = 3000001; var token = "abc123def0";</script>`, 'Gallery Forty-Five - E-Hentai Galleries')
GET[G] = ehGallery(0, 1, 20)
GET[`${G}?p=1`] = ehGallery(1, 21, 40)
GET[`${G}?p=2`] = ehGallery(2, 41, 45)
const hath = (gid: number, n: number): string => `https://kq${n % 3}.xyzh${gid % 7}.hath.network:2333/h/${gid}${n}/keystamp=1793${n};fileindex=${9000 + n};xres=1280/${String(n).padStart(3, '0')}.webp`
const nav = '<div class="sn"><a onclick="return load_image(1)" href="#"><img src="https://ehgt.org/g/f.png"></a><a id="prev" href="#"><img src="https://ehgt.org/g/p.png"></a><div><span>1</span> / <span>45</span></div><a id="next" href="#"><img src="https://ehgt.org/g/n.png"></a><a href="#"><img src="https://ehgt.org/g/l.png"></a></div>'
for (let n = 1; n <= 45; n++) {
    GET[viewer(3000001, n)] = page(`<div id="i1"><h1>Gallery Forty-Five</h1>${nav}<div id="i2"><div>${String(n).padStart(3, '0')}.webp :: 1280 x 1810 :: 312.4 KiB</div></div>
<div id="i3"><a href="${viewer(3000001, n + 1)}"><img id="img" src="${hath(3000001, n)}" style="max-width:1280px;max-height:1810px" onerror="this.onerror=null; nl('${n}')"></a></div>
<div id="i4">${nav}</div><div id="i6"><img src="https://ehgt.org/g/mr.gif"> <a href="${EH}/fullimg/3000001/${n}/abc/${n}.webp">Download original 1280 x 1810 312 KiB source</a></div></div>`)
}

// Galerie signalée : page d'avertissement, puis la vraie galerie (5 pages) via « ?nw=always »
const F = `${EH}/g/3000002/ffeedd0011/`
GET[F] = page(`<div style="width:720px; margin:0 auto"><h1>Content Warning</h1><p>This gallery has been flagged as <strong>Offensive For Everyone</strong>.</p>
<p>[<a href="${F}?nw=session">View Gallery</a>] [<a href="${F}?nw=always">Never Warn Me Again</a>] [<a href="${EH}/">Get Me Outta Here</a>]</p></div>`)
GET[`${F}?nw=always`] = page(`<div id="gd2"><h1 id="gn">Flagged Gallery</h1></div><div id="gdd"><table><tr><td class="gdt1">Length:</td><td class="gdt2">5 pages</td></tr></table></div>
<div id="taglist"><table><tr><td class="tc">female:</td><td><div class="gt"><a href="${EH}/tag/female:big+breasts">big breasts</a></div></td></tr></table></div>
<p class="gpc">Showing 1 - 5 of 5 images</p><div id="gdt">${[1, 2, 3, 4, 5].map(n => `<a href="${viewer(3000002, n)}"><div style="background:url(https://ehgt.org/m/x.webp)"></div></a>`).join('')}</div>`)
for (let n = 1; n <= 5; n++) GET[viewer(3000002, n)] = page(`${nav}<div id="i3"><a href="#"><img id="img" src="${hath(3000002, n)}"></a></div>`)

// Liste d'un tag, paginée par curseur
GET[`${EH}/tag/female:big+breasts`] = ehList(ehRow(3000001, 'abc123def0', 'Gallery Forty-Five', 'big breasts') + ehRow(3000003, 'cc00dd11ee', 'Third Gallery', 'big breasts'), `${EH}/tag/female:big+breasts?next=3000002`)
GET[`${EH}/tag/female:big+breasts?next=3000002`] = ehList(ehRow(3000002, 'ffeedd0011', 'Flagged Gallery', 'big breasts'), '')

// =========================== HentaiNexus ===========================
const HN = 'https://hentainexus.com'
const vectors = JSON.parse(readFileSync(new URL('./fixtures/hentainexus-vectors.json', import.meta.url), 'utf8'))
const hnCard = (id: number, title: string): string => `<div class="column is-one-quarter-desktop is-half-mobile"><a href="/view/${id}"><div class="card"><div class="card-image"><figure class="image"><img src="https://images.hentainexus.com/v2/c/${id}/thumb.jpg" alt="${title}"></figure></div><header class="card-header"><div class="card-header-title">${title}</div></header></div></a></div>`
GET[`${HN}/`] = page(`<section class="section"><div class="container"><div class="columns is-multiline">${hnCard(16001, 'Nexus One') + hnCard(16002, 'Nexus Two')}</div></div></section>
<nav class="pagination"><a class="pagination-next" href="/page/2">Next page</a></nav>`, 'Index :: HentaiNexus')
GET[`${HN}/page/2`] = page(`<div class="container"><div class="columns">${hnCard(15999, 'Nexus Old')}</div></div>`, 'Index :: HentaiNexus')
GET[`${HN}/view/16001`] = page(`<div class="container"><div class="columns"><div class="column is-one-quarter"><figure class="image"><img src="https://images.hentainexus.com/v2/c/16001/cover.jpg"></figure></div>
<div class="column"><h1 class="title">Nexus One</h1><table class="view-page-details">
<tr><td class="viewcolumn">Artist</td><td><a href="/?q=artist:%22someone%22">someone</a></td></tr>
<tr><td class="viewcolumn">Magazine</td><td><a href="/?q=magazine:%22comic+x%22">Comic X</a></td></tr>
<tr><td class="viewcolumn">Pages</td><td>6</td></tr>
<tr><td class="viewcolumn">Tags</td><td><span class="tag"><a href="/?q=tag:%22big+breasts%22">big breasts (1,234)</a></span><span class="tag"><a href="/?q=tag:%22vanilla%22">vanilla (567)</a></span></td></tr>
</table><a class="button is-primary" href="/read/16001">Read Online</a></div></div></div>`, 'Nexus One :: HentaiNexus')
GET[`${HN}/read/16001`] = page(`<div id="reader"></div><script>initReader("${vectors.seed0.enc}", "${HN}/view/16001", 1);</script>`)

// Site qui répond « trop de requêtes » une fois
GET['https://busy.test/'] = page('<p>ok</p>')
STATUS['https://busy.test/'] = [429]

const mem = new Map<string, unknown>()
const managersUsed: Record<string, number> = {}
;(globalThis as any).App = {
    createSourceStateManager: () => ({ keychain: {}, store: async (k: string, v: unknown) => { mem.set(k, JSON.parse(JSON.stringify(v))) }, retrieve: async (k: string) => mem.get(k) }),
    createRequestManager: (info: any) => ({
        ...info, getDefaultUserAgent: async () => 'UA',
        schedule: async (req: any) => {
            const r = await info.interceptor.interceptRequest(req)
            requests.push(r.url)
            managersUsed[String(info.requestsPerSecond)] = (managersUsed[String(info.requestsPerSecond)] ?? 0) + 1
            const forced = STATUS[r.url]
            if (forced && forced.length) return { status: forced.shift(), headers: {}, data: '', request: r }
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
    const { encodeMangaId, tagIdOf, decodeChapterId } = await import('../src/TagFusion/Utils')
    const src: any = new TagFusion({ load })
    await src.store.setSites([EH, HN, 'https://busy.test'])
    await src.discoverAll(true)
    const eh = (u: string): string => encodeMangaId('e-hentai.org', u)
    const hn = (u: string): string => encodeMangaId('hentainexus.com', u)

    // ---------------- E-Hentai ----------------
    // Liste : vrais titres (sans les tags de la ligne), vraies couvertures (pas l'icône des torrents ni l'image vide)
    const latest = await src.getViewMoreItems('home_site_' + (await import('../src/TagFusion/Utils')).safeEncode('e-hentai.org'), undefined)
    const p1 = latest.results.map((r: any) => [r.title, r.image])
    assert.deepEqual(p1.map((x: any) => x[0]), ['Gallery Forty-Five', 'Flagged Gallery'])
    assert.ok(p1.every((x: any) => /ehgt\.org\/w\/01\/abc\/\d+-cover\.webp$/.test(x[1])), `couvertures : ${p1.map((x: any) => x[1]).join(', ')}`)
    const p2 = await src.getViewMoreItems('home_site_' + (await import('../src/TagFusion/Utils')).safeEncode('e-hentai.org'), latest.metadata)
    assert.deepEqual(p2.results.map((r: any) => r.title), ['Older Gallery'])
    assert.equal(p2.metadata, undefined, 'fin de liste (nexturl vide)')
    console.log('✓ E-Hentai : liste avec vrais titres et couvertures, page suivante par « nexturl », fin de liste reconnue')

    // Fiche : vrais tags seulement
    const fiche = await src.getMangaDetails(eh(G))
    assert.equal(fiche.mangaInfo.titles[0], 'Gallery Forty-Five')
    assert.deepEqual(fiche.mangaInfo.tags[0].tags.map((t: any) => t.label).sort(), ['big breasts', 'full color', 'glasses'])
    console.log('✓ E-Hentai : fiche avec ses vrais tags (artiste et langue écartés)')

    // Chapitres : 45 pages = 3 chapitres de 20, 20 et 5
    const chs = await src.getChapters(eh(G))
    assert.deepEqual(chs.map((c: any) => [c.chapNum, c.name]), [[3, 'Pages 41–45'], [2, 'Pages 21–40'], [1, 'Pages 1–20']])
    console.log('✓ E-Hentai : galerie de 45 pages découpée en 3 chapitres (20 + 20 + 5) qui s\'enchaînent')

    // Pages : chaque image est la vraie (img#img sur H@H), jamais les flèches de navigation, dans l'ordre
    const byNum = (n: number) => chs.find((c: any) => c.chapNum === n)
    requests.length = 0
    const pages1 = (await src.getChapterDetails(eh(G), byNum(1).id)).pages
    assert.deepEqual(pages1, Array.from({ length: 20 }, (_, i) => hath(3000001, i + 1)))
    assert.ok(!pages1.some((u: string) => /ehgt\.org\/g\//.test(u)), 'aucune flèche de navigation')
    assert.ok(requests.length <= 22, `requêtes pour 20 pages : ${requests.length}`)
    const pages2 = (await src.getChapterDetails(eh(G), byNum(2).id)).pages
    assert.deepEqual(pages2, Array.from({ length: 20 }, (_, i) => hath(3000001, i + 21)))
    const pages3 = (await src.getChapterDetails(eh(G), byNum(3).id)).pages
    assert.deepEqual(pages3, Array.from({ length: 5 }, (_, i) => hath(3000001, i + 41)))
    assert.equal(decodeChapterId(byNum(2).id), '/g/3000001/abc123def0/?p=1')
    console.log('✓ E-Hentai : pages 1–20, 21–40 et 41–45 exactes et dans l\'ordre (image principale, pas les flèches)')

    // Images : le serveur H@H reçoit bien e-hentai.org comme site d'origine
    const imgReq = await src.requestManager.interceptor.interceptRequest({ url: hath(3000001, 7), method: 'GET', headers: {}, cookies: [] })
    assert.equal(imgReq.headers['referer'], `${EH}/`)
    console.log('✓ E-Hentai : images H@H demandées avec e-hentai.org comme site d\'origine')

    // Galerie signalée : l'avertissement est passé automatiquement
    const flagged = await src.getChapters(eh(F))
    assert.equal(flagged.length, 1)
    const fpages = (await src.getChapterDetails(eh(F), flagged[0].id)).pages
    assert.deepEqual(fpages, Array.from({ length: 5 }, (_, i) => hath(3000002, i + 1)))
    console.log('✓ E-Hentai : galerie signalée (« Content Warning ») ouverte automatiquement, 5 pages')

    // Recherche par tag : page du tag, puis curseur « next »
    const titles: string[] = []
    let meta: unknown = undefined
    let guard = 0
    do {
        const r = await src.getSearchResults({ includedTags: [{ id: tagIdOf('big breasts'), label: 'big breasts' }], excludedTags: [] }, meta)
        titles.push(...r.results.map((x: any) => x.title))
        meta = r.metadata
    } while (meta !== undefined && guard++ < 10)
    for (const t of ['Gallery Forty-Five', 'Third Gallery', 'Flagged Gallery']) assert.ok(titles.includes(t), `manque ${t} : ${titles.join(', ')}`)
    console.log('✓ E-Hentai : recherche par tag sur 2 pages (curseur), tous les résultats')

    // ---------------- HentaiNexus ----------------
    const hnHome = await src.getViewMoreItems('home_site_' + (await import('../src/TagFusion/Utils')).safeEncode('hentainexus.com'), undefined)
    assert.deepEqual(hnHome.results.map((r: any) => r.title), ['Nexus One', 'Nexus Two'])
    assert.ok(hnHome.results.every((r: any) => /images\.hentainexus\.com\/v2\/c\/\d+\/thumb\.jpg$/.test(r.image)))
    const hnHome2 = await src.getViewMoreItems('home_site_' + (await import('../src/TagFusion/Utils')).safeEncode('hentainexus.com'), hnHome.metadata)
    assert.deepEqual(hnHome2.results.map((r: any) => r.title), ['Nexus Old'])
    console.log('✓ HentaiNexus : liste et page suivante (« Next page »)')

    const hnFiche = await src.getMangaDetails(hn(`${HN}/view/16001`))
    assert.equal(hnFiche.mangaInfo.titles[0], 'Nexus One')
    assert.deepEqual(hnFiche.mangaInfo.tags[0].tags.map((t: any) => t.label).sort(), ['big breasts', 'vanilla'])
    console.log('✓ HentaiNexus : fiche avec ses tags (sans les nombres, sans artiste ni magazine)')

    requests.length = 0
    const hnCh = await src.getChapters(hn(`${HN}/view/16001`))
    assert.equal(hnCh.length, 1)
    assert.equal(decodeChapterId(hnCh[0].id), '/read/16001')
    assert.ok(requests.length <= 3, `requêtes pour la liste des chapitres : ${requests.length} (${requests.join(', ')})`)
    console.log(`✓ HentaiNexus : un chapitre (/read/…), ${requests.length} requête(s) seulement (le site limite à 1 par seconde)`)

    const hnPages = (await src.getChapterDetails(hn(`${HN}/view/16001`), hnCh[0].id)).pages
    assert.deepEqual(hnPages, Array.from({ length: 6 }, (_, i) => `https://i0.wp.com/images.hentainexus.com/v2/gx/${String(i + 1).padStart(3, '0')}.webp`))
    console.log('✓ HentaiNexus : lecteur chiffré déchiffré, 6 pages WebP dans l\'ordre (publicité écartée)')

    // ---------------- Rythme des requêtes ----------------
    assert.equal(src.managerFor(`${HN}/x`), src.slowManager)
    assert.equal(src.managerFor(`${EH}/x`), src.politeManager)
    assert.equal(src.managerFor('https://exhentai.org/g/1/'), src.politeManager)
    assert.equal(src.managerFor('https://other.test/'), src.requestManager)
    assert.ok((managersUsed['1'] ?? 0) > 0 && (managersUsed['2'] ?? 0) > 0, `gestionnaires utilisés : ${JSON.stringify(managersUsed)}`)
    const busy = await src.http('GET', 'https://busy.test/')
    assert.match(busy, /ok/)
    assert.equal(src.managerFor('https://busy.test/'), src.slowManager, 'après un 429, le site passe au rythme lent')
    console.log('✓ Rythme : HentaiNexus à 1 requête/s, E-Hentai à 2/s, un site qui répond 429 passe au rythme lent')
}
main().then(() => console.log('\nE-Hentai et HentaiNexus : tout est bon')).catch(e => { console.error('ÉCHEC :', e); process.exit(1) })
