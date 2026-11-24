// What the Studio form decides: the workflow table (the 1.4 manifest), the controls
// each pipeline shows, and the values the generate flows and the director read from
// it: workflow, style, seed, durations, LoRA stack, uploads and extra references.

import { api, blobToBase64, llmJSON, refURL } from "./api.js";
import { L, t } from "./i18n.js";
import { $, LLM, clampInt, log } from "./ui.js";
import { stackParams } from "./lora-stack.js";

export const P = window.Prompts;

// The Gemma instructions replaced in the settings panel, read again before each
// enrichment so an edit made in another tab or page applies at once. Server
// unreachable: the defaults.
export async function loadInstructions() {
  try { P.setInstructionOverrides(await api.instructions()); } catch { P.setInstructionOverrides({}); }
}
// The `llm` function the prompt compilers take.
export const llm = llmJSON;

export const RATIOS = { "16:9": [1280, 720], "9:16": [720, 1280], "1:1": [1024, 1024], "4:5": [832, 1040] };
// Qwen Image 2.1 refuses sizes that are not multiples of 32 (diffusers would floor them).
export const QWEN21_RATIOS = { "16:9": [1344, 768], "9:16": [768, 1344], "1:1": [1024, 1024], "4:5": [896, 1120] };

// One entry per engine choice of a pipeline. `loras`: the LoRA folder (studio/loras.py)
// of the engine the form's LoRA stack goes to; none = no LoRA control. `enrich: "builtin"`: never enriched
// automatically (the Ref2VA flow writes its own prompts; its ✨ button has its own
// instruction, see Prompts.briefEnrichSystem). `engines`: every engine the pipeline's
// buttons submit to (the reference sheets are Krea 2 and Qwen Image 2.1 jobs). "storyboard_qwen21" is in no Studio
// pipeline: it routes the ✨ of the Canvas storyboard and sheet cards.
export const WORKFLOWS = [
  { id: "krea2_t2i", pipeline: "text2image", label: "Krea 2 Turbo", engine: "krea2-t2i", loras: "krea2" },
  { id: "qwen21_t2i", pipeline: "text2image", label: "Qwen Image 2.1", engine: "qwen-image-2.1", loras: "qwen21" },
  { id: "moss_t2i", pipeline: "text2image", label: "MOSS-Image", engine: "moss-image", loras: "moss" },
  { id: "qwen21_i2i", pipeline: "image2image", label: "Qwen Image 2.1", engine: "qwen-image-2.1", loras: "qwen21" },
  { id: "h3_t2v", pipeline: "text2video", label: L("MiniMax H3 · native audio"), engine: "h3-t2v", loras: "h3" },
  { id: "h3_i2v", pipeline: "image2video", label: L("MiniMax H3 · native audio"), engine: "h3-i2v", loras: "h3" },
  { id: "h3_sequence", pipeline: "sequence", label: L("MiniMax H3 · chained segments"), engine: "h3-i2v", loras: "h3" },
  { id: "storyboard_qwen21", pipeline: "storyboard", label: L("Shot images: Qwen Image 2.1"),
    keyframes: "qwen-image-2.1", enrich: "builtin", engines: ["krea2-t2i", "qwen-image-2.1", "h3-i2v"] },
  { id: "h3_r2v", pipeline: "reference2video", label: L("MiniMax H3 · references"), engine: "h3-r2v", loras: "h3", enrich: "builtin",
    engines: ["krea2-t2i", "qwen-image-2.1", "h3-r2v"] },
  { id: "campaign", pipeline: "campaign", label: L("Krea 2 + MiniMax H3"), engines: ["krea2-t2i", "h3-t2v"] },
];

// `scenario`: the goal cards a pipeline is offered under (none = all). `own`: the pipeline
// of one goal card (long take, ad campaign); that card shows it alone, with no
// Pipeline menu, and the other cards do not list it.
// Controls: duration, variants, ratio, style, image, markets, seq. The references and
// the LoRA stack follow the engine (refCtx, WORKFLOWS[].loras).
export const PIPELINES = [
  { id: "text2image", label: L("Image from a text (Text2Image)"), controls: ["variants", "ratio", "style"] },
  { id: "image2image", label: L("Image editing (Image2Image)"), controls: ["image", "markets"] },
  { id: "text2video", label: L("Video from a text (Text2Video)"), controls: ["duration", "ratio"] },
  { id: "image2video", label: L("Video from an image (Image2Video)"), controls: ["duration", "image"] },
  { id: "sequence", label: L("Long take (Relay)"), scenario: ["narrative"], own: true, controls: ["duration", "seq", "image"] },
  { id: "reference2video", label: L("Video from references (MiniMax H3)"), controls: ["duration", "ratio"] },
  { id: "campaign", label: L("Full campaign (posters + thumbnails + teaser)"), scenario: ["campaign"], own: true,
    controls: ["duration", "variants", "style"] },
];

// MOSS-Image modes (server moss.py): the turbo LoRA at 4 or 8 steps, or the SFT model at
// 25 steps. The same three in the Studio, the Canvas card and the assistant's card.
export const MOSS_MODES = [["preview", L("Preview (4 steps)")], ["standard", L("Standard (8 steps)")],
                           ["quality", L("Quality (25 steps)")]];
export const MOSS_DEFAULT_MODE = "standard";
export const mossModeLabel = mode => (MOSS_MODES.find(m => m[0] === mode) || MOSS_MODES[1])[1];

// Every engine a workflow's buttons can submit to (sheets, shot images, cuts…).
export const workflowEngines = wf => wf?.engines || (wf?.engine ? [wf.engine] : []);
export const workflow = id => WORKFLOWS.find(w => w.id === id) || null;
export const pipelineDef = id => PIPELINES.find(p => p.id === id) || null;
export const currentPipeline = () => $("pipelineSelect").value;
export const currentWorkflow = () => workflow($("modelSelect").value);
export const hasControl = name => !!pipelineDef(currentPipeline())?.controls.includes(name);
export const brief = () => $("brief").value.trim();

// Style of the form: "none" where the pipeline has no style control.
export const currentStyleId = () => (hasControl("style") ? $("styleSelect").value || "cinematic" : "none");

// Seeds: "Auto" draws one below 2^31, so the offsets the flows add (seed + 501 + i…)
// stay far from the server's limit; seedPlus wraps around anyway.
const SEED_SPAN = 2 ** 32;
export const seedPlus = (seed, k) => (seed + k) % SEED_SPAN;
export function formSeed() {
  const raw = $("seed").value.trim().toLowerCase();
  if (raw === "auto" || raw === "") return Math.floor(Math.random() * 2 ** 31);
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(SEED_SPAN - 1, Math.max(0, n)) : 0;
}
// MiniMax H3 renders 5 to 15 seconds.
export const clampDuration = (v, dflt = 5) => clampInt(v, 5, 15, dflt);
// The video length of the form, never brought silently into range (a 30 s ask rendered 15 s,
// 2026-11-24). One H3 clip lasts 5 to 15 s; longer, a video of these pipelines is a long take
// (clips chained on the server, up to 150 s): Generate opens it at that length.
export const CLIP_MAX = 15, LONG_MAX = 150;
const LONG_PIPELINES = ["text2video", "image2video", "reference2video", "sequence"];
export const lengthMax = (p = currentPipeline()) => (LONG_PIPELINES.includes(p) ? LONG_MAX : CLIP_MAX);
export function formLength() {
  const v = Number($("videoDuration").value), max = lengthMax();
  if (!Number.isFinite(v) || v < 5 || v > max) throw new Error(t("The video length is {min} to {max} s.", { min: 5, max }));
  return Math.round(v);
}
// A clip's length (5 to 15 s; refused otherwise, never cut down).
export function formDuration() {
  const v = formLength();
  if (v > CLIP_MAX) throw new Error(t("The video length is {min} to {max} s.", { min: 5, max: CLIP_MAX }));
  return v;
}
// Generate makes a long take: the long take pipeline, or a video over one clip's length.
export const longVideo = () => currentPipeline() === "sequence" || (lengthMax() > CLIP_MAX && formLength() > CLIP_MAX);

// LoRA stack of the form: one per folder, so switching engines loses nothing; what is
// sent is the stack of the current workflow's folder, none if it takes no LoRA.
const loraStacks = {};
export const loraFolder = wf => wf?.loras || null;
export const loraStack = folder => (loraStacks[folder] ??= []);
export function formLoras() {
  const folder = loraFolder(currentWorkflow());
  return folder ? stackParams(loraStack(folder)) : [];
}

// H3 prompts over 7,000 characters are trimmed, and the log says so.
export const capH3 = text => P.capH3Prompt(text, (msg, params) => log("warn", msg, params));

// ── Images ────────────────────────────────────────────────────────────────────
// An image is {name, ref} (a server file: gallery asset, job output, earlier upload)
// or {name, blob} (a file from the computer, uploaded once on first use).
const uploads = new WeakMap();
export function imageRef(img) {
  if (img.ref) return Promise.resolve(img.ref);
  if (!uploads.has(img.blob))
    uploads.set(img.blob, api.upload(img.blob).then(r => r.ref, err => { uploads.delete(img.blob); throw err; }));
  return uploads.get(img.blob);
}
export function imageURL(img) {
  if (img.ref) return refURL(img.ref);
  return (img.url ??= URL.createObjectURL(img.blob));
}
export async function imageBlob(img) {
  if (img.blob) return img.blob;
  const res = await fetch(refURL(img.ref));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

// ── References ────────────────────────────────────────────────────────────────
// One list per use: "r2v" (video from references: images, clips and sounds), "i2i" (Qwen
// Image 2.1 editing: 10 images with the input image), "seq" (a long take's references, each
// with its role). A list never leaks into another pipeline, and nothing is lost when the
// engine changes. REF_CAPS.r2v is the Canvas card's (two sheets come first there).
export const REF_CAPS = { r2v: 7, i2i: 9, seq: 7 };
const refLists = { r2v: [], i2i: [], seq: [] };
export function refCtx(wf = currentWorkflow()) {
  const p = currentPipeline();
  if (p === "reference2video") return "r2v";
  if (p === "sequence") return "seq";
  if (p === "image2image" && wf?.id === "qwen21_i2i") return "i2i";
  return "";
}
export const refList = (ctx = refCtx()) => refLists[ctx] || [];

// ── Clips and sounds as Ref2VA references ─────────────────────────────────────
// FastH3 OmniRef takes 9 images, 3 clips and 3 sounds, 12 in all (server h3.py). The
// assistant's card and the Studio's reference-to-video list share these roles: `REF_KINDS`
// maps a role to its prompt kind (P.h3AssignRefs) and label.
export const VIDEO_RE = /\.(mp4|webm|mov)$/i, AUDIO_RE = /\.(wav|mp3|m4a|flac|ogg)$/i;
export const REF_KINDS = { character: ["character", L("Character")], setting: ["environment", L("Setting")],
                           object: ["reference", L("Object or other")], motion: ["motion", L("Camera movement and pacing")],
                           voice: ["voice", L("Voice of a character")], music: ["music", L("Music")],
                           ambience: ["ambience", L("Ambience and sounds")] };
export const MEDIA_KINDS = { image: ["character", "setting", "object"], video: ["motion", "character", "setting", "object"],
                             audio: ["voice", "music", "ambience"] };
export const R2V_MEDIA_CAPS = { image: 9, video: 3, audio: 3 }, R2V_MAX_REFS = 12;
export const refMedia = ref => VIDEO_RE.test(ref || "") ? "video" : AUDIO_RE.test(ref || "") ? "audio" : "image";
// Media of a list item ({name, blob | ref, media?, kind?}).
export const itemMedia = it => it.media
  || (it.blob?.type ? (/^video\//.test(it.blob.type) ? "video" : /^audio\//.test(it.blob.type) ? "audio" : "image")
                    : refMedia(it.ref || it.name));
// Role of a list item (its own, else the first of its media).
export const itemRole = it => MEDIA_KINDS[itemMedia(it)].includes(it.kind) ? it.kind : MEDIA_KINDS[itemMedia(it)][0];

// The reference-to-video plan of the form: the list in its order, capped per media and in
// all as the server is. Each entry: {item, media, kind (as P.h3AssignRefs), label…}.
export function r2vPlan(list = refList("r2v")) {
  const room = { ...R2V_MEDIA_CAPS };
  const kept = list.filter(it => room[itemMedia(it)]-- > 0).slice(0, R2V_MAX_REFS);
  return { dropped: list.length - kept.length,
           entries: P.h3AssignRefs(kept.map(item => ({ item, media: itemMedia(item), kind: REF_KINDS[itemRole(item)][0] }))) };
}

// The six-field Ref2VA prompt of a list of references (entries of P.h3AssignRefs, each with
// its `item` {name, ref | blob}): Gemma's vision describes each image for
// subject_definitions (an undescribed one still goes). The Studio form and the assistant's
// card build it here, the same way.
export async function r2vPrompt(entries, text, music) {
  const images = entries.filter(e => e.media === "image");
  const found = await describeRefs(images.map(e => e.item));
  const subjects = entries.map(e => ({ ...e, desc: e.media === "image" ? found[images.indexOf(e)] || "" : "" }));
  return capH3(P.buildH3RefPrompt({ subjects, summary: P.h3Summary(text), body: P.h3RefBody(subjects, text), music }));
}

// The first `REF_CAPS` images of a list, uploaded. The cap is applied here too: the
// interface is not the only way in.
export async function refRefs(ctx) {
  const list = refList(ctx), max = REF_CAPS[ctx];
  if (list.length > max)
    log("warn", "Extra references limited to {max}: {n} image(s) ignored.", { max, n: list.length - max });
  return Promise.all(list.slice(0, max).map(imageRef));
}

// Gemma's description of each image (vision), "" when it fails: an undescribed
// reference still goes to the model, it only weighs less. Never blocks a render.
export async function describeRefs(images) {
  if (!images.length) return [];
  log("req", "Describing {n} reference(s) with {llm} (vision)…", { n: images.length, llm: LLM });
  const descs = await Promise.all(images.map(async img => {
    try { return await P.describeRefImage(llm, await blobToBase64(await imageBlob(img))); }
    catch (err) {
      log("warn", "Description of {name} unavailable ({error}).", { name: img.name, error: err.message });
      return "";
    }
  }));
  const ok = descs.filter(Boolean).length;
  if (ok) log("ok", "{ok}/{n} reference(s) described by {llm}.", { ok, n: images.length, llm: LLM });
  return descs;
}
