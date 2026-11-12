# Passation

Version anglaise : [../HANDOVER.md](../HANDOVER.md).

Cette page permet à quelqu'un (une personne ou un modèle d'IA) de reprendre le développement
d'OnPrem Media Studio sans contexte préalable. C'est un instantané du **2026-11-12, `main` à
`21148ea`** (PR #33). Elle résume les documents de référence et y renvoie ; en cas de désaccord,
le code et les documents de référence l'emportent. À lire ensuite, dans cet ordre :
[AGENTS.md](../../AGENTS.md), [ARCHITECTURE.md](ARCHITECTURE.md), [LESSONS.md](LESSONS.md),
[adr/0001-inference-stack.md](adr/0001-inference-stack.md), puis la page du moteur concerné
([IMAGE-ENGINES.md](IMAGE-ENGINES.md), [H3.md](H3.md)).

## 1. Objectif et périmètre

OnPrem Media Studio 2.0 est un studio privé d'images et de vidéos par IA qui tourne entièrement
sur la machine de l'utilisateur. Il succède à AI Content Studio 1.4 (dépôt
`yoyo-sama/dellaicontent`, une interface statique qui pilote ComfyUI et Ollama). Les objectifs
fixés par le propriétaire du projet (GitHub `yoyo-sama`) le 2026-10-29 :

- **Autonome** : ni ComfyUI, ni Ollama, ni génération dans le cloud. L'application fait tourner
  les modèles elle-même et télécharge les poids nécessaires à la première utilisation.
- **Même couverture fonctionnelle que la 1.4** : Text2Image, Image2Image, campagne, planches de
  sujet et de décor, le réalisateur de storyboard (planches, images de plan, cuts, animatic),
  référence vers vidéo, Relay, le Canvas, la galerie, la mise à jour depuis l'interface. En plus,
  nouveau en 2.0 : l'assistant de création (un chat à rôles), MOSS-Image, l'agrandissement ×2,
  les piles de LoRA sur tous les moteurs.
- **Les leçons de la 1.4 sont reprises** ([LESSONS.md](LESSONS.md)).
- **Cibles** : DGX OS sur GB10 (ARM64, mémoire unifiée) d'abord, en Docker. Ubuntu ensuite.
  Omarchy et Windows 11 (x86 et ARM64) plus tard. Bare metal plus tard (voir § 9).
- **Le nom du produit doit rester facile à changer** : il n'existe que dans `studio/config.py`
  (`APP_NAME`, `STUDIO_APP_NAME`) ; le paquet s'appelle `studio`, le préfixe d'environnement
  `STUDIO_`.
- **Maestro et WanGP servent seulement de référence** (licence non commerciale) : ne jamais
  copier leur code, ne jamais en dépendre.

Le dépôt est **public** depuis le 2026-11-10.

## 2. L'architecture en un écran

Un conteneur Docker, un port (8090), un processus Python (FastAPI) avec un fil de travail GPU et
un fil de travail CPU, plus un processus enfant `llama-server` pour Gemma, lancé à la demande. Un
second service compose, `updater`, fait la mise à jour depuis l'interface. Détails :
[ARCHITECTURE.md](ARCHITECTURE.md).

| Sujet | Choix |
|---|---|
| Serveur | FastAPI (`studio/main.py`), file de jobs `studio/jobs.py` (historique dans `data/jobs.json`) |
| Moteurs d'image | diffusers 0.42.1 de Hugging Face, poids officiels (`studio/pipelines/krea2.py`, `qwen.py`, `moss.py`) |
| Moteurs vidéo | FastVideo (commit épinglé dans `docker/Dockerfile`) pour MiniMax H3 (`h3.py`, `h3_runtime.py`, `h3_upscaler.py`, `h3_lora.py`) |
| LLM | `llama-server` de llama.cpp b11982 compilé pour sm_121, Gemma 4 26B-A4B GGUF + mmproj (`studio/llm.py`) |
| Téléchargement des modèles | `huggingface_hub`, fichier par fichier, marqueur `.complete`, `revision` épinglée par entrée du catalogue (`studio/models.py`, `studio/catalog.json`) |
| Compilateurs de prompt | Le moteur JavaScript de la 1.4 porté en anglais, côté interface (`web/js/prompts.js`) ; le serveur ne fait que l'inférence et reçoit des prompts finaux (ADR 0001) |
| Interface | `web/index.html` (modes Assistant et Studio) et `web/canvas.html`, sans étape de build, FR/EN/ES/DE ([FRONTEND.md](FRONTEND.md)) |
| Assistant | `studio/assistant/` (rôles dans `roles/*.md`, outils, `/api/chat` en SSE) ([ASSISTANT.md](ASSISTANT.md)) |
| Galerie, mise à jour, envoi de LoRA | `studio/gallery.py` (SQLite/FTS5), `studio/update.py`, `docker/updater/server.py`, `studio/loras.py` ([GALLERY.md](GALLERY.md)) |
| Empaquetage | Image de base NGC PyTorch **25.11** (torch 2.10, CUDA 13), versions Python exactes dans `docker/constraints.txt` |

Contrat clé : un pipeline est une sous-classe de `Pipeline` (`studio/pipelines/`) avec les ids du
catalogue dont il a besoin (`models`), un `validate()` qui refuse les paramètres inconnus en 422
et renvoie les paramètres normalisés, et un `run()`. Rien ne crée de job hormis l'envoi d'un
client.

## 3. Moteurs et modèles

Toutes les entrées de `studio/catalog.json` sont `"qualified": true`, chacune épinglée sur le
commit Hugging Face de son rendu qualifié.

| Id de pipeline | Usage | Modèle (id du catalogue) | Licence | Qualifié |
|---|---|---|---|---|
| `krea2-t2i` | Texte vers image, campagne, planches | Krea 2 Turbo (`krea2-turbo`), 8 étapes | Licence Krea 2, **à accès restreint** (`HF_TOKEN` + licence acceptée sur Hugging Face) | gb10-demo, 2026-10-30 (7/7 cas) |
| `qwen-image-2.1` | Image vers image, images de plan (planches + décor + références), texte vers image | Qwen Image 2.1 (`qwen-image-2.1`) avec le transformer Lightning v2 RL (`qwen-image-2.1-lightning`), 4 étapes | Qwen Research License, **non commerciale** | base 2026-10-30 ; Lightning sur promaxgb10-95c7, 2026-11-07 (LESSONS n° 46) |
| `moss-image` | Texte vers image avec du texte dans l'image | MOSS-Image SFT (`moss-image-sft`) + LoRA turbo (`moss-image-turbo-lora`) ; modes Aperçu 4 / Standard 8 (défaut) / Qualité 25 | Apache-2.0 | promaxgb10-95c7, 2026-11-08 |
| `h3-t2v`, `h3-i2v` | Texte, image, première/dernière image (FL2VA) vers vidéo avec son | FastH3 V2 NVFP4 (`fasth3-v2-nvfp4`) | MiniMax H3 Community License (**exclut UE, Royaume-Uni, Corée du Sud, USA** ; un produit commercial doit afficher « MiniMax H3 ») | gb10-demo, 2026-10-30 |
| `h3-r2v` | Références (≤ 9 images, 3 clips, 3 sons) vers vidéo, deux passes | FastH3 OmniRef NVFP4 (`fasth3-omniref-nvfp4`) + upscaler latent (`h3-latent-upscaler`, Apache-2.0) | idem | gb10-demo, 2026-10-30 |
| `upscale-2x` | Image ou vidéo ×2 depuis la galerie | SPAN 2xNomosUni (`span-2x-nomosuni`) via spandrel | CC BY 4.0 (crédité dans `NOTICE`) | gb10-demo, 2026-11-06 |
| (LLM) | Enrichissement des prompts et chat de l'assistant | Gemma 4 26B-A4B Q4_0 (`gemma4-26b-a4b`) | Apache-2.0 | 2026-11-07 (amendement de l'ADR 0001) |
| `video-concat`, `image-grid`, `video-frames` | Montage sur le fil CPU (ffmpeg, Pillow) | aucun | — | — |

**Abandonnés, et pourquoi** (ne pas les réintroduire sans demande du propriétaire) :

| Modèle | Abandonné le | Raison |
|---|---|---|
| LTX 2.5 (et tout LTX) | 2026-10-29 | Décision du propriétaire : MiniMax H3 le remplace sur tous les chemins vidéo |
| Qwen-Image-Edit 2509 | 2026-10-29 | Inutile : Qwen Image 2.1 couvre toutes les retouches de la 1.4 (références symétriques, jusqu'à 10 images) |
| Checkpoints H3 FP8 (`FastH3-8-Step-V2-FP8`, `FastH3-OmniRef-FP8`) et `STUDIO_H3_PRECISION` | 2026-11-07 (PR #16) | Jamais rendus, donc jamais qualifiés ; le propriétaire ne veut aucun modèle non validé dans la liste |
| Gemma 4 E4B | 2026-11-07 (PR #17) | Un seul LLM suffit ; le 26B-A4B suit les longues consignes de rôle et appelle les outils |
| Transformer de base de Qwen Image 2.1 (25 étapes) et le Turbo officiel 8 étapes | 2026-11-07 (PR #18) | Lightning est 2,9 à 3,6 fois plus rapide en gardant l'identité ; Turbo n'était que 2 fois plus rapide, plus sombre et plus terne |
| FP8 torchao sur les moteurs d'image | 2026-11-05 | 300 fois plus lent par étape sur le GB10 (LESSONS n° 43) |
| `torch.compile` sur Krea 2 | 2026-11-05 | Environ 33 s de compilation par taille pour 6 s gagnées par image |
| DLSS 5, RTX Video SDK, nvidia-vfx | 2026-11-06 | Rien de NVIDIA ne tourne sur le GB10 (Windows ou x86 seulement, moteurs de jeu) ; SPAN les remplace (LESSONS n° 44) |
| LoRA communautaires de MOSS (Fizgig, KOOK, lodestones DMD, Kromoss…) | 2026-11-07 | Redondantes, sans licence, ou rendus moins bons que la LoRA turbo à 8 étapes |

**Limites connues des moteurs** : en FL2VA, une seconde tête fantôme apparaît (images ~30 à
~100) quand la première et la dernière image ont des cadrages très différents, piste non
vérifiée ([H3.md](H3.md#qualification)) ; les clips H3 font 5 à 15 s (FastVideo) ; MOSS en
Aperçu peut doubler un mot de titre, Standard tire vers une lumière de coucher de soleil ;
Qwen Lightning ajoute du contraste et des structures parasites en texte vers image ; deux
sujets au plus par image de plan (LESSONS n° 24).

## 4. Installation et mise à jour sous Docker

Le README contient les étapes vérifiées ([README.fr.md](../../README.fr.md)). En bref, sur la
machine :

```bash
git clone https://github.com/yoyo-sama/onprem-media-studio.git && cd onprem-media-studio
scripts/docker-install.sh --check   # ne change rien ; dit quoi corriger (Docker, toolkit NVIDIA, port, disque)
scripts/docker-install.sh           # .env (600) depuis .env.example, ./data, build, démarrage, attente de /api/health
nano .env                           # HF_TOKEN=hf_... (Krea 2 seulement), puis : docker compose up -d
```

- Le port 8090 est aussi celui de la 1.4 : sur une machine où elle tourne, mettre
  `STUDIO_HOST_PORT=8096` dans `.env`.
- Modèles et rendus vont dans `./data` (`STUDIO_DATA` pour un autre disque) ; prévoir 300 Go.
- `python -m studio.import14` reprend l'upscaler H3, l'encodeur de texte de Qwen 2.1 et les
  LoRA H3 d'une installation 1.4 (README § Reprendre les fichiers).
- **Mise à jour** : la ligne « Mise à jour » du panneau Moniteur demande au service `updater` un
  `git pull`, la reconstruction de l'image, le blocage de la file, puis la recréation du studio
  quand aucun job ne tourne. À la main : `git pull && scripts/docker-install.sh` (refuse tant
  qu'un job tourne ou qu'un modèle se télécharge).
- **L'updater ne se reconstruit jamais lui-même** : après un changement de `docker/updater/`,
  lancer une fois `docker compose up -d --build updater` sur chaque machine (le Moniteur le
  signale, `updater_stale`).
- `web/` et `studio/` sont copiés dans l'image : un `git pull` seul ne change rien sur une
  machine en marche, il faut reconstruire l'image, puis Ctrl+Maj+R dans le navigateur.
- Diagnostic : `curl -s localhost:8090/api/health`, et
  `docker logs studio 2>&1 | grep -E "llm:|engine:|render:"` (un tour de chat lent se confond
  facilement avec un rendu lent).

## 5. Machines de test

Trois GB10 (DGX OS, ARM64, ~121 Gio de mémoire unifiée). **Ne rien supposer d'une machine à
l'autre : chemins, utilisateurs, état.**

| Machine | Utilisateur | Rôle |
|---|---|---|
| `gb10-demo` | `spark` | Première machine de test de la 2.0 (qualifications du 2026-10-30, agrandissement ×2). Manquait de disque le 2026-10-30. |
| `promaxgb10-95c7` | `spark` | Machine du propriétaire avec l'installation Docker (dépôt `/home/spark/onprem-media-studio`, conteneur `studio`). La plupart des mesures depuis le 2026-11-07. Accessible par Remote Control, que le propriétaire active depuis Claude Desktop ; sa session Claude n'a pas le droit de lancer `docker compose build`, le propriétaire le lance alors à la main. `data/` y appartient à root : y écrire via `docker exec`. Contient ~200 Go de modèles ComfyUI d'un autre outil dans `~/.zcode` : pas à nous, ne pas y toucher. |
| `promaxgb10-6c5f` | `sparks` | Héberge la **1.4** (ComfyUI, `comfyui-nvidia`, open-webui, spark-control-center). Pas une machine de test de la 2.0. |

Avant de tester une branche sur une machine, relever sa branche courante et l'étiquette
`studio.commit` de l'image en marche
(`docker inspect studio --format '{{index .Config.Labels "studio.commit"}}'`), puis la remettre
en place ensuite. Le 2026-11-09, un test a fait perdre sans bruit un correctif que la machine
faisait tourner depuis une autre branche.

Rendus et qualifications se font uniquement sur un GB10. Le conteneur cloud des sessions Claude
n'atteint ni huggingface.co ni download.pytorch.org (PyPI et GitHub fonctionnent) : les tests
torch (`tests/test_image_lora_models.py`) ne tournent que sur le GB10.

## 6. Règles apprises (en plus de LESSONS.md)

Les règles permanentes du propriétaire sont dans [AGENTS.md](../../AGENTS.md) ; les 49 leçons
techniques dans [LESSONS.md](LESSONS.md). Les plus souvent en jeu :

1. **Aucun modèle non qualifié dans le catalogue.** Une entrée arrive en `"qualified": false` ;
   seul un rendu réel sur le GB10, regardé (images, bords, dégradés, son) et **accepté par le
   propriétaire**, la passe à true, avec `revision` épinglée sur le commit de ce rendu. Un statut
   `success` ne prouve rien.
2. **Ne jamais reconstruire ni redémarrer le studio pendant un job ou un téléchargement de
   modèle.** Les jobs vivent en mémoire du serveur ; un rebuild du 2026-11-08 a tué un rendu H3
   OmniRef. Utiliser `scripts/docker-install.sh` (il vérifie) et dire au propriétaire d'attendre
   la fin des jobs avant tout `docker compose up -d --build`.
3. **Rien ne se rend sans un clic**, et **le prompt de l'utilisateur part tel quel** (les
   invariants du graphe sont remis par le code). Testé par `tools/assistant-ui.js` et
   `tools/prompt-systems.js`.
4. **Vitesse sur GB10** : ne jamais projeter les poids en mémoire (mmap) (`disable_mmap`,
   `common.from_pretrained`, `h3_runtime.WholeFile`/`RangeFile`) ; pas de FP8 torchao ;
   `torch.compile` seulement là où il est rentable (Qwen seulement avant Lightning, désactivé
   depuis) ; mesurer la mémoire système disponible, pas la « VRAM libre ».
5. **Mémoire** : un seul moteur H3 tient ; Gemma (17 Go) est arrêté avant chaque rendu r2v et
   quand un moteur H3 a besoin de la mémoire ; les moteurs d'image restent chargés tant que la
   mémoire le permet (LRU).
6. **FlashInfer** : `MAX_JOBS=4` et son cache sur `/data/cache`, sinon le premier job NVFP4
   épuise la mémoire du GB10 (LESSONS n° 36).
7. **Les références image de H3 ne sont jamais agrandies**, seulement réduites à 2048 px de petit
   côté, comme dans ComfyUI (FastVideo les agrandit : r2v 2,6 fois plus lent, LESSONS n° 38).
8. **Réflexion de Gemma** : coupée pour les appels de compilation (`enable_thinking: false` ;
   elle coûtait 44 à 81 s par appel) ; le chat la garde, plafonnée à 2048 jetons de réflexion,
   puis redemande sans réflexion. llama.cpp b11982 n'a ni `--reasoning-budget` ni `--no-mmap`.
9. **Épingler ce qui a été qualifié** : révisions des modèles dans le catalogue, versions Python
   dans `docker/constraints.txt`, tag de base NGC, tag llama.cpp et commit FastVideo dans le
   Dockerfile. peft reste sous 0.19 (0.19+ refuse le torchao de NGC 25.11).
10. **Montée de version de FastVideo** : revérifier les deux classes d'étape enveloppées par
    `h3_runtime.report_stages` (`MiniMaxH3DenoisingStage`, `MiniMaxH3VideoDecodingStage`) et
    l'appel `scheduler.step` par étape ; garder la règle « jamais d'agrandissement des
    références ».
11. **Mesurer, pas deviner** : chaque gain de vitesse du projet vient d'un banc de
    `tools/qualify/` (`load_speed.sh`, `render_speed.sh`, `qwen_fast_bench.sh`, `moss_bench.py`,
    `run_upscale.py`). Un banc lancé par `docker exec -i studio python - < script` n'apparaît que
    comme `python -` dans le conteneur ; ne jamais lancer deux bancs à la fois (les deux peuvent
    redémarrer le studio).

## 7. Façon de travailler

- Code, commentaires, journaux, messages de commit, descriptions de PR et documents sont en
  **anglais** ; chaque document a sa traduction française sous `docs/fr/` (et `README.fr.md`),
  mise à jour dans le même changement. L'interface est en FR/EN/ES/DE, au tutoiement.
- Une branche et une PR par chantier, depuis `main`. Le propriétaire lit la PR et dit quand
  fusionner ; une branche dont la PR est fusionnée repart de `main` pour un nouveau chantier.
- Avant de demander une fusion : `python -m pytest`, et pour tout changement d'interface, de
  prompt ou de consigne : `node tools/parity-prompts.js` (demande `../dellaicontent`),
  `tools/prompt-systems.js`, `tools/assistant-ui.js`, `tools/lora-ui.js` (commandes dans
  AGENTS.md). GitHub Actions les lance sur chaque PR ; le test de parité seulement si le secret
  `DELLAICONTENT_TOKEN` est défini.
- Modifier un compilateur de prompt ou une consigne Gemma fait échouer exprès les tests de
  parité et d'empreinte : mettre à jour la référence dans le même commit et dire pourquoi.
- « Le plus simple qui marche » : aucune option, abstraction ou fonction au-delà de la demande.

## 8. Historique des PR

| PR | Date | Contenu |
|---|---|---|
| #1, #4 | 2026-10-30 | Étape 1 : serveur FastAPI, catalogue et téléchargement des modèles, file de jobs, Gemma via llama.cpp, image Docker ; correctifs du premier build sur GB10 |
| #2 | 2026-10-30 | Étape 2 : moteurs Krea 2 et Qwen Image 2.1, qualifiés |
| #3 | 2026-10-30 | Étape 3 : MiniMax H3 via FastVideo (t2v/i2v/FL2VA sur FastH3 V2, Ref2VA en deux passes sur OmniRef avec notre upscaler latent, pile de LoRA), NVFP4 qualifié |
| #5 | 2026-10-30 | Étape 4 : interface Studio et Canvas portée de la 1.4, galerie, mise à jour depuis l'interface, i18n, `install.sh` bare metal (en pause) |
| #6, #7 | 2026-10-30 | Moteurs gardés en mémoire (budget LRU) ; `studio.import14` reprend les fichiers de la 1.4 |
| #8, #9 | 2026-10-31 → 11-01 | Assistant de création (7 rôles, cartes, personnage animé, premier mode) ; avancement du rendu sur les cartes, planches transmises au réalisateur, planche depuis une photo, réflexion de Gemma coupée pour les appels de compilation |
| #10 | 2026-11-05 | Chargements sans mmap, Qwen compilé, journaux de durée de rendu, lecteur vidéo et « Régénérer la vidéo » |
| #11, #12 | 2026-11-05 → 06 | Référence vers vidéo depuis la carte de l'assistant et le Studio, avec références image, clip et son ; les vidéos d'une seule scène vont vers la carte r2v |
| #13 | 2026-11-08 | Lignes de journal des rendus H3 ; budget de réflexion du chat |
| #14 | 2026-11-06 | Agrandissement ×2 (SPAN), après avoir écarté DLSS 5 |
| #15, #16 | 2026-11-07 | Mise à jour depuis l'interface sous Docker (service `updater`) ; H3 FP8 retiré |
| #17, #18, #19 | 2026-11-08 | Gemma 26B-A4B seul ; Qwen 2.1 sur Lightning (4 étapes) ; moteur MOSS-Image |
| #20 → #23 | 2026-11-08 | Jobs coupés par un redémarrage affichés en échec ; suite de la revue de code (historique et relance des jobs, fil CPU, blocage de la file, révisions épinglées, contraintes, CI, Gemma arrêté pendant le r2v) ; vue « Entrées » de la galerie ; points 9, 10 et 20 de la revue |
| #24 → #27 | 2026-11-08 → 09 | Ligne de mise à jour dans le Moniteur ; piles de LoRA (4 au plus) ; LoRA de style sur Krea 2, Qwen 2.1 et MOSS (classement par préfixe de nom, trois formats communautaires, qkv fusionné de MOSS) |
| #28, #29 | 2026-11-09 | `scripts/docker-install.sh` et `.env.example` ; `updater_stale` |
| #30 | 2026-11-09 | Avancement de H3 à chaque étape de débruitage |
| #31 → #33 | 2026-11-10 | Installation du README en étapes numérotées ; licences de MOSS-Image, de sa LoRA turbo et de Gemma 4 |
| **#34 (ouverte)** | 2026-11-10 | Docs pour le dépôt public : aucun jeton pour cloner ni mettre à jour ; `STUDIO_GIT_TOKEN` gardé pour un fork privé. Attend le feu vert du propriétaire. Tant qu'elle n'est pas fusionnée, le README et `.env.example` de `main` décrivent encore un dépôt privé. |

## 9. Points ouverts

Rien ci-dessous n'a été demandé pour maintenant ; chaque point attend le propriétaire.

**Vérifications sur un GB10**
- Barre d'avancement H3 (PR #30, fusionnée avant tout rendu GPU) : confirmer sur
  promaxgb10-95c7 qu'elle avance étape par étape sur un rendu H3.
- Durée d'un r2v FastH3 OmniRef sur promaxgb10-95c7 après la dernière mise à jour (le gain de
  chargement du point 10 de la revue se lit sur la prochaine ligne `engine:` d'un chargement H3 ;
  153 s mesurées avant).
- r2v avec des références clip et son (PR #11) : jamais rendu sur un GB10.
- Planche personnage depuis une photo (Qwen Image 2.1, PR #9) : jamais qualifiée.
- Les poids de l'upscaler SPAN ne sont pas encore téléchargés sur promaxgb10-95c7
  (automatique à la première utilisation).

**Défauts connus et pistes**
- Tête fantôme en FL2VA (§ 3) : la piste est de ne plus écrire le mouvement de caméra du plan
  dans un prompt de cut qui a une image de fin ; à vérifier par un rendu.
- LoRA Qwen_2.1-Unchained à la force 1 : image plus sombre avec une fine trame de points (propre
  à 0,5) ; l'ordre `[gate; up]` de ses clés fusionnées n'est pas tranché. Conseil donné :
  l'utiliser entre 0,5 et 0,7.
- Non utilisé : le fichier de brouillon MTP optionnel du dépôt GGUF de Gemma (décodage plus
  rapide).

**Volontairement non faits (décisions du propriétaire)**
- **Points de sécurité « P4 » de la revue de code du 2026-11-08** : jeton d'accès ou
  authentification sur :8090, middleware same-origin global, contrôle d'Origin sur la
  WebSocket, secret partagé entre le studio et l'updater, conteneur non root. Exclus par le
  propriétaire ; à reproposer seulement s'il le demande.
- Revue d'installation du 2026-11-09 : D4–D8 (`data/` appartenant à root, caches Triton/CUDA
  hors de `/data` à mesurer…), U2 (sécurité) et B1–B6 pour le bare metal.
- **Installation bare metal en pause** depuis le 2026-10-30 (« d'abord une solution Docker qui
  marche ») : `scripts/install.sh` et [INSTALL.md](INSTALL.md) existent mais ne sont pas
  maintenus ; ils ignorent `docker/constraints.txt` et prennent un torch 2.12 PyPI non qualifié
  (Docker tourne sur le torch 2.10 de NGC).
- **L'assistant dans le Canvas** est sur la feuille de route, pas commencé.
- Cibles Omarchy et Windows 11 : pas commencées.
- Les LoRA d'image ne sont pas envoyées par les flux storyboard, campagne et planches (non
  demandé).

**Écart de documentation** : [ROADMAP.md](ROADMAP.md) indique encore pour l'étape 1 « premier
build sur GB10 en attente » et pour l'étape 4 « passage complet sur le GB10 en attente » ; les
deux ont eu lieu le 2026-10-30 (sauf la partie bare metal de l'étape 4). À mettre à jour à la
prochaine retouche de la feuille de route.

## 10. Travailler avec le propriétaire

- Écrire au propriétaire **en français** (chat, fils, cartes de décision). Code, commits, PR et
  documents restent en anglais, les documents avec leur traduction française.
- Donner des **étapes vérifiées et autonomes** : les commandes exactes dans l'ordre, la machine
  et le dossier, ce qu'il faut attendre et le résultat attendu (par exemple le titre affiché par
  `git log --oneline -1`). Le propriétaire n'aime pas les commandes par essais successifs. Un
  changement d'interface demande quand même une reconstruction de l'image (§ 4) ; dire « un
  git pull suffit » a déjà été une erreur.
- Avant toute consigne de reconstruction, dire d'attendre la fin des jobs en cours.
- Le propriétaire décide du périmètre et de la qualification : proposer, recommander une option,
  et ne pas ajouter de fonctions, d'options ou de modèles non demandés.
- Les licences comptent (contexte de démonstration Dell) : rappeler les territoires exclus par
  MiniMax H3 et la licence non commerciale de Qwen Image 2.1 dès qu'un usage commercial est
  évoqué.
