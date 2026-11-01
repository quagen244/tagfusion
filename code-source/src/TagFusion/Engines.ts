import { CheerioAPI, Cheerio, Element } from 'cheerio'
import { EngineName, SiteTag } from './Store'
import {
    absoluteUrl, hostOf, looksLikeChapterUrl, looksLikeMangaUrl, looksLikeTagUrl,
    pagedUrl, parseChapterNumber, parseDate, pickImageSrc
} from './Utils'

// ---------------------------------------------------------------------------
// Ce que chaque "moteur" sait faire. Un moteur = une façon de lire un type de site.
//  - madara   : thème WordPress "Madara" (des centaines de sites de scans)
//  - themesia : thème WordPress "MangaReader / MangaThemesia" (très répandu aussi)
//  - generic  : mode universel par détection automatique, pour tout le reste
// ---------------------------------------------------------------------------

export interface ListingItem { url: string, title: string, image: string }

export interface Details {
    title: string
    image: string
    desc: string
    author: string
    artist: string
    status: string
    altTitles: string[]
    tags: SiteTag[]
}

export interface ChapterItem { url: string, name: string, num: number, date: Date }

/** Accès réseau fourni par l'extension */
export interface Fetcher {
    get(url: string, headers?: Record<string, string>): Promise<string>
    post(url: string, body: string, headers?: Record<string, string>): Promise<string>
    load(html: string): CheerioAPI
}

export interface Engine {
    name: EngineName
    detect(html: string): boolean
    /** Pages à lire pour découvrir la liste complète des tags du site */
    discoveryPages(base: string): string[]
    parseTags($: CheerioAPI, pageUrl: string, base: string, onDetailsPage: boolean): SiteTag[]
    listingUrl(tag: SiteTag, page: number): string
    /** URL d'une recherche "tous ces tags à la fois", si le site sait le faire */
    combinedUrl(base: string, tags: SiteTag[], page: number): string | null
    searchUrl(base: string, title: string, page: number): string
    parseListing($: CheerioAPI, pageUrl: string, base: string): ListingItem[]
    parseDetails($: CheerioAPI, url: string, base: string): Details
    getChapters(f: Fetcher, mangaUrl: string, $: CheerioAPI, base: string): Promise<ChapterItem[]>
    chapterPageUrl(chapterUrl: string): string
    parsePages($: CheerioAPI, html: string, url: string): string[]
}

// --- Outils communs ------------------------------------------------------------

const NAV_SCOPE = 'header, nav, footer, aside, .menu, .navbar, .nav-menu, .main-menu, .sub-menu, .dropdown-menu, .sidebar, .widget, #menu, .footer, .header'

function clean(s: string | undefined): string {
    return (s ?? '').replace(/\s+/g, ' ').trim()
}

function imgOf<T>(el: Cheerio<T>, base: string): string {
    const img = el.is('img') ? el : el.find('img').first()
    if (img.length === 0) return ''
    const node = img.get(0) as Element | undefined
    const src = pickImageSrc(node?.attribs ?? {})
    return absoluteUrl(src, base) ?? ''
}

function sameHost(url: string, base: string): boolean {
    return hostOf(url) === hostOf(base)
}

function inNav($: CheerioAPI, el: Element): boolean {
    return $(el).closest(NAV_SCOPE).length > 0
}

/** Tags = liens qui pointent vers une page "tous les mangas du tag X" */
function genericTagLinks($: CheerioAPI, base: string, skipNav: boolean, scope?: string): SiteTag[] {
    const out: SiteTag[] = []
    const seen = new Set<string>()
    $(scope ? `${scope} a[href]` : 'a[href]').each((_, el) => {
        const url = absoluteUrl($(el).attr('href'), base)
        if (!url || !sameHost(url, base) || !looksLikeTagUrl(url)) return
        if (skipNav && inNav($, el)) return
        // "Romance (1234)" -> "Romance"
        const label = clean($(el).attr('title') && clean($(el).text()) === '' ? $(el).attr('title') : $(el).text())
            .replace(/\s*[([]?\d[\d,.\s]*[)\]]?\s*$/, '').replace(/^#/, '').trim()
        if (!label || label.length > 40) return
        const k = label.toLowerCase()
        if (seen.has(k)) return
        seen.add(k)
        out.push({ label, url: url.replace(/#.*$/, '') })
    })
    return out
}

/** Liste de mangas : liens vers des fiches, accompagnés d'une image */
function genericListing($: CheerioAPI, pageUrl: string, base: string): ListingItem[] {
    const byUrl = new Map<string, ListingItem>()
    const consider = (el: Element, strict: boolean): void => {
        if (inNav($, el)) return
        const a = $(el)
        const url = absoluteUrl(a.attr('href'), pageUrl)
        if (!url || !sameHost(url, base)) return
        const clean_url = url.replace(/#.*$/, '')
        if (looksLikeTagUrl(clean_url) || looksLikeChapterUrl(clean_url)) return
        if (strict && !looksLikeMangaUrl(clean_url)) return
        if (!strict && (/\/page\/\d+|[?&]page=|\/(login|register|user|account|profile|bookmark|contact|privacy|dmca|terms)/i.test(clean_url) || clean_url.replace(/\/$/, '') === base)) return
        const card = a.closest('li, article, .item, .card, .bs, .bsx, [class*="item"], [class*="card"], div')
        let image = imgOf(a, pageUrl)
        if (!image && card.length) image = imgOf(card, pageUrl)
        const heading = card.find('h1, h2, h3, h4, h5, .title, [class*="title"]').first()
        const title = clean(a.attr('title')) || clean(a.find('img').attr('alt')) || clean(heading.text()) || clean(a.text())
        if (!title || title.length > 200) return
        const prev = byUrl.get(clean_url)
        if (!prev) byUrl.set(clean_url, { url: clean_url, title, image })
        else {
            if (!prev.image && image) prev.image = image
            if (prev.title.length < 2 && title) prev.title = title
        }
    }
    $('a[href]').each((_, el) => consider(el, true))
    // Si le site n'utilise pas d'URL "/manga/..." : on prend les liens avec une image
    if (byUrl.size < 3) {
        byUrl.clear()
        $('a[href]').each((_, el) => { if ($(el).find('img').length) consider(el, false) })
    }
    // Une vraie liste de mangas a des images : on garde seulement les entrées illustrées si possible
    const all = [...byUrl.values()]
    const withImg = all.filter(i => i.image)
    return withImg.length >= Math.min(3, all.length) ? withImg : all
}

function genericDetails($: CheerioAPI, url: string, base: string): Details {
    const og = (p: string): string => clean($(`meta[property="${p}"]`).attr('content'))
    const title = clean($('h1').first().text()) || og('og:title').replace(/\s*[-|–].*$/, '')
    const image = absoluteUrl(og('og:image'), url) ?? imgOf($('main, article, body').first(), url)
    let desc = ''
    $('[class*="summary"], [class*="description"], [class*="synopsis"], [itemprop="description"]').each((_, el) => {
        const t = clean($(el).text())
        if (t.length > desc.length && t.length < 5000) desc = t
    })
    if (!desc) desc = og('og:description') || clean($('meta[name="description"]').attr('content'))
    return {
        title, image, desc, author: '', artist: '', status: 'Unknown', altTitles: [],
        tags: genericTagLinks($, base, true)
    }
}

function genericChapters($: CheerioAPI, mangaUrl: string, base: string): ChapterItem[] {
    const out: ChapterItem[] = []
    const seen = new Set<string>()
    const mangaPath = mangaUrl.replace(/^https?:\/\/[^/]+/, '').replace(/\/$/, '')
    $('a[href]').each((_, el) => {
        if (inNav($, el)) return
        const url = absoluteUrl($(el).attr('href'), mangaUrl)
        if (!url || !sameHost(url, base) || !looksLikeChapterUrl(url)) return
        const u = url.replace(/#.*$/, '')
        // On garde en priorité les chapitres "sous" la fiche du manga
        if (seen.has(u)) return
        seen.add(u)
        const row = $(el).closest('li, tr, .chapter, [class*="chapter"], div')
        const name = clean($(el).attr('title')) || clean($(el).text()) || clean(row.text())
        const dateText = clean(row.find('[class*="date"], [class*="time"], time').first().text())
        out.push({ url: u, name, num: parseChapterNumber(name, u), date: parseDate(dateText) })
    })
    const under = out.filter(c => mangaPath.length > 1 && c.url.includes(mangaPath))
    return under.length ? under : out
}

function imagesFromScripts(html: string): string[] {
    // Beaucoup de lecteurs mettent la liste des pages dans un tableau JSON
    const re = /\[\s*"(https?:\\?\/\\?\/[^"]+?\.(?:jpe?g|png|webp|gif|avif)[^"]*)"(?:\s*,\s*"https?:[^"]+")+\s*\]/gi
    let best: string[] = []
    for (const m of html.matchAll(re)) {
        try {
            const arr = JSON.parse(m[0].replace(/\\\//g, '/')) as unknown
            if (Array.isArray(arr) && arr.length > best.length) best = arr.filter((x): x is string => typeof x === 'string')
        } catch { /* pas du JSON valide, on ignore */ }
    }
    return best
}

function genericPages($: CheerioAPI, html: string, url: string): string[] {
    const groups = new Map<unknown, string[]>()
    $('img').each((_, el) => {
        if (inNav($, el)) return
        const src = absoluteUrl(pickImageSrc(el.attribs), url)
        if (!src || /(logo|icon|avatar|banner|sprite|loading|spinner|emoji|\.svg)/i.test(src)) return
        const container = $(el).closest('div, section, article, main').get(0)
        if (!container) return
        const list = groups.get(container) ?? []
        if (!list.includes(src)) list.push(src)
        groups.set(container, list)
    })
    let best: string[] = []
    for (const list of groups.values()) if (list.length > best.length) best = list
    const fromJs = imagesFromScripts(html)
    return fromJs.length > best.length ? fromJs : best
}

function sortNewestFirst(chs: ChapterItem[]): ChapterItem[] {
    const first = chs[0]
    const last = chs[chs.length - 1]
    if (first && last && first.num >= 0 && last.num >= 0 && first.num < last.num) return [...chs].reverse()
    return chs
}

// --- Moteur universel -----------------------------------------------------------

export const GenericEngine: Engine = {
    name: 'generic',
    detect: () => true,
    discoveryPages: base => [`${base}/`, `${base}/genres`, `${base}/genre`, `${base}/tags`, `${base}/manga`, `${base}/search`],
    parseTags: ($, _pageUrl, base, onDetails) => genericTagLinks($, base, onDetails),
    listingUrl: (tag, page) => pagedUrl(tag.url, page),
    combinedUrl: () => null,
    searchUrl: (base, title, page) => pagedUrl(`${base}/?s=${encodeURIComponent(title)}`, page),
    parseListing: genericListing,
    parseDetails: genericDetails,
    getChapters: async (_f, mangaUrl, $, base) => sortNewestFirst(genericChapters($, mangaUrl, base)),
    chapterPageUrl: u => u,
    parsePages: genericPages
}

// --- Madara (WordPress "WP-Manga") ------------------------------------------------

function madaraSlug(url: string): string | undefined {
    return /\/manga-genre\/([^/?#]+)/i.exec(url)?.[1]
}

export const MadaraEngine: Engine = {
    name: 'madara',
    detect: html => /wp-manga|madara|\/manga-genre\//i.test(html),
    discoveryPages: base => [`${base}/?s=&post_type=wp-manga`, `${base}/`],
    parseTags: ($, pageUrl, base, onDetails) => {
        const tags: SiteTag[] = []
        if (onDetails) {
            $('.genres-content a, .tags-content a, .wp-manga-tags-list a').each((_, el) => {
                const url = absoluteUrl($(el).attr('href'), pageUrl)
                const label = clean($(el).text())
                if (!url || !label) return
                const slug = madaraSlug(url)
                tags.push({ label, url, ...(slug ? { filter: slug } : {}) })
            })
            return tags.length ? tags : genericTagLinks($, base, true)
        }
        // Formulaire de recherche avancée : cases à cocher genre[]
        $('input[name="genre[]"]').each((_, el) => {
            const slug = clean($(el).attr('value'))
            const id = $(el).attr('id')
            const label = clean((id ? $(`label[for="${id}"]`).text() : '') || $(el).parent().text())
            if (slug && label) tags.push({ label, url: `${base}/manga-genre/${slug}/`, filter: slug })
        })
        for (const t of genericTagLinks($, base, false)) {
            const slug = madaraSlug(t.url)
            tags.push(slug ? { ...t, filter: slug } : t)
        }
        return tags
    },
    listingUrl: (tag, page) => pagedUrl(tag.url, page),
    combinedUrl: (base, tags, page) => {
        if (tags.length < 2 || tags.some(t => !t.filter)) return null
        const q = tags.map(t => `genre%5B%5D=${encodeURIComponent(t.filter as string)}`).join('&')
        // op=1 : le manga doit avoir TOUS les genres
        return `${base}${page > 1 ? `/page/${page}/` : '/'}?s=&post_type=wp-manga&${q}&op=1`
    },
    searchUrl: (base, title, page) => `${base}${page > 1 ? `/page/${page}/` : '/'}?s=${encodeURIComponent(title)}&post_type=wp-manga`,
    parseListing: ($, pageUrl, base) => {
        const items: ListingItem[] = []
        $('.page-item-detail, .c-tabs-item__content, .manga__item, .manga-item').each((_, el) => {
            const card = $(el)
            const a = card.find('.post-title a, .item-summary a, h3 a, h4 a, .manga-title a').first()
            const link = a.length ? a : card.find('a[href]').first()
            const url = absoluteUrl(link.attr('href'), pageUrl)
            const title = clean(a.text()) || clean(link.attr('title')) || clean(card.find('img').attr('alt'))
            if (url && title && !items.some(i => i.url === url)) items.push({ url, title, image: imgOf(card, pageUrl) })
        })
        return items.length ? items : genericListing($, pageUrl, base)
    },
    parseDetails: ($, url, base) => {
        const h = $('.post-title h1, .post-title h3, .post-title').first()
        const badges = clean(h.find('.manga-title-badges').text())
        let title = clean(h.text())
        if (badges && title.startsWith(badges)) title = title.slice(badges.length).trim()
        const info = (re: RegExp): string => {
            let v = ''
            $('.post-content_item, .summary_content .post-content_item').each((_, el) => {
                if (!v && re.test(clean($(el).find('.summary-heading').text()))) v = clean($(el).find('.summary-content').text())
            })
            return v
        }
        const d = genericDetails($, url, base)
        return {
            title: title || d.title,
            image: imgOf($('.summary_image'), url) || d.image,
            desc: clean($('.summary__content, .description-summary .summary__content, .manga-excerpt').first().text()) || d.desc,
            author: clean($('.author-content a').map((_, el) => $(el).text()).get().join(', ')) || info(/auth|auteur|autor/i),
            artist: clean($('.artist-content a').map((_, el) => $(el).text()).get().join(', ')) || info(/artist|artiste/i),
            status: info(/status|statut|estado/i) || 'Unknown',
            altTitles: info(/altern|other name|autres? noms?/i).split(/[,;/]/).map(clean).filter(Boolean),
            tags: MadaraEngine.parseTags($, url, base, true)
        }
    },
    getChapters: async (f, mangaUrl, $, base) => {
        const parse = (c: CheerioAPI): ChapterItem[] => {
            const out: ChapterItem[] = []
            c('li.wp-manga-chapter').each((_, el) => {
                const a = c(el).find('a').first()
                const url = absoluteUrl(a.attr('href'), mangaUrl)
                if (!url) return
                const name = clean(a.text())
                const dateEl = c(el).find('.chapter-release-date')
                const dateText = clean(dateEl.find('a').attr('title')) || clean(dateEl.text())
                out.push({ url, name, num: parseChapterNumber(name, url), date: parseDate(dateText) })
            })
            return out
        }
        let chs = parse($)
        if (chs.length === 0) {
            // Madara récent : les chapitres arrivent par une requête à part
            const ajaxUrl = mangaUrl.replace(/\/?$/, '/') + 'ajax/chapters/'
            try { chs = parse(f.load(await f.post(ajaxUrl, '', { 'X-Requested-With': 'XMLHttpRequest', 'Referer': mangaUrl }))) } catch { chs = [] }
        }
        if (chs.length === 0) {
            // Ancien Madara : admin-ajax.php avec l'ID WordPress du manga
            const postId = $('#manga-chapters-holder').attr('data-id') ?? $('.rating-post-id').attr('value')
                ?? $('[data-post]').first().attr('data-post') ?? /[?&]p=(\d+)/.exec($('link[rel="shortlink"]').attr('href') ?? '')?.[1]
            if (postId) {
                try {
                    const html = await f.post(`${base}/wp-admin/admin-ajax.php`, `action=manga_get_chapters&manga=${postId}`,
                        { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', 'Referer': mangaUrl })
                    chs = parse(f.load(html))
                } catch { chs = [] }
            }
        }
        return sortNewestFirst(chs.length ? chs : genericChapters($, mangaUrl, base))
    },
    chapterPageUrl: u => u.includes('?') ? u : u.replace(/\/?$/, '/') + '?style=list',
    parsePages: ($, html, url) => {
        const pages: string[] = []
        $('.reading-content img, .page-break img').each((_, el) => {
            const src = absoluteUrl(pickImageSrc(el.attribs), url)
            if (src && !pages.includes(src)) pages.push(src)
        })
        return pages.length ? pages : genericPages($, html, url)
    }
}

// --- MangaThemesia (WordPress "MangaReader / MangaStream") --------------------------

export const ThemesiaEngine: Engine = {
    name: 'themesia',
    detect: html => /ts_reader|bixbox|class="bsx"|themes\/mangareader|mangastream|themesia/i.test(html),
    discoveryPages: base => [`${base}/manga/`, `${base}/`],
    parseTags: ($, pageUrl, base, onDetails) => {
        if (onDetails) {
            const tags: SiteTag[] = []
            $('.mgen a, .seriestugenre a, .genxed a').each((_, el) => {
                const url = absoluteUrl($(el).attr('href'), pageUrl)
                const label = clean($(el).text())
                if (url && label) tags.push({ label, url })
            })
            return tags.length ? tags : genericTagLinks($, base, true)
        }
        // Filtre de la page /manga/ : genre[] = identifiant numérique
        const tags: SiteTag[] = []
        $('input[name="genre[]"]').each((_, el) => {
            const value = clean($(el).attr('value'))
            const id = $(el).attr('id')
            const label = clean((id ? $(`label[for="${id}"]`).text() : '') || $(el).parent().text())
            if (value && label) tags.push({ label, url: `${base}/manga/?genre%5B%5D=${encodeURIComponent(value)}&order=update`, filter: value })
        })
        return [...genericTagLinks($, base, false), ...tags]
    },
    listingUrl: (tag, page) => pagedUrl(tag.url, page),
    // Le filtre multi-genres de ce thème n'est pas fiable partout : on vérifie fiche par fiche
    combinedUrl: () => null,
    searchUrl: (base, title, page) => `${base}${page > 1 ? `/page/${page}/` : '/'}?s=${encodeURIComponent(title)}`,
    parseListing: ($, pageUrl, base) => {
        const items: ListingItem[] = []
        $('.bsx > a, .bs .bsx a, .listupd .bs a, .utao .uta .imgu a').each((_, el) => {
            const a = $(el)
            const url = absoluteUrl(a.attr('href'), pageUrl)
            const title = clean(a.attr('title')) || clean(a.find('.tt').text()) || clean(a.find('img').attr('alt'))
            if (url && title && !items.some(i => i.url === url)) items.push({ url, title, image: imgOf(a, pageUrl) })
        })
        return items.length ? items : genericListing($, pageUrl, base)
    },
    parseDetails: ($, url, base) => {
        const field = (re: RegExp): string => {
            let v = ''
            $('.imptdt, .tsinfo .imptdt, .fmed, .infotable tr').each((_, el) => {
                if (v) return
                const t = clean($(el).text())
                if (re.test(t)) v = clean($(el).find('i, span, a, td:last-child').last().text()) || t.replace(re, '').trim()
            })
            return v
        }
        const d = genericDetails($, url, base)
        return {
            title: clean($('h1.entry-title').first().text()) || d.title,
            image: imgOf($('.thumb, .infomanga .thumb, .bigcontent .thumb').first(), url) || d.image,
            desc: clean($('.entry-content[itemprop="description"], .synp .entry-content, [itemprop="description"]').first().text()) || d.desc,
            author: field(/author|auteur|autor/i),
            artist: field(/artist|artiste/i),
            status: field(/status|statut|estado/i) || 'Unknown',
            altTitles: clean($('.alternative, .seriestualt').first().text()).split(/[,;/]/).map(clean).filter(Boolean),
            tags: ThemesiaEngine.parseTags($, url, base, true)
        }
    },
    getChapters: async (_f, mangaUrl, $, base) => {
        const out: ChapterItem[] = []
        $('#chapterlist li, .eplister li, .clstyle li').each((_, el) => {
            const a = $(el).find('a').first()
            const url = absoluteUrl(a.attr('href'), mangaUrl)
            if (!url) return
            const name = clean($(el).find('.chapternum').text()) || clean(a.text())
            const dataNum = Number($(el).attr('data-num'))
            out.push({
                url, name,
                num: isNaN(dataNum) || $(el).attr('data-num') === undefined ? parseChapterNumber(name, url) : dataNum,
                date: parseDate(clean($(el).find('.chapterdate').text()))
            })
        })
        return sortNewestFirst(out.length ? out : genericChapters($, mangaUrl, base))
    },
    chapterPageUrl: u => u,
    parsePages: ($, html, url) => {
        const m = /ts_reader\.run\((\{[\s\S]*?\})\);/.exec(html)
        if (m?.[1]) {
            try {
                const data = JSON.parse(m[1]) as { sources?: { images?: string[] }[] }
                const imgs = data.sources?.[0]?.images ?? []
                if (imgs.length) return imgs
            } catch { /* on passe au plan B */ }
        }
        const pages: string[] = []
        $('#readerarea img').each((_, el) => {
            const src = absoluteUrl(pickImageSrc(el.attribs), url)
            if (src && !pages.includes(src)) pages.push(src)
        })
        return pages.length ? pages : genericPages($, html, url)
    }
}

export const ENGINES: Engine[] = [MadaraEngine, ThemesiaEngine, GenericEngine]

export function engineByName(name: EngineName | undefined): Engine {
    return ENGINES.find(e => e.name === name) ?? GenericEngine
}

export function detectEngine(html: string): Engine {
    // Madara d'abord : ses marqueurs sont les plus spécifiques
    return ENGINES.find(e => e.detect(html)) ?? GenericEngine
}
