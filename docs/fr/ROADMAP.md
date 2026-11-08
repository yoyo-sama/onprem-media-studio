# Feuille de route

Version anglaise (de référence) : [../ROADMAP.md](../ROADMAP.md).

| Étape | Contenu | État |
|---|---|---|
| 1. Socle | Dépôt, serveur FastAPI, file de jobs, catalogue de modèles et téléchargement automatique, Gemma via llama.cpp, image Docker pour GB10, leçons de la 1.4 | En cours : code et tests unitaires faits ; premier build et premier appel LLM sur GB10 à faire |
| 2. Image | Krea 2 (texte vers image, campagne, planches) et Qwen Image 2.1 (image vers image, keyframes avec références planche + décor ; Qwen-Image-Edit 2509 retiré le 2026-10-29), chaque moteur qualifié par un vrai rendu comparé à la 1.4 | Fait : qualifié sur le GB10 le 2026-10-30, cas Krea 2 7/7 et Qwen Image 2.1 4/4 ([IMAGE-ENGINES.md](IMAGE-ENGINES.md)) |
| 3. Vidéo | FastH3 OmniRef pour la référence vers vidéo (workflow à deux passes validé le 2026-10-28), FastH3 pour texte/image/première-dernière image vers vidéo ; cuts du storyboard, Reference2Video et Relay passent sur H3 ; LTX 2.5 retiré | Fait : qualifié sur le GB10 le 2026-10-30 en NVFP4 (Ref2VA en deux passes avec notre upscaler latent, pile de LoRA ; les checkpoints FP8 non qualifiés ont été retirés le 2026-11-07), limite du FL2VA documentée ([H3.md](H3.md)) |
| 4. Parité et bare metal | Portage du front Studio et Canvas (code en anglais, interface FR/EN/ES/DE), galerie, mise à jour depuis l'interface, tests de non-régression ; script d'installation bare metal pour DGX OS et Ubuntu | En cours : Studio et Canvas portés ([FRONTEND.md](FRONTEND.md)), galerie, mise à jour, téléversement de LoRA ([GALLERY.md](GALLERY.md)), script d'installation ([INSTALL.md](INSTALL.md)), tests de non-régression faits avec des rendus simulés ; un passage complet sur le GB10 reste à faire |
| 5. Assistant de création | Un chat dans le Studio avec des rôles choisis automatiquement (réalisateur, DA publicité, casting, localisation, campagne, transitions, général), qui répond par des cartes lançant les pipelines du Studio sur un clic ; Gemma 4 26B-A4B pour le chat et les enrichissements ([ASSISTANT.md](ASSISTANT.md)) | En cours : serveur et mode Assistant faits ; Gemma 4 26B-A4B qualifié sur le GB10 le 2026-11-07 |

Plus tard : l'assistant dans le Canvas ; Omarchy, Windows 11 (x86 et ARM64).
