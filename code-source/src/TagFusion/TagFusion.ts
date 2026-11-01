import {
    BadgeColor,
    Chapter,
    ChapterDetails,
    ContentRating,
    DUISection,
    HomeSection,
    HomeSectionType,
    PagedResults,
    PartialSourceManga,
    Request,
    Response,
    SearchRequest,
    Source,
    SourceInterceptor,
    SourceInfo,
    SourceIntents,
    SourceManga,
    Tag,
    TagSection
} from '@paperback/types'
import { CheerioAPI } from 'cheerio'
import { Details, detectEngine, Engine, engineByName, Fetcher, ListingItem } from './Engines'
import { buildSettings } from './Settings'
import { SiteTag, Store, UnifiedTag } from './Store'
import {
    decodeChapterId, decodeMangaId, encodeChapterId, encodeMangaId, hostOf, interleave, keyOfTagId,
    mapLimit, safeDate, safeEncode, safeDecode, safeNumber, safeUrl, siteIdOf, siteOfTagId, siteTagIdOf, sitesFromVersioning, tagIdOf, titleKey
} from './Utils'

export const TagFusionInfo: SourceInfo = {
    version: '1.1.0',
    name: 'TagFusion',
    icon: 'icon.png',
    author: 'Toi',
    description: 'Recherche par tags sur plusieurs sites à la fois, avec tous les tags des fiches fusionnés en une seule liste.',
    contentRating: ContentRating.MATURE,
    websiteBaseURL: 'https://paperback.moe',
    sourceTags: [
        { text: 'Multi-sources', type: BadgeColor.BLUE },
        { text: 'Tags fusionnés', type: BadgeColor.GREEN }
    ],
    // HOMEPAGE_SECTIONS fait apparaître la page d'accueil de l'extension, avec l'icône nuage ☁️ du bypass Cloudflare
    intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.HOMEPAGE_SECTIONS | SourceIntents.SETTINGS_UI | SourceIntents.CLOUDFLARE_BYPASS_REQUIRED
}

/** Où on en est sur chaque site pendant un défilement de résultats */
interface SearchMeta {
    sites: Record<string, { page: number, done: boolean, firstUrl?: string }>
    seen: string[]
}

const DISCOVERY_BUDGET_MS = 12000

/**
 * Ajoute à chaque requête :
 *  - le User-Agent du navigateur de Paperback. Indispensable pour Cloudflare : le cookie obtenu
 *    avec le bypass n'est valable qu'avec CE User-Agent, sinon le site bloque encore.
 *  - le Referer attendu par les sites (et leurs serveurs d'images).
 */
class SiteInterceptor implements SourceInterceptor {
    constructor(
        private readonly referers: Map<string, string>,
        private readonly userAgent: () => Promise<string | undefined>
    ) {}

    async interceptRequest(request: Request): Promise<Request> {
        const headers = request.headers ?? {}
        if (!headers['user-agent'] && !headers['User-Agent']) {
            const ua = await this.userAgent()
            if (ua) headers['user-agent'] = ua
        }
        if (!headers['referer'] && !headers['Referer']) {
            const origin = (/^https?:\/\/[^/]+/i.exec(request.url) ?? [''])[0]
            headers['referer'] = this.referers.get(hostOf(request.url)) ?? `${origin}/`
        }
        // Il faut réassigner l'objet pour que l'app voie la modification
        request.headers = headers
        return request
    }

    async interceptResponse(response: Response): Promise<Response> {
        return response
    }
}

export class TagFusion extends Source {
    stateManager = App.createSourceStateManager()
    store = new Store(this.stateManager)

    /** hôte des images -> site d'origine (pour l'en-tête Referer, exigé par beaucoup de sites) */
    private imageReferers = new Map<string, string>()
    private htmlCache = new Map<string, { html: string, at: number }>()
    private detailsCache = new Map<string, Details>()
    private cachedUserAgent?: string

    requestManager = App.createRequestManager({
        // Pas trop vite : un rythme élevé déclenche lui-même les protections Cloudflare
        requestsPerSecond: 5,
        requestTimeout: 20000,
        interceptor: new SiteInterceptor(this.imageReferers, () => this.userAgent())
    })

    /** User-Agent du navigateur intégré de Paperback (celui qui résout le défi Cloudflare) */
    private async userAgent(): Promise<string | undefined> {
        if (this.cachedUserAgent) return this.cachedUserAgent
        try {
            this.cachedUserAgent = await this.requestManager.getDefaultUserAgent()
        } catch { /* l'app fournira le sien */ }
        return this.cachedUserAgent
    }

    private readonly fetcher: Fetcher = {
        get: (url, headers) => this.http('GET', url, undefined, headers),
        post: (url, body, headers) => this.http('POST', url, body, headers),
        load: html => this.cheerio.load(html) as CheerioAPI
    }

    // =========================================================================
    // Réseau
    // =========================================================================

    private async http(method: string, url: string, data?: string, headers: Record<string, string> = {}): Promise<string> {
        if (method === 'GET') {
            const cached = this.htmlCache.get(url)
            if (cached && Date.now() - cached.at < 60000) return cached.html
        }
        const response = await this.requestManager.schedule(App.createRequest({ url, method, headers, ...(data !== undefined ? { data } : {}) }), 1)
        const html = response.data ?? ''
        const host = hostOf(url)
        if ((response.status === 403 || response.status === 503) &&
            (/cf-chl|challenge-platform|just a moment|cf_clearance/i.test(html) || /cloudflare/i.test(String(response.headers?.['server'] ?? response.headers?.['Server'] ?? '')))) {
            const blocked = await this.store.getCloudflareBlocked()
            const base = (await this.store.getSiteInfo())[host]?.base ?? (/^https?:\/\/[^/]+/i.exec(url) ?? [url])[0]
            await this.store.markCloudflareBlocked(base)
            const n = blocked.length
            throw new Error(`Cloudflare bloque ${host}. Ouvre la page d'accueil de TagFusion, touche l'icône nuage ☁️ en haut, attends que le site s'affiche, puis reviens.${n > 1 ? ` ${n} sites sont à débloquer : refais-le pour chacun.` : ''}`)
        }
        if (response.status >= 400) throw new Error(`${host} a répondu ${response.status}`)
        // Le site répond normalement : s'il était bloqué par Cloudflare, il ne l'est plus
        await this.store.markCloudflareOk(host)
        if (method === 'GET') {
            this.htmlCache.set(url, { html, at: Date.now() })
            if (this.htmlCache.size > 40) {
                const oldest = this.htmlCache.keys().next().value
                if (oldest !== undefined) this.htmlCache.delete(oldest)
            }
        }
        return html
    }

    private async baseOf(siteId: string): Promise<string> {
        return (await this.store.site(siteId))?.base ?? `https://${siteId}`
    }

    /** Moteur du site (détecté une fois, puis mémorisé) */
    private async engineOf(siteId: string): Promise<Engine> {
        const info = await this.store.site(siteId)
        if (info?.engine) return engineByName(info.engine)
        const base = info?.base ?? `https://${siteId}`
        const html = await this.fetcher.get(`${base}/`)
        const engine = detectEngine(html)
        const $ = this.fetcher.load(html)
        const name = ($('meta[property="og:site_name"]').attr('content') ?? $('title').first().text().split(/[-|–]/)[0] ?? siteId).trim() || siteId
        await this.store.updateSite(siteId, { base, engine: engine.name, name })
        return engine
    }

    // =========================================================================
    // Découverte des tags
    // =========================================================================

    private async discoverSite(siteId: string, deadline: number): Promise<void> {
        try {
            const engine = await this.engineOf(siteId)
            const base = await this.baseOf(siteId)
            for (const page of engine.discoveryPages(base)) {
                // Le minuteur n'existe pas dans Paperback 0.8 : on vérifie l'heure entre deux pages
                if (Date.now() > deadline) return
                try {
                    const $ = this.fetcher.load(await this.fetcher.get(page))
                    await this.store.addTags(siteId, engine.parseTags($, page, base, false))
                } catch { /* page absente sur ce site : normal */ }
            }
            await this.store.updateSite(siteId, { discoveredAt: Date.now(), error: undefined })
        } catch (e) {
            await this.store.updateSite(siteId, { error: e instanceof Error ? e.message : String(e) })
        }
    }

    async discoverAll(force: boolean, deadline = Number.MAX_SAFE_INTEGER): Promise<void> {
        const sites = (await this.store.getSites()).map(siteIdOf)
        const info = await this.store.getSiteInfo()
        const todo = sites.filter(id => force || !info[id]?.discoveredAt)
        if (force) for (const id of todo) await this.store.updateSite(id, { engine: undefined })
        await mapLimit(todo, 3, id => this.discoverSite(id, deadline))
    }

    /** Ajoute à « Mes sites » tous les sites listés dans les dépôts d'extensions de l'utilisateur */
    async importRepos(): Promise<number> {
        const repos = await this.store.getRepos()
        if (repos.length === 0) return 0
        const current = await this.store.getSites()
        const found: string[] = []
        for (const repo of repos) {
            try {
                const json = JSON.parse(await this.fetcher.get(repo)) as unknown
                const sites = sitesFromVersioning(json)
                found.push(...sites)
                await this.debug(`dépôt ${repo.replace(/^https?:\/\//, '').replace(/\/versioning\.json$/, '')} : ${sites.length} site(s)`)
            } catch (e) {
                await this.debug(`dépôt ${repo} illisible : ${e instanceof Error ? e.message : String(e)}`)
            }
        }
        const known = new Set(current.map(siteIdOf))
        const added = found.filter(b => !known.has(siteIdOf(b)) && (known.add(siteIdOf(b)), true))
        if (added.length) await this.store.setSites([...current, ...added])
        await this.store.setReposImportedAt(Date.now())
        await this.debug(`import des dépôts : ${added.length} nouveau(x) site(s)`)
        return added.length
    }

    /** Réimporte les dépôts une fois par jour au plus */
    private async importReposIfDue(): Promise<void> {
        if ((await this.store.getRepos()).length === 0) return
        if (Date.now() - await this.store.getReposImportedAt() < 864e5) return
        await this.importRepos()
    }

    /** Lit une fiche, et en profite pour apprendre ses tags */
    private async fetchDetails(siteId: string, url: string): Promise<Details> {
        const cached = this.detailsCache.get(url)
        if (cached) return cached
        const engine = await this.engineOf(siteId)
        const base = await this.baseOf(siteId)
        const $ = this.fetcher.load(await this.fetcher.get(url))
        const details = engine.parseDetails($, url, base)
        this.store.addTags(siteId, details.tags).catch(() => undefined)
        this.detailsCache.set(url, details)
        if (this.detailsCache.size > 300) {
            const oldest = this.detailsCache.keys().next().value
            if (oldest !== undefined) this.detailsCache.delete(oldest)
        }
        return details
    }

    // =========================================================================
    // Interface Paperback : réglages et tags
    // =========================================================================

    override async getSourceMenu(): Promise<DUISection> {
        return buildSettings(this.store, {
            discoverAll: force => this.discoverAll(force),
            importRepos: async () => { await this.importRepos(); await this.discoverAll(false) }
        })
    }

    /**
     * Appelée quand on touche l'icône nuage ☁️ : l'app ouvre ce site dans son navigateur,
     * on résout le défi, et Paperback garde le cookie Cloudflare pour les requêtes suivantes.
     * On propose le premier site encore bloqué ; il suffit de recommencer pour les suivants.
     */
    override async getCloudflareBypassRequestAsync(): Promise<Request> {
        const blocked = await this.store.getCloudflareBlocked()
        const target = blocked[0] ?? (await this.store.getSites())[0] ?? 'https://paperback.moe'
        const ua = await this.userAgent()
        await this.debug(`bypass Cloudflare demandé pour ${siteIdOf(target)}`)
        return App.createRequest({
            url: `${target}/`,
            method: 'GET',
            headers: { referer: `${target}/`, ...(ua ? { 'user-agent': ua } : {}) }
        })
    }

    /** Ancienne version (synchrone) que certaines versions de l'app appellent encore */
    override getCloudflareBypassRequest(): Request {
        const target = this.store.cloudflareBlockedSync()[0] ?? this.store.sitesSync()[0] ?? 'https://paperback.moe'
        return App.createRequest({
            url: `${target}/`,
            method: 'GET',
            headers: { referer: `${target}/`, ...(this.cachedUserAgent ? { 'user-agent': this.cachedUserAgent } : {}) }
        })
    }

    // =========================================================================
    // Page d'accueil : les dernières sorties de chaque site (et l'accès au nuage ☁️)
    // =========================================================================

    override async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        await this.debug('page d\'accueil : chargement')
        try {
            await this.userAgent()
            await this.store.getCloudflareBlocked()
            const sites = (await this.store.getSites()).slice(0, 12)
            await mapLimit(sites, 3, async base => {
                const siteId = siteIdOf(base)
                try {
                    const engine = await this.engineOf(siteId)
                    const $ = this.fetcher.load(await this.fetcher.get(`${base}/`))
                    const items = this.toPartials(siteId, engine.parseListing($, `${base}/`, base).slice(0, 24))
                    // Jamais de section vide
                    if (items.length === 0) return
                    const name = (await this.store.site(siteId))?.name || siteId
                    sectionCallback(App.createHomeSection({
                        id: 'home_' + safeEncode(siteId),
                        title: name.slice(0, 60),
                        type: HomeSectionType.singleRowNormal,
                        items,
                        containsMoreItems: false
                    }))
                } catch (e) {
                    await this.store.updateSite(siteId, { error: e instanceof Error ? e.message : String(e) })
                }
            })
            await this.debug(`page d'accueil : terminée (${this.store.cloudflareBlockedSync().length} site(s) bloqué(s) par Cloudflare)`)
        } catch (e) {
            await this.debug(`page d'accueil : erreur ${e instanceof Error ? e.message : String(e)}`)
        }
    }

    override async getViewMoreItems(homepageSectionId: string, _metadata: unknown): Promise<PagedResults> {
        try {
            const siteId = safeDecode(homepageSectionId.replace(/^home_/, ''))
            const base = await this.baseOf(siteId)
            const engine = await this.engineOf(siteId)
            const $ = this.fetcher.load(await this.fetcher.get(`${base}/`))
            return App.createPagedResults({ results: this.toPartials(siteId, engine.parseListing($, `${base}/`, base)) })
        } catch {
            return App.createPagedResults({ results: [] })
        }
    }

    /** Liste du site -> tuiles Paperback, sans doublons et avec des images valides */
    private toPartials(siteId: string, items: ListingItem[]): PartialSourceManga[] {
        const out: PartialSourceManga[] = []
        const ids = new Set<string>()
        for (const it of items) {
            const mangaId = encodeMangaId(siteId, it.url)
            if (ids.has(mangaId)) continue
            ids.add(mangaId)
            out.push(App.createPartialSourceManga({
                mangaId,
                title: (it.title || 'Sans titre').slice(0, 200),
                image: safeUrl(it.image)
            }))
        }
        return out
    }

    override async supportsTagExclusion(): Promise<boolean> {
        return true
    }

    override async getSearchTags(): Promise<TagSection[]> {
        await this.debug('écran de recherche : demande des tags')
        try {
            // Les dépôts d'extensions renseignés apportent leurs sites automatiquement
            if ((await this.store.getSites()).length === 0) await this.importReposIfDue()
            else this.importReposIfDue().catch(() => undefined)
            const sites = await this.store.getSites()
            // Jamais de liste vide ni de section vide : Paperback 0.8 les supporte mal
            if (sites.length === 0) {
                await this.debug('écran de recherche : aucun site configuré')
                return [App.createTagSection({
                    id: 'info', label: 'Aucun site configuré',
                    tags: [App.createTag({ id: 'info_nosites', label: 'Ajoute tes sites ou tes dépôts dans les réglages' })]
                })]
            }

            // Si on ne connaît encore aucun tag, on attend la découverte (avec une limite de temps).
            // Sinon, on complète en arrière-plan pour ne pas bloquer l'écran de recherche.
            const known = Object.keys(await this.store.unified()).length
            if (known === 0) await this.discoverAll(false, Date.now() + DISCOVERY_BUDGET_MS)
            else this.discoverAll(false, Date.now() + DISCOVERY_BUDGET_MS).catch(() => undefined)

            const unified = Object.values(await this.store.unified())
                .sort((a, b) => a.label.localeCompare(b.label))
            const info = await this.store.getSiteInfo()

            const sections: TagSection[] = []
            const siteTags: Tag[] = sites.map(b => {
                const id = siteIdOf(b)
                return App.createTag({ id: siteTagIdOf(id), label: info[id]?.name || id })
            })
            sections.push(App.createTagSection({ id: 'sites', label: 'Limiter à certains sites', tags: siteTags }))

            // Une section par lettre pour que la liste reste lisible
            const byLetter = new Map<string, Tag[]>()
            for (const u of unified) {
                const first = u.label.normalize('NFD').charAt(0).toUpperCase()
                const letter = /[A-Z]/.test(first) ? first : 'other'
                const list = byLetter.get(letter) ?? []
                const count = Object.keys(u.sites).length
                list.push(App.createTag({ id: tagIdOf(u.key), label: count > 1 ? `${u.label} (${count})` : u.label }))
                byLetter.set(letter, list)
            }
            for (const [letter, tags] of [...byLetter.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
                if (tags.length) sections.push(App.createTagSection({ id: `letter_${letter}`, label: letter === 'other' ? '#' : letter, tags }))
            }
            await this.debug(`écran de recherche : ${sections.length} section(s), ${unified.length} tag(s) envoyés à l'app`)
            return sections
        } catch (e) {
            await this.debug(`écran de recherche : erreur ${e instanceof Error ? e.message : String(e)}`)
            return [App.createTagSection({
                id: 'info', label: 'Erreur',
                tags: [App.createTag({ id: 'info_error', label: 'Voir le journal dans les réglages' })]
            })]
        }
    }

    // =========================================================================
    // Recherche multi-sites
    // =========================================================================

    override async getSearchResults(query: SearchRequest, metadata: unknown): Promise<PagedResults> {
        await this.debug('recherche : appel reçu de l\'app')
        try {
            return await this.doSearch(query, metadata)
        } catch (e) {
            await this.debug(`recherche : erreur ${e instanceof Error ? e.message : String(e)}`)
            return App.createPagedResults({ results: [] })
        }
    }

    private async doSearch(query: SearchRequest, metadata: unknown): Promise<PagedResults> {
        const unified = await this.store.unified()
        const inc = query.includedTags ?? []
        const included = inc.map(t => keyOfTagId(t.id)).filter((k): k is string => k !== null)
        const excluded = (query.excludedTags ?? []).map(t => keyOfTagId(t.id)).filter((k): k is string => k !== null)
        const onlySites = inc.map(t => siteOfTagId(t.id)).filter((k): k is string => k !== null)
        const title = (query.title ?? '').trim()
        await this.debug(`recherche lancée : ${included.length} tag(s), titre « ${title} », page suivante : ${metadata ? 'oui' : 'non'}`)

        if (included.length === 0 && title === '') return App.createPagedResults({ results: [] })

        let sites = (await this.store.getSites()).map(siteIdOf)
        if (onlySites.length) sites = sites.filter(s => onlySites.includes(s))

        // Copie indépendante : on ne modifie jamais l'objet que l'app nous a confié
        const meta: SearchMeta = isSearchMeta(metadata)
            ? JSON.parse(JSON.stringify(metadata)) as SearchMeta
            : { sites: {}, seen: [] }
        const seen = new Set(meta.seen)
        const results: PartialSourceManga[] = []
        const ids = new Set<string>()

        // On boucle tant qu'on n'a rien à montrer mais qu'il reste des pages quelque part
        for (let round = 0; round < 3 && results.length === 0; round++) {
            const active = sites.filter(s => !meta.sites[s]?.done)
            if (active.length === 0) break
            const perSite = await Promise.all(active.map(s => this.searchSitePage(s, meta, unified, included, excluded, title)))
            const info = await this.store.getSiteInfo()
            const lists = perSite.map((items, i) => {
                const siteId = active[i] as string
                const out: PartialSourceManga[] = []
                for (const it of items) {
                    const mangaId = encodeMangaId(siteId, it.url)
                    // Doublons : même manga (ID) ou même titre sur un autre site. Un ID en double fait planter l'app.
                    const tk = titleKey(it.title)
                    const dedupe = tk.length >= 3 ? 't' + tk : 'i' + mangaId
                    if (ids.has(mangaId) || seen.has(dedupe) || seen.has('i' + mangaId)) continue
                    ids.add(mangaId)
                    seen.add(dedupe)
                    seen.add('i' + mangaId)
                    out.push(App.createPartialSourceManga({
                        mangaId,
                        title: (it.title || 'Sans titre').slice(0, 200),
                        image: safeUrl(it.image),
                        subtitle: (info[siteId]?.name || siteId).slice(0, 60)
                    }))
                }
                return out
            })
            results.push(...interleave(lists))
        }

        // On garde seulement les clés récentes pour que la pagination reste légère
        meta.seen = [...seen].slice(-600)
        const finished = sites.every(s => meta.sites[s]?.done)
        await this.debug(`recherche : ${results.length} résultat(s) renvoyé(s) à l'app, ${finished ? 'fin de liste' : 'encore des pages'}`)
        return App.createPagedResults({ results, metadata: finished ? undefined : meta })
    }

    /** Petit journal visible dans les réglages, pour savoir où ça coince */
    private async debug(line: string): Promise<void> {
        try {
            const prev = await this.stateManager.retrieve('tf_debug')
            const lines = Array.isArray(prev) ? prev.filter((x): x is string => typeof x === 'string') : []
            const t = new Date()
            const hh = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`
            lines.push(`${hh} ${line}`)
            await this.stateManager.store('tf_debug', lines.slice(-12))
        } catch { /* le journal ne doit jamais gêner */ }
    }

    /** Charge la page suivante d'UN site pour cette recherche */
    private async searchSitePage(
        siteId: string, meta: SearchMeta, unified: Record<string, UnifiedTag>,
        included: string[], excluded: string[], title: string
    ): Promise<ListingItem[]> {
        const state = meta.sites[siteId] ?? (meta.sites[siteId] = { page: 0, done: false })
        const page = state.page + 1
        try {
            const engine = await this.engineOf(siteId)
            const base = await this.baseOf(siteId)

            let url: string
            let mustCheckTags = excluded.length > 0
            if (included.length === 0) {
                url = engine.searchUrl(base, title, page)
            } else {
                const siteTags = included.map(k => unified[k]?.sites[siteId])
                if (siteTags.some(t => t === undefined)) {
                    // Ce site n'a pas l'un des tags demandés : il ne peut rien avoir
                    state.done = true
                    return []
                }
                const tags = siteTags as SiteTag[]
                const combined = engine.combinedUrl(base, tags, page)
                url = combined ?? engine.listingUrl(tags[0] as SiteTag, page)
                if (!combined && tags.length > 1) mustCheckTags = true
            }

            const $ = this.fetcher.load(await this.fetcher.get(url))
            let items = engine.parseListing($, url, base)
            state.page = page

            // Fin de liste : page vide, ou le site renvoie encore la page 1
            const first = items[0]?.url
            if (!first || (page > 1 && first === state.firstUrl)) {
                state.done = true
                return []
            }
            if (page === 1) state.firstUrl = first

            if (title && included.length > 0) {
                const want = titleKey(title)
                items = items.filter(i => titleKey(i.title).includes(want))
            }

            if (mustCheckTags) {
                const checks = await mapLimit(items, 4, async item => {
                    try {
                        const d = await this.fetchDetails(siteId, item.url)
                        const keys = new Set<string>()
                        for (const t of d.tags) {
                            const k = await this.store.keyFor(t.label)
                            if (k) keys.add(k)
                        }
                        return included.every(k => keys.has(k)) && !excluded.some(k => keys.has(k))
                    } catch {
                        return false
                    }
                })
                items = items.filter((_, i) => checks[i])
            }
            return items
        } catch (e) {
            state.done = true
            await this.store.updateSite(siteId, { error: e instanceof Error ? e.message : String(e) })
            return []
        }
    }

    // =========================================================================
    // Fiche, chapitres, pages
    // =========================================================================

    override async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const { siteId, path } = decodeMangaId(mangaId)
        const url = (await this.baseOf(siteId)) + path
        this.detailsCache.delete(url) // toujours des infos fraîches quand on ouvre la fiche
        const d = await this.fetchDetails(siteId, url)

        const tags: Tag[] = []
        const ids = new Set<string>()
        for (const t of d.tags) {
            const key = await this.store.keyFor(t.label)
            if (!key || ids.has(key)) continue
            ids.add(key)
            tags.push(App.createTag({ id: tagIdOf(key), label: t.label }))
        }

        return App.createSourceManga({
            id: mangaId,
            mangaInfo: App.createMangaInfo({
                titles: [d.title || 'Sans titre', ...d.altTitles].filter(Boolean),
                image: safeUrl(d.image),
                desc: d.desc || '',
                status: d.status || 'Unknown',
                author: d.author || '',
                artist: d.artist || '',
                hentai: false,
                tags: [App.createTagSection({ id: 'tags', label: 'Tags', tags })]
            })
        })
    }

    override async getChapters(mangaId: string): Promise<Chapter[]> {
        const { siteId, path } = decodeMangaId(mangaId)
        const base = await this.baseOf(siteId)
        const url = base + path
        const engine = await this.engineOf(siteId)
        const $ = this.fetcher.load(await this.fetcher.get(url))
        const chapters = await engine.getChapters(this.fetcher, url, $, base)
        return chapters.map((c, i) => App.createChapter({
            id: encodeChapterId(c.url),
            chapNum: c.num >= 0 ? safeNumber(c.num) : 0,
            name: c.name || `Chapitre ${chapters.length - i}`,
            time: safeDate(c.date),
            sortingIndex: -i
        }))
    }

    override async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const { siteId } = decodeMangaId(mangaId)
        const base = await this.baseOf(siteId)
        const engine = await this.engineOf(siteId)
        const pageUrl = engine.chapterPageUrl(base + decodeChapterId(chapterId))
        const html = await this.fetcher.get(pageUrl)
        const pages = engine.parsePages(this.fetcher.load(html), html, pageUrl).map(p => safeUrl(p, '')).filter(Boolean)
        // Les images sont souvent sur un autre serveur qui exige le site comme Referer
        for (const p of pages) this.imageReferers.set(hostOf(p), `${base}/`)
        return App.createChapterDetails({ id: chapterId, mangaId, pages })
    }

    override getMangaShareUrl(mangaId: string): string {
        try {
            const { siteId, path } = decodeMangaId(mangaId)
            return `https://${siteId}${path}`
        } catch {
            return 'https://paperback.moe'
        }
    }
}

function isSearchMeta(v: unknown): v is SearchMeta {
    return typeof v === 'object' && v !== null && 'sites' in v && 'seen' in v
}
