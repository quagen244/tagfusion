import { CheerioAPI, Cheerio, Element } from 'cheerio'
import { EngineName, SiteTag } from './Store'
import { sortNewestFirst, universalChapters, universalPages } from './Chapters'
import {
    absoluteUrl, cleanTagLabel, hostOf, looksLikeChapterUrl, looksLikeMangaUrl, looksLikeTagUrl, normalizeTagText,
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

export interface ChapterItem { url: string, name: string, num: number, date: Date, volume?: number }

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
    /** Pages possibles du catalogue complet du site (tous les mangas), dans l'ordre d'essai */
    catalogPages(base: string): string[]
    parseTags($: CheerioAPI, pageUrl: string, base: string, onDetailsPage: boolean): SiteTag[]
    listingUrl(tag: SiteTag, page: number): string
    /** URL d'une recherche "tous ces tags à la fois", si le site sait le faire */
    combinedUrl(base: string, tags: SiteTag[], page: number): string | null
    searchUrl(base: string, title: string, page: number): string
    parseListing($: CheerioAPI, pageUrl: string, base: string): ListingItem[]
    parseDetails($: CheerioAPI, url: string, base: string): Details
    getChapters(f: Fetcher, mangaUrl: string, $: CheerioAPI, base: string, log?: (line: string) => void): Promise<ChapterItem[]>
    chapterPageUrl(chapterUrl: string): string
    parsePages($: CheerioAPI, html: string, url: string): string[]
}

// --- Outils communs ------------------------------------------------------------

/** Liens qui ne sont pas des genres : artistes, groupes, personnages, parodies, langues… */
const NON_GENRE_PATH = /\/(artists?|authors?|auteurs?|groups?|circles?|parod(?:y|ies)|characters?|personnages?|languages?|langues?|uploaders?|users?|members?|scanlators?|translators?|traducteurs?|teams?|magazines?|publishers?|studios?)\//i
const NON_GENRE_QUERY = /[?&](?:q|s|query|search|tag)=(?:artist|author|group|circle|parody|character|language|uploader)(?::|%3a)/i
const NON_GENRE_LABEL = /^(artist|author|group|circle|parody|character|language|uploader)s?\s*:/i

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
        // Artistes, groupes, personnages, parodies, langues : pas des tags de genre
        if (NON_GENRE_PATH.test(url) || NON_GENRE_QUERY.test(url)) return
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

/** Une classe ou un id qui désigne une zone de tags : "tags", "genres-content", "manga-tag-list", "categories"... */
const TAG_TOKEN = /(^|[-_])(tags?|taglist|genres?|genre-list|categor(?:y|ies)|keywords?|themes?)($|[-_])/i
const TAG_TOKEN_EXCLUDE = /(tagline|stage|vintage|heritage|advantage|nav|menu|widget|footer|header|sidebar|search|filter|form|select|cloud)/i

function isTagZone(el: Element): boolean {
    if (el.attribs['itemprop'] === 'genre') return true
    const tokens = `${el.attribs['class'] ?? ''} ${el.attribs['id'] ?? ''}`.split(/\s+/).filter(Boolean)
    return tokens.some(t => TAG_TOKEN.test(t) && !TAG_TOKEN_EXCLUDE.test(t))
}

/**
 * Tous les tags visibles sur une fiche, qu'ils soient des liens ou de simples étiquettes.
 * Un tag sans page dédiée sur le site reçoit url = '' : il ne sert qu'à l'index des mangas.
 */
function zoneTags($: CheerioAPI, pageUrl: string, base: string): SiteTag[] {
    const out: SiteTag[] = []
    const seen = new Set<string>()
    const push = (rawLabel: string, href?: string): void => {
        const label = clean(rawLabel).replace(/^#/, '').replace(/\s*[([]?\d[\d,.\s]*[)\]]?\s*$/, '').replace(/[,;|•·]+$/, '').trim()
        if (!label || label.length > 40 || /:$/.test(label)) return
        if (NON_GENRE_LABEL.test(label)) return
        // Un lien vers un artiste, un groupe, un personnage… n'est pas un tag de genre
        const target = href ? absoluteUrl(href, pageUrl) : null
        if (target && sameHost(target, base) && (NON_GENRE_PATH.test(target) || NON_GENRE_QUERY.test(target))) return
        const norm = normalizeTagText(label)
        if (!norm || seen.has(norm)) return
        seen.add(norm)
        const url = absoluteUrl(href, pageUrl)
        out.push({ label, url: url && sameHost(url, base) && looksLikeTagUrl(url) ? url.replace(/#.*$/, '') : '' })
    }
    $('[class], [id], a[rel="tag"]').each((_, el) => {
        if (el.name === 'a' && el.attribs['rel'] === 'tag') { push($(el).text(), $(el).attr('href')); return }
        if (!isTagZone(el) || inNav($, el)) return
        const zone = $(el)
        // Une zone de tags est courte : on ignore les grands blocs qui ont juste un nom trompeur
        if (clean(zone.text()).length > 1500) return
        let chips = 0
        // Si la zone est elle-même un tag (lien ou étiquette seule)
        if (zone.find('a, li, span, button').length === 0) {
            const text = clean(zone.text())
            if (el.name === 'a') { push(text, zone.attr('href')); return }
            // "Action, Romance, Drame" en texte brut
            for (const part of text.replace(/^[^:]{1,20}:\s*/, '').split(/\s*[,;|•·/]\s*/)) push(part)
            return
        }
        zone.find('a, li, span, button').each((_, c) => {
            const chip = $(c)
            // On ne garde que les "feuilles" (pas les éléments qui contiennent d'autres étiquettes)
            if (chip.find('a, li, span, button').length > 0) return
            chips++
            // L'adresse du tag : le lien lui-même, ou le lien qui contient l'étiquette (<a><span>nom</span></a>)
            const link = c.name === 'a' ? chip : chip.closest('a[href]')
            push(chip.text(), link.length ? link.attr('href') : undefined)
        })
        if (chips === 0) for (const part of clean(zone.text()).split(/\s*[,;|•·]\s*/)) push(part)
    })
    return out
}

/** Réunit deux listes de tags sans doublon (on garde la version qui a une page et un filtre) */
function mergeTags(a: SiteTag[], b: SiteTag[]): SiteTag[] {
    const byKey = new Map<string, SiteTag>()
    for (const t of [...a, ...b]) {
        // Sans le nombre d'œuvres que certains sites collent au tag : "Romance (1 234)" -> "Romance"
        const label = cleanTagLabel(t.label)
        const k = normalizeTagText(label)
        if (!k) continue
        const prev = byKey.get(k)
        if (!prev) byKey.set(k, { ...t, label })
        else {
            if (!prev.url && t.url) prev.url = t.url
            if (!prev.filter && t.filter) prev.filter = t.filter
        }
    }
    return [...byKey.values()]
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
        tags: mergeTags(genericTagLinks($, base, true), zoneTags($, url, base))
    }
}

// --- Moteur universel -----------------------------------------------------------

export const GenericEngine: Engine = {
    name: 'generic',
    detect: () => true,
    discoveryPages: base => [`${base}/`, `${base}/genres`, `${base}/genre`, `${base}/tags`, `${base}/manga`, `${base}/search`],
    catalogPages: base => [`${base}/manga/`, `${base}/series/`, `${base}/manga-list/`, `${base}/`],
    parseTags: ($, _pageUrl, base, onDetails) => genericTagLinks($, base, onDetails),
    listingUrl: (tag, page) => pagedUrl(tag.url, page),
    combinedUrl: () => null,
    searchUrl: (base, title, page) => pagedUrl(`${base}/?s=${encodeURIComponent(title)}`, page),
    parseListing: genericListing,
    parseDetails: genericDetails,
    getChapters: (f, mangaUrl, $, base, log) => universalChapters(f, mangaUrl, $, base, log),
    chapterPageUrl: u => u,
    parsePages: universalPages
}

// --- Madara (WordPress "WP-Manga") ------------------------------------------------

function madaraSlug(url: string): string | undefined {
    return /\/manga-genre\/([^/?#]+)/i.exec(url)?.[1]
}

export const MadaraEngine: Engine = {
    name: 'madara',
    detect: html => /wp-manga|madara|\/manga-genre\//i.test(html),
    discoveryPages: base => [`${base}/?s=&post_type=wp-manga`, `${base}/`],
    catalogPages: base => [`${base}/manga/`, `${base}/?s=&post_type=wp-manga&m_orderby=latest`, `${base}/`],
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
            tags: mergeTags(MadaraEngine.parseTags($, url, base, true), zoneTags($, url, base))
        }
    },
    getChapters: async (f, mangaUrl, $, base, log) => {
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
        let chs: ChapterItem[] = []
        try { chs = parse($) } catch { chs = [] }
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
        log?.(`madara : ${chs.length}`)
        return chs.length ? sortNewestFirst(chs) : universalChapters(f, mangaUrl, $, base, log)
    },
    chapterPageUrl: u => u.includes('?') ? u : u.replace(/\/?$/, '/') + '?style=list',
    parsePages: ($, html, url) => {
        const pages: string[] = []
        $('.reading-content img, .page-break img').each((_, el) => {
            const src = absoluteUrl(pickImageSrc(el.attribs), url)
            if (src && !pages.includes(src)) pages.push(src)
        })
        return pages.length ? pages : universalPages($, html, url)
    }
}

// --- MangaThemesia (WordPress "MangaReader / MangaStream") --------------------------

export const ThemesiaEngine: Engine = {
    name: 'themesia',
    detect: html => /ts_reader|bixbox|class="bsx"|themes\/mangareader|mangastream|themesia/i.test(html),
    discoveryPages: base => [`${base}/manga/`, `${base}/`],
    catalogPages: base => [`${base}/manga/?order=update`, `${base}/manga/`, `${base}/`],
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
            tags: mergeTags(ThemesiaEngine.parseTags($, url, base, true), zoneTags($, url, base))
        }
    },
    getChapters: async (f, mangaUrl, $, base, log) => {
        const out: ChapterItem[] = []
        try { $('#chapterlist li, .eplister li, .clstyle li').each((_, el) => {
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
        }) } catch { out.length = 0 }
        log?.(`mangareader : ${out.length}`)
        return out.length ? sortNewestFirst(out) : universalChapters(f, mangaUrl, $, base, log)
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
        return pages.length ? pages : universalPages($, html, url)
    }
}

// --- Pagination réelle des listes ------------------------------------------------

/** Chemin "normalisé" d'une page de liste : sans requête ni numéro de page final */
function listPathKey(url: string): string {
    return (/^https?:\/\/[^/]+(\/[^?#]*)?/i.exec(url)?.[1] ?? '/').toLowerCase().replace(/\/(page\/)?\d+\/?$/, '').replace(/\/$/, '')
}

/**
 * Lien vers la page suivante d'une liste, tel que le site l'écrit lui-même
 * (rel="next", bouton "Suivant / › / »", ou lien "N+1" dans la pagination).
 * Évite de deviner le format : "/page/2/", "?page=2", "/2/"… varient selon les sites.
 */
export function findNextPageUrl($: CheerioAPI, pageUrl: string, page: number): string | undefined {
    const cur = pageUrl.replace(/#.*$/, '')
    const host = hostOf(pageUrl)
    const usable = (href: string | undefined): string | undefined => {
        const u = absoluteUrl(href, pageUrl)
        if (!u || hostOf(u) !== host) return undefined
        const clean = u.replace(/#.*$/, '')
        return clean !== cur ? clean : undefined
    }
    for (const sel of ['link[rel="next"]', 'a[rel="next"]']) {
        const u = usable($(sel).first().attr('href'))
        if (u) return u
    }
    const nextNum = String(page + 1)
    let found: string | undefined
    // Lien "N+1" dans une zone de pagination
    $('[class*="pagination"] a[href], [class*="pager"] a[href], [class*="paging"] a[href], [class*="page-numbers"] a[href], [class*="pagenavi"] a[href], [class*="nav-links"] a[href], [class*="pages"] a[href]').each((_, el) => {
        if (!found && clean($(el).text()) === nextNum) found = usable($(el).attr('href'))
    })
    if (found) return found
    // Bouton "suivant"
    $('a[href]').each((_, el) => {
        if (found) return
        const cls = el.attribs['class'] ?? ''
        const text = clean($(el).text()).toLowerCase()
        if (/(^|[\s_-])next([\s_-]|$)|nextpostslink/i.test(cls)
            || /^(?:[‹«<←]\s*)?(next|next page|suivant|suivante|page suivante|siguiente|weiter)(?:\s*[›»>→]+)?$|^[›»>→]{1,2}$/.test(text)) found = usable($(el).attr('href'))
    })
    if (found) return found
    // Lien "N+1" n'importe où, s'il pointe vers la même liste
    const key = listPathKey(cur)
    $('a[href]').each((_, el) => {
        if (found || clean($(el).text()) !== nextNum) return
        const u = usable($(el).attr('href'))
        if (u && listPathKey(u) === key) found = u
    })
    return found
}

/** Formats de page courants, pour les sites sans lien "suivant" lisible */
export function pageCandidates(url: string, n: number): string[] {
    const u = url.replace(/#.*$/, '')
    const q = u.indexOf('?')
    const path = q >= 0 ? u.slice(0, q) : u
    const query = q >= 0 ? u.slice(q) : ''
    const withQuery = /[?&]page=\d+/.test(u) ? u.replace(/([?&]page=)\d+/, `$1${n}`) : `${u}${q >= 0 ? '&' : '?'}page=${n}`
    const slashN = path.replace(/\/(page\/)?\d+\/?$/, '').replace(/\/?$/, `/${n}/`) + query
    // Paramètre "p=1" déjà présent (ex. /search?p=1&q=x) : on le fait avancer
    const withP = /[?&]p=\d+/.test(u) ? [u.replace(/([?&]p=)\d+/, `$1${n}`)] : []
    return [...new Set([...withP, pagedUrl(u, n), withQuery, slashN])]
}

export const ENGINES: Engine[] = [MadaraEngine, ThemesiaEngine, GenericEngine]

export function engineByName(name: EngineName | undefined): Engine {
    return ENGINES.find(e => e.name === name) ?? GenericEngine
}

export function detectEngine(html: string): Engine {
    // Madara d'abord : ses marqueurs sont les plus spécifiques
    return ENGINES.find(e => e.detect(html)) ?? GenericEngine
}
