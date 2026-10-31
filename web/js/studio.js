// Studio page: goal cards, the generate form and its flows, the models, LoRA and
// update panels, the monitor. The director (storyboard and reference to video) lives
// in director.js, the gallery in gallery.js.
//
// Nothing here submits a job except the Generate button: choosing a card, a pipeline,
// an engine or a language, dropping an image or editing a field starts nothing, and
// the app never writes the brief (the scenario example is only a placeholder).

import { api, connect, on, uploadLora } from "./api.js";
import { L, LANG, pct, setLang, t, translateTree, tx } from "./i18n.js";
import {
  $, LLM, MOBILE, cancelAll, clampInt, fillSelect, initJobs, initPromptEditor, initTheme, initUndo,
  log, notice, onJobsChange, promptLog, runJob, runningJobs, undoToast, warn,
} from "./ui.js";
import { initModelNotice, showModelNotice } from "./model-notice.js";
import { initGallery } from "./gallery.js";
import * as F from "./form.js";
import * as D from "./director.js";
import * as G from "./generate.js";
import { initChat, loadRolePanel } from "./chat.js";

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
  storyboard: { pipeline: "storyboard",
    example: "A detective enters an abandoned broadcast studio at night, old monitors flicker in the background, tense cinematic cold atmosphere." },
  localization: { pipeline: "image2image",
    example: "Localized promotional poster variant for the Japanese market: keep the premium sci-fi brand identity, adapt background, wardrobe and typography cues to Tokyo night aesthetics." },
};
// The sequence brief is a MOTION prompt.
const MOTION_EXAMPLE = "Smooth cinematic camera transition between the key frames, consistent subject, style and lighting, natural motion.";
let activeScenario = "campaign";

// What the main button starts, said on the button.
const GENERATE_LABELS = {
  text2image: L("Generate the images"), image2image: L("Generate the variants"),
  text2video: L("Generate the video"), image2video: L("Generate the video"),
  sequence: L("Generate the sequence"), storyboard: L("Generate the sheets (step 1/3)"),
  campaign: L("Start the campaign (posters + thumbnails + teaser)"),
};
function refreshGenerateLabel() {
  const p = F.currentPipeline();
  tx($("generateBtn"), p === "reference2video"
    ? ($("skipSheetsToggle").checked ? "Generate the video" : "Generate the sheets (step 1/2)")
    : GENERATE_LABELS[p] || "Generate");
}

function selectScenario(scenario, pipeline = SCENARIOS[scenario].pipeline) {
  activeScenario = scenario;
  refreshPipelineOptions();
  if ([...$("pipelineSelect").options].some(o => o.value === pipeline) && F.currentPipeline() !== pipeline) {
    $("pipelineSelect").value = pipeline;
    updateModelOptions();
  }
}

// ── Pipeline and engine menus ─────────────────────────────────────────────────
const CONTROL_WRAPS = {
  image: "imageInputWrap", duration: "durationWrap", markets: "marketsWrap", seq: "seqWrap",
  shots: "shotCountWrap", hold: "holdWrap", variants: "variantsWrap", ratio: "ratioWrap", style: "styleWrap",
  lora: "loraWrap", sheetTemplate: "sheetTemplateWrap", skipSheets: "skipSheetsWrap",
};

function refreshPipelineOptions() {
  const list = F.PIPELINES.filter(p => !p.scenario || p.scenario.includes(activeScenario));
  const prev = F.currentPipeline();
  fillSelect($("pipelineSelect"), list.map(p => [p.id, p.label]), prev);
  updateModelOptions();
}

let lastPipeline = null;
function updateModelOptions() {
  const p = F.currentPipeline(), def = F.pipelineDef(p);
  fillSelect($("modelSelect"), F.WORKFLOWS.filter(w => w.pipeline === p).map(w => [w.id, w.label]), $("modelSelect").value);
  for (const [name, id] of Object.entries(CONTROL_WRAPS)) $(id).hidden = !def?.controls.includes(name);
  brief.placeholder = p === "sequence" ? MOTION_EXAMPLE : SCENARIOS[activeScenario].example;
  document.querySelectorAll(".usecase").forEach(c => c.setAttribute("aria-pressed", String(c.dataset.pipeline === p)));
  refreshGenerateLabel();
  // Another pipeline ends the director session (the saved project stays).
  if (lastPipeline !== null && p !== lastPipeline) D.reset();
  lastPipeline = p;
  updateModelLabel();
}

function updateModelLabel() {
  const wf = F.currentWorkflow();
  $("modelLabel").textContent = wf ? t(wf.label) : "—";
  showModelNotice($("modelNotice"), F.workflowEngines(wf));
  // The last frame (FL2VA) belongs to H3 image to video.
  $("lastImageWrap").hidden = wf?.id !== "h3_i2v";
  if ($("lastImageWrap").hidden) $("lastImageInput").value = "";
  const ctx = F.refCtx(wf);
  $("refExtrasWrap").hidden = !ctx;
  for (const [cls, on] of [[".r2v-only", ctx === "r2v"], [".sb-only", ctx === "sb"], [".i2i-only", ctx === "i2i"]])
    document.querySelectorAll(`#refExtrasWrap ${cls}`).forEach(el => { el.hidden = !on; });
  tx($("refCapLabel"), "Extra reference images (at most {max})", { max: F.REF_CAPS[ctx] || 7 });
  renderRefs();
  updateResumeButton();
  D.refreshSessionBar();
}

// ── Style and sheet layout ────────────────────────────────────────────────────
function renderStyleOptions() {
  fillSelect($("styleSelect"), Object.entries(P.STYLE_PACKS).map(([id, s]) => [id, s.label]), $("styleSelect").value || "cinematic");
}

// Layout sketch of each sheet template, drawn in the picker: the choice is made by
// eye on the arrangement of the boxes. The <select> stays the source of truth.
const WIRE_STRIP = `<rect x="6" y="61" width="108" height="6" rx="2" opacity=".3"/>`;
const SHEET_WIRES = {
  turnaround: `<rect x="6" y="6" width="26" height="22" rx="2" opacity=".75"/><rect x="38" y="11" width="10" height="10" rx="2" opacity=".5"/><rect x="51" y="11" width="10" height="10" rx="2" opacity=".5"/><rect x="64" y="11" width="10" height="10" rx="2" opacity=".5"/><rect x="77" y="11" width="10" height="10" rx="2" opacity=".5"/><rect x="94" y="9" width="9" height="7" rx="2" opacity=".35"/><rect x="105" y="9" width="9" height="7" rx="2" opacity=".35"/><rect x="94" y="19" width="9" height="7" rx="2" opacity=".35"/><rect x="6" y="33" width="24" height="24" rx="2" opacity=".75"/><rect x="34" y="33" width="24" height="24" rx="2" opacity=".75"/><rect x="62" y="33" width="24" height="24" rx="2" opacity=".75"/><rect x="90" y="33" width="24" height="24" rx="2" opacity=".75"/>`,
  expressions: `<rect x="6" y="5" width="11" height="9" rx="2" opacity=".5"/><rect x="6" y="16" width="11" height="9" rx="2" opacity=".5"/><rect x="6" y="27" width="11" height="9" rx="2" opacity=".5"/><rect x="6" y="38" width="11" height="9" rx="2" opacity=".5"/><rect x="6" y="49" width="11" height="9" rx="2" opacity=".5"/><rect x="24" y="5" width="28" height="42" rx="2" opacity=".75"/><rect x="56" y="5" width="28" height="42" rx="2" opacity=".75"/><rect x="88" y="5" width="26" height="42" rx="2" opacity=".75"/><rect x="24" y="51" width="9" height="7" rx="2" opacity=".35"/><rect x="36" y="51" width="9" height="7" rx="2" opacity=".35"/><rect x="48" y="51" width="9" height="7" rx="2" opacity=".35"/>`,
  portrait: `<rect x="6" y="6" width="34" height="51" rx="2" opacity=".8"/><rect x="46" y="6" width="12" height="11" rx="2" opacity=".5"/><rect x="61" y="6" width="12" height="11" rx="2" opacity=".5"/><rect x="76" y="6" width="12" height="11" rx="2" opacity=".5"/><rect x="91" y="6" width="12" height="11" rx="2" opacity=".5"/><rect x="106" y="6" width="8" height="11" rx="2" opacity=".5"/><rect x="46" y="22" width="20" height="35" rx="2" opacity=".75"/><rect x="70" y="22" width="20" height="35" rx="2" opacity=".75"/><rect x="94" y="22" width="20" height="35" rx="2" opacity=".75"/>`,
  wardrobe: `<rect x="6" y="6" width="24" height="19" rx="2" opacity=".8"/><rect x="6" y="29" width="19" height="28" rx="2" opacity=".75"/><rect x="28" y="29" width="19" height="28" rx="2" opacity=".75"/><rect x="50" y="29" width="19" height="28" rx="2" opacity=".75"/><rect x="72" y="29" width="19" height="28" rx="2" opacity=".75"/><rect x="96" y="6" width="18" height="15" rx="2" opacity=".45"/><rect x="96" y="24" width="18" height="15" rx="2" opacity=".45"/><rect x="96" y="42" width="18" height="15" rx="2" opacity=".45"/>`,
  action: `<rect x="6" y="6" width="17" height="23" rx="2" opacity=".75"/><rect x="26" y="6" width="17" height="23" rx="2" opacity=".75"/><rect x="46" y="6" width="17" height="23" rx="2" opacity=".75"/><rect x="66" y="6" width="17" height="23" rx="2" opacity=".75"/><rect x="6" y="33" width="17" height="24" rx="2" opacity=".55"/><rect x="26" y="33" width="17" height="24" rx="2" opacity=".55"/><rect x="46" y="33" width="17" height="24" rx="2" opacity=".55"/><rect x="88" y="6" width="26" height="20" rx="2" opacity=".8"/><rect x="88" y="29" width="11" height="9" rx="2" opacity=".5"/><rect x="103" y="29" width="11" height="9" rx="2" opacity=".5"/><rect x="88" y="41" width="11" height="9" rx="2" opacity=".35"/><rect x="103" y="41" width="11" height="9" rx="2" opacity=".35"/>`,
};
function renderSheetTemplateOptions() {
  const sel = $("sheetTemplateSelect");
  const entries = [["auto", L("Auto (follows the subject)"), SHEET_WIRES.turnaround, true],
    ...Object.entries(P.SHEET_TEMPLATES).map(([id, v]) => [id, v.label, SHEET_WIRES[id], false])];
  const cur = entries.some(([id]) => id === sel.value) ? sel.value : "auto";
  fillSelect(sel, entries.map(([id, label]) => [id, label]), cur);
  const grid = $("sheetTemplateWrap").querySelector(".tpl-grid");
  grid.replaceChildren(...entries.map(([id, label, wire, faded]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tpl-card";
    b.dataset.tpl = id;
    b.setAttribute("aria-pressed", String(id === cur));
    b.innerHTML = `<svg viewBox="0 0 120 72" aria-hidden="true" fill="currentColor">${faded ? `<g opacity=".55">${wire}${WIRE_STRIP}</g>` : wire + WIRE_STRIP}</svg><span class="tpl-name"></span>`;
    b.querySelector(".tpl-name").textContent = label;
    b.addEventListener("click", () => selectSheetTemplate(id));
    return b;
  }));
  translateTree(grid);
}
function selectSheetTemplate(id) {
  const sel = $("sheetTemplateSelect");
  if (sel.value === id) return;
  sel.value = id;
  $("sheetTemplateWrap").querySelectorAll(".tpl-card").forEach(c => c.setAttribute("aria-pressed", String(c.dataset.tpl === id)));
  sel.dispatchEvent(new Event("change", { bubbles: true }));
}

// ── Input image ───────────────────────────────────────────────────────────────
let selectedAsset = null;   // gallery asset chosen as input: {ref, filename}
function setSelectedAsset(a) {
  selectedAsset = { ref: a.ref, filename: a.filename };
  tx($("assetChipName"), "Gallery: {name}", { name: a.filename });
  $("assetChip").hidden = false;
  $("imageInput").value = "";
  if (!["image2image", "image2video"].includes(F.currentPipeline())) {
    $("pipelineSelect").value = "image2image";
    updateModelOptions();
  }
  log("req", "{name} chosen as the input image.", { name: a.filename });
}
function clearSelectedAsset() { selectedAsset = null; $("assetChip").hidden = true; }

async function inputImageRef() {
  if (selectedAsset) return selectedAsset.ref;
  const file = $("imageInput").files[0];
  if (!file) throw new Error(t("Choose an input image (a file, or a gallery image with “→ Use as input”)."));
  return F.imageRef({ name: file.name, blob: file });
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

// ── Multi-image sequence ──────────────────────────────────────────────────────
const SEQ_MAX = 6;
const seqImages = [];   // {name, ref | blob, dur}: dur = length of the segment that starts on it
function addSeqImage(img) {
  if (seqImages.length >= SEQ_MAX) { notice(false, "The sequence holds at most {max} images.", { max: SEQ_MAX }); return false; }
  seqImages.push({ ...img, dur: 5 });
  renderSeqList();
  return true;
}
function renderSeqList() {
  const list = $("seqList");
  list.replaceChildren(...seqImages.map((item, i) => {
    const row = document.createElement("div");
    row.className = "seq-item";
    const img = document.createElement("img");
    img.alt = "";
    img.src = F.imageURL(item);
    const name = document.createElement("div");
    name.className = "seq-name";
    name.dataset.raw = "";
    name.textContent = `${i + 1}. ${item.name}`;
    const dur = document.createElement("div");
    dur.className = "seq-dur";
    if (i < seqImages.length - 1) {
      const input = document.createElement("input");
      input.type = "number"; input.min = "5"; input.max = "15"; input.value = item.dur;
      txAria(input, "Segment length (s)");
      input.addEventListener("change", () => { item.dur = F.clampDuration(input.value, item.dur); input.value = item.dur; renderSeqSummary(); });
      dur.append("→ ", input, " s");
    } else tx(dur, "end");
    const ctl = document.createElement("div");
    ctl.className = "seq-ctl";
    for (const [text, title, fn] of [
      ["↑", L("Move up"), () => { if (i > 0) { [seqImages[i - 1], seqImages[i]] = [seqImages[i], seqImages[i - 1]]; renderSeqList(); } }],
      ["↓", L("Move down"), () => { if (i < seqImages.length - 1) { [seqImages[i + 1], seqImages[i]] = [seqImages[i], seqImages[i + 1]]; renderSeqList(); } }],
      ["✕", L("Remove"), () => { seqImages.splice(i, 1); renderSeqList(); }]]) {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = text; b.title = title; b.setAttribute("aria-label", title);
      b.addEventListener("click", fn);
      ctl.appendChild(b);
    }
    row.append(img, name, dur, ctl);
    return row;
  }));
  translateTree(list);
  renderSeqSummary();
}
function renderSeqSummary() {
  const segs = seqImages.length - 1;
  if (segs < 1) { $("seqSummary").textContent = ""; return; }
  const asked = seqImages.slice(0, -1).reduce((s, it) => s + it.dur, 0);
  const real = seqImages.slice(0, -1).reduce((s, it) => s + P.h3RealDuration(it.dur), 0);
  tx($("seqSummary"), "{n} segment(s), {asked} s asked, {real} s rendered (H3 frame grid).",
    { n: segs, asked, real: real.toFixed(2) });
}
const txAria = (el, text) => { el.setAttribute("aria-label", text); el.title = text; };

// ── Extra references and H3 subjects ──────────────────────────────────────────
function addRefs(images) {
  const ctx = F.refCtx(), list = F.refList(ctx), max = F.REF_CAPS[ctx];
  if (!ctx) return;
  const room = Math.max(0, max - list.length);
  list.push(...images.slice(0, room));
  if (images.length > room) notice(false, "At most {max} images here: the extra ones were ignored.", { max });
  renderRefs();
}

// Subjects of the next Ref2VA job, in picture order. Skipping the sheets makes the
// first two references the character and the setting.
const SUBJECT_KINDS = { character: L("character"), environment: L("setting"), reference: L("reference") };
function plannedSubjects() {
  const refs = F.refList("r2v");
  if ($("skipSheetsToggle").checked)
    return refs.map((_, i) => (i === 0 ? "character" : i === 1 ? "environment" : "reference"));
  return ["character", "environment", ...refs.map(() => "reference")];
}

function renderRefs() {
  const ctx = F.refCtx(), skip = $("skipSheetsToggle").checked;
  $("refSubjects").replaceChildren(...F.refList(ctx).map((img, i) => {
    const row = document.createElement("div");
    row.className = "ref-subject ref-removable";
    const tag = document.createElement("div");
    tag.className = "rs-tag";
    if (ctx === "i2i") tag.textContent = `<image${i + 2}>`;
    else if (ctx === "sb") tx(tag, "Reference {n}", { n: i + 1 });
    else tx(tag, "Subject {n}", { n: skip ? i + 1 : i + 3 });
    const name = document.createElement("div");
    name.className = "rs-name";
    name.dataset.raw = "";
    name.textContent = img.name;
    const x = document.createElement("button");
    x.type = "button"; x.className = "rs-x"; x.textContent = "✕";
    txAria(x, "Remove this reference");
    x.addEventListener("click", () => { F.refList(ctx).splice(i, 1); renderRefs(); });
    row.append(tag, name, x);
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
function dropZone(el, { max = () => 1, count = () => 0, put, putAsset }) {
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
    items = items.filter(it => {
      if (it.type === "video" || /^video\//.test(it.type)) { refusals.push(["A video cannot go here: drop an image."]); return false; }
      if (it.file && !/^image\//.test(it.type)) { refusals.push(["{name} is not an image.", { name: it.name }]); return false; }
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
function initDrops() {
  dropZone($("imageInputWrap"), { put: f => setInputFile($("imageInput"), f), putAsset: setSelectedAsset });
  dropZone($("lastImageWrap"), { put: f => setInputFile($("lastImageInput"), f) });
  dropZone($("seqWrap"), {
    max: () => SEQ_MAX, count: () => seqImages.length,
    put: f => addSeqImage({ name: f.name, blob: f }),
    putAsset: a => addSeqImage({ name: a.filename, ref: a.ref }),
  });
  dropZone($("refDropZone"), {
    max: () => F.REF_CAPS[F.refCtx()] || 0, count: () => F.refList().length,
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
async function generate() {
  const wf = F.currentWorkflow();
  if (!wf) { log("warn", "No engine selected."); return; }
  // An empty brief starts nothing (the example is a placeholder), except local
  // versions, whose prompts come from the chosen markets.
  if (!F.brief() && !(wf.pipeline === "image2image" && selectedMarkets.size)) {
    log("warn", "Empty brief: describe what you want before generating.");
    brief.focus();
    return;
  }
  const btn = $("generateBtn");
  btn.disabled = true;
  try {
    if (autoEnrich && wf.enrich !== "builtin") {
      log("req", "Auto enrichment of the brief with {llm}…", { llm: LLM });
      await enrich(wf);
    } else if (autoEnrich) log("sys", "{workflow} builds its own prompts: brief sent as it is.", { workflow: t(wf.label) });
    const seed = F.formSeed();
    if (wf.pipeline === "storyboard") await D.startStoryboard(seed);
    else if (wf.pipeline === "reference2video") {
      if ($("skipSheetsToggle").checked) await D.r2vWithoutSheets(seed);
      else await D.startR2V(seed);
    } else if (wf.pipeline === "sequence") await generateSequence(seed);
    else if (wf.pipeline === "campaign") generateCampaign(seed);
    else await generatePlain(wf, seed);
  } catch (err) { warn(err); }
  finally { btn.disabled = false; }
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
    count, duration, loras, image, last, refs, seed }).forEach(detach);
}

// Each pair of images becomes an H3 segment from the first to the last frame, then the
// segments are joined.
async function generateSequence(seed) {
  if (seqImages.length < 2) throw new Error(t("Add at least 2 images to the sequence (files or gallery)."));
  const items = seqImages.slice(), text = F.brief(), loras = F.formLoras();
  const [refs, aspect] = await Promise.all([Promise.all(items.map(F.imageRef)), G.seqAspect(items[0])]);
  detach(G.runSequence({ refs, durs: items.map(it => it.dur), text, loras, aspect, seed }));
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
  create_image: a => ["text2image", a.engine === "qwen" ? "qwen21_t2i" : "krea2_t2i", a.prompt],
  edit_image: a => ["image2image", "qwen21_i2i", a.instruction],
  video_from_text: a => ["text2video", "h3_t2v", a.prompt],
  video_from_image: a => ["image2video", "h3_i2v", a.prompt],
  image_sequence: a => ["sequence", "h3_sequence", a.prompt],
  campaign: a => ["campaign", "campaign", a.brief],
  storyboard: a => ["storyboard", "storyboard_qwen21", a.brief],
  reference_video: a => ["reference2video", "h3_r2v", a.brief],
};
async function openCardInForm(tool, a, image) {
  const [pipeline, wfId, text] = CARD_FORM[tool](a);
  const before = { brief: brief.value, scenario: activeScenario, pipeline: F.currentPipeline(), wf: $("modelSelect").value };
  const scenario = F.pipelineDef(pipeline).scenario?.[0] || (pipeline === "image2image" ? "localization" : "campaign");
  selectScenario(scenario, pipeline);
  $("modelSelect").value = wfId;
  updateModelLabel();
  if (a.ratio) $("ratioSelect").value = a.ratio;
  if (a.count || a.variants) $("variants").value = a.count || a.variants;
  if (a.duration) $("videoDuration").value = a.duration;
  if (a.shots) $("shotCount").value = a.shots;
  if (a.style && F.hasControl("style")) { $("styleSelect").value = a.style; D.setStyle(a.style); }
  const img = id => image(id) && { name: image(id).name, ref: image(id).ref };
  if (a.image) setSelectedAsset({ ref: img(a.image).ref, filename: img(a.image).name });
  if (a.last_image) setInputFile($("lastImageInput"), await assetFile({ ref: img(a.last_image).ref, filename: img(a.last_image).name }));
  if (tool === "edit_image") {
    F.refList("i2i").splice(0, Infinity, ...(a.references || []).map(img));
    selectedMarkets.clear();
    for (const m of a.markets || []) selectedMarkets.add(m);
    renderMarkets();
  }
  if (tool === "reference_video") F.refList("r2v").splice(0, Infinity, ...(a.references || []).map(img));
  if (tool === "image_sequence") { seqImages.splice(0, Infinity, ...a.images.map(id => ({ ...img(id), dur: a.duration }))); renderSeqList(); }
  renderRefs();
  brief.value = text;
  log("sys", "Assistant card opened in the Studio form: nothing starts before Generate.");
  undoToast("Card opened in the Studio form.", {}, () => {
    brief.value = before.brief;
    selectScenario(before.scenario, before.pipeline);
    if ([...$("modelSelect").options].some(o => o.value === before.wf)) { $("modelSelect").value = before.wf; updateModelLabel(); }
  });
  brief.scrollIntoView({ behavior: "smooth", block: "center" });
}

// ── Project buttons (resume, cancel) ──────────────────────────────────────────
function updateResumeButton() {
  $("resumeProjectBtn").hidden = !(D.hasSavedProject() && F.currentPipeline() === "storyboard");
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
  h3_r2v: L("MiniMax H3 references (consistent character + setting)"),
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

let h3Loras = [];
async function loadLoras() {
  try { h3Loras = (await api.loras()).h3 || []; } catch (err) { warn(err); }
  $("loraList").replaceChildren(...h3Loras.map(l => {
    const row = document.createElement("div");
    row.className = "model";
    row.innerHTML = `<strong data-raw></strong><small data-raw></small>`;
    row.querySelector("strong").textContent = l.name;
    row.querySelector("small").textContent = `${(l.size / 2 ** 20).toFixed(1)} MiB`;
    return row;
  }));
  fillSelect($("loraSelect"), [["", "None"], ...h3Loras.map(l => [l.name, l.name.replace(/\.safetensors$/, "")])], $("loraSelect").value);
  // File names are not translated.
  [...$("loraSelect").options].slice(1).forEach(o => { o.dataset.raw = ""; });
}
async function uploadLoraFile() {
  const file = $("loraFile").files[0], status = $("loraUploadStatus");
  if (!file) { log("warn", "No LoRA file selected."); return; }
  if (!file.name.toLowerCase().endsWith(".safetensors")) { log("warn", "{name} refused: a .safetensors file is required.", { name: file.name }); return; }
  $("loraUploadBtn").disabled = true;
  try {
    await uploadLora(file, frac => { status.textContent = pct(Math.round(frac * 100)); });
    log("ok", "LoRA {name} uploaded.", { name: file.name });
    $("loraFile").value = "";
    loadLoras();
  } catch (err) { log("warn", "LoRA upload failed: {error}", { error: err.message }); }
  finally { status.textContent = ""; $("loraUploadBtn").disabled = false; }
}

async function loadUpdate() {
  let s;
  try { s = await api.updateStatus(); }
  catch (err) { tx($("updateState"), "Offline"); tx($("updateText"), "{error}", { error: err.message }); return; }
  $("updateBtn").hidden = !s.available;
  const short = h => (h || "").slice(0, 7);
  if (s.available) {
    tx($("updateState"), "Available");
    tx($("updateText"), "A new version is available ({from} → {to}). The server restarts after the update.", { from: short(s.local), to: short(s.remote) });
  } else if (s.message) {
    tx($("updateState"), s.mode === "none" ? "Not available" : "Up to date");
    $("updateText").textContent = s.message;   // server text, in English
  } else {
    tx($("updateState"), "Up to date");
    tx($("updateText"), "Version {version} is the latest.", { version: short(s.local) });
  }
}
async function applyUpdate() {
  if (!confirm(t("Update the studio now? The server restarts; jobs in progress block the update."))) return;
  const btn = $("updateBtn");
  btn.disabled = true;
  try {
    const r = await api.updateApply();
    if (r.message) $("updateText").textContent = r.message;
    if (!r.updated) { tx($("updateText"), "Already up to date."); return; }
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
  // One flyout at a time, open until its button is clicked again.
  document.querySelectorAll(".rail-btn[data-panel]").forEach(btn => btn.addEventListener("click", () => {
    const name = btn.classList.contains("active") ? "studio" : btn.dataset.panel;
    document.querySelectorAll(".rail-btn[data-panel]").forEach(b => b.classList.toggle("active", b.dataset.panel === name));
    let open = false;
    document.querySelectorAll(".flyout").forEach(f => { f.hidden = f.dataset.flyout !== name; open ||= !f.hidden; });
    document.querySelector(".app-rail").classList.toggle("expanded", open);
    if (name === "models") { loadModels(); loadLoras(); loadInstructionPanel(); loadRolePanel(); loadUpdate(); }
  }));
}

function initForm() {
  document.querySelectorAll(".usecase").forEach(card => card.addEventListener("click", () => {
    selectScenario(card.dataset.scenario, card.dataset.pipeline);
    if (card.dataset.scenario === "localization") $("galleryBlock").scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  $("pipelineSelect").addEventListener("change", updateModelOptions);
  $("modelSelect").addEventListener("change", () => { updateModelLabel(); });
  $("styleSelect").addEventListener("change", () => D.setStyle($("styleSelect").value));
  $("sheetTemplateSelect").addEventListener("change", () => D.setTemplate($("sheetTemplateSelect").value));
  $("skipSheetsToggle").addEventListener("change", () => { renderRefs(); refreshGenerateLabel(); });
  $("assetChipClear").addEventListener("click", clearSelectedAsset);
  $("imageInput").addEventListener("change", () => { if ($("imageInput").files[0]) clearSelectedAsset(); });
  $("seqFiles").addEventListener("change", () => {
    for (const f of $("seqFiles").files) if (!addSeqImage({ name: f.name, blob: f })) break;
    $("seqFiles").value = "";
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
  renderSheetTemplateOptions();
  renderMarkets();
  renderAutoEnrich();
  initDrops();
  D.initDirector({ onChange: updateResumeButton });
  refreshPipelineOptions();
  onJobsChange(updateCancelButton);
  on("model", onModelEvent);
  initModelNotice();
  connect();
  initChat({ openInStudio: openCardInForm, useAsInput: setSelectedAsset });
  initGallery({
    useAsInput: setSelectedAsset,
    addToSequence: a => { if (addSeqImage({ name: a.filename, ref: a.ref })) notice(true, "{name} added to the sequence ({n}/{max}).", { name: a.filename, n: seqImages.length, max: SEQ_MAX }); },
    reusePrompt: a => {
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
}

boot();
