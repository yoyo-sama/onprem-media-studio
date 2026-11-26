// Director: the full-screen studio of the long take (the "sequence" pipeline, the "Narrative
// video" card): the Relay, chained or cut H3 segments from its first frame, its references
// or its text, no sheet to approve. The storyboard (shot list, shot images, animatic) was
// folded into the long take on 2026-11-21; reference to video became a one-click form
// pipeline the same day (studio.js), which only borrows the sheet maker below.
//
// Rules carried over from 1.4 (docs/LESSONS.md): nothing renders without a click; a
// prompt the user edited is sent verbatim and never compiled over; the anchoring
// blocks are re-appended by code.

import { api, blobToBase64, on, refURL, waitJob } from "./api.js";
import { L, LANG, t, translateTree, tx, txAttr } from "./i18n.js";
import { $, LLM, MOBILE, log, promptLog, runJob, warn } from "./ui.js";
import * as F from "./form.js";

const P = F.P;
const RELAY_MAX_SEGMENTS = 10;
// Default segment length: the longest H3 clip qualified on the GB10 (10 s → 10.125 s).
const RELAY_SEG_DEFAULT = 10;
const RELAY_TOTAL_MAX = RELAY_MAX_SEGMENTS * 15;
// Transition candidates, in frames before the end of a segment (24 fps): the last
// frame is not always the best start for the next segment (motion blur, drift).
const RELAY_TRANSITION_OFFSETS = [3, 6, 9, 12];
const SAVE_KEY = "studioProject";

let d = null;            // the session
let hooks = {};
let savedCache = null;   // valid saved project (drives "Resume the project")
export const active = () => !!d;
const out = (job, ext) => job.outputs.find(o => o.endsWith(ext)) || null;
const sameSession = s => d === s;

// ── Subjects ──────────────────────────────────────────────────────────────────
const newChar = (fields, variants = [], active = 0) => ({ fields, variants, active });
const activeVariant = c => c.variants[c.active];
const locVariant = () => d.locVariants[d.locActive];
const charDesc = c => P.charDescFromFields(c.fields);
const locDesc = () => P.locDescFromFields(d.locFields);
const h3Warn = (msg, params) => log("warn", msg, params);

// ── Studio shell ──────────────────────────────────────────────────────────────
const SECTIONS = { relay: "studioRelay" };
const navBtn = name => document.querySelector(`#studioNav [data-section="${name}"]`);
function enterStudio() { document.body.dataset.studio = "1"; hooks.onChange?.(); }
export function exitStudio() { delete document.body.dataset.studio; hooks.onChange?.(); }
function selectSection(name) {
  for (const [key, id] of Object.entries(SECTIONS)) $(id).hidden = key !== name;
  document.querySelectorAll("#studioNav .studio-nav-btn").forEach(b => b.classList.toggle("active", b.dataset.section === name));
}
export function placeProjectActions() {
  const box = document.querySelector(".studio-project-actions");
  (MOBILE.matches ? $("studioShell") : document.querySelector(".studio-nav-foot")).append(box);
}

// Ends the session (the saved project stays: only "New project" erases it).
export function reset() {
  d = null;
  exitStudio();
  $("relayList").replaceChildren();
  $("relayPlayer").replaceChildren();
  relayLive.clear();
  $("relayBoard").hidden = true;
  updateGate();
  selectSection("relay");
}

// ── Start ─────────────────────────────────────────────────────────────────────
const imported = img => ({ ref: img.ref, seed: null, source: "imported", prompt: null, status: "ready" });

// The sheet compilers, fed the image instead of the brief. A failed call leaves the
// fields empty (to fill by hand), never the instruction itself.
async function fieldsFromSheet(img, read, scene) {
  const b64 = await blobToBase64(await F.imageBlob(img));
  const fields = await read((system, user) => F.llm(system, user, [b64]), scene, promptLog);
  for (const k of Object.keys(fields)) if (fields[k] === scene) fields[k] = "";
  return fields;
}

function enterSession(s) {
  reset();
  d = s;
  enterStudio();
  selectSection("relay");
  renderRelay();
  updateGate();
  log("ok", "Long take open: read the segments, then generate the chain.");
  save();
}

// A long take from the form's two image fields, each with one role (`first`: {name, ref |
// blob} or null; `refs`: [{name, ref | blob, kind: "character" | "setting" | "object"}]):
// - the first frame: segment 1 starts on it, as it is, and keeps it (H3 i2v);
// - the references (7 at most, as Ref2VA from the form): who or what stays the same, each in
//   its role (a character or a sheet, an object, a setting: the first setting is the place).
//   Never a frame: Ref2VA sees them in every continuous segment, and segment 1 is made from
//   them when there is no first frame;
// - neither: segment 1 is H3 text to video and its last frame keeps the subject.
// With no reference, the first frame (or segment 1's last frame) is the subject's reference.
// Gemma's vision describes every image. The brief is the screenplay to split; written in the
// H3 layout (an imported file, P.parseScreenplay), it gives the segments, their lengths and
// the shared fields at once, word for word. End images are set on each segment's card.
// The H3 LoRA stack of the form goes to every segment.
export const LONG_TAKE_REFS = 7;
export async function startLongTake(seed, { first = null, refs = [], from = null } = {}) {
  const text = F.brief(), play = P.parseScreenplay(text);
  const place = refs.find(x => x.kind === "setting") || null, subjects = refs.filter(x => x !== place).slice(0, LONG_TAKE_REFS - (place ? 1 : 0));
  const ROLES = { character: "character", object: "reference", setting: "environment" };
  const images = [first, ...subjects, place].filter(Boolean);
  const [ups, descs] = await Promise.all([Promise.all(images.map(F.imageRef)), F.describeRefs(images)]);
  const up = img => ups[images.indexOf(img)], desc = img => descs[images.indexOf(img)] || "";
  const chars = subjects.length
    ? subjects.map(x => newChar({ kind: "other", subject: desc(x), role: ROLES[x.kind] || "character" }, [imported({ ref: up(x) })]))
    : [newChar({ kind: "other", subject: first ? desc(first) : "" }, first ? [imported({ ref: up(first) })] : [])];
  const s = {
    pipeline: "sequence", ...(from ? { from } : {}), wf: F.workflow("h3_sequence"), seed, ratio: $("ratioSelect").value, style: "none",
    loras: F.formLoras(), startImage: first ? { ref: up(first) } : null, refsGiven: subjects.length + (place ? 1 : 0),
    chars, locFields: place ? { place: desc(place) } : {}, locVariants: place ? [imported({ ref: up(place) })] : [],
    locActive: 0,
    relay: newRelay({ scenario: text, total: RELAY_SEG_DEFAULT, segMax: RELAY_SEG_DEFAULT,
      segments: [{ prompt: text, duration: RELAY_SEG_DEFAULT, endImage: null }] }),
  };
  if (play) applyScreenplay(s.relay, play, []);
  enterSession(s);
  if (!first) log("ok", s.refsGiven ? "No first frame: segment 1 is made from the references."
    : "No start image: segment 1 is generated from its text, and its last frame keeps the subject for the next segments.");
  showRelayComposer();
  renderRelay();
}

// A sheet for the form's references (a long take, or a video from references), made before
// anything renders: one click, one job, no approval step. "char": the brief's main subject (Krea 2), or the
// subject of a photo, which Gemma's vision describes and Qwen Image 2.1 draws in five
// views; "setting": the brief's place (Krea 2). `origin`: the gallery feature of the job.
// Returns the sheet's image.
const SUBJECT_FROM_PHOTO = "The scene is the attached photo: describe the main subject it shows, exactly as it looks there.";
export async function referenceSheet(kind, photo = null, origin = "relay") {
  const text = F.brief(), seed = F.formSeed();
  if (!photo && !text) throw new Error(t("Describe the scene in the brief before generating."));
  const meta = (label, info) => ({ origin, label: [label], sub: ["{info} · seed {seed}", { info, seed }] });
  let job;
  if (kind === "setting") {
    log("req", "Setting sheet: the place of the brief with {llm}…", { llm: LLM });
    const fields = await P.locationSheetFromBrief(F.llm, text, promptLog);
    job = await runJob("krea2-t2i", { prompt: P.locsheetPromptFrom(P.locDescFromFields(fields), "none"), ...P.SHEET_SIZE, count: 1, seed },
      meta("Setting sheet", "Krea 2"));
  } else if (photo) {
    log("req", "Subject sheet from a photo: {name} (Qwen Image 2.1)…", { name: photo.name });
    const fields = await fieldsFromSheet(photo, P.characterSheetFromBrief, SUBJECT_FROM_PHOTO);
    const prompt = P.charsheetFromPhotoPrompt(P.charDescFromFields(fields), P.charKindOf(fields), "none");
    job = await runJob("qwen-image-2.1", { prompt, images: [await F.imageRef(photo)], ...P.SHEET_SIZE, count: 1, seed },
      meta("Subject sheet", "Qwen Image 2.1"));
  } else {
    log("req", "Subject sheet: the main subject of the brief with {llm}…", { llm: LLM });
    const fields = await P.characterSheetFromBrief(F.llm, text, promptLog);
    job = await runJob("krea2-t2i", { prompt: P.charsheetPromptFrom(P.charDescFromFields(fields), P.charKindOf(fields), "auto", "none"),
      ...P.SHEET_SIZE, count: 1, seed }, meta("Subject sheet", "Krea 2"));
  }
  return out(job, ".png");
}

const STATUS_WORDS = { pending: L("Generating…"), error: L("Error"), missing: L("Missing"), ready: L("Ready"),
                       stale: L("To regenerate"), locked: L("Locked"), idle: L("To generate") };
const statusWord = st => STATUS_WORDS[st] || STATUS_WORDS.ready;

// ── Gate ──────────────────────────────────────────────────────────────────────
// A long take has nothing to approve: its Relay opens with the session.
function updateGate() {
  const b = navBtn("relay");
  b.disabled = !d;
  b.classList.toggle("locked", !d);
  updateRelayButtons();
  updateNavMarks();
}
// The menu reads as a checklist: ✓ once the take is assembled.
function updateNavMarks() { navBtn("relay").classList.toggle("done", !!d?.relay?.video?.ref); }

function player(wrap, ref) {
  wrap.replaceChildren();
  if (!ref) return;
  const vid = document.createElement("video");
  vid.controls = true;
  vid.playsInline = true;
  vid.src = refURL(ref);
  wrap.appendChild(vid);
}

// ── Relay (long take) ─────────────────────────────────────────────────────────
// A chain of short segments whose consistency comes from the chaining. 🔗 continue:
// the next segment starts on the previous one's transition frame, as it is (the only
// frame-exact continuity). 🎞 cut: a new shot rendered by H3 Ref2VA on the subjects'
// sheets (at most two) and the setting (its sheet, or else the previous segment's last
// frame), which H3 keeps in view for the whole clip, so a subject who left the frame
// comes back as itself. The first segment starts on the long take's first frame, or is
// made from its references or its text.
// `look` is written once and shared by every segment's prompt (camera, lighting,
// soundscape, music); a segment holds only its action and its own camera motion.
const newRelaySegment = (prompt = "", duration = RELAY_SEG_DEFAULT) => ({ prompt, duration, mode: "continue", status: "idle", ref: null,
  seed: 0, prompt_used: null, start: null, transitions: null, transitionIdx: 0, endImage: null });
const RELAY_LOOK_KEYS = ["subjects", "retention", "camera", "lighting", "sound", "music"];
// The cards are the plan: a new Relay gets one empty card per planned segment, and the
// total length of a given (or saved) chain is the sum of its cards.
function newRelay(p = {}) {
  const segMax = F.clampDuration(p.segMax ?? RELAY_SEG_DEFAULT);
  const given = p.segments?.length ? p.segments : relayDurations(clampTotal(p.total ?? 30), segMax).map(dur => newRelaySegment("", dur));
  const segments = given.map(seg => ({ ...newRelaySegment(), ...seg, status: seg.ref ? (seg.status === "stale" ? "stale" : "ready") : "idle" }));
  return {
    scenario: p.scenario || "", video: p.video || null, segMax, segments, ...(p.stitchJob ? { stitchJob: p.stitchJob } : {}),
    total: clampTotal(segments.reduce((sum, seg) => sum + seg.duration, 0)),
    look: Object.fromEntries(RELAY_LOOK_KEYS.map(k => [k, String(p.look?.[k] || "")])),
  };
}
function clampTotal(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(RELAY_TOTAL_MAX, Math.max(5, n)) : 30;
}
// The total length cut into as few segments as the maximum length allows, as even as
// possible (25 s at 10 s max → 8 + 8 + 9), each within H3's 5 to 15 s.
function relayDurations(total, segMax) {
  const n = Math.min(RELAY_MAX_SEGMENTS, Math.max(1, Math.ceil(total / segMax)));
  const base = Math.floor(total / n), extra = total - base * n;
  return Array.from({ length: n }, (_, i) => F.clampDuration(Math.min(segMax, base + (i >= n - extra ? 1 : 0))));
}
// A segment that continues the clip before it in latent space redoes that clip's last 22
// frames, and the take drops them (studio/pipelines/h3_continue.py). Its card length is what it
// adds to the take: H3 renders those 22 frames on top, the new part on the nearest step of the
// 17-frame grid, within H3's 15 s. Counted as a whole clip, a 30 s take came out 28.5 s while
// the plan said 30.4 s (GB10, 2026-11-25).
const TAIL_FRAMES = 22, CLIP_FRAMES_MAX = P.h3VideoFrames(15);
const linkFrames = sec => Math.min(CLIP_FRAMES_MAX, 17 * Math.round(sec * 24 / 17) + TAIL_FRAMES);
const linkSeconds = sec => Math.min(15, linkFrames(sec) / 24);
// Segment i continues the one before it in latent space, as the chain will send it: a long
// take from the text has its subject (segment 1's last frame) once segment 1 is queued.
const linked = i => latentLink(i) || (i > 0 && continuous(d.relay.segments[i]) && !d.relay.segments[i].endImage && !d.startImage);
// Seconds segment i adds to the take.
const takeSeconds = (seg, i) => linked(i) ? (linkFrames(seg.duration) - TAIL_FRAMES) / 24 : P.h3RealDuration(seg.duration);
const takeLength = (segs, keep = () => true) => segs.reduce((sum, seg, i) => sum + (keep(seg) ? takeSeconds(seg, i) : 0), 0);
// "00:10.1": a position in the sequence, from the durations H3 really renders.
const clock = sec => `${String(Math.floor(sec / 60)).padStart(2, "0")}:${(sec % 60).toFixed(1).padStart(4, "0")}`;
// The subjects the Relay follows: the long take's references, sent straight to Ref2VA.
// While a segment 1 made from the text is queued in the chain, its last frame to come is the
// main subject's reference (the segments after it continue it with that frame in view).
const textFrame = () => { const s0 = d.relay?.segments[0]; return inChain(s0) && s0.textStart ? { job: s0.job, output: ".png" } : null; };
const relaySubjects = () => d.chars.map((c, k) => ({ c, ref: (k === 0 && textFrame()) || activeVariant(c)?.ref })).filter(x => x.ref)
  .slice(0, LONG_TAKE_REFS).map(({ c, ref }) => ({ desc: charDesc(c), kind: P.charKindOf(c.fields), role: c.fields.role, ref }));
const relayBusy = () => !!d?.relay?.segments.some(seg => seg.status === "pending");
const relayReady = () => !!d?.relay?.segments.length && d.relay.segments.every(seg => seg.prompt.trim());
const continuous = seg => seg.mode === "continue";
// A continuous segment with the subjects' sheets continues the clip before it in latent space
// (h3-r2v continue_from: the previous clip's last second as context, docs/LONG-VIDEO.md); it
// needs no start image. Without sheets, or with an end image (FL2VA), a continuous segment still
// starts on the previous segment's transition frame (i2v).
const latentLink = i => {
  const seg = d?.relay?.segments[i];
  return i > 0 && !!seg && continuous(seg) && !seg.endImage && relayRefs(settingSheet()).length > 0;
};
// Segment i takes no frame of the clip before it: a latent link, or a new scene of the split.
const takesNoFrame = i => latentLink(i) || (!!d?.relay?.segments[i]?.scene && !continuous(d.relay.segments[i]));
// Segment i starts on a frame of the clip before it: a continuous segment without a latent
// link, or a cut with no setting of its own (no setting sheet, not a new scene).
const usesFrame = i => {
  const seg = d?.relay?.segments[i];
  return i > 0 && !!seg && !latentLink(i) && (continuous(seg) || (!seg.scene && !settingSheet()));
};
const transitionOf = seg => (seg?.transitions?.length ? seg.transitions[Math.min(seg.transitionIdx || 0, seg.transitions.length - 1)] : null);

function updateRelayButtons() {
  const r = d?.relay, busy = relayBusy();
  $("relayComposeBtn").disabled = !r || busy || !$("relayScenario").value.trim();
  $("relayImportBtn").disabled = !r || busy;
  document.querySelectorAll("#relayLook textarea").forEach(el => { el.disabled = !r || busy; });
  $("relayRunBtn").disabled = !r || !relayReady() || busy;
  const from = relayResumeFrom();
  if (!r || from === 0) tx($("relayRunBtn"), "Generate the chain");
  else if (from < r.segments.length) tx($("relayRunBtn"), "Continue the chain from segment {n}", { n: from + 1 });
  else tx($("relayRunBtn"), "Generate the chain again");
  $("relayStopBtn").hidden = !relayRunning;
  $("relayStopBtn").disabled = relayStop;
  tx($("relayStopBtn"), relayStop ? "Stopping after this segment…" : "⏹ Stop after this segment");
  $("relayAddBtn").disabled = !r || r.segments.length >= RELAY_MAX_SEGMENTS || busy;
  // A segment "to regenerate" still has its file: the sequence can be assembled.
  $("relayAssembleBtn").disabled = !r || busy || !r.segments.length || !r.segments.every(seg => seg.ref && ["ready", "stale"].includes(seg.status));
}

// The whole screenplay split by Gemma into consecutive segments, written for the H3
// grammar with the subjects as stand-ins. It REPLACES the chain: asked first.
// `scenes`: how many scenes the screenplay holds, one per paragraph, when that is known (an
// assistant card's screenplay), else 0.
async function composeRelay(scenes = 0) {
  const r = d?.relay, text = $("relayScenario").value.trim();
  if (!r || !text) return;
  const durs = relayDurations(r.total, r.segMax), n = durs.length;
  // Asked only when something would be lost: a render, or a text that is not the screenplay
  // itself (a long take opens with it in every card).
  if (r.segments.some(seg => seg.ref || (seg.prompt.trim() && seg.prompt.trim() !== text))
      && !confirm(t("Replace the current segments with the split screenplay?"))) return;
  // A screenplay in the H3 layout is split as written: no Gemma.
  const play = P.parseScreenplay(text);
  if (play) {
    r.scenario = text;
    applyScreenplay(r, play, r.segments.map(seg => seg.endImage));
    showRelayComposer();
    renderRelay();
    save();
    return;
  }
  const btn = $("relayComposeBtn");
  btn.disabled = true;
  tx(btn, "Splitting…");
  try {
    log("req", "Relay: splitting the screenplay into {n} segments with {llm}…", { n, llm: LLM });
    const { segments: list, look, cuts } = await P.composeScenario(F.llm, text, n, locDesc(), RELAY_MAX_SEGMENTS, relaySubjects(), scenes);
    // The end images stay with the segment of the same rank (a long take's key images). A
    // segment that starts a new scene is a cut (🎞): Ref2VA from the references.
    const ends = r.segments.map(seg => seg.endImage);
    r.segments = list.map((prompt, i) => ({ ...newRelaySegment(prompt, durs[Math.min(i, n - 1)]),
      ...(cuts.includes(i) ? { mode: "cut", scene: true } : {}), endImage: ends[i] || null }));
    if (cuts.length) log("ok", "Relay: {n} new shot(s) found in the screenplay: their segments start with a cut (🎞).", { n: cuts.length });
    syncRelayTotal();
    r.scenario = text;
    // The shared look fills only the fields left empty: what the user wrote stays. With new
    // scenes, Gemma's shared light and sounds spanned every place and time of day, and each
    // segment carried them all (the sea in the street, GB10 2026-11-21): each scene's segment
    // names its own, and those two fields are left as the user wrote them.
    const kept = RELAY_LOOK_KEYS.filter(k => r.look[k].trim());
    const perScene = cuts.length ? ["lighting", "sound"] : [];
    for (const k of RELAY_LOOK_KEYS) if (!r.look[k].trim() && !perScene.includes(k)) r.look[k] = look[k] || "";
    if (cuts.length) log("ok", "Relay: several scenes: each one's light and sounds are written in its segments, not in the shared fields.");
    if (kept.length) log("ok", "Relay: your shared fields were kept ({n}), Gemma filled the empty ones.", { n: kept.length });
    // Gemma may write one segment more or less: kept, and said.
    if (list.length === n) log("ok", "Relay: {n} segments written: read them before starting the chain.", { n });
    else log("warn", "Relay: {got} segments written ({n} asked): read them before starting the chain.", { got: list.length, n });
  } catch (err) {
    log("warn", "Screenplay split unavailable ({error}): segments unchanged.", { error: err.message });
  } finally { tx(btn, "✨ Split the screenplay"); }
  showRelayComposer();
  renderRelay();
  save();
}

// A long take just opened by Generate: the length asked, then its screenplay split by Gemma
// as "✨ Split the screenplay" does (the form once opened every long take as one 10 s card
// holding the whole brief). Nothing renders; a screenplay in the H3 layout already gave its
// segments. `scenes`: the screenplay has one paragraph per scene (an assistant card's, the
// Director's rule). `end`: the end image of the video ({ref, name}), on its last segment.
export async function splitLongTake(total, { scenes = false, end = null } = {}) {
  const r = d?.relay;
  if (!r) return;
  if (r.segments.length === 1) {
    if (total) { r.total = clampTotal(total); fitRelayToPlan(); }
    // A long take of one segment keeps the brief word for word.
    if (r.segments.length > 1) await composeRelay(scenes ? r.scenario.split(/\n\s*\n/).filter(p => p.trim()).length : 0);
  }
  const last = r.segments[r.segments.length - 1];
  if (end && last && (r.segments.length === 1 || continuous(last))) { last.endImage = end; renderRelay(); save(); }
}

// A screenplay in the H3 layout becomes the chain as written: one card per segment, its
// length from its timestamps (5 to 15 s), the first segment of a later shot a new scene (🎞,
// as a split's: from the references, its shot line naming its place), and the shared fields
// the file gives (they replace the ones shown). Nothing renders.
function applyScreenplay(r, play, ends = []) {
  const list = play.segments.slice(0, RELAY_MAX_SEGMENTS);
  r.segments = list.map((seg, i) => ({ ...newRelaySegment(seg.prompt, F.clampDuration(seg.duration || r.segMax, r.segMax)),
    ...(i > 0 && seg.mode === "cut" ? { mode: "cut", scene: true } : { mode: "continue" }), endImage: ends[i] || null }));
  for (const k of play.given) r.look[k] = play.look[k];
  r.segMax = F.clampDuration(Math.max(...r.segments.map(seg => seg.duration)), r.segMax);
  r.total = clampTotal(r.segments.reduce((sum, seg) => sum + seg.duration, 0));
  log("ok", "Relay: screenplay read as written: {n} segment(s), {fields} shared field(s).", { n: r.segments.length, fields: play.given.length });
  if (play.segments.length > list.length)
    log("warn", "Relay: the screenplay has {n} segments, the long take holds {max}: the first {max} were kept.", { n: play.segments.length, max: RELAY_MAX_SEGMENTS });
  const off = list.filter((seg, i) => seg.duration !== r.segments[i].duration).length;
  if (off) log("warn", "Relay: {n} segment length(s) brought into H3's 5 to 15 s.", { n: off });
}

// Composer and shared fields from the session (on open, restore and after a split).
function showRelayComposer() {
  const r = d?.relay;
  $("relayScenario").value = r?.scenario || "";
  $("relayTotal").value = r?.total ?? 30;
  $("relaySegDur").value = r?.segMax ?? RELAY_SEG_DEFAULT;
  document.querySelectorAll("#relayLook textarea").forEach(el => { el.value = r?.look[el.dataset.look] || ""; });
  // The shared fields stay folded while they are all empty, and open once one is written
  // (by the user or by the split): what goes into every prompt is in view.
  $("relayLook").open = !!r && RELAY_LOOK_KEYS.some(k => r.look[k].trim());
  renderRelayPlan();
}
// The plan line says what "Generate the chain" renders: the segment cards, never a count
// the cards do not have (a 5 × 10 s plan once ran as its 3 cards, LESSONS #51).
function renderRelayPlan() {
  const r = d?.relay;
  if (!r) { $("relayPlan").textContent = ""; return; }
  const durs = r.segments.map(seg => seg.duration), empty = r.segments.filter(seg => !seg.prompt.trim()).length;
  const line = t("→ {n} segment(s): {list} s, {real} s rendered", { n: durs.length, list: durs.join(" + "), real: takeLength(r.segments).toFixed(1) });
  $("relayPlan").textContent = empty ? `${line} · ${t("{n} segment(s) still to write", { n: empty })}` : line;
}
// The total length is the sum of the cards: kept so after a card is added, removed or
// changed length.
function syncRelayTotal() {
  const r = d?.relay;
  if (!r) return;
  r.total = clampTotal(r.segments.reduce((sum, seg) => sum + seg.duration, 0));
  $("relayTotal").value = r.total;
}
// A new total length or maximum per segment reshapes the cards: the plan's lengths go to
// the cards not rendered yet, missing cards are added empty (to write before the chain
// can start), extra cards are removed when empty. A card with text or a render is never
// removed: it stays, and the log says so. Nothing renders.
function fitRelayToPlan() {
  const r = d?.relay;
  if (!r || relayBusy()) return;
  const durs = relayDurations(r.total, r.segMax);
  r.segments.forEach((seg, k) => { if (k < durs.length && !seg.ref) seg.duration = durs[k]; });
  for (let k = r.segments.length; k < durs.length; k++) r.segments.push(newRelaySegment("", durs[k]));
  while (r.segments.length > durs.length) {
    const last = r.segments[r.segments.length - 1];
    if (last.prompt.trim() || last.ref || last.endImage) break;
    r.segments.pop();
  }
  const kept = r.segments.length - durs.length;
  if (kept > 0) log("warn", "Relay: {n} written segment(s) kept beyond the plan: remove them (✕ under the advanced options) for a shorter take.", { n: kept });
  syncRelayTotal();
  renderRelay();
}

function renderRelay() {
  const list = $("relayList"), r = d?.relay;
  if (!r) { list.replaceChildren(); updateRelayButtons(); return; }
  const busy = relayBusy();
  let at = 0;
  list.replaceChildren(...r.segments.map((seg, i) => {
    const from = at;
    at += takeSeconds(seg, i);
    const el = document.createElement("div");
    el.className = "relay-seg";
    el.dataset.seg = String(i);
    el.innerHTML = `<div class="seg-head"><strong></strong><span class="seg-status"></span></div>
      <textarea spellcheck="false" placeholder="What happens in this segment, and its own camera motion."></textarea>
      <div class="seg-row seg-start-row" hidden>
        <label class="seg-start-ratio"><span>Video format</span><select>${Object.keys(F.QWEN21_RATIOS).map(k => `<option data-raw>${k}</option>`).join("")}</select></label>
      </div>
      <div class="seg-row">
        <label>Length (s)<input type="number" min="5" max="15"></label>
        <button type="button" class="secondary-btn seg-link"></button>
        <button type="button" class="secondary-btn seg-enrich">✨ Enrich</button>
        <button type="button" class="secondary-btn seg-regen">🔄 Regenerate</button>
      </div>
      <video muted controls preload="metadata" hidden></video>
      <details class="seg-more">
        <summary>Advanced options</summary>
        <div class="seg-row">
          <button type="button" class="secondary-btn seg-end"></button>
          <button type="button" class="secondary-btn seg-del">✕ Remove the segment</button>
          <input type="file" class="seg-end-file" accept="image/*" hidden>
        </div>
        <div class="relay-endframe" hidden></div>
        <div class="relay-transitions" hidden></div>
      </details>`;
    tx(el.querySelector("strong"), "Segment {n}/{total} · {from}–{to}", { n: i + 1, total: r.segments.length, from: clock(from), to: clock(at) });
    tx(el.querySelector(".seg-status"), statusWord(seg.status));
    const area = el.querySelector("textarea");
    area.value = seg.prompt;
    area.addEventListener("change", () => { seg.prompt = area.value; updateRelayButtons(); save(); });
    area.addEventListener("input", () => { seg.prompt = area.value; updateRelayButtons(); });
    const dur = el.querySelector('input[type="number"]');
    dur.value = seg.duration;
    dur.addEventListener("change", () => { seg.duration = F.clampDuration(dur.value, seg.duration); syncRelayTotal(); renderRelay(); save(); });
    const link = el.querySelector(".seg-link");
    // The first segment has no link: it starts on the first frame, the references or the text.
    if (i === 0) link.hidden = true;
    if (i === 0) renderStartChoice(el.querySelector(".seg-start-row"), seg, busy);
    else if (i > 0) {
      tx(link, continuous(seg) ? "🔗 Continuous" : seg.scene ? "🎞 New scene (from the references)" : "🎞 Cut (new shot from the references)");
      txAttr(link, "title", continuous(seg)
        ? "The segment carries on from the previous one, movement included (its last second is carried over), and keeps the subjects' sheets in view so they stay the same. Click for a cut."
        : seg.scene ? "A new scene of the screenplay: a new shot rendered from the subjects' references and its own text; the previous place is not carried over. Click for a continuous segment."
        : "A deliberate cut: a new shot rendered from the references (the subjects' sheets and the setting, or else the previous segment's transition image: choose one where nobody is in view), so a subject who left the frame comes back as itself. Click for a continuous segment.");
      link.classList.toggle("active", continuous(seg));
      link.disabled = busy;
      link.addEventListener("click", () => { seg.mode = seg.mode === "continue" ? "cut" : "continue"; delete seg.scene; renderRelay(); save(); });
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
    // Shown once there is a render to make again.
    regen.hidden = !["ready", "stale", "error"].includes(seg.status);
    regen.disabled = busy;
    regen.addEventListener("click", () => regenerateSegment(i));
    renderEndImage(el, i, seg, busy);
    const del = el.querySelector(".seg-del");
    del.disabled = busy || r.segments.length < 2;
    del.addEventListener("click", () => { r.segments.splice(i, 1); syncRelayTotal(); renderRelay(); save(); });
    const vid = el.querySelector("video");
    if (seg.ref) { vid.hidden = false; vid.src = refURL(seg.ref); }
    renderTransitions(el.querySelector(".relay-transitions"), i, seg, busy);
    // Advanced options stay open across renders once opened, or when they hold something.
    const more = el.querySelector(".seg-more");
    more.open = moreOpen.has(seg) || !!seg.endImage;
    more.addEventListener("toggle", () => { if (more.open) moreOpen.add(seg); else moreOpen.delete(seg); });
    return el;
  }));
  translateTree(list);
  renderRelayPlan();
  updateRelayButtons();
  renderBoard();
}

// The format of a long take with no first frame (segment 1 from the text or from the
// references); a first frame sets its own. Changing it starts nothing: a rendered first
// segment becomes "to regenerate".
function renderStartChoice(row, seg, busy) {
  row.hidden = !!d.startImage;
  if (row.hidden) return;
  const sel = row.querySelector("select");
  sel.value = F.QWEN21_RATIOS[d.ratio] ? d.ratio : "16:9";
  sel.disabled = busy;
  sel.addEventListener("change", () => { d.ratio = sel.value; if (seg.status === "ready") seg.status = "stale"; renderRelay(); save(); });
}

// ── Relay production board ────────────────────────────────────────────────────
// One tile per segment, as wide as its length: start image, place in the sequence,
// state, and the progress of the job running for it; a click goes to the segment. The
// summary says what is done, what runs and, once a segment has been timed, about how
// long is left. Live state (job, progress) is never saved.
const relayLive = new Map();      // segment → {phase, id, progress, start}
const moreOpen = new WeakSet();   // segments whose advanced options are open
let relayRunning = false, relayStop = false;
const PHASE_WORDS = { queued: L("Queued"), video: L("Video"), frames: L("Transition frames") };
on("job", job => {
  for (const live of relayLive.values()) if (live.id === job.id) {
    live.status = job.status;
    if (job.status === "running" && live.phase === "queued") { live.phase = "video"; live.start = Date.now(); }
    live.progress = job.status === "done" ? 1 : job.progress || 0;
    renderBoard();
  }
});
// Runs `fn(onSubmitted)` as the `phase` of segment `seg`, its job followed on the board.
async function tracked(seg, phase, fn) {
  const live = { phase, id: null, progress: 0, start: relayLive.get(seg)?.start || Date.now() };
  relayLive.set(seg, live);
  renderBoard();
  return fn(job => { live.id = job.id; });
}
// First segment the chain has to render: the first one not ready (none: all are).
function relayResumeFrom() {
  const segs = d?.relay?.segments || [];
  const k = segs.findIndex(seg => seg.status !== "ready");
  return k < 0 ? segs.length : k;
}
const minutes = sec => Math.max(1, Math.round(sec / 60));

function renderBoard() {
  const board = $("relayBoard"), r = d?.relay;
  if (!board) return;
  if (!r || !r.segments.length) { board.hidden = true; return; }
  board.hidden = false;
  const strip = board.querySelector(".relay-strip"), segs = r.segments;
  let at = 0;
  strip.replaceChildren(...segs.map((seg, i) => {
    const from = at, live = relayLive.get(seg);
    at += takeSeconds(seg, i);
    const b = document.createElement("button");
    b.type = "button";
    b.className = `relay-tile st-${seg.status}`;
    b.style.flexGrow = String(seg.duration);
    b.innerHTML = `<span class="tile-thumb"></span><span class="tile-cap"></span><span class="tile-bar"><i></i></span>`;
    const thumb = seg.start?.ref || (i > 0 && seg.mode === "continue" ? transitionOf(segs[i - 1])?.ref || segs[i - 1].lastFrame : null);
    if (thumb) { const img = document.createElement("img"); img.alt = ""; img.src = refURL(thumb); b.firstChild.appendChild(img); }
    b.querySelector(".tile-cap").textContent = `${i + 1} · ${clock(from)}`;
    const pct = live ? Math.round(live.progress * 100) : seg.status === "ready" ? 100 : 0;
    b.querySelector(".tile-bar i").style.width = `${pct}%`;
    const state = live ? `${t(PHASE_WORDS[live.phase])} ${t("{n}%", { n: pct })}` : t(statusWord(seg.status));
    b.title = t("Segment {n}: {status}", { n: i + 1, status: state });
    b.setAttribute("aria-label", b.title);
    b.addEventListener("click", () => focusSegment(i));
    // The card's status follows the job too.
    const st = document.querySelector(`#relayList .relay-seg[data-seg="${i}"] .seg-status`);
    if (st && live) st.textContent = state;
    return b;
  }));
  // Summary: segments ready, seconds rendered, the segment running and the time left.
  const ready = segs.filter(seg => seg.status === "ready"), done = takeLength(segs, seg => seg.status === "ready");
  const parts = [t("{n}/{total} segments ready · {done} s of {all} s", { n: ready.length, total: segs.length,
    done: done.toFixed(1), all: takeLength(segs).toFixed(1) })];
  const timed = segs.filter(seg => seg.renderSec > 0);
  if (relayRunning && timed.length) {
    const avg = timed.reduce((sum, seg) => sum + seg.renderSec, 0) / timed.length;
    const runningIdx = segs.findIndex(seg => relayLive.get(seg)?.phase === "video");
    const left = runningIdx < 0 ? 0 : Math.max(0, avg - (Date.now() - relayLive.get(segs[runningIdx]).start) / 1000)
      + avg * segs.slice(runningIdx + 1).filter(seg => seg.status !== "ready").length;
    if (left > 0) parts.push(t("about {n} min left", { n: minutes(left) }));
  }
  board.querySelector(".relay-summary").textContent = parts.join(" · ");
}
function focusSegment(i) {
  const el = document.querySelector(`#relayList .relay-seg[data-seg="${i}"]`);
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
  el.querySelector("textarea")?.focus({ preventScroll: true });
}

// End image of a segment: the segment renders from its start image to that one (FL2VA).
function renderEndImage(el, i, seg, busy) {
  const btn = el.querySelector(".seg-end"), wrap = el.querySelector(".relay-endframe"), input = el.querySelector(".seg-end-file");
  // A cut is rendered from references, which take no end image.
  btn.hidden = i > 0 && !continuous(seg);
  if (btn.hidden) return;
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
  // A latent link, or a new scene, takes no frame of the clip before it: nothing to choose.
  if (!seg.transitions?.length || i >= d.relay.segments.length - 1 || takesNoFrame(i + 1)) return;
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

// ── Relay chain ───────────────────────────────────────────────────────────────
// The click on "Generate the chain" queues the whole chain at once on the server: every
// segment's job, then the take (video-stitch). A file a segment takes from the one before it
// (its clip, its last frame) is that segment's file once rendered or, while that segment is
// queued in the same chain, its job's output to come ({job, output}: the server writes the
// file in when its turn comes). So the chain runs to its end even when this page is closed
// or the computer sleeps (a 5 × 10 s take stopped after segment 1, 2026-11-23); the page only
// follows it, and picks it up again when the project is resumed.
const inChain = seg => seg?.status === "pending" && !!seg.job;
const clipOf = seg => (inChain(seg) ? { job: seg.job, output: ".mp4" } : seg?.ref || null);
const frameOf = seg => (inChain(seg) ? { job: seg.job, output: ".png" } : seg?.ref ? transitionOf(seg)?.ref || seg.lastFrame : null);

// Segment i's job, {pipeline, params, meta}; also writes the prompt it sends (prompt_used).
function segmentJob(s, i) {
  const r = s.relay, seg = r.segments[i], total = r.segments.length, before = i > 0 ? r.segments[i - 1] : null;
  const label = [L("Relay · segment {n}/{total}"), { n: i + 1, total }];
  const noLink = () => new Error(t("Relay, segment {n}: no continuous link possible, segment {p} has no transition frame. Regenerate it.", { n: i + 1, p: i }));
  const r2v = (refs, from, how) => ({ pipeline: "h3-r2v",
    params: { prompt: seg.prompt_used, duration: from.continue_from ? linkSeconds(seg.duration) : seg.duration, seed: seg.seed, loras: s.loras || [], references: refs.map(x => x.ref), ...from },
    meta: { label, sub: ["{info} · seed {seed}", { info: `Ref2VA · ${refs.length} ref.${how} · ${seg.duration} s`, seed: seg.seed }] } });
  seg.textStart = false;
  seg.start = null;
  // A continuous segment with sheets: H3 Ref2VA on the subjects' sheets (and the setting's),
  // continuing the previous clip in latent space. No start image, no join to check: the clip
  // carries on from the previous one's last second, and the take is decoded in one go.
  if (latentLink(i)) {
    const prev = clipOf(before);
    if (!prev) throw noLink();
    const refs = relayRefs(settingSheet());
    log("req", "Relay, segment {n}/{total}: video continuing the previous segment…", { n: i + 1, total });
    seg.prompt_used = relayCutPrompt(seg, r.look, refs, s.style, true);
    return r2v(refs, { continue_from: prev }, " + continuation");
  }
  // A cut: H3 Ref2VA with no start image and no end image. Its setting is the setting's sheet,
  // or else the previous segment's chosen transition frame (its last frame unless another is
  // chosen). A subject still visible in that frame is drifted already and wins over its sheet
  // (GB10, 2026-11-15): the user picks a frame where nobody is in view. A new scene of the
  // split (`scene`) takes no frame of the previous place: H3 kept that place (the sea at the
  // end of the street, the town in the train window, GB10 2026-11-21). A long take with no
  // first frame but references starts the same way.
  if ((i > 0 && !continuous(seg)) || (i === 0 && !s.startImage && s.refsGiven)) {
    const frame = i > 0 && !seg.scene && !settingSheet() ? frameOf(before) : null;
    const refs = relayRefs(settingSheet() || (frame ? { ref: frame, desc: "" } : null));
    log("req", "Relay, segment {n}/{total}: video from the references (cut)…", { n: i + 1, total });
    seg.prompt_used = relayCutPrompt(seg, r.look, refs, s.style);
    return r2v(refs, { aspect: s.ratio }, "");
  }
  // The first segment of a long take with no start image: H3 text to video at the long take's
  // format. Its last frame becomes the subject's reference, as a long take's start picture is,
  // so the segments after it continue it in latent space with that frame in view.
  if (i === 0 && !s.startImage) {
    log("req", "Relay, segment {n}/{total}: video from the text…", { n: i + 1, total });
    seg.textStart = true;
    seg.prompt_used = P.buildRelayTextPrompt(seg.prompt.trim(), r.look, s.style, h3Warn);
    const aspect = F.QWEN21_RATIOS[s.ratio] ? s.ratio : "16:9";
    return { pipeline: "h3-t2v", params: { prompt: seg.prompt_used, duration: seg.duration, seed: seg.seed, loras: s.loras || [], aspect },
      meta: { label, sub: ["{info} · seed {seed}", { info: `T2VA · ${aspect} · ${seg.duration} s`, seed: seg.seed }] } };
  }
  // Segment 1 starts on the long take's first frame, as it is; a continuous one on the
  // previous segment's transition frame (🔗 without one: refused rather than a silent cut).
  const start = i === 0 ? s.startImage.ref : frameOf(before);
  if (!start) throw noLink();
  if (i > 0) log("req", "Relay, segment {n}/{total}: video (continuous link)…", { n: i + 1, total });
  if (typeof start === "string") seg.start = { ref: start };
  const last = seg.endImage?.ref || null;
  // With the subjects' sheets, a segment starts on its frame AND sees the sheets (Ref2VA with a
  // start frame, held still for its first 0.9 s: h3_start_frame.py): i2v sees only its first
  // frame, so the person drifted from the sheet until the next segment (GB10 2026-11-21).
  // An end image (FL2VA) stays i2v: Ref2VA takes no last frame. A long take's first frame
  // takes only the references the user gave for who or what stays the same, never a setting:
  // the frame is the place, and a place image framed otherwise wins over it (GB10 2026-11-16).
  // With none, or in a described scene (that frame is the place, and the segments after it
  // see it as the location), segment 1 stays i2v on its frame.
  const firstFrame = i === 0, place = firstFrame && describedScene();
  const refs = last ? [] : firstFrame ? firstFrameRefs(s) : relayRefs(settingSheet());
  if (refs.length) {
    seg.prompt_used = relayCutPrompt(seg, r.look, refs, s.style);
    return r2v(refs, { image: start }, " + start");
  }
  const subs = relaySubjects();
  seg.prompt_used = place
    ? P.buildRelaySegmentPrompt(seg.prompt.trim(), r.look, [], subs[0].desc?.trim() || "the place in this picture", seg.duration, !!last, s.style, h3Warn)
    : P.buildRelaySegmentPrompt(seg.prompt.trim(), r.look, subs, locDesc(), seg.duration, !!last, s.style, h3Warn);
  return { pipeline: "h3-i2v", params: { prompt: seg.prompt_used, duration: seg.duration, seed: seg.seed, loras: s.loras || [], image: start,
    ...(last ? { last_image: last } : {}) },
    meta: { label, sub: ["{info} · seed {seed}", { info: `${last ? "FL2VA" : "I2VA"} · ${seg.duration} s → ${P.h3RealDuration(seg.duration).toFixed(2)} s`, seed: seg.seed }] } };
}

// Submits a job; resolves once the server has it with {done}, the promise of its end.
function submitted(pipeline, params, meta, onId) {
  return new Promise((resolve, reject) => {
    const done = runJob(pipeline, params, { origin: "relay", ...meta, onSubmitted: job => { onId(job.id); resolve({ done }); } });
    done.catch(reject);
  });
}
// Queues segment i: "pending" (queued) from here, followed on the board.
async function queueSegment(s, i) {
  const r = s.relay, seg = r.segments[i], before = i > 0 ? r.segments[i - 1] : null;
  // A rendered segment this one starts from: its transition frames, to choose from later
  // (and the only frame of a segment saved before its last frame was kept).
  if (before && !inChain(before) && usesFrame(i)) await ensureTransitions(before, i - 1, r.segments.length);
  if (!sameSession(s)) throw new Error(t("Project cancelled."));
  const spec = segmentJob(s, i);
  seg.status = "pending";
  const live = { phase: "queued", status: "queued", id: null, progress: 0, start: Date.now() };
  relayLive.set(seg, live);
  renderRelay();
  try {
    return await submitted(spec.pipeline, spec.params, spec.meta, id => { seg.job = id; live.id = id; save(); });
  } catch (err) { relayLive.delete(seg); seg.status = seg.ref ? "stale" : "idle"; throw err; }
}
// The take of a chain, queued after its segments: their clips, or their outputs to come.
function queueStitch(s) {
  const r = s.relay, clips = r.segments.map(clipOf);
  return submitted("video-stitch", { clips }, { label: ["Relay · sequence"], sub: ["{n} clip(s)", { n: clips.length }] },
    id => { r.stitchJob = id; save(); });
}
const cancelJobs = ids => Promise.all(ids.filter(Boolean).map(id => api.cancel(id).catch(() => {})));

// A rendered segment: its clip and last frame (and, for a segment from the text, the
// subject's reference), then the transition frames a later choice may take, while the page is
// open. Ready at once: the chain already goes on with its last frame.
async function segmentDone(s, seg, i, job) {
  seg.ref = out(job, ".mp4");
  seg.lastFrame = out(job, ".png");
  seg.transitions = null;
  seg.transitionIdx = 0;
  if (typeof job.params?.image === "string") seg.start = { ref: job.params.image };
  if (seg.textStart && seg.lastFrame) { s.chars[0].variants = [imported({ ref: seg.lastFrame })]; s.chars[0].active = 0; }
  delete seg.job;
  seg.status = "ready";
  seg.renderSec = job.started && job.finished ? Math.round(job.finished - job.started) : 0;
  relayLive.delete(seg);
  renderRelay();
  save();
  const total = s.relay.segments.length;
  if (i < total - 1 && usesFrame(i + 1)) {
    try { await extractTransitions(seg, i, total); }
    catch (err) { relayLive.delete(seg); warn(err); }
    if (!sameSession(s)) return;
    renderRelay();
    save();
  }
}

// Follows a queued chain: `items` [{i, done}] in order, then `stitch` ({done} or null). A
// segment that fails or is cancelled ends it: the jobs queued after it are taken off the queue.
async function followChain(s, items, stitch) {
  const r = s.relay;
  for (let k = 0; k < items.length; k++) {
    const { i, done } = items[k], seg = r.segments[i];
    let job;
    try { job = await done; }
    catch (err) {
      if (!sameSession(s)) return;
      const stopped = err.message === "cancelled", rest = items.slice(k + 1).map(x => r.segments[x.i]);
      await cancelJobs([...rest.map(x => x.job), stitch ? r.stitchJob : null]);
      for (const x of [seg, ...rest]) { relayLive.delete(x); delete x.job; x.status = x.ref ? "stale" : "idle"; }
      if (!stopped) seg.status = "error";
      delete r.stitchJob;
      if (stopped) log("ok", "Relay: chain stopped after segment {n}. Continue it when you want.", { n: i });
      else warn(err);
      renderRelay();
      save();
      return;
    }
    if (!sameSession(s)) return;
    await segmentDone(s, seg, i, job);
    if (!sameSession(s)) return;
  }
  if (!stitch) return;
  log("req", "Relay: assembling the sequence…");
  try {
    const job = await stitch.done;
    if (!sameSession(s)) return;
    r.video = { ref: out(job, ".mp4") };
    player($("relayPlayer"), r.video.ref);
    updateNavMarks();
    log("ok", "Relay: sequence assembled.");
  } catch (err) {
    if (!sameSession(s)) return;
    if (err.message !== "cancelled") warn(err);
  }
  delete r.stitchJob;
  updateRelayButtons();
  save();
}


// The Relay's H3 Ref2VA references: the sheets of the first two subjects with one (the first
// is the main character, a further human one a character, a non-human one a reference), then
// the setting, if any.
// A long take keeps its references in the roles given in the form. With none, its first frame
// (or, with none, segment 1's last frame) is the main character; but when its screenplay is in
// the H3 layout and names no <Subject N>, it describes a scene, and that picture is the
// scene's reference, the location.
// A take of several scenes sends no setting reference: each scene's place is written in its
// own segments. Every setting sheet went to every segment, and the subject was anchored in
// the first one: the cottage stood in the open sea (GB10 2026-11-21). With only settings
// given, they stay.
// Each reference keeps `n`, its number in the split's legend (the subjects, then the setting).
function relayRefsAll(setting) {
  const scene = describedScene();
  return [...relaySubjects().map((x, k) => ({ kind: k === 0 && scene ? "environment" : x.role || (k === 0 || x.kind === "human" ? "character" : "reference"),
    desc: x.desc, ref: x.ref })),
    ...(setting ? [{ kind: "environment", ...setting }] : [])].map((x, k) => ({ ...x, n: k + 1 }));
}
function relayRefs(setting) {
  const all = relayRefsAll(setting);
  if (!d.relay.segments.some(seg => seg.scene)) return all;
  const kept = all.filter(x => x.kind !== "environment");
  return kept.length ? kept : all;
}
// The split numbered every subject of the take (<Subject N>, its legend). A segment sent fewer
// references (no setting in a take of several scenes, none on a first frame) renumbers the ones
// it sends and writes a left-out one as its description: the harbour and the cottage stayed
// cited with no picture (GB10 2026-11-22), and an object listed after a setting would have
// taken the setting's number.
function refTokens(text, refs) {
  const all = relayRefsAll(settingSheet()), sent = new Map(refs.map((x, k) => [x.n, k + 1]));
  return String(text || "").replace(new RegExp(P.H3_TOKEN_RE.source, "gi"), (tok, n) => {
    n = Number(n);
    if (sent.has(n)) return `<Subject ${sent.get(n)}>`;
    const left = all.find(x => x.n === n);
    return left?.desc?.trim() || (left?.kind === "environment" ? "the place" : tok);
  });
}
// A Ref2VA segment's prompt, its text and shared fields numbered for the references it sends.
function relayCutPrompt(seg, look, refs, style, continues = false) {
  const lk = Object.fromEntries(Object.entries(look || {}).map(([k, v]) => [k, typeof v === "string" ? refTokens(v, refs) : v]));
  return P.buildRelayCutPrompt(refTokens(seg.prompt.trim(), refs), lk, refs, style, h3Warn, continues);
}
// The references segment 1 sees with a long take's first frame: the subjects the user gave
// (characters, objects), no setting, and never the frame itself (with a setting alone, the
// first frame stands for the main character).
const firstFrameRefs = s => (s.refsGiven && !describedScene()
  ? relayRefs(null).filter(x => x.kind !== "environment" && x.ref !== s.startImage.ref) : []);
const describedScene = () => !d.refsGiven && !!P.parseScreenplay(d.relay.scenario) && !namesSubjects();
const namesSubjects = () => [...d.relay.segments.map(seg => seg.prompt), d.relay.look.subjects, d.relay.look.retention]
  .some(x => new RegExp(P.H3_TOKEN_RE.source, "i").test(x || ""));
// The setting's sheet: the director's, or a long take's setting reference. A segment that
// starts on a frame (i2v) takes no other image of the place: one framed unlike its start frame
// wins over that frame (the shot jumped to the place image's framing, GB10 2026-11-16).
const settingSheet = () => (locVariant()?.ref ? { ref: locVariant().ref, desc: locDesc() } : null);

// A segment rendered last, or followed by a latent link, has no transition frames: they are
// extracted when a segment after it needs one (a continuous start frame, a cut's setting).
async function ensureTransitions(before, i, total) {
  if (before?.ref && !before.transitions?.length) await extractTransitions(before, i, total);
}

// Candidates of a segment's transition: the clip's last frame (saved with it) and frames
// a little earlier (a CPU job).
async function extractTransitions(seg, i, total) {
  log("req", "Relay, segment {n}/{total}: transition frames…", { n: i + 1, total });
  const frames = await tracked(seg, "frames", sub => runJob("video-frames", { video: seg.ref, offsets: RELAY_TRANSITION_OFFSETS },
    { origin: "relay", label: ["Relay · transition frames"], sub: ["{n} image(s)", { n: RELAY_TRANSITION_OFFSETS.length }], onSubmitted: sub }));
  // A segment saved before its last frame was kept has only the earlier candidates.
  seg.transitions = [...(seg.lastFrame ? [{ ref: seg.lastFrame, offset: 0 }] : []),
    ...RELAY_TRANSITION_OFFSETS.map((offset, k) => ({ ref: frames.outputs[k], offset }))].filter(x => x.ref);
  seg.transitionIdx = 0;
  relayLive.delete(seg);
}

function relayFail(err) {
  const pending = d?.relay?.segments.find(seg => seg.status === "pending");
  if (pending) pending.status = "error";
  relayLive.clear();
  warn(err);
}

// The chain starts at the first segment that is not ready (a stopped or broken chain goes
// on from there); when all are, it renders them all again with new seeds, once confirmed.
// Everything is queued at once (a continuous segment takes the previous one's output to
// come), and "Stop after this segment" takes off the queue what has not started.
async function runRelay() {
  const r = d?.relay;
  if (!r || !relayReady() || relayBusy()) return;
  const s = d;
  let from = relayResumeFrom();
  if (from >= r.segments.length) {
    if (!confirm(t("Every segment is ready. Render the whole chain again, with new seeds?"))) return;
    from = 0;
    r.segments.forEach((seg, i) => { seg.seed = F.seedPlus(seg.seed || F.seedPlus(s.seed, 501 + i), 1); });
  }
  // What follows the first segment rendered starts on a new frame: "to regenerate" until
  // its turn, so a stopped chain says where it is.
  markStaleFrom(from);
  relayRunning = true; relayStop = false;
  updateRelayButtons();
  const items = [];
  let stitch = null;
  try {
    for (let i = from; i < r.segments.length; i++) {
      if (!r.segments[i].seed) r.segments[i].seed = F.seedPlus(s.seed, 501 + i);
      items.push({ i, ...(await queueSegment(s, i)) });
    }
    // A finished chain is assembled: the click that started it asked for the video (one
    // segment alone is the video already).
    if (r.segments.length > 1) stitch = await queueStitch(s);
    log("ok", "Relay: {n} job(s) queued on the server: the chain goes on even if this page is closed.", { n: items.length + (stitch ? 1 : 0) });
  } catch (err) {
    // A refused submission: what this click queued is taken off the queue.
    if (sameSession(s)) {
      await cancelJobs([...items.map(x => r.segments[x.i].job), r.stitchJob]);
      for (const x of items) { const seg = r.segments[x.i]; relayLive.delete(seg); delete seg.job; seg.status = seg.ref ? "stale" : "idle"; }
      delete r.stitchJob;
      warn(err);
    }
    relayRunning = false;
    if (sameSession(s)) { renderRelay(); save(); }
    return;
  }
  try { await followChain(s, items, stitch); }
  finally { relayRunning = false; relayStop = false; }
  if (!sameSession(s)) return;
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
    await followChain(s, [{ i, ...(await queueSegment(s, i)) }], null);
    if (!sameSession(s)) return;
    if (seg.status === "ready") {
      markStaleFrom(i + 1);
      log("ok", "Relay: segment {n} regenerated.", { n: i + 1 });
    }
  } catch (err) { if (sameSession(s)) relayFail(err); }
  renderRelay();
  save();
}

// A project resumed while its chain still runs (or ran) on the server: its jobs are followed
// again, their files written into the segments. Nothing is submitted.
async function followSavedChain(s) {
  const r = s.relay, items = [];
  const read = async id => { try { return await api.job(id); } catch { return null; } };
  for (const [i, seg] of r.segments.entries()) {
    if (!seg.job) continue;
    const job = await read(seg.job);
    if (!job) { delete seg.job; continue; }
    seg.status = "pending";
    relayLive.set(seg, { phase: job.status === "queued" ? "queued" : "video", status: job.status, id: job.id, progress: job.progress || 0, start: Date.now() });
    const done = waitJob(job);
    done.catch(() => {});
    items.push({ i, done });
  }
  let stitch = null;
  const sj = r.stitchJob ? await read(r.stitchJob) : null;
  if (sj) { const done = waitJob(sj); done.catch(() => {}); stitch = { done }; }
  else delete r.stitchJob;
  if (!sameSession(s) || (!items.length && !stitch)) return;
  log("ok", "Relay: the chain went on on the server: following it.");
  relayRunning = true;
  renderRelay();
  try { await followChain(s, items, stitch); }
  finally { relayRunning = false; relayStop = false; }
  if (!sameSession(s)) return;
  renderRelay();
  save();
}


async function assembleRelay() {
  const r = d?.relay, s = d;
  if (!r || !r.segments.every(seg => seg.ref)) return;
  $("relayAssembleBtn").disabled = true;
  try {
    log("req", "Relay: assembling the sequence…");
    // video-stitch: the segments joined by latent continuation are decoded in one go (their
    // joins carry on), the others are cuts; the sound of every clip, at one loudness.
    const refs = r.segments.map(seg => seg.ref);
    const ref = out(await runJob("video-stitch", { clips: refs }, { origin: "relay", label: ["Relay · sequence"],
      sub: ["{n} clip(s)", { n: refs.length }] }), ".mp4");
    if (!sameSession(s)) return;
    r.video = { ref };
    player($("relayPlayer"), ref);
    updateNavMarks();
    log("ok", "Relay: sequence assembled.");
  } catch (err) { warn(err); }
  updateRelayButtons();
  save();
}

// ── Saving and resuming (long take only) ──────────────────────────────────────
// The project is kept by file references (server files): nothing volatile is written.
// A "pending" status is not saved; on resume, an item with its file is ready.
function replacer(key, value) {
  if (key === "wf") return undefined;
  if (key === "status" && value === "pending") return undefined;
  return value;
}
function save() {
  if (!d) return;
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
  // A storyboard saved before 2026-11-21 is not a long take: ignored.
  if (p.version !== 2 || p.pipeline !== "sequence" || !F.workflow(p.wfId)) { log("warn", "Saved project ignored (unknown format)."); return null; }
  return p;
}
export const hasSavedProject = () => !!savedCache;
// Pipelines of the saved project: "Resume the project" shows under the long take's, and under
// the one a long take was opened from (Text2Video, Image2Video, Video from references).
export const savedPipelines = () => (savedCache ? [savedCache.pipeline, savedCache.from].filter(Boolean) : []);
// The saved long take has jobs on the server not followed to the end (the page was closed
// while its chain ran): the page opens on it and follows them. Nothing is submitted.
export const savedChainRunning = () => !!savedCache?.relay
  && ((savedCache.relay.segments || []).some(seg => seg.job) || (!!savedCache.relay.stitchJob && !savedCache.relay.video));

const exists = ref => fetch(refURL(ref), { method: "HEAD" }).then(r => r.ok, () => false);

export async function restoreProject() {
  const p = loadSaved();
  if (!p) { savedCache = null; hooks.onChange?.(); return; }
  reset();
  $("brief").value = p.brief || $("brief").value;
  $("ratioSelect").value = p.ratio;
  if (P.STYLE_PACKS[p.style]) $("styleSelect").value = p.style;
  $("seed").value = String(p.seed);
  const revive = it => it && { ...it, status: !it.status || it.status === "missing" ? (it.ref ? "ready" : "error") : it.status };
  d = {
    // A project saved with an engine since dropped (Qwen Edit 2509) takes the pipeline's engine.
    ...p, wf: F.workflow(p.wfId),
    chars: p.chars.map(c => newChar(c.fields, c.variants.map(revive), c.active ?? 0)),
    locVariants: p.locVariants.map(revive),
    relay: newRelay(p.relay || {}),
  };
  const s = d;
  enterStudio();
  selectSection("relay");
  showRelayComposer();
  renderRelay(); player($("relayPlayer"), d.relay.video?.ref);
  updateGate();
  log("ok", "Project restored (saved {date}): checking its files…", { date: new Date(p.savedAt).toLocaleString(LANG) });
  // Every file is checked; a missing one is marked, the rest of the project stays usable.
  const items = [...d.chars.map(activeVariant), locVariant(), ...d.relay.segments].filter(it => it?.ref && ["ready", "stale"].includes(it.status));
  await Promise.all(items.map(async it => { if (!(await exists(it.ref))) it.status = "missing"; }));
  if (d.relay.video?.ref && !(await exists(d.relay.video.ref))) d.relay.video = null;
  if (!sameSession(s)) return;
  renderRelay(); player($("relayPlayer"), d.relay.video?.ref);
  updateGate();
  const missing = items.filter(it => it.status === "missing").length;
  if (missing) log("warn", "Project restored: {n} file(s) missing, regenerate them.", { n: missing });
  else log("ok", "Project restored: every file is there.");
  await followSavedChain(s);
}

// ── Setup ─────────────────────────────────────────────────────────────────────
export function initDirector(h) {
  hooks = h;
  savedCache = loadSaved();
  $("relayAddBtn").addEventListener("click", () => {
    const r = d?.relay;
    if (!r || r.segments.length >= RELAY_MAX_SEGMENTS) return;
    r.segments.push(newRelaySegment("", r.segMax));
    syncRelayTotal();
    renderRelay();
    save();
  });
  $("relayRunBtn").addEventListener("click", runRelay);
  // The segment running ends; what has not started yet (segments, the take) leaves the queue.
  $("relayStopBtn").addEventListener("click", async () => {
    const r = d?.relay;
    if (!r || relayStop) return;
    relayStop = true;
    updateRelayButtons();
    const left = r.segments.filter(inChain), started = left.some(seg => relayLive.get(seg)?.status !== "queued");
    const queued = left.filter(seg => relayLive.get(seg)?.status === "queued").slice(started ? 0 : 1);
    // Stopped during its last segment, the chain is still assembled.
    if (queued.length) await cancelJobs([...queued.map(seg => seg.job), r.stitchJob]);
  });
  $("relayAssembleBtn").addEventListener("click", assembleRelay);
  $("relayComposeBtn").addEventListener("click", () => composeRelay());
  // A screenplay file: read into the screenplay, then split as the button would (asked first
  // when segments would be lost). Nothing renders.
  $("relayImportBtn").addEventListener("click", () => $("relayImportFile").click());
  $("relayImportFile").addEventListener("change", async () => {
    const file = $("relayImportFile").files[0];
    $("relayImportFile").value = "";
    if (!file || !d?.relay) return;
    const was = $("relayScenario").value;
    $("relayScenario").value = (await file.text()).trim();
    if (!$("relayScenario").value) { $("relayScenario").value = was; return; }
    log("ok", "Screenplay {name} imported.", { name: file.name });
    await composeRelay();
    // Declined: the screenplay shown is still the session's.
    if (d?.relay && d.relay.scenario !== $("relayScenario").value) $("relayScenario").value = was;
    updateRelayButtons();
  });
  $("relayScenario").addEventListener("input", updateRelayButtons);
  $("relayScenario").addEventListener("change", () => { if (d?.relay) { d.relay.scenario = $("relayScenario").value; save(); } });
  $("relayTotal").addEventListener("change", () => {
    if (!d?.relay) return;
    d.relay.total = clampTotal($("relayTotal").value);
    fitRelayToPlan(); save();
  });
  $("relaySegDur").addEventListener("change", () => {
    if (!d?.relay) return;
    d.relay.segMax = F.clampDuration($("relaySegDur").value, d.relay.segMax);
    $("relaySegDur").value = d.relay.segMax;
    fitRelayToPlan(); save();
  });
  // A shared field changes every segment's next prompt; it starts nothing.
  document.querySelectorAll("#relayLook textarea").forEach(el => el.addEventListener("change", () => {
    if (!d?.relay) return;
    d.relay.look[el.dataset.look] = el.value;
    save();
  }));
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
  placeProjectActions();
  reset();
}
