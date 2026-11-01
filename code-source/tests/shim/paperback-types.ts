// Remplaçant minimal de @paperback/types pour les tests (valeurs identiques à la 0.8)
export enum BadgeColor { BLUE = 'default', GREEN = 'success', GREY = 'info', YELLOW = 'warning', RED = 'danger' }
export enum ContentRating { EVERYONE = 'EVERYONE', MATURE = 'MATURE', ADULT = 'ADULT' }
export enum SourceIntents { MANGA_CHAPTERS = 1, MANGA_TRACKING = 2, HOMEPAGE_SECTIONS = 4, COLLECTION_MANAGEMENT = 8, CLOUDFLARE_BYPASS_REQUIRED = 16, SETTINGS_UI = 32 }
export enum HomeSectionType { singleRowNormal = 'singleRowNormal', singleRowLarge = 'singleRowLarge', doubleRow = 'doubleRow', featured = 'featured' }
export abstract class Source { constructor(public cheerio: any) {} }
export type Request = { url: string, method: string, headers: Record<string, string>, data?: any, cookies: any[] }
export type Response = { data?: string, status: number, headers: Record<string, string>, request: Request }
export type SourceInterceptor = any; export type SourceStateManager = any; export type DUISection = any
export type Chapter = any; export type ChapterDetails = any; export type PagedResults = any; export type PartialSourceManga = any
export type SearchRequest = any; export type SourceManga = any; export type Tag = any; export type TagSection = any
export type HomeSection = any; export type SourceInfo = any
