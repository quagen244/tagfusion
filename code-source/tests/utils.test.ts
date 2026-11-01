// Tests des fonctions pures : npx tsx tests/utils.test.ts
import assert from 'node:assert/strict'
import {
    absoluteUrl, decodeMangaId, encodeMangaId, interleave, looksLikeChapterUrl, looksLikeMangaUrl,
    looksLikeTagUrl, normalizeBaseUrl, pagedUrl, parseChapterNumber, parseCustomMerges, parseDate,
    parseSiteList, pickImageSrc, tagKey, titleKey, encodeChapterId, decodeChapterId, tagIdOf,
    keyOfTagId, siteTagIdOf, siteOfTagId, safeDate, safeNumber
} from '../src/TagFusion/Utils'

let passed = 0
function test(name: string, fn: () => void): void {
    fn()
    passed++
    console.log(`✓ ${name}`)
}

test('URLs de sites', () => {
    assert.equal(normalizeBaseUrl('Site-Un.com/'), 'https://site-un.com')
    assert.equal(normalizeBaseUrl('http://www.exemple.net/manga/x'), 'http://www.exemple.net')
    assert.equal(normalizeBaseUrl('pas une url'), null)
    assert.deepEqual(parseSiteList('a.com, b.net\nhttps://a.com ; c.org'), ['https://a.com', 'https://b.net', 'https://c.org'])
})

test('URLs absolues', () => {
    assert.equal(absoluteUrl('/manga/x/', 'https://s.com/a/b'), 'https://s.com/manga/x/')
    assert.equal(absoluteUrl('//cdn.s.com/i.jpg', 'https://s.com'), 'https://cdn.s.com/i.jpg')
    assert.equal(absoluteUrl('c.html', 'https://s.com/a/b'), 'https://s.com/a/c.html')
    assert.equal(absoluteUrl('javascript:void(0)', 'https://s.com'), null)
})

test('IDs aller-retour (sans caractères spéciaux)', () => {
    const id = encodeMangaId('s.com', 'https://www.s.com/manga/one-piece/?x=1&é=2')
    assert.match(id, /^[A-Za-z0-9._-]+$/)
    assert.deepEqual(decodeMangaId(id), { siteId: 's.com', path: '/manga/one-piece/?x=1&é=2' })
    const ch = encodeChapterId('https://s.com/manga/a_b/chapter-1/')
    assert.match(ch, /^[A-Za-z0-9._-]+$/)
    assert.equal(decodeChapterId(ch), '/manga/a_b/chapter-1/')
    assert.equal(keyOfTagId(tagIdOf('sci fi')), 'sci fi')
    assert.match(tagIdOf('slice of life'), /^[A-Za-z0-9_-]+$/)
    assert.equal(siteOfTagId(siteTagIdOf('mon-site.com')), 'mon-site.com')
    assert.equal(keyOfTagId(siteTagIdOf('x.com')), null)
    assert.ok(!isNaN(safeDate(new Date('pas une date')).getTime()))
    assert.equal(safeNumber(NaN), 0)
})

test('Fusion des tags', () => {
    assert.equal(tagKey('Romance'), 'romance')
    assert.equal(tagKey('Romantic'), 'romance')
    assert.equal(tagKey('Sci-Fi'), 'sci fi')
    assert.equal(tagKey('Science Fiction'), 'sci fi')
    assert.equal(tagKey('Comédie'), 'comedy')
    assert.equal(tagKey('Slice of Life'), tagKey('Tranche de vie'))
    assert.equal(tagKey('School Life'), tagKey('School'))
    assert.equal(tagKey('Next'), null)
    assert.equal(tagKey('2023'), null)
    const merges = parseCustomMerges('love = romance; Gore=Horror')
    assert.equal(tagKey('Love', merges), 'romance')
    assert.equal(tagKey('GORE', merges), 'horror')
})

test('Reconnaissance des liens', () => {
    assert.ok(looksLikeTagUrl('https://s.com/manga-genre/romance/'))
    assert.ok(looksLikeTagUrl('https://s.com/genres/action'))
    assert.ok(looksLikeTagUrl('https://s.com/search?genre=romance'))
    assert.ok(!looksLikeTagUrl('https://s.com/manga/solo-leveling/'))
    assert.ok(looksLikeMangaUrl('https://s.com/manga/solo-leveling/'))
    assert.ok(!looksLikeMangaUrl('https://s.com/manga/solo-leveling/chapter-12/'))
    assert.ok(looksLikeChapterUrl('https://s.com/manga/solo-leveling/chapter-12/'))
    assert.ok(looksLikeChapterUrl('https://s.com/solo-leveling-chapitre-3/'))
})

test('Pagination', () => {
    assert.equal(pagedUrl('https://s.com/manga-genre/romance/', 1), 'https://s.com/manga-genre/romance/')
    assert.equal(pagedUrl('https://s.com/manga-genre/romance/', 3), 'https://s.com/manga-genre/romance/page/3/')
    assert.equal(pagedUrl('https://s.com/genres/action', 2), 'https://s.com/genres/action/page/2/')
    assert.equal(pagedUrl('https://s.com/manga/?genre%5B%5D=4&order=update', 2), 'https://s.com/manga/?genre%5B%5D=4&order=update&page=2')
    assert.equal(pagedUrl('https://s.com/list?page=2', 5), 'https://s.com/list?page=5')
})

test('Numéros de chapitre', () => {
    assert.equal(parseChapterNumber('Chapter 12'), 12)
    assert.equal(parseChapterNumber('Chapitre 10.5 - Le retour'), 10.5)
    assert.equal(parseChapterNumber('Ch. 7'), 7)
    assert.equal(parseChapterNumber('', 'https://s.com/manga/x/chapter-42/'), 42)
    assert.equal(parseChapterNumber('Épisode spécial'), -1)
})

test('Dates', () => {
    const now = Date.UTC(2026, 10, 1, 12)
    assert.equal(parseDate('3 days ago', now).getTime(), now - 3 * 864e5)
    assert.equal(parseDate('il y a 2 heures', now).getTime(), now - 2 * 36e5)
    assert.equal(parseDate('an hour ago', now).getTime(), now - 36e5)
    assert.equal(parseDate('03/10/2024', now).getFullYear(), 2024)
    assert.equal(parseDate('October 3, 2024', now).getMonth(), 9)
    assert.equal(parseDate('n\'importe quoi', now).getTime(), now)
})

test('Images paresseuses', () => {
    assert.equal(pickImageSrc({ src: 'data:image/gif;base64,xx', 'data-src': ' https://c/i.jpg ' }), 'https://c/i.jpg')
    assert.equal(pickImageSrc({ srcset: 'https://c/a.jpg 1x, https://c/b.jpg 2x' }), 'https://c/b.jpg')
})

test('Doublons et alternance', () => {
    assert.equal(titleKey('The Beginning After The End'), titleKey('Beginning after the End'))
    assert.deepEqual(interleave([[1, 2, 3], ['a'], [10, 20]]), [1, 'a', 10, 2, 20, 3])
})

console.log(`\n${passed} groupes de tests réussis`)

// --- Registre de tags (avec un faux stockage) ---------------------------------
import { Store } from '../src/TagFusion/Store'

async function storeTests(): Promise<void> {
    const mem = new Map<string, unknown>()
    const fakeState = {
        keychain: {} as never,
        store: async (k: string, v: unknown) => { mem.set(k, JSON.parse(JSON.stringify(v))) },
        retrieve: async (k: string) => mem.get(k)
    }
    const store = new Store(fakeState)
    await store.setSites(['https://a.com', 'https://b.net'])
    assert.equal(await store.addTags('a.com', [
        { label: 'Romance', url: 'https://a.com/manga-genre/romance/', filter: 'romance' },
        { label: 'Sci-Fi', url: 'https://a.com/manga-genre/sci-fi/' },
        { label: 'Next', url: 'https://a.com/page/2/' }
    ]), 2)
    assert.equal(await store.addTags('b.net', [
        { label: 'Romantic', url: 'https://b.net/genres/romantic/' },
        { label: 'Science Fiction', url: 'https://b.net/genres/science-fiction/' },
        { label: 'Love', url: 'https://b.net/genres/love/' }
    ]), 3)
    let u = await store.unified()
    assert.deepEqual(Object.keys(u.romance?.sites ?? {}).sort(), ['a.com', 'b.net'])
    assert.equal(u['sci fi']?.sites['b.net']?.url, 'https://b.net/genres/science-fiction/')
    assert.ok(u.love)
    // Fusion personnalisée : "love" rejoint "romance"
    await store.setMergesText('love=romance')
    u = await store.unified()
    assert.equal(u.love, undefined)
    assert.ok(u.romance?.sites['b.net'])
    // Un tag déjà connu ne compte pas deux fois, mais son filtre est complété
    assert.equal(await store.addTags('a.com', [{ label: 'Sci-Fi', url: 'x', filter: 'sci-fi' }]), 0)
    assert.equal((await store.unified())['sci fi']?.sites['a.com']?.filter, 'sci-fi')
    // Retirer un site efface ses tags
    await store.setSites(['https://a.com'])
    assert.equal((await store.unified()).romance?.sites['b.net'], undefined)
    // Tout survit à un redémarrage (nouvelle instance, même stockage)
    const again = new Store(fakeState)
    assert.equal(await again.tagCount('a.com'), 2)
    console.log('✓ Registre de tags')
}
storeTests().catch(e => { console.error(e); process.exit(1) })

// --- URLs d'images sûres --------------------------------------------------------
import { safeUrl, FALLBACK_IMAGE } from '../src/TagFusion/Utils'
assert.equal(safeUrl(''), FALLBACK_IMAGE)
assert.equal(safeUrl(undefined), FALLBACK_IMAGE)
assert.equal(safeUrl('/relative.jpg'), FALLBACK_IMAGE)
assert.equal(safeUrl('//cdn.s.com/a.jpg'), 'https://cdn.s.com/a.jpg')
assert.equal(safeUrl('https://s.com/my cover é.jpg'), 'https://s.com/my%20cover%20%C3%A9.jpg')
assert.equal(safeUrl('https://s.com/a%20b.jpg'), 'https://s.com/a%20b.jpg')
assert.equal(safeUrl('https://s.com/100%.jpg'), 'https://s.com/100%25.jpg')
assert.equal(safeUrl('https://s.com/a|b.jpg'), 'https://s.com/a%7Cb.jpg')
console.log('✓ URLs d\'images sûres')

// --- Import depuis les dépôts d'extensions -----------------------------------------
import { parseRepoList, repoVersioningUrl, sitesFromVersioning } from '../src/TagFusion/Utils'
assert.equal(repoVersioningUrl('https://x.github.io/repo/0.8/'), 'https://x.github.io/repo/0.8/versioning.json')
assert.equal(repoVersioningUrl('x.github.io/repo/versioning.json'), 'https://x.github.io/repo/versioning.json')
assert.equal(repoVersioningUrl('rien'), null)
assert.deepEqual(parseRepoList('a.github.io/r, https://b.netlify.app/0.8/ a.github.io/r/'), [
    'https://a.github.io/r/versioning.json', 'https://b.netlify.app/0.8/versioning.json'])
assert.deepEqual(sitesFromVersioning({ sources: [
    { id: 'A', websiteBaseURL: 'https://www.site-un.com/' },
    { id: 'B', websiteBaseURL: 'https://site-deux.net/manga' },
    { id: 'C', websiteBaseURL: 'https://paperback.moe' },
    { id: 'D', websiteBaseURL: 'https://quelquun.github.io/x' },
    { id: 'E' },
    { id: 'F', websiteBaseURL: 'https://www.site-un.com' }
] }), ['https://www.site-un.com', 'https://site-deux.net'])
assert.deepEqual(sitesFromVersioning('pas du json'), [])
console.log('✓ Import des dépôts')
