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
| `studio/pipelines/common.py` | Contrôle des paramètres, pipeline unique en mémoire, progression par étape, sortie PNG |
| `tools/qualify/` | Cas de qualification tirés des compilateurs de prompt de la 1.4, et leur lanceur |
| `studio/llm.py` | `LlamaServer` : démarrage à la demande, appel chat OpenAI, vision par images base64 |
| `studio/main.py` | API HTTP/WebSocket et fichiers statiques |
| `web/` | Front end (page d'état aujourd'hui ; portage Studio et Canvas à l'étape 4) |
| `docker/Dockerfile` | Base NGC PyTorch + llama.cpp compilé pour sm_121 |

## Cycle de vie d'un job

1. Le client poste `{"pipeline": id, "params": {...}}`. `Pipeline.validate` rejette une entrée
   invalide (paramètre inconnu, référence d'image absente) en 422 avant toute mise en file, et
   renvoie les paramètres que le job conserve, valeurs par défaut remplies et graine tirée.
2. Le worker prend les jobs dans l'ordre. Les modèles manquants sont téléchargés d'abord, dans le
   job, et le téléchargement apparaît dans la progression du job.
3. `Pipeline.run(params, chemins_modèles, ctx)` rend et renvoie les fichiers écrits dans
   `ctx.output_dir` ; le job les liste sous forme de références (`outputs/…`). `ctx.files` résout
   les références d'image. `ctx.progress()` publie la progression et lève une exception si le job
   a été annulé ; les moteurs d'image l'appellent à chaque étape de débruitage, une annulation
   arrête donc un rendu en une étape au plus.
4. Statut : `queued → running → done | error | cancelled`. Chaque changement est poussé sur
   `/api/ws`.

Aucun chemin de code ne crée un job de lui-même.

## Dossier de données

`STUDIO_DATA_DIR` (défaut `~/.local/share/studio`, `/data` dans Docker) :

```
models/<id catalogue>/...   poids, plus .complete une fois le téléchargement terminé
input/<hash>.<ext>          images envoyées (référence inputs/<hash>.<ext>)
output/<pipeline>/...       rendus (référence outputs/<pipeline>/...)
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

## Changer le nom du produit

Le nom apparaît dans `studio/config.py` (`APP_NAME`), `pyproject.toml` (`name`), `compose.yaml`,
les `README*.md` et le nom du dépôt. Le paquet Python (`studio`), le préfixe des variables
(`STUDIO_`), le nom de l'image et le dossier de données sont neutres et ne changent pas. GitHub
redirige l'ancienne URL du dépôt après un renommage.
