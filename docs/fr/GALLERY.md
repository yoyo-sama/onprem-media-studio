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
- **La galerie ne soumet jamais de job.** « Réutiliser le prompt » dans le front n'écrit le brief
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

Seulement pour une installation qui est un **dépôt git** (bare metal, `scripts/install.sh`). Une
image Docker se met à jour en la reconstruisant ; son état le dit.

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

## Téléversement de LoRA

- `GET /api/loras` → `{"h3": [{name, size}]}`.
- `POST /api/loras/h3?name=<fichier>.safetensors` (même origine), fichier brut dans le corps,
  8 Go au plus. Le fichier est écrit sous un nom temporaire caché, puis lié à son nom définitif :
  une LoRA existante n'est jamais remplacée (409).

Seul MiniMax H3 prend des LoRA en 2.0 (`docs/H3.md` § pile de LoRA). La 1.4 avait aussi des LoRA
de style Krea 2 ; le moteur Krea 2 ne les prend pas encore.
