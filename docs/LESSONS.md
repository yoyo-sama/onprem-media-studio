# Lessons carried over from AI Content Studio 1.4

Every rule below was learned from a real failure in 1.4 (ComfyUI + Ollama era) and validated by a
GPU render. The numbers in brackets point to the original entry in `docs/LESSONS.md` of the
[1.4 repository](https://github.com/yoyo-sama/dellaicontent) for the full story. Rules that only
concerned ComfyUI graph plumbing were dropped; what remains is about the models, the prompts and
the product, which do not change when the runtime does.

French version: [fr/LESSONS.md](fr/LESSONS.md).

## 1. Verification

1. **A successful job proves nothing.** 1.4 shipped several pipelines that rendered noise or the
   wrong model with a `success` status (renamed weights, wrong encoder, an LLM wired as a text
   encoder). Every engine is validated by a reduced real render whose frames and audio are
   *looked at*. A catalog entry stays `"qualified": false` until that happened on the target
   hardware. [#14]
2. **Check the edges of the frame, the sky gradients and the saturation**, not only "is it the
   right scene": under-stepped distilled models keep the composition and break colour first
   (H3 turbo LoRA at 4 steps: clipped flats, cyan cast, rainbow band at the bottom of r2v). [#12]
3. **Inspect at least one frame on each side of the middle** of a first/last-frame clip, or a
   hard cut in the middle goes unseen. Judge transitions only at nominal duration. [#13]
4. **Before blaming a UI change, replay the same job through the old path** and compare errors:
   it separates packaging problems from code regressions. [#14]

## 2. Product rules (kept as is)

5. **Nothing renders without a click.** Adding a subject, editing a field, choosing an engine or a
   language submits no job. The backend creates a job only when a client posts one.
6. **The user's prompt is sent verbatim.** Once a prompt is shown and edited, that text goes to
   the model: never recompile over it, never silently restore the compiled version.
7. **Verbatim covers the user's words, not the graph invariants.** The reference-anchoring block
   of a keyframe is re-appended on every path, including a hand-typed prompt; without it the
   edit model collages the reference sheets. [#31]
8. **The brief belongs to the user.** Examples are placeholders, never values; an empty brief
   launches nothing.
9. **Never ask the LLM to describe a subject the brief does not contain:** it invents one, and its
   default is a human. A new subject slot starts empty. [#25]

## 3. Prompting the LLM (Gemma 4)

10. **Strip, then re-append.** Whatever must not change (anchoring blocks, sheet skeletons, the H3
    field structure) is removed before the text goes to the LLM and put back by code afterwards.
    An instruction not to touch it is not enough. [#21, #29]
11. **Tokens do not survive the LLM.** `<Subject N>` comes back damaged; replace it with a plain
    word (`SUBJECTREF1`) before the call, restore it after, repair only the LLM output, and
    reject an output that lost a token or invented one. [#26, #36]
12. **A placeholder must be explicitly allowed by the instruction that receives it**, or the model
    files it under "forbidden syntax" and drops it. [#35]
13. **An instruction that does not say "enrich" makes the model copy or shorten.** [#36]
14. **End-of-sentence details get lost** (camera moves after a `;`). Restore them by code from a
    closed table, not by a stronger instruction. [#37]
15. **One instruction per model, routed in one place, proven by what the model actually
    received** (fingerprint test), never by reading the routing code. [#34]
16. **JSON from Gemma may hold objects where strings are expected:** always normalise. The model
    also pads prompts ("ultra-detailed, 8k"): strip padding after the call. [Application]
17. **Probe vision capability on first use** instead of assuming it; a failed image description
    degrades to an empty string and never blocks a render. [Grammar H3]

## 4. Krea 2

18. **The negative prompt is never encoded.** Krea 2 runs at cfg 1 with a zeroed negative: every
    constraint must be phrased positively in the prompt. [#16]
19. **Its own enrichment instruction** (subject → style → light → optics → composition → colour →
    material → atmosphere, 40–100 words, no negative).

## 5. Qwen Image Edit (2509 and 2.1)

20. **No "storyboard / keyframe / panel" vocabulary** in an edit prompt: the model draws an
    annotated board. Say "one full-frame film still" positively. [#7]
21. **In 2509, image 1 drives the starting latent, image 2 is conditioning only.** The subject
    sheet must be image 1; the location goes in later slots. 2.1 has symmetric references. In
    2.0, diffusers sizes an edit from the *last* image by default: the engines compute the size
    from image 1 and pass it explicitly (IMAGE-ENGINES.md). [#10]
22. **Name the setting in words**, twice (role sentence and after the action): a reference image
    that only feeds conditioning is not enough at cfg 1. [#28]
23. **Strong camera angles are ignored** (overhead, worm's eye): the edit keeps the reference
    pose. Close-ups and wide shots work. [#8]
24. **Two subjects per shot at most**, whatever the engine: beyond that subjects duplicate or the
    setting is lost. With two subjects, name each by its kind and require a whole, visible
    instance. [#17, #32]
25. **The subject sheet template follows the subject's kind** (human vs other); a human template
    turns a lion into a costumed biped. [#17]

## 6. MiniMax H3 / FastH3

26. **Length follows the 17n+5 frame grid at 24 fps**, not the requested duration (1 s → 39
    frames, 1.625 s). Width and height round down to multiples of 32. Python-style modulo when
    porting the formula. [#11, #20]
27. **Structured prompt grammar is mandatory** (6 Ref2VA fields). `<Picture N>` is the physical
    input (1-indexed), `<Subject N>` the logical identity, bound once in `subject_definitions`;
    prose uses `<Subject N>` only. Hard cap 7,000 characters, trimmed inside
    `detailed_description` only. [#19]
28. **I2VA/FL2VA need a time-alignment sentence** whose end mark is the *rendered* duration. [#20]
29. **FL2VA and Ref2VA checkpoints are different models** and not interchangeable.
30. **FastH3 OmniRef (validated on GB10, 2026-10-28):** 8 steps, guidance 1, video shift 12,
    audio shift 3, VSA sparse attention required, two passes (≈0.3 MP then latent upscale to
    ≈0.9 MP and 3 refine steps at denoise 0.4), `ref_image_size = max`. Identity 0.838 at
    1280×736, 5 s, 260 s. No speed-up LoRA (already distilled). Style LoRAs are applied as an
    exact branch; merging a LoRA into a quantised checkpoint destroys most of it.
31. **A cut prompt is never camera motion alone:** anchor it with scene + subject + setting, or the
    video drifts to unrelated content. [#9]
32. **Frame-exact continuity between segments means re-using the last frame as is**; passing it
    through an image edit creates a visible cut. [#22]

## 7. Platform

33. **GB10 has unified memory:** "free VRAM" excludes reclaimable page cache. Measure available
    system memory instead when VRAM total ≈ RAM total.
34. **A container writing to a mounted repository runs with the owner's UID**, never root. [#33]
35. **Models are referenced only after checking they are on disk**; files get renamed or moved
    between versions. [#14]

## 8. Front end (for the port in step 4)

36. Interface text is translated (FR/EN/ES/DE, informal "you"); every string set by code goes
    through the translation function at write time and again on language change.
37. A guard on a possibly-null state must be chosen for the result it gives when the state is
    absent, not for its apparent symmetry. [#18]
38. Headless screenshots with a virtual time budget can freeze an earlier frame than the final
    DOM: confirm with a DOM dump. [#15]
