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
    sheet must be image 1; the location goes in later slots. 2.1 has symmetric references. 2.0
    keeps only 2.1 (2509 dropped on 2026-10-29); diffusers sizes an edit from the *last* image
    by default, so the engine computes the size from image 1 (IMAGE-ENGINES.md). [#10]
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
    porting the formula. In 2.0, FastVideo also limits H3 to 5–15 s: a shorter cut is refused,
    not silently lengthened (H3.md). [#11, #20]
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
36. **Bound and keep FlashInfer's JIT builds.** The first NVFP4 H3 job compiles FlashInfer's
    `fp4_gemm_cutlass_sm120` at render time. With `MAX_JOBS` unset, about 22 nvcc processes ran in
    parallel (~130 GB), the GB10 ran out of memory and no clip came out. With `MAX_JOBS=4` the
    build takes 2 min 50 and leaves more than 91 GB available. The cache must live on the data
    volume (`FLASHINFER_WORKSPACE_BASE=/data/cache`); otherwise every new container compiles again.
    Both are set in the image. (GB10, 2026-10-30)
37. **No torch.compile on the H3 VAE in a long-lived server.** FastVideo's V2 recipe compiles the
    VAE tiles in `reduce-overhead` mode (CUDA graphs). CUDA graph state is per thread, and
    FastVideo runs each request in a new thread. So the second job on the same generator failed
    after 6 s (`assert torch._C._is_key_in_tls` in `cudagraph_trees.py`). With compilation off,
    three jobs in a row pass, and the first job no longer pays a 3.5 min compile. A unit test
    cannot catch this: only a second real job on the GPU shows it. (GB10, 2026-10-30)
38. **Size H3 image references as ComfyUI does, not as FastVideo does.** FastVideo upscales every
    image reference to a 2048 px short edge and keeps image references dense in its sparse
    attention: r2v with two 1920×1088 sheets took 680 s, 2.6 times ComfyUI. ComfyUI's
    `ref_image_size` "max" only ever downscales to that edge: about 247 s, with no visible loss.
    Sending smaller references does not help, since FastVideo scales them back up. (GB10,
    2026-10-30)
42. **Never let a weights file be memory-mapped on the GB10.** Mapped, Krea 2 loaded in 253 s;
    read whole, 82 s, although its disk reads 4.3 GB/s. Reading the folder into the page cache
    first changed nothing (236 s): the mapping costs, not the disk. diffusers' `disable_mmap`
    reaches only its own models, so `common.from_pretrained` loads the transformers text
    encoders itself with theirs, and FastVideo's weight iterator gets a whole-file reader
    (`h3_runtime.WholeFile`) in place of `safe_open`: FastH3 OmniRef then loads in 147 s instead
    of about 285 s. (GB10, 2026-11-05) Each loader that opens its own file needs the same care:
    the packed NVFP4 export of H3 has its own loader, still mapped, which read 11.9 GB in 68 s,
    almost half of an H3 load; it now gets a range reader (`h3_runtime.RangeFile`)
    for that call only. (GB10, 2026-11-08)
43. **No torchao FP8 on the GB10; torch.compile only where it pays back.** FP8 weights and dynamic
    activations (per-row scales) took 1 800 s per Krea 2 step instead of 5.7. `torch.compile` of
    the transformer, default mode, saved 22 % per step on Qwen Image 2.1 at 1920×1088 (16 s per
    image) for about 15 s of compilation on the first render at each size in a process: kept
    until Qwen went to 4 steps (#46), where it would save about 1 s per image.
    On Krea 2 it saved 12 % (6 s per image of 8 steps) for about 33 s per new size or image
    count: not kept. (GB10, 2026-11-05)
44. **NVIDIA's upscalers do not run on the GB10.** DLSS 5 needs a game engine's per-frame buffers
    and Windows (Streamline, D3D12/Vulkan); its ComfyUI bridges load Windows NGX DLLs, under Wine
    on Linux x86-64 at best; the RTX Video SDK is Windows only and `nvidia-vfx` has no ARM64 wheel.
    Upscaling is done by an open network run in PyTorch (SPAN through spandrel,
    [IMAGE-ENGINES.md](IMAGE-ENGINES.md#upscale-2)). (2026-11-06)
45. **`docker compose` run from a container must see the project at its host path.** Compose
    resolves `./data` against the project folder and hands the absolute path to the host's
    daemon: run from `/repo`, it would mount an empty `/repo/data` of the host and download every
    model again. The updater service links the host folder (its own
    `com.docker.compose.project.working_dir` label) to `/repo` and passes the project name and
    compose files from its labels; compose keeps the link as given. Its git runs as the owner of
    the repository, never as root (1.4 lesson). [GALLERY.md](GALLERY.md#docker-docker-compose)
    (2026-11-07)
46. **Qwen Image 2.1 runs a step-distilled transformer, 4 steps instead of 25.**
    lightx2v/Qwen-Image-2.1-Lightning-v2-RL replaces Qwen's own transformer (text encoder, VAE
    and processor unchanged): 2.9 to 3.6 times faster on the five Qwen qualification cases, three
    seeds each, with the identity of both sheet subjects kept in every shot image. Its 4 sigmas
    are already shifted: the base repository's scheduler (dynamic exponential shifting, terminal
    0.02) would shift them again, so a plain `FlowMatchEulerDiscreteScheduler(shift=1)` replaces
    it. The file is FP32 (28.5 GB), loaded in BF16 (14 GB) in 26 to 41 s. Costs: more contrast
    and saturation, stray structures in text to image (2 seeds out of 3); the drift of "keep the
    rest" on an edit asking for rocks the image lacks came from the prompt (the base drifted
    3/3 too). Qwen's official 8-step Turbo was only twice as fast, darker and duller.
    `tools/qualify/qwen_fast_bench.sh` (promaxgb10-95c7, 2026-11-07)
47. **State held across a slow call must not be written back whole.** Jobs live in memory and a
    page asks for the jobs it waited on after a restart: ids restarting at `job-1` could hand it
    another job, so they carry a per-start prefix (`job-<6 hex>-<n>`). An assistant turn keeps
    its conversation for the whole of Gemma's answer while the browser reports a card's render:
    written back whole, the turn put the card back to "running" without its outputs. Cards carry
    the time of their last change, the turn's save keeps the newer state from disk, and a card
    report is one locked load-change-write. (2026-11-08)
48. **Waiting for an empty queue is not enough before a restart.** The Docker updater looked at
    the queue every 10 s, then recreated the container: a click in between was accepted, then
    killed. It now holds the queue (new jobs refused with 503 and a message, renewed at each look,
    lapsing on its own) from the wait to the restart, and counts model downloads as work.
    (2026-11-08)
49. **Pin what was qualified, and measure memory before trusting a budget.** Only MOSS pinned
    its Hugging Face commit and most Python dependencies of the image were open ranges, while
    the in-app update rebuilds the image: a fresh install or a rebuild could run other weights
    or another transformers than the ones qualified. Every qualified model now pins the commit
    recorded in the `.complete` markers of promaxgb10-95c7, and `docker/constraints.txt` holds
    the exact versions of that image's `pip freeze`. Measured there the same day (121.6 GiB):
    a two-pass `h3-r2v` (5 s, two references) with Gemma loaded took MemAvailable from 95.4 to
    10.9 GiB and pushed 5.6 GB to swap without an OOM; `h3-t2v` kept 19.4 GiB. Gemma (17 GB) is
    now stopped before every r2v render. Also measured: H3 loads in 161 to 180 s; Krea 2 frees
    H3 to load (71 s); Upscale ×2 of a 124-frame clip takes 22 s, 80 % in the network (NVENC is
    present but encoding is not the bottleneck); llama-server b11982+ has no `--no-mmap` any
    more (`-lm`), and a quantised KV cache saved nothing at rest. (2026-11-08)
50. **A chained segment's prompt carries no default look.** 1.4's Relay built each segment as a
    pseudo-shot with a fixed camera and light, so every segment ended with a golden-hour
    sentence and "steady framing with subtle natural movement" whatever its text said, and each
    segment invented its own sounds. The look of a long take is now written once (framing,
    lighting, soundscape, music: by the user, or by Gemma where the field is empty) and added to
    every segment; an empty field adds nothing. A score still restarts at every join, since each
    segment renders its own audio, and the ambience of two segments rendered on their own came
    out 7 dB apart: assembling a Relay or a sequence now brings every segment to the median
    level (`smooth_audio`). A true crossfade is not possible without moving the sound against
    the image, since a clip has no sound past its end. The shared field is the framing only: a shared camera
    movement ("tracking that follows the subject") next to the segment's own ("slow push-in")
    made the second segment of the first GB10 render jump between framings. A segment's action
    must also stay within what its start frame shows: "stops beside a low stone wall", with no
    such wall in the frame, made H3 grow melting blobs and floating specks over the whole
    background; re-rendered from the same frame and seed with "slows to a stop on the gravel
    path", the garden held for 10 s. Gemma's split is told so. (2026-11-14)
51. **A long take renders its cards, and a reference sheet is never a first frame.** On the
    GB10 a "5 × 10 s" long take rendered three clips and stopped, with no error: the plan line
    was computed from the total length and the maximum per segment, but the chain renders the
    segment cards, and changing the total added none (the long take opened from one image had
    one card, two more were added by hand). The cards are now the plan: a new total or maximum
    adds the missing cards (empty, so the chain waits until they are written), removes the empty
    ones beyond it, never a written or rendered one, and the total is the sum of the cards; the
    plan line describes the cards. In the same run the start image was a character sheet (four
    full-body views and five close-ups): a long take starts on its first image as it is, so H3
    animated the whole sheet, its last frame showed three copies of the woman side by side, and
    the next segments started from there. Gemma's vision now says whether the start image is a
    sheet (`START_IMAGE_SYSTEM`, which also describes one single instance of the subject); a
    sheet gives a first segment that starts on a Qwen Image 2.1 shot image composed from it,
    in the sheet's style, at a format chosen on the card, and the card can switch between "the
    image as it is" and "a shot composed from the sheet" (it starts nothing). A long take only
    chains on the last frame, so a character who leaves the frame cannot come back as herself:
    the next segment starts on an empty frame and H3 has only the text to redraw her. A cut that
    recomposed a shot image then ran i2v did not hold the face either (it drifted during a
    push-in), and the Relay's cuts recomposed on the previous frame, carrying the drift across.
    On the GB10 the best cut was H3 Ref2VA on the character sheet plus an image of the place:
    the face stayed the sheet's for the whole clip and the light and garden matched the previous
    segment. Relay cuts are now Ref2VA on the subjects' sheets and the setting (its sheet, or
    the previous segment's transition frame). Continuous segments still see only their start
    frame, which is where the drift is born. Two follow-up renders closed the obvious fixes:
    Ref2VA given the drifted last frame "at 0.00 seconds" plus the sheet did not continue the
    shot (Ref2VA takes every image as a reference, never as the first frame: the shot was
    recomposed, mean gap 60 per channel against 6 for a true join), and the drifted frame won
    over the sheet (the purple hair stayed). So a cut's setting frame must show nobody: a
    subject's only image is its sheet. The same segment without the style LoRA kept the fuller
    bust than the sheet: that is H3's bias, not the LoRA's. (2026-11-15) The way out was to give
    a continuous segment its start frame AND the sheet: FastVideo refuses the mix, yet both
    pipelines condition with the same image rows and differ only by their time (FL2VA puts its
    image at the target's frame 0, Ref2VA gives each reference a slot before the target), and the
    two transformers have the same weights but their output head. Patched to put the start frame
    at frame 0 inside a Ref2VA layout, the OmniRef checkpoint joined the previous clip (gap 6 to
    9) and the character came back to her sheet over three chained segments, one woman and one
    outfit throughout, where the i2v chain had grown a second woman and changed her clothes. The
    V2 checkpoint, given the sheet the same way, drew a second woman: it never learned to read a
    sheet. An image of the place as a second reference held the garden but won over a close-up
    start frame (the shot jumped to the place image's framing), so a continuous segment takes the
    setting's sheet only. Ref2VA sound is 10 to 20 dB below i2v from its first pass on, whatever
    the start frame: the assembly lifts a quiet take. (2026-11-16) Through the UI, over five
    segments, OmniRef still let go of its start frame once in three continuous segments (first
    frame 60 away from the image, against 5 to 7 for a true join): the card measures the gap
    between the start image and the clip's first frame and says "broken join, regenerate"; nothing
    is rendered again on its own. (2026-11-16) The sheet-or-photo guess and the Qwen shot
    composed from a sheet were then removed: the long take's form asks for the first frame and
    the references in separate fields, each reference with its role, so the user says what an
    image is and a sheet goes to the references (docs/LONG-VIDEO.md § First frame and
    references). (2026-11-20)
52. **A long take continues its latents, it does not restart from an image.** Every way of
    starting a segment on an image broke somewhere: a start frame in Ref2VA let go of it 7 times
    in 11, key images planned by Qwen missed their shot size about once in 5 and a key image
    unlike its text made H3 swing or cut. Carrying the previous clip's last 7 video latents
    (22 frames) as condition rows at the time of the target's first frames, with the sheets as
    references, held motion, identity, scene and light; decoded apart, each clip restarted the
    causal VAE without history and the join jumped (gap 15.2), stitched as latents and decoded
    once it was 7.3, as inside a clip. Carrying the audio latents too faded the sound out clip
    after clip (-32 to -59 LUFS): only the video is carried, and each clip's own sound is
    levelled to -18 LUFS. Over 47 s the identity held better than the i2v chain, in less time
    (33 min against 50 min for 50 s). docs/LONG-VIDEO.md. (2026-11-20)
53. **A cut to a new scene carries nothing of the previous place, and the shared look holds only
    what every scene shares.** In a three-scene story (street, train, beach), a cut that took
    the previous segment's last frame as its location kept that place: the town showed in the
    train window, a church spire on the beach. A shared light "from dawn to golden hour" and a
    soundscape of city, train and waves made segment 1 walk to the sea by itself. A cut that
    Gemma's split marks as a new scene now takes the subjects' references only and names its
    own place, light and sounds; a manual cut keeps the previous frame (a new angle on the same
    place). The split also states every change of appearance the scenario makes (bare feet):
    left out, H3 kept the boots of the sheet. Asked to keep only what every scene shares, Gemma
    still wrote a light and sounds spanning all places: with new scenes, the code leaves those
    two shared fields empty instead. docs/LONG-VIDEO.md. (2026-11-21)
54. **References go to Ref2VA as they are; a review step is only worth what it catches.** The
    1.4 reference-to-video made the user write, generate and approve a subject sheet and a
    setting sheet before the video, then sent them as two fixed anchors plus 7 extra images.
    H3 OmniRef reads its references directly (Gemma's vision describes each one, since PR #11),
    and the assistant's card already rendered from them in one click. The Studio pipeline is now
    the same: one list with a role per item (9 images, 3 clips, 3 sounds), one job, and a sheet
    only when the user asks for one (one click, no approval). docs/FRONTEND.md. (2026-11-21)

55. **A structured layout in a tool argument is not reliable from Gemma; prose is.** Asked for a
    long take screenplay in the H3 field layout inside the `long_take` card's argument, Gemma
    26B-A4B ran the fields together, put the segments under `lighting:` and wrote no
    `detailed_description:`, and named the subjects by their reference ids (C2#1). The Studio
    could not read it, and the card carried no length, so the long take opened at 10 s, one
    segment, and nothing rendered (GB10 control test, 2026-11-21). The card now takes the story
    as prose, one paragraph per scene, and a `total` length; opening it splits the prose with the
    same Gemma call as "✨ Split the screenplay", which gave clean cuts on the narrative tests. The
    layout stays for files a user imports. (2026-11-21)

## 8. Front end (for the port in step 4)

39. Interface text is translated (FR/EN/ES/DE, informal "you"); every string set by code goes
    through the translation function at write time and again on language change.
40. A guard on a possibly-null state must be chosen for the result it gives when the state is
    absent, not for its apparent symmetry. [#18]
41. Headless screenshots with a virtual time budget can freeze an earlier frame than the final
    DOM: confirm with a DOM dump. [#15]
