# Assistant de création

Version anglaise (de référence) : [../ASSISTANT.md](../ASSISTANT.md).

Le premier mode de la page (rail : Assistant, puis Studio, puis Canvas) : un chat dans la zone
principale qui aide l'utilisateur à construire son contenu. Derrière, plusieurs **rôles** (réalisateur, DA publicité, casting…),
chacun avec ses consignes ; le serveur choisit le rôle le mieux placé pour répondre. Un rôle
répond par du texte et par des **cartes** : une carte par pipeline du Studio qu'il veut lancer,
prompt et réglages remplis. Rien ne part en rendu avant le clic de l'utilisateur sur Générer.

## La page

- **Modes** : Assistant et Studio sont deux modes d'`index.html` ; l'adresse (`#assistant`,
  `#studio`) ou le dernier mode utilisé le choisit au chargement, l'assistant par défaut. Le
  Canvas propose les trois mêmes choix.
- **Conversations** : un chargement de la page ouvre l'accueil ; les conversations précédentes
  restent dans la liste, et « ＋ Nouvelle conversation » ramène à l'accueil à tout moment.
- **Bibliothèque** : le bouton « Bibliothèque » ouvre la file de jobs et la galerie à côté du chat
  (par-dessus sur un téléphone). Une image de la galerie utilisée depuis l'assistant (« → Utiliser
  en entrée », ou glissée sur le chat) devient une pièce jointe du prochain message ; « Réutiliser
  le prompt » le copie dans la zone de message, avec Annuler.
- **Personnage** : un petit personnage animé (`web/js/mascot.js`) accueille l'utilisateur et
  montre ce que fait l'assistant : il écoute pendant la saisie, réfléchit jusqu'au début de la
  réponse, parle pendant qu'elle arrive, saute quand des cartes arrivent ou qu'un rendu se
  termine, a l'air triste sur une erreur. Il porte le costume du rôle qui répond : casquette
  blanche (assistant général), béret (réalisateur), lunettes rondes (casting), lunettes de soleil
  (DA publicité), micro-casque (localisation), nœud papillon (campagne), casque audio (monteur
  transitions) ; un rôle ajouté par l'utilisateur garde la casquette. C'est une pure décoration (un clic le fait sauter) ; il
  reste immobile quand le système demande moins d'animations.

## Modèle

Un seul LLM pour tout : **Gemma 4 26B-A4B** (mélange d'experts, environ 4 milliards de paramètres
actifs par jeton), GGUF `ggml-org/gemma-4-26B-A4B-it-GGUF`, `Q4_0` (14,6 Go) plus son projecteur
de vision (`mmproj` Q8_0, 0,8 Go), Apache-2.0. Il sert le chat et les enrichissements ✨ par le
même `llama-server` (un processus, contexte de 32k, un seul emplacement).
`STUDIO_LLM_MODEL=gemma4-e4b` revient à Gemma 4 E4B (8 Go) sur une machine plus petite. Les appels
d'outils natifs passent par `llama-server --jinja` (gabarit de chat de Gemma 4).

Quand un moteur vidéo H3 doit se charger seul et que la mémoire manque, le serveur arrête d'abord
`llama-server` (`common.LOW_MEMORY`) ; il redémarre à la requête LLM suivante.

Chaque appel à Gemma écrit une ligne dans le journal du conteneur, avec les temps de
llama-server, de même que chaque chargement du modèle : `docker logs studio --since 30m 2>&1 |
grep "llm:"` distingue un modèle lent d'un rendu lent (`llm: call 12.4 s (prompt 850 tokens in
1.1 s, 410 generated in 11.3 s)`). Chaque chargement de moteur écrit aussi une ligne `engine:`
(durée, temps de lecture des fichiers, moteurs libérés pour lui), et chaque rendu d'image ou de vidéo une
ligne `render:` (encodage, étapes, décodage ; passes pour H3) : `grep -E "llm:|engine:|render:"`.

llama-server fait réfléchir Gemma 4 par défaut. Pour les compilateurs de prompts (enrichissement,
planches, liste de plans, choix du rôle), cela faisait des milliers de jetons cachés par appel :
44 à 81 s mesurées sur le GB10 pour des réponses de quelques centaines de jetons. Les tours du
chat faisaient pareil : 8 444 jetons cachés (150 s) pour une réponse de trois lignes, et une fois
une boucle qui a rempli tout le contexte (29 220 jetons, 528 s) sans rien écrire. Les
compilateurs envoient `enable_thinking: false`. Le chat garde la réflexion, utile au choix des
outils, dans un budget de `CHAT_THINKING_BUDGET` jetons (2 048, environ 40 s, `studio/llm.py`).
Au-delà, le studio arrête cette génération et redemande la réponse sans réflexion
(`llm: chat thought … asked again without thinking` dans le journal). llama.cpp b11982 n'a pas
d'option `--reasoning-budget`, c'est donc le studio qui tient le budget. Une réponse entière du chat, réflexion comprise, est plafonnée à
`CHAT_MAX_TOKENS` (2 048 + 4 096). Une réponse coupée au plafond, ou tout autre échec d'un
tour, reste dans la conversation comme une erreur sous le nom du rôle, visible après un
rechargement ; ce message n'est pas renvoyé au modèle.

## Rôles

Un rôle est un fichier Markdown : un en-tête entre deux lignes `---`, puis ses consignes.

```
---
id: director
name: Director
when: A story told in several shots: a script or scene to storyboard, a short film, a trailer…
tools: storyboard, reference_video, video_from_image, image_sequence
---
You are a storyboard artist and director of photography…
```

- `when` est ce que lit le routeur pour choisir le rôle ; `tools` les outils de génération que
  le rôle peut appeler (les deux outils de conversation sont toujours là).
- Les rôles livrés sont dans `studio/assistant/roles/` : `assistant` (général), `director`
  (réalisateur), `casting` (casting et décors), `ad_director` (DA publicité), `localisation`,
  `campaign` (campagne produit et mode), `transitions` (monteur transitions). Ils sont écrits
  pour ce studio, en s'inspirant de la structure d'agents de production (questions à choix
  cliquables, une fiche avant chaque rendu, passages de relais), sans en recopier le texte. Les
  consignes sont en anglais (langue du modèle) ; le rôle répond dans la langue de l'interface.
- `_common.md` est le bloc que chaque rôle reçoit en premier : règles de travail (ne demander que
  ce qui manque, une question à la fois par des choix cliquables, montrer avant de rendre, prompts
  positifs en anglais, ids d'images pris dans la table des références…). Le code remplit ses
  champs : `{app_name}`, `{language}` (la langue de l'interface : le rôle y répond, en tutoyant en français, espagnol et allemand, comme l'interface), `{engines}`
  (une ligne par outil du rôle), `{references}` (la table des images), `{role_name}`, `{roles}`
  (les autres rôles, pour les relais).
- **Remplacer un rôle** : panneau Modèles, carte « Rôles de l'assistant » ; ou un fichier
  `STUDIO_DATA_DIR/roles/<id>.md`. Un fichier avec un nouvel id ajoute un rôle (24 au plus).
  « Rétablir la consigne d'origine » retire le remplacement. Un remplacement cassé (en-tête faux, outil
  inconnu) retombe sur le rôle livré.

## Un tour

`POST /api/chat` `{conversation?, text, attachments: [refs], role?, answer_to?, lang}` répond par
des événements server-sent :

| Événement | Sens |
|---|---|
| `conversation` | Id et titre ; le message de l'utilisateur tel qu'enregistré (pièces jointes numérotées A1, A2…) |
| `role` | Le rôle qui répond (`changed: true` quand il change, `auto`, `goal` pour un relais) |
| `text` | Un morceau de la réponse |
| `card` | Une carte (voir plus bas) |
| `error` | Le LLM a échoué (pas téléchargé, pas lancé…) |
| `done` | Fin du tour |

1. **Routage** : sauf si l'utilisateur a choisi un rôle (`role`) ou répond à une carte question
   (`answer_to`), un court appel JSON (`{"role", "confidence"}`, température 0) choisit le rôle.
   Le rôle courant garde la conversation quand la confiance est sous 0,5.
2. **Réponse** : les consignes du rôle (bloc commun + rôle) et l'historique partent vers Gemma
   avec les outils du rôle ; la réponse arrive en flux. Les images jointes au dernier message vont
   à la vision de Gemma (4 au plus).
3. **Cartes** : chaque appel d'outil devient une carte ; ses arguments sont vérifiés
   (`assistant/tools.py` `normalize`) : valeurs par défaut remplies, valeurs hors bornes ramenées
   avec un avertissement affiché sur la carte, ids d'images inconnus signalés. Un appel qui ne
   peut pas devenir une carte (prompt manquant…) est écarté et Gemma apprend pourquoi au tour
   suivant. Gemma écrit parfois un appel en JSON dans son texte au lieu d'appeler l'outil (un
   bloc comme `{"type": "video_from_image", "props": {…}}`) : quand la réponse n'a aucune carte,
   un tel bloc qui nomme un outil du rôle devient cette carte et sort du texte
   (`text_tool_calls`) ; la consigne l'interdit aussi.
4. **Relais** : l'outil `handoff` passe la conversation à un autre rôle, qui répond dans le même
   tour (une fois par tour).

Les conversations sont des fichiers JSON dans `STUDIO_DATA_DIR/chats/` (`GET/DELETE
/api/chats/{id}`, `GET /api/chats`).

## Cartes

| Outil | Carte | Ce que lance Générer |
|---|---|---|
| `create_image` | Prompt, moteur (Krea 2 / Qwen Image 2.1), ratio, variantes, style | `krea2-t2i` ou `qwen-image-2.1`, comme le formulaire Text2Image |
| `edit_image` | Consigne, image d'entrée, références, marchés | édition `qwen-image-2.1`, un job par marché, comme Image2Image |
| `character_sheet`, `location_sheet` | Description, type de sujet, style ; une photo du sujet (planche sujet seulement) | `krea2-t2i` 1920×1088 avec les gabarits de planche de la 1.4 ; avec une photo, `qwen-image-2.1` la transforme en planche à la même taille, le gabarit précédé d'une phrase d'identité sur `<image1>` (`charsheetFromPhotoPrompt`, pas encore qualifié). Quand Gemma omet la photo alors que le message de l'utilisateur porte une seule image, cette image sert de photo (avec un avertissement sur la carte). Le menu du sujet du réalisateur a la même action : « 📷 Planche depuis une photo » |
| `video_from_text` | Prompt, durée, ratio | `h3-t2v` |
| `video_from_image` | Prompt, première image, dernière image facultative, durée | `h3-i2v` (I2VA ou FL2VA) |
| `image_sequence` | Prompt, 2 à 6 images clés, durée des segments | la séquence multi-images (segments H3, puis `video-concat`) |
| `join_videos` | Clips | `video-concat` |
| `campaign` | Brief, variantes, durée, style | la campagne complète (affiches, miniatures, image sociale, teaser) |
| `storyboard` | Brief et réglages | le réalisateur : « Lancer le Réalisateur » passe au Studio, remplit le formulaire et y lance la revue étape par étape, comme le fait Générer dans le formulaire |
| `reference_video` | Brief, références avec chacune son rôle, durée, ratio : jusqu'à 9 images (personnage, décor, objet), 3 vidéos (mouvement de caméra et rythme, ou personnage, décor, objet) et 3 sons (voix d'un personnage, musique, ambiance et bruitages), 12 en tout ; musique demandée en mots (facultative) | « 🎞 Générer la vidéo » : un job `h3-r2v` depuis la carte. Chaque référence reçoit son repère H3, numéros donnés par l'app (`P.h3AssignRefs`) : un sujet est `<Subject N>` dans son ordre ; une vidéo gardée pour son mouvement de caméra reste `<Video N>`, un son `<Audio N>`. Le brief nomme les références par leur id (`A1 rides…`), chacun remplacé par son repère ; la vision de Gemma décrit chaque image pour `subject_definitions`, et le bloc Ref2VA à six champs est construit par `buildH3RefPrompt`, comme dans le réalisateur : une voix est le timbre du n-ième personnage (`(S1)`…), une musique est reprise comme partition (`non_diegetic_music`), une ambiance guide `overall_soundscape`, le champ musique de la carte va dans `non_diegetic_music` (sinon « None. »), et le résumé ajoute `audio reuse` ou `audio reference` (guide « full-reference » de MiniMax). On peut retirer des références, ou en ajouter depuis les images et vidéos de la conversation ou l'ordinateur. Gemma ne propose que des images et des vidéos ; les sons viennent de l'ordinateur. « Lancer le Réalisateur » et « Ouvrir dans le Studio » ouvrent toujours la revue étape par étape, chaque référence gardant son rôle |
| `ask_choices` | Une question avec 2 à 4 boutons et « Autre… » | rien : le choix part comme réponse de l'utilisateur |

- Une carte ne tourne **que sur le clic de l'utilisateur**, par les mêmes fonctions que le
  formulaire du Studio (`web/js/generate.js`) : ce qu'une carte soumet est ce que le formulaire
  soumettrait.
- Pendant son rendu, une carte montre son avancement : une barre (la moyenne de ses jobs), les
  jobs terminés, le temps écoulé depuis le clic et le dernier message du moteur (téléchargement
  d'un modèle, une étape…). Ses jobs sont marqués de l'id de la carte à l'envoi (`withJobTag` dans
  `web/js/ui.js`).
- Le prompt et les réglages d'une carte se modifient avant Générer ; ✨ Enrichir réécrit le prompt
  de la carte avec la consigne Gemma propre au moteur (`Prompts.briefEnrichSystem`), avec
  Annuler.
- « Ouvrir dans le Studio » passe au Studio et remplit le formulaire (pipeline, moteur, réglages,
  images, brief), sans rien lancer ; Annuler remet le brief et le pipeline.
- « Lancer le Réalisateur » (cartes storyboard et référence vers vidéo) remplit le formulaire de
  la même façon, puis son clic vaut le clic sur Générer : la première étape du réalisateur démarre
  et chaque étape suivante attend l'accord de l'utilisateur, comme toujours.
- Une carte storyboard porte les planches que la conversation contient déjà (`subject_sheets`,
  sujet principal en premier, et `setting_sheet`). Le formulaire les liste sous « Planches venues
  de l'assistant » (✕ en retire une) ; le réalisateur les garde comme variantes importées, fait
  lire chacune par Gemma (vision) pour remplir ses champs, et ne dessine que les planches qui
  manquent. Avec plusieurs sujets, chaque plan part avec les deux premiers.
- Le navigateur signale ce qu'est devenue une carte (`POST /api/chats/{id}/cards/{card}` : en
  cours avec les réglages utilisés, terminée avec ses fichiers, erreur, annulée, ouverte, réalisateur
lancé). Les
  tours suivants le voient : les résultats prennent les ids **C3#1, C3#2…** (un clip H3 est suivi
  de sa dernière image, C3#2), que les cartes suivantes peuvent utiliser. Une carte qui a besoin
  d'un résultat pas encore rendu attend (« En attente de C3#1 »).

## Pas encore

- Le Canvas n'a pas encore d'assistant ([ROADMAP.md](ROADMAP.md)).
- Appels d'outils, vitesse et mémoire à côté de H3 sont à vérifier sur le GB10 avec le modèle
  26B ; le fichier de brouillon MTP facultatif du dépôt GGUF (décodage plus rapide) n'est pas
  utilisé.
