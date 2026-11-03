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
    RequestManager,
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
import { galleryPages, orderPages, pagesFromEncryptedReader, parseChapterInfo, universalChapters, universalPagesDeep } from './Chapters'
import { Details, detectEngine, Engine, engineByName, Fetcher, findNextPageUrl, ListingItem, pageCandidates } from './Engines'
import { buildSettings } from './Settings'
import { IndexedManga, SiteInfo, SiteTag, Store, UnifiedTag } from './Store'
import {
    absoluteUrl, cleanTagLabel, decodeChapterId, decodeMangaId, encodeChapterId, encodeMangaId, hostOf, interleave, keyOfTagId,
    mapLimit, safeDate, safeEncode, safeDecode, safeNumber, safeUrl, siteIdOf, siteOfTagId, siteTagIdOf, sitesFromVersioning, tagIdOf, tagKey, titleKey
} from './Utils'

export const TagFusionInfo: SourceInfo = {
    version: '1.10.0',
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
    sites: Record<string, {
        page: number, done: boolean, firstUrl?: string, mode?: string
        /** Lien "page suivante" lu sur la dernière page, et façon de paginer ('links' = liens du site, 'guess' = formats courants) */
        next?: string, pg?: 'links' | 'guess'
        /** Catalogue : page en cours, position dans la page, adresse résolue, lien suivant, façon de paginer */
        cpage?: number, offset?: number, ccur?: string, cnext?: string, cpg?: 'links' | 'guess'
    }>
    seen: string[]
    /** Tour de rôle des sites à vérifier fiche par fiche */
    cursor?: number
    /** Identifiant de la recherche (une recherche plus récente annule celle-ci) */
    gen?: number
}

const DISCOVERY_BUDGET_MS = 10000
/** Sites à 1 requête/s et à 2 requêtes/s (leurs limites connues) */
const SLOW_SITES = new Set(['hentainexus.com'])
const POLITE_SITES = new Set(['e-hentai.org', 'exhentai.org'])
/** Nombre maximum de tags affichés sur l'écran de recherche */
const MAX_SEARCH_TAGS = 500
/** Recherche : fiches lues au plus par appel, et temps maximum par appel (premier / suivants) */
const SEARCH_READS = 40
const SEARCH_TIME_FIRST = 15000
const SEARCH_TIME_NEXT = 10000

/** Contrôle d'une recherche en cours : annulation, fiches restantes, heure limite */
interface SearchControl { cancelled: () => boolean, reads: number, deadline: number }
/** Accueil : nombre de mangas du carrousel « À la une » et nombre de rangées de tags */
const HOME_FEATURED = 12
const HOME_TAG_ROWS = 5
/** Tags trop généraux pour faire une rangée (langue, format, public) */
const GENERIC_TAGS = new Set(['english', 'japanese', 'chinese', 'korean', 'french', 'spanish', 'translated', 'rewrite', 'speechless',
    'full color', 'manga', 'manhwa', 'manhua', 'webtoon', 'doujinshi', 'artist cg', 'game cg', 'western', 'image set', 'non h',
    'uncensored', 'decensored', 'censored', 'anthology', 'hentai', 'adult', 'mature', '18 plus', 'ecchi', 'smut', 'completed', 'ongoing'])
/** Nombre de mangas visé par page de résultats (de quoi remplir l'écran et pouvoir faire défiler) */
const BATCH_SIZE = 24
/** Parcours d'un catalogue : fiches lues par site et par tour, et sites parcourus par tour */
const CRAWL_BATCH = 10
const CRAWL_SITES_PER_ROUND = 2
/** Durée maximum d'une action lancée depuis les réglages */
const SETTINGS_BUDGET_MS = 25000

/**
 * Ajoute à chaque requête :
 *  - le User-Agent du navigateur de Paperback. Indispensable pour Cloudflare : le cookie obtenu
 *    avec le bypass n'est valable qu'avec CE User-Agent, sinon le site bloque encore.
 *  - le Referer attendu par les sites (et leurs serveurs d'images).
 */
class SiteInterceptor implements SourceInterceptor {
    constructor(
        private readonly referer: (url: string) => Promise<string>,
        private readonly userAgent: () => Promise<string | undefined>
    ) {}

    async interceptRequest(request: Request): Promise<Request> {
        const headers = request.headers ?? {}
        if (!headers['user-agent'] && !headers['User-Agent']) {
            const ua = await this.userAgent()
            if (ua) headers['user-agent'] = ua
        }
        if (!headers['referer'] && !headers['Referer']) {
            try { headers['referer'] = await this.referer(request.url) } catch { /* pas de Referer */ }
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
    /** Identifiant de la recherche la plus récente : les plus anciennes s'arrêtent d'elles-mêmes */
    private latestSearch = 0
    private detailsCache = new Map<string, Details>()
    private cachedUserAgent?: string

    requestManager = App.createRequestManager({
        // Pas trop vite : un rythme élevé déclenche lui-même les protections Cloudflare
        requestsPerSecond: 5,
        requestTimeout: 20000,
        interceptor: new SiteInterceptor(url => this.refererFor(url), () => this.userAgent())
    })

    /**
     * Sites qui limitent le nombre de requêtes : chacun passe par un gestionnaire plus lent.
     * 1 requête/s : HentaiNexus (sa limite), et tout site qui a répondu « trop de requêtes » (429).
     * 2 requêtes/s : E-Hentai / ExHentai (bannissement temporaire en cas d'excès).
     */
    private slowManager = App.createRequestManager({
        requestsPerSecond: 1,
        requestTimeout: 25000,
        interceptor: new SiteInterceptor(url => this.refererFor(url), () => this.userAgent())
    })
    private politeManager = App.createRequestManager({
        requestsPerSecond: 2,
        requestTimeout: 25000,
        interceptor: new SiteInterceptor(url => this.refererFor(url), () => this.userAgent())
    })
    private throttledHosts = new Set<string>()

    private managerFor(url: string): RequestManager {
        const host = hostOf(url)
        const root = host.split('.').slice(-2).join('.')
        if (SLOW_SITES.has(root) || this.throttledHosts.has(host)) return this.slowManager
        if (POLITE_SITES.has(root)) return this.politeManager
        return this.requestManager
    }

    /**
     * Site d'origine à annoncer pour une requête (en-tête Referer). Beaucoup de serveurs d'images
     * refusent une image sans lui. Ordre : mémoire de cet exemplaire, mémoire enregistrée (partagée
     * avec les autres exemplaires et les sessions suivantes), site de même domaine, sinon l'adresse elle-même.
     */
    private async refererFor(url: string): Promise<string> {
        const host = hostOf(url)
        const local = this.imageReferers.get(host)
        if (local) return local
        const saved = (await this.store.getImageReferers())[host]
        if (saved) { this.imageReferers.set(host, saved); return saved }
        const root = host.split('.').slice(-2).join('.')
        const sites = this.store.sitesSync().length ? this.store.sitesSync() : await this.store.getSites()
        const sameDomain = sites.find(b => { const h = siteIdOf(b); return h === host || h.split('.').slice(-2).join('.') === root })
        if (sameDomain) return `${sameDomain}/`
        return `${(/^https?:\/\/[^/]+/i.exec(url) ?? [''])[0]}/`
    }

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
        const host = hostOf(url)
        // Jusqu'à 3 essais pour les erreurs passagères (coupure, délai dépassé, serveur surchargé),
        // jamais pour une page absente (404) ou un blocage Cloudflare
        let response: Response | undefined
        let lastError: unknown
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const r = await this.managerFor(url).schedule(App.createRequest({ url, method, headers, ...(data !== undefined ? { data } : {}) }), 1)
                // « Trop de requêtes » : ce site passe au rythme lent, pour cette requête et les suivantes
                if (r.status === 429 && !this.throttledHosts.has(host)) this.throttledHosts.add(host)
                const transient = r.status === 0 || r.status === 408 || r.status === 425 || r.status === 429 || r.status === 500 || r.status === 502 || r.status === 504
                    || (r.status === 503 && !/cf-chl|challenge-platform|just a moment|cf_clearance/i.test(r.data ?? ''))
                response = r
                if (!transient) break
            } catch (e) {
                lastError = e
                response = undefined
            }
        }
        if (!response) throw lastError instanceof Error ? lastError : new Error(`${host} ne répond pas`)
        const html = response.data ?? ''
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
        // Page d'avertissement de contenu (« Content Warning ») : on suit le lien qui affiche la galerie
        if (method === 'GET' && /content\s+warning/i.test(html) && /[?&]nw=(?:always|session)/.test(html) && !/[?&]nw=/.test(url)) {
            const $w = this.cheerio.load(html) as CheerioAPI
            let pass: string | undefined
            $w('a[href]').each((_, el) => {
                const href = $w(el).attr('href') ?? ''
                if (!pass && /[?&]nw=always/.test(href)) pass = href
            })
            if (!pass) $w('a[href]').each((_, el) => { const href = $w(el).attr('href') ?? ''; if (!pass && /[?&]nw=session/.test(href)) pass = href })
            const target = pass ? absoluteUrl(pass, url) : null
            if (target && hostOf(target) === host) {
                const passed = await this.http('GET', target, undefined, headers)
                this.htmlCache.set(url, { html: passed, at: Date.now() })
                return passed
            }
        }
        if (method === 'GET' && html.length < 1500000) {
            this.htmlCache.set(url, { html, at: Date.now() })
            if (this.htmlCache.size > 15) {
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
        // Nom du site : og:site_name, sinon le titre coupé seulement sur " - ", " | ", " – " (pas "E-Hentai" -> "E")
        // (et pour "Index :: HentaiNexus", on garde le morceau qui ressemble au nom de domaine)
        const parts = $('title').first().text().split(/\s+(?:[-|–—]|::?)\s+/).map(x => x.trim()).filter(Boolean)
        const domainWord = (siteId.split('.')[0] ?? '').toLowerCase()
        const fromTitle = parts.find(x => x.toLowerCase().replace(/[^a-z0-9]/g, '').includes(domainWord)) ?? parts[0]
        const name = ($('meta[property="og:site_name"]').attr('content') ?? fromTitle ?? siteId).trim() || siteId
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
    private async fetchDetails(siteId: string, url: string, record = true): Promise<Details> {
        const cached = this.detailsCache.get(url)
        if (cached) return cached
        const engine = await this.engineOf(siteId)
        const base = await this.baseOf(siteId)
        const $ = this.fetcher.load(await this.fetcher.get(url))
        const details = engine.parseDetails($, url, base)
        // Pendant une recherche, l'enregistrement est fait en un seul lot par l'appelant
        if (record) try {
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
            // Actions des réglages : attendues jusqu'au bout, mais bornées dans le temps
            discoverAll: force => this.discoverAll(force, Date.now() + SETTINGS_BUDGET_MS),
            importRepos: async () => { const end = Date.now() + SETTINGS_BUDGET_MS; await this.importRepos(); await this.discoverAll(false, end) },
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

    /**
     * Page d'accueil, dans l'ordre :
     *  1. « À la une » : grand carrousel des derniers mangas ouverts ou indexés, tous sites confondus ;
     *  2. une rangée par tag populaire (tirée de l'index : instantanée, sans attendre les sites) ;
     *  3. « Nouveautés · site » : les dernières sorties de chaque site, à mesure qu'elles arrivent.
     * Tout se termine avant de rendre la main à l'app (aucune tâche en arrière-plan).
     */
    override async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        await this.debug('page d\'accueil : chargement')
        try {
            await this.userAgent()
            await this.store.getCloudflareBlocked()
            const sites = (await this.store.getSites()).slice(0, 12)
            const info = await this.store.getSiteInfo()
            const indexed = await this.store.searchIndex([], [], sites.map(siteIdOf)).catch(() => [])

            // 1. « À la une » depuis l'index (si assez de mangas illustrés), sinon depuis les sites plus bas
            const featuredFromIndex = this.indexToPartials(indexed.filter(m => m.i), info, HOME_FEATURED)
            // Pas assez dans l'index (premier lancement) : on attend les nouveautés des sites, puis on envoie
            // tout dans l'ordre. Jamais de section vide, même si aucun site ne répond.
            const featuredWaitsForSites = featuredFromIndex.length < 5
            if (!featuredWaitsForSites) {
                sectionCallback(App.createHomeSection({ id: 'home_featured', title: 'À la une', type: HomeSectionType.featured, items: featuredFromIndex, containsMoreItems: true }))
            }

            // 2. Rangées des tags les plus présents dans l'index
            const tagRows = await this.popularTagRows(indexed, info)
            for (const row of tagRows) {
                sectionCallback(App.createHomeSection({
                    id: 'home_tag_' + safeEncode(row.key), title: row.label, type: HomeSectionType.singleRowNormal,
                    items: row.items, containsMoreItems: true
                }))
            }

            // 3. Nouveautés de chaque site (envoyées à mesure, sauf au premier lancement : rangées dans l'ordre à la fin)
            const latest: PartialSourceManga[][] = []
            const held: (HomeSection | undefined)[] = new Array(sites.length)
            const deadline = Date.now() + 20000
            await mapLimit(sites.map((b, i) => ({ base: b, i })), 3, async ({ base, i }) => {
                const siteId = siteIdOf(base)
                if (Date.now() > deadline) return
                try {
                    const engine = await this.engineOf(siteId)
                    const $ = this.fetcher.load(await this.fetcher.get(`${base}/`))
                    const items = this.toPartials(siteId, engine.parseListing($, `${base}/`, base).slice(0, 24))
                    // Jamais de section vide
                    if (items.length === 0) return
                    const name = (await this.store.site(siteId))?.name || siteId
                    latest[i] = items.map(it => App.createPartialSourceManga({ mangaId: it.mangaId, title: it.title, image: it.image, subtitle: name.slice(0, 60) }))
                    const section = App.createHomeSection({
                        id: 'home_site_' + safeEncode(siteId),
                        title: `Nouveautés · ${name}`.slice(0, 70),
                        type: HomeSectionType.singleRowNormal,
                        items,
                        containsMoreItems: true
                    })
                    if (featuredWaitsForSites) held[i] = section
                    else sectionCallback(section)
                } catch (e) {
                    await this.store.updateSite(siteId, { error: e instanceof Error ? e.message : String(e) })
                }
            })

            if (featuredWaitsForSites) {
                // « À la une » : les nouveautés de tous les sites, en alternance, sans doublon ; puis les rangées des sites
                const seen = new Set<string>()
                const mixed = interleave(latest.filter(Boolean)).filter(m => !seen.has(m.mangaId) && (seen.add(m.mangaId), true)).slice(0, HOME_FEATURED)
                const items = mixed.length ? mixed : featuredFromIndex
                if (items.length) sectionCallback(App.createHomeSection({ id: 'home_featured', title: 'À la une', type: HomeSectionType.featured, items, containsMoreItems: false }))
                for (const section of held) if (section) sectionCallback(section)
            }
            await this.debug(`page d'accueil : ${tagRows.length} rangée(s) de tags, ${latest.filter(Boolean).length} site(s) chargé(s), ${this.store.cloudflareBlockedSync().length} bloqué(s) par Cloudflare`)
        } catch (e) {
            await this.debug(`page d'accueil : erreur ${e instanceof Error ? e.message : String(e)}`)
        }
    }

    /** Rangées des tags les plus présents dans l'index (hors tags de format ou de langue) */
    private async popularTagRows(indexed: (IndexedManga & { id: string })[], info: Record<string, SiteInfo>): Promise<{ key: string, label: string, items: PartialSourceManga[] }[]> {
        const unified = await this.store.unified()
        const merges = await this.store.customMerges()
        const candidates = Object.values(unified)
            .filter(u => u.indexed >= 3 && !GENERIC_TAGS.has(u.key))
            .sort((a, b) => b.indexed - a.indexed || a.label.localeCompare(b.label))
        const rows: { key: string, label: string, items: PartialSourceManga[] }[] = []
        for (const u of candidates) {
            if (rows.length >= HOME_TAG_ROWS) break
            const withTag = indexed.filter(m => m.l.some(l => tagKey(l, merges) === u.key))
            const items = this.indexToPartials(withTag, info, 20)
            if (items.length >= 3) rows.push({ key: u.key, label: (cleanTagLabel(u.label) || u.label).replace(/^\w/, c => c.toUpperCase()).slice(0, 60), items })
        }
        return rows
    }

    /** Mangas de l'index -> tuiles Paperback (sans doublon de titre, nom du site en sous-titre) */
    private indexToPartials(list: (IndexedManga & { id: string })[], info: Record<string, SiteInfo>, limit: number): PartialSourceManga[] {
        const out: PartialSourceManga[] = []
        const seen = new Set<string>()
        for (const m of list) {
            if (out.length >= limit) break
            const tk = titleKey(m.t)
            const key = tk.length >= 3 ? 't' + tk : 'i' + m.id
            if (seen.has(key) || seen.has('i' + m.id)) continue
            seen.add(key)
            seen.add('i' + m.id)
            out.push(App.createPartialSourceManga({
                mangaId: m.id, title: (m.t || 'Sans titre').slice(0, 200), image: safeUrl(m.i),
                subtitle: (info[m.s]?.name || m.s).slice(0, 60)
            }))
        }
        return out
    }

    /**
     * « Voir plus » d'une rangée de l'accueil :
     *  - tag : la recherche de ce tag sur tous les sites, avec défilement infini ;
     *  - « À la une » : tout l'index, du plus récent au plus ancien ;
     *  - site : son catalogue, page après page (en suivant sa vraie pagination).
     */
    override async getViewMoreItems(homepageSectionId: string, metadata: unknown): Promise<PagedResults> {
        try {
            if (homepageSectionId.startsWith('home_tag_')) {
                const key = safeDecode(homepageSectionId.slice('home_tag_'.length))
                return await this.doSearch({ includedTags: [App.createTag({ id: tagIdOf(key), label: key })], excludedTags: [], parameters: {} } as SearchRequest, metadata)
            }
            if (homepageSectionId === 'home_featured') {
                const offset = typeof (metadata as { offset?: unknown } | undefined)?.offset === 'number' ? (metadata as { offset: number }).offset : 0
                const sites = (await this.store.getSites()).map(siteIdOf)
                const all = await this.store.searchIndex([], [], sites)
                const pageItems = this.indexToPartials(all.slice(offset, offset + 60), await this.store.getSiteInfo(), 60)
                const next = offset + 60
                return App.createPagedResults({ results: pageItems, metadata: next < all.length ? { offset: next } : undefined })
            }
            // Rangée d'un site (identifiant actuel « home_site_… » ou ancien « home_… »)
            const siteId = safeDecode(homepageSectionId.replace(/^home_site_/, '').replace(/^home_/, ''))
            const base = await this.baseOf(siteId)
            const engine = await this.engineOf(siteId)
            const m = (metadata ?? {}) as { page?: number, next?: string, pg?: 'links' | 'guess', start?: string, seen?: string[] }
            const page = (m.page ?? 0) + 1
            const start = m.start ?? (await this.catalogOf(siteId, engine, base) || `${base}/`)
            const res = await this.fetchListing(start, page, m.next, m.pg, engine, base)
            if (!res) return App.createPagedResults({ results: [] })
            const seen = new Set(m.seen ?? [])
            const results = this.toPartials(siteId, res.items).filter(r => !seen.has(r.mangaId))
            for (const r of results) seen.add(r.mangaId)
            const finished = results.length === 0 || (res.mode === 'links' && !res.next)
            return App.createPagedResults({
                results,
                metadata: finished ? undefined : { page, next: res.next, pg: res.mode, start, seen: [...seen].slice(-2000) }
            })
        } catch (e) {
            await this.debug(`voir plus (${homepageSectionId.slice(0, 40)}) : erreur ${e instanceof Error ? e.message : String(e)}`)
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
            // Aucun travail en arrière-plan : tout se termine avant de répondre à l'app.
            // (Une tâche qui continue après la réponse utilise des objets que l'app a pu libérer,
            // d'où l'erreur « JSManagedValue was released ».)
            // Les dépôts renseignés apportent leurs sites automatiquement (une fois par jour au plus)
            if ((await this.store.getSites()).length === 0) await this.importReposIfDue()
            const sites = await this.store.getSites()
            // Jamais de liste vide ni de section vide : Paperback 0.8 les supporte mal
            if (sites.length === 0) {
                await this.debug('écran de recherche : aucun site configuré')
                return [App.createTagSection({
                    id: 'info', label: 'Aucun site configuré',
                    tags: [App.createTag({ id: 'info_nosites', label: 'Ajoute tes sites ou tes dépôts dans les réglages' })]
                })]
            }

            // Sites jamais analysés : découverte de leurs tags, attendue, avec une limite de temps
            await this.discoverAll(false, Date.now() + DISCOVERY_BUDGET_MS)

            // Écran des tags : tous les tags, mais plafonnés (une liste de plusieurs milliers de tags fait planter
            // l'écran) en gardant les plus utiles : d'abord ceux qui ont une page sur un site, puis les plus fréquents
            const unified = Object.values(await this.store.unified())
                .map(u => ({ u, score: Object.values(u.sites).filter(t => !!t.url).length * 5 + u.indexed }))
                .sort((a, b) => b.score - a.score || a.u.label.localeCompare(b.u.label))
                .slice(0, MAX_SEARCH_TAGS)
                .map(x => x.u)
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
                // Rangé par la première lettre du nom nettoyé ; pas de section « # » (elle ne contenait que des restes de pages)
                const letter = u.key.charAt(0).toUpperCase()
                if (!/^[A-Z]$/.test(letter)) continue
                const list = byLetter.get(letter) ?? []
                // Libellé seul, sans aucun chiffre ajouté (les nombres prêtaient à confusion)
                list.push(App.createTag({ id: tagIdOf(u.key), label: cleanTagLabel(u.label) || u.label }))
                byLetter.set(letter, list)
            }
            for (const [letter, tags] of [...byLetter.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
                if (tags.length) sections.push(App.createTagSection({ id: `letter_${letter}`, label: letter, tags }))
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
        // Paperback relance la recherche à chaque tag touché : la plus récente annule les autres,
        // qui s'arrêtent avant leur prochaine requête au lieu de tourner toutes en même temps.
        const isNew = !isSearchMeta(metadata)
        const gen = isNew ? Math.max(Date.now(), this.latestSearch + 1) : (meta.gen ?? this.latestSearch)
        meta.gen = gen
        if (gen > this.latestSearch) this.latestSearch = gen
        const ctl: SearchControl = {
            cancelled: () => this.latestSearch > gen,
            reads: SEARCH_READS,
            deadline: Date.now() + (isNew ? SEARCH_TIME_FIRST : SEARCH_TIME_NEXT)
        }
        if (ctl.cancelled()) return App.createPagedResults({ results: [] })
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

        // On remplit la page avec une vraie fournée (BATCH_SIZE mangas) prise sur tous les sites.
        // Paperback ne charge la suite que quand on atteint le bas de la liste en faisant défiler :
        // une page trop courte ne remplit pas l'écran, on ne peut pas défiler, et rien d'autre ne charge.
        // Limites : quelques tours, et un temps maximum (au-delà, on renvoie ce qu'on a déjà).
        const wanted = BATCH_SIZE
        for (let round = 0; round < 12 && results.length < wanted && !ctl.cancelled() && Date.now() < ctl.deadline && ctl.reads > 0; round++) {
            const pending = sites.filter(s => !meta.sites[s]?.done)
            if (pending.length === 0) break
            // Sites avec une page pour le tag (un seul tag, pas d'exclusion) : tous à chaque tour (rapide).
            // Sites à vérifier fiche par fiche (plusieurs tags, exclusion, pas de page) : 2 par tour, à tour de rôle.
            const crawl = pending.filter(s => this.needsVerification(s, unified, included, excluded))
            const fast = pending.filter(s => !crawl.includes(s))
            const cursor = meta.cursor ?? 0
            const picked = crawl.length <= CRAWL_SITES_PER_ROUND ? crawl
                : Array.from({ length: CRAWL_SITES_PER_ROUND }, (_, i) => crawl[(cursor + i) % crawl.length] as string)
            meta.cursor = cursor + CRAWL_SITES_PER_ROUND
            const active = [...fast, ...picked]
            const perSite = await Promise.all(active.map(s => this.searchSitePage(s, meta, unified, included, excluded, title, ctl)))
            if (ctl.cancelled()) break
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

        if (ctl.cancelled()) {
            await this.debug('recherche : remplacée par une plus récente, arrêtée')
            return App.createPagedResults({ results: [] })
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
        for (const candidate of engine.catalogPages(base).slice(0, 4)) {
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
     * Garde les mangas qui ont tous les tags demandés et aucun tag exclu.
     * Déjà indexés : vérifiés sans requête. Les autres : fiche lue, puis tout est enregistré
     * en un seul lot (tags du site + index), pour rester rapide et léger.
     */
    /** Ce site doit-il être vérifié fiche par fiche pour cette recherche ? */
    private needsVerification(siteId: string, unified: Record<string, UnifiedTag>, included: string[], excluded: string[]): boolean {
        if (included.length === 0) return false
        const tags = included.map(k => unified[k]?.sites[siteId])
        const allHavePage = tags.every(t => !!t && !!t.url)
        return !allHavePage || excluded.length > 0 || (included.length > 1 && !tags.every(t => !!t?.filter))
    }

    /**
     * Vérifie, dans l'ordre, les mangas d'un lot. Déjà indexés : sans requête. Les autres : fiche lue,
     * dans la limite des fiches et du temps restants. S'arrête au premier manga qui demanderait une
     * fiche quand la limite est atteinte : `processed` dit combien ont été traités (on reprendra là).
     */
    private async verifyItems(siteId: string, items: ListingItem[], included: string[], excluded: string[], ctl: SearchControl, title = '')
        : Promise<{ found: ListingItem[], processed: number }> {
        const merges = await this.store.customMerges()
        const want = title ? titleKey(title) : ''
        // 1. Ce qu'on peut traiter maintenant (dans l'ordre)
        const plan: { item: ListingItem, id: string, labels?: string[], skip?: boolean }[] = []
        for (const item of items) {
            const id = encodeMangaId(siteId, item.url)
            if (want && !titleKey(item.title).includes(want)) { plan.push({ item, id, skip: true }); continue }
            const indexed = await this.store.getIndexed(id).catch(() => undefined)
            if (indexed) { plan.push({ item, id, labels: indexed.l }); continue }
            if (ctl.cancelled() || ctl.reads <= 0 || Date.now() > ctl.deadline) break
            ctl.reads--
            plan.push({ item, id })
        }
        // 2. Lecture des fiches nécessaires (4 à la fois), rien de nouveau si la recherche est annulée
        const newEntries: { id: string, entry: { s: string, u: string, t: string, i: string, l: string[] } }[] = []
        const newTags: SiteTag[] = []
        await mapLimit(plan.filter(p => !p.skip && !p.labels), 4, async p => {
            if (ctl.cancelled()) return
            try {
                const d = await this.fetchDetails(siteId, p.item.url, false)
                p.labels = d.tags.map(t => t.label)
                newTags.push(...d.tags)
                newEntries.push({ id: p.id, entry: { s: siteId, u: p.item.url, t: p.item.title || d.title || 'Sans titre', i: p.item.image || d.image, l: p.labels } })
            } catch { p.labels = undefined }
        })
        try {
            if (newTags.length) await this.store.addTags(siteId, newTags)
            if (newEntries.length) await this.store.indexMany(newEntries)
        } catch { /* l'enregistrement ne doit pas bloquer la recherche */ }
        const found = plan.filter(p => {
            if (p.skip || !p.labels) return false
            const keys = new Set(p.labels.map(l => tagKey(l, merges)).filter((k): k is string => k !== null))
            return included.every(k => keys.has(k)) && !excluded.some(k => keys.has(k))
        }).map(p => p.item)
        return { found, processed: plan.length }
    }

    /**
     * Récupère la page n d'une liste en suivant la vraie pagination du site.
     * Page 1 : l'adresse de départ. Ensuite : le lien "suivant" lu sur la page précédente
     * ('links'), ou les formats courants si le site n'en a pas ('guess').
     * Retourne null s'il n'y a pas de page n (fin de la liste) — ce n'est pas une erreur.
     */
    private async fetchListing(firstUrl: string, page: number, prevNext: string | undefined, mode: 'links' | 'guess' | undefined, engine: Engine, base: string)
        : Promise<{ items: ListingItem[], url: string, next?: string, mode: 'links' | 'guess' } | null> {
        const candidates = page === 1 ? [firstUrl] : mode === 'links' ? (prevNext ? [prevNext] : []) : pageCandidates(firstUrl, page)
        for (const url of candidates) {
            let html: string
            try { html = await this.fetcher.get(url) } catch (e) {
                // Cloudflare : on remonte l'erreur (le site doit être débloqué) ; une page absente : format suivant
                if (e instanceof Error && /Cloudflare/.test(e.message)) throw e
                if (page === 1) throw e
                continue
            }
            const $ = this.fetcher.load(html)
            const items = engine.parseListing($, url, base)
            const next = findNextPageUrl($, url, page)
            return { items, url, ...(next ? { next } : {}), mode: page === 1 ? (next ? 'links' : 'guess') : (mode ?? 'guess') }
        }
        return null
    }

    /**
     * Charge la suite d'UN site pour cette recherche :
     *  - liste simple (titre, un seul tag avec sa page, ou filtre multi-tags du site) : une page par appel ;
     *  - sinon vérification par lots de 10 fiches, en partant de la page d'un des tags ou du catalogue,
     *    avec reprise exacte au lot suivant (rien n'est sauté, rien n'est lu deux fois).
     */
    private async searchSitePage(
        siteId: string, meta: SearchMeta, unified: Record<string, UnifiedTag>,
        included: string[], excluded: string[], title: string, ctl: SearchControl
    ): Promise<ListingItem[]> {
        const state = meta.sites[siteId] ?? (meta.sites[siteId] = { page: 0, done: false })
        let firstPage = false
        // Plus de temps ou de fiches, ou recherche remplacée : on reprendra ici au prochain appel
        if (ctl.cancelled() || Date.now() > ctl.deadline || ctl.reads <= 0) return []
        try {
            const engine = await this.engineOf(siteId)
            const base = await this.baseOf(siteId)
            const siteTags = included.map(k => unified[k]?.sites[siteId])
            const withPage = siteTags.filter((t): t is SiteTag => !!t && !!t.url)
            const verify = this.needsVerification(siteId, unified, included, excluded)

            if (verify) {
                // Point de départ : page combinée du site si elle existe, sinon page d'un des tags, sinon le catalogue
                const combined = withPage.length === siteTags.length ? engine.combinedUrl(base, withPage, 1) : null
                let start = combined ?? (withPage[0] ? engine.listingUrl(withPage[0], 1) : '')
                state.mode = withPage.length ? 'page du tag + vérification' : 'catalogue'
                if (!start) {
                    start = await this.catalogOf(siteId, engine, base)
                    if (!start) { state.done = true; return [] }
                }
                const cpage = state.cpage ?? 1
                firstPage = cpage === 1 && !state.offset
                const offset = state.offset ?? 0
                ctl.reads--
                const res = state.ccur
                    ? await this.fetchListing(state.ccur, 1, undefined, undefined, engine, base)
                    : await this.fetchListing(start, cpage, state.cnext, state.cpg, engine, base)
                if (!res) { state.done = true; return [] }
                if (!state.ccur) { state.ccur = res.url; if (cpage === 1) state.cpg = res.mode }
                const items = res.items
                const first = items[0]?.url
                if (!first || (cpage > 1 && offset === 0 && first === state.firstUrl)) { state.done = true; return [] }
                if (cpage === 1) state.firstUrl = first
                const batch = items.slice(offset, offset + CRAWL_BATCH)
                const { found, processed } = await this.verifyItems(siteId, batch, included, excluded, ctl, title)
                const nextOffset = offset + processed
                if (nextOffset >= items.length) {
                    // Page terminée : la suivante sera celle du lien "suivant"
                    state.cpage = cpage + 1
                    state.offset = 0
                    state.ccur = undefined
                    state.cnext = res.next
                    if (state.cpg === 'links' && !res.next) state.done = true
                } else state.offset = nextOffset
                if (processed) await this.debug(`recherche ${siteId} : ${state.mode} p.${cpage} (${offset + 1}-${nextOffset}), ${found.length} trouvé(s)`)
                return found
            }

            // --- Liste simple : titre, un seul tag avec sa page, ou filtre multi-tags du site ---
            const page = state.page + 1
            firstPage = page === 1
            let firstUrl: string
            if (included.length === 0) {
                firstUrl = engine.searchUrl(base, title, 1)
                state.mode = 'titre'
            } else {
                const combined = engine.combinedUrl(base, withPage, 1)
                firstUrl = combined ?? engine.listingUrl(withPage[0] as SiteTag, 1)
                state.mode = combined ? 'filtre multi-tags' : 'page du tag'
            }
            ctl.reads--
            const res = await this.fetchListing(firstUrl, page, state.next, state.pg, engine, base)
            if (!res) { state.done = true; return [] }
            state.page = page
            state.pg = res.mode
            state.next = res.next
            let items = res.items
            // Fin de liste : page vide, ou le site renvoie encore la page 1
            const first = items[0]?.url
            if (!first || (page > 1 && first === state.firstUrl)) { state.done = true; return [] }
            if (page === 1) state.firstUrl = first
            // Pagination par liens et plus de lien "suivant" : c'était la dernière page
            if (res.mode === 'links' && !res.next) state.done = true
            if (title && included.length > 0) items = items.filter(i => titleKey(i.title).includes(titleKey(title)))
            return items
        } catch (e) {
            state.done = true
            // Seule une vraie panne (première page, Cloudflare) est notée comme erreur du site
            const msg = e instanceof Error ? e.message : String(e)
            if (firstPage || /Cloudflare/.test(msg)) await this.store.updateSite(siteId, { error: msg })
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
        let d: Details
        try {
            d = await this.fetchDetails(siteId, url)
        } catch (e) {
            // Le site ne répond pas : on ouvre quand même la fiche avec ce que l'index connaît
            const known = await this.store.getIndexed(mangaId).catch(() => undefined)
            if (!known) throw e
            await this.debug(`fiche ${siteId} : site injoignable, fiche ouverte depuis l'index`)
            d = { title: known.t, image: known.i, desc: '', author: '', artist: '', status: 'Unknown', altTitles: [], tags: known.l.map(l => ({ label: l, url: '' })) }
        }

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
        const cacheKey = `v3|${siteId}|${chapterId}`
        // Paperback redemande souvent le même chapitre (préchargement, retour en arrière) :
        // on renvoie exactement la même liste pendant 30 minutes, pour un ordre et un nombre de pages stables
        const cached = await this.store.getCachedPages(cacheKey).catch(() => undefined)
        if (cached && Date.now() - cached.at < 30 * 60000) {
            await this.rememberImageHosts(cached.p, base)
            return App.createChapterDetails({ id: chapterId, mangaId, pages: cached.p })
        }
        let pages: string[] = []
        let engineName = '?'
        try {
            const engine = await this.engineOf(siteId)
            engineName = engine.name
            const pageUrl = engine.chapterPageUrl(base + decodeChapterId(chapterId))
            const html = await this.fetcher.get(pageUrl)
            const $p = this.fetcher.load(html)
            // Lecteur chiffré (type HentaiNexus) : la liste exacte des pages, déchiffrée
            let found = pagesFromEncryptedReader(html, hostOf(pageUrl)) ?? []
            // Galerie (miniatures vers des pages de lecture) : images en taille réelle, jamais les miniatures
            if (found.length < 1) found = await galleryPages(this.fetcher, $p, pageUrl, html)
            if (found.length < 2) found = engine.parsePages($p, html, pageUrl)
            // Vieux lecteurs "une image par page" : on suit les pages du chapitre
            if (found.length < 2) found = await universalPagesDeep(this.fetcher, $p, html, pageUrl)
            pages = orderPages([...new Set(found.map(p => safeUrl(p, '')).filter(Boolean))])
            await this.debug(`pages ${siteId} (${engineName}) : ${pages.length} image(s)${pages[0] ? `, ex. ${pages[0].slice(0, 70)}` : ''}`)
        } catch (e) {
            await this.debug(`pages ${siteId} (${engineName}) : erreur ${e instanceof Error ? e.message : String(e)}`)
            // Le site ne répond pas : on reprend la dernière liste connue de ce chapitre, s'il y en a une
            if (cached) {
                await this.rememberImageHosts(cached.p, base)
                return App.createChapterDetails({ id: chapterId, mangaId, pages: cached.p })
            }
            throw e
        }
        if (pages.length === 0) {
            if (cached) return App.createChapterDetails({ id: chapterId, mangaId, pages: cached.p })
            throw new Error('Aucune page trouvée pour ce chapitre. Lance « Diagnostic d\'un manga » dans les réglages de TagFusion et envoie le journal.')
        }
        await this.rememberImageHosts(pages, base)
        try { await this.store.setCachedPages(cacheKey, pages) } catch { /* le cache ne doit pas bloquer la lecture */ }
        return App.createChapterDetails({ id: chapterId, mangaId, pages })
    }

    /** Retient le site d'origine de chaque serveur d'images (en mémoire et dans le stockage) */
    private async rememberImageHosts(pages: string[], base: string): Promise<void> {
        const map: Record<string, string> = {}
        for (const p of pages) { const h = hostOf(p); if (h) { map[h] = `${base}/`; this.imageReferers.set(h, `${base}/`) } }
        try { await this.store.addImageReferers(map) } catch { /* sans gravité */ }
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
