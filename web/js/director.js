// Director: the step-by-step review of the storyboard and reference-to-video
// pipelines, in the full-screen studio. Sheets (Krea 2) → approval → shot images
// (Qwen Image 2.1) → cuts (MiniMax H3 image to video) → animatic;
// the Relay builds a long take out of chained segments. Reference to video stops after
// the sheets: one H3 Ref2VA job.
//
// Rules carried over from 1.4 (docs/LESSONS.md): nothing renders without a click; a
// prompt the user edited is sent verbatim and never compiled over; the anchoring
// blocks are re-appended by code; a shot holds at most two subjects.

import { blobToBase64, refURL } from "./api.js";
import { L, LANG, t, translateTree, tx } from "./i18n.js";
import { $, LLM, MOBILE, log, openPromptEditor, promptLog, runJob, undoToast, warn } from "./ui.js";
import { openLightbox } from "./gallery.js";
import * as F from "./form.js";

const P = F.P;
const MAX_SHOT_SUBJECTS = 2;
const RELAY_MAX_SEGMENTS = 10;
// Transition candidates, in frames before the end of a segment (24 fps): the last
// frame is not always the best start for the next segment (motion blur, drift).
const RELAY_TRANSITION_OFFSETS = [3, 6, 9, 12];
const SAVE_KEY = "studioProject";

let d = null;            // the session
let hooks = {};
let savedCache = null;   // valid saved project (drives "Resume the project")
// Sheets an assistant card handed over ({subjects: [image], setting: image | null}): the
// next storyboard keeps them instead of drawing new ones. Shown in the form.
let givenSheets = null;
export function useSheets(sheets) {
  givenSheets = sheets && (sheets.subjects?.length || sheets.setting) ? { subjects: sheets.subjects || [], setting: sheets.setting || null } : null;
}
export const sheetsGiven = () => givenSheets;

export const active = () => !!d;
const isR2V = () => d?.pipeline === "reference2video";
const origin = () => (isR2V() ? "reference2video" : "storyboard");
const out = (job, ext) => job.outputs.find(o => o.endsWith(ext)) || null;
const sameSession = s => d === s;

// ── Subjects ──────────────────────────────────────────────────────────────────
const newChar = (fields, variants = [], active = 0) => ({ fields, variants, active });
const curChar = () => d.chars[d.charIdx];
const activeVariant = c => c.variants[c.active];
const locVariant = () => d.locVariants[d.locActive];
const charDesc = c => P.charDescFromFields(c.fields);
const locDesc = () => P.locDescFromFields(d.locFields);

// Subject indexes of a shot: within the list, no duplicates, at most two, never empty
// (a shot with no subject has nothing to anchor).
function shotSubjectIdx(shot) {
  const n = d?.chars?.length || 1, idx = [];
  for (const i of Array.isArray(shot?.subjects) ? shot.subjects : [0])
    if (Number.isInteger(i) && i >= 0 && i < n && !idx.includes(i)) idx.push(i);
  return idx.length ? idx.slice(0, MAX_SHOT_SUBJECTS) : [0];
}
// {desc, kind, ref} of a shot's subjects, in image order.
const shotSubjects = shot => shotSubjectIdx(shot).map(i => {
  const c = d.chars[i];
  return { desc: charDesc(c), kind: P.charKindOf(c.fields), ref: activeVariant(c)?.ref || null };
});

// Short name of a subject (tabs, shot chips): the name Gemma gave, else the first
// words of the first filled field.
function subjectLabel(i) {
  const f = d?.chars?.[i]?.fields;
  const head = (P.fieldText(f?.label) || P.charFieldKeys(f).map(k => P.fieldText(f?.[k])).find(Boolean) || "")
    .split(/[,;.]/)[0].trim().split(/\s+/).slice(0, 4).join(" ");
  return head ? t("Subject {n} · {name}", { n: i + 1, name: head }) : t("Subject {n}", { n: i + 1 });
}

const anchorsReady = () => !!d && d.chars.every(c => activeVariant(c)?.status === "ready") && locVariant()?.status === "ready";
const keyframesReady = () => !!d?.keyframes?.length && d.keyframes.every(k => k.status === "ready");

// ── Prompts ───────────────────────────────────────────────────────────────────
const charSheetPrompt = fields => P.charsheetPromptFrom(P.charDescFromFields(fields), P.charKindOf(fields), d.sheetTemplate, d.style);
const locSheetPrompt = () => P.locsheetPromptFrom(locDesc(), d.style);
const keyframePrompt = shot => P.compileKeyframePrompt(shot, shotSubjects(shot), locDesc(), d.style);
const h3Warn = (msg, params) => log("warn", msg, params);
const cutPrompt = (shot, holdMotion, duration, body) =>
  P.buildH3CutPrompt(shot, shotSubjects(shot), locDesc(), holdMotion, duration, body || null, false, d.style, h3Warn);
const keyframeEngineName = () => P.keyframeModelName(d.wf.keyframes);

// ── Jobs ──────────────────────────────────────────────────────────────────────
function sheetJob(kind, prompt, seed) {
  return runJob("krea2-t2i", { prompt, ...P.SHEET_SIZE, count: 1, seed }, {
    origin: origin(), label: [kind === "char" ? "Subject sheet" : "Setting sheet"],
    sub: ["{info} · seed {seed}", { info: "Krea 2", seed }] });
}

// Shot image: subjects (1 or 2 sheets, or the previous frame for a Relay cut), the
// setting sheet and the extra references, at the project's ratio.
async function keyframeJob(subjectRefs, prompt, seed, label) {
  const [width, height] = F.QWEN21_RATIOS[d.ratio];
  const params = { prompt, subjects: subjectRefs, setting: locVariant().ref, references: await F.refRefs("sb"), width, height, seed };
  return runJob(d.wf.keyframes, params, { origin: origin(), label, sub: ["{info} · seed {seed}", { info: keyframeEngineName(), seed }] });
}

// Cut: H3 image to video from a shot image (FL2VA with an end image).
function cutJob(imageRef, prompt, duration, seed, label, lastRef) {
  return runJob("h3-i2v", { prompt, duration, seed, loras: [], image: imageRef, ...(lastRef ? { last_image: lastRef } : {}) }, {
    origin: origin(), label,
    sub: ["{info} · seed {seed}", { info: `${lastRef ? "FL2VA" : "I2VA"} · ${duration} s → ${P.h3RealDuration(duration).toFixed(2)} s`, seed }] });
}

// Joins clips (one clip needs no job).
async function concat(refs, label) {
  if (refs.length === 1) return refs[0];
  return out(await runJob("video-concat", { clips: refs }, { origin: origin(), label: [label], sub: ["{n} clip(s)", { n: refs.length }] }), ".mp4");
}

// ── Studio shell ──────────────────────────────────────────────────────────────
const SECTIONS = { character: "studioCharacter", location: "studioLocation", storyboard: "studioStoryboard",
                   montage: "studioMontage", relay: "studioRelay", video: "studioVideoR2V" };
const navBtn = name => document.querySelector(`#studioNav [data-section="${name}"]`);
function enterStudio() { document.body.dataset.studio = "1"; hooks.onChange?.(); }
export function exitStudio() { delete document.body.dataset.studio; hooks.onChange?.(); }
function selectSection(name) {
  for (const [key, id] of Object.entries(SECTIONS)) $(id).hidden = key !== name;
  document.querySelectorAll("#studioNav .studio-nav-btn").forEach(b => b.classList.toggle("active", b.dataset.section === name));
}
function updateNavForPipeline() {
  for (const name of ["storyboard", "montage", "relay"]) navBtn(name).hidden = isR2V();
  navBtn("video").hidden = !isR2V();
}
export function placeProjectActions() {
  const box = document.querySelector(".studio-project-actions");
  (MOBILE.matches ? $("studioShell") : document.querySelector(".studio-nav-foot")).append(box);
}

// Ends the session (the saved project stays: only "New project" erases it).
export function reset() {
  d = null;
  exitStudio();
  $("shotEditList").replaceChildren();
  $("shotEditList").hidden = true;
  renderShotStrip();
  $("directorKeyframesBtn").hidden = true;
  $("directorKeyframesBtn").disabled = false;
  $("montageList").replaceChildren();
  $("montagePlayer").replaceChildren();
  $("studioTimeline").replaceChildren();
  $("relayList").replaceChildren();
  $("relayPlayer").replaceChildren();
  updateNavForPipeline();
  renderSheetMenu("char");
  renderSheetMenu("loc");
  updateGate();
  selectSection("character");
}

// ── Session bar ───────────────────────────────────────────────────────────────
// Display only: the active sheets and the step reached.
export function refreshSessionBar() {
  const box = $("sbAnchors"), steps = $("sbSteps");
  const show = !!d && ["storyboard", "reference2video"].includes(F.currentPipeline());
  const c = d && activeVariant(d.chars[0]), l = d && locVariant();
  const anchors = show && c?.status === "ready" && l?.status === "ready";
  box.hidden = !anchors;
  if (anchors) {
    for (const [kind, v, label] of [["char", c, L("Subject")], ["loc", l, L("Setting")]]) {
      const b = box.querySelector(`[data-kind="${kind}"]`);
      b.querySelector("img").src = refURL(v.ref);
      b.title = t(label);
      b.setAttribute("aria-label", t(label));
    }
    tx(box.querySelector(".sb-state"), d.validated ? "Identity anchored" : "Identity to approve");
    box.classList.toggle("locked", d.validated);
  }
  steps.hidden = !d;
  if (!d) return;
  const names = isR2V() ? [L("Sheets"), L("Video")] : [L("Sheets"), L("Storyboard"), L("Montage")];
  const cur = !d.validated ? 1 : isR2V() ? 2 : keyframesReady() ? 3 : 2;
  steps.replaceChildren(...names.map((n, i) => {
    const li = document.createElement("li");
    tx(li, "{mark} {name}", { mark: i + 1 < cur ? "✓" : i + 1, name: t(n) });
    if (i + 1 === cur) li.setAttribute("aria-current", "step");
    return li;
  }));
}

// ── Start ─────────────────────────────────────────────────────────────────────
// Sheets from the brief (Gemma), the sheet jobs at once, then (storyboard) the shot list.
// A sheet handed over by the assistant is kept as an imported variant: Gemma reads its
// fields from the image (vision) and no job draws it again.
const SUBJECT_FROM_SHEET = "The scene is the attached character sheet: describe the subject it shows, exactly as it looks there.";
const SETTING_FROM_SHEET = "The scene is the attached setting sheet: describe the place it shows, exactly as it looks there.";
const imported = img => ({ ref: img.ref, seed: null, source: "imported", prompt: null, status: "ready" });

// The sheet compilers, fed the image instead of the brief. A failed call leaves the
// fields empty (to fill by hand), never the instruction itself.
async function fieldsFromSheet(img, read, scene) {
  const b64 = await blobToBase64(await F.imageBlob(img));
  const fields = await read((system, user) => F.llm(system, user, [b64]), scene, promptLog);
  for (const k of Object.keys(fields)) if (fields[k] === scene) fields[k] = "";
  return fields;
}

async function openSession(pipeline, seed) {
  const text = F.brief();
  if (!text) throw new Error(t("Describe the scene in the brief before generating."));
  const given = pipeline === "storyboard" ? givenSheets : null;
  const subjects = given?.subjects || [], setting = given?.setting || null;
  if (given) log("req", "Director: reading the sheets from the assistant with {llm} (vision)…", { llm: LLM });
  else log("req", "Director: subject sheet and setting sheet with {llm}…", { llm: LLM });
  const charFields = [];
  for (const img of subjects) charFields.push(await fieldsFromSheet(img, P.characterSheetFromBrief, SUBJECT_FROM_SHEET));
  if (!subjects.length) charFields.push(await P.characterSheetFromBrief(F.llm, text, promptLog));
  const locFields = setting ? await fieldsFromSheet(setting, P.locationSheetFromBrief, SETTING_FROM_SHEET)
    : await P.locationSheetFromBrief(F.llm, text, promptLog);
  const s = {
    pipeline, wf: F.currentWorkflow(), seed, ratio: $("ratioSelect").value,
    style: F.currentStyleId(), sheetTemplate: F.currentTemplateId(),
    locFields, chars: charFields.map(f => newChar(f)), charIdx: 0, locVariants: [], locActive: 0, validated: false,
  };
  // The prompt compiled here is the one sent AND the one kept on the variant: the
  // prompt editor reopens on what was really rendered, template included (LESSONS).
  const prev = d;
  d = s;
  s.chars.forEach((c, i) => c.variants.push(subjects[i] ? imported(subjects[i])
    : { seed, source: "generated", prompt: charSheetPrompt(c.fields), status: "pending" }));
  s.locVariants.push(setting ? imported(setting)
    : { seed: F.seedPlus(seed, 101), source: "generated", prompt: locSheetPrompt(), status: "pending" });
  d = prev;
  if (given) {
    givenSheets = null;
    log("ok", "{n} sheet(s) from the assistant kept: they are not drawn again.", { n: subjects.length + (setting ? 1 : 0) });
  }
  return { s, text };
}

function enterSession(s) {
  reset();
  d = s;
  updateNavForPipeline();
  enterStudio();
  selectSection("character");
  renderSheetMenu("char");
  renderSheetMenu("loc");
  if (!isR2V()) { renderRelay(); renderShotList(); }
  updateGate();
  // Only the sheets still to draw get a job (one per subject, then the setting).
  const pending = (kind, v) => { if (v.status === "pending") watchVariant(kind, v, sheetJob(kind, v.prompt, v.seed)); };
  s.chars.forEach(c => pending("char", c.variants[0]));
  pending("loc", s.locVariants[0]);
  save();
}

export async function startStoryboard(seed) {
  const { s, text } = await openSession("storyboard", seed);
  s.n = Math.min(16, Math.max(4, parseInt($("shotCount").value, 10) || 6));
  s.segDur = F.formDuration();
  s.holdDur = parseInt($("holdDuration").value, 10) > 0 ? F.clampDuration($("holdDuration").value) : 0;
  s.shots = await P.shotListFromBrief(F.llm, text, s.n, s.segDur, promptLog);
  // Several subjects handed over: each shot starts with the first two (the cap of a
  // shot); the shot list's chips change that.
  if (s.chars.length > 1) s.shots.forEach(shot => { shot.subjects = [0, 1]; });
  s.keyframes = null; s.cutPlan = null; s.cuts = null; s.order = null; s.animatic = null;
  s.relay = { segments: [newRelaySegment()], video: null, scenario: "" };
  enterSession(s);
  $("relayScenario").value = "";
}

export async function startR2V(seed) {
  const { s } = await openSession("reference2video", seed);
  // The video job's settings are read now, not at launch, so a form edited during the
  // review changes nothing.
  s.duration = F.formDuration();
  s.loras = F.formLoras();
  enterSession(s);
}

// Variant of a sheet job already submitted.
function watchVariant(kind, variant, jobPromise) {
  const s = d;
  jobPromise.then(job => {
    if (!sameSession(s)) return;
    variant.ref = out(job, ".png");
    variant.status = "ready";
  }).catch(err => {
    if (!sameSession(s)) return;
    variant.status = "error";
    warn(err);
  }).finally(() => {
    if (!sameSession(s)) return;
    refreshSheetUI(kind);
    save();
  });
}

// ── Subject and setting menus ─────────────────────────────────────────────────
const sheetSection = kind => $(kind === "char" ? "studioCharacter" : "studioLocation");
const FIELD_LABELS = {
  face: L("Face"), hair: L("Hair"), outfit: L("Outfit"), accessories: L("Accessories"), subject: L("Subject"),
  form: L("Form"), surface: L("Surface"), details: L("Details"), palette: L("Palette"), place: L("Place"),
  architecture: L("Architecture"), materials: L("Materials"), lighting: L("Lighting"),
};

// The fields follow the subject: a lion or a robot has a form and a surface, not an
// outfit. Edits go through a delegated listener, so rebuilt fields stay wired.
function renderFields(kind, keys) {
  const box = sheetSection(kind).querySelector(".sheet-fields");
  if ([...box.querySelectorAll("[data-field]")].map(i => i.dataset.field).join() === keys.join()) return;
  box.replaceChildren(...keys.map(k => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "text";
    input.dataset.field = k;
    label.append(FIELD_LABELS[k], input);
    return label;
  }));
  translateTree(box);
}

function renderSubjectTabs() {
  const wrap = $("subjectTabs");
  wrap.hidden = !d || isR2V();
  if (wrap.hidden) return;
  const busy = d.chars.some(c => c.variants.some(v => v.status === "pending"));
  const tab = (cls, text, params, onClick, disabled) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "subject-tab" + cls;
    if (params) tx(b, text, params); else b.textContent = text;
    b.disabled = !!disabled;
    b.addEventListener("click", onClick);
    return b;
  };
  wrap.replaceChildren(
    ...d.chars.map((_, i) => tab(i === d.charIdx ? " active" : "", subjectLabel(i), null, () => selectSubject(i))),
    tab(" add", "+ Add a subject", {}, addSubject),
    // Removing a subject whose sheet is rendering would orphan the job: only this waits.
    ...(d.chars.length > 1 ? [tab(" del", "Remove this subject", {}, () => removeSubject(d.charIdx), busy)] : []));
}

function renderCharKind() {
  const wrap = $("charKindToggle");
  wrap.hidden = !d;
  if (!d) return;
  const kind = P.charKindOf(curChar().fields);
  wrap.querySelectorAll("[data-kind]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.kind === kind)));
}

// Human / other switch of the shown subject. Gemma decides at creation and gets it
// wrong at times. Both field sets live in the same object (disjoint keys), so
// switching back loses nothing; the text already written goes into the first field of
// an empty set.
function switchKind(kind) {
  if (!d) return;
  const f = curChar().fields;
  if (P.charKindOf(f) === kind) return;
  const before = P.stripPromptPadding(P.charFieldKeys(f).filter(k => k !== "palette").map(k => P.fieldText(f[k])).filter(Boolean).join(", "));
  f.kind = kind;
  const keys = P.charFieldKeys(f);
  if (before && !keys.some(k => k !== "palette" && P.fieldText(f[k]))) f[keys[0]] = before;
  renderSheetMenu("char");
  save();
}

function selectSubject(i) {
  if (!d || i === d.charIdx || !d.chars[i]) return;
  d.charIdx = i;
  renderSheetMenu("char");
  save();
}

// A new subject is an EMPTY slot, nothing else: no Gemma call, no job. The user
// describes it, then generates its sheet (on a one-subject brief Gemma used to invent
// a second subject and its sheet rendered unasked).
function addSubject() {
  if (!d || isR2V()) return;
  const fields = { kind: P.charKindOf(curChar().fields), label: "" };
  for (const k of P.charFieldKeys(fields)) fields[k] = "";
  d.chars.push(newChar(fields));
  d.charIdx = d.chars.length - 1;
  d.validated = false;
  renderSheetMenu("char");
  refreshSheetUI("char");
  renderShotList();
  save();
  log("sys", "Subject {n} added (empty): describe it, then generate its sheet.", { n: d.chars.length });
}

// Shots name their subjects by index: theirs are shifted before the splice. Undo puts
// everything back unless the project changed since.
function removeSubject(i) {
  if (!d || d.chars.length < 2 || !d.chars[i] || d.chars.some(c => c.variants.some(v => v.status === "pending"))) return;
  const s = d, shots = s.shots || [];
  const snap = { slot: s.chars[i], charIdx: s.charIdx, validated: s.validated, left: s.chars.length - 1,
                 subjects: shots.map(shot => ({ had: "subjects" in shot, v: shot.subjects })) };
  const remap = shots.map(shot => shotSubjectIdx(shot).filter(x => x !== i).map(x => (x > i ? x - 1 : x)));
  s.chars.splice(i, 1);
  shots.forEach((shot, k) => { shot.subjects = remap[k].length ? remap[k] : [0]; });
  s.charIdx = Math.min(s.charIdx, s.chars.length - 1);
  s.validated = false;
  const redraw = () => { renderSheetMenu("char"); refreshSheetUI("char"); renderShotList(); save(); };
  redraw();
  undoToast("Subject {n} removed.", { n: i + 1 }, () => {
    if (d !== s || s.chars.length !== snap.left) { log("warn", "Undo impossible: the project changed since."); return; }
    s.chars.splice(i, 0, snap.slot);
    shots.forEach((shot, k) => { if (snap.subjects[k].had) shot.subjects = snap.subjects[k].v; else delete shot.subjects; });
    s.charIdx = snap.charIdx;
    s.validated = snap.validated;
    redraw();
  });
}

function renderSheetMenu(kind) {
  const isChar = kind === "char";
  const fields = d ? (isChar ? curChar().fields : d.locFields) : null;
  if (isChar) { renderSubjectTabs(); renderCharKind(); }
  renderFields(kind, isChar ? P.charFieldKeys(fields) : P.LOC_FIELD_KEYS);
  sheetSection(kind).querySelectorAll("[data-field]").forEach(input => {
    input.value = fields ? fields[input.dataset.field] || "" : "";
    input.disabled = !fields;
  });
  renderVariantStrip(kind);
}

const STATUS_WORDS = { pending: L("Generating…"), error: L("Error"), missing: L("Missing"), ready: L("Ready"),
                       stale: L("To regenerate"), locked: L("Locked"), idle: L("To generate") };
const statusWord = st => STATUS_WORDS[st] || STATUS_WORDS.ready;

// Variants of a sheet: thumbnail, active badge, seed or "import"; a click makes it active.
function renderVariantStrip(kind) {
  const isChar = kind === "char", section = sheetSection(kind);
  const variants = d ? (isChar ? curChar().variants : d.locVariants) : [];
  const act = d ? (isChar ? curChar().active : d.locActive) : -1;
  section.querySelector(".variant-strip").replaceChildren(...variants.map((v, idx) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "variant-thumb" + (idx === act ? " active" : "");
    b.innerHTML = (v.status === "missing" || !v.ref ? `<div class="thumb-missing"></div>` : `<img alt="">`)
      + `<span class="variant-badge">Active</span><span class="variant-meta"></span>`;
    if (v.ref && v.status !== "missing") b.querySelector("img").src = refURL(v.ref);
    else tx(b.querySelector(".thumb-missing"), v.status === "missing" ? "Missing" : statusWord(v.status));
    tx(b.querySelector(".variant-meta"), v.source === "imported" ? "#{n} · import · {status}" : "#{n} · seed {seed} · {status}",
      { n: idx + 1, seed: v.seed, status: t(statusWord(v.status)) });
    b.addEventListener("click", () => setActiveVariant(kind, idx));
    return b;
  }));
  translateTree(section.querySelector(".variant-strip"));
  const av = variants[act];
  const img = section.querySelector(".sheet-preview img"), miss = section.querySelector(".sheet-preview .thumb-missing");
  miss.hidden = av?.status !== "missing";
  if (av?.status === "missing") tx(miss, "Missing");
  if (av?.ref && av.status !== "missing") { img.src = refURL(av.ref); img.hidden = false; }
  else { img.removeAttribute("src"); img.hidden = true; }
  const status = section.querySelector(".sheet-status");
  if (!av) tx(status, d && isChar && !variants.length ? "No sheet yet: describe the subject (or ✎ Prompt), then generate." : "");
  else if (variants.length > 1) tx(status, "{status} · sheet {n} of {total} active", { status: t(statusWord(av.status)), n: act + 1, total: variants.length });
  else tx(status, statusWord(av.status));
  const busy = variants.some(v => v.status === "pending");
  const regen = section.querySelector(".sheet-regen");
  tx(regen, variants.length ? "🔄 Regenerate the sheet" : "Generate the sheet");
  regen.disabled = !d || busy;
  section.querySelector(".sheet-prompt").disabled = !d || busy;
  section.querySelector(".sheet-import").disabled = !d;
}

function refreshSheetUI(kind) {
  renderVariantStrip(kind);
  if (kind === "char") renderSubjectTabs();
  updateGate();
}

// Choosing another sheet asks for a new approval, like a regeneration.
function setActiveVariant(kind, idx) {
  if (!d) return;
  const owner = kind === "char" ? curChar() : null;
  if ((owner ? owner.active : d.locActive) === idx) return;
  if (owner) owner.active = idx; else d.locActive = idx;
  d.validated = false;
  refreshSheetUI(kind);
  save();
}

// Regenerates a sheet from the edited fields: a NEW variant (the history is never
// replaced), seed of the last generated one + 1. `promptOverride` (prompt editor) is
// sent verbatim and kept on the variant.
function regenerateSheet(kind, promptOverride) {
  if (!d) return;
  const isChar = kind === "char", owner = isChar ? curChar() : null;
  const variants = isChar ? owner.variants : d.locVariants;
  if (variants.some(v => v.status === "pending")) return;
  const lastGen = [...variants].reverse().find(v => v.source === "generated");
  // A subject added by hand has no variant to start from: a seed of its own, so two
  // new subjects do not look alike.
  const base = isChar ? F.seedPlus(d.seed, d.charIdx ? 211 + d.charIdx : 0) : F.seedPlus(d.seed, 101);
  const seed = F.seedPlus(lastGen ? lastGen.seed : base, 1);
  // A subject described only in the prompt editor would leave its fields empty, and the
  // fields are what shot images and cuts read: the description goes into the first field.
  const fields = isChar ? owner.fields : d.locFields;
  const keys = isChar ? P.charFieldKeys(fields) : P.LOC_FIELD_KEYS;
  if (promptOverride && !(isChar ? P.charDescFromFields(fields) : P.locDescFromFields(fields))) {
    const back = P.stripSheetSkeleton(promptOverride, skeleton(kind));
    if (back) { fields[keys[0]] = back; renderSheetMenu(kind); if (isChar) renderShotList(); }
  }
  const prompt = promptOverride || (isChar ? charSheetPrompt(fields) : locSheetPrompt());
  const variant = { seed, source: "generated", prompt, edited: !!promptOverride, status: "pending" };
  variants.push(variant);
  if (isChar) owner.active = variants.length - 1; else d.locActive = variants.length - 1;
  d.validated = false;
  refreshSheetUI(kind);
  watchVariant(kind, variant, sheetJob(kind, prompt, seed));
}

const skeleton = kind => P.sheetSkeleton(kind, kind === "char" ? P.charKindOf(curChar().fields) : undefined, d.sheetTemplate, d.style);

async function importSheet(kind, file) {
  if (!d) return;
  try {
    const ref = await F.imageRef({ name: file.name, blob: file });
    const owner = kind === "char" ? curChar() : null, variants = owner ? owner.variants : d.locVariants;
    variants.push({ ref, seed: null, source: "imported", prompt: null, status: "ready" });
    if (owner) owner.active = variants.length - 1; else d.locActive = variants.length - 1;
    d.validated = false;
    refreshSheetUI(kind);
    log("ok", kind === "char" ? "Subject sheet imported: {name}." : "Setting sheet imported: {name}.", { name: file.name });
    save();
  } catch (err) { warn(err); }
}

function openSheetPrompt(kind) {
  if (!d) return;
  const isChar = kind === "char", owner = isChar ? curChar() : null;
  const v = isChar ? activeVariant(owner) : locVariant();
  const what = isChar ? P.charKindOf(owner.fields) : "location";
  openPromptEditor({
    title: isChar ? "Subject sheet prompt" : "Setting sheet prompt",
    hint: "Krea 2 encodes no negative prompt: say every constraint positively. Enriching again rewrites only the subject's description; the sheet layout is always put back.",
    text: (v?.source === "generated" && v.prompt) || (isChar ? charSheetPrompt(owner.fields) : locSheetPrompt()),
    enrich: text => P.enrichSheetText(F.llm, text, what, skeleton(kind), promptLog),
    apply: text => regenerateSheet(kind, text),
  });
}

// ── Gate ──────────────────────────────────────────────────────────────────────
// Storyboard and Relay open once the active sheets are ready AND approved; Montage once
// every shot image is ready. Reference to video: approved = ready to launch.
function updateGate() {
  const unlocked = anchorsReady() && !!d?.validated;
  $("directorValidateBtn").hidden = !!d?.validated;
  $("directorValidateBtn").disabled = !anchorsReady();
  const lock = (name, open) => { const b = navBtn(name); b.disabled = !open; b.classList.toggle("locked", !open); };
  if (isR2V()) {
    $("directorR2VLaunchBtn").disabled = !unlocked;
    tx($("studioVideoR2VStatus"), unlocked ? "Ready to start the video." : "Approve the character and setting sheets to enable the launch.");
    lock("video", unlocked);
  } else {
    $("shotEditList").hidden = !unlocked;
    $("directorKeyframesBtn").hidden = !(unlocked && !d?.keyframes);
    lock("storyboard", unlocked);
    lock("montage", keyframesReady());
    lock("relay", unlocked);
    updateMontageButtons();
    updateRelayButtons();
  }
  refreshSessionBar();
}

// ── Shot list ─────────────────────────────────────────────────────────────────
// One chip per subject, lit = in the shot. At two subjects the unlit chips are
// disabled, with the reason said: a third would never reach the model.
function renderShotSubjects(fields, shot) {
  if (d.chars.length < 2) return;
  const sel = shotSubjectIdx(shot), full = sel.length >= MAX_SHOT_SUBJECTS;
  const row = document.createElement("div");
  row.className = "shot-subjects";
  const lbl = document.createElement("p");
  lbl.className = "hint shot-subjects-lbl";
  tx(lbl, full ? "{max} subjects at most per shot." : "Subjects in this shot (up to {max}):", { max: MAX_SHOT_SUBJECTS });
  row.appendChild(lbl);
  d.chars.forEach((_, si) => {
    const on = sel.includes(si);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "subj-chip" + (on ? " on" : "");
    chip.setAttribute("aria-pressed", String(on));
    chip.textContent = `${on ? "✓" : "+"} ${subjectLabel(si)}`;
    chip.disabled = !on && full;
    chip.addEventListener("click", () => {
      if (on && sel.length === 1) return;   // a shot keeps at least one subject
      shot.subjects = on ? sel.filter(x => x !== si) : [...sel, si];
      renderShotList();
      save();
    });
    row.appendChild(chip);
  });
  fields.prepend(row);
}

function libOptions(select, lib, value) {
  select.replaceChildren(...Object.entries(lib).map(([id, v]) => new Option(v.label, id, false, id === value)));
}

function renderShotList() {
  if (!d?.shots) return;
  const list = $("shotEditList");
  list.replaceChildren(...d.shots.map((shot, i) => {
    const item = document.createElement("div");
    item.className = "shot-edit-item";
    item.id = `shotItem_${i}`;
    item.tabIndex = -1;
    item.innerHTML = `<strong></strong>
      <div class="shot-edit-body">
        <div class="shot-edit-fields">
          <div class="two-cols">
            <label>Camera<select data-field="camera"></select></label>
            <label>Lighting<select data-field="lighting"></select></label>
          </div>
          <label>Action<textarea class="small" data-field="action"></textarea></label>
          <button type="button" class="secondary-btn shot-action-btn">✎ Rewrite the action</button>
          <div class="two-cols">
            <label>Emotion<input type="text" data-field="emotion"></label>
            <label>Length (s)<input type="number" min="5" max="15" data-field="duration" title="MiniMax H3 renders on a 17n+5 frame grid"></label>
          </div>
          <label>Details<input type="text" data-field="extra"></label>
        </div>
        <div class="shot-kf" id="kfSlot_${i}"></div>
      </div>`;
    tx(item.querySelector("strong"), "Shot {n}/{total}", { n: i + 1, total: d.n });
    renderShotSubjects(item.querySelector(".shot-edit-fields"), shot);
    const field = name => item.querySelector(`[data-field="${name}"]`);
    libOptions(field("camera"), P.CAMERA_LIB, shot.camera);
    libOptions(field("lighting"), P.LIGHTING_LIB, shot.lighting);
    field("action").value = shot.action;
    field("emotion").value = shot.emotion;
    field("duration").value = shot.duration;
    field("extra").value = shot.extra;
    item.querySelector(".shot-action-btn").addEventListener("click", () => openShotActionPrompt(i));
    const on = (name, fn) => field(name).addEventListener("change", () => { fn(field(name)); save(); });
    on("camera", el => { shot.camera = el.value; });
    on("lighting", el => { shot.lighting = el.value; });
    on("action", el => { shot.action = el.value.trim() || shot.action; });
    on("emotion", el => { shot.emotion = el.value.trim(); });
    on("duration", el => { shot.duration = F.clampDuration(el.value, shot.duration); el.value = shot.duration; });
    on("extra", el => { shot.extra = el.value.trim(); });
    return item;
  }));
  translateTree(list);
  renderAllKeyframeCards();
  renderShotStrip();
}

// Thumbnails of the shots at the top of the Storyboard section: a click scrolls to the
// shot and focuses it, nothing else. Updated in place, so the keyboard focus survives.
function renderShotStrip() {
  const strip = $("shotStrip"), n = d?.shots?.length || 0;
  strip.hidden = !n;
  while (strip.children.length > n) strip.lastChild.remove();
  for (let i = 0; i < n; i++) {
    let b = strip.children[i];
    if (!b) {
      b = document.createElement("button");
      b.type = "button";
      b.innerHTML = `<span class="st-img"></span><span class="st-n"></span><span class="st-s"></span>`;
      b.addEventListener("click", () => { const it = $(`shotItem_${i}`); if (it) { it.scrollIntoView({ block: "start" }); it.focus({ preventScroll: true }); } });
      strip.appendChild(b);
    }
    const kf = d.keyframes?.[i];
    const st = !kf ? "todo" : kf.locked ? "locked" : kf.status;
    b.className = `shot-thumb ${st}`;
    b.querySelector(".st-img").style.backgroundImage = kf?.ref && st !== "missing" ? `url("${refURL(kf.ref)}")` : "";
    tx(b.querySelector(".st-n"), "Shot {n}", { n: i + 1 });
    tx(b.querySelector(".st-s"), st === "todo" ? "To do" : statusWord(st));
    b.setAttribute("aria-label", t("Shot {n}: {status}", { n: i + 1, status: t(st === "todo" ? "To do" : statusWord(st)) }));
  }
}

// The Action field can be rewritten before any shot image exists. The applied text
// replaces it as it is; the shot's subjects go to the enrichment, so two subjects both act.
function openShotActionPrompt(i) {
  const shot = d?.shots?.[i];
  if (!shot) return;
  const descs = shotSubjects(shot).map(r => r.desc).filter(Boolean);
  openPromptEditor({
    title: "Shot action prompt",
    applyLabel: "Apply to the shot",
    hint: "This text says what happens in the shot. It is used as it is in the shot image, then in the cut; framing, light and style are added by the app.",
    text: shot.action,
    enrich: text => P.enrichShotAction(F.llm, text, descs, promptLog),
    apply: text => { shot.action = text; renderShotList(); save(); },
  });
}

// ── Shot images ───────────────────────────────────────────────────────────────
// One job per shot, each with its own status: a failed shot can be regenerated from
// its card while the others go on. No automatic retry.
async function generateKeyframes() {
  log("req", "Director: shot images anchored on the approved sheets…");
  d.keyframes = d.shots.map((shot, i) => ({ status: "pending", locked: false, seed: F.seedPlus(d.seed, 11 + i), ref: null,
                                             prompt: keyframePrompt(shot), edited: false }));
  // New shot images make the montage obsolete.
  d.cutPlan = null; d.cuts = null; d.order = null; d.animatic = null;
  renderShotList();
  renderMontage(); renderMontagePlayer(); renderTimeline();
  updateGate();
  await Promise.all(d.keyframes.map((_, i) => renderKeyframe(i)));
}

async function renderKeyframe(i) {
  const s = d, kf = s.keyframes[i], shot = s.shots[i];
  kf.status = "pending";
  renderKeyframeCard(i);
  updateGate();
  try {
    const job = await keyframeJob(shotSubjects(shot).map(r => r.ref), kf.prompt, kf.seed, ["Shot image {n}/{total}", { n: i + 1, total: s.n }]);
    if (!sameSession(s)) return;
    kf.ref = out(job, ".png");
    kf.status = "ready";
  } catch (err) {
    if (!sameSession(s)) return;
    kf.status = "error";
    warn(err);
  }
  renderKeyframeCard(i);
  updateGate();
  save();
}

function renderKeyframeCard(i) {
  renderShotStrip();
  const kf = d.keyframes[i], slot = $(`kfSlot_${i}`);
  if (!slot) return;
  let card = slot.querySelector(".asset");
  if (!card) {
    card = document.createElement("div");
    card.className = "asset fade-in";
    card.innerHTML = `<img alt=""><div class="thumb-missing" hidden></div><div class="meta"><strong></strong><span></span></div>
      <div class="asset-actions"><button type="button" class="kf-regen"></button><button type="button" class="kf-prompt"></button><button type="button" class="kf-lock"></button></div>`;
    card.querySelector("img").addEventListener("click", () => { const k = d?.keyframes?.[i]; if (k?.ref) openLightbox({ url: refURL(k.ref), type: "image" }); });
    card.querySelector(".kf-regen").addEventListener("click", () => regenerateKeyframe(i));
    card.querySelector(".kf-prompt").addEventListener("click", () => openKeyframePrompt(i));
    card.querySelector(".kf-lock").addEventListener("click", () => toggleLock(i));
    slot.appendChild(card);
  }
  card.classList.toggle("locked", kf.locked);
  tx(card.querySelector("strong"), "Shot {n}/{total}", { n: i + 1, total: d.n });
  tx(card.querySelector("span"), kf.locked ? "Locked" : statusWord(kf.status));
  const img = card.querySelector("img"), miss = card.querySelector(".thumb-missing");
  miss.hidden = kf.status !== "missing";
  img.hidden = kf.status === "missing" || !kf.ref;
  if (kf.status === "missing") tx(miss, "Missing");
  if (kf.ref) img.src = refURL(kf.ref);
  const regen = card.querySelector(".kf-regen"), prompt = card.querySelector(".kf-prompt"), lock = card.querySelector(".kf-lock");
  tx(regen, "🔄 Regenerate");
  regen.disabled = kf.locked || kf.status === "pending";
  tx(prompt, kf.edited ? "✎ Full image prompt ✱" : "✎ Full image prompt");
  prompt.disabled = kf.locked || kf.status === "pending";
  tx(lock, kf.locked ? "🔓 Unlock" : "🔒 Lock");
  lock.disabled = kf.status !== "ready" && !kf.locked;
  lock.classList.toggle("active", kf.locked);
}
function renderAllKeyframeCards() { d?.keyframes?.forEach((_, i) => renderKeyframeCard(i)); }

// Without `promptOverride`, the prompt the shot image already carries: a prompt the user
// edited is never compiled over. An unedited one follows the shot's fields.
function regenerateKeyframe(i, promptOverride) {
  const kf = d.keyframes[i];
  if (kf.locked || kf.status === "pending") return;
  kf.seed = F.seedPlus(kf.seed, 1);
  if (promptOverride) { kf.prompt = promptOverride; kf.edited = true; }
  else if (!kf.edited) kf.prompt = keyframePrompt(d.shots[i]);
  renderKeyframe(i);
}

// The anchoring block to re-append depends on the number of subjects of the shot.
function openKeyframePrompt(i) {
  const kf = d?.keyframes?.[i];
  if (!kf || kf.locked || kf.status === "pending") return;
  const dual = shotSubjects(d.shots[i]).length > 1;
  openPromptEditor({
    title: "Shot image prompt",
    hint: "This is the prompt sent to the engine, not a shot description: it must keep the sentences that say what each reference image is for. To describe only the action, use “✎ Rewrite the action” on the shot. “↩ Original prompt” brings the compiled one back, and the final anchoring block is always put back.",
    text: kf.prompt || keyframePrompt(d.shots[i]),
    enrich: text => P.enrichKeyframeText(F.llm, text, dual, keyframeEngineName(), promptLog),
    apply: text => regenerateKeyframe(i, P.ensureKeyframeAnchor(text, dual, promptLog)),
  });
}

function toggleLock(i) {
  const kf = d.keyframes[i];
  if (kf.status !== "ready" && !kf.locked) return;
  kf.locked = !kf.locked;
  renderKeyframeCard(i);
  save();
}

// ── Montage ───────────────────────────────────────────────────────────────────
// One cut per shot (its length), plus a hold on the last shot when asked.
function buildCutPlan() {
  const plan = d.shots.map((shot, k) => ({ k, shot, holdMotion: null, duration: shot.duration }));
  if (d.holdDur > 0) plan.push({ k: d.n - 1, shot: d.shots[d.n - 1], holdMotion: P.HOLD_MOTION, duration: d.holdDur });
  return plan;
}

function updateMontageButtons() {
  $("directorLaunchBtn").disabled = !keyframesReady() || !!d?.cuts?.some(c => c.status === "pending");
  const cuts = d?.cuts;
  $("directorAssembleBtn").disabled = !(cuts?.length && cuts.every(c => c.ref && (c.status === "ready" || c.status === "stale")));
}

function renderCutHint() {
  const dur = d?.segDur || F.formDuration();
  tx($("cutEngineHint"), "MiniMax H3 image to video, MiniMax H3 Prompt Composer grammar. A {asked} s cut renders {real} s (17n+5 frame grid).",
    { asked: dur, real: P.h3RealDuration(dur).toFixed(2) });
}

// "Generate the cuts": contact sheet (not awaited) + one cut per shot, each with its status.
async function generateCuts() {
  if (!d || !keyframesReady()) return;
  const s = d;
  log("req", "Montage: contact sheet and cuts (one per shot, MiniMax H3)…");
  detachJob(runJob("image-grid", { images: s.keyframes.map(k => k.ref) }, { origin: "storyboard", label: ["Storyboard · contact sheet"],
    sub: ["{n} image(s)", { n: s.keyframes.length }] }));
  s.cutPlan = buildCutPlan();
  s.cuts = s.cutPlan.map((p, k) => ({ ref: null, seed: F.seedPlus(s.seed, 31 + k), duration: p.duration, status: "pending",
                                      edited: false, prompt: cutPrompt(p.shot, p.holdMotion, p.duration) }));
  s.order = s.cutPlan.map((_, k) => k);
  renderMontage(); renderTimeline(); updateMontageButtons();
  await Promise.all(s.cuts.map((_, k) => renderCut(k)));
  if (!sameSession(s)) return;
  const held = s.cutPlan.length - s.n;
  log("ok", held ? "{n} cuts generated + the hold on the last shot: reorder them, then assemble." : "{n} cuts generated: reorder them, then assemble.", { n: s.n });
}
const detachJob = p => { p.catch(warn); };

async function renderCut(k) {
  const s = d, cut = s.cuts[k], p = s.cutPlan[k];
  cut.status = "pending";
  renderMontage(); renderTimeline(); updateMontageButtons();
  try {
    const label = p.holdMotion ? ["Hold on the last shot"] : ["Cut {n}/{total}", { n: k + 1, total: s.n }];
    const job = await cutJob(s.keyframes[p.k].ref, cut.prompt, cut.duration, cut.seed, label);
    if (!sameSession(s)) return;
    cut.ref = out(job, ".mp4");
    cut.status = "ready";
  } catch (err) {
    if (!sameSession(s)) return;
    cut.status = "error";
    warn(err);
  }
  renderMontage(); renderTimeline(); updateMontageButtons();
  save();
}

// One cut again, on the same shot image, seed + 1. An edited prompt stays; an unedited
// one is compiled again (its alignment sentence carries the length).
function regenerateCut(k, promptOverride) {
  const cut = d.cuts?.[k], p = d.cutPlan?.[k];
  if (!cut || !p || cut.status === "pending") return;
  cut.seed = F.seedPlus(cut.seed, 1);
  if (promptOverride) { cut.prompt = promptOverride; cut.edited = true; }
  if (!cut.edited) cut.prompt = cutPrompt(p.shot, p.holdMotion, cut.duration);
  renderCut(k);
}

// Reordering changes only the order: nothing renders.
function moveClip(pos, dir) {
  const order = d.order, j = pos + dir;
  if (j < 0 || j >= order.length) return;
  [order[pos], order[j]] = [order[j], order[pos]];
  renderMontage(); renderTimeline();
  save();
}

async function assembleAnimatic() {
  if (!d?.cuts?.length) return;
  const s = d;
  $("directorAssembleBtn").disabled = true;
  try {
    log("req", "Montage: assembling the animatic (montage order)…");
    const ref = await concat(s.order.map(k => s.cuts[k].ref), "Storyboard · animatic");
    if (!sameSession(s)) return;
    s.animatic = { ref };
    renderMontagePlayer();
    log("ok", "Montage: animatic assembled.");
  } catch (err) { warn(err); }
  updateMontageButtons();
  save();
}

// A cut's prompt is an H3 block: enriching again rewrites only detailed_description,
// then the block is assembled again (subject_definitions, so the anchoring, stays).
function openCutPrompt(k) {
  const cut = d?.cuts?.[k], p = d?.cutPlan?.[k];
  if (!cut || !p || cut.status === "pending") return;
  openPromptEditor({
    title: "Cut prompt",
    hint: "MiniMax H3 block with fields: enriching again rewrites only detailed_description, the subject definitions stay in place.",
    text: cut.prompt || cutPrompt(p.shot, p.holdMotion, cut.duration),
    enrich: async text => cutPrompt(p.shot, p.holdMotion, cut.duration, await P.enrichCutText(F.llm, P.h3CutBodyOf(text), promptLog)),
    apply: text => regenerateCut(k, text),
  });
}

function renderMontage() {
  const list = $("montageList");
  if (!d?.cuts?.length) { list.replaceChildren(); return; }
  list.replaceChildren(...d.order.map((k, pos) => {
    const cut = d.cuts[k], p = d.cutPlan[k];
    const clip = document.createElement("div");
    clip.className = "montage-clip";
    clip.innerHTML = `<div class="clip-head"><strong></strong><span class="clip-meta"></span></div>
      <video muted preload="metadata"></video><div class="thumb-missing" hidden></div>
      <label>Length (s)<input type="number" min="5" max="15" data-field="cutdur"></label>
      <div class="clip-actions">
        <button type="button" class="clip-up">↑ Move up</button><button type="button" class="clip-down">↓ Move down</button>
        <button type="button" class="clip-regen">🔄 Regenerate this shot</button><button type="button" class="clip-prompt"></button>
        <button type="button" class="clip-preview">⤢ Preview</button>
      </div>`;
    // The hold is not one more shot: it has its own label, the shots keep the storyboard's numbers.
    if (p.holdMotion) tx(clip.querySelector("strong"), "Hold on shot {n}", { n: d.n });
    else tx(clip.querySelector("strong"), "Shot {n}/{total}", { n: k + 1, total: d.n });
    tx(clip.querySelector(".clip-meta"), "seed {seed} · {real} s rendered · {status}",
      { seed: cut.seed, real: P.h3RealDuration(cut.duration).toFixed(2), status: t(statusWord(cut.status)) });
    const vid = clip.querySelector("video"), miss = clip.querySelector(".thumb-missing");
    miss.hidden = cut.status !== "missing";
    vid.hidden = cut.status === "missing" || !cut.ref;
    if (cut.status === "missing") tx(miss, "Missing");
    if (cut.ref) vid.src = refURL(cut.ref);
    const dur = clip.querySelector('[data-field="cutdur"]');
    dur.value = cut.duration;
    dur.addEventListener("change", () => {
      const v = F.clampDuration(dur.value, cut.duration);
      dur.value = v;
      if (v === cut.duration) return;
      cut.duration = v;
      if (cut.status === "ready") cut.status = "stale";
      renderMontage(); renderTimeline(); updateMontageButtons();
      save();
    });
    const btn = cls => clip.querySelector(cls);
    btn(".clip-up").disabled = pos === 0;
    btn(".clip-down").disabled = pos === d.order.length - 1;
    btn(".clip-up").addEventListener("click", () => moveClip(pos, -1));
    btn(".clip-down").addEventListener("click", () => moveClip(pos, 1));
    btn(".clip-regen").disabled = cut.status === "pending";
    btn(".clip-regen").addEventListener("click", () => regenerateCut(k));
    tx(btn(".clip-prompt"), cut.edited ? "✎ Prompt ✱" : "✎ Prompt");
    btn(".clip-prompt").disabled = cut.status === "pending";
    btn(".clip-prompt").addEventListener("click", () => openCutPrompt(k));
    btn(".clip-preview").disabled = !cut.ref || cut.status === "missing";
    btn(".clip-preview").addEventListener("click", () => openLightbox({ url: refURL(cut.ref), type: "video" }));
    return clip;
  }));
  translateTree(list);
}

function player(wrap, ref) {
  wrap.replaceChildren();
  if (!ref) return;
  const vid = document.createElement("video");
  vid.controls = true;
  vid.playsInline = true;
  vid.src = refURL(ref);
  wrap.appendChild(vid);
}
const renderMontagePlayer = () => player($("montagePlayer"), d?.animatic?.ref);

// Timeline at the foot of the studio: the clips in montage order; a click opens Montage.
function renderTimeline() {
  const foot = $("studioTimeline");
  if (!d?.cuts?.length) { foot.replaceChildren(); return; }
  const strip = document.createElement("div");
  strip.className = "timeline-strip";
  d.order.forEach((k, pos) => {
    const cut = d.cuts[k];
    const b = document.createElement("button");
    b.type = "button";
    b.className = "timeline-thumb";
    const dot = ["ready", "stale", "missing"].includes(cut.status) ? cut.status : "pending";
    b.innerHTML = `<span class="timeline-dot ${dot}"></span>`
      + (cut.ref && cut.status !== "missing" ? `<video muted preload="metadata"></video>` : `<div class="thumb-missing"></div>`)
      + `<span class="timeline-cap"></span>`;
    if (cut.ref && cut.status !== "missing") b.querySelector("video").src = refURL(cut.ref);
    else tx(b.querySelector(".thumb-missing"), statusWord(cut.status));
    b.querySelector(".timeline-cap").textContent = `${pos + 1} · ${cut.duration} s`;
    b.addEventListener("click", () => selectSection("montage"));
    strip.appendChild(b);
  });
  foot.replaceChildren(strip);
}

// ── Relay (long take) ─────────────────────────────────────────────────────────
// A chain of short segments whose consistency comes from the chaining. 🔗 continue:
// the next segment starts on the previous one's transition frame, as it is (the only
// frame-exact continuity). 🎞 cut: a new shot image is composed on that frame (or on
// the sheets for the first segment) and the setting. The first segment is always a cut.
const newRelaySegment = (prompt = "", duration = 5) => ({ prompt, duration, mode: "continue", status: "idle", ref: null,
  seed: 0, prompt_used: null, start: null, transitions: null, transitionIdx: 0, endImage: null });
const relayShot = seg => P.relayShot(seg);
// The chain follows subject 1, whatever tab the subject menu shows.
const relaySubjects = () => [{ desc: charDesc(d.chars[0]), kind: P.charKindOf(d.chars[0].fields), ref: activeVariant(d.chars[0])?.ref }];
const relayBusy = () => !!d?.relay?.segments.some(seg => seg.status === "pending");
const relayReady = () => !!d?.relay?.segments.length && d.relay.segments.every(seg => seg.prompt.trim());
const transitionOf = seg => (seg?.transitions?.length ? seg.transitions[Math.min(seg.transitionIdx || 0, seg.transitions.length - 1)] : null);

function updateRelayButtons() {
  const r = d?.relay, unlocked = anchorsReady() && !!d?.validated, busy = relayBusy();
  $("relayComposeBtn").disabled = !r || busy || !$("relayScenario").value.trim();
  $("relayRunBtn").disabled = !unlocked || !relayReady() || busy;
  $("relayAddBtn").disabled = !r || r.segments.length >= RELAY_MAX_SEGMENTS || busy;
  // A segment "to regenerate" still has its file: the sequence can be assembled.
  $("relayAssembleBtn").disabled = !r || busy || !r.segments.length || !r.segments.every(seg => seg.ref && ["ready", "stale"].includes(seg.status));
}

// The whole screenplay split by Gemma into consecutive segments, written for the H3
// grammar with the subjects as stand-ins. It REPLACES the chain: asked first.
async function composeRelay() {
  const r = d?.relay, text = $("relayScenario").value.trim();
  if (!r || !text) return;
  const n = Math.min(RELAY_MAX_SEGMENTS, Math.max(1, parseInt($("relaySegCount").value, 10) || 6));
  const dur = F.clampDuration($("relaySegDur").value);
  if (r.segments.some(seg => seg.prompt.trim() || seg.ref) && !confirm(t("Replace the current segments with the split screenplay?"))) return;
  const btn = $("relayComposeBtn");
  btn.disabled = true;
  tx(btn, "Splitting…");
  try {
    log("req", "Relay: splitting the screenplay into {n} segments with {llm}…", { n, llm: LLM });
    const list = await P.composeScenario(F.llm, text, n, locDesc(), RELAY_MAX_SEGMENTS, relaySubjects());
    r.segments = list.map(prompt => newRelaySegment(prompt, dur));
    r.scenario = text;
    // Gemma may write one segment more or less: kept, and said.
    if (list.length === n) log("ok", "Relay: {n} segments written: read them before starting the chain.", { n });
    else log("warn", "Relay: {got} segments written ({n} asked): read them before starting the chain.", { got: list.length, n });
  } catch (err) {
    log("warn", "Screenplay split unavailable ({error}): segments unchanged.", { error: err.message });
  } finally { tx(btn, "✨ Split the screenplay"); }
  renderRelay();
  save();
}

function renderRelay() {
  const list = $("relayList"), r = d?.relay;
  if (!r) { list.replaceChildren(); updateRelayButtons(); return; }
  const busy = relayBusy();
  list.replaceChildren(...r.segments.map((seg, i) => {
    const el = document.createElement("div");
    el.className = "relay-seg";
    el.innerHTML = `<div class="seg-head"><strong></strong><span class="seg-status"></span></div>
      <textarea spellcheck="false" placeholder="What happens in this segment."></textarea>
      <div class="seg-row">
        <label>Length (s)<input type="number" min="5" max="15"></label>
        <button type="button" class="secondary-btn seg-link"></button>
        <button type="button" class="secondary-btn seg-enrich">✨ Enrich</button>
        <button type="button" class="secondary-btn seg-regen">🔄 Regenerate</button>
        <button type="button" class="secondary-btn seg-end"></button>
        <button type="button" class="secondary-btn seg-del">✕ Remove</button>
        <input type="file" class="seg-end-file" accept="image/*" hidden>
      </div>
      <div class="relay-endframe" hidden></div>
      <video muted preload="metadata" hidden></video>
      <div class="relay-transitions" hidden></div>`;
    tx(el.querySelector("strong"), "Segment {n}/{total}", { n: i + 1, total: r.segments.length });
    tx(el.querySelector(".seg-status"), statusWord(seg.status));
    const area = el.querySelector("textarea");
    area.value = seg.prompt;
    area.addEventListener("change", () => { seg.prompt = area.value; updateRelayButtons(); save(); });
    area.addEventListener("input", () => { seg.prompt = area.value; updateRelayButtons(); });
    const dur = el.querySelector('input[type="number"]');
    dur.value = seg.duration;
    dur.addEventListener("change", () => { seg.duration = F.clampDuration(dur.value, seg.duration); dur.value = seg.duration; save(); });
    const link = el.querySelector(".seg-link");
    if (i === 0) { tx(link, "🎞 First segment"); link.disabled = true; }
    else {
      tx(link, seg.mode === "continue" ? "🔗 Continuous (exact frame)" : "🎞 Cut (new shot image)");
      link.classList.toggle("active", seg.mode === "continue");
      link.disabled = busy;
      link.addEventListener("click", () => { seg.mode = seg.mode === "continue" ? "cut" : "continue"; renderRelay(); save(); });
    }
    const enrich = el.querySelector(".seg-enrich");
    enrich.disabled = busy;
    enrich.addEventListener("click", async () => {
      enrich.disabled = true;
      tx(enrich, "Enriching…");
      try { seg.prompt = await P.enrichCutText(F.llm, area.value.trim(), promptLog); area.value = seg.prompt; save(); }
      finally { tx(enrich, "✨ Enrich"); enrich.disabled = false; updateRelayButtons(); }
    });
    const regen = el.querySelector(".seg-regen");
    regen.disabled = busy || !["ready", "stale", "error"].includes(seg.status);
    regen.addEventListener("click", () => regenerateSegment(i));
    renderEndImage(el, i, seg, busy);
    const del = el.querySelector(".seg-del");
    del.disabled = busy || r.segments.length < 2;
    del.addEventListener("click", () => { r.segments.splice(i, 1); renderRelay(); save(); });
    const vid = el.querySelector("video");
    if (seg.ref) { vid.hidden = false; vid.src = refURL(seg.ref); }
    renderTransitions(el.querySelector(".relay-transitions"), i, seg, busy);
    return el;
  }));
  translateTree(list);
  updateRelayButtons();
}

// End image of a segment: the segment renders from its start image to that one (FL2VA).
function renderEndImage(el, i, seg, busy) {
  const btn = el.querySelector(".seg-end"), wrap = el.querySelector(".relay-endframe"), input = el.querySelector(".seg-end-file");
  tx(btn, seg.endImage ? "🎯 Change the end image" : "🎯 End image");
  btn.disabled = busy;
  btn.addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const f = input.files[0];
    input.value = "";
    if (f) await setEndImage(i, f);
  });
  if (!seg.endImage) return;
  wrap.hidden = false;
  wrap.innerHTML = `<span class="transitions-lbl">End image</span><img alt=""><button type="button" class="secondary-btn">✕ Remove the end image</button>`;
  wrap.querySelector("img").src = refURL(seg.endImage.ref);
  wrap.querySelector("button").disabled = busy;
  wrap.querySelector("button").addEventListener("click", () => setEndImage(i, null));
}

// Setting or removing the end image starts nothing: the segment becomes "to regenerate".
async function setEndImage(i, file) {
  const seg = d?.relay?.segments[i];
  if (!seg || relayBusy()) return;
  try {
    seg.endImage = file ? { ref: await F.imageRef({ name: file.name, blob: file }), name: file.name } : null;
    if (seg.status === "ready") seg.status = "stale";
  } catch (err) { warn(err); }
  renderRelay();
  save();
}

function renderTransitions(wrap, i, seg, busy) {
  if (!seg.transitions?.length || i >= d.relay.segments.length - 1) return;
  wrap.hidden = false;
  const lbl = document.createElement("span");
  lbl.className = "transitions-lbl";
  lbl.textContent = "Transition image";
  wrap.appendChild(lbl);
  const chosen = Math.min(seg.transitionIdx || 0, seg.transitions.length - 1);
  seg.transitions.forEach((cand, k) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "relay-thumb" + (k === chosen ? " active" : "");
    b.disabled = busy;
    const title = cand.offset ? t("{n} frames before the end", { n: cand.offset }) : t("Last frame");
    b.title = title;
    const img = document.createElement("img");
    img.src = refURL(cand.ref);
    img.alt = title;
    b.appendChild(img);
    b.addEventListener("click", () => chooseTransition(i, k));
    wrap.appendChild(b);
  });
}

// Another transition frame starts nothing: the next segments become "to regenerate".
function chooseTransition(i, k) {
  const seg = d?.relay?.segments[i];
  if (!seg?.transitions?.[k] || relayBusy() || seg.transitionIdx === k) return;
  seg.transitionIdx = k;
  markStaleFrom(i + 1);
  renderRelay();
  save();
}
function markStaleFrom(from) {
  const segs = d?.relay?.segments || [];
  for (let k = from; k < segs.length; k++) if (segs[k].status === "ready") segs[k].status = "stale";
}

// Renders ONE segment: start image, video, then the transition candidates. The chain and
// the regeneration of one segment both come here, so both produce the same thing.
async function renderSegment(i) {
  const s = d, r = s.relay, seg = r.segments[i], total = r.segments.length;
  seg.status = "pending";
  renderRelay();
  const prev = i > 0 ? transitionOf(r.segments[i - 1]) : null;
  // 🔗 without a transition frame: refused rather than a silent cut.
  if (i > 0 && seg.mode === "continue" && !prev)
    throw new Error(t("Relay, segment {n}: no continuous link possible, segment {p} has no transition frame. Regenerate it.", { n: i + 1, p: i }));
  const subs = relaySubjects(), shot = relayShot(seg);
  let start;
  if (i > 0 && prev && seg.mode === "continue") {
    log("req", "Relay, segment {n}/{total}: video (continuous link)…", { n: i + 1, total });
    start = prev.ref;
  } else {
    log("req", "Relay, segment {n}/{total}: shot image (cut)…", { n: i + 1, total });
    const prompt = P.compileRelayKeyframePrompt(seg.prompt.trim(), subs[0].desc, locDesc(), i === 0, s.style);
    const job = await keyframeJob([prev ? prev.ref : subs[0].ref], prompt, F.seedPlus(s.seed, 401 + i),
      ["Relay · shot image {n}/{total}", { n: i + 1, total }]);
    start = out(job, ".png");
  }
  if (!sameSession(s)) return;
  seg.start = { ref: start };
  const last = seg.endImage?.ref || null;
  seg.prompt_used = P.buildH3CutPrompt(shot, subs, locDesc(), null, seg.duration, null, !!last, s.style, h3Warn);
  const job = await cutJob(start, seg.prompt_used, seg.duration, seg.seed, ["Relay · segment {n}/{total}", { n: i + 1, total }], last);
  if (!sameSession(s)) return;
  seg.ref = out(job, ".mp4");
  seg.status = "ready";
  // Candidates: the clip's last frame (saved with it) and frames a little earlier.
  seg.transitions = null;
  if (i < total - 1) {
    log("req", "Relay, segment {n}/{total}: transition frames…", { n: i + 1, total });
    const frames = await runJob("video-frames", { video: seg.ref, offsets: RELAY_TRANSITION_OFFSETS },
      { origin: "relay", label: ["Relay · transition frames"], sub: ["{n} image(s)", { n: RELAY_TRANSITION_OFFSETS.length }] });
    if (!sameSession(s)) return;
    seg.transitions = [{ ref: out(job, ".png"), offset: 0 },
      ...RELAY_TRANSITION_OFFSETS.map((offset, k) => ({ ref: frames.outputs[k], offset }))].filter(x => x.ref);
    seg.transitionIdx = 0;
  }
  renderRelay();
  save();
}

function relayFail(err) {
  const pending = d?.relay?.segments.find(seg => seg.status === "pending");
  if (pending) pending.status = "error";
  warn(err);
}

// Sequential by construction: a continuous segment needs the previous one's frame.
async function runRelay() {
  const r = d?.relay;
  if (!r || !relayReady()) return;
  const s = d;
  $("relayRunBtn").disabled = true;
  try {
    for (let i = 0; i < r.segments.length; i++) {
      r.segments[i].seed = F.seedPlus(s.seed, 501 + i);
      await renderSegment(i);
      if (!sameSession(s)) return;
    }
    log("ok", "Relay: {n} segments generated: assemble the sequence.", { n: r.segments.length });
  } catch (err) { if (sameSession(s)) relayFail(err); }
  renderRelay();
  save();
}

// One segment again, on its current start, with a new seed. The following segments are
// not rendered again: they become "to regenerate", so a half-old chain never goes unseen.
async function regenerateSegment(i) {
  const seg = d?.relay?.segments?.[i];
  if (!seg || relayBusy()) return;
  const s = d;
  try {
    seg.seed = F.seedPlus(seg.seed || F.seedPlus(s.seed, 501 + i), 1);
    await renderSegment(i);
    if (!sameSession(s)) return;
    markStaleFrom(i + 1);
    log("ok", "Relay: segment {n} regenerated.", { n: i + 1 });
  } catch (err) { if (sameSession(s)) relayFail(err); }
  renderRelay();
  save();
}

async function assembleRelay() {
  const r = d?.relay, s = d;
  if (!r || !r.segments.every(seg => seg.ref)) return;
  $("relayAssembleBtn").disabled = true;
  try {
    log("req", "Relay: assembling the sequence…");
    const ref = await concat(r.segments.map(seg => seg.ref), "Relay · sequence");
    if (!sameSession(s)) return;
    r.video = { ref };
    player($("relayPlayer"), ref);
    log("ok", "Relay: sequence assembled.");
  } catch (err) { warn(err); }
  updateRelayButtons();
  save();
}

// ── Reference to video ────────────────────────────────────────────────────────
// Ref2VA job: the six-field block with every subject defined on its picture; extra
// references become subjects 3 and up, described by Gemma's vision.
async function r2vJob({ subjects, refs, extras, seed, duration, loras, aspect, text }) {
  const extraDescs = await F.describeRefs(extras);
  const all = P.h3AssignSubjects(subjects.concat(extraDescs.map(desc => ({ kind: "reference", desc }))));
  const prompt = F.capH3(P.buildH3RefPrompt({ subjects: all, summary: P.h3Summary(text), body: P.h3RefBody(all, text) }));
  const extraRefs = await Promise.all(extras.map(F.imageRef));
  return runJob("h3-r2v", { prompt, duration, seed, loras, aspect, references: [...refs, ...extraRefs] }, {
    origin: "reference2video", label: ["Consistent character + setting (MiniMax H3)"],
    sub: ["{info} · seed {seed}", { info: extras.length ? `${duration} s · +${extras.length} ref.` : `${duration} s`, seed }] });
}

async function launchR2V() {
  if (!isR2V() || !anchorsReady() || !d.validated) return;
  const s = d;
  $("directorR2VLaunchBtn").disabled = true;
  try {
    const extras = F.refList("r2v").slice(0, F.REF_CAPS.r2v);
    const job = await r2vJob({
      subjects: [{ kind: "character", desc: charDesc(s.chars[0]) }, { kind: "environment", desc: locDesc() }],
      refs: [activeVariant(s.chars[0]).ref, locVariant().ref], extras, seed: F.seedPlus(s.seed, 201),
      duration: s.duration, loras: s.loras, aspect: s.ratio, text: F.brief() });
    log("ok", "Video ready: {name}.", { name: out(job, ".mp4") });
  } catch (err) { warn(err); }
  if (sameSession(s)) updateGate();
}

// "Skip the sheets": nothing generated, nothing to review; the first two references
// are the character and the setting, and their description by Gemma's vision is all
// that tells the model what they are.
export async function r2vWithoutSheets(seed) {
  const text = F.brief();
  if (!text) throw new Error(t("Describe the character and the setting in the brief before generating."));
  const list = F.refList("r2v").slice(0, F.REF_CAPS.r2v);
  if (list.length < 2) throw new Error(t("Skipping the sheets needs at least 2 images in “Extra references”."));
  const [charD, locD] = await F.describeRefs(list.slice(0, 2));
  const refs = await Promise.all(list.slice(0, 2).map(F.imageRef));
  runJobDetached(r2vJob({
    subjects: [{ kind: "character", desc: charD }, { kind: "environment", desc: locD }], refs, extras: list.slice(2),
    seed: F.seedPlus(seed, 201), duration: F.formDuration(), loras: F.formLoras(), aspect: $("ratioSelect").value, text }));
}
const runJobDetached = p => { p.catch(warn); };

// ── Form changes during a session ─────────────────────────────────────────────
export function setStyle(style) { if (d) { d.style = style; save(); } }
export function setTemplate(id) { if (d) { d.sheetTemplate = id; save(); } }

// ── Saving and resuming (storyboard only) ─────────────────────────────────────
// The project is kept by file references (server files): nothing volatile is written.
// A "pending" status is not saved; on resume, an item with its file is ready.
function replacer(key, value) {
  if (key === "wf" || key === "cutPlan") return undefined;
  if (key === "status" && value === "pending") return undefined;
  return value;
}
function save() {
  if (!d || isR2V()) return;
  try {
    const p = { version: 2, savedAt: new Date().toISOString(), brief: F.brief(), wfId: d.wf.id, ...d };
    localStorage.setItem(SAVE_KEY, JSON.stringify(p, replacer));
    savedCache = p;
  } catch (err) { log("warn", "The project could not be saved: {error}", { error: err.message }); }
  hooks.onChange?.();
}
function loadSaved() {
  let p = null;
  try { p = JSON.parse(localStorage.getItem(SAVE_KEY) || "null"); }
  catch { log("warn", "Unreadable saved project: ignored."); return null; }
  if (!p) return null;
  if (p.version !== 2 || !F.workflow(p.wfId)) { log("warn", "Saved project ignored (unknown format)."); return null; }
  return p;
}
export const hasSavedProject = () => !!savedCache;

const exists = ref => fetch(refURL(ref), { method: "HEAD" }).then(r => r.ok, () => false);

export async function restoreProject() {
  const p = loadSaved();
  if (!p) { savedCache = null; hooks.onChange?.(); return; }
  reset();
  $("brief").value = p.brief || $("brief").value;
  $("shotCount").value = p.n;
  $("videoDuration").value = p.segDur;
  $("holdDuration").value = p.holdDur;
  $("ratioSelect").value = p.ratio;
  if (P.STYLE_PACKS[p.style]) $("styleSelect").value = p.style;
  $("seed").value = String(p.seed);
  const revive = it => it && { ...it, status: !it.status || it.status === "missing" ? (it.ref ? "ready" : "error") : it.status };
  d = {
    // A project saved with an engine since dropped (Qwen Edit 2509) takes the pipeline's engine.
    ...p, wf: F.workflow(p.wfId) || F.WORKFLOWS.find(w => w.pipeline === p.pipeline), validated: !!p.validated,
    chars: p.chars.map(c => newChar(c.fields, c.variants.map(revive), c.active ?? 0)),
    locVariants: p.locVariants.map(revive),
    keyframes: p.keyframes ? p.keyframes.map(revive) : null,
    cuts: p.cuts ? p.cuts.map(revive) : null, cutPlan: null,
    relay: { scenario: p.relay?.scenario || "", video: p.relay?.video || null,
             segments: (p.relay?.segments || [newRelaySegment()]).map(seg => ({ ...newRelaySegment(), ...seg,
               status: seg.ref ? (seg.status === "stale" ? "stale" : "ready") : "idle" })) },
  };
  d.charIdx = Math.min(Math.max(0, p.charIdx ?? 0), d.chars.length - 1);
  if (d.cuts) d.cutPlan = buildCutPlan();
  const s = d;
  updateNavForPipeline();
  enterStudio();
  selectSection("character");
  renderSheetMenu("char"); renderSheetMenu("loc");
  renderShotList();
  $("relayScenario").value = d.relay.scenario;
  renderRelay(); player($("relayPlayer"), d.relay.video?.ref);
  renderMontage(); renderTimeline(); renderMontagePlayer();
  renderCutHint();
  updateGate();
  log("ok", "Project restored (saved {date}): checking its files…", { date: new Date(p.savedAt).toLocaleString(LANG) });
  // Every file is checked; a missing one is marked, the rest of the project stays usable.
  const items = [...d.chars.map(activeVariant), locVariant(), ...(d.keyframes || []), ...(d.cuts || []),
                 ...d.relay.segments].filter(it => it?.ref && ["ready", "stale"].includes(it.status));
  await Promise.all(items.map(async it => { if (!(await exists(it.ref))) it.status = "missing"; }));
  if (d.animatic?.ref && !(await exists(d.animatic.ref))) d.animatic = null;
  if (d.relay.video?.ref && !(await exists(d.relay.video.ref))) d.relay.video = null;
  if (!sameSession(s)) return;
  renderSheetMenu("char"); renderSheetMenu("loc");
  renderAllKeyframeCards(); renderMontage(); renderTimeline(); renderMontagePlayer();
  renderRelay(); player($("relayPlayer"), d.relay.video?.ref);
  updateGate();
  const missing = items.filter(it => it.status === "missing").length;
  if (missing) log("warn", "Project restored: {n} file(s) missing, regenerate them.", { n: missing });
  else log("ok", "Project restored: every file is there.");
}

// ── Setup ─────────────────────────────────────────────────────────────────────
export function initDirector(h) {
  hooks = h;
  savedCache = loadSaved();
  for (const kind of ["char", "loc"]) {
    const section = sheetSection(kind);
    section.addEventListener("change", e => {
      const input = e.target.closest("[data-field]");
      if (!input || !d) return;
      (kind === "char" ? curChar().fields : d.locFields)[input.dataset.field] = input.value.trim();
      // A subject's label comes from its fields: tabs and shot chips follow.
      if (kind === "char" && d.chars.length > 1) { renderSubjectTabs(); renderShotList(); }
      save();
    });
    section.querySelector(".sheet-regen").addEventListener("click", () => regenerateSheet(kind));
    section.querySelector(".sheet-prompt").addEventListener("click", () => openSheetPrompt(kind));
    const file = section.querySelector(".sheet-import-input");
    section.querySelector(".sheet-import").addEventListener("click", () => file.click());
    file.addEventListener("change", () => { if (file.files[0]) importSheet(kind, file.files[0]); file.value = ""; });
    const img = section.querySelector(".sheet-preview img");
    img.addEventListener("click", () => { if (img.getAttribute("src")) openLightbox({ url: img.src, type: "image" }); });
  }
  $("charKindToggle").addEventListener("click", e => { const b = e.target.closest("[data-kind]"); if (b) switchKind(b.dataset.kind); });
  $("directorValidateBtn").addEventListener("click", () => {
    if (!anchorsReady()) return;
    d.validated = true;
    updateGate();
    save();
  });
  $("directorKeyframesBtn").addEventListener("click", async () => {
    const b = $("directorKeyframesBtn");
    b.disabled = true;
    try { await generateKeyframes(); b.hidden = true; } catch (err) { warn(err); }
    finally { b.disabled = false; }
  });
  $("directorLaunchBtn").addEventListener("click", generateCuts);
  $("directorAssembleBtn").addEventListener("click", assembleAnimatic);
  $("directorR2VLaunchBtn").addEventListener("click", launchR2V);
  $("relayAddBtn").addEventListener("click", () => {
    const r = d?.relay;
    if (!r || r.segments.length >= RELAY_MAX_SEGMENTS) return;
    r.segments.push(newRelaySegment("", F.clampDuration($("relaySegDur").value)));
    renderRelay();
    save();
  });
  $("relayRunBtn").addEventListener("click", runRelay);
  $("relayAssembleBtn").addEventListener("click", assembleRelay);
  $("relayComposeBtn").addEventListener("click", composeRelay);
  $("relayScenario").addEventListener("input", updateRelayButtons);
  $("relayScenario").addEventListener("change", () => { if (d?.relay) { d.relay.scenario = $("relayScenario").value; save(); } });
  $("videoDuration").addEventListener("change", renderCutHint);
  document.querySelectorAll("#studioNav .studio-nav-btn").forEach(b => b.addEventListener("click", () => {
    selectSection(b.dataset.section);
    if (MOBILE.matches) $(SECTIONS[b.dataset.section]).scrollIntoView({ block: "start" });
  }));
  // "New project" is the only thing that erases the saved project.
  $("studioNewBtn").addEventListener("click", () => {
    if (!confirm(t("Delete this project for good and start again from scratch?"))) return;
    try { localStorage.removeItem(SAVE_KEY); } catch { /* nothing saved */ }
    savedCache = null;
    reset();
  });
  // Leaving keeps the session: Generate starts a new one, Resume reopens the saved one.
  $("studioExitBtn").addEventListener("click", exitStudio);
  document.querySelectorAll(".sb-thumb").forEach(b => b.addEventListener("click", () => {
    const img = b.querySelector("img");
    if (img.getAttribute("src")) openLightbox({ url: img.src, type: "image" });
  }));
  document.addEventListener("langchange", () => {
    if (!d) return;
    renderSubjectTabs();
    renderShotList();
  });
  placeProjectActions();
  renderCutHint();
  reset();
}
