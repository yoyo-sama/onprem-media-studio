# Front end: Studio and Canvas

French version: [fr/FRONTEND.md](fr/FRONTEND.md).

Two static pages served from `web/`, with no build step: `index.html` (the Assistant and the
Studio: the chat, the forms, the step-by-step director, the gallery) and `canvas.html` (the
Canvas: cards connected on a graph). The rail offers three modes in this order: **Assistant**
(the first one, a chat in the main area), **Studio** and **Canvas**. Assistant and Studio are two
modes of `index.html` (`body[data-mode]`, address `#assistant` or `#studio`, last mode remembered
under `mode`); the library (job queue and gallery) moves to the mode shown.
Both are ports of AI Content Studio 1.4 onto the 2.0 API ([ARCHITECTURE.md](ARCHITECTURE.md)).
The only third-party code is litegraph.js 0.7.18 for the Canvas, vendored with its MIT licence
in `web/js/vendor/`.

## Files

| File | Role |
|---|---|
| `web/js/prompts.js` | Prompt compilers and Gemma instructions of 1.4, one copy for both pages (`window.Prompts`); also loadable from Node for the tests |
| `web/js/api.js` | REST calls, the `/api/ws` event socket, `waitJob`, the LLM call (`llmJSON`) |
| `web/js/i18n.js`, `i18n-dict.js` | Translation: English text is the key, French, Spanish and German in `DICT` |
| `web/js/ui.js` | Studio shell: event log, job queue and `runJob`, undo banner, prompt editor, theme |
| `web/js/form.js` | The 1.4 manifest as tables (workflows, pipelines, controls), form values, sizes, uploads, extra references, the form's LoRA stacks (one per folder; a workflow's `loras` names the folder its engine reads, none = no LoRA control) |
| `web/js/lora-stack.js` | LoRA stack picker shared by the Studio form and the Canvas panel: up to 4 rows of file and strength (-2 to 2) for one folder, each file once; edits the stack in place and submits nothing |
| `web/js/studio.js` | Studio page: modes (`setMode`), goal cards, menus, inputs, enrichment, the form's generate handlers, assistant cards taken over by the form (`openCardInForm`, `launchDirector`), models, LoRA, update |
| `web/js/generate.js` | The simple flows as functions of their settings (text/image to image or video, markets, sequence, campaign), called by the form and by the assistant's cards |
| `web/js/chat.js` | Assistant mode: conversations, streamed replies, role choice, attachments, library pane, cards (Generate, ✨, Open in the Studio, Launch the director), role editor of the Models panel: [ASSISTANT.md](ASSISTANT.md) |
| `web/js/mascot.js` | The assistant's animated character (inline SVG, moods in CSS): decoration only |
| `web/js/director.js` | Storyboard and reference-to-video director: sheets, shots, shot images, cuts, animatic, Relay |
| `web/js/gallery.js` | Studio gallery on `/api/gallery` (filters, lightbox, tags, trash, Upscale ×2) |
| `web/js/canvas.js` | Canvas page: drawing, media overlays, properties panel, use cases, persistence, theme, language |
| `web/js/canvas-nodes.js` | Canvas cards: inputs, properties, panel fields and what Generate submits |
| `web/js/canvas-gallery.js` | Canvas gallery drawer (drag an image onto an Image import card) |
| `web/js/model-notice.js` | Notice above Generate (Studio) and in the properties panel (Canvas) naming the models the chosen engine still has to download (`/api/pipelines`, `/api/models`, kept current by the `model` events and the end of each job); with the size left to download when Hugging Face gives it (`/api/models/{id}/size`); the server downloads them inside the first job |

## Rules

The rules of 1.4 still hold; [LESSONS.md](LESSONS.md) gives the reasons.

- **Nothing renders without a click.** Choosing a goal card, a pipeline, an engine, a language,
  adding a card or connecting cards submits nothing. Only Generate buttons (and the director's
  step buttons) post to `/api/jobs`, and "⇱ Upscale ×2" in the gallery lightbox, one job per
  click ([IMAGE-ENGINES.md](IMAGE-ENGINES.md#upscale-2)).
- **The director's first step draws nothing** (decided on 2026-11-01, unlike 1.4). "Open the
  studio" has Gemma write the subject and setting descriptions and the shot list, then opens
  the studio with no sheet. Each sheet is generated on its own click: from its fields, from a
  photo of the subject ("📷 Sheet from a photo", Qwen Image 2.1), or imported finished. A
  sheet's first generation keeps the seed the automatic step used to give it, so its job is the
  one 1.4 sent.
- **The brief belongs to the user.** Examples are placeholders, never values; an empty brief
  starts nothing.
- **"→ Use as input" follows the pipeline on screen** (images and clips, gallery card or
  lightbox). Sequence: the image joins the sequence. A pipeline with an input image (Image2Image,
  Image2Video): it becomes the input. Reference to video: the image or clip joins the reference
  list; Qwen 2.1 storyboard: the image does. Text2Video opens Image2Video with the image, any
  other pipeline Image2Image. A clip that the pipeline cannot take is refused with a message.
  The form is never left for another pipeline when the one shown can take the item, and no job
  starts.
- **The user's prompt goes verbatim**; anchoring blocks and sheet skeletons are re-appended by
  code, never sent through Gemma.
- **One Gemma instruction per model.** `Prompts.briefEnrichSystem(workflow)` routes the ✨
  buttons of both pages: Krea 2 → `KREA2_ENRICH_SYSTEM`, MiniMax H3 text/image to video and
  the multi-image sequence → `H3_VIDEO_ENRICH_SYSTEM`, reference to video →
  `R2V_BRIEF_ENRICH_SYSTEM`, storyboard briefs and sheets → `SHEET_BRIEF_ENRICH_SYSTEM`,
  Qwen Image 2.1 and MOSS-Image → the generic `ENRICH_SYSTEM`. `<Subject N>` and `<imageN>` tokens cross Gemma
  as stand-ins and are checked on the way back.
- **These five instructions can be replaced** in the Studio's Models panel ("Gemma
  instructions"): the server keeps the texts in `STUDIO_DATA_DIR/instructions.json`
  (`/api/instructions`), both pages read them again before each enrichment, and "Restore the
  original" removes the replacement. A replaced text only takes the default's place: the answer
  key and the token checks stay in the code, and the panel warns when the text stops naming the
  key (or SUBJECTREF, for reference to video). The defaults stay those of 1.4.
- **The assistant follows the same rules**: its cards run only on a click, through `generate.js`
  (the submitted jobs are the form's, byte for byte); a storyboard or reference-to-video card
  runs the director only through its "Launch the director" button, which switches to the Studio,
  fills the form and does what Generate does there (the step-by-step review); "Open in the Studio"
  writes the brief on the click, with Undo, and starts nothing.
- **Interface text is translated, log lines too**; file names, prompts and server data are
  marked `data-raw` and never translated.

## Canvas cards

| Card | Inputs | Job(s) |
|---|---|---|
| Character sheet | — | Gemma (sheet fields; a subject type chosen on the card is imposed), then `krea2-t2i` 1920×1088 |
| Setting sheet | — | Gemma, then `krea2-t2i` 1920×1088 |
| Storyboard | character sheet, setting sheet, an optional third sheet | Gemma shot list, one `qwen-image-2.1` shot image per shot (subjects + setting), `image-grid` |
| Video generation | storyboard | one `h3-i2v` cut per shot (from the shot image), or `h3-r2v` (sheets + shot image as references) |
| Final video | video generation | `video-concat` of the cuts |
| Reference2Video | character sheet, setting sheet, up to 7 extra images, 3 clips and 3 sounds | one `h3-r2v` job |
| Image creation | — | `krea2-t2i` or `qwen-image-2.1` |
| Image editing | image, up to 9 extra references | `qwen-image-2.1` (the image is `<image1>`, references `<image2>`…) |
| Video | image | `h3-i2v` |
| Image import | — | upload (`/api/inputs`), or an image dragged from the gallery drawer |

A card that produced something keeps the file reference in `properties.outFile`; the cards
downstream read it. The graph is saved in the browser (`localStorage`, key `canvasGraphState`);
the files stay on the server. The "+" on a free image input adds an Image import card connected
to it.

## Differences from 1.4

- No ComfyUI and no LTX 2.5: every video is MiniMax H3, 5 to 15 seconds (17n+5 frame grid, the
  actual duration is shown).
- Qwen-Image-Edit 2509 is gone (2026-10-29): image editing and shot images use Qwen Image 2.1,
  whose sizes are multiples of 32 (`QWEN21_RATIOS`: 1344×768, 768×1344, 1024², 896×1120). A
  project saved with the 2509 storyboard resumes on Qwen Image 2.1.
- New in 2.0: MOSS-Image in Text2Image (Studio, the Canvas "Image creation" card, the assistant's
  image card), with a Mode select shown for that engine only: Preview (4 steps), Standard (8,
  default) or Quality (25). It uses the Krea 2 ratio table (multiples of 16).
- No cloud generation (OpenAI, Gemini).
- No megapixel or turbo/steps controls; LoRAs are uploaded files, one folder per engine family
  (H3, Krea 2, Qwen Image 2.1, MOSS-Image). A render takes a stack of up to 4 LoRAs, each with
  its strength (1.4: one file at full strength, Krea 2 and H3 only); a Canvas saved with the old
  single `lora` property comes back as a one-row stack. Text2Image and Image2Image show the stack
  of the chosen engine (each keeps its own); the Canvas "Image creation" card keeps one stack per
  engine and "Image editing" a Qwen one. An image job sends `loras` only when its stack has rows.
- Reference to video's extra references take up to 7 images, 3 clips and 3 sounds (as in 1.4),
  in one list (`F.r2vPlan`). Each image is the next `<Subject N>`; a clip has a role (camera
  movement and pacing, or a subject) and a sound one too (voice of a character, music, ambience
  and sounds), shown with its label. The director and "skip the sheets" send them in the list
  order, with the prompt of `buildH3RefPrompt` ([H3.md](H3.md)); a clip goes silent.
- In the director, a reference-to-video clip plays under its button once rendered, and the
  button becomes "Regenerate the video": a new job on the same sheets, with the next seed.
- The multi-image sequence uses the H3 video instruction (1.4 used LTX there).
- The Relay legend names every subject of the shot (1.4 lost the main character).
- Canvas: ✨ follows the Studio routing (1.4 had its own copy of the generic instruction), the
  final video has no audio switch (clips keep their sound), imports are images only.

## Tests

| Command | What it checks | Needs |
|---|---|---|
| `python -m pytest` | Server, engines' parameters, gallery, and `tests/test_i18n.py`: every interface string of both pages has its French, Spanish and German translation with the same `{placeholders}`, and no entry is unused | Python, Node |
| `node tools/parity-prompts.js` | Every prompt compiler and instruction gives, character for character, what 1.4 (`234f37c`, read from `../dellaicontent`) gives, with scripted Gemma answers | Node, the 1.4 checkout |
| `node tools/prompt-systems.js` | Runs both pages headless with `/api` stubbed: for each engine and ✨ button (and automatic enrichment), the instruction Gemma receives has the 1.4 sha256 (or is the replaced one, for its engine only), the call count and user content are right, the text comes back into the field | Node, Playwright and its Chromium (`NODE_PATH=$(npm root -g)`) |
| `node tools/assistant-ui.js` | The assistant mode headless with `/api` stubbed and a scripted reply: the page opens on the assistant; no job from switching modes, the library, typing, sending or editing a card; one job per Generate, with the card's settings, its progress shown on the card from the job events, reported back; "Open in the Studio" switches to the Studio, fills the form and submits nothing; "Launch the director" switches to the Studio and starts the director, whose Generate button names Gemma's work and its time until the first step is ready; that step opens the studio without drawing a sheet, and a sheet's own click sends it with the first step's seed; a card's LoRA chips submit nothing and its Generate sends the ones turned on | Node, Playwright and its Chromium |
| `node tools/lora-ui.js` | The LoRA stack headless with `/api` stubbed: in the Studio it shows for the workflows that take LoRAs only, takes up to 4 files (each once) with strengths clamped to -2…2, submits nothing while edited, Generate sends the rows on screen, another engine sends none and coming back finds the stack; the Models panel uploads into the chosen folder; a Canvas saved with the old `lora` property comes back as a one-row stack and its Generate sends the stack | Node, Playwright and its Chromium |

Changing a prompt compiler or an instruction makes `parity-prompts.js` and `prompt-systems.js` fail; if the change is wanted,
update the reference in the same commit and say why.
