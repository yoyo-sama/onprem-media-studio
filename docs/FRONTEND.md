# Front end: Studio and Canvas

French version: [fr/FRONTEND.md](fr/FRONTEND.md).

Two static pages served from `web/`, with no build step: `index.html` (the Studio: forms, the
step-by-step director, the gallery) and `canvas.html` (the Canvas: cards connected on a graph).
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
| `web/js/form.js` | The 1.4 manifest as tables (workflows, pipelines, controls), form values, sizes, uploads, extra references |
| `web/js/studio.js` | Studio page: goal cards, menus, inputs, enrichment, generate flows, models, LoRA, update |
| `web/js/director.js` | Storyboard and reference-to-video director: sheets, shots, shot images, cuts, animatic, Relay |
| `web/js/gallery.js` | Studio gallery on `/api/gallery` (filters, lightbox, tags, trash) |
| `web/js/canvas.js` | Canvas page: drawing, media overlays, properties panel, use cases, persistence, theme, language |
| `web/js/canvas-nodes.js` | Canvas cards: inputs, properties, panel fields and what Generate submits |
| `web/js/canvas-gallery.js` | Canvas gallery drawer (drag an image onto an Image import card) |

## Rules

The rules of 1.4 still hold; [LESSONS.md](LESSONS.md) gives the reasons.

- **Nothing renders without a click.** Choosing a goal card, a pipeline, an engine, a language,
  adding a card or connecting cards submits nothing. Only Generate buttons (and the director's
  step buttons) post to `/api/jobs`.
- **The brief belongs to the user.** Examples are placeholders, never values; an empty brief
  starts nothing.
- **The user's prompt goes verbatim**; anchoring blocks and sheet skeletons are re-appended by
  code, never sent through Gemma.
- **One Gemma instruction per model.** `Prompts.briefEnrichSystem(workflow)` routes the ✨
  buttons of both pages: Krea 2 → `KREA2_ENRICH_SYSTEM`, MiniMax H3 text/image to video and
  the multi-image sequence → `H3_VIDEO_ENRICH_SYSTEM`, reference to video →
  `R2V_BRIEF_ENRICH_SYSTEM`, storyboard briefs and sheets → `SHEET_BRIEF_ENRICH_SYSTEM`,
  Qwen Image 2.1 → the generic `ENRICH_SYSTEM`. `<Subject N>` and `<imageN>` tokens cross Gemma
  as stand-ins and are checked on the way back.
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
| Reference2Video | character sheet, setting sheet, up to 7 extra images | one `h3-r2v` job |
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
- No cloud generation (OpenAI, Gemini).
- No Krea 2 LoRA, megapixel or turbo/steps controls; H3 LoRAs are uploaded files.
- Reference to video takes image references only (no video or audio references).
- The multi-image sequence uses the H3 video instruction (1.4 used LTX there).
- The Relay legend names every subject of the shot (1.4 lost the main character).
- Canvas: ✨ follows the Studio routing (1.4 had its own copy of the generic instruction), the
  final video has no audio switch (clips keep their sound), imports are images only.

## Tests

| Command | What it checks | Needs |
|---|---|---|
| `python -m pytest` | Server, engines' parameters, gallery, and `tests/test_i18n.py`: every interface string of both pages has its French, Spanish and German translation with the same `{placeholders}`, and no entry is unused | Python, Node |
| `node tools/parity-prompts.js` | Every prompt compiler and instruction gives, character for character, what 1.4 (`234f37c`, read from `../dellaicontent`) gives, with scripted Gemma answers | Node, the 1.4 checkout |
| `node tools/prompt-systems.js` | Runs both pages headless with `/api` stubbed: for each engine and ✨ button (and automatic enrichment), the instruction Gemma receives has the 1.4 sha256, the call count and user content are right, the text comes back into the field | Node, Playwright and its Chromium (`NODE_PATH=$(npm root -g)`) |

Changing a prompt compiler or an instruction makes the last two fail; if the change is wanted,
update the reference in the same commit and say why.
