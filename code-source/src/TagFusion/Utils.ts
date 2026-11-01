// Fonctions pures (aucun appel réseau, aucune dépendance à Paperback) : faciles à tester.

/** Normalise une URL de site saisie par l'utilisateur : "Site.com/" -> "https://site.com" */
export function normalizeBaseUrl(input: string): string | null {
    let s = input.trim()
    if (s === '') return null
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s
    const m = /^(https?):\/\/([^/?#\s]+)/i.exec(s)
    if (!m || !m[2] || !m[2].includes('.')) return null
    return `${(m[1] ?? 'https').toLowerCase()}://${m[2].toLowerCase()}`
}

/** Identifiant court d'un site : son nom d'hôte sans "www." */
export function siteIdOf(baseUrl: string): string {
    const m = /^https?:\/\/([^/?#]+)/i.exec(baseUrl)
    return (m?.[1] ?? baseUrl).toLowerCase().replace(/^www\./, '')
}

/** Découpe la liste de sites saisie (virgules, espaces, retours à la ligne) */
export function parseSiteList(input: string): string[] {
    const out: string[] = []
    for (const part of input.split(/[\s,;]+/)) {
        const base = normalizeBaseUrl(part)
        if (base && !out.includes(base)) out.push(base)
    }
    return out
}

/** Rend une URL absolue par rapport à une base */
export function absoluteUrl(href: string | undefined, base: string): string | null {
    if (!href) return null
    const h = href.trim()
    if (h === '' || h.startsWith('#') || /^(javascript|mailto|data):/i.test(h)) return null
    if (/^https?:\/\//i.test(h)) return h
    if (h.startsWith('//')) return 'https:' + h
    const origin = (/^https?:\/\/[^/]+/i.exec(base) ?? [base])[0]
    if (h.startsWith('/')) return origin + h
    const dir = base.replace(/[?#].*$/, '').replace(/[^/]*$/, '')
    return (dir.endsWith('/') ? dir : dir + '/') + h
}

/** Hôte d'une URL, sans www. */
export function hostOf(url: string): string {
    return siteIdOf(url)
}

/** Chemin + requête d'une URL (ce qu'on stocke dans les IDs) */
export function pathOf(url: string): string {
    const m = /^https?:\/\/[^/]+(\/[^#]*)?/i.exec(url)
    return m?.[1] ?? '/'
}

// --- IDs Paperback -----------------------------------------------------------
// Paperback utilise les IDs comme clés internes (base de données, téléchargements) :
// on les garde limités à [A-Za-z0-9._-], sans "/", ":" ni espaces.

/** Encode n'importe quel texte avec seulement A-Z a-z 0-9 . - _ (réversible) */
export function safeEncode(s: string): string {
    return encodeURIComponent(s)
        .replace(/[!'()*~_]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
        .replace(/%/g, '_')
}

export function safeDecode(s: string): string {
    return decodeURIComponent(s.replace(/_/g, '%'))
}

const ID_SEP = '\n'

export function encodeMangaId(siteId: string, url: string): string {
    return safeEncode(siteId + ID_SEP + pathOf(url))
}

export function decodeMangaId(mangaId: string): { siteId: string, path: string } {
    const raw = safeDecode(mangaId)
    const i = raw.indexOf(ID_SEP)
    if (i < 0) throw new Error(`ID de manga invalide : ${mangaId}`)
    return { siteId: raw.slice(0, i), path: raw.slice(i + ID_SEP.length) }
}

export function encodeChapterId(url: string): string {
    return safeEncode(pathOf(url))
}

export function decodeChapterId(chapterId: string): string {
    return safeDecode(chapterId)
}

/** ID de tag pour Paperback : "tag_sci-fi" <-> clé "sci fi" */
export function tagIdOf(key: string): string {
    return 'tag_' + key.replace(/ /g, '-')
}

export function keyOfTagId(id: string): string | null {
    return id.startsWith('tag_') ? id.slice(4).replace(/-/g, ' ') : null
}

export function siteTagIdOf(siteId: string): string {
    return 'site_' + safeEncode(siteId)
}

export function siteOfTagId(id: string): string | null {
    return id.startsWith('site_') ? safeDecode(id.slice(5)) : null
}

/** Date toujours valide (une date invalide peut faire planter l'app) */
export function safeDate(d: Date | undefined, now: number = Date.now()): Date {
    return d instanceof Date && !isNaN(d.getTime()) ? d : new Date(now)
}

/** Nombre toujours valide */
export function safeNumber(n: number, fallback = 0): number {
    return typeof n === 'number' && isFinite(n) ? n : fallback
}

// --- Tags ----------------------------------------------------------------------

/** Synonymes intégrés : forme normalisée -> clé unifiée */
export const BUILTIN_SYNONYMS: Record<string, string> = {
    'romantic': 'romance',
    'romance comedy': 'romcom',
    'romantic comedy': 'romcom',
    'rom com': 'romcom',
    'scifi': 'sci fi',
    'science fiction': 'sci fi',
    'sf': 'sci fi',
    'slice of life': 'slice of life',
    'sol': 'slice of life',
    'tranche de vie': 'slice of life',
    'school': 'school life',
    'school life': 'school life',
    'vie scolaire': 'school life',
    'martial art': 'martial arts',
    'arts martiaux': 'martial arts',
    'super power': 'superpower',
    'super powers': 'superpower',
    'superpowers': 'superpower',
    'supernatural power': 'superpower',
    'reincarnated': 'reincarnation',
    'reincarnate': 'reincarnation',
    'reincarnation': 'reincarnation',
    'regression': 'regression',
    'time travel': 'time travel',
    'time travels': 'time travel',
    'boys love': 'boys love',
    'bl': 'boys love',
    'girls love': 'girls love',
    'gl': 'girls love',
    'shoujo ai': 'shoujo ai',
    'shounen ai': 'shounen ai',
    'shonen': 'shounen',
    'shoujo': 'shoujo',
    'shojo': 'shoujo',
    'seinen': 'seinen',
    'josei': 'josei',
    'isekai': 'isekai',
    'harem': 'harem',
    'reverse harem': 'reverse harem',
    'action': 'action',
    'adventure': 'adventure',
    'aventure': 'adventure',
    'comedy': 'comedy',
    'comedie': 'comedy',
    'humour': 'comedy',
    'humor': 'comedy',
    'drama': 'drama',
    'drame': 'drama',
    'fantasy': 'fantasy',
    'fantastique': 'fantasy',
    'fantaisie': 'fantasy',
    'horror': 'horror',
    'horreur': 'horror',
    'mystery': 'mystery',
    'mystere': 'mystery',
    'psychological': 'psychological',
    'psychologique': 'psychological',
    'sports': 'sports',
    'sport': 'sports',
    'tragedy': 'tragedy',
    'tragedie': 'tragedy',
    'historical': 'historical',
    'historique': 'historical',
    'history': 'historical',
    'magic': 'magic',
    'magie': 'magic',
    'mecha': 'mecha',
    'military': 'military',
    'militaire': 'military',
    'music': 'music',
    'musique': 'music',
    'cooking': 'cooking',
    'cuisine': 'cooking',
    'game': 'game',
    'games': 'game',
    'gaming': 'game',
    'video games': 'video game',
    'video game': 'video game',
    'webtoons': 'webtoon',
    'webtoon': 'webtoon',
    'manhwas': 'manhwa',
    'manhuas': 'manhua',
    'mangas': 'manga',
    'full color': 'full color',
    'full colour': 'full color',
    'colored': 'full color',
    'coloured': 'full color',
    'gender bender': 'gender bender',
    'genderswap': 'gender bender',
    'gender swap': 'gender bender',
    'demon': 'demons',
    'demons': 'demons',
    'monster': 'monsters',
    'monsters': 'monsters',
    'vampire': 'vampires',
    'vampires': 'vampires',
    'zombie': 'zombies',
    'zombies': 'zombies',
    'ghost': 'ghosts',
    'ghosts': 'ghosts',
    'survival': 'survival',
    'thriller': 'thriller',
    'crime': 'crime',
    'murim': 'murim',
    'wuxia': 'wuxia',
    'xianxia': 'xianxia',
    'cultivation': 'cultivation',
    'villainess': 'villainess',
    'office workers': 'office workers',
    'office': 'office workers',
    'workplace': 'office workers',
    'delinquent': 'delinquents',
    'delinquents': 'delinquents'
}

/** Mots qui ne sont pas de vrais tags (liens de navigation aspirés par erreur) */
const JUNK_TAGS = new Set([
    'all', 'tous', 'toutes', 'more', 'plus', 'see all', 'view all', 'voir tout', 'home', 'accueil',
    'next', 'previous', 'prev', 'suivant', 'precedent', 'page', 'genres', 'genre', 'tags', 'tag',
    'categories', 'category', 'menu', 'search', 'recherche', 'latest', 'popular', 'new', 'hot'
])

/** "Sci-Fi ", "sci‑fi", "Science Fiction" -> "sci fi" (forme comparable) */
export function normalizeTagText(label: string): string {
    return label
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/['’`]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ')
}

/**
 * Clé unifiée d'un tag. `custom` = fusions de l'utilisateur ("love=romance").
 * Retourne null si ce n'est pas un vrai tag.
 */
export function tagKey(label: string, custom: Record<string, string> = {}): string | null {
    let k = normalizeTagText(label)
    if (k === '' || k.length > 40 || /^\d+$/.test(k) || JUNK_TAGS.has(k)) return null
    // Les fusions de l'utilisateur passent en premier, puis les synonymes intégrés
    return custom[k] ?? BUILTIN_SYNONYMS[k] ?? k
}

/** Parse "love=romance; bl = boys love" en dictionnaire normalisé */
export function parseCustomMerges(input: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const pair of input.split(/[;\n]+/)) {
        const [a, b] = pair.split('=')
        if (a === undefined || b === undefined) continue
        const from = normalizeTagText(a)
        const to = normalizeTagText(b)
        if (from && to && from !== to) out[from] = to
    }
    return out
}

/** Joli libellé à partir d'une clé : "sci fi" -> "Sci Fi" */
export function prettyLabel(key: string): string {
    return key.replace(/\b[a-z]/g, c => c.toUpperCase())
}

/** Titre comparable pour retirer les doublons entre sites */
export function titleKey(title: string): string {
    return normalizeTagText(title).replace(/\b(the|a|an|le|la|les)\b/g, '').replace(/\s+/g, '')
}

// --- Détection de liens de tags (mode universel) ------------------------------

const TAG_PATH_RE = /\/(manga-genres?|manga-tags?|genres?|tags?|categor(?:y|ies)|themes?|tag-manga|genero|generos|kategori|genre-manga)\/([^/?#]+)\/?/i
const TAG_QUERY_RE = /[?&](genres?|tags?|category|cat|genre\[\])=([^&#]+)/i

/** Est-ce qu'un lien ressemble à une page "tous les mangas du tag X" ? */
export function looksLikeTagUrl(url: string): boolean {
    const path = pathOf(url)
    if (/\/(page)\/\d+/i.test(path) && !TAG_PATH_RE.test(path)) return false
    return TAG_PATH_RE.test(path) || TAG_QUERY_RE.test(path)
}

const CHAPTER_RE = /(chapter|chapitre|chap|capitulo|episode|\/ch[-_]?\d|\/ep[-_]?\d|-ch-\d|\/c\d+|\/read\/)/i
const MANGA_PATH_RE = /\/(manga|mangas|manhwa|manhua|comic|comics|series|serie|title|titles|webtoon|webtoons|book|books|novel|oeuvre|obra|komik)\/[^/?#]+/i

export function looksLikeChapterUrl(url: string): boolean {
    return CHAPTER_RE.test(pathOf(url))
}

export function looksLikeMangaUrl(url: string): boolean {
    const p = pathOf(url)
    return MANGA_PATH_RE.test(p) && !CHAPTER_RE.test(p) && !looksLikeTagUrl(url)
}

/** URL de la page n d'un listing (page 1 = URL d'origine) */
export function pagedUrl(url: string, page: number): string {
    if (page <= 1) return url
    const [beforeHash] = url.split('#')
    const base = beforeHash ?? url
    if (/[?&]page=\d+/.test(base)) return base.replace(/([?&]page=)\d+/, `$1${page}`)
    if (base.includes('?')) return `${base}&page=${page}`
    if (/\/page\/\d+\/?$/.test(base)) return base.replace(/\/page\/\d+\/?$/, `/page/${page}/`)
    return base.replace(/\/?$/, `/page/${page}/`)
}

// --- Chapitres -----------------------------------------------------------------

/** Numéro de chapitre depuis un texte ou une URL. -1 si introuvable. */
export function parseChapterNumber(text: string, url = ''): number {
    const labelled = /(?:chapter|chapitre|chap|ch|capitulo|cap|episode|ep|#)\s*[.:\-#]?\s*(\d+(?:[.,]\d+)?)/i
    for (const s of [text, decodeURIComponent(pathOf(url || '/')).replace(/[-_/]/g, ' ')]) {
        const m = labelled.exec(s)
        if (m?.[1]) return Number(m[1].replace(',', '.'))
    }
    const any = /(\d+(?:[.,]\d+)?)/.exec(text)
    if (any?.[1]) return Number(any[1].replace(',', '.'))
    const fromUrl = /(\d+(?:[.-]\d+)?)\/?$/.exec(pathOf(url || '/'))
    if (fromUrl?.[1]) return Number(fromUrl[1].replace('-', '.'))
    return -1
}

/** "3 days ago", "il y a 2 heures", "October 3, 2024", "03/10/2024" -> Date */
export function parseDate(text: string, now: number = Date.now()): Date {
    const s = text.trim().toLowerCase()
    if (s === '') return new Date(now)
    const rel = /(\d+|an?|un|une)\s*(sec|second|min|minute|hour|heure|hr|day|jour|week|semaine|month|mois|year|an|année|annee)/i.exec(s)
    if (rel && /(ago|il y a|hace|atrás|before)/i.test(s)) {
        const n = /^\d+$/.test(rel[1] ?? '') ? Number(rel[1]) : 1
        const unit = (rel[2] ?? '').toLowerCase()
        const ms = unit.startsWith('sec') ? 1e3
            : unit.startsWith('min') ? 6e4
                : (unit.startsWith('hour') || unit.startsWith('heure') || unit === 'hr') ? 36e5
                    : (unit.startsWith('day') || unit.startsWith('jour')) ? 864e5
                        : (unit.startsWith('week') || unit.startsWith('semaine')) ? 6048e5
                            : (unit.startsWith('month') || unit === 'mois') ? 2592e6
                                : 31536e6
        return new Date(now - n * ms)
    }
    if (/(today|aujourd|just now|à l'instant)/.test(s)) return new Date(now)
    if (/(yesterday|hier)/.test(s)) return new Date(now - 864e5)
    const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(s)
    if (dmy) return new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]))
    const parsed = Date.parse(text.trim())
    return isNaN(parsed) ? new Date(now) : new Date(parsed)
}

/** Meilleure URL d'image d'un <img> (lazy-loading compris) */
export function pickImageSrc(attrs: Record<string, string | undefined>): string | undefined {
    const order = ['data-src', 'data-lazy-src', 'data-original', 'data-cfsrc', 'data-url', 'src']
    for (const a of order) {
        const v = attrs[a]?.trim()
        if (v && !v.startsWith('data:')) return v
    }
    const srcset = attrs['data-srcset'] ?? attrs['srcset']
    if (srcset) {
        const last = srcset.split(',').map(x => x.trim().split(/\s+/)[0]).filter(Boolean).pop()
        if (last) return last
    }
    return undefined
}

/** Fusionne plusieurs listes en alternant (site A, site B, site A...) */
export function interleave<T>(lists: T[][]): T[] {
    const out: T[] = []
    const max = Math.max(0, ...lists.map(l => l.length))
    for (let i = 0; i < max; i++) {
        for (const l of lists) {
            const item = l[i]
            if (item !== undefined) out.push(item)
        }
    }
    return out
}

/** Exécute des tâches avec un nombre limité en parallèle */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length)
    let next = 0
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++
            results[i] = await fn(items[i] as T)
        }
    })
    await Promise.all(workers)
    return results
}
