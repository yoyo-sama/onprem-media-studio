#!/usr/bin/env node
// Prompt parity with AI Content Studio 1.4.
//
//   node tools/parity-prompts.js [path of a 1.4 checkout, default ../dellaicontent] [--verbose]
//
// Runs the 1.4 prompt code (js/engine.js and the Studio's own prompt functions, taken
// from index.html at REF_REV) next to web/js/prompts.js, over a fixed matrix of inputs
// and scripted Gemma answers, and compares byte for byte: every compiled prompt, every
// instruction and message sent to Gemma, every value written back. Log lines are
// compared by level only (1.4 wrote them in French). Node only, no network.
// Exit 0 = all equal, 1 = a difference, 2 = the test cannot run.
//
// The 1.4 code is only executed to read its output; nothing of it is copied here.
"use strict";
const fs = require("fs"), vm = require("vm"), path = require("path"), { execFileSync } = require("child_process");

const REF_REV = "234f37c";   // AI Content Studio v1.4.7
const ROOT = path.join(__dirname, "..");
const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose");
const REPO = path.resolve(args.find(a => !a.startsWith("--")) || path.join(ROOT, "..", "dellaicontent"));
const die = msg => { console.error("Cannot run: " + msg); process.exit(2); };
const show = file => {
  try {
    return execFileSync("git", ["-C", REPO, "show", `${REF_REV}:${file}`], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { return die(`${REF_REV}:${file} not readable in ${REPO} (${String(e.stderr || e.message).trim()})`); }
};

// ── 1.4 side ─────────────────────────────────────────────────────────────────
// A declaration of index.html: its first line, then the more indented lines, then the
// closing line at the same indentation; a multi-line template runs to the line ending
// with "`;". A truncated block is a SyntaxError, which stops the test (exit 2).
const IDX = show("index.html").split("\n");
function grab(name) {
  const re = new RegExp(`^( *)(?:const|let|function|async function) ${name}\\b`);
  const i = IDX.findIndex(l => re.test(l));
  if (i < 0) die(`"${name}" not found in 1.4 index.html`);
  const ind = IDX[i].match(/^ */)[0].length, out = [IDX[i]];
  if ((IDX[i].match(/`/g) || []).length % 2) {
    for (let j = i + 1; j < IDX.length; j++) { out.push(IDX[j]); if (/`;\s*$/.test(IDX[j])) break; }
    return out.join("\n");
  }
  let j = i + 1;
  for (; j < IDX.length; j++) { const l = IDX[j]; if (l.trim() && l.match(/^ */)[0].length <= ind) break; out.push(l); }
  if (IDX[j] && IDX[j].match(/^ */)[0].length === ind && /^\s*[}\])]/.test(IDX[j])) out.push(IDX[j]);
  return out.join("\n");
}
const STUDIO_NAMES = ["currentStyleId", "currentStyleText", "currentSheetTemplateId", "charsheetPromptFrom", "compileLocsheetPrompt",
  "SHEET_DESC_SENTINEL", "sheetSkeleton", "stripSheetSkeleton", "wrapSheetDesc", "KREA2_WORKFLOWS", "isKrea2Workflow", "ENRICH_SYSTEM",
  "QWEN_EDIT_ENRICH_SYSTEM", "Q21_TOKEN_RE", "briefEnrichSystem", "enrichBrief", "stripKeyframeAnchor", "ensureKeyframeAnchor",
  "enrichKeyframeText", "SHEET_DESC_ENRICH_SYSTEM", "enrichSheetText", "SHOT_ACTION_ENRICH_SYSTEM", "enrichShotAction",
  "CUT_ENRICH_SYSTEM", "enrichCutText", "HOLD_MOTION", "REF_FIELD_KEYS", "REF_VISION_SYSTEM", "describeRefImage",
  "compileRelayKeyframePrompt", "relayShot", "newRelaySegment", "H3_SCENARIO_SYSTEM", "relaySubjectLegend",
  "MAX_SHOT_SUBJECTS", "shotSubjectIdx", "shotSubjects", "h3CutSubjects", "h3CutBodyOf"];

// Gemma is scripted: each test queues answers (an object, or an Error for a failed call)
// and reads back the calls [system, user, images].
function oldSide() {
  const ctx = { console, JSON, Math, Object, Array, Number, String, Set, Map, Promise, Error, RegExp, Response,
    crypto: globalThis.crypto, setTimeout: f => setTimeout(f, 0), location: undefined, queue: [], calls: [] };
  ctx.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith("/ollama/api/chat")) {
      const body = JSON.parse(opts.body);
      if ("think" in body) ctx.calls.push([body.messages[0].content, body.messages[1].content, body.messages[1].images || null]);
      const answer = ctx.queue[0];
      if (answer instanceof Error) { if (!("think" in body)) ctx.queue.shift(); return new Response("{}", { status: 500 }); }
      ctx.queue.shift();
      if (answer === undefined) die("1.4 called Gemma with no scripted answer");
      return new Response(JSON.stringify({ message: { content: JSON.stringify(answer) } }));
    }
    if (u.includes("/comfy/object_info")) return new Response("{}");
    return die(`1.4 code fetched ${u}`);
  };
  ctx.globalThis = ctx; ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(show("js/engine.js"), ctx, { filename: "1.4 js/engine.js" });
  const names = Object.keys(ctx.Engine).filter(n => !STUDIO_NAMES.includes(n));
  const code = `const { ${names.join(", ")} } = Engine;
    let director = null; const events = []; function addEvent(code, text, kind) { events.push(kind); }
    const brief = { value: "" }, negative = { value: "" };
    const dom = { styleSelect: { value: "cinematic" }, sheetTemplateSelect: { value: "auto" },
                  stepEnrich: { classList: { add() {}, remove() {} } } };
    const $ = id => dom[id];
    const pipelineSelect = { value: "p" }; let styleControl = true;
    function pipelineDef() { return { controls: styleControl ? ["style", "sheetTemplate"] : ["sheetTemplate"] }; }
    const fileToBase64 = async file => file.b64;
    ${STUDIO_NAMES.map(grab).join("\n")}
    globalThis.S = { ${STUDIO_NAMES.join(", ")}, events, brief, negative,
      setDirector: d => { director = d; },
      setStyle: id => { styleControl = id !== undefined; if (id !== undefined) dom.styleSelect.value = id; },
      setTemplate: id => { dom.sheetTemplateSelect.value = id; } };`;
  try { vm.runInContext(code, ctx, { filename: "1.4 index.html (extract)" }); }
  catch (e) { die(`the code extracted from 1.4 index.html does not run (${e.message})`); }
  return ctx;
}

// ── 2.0 side ─────────────────────────────────────────────────────────────────
function newSide() {
  const ctx = { console, Object, Array, String, Set, Promise, Error, RegExp, JSON, Math, queue: [], calls: [], events: [] };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "web/js/prompts.js"), "utf8"), ctx, { filename: "web/js/prompts.js" });
  ctx.llm = async (system, user, images) => {
    ctx.calls.push([system, user, images || null]);
    const answer = ctx.queue.shift();
    if (answer === undefined) die("2.0 called Gemma with no scripted answer");
    if (answer instanceof Error) throw answer;
    return answer;
  };
  ctx.log = level => ctx.events.push(level);
  return ctx;
}

const A = oldSide(), O = A.Engine, S = A.S, B = newSide(), P = B.Prompts;

// ── Comparison ───────────────────────────────────────────────────────────────
const groups = {};
let failures = 0, calls = 0;
const ser = v => (typeof v === "string" ? v : JSON.stringify(v, (k, x) => (x === undefined ? "[undefined]" : x)));
function same(group, old, now, input) {
  const g = (groups[group] ||= { n: 0, ok: 0 });
  g.n++;
  const a = ser(old), b = ser(now);
  if (a === b) { g.ok++; return; }
  failures++;
  if (g.n - g.ok <= 2) {
    console.log(`\nDIFF ${group}${input !== undefined ? `  input: ${ser(input).slice(0, 300)}` : ""}`);
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    console.log(`  1.4: …${a.slice(Math.max(0, i - 80), i + 160)}`);
    console.log(`  2.0: …${b.slice(Math.max(0, i - 80), i + 160)}`);
  }
}
const safe = f => { try { return f(); } catch (e) { return { error: e.message }; } };
const product = (...lists) => lists.reduce((acc, l) => acc.flatMap(x => l.map(y => [...x, y])), [[]]);

// Runs one Gemma flow on both sides with the same scripted answers; compares calls,
// result, and the levels of the log lines.
async function flow(group, answers, old, now, input, expectCall = true) {
  A.queue = answers.slice(); A.calls = []; S.events.length = 0;
  B.queue = answers.slice(); B.calls = []; B.events = [];
  let a, b;
  try { a = await old(); } catch (e) { a = { error: true }; }
  try { b = await now(); } catch (e) { b = { error: true }; }
  calls += B.calls.length;
  if (!B.calls.length && expectCall) same(`${group} · Gemma was called`, true, false, input);
  same(`${group} · result`, a, b, input);
  same(`${group} · Gemma calls`, A.calls, B.calls, input);
  same(`${group} · log levels`, S.events.filter(k => k !== "req"), B.events, input);
}

// ── Inputs ───────────────────────────────────────────────────────────────────
const STYLES = Object.keys(O.STYLE_PACKS);
const CAMS = [...Object.keys(O.CAMERA_LIB), "bogus"], LIGHTS = [...Object.keys(O.LIGHTING_LIB), "bogus"];
const HUMAN = "a weathered man in his sixties with a short grey beard, a dark navy wool sweater";
// Relay: 1.4 reads the main character from its director, 2.0 takes it as an argument.
const relayDirector = desc => S.setDirector({ chars: [{ fields: { face: desc }, variants: [], active: 0 }] });
const relaySubs = desc => [{ desc: P.charDescFromFields({ face: desc }) }];
const LION = "an adult male lion, a powerful quadruped with a thick dark mane";
const LOC = "the lamp room at the top of an old stone lighthouse, brass fittings, worn wooden floor";
const LONG = "very long description ".repeat(400).trim();
const SUBJECT_SETS = [HUMAN, [{ desc: HUMAN, kind: "human" }], [{ desc: LION, kind: "other" }],
  [{ desc: HUMAN, kind: "human" }, { desc: LION, kind: "other" }], [{ desc: LION, kind: "other" }, { desc: HUMAN }],
  [{ desc: "" }, { desc: HUMAN }], [], ""];
const SHOTS = product(CAMS, LIGHTS).map(([camera, lighting], i) => ({
  camera, lighting, action: "the keeper kneels beside the great lens and tightens a brass screw",
  emotion: i % 3 ? "calm concentration" : "", extra: i % 4 ? "" : "Light rain streaks the windows." }));
const FIELDS = [
  { face: "round face with freckles", hair: "short brown hair", outfit: "blue wool coat", accessories: "", palette: "blue" },
  { kind: "human", label: "detective", face: "sharp jaw, ultra detailed, 8k", hair: "black hair, artstation", outfit: "red jacket", palette: "red" },
  { kind: "other", subject: "a dragon, hyper-detailed scales, 8k UHD", form: { body: "long body", legs: "four legs" }, surface: ["green scales"], palette: "" },
  { kind: "other", subject: "", form: "", surface: "", details: "", palette: "only a palette" },
  { kind: "bogus", face: "x", subject: "y" }, {}, null, undefined];
const LOCS = [{ place: "a quiet harbor pier", architecture: "wooden piers", materials: "wet planks, masterpiece", lighting: "", palette: "teal" },
  { place: { a: "x", b: "y" } }, {}, null];
const TEXTS = ["Elle marche vers la porte ; plan fixe.", "A man reads a letter, then folds it; slow push-in.",
  "The camera pans left across the harbor, then tilts down.", "No zoom, the boy waves goodbye.", "Gros plan sur ses mains, caméra à l'épaule.",
  "A dragon orbits the tower while the crane shot rises.", "She walks; tracking shot to the right.", "", "   ", "Plain brief without camera words."];
const OUTPUTS = ["She walks toward the door in warm light.", "A man reads a letter at his desk, then folds it and stands up.",
  "The camera slowly pans left across the quiet harbor.", "The boy waves goodbye, slow zoom out.", "", "Hands close-up, shaky handheld camera."];

(async () => {
  // Constants and instructions.
  for (const n of ["KEYFRAME_ANCHOR_SOLO", "KEYFRAME_ANCHOR_DUAL", "SHEET_CLEAN", "KREA2_ENRICH_SYSTEM", "H3_VIDEO_ENRICH_SYSTEM",
    "R2V_BRIEF_ENRICH_SYSTEM", "QWEN_EDIT_INSTRUCTION_ENRICH_SYSTEM", "SHEET_BRIEF_ENRICH_SYSTEM", "LOC_FIELD_KEYS"])
    same("constants", O[n], P[n], n);
  for (const n of ["ENRICH_SYSTEM", "HOLD_MOTION", "REF_VISION_SYSTEM"]) same("constants", S[n], P[n], n);
  same("constants", S.CUT_ENRICH_SYSTEM("minimax_h3"), P.CUT_ENRICH_SYSTEM, "CUT_ENRICH_SYSTEM");
  for (const lib of ["CAMERA_LIB", "LIGHTING_LIB", "STYLE_PACKS"])
    same("libraries", Object.entries(O[lib]).map(([k, v]) => [k, v.frame, v.motion, v.text]),
      Object.entries(P[lib]).map(([k, v]) => [k, v.frame, v.motion, v.text]), lib);
  same("libraries", Object.keys(O.SHEET_TEMPLATES), Object.keys(P.SHEET_TEMPLATES), "SHEET_TEMPLATES");
  for (const [n, model] of product([0, 1, 2, 3], [undefined, "Qwen-Image-Edit-2509", "Qwen Image 2.1"]))
    same("instructions", S.QWEN_EDIT_ENRICH_SYSTEM(n, model), P.QWEN_EDIT_ENRICH_SYSTEM(n, model), [n, model]);
  same("instructions", S.QWEN_EDIT_ENRICH_SYSTEM(1, "Qwen Image 2.1"), P.QWEN_EDIT_ENRICH_SYSTEM(1, P.keyframeModelName("qwen-image-2.1")));
  same("instructions", S.QWEN_EDIT_ENRICH_SYSTEM(1), P.QWEN_EDIT_ENRICH_SYSTEM(1, P.keyframeModelName("qwen-edit-2509")));
  for (const w of ["human", "other", "location", undefined]) same("instructions", S.SHEET_DESC_ENRICH_SYSTEM(w), P.SHEET_DESC_ENRICH_SYSTEM(w), w);
  for (const d of [[], [HUMAN], [HUMAN, LION], [HUMAN, LION, LOC]]) same("instructions", S.SHOT_ACTION_ENRICH_SYSTEM(d), P.SHOT_ACTION_ENRICH_SYSTEM(d), d);
  // H3_SCENARIO_SYSTEM is 2.0's own since the Relay asks Gemma for the shared look too
  // (camera, lighting, soundscape, music written once): not compared.

  // Keyframes.
  for (const [shot, subjects, loc, style] of product(SHOTS, SUBJECT_SETS, [LOC, "", null], ["none", "cinematic", "noir", undefined]))
    same("compileKeyframePrompt", safe(() => O.compileKeyframePrompt(shot, subjects, loc, style)),
      safe(() => P.compileKeyframePrompt(shot, subjects, loc, style)), [shot, subjects, loc, style]);
  for (const t of ["", "action only", `x ${O.KEYFRAME_ANCHOR_SOLO}`, `y ${O.KEYFRAME_ANCHOR_DUAL} z`, O.compileKeyframePrompt(SHOTS[3], HUMAN, LOC, "noir")])
    for (const dual of [false, true]) {
      S.events.length = 0; B.events = [];
      same("keyframe anchor", [S.stripKeyframeAnchor(t), S.ensureKeyframeAnchor(t, dual), S.events],
        [P.stripKeyframeAnchor(t), P.ensureKeyframeAnchor(t, dual, B.log), B.events], [t, dual]);
    }
  for (const [first, style, loc] of product([true, false], ["none", "cinematic", "anime"], [LOC, ""])) {
    S.setStyle(style);
    same("compileRelayKeyframePrompt", S.compileRelayKeyframePrompt("she opens the door", HUMAN, loc, first),
      P.compileRelayKeyframePrompt("she opens the door", HUMAN, loc, first, style), [first, style, loc]);
  }

  // MiniMax H3 grammar.
  for (const [shot, subjects, loc, hold, dur, body, last, style] of product(SHOTS.slice(0, 30), SUBJECT_SETS, [LOC, ""],
    [undefined, S.HOLD_MOTION], [5, 7.5, 15], [null, "A custom body."], [false, true], ["none", "cinematic"])) {
    const warnsA = [], warnsB = [];
    same("buildH3CutPrompt", [safe(() => O.buildH3CutPrompt(shot, subjects, loc, hold, dur, body, last, style, () => warnsA.push(1))), warnsA],
      [safe(() => P.buildH3CutPrompt(shot, subjects, loc, hold, dur, body, last, style, () => warnsB.push(1))), warnsB],
      [shot, subjects, loc, hold, dur, body, last, style]);
  }
  for (const subjects of [[{ desc: LONG }], [{ desc: LONG }, { desc: LONG }]]) {
    const warnsA = [], warnsB = [];
    same("buildH3CutPrompt (over 7,000 characters)", [O.buildH3CutPrompt(SHOTS[0], subjects, LONG, null, 5, null, false, "noir", () => warnsA.push(1)), warnsA],
      [P.buildH3CutPrompt(SHOTS[0], subjects, LONG, null, 5, null, false, "noir", () => warnsB.push(1)), warnsB]);
  }
  for (const t of ["short", LONG, `${LONG} <Subject 12>`, `detailed_description:\n${LONG}\n\noverall_soundscape:\nx`])
    same("capH3Prompt", O.capH3Prompt(t), P.capH3Prompt(t), t.slice(0, 40));
  for (const s of [0, 1, 2, 4.9, 5, 5.2, 6, 7.5, 10, 12.3, 15, 20]) {
    same("h3 durations", [O.h3VideoFrames(s), O.h3RealDuration(s), O.h3Alignment(false, s), O.h3Alignment(true, s)],
      [P.h3VideoFrames(s), P.h3RealDuration(s), P.h3Alignment(false, s), P.h3Alignment(true, s)], s);
  }
  const REF_LISTS = [[{ kind: "character", desc: HUMAN }, { kind: "environment", desc: LOC }],
    [{ kind: "character", desc: HUMAN }, { kind: "character", desc: LION + "." }, { kind: "environment", desc: LOC }, { kind: "reference", desc: "" }],
    [{ kind: "reference", desc: "a red umbrella. " }], [{ kind: "bogus" }], []];
  for (const [list, text] of product(REF_LISTS, TEXTS)) {
    const a = O.h3AssignSubjects(list), b = P.h3AssignSubjects(list);
    same("h3 reference prompt", [a, O.h3Summary(text), O.h3RefBody(a, text), O.buildH3RefPrompt({ subjects: a, summary: O.h3Summary(text), body: O.h3RefBody(a, text) })],
      [b, P.h3Summary(text), P.h3RefBody(b, text), P.buildH3RefPrompt({ subjects: b, summary: P.h3Summary(text), body: P.h3RefBody(b, text) })], [list, text]);
  }
  same("h3 summary", O.h3Summary(LONG), P.h3Summary(LONG));
  const TOKEN_TEXTS = ["<Subject 1> waves at <Subject 2>.", ">Subject 1> 's fingers , move .", "< subject 3 > runs", "SUBJECTREF1 and SUBJECT_REF2, subject ref 4",
    "no tokens here", "", "<Subject 1>  's  ,."];
  for (const t of TOKEN_TEXTS)
    same("h3 tokens", [O.h3TokensOut(t), O.h3TokensIn(t), O.h3NormalizeTokens(t), O.h3TokensIn(O.h3TokensOut(t))],
      [P.h3TokensOut(t), P.h3TokensIn(t), P.h3NormalizeTokens(t), P.h3TokensIn(P.h3TokensOut(t))], t);
  for (const [brief, out] of product(TEXTS, OUTPUTS)) same("restoreCameraClause", O.restoreCameraClause(brief, out), P.restoreCameraClause(brief, out), [brief, out]);
  same("restoreCameraClause", O.restoreCameraClause(null, "x"), P.restoreCameraClause(null, "x"));

  // Fields, filler, shot lists.
  for (const t of ["A cat, masterpiece, best quality, 8k UHD.", "Trending on ArtStation, octane render", "8k", "photorealistic fine detail, unreal engine 5, v-ray.",
    "masterpiece. Second sentence.", "A, , b ,. c"]) same("stripPromptPadding", O.stripPromptPadding(t), P.stripPromptPadding(t), t);
  for (const f of FIELDS) same("fields", [O.charKindOf(f), O.charDescFromFields(f)], [P.charKindOf(f), P.charDescFromFields(f)], f);
  for (const f of LOCS) same("fields", O.locDescFromFields(f), P.locDescFromFields(f), f);
  for (const v of ["x", " y ", { a: "1", b: { c: "2" } }, ["p", "q"], null, undefined, 3]) same("fields", O.fieldText(v), P.fieldText(v), v);

  // Sheets.
  for (const [desc, kind, tpl, style] of product([HUMAN, LION], ["human", "other", undefined], [...Object.keys(O.SHEET_TEMPLATES), "auto", undefined], ["none", "cinematic", undefined]))
    same("charsheetPromptFrom", O.charsheetPromptFrom(desc, kind, tpl, style), P.charsheetPromptFrom(desc, kind, tpl, style), [kind, tpl, style]);
  for (const style of ["none", "noir", undefined]) same("locsheetPromptFrom", O.locsheetPromptFrom(LOC, style), P.locsheetPromptFrom(LOC, style), style);
  for (const [target, kind, tpl, style] of product(["char", "loc"], ["human", "other"], ["turnaround", "action", "auto"], ["none", "cinematic"])) {
    S.setDirector({ charFields: { kind } }); S.setStyle(style); S.setTemplate(tpl);
    const sk = P.sheetSkeleton(target, kind, tpl === "auto" ? undefined : tpl, style);
    const whole = S.wrapSheetDesc(HUMAN, target);
    same("sheet skeleton", [whole, S.stripSheetSkeleton(whole, target), S.stripSheetSkeleton("rewritten from scratch.", target)],
      [P.wrapSheetDesc(HUMAN, sk), P.stripSheetSkeleton(whole, sk), P.stripSheetSkeleton("rewritten from scratch.", sk)], [target, kind, tpl, style]);
  }
  S.setDirector(null); S.setStyle("cinematic"); S.setTemplate("auto");

  // Relay legend.
  // In 1.4 the legend names the director's first subject (shotSubjects); 2.0 takes it
  // as an argument.
  for (const desc of ["", HUMAN]) {
    relayDirector(desc);
    for (const loc of [LOC, ""]) same("relaySubjectLegend", S.relaySubjectLegend(loc), P.relaySubjectLegend(loc, relaySubs(desc)), [desc, loc]);
  }
  S.setDirector(null);

  // ── Gemma flows ────────────────────────────────────────────────────────────
  const fail = () => new Error("unavailable");
  // Brief enrichment: 1.4 workflow → its 2.0 counterpart (LTX workflows have none).
  const WF = [
    [{ id: "krea2_t2i", pipeline: "text2image" }, { id: "krea2_t2i", pipeline: "text2image" }],
    [{ id: "campaign_full", pipeline: "campaign_full", builder: "campaign_full" }, { id: "campaign", pipeline: "campaign" }],
    [{ id: "qwen21_t2i", pipeline: "text2image" }, { id: "qwen21_t2i", pipeline: "text2image" }],
    [{ id: "qwen_edit_i2i", pipeline: "image2image" }, { id: "qwen_edit_i2i", pipeline: "image2image" }],
    [{ id: "qwen21_i2i", pipeline: "image2image" }, { id: "qwen21_i2i", pipeline: "image2image" }],
    [{ id: "minimax_h3_t2v", pipeline: "text2video" }, { id: "h3_t2v", pipeline: "text2video" }],
    [{ id: "minimax_h3_i2v", pipeline: "image2video" }, { id: "h3_i2v", pipeline: "image2video" }],
    [{ id: "minimax_h3_r2v", pipeline: "reference2video", enrich: "builtin" }, { id: "h3_r2v", pipeline: "reference2video", enrich: "builtin" }],
    [{ id: "storyboard_v2", pipeline: "storyboard_v2", enrich: "builtin" }, { id: "storyboard", pipeline: "storyboard", enrich: "builtin" }],
    [{ id: "storyboard_v2_qwen21", pipeline: "storyboard_v2", enrich: "builtin" }, { id: "storyboard_qwen21", pipeline: "storyboard", enrich: "builtin" }],
    [{ id: "other", pipeline: "x", enrich: "builtin", label: "Builtin" }, { id: "other", pipeline: "x", enrich: "builtin", label: "Builtin" }],
  ];
  for (const [w14, w20] of WF) same("briefEnrichSystem", S.briefEnrichSystem(w14), P.briefEnrichSystem(w20), w14.id);
  const BRIEFS = ["A lighthouse keeper repairs the lamp at dusk; slow push-in.", "Make <image1> wear the jacket of <image2>.",
    "<Subject 1> waves at <Subject 2>; static camera.", "walks to the door", "  spaced brief  "];
  const ANSWERS = [
    { prompt: "A keeper, masterpiece, repairs the lamp in amber dusk light, 8k.", brief: "SUBJECTREF1 waves slowly at SUBJECTREF2 in warm light.",
      instruction: "Q21IMAGEREF1 wears the jacket of Q21IMAGEREF2.", positive_prompt: "Rich prompt, best quality.", negative_prompt: "blurry" },
    { prompt: "Lost tokens.", brief: "He waves at her.", instruction: "Wear the jacket.", positive_prompt: "No negative here." },
    { brief: "SUBJECTREF1 waves at SUBJECTREF2 and SUBJECTREF3 joins.", prompt: "<image1> keeps <image2>, slow push-in." },
    { unexpected: "key" }, { prompt: "", brief: "", instruction: "", positive_prompt: "" }];
  for (const [[w14, w20], brief, answer, style] of product(WF, BRIEFS, ANSWERS, ["cinematic", "none"])) {
    S.brief.value = brief; S.negative.value = "user negative"; S.setStyle(style);
    await flow("enrichBrief", [answer], async () => { await S.enrichBrief({ label: "Builtin", ...w14 }); return [S.brief.value, S.negative.value]; },
      async () => { const r = await P.enrichBrief(B.llm, { label: "Builtin", ...w20 }, brief, P.styleTextFor(style), B.log);
        return [r ? r.brief : brief, r && r.negative !== undefined ? r.negative : "user negative"]; },
      [w20.id, brief, answer, style], !!P.briefEnrichSystem(w20));
  }
  for (const [answer, dual, model] of product([{ prompt: "The first reference image is the man; the second reference image is the room. He kneels, 8k." },
    { prompt: "The first reference image is the man, the second reference image the lion, the third reference image the room." },
    { rewritten: "No roles at all in this long enough text." }, { prompt: "short" }, fail()], [false, true], [undefined, "Qwen Image 2.1"])) {
    const text = O.compileKeyframePrompt(SHOTS[5], dual ? SUBJECT_SETS[3] : HUMAN, LOC, "cinematic");
    await flow("enrichKeyframeText", [answer], () => S.enrichKeyframeText(text, dual, model), () => P.enrichKeyframeText(B.llm, text, dual, model, B.log), [answer, dual, model]);
  }
  for (const [target, kind, answer] of product(["char", "loc"], ["human", "other"],
    [{ description: "A tall woman with short silver hair, ultra detailed, and a long green coat." }, { prompt: "too short" }, fail()])) {
    S.setDirector({ charFields: { kind } }); S.setStyle("noir"); S.setTemplate("expressions");
    const text = S.wrapSheetDesc(LION, target), what = target === "loc" ? "location" : kind;
    await flow("enrichSheetText", [answer], () => S.enrichSheetText(text, target),
      () => P.enrichSheetText(B.llm, text, what, P.sheetSkeleton(target, kind, "expressions", "noir"), B.log), [target, kind, answer]);
  }
  S.setDirector(null); S.setStyle("cinematic"); S.setTemplate("auto");
  for (const [descs, answer] of product([[HUMAN], [HUMAN, LION], []], [{ action: "He kneels and tightens the screw, 8k." }, { prompt: "tiny" }, fail()]))
    await flow("enrichShotAction", [answer], () => S.enrichShotAction("he fixes the lamp", descs), () => P.enrichShotAction(B.llm, "he fixes the lamp", descs, B.log), [descs, answer]);
  const cut = O.buildH3CutPrompt(SHOTS[2], SUBJECT_SETS[3], LOC, null, 5, null, false, "cinematic");
  for (const text of [cut, "plain prose, no block", ""]) same("h3CutBodyOf", S.h3CutBodyOf(text), P.h3CutBodyOf(text), text);
  for (const answer of [{ prompt: "SUBJECTREF1 kneels by SUBJECTREF3 , masterpiece, as SUBJECTREF2 watches ." }, { prompt: "short" }, fail()])
    await flow("enrichCutText", [answer], () => S.enrichCutText(cut, "minimax_h3"), () => P.enrichCutText(B.llm, cut, B.log), answer);
  for (const answer of [{ subject: "a red umbrella", appearance: "open, 8k", materials: { a: "nylon" }, palette: "red" }, {}])
    await flow("describeRefImage", [answer], () => S.describeRefImage({ b64: "QUJD", name: "x.png" }), () => P.describeRefImage(B.llm, "QUJD"), answer);
  const SCENES = ["A lighthouse keeper repairs the lamp at dusk.", "Un lion traverse la savane au crépuscule."];
  const CHAR_ANSWERS = [
    { kind: "human", label: "keeper", face: "weathered face", hair: "grey hair", outfit: "navy sweater, 8k", accessories: "", palette: "navy" },
    { kind: "human", label: "lion", subject: "adult male lion", form: "quadruped", surface: "tawny fur", details: "mane", palette: "gold" },
    { kind: "other", face: "a face", hair: "hair" }, { kind: "human", palette: "only palette" }, { kind: "other", label: { a: "x" } }, fail()];
  for (const [scene, answer, force] of product(SCENES, CHAR_ANSWERS, [undefined, "human", "other", "bogus"]))
    await flow("characterSheetFromBrief", [answer], () => O.characterSheetFromBrief(scene, (c, t, k) => S.events.push(k), force),
      () => P.characterSheetFromBrief(B.llm, scene, B.log, force), [scene, answer, force]);
  for (const [scene, answer] of product(SCENES, [{ place: "a lighthouse", architecture: "round tower", materials: "stone", lighting: "dusk", palette: "grey" }, { palette: "" }, fail()]))
    await flow("locationSheetFromBrief", [answer], () => O.locationSheetFromBrief(scene, (c, t, k) => S.events.push(k)),
      () => P.locationSheetFromBrief(B.llm, scene, B.log), [scene, answer]);
  const SHOT_ANSWERS = [{ shots: [{ camera: "Close-up", lighting: "sunset", action: "he kneels", emotion: "calm" }, { camera: "aerial", lighting: "neon", action: 3 }, "junk"] },
    { shots: "none" }, { shots: Array.from({ length: 9 }, (_, i) => ({ camera: "wide", lighting: "night", action: `a${i}` })) }, fail()];
  for (const [scene, answer, n, dur] of product(SCENES, SHOT_ANSWERS, [1, 4, 8], [5, 7]))
    await flow("shotListFromBrief", [answer], () => O.shotListFromBrief(scene, n, dur, (c, t, k) => S.events.push(k)),
      () => P.shotListFromBrief(B.llm, scene, n, dur, B.log), [scene, answer, n, dur]);
  // Scenario: 1.4 did this inside a DOM handler; the same steps are applied to its functions.
  // The segments are cleaned as in 1.4; the instruction and the shared look are 2.0's own,
  // so only the user content of the Gemma call is compared.
  for (const [answer, n] of product([{ segments: ["SUBJECTREF1 walks to SUBJECTREF2 , 8k .", { a: "second" }, "", "third"] }, { segments: "x" }], [2, 3, 6])) {
    A.queue = [answer]; A.calls = [];
    relayDirector(HUMAN);
    let a;
    try {
      const out = await O.gemmaJSON(S.H3_SCENARIO_SYSTEM(n, S.relaySubjectLegend(LOC)), "the scenario");
      a = (Array.isArray(out.segments) ? out.segments : []).map(seg => O.h3NormalizeTokens(O.h3TokensIn(O.stripPromptPadding(O.fieldText(seg))))).filter(Boolean).slice(0, 8);
      if (!a.length) a = { error: true };
    } catch (e) { a = { error: true }; }
    B.queue = [answer]; B.calls = [];
    let b;
    try { b = (await P.composeScenario(B.llm, "the scenario", n, LOC, 8, relaySubs(HUMAN))).segments; } catch (e) { b = { error: true }; }
    S.setDirector(null);
    same("composeScenario · segments", a, b, [answer, n]);
    same("composeScenario · Gemma user content", A.calls.map(c => c.slice(1)), B.calls.map(c => c.slice(1)), [answer, n]);
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  let total = 0;
  for (const [g, r] of Object.entries(groups)) {
    total += r.n;
    if (VERBOSE || r.ok !== r.n) console.log(`${r.ok === r.n ? "ok  " : "FAIL"} ${g}: ${r.ok}/${r.n}`);
  }
  console.log(failures ? `\n${failures} difference(s) out of ${total} comparisons.` : `All ${total} comparisons equal to 1.4 (${REF_REV}), ${calls} scripted Gemma calls.`);
  process.exit(failures ? 1 : 0);
})().catch(e => die(e.stack));
