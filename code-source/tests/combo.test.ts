// Recherche à plusieurs tags par la recherche des sites eux-mêmes, avec contrôle et repli :
// npx tsx --tsconfig tests/tsconfig.json tests/combo.test.ts
import assert from 'node:assert/strict'
import { load } from './shim/minicheerio'

const GET: Record<string, string> = {}
const requests: string[] = []
const page = (body: string, title = 'Site'): string => `<html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`
const enc = encodeURIComponent

// ---------- 1. HentaiNexus : liens de tag "/?q=tag:%22x%22", la recherche du site accepte plusieurs tags ----------
const HN = 'https://hentainexus.com'
// 70 mangas ; "big breasts" = n pair, "vanilla" = n multiple de 3 ; les deux = n multiple de 6 (11 mangas)
const hnTags = (n: number): string[] => [...(n % 2 === 0 ? ['big breasts'] : []), ...(n % 3 === 0 ? ['vanilla'] : []), 'english']
const hnCard = (n: number): string => `<div class="column"><a href="/view/${16000 + n}"><div class="card"><div class="card-image"><figure class="image"><img src="https://images.hentainexus.com/v2/c/${16000 + n}/thumb.jpg"></figure></div><header class="card-header"><div class="card-header-title">Nexus ${n}</div></header></div></a></div>`
const hnList = (ns: number[], next?: string): string => page(`<div class="container"><div class="columns is-multiline">${ns.map(hnCard).join('')}</div></div>${next ? `<nav class="pagination"><a class="pagination-next" href="${next}">Next page</a></nav>` : ''}`, 'HentaiNexus')
GET[`${HN}/`] = hnList([1, 2, 3, 4, 5, 6])
for (let n = 1; n <= 70; n++) {
    GET[`${HN}/view/${16000 + n}`] = page(`<h1 class="title">Nexus ${n}</h1><table class="view-page-details"><tr><td>Artist</td><td><a href="/?q=artist:%22someone%22">someone</a></td></tr>
<tr><td>Tags</td><td>${hnTags(n).map(t => `<span class="tag"><a href="/?q=tag:%22${t.replace(/ /g, '+')}%22">${t} (1,234)</a></span>`).join('')}</td></tr></table><a href="/read/${16000 + n}">Read Online</a>`)
}
const both = Array.from({ length: 70 }, (_, i) => i + 1).filter(n => n % 6 === 0)
const HN_COMBO = `${HN}/?q=${enc('tag:"big breasts" tag:"vanilla"')}`
GET[HN_COMBO] = hnList(both.slice(0, 6), `/page/2?q=${enc('tag:"big breasts" tag:"vanilla"')}`)
GET[`${HN}/page/2?q=${enc('tag:"big breasts" tag:"vanilla"')}`] = hnList(both.slice(6))
// Pages des tags seuls (ne doivent pas servir)
GET[`${HN}/?q=tag:%22big+breasts%22`] = hnList(Array.from({ length: 35 }, (_, i) => 2 * (i + 1)))
GET[`${HN}/?q=tag:%22vanilla%22`] = hnList(Array.from({ length: 23 }, (_, i) => 3 * (i + 1)))

// ---------- 2. E-Hentai : liens "/tag/female:x", recherche f_search, tags visibles dans la liste ----------
const EH = 'https://e-hentai.org'
const ehRow = (n: number, tags: string[]): string => `<tr><td class="gl2c"><div class="glthumb"><div><img data-src="https://ehgt.org/w/01/${n}-cover.webp" src="data:image/gif;base64,R0lGOD"></div></div></td>
<td class="gl3c glname"><a href="${EH}/g/${4000000 + n}/tok${n}ab/"><div class="glink">EH Gallery ${n}</div><div>${tags.map(t => `<div class="gt" title="female:${t}">${t}</div>`).join('')}<div class="gt" title="language:english">english</div></div></a></td>
<td class="gl4c"><div><a href="${EH}/uploader/someone">someone</a></div></td></tr>`
const ehList = (rows: string, next: string): string => page(`<table class="itg gltc">${rows}</table><script>var nexturl="${next}";</script>`, 'E-Hentai Galleries')
GET[`${EH}/`] = ehList([1, 2, 3].map(n => ehRow(n, ['glasses'])).join(''), '')
GET[`${EH}/g/4000001/tok1ab/`] = page(`<h1 id="gn">EH Gallery 1</h1><div id="taglist"><table><tr><td class="tc">female:</td><td><div class="gt"><a href="${EH}/tag/female:big+breasts">big breasts</a></div><div class="gt"><a href="${EH}/tag/female:glasses">glasses</a></div></td></tr></table></div>`)
const EH_COMBO = `${EH}/?f_search=${enc('female:"big breasts$" female:"glasses$"')}`
GET[EH_COMBO] = ehList(Array.from({ length: 25 }, (_, i) => ehRow(100 + i, ['big breasts', 'glasses', 'stockings'])).join(''), `${EH}/?f_search=x&next=4000100`)
GET[`${EH}/?f_search=x&next=4000100`] = ehList(Array.from({ length: 10 }, (_, i) => ehRow(200 + i, ['glasses', 'big breasts'])).join(''), '')

// ---------- 3. Site dont la recherche ignore les tags ("/?s=a b" renvoie n'importe quoi) ----------
const WP = 'https://wp.test'
const wpTags = (n: number): string[] => [...(n % 2 === 0 ? ['romance'] : []), ...(n % 5 === 0 ? ['action'] : [])]
const wpCard = (n: number): string => `<div class="item"><a href="${WP}/manga/wp-${n}/"><img src="${WP}/c/${n}.jpg" alt="WP ${n}"></a><h3>WP ${n}</h3></div>`
const wpList = (ns: number[], next?: string): string => page(ns.map(wpCard).join('') + (next ? `<a class="next" href="${next}">Next</a>` : ''))
GET[`${WP}/`] = wpList([1, 2, 3])
for (let n = 1; n <= 40; n++) GET[`${WP}/manga/wp-${n}/`] = page(`<h1>WP ${n}</h1><div class="tags">${wpTags(n).map(t => `<a href="/?s=${t}">${t}</a>`).join('')}</div>`)
GET[`${WP}/?s=${enc('romance action')}`] = wpList(Array.from({ length: 20 }, (_, i) => i + 1)) // tout, sans filtre
GET[`${WP}/?s=action`] = wpList([5, 10, 15, 20, 25, 30, 35, 40])
GET[`${WP}/?s=romance`] = wpList(Array.from({ length: 20 }, (_, i) => 2 * (i + 1)))

// ---------- 4. Site sans recherche multi-termes (404) ----------
const NF = 'https://nf.test'
const nfCard = (n: number): string => `<div class="item"><a href="${NF}/manga/nf-${n}/"><img src="${NF}/c/${n}.jpg" alt="NF ${n}"></a><h3>NF ${n}</h3></div>`
GET[`${NF}/`] = page([1, 2, 3].map(nfCard).join(''))
for (let n = 1; n <= 12; n++) GET[`${NF}/manga/nf-${n}/`] = page(`<h1>NF ${n}</h1><div class="tags">${[...(n % 2 === 0 ? ['romance'] : []), ...(n % 3 === 0 ? ['action'] : [])].map(t => `<a href="/search?q=${t}">${t}</a>`).join('')}</div>`)
GET[`${NF}/search?q=romance`] = page([2, 4, 6, 8, 10, 12].map(nfCard).join(''))
GET[`${NF}/search?q=action`] = page([3, 6, 9, 12].map(nfCard).join(''))

// ---------- 5. Tags en chemin simple : on part de la page du tag le plus rare ----------
const RT = 'https://rare.test'
const rtCard = (n: number): string => `<div class="item"><a href="${RT}/manga/rt-${n}/"><img src="${RT}/c/${n}.jpg" alt="RT ${n}"></a><h3>RT ${n}</h3></div>`
GET[`${RT}/`] = page(`<a href="${RT}/tag/common/">Common</a><a href="${RT}/tag/rare/">Rare</a>`)
const common = Array.from({ length: 30 }, (_, i) => i + 1)
const rare = [7, 14, 21, 28, 31]
GET[`${RT}/tag/common/`] = page(common.map(rtCard).join(''))
GET[`${RT}/tag/rare/`] = page(rare.map(rtCard).join(''))
for (const n of [...common, 31]) GET[`${RT}/manga/rt-${n}/`] = page(`<h1>RT ${n}</h1><div class="tags">${[...(n <= 30 ? ['Common'] : []), ...(rare.includes(n) ? ['Rare'] : [])].map(t => `<a href="/tag/${t.toLowerCase()}/">${t}</a>`).join('')}</div>`)

// ---------- 6. Site dont les tags ne sont pas des liens (simples étiquettes sur les fiches) ----------
const PL = 'https://plain.test'
const plTags = (n: number): string[] => [...(n % 2 === 0 ? ['Drama'] : []), ...(n % 3 === 0 ? ['School'] : [])]
const plCard = (n: number): string => `<div class="item"><a href="${PL}/manga/pl-${n}/"><img src="${PL}/c/${n}.jpg" alt="PL ${n}"></a><h3>PL ${n}</h3></div>`
GET[`${PL}/`] = page([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(plCard).join(''))
for (let n = 1; n <= 12; n++) GET[`${PL}/manga/pl-${n}/`] = page(`<h1>PL ${n}</h1><div class="genres">${plTags(n).map(t => `<span>${t}</span>`).join('')}</div>`)

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
    createSourceManga: (i: any) => i, createMangaInfo: (i: any) => i, createHomeSection: (i: any) => i
}

async function main(): Promise<void> {
    const { TagFusion } = await import('../src/TagFusion/TagFusion')
    const { encodeMangaId, tagIdOf, siteTagIdOf } = await import('../src/TagFusion/Utils')
    const src: any = new TagFusion({ load })
    await src.store.setSites([HN, EH, WP, NF, RT, PL])
    await src.discoverAll(true)
    // L'utilisateur a ouvert une fiche sur chaque site : leurs tags (avec leur page) sont connus
    await src.getMangaDetails(encodeMangaId('hentainexus.com', `${HN}/view/16006`))
    await src.getMangaDetails(encodeMangaId('e-hentai.org', `${EH}/g/4000001/tok1ab/`))
    await src.getMangaDetails(encodeMangaId('wp.test', `${WP}/manga/wp-10/`))
    await src.getMangaDetails(encodeMangaId('nf.test', `${NF}/manga/nf-6/`))
    await src.getMangaDetails(encodeMangaId('rare.test', `${RT}/manga/rt-7/`))
    await src.getMangaDetails(encodeMangaId('plain.test', `${PL}/manga/pl-6/`))
    // Quelques fiches déjà lues sur rare.test : « common » y est bien plus fréquent que « rare »
    for (const n of [1, 2, 3, 4, 5]) await src.getMangaDetails(encodeMangaId('rare.test', `${RT}/manga/rt-${n}/`))

    const t = (k: string) => ({ id: tagIdOf(k), label: k })
    const only = (site: string) => ({ id: siteTagIdOf(site), label: site })
    const run = async (tags: any[], excluded: any[] = []): Promise<{ titles: string[], calls: number, fiches: string[] }> => {
        requests.length = 0
        const titles: string[] = []
        let meta: unknown = undefined
        let calls = 0
        do {
            const r = await src.getSearchResults({ includedTags: tags, excludedTags: excluded }, meta)
            titles.push(...r.results.map((m: any) => m.title))
            if (r.metadata !== undefined) assert.ok(r.results.length > 0, `appel ${calls + 1} : page vide en cours de route`)
            meta = r.metadata
            calls++
        } while (meta !== undefined && calls < 40)
        assert.equal(new Set(titles).size, titles.length, `doublons : ${titles.join(', ')}`)
        return { titles, calls, fiches: requests.filter(u => /\/(view|g|manga)\/[^?]+$/.test(u)) }
    }

    // 1. HentaiNexus : la recherche du site fait le travail, quelques fiches vérifiées puis confiance
    const hn = await run([t('big breasts'), t('vanilla'), only('hentainexus.com')])
    assert.deepEqual(hn.titles.sort(), both.map(n => `Nexus ${n}`).sort())
    assert.ok(requests.includes(HN_COMBO), 'recherche du site utilisée')
    assert.ok(!requests.some(u => u === `${HN}/?q=tag:%22big+breasts%22` || u === `${HN}/?q=tag:%22vanilla%22`), 'pages des tags seuls pas utilisées')
    assert.ok(hn.fiches.length <= 7, `fiches lues : ${hn.fiches.length}`)
    console.log(`✓ HentaiNexus « big breasts » + « vanilla » : les ${both.length} mangas via la recherche du site (2 pages), ${hn.fiches.length} fiches vérifiées seulement`)

    // 2. E-Hentai : recherche f_search, tags lus sur la liste -> aucune fiche ouverte
    const eh = await run([t('big breasts'), t('glasses'), only('e-hentai.org')])
    // 35 galeries de la recherche + la galerie 1, déjà ouverte (dans l'index) et qui a les deux tags
    assert.equal(eh.titles.length, 36, `résultats : ${eh.titles.length}`)
    assert.ok(eh.titles.includes('EH Gallery 1'))
    assert.ok(requests.includes(EH_COMBO), 'recherche f_search utilisée')
    assert.equal(eh.fiches.length, 0, `fiches ouvertes : ${eh.fiches.join(', ')}`)
    console.log(`✓ E-Hentai « big breasts » + « glasses » : recherche « f_search » du site, ${eh.titles.length} galeries sur 2 pages, aucune fiche ouverte (tags lus sur la liste)`)

    // 3. Recherche du site qui ignore les tags : détectée, abandonnée, résultats exacts quand même
    const wantWp = Array.from({ length: 40 }, (_, i) => i + 1).filter(n => n % 10 === 0).map(n => `WP ${n}`)
    const wp = await run([t('romance'), t('action'), only('wp.test')])
    assert.deepEqual(wp.titles.sort(), wantWp.sort())
    assert.equal((await src.store.site('wp.test'))?.combo, 'no')
    const wp2 = await run([t('romance'), t('action'), only('wp.test')])
    assert.deepEqual(wp2.titles.sort(), wantWp.sort())
    assert.ok(!requests.includes(`${WP}/?s=${enc('romance action')}`), 'recherche du site plus réessayée')
    console.log(`✓ Site dont la recherche ignore les tags : détecté et mémorisé, les ${wantWp.length} bons mangas trouvés quand même (et la 2e fois sans réessayer)`)

    // 4. Recherche du site absente (404) : repli sur la page du tag, résultats exacts
    const nf = await run([t('romance'), t('action'), only('nf.test')])
    assert.deepEqual(nf.titles.sort(), ['NF 12', 'NF 6'])
    assert.equal((await src.store.site('nf.test'))?.combo, 'no')
    console.log('✓ Site sans recherche multi-termes (404) : repli sur la page du tag, les 2 bons mangas')

    // 5. Tags en chemin simple : départ de la page du tag le plus rare
    const rt = await run([t('common'), t('rare'), only('rare.test')])
    assert.deepEqual(rt.titles.sort(), ['RT 14', 'RT 21', 'RT 28', 'RT 7'])
    assert.ok(requests.includes(`${RT}/tag/rare/`) && !requests.includes(`${RT}/tag/common/`), `pages lues : ${requests.filter(u => /\/tag\//.test(u)).join(', ')}`)
    console.log(`✓ Départ du tag le plus rare : « rare » (5 mangas) plutôt que « common » (30), ${rt.fiches.length} fiche(s) lue(s)`)

    // 6. Tous les sites à la fois : chaque site trouve ses mangas, sans doublon ni page vide en route
    const all = await run([t('romance'), t('action')])
    assert.deepEqual(all.titles.sort(), [...wantWp, 'NF 12', 'NF 6'].sort())
    // Les sites qui n'ont jamais montré ces tags sont quand même fouillés, mais seulement après les autres
    const firstLast = requests.findIndex(u => /hentainexus\.com|e-hentai\.org|rare\.test/.test(u))
    const lastMain = requests.length - 1 - [...requests].reverse().findIndex(u => /wp\.test|nf\.test/.test(u))
    assert.ok(firstLast === -1 || firstLast > lastMain, `ordre : site sans ces tags fouillé (${firstLast}) avant la fin des autres (${lastMain})`)
    const allEh = await run([t('big breasts'), t('glasses')])
    for (const n of [100, 124, 200, 209]) assert.ok(allEh.titles.includes(`EH Gallery ${n}`), `manque EH Gallery ${n}`)
    console.log(`✓ Tous les sites ensemble : résultats complets (${all.titles.length} + ${allEh.titles.length}), sites qui n'ont jamais montré ces tags fouillés en dernier, aucun doublon, aucune page vide en cours de route`)

    // 7. Tags sans lien (étiquettes seules) : connus par les fiches lues, le catalogue est vérifié
    const pl = await run([t('drama'), t('school'), only('plain.test')])
    assert.deepEqual(pl.titles.sort(), ['PL 12', 'PL 6'])
    console.log('✓ Tags sans lien (simples étiquettes) : catalogue vérifié, les 2 bons mangas')

    // 7b. Même tag vu sous deux formes sur un site (étiquette seule, puis lien) : on garde celle qui a une page
    await src.store.addTags('nf.test', [{ label: 'Comedy', url: '' }])
    await src.store.addTags('nf.test', [{ label: 'comedy', url: `${NF}/search?q=comedy` }])
    assert.equal((await src.store.unified())['comedy']?.sites['nf.test']?.url, `${NF}/search?q=comedy`)
    console.log('✓ Tag vu sous deux formes sur un site : la forme avec une page est gardée')

    // 8. Avec un tag exclu : la recherche du site sert de départ, mais chaque fiche est vérifiée
    const ex = await run([t('big breasts'), t('vanilla'), only('hentainexus.com')], [t('english')])
    assert.equal(ex.titles.length, 0, `aucun manga sans « english » : ${ex.titles.join(', ')}`)
    console.log('✓ Avec un tag exclu : chaque résultat est vérifié (aucun faux positif)')
}
main().then(() => console.log('\nRecherche à plusieurs tags par les sites : tout est bon')).catch(e => { console.error('ÉCHEC :', e); process.exit(1) })
