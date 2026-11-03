// Reproduction fidèle d'EAHentai (relevé sur le vrai site le 2026-11-03, galerie /a/77148) :
//  - fiche : 24 miniatures « /a/ID/N » (N depuis 0), « 74 pages • 24 showing », bouton « +50 more pages » sans lien ;
//  - la liste COMPLÈTE des pages n'est que dans les données Next.js (self.__next_f.push) : "albumId":ID,"images":[{"imageUri":"galleries/HASH/image1.webp",...}]
//    (formats mélangés : webp, png, jpg ; noms variés : image1.webp, 001.jpg) ;
//  - page de lecture « /a/ID/N » : seulement une fenêtre de ~5 images (N-2 … N+2) dans un carrousel, + la même liste complète en données.
export const EAH = 'https://eahentai.com'
const CDN = 'https://i.eahentai.com/file/ea-gallery/'
const SVG = '<svg stroke="currentColor" fill="currentColor" viewBox="0 0 448 512" height="1em" width="1em" xmlns="http://www.w3.org/2000/svg"><path d="M0 180V56c0-13.3"></path></svg>'

export interface EahAlbum { id: number, hash: string, title: string, files: string[], tags: string[] }

export function album(id: number, hash: string, title: string, count: number, name: (n: number) => string, tags: string[]): EahAlbum {
    return { id, hash, title, files: Array.from({ length: count }, (_, i) => name(i + 1)), tags }
}

const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

/** Données Next.js telles que le site les écrit dans la page (chaîne JS entre guillemets, JSON échappé) */
function flight(a: EahAlbum, related: EahAlbum[]): string {
    const images = a.files.map((f, i) => ({ imageID: 3042457 + i, addDt: '2026-10-31T13:17:43.407', imageUri: `galleries/${a.hash}/${f}`, thumbnailUri: `galleries/${a.hash}/thumbnail/image${i + 1}t.jpg`, title: f.replace(/\.\w+$/, ''), author: 'someone', albumID: a.id, views: 0, sort: (i + 1) * 100, album: null }))
    const part1 = `2c:["$","div",null,{"className":"container mx-auto px-[5px] pb-8","children":[["$","$L8",null,{}],["$","div",null,{"className":"mt-8","children":["$","$L34",null,${JSON.stringify({ albumId: a.id, images })}]}],"$L35","$L36"]}]\n`
    const part2 = `59:["$","$L5a",null,${JSON.stringify({ seedAlbumIds: [a.id], initialAlbums: related.map(r => ({ albumID: r.id, addDt: '2026-11-01T11:57:41.703', thumbnailUri: `galleries/${r.hash}/thumbnail/image1t.jpg`, imageUri: `galleries/${r.hash}/${r.files[0]}`, title: r.title, pageCount: r.files.length, images: [], comments: [] })), source: 'related' })}]\n`
    return `<script type="55a0cfc68c96a19a4fe47e3c-text/javascript">self.__next_f.push([1,"${esc(part1)}"])</script>
<script type="55a0cfc68c96a19a4fe47e3c-text/javascript">self.__next_f.push([1,"${esc(part2)}"])</script>`
}

const head = (title: string): string => `<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/><title>${title}</title><meta property="og:image" content="${CDN}galleries/x/thumbnail/image1t.jpg"/></head>`
const header = `<header class="sticky top-0 z-50"><div class="flex items-center"><a href="/"><img alt="EAHentai Logo" src="/logo.svg"/></a>
<form role="search"><input type="text" placeholder="Search all..." value=""/></form>
<nav class="hidden md:flex"><a href="/latest"><span>Latest</span></a><a href="/bookmarks"><span>Bookmarks</span></a><a href="/artists"><span>Artists</span></a><a href="/tags"><span>Tags</span></a></nav>
<div><a href="/login">Sign in</a><a href="/register">Register</a></div></div></header>`
const footer = `<footer><ul><li><a href="/">Home</a></li><li><a href="/latest">Latest</a></li><li><a href="/about">DMCA</a></li></ul></footer>`

export function galleryPage(a: EahAlbum, related: EahAlbum[] = []): string {
    const shown = Math.min(24, a.files.length)
    const thumbs = Array.from({ length: shown }, (_, i) => `<a class="group relative aspect-[200/280] overflow-hidden rounded-xl bg-[#1c1c1e] border border-[#27272a]" href="/a/${a.id}/${i}"><img alt="Page ${i + 1}" loading="lazy" decoding="async" data-nimg="fill" class="w-full h-full object-cover" src="${CDN}galleries/${a.hash}/thumbnail/image${i + 1}t.jpg"/><div class="absolute inset-0"><div class="absolute bottom-2 left-2"><span class="text-white text-xs">${i + 1}</span></div><div>${SVG}</div></div></a>`).join('')
    const more = a.files.length > shown ? `<div class="flex justify-center pt-4"><button class="group flex items-center gap-3 px-8 py-4"><span class="text-[#ffde65]">+<!-- -->${a.files.length - shown}</span><span>more pages</span><div class="w-2 h-2 rounded-full"></div></button></div>` : ''
    return `${head(`${a.title} - EAHentai`)}<body><div>${header}</div><main><div><div><div><a href="/search?p=1&amp;type=albumType&amp;q=Doujinshi"><span data-slot="badge">Doujinshi</span></a></div>
<div><a aria-label="${a.title} — Start Reading" href="/a/${a.id}/0"><div><img alt="${a.title}" fetchPriority="high" src="${CDN}galleries/${a.hash}/thumbnail/image1t.jpg"/><div>${SVG}Start Reading</div></div></a>
<div><div>${SVG}<span>Views</span><p>8,930</p></div><div>${SVG}<span>Pages</span><p>${a.files.length}</p></div></div></div>
<div><h1 class="text-2xl font-bold">${a.title}</h1><div>${SVG}<span>Uploaded <!-- -->October 31, 2026</span></div>
<div><a href="/a/${a.id}/0">${SVG}Read Now</a><button type="button">${SVG}Bookmark</button><button title="Click to copy album link"><span>#<!-- -->${a.id}</span></button></div>
<div><h2>${SVG}Information</h2><div><div><span>Parody</span><div><a href="/parody/original"><span data-slot="badge">original</span></a></div></div>
<div><span>Artist</span><div><a href="/artist/someone"><span data-slot="badge">someone</span></a></div></div>
<div><span>Tags</span><div>${a.tags.map(t => `<a href="/search?p=1&amp;q=${encodeURIComponent(t)}"><span data-slot="badge">${t}</span></a>`).join('')}</div></div></div></div></div></div>
<div><div class="space-y-6"><div class="flex items-center justify-between"><div class="flex items-center gap-3"><div class="w-10 h-10 rounded-xl">${SVG}</div><div><h2 class="text-xl font-bold text-white">Preview</h2><p class="text-[#71717a] text-sm">${a.files.length}<!-- --> pages • <!-- -->${shown}<!-- --> showing</p></div></div><a class="flex items-center gap-2 px-4 py-2" href="/a/${a.id}/0">${SVG}View All</a></div>
<div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">${thumbs}</div>${more}</div></div>
<div><div><h3>Comments</h3><p>Sign in to post.</p><select><option value="10">10</option><option value="20" selected="">20</option></select></div><div>No comments yet. Be the first to post.</div><div><button disabled="">Prev</button><span>Page <!-- -->1</span><button disabled="">Next</button></div></div>
</div></main>${footer}${flight(a, related)}</body></html>`
}

export function readerPage(a: EahAlbum, n: number): string {
    const from = Math.max(0, n - 2), to = Math.min(a.files.length - 1, n + 2)
    const slides = a.files.map((f, i) => i >= from && i <= to
        ? `<div class="embla__slide relative flex items-start justify-center h-full w-full" style="cursor:pointer"><div class="flex items-start justify-center w-full h-auto min-h-full"><img src="${CDN}galleries/${a.hash}/${f}" decoding="async" fetchPriority="${i === n ? 'high' : 'low'}" alt="${f.replace(/\.\w+$/, '')}" class="w-full h-auto object-contain pointer-events-none select-none" draggable="false"/></div></div>`
        : `<div class="embla__slide relative flex items-start justify-center h-full w-full"><div class="flex items-center justify-center"><span>Loading page ${i + 1} …</span></div></div>`).join('')
    return `${head(`${a.title} - Page ${n + 1} - EAHentai`)}<body><div>${header}</div><main><div class="embla h-screen"><div class="embla__viewport"><div class="embla__container flex">${slides}</div></div><div class="fixed bottom-0"><span>${n + 1} / ${a.files.length}</span></div></div></main>${footer}${flight(a, [])}</body></html>`
}

export const fullUrl = (a: EahAlbum, i: number): string => `${CDN}galleries/${a.hash}/${a.files[i]}`
