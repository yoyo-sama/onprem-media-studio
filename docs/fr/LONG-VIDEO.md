# Vidéo longue : repartir d'une feuille blanche

État : proposition (2026-11-19). Rien n'est encore implémenté.

## Objectif

L'objectif du propriétaire pour les vidéos longues, inchangé :

- des vidéos d'une minute ou plus, faites de segments H3 de 10 s ;
- les sujets référencés restent les mêmes du début à la fin (visage, cheveux, coupe,
  carrure, anatomie, vêtements), avec ou sans image de référence, et la scène aussi ;
- le moins d'interaction possible : brief → durée → un clic ; aucune étape de validation, tous
  les contrôles tournent dans la chaîne ;
- un code simple : pas d'empilement de cas particuliers.

## Ce qui a été essayé (GB10 promaxgb10-95c7, du 2026-11-14 au 19)

Tous les chiffres viennent de rendus réels (images et son inspectés).

| Méthode | Raccords | Identité sur 50 s | Cadrage / mouvement | Coût pour 50 s |
|---|---|---|---|---|
| **A. Chaîne simple** : plan Qwen tiré de la planche, puis 5 × `h3-i2v` depuis la dernière image du clip précédent (PR #39, « relay50 ») | propres | le visage dérive après 5 à 9 s (yeux plus clairs à 9 s) : l'i2v ne voit jamais la planche | naturel, H3 décide | 50 min |
| **B. Ref2VA + image de départ + planches** (PR #41) | **7 clips sur 11 lâchent leur image de départ** (1 à 2 images dessus, puis une coupe) ; déterministe selon la graine | tenue | recomposé quand l'image du lieu cadre autrement | ~55 min |
| **C. Images clés + FL2VA** (PR #43, 6 rendus) : Qwen dessine l'instant final de chaque segment à partir des planches, `h3-i2v` va d'une clé à l'autre | 24 sur 24 exacts (2,9 à 4,4 ; un raccord cassé dépasse 25) | tenue : chaque clé repart de la planche | **va-et-vient et coupes** dès que le cadrage d'une clé diffère de ce que demande le texte | 61 à 67 min |

Ce que C a appris, en détail :

- Qwen dessine le sujet deux fois quand les poses de la planche passent dans la scène (2 rendus
  sur 3) ou quand il retouche la clé précédente (1 retouche sur 2). Le comptage des personnages
  par la vision de Gemma le détecte à chaque fois (36 sur 36 au banc) : un redessin corrige.
- Qwen garde le cadrage de l'image donnée comme référence de lieu. Il a ignoré « medium shot »,
  « waist-up », « framed from the waist up », « bottom edge of the frame at the waist » (0 sur
  8). Seul un plan serré nommé avec « the camera close to her face » l'a fait bouger (6 sur 6).
  La même clé « plan moyen » est sortie en pied à un rendu et aux genoux au suivant.
- Chaque défaut visible de C venait d'un désaccord entre la clé et le texte vidéo : un
  rapprochement écrit vers une clé sortie en pied faisait avancer H3, puis revenir en arrière ou
  couper net à 9 s. Gemma jugeant les valeurs de plan d'après les images faisait pire que le
  plan prévu (12 mouvements justes sur 20, contre 9 sur 10).
- Le résultat changeait d'un rendu à l'autre avec le même code, parce que le découpage, les
  clés et le texte réécrit sont trois paris enchaînés. Chaque correction déplaçait la panne.
- Son : sans musique, H3 rend une ambiance faible (−25 à −52 LUFS, très inégale) ; ramener
  chaque clip à −18 LUFS sous un limiteur de crête vraie marche (−18,3 LUFS, −0,5 à −0,7 dBTP).
- Coût : H3 décharge Qwen, chaque clé le recharge (environ 85 s chacune).

## Leçons pour la nouvelle conception

1. **Une seule image de départ ne suffit pas comme contexte.** Un clip i2v repart d'une image :
   il ne voit ni où le sujet allait, ni la planche ; le mouvement saute aux raccords (vitesse,
   direction) et l'identité dérive.
2. **Ne jamais laisser deux consignes se contredire.** C a échoué là où une image et un texte
   donnaient à H3 deux cadrages différents. La nouvelle conception donne à H3 une seule source
   cohérente par décision.
3. **Moins de paris de modèles enchaînés.** Chaque étape qui dépend de Gemma ou de Qwen pour
   atteindre une cible (valeur de plan, nombre de personnages, action réécrite) multiplie le
   taux d'échec sur plusieurs minutes.
4. **L'identité a besoin de la planche en vue tout du long**, pas seulement au début d'un clip.
5. **Ce qui marche reste** : des raccords exacts sont possibles (lignes FL2VA à l'image 0), le
   comptage des personnages est fiable, le relèvement du niveau de la prise marche, et le
   correctif de l'image de départ (`h3_start_frame.py`) prouve qu'on sait placer des lignes de
   conditionnement où l'on veut dans la disposition de FastVideo.

## Méthodes candidates

### 1. Continuation latente (recommandée en premier)

La méthode habituelle des vidéos longues, et celle vers laquelle la communauté H3 a convergé en
2026 : au lieu d'une image décodée, le clip suivant reçoit **les dernières images latentes du
clip précédent, vidéo et son**, comme ses premières images, puis ces images en recouvrement sont
retirées de la sortie. H3 voit le mouvement déjà en cours : vitesse, direction, mouvement de
caméra et son passent le raccord ; pas d'aller-retour par le VAE, donc pas de perte de qualité à
chaque maillon. L'identité vient des planches des sujets, données en références Ref2VA à chaque
clip.

Ce que rapportent les implémentations de la communauté (lues pour leur mécanique seulement ;
leur code n'est pas copié, plusieurs sont sous GPL-3.0) :

- une queue de 5 images latentes ancrée à l'image 0 comme image clé native de H3, retirée après
  décodage ; continuité au raccord 0,96, mais en Ref2VA pur le cadrage dérive vers
  `<Picture 1>` après 1 à 2 s quand l'image cadre autrement ([mark9009/ComfyUI-H3-LongTake](https://github.com/mark9009/ComfyUI-H3-LongTake), MIT) ;
- 22 ou 39 images latentes de vidéo et de son comme guide à l'image 0, consignes découpées par
  horodatage ([palealloy2999-prog/ComfyUI-MiniMax-H3-Long-Video](https://github.com/palealloy2999-prog/ComfyUI-MiniMax-H3-Long-Video), GPL-3.0) ;
- un « contexte de mouvement » tiré des clips validés, avec des références par clip
  ([tritant/ComfyUI_MiniMax_H3_Extender](https://github.com/tritant/ComfyUI_MiniMax_H3_Extender), Apache-2.0) ;
- 22 images de contexte, un pont de 2 images, un fondu vidéo de 4 images, un fondu son de 15 ms,
  7 clips ≈ 61 s sans retouche, en FL2VA, avec la remarque que H3 « atteint souvent la dernière
  image trop tôt et se fige » ([comfyui-wiki, Infinite Continuation Suite](https://comfyui-wiki.com/en/news/2026-08-11-h3-infinite-continuation-suite)).

Ce que ça retire du Relay actuel : les images clés, le rechargement de Qwen à chaque segment,
le plan des valeurs de plan, la réécriture du mouvement, le contrôle des raccords. Ce qui reste :
le découpage en actions minutées (un texte par 10 s, sans cible de valeur de plan), les
planches, le comptage des personnages sur la première image, le niveau de la prise.

Questions à trancher sur le GB10 avant toute interface :

- FastVideo expose les dispositions Ref2VA et FL2VA ; notre correctif de disposition peut-il
  placer N images latentes de vidéo **et de son** aux premières images de la cible (le même
  mécanisme que `h3_start_frame`, étendu d'une ligne d'image à une queue latente) ?
- Quel checkpoint : OmniRef a tenu l'identité avec le correctif de l'image de départ, V2 a
  dessiné un second sujet à partir d'une planche (2026-11-16).
- Combien d'images : 5 contre 22 (mouvement transmis contre liberté laissée à la nouvelle
  action).
- La planche tire-t-elle encore le cadrage vers elle (la dérive rapportée plus haut) ? Si oui,
  une planche neutre en cadrage (la planche à cinq vues de la PR #38) ou un poids de référence
  plus faible.

### 2. Chaîne simple, visage réancré

La méthode A, appréciée du propriétaire, plus une correction d'identité : à chaque segment (ou
tous les N), l'image de transition reçoit une petite retouche Qwen au même cadrage, qui ne
rétablit que le visage et les cheveux d'après la planche. Peu coûteux et proche de l'existant,
mais le raccord reste sur une seule image (le mouvement peut sauter) et on ajoute un pari Qwen
par segment.

### 3. RefMods pour l'identité

Un RefMod est la planche encodée une fois par le VAE de H3 en un petit adaptateur latent
(~1 Mo), injecté par le même chemin de jetons de référence que les images Ref2VA. Plus léger
que des images brutes et réutilisable d'un clip à l'autre ; pas plus fidèle en soi (leurs
auteurs mettent encore une LoRA en premier pour la ressemblance). Un complément de la méthode 1
(des références plus légères par clip), pas une méthode de vidéo longue à lui seul. Voir
[Luisacaotica/ComfyUI-MiniMaxH3Mod](https://github.com/Luisacaotica/ComfyUI-MiniMaxH3Mod),
[RefMods contre images de référence](https://huggingface.co/datasets/malcolmrey/various/blob/main/h3-center/docs/MINIMAX_REFMODS_VS_REFERENCE_IMAGES.md).

### 4. LoRA de personnage (plus tard, en option)

Le levier d'identité le plus fort selon toutes les sources, mais il faut un court entraînement
par personnage : contraire à la règle du « un clic », sauf s'il tourne dans la chaîne. Gardé
comme option ultérieure.

## Plan

Chaque étape a un critère d'arrêt fixé avant de commencer ; une étape qui le manque est
abandonnée, pas rafistolée.

1. **Faisabilité, par script, sans interface** (GB10, appels d'API seulement) : deux clips de
   10 s enchaînés avec une queue latente de 5 puis de 22 images, planche en référence Ref2VA.
   Arrêt si le raccord n'est pas exact (écart au-dessus de 10) ou si le second clip perd le
   mouvement du premier.
2. **Cinq clips, 50 s**, le scénario et la planche de relay50 : un seul sujet du début à la fin,
   le visage de la planche à 0, 25 et 50 s, le même jardin, aucune coupe, aucun va-et-vient.
   Arrêt si l'identité ou la scène dérive plus qu'avec la méthode A.
3. **Interface** : le plan-séquence devient brief → durée → un clic sur ce pipeline ; les
   chemins de l'ancien Relay qu'il remplace sont retirés dans la même PR.
4. **Plusieurs minutes** : une prise de 2 minutes pour mesurer la dérive sur 12 clips et le
   coût en temps.

Si l'étape 1 échoue, on essaie la méthode 2 avec les mêmes critères ; les RefMods sont essayés
dans la méthode qui passe, pour alléger les références.

## Intégration (PR #44, 2026-11-20)

Le remplacement annoncé par le plan, avec la seule queue vidéo (étape 2b). Le parcours reste
brief → durée → un clic.

- **Serveur.** Chaque clip H3 (`h3-t2v`, `h3-i2v`, `h3-r2v` sauf son aperçu) garde ses latents
  vidéo finaux à côté de son MP4 : `<nom>.latents.safetensors`, normalisés pour le DiT, en
  float16, avec dans leurs métadonnées la taille du cadre, le nombre de latents et le clip qu'il
  continue (environ 25 Mo pour 10 s). `h3-r2v` prend `continue_from`, la référence du clip qu'il
  continue, au lieu d'`image` : le cadre est celui de ce clip, l'upscaler vise sa taille, et la
  préparation des latents de FastVideo est enveloppée (`studio/pipelines/h3_continue.py`) pour
  ajouter ses 7 derniers latents vidéo comme une référence vidéo muette dont les lignes prennent
  le temps des 7 premières images latentes de la cible. Aucun son n'est repris.
  `h3_start_frame.py` reste pour le premier segment d'un plan-séquence (une image de départ avec
  les planches). Un nouveau job GPU, `video-stitch`, assemble une prise : les clips rendus chacun
  avec `continue_from` le clip qui les précède dans la liste sont mis bout à bout en latents
  (chacun sans ses 7 premiers) et décodés d'un seul tenant par le VAE vidéo d'OmniRef dans un
  tampon adossé à un fichier, si bien que les images d'une longue prise vont sur le disque plutôt
  qu'en mémoire ; tout autre clip est une coupe, pris tel qu'en son MP4. Le son est celui de
  chaque clip, coupé là où l'est son image (22 images après le début d'un clip qui continue),
  porté à -18 LUFS, avec un fondu de 25 ms à chaque raccord et un limiteur de crête vraie à
  -2 dBFS (`montage.assemble`, le nivellement de la PR #43, sa limite baissée de 1 dB parce que
  les prises mesuraient +0,2 puis -0,9 dBTP après l'AAC).
- **Interface.** Un segment continu qui a les planches des sujets envoie `continue_from` (le
  clip du segment précédent) et aucune image de départ ; il ne fait extraire aucune image de
  transition pour lui, et sa carte n'en propose aucune. Le contrôle des raccords (`joinGap`,
  « raccord cassé ») disparaît. Un segment continu sans planche, ou avec une image de fin
  (FL2VA), part toujours de l'image de transition du segment précédent (i2v) ; les coupes ne
  changent pas et n'extraient les images du segment précédent que lorsqu'il leur en faut une
  comme décor. La chaîne, et « Assembler », se terminent par `video-stitch`.
- **Tests.** `tests/test_h3_continue.py` : l'arithmétique des latents, les métadonnées, les
  paramètres d'un clip qui en continue un autre, le son de la prise assemblée en phase avec son
  image (vrai ffmpeg, décodage remplacé), et le correctif de la préparation des latents sur des
  modules FastVideo de substitution. `tools/relay-ui.js` vérifie la chaîne de jobs. Un rendu de
  50 s depuis l'interface sur le GB10 la qualifie.

## Fichiers de scénario, départ sur texte et assistant (2026-11-20)

Trois ajouts demandés par le propriétaire le 2026-11-20, tous sur le même parcours (brief →
durée → un clic), pas encore rendus sur le GB10.

- **Fichier de scénario.** Un scénario au format H3 que le propriétaire utilisait déjà à la main
  pour relay50 (`subject_definitions:`, `summary:`, `retention_analysis:`, `camera_direction:`,
  `lighting:`, `detailed_description:` qui contient des lignes `[Shot N]` et des lignes
  `Segment N (00:00.000–00:10.000) – Titre` suivies chacune de son action,
  `overall_soundscape:`, `non_diegetic_music:`) est lu tel qu'il est écrit par
  `parseScreenplay` (`web/js/prompts.js`) : sans Gemma. Une carte par segment, sa durée tirée des
  horodatages (ramenée entre 5 et 15 s ; sans horodatage : le maximum par segment), le premier
  segment d'un plan suivant en coupe, la ligne du plan après l'action de son premier segment ;
  camera_direction → Cadrage, lighting → Lumière, overall_soundscape → Ambiance sonore,
  non_diegetic_music → Musique (N/A, None : pas de musique). Deux champs communs ont été ajoutés
  pour cela : **Sujets** (`subject_definitions`) et **Identité à garder**
  (`retention_analysis`), écrits mot pour mot après les lignes que l'app écrit à partir des
  références (sans référence, ce sont le champ entier). Vides, chaque prompt est celui envoyé
  avant. Horodatages et lignes de champ sont facultatifs : un fichier fait des seules lignes
  `[Shot N]` donne un segment par plan. Un fichier en prose libre est le scénario que Gemma
  découpe, comme avant. L'import est dans le formulaire (📄 Importer un scénario met le fichier
  dans le brief ; l'enrichissement automatique ne réécrit jamais un tel brief) et dans le Relay
  (📄 Importer, ou ✨ Découper sur un scénario collé). Le résumé et la ligne du premier plan
  décrivent la prise pour l'image de plan composée à partir d'une planche de départ.
- **Une scène décrite plutôt qu'un sujet.** Un scénario à ce format qui ne nomme aucun
  `<Subject N>` décrit une scène : son image de départ (ou, sans image, la dernière image du
  segment 1) est envoyée comme référence du lieu (`<Subject 1> is the location as defined by
  <Picture 1>`), pas comme personnage principal. La règle du propriétaire (2026-11-20) : sans
  image de référence, une image de départ est la première image, et la scène part d'elle et la
  respecte ; sans aucune image, le modèle vidéo crée la scène de départ. Le segment 1 d'une scène
  décrite démarre donc sur son image en image vers vidéo H3 (`h3-i2v`, l'image en `<Picture 1>`
  et comme lieu), et les segments suivants le continuent avec l'image comme référence de lieu.
  Le Ref2VA avec image de départ, essayé d'abord, gardait un jardin vide 2 images, puis coupait
  vers un autre cadrage où la femme décrite par le scénario était déjà là. Une planche contient
  toujours un sujet, et un scénario en prose libre garde l'image de départ comme personnage
  principal, comme avant.
- **Sans image de départ.** Le segment 1 est du texte vers vidéo H3 (`h3-t2v`) avec le même bloc
  à six champs sans référence (`buildRelayTextPrompt` : pas de `<Picture N>`, pas d'étiquette de
  tâche), au format que montre sa carte. H3 garde sa dernière image et ses latents comme pour
  tout clip : la dernière image devient l'image de départ du plan-séquence pour les segments
  suivants, qui le continuent avec `continue_from` comme le fait un plan-séquence à partir d'une
  photo. Régénérer le segment 1 remplace cette image.
- **L'assistant.** Sa carte `image_sequence` rendait des paires d'images clés une à une et les
  joignait avec `video-concat` : elle n'utilisait jamais le plan-séquence. Elle est remplacée par
  `long_take` (scénario au format ci-dessus, 0 à 6 images) : « 🎞 Ouvrir le plan-séquence »
  passe dans le Studio et ouvre le Relay sur ses segments, sans rien générer ; la chaîne se lance
  de là. Le Canvas l'aura plus tard.

Rendus sur le GB10 (promaxgb10-95c7, 2026-11-20) :
- Le fichier jardin du propriétaire sans image, 5 × 10 s : segment 1 à partir du texte 617 s,
  continuations 441/300/305/310 s, assemblage 245 s ; 47 s en 1280×736, -18,4 LUFS. Une seule
  femme, même visage, mêmes cheveux et même tenue du début à la fin, les cinq actions dans
  l'ordre, aucune coupe trouvée (détection de scène ffmpeg à 0,15).
- Une scène décrite (une femme décrite en mots, un jardin vide de Krea 2 comme image de
  départ), 4 × 10 s, segment 1 démarré sur l'image : 37,8 s, -18,1 LUFS, le jardin et la femme
  tiennent aux trois raccords, mais une coupe à 0,08 s (voir plus haut ; la fontaine change
  aussi de forme au segment 3). Le segment 1 démarre désormais sur l'image en i2v.
- Reste à rendre : ce départ en i2v, le même fichier avec une image de départ, et une première
  image créée par un moteur d'image (MOSS-Image ou Qwen Image 2.1) à partir du scénario quand il
  n'y a pas d'image, à comparer au texte vers vidéo H3.

## Résultats

### Étape 1, continuation latente (GB10, 2026-11-19)

Comment FastVideo dispose une requête H3 : une seule séquence [texte | lignes de condition |
son cible | vidéo cible] sur une horloge commune à la vidéo et au son. Ref2VA donne à chaque
référence une place d'horloge avant la cible ; les lignes de condition sont bruitées une fois à
0,999 et jamais débruitées : la cible se débruite face à elles telles quelles. 243 images font
72 latents vidéo (un latent couvre 1 ou 4 images selon un cycle 1, 4, 4, 4, 4) ; le son compte
40 latents par seconde.

Test : clip 1 = le `h3-i2v` actuel depuis une image de plan, ses latents finaux gardés. Clip 2
= `h3-r2v` sur OmniRef avec la planche, plus les 7 derniers latents vidéo du clip 1 (22 images)
et 37 latents son (0,93 s) ajoutés comme une condition de plus dont les positions sont
réécrites sur les premiers latents de la cible (un correctif de la préparation des latents,
comme `h3_start_frame.py`) ; le recouvrement est retiré après décodage.

- Le clip 2 a continué le clip 1 : même marche, même caméra qui suit, aucun gel, texte du
  segment 2 suivi, une seule femme avec l'identité de la planche, le même jardin, aucun clic.
  Le clip 2 a pris 304 s (deux passes).
- Décodés séparément, le raccord mesurait 15,2 (critère d'arrêt : 10) : le VAE de H3 est causal
  dans le temps, et les mêmes latents se décodent autrement sans l'historique du clip précédent.
- Recollés en latents (72 + 65 latents vidéo, toujours sur la grille ; latents son de même) et
  décodés d'un seul tenant (96,6 s pour 464 images, pic de 57 Gio) : le raccord mesurait 7,3
  (critère : 7), sans pic nulle part, contre des pas d'image à image de 2,8 en médiane et 8,2 au
  plus dans le clip 1. Continu à l'œil ; le léger pas vient sans doute du texte du nouveau
  segment qui s'applique d'un coup (l'expression change).
- L'ambiance du clip 2 est environ 12 LU plus faible : générée ainsi, pas une couture de
  décodage ; le passage de niveau de la prise s'en charge.

### Étape 2, une prise de 47 s (GB10, 2026-11-19)

Cinq clips du scénario relay50 : clip 1 en `h3-i2v`, clips 2 à 5 en `h3-r2v` sur OmniRef avec
la planche et une queue de 7 latents du clip précédent (vidéo et son), tous les latents recollés
(72 + 4 × 65 = 332, sur la grille) et décodés d'un seul tenant : 1127 images, 46,96 s (cinq
clips de 10,1 s moins quatre recouvrements de 0,92 s). Environ 35 min en tout, contre 50 min
pour les 50 s de relay50.

- Raccords : 7,3, 10,1, 6,3, 10,6 (critère d'arrêt : 10), contre une médiane de 3,1 et un
  maximum de 9,6 à l'intérieur des clips. Les deux plus grands tombent là où le nouveau texte
  lance un geste (un demi-tour, une main levée). Ni coupe ni fantôme : un seul plan continu à
  l'œil.
- Identité : une seule femme du début à la fin, visage, cheveux et tenue de la planche à 0, 25
  et 47 s, gros plan final compris. relay50, aux mêmes instants, avait changé la tenue et
  montrait une partie d'un second visage au bord du cadre.
- Scène : un seul jardin, qui évolue avec les textes (allée d'arbustes, chemin de lupins, un
  cerisier) ; il ne dérive pas plus que celui de relay50.
- Son : il s'éteint de clip en clip (−32, −43, −46, −58, −59 LUFS) ; chaque clip reprend la fin
  sonore du précédent, en plus faible. Remède non testé : ne transmettre que la queue vidéo,
  laisser le son de chaque clip repartir à neuf, lisser les raccords sonores au montage.

### Étape 2b, la queue vidéo seule (GB10, 2026-11-20)

La même prise avec les clips 2 à 5 refaits, les 7 latents vidéo du clip précédent comme seule
queue (aucune ligne de son), 33 min en tout :

- Raccords 7,7, 8,2, 7,3, 3,7, tous sous 10 et sous le 99e centile des pas d'image à image
  dans les clips (10,2). Une seule femme, l'identité de la planche jusqu'au gros plan final, le
  même jardin.
- Le son de chaque clip repart à neuf et suit l'action (pas à cadence de marche quand elle
  marche, presque rien quand elle s'arrête, des oiseaux à la fin), sans s'éteindre d'un clip à
  l'autre. Mais l'ambiance Ref2VA de H3 reste très faible sur 3 clips sur 5 (−49, −53, −51 LUFS ;
  critère d'arrêt −45), comme mesuré le 2026-11-16. Le son propre de chaque clip ramené à
  −18 LUFS au montage (`smooth_audio`) donne une prise égale à −18,1 LUFS sans clic ; le
  relèvement fait monter le bruit de fond des clips faibles. Un seul décodage du son recollé
  restait inégal et plus faible.

### Étape 3, l'application elle-même (GB10, 2026-11-20)

La PR #44 (ac35711) construite sur promaxgb10-95c7, la même prise envoyée par l'API HTTP comme
le Relay l'envoie : le segment 1 en `h3-r2v` avec son image de départ et la planche (celui de
take50a était en i2v), les segments 2 à 5 en `continue_from` du clip précédent, puis
`video-stitch`. 31,4 min en tout : 290 à 320 s environ par clip, 224 s pour l'assemblage
(1127 images, 332 latents décodés d'un seul tenant en 214 s). Chaque clip a gardé 12,7 Mo de
latents.

- Aucune erreur de job, liens `[true, true, true, true]`, 1127 images (243 + 4 × 221), 46,98 s.
- Raccords à 6,7, 13,2, 14,0 et 11,4 : trois au-dessus du critère d'arrêt de 10. Cette prise
  bouge plus que take50a à l'intérieur même de ses clips (écarts d'une image à l'autre :
  médiane 3,4, 99e centile 11,2, maximum 18,3, contre 3,1, 10,2 et 13,9), et les raccords élevés
  tombent là où l'image bouge vite aussi après le raccord (5 à 11 sur les images suivantes). À
  l'œil chaque raccord est continu : ni coupe, ni fantôme, ni arrêt sur image, le geste continue.
- Une seule femme sur les 24 images prises toutes les 2 s, l'identité de la planche jusqu'au
  gros plan final ; un seul jardin qui avance avec les textes, aucun saut de lieu à un raccord.
- Son à -18,1 LUFS (clips entre -50 et -57 LUFS avant nivellement), aucun clic aux raccords,
  crête vraie à -0,9 dBTP : 0,1 dB au-dessus du critère. Le limiteur passe à -2 dBFS.
- Avis du propriétaire sur la prise (2026-11-20) : « ce n'est pas parfait mais le résultat est
  satisfaisant ». Le critère absolu de 10 pour un raccord ne convient pas à une prise qui bouge
  autant ; les raccords ont été jugés à l'œil.
