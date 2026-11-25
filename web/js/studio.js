// Studio page: goal cards, the generate form and its flows, the models, LoRA and
// update panels, the monitor. The director (the long take) lives in director.js, the
// gallery in gallery.js.
//
// Nothing here submits a job except the Generate button: choosing a card, a pipeline,
// an engine or a language, dropping an image or editing a field starts nothing, and
// the app never writes the brief (the scenario example is only a placeholder).

import { api, connect, on, uploadLora } from "./api.js";
import { L, LANG, pct, setLang, t, translateTree, tx, txAttr } from "./i18n.js";
import {
  $, LLM, MOBILE, cancelAll, clampInt, fillSelect, initJobs, initPromptEditor, initTheme, initUndo,
  log, notice, onJobsChange, promptLog, runJob, runningJobs, undoToast, warn,
} from "./ui.js";
import { initModelNotice, showModelNotice } from "./model-notice.js";
import { initGallery } from "./gallery.js";
import * as F from "./form.js";
import { LORA_FOLDERS, folderForName, renderLoraStack, setLoraFiles } from "./lora-stack.js";
import * as D from "./director.js";
import * as G from "./generate.js";
import { CARD_IMAGE_WORKFLOWS, attachAsset, initChat, loadRolePanel, r2vCardBrief, reusePrompt as chatReusePrompt, showAssistant } from "./chat.js";

const P = F.P;
const brief = $("brief");
// Long flows (waiting for clips before assembling them) go on after the click: their
// errors reach the log.
const detach = promise => { promise.catch(warn); };

// ── Goal cards and scenarios ──────────────────────────────────────────────────
// Examples are placeholders only, in English, never translated or written as a value.
const SCENARIOS = {
  campaign: { pipeline: "text2image",
    example: "A cinematic promotional poster for a premium sci-fi streaming series, dramatic blue lighting, futuristic city background, high contrast, premium entertainment campaign style." },
  narrative: { pipeline: "sequence", example: "" },
  localization: { pipeline: "image2image",
    example: "Localized promotional poster variant for the Japanese market: keep the premium sci-fi brand identity, adapt background, wardrobe and typography cues to Tokyo night aesthetics." },
};
// The long take's brief is its screenplay, and the first prompt of every segment.
const MOTION_EXAMPLE = "A woman walks along a garden path at dawn, stops by a flowering tree, then turns toward the camera and smiles.";
let activeScenario = "campaign";

// What the main button starts, said on the button.
const GENERATE_LABELS = {
  text2image: L("Generate the images"), image2image: L("Generate the variants"),
  text2video: L("Generate the video"), image2video: L("Generate the video"),
  sequence: L("Open the long take"), reference2video: L("Generate the video"),
  campaign: L("Start the campaign (posters + thumbnails + teaser)"),
};
function refreshGenerateLabel() {
  tx($("generateBtn"), GENERATE_LABELS[F.currentPipeline()] || "Generate");
}

function selectScenario(scenario, pipeline = SCENARIOS[scenario].pipeline) {
  activeScenario = scenario;
  refreshPipelineOptions(pipeline);
}
// Opens a general pipeline (Image2Image, Image2Video…) from wherever the form is, a goal
// card with its own pipeline included.
const usePipeline = p => selectScenario(p === "image2image" ? "localization" : "campaign", p);

// ── Pipeline and engine menus ─────────────────────────────────────────────────
const CONTROL_WRAPS = {
  image: "imageInputWrap", duration: "durationWrap", markets: "marketsWrap", seq: "seqWrap",
  variants: "variantsWrap", ratio: "ratioWrap", style: "styleWrap",
};

// A goal card with its own pipeline (long take, ad campaign) shows it alone and
// leaves the Pipeline menu out; the other cards share the general pipelines.
function refreshPipelineOptions(pipeline = F.currentPipeline()) {
  const own = F.pipelineDef(pipeline)?.own ? F.pipelineDef(pipeline) : null;
  const list = own ? [own] : F.PIPELINES.filter(p => !p.own && (!p.scenario || p.scenario.includes(activeScenario)));
  fillSelect($("pipelineSelect"), list.map(p => [p.id, p.label]), pipeline);
  $("pipelineWrap").hidden = list.length < 2;
  updateModelOptions();
}

let lastPipeline = null, lengthKind = "clip";
const lengths = { clip: "5", take: "30" };
function updateModelOptions() {
  const p = F.currentPipeline(), def = F.pipelineDef(p);
  fillSelect($("modelSelect"), F.WORKFLOWS.filter(w => w.pipeline === p).map(w => [w.id, w.label]), $("modelSelect").value);
  // One engine: nothing to choose, the menu is left out (the Monitor names the engine).
  $("modelWrap").hidden = $("modelSelect").options.length < 2;
  for (const [name, id] of Object.entries(CONTROL_WRAPS)) $(id).hidden = !def?.controls.includes(name);
  // One field, two lengths kept apart: a clip's (5 s) and a long take's (30 s, its plan).
  const kind = p === "sequence" ? "take" : "clip";
  if (kind !== lengthKind) { lengths[lengthKind] = $("videoDuration").value; $("videoDuration").value = lengths[kind]; lengthKind = kind; }
  $("videoDuration").max = String(F.lengthMax(p));
  refreshDurationHint();
  brief.placeholder = p === "sequence" ? MOTION_EXAMPLE : SCENARIOS[activeScenario].example;
  document.querySelectorAll(".usecase").forEach(c => c.setAttribute("aria-pressed", String(c.dataset.pipeline === p)));
  refreshGenerateLabel();
  // Another pipeline ends the director session (the saved project stays).
  if (lastPipeline !== null && p !== lastPipeline) D.reset();
  lastPipeline = p;
  updateModelLabel();
}

// Over one clip's length (15 s), a video is a long take: said under the field.
function refreshDurationHint() {
  const p = F.currentPipeline(), v = Number($("videoDuration").value);
  $("durationHint").hidden = p === "sequence" || F.lengthMax(p) <= F.CLIP_MAX || !(v > F.CLIP_MAX);
}

function updateModelLabel() {
  const wf = F.currentWorkflow();
  $("modelLabel").textContent = wf ? t(wf.label) : "—";
  showModelNotice($("modelNotice"), F.workflowEngines(wf));
  $("mossModeWrap").hidden = wf?.engine !== "moss-image";
  // The last frame (FL2VA) belongs to H3 image to video.
  $("lastImageWrap").hidden = wf?.id !== "h3_i2v";
  if ($("lastImageWrap").hidden) $("lastImageInput").value = "";
  const ctx = F.refCtx(wf);
  $("refExtrasWrap").hidden = !ctx;
  for (const [cls, on] of [[".r2v-only", ctx === "r2v"], [".i2i-only", ctx === "i2i"], [".seq-only", ctx === "seq"],
                           [".sheets-only", ctx === "seq" || ctx === "r2v"]])
    document.querySelectorAll(`#refExtrasWrap ${cls}, #imageInputWrap ${cls}`).forEach(el => { el.hidden = !on; });
  // A long take's input image is its first frame, and its list is its references. Where the
  // form takes both, the gallery offers both (CSS on body[data-gallery-use]).
  const both = { seq: "first", i2i: "both" }[ctx];
  if (both) document.body.dataset.galleryUse = both;
  else delete document.body.dataset.galleryUse;
  tx($("imageInputLabel"), ctx === "seq" ? "First frame (optional)" : "Input image");
  tx($("refExtrasTitle"), ctx === "seq" ? "References (optional)" : ctx === "r2v" ? "References" : "Extra references");
  if (ctx === "r2v") tx($("refCapLabel"), "Up to 9 images, 3 clips and 3 sounds (12 in all)");
  else tx($("refCapLabel"), ctx === "seq" ? "Reference images (at most {max})" : "Extra reference images (at most {max})", { max: F.REF_CAPS[ctx] || 7 });
  renderRefs();
  renderFormLoras();
  updateResumeButton();
}

// ── Style ─────────────────────────────────────────────────────────────────────
function renderStyleOptions() {
  fillSelect($("styleSelect"), Object.entries(P.STYLE_PACKS).map(([id, s]) => [id, s.label]), $("styleSelect").value || "cinematic");
}

// ── Input image ───────────────────────────────────────────────────────────────
let selectedAsset = null;   // gallery asset chosen as input: {ref, filename}
function setSelectedAsset(a) {
  selectedAsset = { ref: a.ref, filename: a.filename };
  tx($("assetChipName"), "Gallery: {name}", { name: a.filename });
  $("assetChip").hidden = false;
  $("imageInput").value = "";
  if (!["image2image", "image2video", "sequence"].includes(F.currentPipeline())) usePipeline("image2image");
  log("req", "{name} chosen as the input image.", { name: a.filename });
}
function clearSelectedAsset() { selectedAsset = null; $("assetChip").hidden = true; }
// "→ Use as input" from the gallery goes to the pipeline on screen: the input
// image (a long take's first frame), or the reference list (reference to video also takes clips). A pipeline
// with none of them opens its image counterpart (Image2Video from Text2Video, else
// Image2Image) with the image; a clip it cannot take is refused. No job either way.
function useAsInput(a) {
  const video = a.type === "video", ctx = F.refCtx();
  if (!video && F.hasControl("image")) setSelectedAsset(a);
  else if (ctx && (!video || ctx === "r2v")) useAsRef(a);
  else if (video) notice(false, "This pipeline takes no clip: a clip is a reference of “Video from references”.");
  else {
    usePipeline(F.currentPipeline() === "text2video" ? "image2video" : "image2image");
    setSelectedAsset(a);
  }
}

function useAsRef(a) {
  const before = F.refList().length;
  addRefs([{ name: a.filename, ref: a.ref }]);
  if (F.refList().length > before) notice(true, "{name} added ({n}/{max}).", { name: a.filename, n: F.refList().length, max: refMax() });
}

async function inputImageRef() {
  if (selectedAsset) return selectedAsset.ref;
  const file = $("imageInput").files[0];
  if (!file) throw new Error(t("Choose an input image (a file, or a gallery image with “→ Use as input”)."));
  return F.imageRef({ name: file.name, blob: file });
}
const hasInputImage = () => !!selectedAsset || !!$("imageInput").files[0];
// A long take's two image fields: the first frame (the input image, optional) and its
// references, each with its role.
async function longTakeImages() {
  const file = $("imageInput").files[0];
  const first = selectedAsset ? { name: selectedAsset.filename, ref: selectedAsset.ref } : file ? { name: file.name, blob: file } : null;
  return { first, refs: F.refList("seq").slice(0, F.REF_CAPS.seq).map(it => ({ ...it, kind: F.itemRole(it) })) };
}

// A long take: the long take pipeline, or a video longer than one H3 clip (Text2Video,
// Image2Video, Video from references). Its images keep their roles: Image2Video's image is the
// first frame and its end image the last segment's; the images of Video from references are
// references (a long take takes no clip or sound). Generate opens it at the length asked, the
// brief split into segments: nothing renders before "Generate the chain".
async function longTake(wf, seed) {
  const total = F.formLength();
  let images = { first: null, refs: [] }, end = null;
  if (wf.pipeline === "sequence") images = await longTakeImages();
  else if (wf.pipeline === "image2video") {
    images.first = (await longTakeImages()).first;
    if (!images.first) throw new Error(t("Choose an input image (a file, or a gallery image with “→ Use as input”)."));
    const lastFile = $("lastImageInput").files[0];
    if (lastFile) end = { ref: await F.imageRef({ name: lastFile.name, blob: lastFile }), name: lastFile.name };
  } else if (wf.pipeline === "reference2video") {
    const list = F.refList("r2v"), imgs = list.filter(it => F.itemMedia(it) === "image");
    if (!imgs.length)
      throw new Error(t("Add at least one reference image or clip: a photo or a sheet of the subject, or make a sheet from the brief."));
    const left = list.length - Math.min(imgs.length, D.LONG_TAKE_REFS);
    if (left) log("warn", "A long take takes up to {max} reference images, no clip or sound: {n} reference(s) left out.", { max: D.LONG_TAKE_REFS, n: left });
    images.refs = imgs.slice(0, D.LONG_TAKE_REFS).map(it => ({ ...it, kind: F.itemRole(it) }));
  }
  if (wf.pipeline !== "sequence")
    log("ok", "{n} s is longer than one clip (15 s at most): the video is made as a long take, its segments chained. Read them, then generate the chain.", { n: total });
  await D.startLongTake(seed, { ...images, from: wf.pipeline === "sequence" ? null : wf.pipeline });
  await D.splitLongTake(total, { end, scenes: launchingCard });
}

// ── Target markets ────────────────────────────────────────────────────────────
const selectedMarkets = new Set();
function renderMarkets() {
  $("marketChips").replaceChildren(...Object.entries(G.MARKETS).map(([id, m]) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "market-chip";
    chip.textContent = m.label;
    chip.classList.toggle("active", selectedMarkets.has(id));
    chip.setAttribute("aria-pressed", String(selectedMarkets.has(id)));
    chip.addEventListener("click", () => {
      if (selectedMarkets.has(id)) selectedMarkets.delete(id); else selectedMarkets.add(id);
      chip.classList.toggle("active", selectedMarkets.has(id));
      chip.setAttribute("aria-pressed", String(selectedMarkets.has(id)));
    });
    return chip;
  }));
  translateTree($("marketChips"));
}

const txAria = (el, text) => { el.setAttribute("aria-label", text); el.title = text; };

// ── References and H3 subjects ────────────────────────────────────────────────
// Video from references also takes clips and sounds (9 images, 3 clips, 3 sounds, 12 in
// all); the other lists take images only. A reference image's role is first a character,
// then an object, as on the assistant's card; the user changes it on its row.
function addRefs(items) {
  const ctx = F.refCtx(), list = F.refList(ctx);
  if (!ctx) return;
  if (ctx !== "r2v") {
    const max = F.REF_CAPS[ctx], room = Math.max(0, max - list.length);
    list.push(...items.slice(0, room));
    if (items.length > room) notice(false, "At most {max} images here: the extra ones were ignored.", { max });
  } else {
    const room = Object.fromEntries(Object.entries(F.R2V_MEDIA_CAPS).map(([m, max]) => [m, max - list.filter(it => F.itemMedia(it) === m).length]));
    let total = F.R2V_MAX_REFS - list.length;
    const kept = items.filter(it => total > 0 && room[F.itemMedia(it)]-- > 0 && total-- > 0);
    for (const it of kept) {
      if (!it.kind && F.itemMedia(it) === "image") it.kind = list.some(x => F.itemMedia(x) === "image") ? "object" : "character";
      list.push(it);
    }
    if (kept.length < items.length) notice(false, "At most 9 images, 3 clips and 3 sounds here (12 in all): the extra files were ignored.");
  }
  renderRefs();
}

// Subjects of the next Ref2VA job, in their order; a clip can be a subject too.
const SUBJECT_KINDS = { character: L("character"), environment: L("setting"), reference: L("reference") };
const plannedSubjects = () => F.r2vPlan().entries.filter(e => SUBJECT_KINDS[e.kind]).map(e => e.kind);

// Sheets of the references (a long take, a video from references), from the brief or from
// a character photo: one click, one job; the sheet joins the references (a photo's sheet
// takes the photo's place). No approval step.
let sheetBusy = false;
async function makeSheet(kind, photo = null) {
  if (sheetBusy) return;
  const ctx = F.refCtx();
  sheetBusy = true;
  const btns = [$("seqCharSheetBtn"), $("seqSetSheetBtn")];
  btns.forEach(b => { b.disabled = true; });
  renderRefs();
  try {
    const ref = await D.referenceSheet(kind, photo, ctx === "r2v" ? "reference2video" : "relay");
    const list = F.refList(ctx);
    const item = { name: ref.split("/").pop(), ref, kind: kind === "setting" ? "setting" : "character", sheet: true };
    const at = photo ? list.indexOf(photo) : -1;
    const max = ctx === "r2v" ? F.R2V_MEDIA_CAPS.image : F.REF_CAPS.seq;
    const room = ctx === "r2v" ? list.filter(it => F.itemMedia(it) === "image").length < max && list.length < F.R2V_MAX_REFS
                               : list.length < max;
    if (at >= 0) list.splice(at, 1, item);
    else if (room) list.push(item);
    else notice(false, "At most {max} images here: the extra ones were ignored.", { max });
    log("ok", kind === "setting" ? "Setting sheet added to the references." : "Subject sheet added to the references.");
  } catch (err) { warn(err); } finally {
    sheetBusy = false;
    btns.forEach(b => { b.disabled = false; });
    renderRefs();
  }
}

function renderRefs() {
  const ctx = F.refCtx(), plan = ctx === "r2v" ? F.r2vPlan() : null;
  $("refImagesInput").accept = ctx === "r2v" ? "image/*,video/*,audio/*" : "image/*";
  $("refSubjects").replaceChildren(...F.refList(ctx).map((img, i) => {
    const row = document.createElement("div");
    row.className = "ref-subject ref-removable";
    const tag = document.createElement("div");
    tag.className = "rs-tag";
    const entry = plan?.entries.find(e => e.item === img);
    if (ctx === "i2i") tag.textContent = `<image${i + 2}>`;
    else if (ctx === "seq") tx(tag, "Reference {n}", { n: i + 1 });
    else if (!entry) { tx(tag, "Not sent (over the limit)"); row.classList.add("ref-ignored"); }
    else {
      const [, word, n] = /^<(\w+) (\d+)>$/.exec(entry.label);
      tx(tag, word === "Subject" ? "Subject {n}" : word === "Video" ? "Clip {n}" : "Sound {n}", { n: +n });
    }
    const name = document.createElement("div");
    name.className = "rs-name";
    name.dataset.raw = "";
    name.textContent = img.name;
    const x = document.createElement("button");
    x.type = "button"; x.className = "rs-x"; x.textContent = "✕";
    txAria(x, "Remove this reference");
    x.addEventListener("click", () => { F.refList(ctx).splice(i, 1); renderRefs(); });
    row.append(tag, name);
    // Each reference has a role (character, setting or object; a clip's camera movement; a
    // sound's voice, music or ambience), which decides its label: redraw on change.
    if (ctx === "r2v" || ctx === "seq") {
      const role = document.createElement("select");
      role.className = "rs-role";
      fillSelect(role, F.MEDIA_KINDS[F.itemMedia(img)].map(k => [k, t(F.REF_KINDS[k][1])]), F.itemRole(img));
      txAttr(role, "aria-label", "Role of this reference in the clip");
      role.addEventListener("change", () => { img.kind = role.value; renderRefs(); });
      row.appendChild(role);
    }
    // A character photo can become its sheet (five views), in its place.
    if ((ctx === "seq" || ctx === "r2v") && F.itemMedia(img) === "image" && F.itemRole(img) === "character" && !img.sheet) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "rs-sheet"; b.textContent = "✨ Sheet";
      txAttr(b, "title", "Draws a five-view sheet of this photo's subject (Qwen Image 2.1, one job); the sheet takes the photo's place");
      b.disabled = sheetBusy;
      b.addEventListener("click", () => makeSheet("char", img));
      row.appendChild(b);
    }
    row.appendChild(x);
    return row;
  }));
  translateTree($("refSubjects"));
  renderSubjectChips();
}

// Chips that insert a <Subject N> token at the cursor: the only way to tell H3 which
// subject does what when several act in one shot. The app numbers the subjects.
function renderSubjectChips() {
  const box = $("subjectChips"), on = F.currentPipeline() === "reference2video";
  box.hidden = !on;
  box.replaceChildren(...(on ? plannedSubjects() : []).map((kind, i) => {
    const b = document.createElement("button");
    b.type = "button";
    tx(b, "Subject {n} · {kind}", { n: i + 1, kind: t(SUBJECT_KINDS[kind]) });
    txAria(b, "Insert this subject's label in the brief");
    // mousedown cancelled: the textarea keeps its focus and its cursor.
    b.addEventListener("mousedown", e => e.preventDefault());
    b.addEventListener("click", () => {
      const start = brief.selectionStart ?? brief.value.length, end = brief.selectionEnd ?? start;
      const token = P.h3Subject(i + 1);
      brief.value = brief.value.slice(0, start) + token + brief.value.slice(end);
      brief.focus();
      brief.setSelectionRange(start + token.length, start + token.length);
    });
    return b;
  }));
  translateTree(box);
}

// ── Drag and drop: gallery or computer → image inputs ─────────────────────────
// Each zone reuses its field's own path ("→ Use as input", a file chosen with the
// browser, "➕ Sequence"). A drop starts no job, calls no LLM and writes no brief.
const dragHas = e => { const ty = e.dataTransfer?.types; return !!ty && (ty.includes("Files") || ty.includes("application/json")); };
function dragAsset(e) {
  try { const a = JSON.parse(e.dataTransfer.getData("application/json")); return a?.ref ? a : null; }
  catch { return null; }
}
async function assetFile(a) {
  const blob = await F.imageBlob({ ref: a.ref });
  return new File([blob], a.filename, { type: blob.type });
}
function setInputFile(input, file) {
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}
// `max()` = 1: a one-image field (replaced); otherwise a cap, `count()` images already
// there (drops add up). `put(file)` places a file; `putAsset(asset)` a gallery image.
function dropZone(el, { max = () => 1, count = () => 0, put, putAsset, media = () => false }) {
  el.classList.add("drop-zone");
  const hint = document.createElement("span");
  hint.className = "drop-hint";
  hint.setAttribute("aria-hidden", "true");
  tx(hint, "Drop the image here");
  el.appendChild(hint);
  translateTree(hint);
  let depth = 0, chain = Promise.resolve();
  const off = () => { depth = 0; el.classList.remove("drop-over"); };
  async function handle(files, asset) {
    let items = files.length ? files.map(file => ({ file, name: file.name, type: file.type })) : asset ? [{ asset, name: asset.filename, type: asset.type }] : [];
    const refusals = [];
    const clips = media();  // a zone that also takes clips and sounds
    items = items.filter(it => {
      if (!clips && (it.type === "video" || /^video\//.test(it.type))) { refusals.push(["A video cannot go here: drop an image."]); return false; }
      if (it.file && !(/^image\//.test(it.type) || (clips && /^(video|audio)\//.test(it.type)))) {
        if (clips) refusals.push([L("{name} is not an image, a clip or a sound."), { name: it.name }]);
        else refusals.push(["{name} is not an image.", { name: it.name }]);
        return false;
      }
      return true;
    });
    const mono = max() === 1;
    if (mono && items.length > 1) { refusals.push(["One image only here: the first one was kept."]); items = items.slice(0, 1); }
    const over = mono ? 0 : Math.max(0, items.length - Math.max(0, max() - count()));
    if (over) { refusals.push(["At most {max} images here: the extra ones were ignored.", { max: max() }]); items = items.slice(0, items.length - over); }
    for (const it of items) {
      try {
        if (it.file) put(it.file);
        else if (putAsset) putAsset(it.asset);
        else put(await assetFile(it.asset));
      } catch { refusals.push(["{name} could not be read.", { name: it.name }]); continue; }
      if (mono) notice(true, "{name} added.", { name: it.name });
      else notice(true, "{name} added ({n}/{max}).", { name: it.name, n: count(), max: max() });
    }
    // Refusals last: the banner keeps the last message.
    for (const [text, params] of refusals) notice(false, text, params);
  }
  el.addEventListener("dragenter", e => { if (!dragHas(e)) return; e.preventDefault(); depth++; el.classList.add("drop-over"); });
  el.addEventListener("dragover", e => { if (!dragHas(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
  el.addEventListener("dragleave", () => { if (--depth <= 0) off(); });
  el.addEventListener("drop", e => {
    if (!dragHas(e)) return;
    e.preventDefault();
    off();
    // Read now: the DataTransfer empties after the event. Drops queue up, so a cap
    // counts them in order.
    const files = [...e.dataTransfer.files], asset = dragAsset(e);
    chain = chain.then(() => handle(files, asset)).catch(warn);
  });
}
const refMax = () => F.refCtx() === "r2v" ? F.R2V_MAX_REFS : F.REF_CAPS[F.refCtx()] || 0;
function initDrops() {
  dropZone($("imageInputWrap"), { put: f => setInputFile($("imageInput"), f), putAsset: setSelectedAsset });
  dropZone($("lastImageWrap"), { put: f => setInputFile($("lastImageInput"), f) });
  dropZone($("refDropZone"), {
    // Video from references: clips and sounds too, capped per media and in all by addRefs.
    media: () => F.refCtx() === "r2v",
    max: refMax,
    count: () => F.refList().length,
    put: f => addRefs([{ name: f.name, blob: f }]),
    putAsset: a => addRefs([{ name: a.filename, ref: a.ref }]),
  });
  // A missed drop does nothing: no navigation to the file, no text pasted in the
  // brief. A native file input (LoRA) keeps its own drop.
  for (const type of ["dragover", "drop"]) document.addEventListener(type, e => {
    if (e.defaultPrevented || !dragHas(e) || e.target.closest?.('input[type="file"]')) return;
    e.preventDefault();
    if (type === "dragover") e.dataTransfer.dropEffect = "none";
  });
}

// ── Brief enrichment ──────────────────────────────────────────────────────────
let autoEnrich = false;
async function enrich(wf) {
  $("stepEnrich").classList.add("active");
  try {
    await F.loadInstructions();
    const out = await P.enrichBrief(F.llm, wf, brief.value, P.styleTextFor(F.currentStyleId()), promptLog);
    // No engine of this studio encodes a negative prompt: only the brief is written back.
    if (out) brief.value = out.brief;
  } finally { $("stepEnrich").classList.remove("active"); }
}
function renderAutoEnrich() {
  const b = $("autoEnrichBtn");
  b.classList.toggle("active", autoEnrich);
  b.setAttribute("aria-pressed", String(autoEnrich));
  tx(b, autoEnrich ? "✨ Auto enrichment ({llm}): on" : "✨ Auto enrichment ({llm}): off", { llm: LLM });
}

// ── Generate ──────────────────────────────────────────────────────────────────
// A refusal of Generate shows under the button too, not only in the log; the next
// click clears it.
function generateError(message) {
  const el = $("generateError");
  el.textContent = message || "";
  el.hidden = !message;
}

async function generate() {
  generateError("");
  const wf = F.currentWorkflow();
  if (!wf) { log("warn", "No engine selected."); generateError(t("No engine selected.")); return; }
  // An empty brief starts nothing (the example is a placeholder), except local
  // versions, whose prompts come from the chosen markets.
  if (!F.brief() && !(wf.pipeline === "image2image" && selectedMarkets.size)) {
    log("warn", "Empty brief: describe what you want before generating.");
    generateError(t("Empty brief: describe what you want before generating."));
    brief.focus();
    return;
  }
  // A length out of range is said, never brought silently into range; over one clip's
  // length, the video is a long take.
  let long;
  try { long = F.hasControl("duration") && F.longVideo(); }
  catch (err) { generateError(err.message); return; }
  const btn = $("generateBtn");
  btn.disabled = true;
  // The director's first step and the auto enrichment wait on Gemma before any job:
  // the button says so, with the time spent.
  const busy = ((long && hasInputImage()) || ((long || wf.pipeline === "reference2video") && F.refList().some(it => F.itemMedia(it) === "image")))
    ? L("{llm} is describing the images… {time}")
    : autoEnrich && wf.enrich !== "builtin" ? L("{llm} is enriching the brief… {time}") : null;
  const start = Date.now();
  const tick = () => {
    const s = Math.floor((Date.now() - start) / 1000);
    tx(btn, busy, { llm: LLM, time: `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` });
  };
  const timer = busy ? (tick(), setInterval(tick, 1000)) : 0;
  try {
    // A long take's screenplay in the H3 layout is read as written: never enriched.
    const written = wf.pipeline === "sequence" && !!P.parseScreenplay(F.brief());
    if (autoEnrich && wf.enrich !== "builtin" && !written) {
      log("req", "Auto enrichment of the brief with {llm}…", { llm: LLM });
      await enrich(wf);
    } else if (autoEnrich) log("sys", "{workflow} builds its own prompts: brief sent as it is.", { workflow: t(wf.label) });
    const seed = F.formSeed();
    if (long) await longTake(wf, seed);
    else if (wf.pipeline === "reference2video") await generateR2V(seed);
    else if (wf.pipeline === "campaign") generateCampaign(seed);
    else await generatePlain(wf, seed);
  } catch (err) { warn(err); generateError(err?.message ?? String(err)); }
  finally {
    clearInterval(timer);
    if (busy) refreshGenerateLabel();
    btn.disabled = false;
  }
}

// Text and image to image, text and image to video; one job per market for local versions.
async function generatePlain(wf, seed) {
  const styleText = P.styleTextFor(F.currentStyleId());
  const withStyle = s => (styleText ? `${s} ${styleText}` : s);
  const markets = wf.pipeline === "image2image" ? [...selectedMarkets] : [];
  const specs = markets.length
    ? markets.map(id => ({ prompt: withStyle(G.marketPrompt(F.brief(), id)), label: ["{workflow} · {market}", { workflow: t(wf.label), market: t(G.MARKETS[id].label) }] }))
    : [{ prompt: withStyle(F.brief()), label: [wf.label] }];
  const count = clampInt($("variants").value, 1, 4, 1), duration = F.formDuration(), loras = F.formLoras();
  let image = null, last = null, refs = [];
  if (wf.pipeline === "image2image" || wf.pipeline === "image2video") image = await inputImageRef();
  // <image2>… : uploaded once, shared by every market.
  if (wf.id === "qwen21_i2i") refs = await F.refRefs("i2i");
  const lastFile = $("lastImageInput").files[0];
  if (wf.id === "h3_i2v" && lastFile) last = await F.imageRef({ name: lastFile.name, blob: lastFile });
  G.runPlain(wf, { specs, origin: markets.length ? "markets" : "studio", ratio: $("ratioSelect").value,
    count, duration, loras, image, last, refs, seed, mode: $("mossModeSelect").value }).forEach(detach);
}

// Video from references: one H3 Ref2VA job on the list, each reference in its role and
// under its H3 label; Gemma's vision describes each image first. Nothing to review.
async function generateR2V(seed) {
  const { entries, dropped } = F.r2vPlan();
  if (!entries.some(e => e.media !== "audio"))
    throw new Error(t("Add at least one reference image or clip: a photo or a sheet of the subject, or make a sheet from the brief."));
  if (dropped) log("warn", "References limited to 9 images, 3 clips and 3 sounds: {n} ignored.", { n: dropped });
  const prompt = await F.r2vPrompt(entries, F.brief());
  const references = await Promise.all(entries.map(e => F.imageRef(e.item)));
  const duration = F.formDuration();
  detach(runJob("h3-r2v", { prompt, duration, seed, loras: F.formLoras(), aspect: $("ratioSelect").value, references }, {
    origin: "reference2video", label: ["Video from references (MiniMax H3)"],
    sub: ["{info} · seed {seed}", { info: `${duration} s · ${references.length} ref.`, seed }] }));
}

// Posters, thumbnails and a social image (Krea 2), plus a vertical H3 teaser.
function generateCampaign(seed) {
  G.runCampaign({ text: F.brief(), styleId: F.currentStyleId(), count: clampInt($("variants").value, 1, 4, 3),
    duration: F.formDuration(), seed }).forEach(detach);
}

// ── Assistant cards opened in the form ────────────────────────────────────────
// A card of the assistant taken over by the form: pipeline, engine, settings, images
// and the brief, on the user's click. Starts nothing; Undo puts the brief and the
// pipeline back (the images stay, as with "Reuse the prompt").
const CARD_FORM = {
  create_image: a => ["text2image", CARD_IMAGE_WORKFLOWS[a.engine] || "krea2_t2i", a.prompt],
  edit_image: a => ["image2image", "qwen21_i2i", a.instruction],
  video_from_text: a => ["text2video", "h3_t2v", a.prompt],
  video_from_image: a => ["image2video", "h3_i2v", a.prompt],
  long_take: a => ["sequence", "h3_sequence", a.screenplay],
  campaign: a => ["campaign", "campaign", a.brief],
  reference_video: a => ["reference2video", "h3_r2v", r2vCardBrief(a)],
};
async function openCardInForm(tool, a, image, quiet = false) {
  setMode("studio");
  D.exitStudio();  // the form, not a director session left open (it stays in the session bar)
  const [pipeline, wfId, text] = CARD_FORM[tool](a);
  const before = { brief: brief.value, scenario: activeScenario, pipeline: F.currentPipeline(), wf: $("modelSelect").value };
  const scenario = F.pipelineDef(pipeline).scenario?.[0] || (pipeline === "image2image" ? "localization" : "campaign");
  selectScenario(scenario, pipeline);
  $("modelSelect").value = wfId;
  updateModelLabel();
  if (a.ratio) $("ratioSelect").value = a.ratio;
  if (a.mode) $("mossModeSelect").value = a.mode;
  if (a.count || a.variants) $("variants").value = a.count || a.variants;
  if (a.duration || a.total) { $("videoDuration").value = a.duration || a.total; refreshDurationHint(); }
  if (a.style && F.hasControl("style")) $("styleSelect").value = a.style;
  const img = id => image(id) && { name: image(id).name, ref: image(id).ref };
  if (a.image) setSelectedAsset({ ref: img(a.image).ref, filename: img(a.image).name });
  // A long take's first frame is the input image: none on the card, none in the form.
  if (tool === "long_take") {
    if (a.first_frame) setSelectedAsset({ ref: img(a.first_frame).ref, filename: img(a.first_frame).name });
    else { clearSelectedAsset(); $("imageInput").value = ""; }
  }
  if (a.last_image) setInputFile($("lastImageInput"), await assetFile({ ref: img(a.last_image).ref, filename: img(a.last_image).name }));
  if (tool === "edit_image") {
    F.refList("i2i").splice(0, Infinity, ...(a.references || []).map(img));
    selectedMarkets.clear();
    for (const m of a.markets || []) selectedMarkets.add(m);
    renderMarkets();
  }
  if (tool === "reference_video")
    F.refList("r2v").splice(0, Infinity, ...(a.references || []).map((id, i) => ({ ...img(id), kind: a.kinds?.[i] })));
  if (tool === "long_take")
    F.refList("seq").splice(0, Infinity, ...(a.references || []).map((id, i) => ({ ...img(id), kind: a.kinds?.[i] })));
  renderRefs();
  brief.value = text;
  if (quiet) return;
  log("sys", "Assistant card opened in the Studio form: nothing starts before Generate.");
  undoToast("Card opened in the Studio form.", {}, () => {
    brief.value = before.brief;
    selectScenario(before.scenario, before.pipeline);
    if ([...$("modelSelect").options].some(o => o.value === before.wf)) { $("modelSelect").value = before.wf; updateModelLabel(); }
  });
  brief.scrollIntoView({ behavior: "smooth", block: "center" });
}

// A long take card's own button: the form takes the card over, then its click is the
// Generate click, which opens the long take, at the card's length, its screenplay split into
// segments (Gemma; nothing renders before "Generate the chain").
let launchingCard = false;
async function launchDirector(tool, a, image) {
  await openCardInForm(tool, a, image, true);
  log("sys", "Director started from an assistant card.");
  window.scrollTo({ top: 0, behavior: "smooth" });
  launchingCard = true;
  try { await generate(); } finally { launchingCard = false; }
}

// ── Modes ─────────────────────────────────────────────────────────────────────
// Assistant (the first one) and Studio share the page; the Canvas is its own page. The
// library (job queue and gallery) moves to the mode shown. The address (#assistant,
// #studio) and the last mode used choose the mode at load.
const MODES = ["assistant", "studio"];
const MODE_KEY = "mode";
function setMode(mode) {
  if (!MODES.includes(mode)) mode = "assistant";
  const was = document.body.dataset.mode;
  document.body.dataset.mode = mode;
  document.querySelectorAll(".rail-mode").forEach(b => {
    b.classList.toggle("active", b.dataset.mode === mode);
    if (b.dataset.mode === mode) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  const home = mode === "assistant" ? $("assistantLibraryBody") : document.querySelector(".output-panel");
  home.append($("jobQueue"), $("galleryBlock"));
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* this page only */ }
  if (location.hash !== `#${mode}`) history.replaceState(null, "", `#${mode}`);
  if (mode === "assistant") showAssistant();
  if (was && was !== mode) window.scrollTo({ top: 0 });
}
function initialMode() {
  const hash = location.hash.slice(1);
  if (MODES.includes(hash)) return hash;
  try { return localStorage.getItem(MODE_KEY) || "assistant"; } catch { return "assistant"; }
}
const inAssistant = () => document.body.dataset.mode === "assistant";

// ── Project buttons (resume, cancel) ──────────────────────────────────────────
function updateResumeButton() {
  $("resumeProjectBtn").hidden = !(D.hasSavedProject() && D.savedPipelines().includes(F.currentPipeline()));
  updateCancelButton();
}
function updateCancelButton() {
  const show = runningJobs() > 0 || D.active();
  $("cancelProjectBtn").hidden = !show;
  $("studioCancelBtn").hidden = !show;
  $("resumeWrap").hidden = $("resumeProjectBtn").hidden && $("cancelProjectBtn").hidden;
}
async function cancelProject(btn) {
  if (!confirm(t("Stop the generation in progress and empty the job queue?"))) return;
  btn.disabled = true;
  try {
    const n = await cancelAll();
    D.reset();
    log("ok", "Project cancelled: {n} job(s) stopped.", { n });
  } finally { btn.disabled = false; updateCancelButton(); }
}

// ── Models, LoRAs, update ─────────────────────────────────────────────────────
const modelRows = new Map();   // model id → <small> of its row
async function loadModels() {
  let list;
  try { list = await api.models(); }
  catch (err) { tx($("mmState"), "Offline"); warn(err); return; }
  modelRows.clear();
  $("modelList").replaceChildren(...list.map(m => {
    const row = document.createElement("div");
    row.className = "model";
    const name = document.createElement("strong");
    name.dataset.raw = "";
    name.textContent = m.label;
    const state = document.createElement("small");
    modelRows.set(m.id, state);
    row.append(name, state);
    if (m.installed) tx(state, m.qualified ? "Installed" : "Installed · not qualified yet");
    else if (m.progress != null) tx(state, "Downloading {pct}", { pct: pct(Math.round(m.progress * 100)) });
    else {
      tx(state, m.gated ? "Not downloaded · gated (accept the licence on Hugging Face)" : "Not downloaded");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "secondary-btn";
      tx(b, "Download");
      b.addEventListener("click", async () => {
        b.disabled = true;
        try { await api.downloadModel(m.id); tx(state, "Downloading {pct}", { pct: pct(0) }); log("req", "Downloading {name}…", { name: m.label }); }
        catch (err) { b.disabled = false; warn(err); }
      });
      row.appendChild(b);
    }
    return row;
  }));
  tx($("mmState"), "{n}/{total} installed", { n: list.filter(m => m.installed).length, total: list.length });
}
function onModelEvent(msg) {
  const state = modelRows.get(msg.id);
  if (msg.error) { log("warn", "{id}: {error}", { id: msg.id, error: msg.error }); loadModels(); return; }
  if (state) tx(state, "Downloading {pct}", { pct: pct(Math.round((msg.progress || 0) * 100)) });
  if (msg.progress >= 1) { log("ok", "{id} downloaded.", { id: msg.id }); loadModels(); }
}

// Gemma instructions: the default of each engine (web/js/prompts.js) or the user's text,
// stored by the server (/api/instructions). Drafts survive switching engines until saved.
const INSTRUCTION_LABELS = {
  krea2: L("Krea 2 (image from a text, campaign)"),
  qwen21: L("Qwen Image 2.1 (image from a text, image editing)"),
  h3_video: L("MiniMax H3 (video from a text or an image, sequence)"),
  h3_r2v: L("MiniMax H3 (video from references)"),
  storyboard: L("Storyboard brief (sheets and shots)"),
};
let instrSaved = {};
const instrDrafts = {};
async function loadInstructionPanel() {
  try { instrSaved = await api.instructions(); } catch (err) { warn(err); return; }
  fillSelect($("instrSelect"), Object.entries(INSTRUCTION_LABELS), $("instrSelect").value || "krea2");
  showInstruction();
}
function showInstruction() {
  const name = $("instrSelect").value;
  $("instrText").value = instrDrafts[name] ?? instrSaved[name] ?? P.ENRICH_INSTRUCTIONS[name][0];
  checkInstruction();
}
function checkInstruction() {
  const name = $("instrSelect").value, [original, key] = P.ENRICH_INSTRUCTIONS[name], text = $("instrText").value;
  if (text !== (instrSaved[name] ?? original)) instrDrafts[name] = text;
  else delete instrDrafts[name];
  tx($("instrState"), "{n} replaced", { n: Object.keys(instrSaved).length });
  tx($("instrHint"), name in instrDrafts ? "Not saved yet."
    : name in instrSaved ? "Your instruction (replaces the original)." : "Original instruction.");
  // The code still reads the same key and checks the tokens: warn when the text stops asking for them.
  const warns = [];
  if (!text.includes(`"${key}"`)) warns.push([L("The text no longer names the answer key {key}: Gemma may answer without it, and the enrichment is then ignored."), { key: `"${key}"` }]);
  if (name === "h3_r2v" && !text.includes("SUBJECTREF"))
    warns.push([L("The text no longer mentions SUBJECTREF: Gemma may drop the <Subject N> mentions, and the enrichment is then discarded."), {}]);
  $("instrWarn").replaceChildren(...warns.map(([msg, params]) => tx(document.createElement("span"), msg, params)));
  $("instrWarn").hidden = !warns.length;
}
async function saveInstruction(reset) {
  const name = $("instrSelect").value, text = $("instrText").value, original = P.ENRICH_INSTRUCTIONS[name][0];
  const label = t(INSTRUCTION_LABELS[name]);
  try {
    // Saving the original text, or nothing, is the same as restoring it.
    instrSaved = reset || !text.trim() || text === original ? await api.resetInstruction(name) : await api.setInstruction(name, text);
    delete instrDrafts[name];
    log("ok", name in instrSaved ? "Gemma instruction saved: {engine}." : "Original Gemma instruction restored: {engine}.", { engine: label });
    showInstruction();
  } catch (err) { warn(err); }
}

// The LoRA stack of the form follows the current workflow's folder (F.loraFolder).
function renderFormLoras() {
  const folder = F.loraFolder(F.currentWorkflow());
  $("loraWrap").hidden = !folder;
  if (folder) renderLoraStack($("loraStack"), { folder, stack: F.loraStack(folder) });
}
async function loadLoras() {
  let listing = {};
  try { listing = await api.loras(); } catch (err) { warn(err); }
  setLoraFiles(listing);
  const folders = Object.keys(listing);
  fillSelect($("loraFolderSelect"), folders.map(f => [f, LORA_FOLDERS[f] || f]), $("loraFolderSelect").value);
  $("loraList").replaceChildren(...folders.flatMap(folder => listing[folder].map(l => {
    const row = document.createElement("div");
    row.className = "model";
    row.innerHTML = `<strong data-raw></strong><small data-raw></small>`;
    row.querySelector("strong").textContent = l.name;
    row.querySelector("small").textContent = `${LORA_FOLDERS[folder] || folder} · ${(l.size / 2 ** 20).toFixed(1)} MiB`;
    return row;
  })));
  renderFormLoras();
}
// A file whose name starts with an engine prefix (H3_, Qwen_2.1, Krea_2, Moss_) goes to that
// engine's folder: the folder select follows it and is locked while that file is chosen.
function syncLoraFolder() {
  const file = $("loraFile").files[0], named = file ? folderForName(file.name) : null;
  if (named) $("loraFolderSelect").value = named;
  $("loraFolderSelect").disabled = !!named;
  $("loraUploadStatus").textContent = named ? t("Goes to the {engine} folder (from its name).", { engine: LORA_FOLDERS[named] || named }) : "";
}
async function uploadLoraFile() {
  const file = $("loraFile").files[0], status = $("loraUploadStatus");
  const folder = (file && folderForName(file.name)) || $("loraFolderSelect").value;
  if (!file) { log("warn", "No LoRA file selected."); return; }
  if (!file.name.toLowerCase().endsWith(".safetensors")) { log("warn", "{name} refused: a .safetensors file is required.", { name: file.name }); return; }
  $("loraUploadBtn").disabled = true;
  try {
    await uploadLora(file, folder, frac => { status.textContent = pct(Math.round(frac * 100)); });
    log("ok", "LoRA {name} uploaded.", { name: file.name });
    $("loraFile").value = "";
    loadLoras();
    syncLoraFolder();
  } catch (err) { log("warn", "LoRA upload failed: {error}", { error: err.message }); }
  finally { status.textContent = ""; $("loraUploadBtn").disabled = false; }
}

// Bare metal: the server pulls and restarts in place. Docker (mode "docker"): the updater
// service pulls, rebuilds the image, waits for the queue to empty and recreates the studio
// container; the page follows its state, then reloads.
const UPDATE_STEPS = {
  building: L("Building the new image: a few minutes, longer when dependencies changed. The studio keeps working meanwhile."),
  waiting: L("New image ready: the studio restarts once the running jobs are done."),
  restarting: L("Restarting…"),
};
const shortSha = h => (h || "").slice(0, 7);
let followingUpdate = false;
function showUpdate(s) {
  const log = $("updateLog"), last = (s.log || []).at(-1);
  log.hidden = !(s.state && s.state !== "idle" && last);
  log.textContent = last || "";   // build output, in English
  $("updateBtn").hidden = !s.available || (s.state && s.state !== "idle");
  // The updater never rebuilds itself: say so when the repository holds a newer one.
  const stale = $("updaterStale");
  stale.hidden = !s.updater_stale;
  if (s.updater_stale) {
    tx(stale, "The update service itself changed: in the repository folder on the machine, run {command}.",
       { command: "docker compose up -d --build updater" });
  }
  if (s.state && s.state !== "idle") {
    tx($("updateState"), "Running");
    tx($("updateText"), UPDATE_STEPS[s.state] || "Restarting…");
  } else if (s.error) {
    tx($("updateState"), "Failed");
    $("updateText").textContent = s.error;   // server text, in English
  } else if (s.available && s.message) {
    tx($("updateState"), "Available");
    $("updateText").textContent = s.message;
  } else if (s.available) {
    tx($("updateState"), "Available");
    if (s.mode === "docker") {
      tx($("updateText"), "A new version is available ({from} → {to}). The image is rebuilt, then the studio restarts.",
         { from: shortSha(s.running || s.local), to: shortSha(s.remote) });
    } else {
      tx($("updateText"), "A new version is available ({from} → {to}). The server restarts after the update.",
         { from: shortSha(s.local), to: shortSha(s.remote) });
    }
  } else if (s.message) {
    tx($("updateState"), s.mode === "none" ? "Not available" : "Up to date");
    $("updateText").textContent = s.message;   // server text, in English
  } else {
    tx($("updateState"), "Up to date");
    tx($("updateText"), "Version {version} is the latest.", { version: shortSha(s.local) });
  }
}
async function loadUpdate() {
  let s;
  try { s = await api.updateStatus(); }
  catch (err) { tx($("updateState"), "Offline"); tx($("updateText"), "{error}", { error: err.message }); return; }
  showUpdate(s);
  if (s.mode === "docker" && s.state && s.state !== "idle") followRebuild();
}
// Polls the updater until the rebuilt studio answers (reload) or the update failed.
async function followRebuild() {
  if (followingUpdate) return;
  followingUpdate = true;
  try {
    for (let down = 0; down < 200;) {
      await new Promise(res => setTimeout(res, 3000));
      let s;
      try { s = await api.updateStatus(); }
      catch { down++; tx($("updateState"), "Running"); tx($("updateText"), "Restarting…"); continue; }
      if (s.mode !== "docker") { down++; continue; }   // the updater does not answer for now
      down = 0;
      showUpdate(s);
      if (s.state && s.state !== "idle") continue;
      if (!s.error) location.reload();
      return;
    }
    tx($("updateText"), "The server did not come back: check the service on the machine.");
  } finally { followingUpdate = false; }
}
async function applyUpdate() {
  if (!confirm(t("Update the studio now? The server restarts; jobs in progress block the update."))) return;
  const btn = $("updateBtn");
  btn.disabled = true;
  try {
    const r = await api.updateApply();
    if (r.message) $("updateText").textContent = r.message;
    if (!r.updated) { tx($("updateText"), "Already up to date."); return; }
    if (r.rebuilding) {
      showUpdate({ mode: "docker", state: "building" });
      await followRebuild();
      return;
    }
    if (!r.restarting) return;
    tx($("updateText"), "Restarting…");
    // The page reloads once the server answers again.
    for (let i = 0; i < 90; i++) {
      await new Promise(res => setTimeout(res, 2000));
      try { await api.health(); location.reload(); return; } catch { /* still restarting */ }
    }
    tx($("updateText"), "The server did not come back: check the service on the machine.");
  } catch (err) { warn(err); }
  finally { btn.disabled = false; }
}

// ── Monitor ───────────────────────────────────────────────────────────────────
function setGauge(id, value, text) {
  const g = $(id);
  g.querySelector(".arc").style.setProperty("--fill", `${Math.min(100, Math.max(0, value))}%`);
  g.querySelector("strong").textContent = text;
}
const LLM_STATES = { running: L("Ready"), stopped: L("Starts on first use"), exited: L("Stopped") };
// On a GB10 the GPU shares the system memory: the server already reports the system's
// available memory as the GPU's free memory there (LESSONS), the page only names it.
function memoryUse(h) {
  const gpu = h.gpu || {}, mem = h.memory;
  if (!gpu.available) return null;
  const unified = !!(mem && Math.abs(gpu.memory_total - mem.total) / mem.total < 0.05);
  return { unified, used: gpu.memory_total - gpu.memory_free, total: gpu.memory_total };
}
async function pollMonitor() {
  if (document.hidden) return;
  try {
    const h = await api.health();
    tx($("nodeState"), "Live");
    $("nodeDot").classList.remove("offline");
    $("appVersion").textContent = h.version;
    $("gpuName").textContent = h.gpu?.available ? h.gpu.name : t("No GPU");
    tx($("llmState"), LLM_STATES[h.llm] || h.llm);
    const m = memoryUse(h), memText = m ? pct(Math.round(m.used / m.total * 100)) : "—";
    setGauge("gaugeMem", m ? m.used / m.total * 100 : 0, memText);
    const label = m?.unified ? "Unified memory" : "GPU memory";
    tx($("gaugeMem").querySelector("span"), label);
    tx($("sbGpu").firstElementChild, label);
    $("sbGpu").querySelector("strong").textContent = memText;
    const gib = b => (b / 2 ** 30).toLocaleString(LANG, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
    const title = m ? t("{used} / {total} GiB", { used: gib(m.used), total: gib(m.total) }) : "";
    for (const id of ["gaugeMem", "sbGpu"]) $(id).title = title;
    setGauge("gaugeQueue", h.queue * 20, String(h.queue));
  } catch {
    tx($("nodeState"), "Offline");
    $("nodeDot").classList.add("offline");
    $("sbGpu").querySelector("strong").textContent = "—";
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────
function initRail() {
  document.querySelectorAll(".rail-mode").forEach(btn => btn.addEventListener("click", () => setMode(btn.dataset.mode)));
  addEventListener("hashchange", () => { const m = location.hash.slice(1); if (MODES.includes(m)) setMode(m); });
  // One flyout at a time, open until its button is clicked again.
  document.querySelectorAll(".rail-btn[data-panel]").forEach(btn => btn.addEventListener("click", () => {
    const name = btn.classList.contains("active") ? null : btn.dataset.panel;
    document.querySelectorAll(".rail-btn[data-panel]").forEach(b => b.classList.toggle("active", b.dataset.panel === name));
    let open = false;
    document.querySelectorAll(".flyout").forEach(f => { f.hidden = f.dataset.flyout !== name; open ||= !f.hidden; });
    document.querySelector(".app-rail").classList.toggle("expanded", open);
    if (name === "models") { loadModels(); loadLoras(); loadInstructionPanel(); loadRolePanel(); }
    if (name === "monitor") loadUpdate();
  }));
}

function initForm() {
  document.querySelectorAll(".usecase").forEach(card => card.addEventListener("click", () => {
    selectScenario(card.dataset.scenario, card.dataset.pipeline);
    if (card.dataset.scenario === "localization") $("galleryBlock").scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  $("pipelineSelect").addEventListener("change", updateModelOptions);
  $("videoDuration").addEventListener("input", refreshDurationHint);
  $("modelSelect").addEventListener("change", () => { updateModelLabel(); });
  $("assetChipClear").addEventListener("click", clearSelectedAsset);
  $("seqCharSheetBtn").addEventListener("click", () => makeSheet("char"));
  $("seqSetSheetBtn").addEventListener("click", () => makeSheet("setting"));
  $("imageInput").addEventListener("change", () => { if ($("imageInput").files[0]) clearSelectedAsset(); });
  // A screenplay file becomes the brief (Undo puts the old one back); nothing starts.
  $("seqImportBtn").addEventListener("click", () => $("seqImportFile").click());
  $("seqImportFile").addEventListener("change", async () => {
    const file = $("seqImportFile").files[0];
    $("seqImportFile").value = "";
    const text = file ? (await file.text()).trim() : "";
    if (!text) return;
    const before = brief.value;
    brief.value = text;
    const play = P.parseScreenplay(text);
    log("ok", play ? "Screenplay {name} imported: {n} segment(s), opened as written." : "Screenplay {name} imported: Gemma splits it once the long take is open.",
      { name: file.name, n: play?.segments.length || 0 });
    undoToast("Screenplay imported into the brief.", {}, () => { brief.value = before; });
  });
  $("refImagesInput").addEventListener("change", () => {
    addRefs([...$("refImagesInput").files].map(f => ({ name: f.name, blob: f })));
    $("refImagesInput").value = "";
  });
  $("generateBtn").addEventListener("click", generate);
  $("enrichBtn").addEventListener("click", async () => {
    const btn = $("enrichBtn"), wf = F.currentWorkflow();
    if (!wf) return;
    btn.disabled = true;
    log("req", "Enriching the brief with {llm}…", { llm: LLM });
    try { await enrich(wf); }
    catch (err) { log("warn", "Enrichment unavailable: {error}", { error: err.message }); }
    finally { btn.disabled = false; }
  });
  $("autoEnrichBtn").addEventListener("click", () => {
    autoEnrich = !autoEnrich;
    renderAutoEnrich();
    log("sys", autoEnrich ? "Auto enrichment on ({llm})." : "Auto enrichment off ({llm}).", { llm: LLM });
  });
  $("resumeProjectBtn").addEventListener("click", async () => {
    const b = $("resumeProjectBtn");
    b.disabled = true;
    try { await D.restoreProject(); } catch (err) { log("warn", "Restore failed: {error}", { error: err.message }); }
    finally { b.disabled = false; }
  });
  $("cancelProjectBtn").addEventListener("click", () => cancelProject($("cancelProjectBtn")));
  $("studioCancelBtn").addEventListener("click", () => cancelProject($("studioCancelBtn")));
  $("loraUploadBtn").addEventListener("click", uploadLoraFile);
  $("loraFile").addEventListener("change", syncLoraFolder);
  $("instrSelect").addEventListener("change", showInstruction);
  $("instrText").addEventListener("input", checkInstruction);
  $("instrSave").addEventListener("click", () => saveInstruction(false));
  $("instrReset").addEventListener("click", () => saveInstruction(true));
  $("updateBtn").addEventListener("click", applyUpdate);
  $("langSelect").value = LANG;
  $("langSelect").addEventListener("change", () => setLang($("langSelect").value));
  document.addEventListener("langchange", () => {
    $("modelLabel").textContent = F.currentWorkflow() ? t(F.currentWorkflow().label) : "—";
    renderSubjectChips();
  });
}

function boot() {
  document.documentElement.lang = LANG;
  translateTree(document.body);
  initTheme();
  initUndo();
  initPromptEditor();
  initJobs();
  initRail();
  initForm();
  renderStyleOptions();
  fillSelect($("mossModeSelect"), F.MOSS_MODES, F.MOSS_DEFAULT_MODE);
  renderMarkets();
  renderAutoEnrich();
  initDrops();
  D.initDirector({ onChange: updateResumeButton });
  refreshPipelineOptions();
  onJobsChange(updateCancelButton);
  on("model", onModelEvent);
  initModelNotice();
  connect();
  initChat({ openInStudio: openCardInForm, launchDirector, useAsInput: a => { setMode("studio"); setSelectedAsset(a); } });
  setMode(initialMode());
  initGallery({
    // From the assistant, a gallery image goes to the chat; from the Studio, to the form.
    useAsInput: a => (!inAssistant() ? useAsInput(a)
      : a.type === "video" ? notice(false, "A clip cannot be attached to a message: attach an image.") : attachAsset(a)),
    useAsRef: a => { if (!inAssistant() && F.refCtx()) useAsRef(a); },
    reusePrompt: a => {
      if (inAssistant()) { chatReusePrompt(a.prompt); return; }
      const before = brief.value;
      brief.value = a.prompt;
      undoToast("Prompt copied into the brief.", {}, () => { brief.value = before; });
    },
    // An asset sent to the trash stops being the input image (Undo does not bring it back).
    removed: items => { if (selectedAsset && items.some(a => a.ref === selectedAsset.ref)) clearSelectedAsset(); },
  });
  api.health().then(h => {
    document.title = h.app;
    $("appName").textContent = h.app;
    log("sys", "{app} {version} ready.", { app: h.app, version: h.version });
  }).catch(warn);
  loadLoras();
  pollMonitor();
  setInterval(pollMonitor, 4000);
  MOBILE.addEventListener("change", () => D.placeProjectActions());
  // A long take whose chain went on with the page closed: back on it, its jobs followed.
  if (D.savedChainRunning()) D.restoreProject().catch(err => log("warn", "Restore failed: {error}", { error: err.message }));
}

boot();
