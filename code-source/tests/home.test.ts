// Page d'accueil : npx tsx --tsconfig tests/tsconfig.json tests/home.test.ts
import assert from 'node:assert/strict'
import { load } from './shim/minicheerio'

const GET: Record<string, string> = {}
const requests: string[] = []
const page = (body: string, title = 'Site'): string => `<html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`
const card = (site: string, slug: string, title: string): string =>
    `<div class="item"><a href="https://${site}/manga/${slug}/"><img src="https://${site}/c/${slug}.jpg" alt="${title}"></a><h3>${title}</h3></div>`

// Deux sites ; le site A a un catalogue /manga/ paginé par « ?page=N » (lien suivant), une page de tag paginée
GET['https://aaa.test/'] = page('<a href="https://aaa.test/tag/romance/">Romance</a>' + [1, 2, 3, 4, 5].map(n => card('aaa.test', `new${n}`, `A Nouveau ${n}`)).join(''), 'Alpha Scans - accueil')
GET['https://aaa.test/manga/'] = page([1, 2, 3, 4].map(n => card('aaa.test', `cat${n}`, `A Catalogue ${n}`)).join('') + '<a rel="next" href="/manga/?page=2">Suivant</a>')
GET['https://aaa.test/manga/?page=2'] = page([5, 6, 7, 8].map(n => card('aaa.test', `cat${n}`, `A Catalogue ${n}`)).join(''))
GET['https://aaa.test/tag/romance/'] = page([1, 2, 3, 4].map(n => card('aaa.test', `rom${n}`, `A Romance ${n}`)).join('') + '<a class="next" href="/tag/romance/?page=2">Next</a>')
GET['https://aaa.test/tag/romance/?page=2'] = page([5, 6].map(n => card('aaa.test', `rom${n}`, `A Romance ${n}`)).join(''))
GET['https://bbb.test/'] = page([1, 2, 3, 4].map(n => card('bbb.test', `new${n}`, `B Nouveau ${n}`)).join(''), 'Beta Manga')

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
    createTag: (i: any) => i, createTagSection: (i: any) => i, createPagedResults: (i: any) => ({ results: [], ...i }),
    createPartialSourceManga: (i: any) => i, createHomeSection: (i: any) => i
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function main(): Promise<void> {
    const { TagFusion } = await import('../src/TagFusion/TagFusion')
    const { encodeMangaId } = await import('../src/TagFusion/Utils')
    const src: any = new TagFusion({ load })
    await src.store.setSites(['https://aaa.test', 'https://bbb.test'])

    // --- Premier lancement : index vide -> « À la une » annoncé en haut, puis rempli avec les nouveautés ---
    const first: any[] = []
    await src.getHomePageSections((s: any) => first.push(JSON.parse(JSON.stringify(s))))
    assert.equal(first[0].id, 'home_featured', 'À la une en premier')
    const finalFeatured = first.filter(s => s.id === 'home_featured').pop()
    assert.ok(finalFeatured.items.length >= 8, `À la une rempli (${finalFeatured.items.length})`)
    assert.ok(finalFeatured.items.some((i: any) => i.subtitle === 'Alpha Scans') && finalFeatured.items.some((i: any) => i.subtitle === 'Beta Manga'), 'les deux sites mélangés')
    assert.deepEqual(first.map(s => s.title), ['À la une', 'Nouveautés · Alpha Scans', 'Nouveautés · Beta Manga'], 'ordre exact, une seule fois chacune')
    assert.ok(first.every(s => s.items.length > 0), 'aucune section vide')
    console.log(`✓ Premier lancement (index vide) : « À la une » en haut, rempli avec ${finalFeatured.items.length} nouveautés des 2 sites ; rangées « Nouveautés · site »`)

    // --- Index rempli (comme après quelques lectures) ---
    const entries = []
    const tagsFor = (n: number): string[] => [
        'English', 'Translated', // tags trop généraux : jamais de rangée
        ...(n % 2 === 0 ? ['Romance'] : []), ...(n % 3 === 0 ? ['Comedy'] : []), ...(n <= 4 ? ['Office'] : [])
    ]
    for (let n = 1; n <= 12; n++) {
        const site = n % 2 ? 'aaa.test' : 'bbb.test'
        entries.push({ id: encodeMangaId(site, `https://${site}/manga/idx${n}/`), entry: { s: site, u: `https://${site}/manga/idx${n}/`, t: `Indexé ${n}`, i: `https://${site}/c/idx${n}.jpg`, l: tagsFor(n) } })
    }
    await src.store.indexMany(entries)
    await sleep(1600)

    const sections: any[] = []
    await src.getHomePageSections((s: any) => sections.push(JSON.parse(JSON.stringify(s))))
    const ids = sections.map(s => s.id)
    assert.equal(ids[0], 'home_featured')
    assert.equal(sections[0].type, 'featured')
    assert.equal(sections[0].items.length, 12)
    const tagRows = sections.filter(s => s.id.startsWith('home_tag_'))
    assert.deepEqual(tagRows.map(s => s.title), ['Romance', 'Comedy', 'Office Workers'], `rangées : ${tagRows.map(s => s.title).join(', ')}`)
    assert.ok(!sections.some(s => /english|translated/i.test(s.title)), 'pas de rangée « English » ni « Translated »')
    const lastTag = ids.lastIndexOf(tagRows[tagRows.length - 1].id)
    const firstSite = ids.findIndex(i => i.startsWith('home_site_'))
    assert.ok(lastTag < firstSite, 'les tags avant les nouveautés des sites')
    assert.equal(tagRows[0].items.length, 6)
    assert.ok(tagRows[0].items.every((i: any) => /^Indexé (2|4|6|8|10|12)$/.test(i.title)), 'la rangée Romance ne contient que des mangas Romance')
    for (const s of sections) {
        if (s.items.length) assert.equal(new Set(s.items.map((i: any) => i.mangaId)).size, s.items.length, `doublon dans ${s.title}`)
    }
    console.log('✓ Accueil : « À la une » (12, depuis l\'index) puis rangées Romance, Comedy, Office Workers (tags généraux exclus), puis nouveautés')

    // --- « Voir plus » d'un tag : la recherche sur tous les sites, page après page ---
    await src.discoverAll(true)
    const romanceId = tagRows[0].id
    let vm = await src.getViewMoreItems(romanceId, undefined)
    const seenTitles = vm.results.map((r: any) => r.title)
    let guard = 0
    while (vm.metadata !== undefined && guard++ < 10) {
        vm = await src.getViewMoreItems(romanceId, vm.metadata)
        seenTitles.push(...vm.results.map((r: any) => r.title))
    }
    for (let n = 1; n <= 6; n++) assert.ok(seenTitles.includes(`A Romance ${n}`), `manque A Romance ${n}`)
    for (const n of [2, 4, 6, 8, 10, 12]) assert.ok(seenTitles.includes(`Indexé ${n}`), `manque Indexé ${n}`)
    console.log(`✓ « Voir plus » d'un tag : ${seenTitles.length} mangas (index + page du tag sur 2 pages), défilement jusqu'au bout`)

    // --- « Voir plus » de « À la une » : tout l'index ---
    const vf = await src.getViewMoreItems('home_featured', undefined)
    assert.equal(vf.results.length, 12)
    assert.equal(vf.metadata, undefined)
    console.log('✓ « Voir plus » de « À la une » : tout l\'index')

    // --- « Voir plus » d'un site : catalogue page 1, page 2 (lien suivant), puis fin ---
    const siteRow = sections.find(s => s.title === 'Nouveautés · Alpha Scans')
    const p1 = await src.getViewMoreItems(siteRow.id, undefined)
    assert.deepEqual(p1.results.map((r: any) => r.title), [1, 2, 3, 4].map(n => `A Catalogue ${n}`))
    const p2 = await src.getViewMoreItems(siteRow.id, p1.metadata)
    assert.deepEqual(p2.results.map((r: any) => r.title), [5, 6, 7, 8].map(n => `A Catalogue ${n}`))
    assert.equal(p2.metadata, undefined, 'fin du catalogue')
    console.log('✓ « Voir plus » d\'un site : catalogue page 1 puis page 2 (vraie pagination), puis fin')

    // --- Ancien identifiant de rangée (versions précédentes) : toujours compris ---
    const { safeEncode } = await import('../src/TagFusion/Utils')
    const legacy = await src.getViewMoreItems('home_' + safeEncode('bbb.test'), undefined)
    assert.ok(legacy.results.length >= 1)
    console.log('✓ Ancien identifiant de rangée : toujours compris')

    // --- Écran des tags : pas de section « # », pas de faux tags ---
    await src.store.addTags('aaa.test', ['+22 more pages', '1', '» Prev', '(Shoujo)', '3D', 'Show More', '12 pages', 'Vanilla']
        .map(l => ({ label: l, url: `https://aaa.test/tag/${encodeURIComponent(l)}/` })))
    const screen = await src.getSearchTags()
    const letterSections = screen.filter((x: any) => x.id.startsWith('letter_'))
    assert.ok(!screen.some((x: any) => x.label === '#'), 'pas de section #')
    assert.ok(letterSections.every((x: any) => /^[A-Z]$/.test(x.label)), 'seulement des lettres')
    const all = letterSections.flatMap((x: any) => x.tags.map((t: any) => t.label))
    for (const bad of ['+22 more pages', '1', '» Prev', 'Show More', '12 pages', '3D']) assert.ok(!all.includes(bad), `« ${bad} » ne doit pas apparaître`)
    assert.ok(letterSections.find((x: any) => x.label === 'S').tags.some((t: any) => t.label === 'Shoujo'), '« (Shoujo) » rangé sous S, sans parenthèses')
    assert.ok(letterSections.find((x: any) => x.label === 'V').tags.some((t: any) => t.label === 'Vanilla'))
    console.log('✓ Écran des tags : plus de section « # », faux tags retirés, « (Shoujo) » rangé sous S')

    // --- Aucune requête après la réponse ---
    requests.length = 0
    await src.getHomePageSections(() => undefined)
    const after = requests.length
    await sleep(300)
    assert.equal(requests.length, after)
    console.log('✓ Aucune requête après la réponse à l\'app')

    // --- Un site en panne : les autres rangées s'affichent quand même ---
    delete GET['https://bbb.test/']
    src.htmlCache.clear() // la page d'accueil du site était en cache (1 min)
    const withDown: any[] = []
    await src.getHomePageSections((s: any) => withDown.push(s))
    assert.ok(withDown.some(s => s.title === 'Nouveautés · Alpha Scans'))
    assert.ok(!withDown.some(s => s.title === 'Nouveautés · Beta Manga'))
    assert.ok(withDown.every(s => s.items.length > 0), 'aucune rangée vide')
    console.log('✓ Un site en panne : le reste de l\'accueil s\'affiche, aucune rangée vide')
}
main().then(() => console.log('\nPage d\'accueil : tout est bon')).catch(e => { console.error('ÉCHEC :', e); process.exit(1) })
