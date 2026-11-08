# Galerie, mise à jour depuis l'interface et téléversement de LoRA

Version anglaise (de référence) : [../GALLERY.md](../GALLERY.md).

En 1.4, c'étaient deux services séparés derrière nginx (`gallery` sur :8094, `updater` sur :8093).
En 2.0, ce sont des modules du même serveur (`studio/gallery.py`, `studio/update.py`,
`studio/loras.py`), sous `/api/gallery/`, `/api/update/` et `/api/loras`.

## Galerie

Un index SQLite/FTS5 (`STUDIO_DATA_DIR/gallery.db`) du dossier de sorties, avec des miniatures WebP
en cache dans `STUDIO_DATA_DIR/cache/thumbs/`.

### Règles reprises de la 1.4

- **Les fichiers ne sont jamais réécrits.** Tags et favoris vivent uniquement en SQLite.
- **Rien n'est supprimé définitivement.** « Supprimer » déplace le fichier dans
  `output/.trash/<ms>-<hex>/<clé>` ; la restauration le remet en place (sous
  `<nom>_restored.<ext>` si le nom a été pris entre-temps). La purge de la corbeille est manuelle :
  `rm -r <data>/output/.trash`. Chaque déplacement crée le lien du nouveau nom puis retire
  l'ancien : un fichier existant n'est jamais écrasé.
- **Un scan ne vide jamais l'index.** Si le dossier de sorties est absent, ou vide alors que l'index
  a des lignes, rien n'est retiré et `health.warning` le signale.
- **Le service de galerie ne soumet jamais de job.** Dans le front, seul « ⇱ Doubler la
  résolution » de la visionneuse en poste un, sur son clic (`upscale-2x`,
  [IMAGE-ENGINES.md](IMAGE-ENGINES.md#résolution-2)) ; « Réutiliser le prompt » n'écrit le brief
  que sur un clic explicite, avec Annuler, et ne lance rien.
- **Les routes d'écriture exigent la même origine** (`Origin` ou `Referer` égal à `Host`, et
  `Sec-Fetch-Site` absent ou `same-origin`), comme toute route qui déplace ou écrit des fichiers.

### Ce qui est indexé

Tous les `.png .jpg .jpeg .webp .mp4 .webm .mov` sous le dossier de sorties, sauf les liens
symboliques, les noms qui commencent par un point (donc `.trash` et les fichiers temporaires) et
les fichiers de moins de 5 s (le scan suivant les prend). Un scan tourne au démarrage, puis toutes
les `STUDIO_GALLERY_SCAN` secondes (60 par défaut) ; les sorties d'un job sont indexées dès sa fin,
avant que son événement `done` n'atteigne les clients.

Les métadonnées sont celles que les moteurs écrivent avec chaque sortie,
`{"pipeline", "origin", "params", "role"}` :

- dans un PNG, le bloc texte `studio` (lu avant les données de l'image) ;
- dans un MP4, l'étiquette `studio`, écrite par un remultiplexage sans réencodage juste après que
  FastVideo a écrit le fichier (il faut `ffmpeg` ; sans lui, le clip n'a pas de métadonnées et une
  ligne est journalisée).

`pipeline` est le moteur (`krea2-t2i`, `h3-r2v`…), `origin` la fonction du front qui a soumis le
job (`storyboard`, `relay`, `canvas`…, envoyée dans le champ `origin` du job), `params` les
paramètres validés du job (prompt, seed, LoRA…). La dernière image d'un clip
(`role: "last-frame"`, nommée `<clip>-1.png`) et les images extraites d'un clip (`role: "frame"`,
tâche `video-frames`) sont gardées pour l'enchaînement Relay mais masquées du périmètre `app` par
défaut. Un fichier sans métadonnées est listé avec son dossier comme pipeline.

La recherche (`q`) porte sur le prompt, la clé du fichier, le pipeline et l'origine, par préfixe de
mot, tous les mots exigés.

### API

Lecture :

| Route | Paramètres | Réponse |
|---|---|---|
| `GET /api/gallery/health` | — | `{ok, indexed, app, trashed, scanning, lastScanMs, scanSeconds, warning, ffmpeg}` |
| `GET /api/gallery/assets` | `type=image\|video`, `q`, `pipeline` (ou `none`), `origin`, `tag`, `fav=1`, `from`/`to` (ms), `scope=app\|all\|trash`, `sort=new\|old`, `limit` (1–200, 60 par défaut), `cursor` | `{items: [Asset], next, counts: {image, video}}` ; `counts` applique tous les filtres sauf le type |
| `GET /api/gallery/asset?key=` | clé (y compris de corbeille) | Asset avec le prompt complet ; un fichier présent pas encore indexé l'est aussitôt |
| `GET /api/gallery/thumb?key=&v=` | clé, version | WebP, côté long 320 px, en cache un an (l'URL change avec le fichier) |
| `GET /api/gallery/dates` | filtres + `unit=day\|week\|month`, `tz` (= `Date.getTimezoneOffset()`) | `{unit, periods: [{start, end, count}]}`, du plus récent au plus ancien ; semaine du lundi au lundi |
| `GET /api/gallery/facets?scope=` | périmètre | `{pipelines: [{id, count}], origins: [{id, count}], tags: [{name, count}]}` |

Écriture (POST, corps JSON, même origine, 100 clés au plus) :

| Route | Corps | Réponse |
|---|---|---|
| `/api/gallery/fav` | `{keys, fav}` | `{ok, changed}` |
| `/api/gallery/tags` | `{name}` (1 à 40 caractères, sans casse) | `{ok, tag: {name, count}}` |
| `/api/gallery/tag` | `{keys, add: [noms], remove: [noms]}` | `{ok, assets: [{key, tags}]}` |
| `/api/gallery/rename` | `{key, name}` (même dossier et extension, 150 caractères au plus) | `{ok, asset}` ; 409 si le nom est pris ou si le fichier appartient à une session storyboard ou Relay |
| `/api/gallery/trash` | `{keys}` | `{ok, trashed: [{key, trashKey}]}` |
| `/api/gallery/restore` | `{keys: [clés de corbeille]}` | `{ok, restored: [{trashKey, key}]}` |

Une erreur est `{"detail": "..."}` ; une mise à la corbeille ou une restauration interrompue en
cours de route répond 500 avec la liste de ce qui a déjà été déplacé.

Un **Asset** : `key` (chemin POSIX sous le dossier de sorties, sans `/` initial), `filename`,
`folder`, `type`, `url` (`/outputs/<clé>?v=<mtime>`), `ref` (`outputs/<clé>`, ce qu'un job prend
comme référence d'image), `thumb`, `ts` (ms), `prompt` (400 caractères dans les listes),
`pipeline`, `origin`, `loras`, `seed`, `w`, `h`, `duration`, `size`, `fav`, `tags`, `app` (faux
pour une image de travail masquée du périmètre `app`), `trash` (`{origKey, at}` ou null).

Écarts avec la 1.4 : plus de graphe ComfyUI à parcourir (les métadonnées sont explicites), plus de
facette `model` (le moteur le dit), une facette `origin` à la place des motifs de noms de fichiers
qui devinaient le pipeline, des URL sous `/outputs/` au lieu de `/comfy/view`.

## Mise à jour depuis l'interface

Deux installations, deux façons, derrière les mêmes routes et le même panneau « Mise à jour ».

### Bare metal (dépôt git)

Pour une installation qui est un **dépôt git** (`scripts/install.sh`).

- `GET /api/update/status` → `{mode: "git"|"none", branch, local, remote, available, message}`.
  Compare `HEAD` à la branche distante (`STUDIO_UPDATE_BRANCH`, `main` par défaut) par
  `git ls-remote`, sans fetch, en cache une minute.
- `POST /api/update/apply` (même origine) refuse une autre branche que celle des mises à jour, des
  modifications locales de fichiers suivis, et des jobs en file ou en cours (409). Il lance ensuite
  `git pull --ff-only` et répond `{updated, from, to, reinstall, restarting}` :
  - si seul le code a changé, le serveur **redémarre de lui-même** une seconde plus tard (même
    identifiant de processus : systemd comme un terminal le gardent) ; le front attend
    `/api/health` puis recharge la page ;
  - si `pyproject.toml`, `docker/` ou `scripts/install.sh` ont changé, il ne redémarre pas et
    demande de relancer `scripts/install.sh`, qui réinstalle puis redémarre le service.

### Docker (`docker compose`)

Le conteneur du studio ne contient pas de dépôt git et ne peut pas reconstruire sa propre image. Un
second service de `compose.yaml`, `updater` (`docker/updater/server.py`, bibliothèque standard
Python sur l'image `docker:cli`), le fait à côté : le dossier du dépôt est monté sur `/repo` et la
socket Docker lui permet de lancer `docker compose` sur l'hôte, comme tu le ferais. Il ne publie
aucun port ; le studio le joint à `STUDIO_UPDATER_URL` (`http://updater:8091`) et lui transmet
`/api/update/*` (`RemoteUpdater` dans `studio/update.py`).

- `GET /api/update/status` → `{mode: "docker", state, log, error, branch, local, remote, running,
  available, message}`. `running` est le commit dont est construite l'image du studio en marche
  (étiquette d'image `studio.commit`, posée par l'argument de build `STUDIO_COMMIT` que seul
  l'updater passe ; vide pour une image construite à la main). La mise à jour est proposée quand la
  branche distante a de nouveaux commits, ou quand l'image en marche est plus ancienne que le dépôt
  (un `git pull` sans reconstruction, un build en échec). `state` vaut `idle`, `building`,
  `waiting` ou `restarting` ; `log` garde les dernières lignes du build ; `error` le dernier échec,
  jusqu'à la mise à jour suivante.
- `POST /api/update/apply` (même origine) : le studio refuse des jobs en file ou en cours (409),
  l'updater refuse une autre branche, des modifications locales de fichiers suivis et une mise à
  jour déjà en cours. Il lance `git pull --ff-only` **sous l'identité du propriétaire du dépôt**
  (jamais en root : un objet de `.git` appartenant à root casse le git de l'utilisateur), répond
  `{updated, from, to, rebuilding}`, puis en arrière-plan :
  1. `docker compose build studio` : le studio reste utilisable pendant ce temps, et garde la
     version précédente si le build échoue ;
  2. met en attente la file du studio (`POST /api/update/hold` : les nouveaux jobs sont refusés
     en 503 avec un message ; l'attente est renouvelée toutes les 10 s et tombe d'elle-même après
     60 s si l'updater s'arrête) et attend qu'aucun job ne soit en file ou en cours et qu'aucun
     modèle ne se télécharge (`/api/health`, toutes les 10 s) : un job lancé pendant le build n'est
     pas coupé, et aucun ne peut démarrer entre le dernier contrôle et le redémarrage (LESSONS
     n° 48) ;
  3. `docker compose up -d --no-deps --no-build studio` : le conteneur est recréé sur la nouvelle
     image, avec le même volume de données ;
  4. supprime l'image précédente dès que plus rien ne l'utilise.

  L'updater ne se reconstruit jamais lui-même : après une mise à jour qui modifie
  `docker/updater/`, lance une fois `docker compose up -d --build updater` dans le dossier du dépôt.

  La page suit `state`, affiche la dernière ligne du build et se recharge quand le nouveau studio
  répond.
- **Chemins.** Compose résout les chemins relatifs de `compose.yaml` (le volume `./data`) par
  rapport au dossier du projet et les transmet au démon de l'hôte. L'updater lit ses propres
  étiquettes compose (nom du projet, dossier sur l'hôte, fichiers compose) et relie dans son
  conteneur le dossier de l'hôte à `/repo` : son `docker compose` voit exactement la configuration
  d'un lancement sur l'hôte (même source de volume, aucune recréation parasite). Les valeurs
  utilisées par `compose.yaml` doivent vivre dans `.env`, pas dans des `export` du shell, pour
  survivre à une mise à jour.
- **Dépôt privé.** `git ls-remote` et `git pull` tournent sans les gestionnaires d'identifiants de
  l'hôte. Pour un dépôt privé, mets dans `.env` un jeton GitHub qui peut le lire
  (`STUDIO_GIT_TOKEN=...`, un jeton *fine-grained* avec *Contents : read-only* sur ce dépôt), puis
  lance `docker compose up -d` une fois. Il est transmis à git par l'environnement, jamais sur une
  ligne de commande, et n'est jamais journalisé.
- L'updater ne se met pas à jour lui-même : un changement de `docker/updater/` ou de son service
  dans `compose.yaml` demande un `docker compose up -d --build` à la main.

## Téléversement de LoRA

- `GET /api/loras` → `{"h3": [{name, size}]}`.
- `POST /api/loras/h3?name=<fichier>.safetensors` (même origine), fichier brut dans le corps,
  8 Go au plus. Le fichier est écrit sous un nom temporaire caché, puis lié à son nom définitif :
  une LoRA existante n'est jamais remplacée (409).

Seul MiniMax H3 prend des LoRA en 2.0 (`docs/H3.md` § pile de LoRA). La 1.4 avait aussi des LoRA
de style Krea 2 ; le moteur Krea 2 ne les prend pas encore.
