# ADR 0001 — Pile d'inférence sans ComfyUI ni Ollama

- Statut : acceptée (2026-10-29)
- Version anglaise (de référence) : [../../adr/0001-inference-stack.md](../../adr/0001-inference-stack.md)

## Contexte

AI Content Studio 1.4 est un front end statique qui pilote ComfyUI (`:8188`) et Ollama
(`:11434`) via nginx, plus deux petits services Python (updater, galerie). La version 2.0 doit
faire tourner chaque modèle elle-même, télécharger automatiquement les poids nécessaires, garder
la couverture fonctionnelle de la 1.4, et s'installer dans un seul conteneur Docker sur un GB10
(DGX OS, ARM64) d'abord, puis en bare metal, sur Ubuntu, Omarchy et Windows 11.

Modèles concernés : Krea 2, Qwen Image 2.1 (Qwen-Image-Edit 2509 retiré le 2026-10-29), MiniMax H3 via FastH3 (OmniRef pour la
référence vers vidéo). LTX 2.5 est abandonné ; H3 reprend tous les chemins vidéo. Gemma 4 E4B
reste le seul LLM de prompt.

Maestro et WanGP font le même travail mais sont publiés sous la WanGP Non-Commercial Evaluation
License 1.1. Décision du 2026-10-29 : ce sont **des références seulement** ; aucun code n'est
copié et aucun n'est une dépendance.

## Décision

| Sujet | Choix | Pourquoi |
|---|---|---|
| Serveur | Python, FastAPI, un processus, un thread worker GPU | Même langage que tous les moteurs ; les jobs passent dans l'ordre sur un seul GPU |
| Krea 2, Qwen Image 2.1 | Pipelines `diffusers` de Hugging Face, poids officiels | Les dépôts officiels sont au format diffusers (`model_index.json`) ; bibliothèque Apache-2.0 |
| MiniMax H3 / FastH3 | `FastVideo` (Apache-2.0) | Publie les poids FastH3 OmniRef NVFP4 QAD avec une recette DGX Spark ; les noyaux NVFP4 et VSA sont son travail, pas le nôtre |
| LLM de prompt | `llama-server` de llama.cpp, Gemma 4 E4B en GGUF + mmproj | Même approche que Maestro ; API compatible OpenAI ; vision via mmproj |
| Téléchargement | `huggingface_hub`, fichier par fichier, marqueur `.complete` | Reprise possible, contrôle de l'espace disque, dépôts restreints via `HF_TOKEN` |
| Compilateurs de prompt | Le moteur JavaScript de la 1.4 (`js/engine.js`), porté en anglais | Source unique partagée par le Studio et le Canvas, déjà couverte par les tests de parité ; le backend ne fait que l'inférence |
| Packaging | Image de base NGC PyTorch (multi-arch, CUDA 13) | Fournit un PyTorch compilé pour Blackwell/GB10 ; le bare metal réutilise le même paquet Python |

## Conséquences

- Un seul port (8090), ni nginx ni second service : la galerie et l'updater deviennent des
  modules du même serveur à l'étape 4.
- Le backend ne construit jamais de graphe de nœuds. Un pipeline est une classe Python : les
  modèles dont il a besoin + `run()`.
- Les pièces propres à ComfyUI du workflow OmniRef validé demandent un équivalent : l'upscaler
  latent 3D (nœud communautaire) et la « power LoRA stack » (LoRA en branche exacte sur un modèle
  quantifié). Étape 3 (H3.md) : FastVideo n'offre ni l'un ni l'autre, les deux sont donc écrits
  ici : l'upscaler comme module à nous qui charge le checkpoint de LBH-123-AI (poids Apache-2.0),
  la pile comme un seul adaptateur fusionné que FastVideo exécute en branche parallèle. Les deux
  passes passent par les options publiques de FastVideo (sortie latente, latents injectés, plan
  PDD), sans le modifier.
- Le front end parle à `/api/*` au lieu de `/comfy/*` et `/ollama/*` ; sa couche de construction
  de graphes est remplacée par des soumissions de jobs.

## Risques

- **Licence MiniMax H3 :** la Community License exclut l'Union européenne, le Royaume-Uni, la
  Corée du Sud et les États-Unis, et impose d'afficher « MiniMax H3 » dans l'interface d'un
  produit commercial. C'était déjà le cas en 1.4. Un usage dans les territoires exclus demande une
  licence de MiniMax.
- **Krea 2 est à accès restreint :** l'utilisateur doit accepter sa licence sur Hugging Face et
  fournir `HF_TOKEN`.
- **FastH3 en première/dernière image (I2V/FL2VA) :** OmniRef est validé. L'étape 3 utilise
  FastH3 V2 (`FastVideo/FastH3-QAD-v2`, repli FP8 `FastVideo/FastVideo-FastH3-8-Step-V2-FP8`),
  dont le pipeline accepte première et dernière images, mais l'amont ne documente pour lui que le
  texte vers vidéo : à qualifier sur GB10.
- **FastVideo exige torch 2.12** alors que l'image garde le torch de NGC 25.11 (2.10) ; FastVideo
  est installé sans ses dépendances et pip est contraint au torch de la base. API et imports
  passent sur 2.10 sans GPU ; les noyaux sont à confirmer sur GB10, avec la pile CUDA 13.0 +
  torch 2.12 de FastVideo comme repli (`docs/fr/H3.md` § Version de torch).
- **Les clips H3 font 5 à 15 s** dans FastVideo, là où la 1.4 acceptait des cuts plus courts.
- **Le tag de l'image NGC et la révision de llama.cpp** sont figés mais pas encore compilés sur
  GB10 : le premier build sur la machine peut demander de les faire évoluer.
