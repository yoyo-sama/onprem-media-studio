# Creative assistant

French version: [fr/ASSISTANT.md](fr/ASSISTANT.md).

A chat panel in the Studio (rail button "Assistant") that helps the user build their content.
Behind it, several **roles** (director, ad art director, casting…) each with its own instructions;
the server picks the role best placed to answer. A role answers in words and with **cards**: one
card per Studio pipeline it wants to run, with the prompt and the settings filled in. Nothing
renders before the user clicks Generate on a card.

## Model

One LLM for everything: **Gemma 4 26B-A4B** (mixture of experts, about 4B parameters active per
token), GGUF `ggml-org/gemma-4-26B-A4B-it-GGUF`, `Q4_0` (14.6 GB) plus its vision projector
(`mmproj` Q8_0, 0.8 GB), Apache-2.0. It serves the chat and the ✨ enrichments through the same
`llama-server` (one process, 32k context, one slot). `STUDIO_LLM_MODEL=gemma4-e4b` goes back to
Gemma 4 E4B (8 GB) on a smaller machine. Native tool calls go through `llama-server --jinja`
(Gemma 4's chat template).

When an H3 video engine has to load alone and memory is short, the server stops `llama-server`
first (`common.LOW_MEMORY`); it starts again on the next LLM request.

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
  `{app_name}`, `{language}` (the interface language: the role answers in it), `{engines}`
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
   aside and Gemma is told why in the next turn.
4. **Handoff**: the `handoff` tool passes the conversation to another role, which answers in the
   same turn (once per turn).

Conversations are JSON files in `STUDIO_DATA_DIR/chats/` (`GET/DELETE /api/chats/{id}`,
`GET /api/chats`).

## Cards

| Tool | Card | What Generate runs |
|---|---|---|
| `create_image` | Prompt, engine (Krea 2 / Qwen Image 2.1), ratio, variants, style | `krea2-t2i` or `qwen-image-2.1`, as the Text2Image form |
| `edit_image` | Instruction, input image, references, markets | `qwen-image-2.1` editing, one job per market, as Image2Image |
| `character_sheet`, `location_sheet` | Description, subject type, style | `krea2-t2i` 1920×1088 with the 1.4 sheet templates |
| `video_from_text` | Prompt, length, ratio | `h3-t2v` |
| `video_from_image` | Prompt, first image, optional last image, length | `h3-i2v` (I2VA or FL2VA) |
| `image_sequence` | Prompt, 2 to 6 key images, segment length | the multi-image sequence (H3 segments, then `video-concat`) |
| `join_videos` | Clips | `video-concat` |
| `campaign` | Brief, variants, length, style | the full campaign (posters, thumbnails, social image, teaser) |
| `storyboard`, `reference_video` | Brief and settings | **nothing**: "Open in the Studio" fills the form; the step-by-step review starts there, as always |
| `ask_choices` | A question with 2 to 4 buttons and "Other…" | nothing: the choice is sent as the user's answer |

- A card runs **only on the user's click**, through the same functions as the Studio form
  (`web/js/generate.js`): what a card submits is what the form would submit.
- The prompt and the settings of a card can be edited before Generate; ✨ Enrich rewrites the
  card's prompt with the engine's own Gemma instruction (`Prompts.briefEnrichSystem`), with Undo.
- "Open in the Studio" fills the form (pipeline, engine, settings, images, brief) and starts
  nothing; Undo puts the brief and the pipeline back.
- The browser reports what became of a card (`POST /api/chats/{id}/cards/{card}`: running with
  the settings it ran with, done with its files, error, cancelled, opened). The next turns see it:
  the results get ids **C3#1, C3#2…** (an H3 clip is followed by its last frame, C3#2), which
  later cards can use. A card that needs a result not rendered yet waits ("Waiting for C3#1").

## Not yet

- The Canvas has no assistant yet ([ROADMAP.md](ROADMAP.md)).
- Tool calling, speed and memory next to H3 are to be checked on the GB10 with the 26B model;
  the optional MTP draft file of the GGUF repository (faster decoding) is not used.
