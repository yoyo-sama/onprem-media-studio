#!/usr/bin/env node
// node tools/prompt-systems.js [filter]
//
// "Right Gemma instruction for the model": runs the real Studio and Canvas pages in a
// headless Chromium (Playwright), with the server's /api stubbed, and checks for each
// engine and each ✨ button or automatic enrichment that
//   - the instruction Gemma receives is exactly that model's (sha256 of the text,
//     fingerprints of AI Content Studio 1.4 at a6d65c0, so a changed text fails here);
//   - the number of Gemma calls is the expected one;
//   - the user content is the expected one (reference tokens replaced by stand-ins,
//     Krea 2 style as PRIMARY_STYLE);
//   - the enriched text is written back, and an automatic enrichment reaches the job;
//   - an instruction replaced in the settings (/api/instructions) is the one sent, for
//     its engine only.
// Port of 1.4's tools/prompt-systems.js without its mutants: the prompt texts
// themselves are covered by tools/parity-prompts.js.
//
// Needs Node and Playwright with its Chromium (`npm i -g playwright`; set NODE_PATH to
// the global modules). Nothing leaves the machine: a static server on port 0 serves
// web/, every /api request is answered by the stubs below.
// Exit 0 = all green, 1 = a check failed, 2 = the test could not run.
"use strict";
const fs = require("fs"), path = require("path"), http = require("http"), crypto = require("crypto");

let chromium;
try { ({ chromium } = require("playwright")); }
catch { console.error("ERROR (test could not run): Playwright is not installed (npm i -g playwright, NODE_PATH=$(npm root -g))."); process.exit(2); }

const WEB = path.join(__dirname, "..", "web");
const only = process.argv[2] ? new RegExp(process.argv[2]) : null;
const sha = s => crypto.createHash("sha256").update(s).digest("hex");

// sha256 of each instruction, as sent by 1.4 (tools/prompt-systems.js there, bloc FP).
const FP = {
  ENRICH_SYSTEM: "c6bf68a3bc8a77ed5897c84d0406e3a8d9f2944541b29f6f11b767cefb6d8192",
  KREA2_ENRICH_SYSTEM: "d7d318d81bb5dc492570e8b93fc7bb2baed372d9865e374ed82a54a6a9ebaec5",
  H3_VIDEO_ENRICH_SYSTEM: "5d26d56b546c13cc599f7e23ba1792b0322561b4e744064eb3a37452b142b36e",
  R2V_BRIEF_ENRICH_SYSTEM: "d55d0fc3d08606df97bec3600dfce7fed44c93486c9f9ccfc64287667700bdea",
  SHEET_BRIEF_ENRICH_SYSTEM: "a3799383a92581605fcae4da6ffb3b017246e31f622063d0d3d1be00d2b9800a",
  CHARACTER_SYSTEM: "4d78da3e105a0d0d31692a5578cfa35ca8982f8db8dab5684715ecbfec20f267",
  "CHARACTER_SYSTEM(forceKind=human)": "59ca22976439b39bdacad85e602757319e1f91d8fee4763dba34448e753c70e5",
};
// An instruction replaced in the settings panel, served by the /api/instructions stub.
const MINE = 'My own instruction. Answer ONLY with JSON: {"prompt": "..."}.';
FP.MINE = sha(MINE);
const NAME = new Map(Object.entries(FP).map(([n, h]) => [h, n]));
const nameOf = s => NAME.get(sha(s)) || `unknown instruction "${s.slice(0, 50).replace(/\n/g, " ")}…"`;

// ── Static server for web/ ────────────────────────────────────────────────────
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const file = path.join(WEB, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!file.startsWith(WEB) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

// ── /api stubs ────────────────────────────────────────────────────────────────
// Gemma answers with the user text it got (stand-ins included), marked, under every
// key an instruction may ask for; the job queue finishes every job at once.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
function stubs(rec) {
  let n = 0;
  return async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (p === "/api/llm/chat") {
      const body = JSON.parse(req.postData());
      rec.calls.push(body);
      const text = body.prompt.split("\nPRIMARY_STYLE:")[0] + " ENRICHED";
      return json({ content: JSON.stringify({ prompt: text, brief: text, positive_prompt: text, instruction: text }) });
    }
    if (p === "/api/jobs" && req.method() === "POST") {
      const job = JSON.parse(req.postData()), id = `job-${++n}`;
      rec.jobs.push(job);
      const ext = job.pipeline.startsWith("h3-") || job.pipeline === "video-concat" ? "mp4" : "png";
      rec.done[id] = { id, pipeline: job.pipeline, status: "done", progress: 1, outputs: [`outputs/${job.pipeline}/${id}.${ext}`] };
      return json(rec.done[id], 201);
    }
    if (p.startsWith("/api/jobs/")) return json(rec.done[p.split("/").pop()] || {}, rec.done[p.split("/").pop()] ? 200 : 404);
    if (p === "/api/inputs") return json({ ref: "inputs/test.png", width: 64, height: 64 }, 201);
    if (p === "/api/loras") return json({ h3: [] });
    if (p === "/api/instructions") return json(rec.instructions);
    if (p === "/api/gallery/assets") return json({ items: [], next: null, counts: { image: 0, video: 0 } });
    if (p.startsWith("/outputs/") || p.startsWith("/inputs/")) return route.fulfill({ contentType: "image/png", body: Buffer.from(PNG, "base64") });
    return json({ detail: "not stubbed" }, 404);
  };
}

// ── Scenarios ─────────────────────────────────────────────────────────────────
// expect: the instruction of each Gemma call in order; user: text the first user
// content must contain; field: the element whose value must come back enriched.
const studio = (id, scenario, pipeline, model, brief, expect, extra = {}) => ({ id, page: "index.html", scenario, pipeline, model, brief, expect, ...extra });
const canvas = (id, type, props, field, expect, extra = {}) => ({ id, page: "canvas.html", type, props, field, expect, ...extra });
const SCENARIOS = [
  studio("S-krea2", "campaign", "text2image", "krea2_t2i", "a red fox in the snow", ["KREA2_ENRICH_SYSTEM"], { user: "\nPRIMARY_STYLE: " }),
  studio("S-qwen21-t2i", "campaign", "text2image", "qwen21_t2i", "a red fox in the snow", ["ENRICH_SYSTEM"]),
  studio("S-qwen21-i2i", "localization", "image2image", "qwen21_i2i", "put the fox of <image1> in <image2>", ["ENRICH_SYSTEM"],
         { user: "Q21IMAGEREF1", written: "<image2>" }),
  studio("S-h3-t2v", "campaign", "text2video", "h3_t2v", "a fox runs; slow push-in.", ["H3_VIDEO_ENRICH_SYSTEM"]),
  studio("S-h3-i2v", "campaign", "image2video", "h3_i2v", "the fox turns its head", ["H3_VIDEO_ENRICH_SYSTEM"]),
  studio("S-sequence", "storyboard", "sequence", "h3_sequence", "the fox walks between the frames", ["H3_VIDEO_ENRICH_SYSTEM"]),
  studio("S-storyboard", "storyboard", "storyboard", "storyboard_qwen21", "a fox hunts at dawn", ["SHEET_BRIEF_ENRICH_SYSTEM"]),
  studio("S-r2v", "storyboard", "reference2video", "h3_r2v", "<Subject 1> walks through <Subject 2>", ["R2V_BRIEF_ENRICH_SYSTEM"],
         { user: "SUBJECTREF1", written: "<Subject 2>" }),
  // Automatic enrichment: one call before the job, and the job gets the enriched prompt.
  studio("S-auto-krea2", "campaign", "text2image", "krea2_t2i", "a red fox in the snow", ["KREA2_ENRICH_SYSTEM"],
         { auto: true, job: "krea2-t2i" }),
  // A workflow that builds its own prompts is never enriched generically: Gemma's first
  // call writes the character sheet.
  studio("S-auto-storyboard", "storyboard", "storyboard", "storyboard_qwen21", "a fox hunts at dawn",
         ["CHARACTER_SYSTEM", null], { auto: true }),
  // Instructions replaced in the settings: used for their engine, and for it only.
  studio("S-mine-krea2", "campaign", "text2image", "krea2_t2i", "a red fox in the snow", ["MINE"], { instructions: { krea2: MINE } }),
  studio("S-mine-other", "campaign", "text2image", "qwen21_t2i", "a red fox in the snow", ["ENRICH_SYSTEM"], { instructions: { krea2: MINE } }),
  studio("S-mine-auto", "campaign", "text2image", "krea2_t2i", "a red fox in the snow", ["MINE"],
         { instructions: { krea2: MINE }, auto: true, job: "krea2-t2i" }),
  canvas("C-mine-video", "simple/video", { prompt: "the fox turns its head" }, "prompt", ["MINE"], { instructions: { h3_video: MINE } }),
  canvas("C-krea2", "simple/krea2", { engine: "krea2", prompt: "a red fox in the snow" }, "prompt", ["KREA2_ENRICH_SYSTEM"]),
  canvas("C-qwen21", "simple/krea2", { engine: "qwen21", prompt: "a red fox in the snow" }, "prompt", ["ENRICH_SYSTEM"]),
  canvas("C-edit", "simple/qwen_edit", { instruction: "put the fox of <image1> in <image2>" }, "instruction", ["ENRICH_SYSTEM"],
         { user: "Q21IMAGEREF2", written: "<image2>" }),
  canvas("C-video", "simple/video", { prompt: "the fox turns its head" }, "prompt", ["H3_VIDEO_ENRICH_SYSTEM"]),
  canvas("C-r2v", "adv/r2v", { brief: "<Subject 1> walks through <Subject 2>" }, "brief", ["R2V_BRIEF_ENRICH_SYSTEM"],
         { user: "SUBJECTREF2", written: "<Subject 1>" }),
  canvas("C-charsheet", "adv/charsheet", { brief: "an old fox" }, "brief", ["SHEET_BRIEF_ENRICH_SYSTEM"]),
  canvas("C-locsheet", "adv/locsheet", { brief: "a snowy forest" }, "brief", ["SHEET_BRIEF_ENRICH_SYSTEM"]),
  canvas("C-storyboard", "adv/storyboard", { brief: "a fox hunts at dawn" }, "brief", ["SHEET_BRIEF_ENRICH_SYSTEM"]),
  // A subject kind chosen on the card is imposed on Gemma (the Studio never does).
  canvas("C-charsheet-human", "adv/charsheet", { brief: "an old fox", kind: "human" }, null, ["CHARACTER_SYSTEM(forceKind=human)"],
         { generate: true, job: "krea2-t2i" }),
];

async function runStudio(page, s) {
  await page.click(`.usecase[data-scenario="${s.scenario}"]`);
  await page.selectOption("#pipelineSelect", s.pipeline);
  await page.selectOption("#modelSelect", s.model);
  await page.fill("#brief", s.brief);
  await page.evaluate(() => { document.querySelector(".generate-more").open = true; });  // ✨ is under "Advanced options"
  if (s.auto) { await page.click("#autoEnrichBtn"); await page.click("#generateBtn"); }
  else await page.click("#enrichBtn");
  return () => page.inputValue("#brief");
}
async function runCanvas(page, s) {
  await page.evaluate(({ type, props }) => {
    const C = window.__canvas, n = C.addNode(type, null, props);
    C.lgcanvas.selectNode(n);
    C.lgcanvas.onSelectionChange(C.lgcanvas.selected_nodes);
  }, s);
  if (s.generate) await page.click("#btnRegen");
  else await page.click(`button[data-enrich="${s.field}"]`);
  return () => page.inputValue(`#pf-${s.field}`);
}

(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  let browser;
  try { browser = await chromium.launch(); }
  catch (err) { console.error("ERROR (test could not run): " + err.message.split("\n")[0]); process.exit(2); }
  let failed = 0, ran = 0;
  for (const s of SCENARIOS) {
    if (only && !only.test(s.id)) continue;
    ran++;
    const rec = { calls: [], jobs: [], done: {}, instructions: s.instructions || {} }, errors = [];
    const ctx = await browser.newContext();
    await ctx.route("**/api/**", stubs(rec));
    const page = await ctx.newPage();
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(base + s.page, { waitUntil: "load" });
    await page.waitForFunction(() => document.readyState === "complete" && (window.__canvas || document.getElementById("brief")));
    const value = await (s.page === "index.html" ? runStudio(page, s) : runCanvas(page, s));
    // Wait for the expected calls (and the job), then a little more for extra calls.
    for (let i = 0; i < 50 && (rec.calls.length < s.expect.length || (s.job && !rec.jobs.length)); i++) await page.waitForTimeout(100);
    await page.waitForTimeout(400);
    const fails = [];
    const got = rec.calls.map(c => nameOf(c.system));
    s.expect.forEach((want, i) => {
      if (want && got[i] !== want) fails.push(`call ${i + 1}: ${got[i] || "none"} instead of ${want}`);
    });
    if (!s.expect.includes(null) && got.length !== s.expect.length) fails.push(`${got.length} Gemma call(s) instead of ${s.expect.length}: ${got.join(", ")}`);
    if (s.user && !rec.calls[0]?.prompt.includes(s.user)) fails.push(`user content lacks "${s.user}": ${JSON.stringify(rec.calls[0]?.prompt)}`);
    if (s.written && /<Subject \d+>|<image\d+>/.test(rec.calls[0]?.prompt || ""))
      fails.push("a reference token reached Gemma: " + JSON.stringify(rec.calls[0].prompt));
    if (s.id.startsWith("C-krea2") && rec.calls[0]?.prompt.includes("PRIMARY_STYLE")) fails.push("PRIMARY_STYLE sent from the Canvas (no style there)");
    if (!s.generate && !s.job && !s.expect.includes(null)) {
      const v = await value();
      if (!v.includes("ENRICHED")) fails.push(`field not written back: ${JSON.stringify(v)}`);
      if (s.written && !v.includes(s.written)) fails.push(`token ${s.written} not restored: ${JSON.stringify(v)}`);
      if (rec.jobs.length) fails.push(`${rec.jobs.length} job(s) submitted by ✨`);
    }
    if (s.job) {
      const job = rec.jobs.find(j => j.pipeline === s.job);
      if (!job) fails.push(`no ${s.job} job`);
      else if (s.auto && !job.params.prompt.includes("ENRICHED")) fails.push("the job did not get the enriched prompt");
    }
    if (errors.length) fails.push("page errors: " + errors.join(" | "));
    console.log(`${fails.length ? "FAIL" : "ok  "} ${s.id}${fails.length ? "\n      " + fails.join("\n      ") : ""}`);
    failed += fails.length ? 1 : 0;
    await ctx.close();
  }
  await browser.close();
  server.close();
  console.log(failed ? `${failed}/${ran} scenario(s) failed.` : `All ${ran} scenarios passed.`);
  process.exit(failed ? 1 : 0);
})();
