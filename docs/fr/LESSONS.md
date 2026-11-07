# Leçons reprises d'AI Content Studio 1.4

Chaque règle ci-dessous vient d'un échec réel en 1.4 (époque ComfyUI + Ollama), validé par un rendu
GPU. Les numéros entre crochets renvoient à l'entrée d'origine de `docs/LESSONS.md` dans le
[dépôt 1.4](https://github.com/yoyo-sama/dellaicontent), qui raconte l'histoire complète. Les
règles qui ne portaient que sur la plomberie des graphes ComfyUI ont été retirées ; restent celles
qui concernent les modèles, les prompts et le produit, qui ne changent pas avec le moteur
d'exécution.

Version anglaise (de référence) : [../LESSONS.md](../LESSONS.md).

## 1. Vérification

1. **Un job réussi ne prouve rien.** La 1.4 a livré plusieurs pipelines qui rendaient du bruit ou
   le mauvais modèle avec un statut `success` (poids renommés, mauvais encodeur, LLM câblé comme
   encodeur de texte). Chaque moteur est validé par un vrai rendu réduit dont on *regarde* les
   images et écoute l'audio. Une entrée du catalogue reste `"qualified": false` tant que ce n'est
   pas fait sur le matériel cible. [#14]
2. **Regarder les bords du cadre, les dégradés du ciel et la saturation**, pas seulement « est-ce
   la bonne scène » : un modèle distillé sous-échantillonné garde la composition et casse d'abord
   la couleur (LoRA turbo H3 à 4 étapes : aplats clippés, dominante cyan, bande arc-en-ciel en bas
   du r2v). [#12]
3. **Inspecter au moins une image de part et d'autre du milieu** d'un clip première/dernière
   image, sinon une coupe franche au milieu passe inaperçue. Les transitions se jugent à durée
   nominale. [#13]
4. **Avant d'accuser un changement d'interface, rejouer le même job par l'ancien chemin** et
   comparer les erreurs : cela sépare les problèmes de packaging des régressions de code. [#14]

## 2. Règles produit (conservées telles quelles)

5. **Rien ne part en rendu sans un clic.** Ajouter un sujet, éditer un champ, choisir un moteur ou
   une langue ne soumet aucun job. Le backend ne crée un job que si un client le poste.
6. **Le prompt de l'utilisateur part verbatim.** Dès qu'un prompt est montré et modifié, c'est ce
   texte qui part au modèle : jamais de recompilation par-dessus, jamais de retour silencieux à la
   version compilée.
7. **Le verbatim porte sur les mots de l'utilisateur, pas sur les invariants du graphe.** Le bloc
   d'ancrage des références d'une keyframe est ré-apposé sur tous les chemins, y compris un prompt
   tapé à la main ; sans lui, le modèle d'édition colle les planches en collage. [#31]
8. **Le brief n'appartient qu'à l'utilisateur.** Les exemples sont des placeholders, jamais des
   valeurs ; un brief vide ne lance rien.
9. **Ne jamais demander au LLM de décrire un sujet absent du brief :** il en invente un, et par
   défaut c'est un humain. Un nouvel emplacement de sujet démarre vide. [#25]

## 3. Prompter le LLM (Gemma 4)

10. **Amputer, puis recomposer.** Ce qui ne doit pas changer (blocs d'ancrage, squelettes de
    planche, structure des champs H3) est retiré avant d'envoyer le texte au LLM et remis par le
    code ensuite. Une consigne de ne pas y toucher ne suffit pas. [#21, #29]
11. **Les jetons ne survivent pas au LLM.** `<Subject N>` revient abîmé : le remplacer par un mot
    nu (`SUBJECTREF1`) avant l'appel, le restituer après, ne réparer que la sortie du LLM, et
    écarter une sortie qui a perdu ou inventé un jeton. [#26, #36]
12. **Un substitut doit être explicitement autorisé par la consigne qui le reçoit**, sinon le
    modèle le range dans la « syntaxe interdite » et le supprime. [#35]
13. **Une consigne qui ne dit pas « enrichis » fait recopier ou raccourcir.** [#36]
14. **Les détails de fin de phrase se perdent** (mouvements de caméra après un « ; »). Les remettre
    par le code à partir d'une table fermée, pas par une consigne plus forte. [#37]
15. **Une consigne par modèle, routée en un seul endroit, prouvée par ce que le modèle a
    réellement reçu** (test d'empreinte), jamais par la lecture du code de routage. [#34]
16. **Le JSON de Gemma peut contenir des objets là où on attend des chaînes :** toujours
    normaliser. Le modèle ajoute aussi du remplissage (« ultra-detailed, 8k ») : le retirer après
    l'appel. [Application]
17. **Sonder la capacité de vision au premier usage** plutôt que la supposer ; une description
    d'image qui échoue devient une chaîne vide et ne bloque jamais un rendu. [Grammaire H3]

## 4. Krea 2

18. **Le prompt négatif n'est jamais encodé.** Krea 2 tourne à cfg 1 avec un négatif mis à zéro :
    toute contrainte doit être formulée positivement dans le prompt. [#16]
19. **Sa propre consigne d'enrichissement** (sujet → style → lumière → optique → composition →
    couleur → matière → atmosphère, 40 à 100 mots, aucun négatif).

## 5. Qwen Image Edit (2509 et 2.1)

20. **Aucun vocabulaire « storyboard / keyframe / planche »** dans un prompt d'édition : le modèle
    dessine une planche annotée. Dire positivement « une seule image de film plein cadre ». [#7]
21. **En 2509, l'image 1 fixe le latent de départ, l'image 2 n'est que du conditioning.** La
    planche du sujet doit être l'image 1 ; le décor va dans les entrées suivantes. La 2.1 a des
    références symétriques. La 2.0 ne garde que la 2.1 (2509 retiré le 2026-10-29) ;
    diffusers calcule par défaut la taille d'une retouche d'après la *dernière* image, le moteur
    la calcule donc depuis l'image 1 (IMAGE-ENGINES.md). [#10]
22. **Nommer le décor en toutes lettres**, deux fois (phrase de rôle et après l'action) : une image
    de référence qui ne nourrit que le conditioning ne suffit pas à cfg 1. [#28]
23. **Les angles de caméra forts sont ignorés** (plongée zénithale, contre-plongée extrême) :
    l'édition garde la pose de la référence. Gros plans et plans larges fonctionnent. [#8]
24. **Deux sujets par plan au maximum**, quel que soit le moteur : au-delà, les sujets se
    dupliquent ou le décor se perd. À deux sujets, nommer chacun selon sa nature et exiger un
    exemplaire entier et visible. [#17, #32]
25. **Le gabarit de planche suit la nature du sujet** (humain ou autre) ; un gabarit humain
    transforme un lion en bipède costumé. [#17]

## 6. MiniMax H3 / FastH3

26. **La longueur suit la grille 17n+5 à 24 i/s**, pas la durée demandée (1 s → 39 images,
    1,625 s). Largeur et hauteur sont arrondies au multiple de 32 inférieur. Modulo à la Python
    en portant la formule. En 2.0, FastVideo limite aussi H3 à 5–15 s : un cut plus court est
    refusé, pas allongé en silence (H3.md). [#11, #20]
27. **La grammaire de prompt structurée est obligatoire** (6 champs Ref2VA). `<Picture N>` est
    l'entrée physique (à partir de 1), `<Subject N>` l'identité logique, liées une fois dans
    `subject_definitions` ; la prose n'emploie que `<Subject N>`. Plafond dur de 7 000 caractères,
    rogné uniquement dans `detailed_description`. [#19]
28. **I2VA/FL2VA demandent une phrase d'alignement temporel** dont le repère de fin est la durée
    *réellement rendue*. [#20]
29. **Les checkpoints FL2VA et Ref2VA sont deux modèles différents**, non interchangeables.
30. **FastH3 OmniRef (validé sur GB10 le 2026-10-28) :** 8 étapes, guidance 1, shift vidéo 12,
    shift audio 3, attention creuse VSA obligatoire, deux passes (≈0,3 Mpx puis upscale latent à
    ≈0,9 Mpx et 3 étapes de raffinement à denoise 0,4), `ref_image_size = max`. Identité 0,838 en
    1280×736, 5 s, 260 s. Pas de LoRA d'accélération (déjà distillé). Les LoRA de style
    s'appliquent en branche exacte ; fusionner une LoRA dans un checkpoint quantifié en détruit
    l'essentiel.
31. **Un prompt de cut n'est jamais un mouvement de caméra seul :** l'ancrer sur scène + sujet +
    décor, sinon la vidéo dérive vers un contenu sans rapport. [#9]
32. **La continuité exacte entre segments passe par la dernière image réutilisée telle quelle** ;
    la faire repasser par une édition d'image crée une coupure visible. [#22]

## 7. Plateforme

33. **Le GB10 a une mémoire unifiée :** la « VRAM libre » exclut le cache de pages récupérable.
    Mesurer la mémoire système disponible quand la VRAM totale ≈ la RAM totale.
34. **Un conteneur qui écrit dans un dépôt monté tourne avec l'UID du propriétaire**, jamais en
    root. [#33]
35. **Un modèle n'est référencé qu'après avoir vérifié sa présence sur disque** ; les fichiers
    sont renommés ou déplacés d'une version à l'autre. [#14]
36. **Brider et conserver les compilations JIT de FlashInfer.** Le premier job H3 en NVFP4 compile
    le `fp4_gemm_cutlass_sm120` de FlashInfer au moment du rendu. Sans `MAX_JOBS`, environ 22
    processus nvcc tournaient en parallèle (~130 Go) : le GB10 a manqué de mémoire et aucun clip
    n'est sorti. Avec `MAX_JOBS=4`, la compilation prend 2 min 50 et laisse plus de 91 Go
    disponibles. Le cache doit vivre sur le volume de données
    (`FLASHINFER_WORKSPACE_BASE=/data/cache`) ; sinon chaque nouveau conteneur recompile. L'image
    règle les deux. (GB10, 2026-10-30)
37. **Pas de torch.compile sur le VAE H3 dans un serveur qui dure.** La recette V2 de FastVideo
    compile les tuiles du VAE en mode `reduce-overhead` (graphes CUDA). L'état des graphes CUDA est
    propre à chaque thread, et FastVideo lance chaque requête dans un nouveau thread. Le deuxième
    job sur le même générateur échouait donc au bout de 6 s (`assert torch._C._is_key_in_tls`
    dans `cudagraph_trees.py`). Sans compilation, trois jobs d'affilée passent, et le premier job
    ne paie plus 3 min 30 de compilation. Un test unitaire ne peut pas le voir : seul un deuxième
    vrai job sur le GPU le montre. (GB10, 2026-10-30)
38. **Dimensionner les références image H3 comme ComfyUI, pas comme FastVideo.** FastVideo agrandit
    chaque référence image à 2048 px de petit côté et garde les références image denses dans son
    attention creuse : le r2v avec deux planches 1920×1088 prenait 680 s, 2,6 fois ComfyUI. Le
    `ref_image_size` « max » de ComfyUI ne fait que réduire à ce côté : environ 247 s, sans perte
    visible. Envoyer des références plus petites n'y change rien, FastVideo les ré-agrandit.
    (GB10, 2026-10-30)
42. **Ne jamais laisser projeter en mémoire un fichier de poids sur le GB10.** Projeté, Krea 2
    chargeait en 253 s ; lu d'un bloc, 82 s, alors que son disque lit à 4,3 Go/s. Lire d'abord le
    dossier dans le cache disque n'a rien changé (236 s) : c'est la projection qui coûte, pas le
    disque. Le `disable_mmap` de diffusers ne touche que ses propres modèles, donc
    `common.from_pretrained` charge lui-même les encodeurs de texte transformers avec le leur, et
    l'itérateur de poids de FastVideo reçoit un lecteur de fichier entier (`h3_runtime.WholeFile`)
    à la place de `safe_open` : FastH3 OmniRef se charge alors en 147 s au lieu d'environ 285 s.
    (GB10, 2026-11-05)
43. **Pas de FP8 torchao sur le GB10 ; torch.compile seulement là où il est rentable.** Des poids
    et activations dynamiques FP8 (échelles par ligne) prenaient 1 800 s par étape de Krea 2 au
    lieu de 5,7. `torch.compile` du transformer, en mode par défaut, a fait gagner 22 % par étape
    sur Qwen Image 2.1 en 1920×1088 (16 s par image) pour environ 15 s de compilation au premier
    rendu de chaque taille dans un processus : gardé jusqu'au passage de Qwen à 4 étapes (n°46),
    où il ne ferait gagner qu'environ 1 s par image. Sur Krea 2, il faisait gagner 12 % (6 s par
    image de 8 étapes) pour environ 33 s par nouvelle taille ou nombre d'images : écarté. (GB10,
    2026-11-05)
44. **Les upscalers de NVIDIA ne tournent pas sur le GB10.** DLSS 5 demande les buffers qu'un
    moteur de jeu produit à chaque image, et Windows (Streamline, D3D12/Vulkan) ; ses ponts
    ComfyUI chargent les DLL NGX Windows, au mieux sous Wine en Linux x86-64 ; le RTX Video SDK
    est réservé à Windows et `nvidia-vfx` n'a pas de roue ARM64. L'agrandissement passe par un
    réseau ouvert exécuté en PyTorch (SPAN par spandrel,
    [IMAGE-ENGINES.md](IMAGE-ENGINES.md#résolution-2)). (2026-11-06)
45. **Un `docker compose` lancé depuis un conteneur doit voir le projet à son chemin sur l'hôte.**
    Compose résout `./data` par rapport au dossier du projet et transmet le chemin absolu au démon
    de l'hôte : lancé depuis `/repo`, il monterait un `/repo/data` vide de l'hôte et
    retéléchargerait tous les modèles. Le service updater relie le dossier de l'hôte (sa propre
    étiquette `com.docker.compose.project.working_dir`) à `/repo` et reprend nom de projet et
    fichiers compose de ses étiquettes ; compose garde le lien tel quel. Son git tourne sous
    l'identité du propriétaire du dépôt, jamais en root (leçon de la 1.4).
    [GALLERY.md](GALLERY.md#docker-docker-compose) (2026-11-07)
46. **Qwen Image 2.1 tourne avec un transformer distillé, 4 étapes au lieu de 25.**
    lightx2v/Qwen-Image-2.1-Lightning-v2-RL remplace le transformer de Qwen (encodeur de texte,
    VAE et processeur inchangés) : 2,9 à 3,6 fois plus rapide sur les cinq cas de qualification
    Qwen, trois seeds chacun, avec l'identité des deux sujets des planches gardée dans chaque image
    de plan. Ses 4 sigmas sont déjà décalés : le planificateur du dépôt de base (décalage
    exponentiel dynamique, terminal 0,02) les décalerait une seconde fois, donc un simple
    `FlowMatchEulerDiscreteScheduler(shift=1)` le remplace. Le fichier est en FP32 (28,5 Go),
    chargé en BF16 (14 Go) en 26 à 41 s. Contreparties : plus de contraste et de saturation, des
    structures parasites en texte vers image (2 seeds sur 3) ; la dérive de « garder le reste »
    sur une retouche qui demande des rochers absents de l'image venait de la consigne (la base
    dérivait aussi, 3/3). Le Turbo officiel de Qwen à 8 étapes n'allait que 2 fois plus vite,
    plus sombre et plus terne. `tools/qualify/qwen_fast_bench.sh` (promaxgb10-95c7, 2026-11-07)

## 8. Front end (pour le portage de l'étape 4)

39. Le texte de l'interface est traduit (FR/EN/ES/DE, tutoiement) ; toute chaîne posée par le code
    passe par la fonction de traduction à l'écriture et de nouveau au changement de langue.
40. Une garde sur un état possiblement nul se choisit pour le résultat qu'elle donne quand l'état
    est absent, pas pour sa symétrie apparente. [#18]
41. Une capture headless avec budget de temps virtuel peut figer une image antérieure au DOM
    final : confirmer par un dump du DOM. [#15]
