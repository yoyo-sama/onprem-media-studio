# OnPrem Media Studio

**Studio IA d'images et de vidéos privé, qui tourne entièrement sur ta machine.** Ni ComfyUI, ni
Ollama, ni cloud : l'application fait tourner les modèles elle-même et télécharge les poids
nécessaires à la première utilisation.

Successeur d'AI Content Studio 1.4. Moteurs : Krea 2, Qwen Image 2.1, MOSS-Image,
MiniMax H3 via FastH3, Gemma 4 26B-A4B pour l'enrichissement des prompts et l'assistant de création (un chat à
rôles qui propose des cartes prêtes à lancer : [docs/fr/ASSISTANT.md](docs/fr/ASSISTANT.md)).

> État : l'assistant, le Studio et le Canvas tournent en Docker sur le GB10. Krea 2, Qwen Image
> 2.1, MOSS-Image, Gemma 4 26B-A4B et les moteurs vidéo MiniMax H3 en NVFP4 (texte, image,
> première/dernière image et références vers vidéo) y sont qualifiés par de vrais rendus. Voir la
> [feuille de route](docs/fr/ROADMAP.md).

English version: [README.md](README.md).

## Prérequis

- GPU NVIDIA. Première cible : DGX OS sur GB10 (ARM64). Ubuntu ensuite ; Omarchy et Windows 11
  plus tard.
- Docker avec le NVIDIA Container Toolkit.
- Disque : les modèles occupent des centaines de Go ; prévoir 300 Go libres.
- Un jeton Hugging Face pour les modèles à accès restreint (Krea 2), après avoir accepté leur
  licence sur la page du modèle.

## Lancer avec Docker

1. Récupérer le dépôt. Tant qu'il est privé, `git clone` demande un nom d'utilisateur et un mot
   de passe : donner son identifiant GitHub et un jeton qui peut lire le dépôt (*fine-grained*,
   *Contents : read-only*).

   ```bash
   git clone https://github.com/yoyo-sama/onprem-media-studio.git
   cd onprem-media-studio
   ```

2. Vérifier la machine. Cette commande ne change rien ; elle dit quoi corriger, avec la
   commande, si Docker n'est pas utilisable par l'utilisateur, si aucun GPU n'est vu dans un
   conteneur (NVIDIA Container Toolkit), si le port est pris ou si le disque est trop juste.

   ```bash
   scripts/docker-install.sh --check
   ```

3. Installer et démarrer. Le script crée `.env` et `./data`, construit l'image (la première
   construction prend plusieurs minutes), démarre le studio et attend qu'il réponde.

   ```bash
   scripts/docker-install.sh
   ```

4. Mettre ses jetons dans `.env`, puis les appliquer :

   ```bash
   nano .env                # HF_TOKEN=hf_...   STUDIO_GIT_TOKEN=github_pat_...
   docker compose up -d
   ```

   `HF_TOKEN` sert à Krea 2 (accepter d'abord sa licence sur sa page Hugging Face) ;
   `STUDIO_GIT_TOKEN` est le jeton GitHub de l'étape 1, pour les mises à jour depuis l'interface
   tant que le dépôt est privé.

5. Ouvrir `http://localhost:8090` (ou `http://<adresse de la machine>:8090` depuis un autre
   ordinateur). Chaque modèle se télécharge à sa première utilisation.

Bon à savoir :

- AI Content Studio 1.4 utilise le port 8090. Sur une machine où il tourne, les étapes 2 et 3
  s'arrêtent sur le port : créer soi-même le fichier de réglages avec
  `cp .env.example .env && chmod 600 .env`, y mettre `STUDIO_HOST_PORT=8096`, puis lancer les
  étapes 2 et 3 (l'adresse de l'étape 5 se termine alors par `:8096`).
- Tous les réglages sont dans `.env`, créé une fois depuis [`.env.example`](.env.example) et
  lisible par son seul propriétaire ; le script ne modifie jamais un `.env` existant. Modèles et
  rendus vont dans `./data` (`STUDIO_DATA=/chemin` dans `.env` pour un autre disque).
- Relancé plus tard, le script reconstruit et redémarre le studio, mais jamais pendant un job ou
  un téléchargement de modèle : il le dit et s'arrête.
- État et journaux : `curl -s localhost:8090/api/health` et `docker compose logs -f studio`.

### Mises à jour

Le panneau « Mise à jour » de l'interface tire le dépôt, reconstruit l'image (le studio reste
utilisable pendant ce temps), puis redémarre le studio dès qu'aucun job ne tourne ; modèles et
rendus restent en place. C'est le service `updater` de `compose.yaml` qui s'en charge
([docs/fr/GALLERY.md](docs/fr/GALLERY.md#docker-docker-compose)). Un dépôt privé demande
`STUDIO_GIT_TOKEN` dans `.env` (étape 4). À la main, dans ce dossier :
`git pull && scripts/docker-install.sh`, qui ne redémarre le studio que si aucun job ne tourne.

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

Voir [docs/fr/INSTALL.md](docs/fr/INSTALL.md).

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
- [Moteurs d'image](docs/fr/IMAGE-ENGINES.md) : jobs Krea 2, Qwen Image 2.1 et MOSS-Image, références d'images,
  qualification
- [Moteurs vidéo](docs/fr/H3.md) : jobs MiniMax H3, référence vers vidéo en deux passes,
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
- **SPAN 2xNomosUni** (résolution ×2, Philip Hofmann) : poids sous CC BY 4.0, crédités dans
  [NOTICE](NOTICE) ; exécutés par spandrel (MIT).
- **Krea 2** : accès restreint sur Hugging Face, licence acceptée par chaque utilisateur.
- **Qwen Image 2.1** : Qwen Research License, **usage non commercial uniquement** ; un usage
  commercial demande une licence de Qwen. Toutes les retouches et images de plan l'utilisent.
- **MOSS-Image** (OpenMOSS-Team/MOSS-Image-SFT) et sa LoRA turbo
  (akhaliq/MOSS-Image-SFT-4-steps) : Apache-2.0.
- **Gemma 4 26B-A4B** (GGUF de ggml-org) : Apache-2.0.

Maestro et WanGP ont inspiré l'approche ; aucun code n'en a été repris (leur licence est non
commerciale).
