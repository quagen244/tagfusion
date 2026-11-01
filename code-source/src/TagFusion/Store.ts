import { SourceStateManager } from '@paperback/types'
import { normalizeTagText, parseCustomMerges, prettyLabel, siteIdOf, tagKey } from './Utils'

export type EngineName = 'madara' | 'themesia' | 'generic'

/** Un tag tel qu'il existe sur UN site */
export interface SiteTag {
    label: string
    /** Page du site qui liste tous les mangas de ce tag */
    url: string
    /** Valeur utilisable dans le filtre multi-tags du site (ex : genre[]=romance), si le site en a un */
    filter?: string
}

/** Un tag unifié : un nom, et où le trouver sur chaque site */
export interface UnifiedTag {
    key: string
    label: string
    sites: Record<string, SiteTag>
}

export interface SiteInfo {
    base: string
    engine?: EngineName
    name?: string
    discoveredAt?: number
    error?: string
}

type RawTags = Record<string, Record<string, SiteTag>> // siteId -> tagTextNormalisé -> SiteTag

const K_SITES = 'tf_sites'
const K_INFO = 'tf_site_info'
const K_RAW = 'tf_raw_tags'
const K_MERGES = 'tf_merges'
const K_CF = 'tf_cloudflare_target'

/**
 * Tout ce que l'extension retient : la liste des sites, ce qu'on sait de chacun,
 * et tous les tags découverts. Stocké dans le stockage interne de Paperback.
 */
export class Store {
    private raw?: RawTags
    private info?: Record<string, SiteInfo>
    private unifiedCache?: Record<string, UnifiedTag>
    private saveChain: Promise<void> = Promise.resolve()

    constructor(private readonly state: SourceStateManager) {}

    // --- Sites ---------------------------------------------------------------

    async getSites(): Promise<string[]> {
        const v = await this.state.retrieve(K_SITES)
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    }

    async setSites(bases: string[]): Promise<void> {
        await this.state.store(K_SITES, bases)
        // On oublie les sites retirés (et leurs tags)
        const keep = new Set(bases.map(siteIdOf))
        const info = await this.getSiteInfo()
        const raw = await this.getRaw()
        for (const id of Object.keys(info)) if (!keep.has(id)) delete info[id]
        for (const id of Object.keys(raw)) if (!keep.has(id)) delete raw[id]
        for (const b of bases) {
            const id = siteIdOf(b)
            if (!info[id]) info[id] = { base: b }
        }
        this.unifiedCache = undefined
        await this.persist()
    }

    async getSiteInfo(): Promise<Record<string, SiteInfo>> {
        if (!this.info) {
            const v = await this.state.retrieve(K_INFO)
            this.info = (v && typeof v === 'object') ? v as Record<string, SiteInfo> : {}
        }
        return this.info
    }

    async site(siteId: string): Promise<SiteInfo | undefined> {
        return (await this.getSiteInfo())[siteId]
    }

    async updateSite(siteId: string, patch: Partial<SiteInfo>): Promise<void> {
        const info = await this.getSiteInfo()
        const cur = info[siteId]
        if (!cur && !patch.base) return
        info[siteId] = { ...(cur ?? { base: patch.base as string }), ...patch }
        await this.persist()
    }

    // --- Tags ----------------------------------------------------------------

    private async getRaw(): Promise<RawTags> {
        if (!this.raw) {
            const v = await this.state.retrieve(K_RAW)
            this.raw = (v && typeof v === 'object') ? v as RawTags : {}
        }
        return this.raw
    }

    async tagCount(siteId: string): Promise<number> {
        return Object.keys((await this.getRaw())[siteId] ?? {}).length
    }

    /** Ajoute des tags découverts sur un site. Retourne le nombre de NOUVEAUX tags. */
    async addTags(siteId: string, tags: SiteTag[]): Promise<number> {
        const raw = await this.getRaw()
        const bucket = raw[siteId] ?? (raw[siteId] = {})
        let added = 0
        let changed = false
        for (const t of tags) {
            const label = t.label.replace(/\s+/g, ' ').trim()
            const norm = normalizeTagText(label)
            if (!norm || tagKey(label) === null) continue
            const prev = bucket[norm]
            if (!prev) {
                bucket[norm] = { label, url: t.url, ...(t.filter ? { filter: t.filter } : {}) }
                added++
                changed = true
            } else if (t.filter && !prev.filter) {
                prev.filter = t.filter
                changed = true
            }
        }
        if (changed) {
            this.unifiedCache = undefined
            await this.persist()
        }
        return added
    }

    async clearTags(): Promise<void> {
        this.raw = {}
        const info = await this.getSiteInfo()
        for (const s of Object.values(info)) delete s.discoveredAt
        this.unifiedCache = undefined
        await this.persist()
    }

    // --- Fusions personnalisées ("love=romance; bl=boys love") ----------------

    async getMergesText(): Promise<string> {
        const v = await this.state.retrieve(K_MERGES)
        return typeof v === 'string' ? v : ''
    }

    async setMergesText(text: string): Promise<void> {
        await this.state.store(K_MERGES, text)
        this.unifiedCache = undefined
    }

    async customMerges(): Promise<Record<string, string>> {
        return parseCustomMerges(await this.getMergesText())
    }

    /** Tous les tags de tous les sites, fusionnés */
    async unified(): Promise<Record<string, UnifiedTag>> {
        if (this.unifiedCache) return this.unifiedCache
        const raw = await this.getRaw()
        const merges = await this.customMerges()
        const out: Record<string, UnifiedTag> = {}
        const labelVotes: Record<string, Record<string, number>> = {}
        for (const [siteId, tags] of Object.entries(raw)) {
            for (const t of Object.values(tags)) {
                const key = tagKey(t.label, merges)
                if (key === null) continue
                const u = out[key] ?? (out[key] = { key, label: prettyLabel(key), sites: {} })
                if (!u.sites[siteId]) u.sites[siteId] = t
                // Le libellé affiché = la forme la plus fréquente sur les sites
                const votes = labelVotes[key] ?? (labelVotes[key] = {})
                votes[t.label] = (votes[t.label] ?? 0) + 1
            }
        }
        for (const [key, votes] of Object.entries(labelVotes)) {
            const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0]
            const u = out[key]
            if (best && u && normalizeTagText(best[0]) === key) u.label = best[0]
        }
        this.unifiedCache = out
        return out
    }

    /** Clé unifiée d'un libellé vu sur une fiche */
    async keyFor(label: string): Promise<string | null> {
        return tagKey(label, await this.customMerges())
    }

    // --- Dépôts d'extensions dont on importe les sites ---------------------------

    async getRepos(): Promise<string[]> {
        const v = await this.state.retrieve('tf_repos')
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    }

    async setRepos(urls: string[]): Promise<void> {
        await this.state.store('tf_repos', urls)
        await this.state.store('tf_repos_imported_at', 0)
    }

    async getReposImportedAt(): Promise<number> {
        const v = await this.state.retrieve('tf_repos_imported_at')
        return typeof v === 'number' ? v : 0
    }

    async setReposImportedAt(t: number): Promise<void> {
        await this.state.store('tf_repos_imported_at', t)
    }

    // --- Journal de diagnostic -------------------------------------------------

    async getDebugLines(): Promise<string[]> {
        const v = await this.state.retrieve('tf_debug')
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    }

    // --- Cloudflare ---------------------------------------------------------------

    async setCloudflareTarget(base: string): Promise<void> {
        await this.state.store(K_CF, base)
    }

    async getCloudflareTarget(): Promise<string | undefined> {
        const v = await this.state.retrieve(K_CF)
        return typeof v === 'string' ? v : undefined
    }

    // --- Sauvegarde -------------------------------------------------------------

    private persist(): Promise<void> {
        // Les sauvegardes passent l'une après l'autre pour ne jamais s'écraser
        this.saveChain = this.saveChain.then(async () => {
            await this.state.store(K_RAW, this.raw ?? {})
            await this.state.store(K_INFO, this.info ?? {})
        }).catch(() => undefined)
        return this.saveChain
    }
}
