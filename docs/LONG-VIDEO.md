# Long video: a fresh start

Status: proposal (2026-11-19). Nothing here is implemented yet.

## Goal

The owner's goal for long videos, unchanged:

- videos of a minute or more, made of 10 s H3 segments;
- the referenced subjects stay the same from start to end (face, hair, haircut, build,
  anatomy, clothes), with or without a reference image, and so does the scene;
- as little interaction as possible: brief → length → one click; no review step, every check
  runs inside the chain;
- simple code: no stack of special cases.

## What was tried (GB10 promaxgb10-95c7, 2026-11-14 to 19)

Every figure below was measured on real renders (frames and sound inspected).

| Method | Joins | Identity over 50 s | Framing / motion | Cost for 50 s |
|---|---|---|---|---|
| **A. Plain chain**: Qwen shot from the sheet, then 5 × `h3-i2v` from the previous clip's last frame (PR #39, "relay50") | clean | the face drifts after 5 to 9 s (eyes lighter by 9 s): i2v never sees the sheet | natural, H3 decides | 50 min |
| **B. Ref2VA + start frame + sheets** (PR #41) | **7 clips in 11 dropped their start image** (1 to 2 frames on it, then a cut); deterministic per seed | held | recomposed when the place image frames differently | ~55 min |
| **C. Key images + FL2VA** (PR #43, 6 runs): Qwen draws each segment's final instant from the sheets, `h3-i2v` goes from key to key | 24 of 24 exact (2.9 to 4.4, a broken join reads above 25) | held: each key restarts from the sheet | **swings and cuts** whenever a key's framing differs from what the text asks | 61 to 67 min |

What C taught, in detail:

- Qwen draws the subject twice when the sheet's poses leak into the scene (2 runs in 3) or when
  it edits the previous key (1 edit in 2). Gemma's vision as a figure count catches it every time
  (36 of 36 on the bench), so a redraw fixes it.
- Qwen keeps the framing of the image given as the place reference. It ignored "medium shot",
  "waist-up", "framed from the waist up", "bottom edge of the frame at the waist" (0 of 8). Only
  a close shot named with "the camera close to her face" moved it (6 of 6). The same "medium"
  key came out full-body in one run and knee-up in the next.
- Every visible defect of C came from a mismatch between the key and the video text: a push-in
  written toward a key that came out full-body made H3 move in, then swing back or cut hard at
  9 s. Gemma judging the shot sizes from the images was worse than the plan (12 of 20 moves
  right, against 9 of 10).
- The outcome changed from run to run with the same code, because the split, the keys and the
  rewritten text are three chained guesses. Each fix moved the failure elsewhere.
- Audio: without music H3 renders a quiet ambience (−25 to −52 LUFS, very uneven); bringing
  every clip to −18 LUFS under a true-peak limiter works (−18.3 LUFS, −0.5 to −0.7 dBTP).
- Cost: H3 evicts Qwen, so every key reloads it (about 85 s each).

## Lessons for the new design

1. **A single start frame is not enough context.** An i2v clip continues from one image: it
   cannot see where the subject was going, nor the sheet, so motion jumps at joins (speed,
   direction) and identity drifts.
2. **Never let two pieces of guidance disagree.** C failed where an image and a text told H3
   different framings. The new design gives H3 one consistent source per decision.
3. **Fewer chained model guesses.** Every step that depends on Gemma or Qwen hitting a target
   (shot size, figure count, rewritten action) multiplies the failure rate over minutes.
4. **Identity needs the sheet in view all along**, not only at the start of a clip.
5. **What works stays**: exact joins are possible (FL2VA rows at frame 0), the figure count is
   reliable, the take loudness lift works, and the start-frame patch (`h3_start_frame.py`)
   proves we can place conditioning rows wherever we need in FastVideo's layout.

## Candidate methods

### 1. Latent continuation (recommended first)

The usual long-video method, and what the H3 community converged on in 2026: instead of one
decoded frame, the next clip receives **the last latent frames of the previous clip, video and
audio**, as its first frames, then those overlapping frames are cut from the output. H3 sees the
motion already under way, so speed, direction, camera move and sound carry across the join; no
VAE round trip, so no quality loss per link. Identity comes from the subjects' sheets given as
Ref2VA references to every clip.

Reported by community implementations (read for their mechanics only; their code is not
copied, several are GPL-3.0):

- tail of 5 latent frames anchored at frame 0 as a native H3 keyframe, trimmed after decoding;
  seam continuity 0.96, but in pure Ref2VA mode the framing drifts toward `<Picture 1>` after
  1 to 2 s when the picture frames differently ([mark9009/ComfyUI-H3-LongTake](https://github.com/mark9009/ComfyUI-H3-LongTake), MIT);
- 22 or 39 latent frames of video and audio as the frame-0 guide, prompts split by timestamp
  ([palealloy2999-prog/ComfyUI-MiniMax-H3-Long-Video](https://github.com/palealloy2999-prog/ComfyUI-MiniMax-H3-Long-Video), GPL-3.0);
- "motion context" from validated clips with per-clip references
  ([tritant/ComfyUI_MiniMax_H3_Extender](https://github.com/tritant/ComfyUI_MiniMax_H3_Extender), Apache-2.0);
- 22 context frames, a 2-frame tail bridge, 4-frame video crossfade, 15 ms audio crossfade,
  7 clips ≈ 61 s with no manual edit, on FL2VA, with the remark that H3 "often reaches the last
  frame early and freezes" ([comfyui-wiki, Infinite Continuation Suite](https://comfyui-wiki.com/en/news/2026-08-11-h3-infinite-continuation-suite)).

What it removes from our current Relay: key images, the Qwen reload per segment, the shot-size
plan, the motion rewrite, the join check. What stays: the split into timed actions (one text
per 10 s, no camera size target), the sheets, the figure count on the first shot image, the
take loudness.

Open questions to settle on the GB10 before any UI work:

- FastVideo exposes Ref2VA and FL2VA layouts; can our layout patch place N latent frames of
  video **and audio** at the target's first frames (the same mechanism as `h3_start_frame`,
  extended from one image row to a latent tail)?
- Which checkpoint: OmniRef held identity with the start-frame patch, V2 drew a second subject
  from a sheet (2026-11-16).
- How many frames: 5 versus 22 (motion carried versus freedom left to the new action).
- Does the sheet still pull the framing toward itself (the drift reported above)? If so, a
  framing-neutral sheet (the five-view sheet of PR #38) or a lower reference weight.

### 2. Plain chain, re-anchored face

Method A, which the owner liked, plus an identity fix: every segment (or every N) the
transition frame gets a small Qwen edit at the same framing that only restores the face and hair
from the sheet. Cheap and close to what exists, but it keeps the one-frame join (motion can jump)
and adds one Qwen guess per segment.

### 3. RefMods for identity

A RefMod is the sheet pre-encoded once by H3's VAE into a small latent adapter (~1 MB),
injected through the same reference-token path as Ref2VA images. Lighter than raw images and
reusable across clips; not more faithful by itself (their authors still put a LoRA first for
likeness). A complement to method 1 (lighter references per clip), not a long-video method on
its own. See [Luisacaotica/ComfyUI-MiniMaxH3Mod](https://github.com/Luisacaotica/ComfyUI-MiniMaxH3Mod),
[RefMods vs reference images](https://huggingface.co/datasets/malcolmrey/various/blob/main/h3-center/docs/MINIMAX_REFMODS_VS_REFERENCE_IMAGES.md).

### 4. Character LoRA (later, optional)

The strongest identity lever reported everywhere, but it needs a short training per character:
against the "one click" rule unless it runs inside the chain. Kept as a later option.

## Plan

Each step has a stop criterion set before it starts; a step that misses it is dropped, not
patched.

1. **Feasibility, scripted, no UI** (GB10, API calls only): two chained 10 s clips with a latent
   tail of 5 and of 22 frames, sheet as Ref2VA reference. Stop if the join is not exact (gap
   above 10) or if the second clip loses the motion of the first.
2. **Five clips, 50 s**, the relay50 screenplay and sheet: one subject throughout, the sheet's
   face at 0, 25 and 50 s, the same garden, no cut, no swing. Stop if identity or the scene
   drifts more than in method A.
3. **UI**: the long take becomes brief → length → one click on this pipeline; the old Relay
   code paths it replaces are removed in the same PR.
4. **Minutes**: a 2-minute take to measure drift over 12 clips and the time cost.

If step 1 fails, method 2 is tried with the same criteria; RefMods are tried inside whichever
method passes, to lighten the references.

## Integration (PR #44, 2026-11-20)

The swap the plan announced, with the video tail only (step 2b). The path stays brief → length
→ one click.

- **Server.** Every H3 clip (`h3-t2v`, `h3-i2v`, `h3-r2v` but its preview) keeps its final video
  latents next to its MP4: `<stem>.latents.safetensors`, DiT-normalised, float16, with the canvas
  size, the latent count and the clip it continues in its metadata (about 25 MB for 10 s).
  `h3-r2v` takes `continue_from`, the reference of the clip it continues, instead of `image`: the
  canvas is that clip's, the upscaler aims at its size, and FastVideo's latent preparation is
  wrapped (`studio/pipelines/h3_continue.py`) to add its last 7 video latents as a silent video
  reference whose rows take the time of the target's first 7 latent frames. No sound is carried
  over. `h3_start_frame.py` stays for the first segment of a long take (a start image with the
  sheets). A new GPU job, `video-stitch`, assembles a take: the clips each rendered with
  `continue_from` the clip before them in the list are put end to end as latents (each without
  its first 7) and decoded once by the OmniRef video VAE into a file-backed buffer, so a long
  take's frames go to the disk rather than to memory; any other clip is a cut, taken as its MP4.
  The sound is each clip's own, cut where its image is (22 frames into a continuing clip),
  brought to -18 LUFS, with a 25 ms fade at each join and a true-peak limiter at -2 dBFS
  (`montage.assemble`, the levelling of PR #43, its limit lowered by 1 dB because takes
  measured +0.2 then -0.9 dBTP after AAC).
- **Front end.** A continuous segment with the subjects' sheets sends `continue_from` (the
  previous segment's clip) and no start image; it extracts no transition frames for it, and its
  card offers none to choose. The join check (`joinGap`, "broken join") is gone. A continuous
  segment without sheets, or with an end image (FL2VA), still starts on the previous segment's
  transition frame (i2v); cuts are unchanged and extract the previous segment's frames only when
  they need one as their setting. The chain, and "Assemble", end with `video-stitch`.
- **Tests.** `tests/test_h3_continue.py`: the latent arithmetic, the metadata, the parameters of a
  continuing clip, the stitched take's sound in step with its image (real ffmpeg, the decoding
  replaced), and the latent-preparation patch on stand-in FastVideo modules. `tools/relay-ui.js`
  checks the job chain. A 50 s render through the UI on the GB10 qualifies it.

## Screenplay files, text start and the assistant (2026-11-20)

Three additions asked by the owner on 2026-11-20, all on the same path (brief → length → one
click), not yet rendered on the GB10.

- **Screenplay file.** A screenplay in the H3 layout the owner already used by hand for
  relay50 (`subject_definitions:`, `summary:`, `retention_analysis:`, `camera_direction:`,
  `lighting:`, `detailed_description:` holding `[Shot N]` lines and
  `Segment N (00:00.000–00:10.000) – Title` lines each followed by its action,
  `overall_soundscape:`, `non_diegetic_music:`) is read as written by `parseScreenplay`
  (`web/js/prompts.js`): no Gemma. One card per segment, its length from the timestamps
  (brought into 5 to 15 s; none given: the maximum per segment), the first segment of a later
  shot a cut, the shot's own line after the action of its first segment; camera_direction →
  Framing, lighting → Lighting, overall_soundscape → Soundscape, non_diegetic_music → Music
  (N/A, None: no music). Two shared fields were added for it: **Subjects**
  (`subject_definitions`) and **Identity to keep** (`retention_analysis`), written word for
  word after the lines the app writes from the references (with no reference, they are the
  whole field). Empty, every prompt is the one sent before. Timestamps and the field lines are
  optional: a file of `[Shot N]` lines alone gives one segment per shot. A file in plain prose
  is the screenplay Gemma splits, as before. The import is in the form (📄 Import a screenplay
  puts the file in the brief; auto enrichment never rewrites such a brief) and in the Relay (📄
  Import, or ✨ Split on a pasted one). The summary and the first shot's line describe the take
  for the shot image composed from a start sheet.
- **A described scene rather than a subject.** A screenplay in that layout that names no
  `<Subject N>` describes a scene: its start picture (or, with none, segment 1's last frame) is
  sent as the location reference (`<Subject 1> is the location as defined by <Picture 1>`), not
  as the main character. The owner's rule (2026-11-20): with no reference image, a start
  picture is the first frame, and the scene starts from it and respects it; with no picture at
  all, the video model creates the opening scene. So segment 1 of a described scene starts on
  its picture with H3 image to video (`h3-i2v`, the picture as `<Picture 1>` and as the
  location), and the segments after it continue it with the picture as their location
  reference. Ref2VA with a start frame, tried first, kept an empty garden for 2 frames, then
  cut to another framing with the woman the screenplay describes already in view. A sheet always
  holds a subject, and a plain prose screenplay keeps the start picture as the main character,
  as before.
- **No start image.** Segment 1 is H3 text to video (`h3-t2v`) with the same six-field block
  without reference (`buildRelayTextPrompt`: no `<Picture N>`, no task tag), at the format its
  card shows. H3 keeps its last frame and latents like any clip: the last frame becomes the
  long take's start picture for the segments after it, which continue it with `continue_from`
  as a long take from a photo does. Regenerating segment 1 replaces that frame.
- **The assistant.** Its `image_sequence` card rendered key-image pairs one by one and joined
  them with `video-concat`: it never used the long take. It is replaced by `long_take`
  (screenplay in the layout above, an optional first frame and references with their roles): "🎞 Open the long take" switches to the
  Studio and opens the Relay on its segments, rendering nothing; the chain starts there. The
  Canvas will get it later.

GB10 renders (promaxgb10-95c7, 2026-11-20):
- The owner's garden file with no image, 5 × 10 s: segment 1 from text 617 s, continuations
  441/300/305/310 s, stitch 245 s; 47 s at 1280×736, -18.4 LUFS. One woman with the same face,
  hair and outfit throughout, the five actions in order, no cut found (ffmpeg scene detection
  at 0.15).
- A described scene (a woman described in words, an empty garden from Krea 2 as start
  picture), 4 × 10 s, segment 1 started on the picture: 37.8 s, -18.1 LUFS, the garden and the
  woman held across the three joins, but a cut at 0.08 s (see above; the fountain also changed
  shape in segment 3). Segment 1 now starts on the picture in i2v instead.
- Segment 1 alone, starting on a first frame in i2v (10 s each, same text and seed for b, c, d):
  a) the empty garden: 647 s, frame 0 is the picture, no cut, the woman really enters from the
  left and the garden holds; b) no picture, H3 text to video (the take above): clean, stable
  face, little walking; c) a MOSS-Image frame (77 s) then i2v (693 s): frame kept, but the face
  aged within 2 s and the background changed; d) a Qwen Image 2.1 frame (108 s, 1344×768: Qwen
  needs multiples of 32) then i2v (470 s): the most natural frame and the steadiest face. One
  render per case: a trend, not a qualification. Kept: text to video when there is no picture
  (no extra step); a user who wants to see the opening first can make it with Qwen and start
  from it.
- Still to render: the same file with a start image.

## First frame and references (2026-11-20, evening)

The owner found the long take's image list confusing ("0 to 6 images": start image, end
images, with a guess whether the first was a sheet). The form now asks for each kind of image
in its own field, both optional:

- **First frame**, one image: the video starts on it exactly and keeps it (segment 1 is
  `h3-i2v` on it; with references, `h3-r2v` starting on it since 2026-11-22, see § First frame
  with references). A character sheet is not a first frame.
- **References**, up to 7 (as in reference to video, since H3 Ref2VA takes them directly; the
  cap of 3 came from the director's two subjects per shot image), each with its role:
  character, setting or object. Who or what must stay the same; never shown as a frame. With no
  first frame, segment 1 is `h3-r2v` made from them. A setting reference is the location of
  every segment. Each reference makes every segment's render a little longer.
- **Neither**: segment 1 is H3 text to video, as before.

End images left the form: each segment card takes its own (🎯 End image). The sheet-or-photo
guess and the Qwen shot composed from a sheet (LESSONS #51) are gone: the user says what each
image is. A described scene (a screenplay that names no `<Subject N>`) still makes the first
frame its location when no reference is given. The assistant's `long_take` card takes
`first_frame`, `references` and `kinds` the same way. Not rendered on the GB10 yet.

## One narrative video card: cuts and sheets (2026-11-20, night)

The owner found the "Narrative trailer" card (the storyboard) and the "Long video" card
redundant and chose to merge them along this plan:

1. One card, **"Narrative video (long take)"**, opens the long take. A screenplay written as
   prose that moves to another place, moment or shot gets a 🎞 cut there: Gemma's split
   (`H3_SCENARIO_SYSTEM`) now answers `"cuts"`, the 1-based numbers of the segments that start a
   new shot; `composeScenario` keeps whole numbers from 2 to the segment count and the Relay
   sets those segments to `cut` (one `h3-r2v` job on the sheets, as a cut always was). A
   screenplay file keeps its own layout, read without Gemma.
2. **Sheets in one click** under References: "✨ Subject sheet from the brief" (Gemma's
   character fields, then one Krea 2 job with the character sheet prompt), "✨ Setting sheet
   from the brief" (location fields, one Krea 2 job), and "✨ Sheet" on a character photo (a
   vision call for its fields, then one Qwen Image 2.1 job on the photo with the five-view
   prompt; the sheet replaces the photo). Each sheet joins the references with its role. No
   approval step: a sheet is redrawn by clicking again, or removed with ✕.
3. The per-shot still images and the animatic of the storyboard leave the card: the story is
   rendered directly as chained or cut segments.
4. A three-scene story with cuts rendered on the GB10, its frames inspected (below).
5. That render being good, the storyboard pipeline went (below, § Storyboard removed).

**GB10 render, 2026-11-21** (`tools/qualify/narrative_take.js` drives the real Studio with
Playwright: card, subject sheet from the brief, Generate, 40 s, split, chain). A French brief:
a woman leaves her building at dawn down a cobbled street, later reads a letter in a train,
in the evening walks barefoot on a beach at sunset, boots in hand. 28.7 min: sheet 148 s,
segments 451/336/334/321 s, stitch 91 s; 39.58 s at 1280×736, -17.8 LUFS. Gemma put the two
cuts where the scenes change (segments 2 and 3; segment 4 continuous). Identity held in all
four segments (face, hair, coat, boots, nobody else); both cuts are one-frame hard cuts; the
continuous join does not show. Three defects (LESSONS #53): each cut took the previous
segment's last frame as its location (the sea at the end of the street, the town in the train
window, a spire on the beach); the shared light and sound covered the whole day, so segment 1
walked to the sea; "barefoot" was lost in the split. Fixed: a cut the split marks as a new
scene (`scene`) takes the subjects' references only, extracts no transition frame and shows
"🎞 New scene"; the split's shared light and sound keep only what every scene shares, a new
shot names its own place, light and sounds, and a change of appearance is stated wherever it
holds. To render again with the same brief.

**Second render, PR #51, 2026-11-21** (same brief, 26.6 min, no transition-frame job). Gemma
marked the same two new scenes; "barefoot" held in segments 3 and 4 (failed before); the cuts
took the sheet only and no previous picture leaked; segment 1 stayed in the street. But Gemma's
shared light ("warm golden grade, morning and evening glows") and sounds (city, train, waves)
still spanned the three places despite the rule: the sea showed at the end of the street and on
the horizon from the train, rails along the street, catenary masts on the beach. Fixed in code
rather than by asking Gemma again: when the split finds new scenes, the shared Lighting and
Soundscape fields are not filled (each scene's segment names its own); what the user wrote
there stays. Still seen in both renders: the head out of frame for a few seconds around the
continuous join on the beach (the lateral track tilts down to the feet), seed-driven.

**Third render, 2026-11-21** (b61f593, 26.5 min, same brief). No place leaked any more: a
street of terraces at blue dawn with lit windows, green fields under grey daylight through the
train window, a beach in the sunset afterglow, nothing of one place in another; barefoot held,
both cuts clean, the continuous join invisible, identity held, -18.1 LUFS. With the shared
light and sound empty, Gemma named no sounds this time, so each segment got the generic
ambience line. Remaining defect: the head out of frame for about 11 s on the beach, asked by
Gemma's own segment 4 ("zooms in slowly on the bare feet"). The split now asks for a camera
motion that keeps the main subject's face in frame, a close shot of feet, hands or an object
only where the scenario asks for one (not rendered).

**Storyboard removed, 2026-11-21.** On the owner's go after the third render, the Studio's
storyboard pipeline is gone: shot list, shot images, cuts from shot images, animatic, the
subject tabs and the sheets handed over by the assistant. The director keeps reference to
video (sheets, approval, video) and the long take; a storyboard project saved before is not
offered for resuming. The assistant's storyboard card is gone too: the Director role takes a
story in several scenes to a `long_take` card, the conversation's sheets going in its
`references`. In a screenplay in the H3 layout (a file or the assistant's card), the first
segment of a later `[Shot N]` is now a new scene, as a split's is: from the references, with no
frame of the previous place (it was a cut that took the previous segment's last frame as its
setting when there was no setting sheet). The Canvas keeps its storyboard card.

## First frame with references (2026-11-22)

Control render C3 (PR #55, GB10 2026-11-21) started a café take on a Krea 2 first frame with a
subject sheet in the References: segment 1 was `h3-i2v` on the frame and never saw the sheet,
so the woman of the whole take was the frame's, not the sheet's (glasses, shirt, bag), the
continuations carrying her on. Segment 1 of a long take with a first frame and references is
now `h3-r2v` with `image` (the first frame) and the references the user gave for who or what
stays the same: characters and objects, never a setting (the frame is the place; a place image
framed otherwise wins over it, LESSONS #51), never the frame itself. With a setting reference
alone, with no reference, in a described scene or with an end image, segment 1 stays `h3-i2v`.

The start frame itself changed (`h3_start_frame.py`): one image row at the target's frame-0
time was let go of in 7 clips out of 11 (method B above). The picture is now held still for 22
frames as a silent clip whose rows take the time of the target's first 7 latent frames: the
layout of latent continuation (step 2b), which never let go of its tail. The clip starts on the
picture, holds it about 0.9 s, then moves.

A segment that sends fewer references than the split's legend (no setting in a take of several
scenes, none on a first frame) renumbers the `<Subject N>` it sends and writes a left-out one as
its description: the harbour and the cottage stayed cited with no picture.

GB10 control renders (promaxgb10-95c7, 2026-11-22, f3608f4, report
`control-tests/inspection-pr56.md` there):
- **C4**, the café take of C3 (an empty terrace as first frame, the woman's sheet as reference),
  30 s: segment 1 `h3-r2v` with the frame and the sheet only. Frame 0 is the terrace, held about
  0.92 s, no cut in the first 2 s; the woman matches her sheet (round tortoiseshell glasses,
  Breton top, beige trench, red bag) from her first appearance to the end, no morph at the
  joins. −18.0 LUFS, no dip at the joins. Segment 1 took 491 s with the H3 load (the hold adds
  about 60–70 s). Still wrong: a brightness pop where the hold ends (luma −11, same shot); H3 cut
  to another square 1.2 s into segment 3 (same parameters as C3, which held: not this change).
- **A6**, the fisherman from the assistant (Director → four sheets → long take card → split →
  chain), never rendered before with the PR #55 fixes: the card carried the four sheets with
  their roles, segment 1 was `h3-r2v` from the subject sheet, both scene changes were cuts,
  every segment got the subject sheet only. No place leak, no doubled fisherman, no cut inside a
  clip, the same man as his sheet in the three scenes, −18.0 LUFS; 1410 s in all, the fastest
  run. Still wrong: the prompts cited the dropped setting sheets (fixed above, not re-rendered);
  the sheet drew a fedora rather than the story's beanie, gone indoors with no gesture; he turns
  his back to the camera for about 4 s at the harbour; the boat differs between the harbour and
  the sea.

## Results

### Step 1, latent continuation (GB10, 2026-11-19)

How FastVideo lays out an H3 request: one packed sequence [text | condition rows | target
audio | target video] on one clock shared by video and audio. Ref2VA gives every reference a
clock slot before the target; condition rows are noised once at 0.999 and never stepped, so the
target is denoised against them as given. 243 frames are 72 video latents (a latent covers 1 or
4 frames in a 1, 4, 4, 4, 4 cycle); audio is 40 latents per second.

Test: clip 1 = today's `h3-i2v` from a shot image, its final latents kept. Clip 2 = `h3-r2v`
on OmniRef with the sheet, plus clip 1's last 7 video latents (22 frames) and 37 audio latents
(0.93 s) added as one more condition whose positions are rewritten to the target's first
latents (a forward patch on the latent preparation, like `h3_start_frame.py`); the overlap is
cut after decoding.

- Clip 2 continued clip 1: the same walk and tracking camera, no freeze, segment 2's text
  followed, one woman with the sheet's identity, the same garden, no click. Clip 2 took 304 s
  (two passes).
- Decoded separately, the join measured 15.2 (stop criterion: 10): H3's VAE is causal in time,
  and the same latents decode differently without the previous clip's history.
- Stitched in latent space (72 + 65 video latents, still on the latent grid; audio latents the
  same way) and decoded once (96.6 s for 464 frames, 57 GiB peak): the join measured 7.3
  (criterion: 7), with no spike anywhere, against frame-to-frame gaps of 2.8 median and 8.2 at
  most inside clip 1. Continuous to the eye; the slight step is likely the new segment's text
  landing at once (the expression changes).
- Clip 2's ambience is about 12 LU quieter: generated so, not a decoding seam; the take's
  loudness pass handles it.

### Step 2, a 47 s take (GB10, 2026-11-19)

Five clips of the relay50 screenplay: clip 1 `h3-i2v`, clips 2 to 5 `h3-r2v` on OmniRef with
the sheet and a 7-latent tail of the previous clip (video and audio), all latents stitched
(72 + 4 × 65 = 332, on the grid) and decoded once: 1127 frames, 46.96 s (five 10.1 s clips
minus four 0.92 s overlaps). About 35 min in all, against 50 min for relay50's 50 s.

- Joins: 7.3, 10.1, 6.3, 10.6 (stop criterion: 10), against a median of 3.1 and a maximum of
  9.6 inside the clips. The two larger ones fall where the new text starts a gesture (a turn,
  a raised hand). No cut, no ghost: one continuous shot to the eye.
- Identity: one woman throughout, the sheet's face, hair and outfit at 0, 25 and 47 s,
  closing close-up included. relay50 at the same times had changed the outfit and showed part
  of a second face at the edge of the frame.
- Scene: one garden, progressing with the texts (shrub path, lupin path, a cherry tree); it
  drifts no more than relay50's.
- Sound: it fades out clip after clip (−32, −43, −46, −58, −59 LUFS); each clip continues the
  previous one's audio tail, quieter. Untested remedy: carry the video tail only, let every
  clip's sound start fresh, smooth the audio joins at assembly.

### Step 2b, the video tail only (GB10, 2026-11-20)

The same take with clips 2 to 5 rendered again, the previous clip's 7 video latents as the only
tail (no audio rows), 33 min in all:

- Joins 7.7, 8.2, 7.3, 3.7, all under 10 and under the 99th percentile of the frame-to-frame
  gaps inside the clips (10.2). One woman, the sheet's identity to the closing close-up, the
  same garden.
- Each clip's sound starts fresh and follows the action (footsteps at a walking cadence while
  she walks, near silence when she stands, birdsong at the end), with no fade from clip to clip.
  But H3's Ref2VA ambience stays very quiet on 3 clips in 5 (−49, −53, −51 LUFS; stop
  criterion −45), as measured on 2026-11-16. Each clip's own sound brought to −18 LUFS at
  assembly (`smooth_audio`) gives an even take at −18.1 LUFS with no click; the lift raises the
  room noise of the quiet clips. One stitched audio decode stayed uneven and quieter.

### Step 3, the app itself (GB10, 2026-11-20)

PR #44 (ac35711) built on promaxgb10-95c7, the same take sent through the HTTP API as the Relay
sends it: segment 1 `h3-r2v` with its start image and the sheet (take50a's was i2v), segments 2
to 5 `continue_from` the clip before, then `video-stitch`. 31.4 min in all: about 290 to 320 s
per clip, 224 s for the stitch (1127 frames, 332 latents decoded once in 214 s). Each clip kept
12.7 MB of latents.

- No job error, links `[true, true, true, true]`, 1127 frames (243 + 4 × 221), 46.98 s.
- Joins 6.7, 13.2, 14.0, 11.4: three above the stop criterion of 10. This take moves more than
  take50a inside its clips too (frame-to-frame gaps: median 3.4, 99th percentile 11.2, max
  18.3, against 3.1, 10.2, 13.9), and the high joins fall where the picture moves fast after the
  join as well (5 to 11 on the next frames). To the eye every join is continuous: no cut, no
  ghost, no freeze, the gesture goes on.
- One woman in all 24 frames sampled every 2 s, the sheet's identity to the closing close-up;
  one garden progressing with the texts, no jump of place at a join.
- Sound −18.1 LUFS (clips −50 to −57 LUFS before levelling), no click at the joins, true peak
  −0.9 dBTP: 0.1 dB above the criterion. The limiter goes to −2 dBFS.
- Owner's verdict on the take (2026-11-20): "not perfect, but the result is satisfying". The
  absolute join criterion of 10 does not fit a take that moves this much; the joins were judged
  by eye.

## The chain runs on the server; video lengths (2026-11-24)

Two reports from the owner on promaxgb10-95c7 (main 756bc78):

- **A 5-segment long take rendered one segment.** Segment 1 (10 s, four references) ended without
  error, then nothing: the page that drove the chain sent its last request during that render
  (tab closed, computer asleep or tab frozen by the browser), so segment 2 was never submitted,
  and the resumed project did not even know segment 1. Now the click on "Generate the chain"
  queues the whole chain at once: each segment's job, then `video-stitch`. A file a segment takes
  from the one before it (its clip for `continue_from`, its last frame as a start image, a
  setting or, after a text start, the subject's reference) is written `{"job": "<id>",
  "output": ".mp4" | ".png"}`; the server writes the file in when the job's turn comes
  (ARCHITECTURE.md § Job lifecycle). A failed segment fails the rest of the chain (the page takes those
  jobs off the queue); "Stop after this segment" cancels the segments not started and the take
  (a chain stopped during its last segment is still assembled). The page only follows the jobs:
  each segment keeps its job id (`job`, and `stitchJob` for the take), and a resumed project
  follows them again, submitting nothing. Transition frames are still extracted when the page is
  open, for a later choice; the chain itself takes the last frame, the default choice. A
  transition frame is extracted only for a segment that starts on one (a cut with a setting of its
  own takes none).
- **30 s asked, 15 s rendered (Text2Video and Image2Video).** One H3 clip lasts 5 to 15 s
  (FastVideo): the form brought any length into that range without a word and sent 15 s. Same in
  Video from references, the campaign and every assistant card. A longer Text2Video, Image2Video
  or Video from references is now a long take: Generate opens it at the length asked (up to
  150 s), the brief split into segments by Gemma, and "Generate the chain" renders it. The long
  take form takes that length too (it opened every long take as one 10 s card holding the whole
  brief); a long take of one segment keeps the brief word for word. The campaign teaser stays a
  clip: over 15 s is refused, as is any length out of range.
- The alignment sentence of an Image2Video prompt came twice when the brief already opened on it
  (a prompt reused from the gallery): it is left out of the brief before it is written
  (`stripH3Alignment`), in the Studio and on the Canvas.

**GB10 render, 2026-11-25** (`tools/qualify/closed_page_take.js`, promaxgb10-95c7 on ebffb48): a
30 s Text2Video, the browser closed a few seconds after "Generate the chain", segment 1 running. The server
rendered the three segments and the take on its own (592 + 432 + 302 + 136 s), −17.9 LUFS, no
silence, no jump at the joins, the covered market kept. Three defects, fixed since:

- **28.5 s for 30 s, the page saying 30.4 s.** A segment that continues the clip before it in
  latent space redoes that clip's last 22 frames, and the take drops them: 243 + 221 + 221 frames.
  A card's length is now what the segment adds to the take: a latent link asks H3 for those 22
  frames on top, its new part on the nearest step of the 17-frame grid (a 10 s card: a 260-frame
  clip, 238 new frames, 9.9 s), within 15 s per clip. The plan, the card times and the board count
  the same: 30 s plans as 30.0 s.
- **The jacket changed at segment 3.** With no reference, the subject's look was only in the brief,
  and the split writes no appearance inside a segment: segment 1 went with "a woman, short red hair"
  and no outfit. With no subject reference, the split now also writes the subjects' look once
  (`"subjects"`, the shared Subjects field, copied from the scenario, nothing added), sent in every
  segment's subject_definitions.
- **Reopened, the page did not show the take.** "Resume the project" showed only under the long take
  tile, not under Text2Video where it was asked. It shows under both now, and a page opened while
  a saved chain still has jobs to follow goes back to that long take by itself and follows them
  (it submits nothing).

Rendered again on 928b7fc (same brief, page closed during segment 1): clips of 243 + 260 + 260
frames, take 29.96 s (719 frames), −18.1 LUFS, no silence; the same red-haired woman in the denim
jacket over the green sweater in every frame, the market kept, no jump at the joins; the reopened
page went back to the take by itself, with no job queued.

## Drifts of a 3-minute take (2026-11-26)

A 3-minute original anime (three 60 s long takes from screenplays, then `video-concat`, on
promaxgb10-95c7) kept the 2D style and the three characters, but showed drifts the brief never
asked for: a character drawn twice in a busy shot, a third hand left on the handlebar while the
rider waved, a small robot grown to a girl's height, hard cuts and a ghost dissolve inside links
marked continuous, and props (an egg, a scooter, an airship) whose design changed from shot to
shot. They come from the prompt, not from the seed: re-rendering with new seeds kept the double.
What changed, for every H3 video (LESSONS #60):

- **Coherence guards in every H3 prompt.** `capH3Prompt`, the one function every H3 prompt goes
  through (Text2Video, Image2Video, Video from references, every long take segment, the Canvas,
  the assistant's cards, the campaign teaser), closes `retention_analysis` with an anatomy and
  scale line (each character once in the frame, its own number of heads, arms, hands and legs, a
  hand that rises leaving its place, sizes relative to one another kept) and
  `detailed_description` with a one-shot sentence (none when a clip is the camera-movement
  reference); plain prose gets both at its end. Written once, given back exactly by
  `stripH3Guards`, never trimmed.
- **A reference sheet is described once.** Gemma's vision wrote "shown from four different
  angles", "against a pale off-white background": H3 drew the subject twice. The instruction now
  asks for the one subject, its size against an adult and every distinctive accessory, never
  its views, poses or background; `stripSheetLayout` removes what slips through.
- **A continuous join opens on the previous clip.** A segment that continues the previous clip
  in latent space opens its body on that join (`H3_CONTINUES`): same place, framing and light.
- **Props written once.** With subject references, the split now also writes the recurring
  objects, vehicles and animals with no reference in the shared Subjects field (with none, the
  subjects themselves, with their size), sent in every segment's `subject_definitions`. A
  screenplay is read as written: its `subject_definitions` must name them.

**Bench on the GB10** (`tools/qualify/anime_take/drift_bench.py`, same seed and same request,
only the prompt changed; cut = scdet score over 0.3):

| Case | Before | After |
|---|---|---|
| Sheet descriptions with layout words (3 sheets × 3 runs) | 8 of 9 | 0 of 9 |
| Egg hatch (job-28 → 36): Riko per frame, 9 frames | 2 Riko in 7 frames, a cut at 1.75 s | 1 Riko in all 9, no cut |
| Arrival at the mountain (job-9 → 37) | cuts at 1.0 s and 7.25 s | cut at 1.0 s only, one continuous push-in |
| The claw (job-13 → 38) | cut at 1.42 s | same |
| Jump to the ladder (job-16 → 39) | cut at 1.0 s | same |

The one-shot sentence removed the cut inside the clip; the cut right after the ~1 s of context
stayed: the segment's text started in another framing or place than the previous clip's end.
That is what the join sentence answers (not benched yet). The first description of the new
vision instruction dropped the Baron's monocle, and the monocle left the clip after 2.5 s: the
instruction now names distinctive accessories. The airship stayed a red and white flying boat:
the bench re-rendered screenplay segments that never defined it.
