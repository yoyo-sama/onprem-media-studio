# Moteurs d'image

Version anglaise (de référence) : [../IMAGE-ENGINES.md](../IMAGE-ENGINES.md). Leçons derrière
chaque règle : [LESSONS.md](LESSONS.md) § 4–5.

Trois moteurs, chacun un pipeline de job (`studio/pipelines/`), sur diffusers 0.42.1 avec les
poids officiels. Qwen-Image-Edit 2509 a été retiré le 2026-10-29 (pas requis) : Qwen Image 2.1
couvre toutes les retouches que la 1.4 faisait avec 2509. MOSS-Image a été ajouté le 2026-11-07
pour le texte dans l'image (voir [MOSS-Image](#moss-image)).

| Id du pipeline | Modèle (id catalogue) | Classe diffusers | Réglages fixes |
|---|---|---|---|
| `krea2-t2i` | Krea 2 Turbo (`krea2-turbo`) | `Krea2Pipeline` | 8 étapes, `guidance_scale=0` |
| `qwen-image-2.1` | Qwen Image 2.1 (`qwen-image-2.1`) | `QwenImage21Pipeline` | 25 étapes, `true_cfg_scale=1`, images de condition à 1024 |
| `moss-image` | MOSS-Image SFT (`moss-image-sft`) + LoRA turbo (`moss-image-turbo-lora`) | `MOSSImagePipeline` (code du modèle) | selon `mode` : 4 ou 8 étapes avec la LoRA turbo sans guidance, ou 25 étapes en guidance 3 |

Krea 2 et Qwen Image 2.1 tournent avec les réglages qualifiés en 1.4 (`workflows/api/krea2_t2i.json`, `qwen21_*.json`). Étapes et guidance ne sont pas des paramètres : un modèle distillé casse
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

Le corps est l'image brute (PNG, JPEG ou WebP, 50 Mo au plus). Une vidéo (MP4, MOV, WebM) ou un
son (WAV, MP3, M4A, FLAC, Ogg), 200 Mo au plus, est aussi accepté, pour les références de
`h3-r2v` ([H3.md](H3.md)) : ffprobe le lit, et la réponse est `{"ref", "kind"}` (`kind` vaut
`image`, `video` ou `audio` ; la réponse d'une image donne aussi sa taille). Les autres moteurs
refusent une référence qui n'est pas une image. Les images envoyées sont rangées
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

### `moss-image`

Texte vers image seulement. `mode` choisit les étapes et la guidance, rien d'autre ne le fait :

| `mode` | Réglages | Banc GB10, 1024² |
|---|---|---|
| `preview` (Aperçu) | LoRA turbo, 4 étapes, guidance 1 (pas de passe négative) | environ 11 s ; le titre d'une affiche avait un mot doublé sur 2 graines sur 3 |
| `standard` (par défaut) | LoRA turbo, 8 étapes, guidance 1 | environ 19 s ; texte exact sur 3 graines sur 3, tire vers une lumière chaude de coucher de soleil |
| `quality` (Qualité) | SFT seule, 25 étapes, guidance 3, branche négative du modèle (prompt vide, bloc 22 sauté) | environ 72 s ; texte exact, lumière et ambiance les plus fidèles |

`width`, `height` 256–2048, multiples de 16 (1024 par défaut) ; `count` 1 à 4. Un `negative` est
refusé : la branche négative du mode Qualité fait partie des réglages du modèle. Le texte à écrire
se met entre guillemets droits dans le prompt ; le modèle lit aussi le prompt de mise en page JSON
officiel (une boîte par élément).

## MOSS-Image

`OpenMOSS-Team/MOSS-Image-SFT` (Apache-2.0) : un DiT à flux unique de 5,1 G paramètres en bf16
(10,2 Go), l'encodeur de texte Qwen3.5-9B (16,8 Go) et le VAE à petit décodeur de FLUX.2, environ
28 Go sur disque plus 1,2 Go pour la LoRA turbo (`akhaliq/MOSS-Image-SFT-4-steps`, fichier
`moss_image_sft_4step_v2.0.safetensors`, Apache-2.0). Pic mémoire au banc : 30 à 34,5 Go. Choisi
par le responsable du projet le 2026-11-07 après `tools/qualify/moss_bench.py` sur
promaxgb10-95c7 (Fizgig, KOOK, les LoRA DMD et Kromoss y ont été écartés).

- **Code.** diffusers 0.42 n'a pas de pipeline MOSS : `studio/pipelines/moss.py` importe
  `pipeline_moss_image.py` depuis le dossier du modèle téléchargé. Le catalogue fige les deux
  dépôts aux commits qu'a fait tourner le banc (`revision`) : un nouveau commit en amont ne change
  rien tant que le catalogue ne change pas. Ce fichier n'a pas de rappel par étape : progression et
  annulation s'accrochent au `step` du planificateur.
- **LoRA turbo non fusionnée.** fp32, rang 128, appliquée en crochets `forward` le temps du rendu
  puis retirée. Ses écarts sont sous le pas d'arrondi du bf16 et disparaîtraient à la fusion
  (avertissement des auteurs ; même leçon que les LoRA H3, LESSONS n°30). Une clé qui ne
  correspond à aucune couche fait refuser le fichier.
- **Graines.** Le bruit est tiré sur le CPU, comme au banc : une graine donne l'image des planches
  du banc.
- **Non utilisés :** `lora.safetensors` du dépôt turbo (réécrit sur place par son auteur), la LoRA
  destripe (les bandes de la SFT sont invisibles à l'œil à ces nombres d'étapes).

## Les fonctions de la 1.4 sur ces moteurs

| Fonction 1.4 | Jobs |
|---|---|
| Text2Image | `krea2-t2i`, table de ratios 16:9 1280×720, 9:16 720×1280, 1:1 1024², 4:5 832×1040 ; ou `qwen-image-2.1` sans image, en multiples de 32 (16:9 1344×768) ; ou `moss-image` (nouveau en 2.0) avec la table de ratios de Krea 2 et son `mode` |
| Image2Image / localisation | `qwen-image-2.1` avec `images` (image d'entrée + jusqu'à 9 références) ; un job par marché |
| Images de campagne | `krea2-t2i` : affiche 832×1216 et vignette 1280×720 (variantes), réseau social 1024×1024 (1), graines `seed+200`, `+201`, `+202` ; le teaser vidéo arrive avec l'étape 3 |
| Planches sujet et décor | `krea2-t2i` en 1920×1088, une image chacune |
| Images des plans (keyframes) | `qwen-image-2.1` avec `subjects` = la ou les planches de sujet, `setting` = la planche du décor |

## Vitesse

Les poids sont lus d'un bloc, jamais projetés en mémoire, et le transformer de Qwen Image 2.1
passe par `torch.compile` ; mesures et bancs dans [H3.md](H3.md#mémoire-et-annulation) et
[LESSONS.md](LESSONS.md) n°42–43. Chargements sur le GB10, cache disque vidé : Krea 2 34 s
(253 s avant). Rendus en 1280×720 : Krea 2 environ 20 s par image ; Qwen Image 2.1 en 1344×768
environ 40 s une fois compilé (le premier rendu à une nouvelle taille ajoute environ 15 s).

## Résolution ×2

`upscale-2x` crée une copie d'une image ou d'une vidéo deux fois plus large et deux fois plus
haute. Il tourne sur le clic « ⇱ Doubler la résolution » de la visionneuse de la galerie, jamais
de lui-même après un rendu ; la copie arrive dans la galerie comme un nouveau fichier (titre
« Résolution ×2 »), la source reste telle quelle.

| | |
|---|---|
| Paramètre | `source` : une référence d'image ou de vidéo (`outputs/…` ou `inputs/…`) ; rien d'autre, pas de prompt |
| Limites | image d'au plus 4096 px sur son grand côté (8192 px en sortie), vidéo d'au plus 1920 px (3840 px en sortie) ; refus 422 au-delà |
| Réseau | SPAN, poids `2xNomosUni_span_multijpg` (id catalogue `span-2x-nomosuni`, 4,3 Mo), chargé par spandrel 0.4.2, en float16 sur le GPU, gardé en mémoire |
| Vidéo | décodée par ffmpeg en RGB, agrandie image par image, encodée en H.264 CRF 18 à la cadence de la source, le son copié tel quel ; rien n'est gardé si le job échoue |
| Sortie | PNG (métadonnées `studio` : `params.source`) ou MP4 tagué sous `outputs/upscale-2x/` |

Licences : poids CC BY 4.0 (Philip Hofmann, crédité dans `NOTICE`), code du réseau SPAN
Apache-2.0, spandrel MIT (son paquet principal ne porte que des architectures sous licence
permissive). L'usage commercial est permis avec le crédit.

**Pourquoi pas les upscalers de NVIDIA** (vérifié les 2026-11-05 et 06) : aucun ne tourne sur le
GB10.

- DLSS 5 est une fonction de jeu en temps réel : il lit la couleur et les vecteurs de mouvement
  que le moteur de jeu produit à chaque image, par Streamline (Windows 10+, DirectX 11/12,
  Vulkan) ou le plugin Unreal Engine 5, sur GeForce RTX 50. Il réécrit aussi la lumière de la
  peau et des matières, ce qu'une copie fidèle ne doit pas faire.
- Les ponts ComfyUI communautaires vers DLSS 5 pilotent les DLL NGX Windows de NVIDIA (une
  « feature 18 » non documentée) dans un faux pipeline D3D12 ; sous Linux ils les font tourner
  sous Wine, en x86-64 seulement. Ces DLL ne peuvent pas être livrées dans notre image.
- Le RTX Video SDK est réservé à Windows ; son équivalent Linux `nvidia-vfx` (Maxine Video
  Effects) n'a que des roues x86_64 et Windows, et NVIDIA a répondu sur le forum DGX Spark qu'il
  n'y a « currently no plan to add NVIDIA VFX support on Spark ».

SPAN a été choisi d'après une mesure tierce sur un DGX Spark (ai-muninn.com, 2026-08-07) : 362
images H3 de 960×540 à 1920×1080 en 49 s avec SPAN contre 316 s avec Real-ESRGAN, sans
différence visible rapportée. Notre propre mesure sur le GB10 :

```bash
docker compose up -d --build          # spandrel est une nouvelle dépendance de l'image
python tools/qualify/run_upscale.py   # dernières images Krea 2 et Qwen et dernière vidéo H3
docker logs studio 2>&1 | grep 'render: upscale-2x'
```

Mesuré sur gb10-demo le 2026-11-06 (modèle déjà téléchargé) : une image de 1920×1088 (Krea 2
ou Qwen) passe en 3840×2176 en 0,4 à 1,2 s de réseau, 3 à 4 s pour tout le job ; un clip H3 de
5 s (124 images, 1280×736) passe en 2560×1472 en 20 s, dont 16 s dans le réseau (6,1 images/s
au total), son gardé.

Le script poste un job par source comme le fait le clic et écrit `qualify-upscale.json` (chaque
source à côté de sa copie) ; la ligne de journal donne le temps du réseau seul et, pour une
vidéo, les images par seconde. Le responsable du projet a comparé les quatre copies à leurs
sources à 100 % le 2026-11-06 et les a acceptées : `span-2x-nomosuni` est `"qualified": true`.

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

- **Qualification de MOSS-Image (promaxgb10-95c7, 2026-11-07) :** les trois modes rendus par
  l'application sont identiques au pixel près aux images du banc à graine égale (Aperçu 10 s,
  Standard 18 s, Qualité 69 s en 1024², chargement du moteur 36 s), un rendu annulé n'a laissé
  aucun crochet de LoRA, et le responsable du projet les a validés le 2026-11-08 : les deux
  entrées du catalogue sont `"qualified": true`. Limites connues : Aperçu peut doubler un mot d'un
  titre, Standard tire vers une lumière chaude de coucher de soleil.
- **Qualification (gb10-demo, 2026-10-29/30) :** tous les cas Krea 2 (7/7) et Qwen Image 2.1 (4/4)
  ont rendu, et le responsable du projet a validé les rendus le 2026-10-30 : les deux modèles sont
  `"qualified": true`. Il n'y a pas eu de comparaison côte à côte avec la 1.4 ; un écart trouvé
  plus tard sera corrigé à ce moment-là.
- **Chargement de LoRA sur NGC 25.11 :** peft 0.19 et plus refuse son torchao 0.14, peft est donc
  épinglé sous 0.19.
- **LoRA de style** (LoRA Krea 2 et de planche de la 1.4) pas encore portées.
- **Licence Qwen Image 2.1 :** Qwen Research License, usage non commercial uniquement. 2509
  (Apache-2.0) ayant été retiré, toutes les retouches et toutes les images de plan en dépendent.
