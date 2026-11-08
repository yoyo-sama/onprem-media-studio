// Canvas cards: what each card is (inputs, properties, panel fields, footer line) and
// what a click on Generate submits. The jobs and the prompts are the Studio's: a card
// only chains them, reading what the card upstream produced. Nothing here runs
// without that click.
//
// A card that produced something holds it in `properties.outFile` (a file reference,
// `outputs/…` or `inputs/…`) and `properties.src` (its URL); the cards downstream read
// `outFile`. The storyboard and the cuts also keep what the next card needs (shots,
// descriptions, shot images, cuts).

import { api, on, refURL, waitJob } from "./api.js";
import { L, t } from "./i18n.js";
import * as F from "./form.js";
import { stackParams } from "./lora-stack.js";

const P = window.Prompts;

// ── Status ────────────────────────────────────────────────────────────────────
// `status`: idle, running, error or done; `statusMsg`: [English template, params],
// translated when drawn. Colours of the canvas drawing, the panel has its own.
export const STATUS_COLOR = { idle: "#94a3b8", running: "#c98a1b", error: "#c0392b", done: "#2a7d2a" };
export function setStatus(node, status, text = "", params) {
  node.status = status;
  node.statusMsg = text ? [text, params] : null;
  node.boxcolor = STATUS_COLOR[status] || STATUS_COLOR.idle;
  if (status !== "running") node.progress = null;
  node.setDirtyCanvas(true, true);
}
const fail = (node, err) => setStatus(node, "error", "Error: {error}", { error: err.message });

let saveGraph = () => {};
export function onChange(fn) { saveGraph = fn; }

// ── Jobs ──────────────────────────────────────────────────────────────────────
// Job progress (0 to 100) is drawn on the card that submitted the job.
const jobNodes = new Map();
on("job", job => {
  const node = jobNodes.get(job.id);
  if (node && job.status === "running") {
    node.progress = Math.round((job.progress || 0) * 100);
    node.setDirtyCanvas(true, true);
  }
});
async function submit(node, pipeline, params) {
  const job = await api.submit(pipeline, params, "canvas");
  jobNodes.set(job.id, node);
  return job;
}
async function finish(job) {
  try { return await waitJob(job); } finally { jobNodes.delete(job.id); }
}
const run = async (node, pipeline, params) => finish(await submit(node, pipeline, params));
function output(job, ext) {
  const ref = job.outputs.find(o => o.endsWith(ext));
  if (!ref) throw new Error(t(ext === ".mp4" ? "The job returned no video." : "The job returned no image."));
  return ref;
}
function done(node, ref, text = "Done: {name}", params) {
  node.properties.outFile = ref;
  node.properties.src = refURL(ref);
  setStatus(node, "done", text, { name: ref.split("/").pop(), ...params });
}

// Seeds: 0 draws one, below 2^31 so the offsets added per shot stay in range.
const seedOf = node => node.properties.seed || Math.floor(Math.random() * 2 ** 31);
// LoRA stacks of a card, one per folder (`properties.loras`, edited by a "loras" panel
// field); a job sends the one of its engine's folder.
const lorasOf = (node, folder) => stackParams(node.properties.loras?.[folder]);
const STYLES = () => Object.entries(P.STYLE_PACKS).map(([id, s]) => [id, s.label]);
const styleLabel = id => t(P.STYLE_PACKS[id]?.label || id);
const RATIOS = () => Object.keys(F.RATIOS).map(r => [r, r]);
// Engines of the Image creation card: server engine, label, Studio workflow (its ✨ instruction).
const IMAGE_ENGINES = {
  krea2: { engine: "krea2-t2i", label: "Krea 2 Turbo", workflow: "krea2_t2i" },
  qwen21: { engine: "qwen-image-2.1", label: "Qwen Image 2.1", workflow: "qwen21_t2i" },
  moss: { engine: "moss-image", label: "MOSS-Image", workflow: "moss_t2i" },
};
const imageEngine = p => IMAGE_ENGINES[p.engine] || IMAGE_ENGINES.krea2;
const SUBJECT_KINDS = () => [["auto", L("Auto")], ["human", L("Human")], ["other", L("Other (animal, object…)")]];

// ── Upstream cards ────────────────────────────────────────────────────────────
export function upstreamNode(node, slot) {
  const link = node.getInputLink(slot);
  return link ? node.graph.getNodeById(link.origin_id) : null;
}
export const upstreamRef = (node, slot) => upstreamNode(node, slot)?.properties?.outFile || null;
// Missing sheets of a card fed by a character and a setting sheet (slots 0 and 1).
function missingSheets(node, charRef, locRef) {
  if (charRef && locRef) return false;
  setStatus(node, "error", !charRef && !locRef ? "Error: run the character and setting sheets connected to this card first."
    : !charRef ? "Error: run the character sheet connected to this card first."
    : "Error: run the setting sheet connected to this card first.");
  return true;
}

// ── Inputs that grow ──────────────────────────────────────────────────────────
// A group of inputs (same name) always has one free input until its cap: connecting
// it adds the next one, disconnecting removes the extra free ones. Inputs are found by
// name, never by index, so existing links never move.
export const SLOT_IMG_REF = "image ref +";
export const SLOT_SHEET_REF = "sheet +";
export const slotIndexes = (node, name) => (node.inputs || []).flatMap((s, i) => (s.name === name ? [i] : []));
const connectedSlots = (node, name) => slotIndexes(node, name).filter(i => node.inputs[i].link != null);
// Cards with many inputs grow taller, so every input sits above the media.
function autoHeight(node, baseH) {
  const rows = Math.max((node.inputs || []).length, (node.outputs || []).length);
  node.size[1] = Math.max(baseH, 20 * rows + 4 + 160);
  node.setDirtyCanvas(true, true);
}
function autogrow(node, groups, baseH) {
  if (node._growing) return;  // removeInput calls onConnectionsChange again
  node._growing = true;
  const w = node.size[0];     // addInput and removeInput recompute the size
  try {
    for (const [name, cap] of groups) {
      const free = slotIndexes(node, name).filter(i => node.inputs[i].link == null);
      for (let k = free.length - 1; k >= 1; k--) node.removeInput(free[k]);
      const all = slotIndexes(node, name);
      if (all.length < cap && all.every(i => node.inputs[i].link != null)) {
        node.addInput(name, 0);
        node.inputs[node.inputs.length - 1].label = "";
      }
    }
  } finally { node._growing = false; }
  node.size[0] = w;
  autoHeight(node, baseH);
}
// Outputs of the cards connected to a group, in input order. A connected card that
// has produced nothing yet is skipped: extra references never block a render.
const refsFor = (node, name) => connectedSlots(node, name).map(i => upstreamRef(node, i)).filter(Boolean);

// ── Cards ─────────────────────────────────────────────────────────────────────
// label: card name; tech: card type shown in the panel; grad: placeholder gradient;
// video: video card; model: engine shown in the panel, or modelProp + modelValues for
// a card with an engine choice; subject/preview: property shown in the title and the
// panel; meta(n): footer line; fields: panel fields (k: property, type, enrich: the
// Studio workflow whose ✨ instruction the field uses, `when`: shown only if true).
const H3_DURATION = { min: 5, max: 15 };
export const CARDS = {
  "adv/charsheet": {
    label: L("Character sheet"), tech: "charsheet", grad: ["#efe9ff", "#c9b8f5"], model: "Krea 2",
    engines: () => ["krea2-t2i"],
    subject: "brief", preview: "brief",
    outputs: ["charsheet"], size: [340, 260],
    props: { brief: "", kind: "auto", style: "cinematic", seed: 0, charDesc: "", kindResolved: "" },
    meta: n => `Krea 2 · ${P.SHEET_SIZE.width}×${P.SHEET_SIZE.height} · ${styleLabel(n.properties.style)}`,
    fields: [
      { k: "brief", label: L("Character"), type: "textarea", enrich: () => "storyboard_qwen21",
        placeholder: "a lighthouse keeper with short white hair, yellow raincoat and a red scarf" },
      // Applies to the next generation (a click), changing it starts nothing.
      { k: "kind", label: L("Subject type"), type: "select", values: SUBJECT_KINDS,
        hint: L("Auto: the AI tells whether the subject is human. Choose yourself if it gets it wrong.") },
      { k: "style", label: L("Style"), type: "select", values: STYLES },
      { k: "seed", label: L("Seed (0 = auto)"), type: "number", min: 0 },
    ],
    async generate(node) {
      const p = node.properties, brief = p.brief.trim();
      if (!brief) return setStatus(node, "error", "Error: describe the character first.");
      setStatus(node, "running", "Character sheet: {llm}…", { llm: P.LLM_NAME });
      // A kind chosen on the card is imposed on Gemma; "auto" lets it decide.
      const fields = await P.characterSheetFromBrief(F.llm, brief, null, p.kind);
      const charDesc = P.charDescFromFields(fields), kind = P.charKindOf(fields);
      setStatus(node, "running", "Character sheet (Krea 2)…");
      const job = await run(node, "krea2-t2i", { prompt: P.charsheetPromptFrom(charDesc, kind, undefined, p.style),
        ...P.SHEET_SIZE, count: 1, seed: seedOf(node) });
      p.charDesc = charDesc;
      p.kindResolved = kind;
      done(node, output(job, ".png"));
    },
  },
  "adv/locsheet": {
    label: L("Setting sheet"), tech: "locsheet", grad: ["#e6f1ff", "#b3d1f5"], model: "Krea 2",
    engines: () => ["krea2-t2i"],
    subject: "brief", preview: "brief",
    outputs: ["locsheet"], size: [340, 260],
    props: { brief: "", style: "cinematic", seed: 0, locDesc: "" },
    meta: n => `Krea 2 · ${P.SHEET_SIZE.width}×${P.SHEET_SIZE.height} · ${styleLabel(n.properties.style)}`,
    fields: [
      { k: "brief", label: L("Setting"), type: "textarea", enrich: () => "storyboard_qwen21",
        placeholder: "the round lantern room of an old lighthouse, green tiled floor, brass lamps, spiral staircase" },
      { k: "style", label: L("Style"), type: "select", values: STYLES },
      { k: "seed", label: L("Seed (0 = auto)"), type: "number", min: 0 },
    ],
    async generate(node) {
      const p = node.properties, brief = p.brief.trim();
      if (!brief) return setStatus(node, "error", "Error: describe the setting first.");
      setStatus(node, "running", "Setting sheet: {llm}…", { llm: P.LLM_NAME });
      const locDesc = P.locDescFromFields(await P.locationSheetFromBrief(F.llm, brief, null));
      setStatus(node, "running", "Setting sheet (Krea 2)…");
      const job = await run(node, "krea2-t2i", { prompt: P.locsheetPromptFrom(locDesc, p.style),
        ...P.SHEET_SIZE, count: 1, seed: seedOf(node) });
      p.locDesc = locDesc;
      done(node, output(job, ".png"));
    },
  },
  // Stops after the shot images: the cuts are a card of their own, so the storyboard
  // can be checked before the video renders. A third sheet (a second character or a
  // second setting) can be connected; it is the third reference image of every shot.
  "adv/storyboard": {
    label: L("Storyboard"), tech: "storyboard", grad: ["#fdf1dd", "#e8cf9f"], model: "Qwen Image 2.1",
    engines: () => ["qwen-image-2.1"],
    subject: "brief", preview: "brief",
    inputs: ["charsheet", "locsheet", SLOT_SHEET_REF], outputs: ["keyframes"], size: [360, 320],
    autogrow: [[SLOT_SHEET_REF, 1]],
    props: { brief: "", shotCount: 4, segmentDuration: 5, style: "cinematic", seed: 0,
             shots: [], keyframes: [], charDesc: "", locDesc: "", styleId: "" },
    meta: n => t("Qwen Image 2.1 · {n} shots · {d} s/shot", { n: n.properties.shotCount, d: n.properties.segmentDuration }),
    fields: [
      { k: "brief", label: L("Brief"), type: "textarea", enrich: () => "storyboard_qwen21",
        placeholder: "the lighthouse keeper climbs to the lantern room and watches the storm" },
      { k: "shotCount", label: L("Number of shots"), type: "number", min: 1, max: 16 },
      { k: "segmentDuration", label: L("Duration / shot (s)"), type: "number", ...H3_DURATION },
      { k: "style", label: L("Style"), type: "select", values: STYLES },
      { k: "seed", label: L("Seed (0 = auto)"), type: "number", min: 0 },
    ],
    async generate(node) {
      const p = node.properties, charNode = upstreamNode(node, 0), locNode = upstreamNode(node, 1);
      const charRef = upstreamRef(node, 0), locRef = upstreamRef(node, 1);
      if (missingSheets(node, charRef, locRef)) return;
      const brief = p.brief.trim();
      if (!brief) return setStatus(node, "error", "Error: write the brief first.");
      const charDesc = charNode.properties.charDesc || "", locDesc = locNode.properties.locDesc || "";
      const n = p.shotCount, seed = seedOf(node), third = refsFor(node, SLOT_SHEET_REF)[0];
      setStatus(node, "running", "Storyboard: {n} shots with {llm}…", { n, llm: P.LLM_NAME });
      const shots = await P.shotListFromBrief(F.llm, brief, n, p.segmentDuration, null);
      if (third) for (const s of shots)
        s.extra = `${s.extra} Use the third reference image only as an additional appearance and art-direction guide for the same single scene.`.trim();
      // Without a size, a shot image follows image 1: the character sheet.
      const jobs = [];
      for (let i = 0; i < n; i++) {
        jobs.push(await submit(node, "qwen-image-2.1", { prompt: P.compileKeyframePrompt(shots[i], charDesc, locDesc, p.style),
          subjects: [charRef], setting: locRef, references: third ? [third] : [], seed: F.seedPlus(seed, 11 + i) }));
        setStatus(node, "running", "Shot images ({k}/{n} submitted)…", { k: i + 1, n });
      }
      const keyframes = (await Promise.all(jobs.map(finish))).map(job => output(job, ".png"));
      let preview = keyframes[0];
      if (keyframes.length > 1) {
        setStatus(node, "running", "Contact sheet…");
        preview = output(await run(node, "image-grid", { images: keyframes }), ".png");
      }
      Object.assign(p, { shots, keyframes, charDesc, locDesc, styleId: p.style });
      done(node, preview, "Done: {n} shot images ready.", { n: keyframes.length });
    },
  },
  // One H3 cut per shot. i2v starts from the shot image; r2v takes the two sheets
  // (two cards up, through the storyboard) and the shot image as references.
  "adv/cutvideo": {
    label: L("Video generation"), tech: "cutvideo", grad: ["#1d2a55", "#0d1430"], video: true,
    engines: p => [p.engine === "r2v" ? "h3-r2v" : "h3-i2v"],
    modelProp: "engine", modelValues: [["i2v", "MiniMax H3"], ["r2v", "MiniMax H3 (r2v)"]],
    inputs: ["keyframes"], outputs: ["cuts"], size: [340, 260],
    props: { engine: "i2v", duration: 5, loras: {}, seed: 0, cuts: [] },
    meta: n => t("MiniMax H3 {engine} · {d} s/shot · {n} cuts",
      { engine: n.properties.engine, d: n.properties.duration, n: n.properties.cuts.length }),
    fields: [
      { k: "engine", label: L("Video engine"), type: "select", values: () => CARDS["adv/cutvideo"].modelValues },
      { k: "duration", label: L("Duration / shot (s)"), type: "number", ...H3_DURATION },
      { k: "loras", label: L("H3 style (LoRA)"), type: "loras", folder: () => "h3", when: n => n.properties.engine === "i2v" },
      { k: "seed", label: L("Seed (0 = auto)"), type: "number", min: 0 },
    ],
    async generate(node) {
      const p = node.properties, up = upstreamNode(node, 0), sb = up?.properties;
      if (!sb?.keyframes?.length || !sb.shots?.length)
        return setStatus(node, "error", "Error: run the storyboard connected to this card first.");
      const r2v = p.engine === "r2v", charRef = r2v ? upstreamRef(up, 0) : null, locRef = r2v ? upstreamRef(up, 1) : null;
      if (r2v && missingSheets(node, charRef, locRef)) return;
      const { shots, keyframes, charDesc, locDesc, styleId } = sb, duration = p.duration, seed = seedOf(node);
      let capped = false;
      const onWarn = () => { capped = true; };
      const jobs = [];
      for (let k = 0; k < shots.length; k++) {
        let params;
        if (r2v) {
          // <Picture 1> character sheet, <Picture 2> setting sheet, <Picture 3> the shot image.
          const subjects = P.h3AssignSubjects([{ kind: "character", desc: charDesc }, { kind: "environment", desc: locDesc },
            { kind: "reference", desc: "" }]);
          params = { prompt: P.capH3Prompt(P.buildH3RefPrompt({ subjects, summary: P.h3Summary(shots[k].action),
            body: P.h3CutBodyText(shots[k], subjects, null, styleId) }), onWarn), references: [charRef, locRef, keyframes[k]] };
        } else {
          params = { prompt: P.buildH3CutPrompt(shots[k], charDesc, locDesc, null, duration, null, false, styleId, onWarn),
            image: keyframes[k], loras: lorasOf(node, "h3") };
        }
        jobs.push(await submit(node, r2v ? "h3-r2v" : "h3-i2v", { ...params, duration, seed: F.seedPlus(seed, 31 + k) }));
        setStatus(node, "running", "Cuts ({k}/{n} submitted)…", { k: k + 1, n: shots.length });
      }
      p.cuts = (await Promise.all(jobs.map(finish))).map(job => output(job, ".mp4"));
      done(node, p.cuts[0], capped ? "Done: {n} cuts ready. H3 prompt cut to 7,000 characters (model limit)."
        : "Done: {n} cuts ready.", { n: p.cuts.length });
    },
  },
  "adv/final_video": {
    label: L("Final video"), tech: "animatic", grad: ["#1d2a55", "#0d1430"], video: true, model: "—",
    inputs: ["cuts"], outputs: ["video"], size: [340, 240], props: {},
    meta: () => t("Animatic · hard cuts"),
    fields: [],
    async generate(node) {
      const cuts = upstreamNode(node, 0)?.properties?.cuts;
      if (!cuts?.length) return setStatus(node, "error", "Error: run the video generation connected to this card first.");
      if (cuts.length === 1) return done(node, cuts[0]);
      setStatus(node, "running", "Joining {n} cuts…", { n: cuts.length });
      done(node, output(await run(node, "video-concat", { clips: cuts }), ".mp4"));
    },
  },
  // One H3 Ref2VA job: the two sheets and the extra images are its references.
  "adv/r2v": {
    label: L("Reference2Video"), tech: "r2v", grad: ["#1d2a55", "#0d1430"], video: true, model: "MiniMax H3",
    engines: () => ["h3-r2v"],
    subject: "brief", preview: "brief",
    inputs: ["charsheet", "locsheet", SLOT_IMG_REF], outputs: ["video"], size: [360, 300],
    autogrow: [[SLOT_IMG_REF, F.REF_CAPS.r2v]],
    props: { brief: "", ratio: "16:9", duration: 5, loras: {}, seed: 0 },
    meta: n => `MiniMax H3 r2v · ${n.properties.ratio} · ${n.properties.duration} s`,
    fields: [
      { k: "brief", label: L("Brief"), type: "textarea", enrich: () => "h3_r2v",
        placeholder: "the lighthouse keeper walks slowly across the lantern room and looks out of the window" },
      { k: "ratio", label: L("Aspect ratio"), type: "select", values: RATIOS },
      { k: "duration", label: L("Duration (s)"), type: "number", ...H3_DURATION },
      { k: "loras", label: L("H3 style (LoRA)"), type: "loras", folder: () => "h3" },
      { k: "seed", label: L("Seed (0 = auto)"), type: "number", min: 0 },
    ],
    async generate(node) {
      const p = node.properties, charRef = upstreamRef(node, 0), locRef = upstreamRef(node, 1);
      if (missingSheets(node, charRef, locRef)) return;
      const brief = p.brief.trim();
      if (!brief) return setStatus(node, "error", "Error: write the brief first.");
      // Extra images are references with no description (no vision call here).
      const extras = refsFor(node, SLOT_IMG_REF);
      const subjects = P.h3AssignSubjects([{ kind: "character", desc: upstreamNode(node, 0).properties.charDesc || "" },
        { kind: "environment", desc: upstreamNode(node, 1).properties.locDesc || "" },
        ...extras.map(() => ({ kind: "reference", desc: "" }))]);
      let capped = false;
      const prompt = P.capH3Prompt(P.buildH3RefPrompt({ subjects, summary: P.h3Summary(brief), body: P.h3RefBody(subjects, brief) }),
        () => { capped = true; });
      setStatus(node, "running", "MiniMax H3 r2v running…");
      const job = await run(node, "h3-r2v", { prompt, duration: p.duration, seed: F.seedPlus(seedOf(node), 201), loras: lorasOf(node, "h3"),
        aspect: p.ratio, references: [charRef, locRef, ...extras] });
      done(node, output(job, ".mp4"), capped ? "Done: {name}. H3 prompt cut to 7,000 characters (model limit)." : undefined);
    },
  },
  "simple/krea2": {
    label: L("Image creation"), tech: "t2i", grad: ["#fdf1dd", "#e8cf9f"],
    engines: p => [imageEngine(p).engine],
    modelProp: "engine", modelValues: Object.entries(IMAGE_ENGINES).map(([id, e]) => [id, e.label]),
    subject: "prompt", preview: "prompt",
    outputs: ["image"], size: [320, 240],
    // `mode` is read by MOSS-Image only; it stays in the properties across an engine switch,
    // as each engine's LoRA stack (`loras`, keyed by the engine id, which is its LoRA folder).
    props: { engine: "krea2", prompt: "", ratio: "1:1", mode: F.MOSS_DEFAULT_MODE, loras: {} },
    meta: n => {
      const [w, h] = imageSize(n), e = imageEngine(n.properties);
      return `${e.label}${e.engine === "moss-image" ? ` · ${t(F.mossModeLabel(n.properties.mode))}` : ""} · ${w}×${h}`;
    },
    fields: [
      { k: "engine", label: L("Engine"), type: "select", values: () => CARDS["simple/krea2"].modelValues },
      { k: "mode", label: L("Mode"), type: "select", values: () => F.MOSS_MODES, when: n => n.properties.engine === "moss" },
      { k: "prompt", label: L("Prompt"), type: "textarea", enrich: n => imageEngine(n.properties).workflow,
        placeholder: "a cinematic photo of a lighthouse at sunset" },
      { k: "ratio", label: L("Aspect ratio"), type: "select", values: RATIOS },
      { k: "loras", label: L("LoRA"), type: "loras", folder: n => (IMAGE_ENGINES[n.properties.engine] ? n.properties.engine : "krea2") },
    ],
    async generate(node) {
      const p = node.properties, prompt = p.prompt.trim(), e = imageEngine(p);
      const loras = lorasOf(node, IMAGE_ENGINES[p.engine] ? p.engine : "krea2");
      if (!prompt) return setStatus(node, "error", "Error: write the prompt first.");
      const [width, height] = imageSize(node);
      setStatus(node, "running", "{engine} running…", { engine: e.label });
      const job = await run(node, e.engine, { prompt, width, height, count: 1, seed: seedOf(node),
        ...(e.engine === "moss-image" ? { mode: p.mode || F.MOSS_DEFAULT_MODE } : {}), ...(loras.length ? { loras } : {}) });
      done(node, output(job, ".png"));
    },
  },
  // Qwen Image 2.1 edit: the top input is <image1>, the extra references <image2>…
  // in input order; the output keeps the size of image 1.
  "simple/qwen_edit": {
    label: L("Image editing"), tech: "i2i", grad: ["#fdf1dd", "#e8cf9f"], model: "Qwen Image 2.1",
    engines: () => ["qwen-image-2.1"],
    subject: "instruction", preview: "instruction",
    inputs: ["image", SLOT_IMG_REF], outputs: ["image"], size: [340, 240],
    autogrow: [[SLOT_IMG_REF, F.REF_CAPS.i2i]],
    props: { instruction: "", loras: {} },
    meta: n => t("Qwen Image 2.1 · {n} image(s) · size of image 1", { n: 1 + connectedSlots(n, SLOT_IMG_REF).length }),
    fields: [
      { k: "instruction", label: L("Editing instruction"), type: "textarea", enrich: () => "qwen21_i2i",
        placeholder: "add sunglasses on the character",
        hint: L("Top input: the image to edit, <image1>. The inputs below: extra references, <image2>, <image3>… in order, to cite in the instruction.") },
      { k: "loras", label: L("LoRA"), type: "loras", folder: () => "qwen21" },
    ],
    async generate(node) {
      const p = node.properties, image = upstreamRef(node, 0);
      if (!image) return setStatus(node, "error", "Error: connect a card that has produced an image to the top input.");
      const prompt = p.instruction.trim();
      if (!prompt) return setStatus(node, "error", "Error: write the editing instruction first.");
      setStatus(node, "running", "{engine} running…", { engine: "Qwen Image 2.1" });
      const loras = lorasOf(node, "qwen21");
      const job = await run(node, "qwen-image-2.1", { prompt, images: [image, ...refsFor(node, SLOT_IMG_REF)], seed: seedOf(node),
        ...(loras.length ? { loras } : {}) });
      done(node, output(job, ".png"));
    },
  },
  // H3 image to video: the canvas follows the input image.
  "simple/video": {
    label: L("Video"), tech: "i2v", grad: ["#1d2a55", "#0d1430"], video: true, model: "MiniMax H3",
    engines: () => ["h3-i2v"],
    subject: "prompt", preview: "prompt",
    inputs: ["image"], outputs: ["video"], size: [340, 260],
    props: { prompt: "", duration: 5, loras: {} },
    meta: n => `MiniMax H3 i2v · ${n.properties.duration} s`,
    fields: [
      { k: "prompt", label: L("Prompt (motion)"), type: "textarea", enrich: () => "h3_i2v",
        placeholder: "The scene continues with natural motion; slow push-in." },
      { k: "duration", label: L("Duration (s)"), type: "number", ...H3_DURATION },
      { k: "loras", label: L("H3 style (LoRA)"), type: "loras", folder: () => "h3" },
    ],
    async generate(node) {
      const p = node.properties, image = upstreamRef(node, 0);
      if (!image) return setStatus(node, "error", "Error: connect a card that has produced an image to the input.");
      const text = p.prompt.trim();
      if (!text) return setStatus(node, "error", "Error: write the prompt first.");
      let capped = false;
      // H3 expects at the head of the prompt the moment the input image stands for.
      const prompt = P.capH3Prompt(`${P.h3Alignment(false, p.duration)}\n\n${text}`, () => { capped = true; });
      setStatus(node, "running", "{engine} running…", { engine: "MiniMax H3" });
      const job = await run(node, "h3-i2v", { prompt, duration: p.duration, seed: seedOf(node), loras: lorasOf(node, "h3"), image });
      done(node, output(job, ".mp4"), capped ? "Done: {name}. H3 prompt cut to 7,000 characters (model limit)." : undefined);
    },
  },
  // An image from the computer (or dropped from the gallery drawer) made connectable.
  "simple/import": {
    label: L("Image import"), tech: "import", grad: ["#eef1f6", "#d5dbe6"], model: "—",
    outputs: ["image"], size: [320, 240],
    props: { filename: "" },
    meta: n => n.properties.filename || t("no file"),
    fields: [{ k: "file", label: L("Image file"), type: "file" }],
  },
};

const imageSize = n => (n.properties.engine === "qwen21" ? F.QWEN21_RATIOS : F.RATIOS)[n.properties.ratio] || F.RATIOS["1:1"];

export async function importFile(node, file) {
  setStatus(node, "running", "Uploading the file…");
  try {
    const { ref } = await api.upload(file);
    node.properties.filename = file.name;
    done(node, ref, "Imported: {name}", { name: file.name });
  } catch (err) { fail(node, err); }
  saveGraph();
}
// A gallery image dropped on an Import card: the file is already on the server.
export function adoptRef(node, ref, name) {
  node.properties.filename = name;
  done(node, ref, "From the gallery");
  saveGraph();
}

// ── Registration ──────────────────────────────────────────────────────────────
// Only these cards: litegraph's own sample nodes would otherwise be offered by its menus.
LiteGraph.clearRegisteredTypes();
for (const [type, card] of Object.entries(CARDS)) {
  function Card() {
    for (const name of card.inputs || []) this.addInput(name, 0);
    for (const name of card.outputs || []) this.addOutput(name, 0);
    this.properties = { ...structuredClone(card.props), src: "", outFile: null };
    this.size = card.size.slice();
    if (card.autogrow) autoHeight(this, card.size[1]);
    setStatus(this, "idle");
  }
  Card.title = card.label;
  Card.prototype.onConfigure = function () {
    // Canvases saved before LoRA stacks held one H3 file at full strength.
    if ("lora" in this.properties) {
      const name = this.properties.lora;
      delete this.properties.lora;
      if ("loras" in card.props) this.properties.loras = name ? { h3: [{ name, strength: 1 }] } : {};
    }
    setStatus(this, this.properties.outFile ? "done" : "idle");
    if (card.autogrow) autogrow(this, card.autogrow, card.size[1]);  // the free input of a restored card
  };
  if (card.autogrow) Card.prototype.onConnectionsChange = function (kind) {
    if (kind !== LiteGraph.INPUT) return;
    autogrow(this, card.autogrow, card.size[1]);
    saveGraph();
  };
  if (card.generate) Card.prototype.generate = async function () {
    if (this.status === "running") return;
    try { await card.generate(this); } catch (err) { fail(this, err); }
    saveGraph();
  };
  LiteGraph.registerNodeType(type, Card);
}
