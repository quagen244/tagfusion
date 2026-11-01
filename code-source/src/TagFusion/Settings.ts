import { DUISection } from '@paperback/types'
import { Store } from './Store'
import { parseSiteList, siteIdOf } from './Utils'

export interface SettingsActions {
    discoverAll(force: boolean): Promise<void>
}

const ENGINE_LABEL: Record<string, string> = {
    madara: 'thème Madara',
    themesia: 'thème MangaReader',
    generic: 'mode universel'
}

/** Menu des réglages de l'extension (Paperback > Extensions > TagFusion) */
export async function buildSettings(store: Store, actions: SettingsActions): Promise<DUISection> {
    return App.createDUISection({
        id: 'main',
        header: 'TagFusion',
        isHidden: false,
        rows: async () => [
            App.createDUINavigationButton({
                id: 'sites_nav',
                label: 'Mes sites',
                form: App.createDUIForm({
                    sections: async () => [
                        App.createDUISection({
                            id: 'sites_section',
                            header: 'Sites à fusionner',
                            footer: 'Colle les adresses des sites, séparées par des virgules. Exemple : site-un.com, site-deux.net. Ensuite, reviens en arrière et touche « Charger les tags ».',
                            isHidden: false,
                            rows: async () => [
                                App.createDUIInputField({
                                    id: 'sites',
                                    label: 'Sites',
                                    value: App.createDUIBinding({
                                        get: async () => (await store.getSites()).join(', '),
                                        set: async (v: unknown) => { try { await store.setSites(parseSiteList(String(v ?? ''))) } catch { /* ignoré */ } }
                                    })
                                })
                            ]
                        })
                    ]
                })
            }),
            App.createDUINavigationButton({
                id: 'merges_nav',
                label: 'Fusions de tags personnalisées',
                form: App.createDUIForm({
                    sections: async () => [
                        App.createDUISection({
                            id: 'merges_section',
                            header: 'Fusions',
                            footer: 'Pour regrouper des tags que l\'extension ne fusionne pas toute seule. Format : ancien=nouveau, séparés par des points-virgules. Exemple : love=romance; bl=boys love; gore=horror',
                            isHidden: false,
                            rows: async () => [
                                App.createDUIInputField({
                                    id: 'merges',
                                    label: 'Fusions',
                                    value: App.createDUIBinding({
                                        get: async () => store.getMergesText(),
                                        set: async (v: unknown) => { try { await store.setMergesText(String(v ?? '')) } catch { /* ignoré */ } }
                                    })
                                })
                            ]
                        })
                    ]
                })
            }),
            App.createDUIButton({
                id: 'discover',
                label: 'Charger / mettre à jour les tags',
                onTap: async () => { try { await actions.discoverAll(true) } catch { /* l'erreur est affichée dans l'état des sites */ } }
            }),
            App.createDUIMultilineLabel({
                id: 'status',
                label: 'État des sites',
                value: await statusText(store).catch(() => 'État indisponible pour le moment.')
            }),
            App.createDUIMultilineLabel({
                id: 'debug',
                label: 'Journal (diagnostic)',
                value: await store.getDebugLines().then(l => l.length ? l.join('\n') : 'Vide pour l\'instant.').catch(() => 'Indisponible.')
            }),
            App.createDUIButton({
                id: 'clear',
                label: 'Effacer tous les tags appris',
                onTap: async () => { try { await store.clearTags() } catch { /* rien à faire */ } }
            })
        ]
    })
}

async function statusText(store: Store): Promise<string> {
    const sites = await store.getSites()
    if (sites.length === 0) return 'Aucun site pour l\'instant. Ouvre « Mes sites » pour en ajouter.'
    const info = await store.getSiteInfo()
    const unified = await store.unified()
    const lines: string[] = []
    for (const base of sites) {
        const id = siteIdOf(base)
        const s = info[id]
        const n = await store.tagCount(id)
        const engine = s?.engine ? ENGINE_LABEL[s.engine] ?? s.engine : 'pas encore analysé'
        let line = `• ${s?.name ?? id} : ${engine}, ${n} tags`
        if (s?.error) line += `\n   ⚠️ ${s.error}`
        lines.push(line)
    }
    lines.push(`\nTotal : ${Object.keys(unified).length} tags fusionnés.`)
    return lines.join('\n')
}
