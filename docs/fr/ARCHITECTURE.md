# Architecture

Version anglaise (de référence) : [../ARCHITECTURE.md](../ARCHITECTURE.md). Décisions de
conception : [adr/](adr/).

## Vue d'ensemble

```
navigateur ──HTTP/WS──> studio (FastAPI, :8090)
                          ├─ /api/models   catalogue + téléchargement (huggingface_hub)
                          ├─ /api/inputs   envoi d'image, de vidéo ou de son → référence pour les jobs
                          ├─ /api/jobs     file → un worker GPU → pipelines (diffusers, FastVideo) ; jobs CPU sur un second worker
                          ├─ /api/llm      llama-server (Gemma 4 26B-A4B, 127.0.0.1:8095)
                          ├─ /api/chat     assistant de création : rôles, conversations, cartes
                          ├─ /api/gallery  index des sorties : recherche, miniatures, tags, corbeille
                          ├─ /api/update   mise à jour depuis l'interface : dépôt git, ou service updater (Docker)
                          ├─ /api/loras    liste et téléversement de LoRA
                          ├─ /api/instructions  consignes Gemma remplacées dans les paramètres
                          ├─ /api/ws       événements de jobs et de téléchargements
                          ├─ /inputs       images envoyées
                          ├─ /outputs      fichiers rendus
                          └─ /             front end (web/)
```

Tout tourne dans un seul processus, plus un processus enfant `llama-server` démarré à la première
requête LLM.

## Organisation du code

| Chemin | Rôle |
|---|---|
| `studio/config.py` | Réglages lus dans les variables d'environnement ; **le nom affiché n'existe qu'ici** |
| `studio/catalog.json` | Tous les modèles téléchargeables : dépôt, fichiers, licence, accès restreint, qualifié |
| `studio/models.py` | `ModelStore` : état installé, téléchargement fichier par fichier avec reprise, contrôle du disque |
| `studio/import14.py` | `python -m studio.import14` : reprend les modèles et les LoRA H3 d'une installation 1.4 (fichiers identiques, fragments reconstruits, contrôlés par SHA-256) |
| `studio/jobs.py` | `JobQueue` : soumission, un worker GPU et un worker CPU (jobs de montage, `Pipeline.gpu = False`), progression, annulation, événements, historique dans `jobs.json` |
| `studio/files.py` | `FileStore` : images envoyées, références `inputs/…` et `outputs/…` |
| `studio/pipelines/` | Contrat `Pipeline` et registre ; une sous-classe par moteur |
| `studio/pipelines/krea2.py`, `qwen.py`, `moss.py` | Moteurs d'image (Krea 2, Qwen Image 2.1, MOSS-Image) : [IMAGE-ENGINES.md](IMAGE-ENGINES.md) |
| `studio/pipelines/h3.py` | Moteurs vidéo (MiniMax H3 : texte, image, première/dernière image et références vers vidéo), géométrie et plan d'affinage : [H3.md](H3.md) |
| `studio/pipelines/h3_runtime.py` | Adaptateur FastVideo : recettes Spark, profil NVFP4, sortie latente et réglages de la passe d'affinage, annulation |
| `studio/pipelines/h3_upscaler.py`, `h3_lora.py` | Upscaler latent H3 (convolutions 3D, checkpoint LBH v1) et pile de LoRA (fusion exacte en une seule branche parallèle) |
| `studio/pipelines/montage.py` | Jobs CPU sur des fichiers rendus, avec ffmpeg et Pillow : `video-concat` (clips bout à bout), `image-grid` (planche contact), `video-frames` (images proches de la fin d'un clip, pour les transitions du Relay) ; ils tournent sur le worker CPU, jamais derrière un rendu |
| `studio/pipelines/upscale.py` | `upscale-2x` : une image ou une vidéo deux fois plus grande par le réseau SPAN, sur un clic de la galerie : [IMAGE-ENGINES.md](IMAGE-ENGINES.md#résolution-2) |
| `studio/pipelines/common.py` | Contrôle des paramètres, pipelines gardés en mémoire (le moins récemment utilisé libéré quand le suivant ne tient pas), progression par étape, sortie PNG |
| `tools/qualify/` | Cas de qualification tirés des compilateurs de prompt de la 1.4, et leur lanceur |
| `studio/llm.py` | `LlamaServer` : démarrage à la demande (contexte de 32k, un emplacement), appel chat OpenAI, appel en flux avec outils, vision par images base64 ; arrêté quand un moteur H3 a besoin de la mémoire, et avant chaque rendu r2v |
| `studio/gallery.py` | `Gallery` : index SQLite/FTS5 des sorties, miniatures, tags, favoris, renommage, corbeille : [GALLERY.md](GALLERY.md) |
| `studio/update.py`, `loras.py` | Mise à jour depuis l'interface (avance rapide git et redémarrage sur place, ou transmise au service updater sous Docker) et téléversement de LoRA : [GALLERY.md](GALLERY.md) |
| `docker/updater/server.py` | Le service `updater` de `compose.yaml` : pull, reconstruction de l'image, conteneur du studio recréé une fois la file vide : [GALLERY.md](GALLERY.md#docker-docker-compose) |
| `studio/assistant/` | Assistant de création : registre des rôles (`roles.py`, rôles livrés dans `roles/*.md`), outils et leurs vérifications (`tools.py`), routage, tours et conversations (`chat.py`, `/api/chat`, `/api/roles`, `/api/chats`) : [ASSISTANT.md](ASSISTANT.md) |
| `studio/instructions.py` | Consignes Gemma remplacées depuis l'interface, gardées dans `STUDIO_DATA_DIR/instructions.json` (`/api/instructions`) ; celles par défaut vivent dans `web/js/prompts.js` |
| `studio/guard.py` | Contrôle de même origine des routes qui déplacent ou écrivent des fichiers |
| `studio/main.py` | API HTTP/WebSocket et fichiers statiques ; `/api/health` donne l'application, le GPU, la mémoire, l'état du LLM, le nombre de jobs en file et de téléchargements de modèles hors job, et si la file est en attente d'une mise à jour |
| `web/index.html`, `web/canvas.html` | Front end : le Studio et le Canvas, portés de la 1.4, sans étape de build : [FRONTEND.md](FRONTEND.md) |
| `web/js/prompts.js` | Compilateurs de prompts et consignes Gemma de la 1.4, une seule copie pour les deux pages (les prompts sont compilés côté front, ADR 0001) |
| `tools/parity-prompts.js`, `tools/prompt-systems.js` | Tests de non-régression du front contre la 1.4 : parité des prompts et consigne Gemma par moteur : [FRONTEND.md](FRONTEND.md#tests) |
| `docker/Dockerfile` | Base NGC PyTorch + llama.cpp compilé pour sm_121 + FastVideo et ses noyaux compilés pour sm_121a |

## Cycle de vie d'un job

1. Le client poste `{"pipeline": id, "params": {...}, "origin": fonction}` (`origin`, facultatif,
   nomme la fonction du front pour la galerie et n'est jamais lu par un pipeline). `Pipeline.validate` rejette une entrée
   invalide (paramètre inconnu, référence d'image absente) en 422 avant toute mise en file, et
   renvoie les paramètres que le job conserve, valeurs par défaut remplies et graine tirée.
2. Le worker prend les jobs dans l'ordre. Les modèles manquants (`Pipeline.models`) sont
   téléchargés d'abord, dans le job, et le téléchargement apparaît dans la progression du job.
3. `Pipeline.run(params, chemins_modèles, ctx)` rend et renvoie les fichiers écrits dans
   `ctx.output_dir` ; le job les liste sous forme de références (`outputs/…`). `ctx.files` résout
   les références d'image. `ctx.progress()` publie la progression et lève une exception si le job
   a été annulé ; les moteurs d'image l'appellent à chaque étape de débruitage, une annulation
   arrête donc un rendu en une étape au plus. Les moteurs vidéo interrompent directement
   FastVideo (H3.md).
4. Statut : `queued → running → done | error | cancelled`. Chaque changement est poussé sur
   `/api/ws` ; les sorties d'un job terminé sont dans la galerie avant l'envoi de son événement
   `done`. Un redémarrage (`docker compose up -d --build`, une mise à jour) coupe le job en cours
   et ceux en file. Les 200 derniers jobs sont gardés dans `STUDIO_DATA_DIR/jobs.json` (et en
   mémoire, avec tout job encore en file ou en cours), écrit à
   chaque changement de statut : après un redémarrage, un job qui était en file ou en cours est
   relu en échec avec `interrupted: true` (« the server restarted during this job »), et la file
   de jobs du Studio l'affiche avec un bouton « Relancer » (`POST /api/jobs/{id}/retry` : mêmes
   paramètres que ceux envoyés au départ, même seed). Il ne repart jamais tout seul. Les
   identifiants de job portent un préfixe propre à chaque démarrage (`job-<6 hex>-<n>`) : une page
   ne confond jamais un nouveau job avec celui qu'elle attendait. À la reconnexion du socket, une
   page qui attend encore un job lit son état, en échec si un redémarrage l'a coupé, au lieu de
   garder sa dernière progression indéfiniment. Une carte
   de l'assistant enregistrée comme en cours avant le démarrage du serveur est relue en échec pour
   la même raison, et son bouton fonctionne de nouveau.

Aucun chemin de code ne crée un job de lui-même.

## Dossier de données

`STUDIO_DATA_DIR` (défaut `~/.local/share/studio`, `/data` dans Docker) :

```
models/<id catalogue>/...   poids, plus .complete une fois le téléchargement terminé
input/<hash>.<ext>          images envoyées (référence inputs/<hash>.<ext>)
output/<pipeline>/...       rendus (référence outputs/<pipeline>/...)
loras/h3/<fichier>.safetensors   LoRA H3, désignées par leur nom de fichier
cache/h3-loras/...          piles de LoRA fusionnées
cache/thumbs/...            miniatures de la galerie
gallery.db                  index de la galerie, tags et favoris
chats/<id>.json             conversations de l'assistant
roles/<id>.md               rôles de l'assistant remplacés ou ajoutés par l'utilisateur
output/.trash/...           corbeille de la galerie (purge manuelle)
```

## Configuration

| Variable | Défaut | Usage |
|---|---|---|
| `STUDIO_APP_NAME` | `OnPrem Media Studio` | Nom affiché |
| `STUDIO_DATA_DIR` | `~/.local/share/studio` | Modèles et rendus |
| `STUDIO_HOST` / `STUDIO_PORT` | `0.0.0.0` / `8090` | Adresse d'écoute |
| `HF_TOKEN` | — | Dépôts à accès restreint (Krea 2) ; jamais journalisé |
| `STUDIO_LLAMA_SERVER` | `llama-server` | Chemin du binaire serveur de llama.cpp |
| `STUDIO_LLM_PORT` | `8095` | Port local de llama-server |
| `STUDIO_LLM_MODEL` | `gemma4-26b-a4b` | Id de catalogue du LLM de l'assistant et des enrichissements ; `gemma4-26b-a4b` est le seul |
| `STUDIO_DISK_RESERVE_GB` | `20` | Espace libre conservé après tout téléchargement |
| `STUDIO_GALLERY_SCAN` | `60` | Secondes entre deux scans du dossier de sorties par la galerie |
| `STUDIO_UPDATE_BRANCH` | `main` | Branche suivie par la mise à jour depuis l'interface (bare metal, et le service updater via `.env`) |
| `STUDIO_UPDATER_URL` | — | Docker : le service updater (`compose.yaml` met `http://updater:8091`) |
| `STUDIO_GIT_TOKEN` | — | Docker, dans `.env` : jeton GitHub avec lequel le service updater lit un dépôt privé ; jamais journalisé |

## Changer le nom du produit

Le nom apparaît dans `studio/config.py` (`APP_NAME`), `pyproject.toml` (`name`), `compose.yaml`,
les `README*.md` et le nom du dépôt. Le paquet Python (`studio`), le préfixe des variables
(`STUDIO_`), le nom de l'image et le dossier de données sont neutres et ne changent pas. GitHub
redirige l'ancienne URL du dépôt après un renommage.
