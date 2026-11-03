import { CheerioAPI, Element } from 'cheerio'
import type { ChapterItem, Fetcher } from './Engines'
import { absoluteUrl, hostOf, looksLikeTagUrl, parseDate, pathOf, pickImageSrc, tryDecodeURI } from './Utils'

// ============================================================================
// Lecture UNIVERSELLE des chapitres et des pages, quelle que soit la présentation du site.
// Les méthodes s'enchaînent : chacune prend le relais si la précédente ne trouve pas assez.
// ============================================================================

/** Zones de navigation à ignorer pour les chapitres (les barres latérales sont triées ensuite) */
const CH_NAV = 'header, nav, footer, .menu, .navbar, .nav-menu, .main-menu, .sub-menu, .dropdown-menu, .breadcrumb, .breadcrumbs, #menu'

/** Adresse qui ressemble à un chapitre, dans de nombreuses langues et structures */
const CH_URL_RE = /(chapter|chapitre|capitulo|capítulo|kapitel|bolum|bölüm|chuong|chương|episode|episodio|épisode|[/_-]cap[-_]?\d|[/_-]ep[-_.]?\d|[/_-]ch[-_.]?\d|\/c\d+(?:[/.?#]|$)|\/read\/|\/reader\/|\/viewer\/|\/view\/|\/chap[-_/]?\d)/i

/** Texte qui ressemble à un chapitre : "Chapter 12", "Ch. 3", "Chapitre 4", "Vol.2 Ch.5", "Épisode 7", "#12", "第12話" */
const CH_TEXT_RE = /^(?:(?:vol(?:ume)?|tome|t)\.?\s*\d+[\s,.:-]*)?(?:chapter|chapitre|chap|ch|capitulo|capítulo|cap|kapitel|bölüm|bolum|episode|épisode|episodio|ep|chương|chuong|#)\s*\.?\s*[-:#]?\s*\d+|第\s*\d+\s*[话話章回]/i

/** Lien "tous les chapitres" / "liste des chapitres" */
const ALL_CHAPTERS_RE = /(all|tous les|toutes les|view all|voir tous?|liste des|full|complete|show all|see all).{0,15}(chap|épisode|episode)|(chapters?|chapitres?)\s*(list|liste)/i

/** Petits badges à retirer des noms */
const BADGES_RE = /\b(new|nouveau|hot|up|free|gratuit|vip|locked)\b|🔒|🆕|🔥/gi

/** Dates dans une ligne de chapitre */
const DATE_RE = /(\d+\s*(?:sec|second|min|minute|hour|heure|hr|day|jour|week|semaine|month|mois|year|an|année)s?\s*(?:ago)?|il y a\s+\d+\s*\w+|\b(?:today|yesterday|aujourd'hui|hier)\b|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?|(?:jan|feb|fév|mar|apr|avr|may|mai|jun|juin|jul|juil|aug|aoû|sep|oct|nov|dec|déc)[a-zéû]*\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+(?:jan|feb|fév|mar|apr|avr|may|mai|jun|juin|jul|juil|aug|aoû|sep|oct|nov|dec|déc)[a-zéû]*\.?\s+\d{4})/i

/** Liens de pagination ou de liste : pas des chapitres */
function isListOrPaging(path: string): boolean {
    return /[?&](page|p|pg|sort|order)=/i.test(path) || /\/page\/\d+\/?$/i.test(path) || /\/(chapters?|chapitres?|chapter-list|episodes?)\/?(\?|$)/i.test(path)
}

function clean(s: string | undefined): string {
    return (s ?? '').replace(/\s+/g, ' ').trim()
}

function inChapterNav($: CheerioAPI, el: Element): boolean {
    return $(el).closest(CH_NAV).length > 0
}

/** Même site, sous-domaines compris (api.site.com pour site.com) */
function sameSite(url: string, base: string): boolean {
    const h = hostOf(url)
    const b = hostOf(base)
    if (h === b) return true
    const root = b.split('.').slice(-2).join('.')
    return h.endsWith('.' + root) || h === root
}

/** Dernier morceau de l'adresse de la fiche : "/manga/solo-leveling/" -> "solo-leveling" */
function mangaSlug(mangaUrl: string): string {
    const parts = pathOf(mangaUrl).replace(/[?#].*$/, '').split('/').filter(Boolean)
    return (parts[parts.length - 1] ?? '').toLowerCase()
}

function mangaPathOf(mangaUrl: string): string {
    return pathOf(mangaUrl).replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase()
}

/** Ce lien appartient-il à CE manga (sous sa fiche, ou contenant son nom) ? */
function relatedTo(url: string, mangaUrl: string): boolean {
    const p = pathOf(url).toLowerCase()
    const mp = mangaPathOf(mangaUrl)
    const slug = mangaSlug(mangaUrl)
    return (mp.length > 1 && p.startsWith(mp + '/')) || (slug.length > 2 && p.includes(slug))
}

// --- Numéro, volume, nom propre ---------------------------------------------------

export function parseChapterInfo(text: string, url: string): { num: number, volume: number, name: string } {
    const t = clean(text)
    const vol = /(?:vol(?:ume)?|tome|t)\.?\s*(\d+)/i.exec(t)
    const labelled = /(?:chapter|chapitre|chap|ch|capitulo|capítulo|cap|kapitel|bölüm|bolum|episode|épisode|episodio|ep|chương|chuong|#)\s*\.?\s*[-:#]?\s*(\d+(?:[.,]\d+)?)/i.exec(t) ?? /第\s*(\d+(?:\.\d+)?)\s*[话話章回]/.exec(t)
    let num = labelled?.[1] ? Number(labelled[1].replace(',', '.')) : NaN
    if (isNaN(num) && /^\d+(?:[.,]\d+)?$/.test(t)) num = Number(t.replace(',', '.'))
    if (isNaN(num)) {
        const p = tryDecodeURI(pathOf(url)).replace(/[?#].*$/, '')
        const fromUrl = /(?:chapter|chapitre|capitulo|kapitel|bolum|chuong|episode|ep|ch|chap|cap|c)[-_/.]?(\d+(?:[-_.]\d+)?)(?:[/?#.]|$)/i.exec(p) ?? /(\d+(?:[-.]\d+)?)\/?$/.exec(p)
        if (fromUrl?.[1]) num = Number(fromUrl[1].replace(/[-_]/, '.'))
    }
    if (isNaN(num)) {
        const any = /(\d+(?:[.,]\d+)?)/.exec(t.replace(DATE_RE, ''))
        if (any?.[1]) num = Number(any[1].replace(',', '.'))
    }
    // Nom affiché : ce qui reste après "Vol. 2 Ch. 12 -", sans date ni badge
    let name = t.replace(DATE_RE, '').replace(BADGES_RE, '')
    name = name.replace(/^(?:(?:vol(?:ume)?|tome|t)\.?\s*\d+[\s,.:-]*)?(?:chapter|chapitre|chap|ch|capitulo|capítulo|cap|kapitel|bölüm|bolum|episode|épisode|episodio|ep|chương|chuong|#)\s*\.?\s*[-:#]?\s*\d+(?:[.,]\d+)?/i, '')
        .replace(/^第\s*\d+(?:\.\d+)?\s*[话話章回]/, '')
        .replace(/^\d+(?:[.,]\d+)?$/, '')
        .replace(/^\d+(?:[.,]\d+)?\s*[-:.)–—]\s+/, '')
        .replace(/^[\s:|·•–—-]+/, '').replace(/[\s:|·•–—-]+$/, '')
    name = clean(name)
    return { num: isNaN(num) || !isFinite(num) ? -1 : num, volume: vol?.[1] ? Number(vol[1]) : 0, name }
}

function dateFromRow(rowText: string): Date {
    const m = DATE_RE.exec(rowText)
    return parseDate(m ? m[0] : '')
}

// --- Méthode 1 : les éléments cliquables de la page ------------------------------------

interface Candidate { url: string, text: string, row: string, group: unknown }

/** Adresse d'un élément cliquable : href, data-href, data-url, onclick="location.href='…'"… */
function linkOf($: CheerioAPI, el: Element): string | undefined {
    const href = $(el).attr('href')
    const usable = href && !/^(javascript:|#)/i.test(href.trim()) ? href : undefined
    const onclick = $(el).attr('onclick') ?? ''
    const fromClick = /(?:location(?:\.href)?|window\.open)\s*(?:=|\()\s*['"]([^'"]+)['"]/i.exec(onclick)?.[1]
    return usable ?? $(el).attr('data-href') ?? $(el).attr('data-url') ?? $(el).attr('data-link') ?? fromClick
}

function chapterCandidates($: CheerioAPI, pageUrl: string, base: string, mangaUrl: string): Candidate[] {
    const out: Candidate[] = []
    const seen = new Set<string>()
    const mangaClean = mangaUrl.replace(/[?#].*$/, '').replace(/\/$/, '')
    const mp = mangaPathOf(mangaUrl)
    $('a[href], [data-href], [data-url], [data-link], [onclick]').each((_, el) => {
        if (el.name === 'img' || el.name === 'source' || inChapterNav($, el)) return
        const url = absoluteUrl(linkOf($, el), pageUrl)
        if (!url || !sameSite(url, base)) return
        const u = url.replace(/#.*$/, '')
        if (u.replace(/\/$/, '') === mangaClean || looksLikeTagUrl(u)) return
        const p = pathOf(u)
        if (isListOrPaging(p) || /\.(jpe?g|png|webp|gif|avif|css|js)(\?|$)/i.test(p)) return
        const text = clean($(el).attr('title')) || clean($(el).text())
        // Grille de numéros seuls ("1 2 3 … 120") sous la fiche du manga
        const underManga = mp.length > 1 && p.toLowerCase().startsWith(mp + '/')
        // Grille de numéros seuls, ou adresse "/titre/12/" avec un texte (pas une miniature de galerie)
        const numberUnderManga = underManga && (/^\d+(?:[.,]\d+)?$/.test(text)
            || (text.length > 0 && $(el).find('img').length === 0 && new RegExp(`^${mp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\d+(?:[.-]\\d+)?/?$`).test(p.toLowerCase().replace(/[?#].*$/, ''))))
        if (!CH_URL_RE.test(p) && !CH_TEXT_RE.test(text) && !numberUnderManga) return
        if (seen.has(u)) return
        seen.add(u)
        const groupEl = $(el).closest('ul, ol, tbody, table, select, [class*="chapter"], [id*="chapter"], [class*="episode"], [class*="list"], [class*="eplist"], [class*="grid"]').get(0)
            ?? $(el).parent().parent().get(0)
        const row = clean($(el).closest('li, tr, [class*="chapter-item"], [class*="item"], [class*="row"], div').text())
        out.push({ url: u, text, row, group: groupEl })
    })
    return out
}

function toItems(cands: Candidate[]): ChapterItem[] {
    return cands.map(c => {
        const info = parseChapterInfo(c.text || c.row, c.url)
        return { url: c.url, name: info.name, num: info.num, volume: info.volume, date: dateFromRow(c.row) }
    })
}

/** Garde le bloc qui contient la vraie liste (pas les "derniers chapitres" des autres mangas) */
function pickChapterList(cands: Candidate[], mangaUrl: string): Candidate[] {
    if (cands.length === 0) return []
    const related = (c: Candidate): boolean => relatedTo(c.url, mangaUrl)
    const groups = new Map<unknown, Candidate[]>()
    for (const c of cands) {
        const list = groups.get(c.group) ?? []
        list.push(c)
        groups.set(c.group, list)
    }
    let best: Candidate[] = []
    let bestScore = -1
    for (const list of groups.values()) {
        // Les liens "liés" à ce manga comptent triple
        const score = list.length + list.filter(related).length * 2
        if (score > bestScore) { best = list; bestScore = score }
    }
    const relatedAll = cands.filter(related)
    // Si des chapitres de CE manga existent ailleurs que dans le meilleur bloc, on les préfère
    if (relatedAll.length > best.filter(related).length && relatedAll.length >= 2) return relatedAll
    if (best.some(related)) return best.filter(related)
    return best
}

// --- Méthode 2 : données structurées (JSON dans la page, ou renvoyé par le site) ------------

const URL_KEYS = ['url', 'href', 'link', 'path', 'permalink', 'chapter_url', 'chapterUrl', 'read_url']
const SLUG_KEYS = ['chapter_slug', 'chapterSlug', 'slug', 'chapter_id', 'chapterId', 'hid', 'id']
const NUM_KEYS = ['chapter', 'chapter_number', 'chapterNumber', 'chapter_num', 'chap', 'number', 'num', 'episode', 'index']
const NAME_KEYS = ['chapter_name', 'chapterName', 'chapter_title', 'chapterTitle', 'name', 'title', 'label']
const DATE_KEYS = ['date', 'created_at', 'createdAt', 'published_at', 'publishedAt', 'updated_at', 'updatedAt', 'datePublished', 'release_date', 'releaseDate', 'uploaded']
const HTML_KEYS = ['html', 'data', 'content', 'list', 'chapters', 'result']

/** Chapitres dans une valeur JSON quelconque (tableaux d'objets "chapitre", à n'importe quelle profondeur) */
export function chaptersFromValue(value: unknown, pageUrl: string, base: string, mangaUrl: string, load?: (html: string) => CheerioAPI): ChapterItem[] {
    const out: ChapterItem[] = []
    const seen = new Set<string>()
    const pick = (o: Record<string, unknown>, keys: string[]): unknown => { for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]; return undefined }
    const visit = (node: unknown, depth: number): void => {
        if (depth > 14 || node === null || node === undefined) return
        // Un morceau de HTML renvoyé dans le JSON : {"html": "<ul>…</ul>"}
        if (typeof node === 'string') {
            if (load && /<a\s[^>]*href|data-href/i.test(node) && node.length < 2000000) {
                const $h = load(node)
                for (const c of toItems(pickChapterList(chapterCandidates($h, pageUrl, base, mangaUrl), mangaUrl))) if (!seen.has(c.url)) { seen.add(c.url); out.push(c) }
            }
            return
        }
        if (typeof node !== 'object') return
        if (Array.isArray(node)) {
            const objs = node.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
            if (objs.length >= 1) {
                const found: ChapterItem[] = []
                for (const o of objs) {
                    const label = pick(o, NAME_KEYS)
                    const labelText = typeof label === 'string' ? label : ''
                    const numRaw = pick(o, NUM_KEYS)
                    const numOk = typeof numRaw === 'number' || (typeof numRaw === 'string' && /^\d+(\.\d+)?$/.test(numRaw))
                    let link = pick(o, URL_KEYS)
                    let url = typeof link === 'string' ? absoluteUrl(link, pageUrl) : null
                    // Pas d'adresse complète : on la construit depuis l'identifiant du chapitre, sous la fiche
                    if (!url) {
                        link = pick(o, SLUG_KEYS)
                        if ((typeof link === 'string' && /^[\w.-]+$/.test(link)) || typeof link === 'number') {
                            if (numOk || CH_TEXT_RE.test(labelText) || CH_URL_RE.test('/' + String(link))) url = mangaUrl.replace(/\/?$/, '/') + String(link)
                        }
                    }
                    if (!url || !sameSite(url, base)) continue
                    if (!CH_URL_RE.test(pathOf(url)) && !CH_TEXT_RE.test(labelText) && !numOk) continue
                    const info = parseChapterInfo(labelText || (numOk ? `Chapter ${numRaw}` : ''), url)
                    const dateRaw = pick(o, DATE_KEYS)
                    found.push({
                        url, name: info.name,
                        num: numOk ? Number(numRaw) : info.num,
                        volume: info.volume || (typeof o['volume'] === 'number' ? o['volume'] : Number(o['vol'] ?? 0) || 0),
                        date: typeof dateRaw === 'number' ? new Date(dateRaw > 1e12 ? dateRaw : dateRaw * 1000) : parseDate(typeof dateRaw === 'string' ? dateRaw : '')
                    })
                }
                if (found.length >= Math.min(2, objs.length)) for (const c of found) if (!seen.has(c.url)) { seen.add(c.url); out.push(c) }
            }
            for (const x of node) visit(x, depth + 1)
            return
        }
        const o = node as Record<string, unknown>
        for (const k of Object.keys(o)) visit(o[k], depth + 1)
        for (const k of HTML_KEYS) if (typeof o[k] === 'string') visit(o[k], depth + 1)
    }
    visit(value, 0)
    return out
}

function chaptersFromPageJson($: CheerioAPI, pageUrl: string, base: string, mangaUrl: string): ChapterItem[] {
    const out: ChapterItem[] = []
    $('script#__NEXT_DATA__, script#__NUXT_DATA__, script[type="application/ld+json"], script[type="application/json"]').each((_, el) => {
        try { out.push(...chaptersFromValue(JSON.parse($(el).text()), pageUrl, base, mangaUrl)) } catch { /* pas du JSON */ }
    })
    return dedupe(out)
}

// --- Méthode 3 : balayage du code brut (scripts, données Next.js "self.__next_f"…) ------------

function unescapeJs(text: string): string {
    return text.replace(/\\u002[fF]/g, '/').replace(/\\u0026/g, '&').replace(/\\\\\//g, '/').replace(/\\\//g, '/').replace(/\\"/g, '"').replace(/\\\\"/g, '"')
}

function chaptersFromRawText(html: string, pageUrl: string, base: string, mangaUrl: string): ChapterItem[] {
    const text = unescapeJs(html)
    const out: ChapterItem[] = []
    const seen = new Set<string>()
    // (pas de « recherche arrière » dans les expressions : iOS ne la connaît que depuis la version 16.4)
    for (const m of text.matchAll(/(?:^|[^\w.])(https?:\/\/[^\s"'<>`\\)]+|\/[^\s"'<>`\\)]{2,300})/g)) {
        const url = absoluteUrl(m[1], pageUrl)
        if (!url || !sameSite(url, base)) continue
        const u = url.replace(/#.*$/, '').replace(/[,;]+$/, '')
        const p = pathOf(u)
        if (seen.has(u) || !CH_URL_RE.test(p) || isListOrPaging(p) || /\.(jpe?g|png|webp|gif|avif|css|js|svg|ico)(\?|$)/i.test(p)) continue
        // Uniquement les chapitres de CE manga (le code contient aussi d'autres mangas)
        if (!relatedTo(u, mangaUrl)) continue
        seen.add(u)
        const info = parseChapterInfo('', u)
        out.push({ url: u, name: '', num: info.num, volume: 0, date: parseDate('') })
    }
    return out
}

// --- Méthode 4 : la liste est chargée depuis une adresse annexe (/ajax/…, /api/…) --------------

const ID_RE = /\b(?:bookId|book_id|mangaId|manga_id|seriesId|series_id|comicId|comic_id|postId|post_id|mangaID|manga-id|data-manga-id|data-id)["']?\s*[:=]\s*["']?(\d{1,10})\b/i

function chapterEndpoints($: CheerioAPI, html: string, mangaUrl: string, base: string): string[] {
    const found: string[] = []
    const add = (raw: string | undefined): void => {
        const u = absoluteUrl(raw, mangaUrl)
        if (u && sameSite(u, base) && !/\.(jpe?g|png|webp|gif|avif|css|js)(\?|$)/i.test(u) && !found.includes(u)) found.push(u)
    }
    // Attributs qui pointent vers une liste de chapitres
    $('[data-url], [data-src], [data-ajax], [data-endpoint], [data-load], [data-api], [hx-get]').each((_, el) => {
        for (const a of ['data-url', 'data-src', 'data-ajax', 'data-endpoint', 'data-load', 'data-api', 'hx-get']) {
            const v = el.attribs[a]
            if (v && /(chapter|episode|chap)/i.test(v) && !CH_TEXT_RE.test(clean($(el).text()))) add(v)
        }
    })
    // Adresses écrites dans les scripts : "/ajax/manga/55/chapters", "/api/series/42/chapters"…
    for (const m of unescapeJs(html).matchAll(/["'`]((?:https?:\/\/[^"'`\s]+)?\/[^"'`\s]*?(?:ajax|api|wp-json|load|get|list)[^"'`\s]*?(?:chapter|episode)[^"'`\s]*)["'`]/gi)) add(m[1])
    // Identifiant du manga dans la page : on essaie les adresses d'API les plus répandues
    const id = ID_RE.exec(html)?.[1]
    if (id) {
        const origin = (/^https?:\/\/[^/]+/.exec(base) ?? [base])[0]
        for (const t of [`/api/manga/${id}/chapters?source=detail`, `/api/manga/${id}/chapters`, `/api/comics/${id}/chapters`, `/ajax/manga/${id}/chapters`]) add(origin + t)
    }
    return found.slice(0, 6)
}

async function chaptersFromEndpoints(f: Fetcher, $: CheerioAPI, html: string, mangaUrl: string, base: string): Promise<ChapterItem[]> {
    for (const endpoint of chapterEndpoints($, html, mangaUrl, base)) {
        let body = ''
        try { body = await f.get(endpoint, { 'X-Requested-With': 'XMLHttpRequest', 'Referer': mangaUrl }) } catch {
            try { body = await f.post(endpoint, '', { 'X-Requested-With': 'XMLHttpRequest', 'Referer': mangaUrl }) } catch { continue }
        }
        const trimmed = body.trim()
        let list: ChapterItem[] = []
        if (/^[[{]/.test(trimmed)) {
            try { list = chaptersFromValue(JSON.parse(trimmed), mangaUrl, base, mangaUrl, f.load) } catch { /* JSON invalide */ }
        } else if (trimmed) {
            list = toItems(pickChapterList(chapterCandidates(f.load(trimmed), mangaUrl, base, mangaUrl), mangaUrl))
        }
        if (list.length >= 1) return list
    }
    return []
}

// --- Méthode 6 : le menu déroulant d'un lecteur ----------------------------------------

function chaptersFromSelect($: CheerioAPI, pageUrl: string, base: string): ChapterItem[] {
    let best: ChapterItem[] = []
    $('select').each((_, sel) => {
        const found: ChapterItem[] = []
        const seen = new Set<string>()
        $(sel).find('option').each((__, opt) => {
            const value = $(opt).attr('value') ?? $(opt).attr('data-redirect') ?? $(opt).attr('data-url')
            const url = absoluteUrl(value, pageUrl)
            const text = clean($(opt).text())
            if (!url || !sameSite(url, base)) return
            if (!CH_URL_RE.test(pathOf(url)) && !CH_TEXT_RE.test(text)) return
            const u = url.replace(/#.*$/, '')
            if (seen.has(u)) return
            seen.add(u)
            const info = parseChapterInfo(text, u)
            found.push({ url: u, name: info.name, num: info.num, volume: info.volume, date: parseDate('') })
        })
        if (found.length > best.length) best = found
    })
    return best
}

// --- Assemblage -------------------------------------------------------------------------

export function sortNewestFirst(chs: ChapterItem[]): ChapterItem[] {
    const known = chs.filter(c => c.num >= 0)
    if (known.length < 2) return chs
    // Majorité des voisins croissante = liste du plus ancien au plus récent : on retourne
    let up = 0
    let down = 0
    for (let i = 1; i < known.length; i++) {
        const a = (known[i - 1] as ChapterItem).num
        const b = (known[i] as ChapterItem).num
        if (b > a) up++
        else if (b < a) down++
    }
    return up > down ? [...chs].reverse() : chs
}

function dedupe(chs: ChapterItem[]): ChapterItem[] {
    const seen = new Set<string>()
    return chs.filter(c => (seen.has(c.url) ? false : (seen.add(c.url), true)))
}

/**
 * Trouve les chapitres d'une fiche, quelle que soit la présentation du site.
 * `$` = la fiche déjà chargée. Les autres pages ne sont demandées que si nécessaire.
 * Chaque méthode est protégée : une erreur dans l'une passe simplement à la suivante.
 * `log` reçoit le compte rendu de chaque méthode (pour le journal de diagnostic).
 */
export async function universalChapters(f: Fetcher, mangaUrl: string, $: CheerioAPI, base: string, log: (line: string) => void = () => undefined): Promise<ChapterItem[]> {
    let chapters: ChapterItem[] = []
    const better = (list: ChapterItem[]): void => { if (list.length > chapters.length) chapters = dedupe(list) }
    const step = async (name: string, fn: () => Promise<ChapterItem[]> | ChapterItem[]): Promise<void> => {
        try {
            const list = await fn()
            log(`${name} : ${list.length}`)
            better(list)
        } catch (e) {
            log(`${name} : erreur ${e instanceof Error ? e.message : String(e)}`)
        }
    }
    let html = ''
    try { html = await f.get(mangaUrl) } catch { /* la fiche est déjà dans $ */ }

    // 1. Éléments cliquables de la fiche (liens, data-href, onclick, grilles de numéros)
    let cands: Candidate[] = []
    // Miniatures d'une galerie (lien avec une image vers « /a/ID/N ») : des PAGES du manga, pas des chapitres
    // (EAHentai : 24 miniatures numérotées « 1 », « 2 »… qui ressemblaient à 24 chapitres)
    const thumbUrls = new Set(galleryLinks($, mangaUrl, mangaUrl).filter(t => t.thumb).map(t => t.url.replace(/[?#].*$/, '').replace(/\/$/, '')))
    const isThumbPage = (c: Candidate): boolean => thumbUrls.size >= 2 && thumbUrls.has(c.url.replace(/[?#].*$/, '').replace(/\/$/, '')) && !CHAPTER_WORDS.test(c.text)
    await step('liens de la fiche', () => {
        cands = pickChapterList(chapterCandidates($, mangaUrl, base, mangaUrl).filter(c => !isThumbPage(c)), mangaUrl)
        return toItems(cands)
    })
    if (chapters.length >= 2) {
        // La liste de la fiche est peut-être paginée : on suit ses pages
        await step('pages suivantes de la liste', async () => {
            const more = await followListPagination(f, $, mangaUrl, base, mangaUrl, cands)
            return more.length ? [...chapters, ...more] : []
        })
        return sortNewestFirst(chapters)
    }

    // 2. Données structurées de la page (__NEXT_DATA__, JSON-LD…)
    await step('données structurées', () => chaptersFromPageJson($, mangaUrl, base, mangaUrl))

    // 3. Balayage du code brut (sites Next.js récents, listes dans les scripts)
    if (chapters.length < 2 && html) await step('code brut', () => chaptersFromRawText(html, mangaUrl, base, mangaUrl))

    // 4. Liste chargée depuis une adresse annexe (/ajax/…, /api/…)
    if (chapters.length < 2 && html) await step('adresse annexe', () => chaptersFromEndpoints(f, $, html, mangaUrl, base))

    // 5. Page "tous les chapitres" séparée (et sa pagination) ; avec un seul chapitre trouvé,
    //    seulement si la fiche a un vrai lien vers une liste (pas d'adresses devinées inutiles)
    if (chapters.length === 0 || (chapters.length === 1 && hasAllChaptersLink($, mangaUrl, base))) {
        await step('page « tous les chapitres »', async () => {
            const links: string[] = []
            $('a[href]').each((_, el) => {
                const text = clean($(el).text()) + ' ' + clean($(el).attr('title'))
                const href = absoluteUrl($(el).attr('href'), mangaUrl)
                if (!href || !sameSite(href, base)) return
                if (ALL_CHAPTERS_RE.test(text) || /\/(chapters?|chapter-list|episodes|chapitres)\/?(\?|$)/i.test(pathOf(href))) links.push(href)
            })
            const slash = mangaUrl.replace(/[?#].*$/, '').replace(/\/?$/, '/')
            const guesses = [...links, slash + 'chapters', slash + 'chapters/', mangaUrl.replace(/[?#].*$/, '') + '?tab=chapters']
            let best: ChapterItem[] = []
            for (const pageUrl of [...new Set(guesses)].slice(0, 5)) {
                try {
                    const list = await chaptersAcrossPages(f, pageUrl, base, mangaUrl)
                    if (list.length > best.length) { best = list; if (list.length >= 2) break }
                } catch { /* page absente : on essaie la suivante */ }
            }
            return best
        })
    }

    // 6. Ouvrir un chapitre et lire le menu déroulant (ou la liste) de son lecteur
    if (chapters.length < 2) {
        await step('lecteur', async () => {
            const first = chapters[0]?.url ?? firstReadLink($, mangaUrl, base)
            if (!first) return []
            const $c = f.load(await f.get(first))
            const fromSelect = chaptersFromSelect($c, first, base)
            if (fromSelect.length >= 2) return fromSelect
            const fromReader = toItems(pickChapterList(chapterCandidates($c, first, base, mangaUrl), mangaUrl))
            return fromReader.length >= 2 ? [...chapters, ...fromReader] : []
        })
    }
    // 7. Aucune liste de chapitres mais une galerie (miniatures numérotées) : un chapitre unique,
    //    ou un chapitre par page de miniatures quand la galerie en a plusieurs (E-Hentai : 20 par page)
    if (chapters.length === 0) {
        await step('galerie', () => {
            const thumbs = galleryLinks($, mangaUrl, mangaUrl)
            const reader = readerImages($, mangaUrl)
            if (thumbs.length < 2 && reader < 3) return []
            const single = [{ url: mangaUrl.replace(/[?#].*$/, ''), name: '', num: 1, date: parseDate('') }]
            const total = totalPagesOf($, html, thumbs.length)
            const perPage = thumbs.length
            if (perPage < 2 || total <= perPage || !galleryHasPagination($, mangaUrl)) return single
            const count = Math.ceil(total / perPage)
            const urls = galleryPageUrls($, mangaUrl, count)
            if (urls.length !== count) return single
            return urls.map((u, i) => ({
                url: i === 0 ? mangaUrl.replace(/#.*$/, '') : u,
                name: `Pages ${i * perPage + 1}–${Math.min((i + 1) * perPage, total)}`,
                num: i + 1,
                date: parseDate('')
            })).reverse()
        })
    }
    return sortNewestFirst(dedupe(chapters))
}

/**
 * Miniatures d'une galerie : liens vers des pages de lecture numérotées, triés par numéro.
 * Reconnus si la page de lecture est sous l'adresse de la galerie ("/g/123/" -> "/g/123/4/")
 * ou porte le même identifiant ("/g/694069/" -> "/gallery/694069/4/"). Numérotation à 0 ou 1.
 */
export function galleryLinks($: CheerioAPI, pageUrl: string, galleryUrl: string): { n: number, url: string, thumb: string }[] {
    const gp = pathOf(galleryUrl).replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase()
    if (gp.length < 2) return []
    // Tous les nombres d'au moins 3 chiffres de l'adresse : l'un d'eux est l'identifiant de la galerie
    const ids = gp.split('/').filter(seg => /^\d{3,}$/.test(seg))
    const out: { n: number, url: string, thumb: string }[] = []
    const seen = new Set<number>()
    $('a[href]').each((_, el) => {
        const img = $(el).find('img').first()
        const text = clean($(el).text())
        // Une miniature (image ou case vide) ou un simple numéro de page ; pas un lien avec un vrai texte
        if (img.length === 0 && text !== '' && !/^\d+$/.test(text)) return
        const url = absoluteUrl($(el).attr('href'), pageUrl)
        if (!url || hostOf(url) !== hostOf(galleryUrl)) return
        const path = pathOf(url).replace(/[?#].*$/, '').toLowerCase()
        if (path.replace(/\/$/, '') === gp) return
        let n: number | undefined
        // « /g/123/4/ » ou « /gallery/123/4/ » : numéro de page en dernier, sous la galerie ou avec son identifiant
        const m = /^(.*)\/(\d+)\/?$/.exec(path)
        if (m && (m[1] === gp || ids.some(id => (m[1] as string).split('/').includes(id)))) n = Number(m[2])
        // « /s/{code}/{id}-{n} » (E-Hentai) : identifiant de la galerie et numéro de page dans le dernier segment
        if (n === undefined) {
            const d = /\/(\d{3,})-(\d+)\/?$/.exec(path)
            if (d && ids.includes(d[1] as string)) n = Number(d[2])
        }
        if (n === undefined || seen.has(n)) return
        seen.add(n)
        const node = img.get(0) as Element | undefined
        out.push({ n, url: url.replace(/#.*$/, ''), thumb: node ? absoluteUrl(pickImageSrc(node.attribs), pageUrl) ?? '' : '' })
    })
    return out.sort((a, b) => a.n - b.n)
}

/**
 * Galerie dont les miniatures sont réparties sur plusieurs pages (E-Hentai : 20 par page, « ?p=N ») :
 * adresses de toutes ces pages, déduites des liens de pagination de la galerie (modèle vérifié).
 * Retourne seulement la page de départ si on ne peut pas les déduire avec certitude.
 */
export function galleryPageUrls($: CheerioAPI, galleryUrl: string, count: number): string[] {
    const gp = pathOf(galleryUrl).replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase()
    const byNumber = new Map<number, string>()
    $('a[href]').each((_, el) => {
        const text = clean($(el).text())
        if (!/^\d+$/.test(text)) return
        const url = absoluteUrl($(el).attr('href'), galleryUrl)
        if (!url || hostOf(url) !== hostOf(galleryUrl)) return
        if (pathOf(url).replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase() !== gp) return
        const k = Number(text)
        if (k >= 2 && !byNumber.has(k)) byNumber.set(k, url.replace(/#.*$/, ''))
    })
    const urls = [galleryUrl.replace(/#.*$/, '')]
    if (count <= 1) return urls
    const two = byNumber.get(2)
    const three = byNumber.get(3)
    let tpl: ((n: number) => string) | null = null
    if (two && three) {
        const t = numberTemplate(two, 2, three, 3)
        // Vérifié sur tous les autres numéros affichés
        if (t && [...byNumber.entries()].every(([k, u]) => t(k) === u)) tpl = t
    }
    for (let k = 2; k <= count; k++) {
        const u = tpl ? tpl(k) : byNumber.get(k)
        if (!u) return urls.length === count ? urls : [urls[0] as string]
        urls.push(u)
    }
    return urls
}

/**
 * Nombre total de pages annoncé par une galerie ("Pages: 35", "46 pages • 24 showing", champ caché).
 * On garde le plus petit total au moins égal au nombre de miniatures affichées (et au plus 30 fois ce nombre),
 * pour ne pas confondre avec un autre nombre de la page (« 2303 pages » d'une pagination, etc.).
 */
export function totalPagesOf($: CheerioAPI, html: string, shown = 1): number {
    const plausible = plausibleTotals($, html, shown)
    return plausible.length ? Math.min(...plausible) : 0
}

/** Tous les nombres de pages annoncés par la page qui sont plausibles pour cette galerie */
function plausibleTotals($: CheerioAPI, html: string, shown: number): number[] {
    const found: number[] = []
    $('input[id*="pages"], input[name*="pages"], input[id*="Pages"]').each((_, el) => {
        const v = Number(el.attribs['value'])
        if (Number.isInteger(v) && v > 0 && v < 3000) found.push(v)
    })
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ')
    for (const m of text.matchAll(/\b(\d{1,4})\s*pages?\b|\bpages?\s*:?\s*(\d{1,4})\b/gi)) {
        const v = Number(m[1] ?? m[2])
        if (v > 0 && v < 3000) found.push(v)
    }
    return found.filter(v => v >= shown && v <= Math.max(shown * 30, shown + 30))
}

/** Nombre d'images de lecture affichées directement sur une page (dans une zone de lecteur, hors liens) */
function readerImages($: CheerioAPI, url: string): number {
    let n = 0
    $('[class*="reader"] img, [class*="reading"] img, [id*="reader"] img, [class*="viewer"] img, [class*="page-break"] img, #image-container img').each((_, el) => {
        if ($(el).closest('a[href]').length) return
        const src = absoluteUrl(pickImageSrc(el.attribs), url)
        if (src && !NOT_PAGE.test(src)) n++
    })
    return n
}

/** La fiche a-t-elle un lien explicite vers une liste de chapitres ? */
function hasAllChaptersLink($: CheerioAPI, mangaUrl: string, base: string): boolean {
    let found = false
    $('a[href]').each((_, el) => {
        if (found) return
        const href = absoluteUrl($(el).attr('href'), mangaUrl)
        if (!href || !sameSite(href, base)) return
        if (ALL_CHAPTERS_RE.test(clean($(el).text()) + ' ' + clean($(el).attr('title')))) found = true
    })
    return found
}

/** La galerie a-t-elle des liens vers ses autres pages de miniatures (2, 3…) ? */
function galleryHasPagination($: CheerioAPI, galleryUrl: string): boolean {
    const gp = pathOf(galleryUrl).replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase()
    let found = false
    $('a[href]').each((_, el) => {
        if (found || clean($(el).text()) !== '2') return
        const u = absoluteUrl($(el).attr('href'), galleryUrl)
        if (u && pathOf(u).replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase() === gp && /[?&]\w+=\d+/.test(u)) found = true
    })
    return found
}

/** Lien "Lire" / "Commencer" / "Premier chapitre" */
function firstReadLink($: CheerioAPI, mangaUrl: string, base: string): string | undefined {
    let found: string | undefined
    $('a[href], [data-href]').each((_, el) => {
        if (found) return
        const text = clean($(el).text()).toLowerCase()
        const href = absoluteUrl(linkOf($, el), mangaUrl)
        if (!href || !sameSite(href, base)) return
        if (/(read|lire|start|commencer|first|premier|begin|leer|ler)\b/.test(text) && href.replace(/\/$/, '') !== mangaUrl.replace(/\/$/, '')) found = href
    })
    return found
}

/** Lit une page de liste de chapitres et ses pages suivantes */
async function chaptersAcrossPages(f: Fetcher, pageUrl: string, base: string, mangaUrl: string): Promise<ChapterItem[]> {
    const $p = f.load(await f.get(pageUrl))
    const cands = pickChapterList(chapterCandidates($p, pageUrl, base, mangaUrl), mangaUrl)
    const first = toItems(cands)
    const more = await followListPagination(f, $p, pageUrl, base, mangaUrl, cands)
    return dedupe([...first, ...more])
}

/** Suit "page 2, 3…" d'une liste de chapitres (20 pages au plus) */
async function followListPagination(f: Fetcher, $: CheerioAPI, pageUrl: string, base: string, mangaUrl: string, firstCands: Candidate[]): Promise<ChapterItem[]> {
    const listPath = pathOf(pageUrl).replace(/[?#].*$/, '').replace(/\/page\/\d+\/?$/, '').replace(/\/$/, '')
    const pages = new Set<string>()
    $('a[href]').each((_, el) => {
        const href = absoluteUrl($(el).attr('href'), pageUrl)
        if (!href || !sameSite(href, base)) return
        const p = pathOf(href)
        const samePath = p.replace(/[?#].*$/, '').replace(/\/page\/\d+\/?$/, '').replace(/\/$/, '') === listPath
        if (samePath && (/[?&](page|p|pg)=\d+/.test(p) || /\/page\/\d+/.test(p))) pages.add(href.replace(/#.*$/, ''))
    })
    if (pages.size === 0) return []
    const known = new Set(firstCands.map(c => c.url))
    const out: ChapterItem[] = []
    for (const p of [...pages].slice(0, 20)) {
        try {
            const $p = f.load(await f.get(p))
            const cands = pickChapterList(chapterCandidates($p, p, base, mangaUrl), mangaUrl).filter(c => !known.has(c.url))
            for (const c of cands) known.add(c.url)
            out.push(...toItems(cands))
        } catch { /* page suivante illisible */ }
    }
    return out
}

// ============================================================================
// Pages d'un chapitre
// ============================================================================

const IMG_EXT = /\.(?:jpe?g|png|webp|gif|avif|bmp|jfif)(?:[?#]|$)/i
const NOT_PAGE = /(logo|icon|favicon|avatar|banner|sprite|loading|loader|spinner|emoji|placeholder|pixel|blank|[/_-]ads?[/_.-]|advert|badge|button|thumb(?:nail)?s?\/|\/smilies\/|\/covers?\/|\.svg)/i

function smallImage(el: Element): boolean {
    const w = Number(el.attribs['width'])
    const h = Number(el.attribs['height'])
    return (w > 0 && w < 120) || (h > 0 && h < 120)
}

/** Listes d'images dans les scripts : ["…/1.jpg","…/2.jpg"], chemins relatifs et "\/" compris */
function imagesFromScriptArrays(html: string, pageUrl: string): string[] {
    const re = /\[\s*"(?:[^"\\]|\\.)+?\.(?:jpe?g|png|webp|gif|avif|jfif)(?:\?(?:[^"\\]|\\.)*)?"(?:\s*,\s*"(?:[^"\\]|\\.)+?")+\s*,?\s*\]/gi
    let best: string[] = []
    for (const m of html.matchAll(re)) {
        try {
            const arr = JSON.parse(m[0].replace(/,\s*\]$/, ']')) as unknown
            if (!Array.isArray(arr)) continue
            const raw = arr.filter((x): x is string => typeof x === 'string' && IMG_EXT.test(x)).map(x => x.replace(/\\\//g, '/'))
            const prefix = cdnPrefix(raw, html)
            const urls = raw.map(x => prefix && !/^(https?:)?\/\//i.test(x) ? prefix + (x.startsWith('/') ? x : '/' + x) : absoluteUrl(x, pageUrl))
                .filter((x): x is string => !!x && !NOT_PAGE.test(x))
            if (urls.length > best.length) best = urls
        } catch { /* pas du JSON valide */ }
    }
    return best
}

/**
 * Images listées en chemins relatifs ("/hentai/abc/001.jpg") mais servies par un autre serveur :
 * on cherche dans la page une adresse complète qui finit par l'un de ces chemins
 * (souvent la première image déjà affichée) et on en déduit le début commun.
 */
function cdnPrefix(paths: string[], html: string): string | null {
    const text = unescapeJs(html)
    for (const p of paths.slice(0, 5)) {
        if (/^(https?:)?\/\//i.test(p)) return null
        const rel = p.startsWith('/') ? p : '/' + p
        const esc = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const m = new RegExp(`(https?:\\/\\/[^\\s"'<>\\\\]+?)${esc}(?=["'\\s?#<>]|$)`, 'i').exec(text)
        if (m?.[1]) return m[1]
    }
    return null
}

/** Images cachées dans <noscript> */
function imagesFromNoscript($: CheerioAPI, pageUrl: string): string[] {
    const out: string[] = []
    $('noscript').each((_, el) => {
        for (const m of $(el).text().matchAll(/<img[^>]+?(?:data-src|src)\s*=\s*["']([^"']+)["']/gi)) {
            const u = absoluteUrl(m[1], pageUrl)
            if (u && !NOT_PAGE.test(u) && !out.includes(u)) out.push(u)
        }
    })
    return out
}

/** Toutes les adresses d'images du texte, regroupées par dossier : les pages d'un chapitre partagent le même */
function imageCluster(text: string, pageUrl: string): string[] {
    const groups = new Map<string, string[]>()
    for (const m of unescapeJs(text).matchAll(/(?:^|[^\w.])(https?:\/\/[^\s"'<>`\\),]+?\.(?:jpe?g|png|webp|gif|avif|jfif)(?:\?[^\s"'<>`\\),]*)?|\/[^\s"'<>`\\),]+?\.(?:jpe?g|png|webp|gif|avif|jfif)(?:\?[^\s"'<>`\\),]*)?)/gi)) {
        const u = absoluteUrl(m[1], pageUrl)
        if (!u || NOT_PAGE.test(u)) continue
        const dir = u.replace(/[?#].*$/, '').replace(/[^/]*$/, '')
        const list = groups.get(dir) ?? []
        if (!list.includes(u)) list.push(u)
        groups.set(dir, list)
    }
    let best: string[] = []
    for (const list of groups.values()) if (list.length > best.length) best = list
    return best.length >= 2 ? best : []
}

/** Décodage base64 sans dépendre de atob (absent de certains moteurs JavaScript) */
function b64decode(s: string): string | null {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    let out = ''
    let buffer = 0
    let bits = 0
    for (const c of s.replace(/=+$/, '')) {
        const v = chars.indexOf(c)
        if (v < 0) return null
        buffer = ((buffer << 6) | v) & 0xffffff
        bits += 6
        if (bits >= 8) { bits -= 8; out += String.fromCharCode((buffer >> bits) & 0xff) }
    }
    return out
}

/** Listes d'images codées en base64 dans les scripts */
function imagesFromBase64(html: string, pageUrl: string): string[] {
    let best: string[] = []
    for (const m of html.matchAll(/["'`]([A-Za-z0-9+/]{60,}={0,2})["'`]/g)) {
        const decoded = b64decode(m[1] as string)
        if (!decoded || !/\.(jpe?g|png|webp|gif|avif)/i.test(decoded)) continue
        const imgs = imageCluster(decoded, pageUrl)
        if (imgs.length > best.length) best = imgs
    }
    return best
}

/** Trouve les images d'un chapitre, quelle que soit la façon dont le lecteur les présente */
export function universalPages($: CheerioAPI, html: string, url: string): string[] {
    const NAV = 'header, nav, footer, aside, .menu, .navbar, .sidebar, .widget, .comments, #comments, .related'
    // Images (et éléments à image différée) regroupées par conteneur : le lecteur est le plus gros groupe
    const groups = new Map<unknown, string[]>()
    $('img, [data-src], [data-original], [data-lazy-src], [data-url], [data-srcset]').each((_, el) => {
        if ($(el).closest(NAV).length) return
        if (el.name === 'img' && smallImage(el)) return
        const src = absoluteUrl(pickImageSrc(el.attribs), url)
        if (!src || NOT_PAGE.test(src)) return
        if (el.name !== 'img' && !IMG_EXT.test(src)) return
        const container = $(el).closest('div, section, article, main, body').get(0)
        const list = groups.get(container) ?? []
        if (!list.includes(src)) list.push(src)
        groups.set(container, list)
    })
    let best: string[] = []
    for (const list of groups.values()) if (list.length > best.length) best = list
    for (const alt of [imagesFromScriptArrays(html, url), imagesFromNoscript($, url)]) if (alt.length > best.length) best = alt
    // Derniers recours, seulement si rien de clair n'a été trouvé
    if (best.length < 2) for (const alt of [imageCluster(html, url), imagesFromBase64(html, url)]) if (alt.length > best.length) best = alt
    return best
}

/**
 * Vieux lecteurs "une image par page" : si une seule image est trouvée, on suit les pages
 * du chapitre (menu des pages ou lien "suivant") et on récupère l'image de chacune.
 */
/**
 * Pages d'une galerie, en taille réelle : chaque miniature mène à une page de lecture qui contient
 * la grande image. On essaie de déduire l'adresse des grandes images depuis les miniatures
 * (règle vérifiée sur la première, une du milieu et la dernière) ; sinon on ouvre chaque page.
 */
export async function galleryPages(f: Fetcher, $: CheerioAPI, url: string, html = ''): Promise<string[]> {
    const thumbs = galleryLinks($, url, url)
    if (thumbs.length < 2) return []
    const fullOf = async (pageUrl: string): Promise<string | undefined> => {
        const h = await f.get(pageUrl)
        return mainImageOf(f.load(h), h, pageUrl)
    }
    // Pages annoncées mais dont la miniature n'est pas affichée ("46 pages • 24 showing")
    const total = totalPagesOf($, html, thumbs.length)
    const first = thumbs[0] as { n: number, url: string, thumb: string }
    const contiguous = thumbs.every((t, i) => t.n === first.n + i)
    const missing = contiguous && total > thumbs.length ? total - thumbs.length : 0
    const allNumbers = Array.from({ length: thumbs.length + missing }, (_, i) => first.n + i)

    const samples = [...new Set([0, Math.floor(thumbs.length / 2), thumbs.length - 1])]
    const sampleFull: (string | undefined)[] = []
    for (const i of samples) {
        try { sampleFull.push(await fullOf((thumbs[i] as { url: string }).url)) } catch { sampleFull.push(undefined) }
        // Liste complète des pages fournie par le site lui-même (type nhentai) : vérifiée sur la 1re page
        if (sampleFull.length === 1) {
            const fromData = pagesFromGalleryData(html, sampleFull[0], first.n)
            if (fromData) return fromData
        }
    }
    const rule = thumbToFullRule(samples.map(i => (thumbs[i] as { thumb: string }).thumb), sampleFull)
    if (rule) {
        const known = thumbs.map(t => rule(t.thumb))
        if (!missing) return known
        // Modèle d'adresse "…/image{n}.jpg" vérifié sur deux pages, pour compléter les pages non affichées
        const tpl = numberTemplate(known[0] as string, first.n, known[1] as string, first.n + 1)
        return tpl ? allNumbers.map(tpl) : known
    }
    // Les grandes images suivent-elles elles-mêmes un modèle numéroté ? (vérifié sur 3 pages réelles)
    if (samples.length >= 3 && sampleFull.every(Boolean)) {
        const n = samples.map(i => (thumbs[i] as { n: number }).n)
        const tpl = numberTemplate(sampleFull[0] as string, n[0] as number, sampleFull[1] as string, n[1] as number)
        if (tpl && tpl(n[2] as number) === (sampleFull[2] as string).replace(/[?#].*$/, '')) return allNumbers.map(tpl)
    }
    // Pas de règle sûre : on ouvre chaque page de lecture (y compris les pages non affichées)
    let slots: { url: string, thumb: string }[] = thumbs.map(t => ({ url: t.url, thumb: t.thumb }))
    if (missing) {
        const tpl = numberTemplate(first.url, first.n, (thumbs[1] as { url: string }).url, first.n + 1)
        if (tpl) slots = allNumbers.map((num, i) => ({ url: tpl(num), thumb: thumbs[i]?.thumb ?? '' }))
    }
    // Les pages déjà ouvertes pour la vérification ne sont pas redemandées
    const known = new Map<string, string>()
    samples.forEach((i, k) => { const full = sampleFull[k]; if (full) known.set((thumbs[i] as { url: string }).url, full) })
    // Limites : au plus 120 pages ouvertes et 25 secondes ; au-delà, la miniature garde la place
    // (le chapitre s'ouvre toujours, au lieu de charger sans fin)
    const started = Date.now()
    let opened = 0
    const pages = await mapLimitSimple(slots.slice(0, 500), 4, async slot => {
        const hit = known.get(slot.url)
        if (hit) return hit
        for (let attempt = 0; attempt < 2; attempt++) {
            if (Date.now() - started > 25000 || opened >= 120) break
            opened++
            try { const full = await fullOf(slot.url); if (full) return full } catch { /* nouvel essai */ }
        }
        // Page illisible : sa miniature, sinon sa page de lecture (affichée en erreur, mais rien n'est décalé)
        return slot.thumb || slot.url
    })
    return pages.filter((x): x is string => !!x)
}

/** Sélecteurs de l'image principale d'une page de lecture, du plus sûr au moins sûr */
const MAIN_IMAGE_SELECTORS = ['img#img', '#i3 img', '#image-container img', 'img#image', '#image img', 'img#main-image', 'img.main-image', '#reader img', '.reader-image img', '#viewer img']

/** Image principale d'une page de lecture « une image par page » */
export function mainImageOf($: CheerioAPI, html: string, url: string): string | undefined {
    for (const sel of MAIN_IMAGE_SELECTORS) {
        const el = $(sel).first().get(0) as Element | undefined
        if (!el) continue
        const src = absoluteUrl(pickImageSrc(el.attribs), url)
        if (src && !NOT_PAGE.test(src)) return src
    }
    return universalPages($, html, url)[0]
}

/**
 * Modèle d'adresse où seul le numéro de page change : à partir de deux exemples (page a et page b),
 * retourne n -> adresse, ou null si les deux exemples ne suivent pas le même modèle.
 */
export function numberTemplate(exA: string, a: number, exB: string, b: number): ((n: number) => string) | null {
    const m = /^(.*?)(\d+)(\D*)$/.exec(exA.replace(/[?#].*$/, ''))
    if (!m) return null
    const before = m[1] as string
    const after = m[3] as string
    const digits = m[2] as string
    // Décalage possible entre le numéro de page et celui du fichier (page 0 -> image1)
    const offset = Number(digits) - a
    const pad = digits.startsWith('0') && digits.length > 1
    const make = (n: number): string => before + (pad ? String(n + offset).padStart(digits.length, '0') : String(n + offset)) + after
    return make(a) === exA.replace(/[?#].*$/, '') && make(b) === exB.replace(/[?#].*$/, '') ? make : null
}

/**
 * Remet les pages dans l'ordre si, et seulement si, ce sont clairement les pages numérotées d'un
 * même dossier (même début et même fin d'adresse, numéros tous différents et consécutifs) mais dans
 * le désordre. Sinon la liste est gardée telle quelle : on ne devine jamais un ordre.
 */
export function orderPages(pages: string[]): string[] {
    if (pages.length < 3) return pages
    const parsed = pages.map(p => /^(.*?)(\d+)(\D*)$/.exec(p.replace(/[?#].*$/, '')))
    if (parsed.some(m => !m)) return pages
    const pre = (parsed[0] as RegExpExecArray)[1]
    const suf = (parsed[0] as RegExpExecArray)[3]
    if (parsed.some(m => (m as RegExpExecArray)[1] !== pre || (m as RegExpExecArray)[3] !== suf)) return pages
    const nums = parsed.map(m => Number((m as RegExpExecArray)[2]))
    const sorted = [...nums].sort((a, b) => a - b)
    const contiguous = new Set(nums).size === nums.length && sorted.every((v, i) => i === 0 || v === (sorted[i - 1] as number) + 1)
    if (!contiguous || nums.every((v, i) => i === 0 || v > (nums[i - 1] as number))) return pages
    return pages.map((p, i) => ({ p, n: nums[i] as number })).sort((a, b) => a.n - b.n).map(x => x.p)
}

/**
 * Liste des pages donnée par le site dans ses données (type nhentai : identifiant du dossier d'images
 * et type de chaque page, j/p/g/w). Construite à partir de la vraie adresse de la 1re page, et retenue
 * seulement si elle la reproduit exactement.
 */
export function pagesFromGalleryData(html: string, firstFull: string | undefined, firstNumber: number): string[] | null {
    if (!firstFull || !html) return null
    const text = html.replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))).replace(/\\"/g, '"').replace(/\\\//g, '/')
    const media = /"media_id"\s*:\s*"?(\d+)"?/.exec(text)?.[1]
    const pagesBlock = /"pages"\s*:\s*\[([^\]]*)\]/.exec(text)?.[1]
    if (!media || !pagesBlock) return null
    const EXT: Record<string, string> = { j: 'jpg', p: 'png', g: 'gif', w: 'webp', a: 'avif' }
    const types = [...pagesBlock.matchAll(/"t"\s*:\s*"(\w)"/g)].map(m => EXT[m[1] as string] ?? '')
    if (types.length < 1 || types.some(t => !t)) return null
    const m = new RegExp(`^(.*/${media}/)(\\d+)\\.([a-z0-9]+)(\\?.*)?$`, 'i').exec(firstFull)
    if (!m) return null
    const prefix = m[1] as string
    const firstFileNumber = Number(m[2])
    const pages = types.map((ext, i) => `${prefix}${firstFileNumber + i}.${ext}`)
    // Vérification : la 1re page construite doit être exactement la vraie
    if (pages[0] !== firstFull.replace(/[?#].*$/, '') || firstFileNumber < 0 || firstNumber < 0) return null
    return pages
}

/**
 * Lecteur dont la liste des pages est chiffrée dans la page (« initReader("…") », type HentaiNexus).
 * Déchiffrement : base64, XOR des premiers octets avec le nom du site, puis flot de type RC4 dont
 * la clé (64 octets) est en tête des données. Retenu seulement si le résultat est une liste d'images.
 */
export function pagesFromEncryptedReader(html: string, hostname: string): string[] | null {
    const m = /initReader\(\s*["']((?:[A-Za-z0-9+/=\s]|\\\/){80,})["']/.exec(html)
    if (!m) return null
    const raw = b64decode((m[1] as string).replace(/\\\//g, '/').replace(/\s+/g, ''))
    if (!raw || raw.length <= 64) return null
    const data: number[] = []
    for (let i = 0; i < raw.length; i++) data.push(raw.charCodeAt(i) & 0xff)
    // La clé dépend du nom du site : on essaie le nom exact, puis sans « www. »
    let parsed: unknown
    for (const h of [...new Set([hostname.replace(/^www\./, ''), hostname])]) {
        try { parsed = JSON.parse(decryptReader(data, h)); break } catch { parsed = undefined }
    }
    if (!Array.isArray(parsed)) return null
    const pages: string[] = []
    for (const item of parsed) {
        if (!item || typeof item !== 'object') continue
        const o = item as Record<string, unknown>
        if (o['type'] !== undefined && o['type'] !== 'image') continue
        // WebP d'abord (affiché partout), puis l'original, puis les autres champs connus
        const u = [o['image_fallback'], o['image'], o['url'], o['src'], o['image_source']].find((v): v is string => typeof v === 'string' && /^https?:\/\//i.test(v))
        if (u) pages.push(u)
    }
    return pages.length ? pages : null
}

function decryptReader(input: number[], hostname: string): string {
    const data = input.slice()
    for (let i = 0; i < hostname.length && i < data.length; i++) data[i] = ((data[i] as number) ^ hostname.charCodeAt(i)) & 0xff
    const keyStream = data.slice(0, 64)
    const cipher = data.slice(64)
    const digest: number[] = Array.from({ length: 256 }, (_, i) => i)
    let primeIdx = 0
    for (let i = 0; i < 64; i++) {
        primeIdx ^= keyStream[i] as number
        for (let j = 0; j < 8; j++) primeIdx = (primeIdx & 1) !== 0 ? (primeIdx >>> 1) ^ 12 : primeIdx >>> 1
    }
    primeIdx &= 7
    let key = 0
    for (let i = 0; i < 256; i++) {
        key = (key + (digest[i] as number) + (keyStream[i % 64] as number)) % 256
        const t = digest[i] as number
        digest[i] = digest[key] as number
        digest[key] = t
    }
    const q = [2, 3, 5, 7, 11, 13, 17, 19][primeIdx] as number
    let k = 0, n = 0, p = 0, xorKey = 0
    let out = ''
    for (let i = 0; i < cipher.length; i++) {
        k = (k + q) % 256
        n = (p + (digest[(n + (digest[k] as number)) % 256] as number)) % 256
        p = (p + k + (digest[k] as number)) % 256
        const t = digest[k] as number
        digest[k] = digest[n] as number
        digest[n] = t
        xorKey = digest[(n + (digest[(k + (digest[(xorKey + p) % 256] as number)) % 256] as number)) % 256] as number
        out += String.fromCharCode(((cipher[i] as number) ^ xorKey) & 0xff)
    }
    return out
}

/** Règles miniature -> grande image, combinables ; retenue seulement si elle reproduit tous les exemples */
function thumbToFullRule(thumbs: string[], fulls: (string | undefined)[]): ((t: string) => string) | null {
    if (fulls.some(x => !x) || thumbs.some(x => !x)) return null
    // Miniatures et grandes images sur deux serveurs différents (t3.site -> i5.site) : correspondance apprise
    const originOf = (u: string): string => (/^https?:\/\/[^/]+/i.exec(u) ?? [''])[0]
    const tOrigins = [...new Set(thumbs.map(originOf))]
    const fOrigins = [...new Set((fulls as string[]).map(originOf))]
    const learned: ((t: string) => string)[] = tOrigins.length === 1 && fOrigins.length === 1 && tOrigins[0] !== fOrigins[0]
        ? [t => (originOf(t) === tOrigins[0] ? (fOrigins[0] as string) + t.slice((tOrigins[0] as string).length) : t)]
        : []
    const atoms: ((t: string) => string)[] = [
        ...learned,
        t => t.replace(/\/\/t(\d*)\./, '//i$1.'),                                  // t3.site -> i3.site
        t => t.replace(/(\d+)t(\.[a-z0-9]+)(\?|$)/i, '$1$2$3'),                   // 12t.jpg -> 12.jpg
        t => t.replace(/\/thumb(?:nail)?s?\//i, '/'),                            // /thumbnail/ -> /
        t => t.replace(/[-_.]thumb(?:nail)?(?=\.[a-z0-9]+(\?|$))/i, ''),         // 12-thumb.jpg -> 12.jpg
        t => t.replace(/\/thumb(?:nail)?s?[-_]/i, '/'),                           // /thumb_12.jpg -> /12.jpg
        t => t.replace(/\/(?:small|mini|preview|thumbs?)\//i, '/full/'),          // /small/ -> /full/
        t => t.replace(/[-_]?\d{2,4}x\d{2,4}(?=\.[a-z0-9]+(\?|$))/i, '')          // 12-200x280.jpg -> 12.jpg
    ]
    // Toutes les combinaisons, des plus simples aux plus complexes
    const combos: number[][] = []
    for (let mask = 1; mask < (1 << atoms.length); mask++) {
        const ids: number[] = []
        for (let i = 0; i < atoms.length; i++) if (mask & (1 << i)) ids.push(i)
        combos.push(ids)
    }
    combos.sort((x, y) => x.length - y.length)
    for (const ids of combos) {
        const rule = (t: string): string => ids.reduce((acc, i) => (atoms[i] as (s: string) => string)(acc), t)
        if (thumbs.every((t, i) => rule(t) === fulls[i] && rule(t) !== t)) return rule
    }
    return null
}

async function mapLimitSimple<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) { const i = next++; out[i] = await fn(items[i] as T) }
    }))
    return out
}

export async function universalPagesDeep(f: Fetcher, $: CheerioAPI, html: string, url: string): Promise<string[]> {
    const pages = universalPages($, html, url)
    if (pages.length >= 2) return pages
    const chapterPath = pathOf(url).replace(/[?#].*$/, '').replace(/\/(\d+)(\.html?)?\/?$/, '').replace(/\/$/, '')
    const urls: string[] = []
    // Menu des pages : <select><option value="…/2">2</option>…
    $('select option').each((_, opt) => {
        const u = absoluteUrl($(opt).attr('value'), url)
        if (u && pathOf(u).startsWith(chapterPath) && u.replace(/#.*$/, '') !== url && !urls.includes(u)) urls.push(u.replace(/#.*$/, ''))
    })
    const out = [...pages]
    if (urls.length) {
        // Toutes les pages du menu, en parallèle mais rangées à leur place (l'ordre du menu)
        const imgs = await mapLimitSimple(urls.slice(0, 300), 4, async u => {
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    const h = await f.get(u)
                    const img = mainImageOf(f.load(h), h, u)
                    if (img) return img
                } catch { /* nouvel essai */ }
            }
            return undefined
        })
        for (const img of imgs) if (img && !out.includes(img)) out.push(img)
        return out
    }
    // Sinon : lien "suivant" de page en page (dans le même chapitre)
    let current$ = $
    let currentUrl = url
    for (let i = 0; i < 200; i++) {
        let next: string | undefined
        current$('a[rel="next"], a[href]').each((_, el) => {
            if (next) return
            const text = clean(current$(el).text()).toLowerCase()
            const u = absoluteUrl(current$(el).attr('href'), currentUrl)
            if (!u || !pathOf(u).startsWith(chapterPath)) return
            if (el.attribs['rel'] === 'next' || /^(next|suivant|suivante|›|»|>|→)$/.test(text) || /next page|page suivante/.test(text)) next = u.replace(/#.*$/, '')
        })
        if (!next || next === currentUrl) break
        try {
            const h = await f.get(next)
            current$ = f.load(h)
            currentUrl = next
            const img = universalPages(current$, h, next)[0]
            if (!img || out.includes(img)) break
            out.push(img)
        } catch { break }
    }
    return out
}

/** Texte d'un vrai lien de chapitre */
const CHAPTER_WORDS = /\b(?:chap(?:ter|itre)?s?|ch\.?\s*\d|episodes?|ep\.?\s*\d|vol(?:ume)?\.?|tome|cap[ií]tulo|part(?:ie)?\s*\d)/i

/** Dossier de miniatures (« …/HASH/thumbnail/ », « …/thumbs/ ») : les grandes images sont dans le dossier parent */
const THUMB_DIR = /^(?:thumbs?|thumbnails?|small|previews?|mini|t)$/i
/** Nom de miniature à côté des grandes images (« image1t.jpg », « 1t.jpg ») */
const THUMB_FILE = /\d+t\.(?:jpe?g|png|webp|gif|avif)$/i

/**
 * Liste complète des pages écrite dans les données de la page (Next.js, JSON, scripts) :
 * toutes les images du dossier de la galerie, dans l'ordre où le site les donne (EAHentai :
 * "imageUri":"galleries/HASH/image1.webp", formats mélangés). Le dossier est celui des miniatures
 * (ou des images affichées) ; seules les images directement dans ce dossier comptent, jamais celles
 * des autres galeries citées sur la page (suggestions) ni les miniatures.
 * Utilisée seulement pour une galerie (miniatures) ou quand les données annoncent plus de pages que la page n'en affiche.
 */
export function pagesFromFolderData($: CheerioAPI, html: string, url: string): string[] | null {
    if (!html) return null
    const thumbs = galleryLinks($, url, url)
    const hints: string[] = thumbs.map(t => t.thumb).filter(Boolean)
    const shownImages: string[] = []
    $('img').each((_, el) => {
        const src = absoluteUrl(pickImageSrc(el.attribs), url)
        if (src && !NOT_PAGE.test(src.replace(/[?#].*$/, '').replace(/\/(?:thumbs?|thumbnails?)\/[^/]+$/i, '/x.jpg'))) shownImages.push(src)
    })
    hints.push(...shownImages)
    // Dossiers candidats : dossier de l'image (ou son parent si c'est un dossier de miniatures)
    const folders = new Map<string, number>()
    for (const h of hints) {
        const clean = h.replace(/[?#].*$/, '')
        let dir = clean.slice(0, clean.lastIndexOf('/'))
        const last = dir.slice(dir.lastIndexOf('/') + 1)
        if (THUMB_DIR.test(last)) dir = dir.slice(0, dir.lastIndexOf('/'))
        if (!/^https?:\/\/[^/]+\/.+/.test(dir)) continue
        folders.set(dir, (folders.get(dir) ?? 0) + 1)
    }
    if (folders.size === 0) return null
    const unescape = (t: string): string => t
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, x: string) => String.fromCharCode(parseInt(x, 16)))
        .replace(/\\+"/g, '"').replace(/\\+\//g, '/')
    // Les données (scripts) d'abord : c'est là que la liste est complète et dans l'ordre du site ;
    // les images affichées dans la page (une fenêtre autour de la page courante) passent après
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1] as string).join('\n')
    const texts = [unescape(scripts), unescape(html)]
    // Nombres de pages annoncés (seulement sur une galerie : sur une page de lecture, « Page 6 » n'est pas un total)
    const totals = thumbs.length >= 2 ? plausibleTotals($, html, thumbs.length) : []
    let best: string[] = []
    // Le dossier le plus représenté d'abord (celui des miniatures de la galerie)
    for (const [dir] of [...folders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
        const segs = dir.replace(/^https?:\/\/[^/]+\//, '').split('/')
        const seg = segs[segs.length - 1] as string
        const parent = segs[segs.length - 2]
        // Le nom du dossier doit être assez particulier (identifiant, code) pour ne désigner que cette galerie
        if (!parent || seg.length < 3 || !/\d/.test(seg)) continue
        const key = `${parent}/${seg}/`
        const re = new RegExp(`([A-Za-z0-9_.~:%/-]*?)${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^"'\\s<>?#/\\\\]+\\.(?:jpe?g|png|webp|gif|avif))(?=[?#"'\\s\\\\<]|$)`, 'gi')
        for (const text of texts) {
            const out: string[] = []
            for (const m of text.matchAll(re)) {
                const file = m[2] as string
                if (THUMB_FILE.test(file)) continue
                const lead = m[1] as string
                let abs: string | null = null
                if (/^https?:\/\//i.test(lead)) abs = lead + key + file
                else if (lead.startsWith('//')) abs = 'https:' + lead + key + file
                else {
                    // Chemin relatif (« galleries/HASH/image1.webp ») : on le replace dans l'adresse du dossier
                    const at = (dir + '/').lastIndexOf(key)
                    if (at >= 0) abs = (dir + '/').slice(0, at) + key + file
                }
                if (abs && !out.includes(abs)) out.push(abs)
            }
            if (out.length >= 2) { best = out; break }
        }
        // Le dossier principal a donné sa liste : on ne regarde pas les autres (galeries suggérées)
        if (best.length >= 2) break
    }
    if (best.length < 2) return null
    // Contrôles : autant de pages que la galerie l'annonce, au moins autant que de miniatures,
    // et (hors galerie) plus que ce que la page affiche, sinon la lecture habituelle suffit
    if (totals.length && !totals.includes(best.length)) return null
    if (best.length < thumbs.length) return null
    const shownHere = shownImages.filter(s => best.includes(s.replace(/[?#].*$/, ''))).length
    if (thumbs.length < 2 && best.length <= shownHere) return null
    return best
}
