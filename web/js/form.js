// What the Studio form decides: the workflow table (the 1.4 manifest), the controls
// each pipeline shows, and the values the generate flows and the director read from
// it: workflow, style, seed, durations, H3 LoRA, uploads and extra references.

import { api, blobToBase64, llmJSON, refURL } from "./api.js";
import { L } from "./i18n.js";
import { $, LLM, clampInt, log } from "./ui.js";

export const P = window.Prompts;
// The `llm` function the prompt compilers take.
export const llm = llmJSON;

export const RATIOS = { "16:9": [1280, 720], "9:16": [720, 1280], "1:1": [1024, 1024], "4:5": [832, 1040] };

// One entry per engine choice of a pipeline. `enrich: "builtin"`: never enriched
// automatically (the storyboard and Ref2VA flows write their own prompts; their ✨
// button has its own instruction, see Prompts.briefEnrichSystem).
export const WORKFLOWS = [
  { id: "krea2_t2i", pipeline: "text2image", label: "Krea 2 Turbo", engine: "krea2-t2i" },
  { id: "qwen21_t2i", pipeline: "text2image", label: "Qwen Image 2.1", engine: "qwen-image-2.1" },
  { id: "qwen_edit_i2i", pipeline: "image2image", label: "Qwen-Edit 2509", engine: "qwen-edit-2509" },
  { id: "qwen21_i2i", pipeline: "image2image", label: "Qwen Image 2.1", engine: "qwen-image-2.1" },
  { id: "h3_t2v", pipeline: "text2video", label: L("MiniMax H3 · native audio"), engine: "h3-t2v" },
  { id: "h3_i2v", pipeline: "image2video", label: L("MiniMax H3 · native audio"), engine: "h3-i2v" },
  { id: "h3_sequence", pipeline: "sequence", label: L("MiniMax H3 · first and last frames"), engine: "h3-i2v" },
  { id: "storyboard", pipeline: "storyboard", label: L("Shot images: Qwen-Edit 2509"),
    keyframes: "qwen-edit-2509", enrich: "builtin" },
  { id: "storyboard_qwen21", pipeline: "storyboard", label: L("Shot images: Qwen Image 2.1"),
    keyframes: "qwen-image-2.1", enrich: "builtin" },
  { id: "h3_r2v", pipeline: "reference2video", label: L("MiniMax H3 · references"), engine: "h3-r2v", enrich: "builtin" },
  { id: "campaign", pipeline: "campaign", label: L("Krea 2 + MiniMax H3") },
];

// `scenario`: the goal cards a pipeline is offered under (none = all).
// Controls: duration, shots, hold, variants, ratio, style, lora, image, markets, seq,
// sheetTemplate, skipSheets. The extra references follow the engine (refCtx).
export const PIPELINES = [
  { id: "text2image", label: L("Image from a text (Text2Image)"), controls: ["variants", "ratio", "style"] },
  { id: "image2image", label: L("Image editing (Image2Image)"), controls: ["image", "markets"] },
  { id: "text2video", label: L("Video from a text (Text2Video)"), controls: ["duration", "ratio", "lora"] },
  { id: "image2video", label: L("Video from an image (Image2Video)"), controls: ["duration", "image", "lora"] },
  { id: "sequence", label: L("Multi-image sequence (FL2VA)"), scenario: ["storyboard"], controls: ["seq", "lora"] },
  { id: "storyboard", label: L("Storyboard + animatic (sheets, shots, cuts)"), scenario: ["storyboard"],
    controls: ["shots", "duration", "hold", "ratio", "style", "sheetTemplate"] },
  { id: "reference2video", label: L("Consistent character + setting (MiniMax H3)"), scenario: ["storyboard"],
    controls: ["duration", "ratio", "lora", "sheetTemplate", "skipSheets", "style"] },
  { id: "campaign", label: L("Full campaign (posters + thumbnails + teaser)"), scenario: ["campaign"],
    controls: ["duration", "variants", "style"] },
];

export const workflow = id => WORKFLOWS.find(w => w.id === id) || null;
export const pipelineDef = id => PIPELINES.find(p => p.id === id) || null;
export const currentPipeline = () => $("pipelineSelect").value;
export const currentWorkflow = () => workflow($("modelSelect").value);
export const hasControl = name => !!pipelineDef(currentPipeline())?.controls.includes(name);
export const brief = () => $("brief").value.trim();

// Style of the form: "none" where the pipeline has no style control.
export const currentStyleId = () => (hasControl("style") ? $("styleSelect").value || "cinematic" : "none");
export const currentTemplateId = () => $("sheetTemplateSelect").value || "auto";

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
export const formDuration = () => clampDuration($("videoDuration").value);

// H3 LoRA of the form: the chosen file at full strength, or none.
export const formLoras = () => ($("loraSelect").value ? [{ name: $("loraSelect").value, strength: 1 }] : []);

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

// ── Extra references ──────────────────────────────────────────────────────────
// One list per use: "r2v" (reference to video), "sb" (storyboard shot images with Qwen
// Image 2.1), "i2i" (Qwen Image 2.1 editing: 10 images with the input image). A list
// never leaks into another pipeline, and nothing is lost when the engine changes.
export const REF_CAPS = { r2v: 7, sb: 7, i2i: 9 };
const refLists = { r2v: [], sb: [], i2i: [] };
export function refCtx(wf = currentWorkflow()) {
  const p = currentPipeline();
  if (p === "reference2video") return "r2v";
  if (p === "storyboard" && wf?.keyframes === "qwen-image-2.1") return "sb";
  if (p === "image2image" && wf?.id === "qwen21_i2i") return "i2i";
  return "";
}
export const refList = (ctx = refCtx()) => refLists[ctx] || [];

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
