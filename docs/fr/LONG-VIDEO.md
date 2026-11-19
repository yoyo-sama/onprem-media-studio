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

## Plan d'intégration (une fois le son réglé)

Le Relay de `main` rend déjà un segment continu en `h3-r2v` avec les planches plus une image de
départ (`image`, placée à l'image 0 par `h3_start_frame.py`) ; c'est cette image de départ qui a
cassé 7 fois sur 11. Le changement est un remplacement, pas une nouvelle fonction :

- **Serveur** : chaque clip H3 garde ses latents finaux vidéo et son à côté de sa sortie.
  `h3-r2v` prend `continue_from` (la sortie du clip précédent) au lieu d'`image` : ses 7 derniers
  latents vidéo (et son, selon le test du son) deviennent des lignes de condition aux premières
  positions de la cible, par un correctif de la préparation des latents (`h3_continue.py`, qui
  remplace `h3_start_frame.py`). Un nouveau job `video-stitch` recolle les latents d'une chaîne
  (chaque clip sans son recouvrement) et les décode d'un seul tenant avec les VAE de H3, puis
  passe le niveau de la prise.
- **Interface** : un segment continu envoie `continue_from` au lieu de son image de départ ; une
  chaîne de segments continus est montée par `video-stitch` au lieu de `video-concat`. Le
  contrôle des raccords (`joinGap`, « raccord cassé ») disparaît, comme les images de transition
  des segments continus. Les coupes restent telles quelles. Le parcours reste brief → durée →
  un clic.
- **Tests** : tests unitaires de l'arithmétique des latents (recouvrement, grille, positions)
  sans GPU ; le test d'interface du Relay vérifie la chaîne de jobs ; un rendu 50 s depuis
  l'interface sur le GB10 la qualifie.

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
