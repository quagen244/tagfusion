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
    /** 'no' : la recherche du site ignore les recherches à plusieurs tags (on ne réessaie plus) */
    combo?: 'no'
}

/** Un manga dont on a lu la fiche, avec tous ses tags (liens ou non) */
export interface IndexedManga {
    s: string // site
    u: string // adresse de la fiche
    t: string // titre
    i: string // image
    l: string[] // libellés des tags, tels qu'affichés sur la fiche
    at: number // date de lecture
    /** 1 = fiche pas encore lue : seulement les tags vus sur sa vignette dans une liste (sûrs, mais peut-être incomplets) */
    p?: 1
}

type RawTags = Record<string, Record<string, SiteTag>> // siteId -> tagTextNormalisé -> SiteTag
type MangaIndex = Record<string, IndexedManga> // mangaId -> manga

const K_SITES = 'tf_sites'
const K_INFO = 'tf_site_info'
const K_RAW = 'tf_raw_tags'
/** Ancien index (une seule clé) : relu et réparti dans les morceaux à la première écriture */
const K_INDEX = 'tf_manga_index'
/** L'index est découpé en morceaux : une écriture ne réenregistre que les morceaux modifiés */
const INDEX_SHARDS = 8
const shardKey = (i: number): string => `tf_manga_index_${i}`
const K_INDEX_VER = 'tf_manga_index_ver'
function shardOf(id: string): number {
    let h = 0
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
    return Math.abs(h) % INDEX_SHARDS
}
const K_MERGES = 'tf_merges'
const K_CF = 'tf_cloudflare_blocked'

/** Nombre maximum de mangas gardés dans l'index (les vignettes seules partent en premier, puis les plus anciens) */
const INDEX_LIMIT = 12000
/** Durée pendant laquelle on fait confiance à la copie en mémoire avant de relire le stockage */
const FRESH_MS = 1500
const INDEX_FRESH_MS = 10000

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
    /** L'ancien index (une seule clé) contenait encore des mangas : à répartir dans les morceaux */
    private legacyIndex = false
    /** Version de l'index au moment où la copie en mémoire a été lue */
    private indexVer: unknown
    private unifiedCache?: { forRaw: RawTags, forIndex: MangaIndex, merges: string, rev: number, rawSig: string, indexSig: string, data: Record<string, UnifiedTag> }
    /** Compteur de modifications des tags et de l'index (une copie en mémoire n'est valable que pour la même valeur) */
    private rev = 0
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
            this.rev++
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
            if (changed) { await this.state.store(K_RAW, raw); this.rev++ }
            return added
        })
    }

    /**
     * Toutes les pages de ce site pour un tag unifié (synonymes fusionnés : "Yuri" et "Girls Love"
     * peuvent être deux pages différentes du même site). Celle donnée en premier passe d'abord.
     */
    async siteVariants(siteId: string, key: string, first?: SiteTag): Promise<SiteTag[]> {
        const merges = await this.customMerges()
        const out: SiteTag[] = first?.url ? [first] : []
        for (const t of Object.values((await this.getRaw())[siteId] ?? {})) {
            if (!t.url || out.some(o => o.url === t.url)) continue
            if (tagKey(t.label, merges) === key) out.push(t)
        }
        return out
    }

    async clearTags(): Promise<void> {
        await this.serial(async () => {
            await this.state.store(K_RAW, {})
            await this.clearIndexKeys()
            this.rev++
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
        // L'index est gros : on ne le relit en entier que s'il a changé (petit numéro de version
        // enregistré à chaque écriture, par n'importe quel exemplaire de l'extension)
        if (!force && this.index) {
            const age = Date.now() - this.index.at
            if (age <= FRESH_MS) return this.index.data
            if (age <= INDEX_FRESH_MS) {
                const ver = await this.state.retrieve(K_INDEX_VER)
                if (ver === this.indexVer) { this.index.at = Date.now() - FRESH_MS; return this.index.data }
            }
        }
        {
            this.indexVer = await this.state.retrieve(K_INDEX_VER)
            const data: MangaIndex = {}
            const legacy = await this.load<MangaIndex>(K_INDEX)
            this.legacyIndex = Object.keys(legacy).length > 0
            for (const [id, m] of Object.entries(legacy)) if (isIndexed(m)) data[id] = m
            for (let i = 0; i < INDEX_SHARDS; i++) {
                for (const [id, m] of Object.entries(await this.load<MangaIndex>(shardKey(i)))) {
                    if (!isIndexed(m)) continue
                    const prev = data[id]
                    // Le plus récent gagne, une fiche lue gagne toujours sur une simple vignette
                    if (!prev || (prev.p && !m.p) || (!!prev.p === !!m.p && m.at >= prev.at)) data[id] = m
                }
            }
            this.index = { data, at: Date.now() }
        }
        return this.index.data
    }

    private async clearIndexKeys(): Promise<void> {
        await this.state.store(K_INDEX, {})
        for (let i = 0; i < INDEX_SHARDS; i++) await this.state.store(shardKey(i), {})
        this.legacyIndex = false
        await this.bumpIndexVer()
    }

    private async bumpIndexVer(): Promise<void> {
        const v = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`
        await this.state.store(K_INDEX_VER, v)
        this.indexVer = v
    }

    /** Enregistre les morceaux modifiés (tous, la première fois après l'ancien format) */
    private async saveIndex(index: MangaIndex, dirty: Set<number>): Promise<void> {
        const all = this.legacyIndex
        if (!all && dirty.size === 0) return
        const buckets: MangaIndex[] = Array.from({ length: INDEX_SHARDS }, () => ({}))
        for (const [id, m] of Object.entries(index)) (buckets[shardOf(id)] as MangaIndex)[id] = m
        for (let i = 0; i < INDEX_SHARDS; i++) if (all || dirty.has(i)) await this.state.store(shardKey(i), buckets[i])
        if (all) { await this.state.store(K_INDEX, {}); this.legacyIndex = false }
        await this.bumpIndexVer()
        this.rev++
    }

    /** Au-delà de la limite : d'abord les vignettes seules, puis les fiches les plus anciennes */
    private trimIndex(index: MangaIndex, dirty: Set<number>): void {
        const ids = Object.keys(index)
        if (ids.length <= INDEX_LIMIT) return
        ids.sort((a, b) => {
            const ma = index[a] as IndexedManga, mb = index[b] as IndexedManga
            if (!!ma.p !== !!mb.p) return ma.p ? -1 : 1
            return ma.at - mb.at
        })
        for (const id of ids.slice(0, ids.length - INDEX_LIMIT)) { delete index[id]; dirty.add(shardOf(id)) }
    }

    async indexSize(): Promise<number> {
        return Object.values(await this.getIndex(true)).filter(m => !m.p).length
    }

    /** Enregistre (ou met à jour) un manga et tous ses tags. Retourne true si ses tags ont changé. */
    async indexManga(mangaId: string, entry: Omit<IndexedManga, 'at'>): Promise<boolean> {
        return (await this.indexMany([{ id: mangaId, entry }])) > 0
    }

    /**
     * Enregistre plusieurs mangas (fiches lues) en UNE seule écriture, en ne réécrivant que
     * les morceaux de l'index concernés. Retourne le nombre de mangas modifiés.
     */
    async indexMany(list: { id: string, entry: Omit<IndexedManga, 'at' | 'p'> }[]): Promise<number> {
        if (list.length === 0) return 0
        return this.serial(async () => {
            const index = await this.getIndex(true)
            const dirty = new Set<number>()
            let changed = 0
            const now = Date.now()
            for (const { id, entry } of list) {
                const labels = [...new Set(entry.l.map(cleanTagLabel).filter(l => tagKey(l) !== null))]
                const prev = index[id]
                if (!prev || prev.p || prev.l.join('|') !== labels.join('|')) changed++
                index[id] = { s: entry.s, u: entry.u, t: entry.t.slice(0, 200), i: entry.i, l: labels, at: now }
                dirty.add(shardOf(id))
            }
            this.trimIndex(index, dirty)
            await this.saveIndex(index, dirty)
            return changed
        })
    }

    /**
     * Retient les tags vus sur la vignette de mangas dont la fiche n'a pas été lue.
     * Une fiche déjà lue n'est jamais remplacée ; une vignette déjà vue est complétée.
     */
    async notePartial(list: { id: string, entry: Omit<IndexedManga, 'at' | 'p'> }[]): Promise<number> {
        if (list.length === 0) return 0
        return this.serial(async () => {
            const index = await this.getIndex(true)
            const dirty = new Set<number>()
            const now = Date.now()
            let changed = 0
            for (const { id, entry } of list) {
                const prev = index[id]
                if (prev && !prev.p) continue
                const labels = [...new Set([...(prev?.l ?? []), ...entry.l.map(cleanTagLabel)].filter(l => tagKey(l) !== null))]
                if (labels.length === 0) continue
                if (prev && labels.length === prev.l.length) continue
                index[id] = { s: entry.s, u: entry.u, t: (entry.t || prev?.t || '').slice(0, 200), i: entry.i || prev?.i || '', l: labels, at: now, p: 1 }
                dirty.add(shardOf(id))
                changed++
            }
            this.trimIndex(index, dirty)
            await this.saveIndex(index, dirty)
            return changed
        })
    }

    /** Un manga déjà indexé (ses tags sont connus sans relire sa fiche) */
    async getIndexed(mangaId: string): Promise<IndexedManga | undefined> {
        return (await this.getIndex())[mangaId]
    }

    /** Mangas indexés qui ont tous les tags demandés et aucun des tags exclus */
    async searchIndex(included: string[], excluded: string[], sites?: string[], onlyRead = false): Promise<(IndexedManga & { id: string })[]> {
        const index = await this.getIndex(true)
        const merges = await this.customMerges()
        const out: (IndexedManga & { id: string })[] = []
        for (const [id, m] of Object.entries(index)) {
            if (sites && !sites.includes(m.s)) continue
            // Vignette seule : ses tags peuvent être incomplets, elle ne prouve donc pas l'absence d'un tag exclu
            if (m.p && (onlyRead || excluded.length > 0 || included.length === 0)) continue
            const keys = new Set(m.l.map(l => tagKey(l, merges)).filter((k): k is string => k !== null))
            if (included.every(k => keys.has(k)) && !excluded.some(k => keys.has(k))) out.push({ ...m, id })
        }
        return out.sort((a, b) => b.at - a.at)
    }

    /** Nombre de mangas indexés de ce site qui portent chacun de ces tags (pour partir du tag le plus rare) */
    async tagCounts(siteId: string, keys: string[]): Promise<Record<string, number>> {
        const out: Record<string, number> = {}
        for (const k of keys) out[k] = 0
        const index = await this.getIndex()
        const merges = await this.customMerges()
        for (const m of Object.values(index)) {
            if (m.s !== siteId) continue
            const ks = new Set(m.l.map(l => tagKey(l, merges)).filter((k): k is string => k !== null))
            for (const k of keys) if (ks.has(k)) out[k] = (out[k] ?? 0) + 1
        }
        return out
    }

    /** Comme tagCounts, pour plusieurs sites en un seul passage sur l'index : site -> tag -> nombre */
    async tagCountsBySite(wanted: Record<string, string[]>): Promise<Record<string, Record<string, number>>> {
        const out: Record<string, Record<string, number>> = {}
        for (const [site, keys] of Object.entries(wanted)) { out[site] = {}; for (const k of keys) (out[site] as Record<string, number>)[k] = 0 }
        if (Object.keys(out).length === 0) return out
        const index = await this.getIndex()
        const merges = await this.customMerges()
        for (const m of Object.values(index)) {
            const keys = wanted[m.s]
            if (!keys) continue
            const row = out[m.s] as Record<string, number>
            for (const l of m.l) {
                const k = tagKey(l, merges)
                if (k !== null && Object.prototype.hasOwnProperty.call(row, k)) row[k] = (row[k] ?? 0) + 1
            }
        }
        return out
    }

    // --- Fusions personnalisées ("love=romance; bl=boys love") ----------------

    async getMergesText(): Promise<string> {
        const v = await this.state.retrieve(K_MERGES)
        return typeof v === 'string' ? v : ''
    }

    async setMergesText(text: string): Promise<void> {
        await this.state.store(K_MERGES, text)
        this.rev++
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
        const rawSig = Object.entries(raw).map(([k, v]) => `${k}:${Object.keys(v).length}`).join(',')
        const indexSig = `${Object.keys(index).length}:${Object.values(index).reduce((n, m) => n + m.l.length + (m.at % 997), 0)}`
        const c = this.unifiedCache
        if (c && c.forRaw === raw && c.forIndex === index && c.merges === mergesText && c.rev === this.rev && c.rawSig === rawSig && c.indexSig === indexSig) return c.data

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
                // Plusieurs formes du même tag sur un site : on garde celle qui a une page (et un filtre)
                const prev = u.sites[siteId]
                if (!prev || (!prev.url && t.url) || (prev.url && t.url && !prev.filter && t.filter)) u.sites[siteId] = t
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
        this.unifiedCache = { forRaw: raw, forIndex: index, merges: mergesText, rev: this.rev, rawSig, indexSig, data: out }
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

    // --- Serveurs d'images -> site d'origine (en-tête Referer), gardé entre les sessions ---

    private imgRef?: { data: Record<string, string>, at: number }

    async getImageReferers(): Promise<Record<string, string>> {
        if (!this.imgRef || Date.now() - this.imgRef.at > 10000) {
            this.imgRef = { data: await this.load<Record<string, string>>('tf_image_referers'), at: Date.now() }
        }
        return this.imgRef.data
    }

    async addImageReferers(map: Record<string, string>): Promise<void> {
        const entries = Object.entries(map)
        if (entries.length === 0) return
        const cur = await this.getImageReferers()
        if (entries.every(([h, b]) => cur[h] === b)) return
        await this.serial(async () => {
            const data = await this.load<Record<string, string>>('tf_image_referers')
            for (const [h, b] of entries) data[h] = b
            // Au plus 300 serveurs gardés
            const keys = Object.keys(data)
            for (const k of keys.slice(0, Math.max(0, keys.length - 300))) delete data[k]
            await this.state.store('tf_image_referers', data)
            this.imgRef = { data, at: Date.now() }
        })
    }

    // --- Pages des chapitres déjà chargés (même résultat à chaque ouverture) ---------

    async getCachedPages(key: string): Promise<{ p: string[], at: number } | undefined> {
        const all = await this.load<Record<string, { p: string[], at: number }>>('tf_pages_cache')
        const hit = all[key]
        return hit && Array.isArray(hit.p) && hit.p.length ? hit : undefined
    }

    async setCachedPages(key: string, pages: string[]): Promise<void> {
        await this.serial(async () => {
            const all = await this.load<Record<string, { p: string[], at: number }>>('tf_pages_cache')
            all[key] = { p: pages, at: Date.now() }
            // Les 40 chapitres les plus récents
            const keys = Object.keys(all).sort((a, b) => (all[a]?.at ?? 0) - (all[b]?.at ?? 0))
            for (const k of keys.slice(0, Math.max(0, keys.length - 40))) delete all[k]
            await this.state.store('tf_pages_cache', all)
        })
    }

    // --- Remise à zéro ----------------------------------------------------------

    /**
     * Efface l'index des mangas, les tags appris, l'état des sites (moteur détecté, erreurs),
     * la liste Cloudflare et le journal. Avec `full`, efface aussi les sites, les dépôts et les fusions.
     */
    async resetAll(full: boolean): Promise<void> {
        await this.serial(async () => {
            for (const k of [K_RAW, K_INFO, 'tf_pages_cache']) await this.state.store(k, {})
            await this.clearIndexKeys()
            this.rev++
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

function isIndexed(m: unknown): m is IndexedManga {
    if (!m || typeof m !== 'object') return false
    const o = m as Record<string, unknown>
    return typeof o['s'] === 'string' && typeof o['u'] === 'string' && Array.isArray(o['l']) && typeof o['at'] === 'number'
}
