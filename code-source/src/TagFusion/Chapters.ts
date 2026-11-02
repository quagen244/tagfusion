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
    await step('liens de la fiche', () => {
        cands = pickChapterList(chapterCandidates($, mangaUrl, base, mangaUrl), mangaUrl)
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

    // 5. Page "tous les chapitres" séparée (et sa pagination)
    if (chapters.length < 2) {
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
    // 7. Aucune liste de chapitres mais une galerie (miniatures numérotées) : un chapitre unique
    if (chapters.length === 0) {
        await step('galerie (chapitre unique)', () => {
            const thumbs = galleryLinks($, mangaUrl, mangaUrl)
            const reader = readerImages($, mangaUrl)
            return thumbs.length >= 2 || reader >= 3 ? [{ url: mangaUrl.replace(/[?#].*$/, ''), name: '', num: 1, date: parseDate('') }] : []
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
    const ids = gp.match(/\d{3,}/g) ?? []
    const gid = ids[ids.length - 1]
    const out: { n: number, url: string, thumb: string }[] = []
    const seen = new Set<number>()
    $('a[href]').each((_, el) => {
        const img = $(el).find('img').first()
        const text = clean($(el).text())
        // Une miniature (image) ou un simple numéro de page ; pas un lien avec un vrai texte
        if (img.length === 0 && text !== '' && !/^\d+$/.test(text)) return
        const url = absoluteUrl($(el).attr('href'), pageUrl)
        if (!url || hostOf(url) !== hostOf(galleryUrl)) return
        const path = pathOf(url).replace(/[?#].*$/, '').toLowerCase()
        if (path.replace(/\/$/, '') === gp) return
        const m = /^(.*)\/(\d+)\/?$/.exec(path)
        if (!m) return
        const parent = m[1] as string
        const sameGallery = parent === gp || (!!gid && parent.split('/').includes(gid))
        if (!sameGallery) return
        const n = Number(m[2])
        if (seen.has(n)) return
        seen.add(n)
        const node = img.get(0) as Element | undefined
        out.push({ n, url: url.replace(/#.*$/, ''), thumb: node ? absoluteUrl(pickImageSrc(node.attribs), pageUrl) ?? '' : '' })
    })
    return out.sort((a, b) => a.n - b.n)
}

/**
 * Nombre total de pages annoncé par une galerie ("Pages: 35", "46 pages • 24 showing", champ caché).
 * On garde le plus petit total au moins égal au nombre de miniatures affichées (et au plus 30 fois ce nombre),
 * pour ne pas confondre avec un autre nombre de la page (« 2303 pages » d'une pagination, etc.).
 */
export function totalPagesOf($: CheerioAPI, html: string, shown = 1): number {
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
    const plausible = found.filter(v => v >= shown && v <= Math.max(shown * 30, shown + 30))
    return plausible.length ? Math.min(...plausible) : 0
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
        return universalPages(f.load(h), h, pageUrl)[0]
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
        return slot.thumb || undefined
    })
    return pages.filter((x): x is string => !!x)
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
                    const img = universalPages(f.load(h), h, u)[0]
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
