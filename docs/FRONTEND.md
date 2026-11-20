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
| `web/js/generate.js` | The simple flows as functions of their settings (text/image to image or video, markets, campaign), called by the form and by the assistant's cards |
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
  click ([IMAGE-ENGINES.md](IMAGE-ENGINES.md#upscale-2)). A click may start, in a row, the
  jobs its button stands for: "Generate the chain" renders the Relay's segments and, when every
  one is ready, assembles the sequence (two segments or more; a chain stopped or broken is not
  assembled).
- **A goal card with its own pipeline shows no Pipeline menu** (2026-11-20). "Narrative video
  (long take)" and "Short ad / campaign" open their pipeline alone (`sequence`, `campaign`:
  `own` in `PIPELINES`), with no menu to choose; the other cards share the general pipelines
  (Text2Image, Image2Image, Text2Video, Image2Video, reference to video) in the menu. "→ Use as
  input" from such a card opens the general card (`usePipeline`).
- **One card for a story told in video** (2026-11-20). The "Narrative trailer" card (the
  storyboard: sheets, shot images, animatic) and the "Long video" card did the same job; the
  owner had them merged into "Narrative video (long take)", which opens the long take. A new
  scene in a prose screenplay becomes a 🎞 cut: Gemma's split lists the segments that start a
  new shot (`cuts` in `H3_SCENARIO_SYSTEM`, numbers checked by `composeScenario`). Under
  References, "✨ Subject sheet from the brief" and "✨ Setting sheet from the brief" draw one
  sheet each (Gemma's fields, then one Krea 2 job) and add it with its role; "✨ Sheet" on a
  character photo draws its five-view sheet (one Qwen Image 2.1 job) in the photo's place. No
  approval step. The storyboard pipeline stays reachable from the assistant's storyboard card
  and a saved storyboard project resumes from the narrative card, until its removal is decided.
- **One main action per step, in view, and the rest folded** (2026-11-16). The form reads top
  to bottom: the brief on its full width, the pipeline's own settings, what it takes besides the
  brief (input image or first frame, extra references, sheets from the assistant), the
  "Advanced options" (seed, hold on the last shot, sheet layout, enrichment), then Generate:
  nothing to fill sits under the button. The Engine menu shows only when the pipeline has more
  than one engine (Text2Image). What skipping the sheets does is said once the box is ticked.
  The director's menu is a checklist: ✓ on a step that has its result (sheets ready, shot
  images, animatic, assembled long take, video), 🔒 on a step not open yet, and "Approve the
  sheets" right under the two sheets; approving opens the next step (Storyboard, or Video) and
  submits nothing. A sheet's first "Generate the sheet" is the primary button of its page. The
  step's main button ("Generate the shot images", the Relay's chain buttons) stays at the foot
  of the panel while the cards scroll. Folding never changes what is sent: a folded field keeps
  its value.
- **The director's first step draws nothing** (decided on 2026-11-01, unlike 1.4). "Open the
  studio" has Gemma write the subject and setting descriptions and the shot list, then opens
  the studio with no sheet. Each sheet is generated on its own click: from its fields, from a
  photo of the subject ("📷 Sheet from a photo", Qwen Image 2.1: five views, two portraits and
  three full-body views, in the image's own style; the sheet layout menu applies to sheets drawn
  from the fields only), or imported finished. A
  sheet's first generation keeps the seed the automatic step used to give it, so its job is the
  one 1.4 sent.
- **The brief belongs to the user.** Examples are placeholders, never values; an empty brief
  starts nothing.
- **"→ Use as input" follows the pipeline on screen** (images and clips, gallery card or
  lightbox). A pipeline with an input image (Image2Image, Image2Video): it becomes the input.
  Where the form takes both an input image and references (the long take, Image2Image on Qwen
  Image 2.1), an image card and the lightbox show the choice instead: "→ First frame" (the long
  take's name for its input image, which replaces "→ Use as input" there) or "→ Use as input",
  and "→ Reference", which adds the image to the reference list (CSS on
  `body[data-gallery-use]`, set by `updateModelLabel`; hidden in assistant mode). Reference to video: the image or clip joins the reference
  list; Qwen 2.1 storyboard: the image does. Text2Video opens Image2Video with the image, any
  other pipeline Image2Image. A clip that the pipeline cannot take is refused with a message.
  The form is never left for another pipeline when the one shown can take the item, and no job
  starts.
- **The user's prompt goes verbatim**; anchoring blocks and sheet skeletons are re-appended by
  code, never sent through Gemma.
- **One Gemma instruction per model.** `Prompts.briefEnrichSystem(workflow)` routes the ✨
  buttons of both pages: Krea 2 → `KREA2_ENRICH_SYSTEM`, MiniMax H3 text/image to video and
  the long take from images → `H3_VIDEO_ENRICH_SYSTEM`, reference to video →
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
  An uploaded file whose name starts with `H3_`, `Qwen_2.1`, `Krea_2` or `Moss_` (any case) goes
  to that engine's folder: the Models panel picks and locks the folder, and the server refuses
  such a file sent to another folder (422).
- Reference to video's extra references take up to 7 images, 3 clips and 3 sounds (as in 1.4),
  in one list (`F.r2vPlan`). Each image is the next `<Subject N>`; a clip has a role (camera
  movement and pacing, or a subject) and a sound one too (voice of a character, music, ambience
  and sounds), shown with its label. The director and "skip the sheets" send them in the list
  order, with the prompt of `buildH3RefPrompt` ([H3.md](H3.md)); a clip goes silent. "Skip the
  sheets" needs one image: the first is the character, the others stay free references, and the
  brief gives the place.
- A refusal of Generate (empty brief, missing image…) shows under the button, not only in the
  log; the next click clears it.
- In the director, a reference-to-video clip plays under its button once rendered, and the
  button becomes "Regenerate the video": a new job on the same sheets, with the next seed.
- The multi-image sequence of 1.4 became the long take (pipeline `sequence`, workflow
  `h3_sequence`). Since 2026-11-20 (evening) its form asks for two kinds of images, each in its
  own field, both optional: **First frame** (the input image field, one image: the video starts
  on it exactly and keeps it, so a sheet never goes there) and **References** (the reference
  list, up to 7, each with its role: character, setting or object; who or what must stay the
  same; a photo or a sheet, never shown as a frame). With neither, segment 1 is made from the
  text. "Open the long take" opens the director on the Relay alone, with no sheet and no
  approval, and submits nothing; Gemma's vision describes the images (the first frame and each
  reference), with no sheet-or-photo guess any more. Segment 1 is then `h3-i2v` on the first
  frame when there is one, else `h3-r2v` on the references (no start image, at the format its
  card shows), else `h3-t2v`; the segments after it continue it (`continue_from`) with the
  references (or, with none, the first frame or segment 1's last frame as the subject). A
  setting reference is the location of every segment. End images are no longer listed in the
  form: each segment card takes its own (🎯 End image, FL2VA). In the gallery, "→ First frame"
  and "→ Reference" send an image to one field or the other. The brief is the screenplay and the first text of every
  segment (splitting that screenplay asks nothing: a card that only holds the screenplay loses
  nothing). The goal card "Long video (long take)" opens this pipeline in one click. From
  segment 2 on, a link can be "🎞 Cut (new shot from the references)", as in the director's
  Relay (below); the form's H3 LoRA stack goes to every segment; the
  project is saved and resumed like a storyboard (one project at a time), under its own
  pipeline. The assistant's `long_take` card opens this long take (no render of its own), with
  its `first_frame` and its `references` and their `kinds`. ✨ uses the H3 video instruction,
  as 1.4's sequence did with LTX.
- Since 2026-11-20 a long take also starts with **no image**, imports a **screenplay file**, and
  opens from the assistant (docs/LONG-VIDEO.md § Screenplay files, text start and the
  assistant). With no image, segment 1 is H3 text to video (`h3-t2v`, `buildRelayTextPrompt`,
  at the format its card shows) and its last frame becomes the reference of the segments after
  it, which continue it as usual. A screenplay in the H3 layout (`P.parseScreenplay`: field
  lines, `[Shot N]` lines, `Segment N (00:00.000–00:10.000) – Title` lines) is read as written,
  in the form (📄 Import a screenplay puts it in the brief; auto enrichment leaves it alone) or in
  the Relay (📄 Import, or ✨ Split on a pasted one: no Gemma): one card per segment with its
  length, a later shot's first segment a cut, and the shared fields it gives, among them two new
  ones, Subjects (`subject_definitions`) and Identity to keep (`retention_analysis`), added word
  for word after the lines the app writes from the references (empty: prompts unchanged). A
  screenplay in that layout that names no `<Subject N>` describes a scene: its start picture
  (or segment 1's last frame) is then the location reference, not the main character.
- A Relay cut (🎞, from segment 2 on, in the director's Relay and in a long take) is one H3
  Ref2VA clip (`h3-r2v`) with no start image: the references are the sheets of the first two
  subjects with one (the first is the main character, a further human one a character, a
  non-human one a reference), then the setting: its sheet, or else the previous segment's
  chosen transition frame, its last frame by default (a long take has no setting sheet; the
  frames are extracted first when the previous segment was the last). A subject still visible
  in that frame is drifted already and wins over its sheet, so the cut button's tooltip asks for
  a frame where nobody is in view. H3 keeps the references in view for the whole clip, so a
  subject who left the frame comes back as itself; the prompt is the six-field block
  (`buildRelayCutPrompt`) with the shared look. A cut takes no end image (its button is hidden).
  A continuous segment (🔗) with a sheet to follow is H3 Ref2VA too, continuing the previous
  clip: `h3-r2v` gets the same subjects' sheets, the setting's sheet in the director's Relay
  only, and `continue_from` (the previous segment's clip), whose last second becomes its context
  (docs/LONG-VIDEO.md); it has no start image, extracts no transition frames for it and offers
  none to choose. Segment 1 of a long take with references and no first frame is `h3-r2v` on
  them, with no start image. A continuous segment without sheets, or with an
  end image (FL2VA), stays `h3-i2v` on the previous segment's transition frame, which takes no
  references. The chain ends with `video-stitch`, which decodes the continuing clips in one go
  and levels the take's sound to -18 LUFS. LESSONS #51, #52.
- A segment added after the end of a rendered chain gets the previous segment's transition
  frames extracted first (the last segment of a chain has none).
- The Relay legend names every subject of the shot (1.4 lost the main character).
- The Relay is set by a total length and a maximum per segment (10 s by default, the longest H3
  render qualified on the GB10; under the composer's "Advanced options", each card having its
  own length): the studio cuts the total into as few segments as possible, as
  even as possible, and shows each segment's place in the sequence (`00:10.1–00:20.3`, from the
  durations H3 really renders). The cards are the plan: a new total or maximum adds the missing
  cards empty (the chain waits until they are written) and removes the empty ones beyond it,
  never a written or rendered one; the total is the sum of the cards and the plan line describes
  them (LESSONS #51). Gemma writes, besides one action per segment, the look the
  whole sequence shares (framing, lighting, soundscape, music); it fills only the shared fields
  left empty. The shared framing is shot size and camera height only: each segment gives its
  own camera movement, one per segment. Each segment's prompt takes that look once, and nothing else: 1.4 appended a
  golden-hour light and a "steady framing" to every segment whatever it said (LESSONS #50). The
  first shot image takes the shared lighting too. The four shared fields are folded while they
  are all empty and open once one is written, by the user or by the split.
- The Relay has a production board: one tile per segment, as wide as its length, with its start
  image, its place in the sequence, its state and the progress of the job running for it (shot
  image, video, transition frames, from the job events); a click goes to the segment and starts
  nothing. The summary gives the segments ready, the seconds rendered and, once a segment has
  been timed, about how long is left. "Generate the chain" starts at the first segment that is
  not ready ("Continue the chain from segment n"), and marks the following ones "to
  regenerate"; when all are ready it renders them all again with new seeds, once confirmed.
  "Stop after this segment" ends the chain once the running segment is done. A chain that ends
  with every segment ready assembles the sequence at once, which plays under the board;
  "Assemble the sequence" stays for a chain with a segment regenerated since. A segment's end
  image, transition choice and removal sit under its "Advanced options"; the first segment
  shows no link, and "Regenerate" shows once a segment has a render. A segment is ready only
  once its transition frames are there.
- Canvas: ✨ follows the Studio routing (1.4 had its own copy of the generic instruction), the
  final video has no audio switch (clips keep their sound), imports are images only.

## Tests

| Command | What it checks | Needs |
|---|---|---|
| `python -m pytest` | Server, engines' parameters, gallery, and `tests/test_i18n.py`: every interface string of both pages has its French, Spanish and German translation with the same `{placeholders}`, and no entry is unused | Python, Node |
| `node tools/parity-prompts.js` | Every prompt compiler and instruction gives, character for character, what 1.4 (`234f37c`, read from `../dellaicontent`) gives, with scripted Gemma answers | Node, the 1.4 checkout |
| `node tools/prompt-systems.js` | Runs both pages headless with `/api` stubbed: for each engine and ✨ button (and automatic enrichment), the instruction Gemma receives has the 1.4 sha256 (or is the replaced one, for its engine only), the call count and user content are right, the text comes back into the field | Node, Playwright and its Chromium (`NODE_PATH=$(npm root -g)`) |
| `node tools/assistant-ui.js` | The assistant mode headless with `/api` stubbed and a scripted reply: the page opens on the assistant; no job from switching modes, the library, typing, sending or editing a card; one job per Generate, with the card's settings, its progress shown on the card from the job events, reported back; "Open in the Studio" switches to the Studio, fills the form and submits nothing; "Launch the director" switches to the Studio and starts the director, whose Generate button names Gemma's work and its time until the first step is ready; that step opens the studio without drawing a sheet, and a sheet's own click sends it with the first step's seed; a card's LoRA chips submit nothing and its Generate sends the ones turned on; the director's menu marks the ready sheets, and approving them opens the next step without a job | Node, Playwright and its Chromium |
| `node tools/lora-ui.js` | The LoRA stack headless with `/api` stubbed: in the Studio it shows for the workflows that take LoRAs only, takes up to 4 files (each once) with strengths clamped to -2…2, submits nothing while edited, Generate sends the rows on screen, another engine sends none and coming back finds the stack; the Models panel uploads into the chosen folder; a Canvas saved with the old `lora` property comes back as a one-row stack and its Generate sends the stack; a pipeline with one engine shows no engine menu, and the seed sits under the advanced options | Node, Playwright and its Chromium |
| `node tools/relay-ui.js` | The director's Relay headless with `/api` stubbed, on a restored project with approved sheets: the total length and the maximum per segment give the plan (25 s at 10 s → 8 + 8 + 9), the screenplay split fills the segments and only the shared fields left empty and submits nothing, the segment headers show their place in the sequence, and the chain sends a shot image then one H3 clip per segment whose prompt carries the shared look once and no default light or camera; the production board shows each segment's state and the progress sent by the job events, a tile click focuses its segment without a job, the chain continues from the first segment not ready, and "Stop after this segment" ends it there; the long take form shows a First frame field and a References list with a role per image; a long take from a first frame opens the Relay alone without a job (one vision call), with no video format to choose, and renders the first frame → the segment's end image as one FL2VA clip, a segment added after the end continues segment 1's clip (`continue_from`), and the project resumes under its pipeline; the cards follow the plan (empty cards added and removed, written ones kept, the chain waits for empty ones); a long take from two references (character, object) renders segment 1 as one `h3-r2v` on both at the format its card shows, a setting reference is the location of every segment, every segment with a sheet is one `h3-r2v` job with the sheets (the setting's sheet in the director's Relay), segment 1 with its start frame and the continuous ones with `continue_from` the previous clip and no transition frames, the take is one `video-stitch` job, a cut in the director's Relay or in a long take is one `h3-r2v` job on the sheets and the setting (sheet, or the previous segment's transition frame, extracted first when there is no setting sheet) with no start image, another transition frame chosen becomes its setting, and switching its start, a link or a transition frame submits nothing; the empty shared fields are folded and open once filled, a chain that ends with every segment ready assembles the sequence (a stopped one does not), the "Narrative video" goal card opens the long take with no Pipeline menu and resumes a saved storyboard project, there is no trailer card, a segment Gemma's split marks as a new shot opens with a cut (🎞, numbers out of range dropped), and splitting a long take that only holds its screenplay asks nothing; the two sheet buttons under References each submit one Krea 2 job and add the sheet with its role (character, setting), a character photo's "✨ Sheet" submits one Qwen Image 2.1 job on it and its sheet takes the photo's place, and writing the brief or adding a photo submits nothing; a screenplay file imported in the form opens with no start image on its segments, lengths and shared fields without a job or a Gemma call, and its chain is `h3-t2v` then `h3-r2v` clips continuing it on segment 1's last frame; a screenplay that names no subject makes the start picture the location; the Relay's import splits a file without Gemma | Node, Playwright and its Chromium |

Changing a prompt compiler or an instruction makes `parity-prompts.js` and `prompt-systems.js` fail; if the change is wanted,
update the reference in the same commit and say why.
