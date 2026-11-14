# Interface : Studio et Canvas

Version anglaise (de référence) : [../FRONTEND.md](../FRONTEND.md).

Deux pages statiques servies depuis `web/`, sans étape de build : `index.html` (l'Assistant et le
Studio : le chat, les formulaires, le réalisateur étape par étape, la galerie) et `canvas.html`
(le Canvas : des cartes reliées sur un graphe). Le rail propose trois modes dans cet ordre :
**Assistant** (le premier, un chat dans la zone principale), **Studio** et **Canvas**. Assistant
et Studio sont deux modes d'`index.html` (`body[data-mode]`, adresse `#assistant` ou `#studio`,
dernier mode retenu sous `mode`) ; la bibliothèque (file de jobs et galerie) suit le mode affiché. Les deux sont des portages d'AI Content Studio 1.4 sur l'API 2.0
([ARCHITECTURE.md](ARCHITECTURE.md)). Seul code tiers : litegraph.js 0.7.18 pour le Canvas,
inclus avec sa licence MIT dans `web/js/vendor/`.

## Fichiers

| Fichier | Rôle |
|---|---|
| `web/js/prompts.js` | Compilateurs de prompts et consignes Gemma de la 1.4, une seule copie pour les deux pages (`window.Prompts`) ; chargeable aussi depuis Node pour les tests |
| `web/js/api.js` | Appels REST, socket d'événements `/api/ws`, `waitJob`, appel du LLM (`llmJSON`) |
| `web/js/i18n.js`, `i18n-dict.js` | Traduction : le texte anglais est la clé, français, espagnol et allemand dans `DICT` |
| `web/js/ui.js` | Cadre du Studio : journal, file de jobs et `runJob`, bandeau d'annulation, éditeur de prompt, thème |
| `web/js/form.js` | Le manifest de la 1.4 sous forme de tables (workflows, pipelines, contrôles), valeurs du formulaire, tailles, envois, références supplémentaires, piles de LoRA du formulaire (une par dossier ; le `loras` d'un workflow nomme le dossier que lit son moteur, absent = pas de contrôle LoRA) |
| `web/js/lora-stack.js` | Sélecteur de pile de LoRA partagé par le formulaire du Studio et le panneau du Canvas : jusqu'à 4 lignes fichier et force (-2 à 2) pour un dossier, chaque fichier une fois ; modifie la pile en place et ne soumet rien |
| `web/js/studio.js` | Page Studio : modes (`setMode`), cartes d'objectif, menus, entrées, enrichissement, gestionnaires de génération du formulaire, cartes de l'assistant reprises par le formulaire (`openCardInForm`, `launchDirector`), modèles, LoRA, mise à jour |
| `web/js/generate.js` | Les générations simples comme fonctions de leurs réglages (texte/image vers image ou vidéo, marchés, séquence, campagne), appelées par le formulaire et par les cartes de l'assistant |
| `web/js/chat.js` | Mode Assistant : conversations, réponses en flux, choix du rôle, pièces jointes, volet Bibliothèque, cartes (Générer, ✨, Ouvrir dans le Studio, Lancer le Réalisateur), éditeur de rôles du panneau Modèles : [ASSISTANT.md](ASSISTANT.md) |
| `web/js/mascot.js` | Le personnage animé de l'assistant (SVG en ligne, humeurs en CSS) : pure décoration |
| `web/js/director.js` | Réalisateur du storyboard et de la référence vers vidéo : planches, plans, images des plans, cuts, animatic, Relay |
| `web/js/gallery.js` | Galerie du Studio sur `/api/gallery` (filtres, visionneuse, tags, corbeille, résolution ×2) |
| `web/js/canvas.js` | Page Canvas : dessin, médias superposés, panneau Propriétés, cas d'usage, sauvegarde, thème, langue |
| `web/js/canvas-nodes.js` | Cartes du Canvas : entrées, propriétés, champs du panneau et ce que Générer soumet |
| `web/js/canvas-gallery.js` | Tiroir de galerie du Canvas (glisser une image sur une carte Import d'image) |
| `web/js/model-notice.js` | Avertissement au-dessus de Générer (Studio) et dans le panneau Propriétés (Canvas) qui nomme les modèles que le moteur choisi doit encore télécharger (`/api/pipelines`, `/api/models`, tenu à jour par les événements `model` et la fin de chaque job) ; avec la taille restant à télécharger quand Hugging Face la donne (`/api/models/{id}/size`) ; le serveur les télécharge dans le premier job |

## Règles

Les règles de la 1.4 restent valables ; [LESSONS.md](LESSONS.md) en donne les raisons.

- **Rien ne part en rendu sans un clic.** Choisir une carte d'objectif, un pipeline, un moteur,
  une langue, ajouter ou relier des cartes ne soumet rien. Seuls les boutons Générer (et les
  boutons d'étape du réalisateur) postent sur `/api/jobs`, ainsi que « ⇱ Doubler la résolution »
  dans la visionneuse de la galerie, un job par clic ([IMAGE-ENGINES.md](IMAGE-ENGINES.md#résolution-2)).
- **La première étape du réalisateur ne dessine rien** (décidé le 2026-11-01, contrairement à la
  1.4). « Entrer dans le studio » fait écrire par Gemma les descriptions du sujet et du décor et
  la liste de plans, puis ouvre le studio sans planche. Chaque planche part sur son propre clic :
  depuis ses champs, depuis une photo du sujet (« 📷 Planche depuis une photo », Qwen Image 2.1 :
  cinq vues, deux portraits et trois vues en pied, dans le style de l'image ; le menu de mise en
  page des planches ne vaut que pour les planches dessinées depuis les champs), ou importée
  terminée. La première génération d'une planche garde la seed que l'étape
  automatique lui donnait : son job est celui qu'envoyait la 1.4.
- **Le brief n'appartient qu'à l'utilisateur.** Les exemples sont des placeholders, jamais des
  valeurs ; un brief vide ne lance rien.
- **« → Utiliser en entrée » suit le pipeline affiché** (images et vidéos, carte de la galerie
  ou visionneuse). Séquence : l'image rejoint la séquence. Pipeline à image d'entrée
  (Image2Image, Image2Video) : elle devient l'entrée. Vidéo depuis des références : l'image ou la
  vidéo rejoint la liste des références ; storyboard Qwen 2.1 : l'image. Text2Video ouvre
  Image2Video avec l'image, tout autre pipeline Image2Image. Une vidéo que le pipeline ne prend
  pas est refusée avec un message. Le formulaire ne quitte jamais un pipeline qui peut prendre
  l'élément, et aucun job ne part.
- **Le prompt de l'utilisateur part tel quel** ; les blocs d'ancrage et squelettes de planche
  sont remis par le code, jamais envoyés à Gemma.
- **Une consigne Gemma par modèle.** `Prompts.briefEnrichSystem(workflow)` route les boutons ✨
  des deux pages : Krea 2 → `KREA2_ENRICH_SYSTEM`, MiniMax H3 texte/image vers vidéo et la
  plan-séquence à partir d'images → `H3_VIDEO_ENRICH_SYSTEM`, référence vers vidéo →
  `R2V_BRIEF_ENRICH_SYSTEM`, briefs de storyboard et planches → `SHEET_BRIEF_ENRICH_SYSTEM`,
  Qwen Image 2.1 et MOSS-Image → la consigne générique `ENRICH_SYSTEM`. Les jetons `<Subject N>` et `<imageN>`
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
  vers vidéo ne lance le réalisateur que par son bouton « Lancer le Réalisateur », qui passe au
  Studio, remplit le formulaire et fait ce que fait Générer là-bas (la revue étape par étape) ;
  « Ouvrir dans le Studio » écrit le brief sur le clic, avec Annuler, et ne lance rien.
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
| Reference2Video | fiche personnage, fiche décor, jusqu'à 7 images, 3 vidéos et 3 sons en plus | un job `h3-r2v` |
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
- Nouveau en 2.0 : MOSS-Image en Text2Image (Studio, carte « Création d'image » du Canvas, carte
  image de l'assistant), avec un menu Mode affiché pour ce moteur seulement : Aperçu (4 étapes),
  Standard (8, par défaut) ou Qualité (25). Il prend la table de ratios de Krea 2 (multiples de 16).
- Plus de génération cloud (OpenAI, Gemini).
- Ni mégapixels, ni turbo/steps ; les LoRA sont des fichiers envoyés, un dossier par famille de
  moteurs (H3, Krea 2, Qwen Image 2.1, MOSS-Image). Un rendu prend une pile de 4 LoRA au plus,
  chacune avec sa force (1.4 : un fichier à pleine force, Krea 2 et H3 seulement) ; un Canvas
  enregistré avec l'ancienne propriété `lora` revient avec une pile d'une ligne. Text2Image et
  Image2Image montrent la pile du moteur choisi (chacun garde la sienne) ; la carte Canvas
  « Création d'image » garde une pile par moteur et « Édition d'image » une pile Qwen. Un job
  d'image n'envoie `loras` que si sa pile a des lignes.
  Un fichier envoyé dont le nom commence par `H3_`, `Qwen_2.1`, `Krea_2` ou `Moss_` (casse
  indifférente) va dans le dossier de ce moteur : le panneau Modèles choisit et verrouille le
  dossier, et le serveur refuse un tel fichier envoyé dans un autre dossier (422).
- Les références en plus de la référence vers vidéo prennent jusqu'à 7 images, 3 vidéos et 3 sons
  (comme en 1.4), dans une seule liste (`F.r2vPlan`). Chaque image est le `<Subject N>` suivant ;
  une vidéo a un rôle (mouvement de caméra et rythme, ou un sujet), un son aussi (voix d'un
  personnage, musique, ambiance et bruitages), affiché avec son repère. Le réalisateur et
  « Ignorer les planches » les envoient dans l'ordre de la liste, avec le prompt de
  `buildH3RefPrompt` ([H3.md](H3.md)) ; une vidéo part muette.
- Dans le réalisateur, un clip de référence vers vidéo se lit sous son bouton une fois rendu, et
  le bouton devient « Régénérer la vidéo » : un nouveau job sur les mêmes planches, avec le seed
  suivant.
- La séquence multi-images de la 1.4 est devenue le plan-séquence à partir d'images (pipeline
  `sequence`, workflow `h3_sequence`) : 1 à 6 images, puis « Ouvrir le plan-séquence » ouvre le
  réalisateur sur le Relay seul, sans planche ni validation, et ne soumet rien. La vision de
  Gemma décrit la première image (le sujet de chaque segment) ; le segment k finit sur l'image
  k+1 (FL2VA) et chaque segment part de la dernière image du précédent, telle quelle (la 1.4
  partait de l'image clé elle-même) ; une seule image donne un segment, à compléter. Le brief
  est le scénario et le premier texte de chaque segment, si bien que « Générer la chaîne »
  rend tout de suite ce que faisait la séquence de la 1.4. Pas de lien de coupe (aucune planche
  sur laquelle la composer) ; la pile de LoRA H3 du formulaire va à chaque segment ; le projet
  est enregistré et repris comme un storyboard (un projet à la fois), sous son propre pipeline.
  La carte `image_sequence` de l'assistant rend toujours ses paires d'un coup
  (`G.runSequence`) ; son « Ouvrir dans le Studio » ouvre le plan-séquence. ✨ utilise la
  consigne vidéo H3, comme la séquence de la 1.4 avec LTX.
- Un segment ajouté après la fin d'une chaîne rendue fait d'abord extraire les images de
  transition du segment précédent (le dernier segment d'une chaîne n'en a pas).
- La légende du Relay nomme tous les sujets du plan (la 1.4 perdait le personnage principal).
- Le Relay se règle par une durée totale et un maximum par segment (10 s par défaut, le plus long
  rendu H3 qualifié sur le GB10) : le studio découpe le total en aussi peu de segments que
  possible, aussi égaux que possible, et montre la place de chaque segment dans la séquence
  (`00:10.1–00:20.3`, d'après les durées que H3 rend vraiment). Gemma écrit, en plus d'une action
  par segment, l'ambiance commune à toute la séquence (caméra, lumière, ambiance sonore,
  musique) ; il ne remplit que les champs communs laissés vides. Le prompt de chaque segment
  reprend cette ambiance une fois, et rien d'autre : la 1.4 ajoutait à chaque segment une lumière
  « golden hour » et un « steady framing », quoi qu'il dise (LESSONS n°50). La première image de
  plan reprend aussi la lumière commune.
- Le Relay a un tableau de production : une tuile par segment, aussi large que sa durée, avec son
  image de départ, sa place dans la séquence, son état et l'avancement du job en cours pour lui
  (image de plan, vidéo, images de transition, d'après les événements des jobs) ; un clic mène au
  segment et ne lance rien. Le résumé donne les segments prêts, les secondes rendues et, dès
  qu'un segment a été chronométré, le temps restant estimé. « Générer la chaîne » part du premier
  segment qui n'est pas prêt (« Continuer la chaîne au segment n ») et marque les suivants « à
  régénérer » ; quand tous sont prêts, il les refait tous avec de nouvelles seeds, après
  confirmation. « Arrêter après ce segment » arrête la chaîne une fois le segment en cours
  terminé. L'image de fin d'un segment, le choix de la transition et la suppression sont dans
  ses « Options avancées ». Un segment n'est prêt qu'une fois ses images de transition faites.
- Canvas : ✨ suit le routage du Studio (la 1.4 avait sa propre copie de la consigne générique),
  la vidéo finale n'a pas d'interrupteur audio (les clips gardent leur son), les imports sont
  des images seulement.

## Tests

| Commande | Ce qu'elle vérifie | Il faut |
|---|---|---|
| `python -m pytest` | Serveur, paramètres des moteurs, galerie, et `tests/test_i18n.py` : chaque texte d'interface des deux pages a sa traduction française, espagnole et allemande avec les mêmes `{paramètres}`, et aucune entrée n'est inutilisée | Python, Node |
| `node tools/parity-prompts.js` | Chaque compilateur de prompt et consigne donne, au caractère près, ce que donne la 1.4 (`234f37c`, lue dans `../dellaicontent`), avec des réponses de Gemma scriptées | Node, la copie de la 1.4 |
| `node tools/prompt-systems.js` | Lance les deux pages sans affichage avec `/api` bouchonné : pour chaque moteur et bouton ✨ (et l'enrichissement automatique), la consigne reçue par Gemma a le sha256 de la 1.4 (ou est la consigne remplacée, pour son seul moteur), le nombre d'appels et le contenu sont justes, le texte revient dans le champ | Node, Playwright et son Chromium (`NODE_PATH=$(npm root -g)`) |
| `node tools/assistant-ui.js` | Le mode Assistant sans affichage, avec `/api` bouchonné et une réponse scriptée : la page s'ouvre sur l'assistant ; aucun job au changement de mode, à la Bibliothèque, à la saisie, à l'envoi ni à la modification d'une carte ; un job par clic sur Générer, avec les réglages de la carte, son avancement affiché sur la carte d'après les événements du job, signalé au serveur ; « Ouvrir dans le Studio » passe au Studio, remplit le formulaire et ne soumet rien ; « Lancer le Réalisateur » passe au Studio et lance le réalisateur, dont le bouton Générer nomme le travail de Gemma et son temps jusqu'à ce que la première étape soit prête ; cette étape ouvre le studio sans dessiner de planche, et le clic d'une planche l'envoie avec la seed de la première étape ; les pastilles LoRA d'une carte ne soumettent rien et son Générer envoie celles qui sont activées | Node, Playwright et son Chromium |
| `node tools/lora-ui.js` | La pile de LoRA sans affichage, avec `/api` bouchonné : dans le Studio elle n'apparaît que pour les workflows qui prennent des LoRA, accepte jusqu'à 4 fichiers (chacun une fois) avec des forces ramenées à -2…2, ne soumet rien pendant qu'on la modifie, Générer envoie les lignes affichées, un autre moteur n'en envoie aucune et le retour retrouve la pile ; le panneau Modèles téléverse dans le dossier choisi ; un Canvas enregistré avec l'ancienne propriété `lora` revient avec une pile d'une ligne et son Générer envoie la pile | Node, Playwright et son Chromium |
| `node tools/relay-ui.js` | Le Relay du réalisateur sans affichage, avec `/api` bouchonné, sur un projet restauré aux planches validées : la durée totale et le maximum par segment donnent le découpage (25 s à 10 s → 8 + 8 + 9), le découpage du scénario remplit les segments et seulement les champs communs restés vides sans rien soumettre, les en-têtes de segment montrent leur place dans la séquence, et la chaîne envoie une image de plan puis un clip H3 par segment dont le prompt porte l'ambiance commune une seule fois, sans lumière ni caméra par défaut ; le tableau de production montre l'état de chaque segment et l'avancement envoyé par les événements des jobs, un clic sur une tuile mène à son segment sans job, la chaîne reprend au premier segment pas prêt, et « Arrêter après ce segment » l'arrête là ; le plan-séquence à partir de deux images ouvre le Relay seul sans job (un appel de vision), rend image 1 → image 2 en un clip FL2VA, un segment ajouté après la fin part de la dernière image du segment 1, et le projet se reprend sous son pipeline | Node, Playwright et son Chromium |

Modifier un compilateur de prompt ou une consigne fait échouer `parity-prompts.js` et `prompt-systems.js` ; si le
changement est voulu, mettre à jour la référence dans le même commit et dire pourquoi.
