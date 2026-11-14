#!/usr/bin/env node
// NODE_PATH=$(npm root -g) node tools/relay-ui.js [screenshot folder]
//
// The Relay (long take) of the director in a headless Chromium (Playwright), /api stubbed,
// on a restored storyboard project with approved sheets: the total length and the maximum
// per segment give the segment plan; the screenplay split fills the segments and only the
// shared fields left empty, and submits no job; editing a shared field submits nothing;
// "Generate the chain" sends one shot image then one H3 clip per segment, each prompt
// carrying the shared look once and no default light or camera.
// With a folder, screenshots of the Relay at 1440 and 390 px, light and dark.
// Exit 0 = all green, 1 = a check failed, 2 = the test could not run.
"use strict";
const fs = require("fs"), path = require("path"), http = require("http");
let chromium;
try { ({ chromium } = require("playwright")); }
catch { console.error("ERROR (test could not run): Playwright is not installed (npm i -g playwright, NODE_PATH=$(npm root -g))."); process.exit(2); }
const WEB = path.join(__dirname, "..", "web"), SHOTS = process.argv[2];
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer((req, res) => {
  const file = path.join(WEB, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!file.startsWith(WEB) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

const sheet = ref => ({ ref, status: "ready", seed: 1 });
const PROJECT = {
  version: 2, savedAt: new Date().toISOString(), brief: "A woman walks through a walled garden at dawn.",
  wfId: "storyboard_qwen21", pipeline: "storyboard", seed: 42, n: 4, segDur: 5, holdDur: 0, ratio: "16:9", style: "none",
  sheetTemplate: "auto", validated: true, charIdx: 0, locActive: 0,
  chars: [{ fields: { kind: "human", face: "oval face, freckles", hair: "auburn bob", outfit: "green wool coat" }, variants: [sheet("outputs/char.png")], active: 0 }],
  locVariants: [sheet("outputs/loc.png")], locFields: { place: "a walled garden with a gravel path" },
  shots: [], keyframes: null, cuts: null, order: null, animatic: null,
  relay: { scenario: "", segments: [{ prompt: "", duration: 5 }] },
};
const SPLIT = {
  camera: "Slow smooth tracking at eye level, medium shots.", lighting: "Soft cool morning light with long shadows.",
  soundscape: "Birdsong, a light breeze and footsteps on gravel.", music: "none",
  segments: ["SUBJECTREF1 walks along the gravel path; the camera tracks backward.", "SUBJECTREF1 stops by a flowering tree and turns.",
             "SUBJECTREF1 looks toward the sun and smiles; slow push-in."],
};

(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  let browser;
  try { browser = await chromium.launch(); }
  catch (err) { console.error("ERROR (test could not run): " + err.message.split("\n")[0]); process.exit(2); }
  const fails = [];
  const check = (ok, msg) => { if (!ok) fails.push(msg); };
  const jobs = [], chats = [], done = new Map();
  let n = 0;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(p => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem("studioProject", p); sessionStorage.setItem("seeded", "1"); } },
    JSON.stringify(PROJECT));
  await ctx.route("**/api/**", async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname;
    const json = (b, s = 200) => route.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
    if (p === "/api/jobs" && req.method() === "POST") {
      const body = JSON.parse(req.postData()), id = `job-${++n}`;
      jobs.push(body);
      const outputs = body.pipeline === "h3-i2v" ? [`outputs/${id}.mp4`, `outputs/${id}.png`]
        : body.pipeline === "video-frames" ? body.params.offsets.map(o => `outputs/${id}-${o}.png`) : [`outputs/${id}.png`];
      done.set(id, { id, status: "done", progress: 1, outputs });
      return json({ id, status: "queued", progress: 0, outputs: [] }, 201);
    }
    if (p.startsWith("/api/jobs/")) return json(done.get(p.split("/").pop()) || { id: "x", status: "queued", progress: 0, outputs: [] });
    if (p === "/api/llm/chat") { chats.push(JSON.parse(req.postData())); return json({ content: JSON.stringify(SPLIT) }); }
    if (p === "/api/loras") return json({ h3: [], krea2: [], qwen21: [], moss: [] });
    if (p === "/api/instructions") return json({});
    if (p === "/api/roles" || p === "/api/chats") return json([]);
    if (p.startsWith("/api/gallery/")) return json({ items: [], next: null, counts: { image: 0, video: 0 } });
    return json({ detail: "x" }, 404);
  });
  await ctx.routeWebSocket("**/api/ws", () => {});
  await ctx.route(/\/(outputs|inputs)\//, r => r.fulfill({ contentType: "image/png", body: Buffer.from(PNG, "base64") }));
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));
  page.on("dialog", d => d.accept());

  await page.goto(base + "index.html#studio", { waitUntil: "load" });
  await page.click('.usecase[data-scenario="storyboard"]');
  await page.selectOption("#pipelineSelect", "storyboard");
  await page.waitForSelector("#resumeProjectBtn:not([hidden])", { timeout: 5000 });
  await page.click("#resumeProjectBtn");
  await page.waitForSelector('#studioNav [data-section="relay"]:not([disabled])', { timeout: 5000 });
  await page.click('#studioNav [data-section="relay"]');

  // Plan: 25 s at 10 s max → 8 + 8 + 9.
  await page.fill("#relayTotal", "25");
  await page.dispatchEvent("#relayTotal", "change");
  const plan = await page.textContent("#relayPlan");
  check(/3 segment\(s\): 8 \+ 8 \+ 9 s/.test(plan), `plan for 25 s at 10 s max: "${plan}"`);
  await page.fill("#relayTotal", "30");
  await page.dispatchEvent("#relayTotal", "change");
  check(/3 segment\(s\): 10 \+ 10 \+ 10 s, 30\.4 s rendered/.test(await page.textContent("#relayPlan")), `plan for 30 s: "${await page.textContent("#relayPlan")}"`);

  // A shared field the user wrote is kept by the split; editing it submits nothing.
  await page.fill('#relayLook textarea[data-look="lighting"]', "Warm candle light.");
  await page.dispatchEvent('#relayLook textarea[data-look="lighting"]', "change");
  await page.fill("#relayScenario", "She walks through the garden, stops by a tree, then looks at the sun.");
  await page.dispatchEvent("#relayScenario", "input");
  await page.click("#relayComposeBtn");
  await page.waitForFunction(() => document.querySelectorAll("#relayList .relay-seg").length === 3);
  check(jobs.length === 0, `the split or a shared field submitted ${jobs.length} job(s)`);
  check(chats.length === 1 && /exactly 3 segments/.test(chats[0].system), "the split did not ask Gemma for 3 segments");
  const look = await page.$$eval("#relayLook textarea", els => Object.fromEntries(els.map(e => [e.dataset.look, e.value])));
  check(look.lighting === "Warm candle light.", `the user's lighting was overwritten: "${look.lighting}"`);
  check(look.camera === SPLIT.camera && look.sound === SPLIT.soundscape && look.music === "",
    `empty shared fields not filled as expected: ${JSON.stringify(look)}`);
  const heads = await page.$$eval("#relayList .seg-head strong", els => els.map(e => e.textContent));
  check(JSON.stringify(heads) === JSON.stringify(["Segment 1/3 · 00:00.0–00:10.1", "Segment 2/3 · 00:10.1–00:20.3", "Segment 3/3 · 00:20.3–00:30.4"]),
    `segment headers: ${JSON.stringify(heads)}`);
  const durs = await page.$$eval('#relayList input[type="number"]', els => els.map(e => e.value));
  check(JSON.stringify(durs) === JSON.stringify(["10", "10", "10"]), `segment lengths: ${JSON.stringify(durs)}`);

  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
      await page.locator("#studioRelay").screenshot({ path: path.join(SHOTS, `relay-1440-${theme}.png`) });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#studioRelay").screenshot({ path: path.join(SHOTS, "relay-390-dark.png") });
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    await page.setViewportSize({ width: 1440, height: 900 });
  }

  // The chain: shot image, clip and transition frames for segments 1-2, then the last clip.
  await page.click("#relayRunBtn");
  await page.waitForFunction(() => document.querySelectorAll("#relayList .seg-status").length === 3
    && [...document.querySelectorAll("#relayList .seg-status")].every(e => e.textContent === "Ready"), null, { timeout: 15000 });
  const kinds = jobs.map(j => j.pipeline);
  check(JSON.stringify(kinds) === JSON.stringify(["qwen-image-2.1", "h3-i2v", "video-frames", "h3-i2v", "video-frames", "h3-i2v"]),
    `chain jobs: ${JSON.stringify(kinds)}`);
  const clips = jobs.filter(j => j.pipeline === "h3-i2v");
  for (const [i, j] of clips.entries()) {
    const pr = j.params.prompt;
    check(j.params.duration === 10, `segment ${i + 1} duration ${j.params.duration}`);
    check(!/golden|steady framing/i.test(pr), `segment ${i + 1} prompt carries a default look`);
    check(pr.includes("Warm candle light.") && pr.includes(`Camera: ${SPLIT.camera}`), `segment ${i + 1} prompt lacks the shared look`);
    check(pr.includes(`overall_soundscape:\n${SPLIT.soundscape}`) && pr.includes("non_diegetic_music:\nNone."), `segment ${i + 1} sound fields`);
    check(pr.split("Warm candle light.").length === 2, `segment ${i + 1} repeats the lighting`);
  }
  check(/Warm candle light/.test(jobs[0].params.prompt), "the first shot image does not take the shared lighting");

  check(!errs.length, `page errors: ${errs.join(" | ")}`);
  await browser.close();
  server.close();
  if (fails.length) { console.log("FAIL\n- " + fails.join("\n- ")); process.exit(1); }
  console.log("All Relay checks passed.");
})().catch(e => { console.error("ERROR (test could not run): " + e.stack); process.exit(2); });
