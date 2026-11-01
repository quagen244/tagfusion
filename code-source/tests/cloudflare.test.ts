// Test du parcours Cloudflare avec une fausse app Paperback : npx tsx --tsconfig tests/tsconfig.json tests/cloudflare.test.ts
import assert from 'node:assert/strict'

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Paperback'
const sent: any[] = []
let blockedHosts = new Set(['bloque.com', 'autre.net'])

// Faux site : renvoie le défi Cloudflare tant que le site est "bloqué", sauf si le cookie et le bon UA sont là
function fakeServer(req: any): any {
    const host = new URL(req.url).hostname.replace(/^www\./, '')
    if (blockedHosts.has(host)) {
        return { status: 403, headers: { server: 'cloudflare' }, data: '<html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/x"></script></html>', request: req }
    }
    return { status: 200, headers: {}, data: '<html><body>ok</body></html>', request: req }
}

const mem = new Map<string, unknown>()
;(globalThis as any).App = {
    createSourceStateManager: () => ({ keychain: {}, store: async (k: string, v: unknown) => { mem.set(k, JSON.parse(JSON.stringify(v))) }, retrieve: async (k: string) => mem.get(k) }),
    createRequestManager: (info: any) => ({
        ...info,
        getDefaultUserAgent: async () => UA,
        schedule: async (req: any) => {
            const r = info.interceptor ? await info.interceptor.interceptRequest(req) : req
            sent.push(JSON.parse(JSON.stringify(r)))
            return fakeServer(r)
        }
    }),
    createRequest: (i: any) => ({ headers: {}, cookies: [], ...i }),
    createTag: (i: any) => i, createTagSection: (i: any) => i, createPagedResults: (i: any) => ({ results: [], ...i }),
    createPartialSourceManga: (i: any) => i, createHomeSection: (i: any) => i
}

async function main(): Promise<void> {
    const { TagFusion } = await import('../src/TagFusion/TagFusion')
    const src: any = new TagFusion({ load: () => { throw new Error('pas de HTML à lire dans ce test') } })
    await src.store.setSites(['https://bloque.com', 'https://autre.net', 'https://libre.org'])

    // 1. Chaque requête porte le User-Agent de Paperback et un Referer
    await src.http('GET', 'https://libre.org/')
    assert.equal(sent.at(-1).headers['user-agent'], UA)
    assert.equal(sent.at(-1).headers['referer'], 'https://libre.org/')
    console.log('✓ User-Agent de Paperback envoyé avec chaque requête')

    // 2. Un site sous Cloudflare est détecté, mémorisé, avec un message clair
    await assert.rejects(src.http('GET', 'https://bloque.com/'), /Cloudflare bloque bloque\.com.*nuage/)
    await assert.rejects(src.http('GET', 'https://autre.net/manga/x/'), /Cloudflare bloque autre\.net.*2 sites/)
    assert.deepEqual(await src.store.getCloudflareBlocked(), ['https://bloque.com', 'https://autre.net'])
    console.log('✓ Sites bloqués détectés et mémorisés (plusieurs à la fois)')

    // 3. Le bouton nuage ouvre le premier site bloqué, avec le même User-Agent
    let bypass = await src.getCloudflareBypassRequestAsync()
    assert.equal(bypass.url, 'https://bloque.com/')
    assert.equal(bypass.headers['user-agent'], UA)
    assert.equal(src.getCloudflareBypassRequest().url, 'https://bloque.com/')
    console.log('✓ Bypass : premier site bloqué, même User-Agent (versions async et sync)')

    // 4. Après le bypass, le site répond : il sort de la liste, le nuage passe au suivant
    blockedHosts.delete('bloque.com')
    await src.http('GET', 'https://bloque.com/page-2/')
    assert.deepEqual(await src.store.getCloudflareBlocked(), ['https://autre.net'])
    bypass = await src.getCloudflareBypassRequestAsync()
    assert.equal(bypass.url, 'https://autre.net/')
    console.log('✓ Site débloqué retiré, le nuage passe au site suivant')

    // 5. Tout est débloqué : plus rien en attente
    blockedHosts = new Set()
    await src.http('GET', 'https://autre.net/x/')
    assert.deepEqual(await src.store.getCloudflareBlocked(), [])
    console.log('✓ Plus aucun site bloqué')

    // 6. La liste survit à un redémarrage de l'extension
    blockedHosts.add('libre.org')
    await assert.rejects(src.http('GET', 'https://libre.org/z/'))
    const again: any = new TagFusion({})
    assert.deepEqual(await again.store.getCloudflareBlocked(), ['https://libre.org'])
    console.log('✓ Liste des sites bloqués conservée après redémarrage')

    // 7. Écran de recherche sans site : jamais de liste vide
    const fresh: any = new TagFusion({})
    mem.delete('tf_sites')
    const sections = await fresh.getSearchTags()
    assert.equal(sections.length, 1)
    assert.ok(sections[0].tags.length > 0)
    console.log('✓ Écran de recherche sans site : une section non vide')

    // 8. Page d'accueil : une erreur de site ne fait rien planter et ne crée pas de section vide
    const calls: any[] = []
    await src.store.setSites(['https://libre.org'])
    await src.getHomePageSections((s: any) => calls.push(s))
    assert.equal(calls.length, 0)
    console.log('✓ Page d\'accueil : site bloqué ignoré proprement, aucune section vide')
}
main().then(() => console.log('\nParcours Cloudflare : tout est bon')).catch(e => { console.error('ÉCHEC :', e); process.exit(1) })
