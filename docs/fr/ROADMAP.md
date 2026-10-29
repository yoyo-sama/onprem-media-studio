# Feuille de route

Version anglaise (de référence) : [../ROADMAP.md](../ROADMAP.md).

| Étape | Contenu | État |
|---|---|---|
| 1. Socle | Dépôt, serveur FastAPI, file de jobs, catalogue de modèles et téléchargement automatique, Gemma via llama.cpp, image Docker pour GB10, leçons de la 1.4 | En cours : code et tests unitaires faits ; premier build et premier appel LLM sur GB10 à faire |
| 2. Image | Krea 2 (texte vers image, campagne, planches) et Qwen Edit 2509 / 2.1 (image vers image, keyframes avec références planche + décor), chaque moteur qualifié par un vrai rendu comparé à la 1.4 | En cours : moteurs, envoi d'images et références, tests unitaires et cas de qualification faits ([IMAGE-ENGINES.md](IMAGE-ENGINES.md)) ; vrais rendus sur GB10 à faire |
| 3. Vidéo | FastH3 OmniRef pour la référence vers vidéo (workflow à deux passes validé le 2026-10-28), FastH3 pour texte/image/première-dernière image vers vidéo ; cuts du storyboard, Reference2Video et Relay passent sur H3 ; LTX 2.5 retiré | À faire |
| 4. Parité et bare metal | Portage du front Studio et Canvas (code en anglais, interface FR/EN/ES/DE), galerie, mise à jour depuis l'interface, tests de non-régression ; script d'installation bare metal pour DGX OS et Ubuntu | À faire |

Plus tard : Omarchy, Windows 11 (x86 et ARM64).
