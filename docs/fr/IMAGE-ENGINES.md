# Moteurs d'image

Version anglaise (de référence) : [../IMAGE-ENGINES.md](../IMAGE-ENGINES.md). Leçons derrière
chaque règle : [LESSONS.md](LESSONS.md) § 4–5.

Deux moteurs, chacun un pipeline de job (`studio/pipelines/`), tous deux sur diffusers 0.42.1 avec
les poids officiels. Qwen-Image-Edit 2509 a été retiré le 2026-10-29 (pas requis) : Qwen Image 2.1
couvre toutes les retouches que la 1.4 faisait avec 2509.

| Id du pipeline | Modèle (id catalogue) | Classe diffusers | Réglages fixes |
|---|---|---|---|
| `krea2-t2i` | Krea 2 Turbo (`krea2-turbo`) | `Krea2Pipeline` | 8 étapes, `guidance_scale=0` |
| `qwen-image-2.1` | Qwen Image 2.1 (`qwen-image-2.1`) | `QwenImage21Pipeline` | 25 étapes, `true_cfg_scale=1`, images de condition à 1024 |

Ce sont les réglages qualifiés en 1.4 (`workflows/api/krea2_t2i.json`, `qwen21_*.json`). Étapes et guidance ne sont pas des paramètres : un modèle distillé casse
d'abord la colorimétrie quand on lui retire des étapes (LESSONS n°2), et personne n'a demandé à
les régler.

Un seul moteur reste en mémoire GPU : lancer un job sur un autre moteur décharge le précédent.

## Partage du travail avec le front end

Le backend exécute des prompts finaux. Les compiler (gabarits de planche, bloc d'ancrage des
keyframes, texte de style, suffixes de campagne, enrichissement Gemma) revient au front end
(ADR 0001), porté depuis le `js/engine.js` de la 1.4 à l'étape 4. Les moteurs portent ce qui est
vrai du modèle quel que soit le prompt :

| Règle (LESSONS) | Où elle est garantie |
|---|---|
| Rien ne part en rendu sans un clic (n°5) | Seul `POST /api/jobs` crée un job ; un envoi d'image n'en crée aucun |
| Prompt envoyé tel quel (n°6) | Les moteurs transmettent `prompt` intact : jamais rogné, réécrit ni complété |
| Krea 2 n'encode jamais de négatif (n°18) | `guidance_scale=0` (aucune passe non conditionnée) ; `negative` refusé en 422 |
| Pas de négatif avec Qwen à cfg 1 | Refusé en 422, plutôt qu'ignoré en silence |
| La planche du sujet est l'image 1 (n°21) | Forme plan `subjects` + `setting` : le moteur ordonne les entrées |
| La taille de sortie suit l'image 1 (n°21) | Calculée par le moteur depuis l'image 1 et passée explicitement (voir ci-dessous) |
| Deux sujets par plan au plus (n°24) | `subjects` prend 1 ou 2 planches |
| Bloc d'ancrage sur tous les chemins (n°7), décor nommé deux fois (n°22), pas de vocabulaire « storyboard » (n°20), gabarit de planche selon la nature du sujet (n°25) | Front end (compilateurs de prompt), étape 4 |

**Taille de sortie d'une retouche.** En 1.4, une retouche image vers image gardait le ratio de son
image d'entrée. diffusers calcule la taille de sortie d'après la **dernière** image par défaut,
c'est-à-dire, dans un plan, la planche du décor. Sans `width`/`height` explicites, le moteur
calcule donc lui-même la taille depuis l'image 1 : environ 1 Mpx à son ratio, multiples de 32 (la
formule de la 1.4 `round(sqrt(1024²·r)/32)·32`). Les plans reçoivent en général une taille
explicite (la 1.4 rendait ses keyframes Qwen 2.1 au ratio du plan, 1344×768).

## Images : envoi et références

```bash
curl -s --data-binary @photo.png localhost:8090/api/inputs
# {"ref": "inputs/3f9a…c1.png", "width": 1280, "height": 720}
```

Le corps est l'image brute (PNG, JPEG ou WebP, 50 Mo au plus). Les images envoyées sont rangées
sous une empreinte de leur contenu dans `<data>/input/`. Une **référence** est le chemin d'URL du
fichier sans la barre initiale : `inputs/<nom>` pour une image envoyée, `outputs/<chemin>` pour un
rendu (les `outputs` d'un job sont des références). Un plan peut donc utiliser directement les
planches rendues par des jobs précédents. Les références sont vérifiées à la soumission : un
fichier absent donne un 422, pas un job en erreur.

## Paramètres

Les paramètres inconnus sont refusés (422) : une faute de frappe ne passe jamais inaperçue.
`seed` est facultatif partout (0 à 2³²−1) ; absent, il est tiré à la soumission et conservé dans
les `params` du job. Chaque PNG porte le pipeline et les paramètres du job en JSON dans un bloc
texte `studio`.

### `krea2-t2i`

| Paramètre | Défaut | Règle |
|---|---|---|
| `prompt` | obligatoire | Tel quel |
| `width`, `height` | 1024 | 256–2048, multiple de 16 |
| `count` | 1 | 1 à 4 images d'une même graine (les « variantes » de la 1.4) |

### `qwen-image-2.1`

Sans image, c'est du texte vers image (`width`/`height` 1024 par défaut, `count` 1 à 4). Les
tailles sont des multiples de **32** (256–2048) : diffusers arrondit les tailles de la 2.1 au
multiple de 32 inférieur, 1280×720 sortirait donc en 1280×704 ; prendre 1344×768 pour du 16:9,
768×1344 pour du 9:16. Avec
`images` (1 à 10) ou la forme plan `subjects` (1–2) + `setting` + `references` (0 à 7 images en
plus après le décor, comme en 1.4 : 2 planches + 7), il retouche : `count` vaut 1, taille d'après
l'image 1 sauf si `width` et `height` sont donnés tous les deux. Le prompt cite les images
`<image1>`, `<image2>`… dans l'ordre des entrées.

## Les fonctions de la 1.4 sur ces moteurs

| Fonction 1.4 | Jobs |
|---|---|
| Text2Image | `krea2-t2i`, table de ratios 16:9 1280×720, 9:16 720×1280, 1:1 1024², 4:5 832×1040 ; ou `qwen-image-2.1` sans image, en multiples de 32 (16:9 1344×768) |
| Image2Image / localisation | `qwen-image-2.1` avec `images` (image d'entrée + jusqu'à 9 références) ; un job par marché |
| Images de campagne | `krea2-t2i` : affiche 832×1216 et vignette 1280×720 (variantes), réseau social 1024×1024 (1), graines `seed+200`, `+201`, `+202` ; le teaser vidéo arrive avec l'étape 3 |
| Planches sujet et décor | `krea2-t2i` en 1920×1088, une image chacune |
| Images des plans (keyframes) | `qwen-image-2.1` avec `subjects` = la ou les planches de sujet, `setting` = la planche du décor |

## Qualification

Un moteur n'est qualifié que par un vrai rendu dont les images ont été regardées (LESSONS n°1),
sur le GB10, face à la 1.4. `tools/qualify/image_cases.json` contient 12 cas construits par les
compilateurs de prompt de la 1.4 eux-mêmes (`node tools/qualify/export_1_4_prompts.js
../dellaicontent`) : Text2Image, les trois formats de campagne, planches humaine, non humaine et
décor, plans à un et deux sujets, image vers image avec et sans référence supplémentaire, et
texte vers image Qwen 2.1.

```bash
docker compose up -d --build
python tools/qualify/run_image_cases.py            # écrit qualify-images.json
```

Le script poste les cas un par un, comme le ferait un clic, en enchaînant les plans sur les
planches qu'il vient de rendre, et note statut, durée et URL des sorties. Ensuite, regarder chaque
image à côté du rendu 1.4 du même prompt, avec les contrôles de LESSONS n°2 (bords, dégradés,
saturation) et ceux-ci :

- planches : un seul sujet, rien d'écrit sur l'image, le lion à quatre pattes et sans vêtements
  (n°25) ;
- plans : l'identité et le costume du sujet tirés de la planche, le décor reconnaissable (n°22),
  un exemplaire de chaque sujet, pas de collage des planches (n°7), une image de film et non une
  planche (n°20) ;
- taille des plans : 1344×768.

Alors seulement, passer `"qualified": true` pour le modèle dans `studio/catalog.json`. Les
graines ne reproduisent pas les pixels de la 1.4 (autre runtime, autre format de poids) :
comparer la qualité, pas les pixels.

## Manques connus

- **Premier passage sur GPU (gb10-demo, 2026-10-29) :** tous les cas Krea 2 (7/7) et Qwen Image
  2.1 (4/4) ont rendu. `qualified` reste à `false` tant que les images n'ont pas été comparées à
  la 1.4 comme ci-dessus.
- **Chargement de LoRA sur NGC 25.11 :** peft 0.19 et plus refuse son torchao 0.14, peft est donc
  épinglé sous 0.19.
- **LoRA de style** (LoRA Krea 2 et de planche de la 1.4) pas encore portées.
- **Licence Qwen Image 2.1 :** Qwen Research License, usage non commercial uniquement. 2509
  (Apache-2.0) ayant été retiré, toutes les retouches et toutes les images de plan en dépendent.
