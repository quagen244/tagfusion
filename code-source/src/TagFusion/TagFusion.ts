import {
    BadgeColor,
    Chapter,
    ChapterDetails,
    ContentRating,
    DUISection,
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
    mapLimit, safeDate, safeNumber, siteIdOf, siteOfTagId, siteTagIdOf, tagIdOf, titleKey
} from './Utils'

export const TagFusionInfo: SourceInfo = {
    version: '1.0.1',
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
    intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.SETTINGS_UI | SourceIntents.CLOUDFLARE_BYPASS_REQUIRED
}

/** Où on en est sur chaque site pendant un défilement de résultats */
interface SearchMeta {
    sites: Record<string, { page: number, done: boolean, firstUrl?: string }>
    seen: string[]
}

const DISCOVERY_BUDGET_MS = 12000

/** Ajoute le Referer attendu par les sites (et leurs serveurs d'images) */
class RefererInterceptor implements SourceInterceptor {
    constructor(private readonly referers: Map<string, string>) {}

    async interceptRequest(request: Request): Promise<Request> {
        const headers = request.headers ?? {}
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

    requestManager = App.createRequestManager({
        requestsPerSecond: 8,
        requestTimeout: 20000,
        interceptor: new RefererInterceptor(this.imageReferers)
    })

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
            await this.store.setCloudflareTarget((/^https?:\/\/[^/]+/i.exec(url) ?? [url])[0])
            throw new Error(`Cloudflare protège ${host}. Va dans les réglages de TagFusion et touche « Cloudflare Bypass », puis réessaie.`)
        }
        if (response.status >= 400) throw new Error(`${host} a répondu ${response.status}`)
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
        return buildSettings(this.store, { discoverAll: force => this.discoverAll(force) })
    }

    override async getCloudflareBypassRequestAsync(): Promise<Request> {
        const target = await this.store.getCloudflareTarget() ?? (await this.store.getSites())[0] ?? 'https://paperback.moe'
        return App.createRequest({ url: `${target}/`, method: 'GET', headers: { referer: `${target}/` } })
    }

    override async supportsTagExclusion(): Promise<boolean> {
        return true
    }

    override async getSearchTags(): Promise<TagSection[]> {
        try {
            const sites = await this.store.getSites()
            // Aucune section vide : Paperback 0.8 les supporte mal
            if (sites.length === 0) return []

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
            return sections
        } catch {
            return []
        }
    }

    // =========================================================================
    // Recherche multi-sites
    // =========================================================================

    override async getSearchResults(query: SearchRequest, metadata: unknown): Promise<PagedResults> {
        const unified = await this.store.unified()
        const inc = query.includedTags ?? []
        const included = inc.map(t => keyOfTagId(t.id)).filter((k): k is string => k !== null)
        const excluded = (query.excludedTags ?? []).map(t => keyOfTagId(t.id)).filter((k): k is string => k !== null)
        const onlySites = inc.map(t => siteOfTagId(t.id)).filter((k): k is string => k !== null)
        const title = (query.title ?? '').trim()

        if (included.length === 0 && title === '') return App.createPagedResults({ results: [] })

        let sites = (await this.store.getSites()).map(siteIdOf)
        if (onlySites.length) sites = sites.filter(s => onlySites.includes(s))

        const meta: SearchMeta = isSearchMeta(metadata) ? metadata : { sites: {}, seen: [] }
        const seen = new Set(meta.seen)
        let results: PartialSourceManga[] = []

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
                    const k = titleKey(it.title)
                    if (seen.has(k)) continue
                    seen.add(k)
                    out.push(App.createPartialSourceManga({
                        mangaId: encodeMangaId(siteId, it.url),
                        title: it.title || 'Sans titre',
                        image: it.image,
                        subtitle: info[siteId]?.name || siteId
                    }))
                }
                return out
            })
            results = interleave(lists)
        }

        meta.seen = [...seen]
        const finished = sites.every(s => meta.sites[s]?.done)
        return App.createPagedResults({ results, metadata: finished ? undefined : meta })
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
                image: d.image,
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
        const pages = engine.parsePages(this.fetcher.load(html), html, pageUrl)
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
