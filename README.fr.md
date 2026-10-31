# OnPrem Media Studio

**Studio IA d'images et de vidéos privé, qui tourne entièrement sur ta machine.** Ni ComfyUI, ni
Ollama, ni cloud : l'application fait tourner les modèles elle-même et télécharge les poids
nécessaires à la première utilisation.

Successeur d'AI Content Studio 1.4. Moteurs : Krea 2, Qwen Image 2.1, MiniMax H3 via
FastH3, Gemma 4 26B-A4B pour l'enrichissement des prompts et l'assistant de création (un chat à
rôles qui propose des cartes prêtes à lancer : [docs/fr/ASSISTANT.md](docs/fr/ASSISTANT.md)).

> État : étape 4 de la [feuille de route](docs/fr/ROADMAP.md). Le serveur, le téléchargement des
> modèles, la file de jobs et le pont LLM sont en place, et les moteurs d'image (Krea 2, Qwen Image
> 2.1), Gemma 4 et les moteurs vidéo MiniMax H3 en NVFP4 (texte, image, première/dernière image et
> références vers vidéo) sont qualifiés sur le GB10 (2026-10-30). Le repli FP8 de H3 n'a pas encore
> été rendu. Les pages Studio et Canvas sont portées de la 1.4 ([interface](docs/fr/FRONTEND.md))
> et testées avec des rendus simulés ; leur premier passage sur le GB10 reste à faire.

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

### Réutiliser les fichiers d'AI Content Studio 1.4

Sur une machine où la 1.4 est installée, cette commande copie dans `./data` ce que la 2.0 peut
reprendre de son dossier de modèles ComfyUI, pour ne pas le retélécharger : l'upscaler latent H3
(0,7 Go), l'encodeur de texte de Qwen Image 2.1 (17,5 Go, reconstruit en fragments Hugging Face) et
les LoRA MiniMax H3. Les autres modèles de la 1.4 sont des formats ComfyUI (fp8, int8, conversions
NVFP4) que la 2.0 ne sait pas charger ; ils sont téléchargés à la première utilisation. Un fichier
repris n'est gardé que si son SHA-256 est celui que publie Hugging Face. Les LoRA d'accélération
(turbo, lightning, n étapes) sont écartées : les checkpoints H3 de la 2.0 sont déjà distillés. Le
dossier de la 1.4 est monté en lecture seule et n'est jamais modifié.

```bash
docker compose run --rm -v ~/comfyui-spark/basedir/models:/import:ro studio python -m studio.import14 /import
```

Elle affiche ce qui a été repris, les LoRA importées ou écartées avec la raison, et ce qu'il reste
à télécharger par modèle. Les copies occupent de la place en plus : les fichiers de la 1.4 restent
où ils sont.

## Installer en bare metal (DGX OS, Ubuntu)

```bash
scripts/install.sh --check     # vérifie pilote, toolkit CUDA 13, GPU, Python, disque
scripts/install.sh             # compile et démarre le service systemd « studio »
```

Voir [docs/fr/INSTALL.md](docs/fr/INSTALL.md). Le bare metal est la seule installation mise à jour
depuis l'interface.

## Lancer sans Docker (développement)

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"                     # ajouter ,inference pour lancer les moteurs (torch installé à part)
python -m pytest
STUDIO_DATA_DIR=./data python -m studio      # http://localhost:8090
```

Le LLM a besoin du binaire `llama-server` de [llama.cpp](https://github.com/ggml-org/llama.cpp)
dans le `PATH` ou dans `STUDIO_LLAMA_SERVER`.

## Documentation

- [Architecture](docs/fr/ARCHITECTURE.md) : composants, API, cycle de vie d'un job, configuration,
  changement de nom
- [Moteurs d'image](docs/fr/IMAGE-ENGINES.md) : jobs Krea 2 et Qwen Image 2.1, références d'images,
  qualification
- [Moteurs vidéo](docs/fr/H3.md) : jobs MiniMax H3, référence vers vidéo en deux passes, repli de
  précision, pile de LoRA, qualification
- [Assistant de création](docs/fr/ASSISTANT.md) : le mode Assistant, ses rôles, ses cartes et son
  modèle
- [Interface](docs/fr/FRONTEND.md) : pages Studio et Canvas, cartes du Canvas, différences avec
  la 1.4, tests du front
- [Installation bare metal](docs/fr/INSTALL.md) : `scripts/install.sh`, service, mises à jour
- [Galerie, mise à jour, LoRA](docs/fr/GALLERY.md) : index des sorties, corbeille, mise à jour
  depuis l'interface
- [Leçons de la 1.4](docs/fr/LESSONS.md) : règles apprises à la dure, à lire avant de toucher un
  prompt ou un moteur
- [ADR 0001](docs/fr/adr/0001-inference-stack.md) : pourquoi diffusers, FastVideo et llama.cpp
- [Feuille de route](docs/fr/ROADMAP.md)

## Licences

Ce dépôt ne contient aucun poids de modèle. Chaque modèle garde sa licence, indiquée dans
`studio/catalog.json` et sur la page d'état. À noter en particulier :

- **MiniMax H3** (et FastH3) : MiniMax H3 Community License. Elle **exclut l'Union européenne, le
  Royaume-Uni, la Corée du Sud et les États-Unis**, et impose d'afficher « MiniMax H3 » dans
  l'interface d'un produit commercial (la page d'état l'affiche). Voir [NOTICE](NOTICE).
- **Upscaler latent MiniMax H3** (LBH-123-AI) : poids sous Apache-2.0 ; le code qui les exécute
  est celui de ce projet.
- **Krea 2** : accès restreint sur Hugging Face, licence acceptée par chaque utilisateur.
- **Qwen Image 2.1** : Qwen Research License, **usage non commercial uniquement** ; un usage
  commercial demande une licence de Qwen. Toutes les retouches et images de plan l'utilisent.

Maestro et WanGP ont inspiré l'approche ; aucun code n'en a été repris (leur licence est non
commerciale).
