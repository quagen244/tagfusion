import { CheerioAPI, Element } from 'cheerio'
import type { ChapterItem, Fetcher } from './Engines'
import { absoluteUrl, hostOf, looksLikeTagUrl, parseDate, pathOf, pickImageSrc } from './Utils'

// ============================================================================
// Lecture UNIVERSELLE des chapitres et des pages, quel que soit le site.
// Plusieurs méthodes enchaînées : chacune prend le relais si la précédente ne trouve rien.
// ============================================================================

/** Zones de navigation à ignorer pour les chapitres (on garde les barres latérales : on trie après) */
const CH_NAV = 'header, nav, footer, .menu, .navbar, .nav-menu, .main-menu, .sub-menu, .dropdown-menu, .breadcrumb, .breadcrumbs, #menu'

/** Adresse qui ressemble à un chapitre, dans de nombreuses langues et structures */
const CH_URL_RE = /(chapter|chapitre|capitulo|capítulo|kapitel|bolum|bölüm|chuong|chương|episode|episodio|épisode|[/_-]cap[-_]?\d|[/_-]ep[-_.]?\d|[/_-]ch[-_.]?\d|\/c\d+(?:[/.?#]|$)|\/read\/|\/reader\/|\/viewer\/|\/view\/|\/chap[-_/]?\d)/i

/** Texte de lien qui ressemble à un chapitre : "Chapter 12", "Ch. 3", "Chapitre 4", "Vol.2 Ch.5", "Épisode 7", "#12", "第12話" */
const CH_TEXT_RE = /^(?:(?:vol(?:ume)?|tome|t)\.?\s*\d+[\s,.:-]*)?(?:chapter|chapitre|chap|ch|capitulo|capítulo|cap|kapitel|bölüm|bolum|episode|épisode|episodio|ep|chương|chuong|#)\s*\.?\s*[-:#]?\s*\d+|第\s*\d+\s*[话話章回]/i

/** Lien "tous les chapitres" / "liste des chapitres" */
const ALL_CHAPTERS_RE = /(all|tous les|toutes les|view all|voir tous?|liste des|full|complete|show all|see all).{0,15}(chap|épisode|episode)|(chapters?|chapitres?)\s*(list|liste)/i

/** Petits badges à retirer des noms : "NEW", "HOT", "UP"... */
const BADGES_RE = /\b(new|nouveau|hot|up|free|gratuit|vip|locked|🔒)\b/gi

/** Dates dans une ligne de chapitre */
const DATE_RE = /(\d+\s*(?:sec|second|min|minute|hour|heure|hr|day|jour|week|semaine|month|mois|year|an|année)s?\s*(?:ago)?|il y a\s+\d+\s*\w+|\b(?:today|yesterday|aujourd'hui|hier)\b|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|(?:jan|feb|fév|mar|apr|avr|may|mai|jun|juin|jul|juil|aug|aoû|sep|oct|nov|dec|déc)[a-zéû]*\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+(?:jan|feb|fév|mar|apr|avr|may|mai|jun|juin|jul|juil|aug|aoû|sep|oct|nov|dec|déc)[a-zéû]*\.?\s+\d{4})/i

function clean(s: string | undefined): string {
    return (s ?? '').replace(/\s+/g, ' ').trim()
}

function inChapterNav($: CheerioAPI, el: Element): boolean {
    return $(el).closest(CH_NAV).length > 0
}

/** Dernier morceau de l'adresse de la fiche : "/manga/solo-leveling/" -> "solo-leveling" */
function mangaSlug(mangaUrl: string): string {
    const parts = pathOf(mangaUrl).replace(/[?#].*$/, '').split('/').filter(Boolean)
    return (parts[parts.length - 1] ?? '').toLowerCase()
}

// --- Numéro, volume, nom propre ---------------------------------------------------

export function parseChapterInfo(text: string, url: string): { num: number, volume: number, name: string } {
    const t = clean(text)
    const vol = /(?:vol(?:ume)?|tome|t)\.?\s*(\d+)/i.exec(t)
    const labelled = /(?:chapter|chapitre|chap|ch|capitulo|capítulo|cap|kapitel|bölüm|bolum|episode|épisode|episodio|ep|chương|chuong|#)\s*\.?\s*[-:#]?\s*(\d+(?:[.,]\d+)?)/i.exec(t) ?? /第\s*(\d+(?:\.\d+)?)\s*[话話章回]/.exec(t)
    let num = labelled?.[1] ? Number(labelled[1].replace(',', '.')) : NaN
    if (isNaN(num)) {
        const p = decodeURIComponent(pathOf(url)).replace(/[?#].*$/, '')
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
        .replace(/^[\s:|·•–—-]+/, '').replace(/[\s:|·•–—-]+$/, '')
    name = clean(name)
    return { num: isNaN(num) ? -1 : num, volume: vol?.[1] ? Number(vol[1]) : 0, name }
}

function dateFromRow(rowText: string): Date {
    const m = DATE_RE.exec(rowText)
    return parseDate(m ? m[0] : '')
}

// --- Méthode 1 : les liens de chapitres de la page -----------------------------------

interface Candidate { url: string, text: string, row: string, group: unknown, order: number }

function chapterCandidates($: CheerioAPI, pageUrl: string, base: string, mangaUrl: string): Candidate[] {
    const out: Candidate[] = []
    const seen = new Set<string>()
    const mangaClean = mangaUrl.replace(/[?#].*$/, '').replace(/\/$/, '')
    let order = 0
    $('a[href]').each((_, el) => {
        if (inChapterNav($, el)) return
        const url = absoluteUrl($(el).attr('href'), pageUrl)
        if (!url || hostOf(url) !== hostOf(base)) return
        const u = url.replace(/#.*$/, '')
        if (u.replace(/\/$/, '') === mangaClean || looksLikeTagUrl(u)) return
        // Liens de pagination ou de liste ("…/chapters?page=2", "…/page/3/", "…/chapters") : pas des chapitres
        const p = pathOf(u)
        if (/[?&](page|p|pg|sort|order)=/i.test(p) || /\/page\/\d+\/?$/i.test(p) || /\/(chapters?|chapitres?|chapter-list|episodes?)\/?(\?|$)/i.test(p)) return
        const text = clean($(el).attr('title')) || clean($(el).text())
        if (!CH_URL_RE.test(pathOf(u)) && !CH_TEXT_RE.test(text)) return
        if (seen.has(u)) return
        seen.add(u)
        // Le "bloc" du lien : la liste qui le contient
        const groupEl = $(el).closest('ul, ol, tbody, table, select, [class*="chapter"], [id*="chapter"], [class*="episode"], [class*="list"], [class*="eplist"]').get(0)
            ?? $(el).parent().parent().get(0)
        const row = clean($(el).closest('li, tr, [class*="chapter-item"], [class*="item"], div').text())
        out.push({ url: u, text, row, group: groupEl, order: order++ })
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
    const slug = mangaSlug(mangaUrl)
    const mangaPath = pathOf(mangaUrl).replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase()
    const related = (c: Candidate): boolean => {
        const p = pathOf(c.url).toLowerCase()
        return (mangaPath.length > 1 && p.startsWith(mangaPath + '/')) || (slug.length > 2 && p.includes(slug))
    }
    const groups = new Map<unknown, Candidate[]>()
    for (const c of cands) {
        const list = groups.get(c.group) ?? []
        list.push(c)
        groups.set(c.group, list)
    }
    let best: Candidate[] = []
    let bestScore = -1
    for (const list of groups.values()) {
        const rel = list.filter(related).length
        // Les liens "liés" à ce manga comptent triple
        const score = list.length + rel * 2
        if (score > bestScore) { best = list; bestScore = score }
    }
    const relatedAll = cands.filter(related)
    // Si des chapitres de CE manga existent ailleurs que dans le meilleur bloc, on les préfère
    if (relatedAll.length > best.filter(related).length && relatedAll.length >= 2) return relatedAll
    if (best.some(related)) return best.filter(c => related(c) || !relatedAll.length)
    return best
}

// --- Méthode 2 : données cachées dans la page (sites modernes) -------------------------

function chaptersFromJson($: CheerioAPI, pageUrl: string, base: string): ChapterItem[] {
    const out: ChapterItem[] = []
    const seen = new Set<string>()
    const visit = (node: unknown, depth: number): void => {
        if (depth > 12 || !node || typeof node !== 'object') return
        if (Array.isArray(node)) {
            const objs = node.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
            if (objs.length >= 2) {
                const found: ChapterItem[] = []
                for (const o of objs) {
                    const link = [o['url'], o['href'], o['link'], o['path'], o['permalink']].find((v): v is string => typeof v === 'string' && /^(https?:\/\/|\/)/.test(v))
                    if (!link) continue
                    const url = absoluteUrl(link, pageUrl)
                    if (!url || hostOf(url) !== hostOf(base)) continue
                    const label = [o['name'], o['title'], o['chapter_title'], o['label']].find((v): v is string => typeof v === 'string') ?? ''
                    const numRaw = [o['chapter'], o['chapter_number'], o['chapterNumber'], o['number'], o['chap'], o['episode']].find(v => typeof v === 'number' || (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)))
                    if (!CH_URL_RE.test(pathOf(url)) && !CH_TEXT_RE.test(label) && numRaw === undefined) continue
                    const info = parseChapterInfo(label || (numRaw !== undefined ? `Chapter ${numRaw}` : ''), url)
                    const dateRaw = [o['date'], o['created_at'], o['createdAt'], o['published_at'], o['publishedAt'], o['updated_at'], o['datePublished']].find((v): v is string => typeof v === 'string')
                    found.push({
                        url, name: info.name,
                        num: numRaw !== undefined ? Number(numRaw) : info.num,
                        volume: info.volume,
                        date: parseDate(dateRaw ?? '')
                    })
                }
                if (found.length >= 2) for (const c of found) if (!seen.has(c.url)) { seen.add(c.url); out.push(c) }
            }
            for (const x of node) visit(x, depth + 1)
            return
        }
        for (const v of Object.values(node as Record<string, unknown>)) visit(v, depth + 1)
    }
    $('script#__NEXT_DATA__, script[type="application/ld+json"], script[type="application/json"]').each((_, el) => {
        try { visit(JSON.parse($(el).text()), 0) } catch { /* pas du JSON */ }
    })
    return out
}

// --- Méthode 4 : le menu déroulant d'un lecteur ----------------------------------------

function chaptersFromSelect($: CheerioAPI, pageUrl: string, base: string): ChapterItem[] {
    const out: ChapterItem[] = []
    const seen = new Set<string>()
    $('select').each((_, sel) => {
        const found: ChapterItem[] = []
        $(sel).find('option').each((__, opt) => {
            const value = $(opt).attr('value') ?? $(opt).attr('data-redirect') ?? $(opt).attr('data-url')
            const url = absoluteUrl(value, pageUrl)
            const text = clean($(opt).text())
            if (!url || hostOf(url) !== hostOf(base)) return
            if (!CH_URL_RE.test(pathOf(url)) && !CH_TEXT_RE.test(text)) return
            const info = parseChapterInfo(text, url)
            found.push({ url: url.replace(/#.*$/, ''), name: info.name, num: info.num, volume: info.volume, date: parseDate('') })
        })
        if (found.length > out.length) {
            out.length = 0
            for (const c of found) if (!seen.has(c.url)) { seen.add(c.url); out.push(c) }
        }
    })
    return out
}

// --- Assemblage -------------------------------------------------------------------------

export function sortNewestFirst(chs: ChapterItem[]): ChapterItem[] {
    const known = chs.filter(c => c.num >= 0)
    const first = known[0]
    const last = known[known.length - 1]
    if (first && last && first.num < last.num) return [...chs].reverse()
    return chs
}

function dedupe(chs: ChapterItem[]): ChapterItem[] {
    const seen = new Set<string>()
    return chs.filter(c => (seen.has(c.url) ? false : (seen.add(c.url), true)))
}

/**
 * Trouve les chapitres d'une fiche, sur n'importe quel site.
 * `$` = la fiche déjà chargée. Va chercher d'autres pages seulement si nécessaire.
 */
export async function universalChapters(f: Fetcher, mangaUrl: string, $: CheerioAPI, base: string): Promise<ChapterItem[]> {
    // 1. Liens de chapitres sur la fiche
    let cands = pickChapterList(chapterCandidates($, mangaUrl, base, mangaUrl), mangaUrl)
    let chapters = toItems(cands)

    // 2. Données cachées (sites en Next.js, JSON-LD...)
    if (chapters.length < 2) {
        const fromJson = chaptersFromJson($, mangaUrl, base)
        if (fromJson.length > chapters.length) chapters = fromJson
    }

    // 3. Page "tous les chapitres" (et sa pagination)
    if (chapters.length < 2) {
        const links: string[] = []
        $('a[href]').each((_, el) => {
            const text = clean($(el).text()) + ' ' + clean($(el).attr('title'))
            const href = absoluteUrl($(el).attr('href'), mangaUrl)
            if (!href || hostOf(href) !== hostOf(base)) return
            if (ALL_CHAPTERS_RE.test(text) || /\/(chapters?|chapter-list|episodes)\/?(\?|$)/i.test(pathOf(href))) links.push(href)
        })
        const guesses = [...links, mangaUrl.replace(/\/?$/, '/') + 'chapters', mangaUrl.replace(/\/?$/, '/') + 'chapters/']
        for (const pageUrl of [...new Set(guesses)].slice(0, 4)) {
            try {
                const list = await chaptersAcrossPages(f, pageUrl, base, mangaUrl)
                if (list.length > chapters.length) { chapters = list; break }
            } catch { /* page absente : on essaie la suivante */ }
        }
    } else {
        // La liste de la fiche est peut-être paginée : on suit ses pages
        const more = await followListPagination(f, $, mangaUrl, base, mangaUrl, cands)
        if (more.length) chapters = dedupe([...chapters, ...more])
    }

    // 4. Le menu déroulant du lecteur, en ouvrant un chapitre
    if (chapters.length < 2) {
        const first = chapters[0]?.url ?? firstReadLink($, mangaUrl, base)
        if (first) {
            try {
                const $c = f.load(await f.get(first))
                const fromSelect = chaptersFromSelect($c, first, base)
                if (fromSelect.length > chapters.length) chapters = fromSelect
                else {
                    cands = pickChapterList(chapterCandidates($c, first, base, mangaUrl), mangaUrl)
                    const fromReader = toItems(cands).filter(c => c.url !== first)
                    if (fromReader.length + 1 > chapters.length && fromReader.length >= 2) chapters = dedupe([...(chapters[0] ? [chapters[0]] : []), ...fromReader])
                }
            } catch { /* chapitre illisible */ }
        }
    }
    return sortNewestFirst(dedupe(chapters))
}

/** Lien "Lire" / "Commencer" / "Premier chapitre" */
function firstReadLink($: CheerioAPI, mangaUrl: string, base: string): string | undefined {
    let found: string | undefined
    $('a[href]').each((_, el) => {
        if (found) return
        const text = clean($(el).text()).toLowerCase()
        const href = absoluteUrl($(el).attr('href'), mangaUrl)
        if (!href || hostOf(href) !== hostOf(base)) return
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

/** Suit "page 2, 3..." d'une liste de chapitres (15 pages au plus) */
async function followListPagination(f: Fetcher, $: CheerioAPI, pageUrl: string, base: string, mangaUrl: string, firstCands: Candidate[]): Promise<ChapterItem[]> {
    const listPath = pathOf(pageUrl).replace(/[?#].*$/, '').replace(/\/page\/\d+\/?$/, '').replace(/\/$/, '')
    const pages = new Set<string>()
    $('a[href]').each((_, el) => {
        const href = absoluteUrl($(el).attr('href'), pageUrl)
        if (!href || hostOf(href) !== hostOf(base)) return
        const p = pathOf(href)
        const samePath = p.replace(/[?#].*$/, '').replace(/\/page\/\d+\/?$/, '').replace(/\/$/, '') === listPath
        if (samePath && (/[?&](page|p|pg)=\d+/.test(p) || /\/page\/\d+/.test(p))) pages.add(href.replace(/#.*$/, ''))
    })
    if (pages.size === 0) return []
    const known = new Set(firstCands.map(c => c.url))
    const out: ChapterItem[] = []
    for (const p of [...pages].slice(0, 15)) {
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

const IMG_EXT = /\.(?:jpe?g|png|webp|gif|avif|bmp)(?:[?#]|$)/i
const NOT_PAGE = /(logo|icon|favicon|avatar|banner|sprite|loading|loader|spinner|emoji|placeholder|pixel|blank|ads?[/_-]|advert|badge|button|thumb(?:nail)?s?\/|\/smilies\/|\.svg)/i

function smallImage(el: Element): boolean {
    const w = Number(el.attribs['width'])
    const h = Number(el.attribs['height'])
    return (w > 0 && w < 120) || (h > 0 && h < 120)
}

/** Listes d'images dans les scripts : ["…/1.jpg","…/2.jpg"], y compris chemins relatifs et "\/" */
function imagesFromScripts(html: string, pageUrl: string): string[] {
    const re = /\[\s*"(?:[^"\\]|\\.)+?\.(?:jpe?g|png|webp|gif|avif)(?:\?(?:[^"\\]|\\.)*)?"(?:\s*,\s*"(?:[^"\\]|\\.)+?")+\s*,?\s*\]/gi
    let best: string[] = []
    for (const m of html.matchAll(re)) {
        try {
            const arr = JSON.parse(m[0].replace(/,\s*\]$/, ']')) as unknown
            if (!Array.isArray(arr)) continue
            const urls = arr.filter((x): x is string => typeof x === 'string' && IMG_EXT.test(x))
                .map(x => absoluteUrl(x.replace(/\\\//g, '/'), pageUrl)).filter((x): x is string => !!x && !NOT_PAGE.test(x))
            if (urls.length > best.length) best = urls
        } catch { /* pas du JSON valide */ }
    }
    return best
}

/** Images cachées dans <noscript> (lecteurs avec chargement différé) */
function imagesFromNoscript($: CheerioAPI, pageUrl: string): string[] {
    const out: string[] = []
    $('noscript').each((_, el) => {
        const raw = $(el).text()
        for (const m of raw.matchAll(/<img[^>]+?(?:data-src|src)\s*=\s*["']([^"']+)["']/gi)) {
            const u = absoluteUrl(m[1], pageUrl)
            if (u && !NOT_PAGE.test(u) && !out.includes(u)) out.push(u)
        }
    })
    return out
}

/** Trouve les images d'un chapitre, sur n'importe quel site */
export function universalPages($: CheerioAPI, html: string, url: string): string[] {
    const NAV = 'header, nav, footer, aside, .menu, .navbar, .sidebar, .widget, .comments, #comments, .related'
    // Images (et éléments à image différée) regroupées par conteneur : le lecteur est le plus gros groupe
    const groups = new Map<unknown, string[]>()
    $('img, [data-src], [data-original], [data-lazy-src], [data-url]').each((_, el) => {
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
    for (const alt of [imagesFromScripts(html, url), imagesFromNoscript($, url)]) if (alt.length > best.length) best = alt
    return best
}
