# OnPrem Media Studio

**Studio IA d'images et de vidéos privé, qui tourne entièrement sur ta machine.** Ni ComfyUI, ni
Ollama, ni cloud : l'application fait tourner les modèles elle-même et télécharge les poids
nécessaires à la première utilisation.

Successeur d'AI Content Studio 1.4. Moteurs : Krea 2, Qwen Image Edit (2509, 2.1), MiniMax H3 via
FastH3, Gemma 4 E4B pour l'enrichissement des prompts.

> État : étape 1 de la [feuille de route](docs/fr/ROADMAP.md). Le serveur, le téléchargement des
> modèles, la file de jobs et le pont LLM sont en place ; les moteurs image et vidéo arrivent aux
> étapes 2 et 3.

English version: [README.md](README.md).

## Prérequis

- GPU NVIDIA. Première cible : DGX OS sur GB10 (ARM64). Ubuntu ensuite ; Omarchy et Windows 11
  plus tard.
- Docker avec le NVIDIA Container Toolkit.
- Disque : les modèles occupent des centaines de Go ; prévoir 300 Go libres.
- Un jeton Hugging Face pour les modèles à accès restreint (Krea 2), après avoir accepté leur
  licence sur la page du modèle.

## Lancer avec Docker

```bash
echo "HF_TOKEN=hf_..." > .env          # facultatif, nécessaire pour Krea 2
docker compose up -d --build
# puis http://localhost:8090
```

Modèles et rendus vont dans `./data` (à changer avec `STUDIO_DATA=/chemin` dans `.env`). Si le
port 8090 est déjà pris (AI Content Studio 1.4 l'utilise), mettre `STUDIO_HOST_PORT=8096` dans `.env`.

## Lancer sans Docker (développement)

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
python -m pytest
STUDIO_DATA_DIR=./data python -m studio      # http://localhost:8090
```

Le LLM a besoin du binaire `llama-server` de [llama.cpp](https://github.com/ggml-org/llama.cpp)
dans le `PATH` ou dans `STUDIO_LLAMA_SERVER`.

## Documentation

- [Architecture](docs/fr/ARCHITECTURE.md) : composants, API, cycle de vie d'un job, configuration,
  changement de nom
- [Leçons de la 1.4](docs/fr/LESSONS.md) : règles apprises à la dure, à lire avant de toucher un
  prompt ou un moteur
- [ADR 0001](docs/fr/adr/0001-inference-stack.md) : pourquoi diffusers, FastVideo et llama.cpp
- [Feuille de route](docs/fr/ROADMAP.md)

## Licences

Ce dépôt ne contient aucun poids de modèle. Chaque modèle garde sa licence, indiquée dans
`studio/catalog.json` et sur la page d'état. À noter en particulier :

- **MiniMax H3** (et FastH3) : MiniMax H3 Community License. Elle **exclut l'Union européenne, le
  Royaume-Uni, la Corée du Sud et les États-Unis**, et impose d'afficher « MiniMax H3 » dans
  l'interface d'un produit commercial. Voir [NOTICE](NOTICE).
- **Krea 2** : accès restreint sur Hugging Face, licence acceptée par chaque utilisateur.

Maestro et WanGP ont inspiré l'approche ; aucun code n'en a été repris (leur licence est non
commerciale).
