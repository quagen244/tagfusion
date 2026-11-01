# TagFusion — recherche par tags multi-sites pour Paperback 0.8

Une seule extension qui cherche sur plusieurs sites à la fois, avec **tous les tags des fiches** réunis dans une seule liste.
Tu choisis « Romance », et tous les mangas romance de tous tes sites sortent ensemble.

## Comment ça marche

- **Pas de base de données géante.** Les sites ont déjà une page « tous les mangas du tag X » derrière chaque tag cliquable.
  TagFusion retient ces liens et interroge directement ces pages, sur tous les sites en parallèle.
- **Les tags s'ajoutent tout seuls :**
  1. au premier lancement, l'extension lit la liste des genres/tags de chaque site ;
  2. ensuite, chaque fiche que tu ouvres lui apprend les tags qu'elle ne connaissait pas encore.
- **Fusion automatique :** « Romance », « Romantic », « romance » deviennent un seul tag.
  Les synonymes courants sont gérés, en anglais et en français (Comédie = Comedy, Tranche de vie = Slice of Life…).
  Tu peux ajouter tes propres fusions dans les réglages (`love=romance; gore=horror`).
- **Plusieurs tags à la fois** (romance + école) : si le site sait filtrer sur plusieurs genres, l'extension utilise son filtre.
  Sinon, elle vérifie chaque manga sur sa fiche. C'est plus lent, mais exact.
- **Exclure un tag** fonctionne aussi (vérification sur fiche).
- **Doublons** : le même titre trouvé sur deux sites n'apparaît qu'une fois. Le nom du site est affiché sous chaque manga.

## Quels sites sont compatibles

L'extension reconnaît automatiquement le type de chaque site :

| Type de site | Compatibilité |
|---|---|
| Thème WordPress **Madara** (le plus courant pour les scans) | complète : tags, filtre multi-genres, chapitres, pages |
| Thème WordPress **MangaReader / MangaThemesia** | complète : tags, chapitres, pages (multi-tags par vérification) |
| Tous les autres sites | **mode universel** par détection : marche sur la plupart des sites « classiques » |

Limites du mode universel :
- les sites qui affichent tout en JavaScript (applications web, comme MangaDex) ne renvoient pas de HTML lisible, donc ça ne marche pas ;
- les sites protégés par Cloudflare doivent être débloqués une fois avec le bouton **Cloudflare Bypass** dans les réglages de l'extension.

## Installation : plug and play, sans GitHub ni build (2 minutes)

L'extension est **déjà compilée** dans le dossier `dist/TagFusion-en-ligne`. Il n'y a rien à installer ni à construire.

Paperback n'accepte les extensions qu'à partir d'un **lien en ligne** : il faut juste déposer ce dossier sur un hébergeur gratuit.

1. Sur un ordinateur, va sur **app.netlify.com/drop**.
2. Crée un compte gratuit ou connecte-toi avec Google. C'est nécessaire : sans compte, Netlify protège le site par mot de passe et Paperback ne pourrait pas le lire.
3. **Glisse le dossier `TagFusion-en-ligne`** dans la zone de dépôt.
4. Quelques secondes plus tard, Netlify te donne une adresse du type `https://nom-au-hasard.netlify.app`.
   Ouvre-la : une page « TagFusion est en ligne ✅ » s'affiche avec l'adresse à copier.

## Ajouter dans Paperback

1. Paperback → **Settings → External Sources** (ou Extensions) → **+**, puis colle l'adresse Netlify.
2. Installe **TagFusion**.
3. Ouvre les réglages de TagFusion :
   - **Mes sites** : colle les adresses de tes sites, séparées par des virgules ;
   - reviens en arrière et touche **Charger / mettre à jour les tags** ;
   - **État des sites** te montre ce qui a été détecté pour chaque site et le nombre de tags trouvés.
4. Va dans la recherche de TagFusion : tous les tags fusionnés sont là, classés par lettre.
   Le chiffre après un tag (`Romance · 3`) indique sur combien de sites il existe.
   La section **Limiter à certains sites** permet de ne chercher que sur certains sites.

## Mettre à jour l'extension

Quand je te donne une nouvelle version du dossier `TagFusion-en-ligne`, va sur ton site dans Netlify, onglet **Deploys**, et glisse le nouveau dossier.
L'adresse ne change pas, et Paperback propose la mise à jour.

## Pour les développeurs

```
npm install
npm test           # tests de la logique (tags, URLs, pagination, dates, registre)
npm run bundle     # reconstruit l'extension dans bundles/ (facultatif, dist/ est déjà prêt)
npm run serve      # serveur local pour tester depuis Paperback sur le même Wi-Fi
```

Organisation du code, dans `src/TagFusion/` :
- `TagFusion.ts` : l'extension (recherche multi-sites, fiches, chapitres, pages) ;
- `Engines.ts` : les lecteurs de sites (Madara, MangaThemesia, universel) ;
- `Store.ts` : la mémoire des sites et des tags, et la fusion ;
- `Settings.ts` : le menu de réglages ;
- `Utils.ts` : les fonctions pures (normalisation des tags, URLs, dates, numéros de chapitre).

Pour ajouter un type de site, écris un nouveau moteur dans `Engines.ts` sur le modèle de `MadaraEngine` et ajoute-le à la liste `ENGINES`.
