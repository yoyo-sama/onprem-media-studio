# Passation

Version anglaise : [../HANDOVER.md](../HANDOVER.md).

Cette page permet à quelqu'un (une personne ou un modèle d'IA) de reprendre le développement
d'OnPrem Media Studio sans contexte préalable. C'est un instantané du **2026-11-23, `main` à
`756bc78`** (PR #56, la dernière fusionnée ; aucune pull request ouverte). Elle résume les
documents de référence et y renvoie ; en cas de désaccord, le code et les documents de référence
l'emportent. À lire ensuite, dans cet ordre : [AGENTS.md](../../AGENTS.md),
[ARCHITECTURE.md](ARCHITECTURE.md), [LESSONS.md](LESSONS.md),
[adr/0001-inference-stack.md](adr/0001-inference-stack.md), puis la page de la partie concernée
([IMAGE-ENGINES.md](IMAGE-ENGINES.md), [H3.md](H3.md), [LONG-VIDEO.md](LONG-VIDEO.md),
[FRONTEND.md](FRONTEND.md), [ASSISTANT.md](ASSISTANT.md), [GALLERY.md](GALLERY.md)).

## 1. Objectif et périmètre

OnPrem Media Studio 2.0 est un studio privé d'images et de vidéos par IA qui tourne entièrement
sur la machine de l'utilisateur. Il succède à AI Content Studio 1.4 (dépôt
`yoyo-sama/dellaicontent`, une interface statique qui pilote ComfyUI et Ollama). Les objectifs
fixés par le propriétaire du projet (GitHub `yoyo-sama`) le 2026-10-29 :

- **Autonome** : ni ComfyUI, ni Ollama, ni génération dans le cloud. L'application fait tourner
  les modèles elle-même et télécharge les poids nécessaires à la première utilisation.
- **Même couverture fonctionnelle que la 1.4**, remaniée depuis : Text2Image, Image2Image,
  campagne, planches de sujet et de décor, vidéo à partir de références, le plan-séquence (où le
  storyboard de la 1.4 a été fondu), le Canvas, la galerie, la mise à jour depuis l'interface.
  Nouveau en 2.0 : l'assistant de création (un chat à rôles), MOSS-Image, l'agrandissement ×2,
  les piles de LoRA sur tous les moteurs.
- **Les vidéos longues** sont l'objectif principal du propriétaire depuis mi-novembre : des
  vidéos d'une minute ou plus où les sujets (visage, cheveux, morphologie, vêtements) et la scène
  restent les mêmes du début à la fin, avec le moins d'interaction possible (brief → durée → un
  clic, aucune étape de validation), § 4.
- **Les leçons de la 1.4 sont reprises** ([LESSONS.md](LESSONS.md), 58 entrées aujourd'hui).
- **Cibles** : DGX OS sur GB10 (ARM64, mémoire unifiée) d'abord, en Docker. Ubuntu ensuite.
  Omarchy et Windows 11 (x86 et ARM64) plus tard. Bare metal plus tard (voir § 10).
- **Le nom du produit doit rester facile à changer** : il n'existe que dans `studio/config.py`
  (`APP_NAME`, `STUDIO_APP_NAME`) ; le paquet s'appelle `studio`, le préfixe d'environnement
  `STUDIO_`.
- **Maestro et WanGP servent seulement de référence** (licence non commerciale) : ne jamais
  copier leur code, ne jamais en dépendre.

Le dépôt est **public** depuis le 2026-11-10 : n'y nommer le propriétaire que par son
identifiant GitHub, et n'y écrire ni adresse du réseau local, ni nom de compte, ni lien privé.

## 2. L'architecture en un écran

Un conteneur Docker, un port (8090), un processus Python (FastAPI) avec un fil de travail GPU et
un fil de travail CPU, plus un processus enfant `llama-server` pour Gemma, démarré à la demande.
Un second service compose, `updater`, fait la mise à jour depuis l'interface. Détails :
[ARCHITECTURE.md](ARCHITECTURE.md).

| Sujet | Choix |
|---|---|
| Serveur | FastAPI (`studio/main.py`), file de jobs `studio/jobs.py` (historique dans `data/jobs.json`) |
| Moteurs image | Hugging Face diffusers 0.42.1, poids officiels (`studio/pipelines/krea2.py`, `qwen.py`, `moss.py`, chargement des LoRA dans `image_lora.py`) |
| Moteurs vidéo | FastVideo (commit épinglé dans `docker/Dockerfile`) pour MiniMax H3 (`h3.py`, `h3_runtime.py`, `h3_upscaler.py`, `h3_lora.py`), plus deux correctifs de la préparation des latents de FastVideo pour le plan-séquence : `h3_continue.py` (un clip prolonge les 7 derniers latents vidéo du précédent) et `h3_start_frame.py` (une image de départ tenue 22 images dans un rendu Ref2VA) |
| Montage | `studio/pipelines/montage.py` : `video-concat`, `image-grid`, `video-frames` sur le fil CPU, `video-stitch` sur le GPU (un plan décodé une seule fois depuis ses latents, son à -18 LUFS) |
| LLM | llama.cpp `llama-server` b11982 compilé pour sm_121, Gemma 4 26B-A4B GGUF + mmproj (`studio/llm.py`) |
| Téléchargement des modèles | `huggingface_hub`, fichier par fichier, marqueur `.complete`, `revision` épinglée par entrée du catalogue (`studio/models.py`, `studio/catalog.json`) |
| Compilateurs de prompt | Le moteur JavaScript de la 1.4 porté en anglais, dans l'interface (`web/js/prompts.js`) ; le backend ne fait que l'inférence et reçoit des prompts finaux (ADR 0001) |
| Interface | `web/index.html` (modes Assistant et Studio) et `web/canvas.html`, modules ES dans `web/js/` (`studio.js` formulaire et flux, `director.js` plan-séquence, `form.js` pipelines et contrôles, `chat.js` assistant, `gallery.js`, `canvas*.js`), sans étape de build, FR/EN/ES/DE ([FRONTEND.md](FRONTEND.md)) |
| Assistant | `studio/assistant/` (rôles dans `roles/*.md`, outils, `/api/chat` en SSE) ([ASSISTANT.md](ASSISTANT.md)) |
| Galerie, mise à jour, envoi de LoRA | `studio/gallery.py` (SQLite/FTS5), `studio/update.py`, `docker/updater/server.py`, `studio/loras.py` ([GALLERY.md](GALLERY.md)) |
| Empaquetage | Image de base NGC PyTorch **25.11** (torch 2.10, CUDA 13), versions Python exactes dans `docker/constraints.txt` |

Contrat clé : un pipeline est une sous-classe de `Pipeline` (`studio/pipelines/`) avec les ids
de catalogue dont il a besoin (`models`), un `validate()` qui refuse les paramètres inconnus en
422 et renvoie les paramètres normalisés, et un `run()`. Rien ne crée de job hormis un envoi du
client.

## 3. Moteurs et modèles

Toutes les entrées de `studio/catalog.json` sont `"qualified": true`, chacune épinglée au commit
Hugging Face de son rendu qualifié.

| Id de pipeline | Usage | Modèle (id de catalogue) | Licence | Qualifié |
|---|---|---|---|---|
| `krea2-t2i` | Texte vers image, campagne, planches depuis un brief | Krea 2 Turbo (`krea2-turbo`), 8 pas | Licence Krea 2, **à accès restreint** (`HF_TOKEN` + licence acceptée sur Hugging Face) | gb10-demo, 2026-10-30 (7/7 cas) |
| `qwen-image-2.1` | Image vers image (jusqu'à 10 images), planche depuis une photo, texte vers image | Qwen Image 2.1 (`qwen-image-2.1`) avec le transformer Lightning v2 RL (`qwen-image-2.1-lightning`), 4 pas | Qwen Research License, **non commerciale** | base 2026-10-30 ; Lightning sur promaxgb10-95c7, 2026-11-07 (LESSONS n° 46) |
| `moss-image` | Texte vers image avec du texte dans l'image | MOSS-Image SFT (`moss-image-sft`) + LoRA turbo (`moss-image-turbo-lora`) ; modes Aperçu 4 / Standard 8 (défaut) / Qualité 25 | Apache-2.0 | promaxgb10-95c7, 2026-11-08 |
| `h3-t2v`, `h3-i2v` | Texte, image, première/dernière image (FL2VA) vers vidéo avec son | FastH3 V2 NVFP4 (`fasth3-v2-nvfp4`) | MiniMax H3 Community License (**exclut UE, Royaume-Uni, Corée du Sud, États-Unis** ; un produit commercial doit afficher « MiniMax H3 ») | gb10-demo, 2026-10-30 |
| `h3-r2v` | Références (≤ 9 images, 3 clips, 3 sons) vers vidéo, deux passes ; prend aussi `image` (une image de départ, tenue) ou `continue_from` (le clip qu'il prolonge) pour le plan-séquence | FastH3 OmniRef NVFP4 (`fasth3-omniref-nvfp4`) + upscaler latent (`h3-latent-upscaler`, Apache-2.0) | comme ci-dessus | gb10-demo, 2026-10-30 ; `continue_from` le 2026-11-20 et l'image de départ tenue le 2026-11-22 sur promaxgb10-95c7 |
| `upscale-2x` | Image ou vidéo ×2 depuis la galerie | SPAN 2xNomosUni (`span-2x-nomosuni`) via spandrel | CC BY 4.0 (crédité dans `NOTICE`) | gb10-demo, 2026-11-06 |
| (LLM) | Enrichissement des prompts, découpage du plan-séquence, description d'images, chat de l'assistant | Gemma 4 26B-A4B Q4_0 (`gemma4-26b-a4b`) | Apache-2.0 | 2026-11-07 (amendement de l'ADR 0001) |
| `video-stitch` | Un plan-séquence : clips qui se prolongent décodés une seule fois depuis leurs latents, coupes telles quelles, son à -18 LUFS | le VAE vidéo d'OmniRef (`fasth3-omniref-nvfp4`) | comme H3 | promaxgb10-95c7, par script puis depuis l'interface, 2026-11-20 |
| `video-concat`, `image-grid`, `video-frames` | Montage sur le fil CPU (ffmpeg, Pillow) | aucun | — | — |

**Abandonnés, et pourquoi** (ne pas les reprendre sans demande du propriétaire) :

| Modèle ou fonction | Abandonné le | Raison |
|---|---|---|
| LTX 2.5 (et tout LTX) | 2026-10-29 | Décision du propriétaire : MiniMax H3 le remplace sur tous les chemins vidéo |
| Qwen-Image-Edit 2509 | 2026-10-29 | Inutile : Qwen Image 2.1 couvre toutes les retouches de la 1.4 (références symétriques, jusqu'à 10 images) |
| Checkpoints H3 FP8 (`FastH3-8-Step-V2-FP8`, `FastH3-OmniRef-FP8`) et `STUDIO_H3_PRECISION` | 2026-11-07 (PR #16) | Jamais rendus, donc jamais qualifiés ; le propriétaire ne veut aucun modèle non validé dans la liste |
| Gemma 4 E4B | 2026-11-07 (PR #17) | Un seul LLM suffit ; 26B-A4B suit les longues consignes de rôle et appelle les outils |
| Transformer de base de Qwen Image 2.1 (25 pas) et le Turbo officiel 8 pas | 2026-11-07 (PR #18) | Lightning est 2,9 à 3,6 fois plus rapide en gardant l'identité ; Turbo n'était que 2× plus rapide, plus sombre et plus terne |
| torchao FP8 sur les moteurs image | 2026-11-05 | 300 fois plus lent par pas sur le GB10 (LESSONS n° 43) |
| `torch.compile` sur Krea 2 | 2026-11-05 | Environ 33 s de compilation par taille pour 6 s gagnées par image |
| DLSS 5, RTX Video SDK, nvidia-vfx | 2026-11-06 | Rien de NVIDIA ne tourne sur le GB10 (Windows ou x86 seulement, moteurs de jeu) ; SPAN les remplace (LESSONS n° 44) |
| LoRA MOSS communautaires (Fizgig, KOOK, lodestones DMD, Kromoss…) | 2026-11-07 | Redondantes, sans licence, ou rendus moins bons que la LoRA turbo à 8 pas |
| Plan-séquence par images clés (une image clé Qwen par segment + FL2VA, PR #43, fermée sans fusion) | 2026-11-19 | Des heures d'essais, pire qu'au départ (cadrage raté sur une image clé sur 5, mouvement élastique, fantômes) ; remplacé par la continuation latente ([LONG-VIDEO.md](LONG-VIDEO.md)) |
| Le storyboard du Studio (liste de plans, images des plans, animatique) et la carte storyboard de l'assistant | 2026-11-21 (PR #52) | Fondus dans le plan-séquence après un bon rendu en trois scènes ; **le Canvas garde sa carte storyboard** |
| Le réalisateur r2v avec planches à valider (« Personnage + décor cohérents »), « Ignorer les planches », le style r2v | 2026-11-21 (PR #53) | Remplacés par un formulaire « Vidéo à partir de références », un clic, un job |
| MiniMax-H3-Image pour les planches, le checkpoint hybride FL2VA/Ref2VA, les RefMods | évalués les 2026-11-13/16, non retenus | Trop gros pour le GB10 en l'état, non qualifiés, licence « other » ; les planches sont passées à Qwen 2.1 |

**Limites connues des moteurs** : FL2VA montre une seconde tête fantôme (images ~30–100) quand
la première et la dernière image diffèrent fortement de cadrage, piste non vérifiée
([H3.md](H3.md#qualification)) ; les clips H3 font 5 à 15 s (FastVideo) ; MOSS Aperçu peut
doubler un mot de titre, Standard tire vers une lumière de couchant ; Qwen Lightning ajoute du
contraste et des structures parasites en texte vers image ; au plus deux sujets par image de plan
Qwen (LESSONS n° 24) ; le chemin OmniRef (Ref2VA) rend un son plus faible que V2, remis à niveau
au montage.

## 4. Ce que fait le Studio aujourd'hui

**Pipelines du Studio** (`PIPELINES` dans `web/js/form.js`) : Text2Image (Krea 2, Qwen 2.1 ou
MOSS-Image), Image2Image (Qwen 2.1, image d'entrée + jusqu'à 9 références, marchés), Text2Video
et Image2Video (H3 V2), **Vidéo à partir de références** (un job `h3-r2v` depuis une liste de
Références : jusqu'à 9 images, 3 clips, 3 sons, chacun avec un rôle ; le prompt Ref2VA à six
champs construit par `buildH3RefPrompt`, le même que la carte `reference_video` de l'assistant),
et deux pipelines propres à leur carte d'objectif (sans menu Pipeline) : le **plan-séquence**
(carte « Vidéo narrative ») et la **campagne complète**. La galerie propose « → Première image »
et « → Référence » sur les images là où le formulaire les prend.

**Le plan-séquence** ([LONG-VIDEO.md](LONG-VIDEO.md), `web/js/director.js`), résultat du travail
du 2026-11-14 au 22 :

1. Entrées : un brief ou un scénario (en prose, un paragraphe par scène ; ou un fichier au format
   H3 du propriétaire, lu sans Gemma, dont chaque `[Shot N]` ouvre une nouvelle scène), une durée
   totale (segments de 10 s), une **Première image** facultative et jusqu'à 7 **Références** avec
   leur rôle (personnage, décor, objet). « ✨ Planche du sujet / ✨ Planche du décor depuis le
   brief » (un job Krea 2 chacune) et « ✨ Planche » sur la photo d'un personnage (un job Qwen
   2.1 à cinq vues) ajoutent des planches en un clic, sans étape de validation.
2. Le découpage de Gemma (`H3_SCENARIO_SYSTEM`) en fait des cartes de segment
   `{"new_shot", "text"}` ; un nouveau plan devient une coupe 🎞. Quand le nombre de scènes est
   connu (paragraphes, fichier), c'est le code qui pose les coupes. Éclairage et Ambiance sonore
   communs restent vides quand il y a plusieurs scènes ; la caméra garde le visage du sujet
   principal dans le cadre.
3. Un clic lance la chaîne. **Segment 1** : ni image ni référence → `h3-t2v` ; références
   seules → `h3-r2v` ; une première image seule, avec un décor seulement, ou une scène décrite →
   `h3-i2v` sur elle ; une première image **et** des références de sujet → `h3-r2v` avec `image`
   (l'image tenue immobile environ 0,9 s, puis en mouvement) et seulement les personnages et
   objets. **Segments continus** avec références → `h3-r2v` avec `continue_from` (continuation
   latente, sans image de départ). **Coupes et nouvelles scènes** → `h3-r2v` sur les seules
   références, aucune image du lieu précédent. Un plan-séquence de plusieurs scènes n'envoie
   **aucune référence de décor** (une image de lieu y ancre le personnage) ; les segments qui
   envoient moins de références renumérotent leurs `<Subject N>` et écrivent une référence
   écartée sous forme de sa description.
4. Le plan-séquence se termine par `video-stitch` : clips continus décodés une seule fois, coupes
   telles quelles, -18 LUFS, fondus de 25 ms, limiteur de crête vraie.

Mesuré sur promaxgb10-95c7 : un segment `h3-r2v` de 10 s prend environ 4–5 min avec une
référence et jusqu'à 9 min avec quatre ; un plan-séquence de trois scènes de 30–40 s prend 23 à
29 min de bout en bout. Le propriétaire a jugé le plan-séquence de 47 s de l'application du
2026-11-20 « pas parfait mais satisfaisant » ; les raccords mesurent 6–14 sur les mouvements
rapides.

**L'assistant** (premier mode de la page) : sept rôles (assistant général, réalisateur, casting
et décors, DA pub, localisation, campagne produit et mode, monteur transitions) répondent par des
cartes qui ne lancent rien sans clic (`create_image`, `edit_image`, planches, `video_from_text`,
`video_from_image`, `long_take`, `reference_video`, `join_videos`, `campaign`, `ask_choices`). Le
Réalisateur oriente une histoire en plusieurs scènes vers une carte `long_take`. Les arguments de
carte de Gemma sont peu fiables, d'une façon nouvelle à chaque essai (types manquants, références
manquantes) : l'application complète ce qu'elle peut (une référence sans type prend le rôle de sa
carte ; une carte plan-séquence sans références reprend les planches terminées de la
conversation).

**Le Canvas** garde ses propres cartes, dont les cartes storyboard et référence vers vidéo,
inchangées par le travail sur le plan-séquence ; l'assistant n'est pas encore dans le Canvas.

## 5. Installer et mettre à jour sous Docker

Le README contient les étapes vérifiées ([README.fr.md](../../README.fr.md)). En bref, sur la
machine :

```bash
git clone https://github.com/yoyo-sama/onprem-media-studio.git && cd onprem-media-studio
scripts/docker-install.sh --check   # ne change rien ; dit quoi corriger (Docker, toolkit NVIDIA, port, disque)
scripts/docker-install.sh           # .env (600) depuis .env.example, ./data, build, démarrage, attente de /api/health
nano .env                           # HF_TOKEN=hf_... (Krea 2 seulement), puis : docker compose up -d
```

- Le port 8090 est aussi celui de la 1.4 : sur une machine qui fait tourner la 1.4, mettre
  `STUDIO_HOST_PORT=8096` dans `.env`.
- Modèles et rendus vivent dans `./data` (`STUDIO_DATA` pour un autre disque) ; prévoir 300 Go.
- `python -m studio.import14` reprend l'upscaler H3, l'encodeur de texte de Qwen 2.1 et les LoRA
  H3 d'une installation 1.4 (README § Réutiliser des fichiers).
- **Mise à jour** : la ligne « Mise à jour » du panneau Moniteur demande au service `updater` de
  faire `git pull`, de reconstruire l'image, de retenir la file et de recréer le studio dès
  qu'aucun job ne tourne. À la main : `git pull && scripts/docker-install.sh` (il refuse pendant
  un job ou un téléchargement de modèle). Le dépôt est public : aucun jeton n'est nécessaire ;
  `STUDIO_GIT_TOKEN` ne sert que pour un fork privé.
- **L'updater ne se reconstruit jamais lui-même** : après un changement de `docker/updater/`,
  lancer `docker compose up -d --build updater` une fois sur chaque machine (le Moniteur le
  signale, `updater_stale`).
- `web/` et `studio/` sont copiés dans l'image : un `git pull` seul ne change rien sur une
  machine en marche, il faut reconstruire l'image ; puis Ctrl+Maj+R dans le navigateur.
- Diagnostic : `curl -s localhost:8090/api/health`, et
  `docker logs studio 2>&1 | grep -E "llm:|engine:|render:"` (un tour de chat lent se confond
  facilement avec un rendu lent).

## 6. Machines de test

Trois GB10 (DGX OS, ARM64, ~121 Gio de mémoire unifiée). **Ne rien supposer d'une machine à
l'autre : chemins, utilisateurs, état.**

| Machine | Utilisateur | Rôle |
|---|---|---|
| `gb10-demo` | `spark` | Première machine de test de la 2.0 (qualifications du 2026-10-30, agrandissement ×2). Manquait de disque le 2026-10-30. Plus utilisée depuis mi-novembre. |
| `promaxgb10-95c7` | `spark` | La machine du propriétaire avec l'installation Docker (dépôt `/home/spark/onprem-media-studio`, conteneur `studio`). Tous les rendus depuis le 2026-11-07. **Tourne sur `main` 756bc78**, reconstruite le 2026-11-22 à 21:39 UTC après la PR #56 (file vide, santé OK). Accessible par Remote Control, que le propriétaire active depuis Claude Desktop. Contient `control-tests/` (les rendus de contrôle des PR #55/#56, rapports `inspection-*.md`) : ne supprimer que sur parole du propriétaire. Contient aussi ~200 Go de modèles ComfyUI d'un autre outil dans `~/.zcode` : pas à nous, ne pas y toucher. |
| `promaxgb10-6c5f` | `sparks` | Héberge la **1.4** (ComfyUI, `comfyui-nvidia`, open-webui, spark-control-center). Pas une machine de test de la 2.0. |

Travailler sur promaxgb10-95c7 :

- La session Claude y tourne en mode auto : elle refuse certaines commandes
  (`docker compose build`, `rm` via un conteneur root) que le propriétaire lance alors à la main.
  Lancer des rendus ou redémarrer le studio demande l'accord **écrit** du propriétaire dans le
  fil.
- `data/` appartient à root : y écrire via `docker exec`.
- Avant de tester une branche, noter la branche courante et l'étiquette `studio.commit` de
  l'image en marche
  (`docker inspect studio --format '{{index .Config.Labels "studio.commit"}}'`), et la remettre
  ensuite (le 2026-11-09, un test a fait disparaître sans bruit un correctif que la machine
  exécutait depuis une autre branche). Après la fusion d'une PR, reconstruire la machine sur
  `main`.
- Les rendus par l'interface sont pilotés par Playwright (`tools/qualify/narrative_take.js`,
  `director_take.js`, `first_frame_take.js`) dans un conteneur lancé avec
  `--user $(id -u):$(id -g)` : des sorties écrites en root n'ont pas pu être supprimées le
  2026-11-21.

Rendus et qualifications se font uniquement sur un GB10. Le conteneur cloud des sessions Claude
n'atteint ni huggingface.co ni download.pytorch.org (PyPI et GitHub fonctionnent) : les tests
torch (`tests/test_image_lora_models.py`) ne tournent que sur le GB10. Les sessions Claude ne
peuvent pousser que leur propre branche : le propriétaire supprime les anciennes branches
distantes dans l'interface de GitHub.

## 7. Règles apprises (au-delà de LESSONS.md)

Les règles permanentes du propriétaire sont dans [AGENTS.md](../../AGENTS.md) ; les 58 leçons
techniques dans [LESSONS.md](LESSONS.md). Celles qui reviennent le plus souvent :

1. **Aucun modèle non qualifié dans le catalogue.** Une entrée est ajoutée en
   `"qualified": false` ; seul un vrai rendu sur le GB10, regardé (images, bords, dégradés, son)
   et **accepté par le propriétaire**, la passe à true, avec `revision` épinglée au commit de ce
   rendu. Un statut `success` ne prouve rien.
2. **Ne jamais reconstruire ni redémarrer le studio pendant un job ou un téléchargement de
   modèle.** Les jobs vivent dans la mémoire du serveur ; une reconstruction le 2026-11-08 a tué
   un rendu H3 OmniRef. Utiliser `scripts/docker-install.sh` (il vérifie) et dire au propriétaire
   d'attendre la fin des jobs avant tout `docker compose up -d --build`.
3. **Rien ne se rend sans un clic**, et **le prompt de l'utilisateur part tel quel** (les
   invariants du graphe sont rajoutés par le code). Testé par `tools/assistant-ui.js` et
   `tools/prompt-systems.js`.
4. **Vitesse sur GB10** : ne jamais mapper les poids en mémoire (`disable_mmap`,
   `common.from_pretrained`, `h3_runtime.WholeFile`/`RangeFile`) ; pas de FP8 torchao ;
   `torch.compile` seulement là où il paie (Qwen seulement avant Lightning, désactivé
   aujourd'hui) ; mesurer la mémoire système disponible, pas la « VRAM libre ».
5. **Mémoire** : un seul moteur H3 tient ; Gemma (17 Go) est arrêté avant chaque rendu r2v et
   quand un moteur H3 a besoin de la mémoire ; les moteurs image restent résidents tant que la
   mémoire le permet (LRU).
6. **FlashInfer** : `MAX_JOBS=4` et son cache sur `/data/cache`, sinon le premier job NVFP4
   épuise la mémoire du GB10 (LESSONS n° 36).
7. **Les images de référence H3 ne sont jamais que réduites**, à 2048 px sur le petit côté,
   comme le fait ComfyUI (FastVideo les agrandit : r2v 2,6× plus lent, LESSONS n° 38).
8. **Réflexion de Gemma** : désactivée pour les appels de compilation (`enable_thinking: false` ;
   elle coûtait 44–81 s par appel) ; le chat la garde, plafonnée à 2048 jetons de réflexion puis
   redemandé sans réflexion. llama.cpp b11982 n'a ni `--reasoning-budget` ni `--no-mmap`.
9. **Épingler ce qui a été qualifié** : révisions des modèles dans le catalogue, versions Python
   dans `docker/constraints.txt`, l'étiquette de base NGC, le tag llama.cpp et le commit
   FastVideo dans le Dockerfile. peft reste sous 0.19 (0.19+ refuse le torchao de NGC 25.11).
10. **Mettre à jour FastVideo** : revérifier les deux classes d'étape enveloppées par
    `h3_runtime.report_stages` (`MiniMaxH3DenoisingStage`, `MiniMaxH3VideoDecodingStage`),
    l'appel `scheduler.step` par pas, et le code de préparation des latents corrigé par
    `h3_continue.py` et `h3_start_frame.py` ; garder la règle de ne jamais agrandir les
    références.
11. **Mesurer, pas deviner** : chaque changement de vitesse vient d'un script de banc dans
    `tools/qualify/` (`load_speed.sh`, `render_speed.sh`, `qwen_fast_bench.sh`, `moss_bench.py`,
    `run_upscale.py`). Un banc lancé par `docker exec -i studio python - < script` n'apparaît que
    comme `python -` dans le conteneur ; ne jamais lancer deux bancs à la fois (les deux peuvent
    redémarrer le studio).
12. **Travail sur les vidéos longues** : fixer un critère d'arrêt avant chaque essai ; après un
    échec de plus sur une piste, proposer une approche repartie de zéro avec ce qui a été appris
    plutôt qu'un correctif de plus (les mots du propriétaire du 2026-11-18, la raison de la
    fermeture de la PR #43). Garder le parcours brief → durée → un clic ; les vérifications
    tournent dans la chaîne, jamais comme une étape de validation par l'utilisateur.
13. **Compléter ce que l'application peut** plutôt que se fier à une sortie structurée de Gemma :
    un indicateur par élément vaut mieux qu'une liste de numéros, la prose vaut mieux qu'une mise
    en page dans un argument d'outil (LESSONS n° 55, 56), et le code décide de ce qui est
    déterministe (coupes quand le nombre de scènes est connu, références par segment).

## 8. Comment le travail se fait

- Code, commentaires, journaux, messages de commit, descriptions de PR et documents sont en
  **anglais** ; chaque document a sa traduction française sous `docs/fr/` (et `README.fr.md`),
  mise à jour dans le même changement. L'interface est en FR/EN/ES/DE, au tutoiement.
- Une branche et une PR par travail, depuis `main`. Le propriétaire lit la PR et dit quand
  fusionner ; ne jamais fusionner sans sa demande. Une branche dont la PR est fusionnée repart de
  `main` pour un nouveau travail.
- Avant de demander une fusion : `python -m pytest`, et pour tout changement d'interface, de
  prompt ou de consigne `node tools/parity-prompts.js` (demande `../dellaicontent`),
  `tools/prompt-systems.js`, `tools/assistant-ui.js`, `tools/lora-ui.js`, `tools/relay-ui.js`
  (commandes dans AGENTS.md). GitHub Actions les lance sur chaque PR ; le test de parité
  seulement quand le secret `DELLAICONTENT_TOKEN` est défini.
- Changer un compilateur de prompt ou une consigne Gemma fait échouer exprès les tests de parité
  et d'empreinte : mettre à jour la référence dans le même commit et dire pourquoi.
- Un changement du plan-séquence se vérifie par un rendu de contrôle sur promaxgb10-95c7 (sur
  accord du propriétaire), images et son inspectés et consignés dans un rapport à côté du rendu.
- « La chose la plus simple qui marche » : aucune option, abstraction ou fonction au-delà de ce
  qui est demandé.
- Quand une PR change les moteurs, les machines ou les points ouverts, mettre à jour cette page
  (§ 3, § 4, § 6, § 9, § 10) et sa version anglaise dans la même PR.

## 9. Historique des PR

| PR | Date | Contenu |
|---|---|---|
| #1, #4 | 2026-10-30 | Étape 1 : serveur FastAPI, catalogue et téléchargement des modèles, file de jobs, Gemma via llama.cpp, image Docker ; correctifs du premier build sur GB10 |
| #2 | 2026-10-30 | Étape 2 : moteurs Krea 2 et Qwen Image 2.1, qualifiés |
| #3 | 2026-10-30 | Étape 3 : MiniMax H3 via FastVideo (t2v/i2v/FL2VA sur FastH3 V2, Ref2VA en deux passes sur OmniRef avec notre upscaler latent, pile de LoRA), NVFP4 qualifié |
| #5 | 2026-10-30 | Étape 4 : interface Studio et Canvas portée de la 1.4, galerie, mise à jour depuis l'interface, i18n, `install.sh` bare metal (en pause) |
| #6, #7 | 2026-10-30 | Moteurs gardés résidents (budget mémoire LRU) ; `studio.import14` reprend des fichiers de la 1.4 |
| #8, #9 | 2026-10-31 → 11-01 | Assistant de création (7 rôles, cartes, personnage animé, premier mode) ; avancement des rendus sur les cartes, planche depuis une photo, réflexion de Gemma coupée pour les appels de compilation |
| #10 | 2026-11-05 | Chargements sans mappage mémoire, Qwen compilé, journaux de durée de rendu, lecteur vidéo et « Régénérer la vidéo » |
| #11, #12 | 2026-11-05 → 06 | Référence vers vidéo depuis la carte de l'assistant et le Studio avec références image, clip et son ; les vidéos d'une scène passent par la carte r2v |
| #13 | 2026-11-08 | Lignes de journal des rendus H3 ; budget de réflexion du chat |
| #14 | 2026-11-06 | Agrandissement ×2 (SPAN), après avoir écarté DLSS 5 |
| #15, #16 | 2026-11-07 | Mise à jour depuis l'interface sous Docker (service `updater`) ; H3 FP8 retiré |
| #17, #18, #19 | 2026-11-08 | Gemma 26B-A4B seul ; Qwen 2.1 sur Lightning (4 pas) ; moteur MOSS-Image |
| #20 → #23 | 2026-11-08 | Jobs coupés par un redémarrage affichés en échec ; suite de la revue de code (historique et relance des jobs, voie CPU, file retenue, révisions épinglées, contraintes, CI, Gemma arrêté pendant le r2v) ; « Entrées » de la galerie ; points 9, 10, 20 de la revue |
| #24 → #27 | 2026-11-08 → 09 | Ligne de mise à jour dans le Moniteur ; piles de LoRA (4 au plus) ; LoRA de style sur Krea 2, Qwen 2.1 et MOSS (classement par préfixe de nom, trois formats communautaires, qkv fusionné de MOSS) |
| #28, #29 | 2026-11-09 | `scripts/docker-install.sh` et `.env.example` ; `updater_stale` |
| #30 | 2026-11-09 | Avancement H3 par pas de débruitage |
| #31 → #33 | 2026-11-10 | Installation du README en étapes numérotées ; licences de MOSS-Image, de sa LoRA turbo et de Gemma 4 |
| #35 | 2026-11-12 | Cette passation |
| #36, #38 | 2026-11-14 | Planche de sujet depuis une photo avec Qwen 2.1 : cinq vues (méthode d'après H3 Character Sheet Designer, MIT), portraits empilés à gauche, vraie vue de profil |
| #37 | 2026-11-14 | Refonte du Relay : look commun (« Cadrage »), durée totale en segments de 10 s, tableau de production, plan-séquence depuis n'importe quelle image, fondus de 25 ms aux raccords |
| #39 | 2026-11-15 | Les cartes du Relay suivent la durée totale ; une planche n'est jamais une première image |
| #40, #41 | 2026-11-16 → 17 | Coupes du Relay en H3 Ref2VA avec les planches et le décor ; segments continus en Ref2VA avec image de départ (`h3_start_frame.py`) |
| #42 | 2026-11-17 | Formulaire du Studio et réalisateur allégés (une action principale par étape, le reste replié), assemblage automatique de la chaîne |
| #43 | fermée le 2026-11-19, non fusionnée | Plan-séquence par images clés (images clés Qwen + FL2VA) : arrêté par le propriétaire, voir § 3 |
| #34, #45 | 2026-11-20 | Docs pour le dépôt public (aucun jeton pour cloner ou mettre à jour) ; ligne de la passation |
| #44 | 2026-11-20 | **Continuation latente** : `continue_from` de `h3-r2v`, les clips gardent leurs latents, `video-stitch` décode un plan-séquence une seule fois, -18 LUFS ([LONG-VIDEO.md](LONG-VIDEO.md)) |
| #46, #47 | 2026-11-20 | Fichiers de scénario au format H3, départ sans image (t2v), une scène décrite démarre en i2v sur son image, carte `long_take` de l'assistant ; Première image et Références (avec rôles) en entrées séparées |
| #48, #49 | 2026-11-20 | Galerie « → Première image » / « → Référence » ; une carte d'objectif avec son propre pipeline n'affiche pas de menu Pipeline |
| #50, #51 | 2026-11-20 → 21 | Une seule carte « Vidéo narrative » : coupes issues du découpage de Gemma, planches en un clic ; une nouvelle scène n'emporte rien du lieu précédent, pas d'éclairage ni de son communs entre scènes |
| #52 | 2026-11-21 | Storyboard retiré du Studio et de l'assistant (gardé sur le Canvas) |
| #53 | 2026-11-21 | Le formulaire « Vidéo à partir de références » remplace « Personnage + décor cohérents » (un clic, un job) |
| #54, #55 | 2026-11-21 | Carte plan-séquence de l'assistant en prose avec une durée totale ; segments du découpage marqués `new_shot`, visage gardé dans le cadre, aucune référence de décor entre scènes, références de la carte complétées par l'application |
| #56 | 2026-11-22 | Le segment 1 d'un plan-séquence sur une première image voit les références de sujet (`h3-r2v` + image de départ tenue 22 images) ; références écartées renumérotées dans les prompts |

## 10. Points ouverts

Rien de ce qui suit n'a été demandé pour maintenant ; chaque point attend le propriétaire.

**Vérifications sur GB10, jamais faites**
- r2v avec références clip et son (PR #11) : jamais rendu sur un GB10.
- Barre d'avancement H3 (PR #30, fusionnée avant tout rendu GPU) : confirmer qu'elle avance pas
  à pas sur un rendu H3.
- Temps de chargement de FastH3 OmniRef après le point 10 de la revue (export lu par
  `RangeFile`) : lire la prochaine ligne de journal `engine:` d'un chargement H3 (153 s mesurées
  avant).
- Plan-séquence : le correctif d'A6 qui renumérote les `<Subject N>` et écrit une référence
  écartée (le port, la maison) sous forme de sa description n'a pas été rendu à nouveau ; pas plus
  qu'un fichier de scénario avec une image de départ, ni les scènes `[Shot N]` d'un fichier.
- Planche de personnage depuis une photo (Qwen 2.1, cinq vues, PR #36/#38) : rendue par l'API
  sur trois sujets, jamais qualifiée par le propriétaire.

**Défauts connus et pistes**
- Plan-séquence avec une première image et des références : un **saut de luminosité** à la fin
  de la tenue de 0,9 s (luma −11, même plan).
- H3 **coupe vers un autre lieu** 1,2 s après le début du segment 3 du plan au café (C3 et C4,
  même graine) ; pas causé par la tenue. Un mouvement de segment dû à la graine se corrige par
  « Régénérer ».
- Une planche Krea 2 depuis le brief a dessiné un **fedora au lieu du bonnet de l'histoire** ;
  dans A6, le pêcheur a aussi tourné le dos environ 4 s et le bateau différait entre le port et
  la mer.
- Les raccords de la continuation latente se voient sur les mouvements rapides (6–14, mouvement
  interne au clip jusqu'à 18).
- Tête fantôme FL2VA (§ 3) : piste, ne plus écrire le mouvement de caméra dans un prompt de coupe
  qui a une image de fin ; à vérifier par un rendu.
- LoRA Qwen_2.1-Unchained à la force 1 : image plus sombre avec une fine trame de points (propre
  à 0,5). Conseil donné : l'utiliser entre 0,5 et 0,7.
- Inutilisé : le fichier de brouillon MTP facultatif du dépôt GGUF de Gemma (décodage plus
  rapide).

**Plus tard, ou volontairement pas fait (décisions du propriétaire)**
- **Points de sécurité « P4 » de la revue de code du 2026-11-08** : un jeton d'accès ou une
  authentification sur :8090, un middleware même-origine global, un contrôle d'Origin sur la
  WebSocket, un secret partagé entre le studio et l'updater, un conteneur non root. Écartés par
  le propriétaire ; ne les reproposer que sur demande.
- Revue d'installation du 2026-11-09 : D4–D8 (`data/` appartenant à root, caches Triton/CUDA hors
  de `/data` à mesurer…), U2 (sécurité), et B1–B6 pour le bare metal.
- **Installation bare metal en pause** depuis le 2026-10-30 (« une solution Docker qui marche
  d'abord ») : `scripts/install.sh` et [INSTALL.md](INSTALL.md) existent mais ne sont pas
  maintenus ; ils ignorent `docker/constraints.txt` et utilisent un torch 2.12 de PyPI non
  qualifié (Docker tourne sur le torch 2.10 de NGC).
- Cibles Omarchy et Windows 11 : pas commencées.
- **L'assistant dans le Canvas** : sur la feuille de route, pas commencé.
- Mettre en cache sur disque les poids H3 convertis en NVFP4 (environ 75 s gagnées par
  chargement H3) : seulement sur demande.
- Une LoRA de personnage pour l'identité sur les plans-séquences longs (candidat 4 de
  [LONG-VIDEO.md](LONG-VIDEO.md)) : pas commencée.
- Les LoRA image ne sont pas envoyées par les flux storyboard, campagne et planches du Canvas
  (non demandé).

**Retard de documentation** : [ROADMAP.md](ROADMAP.md) marque encore l'étape 1 « premier build
sur GB10 en attente » et l'étape 4 « passage complet sur le GB10 en attente » (faits tous les
deux le 2026-10-30, hors bare metal), et ne dit rien du plan-séquence. À mettre à jour la
prochaine fois que la feuille de route est touchée.

## 11. Travailler avec le propriétaire

- Écrire au propriétaire **en français** (chat, fils, cartes de décision). Code, commits, PR et
  documents restent en anglais, les documents avec leur traduction française.
- Donner des **étapes vérifiées et autonomes** : les commandes exactes dans l'ordre, sur quelle
  machine et dans quel dossier, quoi attendre, et quel résultat obtenir (par exemple le titre de
  `git log --oneline -1` à voir). Le propriétaire n'aime pas les commandes par tâtonnement. Un
  changement d'interface demande quand même une reconstruction de l'image (§ 5) ; dire « un git
  pull suffit » a été faux une fois.
- Avant toute consigne de reconstruction, dire d'attendre la fin des jobs en cours.
- Le propriétaire décide du périmètre et de la qualification : proposer, recommander une option,
  et ne pas ajouter de fonctions, d'options ni de modèles non demandés ; aucun modèle non validé
  n'est jamais listé.
- Le propriétaire juge sur le résultat à l'écran et sur la simplicité d'usage (« il faut que ce
  soit simple à l'usage »), pas sur le nombre de correctifs : montrer le rendu, dire clairement
  ce qui ne va pas encore.
- Ne jamais supprimer de fichiers de test ni de rendus sur une machine sans l'accord du
  propriétaire.
- Les licences comptent (contexte de démonstration Dell) : rappeler les exclusions territoriales
  de MiniMax H3 et la licence non commerciale de Qwen Image 2.1 dès qu'il est question d'usage
  commercial.
