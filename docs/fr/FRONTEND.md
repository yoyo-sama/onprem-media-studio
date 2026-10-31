# Interface : Studio et Canvas

Version anglaise (de référence) : [../FRONTEND.md](../FRONTEND.md).

Deux pages statiques servies depuis `web/`, sans étape de build : `index.html` (le Studio :
formulaires, réalisateur étape par étape, galerie) et `canvas.html` (le Canvas : des cartes
reliées sur un graphe). Les deux sont des portages d'AI Content Studio 1.4 sur l'API 2.0
([ARCHITECTURE.md](ARCHITECTURE.md)). Seul code tiers : litegraph.js 0.7.18 pour le Canvas,
inclus avec sa licence MIT dans `web/js/vendor/`.

## Fichiers

| Fichier | Rôle |
|---|---|
| `web/js/prompts.js` | Compilateurs de prompts et consignes Gemma de la 1.4, une seule copie pour les deux pages (`window.Prompts`) ; chargeable aussi depuis Node pour les tests |
| `web/js/api.js` | Appels REST, socket d'événements `/api/ws`, `waitJob`, appel du LLM (`llmJSON`) |
| `web/js/i18n.js`, `i18n-dict.js` | Traduction : le texte anglais est la clé, français, espagnol et allemand dans `DICT` |
| `web/js/ui.js` | Cadre du Studio : journal, file de jobs et `runJob`, bandeau d'annulation, éditeur de prompt, thème |
| `web/js/form.js` | Le manifest de la 1.4 sous forme de tables (workflows, pipelines, contrôles), valeurs du formulaire, tailles, envois, références supplémentaires |
| `web/js/studio.js` | Page Studio : cartes d'objectif, menus, entrées, enrichissement, gestionnaires de génération du formulaire, modèles, LoRA, mise à jour |
| `web/js/generate.js` | Les générations simples comme fonctions de leurs réglages (texte/image vers image ou vidéo, marchés, séquence, campagne), appelées par le formulaire et par les cartes de l'assistant |
| `web/js/chat.js` | Panneau Assistant : conversations, réponses en flux, choix du rôle, pièces jointes, cartes (Générer, ✨, Ouvrir dans le Studio), éditeur de rôles du panneau Modèles : [ASSISTANT.md](ASSISTANT.md) |
| `web/js/director.js` | Réalisateur du storyboard et de la référence vers vidéo : planches, plans, images des plans, cuts, animatic, Relay |
| `web/js/gallery.js` | Galerie du Studio sur `/api/gallery` (filtres, visionneuse, tags, corbeille) |
| `web/js/canvas.js` | Page Canvas : dessin, médias superposés, panneau Propriétés, cas d'usage, sauvegarde, thème, langue |
| `web/js/canvas-nodes.js` | Cartes du Canvas : entrées, propriétés, champs du panneau et ce que Générer soumet |
| `web/js/canvas-gallery.js` | Tiroir de galerie du Canvas (glisser une image sur une carte Import d'image) |
| `web/js/model-notice.js` | Avertissement au-dessus de Générer (Studio) et dans le panneau Propriétés (Canvas) qui nomme les modèles que le moteur choisi doit encore télécharger (`/api/pipelines`, `/api/models`, tenu à jour par les événements `model` et la fin de chaque job) ; avec la taille restant à télécharger quand Hugging Face la donne (`/api/models/{id}/size`) ; le serveur les télécharge dans le premier job |

## Règles

Les règles de la 1.4 restent valables ; [LESSONS.md](LESSONS.md) en donne les raisons.

- **Rien ne part en rendu sans un clic.** Choisir une carte d'objectif, un pipeline, un moteur,
  une langue, ajouter ou relier des cartes ne soumet rien. Seuls les boutons Générer (et les
  boutons d'étape du réalisateur) postent sur `/api/jobs`.
- **Le brief n'appartient qu'à l'utilisateur.** Les exemples sont des placeholders, jamais des
  valeurs ; un brief vide ne lance rien.
- **Le prompt de l'utilisateur part tel quel** ; les blocs d'ancrage et squelettes de planche
  sont remis par le code, jamais envoyés à Gemma.
- **Une consigne Gemma par modèle.** `Prompts.briefEnrichSystem(workflow)` route les boutons ✨
  des deux pages : Krea 2 → `KREA2_ENRICH_SYSTEM`, MiniMax H3 texte/image vers vidéo et la
  séquence multi-images → `H3_VIDEO_ENRICH_SYSTEM`, référence vers vidéo →
  `R2V_BRIEF_ENRICH_SYSTEM`, briefs de storyboard et planches → `SHEET_BRIEF_ENRICH_SYSTEM`,
  Qwen Image 2.1 → la consigne générique `ENRICH_SYSTEM`. Les jetons `<Subject N>` et `<imageN>`
  traversent Gemma sous forme de substituts et sont vérifiés au retour.
- **Ces cinq consignes peuvent être remplacées** dans le panneau Modèles du Studio (« Consignes
  Gemma ») : le serveur garde les textes dans `STUDIO_DATA_DIR/instructions.json`
  (`/api/instructions`), les deux pages les relisent avant chaque enrichissement, et « Rétablir la
  consigne d'origine » retire le remplacement. Un texte remplacé ne fait que prendre la place de
  celui par défaut : la clé de réponse et les vérifications de jetons restent dans le code, et le
  panneau prévient quand le texte ne nomme plus la clé (ou SUBJECTREF, pour la référence vers
  vidéo). Les consignes par défaut restent celles de la 1.4.
- **L'assistant suit les mêmes règles** : ses cartes ne tournent que sur un clic, par `generate.js`
  (les jobs soumis sont ceux du formulaire, octet pour octet) ; une carte storyboard ou référence
  vers vidéo ne fait que remplir le formulaire ; « Ouvrir dans le Studio » écrit le brief sur le
  clic, avec Annuler.
- **Le texte d'interface est traduit, le journal aussi** ; noms de fichiers, prompts et données
  du serveur sont marqués `data-raw` et jamais traduits.

## Cartes du Canvas

| Carte | Entrées | Job(s) |
|---|---|---|
| Fiche personnage | — | Gemma (champs de la planche ; un type de sujet choisi sur la carte est imposé), puis `krea2-t2i` 1920×1088 |
| Fiche décor | — | Gemma, puis `krea2-t2i` 1920×1088 |
| Storyboard | fiche personnage, fiche décor, une troisième fiche facultative | liste de plans par Gemma, une image `qwen-image-2.1` par plan (sujets + décor), `image-grid` |
| Génération vidéo | storyboard | un cut `h3-i2v` par plan (depuis l'image du plan), ou `h3-r2v` (planches + image du plan en références) |
| Vidéo finale | génération vidéo | `video-concat` des cuts |
| Reference2Video | fiche personnage, fiche décor, jusqu'à 7 images en plus | un job `h3-r2v` |
| Création d'image | — | `krea2-t2i` ou `qwen-image-2.1` |
| Édition d'image | image, jusqu'à 9 références en plus | `qwen-image-2.1` (l'image est `<image1>`, les références `<image2>`…) |
| Vidéo | image | `h3-i2v` |
| Import d'image | — | envoi (`/api/inputs`), ou image glissée depuis le tiroir de galerie |

Une carte qui a produit quelque chose garde la référence du fichier dans `properties.outFile` ;
les cartes en aval la lisent. Le graphe est enregistré dans le navigateur (`localStorage`, clé
`canvasGraphState`) ; les fichiers restent sur le serveur. Le « + » d'une entrée image libre
ajoute une carte Import d'image reliée à elle.

## Différences avec la 1.4

- Ni ComfyUI ni LTX 2.5 : toute vidéo est MiniMax H3, de 5 à 15 secondes (grille de 17n+5
  images, la durée réelle est affichée).
- Qwen-Image-Edit 2509 est retiré (2026-10-29) : édition d'image et images des plans passent
  par Qwen Image 2.1, dont les tailles sont des multiples de 32 (`QWEN21_RATIOS` : 1344×768,
  768×1344, 1024², 896×1120). Un projet enregistré avec le storyboard 2509 reprend sur Qwen
  Image 2.1.
- Plus de génération cloud (OpenAI, Gemini).
- Ni LoRA Krea 2, ni mégapixels, ni turbo/steps ; les LoRA H3 sont des fichiers envoyés.
- La référence vers vidéo ne prend que des images (ni vidéo ni audio de référence).
- La séquence multi-images utilise la consigne vidéo H3 (la 1.4 y utilisait LTX).
- La légende du Relay nomme tous les sujets du plan (la 1.4 perdait le personnage principal).
- Canvas : ✨ suit le routage du Studio (la 1.4 avait sa propre copie de la consigne générique),
  la vidéo finale n'a pas d'interrupteur audio (les clips gardent leur son), les imports sont
  des images seulement.

## Tests

| Commande | Ce qu'elle vérifie | Il faut |
|---|---|---|
| `python -m pytest` | Serveur, paramètres des moteurs, galerie, et `tests/test_i18n.py` : chaque texte d'interface des deux pages a sa traduction française, espagnole et allemande avec les mêmes `{paramètres}`, et aucune entrée n'est inutilisée | Python, Node |
| `node tools/parity-prompts.js` | Chaque compilateur de prompt et consigne donne, au caractère près, ce que donne la 1.4 (`234f37c`, lue dans `../dellaicontent`), avec des réponses de Gemma scriptées | Node, la copie de la 1.4 |
| `node tools/prompt-systems.js` | Lance les deux pages sans affichage avec `/api` bouchonné : pour chaque moteur et bouton ✨ (et l'enrichissement automatique), la consigne reçue par Gemma a le sha256 de la 1.4 (ou est la consigne remplacée, pour son seul moteur), le nombre d'appels et le contenu sont justes, le texte revient dans le champ | Node, Playwright et son Chromium (`NODE_PATH=$(npm root -g)`) |
| `node tools/assistant-ui.js` | Le panneau Assistant sans affichage, avec `/api` bouchonné et une réponse scriptée : aucun job à l'ouverture, à la saisie, à l'envoi ni à la modification d'une carte ; un job par clic sur Générer, avec les réglages de la carte, signalé au serveur ; « Ouvrir dans le Studio » remplit le formulaire et ne soumet rien | Node, Playwright et son Chromium |

Modifier un compilateur de prompt ou une consigne fait échouer `parity-prompts.js` et `prompt-systems.js` ; si le
changement est voulu, mettre à jour la référence dans le même commit et dire pourquoi.
