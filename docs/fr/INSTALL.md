# Installation bare metal (DGX OS et Ubuntu)

Version anglaise (de référence) : [../INSTALL.md](../INSTALL.md).

`scripts/install.sh` installe le studio sans Docker, comme service systemd, sur DGX OS (GB10,
ARM64) ou Ubuntu 22.04/24.04 (ARM64 ou x86_64) avec un GPU NVIDIA. Docker reste la voie de test sur
le GB10 (README) ; le bare metal est la voie d'exploitation, et la seule avec la mise à jour depuis
l'interface.

## Prérequis

| Quoi | Requis | Vérifié par |
|---|---|---|
| Pilote NVIDIA | 580 ou plus récent (CUDA 13.0) | `nvidia-smi` |
| Toolkit CUDA | 13.x, avec `nvcc` (DGX OS le fournit dans `/usr/local/cuda`) | `nvcc --version` |
| GPU | compute capability 8.0 ou plus ; qualifié sur GB10 (12.1) seulement | `nvidia-smi` |
| Python | 3.11 ou plus récent (DGX OS 7 et Ubuntu 24.04 : 3.12) | `python3` |
| Disque | environ 300 Go pour tous les modèles, dans le dossier de données | `df` |
| Réseau | PyPI, GitHub, Hugging Face | — |
| sudo | pour les paquets apt et le service | — |

## Installer

```bash
git clone https://github.com/yoyo-sama/onprem-media-studio.git
cd onprem-media-studio
scripts/install.sh --check     # facultatif : vérifie la machine, ne change rien
scripts/install.sh             # le premier passage compile llama.cpp et les noyaux FastVideo : prévoir du temps
```

Options : `--data DOSSIER` (modèles et rendus, `~/.local/share/studio` par défaut), `--port N`
(8090 par défaut), `--skip-system` (paquets apt déjà installés), `--no-service` (compiler
seulement, démarrage à la main). Le dossier de données et le port sont écrits une seule fois dans
`~/.config/studio/studio.env` ; les passages suivants gardent ce fichier tel quel.

Pour Krea 2 (accès restreint sur Hugging Face) : accepter sa licence sur la page du modèle, puis
mettre le jeton dans `~/.config/studio/studio.env` (`HF_TOKEN=hf_...`, fichier lisible par son
propriétaire seulement) et lancer `sudo systemctl restart studio`.

## Ce que fait le script

Chaque étape s'arrête avec un message qui dit quoi corriger ; rien n'est installé à moitié en
silence.

1. **Vérifie** le pilote, le toolkit CUDA (version majeure 13, celle du torch installé), le GPU,
   Python et l'espace disque libre.
2. **Paquets apt** (seulement ceux qui manquent) : `git cmake ninja-build build-essential
   pkg-config ffmpeg curl python3-venv python3-dev`.
3. **Environnement Python** `.venv/` dans le dépôt, avec **torch 2.12.0** et torchvision 0.27.0 de
   PyPI : sous Linux, ce sont les builds CUDA 13.0, pour ARM64 comme x86_64, les versions
   qu'épingle FastVideo. Le script s'arrête si torch ne voit pas le GPU. Toute installation
   suivante est contrainte à ce torch (`.venv/studio-constraints.txt`).
4. **llama.cpp** (même version que l'image Docker), `llama-server` compilé pour l'architecture de
   ce GPU dans `.build/llama/`, derrière une petite enveloppe qui ajoute les bibliothèques du
   toolkit CUDA à son propre chemin de bibliothèques seulement.
5. **FastVideo** (même commit que l'image Docker) et ses noyaux, compilés contre le torch du venv
   pour ce GPU (`12.1a` sur un GB10), installés sans leurs dépendances ; celles-ci viennent de
   `docker/fastvideo-requirements.txt`, comme dans l'image.
6. **Le paquet studio** en mode éditable avec son extra `inference`, puis un contrôle des imports.
7. **Configuration** `~/.config/studio/studio.env` (une seule fois).
8. **Service** `/etc/systemd/system/studio.service`, lancé sous l'utilisateur qui a lancé le
   script, depuis le dépôt, activé au démarrage et redémarré ; le script attend `/api/health`.

Un deuxième passage ne recompile que ce qui a changé (llama.cpp et FastVideo sont sautés quand leur
version épinglée et l'architecture du GPU sont déjà compilées), puis redémarre le service.

## Au quotidien

```bash
systemctl status studio                 # état
journalctl -u studio -f                 # journal
sudo systemctl restart studio           # après une modification de studio.env
curl -s localhost:8090/api/health       # app, GPU, LLM
```

## Mises à jour

L'interface propose une mise à jour quand la branche `main` du dépôt a de nouveaux commits
(`docs/fr/GALLERY.md` § Mise à jour depuis l'interface). Elle refuse tant que des jobs tournent,
avance la branche, puis redémarre le serveur. Quand la mise à jour touche les dépendances
(`pyproject.toml`, `docker/`, ce script), elle demande plutôt de relancer `scripts/install.sh`, qui
réinstalle et redémarre le service. À la main :

```bash
git pull --ff-only && scripts/install.sh
```

## Désinstaller

```bash
sudo systemctl disable --now studio && sudo rm /etc/systemd/system/studio.service
rm -rf .venv .build ~/.config/studio      # garde les modèles et les rendus
rm -rf ~/.local/share/studio              # modèles et rendus, si tu veux aussi les retirer
```

## Différences avec l'image Docker

| | Docker (`docker compose`) | Bare metal (`scripts/install.sh`) |
|---|---|---|
| torch | NGC PyTorch 25.11 (2.10, CUDA 13.0) | PyPI 2.12.0 (CUDA 13.0), la version de FastVideo |
| Toolkit CUDA | dans l'image | celui du système (13.x) |
| Mises à jour | reconstruire l'image | depuis l'interface |
| Données | `./data` (`STUDIO_DATA`) | `~/.local/share/studio` (`--data`) |

Les deux compilent llama.cpp et FastVideo aux mêmes versions épinglées (`tests/test_install.py` le
vérifie). Aucun des deux n'est encore qualifié sur le GB10 : les rendus doivent d'abord y être
inspectés (LESSONS n°1).
