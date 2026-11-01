import { DUISection } from '@paperback/types'
import { Store } from './Store'
import { parseRepoList, parseSiteList, siteIdOf } from './Utils'

export interface SettingsActions {
    discoverAll(force: boolean): Promise<void>
    importRepos(): Promise<void>
    diagnose(url: string): Promise<void>
    reset(full: boolean): Promise<void>
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
                id: 'repos_nav',
                label: 'Importer les sites de mes dépôts',
                form: App.createDUIForm({
                    sections: async () => [
                        App.createDUISection({
                            id: 'repos_section',
                            header: 'Dépôts d\'extensions',
                            footer: 'Colle les liens de tes dépôts d\'extensions, séparés par des virgules. Tu les trouves dans Paperback > Réglages > Sources externes (ou Dépôts). TagFusion récupère alors tous les sites de ces dépôts, puis revérifie chaque jour s\'il y en a de nouveaux. Tu peux retirer ceux que tu ne veux pas dans « Mes sites ».',
                            isHidden: false,
                            rows: async () => [
                                App.createDUIInputField({
                                    id: 'repos',
                                    label: 'Dépôts',
                                    value: App.createDUIBinding({
                                        get: async () => (await store.getRepos()).map(u => u.replace(/\/versioning\.json$/, '')).join(', '),
                                        set: async (v: unknown) => { try { await store.setRepos(parseRepoList(String(v ?? ''))) } catch { /* ignoré */ } }
                                    })
                                }),
                                App.createDUIButton({
                                    id: 'repos_import',
                                    label: 'Importer les sites maintenant',
                                    onTap: async () => { try { await actions.importRepos() } catch { /* voir le journal */ } }
                                })
                            ]
                        })
                    ]
                })
            }),
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
            App.createDUINavigationButton({
                id: 'diag_nav',
                label: 'Diagnostic d\'un manga',
                form: App.createDUIForm({
                    sections: async () => [
                        App.createDUISection({
                            id: 'diag_section',
                            header: 'Analyser un manga',
                            footer: 'Colle l\'adresse complète d\'un manga (copiée depuis le navigateur), puis touche « Analyser ». Le résultat détaillé apparaît dans « Journal (diagnostic) » sur l\'écran précédent.',
                            isHidden: false,
                            rows: async () => [
                                App.createDUIInputField({
                                    id: 'diag_url',
                                    label: 'Adresse',
                                    value: App.createDUIBinding({
                                        get: async () => store.getDiagUrl(),
                                        set: async (v: unknown) => { try { await store.setDiagUrl(String(v ?? '')) } catch { /* ignoré */ } }
                                    })
                                }),
                                App.createDUIButton({
                                    id: 'diag_run',
                                    label: 'Analyser',
                                    onTap: async () => { try { await actions.diagnose(await store.getDiagUrl()) } catch { /* voir le journal */ } }
                                })
                            ]
                        })
                    ]
                })
            }),
            App.createDUIButton({
                id: 'reset_index',
                label: 'Effacer l\'index et les tags (garde mes sites)',
                onTap: async () => { try { await actions.reset(false) } catch { /* rien à faire */ } }
            }),
            App.createDUIButton({
                id: 'reset_all',
                label: 'Tout réinitialiser (sites compris)',
                onTap: async () => { try { await actions.reset(true) } catch { /* rien à faire */ } }
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
    const blocked = await store.getCloudflareBlocked()
    if (blocked.length) {
        lines.push(`\n☁️ Bloqués par Cloudflare : ${blocked.map(siteIdOf).join(', ')}`)
        lines.push('Pour débloquer : ouvre la page d\'accueil de TagFusion, touche l\'icône nuage en haut, attends que le site s\'affiche, puis reviens. Recommence pour chaque site.')
    }
    lines.push(`\nTotal : ${Object.keys(unified).length} tags fusionnés, ${await store.indexSize()} manga(s) indexé(s).`)
    return lines.join('\n')
}
