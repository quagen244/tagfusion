// Recherche avec plusieurs tags touchés rapidement : npx tsx --tsconfig tests/tsconfig.json tests/multitag.test.ts
import assert from 'node:assert/strict'
import { load } from './shim/minicheerio'

const GET: Record<string, string> = {}
const requests: string[] = []
const page = (body: string, title = 'Site'): string => `<html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`

// 4 sites ; chacun a 60 mangas ; tags Alpha (n pair), Beta (n multiple de 3), Gamma (n multiple de 5).
// Chaque tag a sa page (10 mangas par page, lien « Next »), mais aucun site ne sait filtrer plusieurs tags à la fois.
const SITES = ['s1', 's2', 's3', 's4']
const TAGS: Record<string, (n: number) => boolean> = { alpha: n => n % 2 === 0, beta: n => n % 3 === 0, gamma: n => n % 5 === 0 }
const label = (k: string): string => k[0]!.toUpperCase() + k.slice(1)
for (const s of SITES) {
    const host = `${s}.test`
    GET[`https://${host}/`] = page(Object.keys(TAGS).map(k => `<a href="https://${host}/tag/${k}/">${label(k)}</a>`).join(''), `${s.toUpperCase()} Scans`)
    for (const [k, has] of Object.entries(TAGS)) {
        const list = Array.from({ length: 60 }, (_, i) => i + 1).filter(has)
        const pages = Math.ceil(list.length / 10)
        for (let p = 1; p <= pages; p++) {
            const url = p === 1 ? `https://${host}/tag/${k}/` : `https://${host}/tag/${k}/?page=${p}`
            const cards = list.slice((p - 1) * 10, p * 10).map(n => `<div class="item"><a href="https://${host}/manga/${s}-${n}/"><img src="https://${host}/c/${n}.jpg" alt="${s.toUpperCase()} ${n}"></a><h3>${s.toUpperCase()} ${n}</h3></div>`).join('')
            GET[url] = page(cards + (p < pages ? `<a class="next" href="/tag/${k}/?page=${p + 1}">Next</a>` : ''))
        }
    }
    for (let n = 1; n <= 60; n++) {
        const tags = Object.keys(TAGS).filter(k => TAGS[k]!(n))
        GET[`https://${host}/manga/${s}-${n}/`] = page(`<h1>${s.toUpperCase()} ${n}</h1><div class="tags">${tags.map(k => `<a href="/tag/${k}/">${label(k)}</a>`).join('')}</div>`)
    }
}

const mem = new Map<string, unknown>()
;(globalThis as any).App = {
    createSourceStateManager: () => ({ keychain: {}, store: async (k: string, v: unknown) => { mem.set(k, JSON.parse(JSON.stringify(v))) }, retrieve: async (k: string) => mem.get(k) }),
    createRequestManager: (info: any) => ({
        ...info, getDefaultUserAgent: async () => 'UA',
        schedule: async (req: any) => {
            const r = await info.interceptor.interceptRequest(req)
            requests.push(r.url)
            await new Promise(res => setTimeout(res, 2)) // un peu de latence réseau
            const body = GET[r.url]
            return body !== undefined ? { status: 200, headers: {}, data: body, request: r } : { status: 404, headers: {}, data: '', request: r }
        }
    }),
    createRequest: (i: any) => ({ headers: {}, cookies: [], ...i }),
    createTag: (i: any) => i, createTagSection: (i: any) => i, createPagedResults: (i: any) => ({ results: [], ...i }),
    createPartialSourceManga: (i: any) => i, createHomeSection: (i: any) => i
}

const isFiche = (u: string): boolean => /\/manga\/s\d-\d+\/$/.test(u)

async function main(): Promise<void> {
    const { TagFusion } = await import('../src/TagFusion/TagFusion')
    const { tagIdOf } = await import('../src/TagFusion/Utils')
    const src: any = new TagFusion({ load })
    await src.store.setSites(SITES.map(s => `https://${s}.test`))
    await src.discoverAll(true)
    const t = (k: string) => ({ id: tagIdOf(k), label: label(k) })

    // --- Trois tags touchés coup sur coup : trois recherches lancées presque en même temps ---
    requests.length = 0
    const p1 = src.getSearchResults({ includedTags: [t('alpha')], excludedTags: [] }, undefined)
    await new Promise(r => setTimeout(r, 5))
    const p2 = src.getSearchResults({ includedTags: [t('alpha'), t('beta')], excludedTags: [] }, undefined)
    await new Promise(r => setTimeout(r, 5))
    const p3 = src.getSearchResults({ includedTags: [t('alpha'), t('beta'), t('gamma')], excludedTags: [] }, undefined)
    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    assert.equal(r2.results.length, 0, 'la recherche Alpha+Beta, remplacée, s\'arrête')
    assert.equal(r2.metadata, undefined)
    assert.equal(r1.metadata, undefined, 'la recherche Alpha, remplacée, ne continue pas')
    const fiches = requests.filter(isFiche).length
    assert.ok(fiches <= 45, `trop de fiches lues pendant les 3 recherches : ${fiches}`)
    console.log(`✓ 3 tags touchés coup sur coup : les 2 recherches remplacées s'arrêtent, ${fiches} fiches lues au total (plafond respecté)`)

    // --- La dernière recherche (Alpha+Beta+Gamma) va jusqu'au bout en faisant défiler ---
    const want3 = new Set(SITES.flatMap(s => [30, 60].map(n => `${s.toUpperCase()} ${n}`)))
    const got3: string[] = r3.results.map((m: any) => m.title)
    let meta = r3.metadata
    let calls = 1
    while (meta !== undefined && calls < 60) {
        requests.length = 0
        const r = await src.getSearchResults({ includedTags: [t('alpha'), t('beta'), t('gamma')], excludedTags: [] }, meta)
        assert.ok(requests.filter(isFiche).length <= 40, `appel ${calls} : ${requests.filter(isFiche).length} fiches lues (plafond 40)`)
        got3.push(...r.results.map((m: any) => m.title))
        meta = r.metadata
        calls++
    }
    assert.deepEqual([...new Set(got3)].sort(), [...want3].sort())
    assert.equal(new Set(got3).size, got3.length, 'aucun doublon')
    console.log(`✓ Alpha + Beta + Gamma : les ${want3.size} mangas des 4 sites trouvés en ${calls} appels, chacun plafonné à 40 fiches`)

    // --- Nouvelle recherche Alpha + Beta : tout vient de l'index (fiches déjà lues), rien n'est perdu ---
    const want2 = new Set(SITES.flatMap(s => [6, 12, 18, 24, 30, 36, 42, 48, 54, 60].map(n => `${s.toUpperCase()} ${n}`)))
    requests.length = 0
    const got2: string[] = []
    meta = undefined
    calls = 0
    do {
        const r = await src.getSearchResults({ includedTags: [t('alpha'), t('beta')], excludedTags: [] }, meta)
        got2.push(...r.results.map((m: any) => m.title))
        meta = r.metadata
        calls++
    } while (meta !== undefined && calls < 60)
    assert.deepEqual([...new Set(got2)].sort(), [...want2].sort())
    const reRead = requests.filter(isFiche)
    const dup = reRead.filter((u, i) => reRead.indexOf(u) !== i)
    assert.equal(dup.length, 0, `fiches lues deux fois : ${dup.slice(0, 3).join(', ')}`)
    console.log(`✓ Alpha + Beta : les ${want2.size} mangas trouvés, aucune fiche lue deux fois (${reRead.length} nouvelle(s) lecture(s), le reste depuis l'index)`)

    // --- Exclusion : Alpha sans Beta ---
    const wantEx = new Set(SITES.flatMap(s => Array.from({ length: 60 }, (_, i) => i + 1).filter(n => n % 2 === 0 && n % 3 !== 0).map(n => `${s.toUpperCase()} ${n}`)))
    const gotEx: string[] = []
    meta = undefined
    calls = 0
    do {
        const r = await src.getSearchResults({ includedTags: [t('alpha')], excludedTags: [t('beta')] }, meta)
        gotEx.push(...r.results.map((m: any) => m.title))
        meta = r.metadata
        calls++
    } while (meta !== undefined && calls < 80)
    assert.deepEqual([...new Set(gotEx)].sort(), [...wantEx].sort())
    console.log(`✓ Alpha sans Beta : les ${wantEx.size} mangas trouvés, aucun avec Beta`)

    // --- Un seul tag : liste simple, rapide (aucune fiche à lire) ---
    requests.length = 0
    const one = await src.getSearchResults({ includedTags: [t('gamma')], excludedTags: [] }, undefined)
    assert.ok(one.results.length >= 24)
    assert.equal(requests.filter(isFiche).length, 0)
    console.log(`✓ Un seul tag : ${one.results.length} mangas sans ouvrir une seule fiche`)
}
main().then(() => console.log('\nRecherche multi-tags : tout est bon')).catch(e => { console.error('ÉCHEC :', e); process.exit(1) })
