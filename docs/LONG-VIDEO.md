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
