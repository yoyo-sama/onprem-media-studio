// Prompt compilers and Gemma instructions, shared by the Studio and the Canvas.
//
// Ported from AI Content Studio 1.4 (`js/engine.js` and the prompt code of its
// `index.html`). Every string these functions return, and every instruction and
// message sent to Gemma, is the 1.4 text to the character: tools/parity-prompts.js
// runs both versions side by side and fails on any difference. The instructions that
// 1.4 wrote in French stay in French: they are model input measured against Gemma's
// output (docs/LESSONS.md), not interface text, and rewording them would need new
// measurements.
//
// Pure functions only, no DOM and no network: what needs Gemma takes an `llm`
// function, `(system, user, images?) => Promise<object>` (parsed JSON), and an
// optional `log(level, text, params)` whose text is an English interface string
// translated by the page. Loaded by a <script> tag (window.Prompts) or by Node.
(function (global) {
  "use strict";

  const LLM_NAME = "Gemma 4";
  const say = (log, level, text, params) => { if (log) log(level, text, params || {}); };

  // ── Shot libraries ──────────────────────────────────────────────────────────

  const CAMERA_LIB = {
    extreme_close_up: { label: "Extreme close-up",
      frame: "an extreme close-up in which the character's face fills almost the entire frame, cropped tightly just below the chin, only the head visible, no shoulders and no body in frame",
      motion: "very slow subtle push-in on the face, almost still" },
    close_up: { label: "Close-up",
      frame: "a tight head-and-shoulders portrait framing, the character's head and the very tops of the shoulders filling most of the frame, everything below the upper chest cropped out",
      motion: "slow gentle push-in on the character" },
    medium: { label: "Medium shot",
      frame: "a medium shot of the character from the waist up",
      motion: "steady framing with subtle natural movement" },
    wide: { label: "Wide shot",
      frame: "a wide shot showing the character full-length within the surrounding environment",
      motion: "slow pull-back gradually revealing the surroundings" },
    extreme_wide: { label: "Extreme wide shot",
      frame: "an extreme wide establishing shot in which the character is a small distant figure in the vast landscape",
      motion: "very slow sweeping camera drift across the vast landscape" },
    pov: { label: "Point of view",
      frame: "a close over-the-shoulder point-of-view framing from just behind the character, looking out at the environment ahead",
      motion: "smooth first-person forward movement through the scene" },
    low_angle: { label: "Low angle",
      frame: "a low camera angle looking slightly up at the character, making them feel a little taller and more heroic",
      motion: "slow upward tilt, camera rising slightly" },
    high_angle: { label: "High angle",
      frame: "a high camera angle looking slightly down at the character from a little above",
      motion: "slow downward tilt, camera craning gently down" },
    tracking: { label: "Tracking shot",
      frame: "a tracking shot positioned beside the character as if following alongside them through the environment",
      motion: "smooth lateral tracking movement following the character" },
    handheld: { label: "Handheld",
      frame: "a handheld-style shot of the character with natural, slightly loose framing",
      motion: "loose handheld camera with subtle organic sway" },
  };
  const LIGHTING_LIB = {
    morning: { label: "Morning",
      text: "The whole scene is lit by soft cool early-morning daylight, gentle long shadows and a fresh clear atmosphere." },
    golden_hour: { label: "Golden hour",
      text: "The whole scene is bathed in warm golden-hour sunlight, long soft shadows and a glowing amber atmosphere." },
    overcast: { label: "Overcast",
      text: "The whole scene sits under flat soft overcast daylight, with muted diffuse shadows and cool desaturated grey tones." },
    moonlight: { label: "Moonlight",
      text: "The whole scene is lit only by cool blue moonlight, deep shadows and a low-key nocturnal mood under a dark night sky." },
    fire: { label: "Firelight",
      text: "The whole scene is lit by flickering warm firelight, a strong orange glow on the character and dancing shadows in the surrounding darkness." },
    interior: { label: "Interior",
      text: "The whole scene is lit by soft warm interior lighting from practical lamps, with a cosy sheltered indoor ambience." },
    studio: { label: "Studio",
      text: "The whole scene is lit by clean balanced studio lighting, soft key and fill light and an even neutral exposure." },
    night: { label: "Night",
      text: "The whole scene is set at night under cool artificial lighting, with pools of light, deep shadow and a dark sky." },
  };
  // 14 styles over the nine families of the Krea 2 taxonomy. Positive text only (Krea 2
  // never encodes a negative), always appended at the END of a prompt: subject before style.
  const STYLE_PACKS = {
    none: { label: "None", text: "" },
    editorial: { label: "Editorial",
      text: "Editorial photography, sophisticated composition, magazine aesthetic, controlled studio lighting, refined neutral palette." },
    analog35: { label: "35 mm film",
      text: "35mm film, analog grain, soft halation, warm natural light, gentle imperfect exposure." },
    documentary: { label: "Documentary",
      text: "Naturalistic documentary photography look, available light, realistic muted colors and candid unposed framing." },
    cinematic: { label: "Cinematic",
      text: "Shot on 35mm Kodak Vision3 film, cinematic color grading, soft natural film grain, natural contrast and shallow depth of field." },
    noir: { label: "Film noir",
      text: "High-contrast black-and-white film-noir look, deep shadows, hard directional light and dramatic chiaroscuro." },
    arthouse: { label: "Arthouse",
      text: "Arthouse cinema, restrained palette, symbolic composition, naturalistic soft light and quiet contemplative atmosphere." },
    scifi: { label: "Sci-fi blockbuster",
      text: "Cinematic science-fiction, ambitious production design, dramatic volumetric lighting, cool steel and neon palette." },
    quiet_luxury: { label: "Quiet luxury",
      text: "Quiet luxury, minimalist styling, neutral palette, soft directional light, premium understated materials." },
    product: { label: "Product packshot",
      text: "Premium product visualization, controlled studio environment, physically accurate materials, clean gradient backdrop, precise specular highlights." },
    anime: { label: "Anime",
      text: "Stylized Japanese anime illustration look, clean cel-shaded artwork, vivid saturated colors and expressive linework." },
    screenprint: { label: "Screen print",
      text: "Screen print, flat inks, bold graphic shapes, halftone texture, limited high-contrast palette." },
    oil: { label: "Oil painting",
      text: "Classical oil painting, controlled chiaroscuro, rich pigments, visible brushwork on canvas texture." },
    dreamlike: { label: "Dreamlike",
      text: "Dreamlike atmosphere, soft diffusion, ethereal light, hazy pastel palette and weightless depth." },
  };
  const styleTextFor = styleId => (STYLE_PACKS[styleId] || STYLE_PACKS.none).text;

  // Subjects of a shot: `[{desc, kind}]` (or a bare description string), in the order of
  // the image inputs. A subject without a description is dropped.
  const asSubjects = s => (Array.isArray(s) ? s : [s])
    .map(x => (typeof x === "string" ? { desc: x } : x)).filter(x => x && x.desc);

  // ── Sheet fields ────────────────────────────────────────────────────────────

  // Gemma sometimes answers an object where a string is expected: its values are joined.
  const fieldText = v => {
    if (typeof v === "string") return v.trim();
    if (v && typeof v === "object") return Object.values(v).map(fieldText).filter(Boolean).join(", ");
    return v == null ? "" : String(v);
  };
  // Two field sets (LESSONS: the sheet follows the subject): face, hair and outfit mean
  // nothing for a lion or a robot. `kind` lives in the field object but outside both lists,
  // so it is never compiled into a prompt; a sheet without `kind` is human.
  const CHAR_FIELD_KEYS = ["face", "hair", "outfit", "accessories", "palette"];
  const CHAR_OTHER_FIELD_KEYS = ["subject", "form", "surface", "details", "palette"];
  const charKindOf = f => (f?.kind && f.kind !== "human" ? "other" : "human");
  const charFieldKeys = f => (charKindOf(f) === "other" ? CHAR_OTHER_FIELD_KEYS : CHAR_FIELD_KEYS);
  const LOC_FIELD_KEYS = ["place", "architecture", "materials", "lighting", "palette"];

  // Gemma does not reliably obey a vocabulary ban, so filler words are removed afterwards.
  // Deliberately narrow: only words without visual direction ("photorealistic" and the
  // STYLE_PACKS wording must survive).
  const PROMPT_PADDING = new RegExp("\\s*\\b(?:" + [
    "masterpiece", "best quality", "highest quality", "high quality",
    "award[- ]winning", "ultra[- ]detailed", "hyper[- ]detailed", "highly detailed",
    "extremely detailed", "insanely detailed", "super detailed", "highly rendered",
    "trending on artstation", "artstation", "cgsociety", "deviantart", "pixiv",
    "octane render", "rendered in octane", "unreal engine(?: \\d)?", "v-?ray", "redshift render",
    "8k(?: uhd)?", "4k", "16k", "32k", "uhd",
  ].join("|") + ")\\b", "gi");
  function stripPromptPadding(text) {
    const out = text.replace(PROMPT_PADDING, "")
      .replace(/,(\s*,)+/g, ",")
      .replace(/([.!?])\s*,\s*/g, "$1 ")
      .replace(/,\s*([.!?])/g, "$1")
      .replace(/\s+([,.!?])/g, "$1")
      .replace(/([.!?])(?:\s*[.!?])+/g, "$1")   // a sentence removed entirely leaves ".."
      .replace(/\s{2,}/g, " ")
      .replace(/^[\s,]+/, "").replace(/[\s,]+$/, "").trim();
    return out || text;   // a prompt made only of filler is kept as it was
  }

  // Single point every caller goes through: the same filler filter as the enrichment,
  // since these strings end up in Krea 2 prompts.
  function charDescFromFields(f) {
    return stripPromptPadding(charFieldKeys(f).map(k => fieldText(f?.[k])).filter(Boolean).join(", "));
  }
  function locDescFromFields(f) {
    return stripPromptPadding(LOC_FIELD_KEYS.map(k => fieldText(f?.[k])).filter(Boolean).join(", "));
  }

  // ── Keyframes (Qwen Edit) ───────────────────────────────────────────────────

  // The part of a keyframe prompt that is not negotiable: one single film frame, and the
  // identity of every reference kept. Never given to Gemma, always re-appended
  // (LESSONS: strip, then re-append). SOLO for one subject, DUAL for two of any kind.
  const KEYFRAME_ANCHOR_DUAL =
    "Both subjects are fully integrated into the same scene, present together in that "
    + "location with correct perspective and scale. Each of them appears exactly once, as one "
    + "single complete and intact whole, assembled in one piece, never broken up, never taken "
    + "apart, never scattered as separate fragments. Do not place the references side by side, "
    + "do not create a split screen, diptych or collage, do not show any reference sheet, "
    + "contact sheet, grid, thumbnails, multiple poses, color swatches, panels, borders, "
    + "margins, black frame, caption or text anywhere. The whole picture is a single unified "
    + "live-action movie frame, one continuous scene that extends all the way to all four "
    + "edges. Keep each subject exactly as its own reference image shows it: same shape, "
    + "structure, proportions, surface, materials, markings and colors, and, for a living "
    + "character, the same anatomy, body plan, head and clothing.";
  const KEYFRAME_ANCHOR_SOLO =
    "The character is fully integrated into the scene, present in that location with correct "
    + "perspective and scale. Do not place the two references side by side, do not create a "
    + "split screen, diptych or collage, do not show any reference sheet, contact sheet, grid, "
    + "thumbnails, multiple poses, color swatches, panels, borders, margins, black frame, caption "
    + "or text anywhere. The whole picture is a single unified live-action movie frame, one "
    + "continuous scene that extends all the way to all four edges. Keep the character's anatomy, "
    + "body plan, head, surface, materials, markings, clothing if any and colors identical to the "
    + "first reference image.";

  // `subjects`: a description, or `[{desc, kind}]` (one or two subjects) in image order.
  // The setting is named twice, in the role sentence and after the framing: its image
  // only conditions the model, and at cfg 1 the prompt decides (LESSONS). With two
  // subjects each is named after its kind and the setting moves to the third image.
  // Everything is phrased positively: no negative prompt is ever encoded.
  function compileKeyframePrompt(shot, subjects, locDesc, styleId) {
    const list = asSubjects(subjects);
    const charDesc = list[0] ? list[0].desc : "";
    const loc = String(locDesc ?? "").trim();
    const locHere = loc ? " The location is " + loc + "." : "";
    const cam = CAMERA_LIB[shot.camera] || CAMERA_LIB.medium;
    const light = LIGHTING_LIB[shot.lighting] || LIGHTING_LIB.golden_hour;
    const styleText = styleTextFor(styleId);
    const emotion = (shot.emotion || "").trim();
    const extra = (shot.extra || "").trim();
    let s;
    if (list.length > 1) {
      const noun = sub => (charKindOf(sub) === "other" ? "subject" : "character");
      s = "Use the first reference image only as the appearance guide for one single " + noun(list[0]) + ", "
        + list[0].desc
        + ", use the second reference image only as the appearance guide for one single other "
        + noun(list[1]) + ", " + list[1].desc
        + ", and use the third reference image only as the guide for the environment"
        + (loc ? ", " + loc : "") + ". "
        + "The first two reference images are multi-view reference sheets, each one showing the "
        + "same single thing from several angles: read them only to learn what that one thing "
        + "looks like. "
        + "Create one brand-new photorealistic cinematic film still that places exactly one single "
        + "complete instance of each of those two subjects together inside the environment of the "
        + "third reference image, both of them whole and clearly visible in the frame: "
        + shot.action + ". Frame it as " + cam.frame + "." + locHere;
      if (emotion) s += " The subjects' expressions and body language convey " + emotion + ".";
      s += " " + light.text;
      s += " " + KEYFRAME_ANCHOR_DUAL;
    } else {
      s = "Use the first reference image only as the appearance guide for one single character, "
        + charDesc
        + ", and use the second reference image only as the guide for the environment"
        + (loc ? ", " + loc : "") + ". "
        + "Create one brand-new photorealistic cinematic film still that places exactly one single "
        + "instance of that character inside the environment of the second reference image: "
        + shot.action + ". Frame it as " + cam.frame + "." + locHere;
      if (emotion) s += " The character's expression and body language convey " + emotion + ".";
      s += " " + light.text;
      s += " " + KEYFRAME_ANCHOR_SOLO;
    }
    if (extra) s += " " + extra;
    if (styleText) s += " " + styleText;
    return s;
  }

  // Removes the anchoring blocks before a keyframe prompt goes to Gemma.
  function stripKeyframeAnchor(text) {
    return String(text || "")
      .split(KEYFRAME_ANCHOR_DUAL).join(" ")
      .split(KEYFRAME_ANCHOR_SOLO).join(" ")
      .replace(/\s{2,}/g, " ").trim();
  }
  // Re-appends the anchoring block when a prompt (typed by hand or rewritten) lost it: a
  // keyframe prompt without it makes Qwen Edit recompose the sheets as a collage
  // (LESSONS). The user's words are kept; the block is only added.
  function ensureKeyframeAnchor(text, dual, log) {
    const anchor = dual ? KEYFRAME_ANCHOR_DUAL : KEYFRAME_ANCHOR_SOLO;
    const t = String(text || "").trim();
    if (!t || t.includes(anchor)) return t;
    say(log, "sys", "Anchoring block added back to the keyframe prompt (it was missing).");
    return t + " " + anchor;
  }

  // Keyframe of a Relay segment that starts on a cut. The first segment uses the
  // storyboard anchoring (image 1 = subject sheet, image 2 = setting); later ones start
  // from the previous segment's last frame, and the prompt has to say so, or Qwen Edit
  // treats that frame as a reference sheet and recomposes a pose.
  function compileRelayKeyframePrompt(text, charDesc, locDesc, isFirst, styleId) {
    const styleText = styleTextFor(styleId);
    let s;
    if (isFirst) {
      s = "Use the first reference image only as the appearance guide for one single character, "
        + charDesc
        + ", and use the second reference image only as the guide for the environment"
        + (locDesc ? ", " + locDesc : "") + ". "
        + "Create one brand-new photorealistic cinematic film still that places exactly one single "
        + "instance of that character inside the environment of the second reference image: "
        + text + ".";
    } else {
      s = "The first reference image is the last film frame of the previous segment of one single "
        + "continuous shot. Continue that exact scene: keep the character's face, hair, clothing, "
        + "position and the environment strictly continuous with that first reference image. "
        + "The second reference image is the guide for the environment"
        + (locDesc ? ", " + locDesc : "") + ". "
        + "Create the next photorealistic cinematic film still of this same continuous shot, moments "
        + "later: " + text + ".";
    }
    s += " " + KEYFRAME_ANCHOR_SOLO;
    if (styleText) s += " " + styleText;
    return s;
  }

  // Camera motion of the pseudo-shot that holds on the last shot of a storyboard.
  const HOLD_MOTION = "Locked camera holding on the final shot, subtle ambient motion only.";

  // ── MiniMax H3 prompt grammar ───────────────────────────────────────────────
  // From the reference composer BMB12d3/minimax-h3-prompt-composer:
  //   <Picture N> = the N-th reference image as sent (1-based);
  //   <Subject N> = a logical identity, bound to a picture by one sentence of
  //   subject_definitions; the prose then only uses <Subject N>.
  // Model limit: 7,000 characters (capH3Prompt).
  const H3_PROMPT_CHARS = 7000;
  const h3Subject = n => `<Subject ${n}>`;
  const h3Picture = n => `<Picture ${n}>`;

  // <Subject N> tokens never go through Gemma: they become a bare word before the call and
  // are put back after (LESSONS: Gemma copied them damaged, "<Subject 1> 's"). A bare
  // word reads like a proper name and comes back intact.
  const H3_TOKEN_STUB = n => `SUBJECTREF${n}`;
  // Tolerant on both brackets: "<Subject 1>", ">Subject 1>", "< subject 1 >".
  const H3_TOKEN_RE = /[<>]\s*subject\s*(\d+)\s*[<>]/gi;
  const H3_STUB_RE = /\bSUBJECT\s*_?\s*REF\s*_?\s*(\d+)\b/gi;
  const h3TokensOut = text => String(text || "").replace(H3_TOKEN_RE, (_, n) => H3_TOKEN_STUB(n));
  const h3TokensIn = text => String(text || "").replace(H3_STUB_RE, (_, n) => h3Subject(n));

  // Last safety net, for Gemma's OUTPUT only, never for the user's text (sent verbatim):
  // repairs a damaged token and the copying slips around it.
  function h3NormalizeTokens(text) {
    return String(text || "")
      .replace(H3_TOKEN_RE, (_, n) => h3Subject(n))
      .replace(/(<Subject \d+>)\s+'/g, "$1'")
      .replace(/,\s*([.!?])/g, "$1")
      .replace(/\s+([,.!?])/g, "$1")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  // Definition and retention note per kind of subject. Two characters cannot both be
  // "the main character" (`leadMulti`).
  const H3_SUBJECT_KINDS = {
    character:   { lead: "is the main character in", leadMulti: "is a character in", note: "the complete defined identity, face, and body proportions are preserved." },
    environment: { lead: "is the location as defined by", note: "the environment's defined architecture, layout, and spatial continuity are retained." },
    reference:   { lead: "is an additional reference in", note: "the defined shape, proportions, materials, colors, and distinguishing features are retained." }
  };

  // Numbers are given by the app, never typed: the order of the references is the order
  // of the subjects. `list` = [{kind, desc}].
  function h3AssignSubjects(list) {
    return list.map((sub, i) => ({ ...sub, picture: i + 1, label: h3Subject(i + 1) }));
  }

  // One-line `summary`: the first sentence of the brief, bounded.
  function h3Summary(text) {
    const first = String(text || "").trim().split(/[.!?]/)[0].trim() || String(text || "").trim();
    return first.length > 200 ? `${first.slice(0, 197)}…` : first;
  }

  // Body of detailed_description: the character-in-setting sentence, then the brief.
  function h3RefBody(subjects, text) {
    const char = subjects.find(sub => sub.kind === "character");
    const env = subjects.find(sub => sub.kind === "environment");
    const anchor = char && env ? `${char.label} is in ${env.label}. ` : "";
    return anchor + String(text || "").trim();
  }

  // The six-field Ref2VA block. `subjects` comes from h3AssignSubjects.
  function buildH3RefPrompt({ subjects, summary, body }) {
    const multiChar = subjects.filter(sub => sub.kind === "character").length > 1;
    const defs = subjects.map(sub => {
      const kind = H3_SUBJECT_KINDS[sub.kind] || H3_SUBJECT_KINDS.reference;
      const desc = (sub.desc || "").trim().replace(/[.\s]+$/, "");
      const lead = (multiChar && kind.leadMulti) || kind.lead;
      return `${sub.label} ${lead} ${h3Picture(sub.picture)}${desc ? `, ${desc}` : ""}.`;
    }).join("\n");
    const ret = subjects.map(sub => {
      const kind = H3_SUBJECT_KINDS[sub.kind] || H3_SUBJECT_KINDS.reference;
      return `${sub.label}: fully_preserved - ${kind.note}`;
    }).join("\n");
    return [
      `subject_definitions:\n${defs || "—"}`,
      `summary:\n[reference generation] ${summary}`,
      `retention_analysis:\n${ret || "—"}`,
      `detailed_description:\n${body}`,
      // The last two fields belong to the grammar: H3 expects them.
      "overall_soundscape:\nNatural diegetic ambience consistent with the scene.",
      "non_diegetic_music:\nNone."
    ].join("\n\n");
  }

  // Hard model limit, trimmed openly (`onWarn(text, params)`, optional): the excess comes
  // out of the END of detailed_description, never out of the closing fields, and a
  // <Subject N> token cut in two goes with the cut. (The server refuses a longer prompt
  // instead of trimming it.)
  function capH3Prompt(text, onWarn) {
    if (text.length <= H3_PROMPT_CHARS) return text;
    if (onWarn) onWarn("H3 prompt of {length} characters, trimmed to {max} (model limit).",
      { length: text.length, max: H3_PROMPT_CHARS });
    const over = text.length - H3_PROMPT_CHARS;
    const key = "detailed_description:\n", i = text.indexOf(key), end = text.lastIndexOf("\n\noverall_soundscape:");
    if (i >= 0 && end - (i + key.length) > over) return text.slice(0, end - over).replace(/<[A-Za-z]* ?\d*$/, "") + text.slice(end);
    // Without the Ref2VA structure, or when the body is too short, a plain cut.
    return text.slice(0, H3_PROMPT_CHARS).replace(/<[A-Za-z]* ?\d*$/, "");
  }

  // Duration H3 really renders: 17n+5 frame grid at 24 fps, Python-style modulo
  // (studio/pipelines/h3.py frames_for).
  const h3VideoFrames = seconds => {
    const base = Math.max(5, Math.round(seconds * 24));
    return base + (((5 - (base % 17)) % 17) + 17) % 17;
  };
  const h3RealDuration = seconds => h3VideoFrames(seconds) / 24;

  // Time alignment sentence at the HEAD of an image-to-video prompt: first image only, or
  // first and last (FL2VA, whose end mark is the duration really rendered).
  function h3Alignment(hasLast, seconds) {
    if (!hasLast)
      return "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.";
    return "How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with "
      + `the 0.00-second mark of the target video; <Picture 2> (from [Shot 1]) aligns with the `
      + `${h3RealDuration(seconds).toFixed(2)}-second mark of the target video.`;
  }

  // A storyboard cut is image to video from a keyframe that already holds the subjects and
  // the setting, so every subject is defined on <Picture 1>.
  function h3CutSubjects(subjects, locDesc) {
    const list = asSubjects(subjects).map(sub => ({ kind: "character", desc: sub.desc }));
    if (locDesc) list.push({ kind: "environment", desc: locDesc });
    return list.map((sub, i) => ({ ...sub, picture: 1, label: h3Subject(i + 1) }));
  }

  // Narrative body of a cut: the shot without repeating the descriptions (already in
  // subject_definitions), every character placed in the setting.
  function h3CutBodyText(shot, subjects, holdMotion, styleId) {
    const cam = CAMERA_LIB[shot.camera] || CAMERA_LIB.medium;
    const light = LIGHTING_LIB[shot.lighting] || LIGHTING_LIB.golden_hour;
    const emotion = (shot.emotion || "").trim();
    const extra = (shot.extra || "").trim();
    const styleText = styleTextFor(styleId);
    const env = subjects.find(sub => sub.kind === "environment");
    const chars = subjects.filter(sub => sub.kind === "character");
    const lead = chars.length && env
      ? `${chars.map(sub => sub.label).join(" and ")} ${chars.length > 1 ? "are" : "is"} in ${env.label}. `
      : "";
    let s = lead + shot.action + (emotion ? ", conveying " + emotion : "") + ". " + light.text
      + " Camera motion: " + (holdMotion || cam.motion) + ".";
    if (extra) s += " " + extra;
    if (styleText) s += " " + styleText;
    return s;
  }

  // Full prompt of a cut: alignment sentence (the keyframe is time 0), then the six
  // fields. `bodyOverride`: a rewritten body, the structure stays. `hasLast`: an end
  // image is given (FL2VA).
  function buildH3CutPrompt(shot, subjects, locDesc, holdMotion, duration, bodyOverride, hasLast, styleId, onWarn) {
    const subs = h3CutSubjects(subjects, locDesc);
    const body = bodyOverride || h3CutBodyText(shot, subs, holdMotion, styleId);
    return capH3Prompt(`${h3Alignment(!!hasLast, duration)}\n\n` + buildH3RefPrompt({
      subjects: subs, summary: h3Summary(shot.action), body
    }), onWarn);
  }

  // The detailed_description of an H3 block: what a cut's re-enrichment rewrites before
  // the block is assembled again (the whole text when it is not a block).
  function h3CutBodyOf(text) {
    const m = /detailed_description:\n([\s\S]*?)(?:\n\n[a-z_]+:\n|$)/.exec(String(text || ""));
    return m ? m[1].trim() : String(text || "").trim();
  }

  // ── Camera clause guard (H3 text and image to video) ───────────────────────
  // Gemma drops the brief's camera move when it ends the sentence ("; slow push-in.",
  // "static camera"), whatever the instruction says (LESSONS). When the BRIEF holds a
  // camera move (French or English, accents and case ignored, not negated) that the
  // OUTPUT has in no equivalent form, "; <English clause>." is appended; otherwise the
  // output is returned unchanged. Closed table: [brief regex, output equivalents,
  // [[refinement read in the 40 characters of the brief, clause]...]].
  const CAMERA_KINDS = [
    [/plan fixe|camera fixe|cadre fixe|(static|fixed) (camera|shot)|locked[- ]off|(still|stationary) camera|camera (is |stays |remains |holds )?(static|fixed|locked|still)/,
      /static|locked[- ]off|fixed (camera|shot|frame)|(still|stationary|unmoving) camera|(camera|shot|frame)( \w+)? (is |stays |remains |holds |stay |remain |hold )?(fixed|still|locked|stationary|motionless)|tripod|(camera|shot|frame) (does not|doesn't) move/,
      [[null, "static camera"]]],
    [/push(es|ing)?[- ]?in\b|dolly(ing)?[- ]?(in|forward)|travelling avant|camera (s')?(avance|approche|rapproche)|(camera|shot) (\w+ )?(moves?|creeps?|drifts?|pushes) (slowly |gently )?(in|closer|forward|toward)/,
      /push(es|ing|ed)?[- ]?in|dolly(ing)?[- ]?(in|forward)|(camera|shot|frame|lens)\b[^.;]{0,40}\b(closer|forward|toward|towards|in on|inward|approach\w*|advanc\w*)/,
      [[null, "slow push-in"]]],
    [/pull(s|ing|ed)?[- ]?(back|out|away)|dolly(ing)?[- ]?(out|back)|push(es|ing)?[- ]?out|travelling arriere|camera (s')?(recule|eloigne)/,
      /pull(s|ing|ed)?[- ]?(back|out|away)|dolly(ing)?[- ]?(out|back)|push(es|ing)?[- ]?out|recede|retreat|(camera|shot|frame|lens)\b[^.;]{0,40}\b(back|away|farther|further|outward)/,
      [[null, "slow pull-out"]]],
    [/tracking|travell?ing(?! (avant|arriere))|follow(ing)? shot|camera (\w+ )?(tracks?|follows?|suit)\b|dolly (left|right|along|alongside|beside)/,
      /track|travell?ing|dolly|(camera|shot|frame)\b[^.;]{0,30}\b(follow|alongside|beside|along)|follow(ing)? shot/,
      [[/lateral|sideways/, "the camera tracks sideways"], [/left|gauche/, "the camera tracks left"], [/right|droite/, "the camera tracks right"], [null, "smooth tracking shot"]]],
    [/(camera|shot)[^.;,]{0,20}\bpan(s|ning|ned)?\b|\bpan(s|ning)? (left|right|up|down|across|slowly|gently)|\bpan (left|right|up|down)|\bpanning\b|whip pan|panoramique/,
      /(camera|shot|frame|lens)\b[^.;]{0,25}\bpan\w*|\bpan(s|ning)? (to the )?(left|right|up|down|across)|\bpanning\b|panoram/,
      [[/left|gauche/, "the camera pans left"], [/right|droite/, "the camera pans right"], [null, "a slow pan"]]],
    [/(camera|shot)[^.;,]{0,25}\btilt\w*|\btilt(s|ing)?[- ](the camera )?(up|down)|tilt[- ]shot|camera (s')?incline/,
      /(camera|shot|frame|lens)\b[^.;]{0,25}\btilt\w*|\btilt(s|ing)?( the camera)?[- ](up|down)|(up|down)ward tilt/,
      [[/down|bas|vers le sol/, "the camera tilts down"], [/up|haut/, "the camera tilts up"], [null, "a slow camera tilt"]]],
    [/\bzoom/, /zoom/, [[/zoom[- ]?(out|arriere)|dezoom/, "slow zoom out"], [null, "slow zoom in"]]],
    [/orbit|(camera|shot)[^.;,]{0,30}\b(around|round|autour)|arc shot|travelling circulaire/,
      /orbit|circl\w* (around|round)|arc\w* (around|round)|revolv|(camera|shot|frame|lens)\b[^.;]{0,30}\b(around|round)/,
      [[null, "the camera slowly orbits"]]],
    [/crane (shot|up|down)|craning|\bjib\b|\bgrue\b|camera[^.;,]{0,15}\b(rises?|lifts?|descends?|lowers?|monte|descend)/,
      /crane|craning|jib|boom|(camera|shot|frame|lens)\b[^.;]{0,30}\b(rise|rises|rising|lift|lifts|ascend\w*|descend\w*|lower\w*|up|down)\b/,
      [[/down|descend|lower|baisse/, "the camera cranes down"], [null, "the camera cranes up"]]],
    [/hand-?held|shaky|camera a l.epaule|a l.epaule|shoulder[- ]?(cam|mounted|held)/, /hand-?held|shoulder|shaky|camera shake/, [[null, "handheld camera"]]],
    [/close[- ]?up|gros plan/, /close[- ]?up|tight (shot|frame|framing)|closely framed/, [[null, "close-up shot"]]],
  ];
  const camNorm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[’‘]/g, "'").toLowerCase();
  function restoreCameraClause(brief, enriched) {
    if (typeof brief !== "string" || typeof enriched !== "string" || !enriched.trim()) return enriched;
    const b = camNorm(brief), o = camNorm(enriched), add = [];
    for (const [inBrief, inOut, clauses] of CAMERA_KINDS) {
      const m = inBrief.exec(b);
      if (!m || /\b(no|not|without|never|sans|pas|jamais|don't)\b[\w' ]*$/.test(b.slice(Math.max(0, m.index - 16), m.index)) || inOut.test(o)) continue;
      const near = b.slice(m.index, m.index + 40), text = clauses.find(([re]) => !re || re.test(near))[1];
      if (!add.includes(text)) add.push(text);
    }
    return add.length ? enriched.replace(/[\s.!?…,;:]*$/, "") + "; " + add.join(", ") + "." : enriched;
  }

  // ── Gemma output → valid shot ids ───────────────────────────────────────────
  const CAMERA_ALIASES = [
    [/(extreme|very)\s*(close|tight)|face[\s-]?fill|macro/, "extreme_close_up"],
    [/close[\s-]?up|closeup|head[\s-]?and[\s-]?shoulders|headshot|tight on/, "close_up"],
    [/medium|waist[\s-]?up|mid[\s-]?shot|cowboy/, "medium"],
    [/extreme[\s-]?wide|very[\s-]?wide|establishing|vista|panorama|aerial/, "extreme_wide"],
    [/wide|full[\s-]?length|full[\s-]?body|long[\s-]?shot/, "wide"],
    [/pov|point[\s-]?of[\s-]?view|first[\s-]?person|over[\s-]?the[\s-]?shoulder|ots/, "pov"],
    [/low[\s-]?angle|worm|from[\s-]?below|looking[\s-]?up|upward/, "low_angle"],
    [/high[\s-]?angle|bird|overhead|top[\s-]?down|from[\s-]?above|looking[\s-]?down/, "high_angle"],
    [/track|dolly|follow|steadicam|alongside/, "tracking"],
    [/handheld|hand[\s-]?held|shaky/, "handheld"],
  ];
  const LIGHTING_ALIASES = [
    [/golden|sunset|dusk|sundown/, "golden_hour"],
    [/morning|sunrise|dawn/, "morning"],
    [/overcast|cloud|grey|gray|diffuse|flat[\s-]?light/, "overcast"],
    [/moon|starlight/, "moonlight"],
    [/fire|flame|torch|campfire|ember|firelight/, "fire"],
    [/interior|indoor|lamp|room|candle/, "interior"],
    [/studio|softbox|key[\s-]?light/, "studio"],
    [/night|dark|nocturnal|neon|artificial/, "night"],
  ];
  function normalizeId(raw, lib, aliases, fallback) {
    const v = String(raw == null ? "" : raw).toLowerCase().trim().replace(/\s+/g, " ");
    if (lib[v]) return v;                          // exact id
    const flat = v.replace(/[\s-]+/g, "_");
    if (lib[flat]) return flat;                    // "close up" / "close-up" -> "close_up"
    for (const [re, id] of aliases) if (re.test(v)) return id;
    return fallback;                               // unknown -> medium / golden_hour
  }
  const normalizeCamera = raw => normalizeId(raw, CAMERA_LIB, CAMERA_ALIASES, "medium");
  const normalizeLighting = raw => normalizeId(raw, LIGHTING_LIB, LIGHTING_ALIASES, "golden_hour");

  // Fallback: a rotation of the presets that render reliably (no extreme close-up or
  // extreme wide, which the Qwen Edit anchoring renders badly).
  const FALLBACK_ROTATION = ["wide", "medium", "close_up", "low_angle", "tracking", "high_angle", "pov", "handheld"];
  function fallbackShots(n, action) {
    const out = [];
    for (let i = 0; i < n; i++) out.push({
      camera: FALLBACK_ROTATION[i % FALLBACK_ROTATION.length],
      lighting: "golden_hour",
      action: action || "the character moves through the scene",
      emotion: "",
    });
    return out;
  }
  // Gemma's shot list as valid ids, completed from the fallback when short or malformed.
  function normalizeShotList(rawShots, n, action) {
    const shots = (Array.isArray(rawShots) ? rawShots : [])
      .filter(s => s && typeof s === "object")
      .map(s => ({
        camera: normalizeCamera(s.camera),
        lighting: normalizeLighting(s.lighting),
        action: typeof s.action === "string" ? s.action : (action || ""),
        emotion: typeof s.emotion === "string" ? s.emotion : "",
      }));
    if (shots.length >= n) return shots.slice(0, n);
    const fb = fallbackShots(n, action);
    for (let i = shots.length; i < n; i++) shots.push(fb[i]);
    return shots;
  }

  // ── Reference sheets (Krea 2) ───────────────────────────────────────────────

  // Krea 2 never encodes a negative prompt: the sheet constraints are positive sentences.
  const SHEET_CLEAN = "One single seamless uncut photograph filling the whole frame edge to edge, completely free of any text, letters, numbers, captions, labels, annotations, watermark, signature or logo, with no drawn borders, no panel lines, no grid lines, no black frame and no comic panel divisions. Pure photography: real photographic capture, sharp focus, high detail, correct anatomy, clean seamless background.";

  // A template only describes the layout; the words that depend on the subject come from
  // sheetWords(kind), and the anti-anthropomorphic clause is added outside the template,
  // so every template works for a person, a lion or a robot. `turnaround` with a human
  // subject is the wording qualified in 1.4: do not touch it without a real render.
  const SUBJECT_GUARD = "The subject is photographed exactly as the thing it is: its anatomy, structure, proportions, number of limbs and parts, and its natural resting posture are strictly the ones described above and never those of a human being; it has no human face, and it wears nothing unless the description above says otherwise. ";

  const sheetWords = kind => kind === "other"
    ? { who: "subject", sheet: "reference sheet", design: "design",
        poses: "four views", stance: "natural posture",
        face: "the part that identifies it best: its head, or its front if it has no head",
        faceShort: "that same part", headshots: "photographs", expressions: "seen from different angles",
        details: "its surface, its materials and its distinctive details",
        flats: "its separable parts laid out flat", swatches: "the subject",
        identity: "shape, surface and markings" }
    : { who: "person", sheet: "character reference sheet", design: "character design",
        poses: "four standing poses", stance: "neutral relaxed stance",
        face: "the face", faceShort: "the face", headshots: "headshots",
        expressions: "showing different facial expressions: neutral, smiling, surprised, determined",
        details: "costume details", flats: "the garments laid out flat, seen from the front",
        swatches: "the outfit and hair", identity: "face, hair and costume" };

  const SHEET_HEAD = (d, w, guard) =>
    `A professional photorealistic ${w.sheet} of one single ${w.who}, composited as a clean multi-view layout on a smooth seamless light grey studio background: ${d}. ${guard}`;
  const SHEET_SWATCHES = w =>
    `Along the bottom edge, a horizontal strip of solid rectangular color swatches sampling the exact colors of ${w.swatches}. `;
  const SHEET_SAME = w =>
    `Every view shows the exact same single ${w.who} with identical ${w.identity}, consistent ${w.design}. `;

  const SHEET_TEMPLATES = {
    // Four-view turnaround + row of expressions + costume details (the original template).
    turnaround: { label: "Turnaround + expressions + costume", build: (d, w, guard) =>
      SHEET_HEAD(d, w, guard)
      + `Arranged neatly, the sheet shows a full-body turnaround of the same ${w.who} in ${w.poses} evenly spaced across a row - front view, three-quarter view, side profile view, and back view - all in a ${w.stance}, evenly studio-lit. `
      + `Above the turnaround, one large tight close-up portrait of ${w.face}. `
      + `A row of several smaller close-up ${w.headshots} of ${w.faceShort} ${w.expressions}. `
      + `A cluster of detailed close-up photographs of ${w.details}. `
      + SHEET_SWATCHES(w) + SHEET_SAME(w) },

    // Column of expressions on the left + three views + isolated accessories.
    expressions: { label: "Expression column + accessories", build: (d, w, guard) =>
      SHEET_HEAD(d, w, guard)
      + `Arranged neatly, the sheet shows down its entire left side a vertical column of five close-up ${w.headshots} of ${w.faceShort} ${w.expressions}, evenly stacked. `
      + `Filling the rest of the frame, three large full-body views of the same ${w.who} side by side - front view, side profile view, and back view - at the same scale on the same ground, all in a ${w.stance}, evenly studio-lit. `
      + `In the lower left corner, below the column, a cluster of isolated close-up photographs of ${w.details}, each one floating separately on the empty background. `
      + SHEET_SWATCHES(w) + SHEET_SAME(w) },

    // Large hero portrait on the left + row of heads + body views.
    portrait: { label: "Large portrait + row of heads", build: (d, w, guard) =>
      SHEET_HEAD(d, w, guard)
      + `Arranged neatly, the sheet shows one very large close-up portrait of ${w.face} filling the whole left third of the frame. `
      + `Across the top of the remaining space, a row of five smaller ${w.headshots} of ${w.faceShort} ${w.expressions}. `
      + `Below that row, three large full-body views of the same ${w.who} side by side - front view, side profile view, and back view - at the same scale on the same ground, all in a ${w.stance}, evenly studio-lit. `
      + SHEET_SWATCHES(w) + SHEET_SAME(w) },

    // Portrait + four-view turnaround + garments laid flat.
    wardrobe: { label: "Large portrait + flat garments", build: (d, w, guard) =>
      SHEET_HEAD(d, w, guard)
      + `Arranged neatly, the sheet shows one large close-up portrait of ${w.face} in its upper left corner. `
      + `Across the middle and lower part of the frame, a full-body turnaround of the same ${w.who} in ${w.poses} evenly spaced across a row - front view, three-quarter view, side profile view, and back view - at the same scale on the same ground, all in a ${w.stance}, evenly studio-lit. `
      + `Along the right edge, a narrow vertical column of separate product photographs showing ${w.flats}, each isolated on its own plain background. `
      + SHEET_SWATCHES(w) + SHEET_SAME(w) },

    // Neutral views + action poses + equipment.
    action: { label: "Action poses + equipment", build: (d, w, guard) =>
      SHEET_HEAD(d, w, guard)
      + `Arranged neatly, the sheet shows across its top a row of four full-body views of the same ${w.who} - front view, three-quarter view, side profile view, and back view - at the same scale on the same ground, all in a ${w.stance}. `
      + `Below them, a second row of three full-body action poses of the same ${w.who} caught in mid-movement, each one isolated on the background. `
      + `In the upper right corner, one large close-up portrait of ${w.face}, and beside it four smaller ${w.headshots} ${w.expressions}. `
      + `In the lower right corner, a cluster of isolated close-up photographs of ${w.details} laid out flat. `
      + SHEET_SWATCHES(w) + SHEET_SAME(w) }
  };

  // Subject sheet prompt from an already compiled description. `kind` ("human" | "other",
  // human by default) and `templateId` (unknown = turnaround) are optional.
  function charsheetPromptFrom(desc, kind, templateId, styleId) {
    const styleText = styleTextFor(styleId);
    const layout = SHEET_TEMPLATES[templateId] || SHEET_TEMPLATES.turnaround;
    return `${layout.build(desc, sheetWords(kind), kind === "other" ? SUBJECT_GUARD : "")}${SHEET_CLEAN}${styleText ? " " + styleText : ""}`;
  }

  // A subject sheet drawn by Qwen Image 2.1 from a photo (<image1>): the photo holds the
  // identity, the template the layout. Not part of 1.4.
  const SHEET_FROM_PHOTO = {
    human: "Using <image1> only as the identity reference: the person of <image1>, with exactly the same face, hair, build, skin tone and clothing, shown again from every angle for a studio reference sheet, in the same visual style as <image1>. ",
    other: "Using <image1> only as the identity reference: the subject of <image1>, with exactly the same shape, proportions, surface, colors and markings, shown again from every angle for a studio reference sheet, in the same visual style as <image1>. ",
  };
  const charsheetFromPhotoPrompt = (desc, kind, templateId, styleId) =>
    SHEET_FROM_PHOTO[kind === "other" ? "other" : "human"] + charsheetPromptFrom(desc, kind, templateId, styleId);

  function locsheetPromptFrom(locDesc, styleId) {
    const styleText = styleTextFor(styleId);
    return `A professional photorealistic environment reference sheet of one single location, composited as a clean multi-view layout on a smooth seamless dark neutral background: ${locDesc}. Arranged neatly, the sheet shows several wide establishing photographs of the same location from different angles across the top, below them a row of medium shots of key structures, and along the bottom a cluster of tight close-up material and detail studies. The location is completely empty and deserted, showing only architecture, materials and scenery. Consistent art direction, matching lighting and color palette across every view. ${SHEET_CLEAN}${styleText ? " " + styleText : ""}`;
  }

  // Sheets are rendered wide (layout proven in 1.4), whatever the ratio chosen elsewhere.
  const SHEET_SIZE = { width: 1920, height: 1088 };

  // Everything of a sheet prompt EXCEPT the description: the part Gemma never sees
  // (strip, then re-append). `target` = "char" | "loc"; `kind`, `templateId`, `styleId`
  // as for charsheetPromptFrom.
  const SHEET_DESC_SENTINEL = "\u0001SHEETDESC\u0001";
  function sheetSkeleton(target, kind, templateId, styleId) {
    const full = target === "char"
      ? charsheetPromptFrom(SHEET_DESC_SENTINEL, kind, templateId, styleId)
      : locsheetPromptFrom(SHEET_DESC_SENTINEL, styleId);
    const i = full.indexOf(SHEET_DESC_SENTINEL);
    return { head: full.slice(0, i), tail: full.slice(i + SHEET_DESC_SENTINEL.length) };
  }
  // Only the description. When the skeleton is not recognised (the prompt was rewritten
  // from scratch, or the style changed since), the WHOLE text is taken as the description:
  // the fallback always keeps the sheet layout.
  function stripSheetSkeleton(text, skeleton) {
    const { head, tail } = skeleton;
    let t = String(text || "").trim();
    const h = head.trimEnd(), tl = tail.trimEnd();
    if (h && t.startsWith(h)) t = t.slice(h.length);
    if (tl && t.endsWith(tl)) t = t.slice(0, -tl.length);
    return t.replace(/^[\s:.,]+/, "").replace(/[\s.]+$/, "").trim();
  }
  const wrapSheetDesc = (desc, skeleton) => skeleton.head + desc + skeleton.tail;

  // ── Campaign (Krea 2 images + H3 teaser) ────────────────────────────────────
  // No title is drawn: Krea 2 renders a legible title sometimes and gibberish other
  // times, so it keeps room for one instead (wording modelled on SHEET_CLEAN).
  const NO_LETTERING = "The picture itself is completely free of any text, letters, words, caption, watermark or logo.";
  const CAMPAIGN_IMAGES = [
    { name: "poster", width: 832, height: 1216, batch: true,
      suffix: `Vertical poster composition, the upper third kept as clean uncluttered background so a title can be overlaid afterwards. ${NO_LETTERING}` },
    { name: "thumbnail", width: 1280, height: 720, batch: true,
      suffix: `Horizontal thumbnail composition, one bold clearly readable subject on a clean background. ${NO_LETTERING}` },
    { name: "social", width: 1024, height: 1024, batch: false,
      suffix: `Square social media composition, centered subject with even margins. ${NO_LETTERING}` },
  ];
  const CAMPAIGN_TEASER = "Dynamic cinematic teaser, energetic camera movement.";
  // Subject, then format, then style.
  const campaignPrompt = (prompt, suffix, styleId) => {
    const styleText = styleTextFor(styleId);
    return `${prompt} ${suffix}${styleText ? " " + styleText : ""}`;
  };

  // ── Gemma instructions ──────────────────────────────────────────────────────
  // One instruction per model, never the generic one for a model that has its own
  // (briefEnrichSystem). Output keys: {"prompt"}, {"brief"}, {"instruction"}; only the
  // generic one asks for a negative prompt.

  const KREA2_ENRICH_SYSTEM = `You are a visual prompt architect for Krea 2, an aesthetic-focused image model.
Rewrite the user's brief into ONE English image prompt, built in this order and keeping only what carries visual information: subject, action, environment, style, lighting, camera and optics, composition, color, material and texture, atmosphere.
Rules:
- Name the main subject first and unambiguously; never let style wording replace or obscure it.
- Preserve the user's subject, action and intent exactly. Invent no detail the brief does not imply.
- Describe the visual result, not how to achieve it.
- Krea 2 never encodes a negative prompt, so express every constraint POSITIVELY: write "clean seamless background", never "no clutter"; write "both hands fully visible and correctly formed", never "no extra limbs".
- Keep one dominant style. Do not stack unrelated style keywords.
- 40 to 100 words. Every phrase must add visual information; delete filler.
- Never use "masterpiece", "best quality", "8k", "ultra detailed", "award winning", "stunning" or "beautiful lighting" — they carry no visual direction.
- A PRIMARY_STYLE line may follow the brief. Build the description so it fits that style, but do NOT restate the style wording itself: it is appended separately.
Before answering, re-read your prompt and delete any banned word that slipped in.
Answer ONLY with JSON: {"prompt": "..."}`;

  // H3 text and image to video: takes the whole brief and inserts two short additions
  // (motion, light), keeping the subject and the camera move, one continuous shot.
  const H3_VIDEO_ENRICH_SYSTEM = "Tu es un ingénieur de prompts pour Minimax H3, un modèle de diffusion texte→vidéo et image→vidéo qui rend UN SEUL plan continu de quelques secondes. ENRICHIS la description de l'utilisateur : reprends-la entière (traduite en anglais si besoin) avec son sujet, son action, son décor, son cadrage et son mouvement de caméra, et insère-y DEUX courts compléments de 3 à 8 mots chacun : l'un sur le mouvement (geste ou rythme du sujet, ou mouvement de caméra lent et continu si le brief n'en indique aucun), l'autre sur la lumière ou l'atmosphère. Le résultat tient en 1 à 3 phrases complètes en anglais qui commencent par le sujet, sans liste de mots-clés, et ne dépasse jamais quatre fois la longueur de la description. Exemples : « The boy waves goodbye. » → {\"prompt\": \"The boy waves goodbye with a slow sweep of his arm, in warm evening light.\"} ; « A man reads a letter at his desk, then folds it and stands up; slow push-in. » → {\"prompt\": \"A man reads a letter at his desk, his eyes moving slowly down the page, then folds it and stands up; slow push-in, pale morning light across the desk.\"}. Règles : (1) Le sujet du brief reste le sujet de ta phrase, avec le même nom ou le même pronom (« elle » → she, « il » → he, « ils/elles » → they) ; ne le remplace jamais par une partie du corps (« a head », « a hand »), par « a person » ou « the subject », ne le précise pas (pas de race, d'âge ou de modèle ajouté) et ne le supprime pas. (2) Un seul plan continu : pas de « cut to », pas de nouveau plan, pas de changement de cadrage ni d'échelle, pas de gros plan ni de zoom que le brief ne demande pas. (3) Le mouvement de caméra et le cadrage du brief sont repris avec le même mot (« caméra à l'épaule » → handheld, « plan fixe » → static shot, « gros plan » → close-up, « pan left », « push-in »…), même direction, même vitesse. (4) Si le brief désigne le sujet par un pronom ou par « the … », une image fournit déjà son apparence : ne décris ni ses vêtements, ni ses cheveux, ni son âge. (5) N'invente aucun personnage, aucun lieu ni aucun objet que le brief n'implique pas. Ce moteur n'utilise aucun prompt négatif : n'en génère pas. Réponds UNIQUEMENT en JSON : {\"prompt\": \"...\"}.";
  // H3 reference to video: SUBJECTREFn stand-ins are named and allowed explicitly
  // (forbidding "reference syntax" made Gemma delete them).
  const R2V_BRIEF_ENRICH_SYSTEM = "Tu es un ingénieur de prompts pour Minimax H3 reference2video. Le personnage et le décor sont DÉJÀ décrits séparément et ajoutés automatiquement avant ton texte — ne les redécris pas (ni apparence, ni vêtements, ni description du lieu). ENRICHIS le brief de l'utilisateur : reprends-le entier (traduit en anglais si besoin) avec son action et son mouvement de caméra, et insère-y DEUX ou TROIS courts compléments de 3 à 8 mots chacun : gestes ou rythme du mouvement, mouvement de caméra lent et continu si le brief n'en indique aucun, lumière ou atmosphère. Le résultat tient en 1 à 3 phrases complètes en anglais, sans liste de mots-clés, sans nouveau personnage, lieu ou objet. Un mot en majuscules de la forme SUBJECTREF suivi d'un chiffre désigne un personnage ou un lieu du brief : recopie chacun EXACTEMENT, tel quel (même casse, sans espace), à sa place ; ne le traduis pas, ne le remplace jamais par « the subject », « he », « she » ou un nom, n'en supprime aucun. N'en ajoute JAMAIS un qui n'est pas déjà dans le brief : un brief sans SUBJECTREF donne une réponse sans SUBJECTREF, où le sujet reste désigné comme dans le brief (« she », « a man »…) ou reste implicite. Exemples : « walks to the door » → {\"brief\": \"walks slowly to the door, footsteps echoing, in dim evening light\"} ; « SUBJECTREF1 waves at SUBJECTREF2. » → {\"brief\": \"SUBJECTREF1 waves at SUBJECTREF2 with a slow, wide sweep of the arm, the camera gently drifting closer in warm afternoon light.\"}. N'utilise pas de balises entre chevrons. Ce moteur n'utilise aucun prompt négatif : n'en génère pas. Réponds UNIQUEMENT en JSON : {\"brief\": \"...\"}.";
  const QWEN_EDIT_INSTRUCTION_ENRICH_SYSTEM = "Tu es un ingénieur de prompts pour un modèle d'édition d'image (Qwen-Edit). Réécris l'instruction de l'utilisateur en une consigne d'édition claire et positive en anglais (décris le résultat voulu, jamais ce qu'il faut éviter). N'utilise JAMAIS les mots \"storyboard\", \"keyframe\", \"panel\" ou équivalents — ils font dessiner une planche annotée au lieu d'éditer l'image. Réponds UNIQUEMENT en JSON : {\"instruction\": \"...\"}.";
  // A storyboard brief is a scenario in prose, read again by the sheet and shot-list steps.
  const SHEET_BRIEF_ENRICH_SYSTEM = "Tu enrichis un brief créatif en prose, en anglais, avec plus de détails descriptifs concrets (apparence, ambiance, contexte), SANS structurer en JSON ni en liste, SANS inventer de contrainte technique — ce texte sera ensuite analysé par un autre système pour en extraire des champs structurés, garde donc un texte narratif simple. Réponds UNIQUEMENT en JSON : {\"brief\": \"...\"}.";
  // The generic instruction (engines that do encode a negative prompt).
  const ENRICH_SYSTEM = `You are a prompt engineer for diffusion image and video models.
Rewrite the user's creative brief into a single rich English diffusion prompt (subject, style, lighting, composition, mood) and a matching negative prompt.
Answer ONLY with JSON: {"positive_prompt": "...", "negative_prompt": "..."}`;

  // Keyframes: say what to change and what to keep, explicit image roles, no "storyboard"
  // vocabulary. `nSubjects` > 1 asks for the three role sentences; `model` names the
  // keyframe engine of the active workflow (keyframeModelName).
  const QWEN_EDIT_ENRICH_SYSTEM = (nSubjects, model = "Qwen-Image-Edit-2509") => `You are an image-edit instruction architect for ${model}, an editing model that composes one new cinematic film still out of reference images.
Rewrite the user's instruction into ONE precise English edit instruction.
Rules:
- ${model} must be told WHAT TO CHANGE and WHAT TO PRESERVE. Never turn a local edit into a global restyle.
- Every sentence that assigns a role to a reference image ("the first reference image ...", "the second reference image ...", "the third reference image ...") carries the identity anchoring: keep those sentences and their meaning intact.
- Keep the user's subject, action and intent exactly. Invent no character, object or detail the instruction does not imply.
- Identity comes from the reference images: face, body plan, surface, materials, markings, clothing and colors are preserved, never reimagined.
- The model runs at cfg 1 and never encodes a negative prompt, so express every constraint POSITIVELY: write "both hands fully visible and correctly formed", never "no extra limbs".
- Never describe the OUTPUT as a storyboard, keyframe, reference sheet, model sheet, contact sheet, panel or caption: those words make the model draw an annotated board instead of a film still.
- Enrich only the moment itself: action, expression, framing, lighting, materials, texture, atmosphere.
- Under 120 words. Every phrase must add visual information; delete filler.
- Never write "masterpiece", "best quality", "8k", "ultra detailed" or "award winning".
${nSubjects > 1
  ? `- This shot has TWO characters. The instruction assigns the FIRST reference image to one character, the SECOND reference image to the other character, and the THIRD reference image to the environment: keep all THREE of those role sentences, each with its own image number, and keep both characters acting together in the same scene.`
  : `- This shot has ONE character. The instruction assigns the FIRST reference image to that character and the SECOND reference image to the environment: keep both of those role sentences, each with its own image number.`}
Answer ONLY with JSON: {"prompt": "..."}`;
  const keyframeModelName = engine => engine === "qwen-image-2.1" ? "Qwen Image 2.1" : "Qwen-Image-Edit-2509";

  // Description of a sheet, the only part Gemma sees: what the subject or place IS,
  // never the scene around it (the template sets layout, background and light).
  const SHEET_DESC_ENRICH_SYSTEM = what => {
    const subject = what === "location"
      ? "ONE single location for an environment reference sheet"
      : what === "other"
        ? "ONE single non-human subject (animal, creature, robot or object) for a reference sheet"
        : "ONE single person for a character reference sheet";
    const covers = what === "location"
      ? "the place itself, its architecture, its structures, its ground, its materials, its textures and its colors"
      : what === "other"
        ? "its species or nature, its body plan, its proportions, its size, its surface, its materials, its markings and its colors"
        : "face, hair, age, build, skin, clothing and accessories";
    const bans = what === "location"
      ? "describe no character, no person, no animal and no action; "
      : "describe no background, no location, no scene and no action; ";
    const guard = what === "other"
      ? "never give the subject human anatomy, a human face, a human posture or human clothing unless the user's text asks for it; "
      : "";
    return `You are a production designer writing the identity card of ${subject}. Rewrite the user's text into ONE English description of 25 to 60 words covering ONLY what it permanently looks like: ${covers}. STRICT RULES: keep every detail the user gave and contradict none of them; ${bans}${guard}describe no camera, no lens, no framing, no shot size, no lighting, no mood and no photographic style, the sheet sets all of those; use ONLY positive phrasing (never "no", "without", "avoid"); never write "reference sheet", "turnaround", "multi-view", "storyboard", "keyframe", "photo", "photograph", "masterpiece", "best quality", "8k" or "ultra detailed". Answer ONLY with JSON: {"description": "..."}`;
  };

  // Action field of a shot: re-injected as is in the keyframe and cut prompts, which add
  // camera, light, style and anchoring themselves; `descs` = the shot's subjects.
  const SHOT_ACTION_ENRICH_SYSTEM = descs => `You are a storyboard cinematographer. Rewrite the user's shot action into ONE English sentence of 12 to 25 words describing ONLY what happens in this single shot: what the subjects do, and with what body language. STRICT RULES: keep the same moment, the same place and the same intent; invent no new character and no new object; ${
    descs.length > 1
      ? `this shot has EXACTLY TWO subjects and BOTH must act in the sentence, together in the same place: (1) ${descs[0]}; (2) ${descs[1]}`
      : `this shot has EXACTLY ONE subject and it is the only character present: ${descs[0] || "the main subject of the scene"}`}; name each subject in two or three plain words, never copy its full description into the sentence; describe no camera angle, no shot size, no lens, no lighting and no color, they are set elsewhere; use ONLY positive phrasing (never "no", "without", "avoid"); never write "storyboard", "keyframe", "panel", "frame", "masterpiece", "best quality", "8k" or "ultra detailed". Answer ONLY with JSON: {"action": "..."}`;

  // A cut prompt (H3 is the only cut engine in 2.0; the text is 1.4's H3 variant).
  const CUT_ENRICH_SYSTEM = "You are a motion-picture prompt writer for the MiniMax H3 video model. Enrich the following shot into one dense cinematic English paragraph of 30 to 60 words: what happens, then lighting, materials, atmosphere and natural motion. STRICT RULES: keep the exact same subject, action, environment and camera motion; add no new character or object; use ONLY positive phrasing (never \"no\", \"without\", \"avoid\"); the text may contain subject markers written as a single bare word such as SUBJECTREF1 — copy every one of them character for character, keep them where they belong in the sentence, and write no other marker, no angle bracket and no square bracket; never write \"masterpiece\", \"best quality\", \"8k\" or \"ultra detailed\". Answer ONLY with JSON: {\"prompt\": \"...\"}";

  // Scenario split into Relay segments: Gemma writes only the prose of each segment,
  // the H3 structure is assembled at render time, subjects arrive as bare stand-ins.
  const H3_SCENARIO_SYSTEM = (n, legend) => `You are a shot-list writer for the MiniMax H3 video model.
Split the user's scenario into exactly ${n} consecutive video segments of one single continuous sequence, in chronological order.
Rules:
- Each segment is ONE English paragraph of 25 to 50 words: what happens first, then lighting, materials, atmosphere and the natural camera motion of that segment.
- The segments follow on from one another: segment k+1 starts exactly where segment k ended. Never restart the scene, never retell the whole scenario inside one segment, never jump elsewhere unless the scenario says so.
- The recurring subjects are named by a marker, one bare word each. Copy each marker character for character wherever that subject acts:
${legend}
- Write the marker instead of a proper name, and instead of a bare pronoun whenever the sentence would otherwise be ambiguous.
- Use ONLY positive phrasing (never "no", "without", "avoid").
- Plain prose only: no field name, no heading, no numbering, no angle bracket, no square bracket.
- Never write "masterpiece", "best quality", "8k" or "ultra detailed".
Answer ONLY with JSON: {"segments": ["...", "..."]} with exactly ${n} entries, in order.`;

  // Reference images described by Gemma's vision: otherwise <Subject N> has no text.
  const REF_FIELD_KEYS = ["subject", "appearance", "materials", "palette"];
  const REF_VISION_SYSTEM = `You are describing a reference image for a video model. Describe ONLY what is visibly present, so the subject stays IDENTICAL across shots. No camera, scene, action or mood wording, no speculation about story. Answer ONLY with JSON with these fields, each a dense ~10-20 word English string: {"subject":"...","appearance":"...","materials":"...","palette":"..."}.`;

  const CHARACTER_SHEET_SYSTEM = `You are a character designer. From the user's scene, take the SINGLE most prominent character or subject and describe it so it stays IDENTICAL across shots. It can be anything: a human being, an animal, an imaginary creature, a robot or machine of any shape, an alien, a vehicle, a plant or an inanimate object. FIRST set "kind": "human" only for a human being, "other" for everything else. THEN use the field set of that kind, each value a dense ~10-20 word English string, no camera/scene/action wording. Also set "label": a plain 2-to-4-word name for this subject that tells it apart from other subjects of the same scene, e.g. "weary detective", "young farmhand", "adult male lion", "six-legged mining robot". If kind is "human", answer ONLY with JSON {"kind":"human","label":"...","face":"...","hair":"...","outfit":"...","accessories":"...","palette":"..."}. If kind is "other", answer ONLY with JSON {"kind":"other","label":"...","subject":"what it is, in its own terms: type or species, and how many limbs, heads, wheels or parts it has, e.g. adult male African lion, four-legged big cat, or six-legged insect-like mining robot","form":"its silhouette, structure, proportions and natural resting posture","surface":"what its body is made of and how it looks: fur, scales, skin, bark, metal, glass, worn paint","details":"the distinctive parts and marks that identify it","palette":"..."}. When kind is "other", describe it strictly as the thing it is: give it no human face, no human hair, no clothing and no human stance unless the user's scene explicitly says so.`;
  const characterSheetSystem = force => CHARACTER_SHEET_SYSTEM
    + (force ? ` The user has already decided: kind is "${force}". Set "kind" to "${force}" and fill only the ${force} field set.` : "");
  const LOCATION_SHEET_SYSTEM = `You are a location designer. From the user's scene, take the SINGLE main location/setting and describe it so the environment stays IDENTICAL across shots. Answer ONLY with JSON with these fields, each a dense ~10-20 word English string, no camera/character/action wording: {"place":"...","architecture":"...","materials":"...","lighting":"...","palette":"..."}.`;
  const SHOT_LIST_SYSTEM = n => {
    const camIds = Object.keys(CAMERA_LIB).join(", ");
    const lightIds = Object.keys(LIGHTING_LIB).join(", ");
    return `You are a storyboard cinematographer. The user gives ONE scene with fixed character and setting. Break it into exactly ${n} sequential shots of THAT SAME scene. The character's appearance and the setting NEVER change — only camera, light and moment vary. For EACH shot output an object with: "camera" = EXACTLY ONE id from [${camIds}], "lighting" = EXACTLY ONE id from [${lightIds}], "action" = short English description of what the single main character (exactly one subject in frame, a person, an animal, a creature, a machine or an object) is doing (~8-14 words), "emotion" = one or two words for the mood/expression. Answer ONLY with JSON: {"shots": [ {"camera":"...","lighting":"...","action":"...","emotion":"..."}, ... ]} with exactly ${n} entries.`;
  };

  // ── Brief enrichment ────────────────────────────────────────────────────────

  // The one decision point: [instruction, output key] for a workflow, or null when the
  // workflow builds its own prompts (`enrich: "builtin"`), in which case nothing is sent.
  // Krea 2, H3 and Qwen Edit 2509 each have their own instruction; storyboards get the
  // storyboard brief one; everything else the generic one. Only "positive_prompt" rewrites
  // the user's negative prompt.
  const KREA2_WORKFLOWS = new Set(["krea2_t2i", "campaign"]);
  const isKrea2Workflow = wf => !!wf && KREA2_WORKFLOWS.has(wf.id);
  // The instructions the settings panel can replace, by name: [default, output key].
  // A replaced text (setInstructionOverrides, from /api/instructions) only takes the
  // default's place; the output key and the token checks of enrichBrief stay.
  const ENRICH_INSTRUCTIONS = {
    krea2: [KREA2_ENRICH_SYSTEM, "prompt"],
    qwen21: [ENRICH_SYSTEM, "positive_prompt"],
    h3_video: [H3_VIDEO_ENRICH_SYSTEM, "prompt"],
    h3_r2v: [R2V_BRIEF_ENRICH_SYSTEM, "brief"],
    storyboard: [SHEET_BRIEF_ENRICH_SYSTEM, "brief"],
  };
  let instructionOverrides = {};
  function setInstructionOverrides(map) { instructionOverrides = { ...map }; }
  function enrichRoute(wf) {
    if (isKrea2Workflow(wf)) return "krea2";
    // The multi-image sequence renders H3 image-to-video segments (1.4 used LTX there).
    if (wf?.id === "h3_t2v" || wf?.id === "h3_i2v" || wf?.id === "h3_sequence") return "h3_video";
    if (wf?.id === "h3_r2v") return "h3_r2v";
    if (wf?.pipeline === "storyboard") return "storyboard";
    if (wf?.enrich === "builtin") return null;
    return "qwen21";
  }
  function briefEnrichSystem(wf) {
    if (wf?.id === "qwen_edit_i2i") return [QWEN_EDIT_INSTRUCTION_ENRICH_SYSTEM, "instruction"];
    const name = enrichRoute(wf);
    if (!name) return null;
    const [text, key] = ENRICH_INSTRUCTIONS[name];
    return [instructionOverrides[name] || text, key];
  }

  // <imageN> mentions of a Qwen Image 2.1 edit brief cross Gemma as bare words too.
  const Q21_TOKEN_RE = /[<>]\s*image\s*(\d+)\s*[<>]/gi, Q21_STUB_RE = /\bQ21IMAGEREF\s*_?(\d+)\b/gi;

  // Rewrites the brief of `wf`. Returns {brief, negative} with what to write back (a
  // missing key = leave that field alone), or null when nothing was applied. The brief is
  // kept, and said so, when Gemma lost or invented a reference mention or answered
  // without the expected key. `styleText` (Krea 2 only) goes along as PRIMARY_STYLE so
  // Gemma composes around it; it is appended at submission, not written into the brief.
  async function enrichBrief(llm, wf, briefText, styleText, log) {
    const route = briefEnrichSystem(wf);
    if (!route) { say(log, "sys", "{workflow} builds its own prompts: brief sent as it is.", { workflow: wf.label }); return null; }
    const [system, key] = route, krea2 = isKrea2Workflow(wf);
    const style = krea2 ? styleText || "" : "";
    const q21 = wf?.id === "qwen21_i2i", r2v = wf?.id === "h3_r2v", src = String(briefText || "").trim();
    const cited = q21 ? [...src.matchAll(Q21_TOKEN_RE)].map(m => m[1]) : [];
    const citedH3 = r2v ? [...src.matchAll(H3_TOKEN_RE)].map(m => m[1]) : [];
    const user = (q21 ? src.replace(Q21_TOKEN_RE, (_, n) => `Q21IMAGEREF${n}`) : r2v ? h3TokensOut(src) : src) + (style ? `\nPRIMARY_STYLE: ${style}` : "");
    const out = await llm(system, user);
    if (!out[key]) {
      say(log, "warn", "Enrichment ignored: Gemma's answer lacks the expected field. Your prompt is kept.");
      return null;
    }
    const got = r2v ? h3NormalizeTokens(h3TokensIn(out[key])) : out[key];
    const raw = q21 ? got.replace(Q21_STUB_RE, (_, n) => `<image${n}>`).replace(Q21_TOKEN_RE, (_, n) => `<image${n}>`) : got;
    if (cited.some(n => !raw.includes(`<image${n}>`))) {
      say(log, "warn", "Enrichment discarded: the <imageN> mentions of your prompt were missing from Gemma's output. Your prompt is kept.");
      return null;
    }
    if (citedH3.some(n => !raw.includes(h3Subject(n)))) {
      say(log, "warn", "Enrichment discarded: the <Subject N> mentions of your prompt were missing from Gemma's output. Your prompt is kept.");
      return null;
    }
    // A <Subject n> the brief does not cite would point at a random reference.
    if (r2v && [...raw.matchAll(H3_TOKEN_RE)].some(m => !citedH3.includes(m[1]))) {
      say(log, "warn", "Enrichment discarded: Gemma added a <Subject N> mention your prompt does not have. Your prompt is kept.");
      return null;
    }
    let text = krea2 ? stripPromptPadding(raw) : raw;
    let camera = false;
    if (enrichRoute(wf) === "h3_video") {
      const fixed = restoreCameraClause(src, text);
      camera = fixed !== text;
      text = fixed;
    }
    const result = { brief: text };
    if (key === "positive_prompt" && out.negative_prompt) result.negative = out.negative_prompt;
    say(log, "ok", krea2 ? "Prompt enriched by {model} (Krea 2 instruction, positive only)." : "Prompt enriched by {model}.",
      { model: LLM_NAME });
    if (camera) say(log, "sys", "The camera move of your prompt was put back into the enriched prompt.");
    const stripped = got.length - text.length;
    if (stripped > 0) say(log, "sys", "Filler removed from the prompt ({count} characters without visual direction).", { count: stripped });
    return result;
  }

  // ── Studio prompt rewrites (sheets, keyframes, actions, cuts) ───────────────

  // Keyframe prompt edited by hand. Two safety nets, because a Qwen Edit prompt that lost
  // its anchoring renders a plausible but wrong image that no status reports: the edited
  // text is kept when Gemma dropped a reference role, and the anchoring is re-appended
  // in every case.
  async function enrichKeyframeText(llm, editedText, dual, model, log) {
    const anchorBlock = dual ? KEYFRAME_ANCHOR_DUAL : KEYFRAME_ANCHOR_SOLO;
    const stripped = stripKeyframeAnchor(editedText);
    let txt = "";
    try {
      const out = await llm(QWEN_EDIT_ENRICH_SYSTEM(dual ? 2 : 1, model), stripped);
      txt = fieldText(out.prompt || out.Rewritten || out.rewritten || out.positive_prompt);
    } catch (err) {
      say(log, "warn", "Qwen Edit enrichment unavailable ({error}): edited prompt kept.", { error: err.message });
      return stripped + " " + anchorBlock;
    }
    // Two subjects need THREE role sentences (first subject, second subject, setting).
    const roles = (txt.match(/(first|second|third) reference image/gi) || [])
      .map(m => m.split(" ")[0].toLowerCase());
    const missingRole = dual
      ? !(roles.includes("first") && roles.includes("second") && roles.includes("third"))
      : !/reference image/i.test(txt);
    if (!txt || txt.length < 20 || missingRole) {
      say(log, "warn", "Qwen Edit enrichment discarded: the reference image roles were missing from Gemma's output.");
      return stripped + " " + anchorBlock;
    }
    say(log, "ok", "Keyframe prompt enriched by {model} (Qwen Edit instruction).", { model: LLM_NAME });
    return stripPromptPadding(txt) + " " + anchorBlock;
  }

  // Sheet prompt (Krea 2), strip then re-append: the skeleton is removed before the call
  // and put back after, so the multi-view layout cannot vanish in the rewrite.
  // `what` = "human" | "other" | "location"; `skeleton` from sheetSkeleton.
  async function enrichSheetText(llm, editedText, what, skeleton, log) {
    const desc = stripSheetSkeleton(editedText, skeleton);
    try {
      const out = await llm(SHEET_DESC_ENRICH_SYSTEM(what), desc);
      const txt = fieldText(out.description || out.positive_prompt || out.prompt);
      if (!txt || txt.length < 20) return editedText;
      say(log, "ok", "Sheet description enriched by {model} (template layout kept).", { model: LLM_NAME });
      return wrapSheetDesc(stripPromptPadding(txt), skeleton);
    } catch (err) {
      say(log, "warn", "Krea 2 enrichment unavailable ({error}): edited prompt kept.", { error: err.message });
      return editedText;
    }
  }

  async function enrichShotAction(llm, editedText, descs, log) {
    try {
      const out = await llm(SHOT_ACTION_ENRICH_SYSTEM(descs), editedText);
      const txt = fieldText(out.action || out.prompt);
      if (!txt || txt.length < 10) return editedText;
      say(log, "ok", "Shot action enriched by {model} ({count} subject(s) taken into account).", { model: LLM_NAME, count: descs.length });
      return stripPromptPadding(txt);
    } catch (err) {
      say(log, "warn", "Action enrichment unavailable ({error}): text kept.", { error: err.message });
      return editedText;
    }
  }

  // Cut prompt: <Subject N> tokens cross Gemma as bare stand-ins.
  async function enrichCutText(llm, editedText, log) {
    try {
      const out = await llm(CUT_ENRICH_SYSTEM, h3TokensOut(editedText));
      const txt = fieldText(out.prompt || out.positive_prompt);
      if (!txt || txt.length < 20) return editedText;
      say(log, "ok", "Cut prompt enriched by {model} (MiniMax H3 instruction).", { model: LLM_NAME });
      return h3NormalizeTokens(h3TokensIn(stripPromptPadding(txt)));
    } catch (err) {
      say(log, "warn", "Cut enrichment unavailable ({error}): edited prompt kept.", { error: err.message });
      return editedText;
    }
  }

  // ── Sheets and shot list from the brief ─────────────────────────────────────

  // Gemma picks `kind` (human / other) and fills that field set, plus a short `label`
  // (tabs only, never compiled). `forceKind` ("human" | "other"): the kind chosen by the
  // user; anything else lets Gemma decide.
  async function characterSheetFromBrief(llm, scene, log, forceKind) {
    const force = forceKind === "human" || forceKind === "other" ? forceKind : null;
    try {
      const out = await llm(characterSheetSystem(force), scene);
      // The field set follows the fields Gemma FILLED, not the `kind` it announces (it
      // regularly describes a lion in {subject, form, surface} while saying "human").
      // `palette`, shared by both sets, decides nothing; `kind` only breaks a tie. A kind
      // forced by the user wins over all of it.
      const filledCount = keys => keys.filter(k => k !== "palette" && fieldText(out[k])).length;
      const nHuman = filledCount(CHAR_FIELD_KEYS), nOther = filledCount(CHAR_OTHER_FIELD_KEYS);
      const fields = { kind: force || (nOther > nHuman ? "other" : nHuman > nOther ? "human"
                             : (out.kind === "human" ? "human" : "other")) };
      fields.label = fieldText(out.label);
      for (const k of charFieldKeys(fields)) fields[k] = fieldText(out[k]);
      // Forced kind while Gemma filled the OTHER set: its description goes into the first
      // field of the forced set.
      if (force && !filledCount(charFieldKeys(fields))) {
        const other = force === "human" ? CHAR_OTHER_FIELD_KEYS : CHAR_FIELD_KEYS;
        const poured = stripPromptPadding(other.filter(k => k !== "palette").map(k => fieldText(out[k])).filter(Boolean).join(", "));
        if (poured) { fields[charFieldKeys(fields)[0]] = poured; say(log, "ok", "Subject sheet written by {model}.", { model: LLM_NAME }); return fields; }
      }
      // A sheet holding only a palette describes nothing: fall back to the brief.
      if (filledCount(charFieldKeys(fields))) { say(log, "ok", "Subject sheet written by {model}.", { model: LLM_NAME }); return fields; }
      throw new Error("no descriptive field filled");
    } catch (e) {
      say(log, "warn", "Subject sheet unavailable from the LLM ({error}): brief used as it is.", { error: e.message });
      if (force === "other") return { kind: "other", subject: scene, form: "", surface: "", details: "", palette: "" };
      return { face: scene, hair: "", outfit: "", accessories: "", palette: "" };
    }
  }

  async function locationSheetFromBrief(llm, scene, log) {
    try {
      const out = await llm(LOCATION_SHEET_SYSTEM, scene);
      const fields = {};
      for (const k of LOC_FIELD_KEYS) fields[k] = fieldText(out[k]);
      if (locDescFromFields(fields)) { say(log, "ok", "Setting sheet written by {model}.", { model: LLM_NAME }); return fields; }
      throw new Error("unexpected format");
    } catch (e) {
      say(log, "warn", "Setting sheet unavailable from the LLM ({error}): brief used as it is.", { error: e.message });
      return { place: scene, architecture: "", materials: "", lighting: "", palette: "" };
    }
  }

  async function shotListFromBrief(llm, scene, n, segDur, log) {
    let shots;
    try {
      const out = await llm(SHOT_LIST_SYSTEM(n), scene);
      shots = normalizeShotList(out.shots, n, scene);
      say(log, "ok", "{count} shots (camera, light, action) written by {model}.", { count: n, model: LLM_NAME });
    } catch (e) {
      say(log, "warn", "Shot list unavailable from the LLM ({error}): fallback presets used.", { error: e.message });
      shots = fallbackShots(n, scene);
    }
    return shots.map(s => ({
      camera: s.camera, lighting: s.lighting, action: s.action, emotion: s.emotion || "",
      duration: segDur, extra: ""
    }));
  }

  // A reference image described by Gemma's vision (`base64` without the data: prefix),
  // filtered like everything that ends up in a prompt.
  async function describeRefImage(llm, base64) {
    const out = await llm(REF_VISION_SYSTEM, "Describe this reference image.", [base64]);
    return stripPromptPadding(REF_FIELD_KEYS.map(k => fieldText(out[k])).filter(Boolean).join(", "));
  }

  // ── Relay scenario ──────────────────────────────────────────────────────────

  // Pseudo-shot of a Relay segment: its text is the action, so the cut prompt functions
  // alone decide the prompt's shape.
  const relayShot = seg => ({ camera: "medium", lighting: "golden_hour", action: String(seg.prompt || "").trim(),
                              emotion: "", extra: "", duration: seg.duration, subjects: [0] });

  // Legend of the stand-ins, built from h3CutSubjects, the function that numbers the
  // subjects in the rendered prompt, so the two never disagree. `subjects`: those of
  // relayShot (the main character), as for the segment's cut prompt.
  function relaySubjectLegend(locDesc, subjects) {
    return h3CutSubjects(subjects || [], locDesc)
      .map((sub, i) => `  ${H3_TOKEN_STUB(i + 1)} = ${sub.kind === "environment" ? "the location" : "the main character"}${sub.desc ? `, ${sub.desc}` : ""}`)
      .join("\n");
  }

  // Splits a scenario into at most `max` segment texts (Gemma may return one more or one
  // less than `n`: what it wrote is kept). Throws when nothing usable came back.
  async function composeScenario(llm, text, n, locDesc, max, subjects) {
    const out = await llm(H3_SCENARIO_SYSTEM(n, relaySubjectLegend(locDesc, subjects)), text);
    const list = (Array.isArray(out.segments) ? out.segments : [])
      .map(seg => h3NormalizeTokens(h3TokensIn(stripPromptPadding(fieldText(seg)))))
      .filter(Boolean)
      .slice(0, max);
    if (!list.length) throw new Error("no segment returned");
    return list;
  }

  const Prompts = {
    LLM_NAME,
    CAMERA_LIB, LIGHTING_LIB, STYLE_PACKS, styleTextFor, asSubjects,
    fieldText, CHAR_FIELD_KEYS, CHAR_OTHER_FIELD_KEYS, charKindOf, charFieldKeys, LOC_FIELD_KEYS,
    stripPromptPadding, charDescFromFields, locDescFromFields,
    KEYFRAME_ANCHOR_SOLO, KEYFRAME_ANCHOR_DUAL, compileKeyframePrompt, stripKeyframeAnchor, ensureKeyframeAnchor,
    compileRelayKeyframePrompt, HOLD_MOTION,
    H3_PROMPT_CHARS, h3Subject, h3Picture, H3_TOKEN_STUB, H3_TOKEN_RE, h3TokensOut, h3TokensIn, h3NormalizeTokens,
    h3AssignSubjects, h3Summary, h3RefBody, buildH3RefPrompt, capH3Prompt, h3VideoFrames, h3RealDuration,
    h3Alignment, h3CutSubjects, h3CutBodyText, buildH3CutPrompt, h3CutBodyOf, restoreCameraClause,
    normalizeShotList, fallbackShots,
    SHEET_CLEAN, SHEET_TEMPLATES, SHEET_SIZE, sheetWords, charsheetPromptFrom, charsheetFromPhotoPrompt, locsheetPromptFrom,
    sheetSkeleton, stripSheetSkeleton, wrapSheetDesc,
    CAMPAIGN_IMAGES, CAMPAIGN_TEASER, campaignPrompt,
    KREA2_ENRICH_SYSTEM, H3_VIDEO_ENRICH_SYSTEM, R2V_BRIEF_ENRICH_SYSTEM, QWEN_EDIT_INSTRUCTION_ENRICH_SYSTEM,
    SHEET_BRIEF_ENRICH_SYSTEM, ENRICH_SYSTEM, QWEN_EDIT_ENRICH_SYSTEM, keyframeModelName, SHEET_DESC_ENRICH_SYSTEM,
    SHOT_ACTION_ENRICH_SYSTEM, CUT_ENRICH_SYSTEM, H3_SCENARIO_SYSTEM, REF_VISION_SYSTEM,
    isKrea2Workflow, briefEnrichSystem, enrichBrief, ENRICH_INSTRUCTIONS, setInstructionOverrides,
    enrichKeyframeText, enrichSheetText, enrichShotAction, enrichCutText,
    characterSheetFromBrief, locationSheetFromBrief, shotListFromBrief, describeRefImage,
    relayShot, relaySubjectLegend, composeScenario,
  };
  if (typeof module === "object" && module.exports) module.exports = Prompts;
  else global.Prompts = Prompts;
})(typeof window !== "undefined" ? window : globalThis);
