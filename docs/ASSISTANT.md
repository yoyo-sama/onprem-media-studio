# Creative assistant

French version: [fr/ASSISTANT.md](fr/ASSISTANT.md).

The first mode of the page (rail: Assistant, then Studio, then Canvas): a chat in the main area
that helps the user build their content.
Behind it, several **roles** (director, ad art director, casting…) each with its own instructions;
the server picks the role best placed to answer. A role answers in words and with **cards**: one
card per Studio pipeline it wants to run, with the prompt and the settings filled in. Nothing
renders before the user clicks Generate on a card.

## The page

- **Modes**: Assistant and Studio are two modes of `index.html`; the address (`#assistant`,
  `#studio`) or the last mode used chooses it at load, the assistant by default. The Canvas
  offers the same three choices.
- **Conversations**: a page load opens on the welcome; earlier conversations stay in the list,
  and "＋ New conversation" goes back to the welcome at any time.
- **Library**: the "Library" button opens the job queue and the gallery beside the chat (over it
  on a phone). A gallery image used from the assistant ("→ Use as input", or dragged onto the
  chat) becomes an attachment of the next message; "Reuse the prompt" copies it into the message
  box, with Undo.
- **Character**: a small animated character (`web/js/mascot.js`) welcomes the user and shows what
  the assistant is doing: it listens while the user types, thinks until the reply starts, talks
  while it streams, jumps when cards arrive or a render ends, looks sad on an error. It wears the
  costume of the role answering: white cap (general assistant), beret (director), round glasses
  (casting), sunglasses (ad art director), headset (localisation), bow tie (campaign), headphones
  (transition editor); a role the user added keeps the cap. It is pure
  decoration (a click makes it jump) and stays still when the system asks for reduced motion.

## Model

One LLM for everything: **Gemma 4 26B-A4B** (mixture of experts, about 4B parameters active per
token), GGUF `ggml-org/gemma-4-26B-A4B-it-GGUF`, `Q4_0` (14.6 GB) plus its vision projector
(`mmproj` Q8_0, 0.8 GB), Apache-2.0. It serves the chat and the ✨ enrichments through the same
`llama-server` (one process, 32k context, one slot). Qualified on the GB10 on 2026-11-07; Gemma 4
E4B, the smaller model offered before, was dropped the same day. Native tool calls go through
`llama-server --jinja` (Gemma 4's chat template).

When an H3 video engine has to load alone and memory is short, the server stops `llama-server`
first (`common.LOW_MEMORY`); it starts again on the next LLM request.

Each Gemma call writes one line to the container log, with llama-server's timings, and so does
each model load: `docker logs studio --since 30m 2>&1 | grep "llm:"` tells a slow model from a
slow render (`llm: call 12.4 s (prompt 850 tokens in 1.1 s, 410 generated in 11.3 s)`). Each
engine load writes an `engine:` line too (duration, files read time, engines freed for it), and
each image or video render a `render:` line (encoding, steps, decoding; passes for H3): `grep -E "llm:|engine:|render:"`.

llama-server lets Gemma 4 think by default. For the prompt compilers (enrichment, sheets, shot
list, role routing) that meant thousands of hidden tokens per call: 44 to 81 s measured on the
GB10 for answers of a few hundred tokens. The chat turns did the same: 8 444 hidden tokens (150 s)
for a three-line answer, and once a loop that filled the whole context (29 220 tokens, 528 s)
without writing anything. The compile calls send `enable_thinking: false`. The chat keeps
thinking, which helps choosing the tools, within a budget of `CHAT_THINKING_BUDGET` tokens
(2 048, about 40 s, `studio/llm.py`). Past it, the studio stops that generation and asks for the
answer again without thinking (`llm: chat thought … asked again without thinking` in the log).
llama.cpp b11982 has no `--reasoning-budget` flag, so the budget is held by the studio. A whole chat answer,
thinking included, is capped at `CHAT_MAX_TOKENS` (2 048 + 4 096). An answer cut at the cap, or any other
failure of a turn, is kept in the conversation as an error under the role's name, so it shows
after a reload; such a message is not sent back to the model.

## Roles

A role is a Markdown file: a header between `---` lines, then its instructions.

```
---
id: director
name: Director
when: A story told in several shots: a script or scene to storyboard, a short film, a trailer…
tools: storyboard, reference_video, video_from_image, image_sequence
---
You are a storyboard artist and director of photography…
```

- `when` is what the router reads to pick the role; `tools` the generation tools the role may
  call (the two conversation tools are always there).
- The shipped roles live in `studio/assistant/roles/`: `assistant` (general), `director`,
  `casting` (casting and sets), `ad_director` (ad art director), `localisation`, `campaign`
  (product and fashion campaign), `transitions` (transition editor). They were written for this
  studio, inspired by the structure of production agents (questions with clickable choices, a
  spec before every render, handoffs), without copying any text. The instructions are in English (the model's
  language); the role answers in the interface language.
- `_common.md` is the block every role receives first: working rules (ask only what is
  missing, one question at a time through clickable choices, show before rendering, positive
  prompts in English, image ids from the reference table…). The code fills its placeholders:
  `{app_name}`, `{language}` (the interface language: the role answers in it, informally in French, Spanish and German, as the interface does), `{engines}`
  (one line per tool of the role), `{references}` (the image table), `{role_name}`, `{roles}`
  (the other roles, for handoffs).
- **Replacing a role**: Models panel, "Assistant roles" card; or a file
  `STUDIO_DATA_DIR/roles/<id>.md`. A file with a new id adds a role (24 at most). "Restore the
  original" removes the replacement. A broken replacement (bad header, unknown tool) falls back
  to the shipped role.

## A turn

`POST /api/chat` `{conversation?, text, attachments: [refs], role?, answer_to?, lang}` answers
with server-sent events:

| Event | Meaning |
|---|---|
| `conversation` | Id and title; the user's message as stored (attachments numbered A1, A2…) |
| `role` | The role answering (`changed: true` when it changes, `auto`, `goal` for a handoff) |
| `text` | A piece of the reply |
| `card` | A card (see below) |
| `error` | The LLM failed (not downloaded, not running…) |
| `done` | End of the turn |

1. **Routing**: unless the user pinned a role (`role`) or answers a question card (`answer_to`),
   a short JSON call (`{"role", "confidence"}`, temperature 0) picks the role. The current role
   keeps the conversation when the confidence is under 0.5.
2. **Reply**: the role's instructions (common block + role) and the conversation history go to
   Gemma with the role's tools; the reply streams. The images attached to the last message are
   sent to Gemma's vision (4 at most).
3. **Cards**: each tool call becomes a card; its arguments are checked (`assistant/tools.py`
   `normalize`): defaults filled, values out of range brought back with a warning shown on the
   card, unknown image ids flagged. A call that cannot become a card (missing prompt…) is set
   aside and Gemma is told why in the next turn. Gemma sometimes writes a call as JSON in its
   text instead of calling the tool (a fenced block such as `{"type": "video_from_image",
   "props": {…}}`): when the answer holds no card, such a block naming one of the role's tools
   becomes that card and leaves the text (`text_tool_calls`); the instructions also forbid it.
4. **Handoff**: the `handoff` tool passes the conversation to another role, which answers in the
   same turn (once per turn).

Conversations are JSON files in `STUDIO_DATA_DIR/chats/` (`GET/DELETE /api/chats/{id}`,
`GET /api/chats`).

## Cards

| Tool | Card | What Generate runs |
|---|---|---|
| `create_image` | Prompt, engine (Krea 2 / Qwen Image 2.1 / MOSS-Image), MOSS-Image mode (shown for that engine only), ratio, variants, style | `krea2-t2i`, `qwen-image-2.1` or `moss-image`, as the Text2Image form |
| `edit_image` | Instruction, input image, references, markets | `qwen-image-2.1` editing, one job per market, as Image2Image |
| `character_sheet`, `location_sheet` | Description, subject type, style; a photo of the subject (subject sheet only) | `krea2-t2i` 1920×1088 with the 1.4 sheet templates; with a photo, `qwen-image-2.1` edits it into the sheet at the same size, the template preceded by an identity sentence on `<image1>` (`charsheetFromPhotoPrompt`, not qualified yet). When Gemma leaves the photo out while the user's message carries one image, that image is the photo (with a warning on the card). The director's subject menu has the same action: "📷 Sheet from a photo" |
| `video_from_text` | Prompt, length, ratio | `h3-t2v` |
| `video_from_image` | Prompt, first image, optional last image, length | `h3-i2v` (I2VA or FL2VA) |
| `image_sequence` | Prompt, 2 to 6 key images, segment length | the multi-image sequence (H3 segments, then `video-concat`) |
| `join_videos` | Clips | `video-concat` |
| `campaign` | Brief, variants, length, style | the full campaign (posters, thumbnails, social image, teaser) |
| `storyboard` | Brief and settings | the director: "Launch the director" switches to the Studio, fills the form and starts the step-by-step review there, as the form's Generate does |
| `reference_video` | Brief, references each with its role, length, ratio: up to 9 images (character, setting, object), 3 clips (camera movement and pacing, or character, setting, object) and 3 sounds (voice of a character, music, ambience and sounds), 12 in all; music asked for in words (optional) | "🎞 Generate the video": one `h3-r2v` job from the card. Each reference gets its H3 label, numbers given by the app (`P.h3AssignRefs`): a subject is `<Subject N>` in its order; a clip kept for its camera movement stays `<Video N>`, a sound `<Audio N>`. The brief names references by their ids (`A1 rides…`), each replaced by its label; Gemma's vision describes each image for `subject_definitions`, and the six-field Ref2VA block is built by `buildH3RefPrompt`, as in the director: a voice is the timbre of the n-th character (`(S1)`…), music is reused as the score (`non_diegetic_music`), an ambience guides `overall_soundscape`, the card's music field goes to `non_diegetic_music` (else "None."), and the summary adds `audio reuse` or `audio reference` (MiniMax's full-reference guide). References can be removed, or added from the conversation's images and clips or the computer. Gemma proposes images and clips only; sounds come from the computer. "Launch the director" and "Open in the Studio" still open the step-by-step review, every reference keeping its role |
| `ask_choices` | A question with 2 to 4 buttons and "Other…" | nothing: the choice is sent as the user's answer |

- A card runs **only on the user's click**, through the same functions as the Studio form
  (`web/js/generate.js`): what a card submits is what the form would submit.
- While a card renders, it shows its progress: a bar (the mean of its jobs), the jobs done, the
  time since the click and the engine's last message (a model download, a step…). Its jobs are
  tagged with the card's id when submitted (`withJobTag` in `web/js/ui.js`).
- The prompt and the settings of a card can be edited before Generate; ✨ Enrich rewrites the
  card's prompt with the engine's own Gemma instruction (`Prompts.briefEnrichSystem`), with Undo.
- "Open in the Studio" switches to the Studio and fills the form (pipeline, engine, settings,
  images, brief), starting nothing; Undo puts the brief and the pipeline back.
- "Launch the director" (storyboard and reference-to-video cards) fills the form the same way,
  then its click is the Generate click: the director's first step starts and every next step
  waits for the user's approval, as always.
- A storyboard card carries the sheets the conversation already holds (`subject_sheets`, main
  subject first, and `setting_sheet`). The form lists them under "Sheets from the assistant" (✕
  drops one); the director keeps them as imported variants, has Gemma read each one (vision) to
  fill its fields, and draws only the missing sheets. With several subjects, every shot starts
  with the first two.
- The browser reports what became of a card (`POST /api/chats/{id}/cards/{card}`: running with
  the settings it ran with, done with its files, error, cancelled, opened, director launched). The next turns see it:
  the results get ids **C3#1, C3#2…** (an H3 clip is followed by its last frame, C3#2), which
  later cards can use. A card that needs a result not rendered yet waits ("Waiting for C3#1").

## Not yet

- The Canvas has no assistant yet ([ROADMAP.md](ROADMAP.md)).
- The optional MTP draft file of the GGUF repository (faster decoding) is not used.
