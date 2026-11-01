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
import { parseChapterInfo, universalChapters, universalPagesDeep } from './Chapters'
import { Details, detectEngine, Engine, engineByName, Fetcher, ListingItem } from './Engines'
import { buildSettings } from './Settings'
import { SiteTag, Store, UnifiedTag } from './Store'
import {
    cleanTagLabel, decodeChapterId, decodeMangaId, encodeChapterId, encodeMangaId, hostOf, interleave, keyOfTagId,
    mapLimit, pagedUrl, safeDate, safeEncode, safeDecode, safeNumber, safeUrl, siteIdOf, siteOfTagId, siteTagIdOf, sitesFromVersioning, tagIdOf, tagKey, titleKey
} from './Utils'

export const TagFusionInfo: SourceInfo = {
    version: '1.5.0',
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
    sites: Record<string, { page: number, done: boolean, firstUrl?: string, mode?: string }>
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
            const base = (await this.store.getSiteInfo())[host]?.base ?? (/^https?:\/\/[^/]+/i.exec(url) ?? [url])[0]
            await this.store.markCloudflareBlocked(base)
            const n = (await this.store.getCloudflareBlocked()).length
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

    /**
     * Lit une fiche, et en profite pour apprendre ses tags :
     *  - les tags qui sont des liens deviennent des tags de recherche du site ;
     *  - TOUS les tags (liens ou non) vont dans l'index des mangas.
     * Les enregistrements sont attendus (et non lancés en arrière-plan) : Paperback peut
     * suspendre l'extension dès qu'elle a répondu, et une écriture pas finie serait perdue.
     */
    private async fetchDetails(siteId: string, url: string): Promise<Details> {
        const cached = this.detailsCache.get(url)
        if (cached) return cached
        const engine = await this.engineOf(siteId)
        const base = await this.baseOf(siteId)
        const $ = this.fetcher.load(await this.fetcher.get(url))
        const details = engine.parseDetails($, url, base)
        try {
            const added = await this.store.addTags(siteId, details.tags)
            await this.store.indexManga(encodeMangaId(siteId, url), {
                s: siteId, u: url, t: details.title || 'Sans titre', i: details.image, l: details.tags.map(t => t.label)
            })
            await this.debug(`fiche « ${(details.title || '?').slice(0, 40)} » : ${details.tags.length} tag(s) lu(s), ${added} nouveau(x) tag(s) de recherche`)
        } catch (e) {
            await this.debug(`fiche : enregistrement des tags impossible (${e instanceof Error ? e.message : String(e)})`)
        }
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
            importRepos: async () => { await this.importRepos(); await this.discoverAll(false) },
            diagnose: url => this.diagnoseManga(url),
            reset: full => this.resetExtension(full)
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
                // Libellé seul, sans aucun chiffre ajouté (les nombres prêtaient à confusion)
                list.push(App.createTag({ id: tagIdOf(u.key), label: cleanTagLabel(u.label) || u.label }))
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
        // tagKey() nettoie aussi les anciens tags qui contenaient un nombre ("romance 123" -> "romance")
        const toKey = (id: string): string | null => { const k = keyOfTagId(id); return k === null ? null : (tagKey(k) ?? k) }
        const included = [...new Set(inc.map(t => toKey(t.id)).filter((k): k is string => k !== null))]
        const excluded = [...new Set((query.excludedTags ?? []).map(t => toKey(t.id)).filter((k): k is string => k !== null))]
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

        // Première page : d'abord les mangas de l'index qui ont ces tags (y compris les tags
        // qui ne sont pas des liens sur le site, donc introuvables autrement)
        if (!isSearchMeta(metadata) && included.length > 0) {
            const info = await this.store.getSiteInfo()
            let local = await this.store.searchIndex(included, excluded, sites)
            if (title) local = local.filter(m => titleKey(m.t).includes(titleKey(title)))
            for (const m of local.slice(0, 100)) {
                const tk = titleKey(m.t)
                const dedupe = tk.length >= 3 ? 't' + tk : 'i' + m.id
                if (ids.has(m.id) || seen.has(dedupe)) continue
                ids.add(m.id)
                seen.add(dedupe)
                seen.add('i' + m.id)
                results.push(App.createPartialSourceManga({
                    mangaId: m.id,
                    title: m.t || 'Sans titre',
                    image: safeUrl(m.i),
                    subtitle: (info[m.s]?.name || m.s).slice(0, 60)
                }))
            }
            await this.debug(`recherche : ${results.length} manga(s) trouvé(s) dans l'index`)
        }

        // On boucle tant qu'on n'a rien à montrer mais qu'il reste des pages quelque part
        // (un écran vide ferait croire à Paperback que la liste est finie). Limite de temps : 25 s.
        const started = Date.now()
        for (let round = 0; round < 8 && results.length === 0 && Date.now() - started < 25000; round++) {
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
        meta.seen = [...seen].slice(-3000)
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
            await this.stateManager.store('tf_debug', lines.slice(-30))
        } catch { /* le journal ne doit jamais gêner */ }
    }

    /** Page du catalogue complet d'un site (détectée une fois, puis mémorisée) */
    private async catalogOf(siteId: string, engine: Engine, base: string): Promise<string> {
        const known = (await this.store.site(siteId))?.catalog
        if (known !== undefined) return known
        for (const candidate of engine.catalogPages(base)) {
            try {
                const items = engine.parseListing(this.fetcher.load(await this.fetcher.get(candidate)), candidate, base)
                if (items.length >= 4) {
                    await this.store.updateSite(siteId, { catalog: candidate })
                    await this.debug(`catalogue de ${siteId} : ${candidate.replace(/^https?:\/\/[^/]+/, '')}`)
                    return candidate
                }
            } catch { /* page absente : candidate suivante */ }
        }
        await this.store.updateSite(siteId, { catalog: '' })
        return ''
    }

    /**
     * Charge la page suivante d'UN site pour cette recherche. Trois façons, de la plus rapide à la plus complète :
     *  - le site a une page pour ce(s) tag(s) : on la parcourt (et on vérifie les autres tags s'il y en a) ;
     *  - sinon on parcourt le catalogue complet du site et on vérifie les tags de chaque manga.
     *    Les mangas déjà indexés sont vérifiés sans requête ; les autres sont lus puis indexés au passage.
     */
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
                state.mode = 'titre'
            } else {
                const siteTags = included.map(k => unified[k]?.sites[siteId])
                const withPage = siteTags.filter((t): t is SiteTag => !!t && !!t.url)
                if (withPage.length === siteTags.length) {
                    const combined = engine.combinedUrl(base, withPage, page)
                    url = combined ?? engine.listingUrl(withPage[0] as SiteTag, page)
                    if (!combined && withPage.length > 1) mustCheckTags = true
                    state.mode = 'page du tag'
                } else if (withPage.length > 0) {
                    // Un des tags a une page sur ce site : on la parcourt et on vérifie les autres
                    url = engine.listingUrl(withPage[0] as SiteTag, page)
                    mustCheckTags = true
                    state.mode = 'page du tag + vérification'
                } else {
                    // Aucun tag n'a de page sur ce site : on parcourt tout son catalogue
                    const catalog = await this.catalogOf(siteId, engine, base)
                    if (!catalog) { state.done = true; return [] }
                    url = pagedUrl(catalog, page)
                    mustCheckTags = true
                    state.mode = 'catalogue'
                }
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
                const merges = await this.store.customMerges()
                const checks = await mapLimit(items, 4, async item => {
                    try {
                        // Déjà indexé : on connaît ses tags sans relire sa fiche
                        const indexed = await this.store.getIndexed(encodeMangaId(siteId, item.url))
                        const labels = indexed ? indexed.l : (await this.fetchDetails(siteId, item.url)).tags.map(t => t.label)
                        const keys = new Set(labels.map(l => tagKey(l, merges)).filter((k): k is string => k !== null))
                        return included.every(k => keys.has(k)) && !excluded.some(k => keys.has(k))
                    } catch {
                        return false
                    }
                })
                const total = items.length
                items = items.filter((_, i) => checks[i])
                if (state.mode === 'catalogue') await this.debug(`recherche ${siteId} : catalogue page ${page}, ${items.length}/${total} correspondent`)
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
            tags.push(App.createTag({ id: tagIdOf(key), label: cleanTagLabel(t.label) }))
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
        return this.findChapters(mangaId, () => undefined)
    }

    /** Outil des réglages : analyse un manga à partir de son adresse et écrit le détail dans le journal */
    async diagnoseManga(input: string): Promise<void> {
        const raw = input.trim()
        const m = /^(https?:\/\/[^/?#\s]+)(\/[^\s]*)?$/i.exec(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
        if (!m?.[1]) { await this.debug('diagnostic : adresse invalide, colle l\'adresse complète d\'un manga'); return }
        const base = (m[1] as string).toLowerCase()
        const siteId = siteIdOf(base)
        const url = base + (m[2] ?? '/')
        if (!(await this.store.site(siteId))) await this.store.updateSite(siteId, { base })
        await this.debug(`diagnostic : ${url.slice(0, 90)}`)
        const lines: string[] = []
        this.htmlCache.delete(url)
        const chapters = await this.findChapters(encodeMangaId(siteId, url), l => lines.push(l))
        for (const l of lines) await this.debug(`  • ${l}`)
        const first = chapters.slice(0, 3).map(c => `${c.chapNum} ${c.name}`).join(' ; ')
        await this.debug(`diagnostic : ${chapters.length} chapitre(s)${first ? ` — ${first}` : ''}`)
    }

    /** Remise à zéro : index, tags appris, état des sites, journal (et les sites eux-mêmes si `full`) */
    async resetExtension(full: boolean): Promise<void> {
        await this.store.resetAll(full)
        this.htmlCache.clear()
        this.detailsCache.clear()
        this.imageReferers.clear()
        await this.debug(full ? 'extension entièrement réinitialisée' : 'index et tags effacés (sites conservés)')
    }

    /**
     * Cherche les chapitres sans jamais lever d'erreur : si le moteur du site échoue,
     * la lecture universelle prend le relais. Tout est noté dans le journal.
     */
    private async findChapters(mangaId: string, log: (line: string) => void): Promise<Chapter[]> {
        let siteId = '?'
        let path = '/'
        try {
            ({ siteId, path } = decodeMangaId(mangaId))
        } catch (e) {
            await this.debug(`chapitres : ${e instanceof Error ? e.message : String(e)}`)
            return []
        }
        const base = await this.baseOf(siteId)
        const url = base + path
        let engineName = '?'
        let chapters: Awaited<ReturnType<Engine['getChapters']>> = []
        let langCode = 'en'
        const steps: string[] = []
        const note = (l: string): void => { steps.push(l); log(l) }
        try {
            const engine = await this.engineOf(siteId)
            engineName = engine.name
            const html = await this.fetcher.get(url)
            const $ = this.fetcher.load(html)
            langCode = languageOf($('html').attr('lang'))
            try {
                chapters = await engine.getChapters(this.fetcher, url, $, base, note)
            } catch (e) {
                note(`moteur ${engine.name} : erreur ${e instanceof Error ? e.message : String(e)}`)
                chapters = await universalChapters(this.fetcher, url, $, base, note)
            }
        } catch (e) {
            await this.debug(`chapitres ${siteId} (${engineName}) : erreur ${e instanceof Error ? e.message : String(e)}`)
            return []
        }
        await this.debug(`chapitres ${siteId} (${engineName}, langue ${langCode}) : ${chapters.length} trouvé(s) sur ${path.slice(0, 50)} [${steps.join(' | ').slice(0, 160)}]`)
        return this.toPaperbackChapters(chapters, langCode)
    }

    private toPaperbackChapters(chapters: Awaited<ReturnType<Engine['getChapters']>>, langCode: string): Chapter[] {
        // Affichage propre dans Paperback : numéro, volume, titre sans "Chapter 12" répété,
        // numéro de secours si le site n'en donne pas, et aucun identifiant en double
        const seenIds = new Set<string>()
        const out: Chapter[] = []
        const infos = chapters.map(c => parseChapterInfo(c.name, c.url))
        const nums = fillMissingNumbers(chapters.map((c, i) => c.num >= 0 ? c.num : (infos[i]?.num ?? -1)), chapters.map(c => c.name))
        chapters.forEach((c, i) => {
            const id = encodeChapterId(c.url)
            if (seenIds.has(id)) return
            seenIds.add(id)
            const info = infos[i] ?? { num: -1, volume: 0, name: '' }
            const num = nums[i] ?? 0
            const volume = safeNumber(c.volume || info.volume)
            // Mêmes champs que les extensions Paperback 0.8 qui fonctionnent : une langue (Paperback
            // filtre les chapitres par langue), un nom toujours rempli, un volume seulement s'il existe
            out.push(App.createChapter({
                id,
                chapNum: safeNumber(num),
                name: (info.name || `Chapter ${safeNumber(num)}`).slice(0, 120),
                langCode,
                time: safeDate(c.date),
                ...(volume > 0 ? { volume } : {})
            }))
        })
        return out
    }

    override async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const { siteId } = decodeMangaId(mangaId)
        const base = await this.baseOf(siteId)
        const engine = await this.engineOf(siteId)
        const pageUrl = engine.chapterPageUrl(base + decodeChapterId(chapterId))
        let pages: string[] = []
        try {
            const html = await this.fetcher.get(pageUrl)
            const $p = this.fetcher.load(html)
            let found = engine.parsePages($p, html, pageUrl)
            // Vieux lecteurs "une image par page" : on suit les pages du chapitre
            if (found.length < 2) found = await universalPagesDeep(this.fetcher, $p, html, pageUrl)
            pages = [...new Set(found.map(p => safeUrl(p, '')).filter(Boolean))]
            await this.debug(`pages ${siteId} (${engine.name}) : ${pages.length} image(s)${pages[0] ? `, ex. ${pages[0].slice(0, 70)}` : ''}`)
        } catch (e) {
            await this.debug(`pages ${siteId} (${engine.name}) : erreur ${e instanceof Error ? e.message : String(e)}`)
            throw e
        }
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

/** Langue d'une page ("fr-FR" -> "fr"), "en" par défaut, au format attendu par Paperback */
export function languageOf(lang: string | undefined): string {
    const m = /^([a-z]{2,3})(?:[-_]|$)/i.exec((lang ?? '').trim())
    return m?.[1] ? m[1].toLowerCase() : 'en'
}

/**
 * Donne un numéro logique aux chapitres qui n'en ont pas (liste du plus récent au plus ancien) :
 * prologue = 0, sinon à mi-chemin entre ses voisins, ou juste après le plus récent.
 */
export function fillMissingNumbers(nums: number[], names: string[]): number[] {
    const out = [...nums]
    for (let i = 0; i < out.length; i++) {
        if ((out[i] ?? -1) >= 0) continue
        if (/(prologue|prolog|prólogo|prologo|序章|oneshot|one-shot)/i.test(names[i] ?? '')) { out[i] = 0; continue }
        let newer = -1
        for (let j = i - 1; j >= 0; j--) if ((nums[j] ?? -1) >= 0) { newer = nums[j] as number; break }
        let older = -1
        for (let j = i + 1; j < out.length; j++) if ((nums[j] ?? -1) >= 0) { older = nums[j] as number; break }
        if (newer >= 0 && older >= 0) out[i] = Math.round(((newer + older) / 2) * 100) / 100
        else if (older >= 0) out[i] = older + 0.5
        else if (newer >= 0) out[i] = Math.max(0, newer - 0.5)
        else out[i] = out.length - i
    }
    return out
}

function isSearchMeta(v: unknown): v is SearchMeta {
    return typeof v === 'object' && v !== null && 'sites' in v && 'seen' in v
}
