# Architecture

Version anglaise (de référence) : [../ARCHITECTURE.md](../ARCHITECTURE.md). Décisions de
conception : [adr/](adr/).

## Vue d'ensemble

```
navigateur ──HTTP/WS──> studio (FastAPI, :8090)
                          ├─ /api/models   catalogue + téléchargement (huggingface_hub)
                          ├─ /api/inputs   envoi d'image → référence pour les jobs
                          ├─ /api/jobs     file → un worker GPU → pipelines (diffusers, FastVideo)
                          ├─ /api/llm      llama-server (Gemma 4 E4B, 127.0.0.1:8095)
                          ├─ /api/gallery  index des sorties : recherche, miniatures, tags, corbeille
                          ├─ /api/update   mise à jour d'un dépôt git depuis l'interface
                          ├─ /api/loras    liste et téléversement de LoRA
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
| `studio/jobs.py` | `JobQueue` : soumission, worker unique, progression, annulation, événements |
| `studio/files.py` | `FileStore` : images envoyées, références `inputs/…` et `outputs/…` |
| `studio/pipelines/` | Contrat `Pipeline` et registre ; une sous-classe par moteur |
| `studio/pipelines/krea2.py`, `qwen.py` | Moteurs d'image (Krea 2, Qwen Image 2.1) : [IMAGE-ENGINES.md](IMAGE-ENGINES.md) |
| `studio/pipelines/h3.py` | Moteurs vidéo (MiniMax H3 : texte, image, première/dernière image et références vers vidéo), géométrie et plan d'affinage : [H3.md](H3.md) |
| `studio/pipelines/h3_runtime.py` | Adaptateur FastVideo : recettes Spark, profils NVFP4/FP8, sortie latente et réglages de la passe d'affinage, annulation |
| `studio/pipelines/h3_upscaler.py`, `h3_lora.py` | Upscaler latent H3 (convolutions 3D, checkpoint LBH v1) et pile de LoRA (fusion exacte en une seule branche parallèle) |
| `studio/pipelines/common.py` | Contrôle des paramètres, pipeline unique en mémoire, progression par étape, sortie PNG |
| `tools/qualify/` | Cas de qualification tirés des compilateurs de prompt de la 1.4, et leur lanceur |
| `studio/llm.py` | `LlamaServer` : démarrage à la demande, appel chat OpenAI, vision par images base64 |
| `studio/gallery.py` | `Gallery` : index SQLite/FTS5 des sorties, miniatures, tags, favoris, renommage, corbeille : [GALLERY.md](GALLERY.md) |
| `studio/update.py`, `loras.py` | Mise à jour depuis l'interface (avance rapide git, redémarrage sur place) et téléversement de LoRA : [GALLERY.md](GALLERY.md) |
| `studio/guard.py` | Contrôle de même origine des routes qui déplacent ou écrivent des fichiers |
| `studio/main.py` | API HTTP/WebSocket et fichiers statiques |
| `web/` | Front end (page d'état aujourd'hui ; portage Studio et Canvas à l'étape 4) |
| `docker/Dockerfile` | Base NGC PyTorch + llama.cpp compilé pour sm_121 + FastVideo et ses noyaux compilés pour sm_121a |

## Cycle de vie d'un job

1. Le client poste `{"pipeline": id, "params": {...}, "origin": fonction}` (`origin`, facultatif,
   nomme la fonction du front pour la galerie et n'est jamais lu par un pipeline). `Pipeline.validate` rejette une entrée
   invalide (paramètre inconnu, référence d'image absente) en 422 avant toute mise en file, et
   renvoie les paramètres que le job conserve, valeurs par défaut remplies et graine tirée.
2. Le worker prend les jobs dans l'ordre. Les modèles manquants (`Pipeline.needs(settings)`,
   c'est-à-dire `models` sauf quand un réglage les choisit, comme la précision H3) sont
   téléchargés d'abord, dans le job, et le téléchargement apparaît dans la progression du job.
3. `Pipeline.run(params, chemins_modèles, ctx)` rend et renvoie les fichiers écrits dans
   `ctx.output_dir` ; le job les liste sous forme de références (`outputs/…`). `ctx.files` résout
   les références d'image. `ctx.progress()` publie la progression et lève une exception si le job
   a été annulé ; les moteurs d'image l'appellent à chaque étape de débruitage, une annulation
   arrête donc un rendu en une étape au plus. Les moteurs vidéo interrompent directement
   FastVideo (H3.md).
4. Statut : `queued → running → done | error | cancelled`. Chaque changement est poussé sur
   `/api/ws` ; les sorties d'un job terminé sont dans la galerie avant l'envoi de son événement
   `done`.

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
| `STUDIO_DISK_RESERVE_GB` | `20` | Espace libre conservé après tout téléchargement |
| `STUDIO_H3_PRECISION` | `auto` | MiniMax H3 : `auto` (NVFP4, FP8 si NVFP4 échoue), `nvfp4` ou `fp8` (H3.md) |
| `STUDIO_GALLERY_SCAN` | `60` | Secondes entre deux scans du dossier de sorties par la galerie |
| `STUDIO_UPDATE_BRANCH` | `main` | Branche suivie par la mise à jour depuis l'interface (dépôt git seulement) |

## Changer le nom du produit

Le nom apparaît dans `studio/config.py` (`APP_NAME`), `pyproject.toml` (`name`), `compose.yaml`,
les `README*.md` et le nom du dépôt. Le paquet Python (`studio`), le préfixe des variables
(`STUDIO_`), le nom de l'image et le dossier de données sont neutres et ne changent pas. GitHub
redirige l'ancienne URL du dépôt après un renommage.
