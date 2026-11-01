import { SourceStateManager } from '@paperback/types'
import { cleanTagLabel, normalizeTagText, parseCustomMerges, prettyLabel, siteIdOf, tagKey } from './Utils'

export type EngineName = 'madara' | 'themesia' | 'generic'

/** Un tag tel qu'il existe sur UN site */
export interface SiteTag {
    label: string
    /** Page du site qui liste tous les mangas de ce tag ('' si le tag n'est pas un lien sur ce site) */
    url: string
    /** Valeur utilisable dans le filtre multi-tags du site (ex : genre[]=romance), si le site en a un */
    filter?: string
}

/** Un tag unifié : un nom, où le trouver sur chaque site, et combien de mangas indexés l'ont */
export interface UnifiedTag {
    key: string
    label: string
    sites: Record<string, SiteTag>
    indexed: number
}

export interface SiteInfo {
    base: string
    engine?: EngineName
    name?: string
    discoveredAt?: number
    error?: string
    /** Page du catalogue complet du site ('' = aucune trouvée) */
    catalog?: string
}

/** Un manga dont on a lu la fiche, avec tous ses tags (liens ou non) */
export interface IndexedManga {
    s: string // site
    u: string // adresse de la fiche
    t: string // titre
    i: string // image
    l: string[] // libellés des tags, tels qu'affichés sur la fiche
    at: number // date de lecture
}

type RawTags = Record<string, Record<string, SiteTag>> // siteId -> tagTextNormalisé -> SiteTag
type MangaIndex = Record<string, IndexedManga> // mangaId -> manga

const K_SITES = 'tf_sites'
const K_INFO = 'tf_site_info'
const K_RAW = 'tf_raw_tags'
const K_INDEX = 'tf_manga_index'
const K_MERGES = 'tf_merges'
const K_CF = 'tf_cloudflare_blocked'

/** Nombre maximum de mangas gardés dans l'index (les plus anciens partent en premier) */
const INDEX_LIMIT = 3000
/** Durée pendant laquelle on fait confiance à la copie en mémoire avant de relire le stockage */
const FRESH_MS = 1500

/**
 * Tout ce que l'extension retient : la liste des sites, ce qu'on sait de chacun,
 * les tags découverts et l'index des mangas lus. Stocké dans le stockage interne de Paperback.
 *
 * Paperback peut faire tourner l'extension en plusieurs exemplaires en même temps
 * (recherche, fiche, réglages). Donc on ne garde jamais longtemps une copie en mémoire :
 * on relit le stockage avant chaque lecture importante, et on fusionne avant chaque écriture,
 * pour ne jamais écraser ce qu'un autre exemplaire vient d'enregistrer.
 */
export class Store {
    private raw?: { data: RawTags, at: number }
    private info?: { data: Record<string, SiteInfo>, at: number }
    private index?: { data: MangaIndex, at: number }
    private unifiedCache?: { forRaw: RawTags, forIndex: MangaIndex, merges: string, data: Record<string, UnifiedTag> }
    private writeChain: Promise<void> = Promise.resolve()

    constructor(private readonly state: SourceStateManager) {}

    /** Les écritures passent l'une après l'autre, chacune relit puis fusionne */
    private serial<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.writeChain.then(fn)
        this.writeChain = run.then(() => undefined, () => undefined)
        return run
    }

    private async load<T extends object>(key: string): Promise<T> {
        const v = await this.state.retrieve(key)
        return (v && typeof v === 'object' && !Array.isArray(v)) ? v as T : {} as T
    }

    // --- Sites ---------------------------------------------------------------

    private sitesCache?: string[]

    async getSites(): Promise<string[]> {
        const v = await this.state.retrieve(K_SITES)
        this.sitesCache = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
        return this.sitesCache
    }

    /** Dernière liste connue, pour les appels synchrones */
    sitesSync(): string[] {
        return this.sitesCache ?? []
    }

    async setSites(bases: string[]): Promise<void> {
        this.sitesCache = bases
        await this.state.store(K_SITES, bases)
        const keep = new Set(bases.map(siteIdOf))
        await this.serial(async () => {
            // On oublie les sites retirés (et leurs tags)
            const info = await this.load<Record<string, SiteInfo>>(K_INFO)
            for (const id of Object.keys(info)) if (!keep.has(id)) delete info[id]
            for (const b of bases) {
                const id = siteIdOf(b)
                if (!info[id]) info[id] = { base: b }
            }
            await this.state.store(K_INFO, info)
            this.info = { data: info, at: Date.now() }

            const raw = await this.load<RawTags>(K_RAW)
            for (const id of Object.keys(raw)) if (!keep.has(id)) delete raw[id]
            await this.state.store(K_RAW, raw)
            this.raw = { data: raw, at: Date.now() }
        })
    }

    async getSiteInfo(): Promise<Record<string, SiteInfo>> {
        if (!this.info || Date.now() - this.info.at > FRESH_MS) {
            this.info = { data: await this.load<Record<string, SiteInfo>>(K_INFO), at: Date.now() }
        }
        return this.info.data
    }

    async site(siteId: string): Promise<SiteInfo | undefined> {
        return (await this.getSiteInfo())[siteId]
    }

    async updateSite(siteId: string, patch: Partial<SiteInfo>): Promise<void> {
        await this.serial(async () => {
            const info = await this.load<Record<string, SiteInfo>>(K_INFO)
            const cur = info[siteId]
            if (!cur && !patch.base) return
            const next: SiteInfo = { ...(cur ?? { base: patch.base as string }), ...patch }
            // "undefined" veut dire "effacer ce champ"
            for (const k of Object.keys(patch) as (keyof SiteInfo)[]) if (patch[k] === undefined) delete next[k]
            info[siteId] = next
            await this.state.store(K_INFO, info)
            this.info = { data: info, at: Date.now() }
        })
    }

    // --- Tags des sites (ceux qui ont une page "tous les mangas du tag") ---------

    private async getRaw(force = false): Promise<RawTags> {
        if (force || !this.raw || Date.now() - this.raw.at > FRESH_MS) {
            this.raw = { data: await this.load<RawTags>(K_RAW), at: Date.now() }
        }
        return this.raw.data
    }

    async tagCount(siteId: string): Promise<number> {
        return Object.keys((await this.getRaw(true))[siteId] ?? {}).length
    }

    /** Ajoute des tags découverts sur un site. Retourne le nombre de NOUVEAUX tags. */
    async addTags(siteId: string, tags: SiteTag[]): Promise<number> {
        const linked = tags.filter(t => t.url)
        if (linked.length === 0) return 0
        return this.serial(async () => {
            const raw = await this.getRaw(true)
            const bucket = raw[siteId] ?? (raw[siteId] = {})
            let added = 0
            let changed = false
            for (const t of linked) {
                // Sans le nombre d'œuvres que certains sites collent au tag
                const label = cleanTagLabel(t.label)
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
            if (changed) await this.state.store(K_RAW, raw)
            return added
        })
    }

    async clearTags(): Promise<void> {
        await this.serial(async () => {
            await this.state.store(K_RAW, {})
            await this.state.store(K_INDEX, {})
            this.raw = { data: {}, at: Date.now() }
            this.index = { data: {}, at: Date.now() }
            const info = await this.load<Record<string, SiteInfo>>(K_INFO)
            for (const s of Object.values(info)) delete s.discoveredAt
            await this.state.store(K_INFO, info)
            this.info = { data: info, at: Date.now() }
        })
    }

    // --- Index des mangas lus (tous leurs tags, même ceux qui ne sont pas des liens) ---

    private async getIndex(force = false): Promise<MangaIndex> {
        if (force || !this.index || Date.now() - this.index.at > FRESH_MS) {
            this.index = { data: await this.load<MangaIndex>(K_INDEX), at: Date.now() }
        }
        return this.index.data
    }

    async indexSize(): Promise<number> {
        return Object.keys(await this.getIndex(true)).length
    }

    /** Enregistre (ou met à jour) un manga et tous ses tags. Retourne true si ses tags ont changé. */
    async indexManga(mangaId: string, entry: Omit<IndexedManga, 'at'>): Promise<boolean> {
        return (await this.indexMany([{ id: mangaId, entry }])) > 0
    }

    /**
     * Enregistre plusieurs mangas en UNE seule écriture (l'index peut être gros : l'écrire
     * à chaque fiche serait lent et lourd en mémoire). Retourne le nombre de mangas modifiés.
     */
    async indexMany(list: { id: string, entry: Omit<IndexedManga, 'at'> }[]): Promise<number> {
        if (list.length === 0) return 0
        return this.serial(async () => {
            const index = await this.getIndex(true)
            let changed = 0
            const now = Date.now()
            for (const { id, entry } of list) {
                const labels = [...new Set(entry.l.map(cleanTagLabel).filter(l => tagKey(l) !== null))]
                const prev = index[id]
                if (!prev || prev.l.join('|') !== labels.join('|')) changed++
                index[id] = { s: entry.s, u: entry.u, t: entry.t.slice(0, 200), i: entry.i, l: labels, at: now }
            }
            const ids = Object.keys(index)
            if (ids.length > INDEX_LIMIT) {
                ids.sort((a, b) => (index[a]?.at ?? 0) - (index[b]?.at ?? 0))
                for (const id of ids.slice(0, ids.length - INDEX_LIMIT)) delete index[id]
            }
            await this.state.store(K_INDEX, index)
            return changed
        })
    }

    /** Un manga déjà indexé (ses tags sont connus sans relire sa fiche) */
    async getIndexed(mangaId: string): Promise<IndexedManga | undefined> {
        return (await this.getIndex())[mangaId]
    }

    /** Mangas indexés qui ont tous les tags demandés et aucun des tags exclus */
    async searchIndex(included: string[], excluded: string[], sites?: string[]): Promise<(IndexedManga & { id: string })[]> {
        const index = await this.getIndex(true)
        const merges = await this.customMerges()
        const out: (IndexedManga & { id: string })[] = []
        for (const [id, m] of Object.entries(index)) {
            if (sites && !sites.includes(m.s)) continue
            const keys = new Set(m.l.map(l => tagKey(l, merges)).filter((k): k is string => k !== null))
            if (included.every(k => keys.has(k)) && !excluded.some(k => keys.has(k))) out.push({ ...m, id })
        }
        return out.sort((a, b) => b.at - a.at)
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

    /** Tous les tags de tous les sites et de l'index, fusionnés */
    async unified(): Promise<Record<string, UnifiedTag>> {
        const raw = await this.getRaw()
        const index = await this.getIndex()
        const mergesText = await this.getMergesText()
        const c = this.unifiedCache
        if (c && c.forRaw === raw && c.forIndex === index && c.merges === mergesText) return c.data

        const merges = parseCustomMerges(mergesText)
        const out: Record<string, UnifiedTag> = {}
        const labelVotes: Record<string, Record<string, number>> = {}
        const vote = (key: string, label: string): void => {
            const votes = labelVotes[key] ?? (labelVotes[key] = {})
            votes[label] = (votes[label] ?? 0) + 1
        }
        for (const [siteId, tags] of Object.entries(raw)) {
            for (const t of Object.values(tags)) {
                const key = tagKey(t.label, merges)
                if (key === null) continue
                const u = out[key] ?? (out[key] = { key, label: prettyLabel(key), sites: {}, indexed: 0 })
                if (!u.sites[siteId]) u.sites[siteId] = t
                vote(key, cleanTagLabel(t.label))
            }
        }
        for (const m of Object.values(index)) {
            const seen = new Set<string>()
            for (const l of m.l) {
                const key = tagKey(l, merges)
                if (key === null || seen.has(key)) continue
                seen.add(key)
                const u = out[key] ?? (out[key] = { key, label: prettyLabel(key), sites: {}, indexed: 0 })
                u.indexed++
                vote(key, cleanTagLabel(l))
            }
        }
        // Le libellé affiché = la forme la plus fréquente
        for (const [key, votes] of Object.entries(labelVotes)) {
            const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0]
            const u = out[key]
            if (best && u && normalizeTagText(best[0]) === key) u.label = best[0]
        }
        this.unifiedCache = { forRaw: raw, forIndex: index, merges: mergesText, data: out }
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

    // --- Remise à zéro ----------------------------------------------------------

    /**
     * Efface l'index des mangas, les tags appris, l'état des sites (moteur détecté, erreurs),
     * la liste Cloudflare et le journal. Avec `full`, efface aussi les sites, les dépôts et les fusions.
     */
    async resetAll(full: boolean): Promise<void> {
        await this.serial(async () => {
            for (const k of [K_RAW, K_INDEX, K_INFO]) await this.state.store(k, {})
            await this.state.store(K_CF, [])
            await this.state.store('tf_debug', [])
            await this.state.store('tf_repos_imported_at', 0)
            if (full) {
                await this.state.store(K_SITES, [])
                await this.state.store('tf_repos', [])
                await this.state.store(K_MERGES, '')
                this.sitesCache = []
            } else {
                // On garde les sites, avec une fiche vierge pour chacun
                const sites = await this.getSites()
                const info: Record<string, SiteInfo> = {}
                for (const b of sites) info[siteIdOf(b)] = { base: b }
                await this.state.store(K_INFO, info)
            }
            this.raw = { data: {}, at: Date.now() }
            this.index = { data: {}, at: Date.now() }
            this.info = undefined
            this.cfBlocked = []
            this.unifiedCache = undefined
        })
    }

    async getDiagUrl(): Promise<string> {
        const v = await this.state.retrieve('tf_diag_url')
        return typeof v === 'string' ? v : ''
    }

    async setDiagUrl(v: string): Promise<void> {
        await this.state.store('tf_diag_url', v)
    }

    // --- Journal de diagnostic -------------------------------------------------

    async getDebugLines(): Promise<string[]> {
        const v = await this.state.retrieve('tf_debug')
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    }

    // --- Cloudflare ---------------------------------------------------------------
    // Liste des sites bloqués par Cloudflare (adresses de base), dans l'ordre où ils ont bloqué.

    private cfBlocked?: string[]

    async getCloudflareBlocked(): Promise<string[]> {
        const v = await this.state.retrieve(K_CF)
        this.cfBlocked = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
        return this.cfBlocked
    }

    /** Version synchrone (dernier état connu), pour les appels de l'app qui n'attendent pas */
    cloudflareBlockedSync(): string[] {
        return this.cfBlocked ?? []
    }

    async markCloudflareBlocked(base: string): Promise<void> {
        await this.serial(async () => {
            const list = await this.getCloudflareBlocked()
            if (list.includes(base)) return
            this.cfBlocked = [...list, base]
            await this.state.store(K_CF, this.cfBlocked)
        })
    }

    /** Un site a répondu normalement : il n'est plus bloqué */
    async markCloudflareOk(host: string): Promise<void> {
        // Rapide dans le cas courant : rien n'est bloqué
        if (this.cfBlocked && !this.cfBlocked.some(b => siteIdOf(b) === host)) return
        await this.serial(async () => {
            const list = await this.getCloudflareBlocked()
            const next = list.filter(b => siteIdOf(b) !== host)
            if (next.length === list.length) return
            this.cfBlocked = next
            await this.state.store(K_CF, next)
        })
    }
}
