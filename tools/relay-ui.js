#!/usr/bin/env node
// NODE_PATH=$(npm root -g) node tools/relay-ui.js [screenshot folder]
//
// The Relay (long take) of the director in a headless Chromium (Playwright), /api stubbed,
// on a restored storyboard project with approved sheets: the total length and the maximum
// per segment give the segment plan; the screenplay split fills the segments and only the
// shared fields left empty, and submits no job; editing a shared field submits nothing;
// "Generate the chain" sends one shot image then one H3 clip per segment, a continuous one
// continuing the previous clip (continue_from, no start image, no transition frames), each
// prompt carrying the shared look once and no default light or camera; the take is
// assembled by video-stitch. The production board: one
// tile per segment, its progress from the job events, a click goes to the segment and
// submits nothing; after a regenerated segment the chain continues from the next one;
// "Stop after this segment" ends the chain once the running segment is done. A long take
// from images opens the Relay alone without a job, its subject described by Gemma's
// vision; its first segment runs from image 1 to image 2 (FL2VA), a segment added after
// the end continues it, and it resumes as saved.
// The shared fields are folded while empty and open once filled; a chain that ends with
// every segment ready assembles the sequence, a stopped one does not; the "Narrative video"
// goal card opens the long take (no trailer card any more), whose screenplay is split without
// a question while its cards only hold that screenplay, a new scene of the split opening with
// a cut; the sheet buttons under References submit one job each and add the sheet with its
// role, a character photo's sheet taking the photo's place.
// With a folder, screenshots of the Relay at 1440 and 390 px, light and dark, and of the goal
// cards and the long take's references in French.
// Exit 0 = all green, 1 = a check failed, 2 = the test could not run.
"use strict";
const fs = require("fs"), path = require("path"), http = require("http");
let chromium;
try { ({ chromium } = require("playwright")); }
catch { console.error("ERROR (test could not run): Playwright is not installed (npm i -g playwright, NODE_PATH=$(npm root -g))."); process.exit(2); }
const WEB = path.join(__dirname, "..", "web"), SHOTS = process.argv[2];
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
// A 64×36 VP8 clip of one color.
const RED_WEBM = "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAIBEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggEeTbuMU6uEHFO7a1OsggHr7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjAuMTYuMTAwV0GNTGF2ZjYwLjE2LjEwMESJiEBpAAAAAAAAFlSua8GuAQAAAAAAADjXgQFzxYjABdBPZejM6JyBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhAvrwgDgibCBQLqBJJqBAhJUw2f8c3OgY8CAZ8iaRaOHRU5DT0RFUkSHjUxhdmY2MC4xNi4xMDBzc9ZjwItjxYjABdBPZejM6GfIoUWjh0VOQ09ERVJEh5RMYXZjNjAuMzEuMTAyIGxpYnZweGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDAuMjAwMDAwMDAwAB9DtnXH54EAo8KBAACAkAMAnQEqQAAkAABHCIWFiIWEiAICAnWqA/gD+gIHO3nizzMeXgD+/W7z/+OZNzDE/45t//FhPA4oyP/xUQAcU7trkbuPs4EAt4r3gQHxggGf8IED";
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
// A screenplay file in the H3 layout (the owner's, 2026-11-20), shortened to three segments.
const SCREENPLAY = `subject_definitions:
<Subject 1> is an adult woman with auburn hair. Same outfit throughout.

summary:
A cinematic video of the woman walking through a garden.

retention_analysis:
Preserve the same facial identity and clothing across all segments.

camera_direction:
16:9 cinematic medium shots.

lighting:
Soft natural morning sunlight.

detailed_description:
[Shot 1] Photorealistic garden, gentle camera movement.

Segment 1 (00:00.000–00:10.000) – Introduction
<Subject 1> stands facing the camera. She blinks
naturally and slowly begins walking.
Segment 2 (00:10.000–00:22.000) – Walking
<Subject 1> continues walking along the garden path.
Segment 3 (00:22.000–00:30.000) – Closing
<Subject 1> looks toward the camera and smiles.

overall_soundscape:
Birdsong and soft footsteps.

non_diegetic_music:
N/A`;
// A described scene: no <Subject N> anywhere.
const SCENE = `summary:
A misty pine forest at dawn.

detailed_description:
[Shot 1] A misty pine forest at dawn, wide shot.
Segment 1 (00:00–00:10) – The deer
A young deer steps out of the fog.
Segment 2 (00:10–00:20) – The stream
The deer walks toward a stream.`;
const SPLIT = {
  framing: "Medium shots at eye level.", lighting: "Soft cool morning light with long shadows.",
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
  const jobs = [], chats = [], done = new Map(), held = [];
  let n = 0, hold = false, sock = null, visionSheet = false;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(p => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem("studioProject", p); sessionStorage.setItem("seeded", "1"); } },
    JSON.stringify(PROJECT));
  await ctx.route("**/api/**", async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname;
    const json = (b, s = 200) => route.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
    if (p === "/api/jobs" && req.method() === "POST") {
      const body = JSON.parse(req.postData()), id = `job-${++n}`;
      jobs.push({ ...body, id });
      const outputs = ["h3-t2v", "h3-i2v", "h3-r2v"].includes(body.pipeline) ? [`outputs/${id}.mp4`, `outputs/${id}.png`]
        : ["video-concat", "video-stitch"].includes(body.pipeline) ? [`outputs/${id}.mp4`]
        : body.pipeline === "video-frames" ? body.params.offsets.map(o => `outputs/${id}-${o}.png`) : [`outputs/${id}.png`];
      if (hold) held.push({ id, status: "done", progress: 1, outputs });
      else done.set(id, { id, status: "done", progress: 1, outputs });
      return json({ id, status: "queued", progress: 0, outputs: [] }, 201);
    }
    if (p.startsWith("/api/jobs/")) { const id = p.split("/").pop(); return json(done.get(id) || { id, status: "running", progress: 0, outputs: [] }); }
    if (p === "/api/llm/chat") {
      const body = JSON.parse(req.postData());
      chats.push(body);
      // Vision: the description of a long take's start image.
      if (body.images?.length) return json({ content: JSON.stringify({ sheet: visionSheet, subject: "a woman in a green wool coat", appearance: "auburn bob",
                                                                      materials: "", palette: "" }) });
      return json({ content: JSON.stringify(SPLIT) });
    }
    if (p === "/api/inputs") return json({ ref: `inputs/up-${++n}.png` }, 201);
    if (p === "/api/loras") return json({ h3: [], krea2: [], qwen21: [], moss: [] });
    if (p === "/api/instructions") return json({});
    if (p === "/api/roles" || p === "/api/chats") return json([]);
    if (p.startsWith("/api/gallery/facets")) return json({ pipelines: [], origins: [], tags: [] });
    if (p.startsWith("/api/gallery/dates")) return json({ periods: [] });
    if (p.startsWith("/api/gallery/")) return json({ items: [], next: null, counts: { image: 0, video: 0 } });
    return json({ detail: "x" }, 404);
  });
  await ctx.routeWebSocket("**/api/ws", ws => { sock = ws; });
  // A held job's progress or end, sent as the server's WebSocket does.
  const push = job => sock.send(JSON.stringify({ type: "job", job }));
  await ctx.route(/\/(outputs|inputs)\//, r => {
    const m = /\/(job-\d+)\.mp4$/.exec(new URL(r.request().url()).pathname);
    if (m) return r.fulfill({ contentType: "video/webm", body: Buffer.from(RED_WEBM, "base64") });
    return r.fulfill({ contentType: "image/png", body: Buffer.from(PNG, "base64") });
  });
  const page = await ctx.newPage();
  // A chain that ends with every segment ready assembles the sequence: wait for that job.
  const assembled = async from => { for (let w = 0; w < 100 && !jobs.slice(from).some(j => j.pipeline === "video-stitch"); w++) await page.waitForTimeout(50); };
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));
  let dialogs = 0;
  page.on("dialog", d => { dialogs++; d.accept(); });

  await page.goto(base + "index.html#studio", { waitUntil: "load" });
  // The trailer card is folded into the narrative video's: no card opens the storyboard,
  // and a saved storyboard project resumes from the narrative video card.
  check(!(await page.$('.usecase[data-pipeline="storyboard"]')), "the trailer card is still there");
  await page.click('.usecase[data-pipeline="campaign"]');
  check(await page.inputValue("#pipelineSelect") === "campaign" && await page.isHidden("#pipelineWrap"), "the short ad card shows a Pipeline menu");
  await page.click('.usecase[data-pipeline="sequence"]');
  check(await page.inputValue("#pipelineSelect") === "sequence" && await page.isHidden("#pipelineWrap"), "the narrative video card shows a Pipeline menu");
  await page.waitForSelector("#resumeProjectBtn:not([hidden])", { timeout: 5000 });
  await page.click("#resumeProjectBtn");
  await page.waitForSelector('#studioNav [data-section="relay"]:not([disabled])', { timeout: 5000 });
  await page.click('#studioNav [data-section="relay"]');

  // Plan: 25 s at 10 s max → 8 + 8 + 9, as three cards: the chain renders the cards, so
  // the plan line never announces more segments than there are cards.
  await page.fill("#relayTotal", "25");
  await page.dispatchEvent("#relayTotal", "change");
  const plan = await page.textContent("#relayPlan");
  check(/3 segment\(s\): 8 \+ 8 \+ 9 s/.test(plan) && /3 segment\(s\) still to write/.test(plan), `plan for 25 s at 10 s max: "${plan}"`);
  const cardDurs = () => page.$$eval('#relayList input[type="number"]', els => els.map(e => e.value).join(","));
  check(await cardDurs() === "8,8,9", `cards for 25 s: ${await cardDurs()}`);
  check(await page.isDisabled("#relayRunBtn"), "the chain can start with empty segments");
  // Fewer seconds: the empty cards beyond the plan go.
  await page.fill("#relayTotal", "10");
  await page.dispatchEvent("#relayTotal", "change");
  check(await cardDurs() === "10", `cards for 10 s: ${await cardDurs()}`);
  await page.fill("#relayTotal", "30");
  await page.dispatchEvent("#relayTotal", "change");
  check(/3 segment\(s\): 10 \+ 10 \+ 10 s, 30\.4 s rendered/.test(await page.textContent("#relayPlan")), `plan for 30 s: "${await page.textContent("#relayPlan")}"`);

  // The shared fields are folded while they are all empty, and "Max per segment" sits under
  // the composer's advanced options.
  check(!(await page.$eval("#relayLook", el => el.open)), "the empty shared fields are not folded");
  check(await page.isHidden("#relaySegDur"), "the maximum per segment is not under the advanced options");
  await page.click("#relayLook > summary");
  // A shared field the user wrote is kept by the split; editing it submits nothing.
  await page.fill('#relayLook textarea[data-look="lighting"]', "Warm candle light.");
  await page.dispatchEvent('#relayLook textarea[data-look="lighting"]', "change");
  await page.fill("#relayScenario", "She walks through the garden, stops by a tree, then looks at the sun.");
  await page.dispatchEvent("#relayScenario", "input");
  await page.click("#relayComposeBtn");
  // The plan already gave 3 empty cards: wait for the split's text in them.
  await page.waitForFunction(() => [...document.querySelectorAll("#relayList .relay-seg textarea")].map(a => a.value.trim()).filter(Boolean).length === 3);
  check(jobs.length === 0, `the split or a shared field submitted ${jobs.length} job(s)`);
  check(chats.length === 1 && /exactly 3 segments/.test(chats[0].system), "the split did not ask Gemma for 3 segments");
  const look = await page.$$eval("#relayLook textarea", els => Object.fromEntries(els.map(e => [e.dataset.look, e.value])));
  check(look.lighting === "Warm candle light.", `the user's lighting was overwritten: "${look.lighting}"`);
  check(await page.$eval("#relayLook", el => el.open), "the shared fields the split filled are folded");
  // The first segment has no link, and nothing to regenerate before its render.
  check(await page.isHidden('#relayList .relay-seg[data-seg="0"] .seg-link') && await page.isHidden('#relayList .relay-seg[data-seg="0"] .seg-regen'),
    "the first segment shows a link or a Regenerate button before its render");
  check(look.camera === SPLIT.framing && look.sound === SPLIT.soundscape && look.music === "",
    `empty shared fields not filled as expected: ${JSON.stringify(look)}`);
  const heads = await page.$$eval("#relayList .seg-head strong", els => els.map(e => e.textContent));
  check(JSON.stringify(heads) === JSON.stringify(["Segment 1/3 · 00:00.0–00:10.1", "Segment 2/3 · 00:10.1–00:20.3", "Segment 3/3 · 00:20.3–00:30.4"]),
    `segment headers: ${JSON.stringify(heads)}`);
  const durs = await page.$$eval('#relayList input[type="number"]', els => els.map(e => e.value));
  check(JSON.stringify(durs) === JSON.stringify(["10", "10", "10"]), `segment lengths: ${JSON.stringify(durs)}`);
  // A shorter total never drops a written segment: kept, and the total says so.
  await page.fill("#relayTotal", "10");
  await page.dispatchEvent("#relayTotal", "change");
  check(await cardDurs() === "10,10,10" && await page.inputValue("#relayTotal") === "30",
    `written cards after a shorter total: ${await cardDurs()}, total ${await page.inputValue("#relayTotal")}`);
  check(jobs.length === 0, "changing the total submitted a job");

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

  // The chain: shot image and clip for segment 1, then a clip continuing the one before for
  // segments 2 and 3 (no transition frames to extract), then the take.
  await page.click("#relayRunBtn");
  await page.waitForFunction(() => document.querySelectorAll("#relayList .seg-status").length === 3
    && [...document.querySelectorAll("#relayList .seg-status")].every(e => e.textContent === "Ready"), null, { timeout: 15000 });
  // The finished chain is assembled at once, by the same click.
  await page.waitForSelector("#relayPlayer video", { timeout: 5000 });
  const kinds = jobs.map(j => j.pipeline);
  check(JSON.stringify(kinds) === JSON.stringify(["qwen-image-2.1", "h3-r2v", "h3-r2v", "h3-r2v", "video-stitch"]),
    `chain jobs: ${JSON.stringify(kinds)}`);
  check(JSON.stringify(jobs[4]?.params) === JSON.stringify({ clips: [1, 2, 3].map(k => `outputs/${jobs[k].id}.mp4`) }),
    `assembly at the end of the chain: ${JSON.stringify(jobs[4]?.params)}`);
  check(await page.$eval('#studioNav [data-section="relay"]', b => b.classList.contains("done")), "the menu does not mark the assembled long take");
  // Each segment is H3 Ref2VA on the sheets: segment 1 on its start frame (the shot image),
  // the next ones continuing the previous clip; the canvas follows the start frame, then the clip.
  const clips = jobs.filter(j => j.pipeline === "h3-r2v");
  const from = [{ image: `outputs/${jobs[0].id}.png` }, { continue_from: `outputs/${jobs[1].id}.mp4` },
    { continue_from: `outputs/${jobs[2].id}.mp4` }];
  for (const [i, j] of clips.entries()) {
    const pr = j.params.prompt, [key, value] = Object.entries(from[i])[0];
    check(j.params[key] === value && !("image" in j.params && key !== "image") && !("continue_from" in j.params && key !== "continue_from")
      && JSON.stringify(j.params.references) === JSON.stringify(["outputs/char.png", "outputs/loc.png"])
      && !("aspect" in j.params), `segment ${i + 1} start and references: ${JSON.stringify(j.params)}`);
    check(/<Subject 1> is the main character in <Picture 1>/.test(pr) && /<Subject 2> is the location as defined by <Picture 2>/.test(pr),
      `segment ${i + 1} names the sheets: ${pr}`);
    check(j.params.duration === 10, `segment ${i + 1} duration ${j.params.duration}`);
    check(!/golden|steady framing/i.test(pr), `segment ${i + 1} prompt carries a default look`);
    check(pr.includes("Warm candle light.") && pr.includes(`Framing: ${SPLIT.framing}`), `segment ${i + 1} prompt lacks the shared look`);
    check(pr.includes(`overall_soundscape:\n${SPLIT.soundscape}`) && pr.includes("non_diegetic_music:\nNone."), `segment ${i + 1} sound fields`);
    check(pr.split("Warm candle light.").length === 2, `segment ${i + 1} repeats the lighting`);
  }
  check(/Warm candle light/.test(jobs[0].params.prompt), "the first shot image does not take the shared lighting");
  // A continuous segment takes no frame of the one before: no transition image to choose.
  check(await page.$$eval("#relayList .relay-thumb", els => els.length) === 0, "transition images offered before continuous segments");

  // ── Production board ──
  const tiles = () => page.$$eval("#relayBoard .relay-tile", ts => ts.map(t => t.className.replace("relay-tile ", "")));
  check(await page.isVisible("#relayBoard"), "the board is hidden");
  check(JSON.stringify(await tiles()) === JSON.stringify(["st-ready", "st-ready", "st-ready"]), `tiles after the chain: ${JSON.stringify(await tiles())}`);
  check(/3\/3 segments ready · 30\.4 s of 30\.4 s/.test(await page.textContent("#relayBoard .relay-summary")),
    `summary: "${await page.textContent("#relayBoard .relay-summary")}"`);
  check((await page.textContent("#relayRunBtn")).trim() === "Generate the chain again", `run button: "${await page.textContent("#relayRunBtn")}"`);
  check(await page.isHidden("#relayStopBtn"), "the stop button shows with no chain running");
  // End image, transitions and removal sit under the advanced options.
  check(await page.isHidden('#relayList .relay-seg[data-seg="0"] .seg-del'), "the remove button is not under the advanced options");
  // A click on a tile goes to its segment and starts nothing.
  let before = jobs.length;
  await page.click("#relayBoard .relay-tile:nth-child(3)");
  await page.waitForTimeout(200);
  check(await page.evaluate(() => document.activeElement === document.querySelector('#relayList .relay-seg[data-seg="2"] textarea')),
    "a tile click does not focus its segment");
  check(jobs.length === before, "a tile click submitted a job");

  // Regenerating segment 2 leaves segment 3 to regenerate; the chain continues from there.
  await page.click('#relayList .relay-seg[data-seg="1"] .seg-regen');
  await page.waitForFunction(() => document.querySelector('#relayList .relay-seg[data-seg="2"] .seg-status')?.textContent === "To regenerate");
  check(JSON.stringify(await tiles()) === JSON.stringify(["st-ready", "st-ready", "st-stale"]), `tiles after regenerating 2: ${JSON.stringify(await tiles())}`);
  check((await page.textContent("#relayRunBtn")).trim() === "Continue the chain from segment 3", `run button: "${await page.textContent("#relayRunBtn")}"`);
  before = jobs.length;
  await page.click("#relayRunBtn");
  await page.waitForFunction(() => [...document.querySelectorAll("#relayList .seg-status")].every(e => e.textContent === "Ready"));
  await assembled(before);
  check(JSON.stringify(jobs.slice(before).map(j => j.pipeline)) === JSON.stringify(["h3-r2v", "video-stitch"]),
    `continuing from segment 3: ${JSON.stringify(jobs.slice(before).map(j => j.pipeline))}`);
  const regen2 = jobs.slice(0, before).filter(j => j.pipeline === "h3-r2v").pop();
  check(jobs[before]?.params.continue_from === `outputs/${regen2?.id}.mp4`, `segment 3 does not continue the regenerated segment 2: ${jobs[before]?.params.continue_from}`);
  // A cut: one H3 Ref2VA clip on the subject's sheet and the setting's sheet, no start
  // image; switching the link starts nothing and hides the end image.
  const seg3 = '#relayList .relay-seg[data-seg="2"]';
  before = jobs.length;
  await page.click(`${seg3} .seg-link`);
  check((await page.textContent(`${seg3} .seg-link`)).trim() === "🎞 Cut (new shot from the references)", `cut link: "${await page.textContent(`${seg3} .seg-link`)}"`);
  check(jobs.length === before, "switching the link submitted a job");
  check(await page.$eval(`${seg3} .seg-end`, b => b.hidden), "a cut offers an end image");
  await page.click(`${seg3} .seg-regen`);
  await page.waitForFunction(s => document.querySelector(`${s} .seg-status`)?.textContent === "Ready", seg3);
  let cutJobs = jobs.slice(before);
  check(JSON.stringify(cutJobs.map(j => j.pipeline)) === JSON.stringify(["h3-r2v"]), `director cut: ${JSON.stringify(cutJobs.map(j => j.pipeline))}`);
  let cp = cutJobs[0]?.params || {};
  check(JSON.stringify(cp.references) === JSON.stringify(["outputs/char.png", "outputs/loc.png"]) && cp.aspect === "16:9" && !("image" in cp),
    `director cut references: ${JSON.stringify({ refs: cp.references, aspect: cp.aspect, image: cp.image })}`);
  check(/<Subject 1> is the main character in <Picture 1>, .*auburn bob/.test(cp.prompt || "") && /<Subject 2> is the location as defined by <Picture 2>, a walled garden/.test(cp.prompt || "")
    && (cp.prompt || "").includes("Warm candle light.") && (cp.prompt || "").includes(`overall_soundscape:\n${SPLIT.soundscape}`), `director cut prompt: ${cp.prompt}`);

  // Assembling the long take: one video-stitch job on the three clips (the server finds which
  // ones continue the clip before them).
  before = jobs.length;
  await page.click("#relayAssembleBtn");
  await page.waitForTimeout(300);
  const join = jobs.slice(before).find(j => j.pipeline === "video-stitch");
  check(join && join.params.clips.length === 3, `assembly job: ${JSON.stringify(join && join.params)}`);

  // The whole chain again, held: progress on the tile, then "Stop after this segment".
  hold = true;
  before = jobs.length;
  await page.click("#relayRunBtn");
  await page.waitForFunction(() => document.querySelectorAll("#relayBoard .relay-tile.st-pending").length === 1);
  await page.waitForFunction(() => !document.getElementById("relayStopBtn").hidden);
  await page.waitForTimeout(100);
  const first = held.shift();
  push({ id: first.id, status: "running", progress: 0.5, outputs: [] });
  await page.waitForFunction(() => document.querySelector("#relayBoard .relay-tile .tile-bar i").style.width === "50%");
  const st = await page.textContent('#relayList .relay-seg[data-seg="0"] .seg-status');
  check(st === "Shot image 50%", `card status while running: "${st}"`);
  check(JSON.stringify(await tiles()) === JSON.stringify(["st-pending", "st-stale", "st-stale"]), `tiles while running: ${JSON.stringify(await tiles())}`);
  await page.click("#relayStopBtn");
  check((await page.textContent("#relayStopBtn")).trim() === "Stopping after this segment…", "the stop button does not say it is stopping");
  // Segment 1 ends (shot image, clip): the chain stops there.
  done.set(first.id, first); push(first);
  for (let k = 0; k < 1; k++) {
    for (let w = 0; w < 50 && !held.length; w++) await page.waitForTimeout(50);
    const j = held.shift();
    if (j) { done.set(j.id, j); push(j); }
  }
  await page.waitForFunction(() => document.getElementById("relayStopBtn").hidden);
  await page.waitForTimeout(200);
  check(JSON.stringify(jobs.slice(before).map(j => j.pipeline)) === JSON.stringify(["qwen-image-2.1", "h3-r2v"]),
    `jobs of the stopped chain: ${JSON.stringify(jobs.slice(before).map(j => j.pipeline))}`);
  check(JSON.stringify(await tiles()) === JSON.stringify(["st-ready", "st-stale", "st-stale"]), `tiles after the stop: ${JSON.stringify(await tiles())}`);
  check((await page.textContent("#relayRunBtn")).trim() === "Continue the chain from segment 2", `run button after the stop: "${await page.textContent("#relayRunBtn")}"`);
  hold = false;
  if (SHOTS) {
    for (const theme of ["light", "dark"]) {
      await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
      await page.evaluate(() => document.getElementById("relayBoard").scrollIntoView({ block: "start" }));
      await page.screenshot({ path: path.join(SHOTS, `relay-board-1440-${theme}.png`) });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.getElementById("relayBoard").scrollIntoView({ block: "start" }));
    await page.screenshot({ path: path.join(SHOTS, "relay-board-390-light.png") });
  }

  // ── Long take from a first frame (the "sequence" pipeline) ──
  // A fresh page: no saved project. The input image is the first frame: segment 1 starts on
  // it in i2v; an end image set on the segment's card makes it FL2VA.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => { localStorage.removeItem("studioProject"); });
  await page.reload({ waitUntil: "load" });
  await page.click('.usecase[data-pipeline="sequence"]');
  check(await page.isHidden("#resumeProjectBtn"), "a resume button shows with no saved long take");
  check(await page.isVisible("#imageInputWrap") && (await page.textContent("#imageInputLabel")).trim() === "First frame (optional)"
    && await page.isVisible("#refExtrasWrap") && (await page.textContent("#refExtrasTitle")).trim() === "References (optional)"
    && await page.isVisible("#imageInputWrap .seq-only") && await page.isVisible("#refExtrasWrap .seq-only") && await page.isHidden("#refExtrasWrap .r2v-only"),
    "the long take form does not show its first frame and its references");
  await page.setInputFiles("#imageInput", { name: "start.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") });
  await page.fill("#brief", "She walks to the gate.");
  before = jobs.length;
  const chats0 = chats.length;
  await page.click("#generateBtn");
  await page.waitForSelector("#studioRelay:not([hidden])", { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll("#relayList .relay-seg").length === 1);
  check(jobs.length === before, `opening the long take submitted ${jobs.length - before} job(s)`);
  check(chats.length === chats0 + 1 && chats[chats0].images?.length === 1, "the first frame was not described once by Gemma's vision");
  const nav = await page.$$eval("#studioNav .studio-nav-btn", bs => bs.filter(b => !b.hidden).map(b => b.dataset.section));
  check(JSON.stringify(nav) === JSON.stringify(["relay"]), `long take navigation: ${JSON.stringify(nav)}`);
  check(await page.inputValue("#relayList .relay-seg textarea") === "She walks to the gate.", "the segment does not start with the brief");
  check(await page.inputValue("#relayScenario") === "She walks to the gate.", "the screenplay is not the brief");
  check(await page.isHidden("#relayList .seg-link"), "a long take offers a cut");
  check(await page.isHidden("#relayList .seg-start-row"), "a long take with a first frame offers a format");
  await page.setInputFiles('#relayList .relay-seg[data-seg="0"] .seg-end-file', { name: "end.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") });
  await page.waitForFunction(() => !!document.querySelector("#relayList .relay-endframe img"));
  check(jobs.length === before, "setting an end image submitted a job");
  await page.click("#relayRunBtn");
  await page.waitForFunction(() => document.querySelector("#relayList .seg-status")?.textContent === "Ready", null, { timeout: 10000 });
  let lt = jobs.slice(before);
  check(JSON.stringify(lt.map(j => j.pipeline)) === JSON.stringify(["h3-i2v"]), `long take jobs: ${JSON.stringify(lt.map(j => j.pipeline))}`);
  const clip = lt[0]?.params || {};
  check(/^inputs\/up-\d+\.png$/.test(clip.image) && /^inputs\/up-\d+\.png$/.test(clip.last_image) && clip.image !== clip.last_image,
    `long take images: ${clip.image} → ${clip.last_image}`);
  check(clip.duration === 10 && /<Picture 2>/.test(clip.prompt) && /a woman in a green wool coat/.test(clip.prompt) && lt[0].origin === "relay",
    `long take clip: ${JSON.stringify({ d: clip.duration, origin: lt[0]?.origin })}`);
  // A segment added after the end continues the previous clip.
  await page.click("#relayAddBtn");
  await page.fill('#relayList .relay-seg[data-seg="1"] textarea', "She opens the gate.");
  await page.dispatchEvent('#relayList .relay-seg[data-seg="1"] textarea', "change");
  check((await page.textContent("#relayRunBtn")).trim() === "Continue the chain from segment 2", `long take run button: "${await page.textContent("#relayRunBtn")}"`);
  check((await page.textContent('#relayList .relay-seg[data-seg="1"] .seg-link')).trim() === "🔗 Continuous",
    "a long take does not offer a cut after its first segment");
  before = jobs.length;
  await page.click("#relayRunBtn");
  await page.waitForFunction(() => [...document.querySelectorAll("#relayList .seg-status")].every(e => e.textContent === "Ready"), null, { timeout: 10000 });
  await assembled(before);
  lt = jobs.slice(before);
  check(JSON.stringify(lt.map(j => j.pipeline)) === JSON.stringify(["h3-r2v", "video-stitch"]), `extending the long take: ${JSON.stringify(lt.map(j => j.pipeline))}`);
  const seg1Id = jobs.slice(0, before).filter(j => j.pipeline === "h3-i2v").pop()?.id;
  check(lt[0]?.params.continue_from === `outputs/${seg1Id}.mp4` && !("image" in (lt[0]?.params || {})),
    `segment 2 does not continue the clip of segment 1: ${JSON.stringify(lt[0]?.params)}`);
  // With no reference, the first frame is the subject's reference: segment 2 sees it as it continues.
  check(JSON.stringify(lt[0]?.params.references) === JSON.stringify([clip.image]) && !("aspect" in (lt[0]?.params || {})),
    `segment 2 of a long take, references: ${JSON.stringify(lt[0]?.params.references)}`);
  check(!("last_image" in (lt[0]?.params || {})), "segment 2 has an end image");
  // Saved and resumed under its own pipeline.
  await page.click("#studioExitBtn");
  await page.waitForSelector("#resumeProjectBtn:not([hidden])", { timeout: 5000 });
  await page.click("#resumeProjectBtn");
  await page.waitForFunction(() => document.querySelectorAll("#relayList .relay-seg").length === 2);
  check(await page.isVisible("#studioRelay"), "the resumed long take does not open on the Relay");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "longtake-1440-light.png") });

  // ── Long take from references, with no first frame ──
  // Each reference has its role (a character sheet, an object); none is ever a frame.
  // Segment 1 is Ref2VA from them at the format of its card. A 50 s plan gives five cards,
  // and the chain waits until all are written.
  await page.click("#studioExitBtn");
  await page.evaluate(() => { localStorage.removeItem("studioProject"); });
  await page.reload({ waitUntil: "load" });
  await page.click('.usecase[data-pipeline="sequence"]');
  await page.setInputFiles("#refImagesInput", [{ name: "sheet.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") },
                                               { name: "racket.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") }]);
  await page.waitForFunction(() => document.querySelectorAll("#refSubjects .rs-role").length === 2);
  const roles = await page.$$eval("#refSubjects .rs-role", els => els.map(e => e.value));
  check(JSON.stringify(roles) === JSON.stringify(["character", "character"]), `default roles of the references: ${JSON.stringify(roles)}`);
  await page.selectOption("#refSubjects .ref-subject:nth-child(2) .rs-role", "object");
  await page.fill("#brief", "She walks along the garden path at dawn.");
  before = jobs.length;
  await page.click("#generateBtn");
  await page.waitForSelector("#studioRelay:not([hidden])", { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll("#relayList .relay-seg").length === 1);
  check(await page.isVisible("#relayList .seg-start-ratio"), "a long take with no first frame does not offer its video format");
  await page.fill("#relayTotal", "50");
  await page.dispatchEvent("#relayTotal", "change");
  check(await page.$$eval("#relayList .relay-seg", els => els.length) === 5, "a 50 s plan does not give five cards");
  check(/5 segment\(s\): 10 \+ 10 \+ 10 \+ 10 \+ 10 s/.test(await page.textContent("#relayPlan")) && await page.isDisabled("#relayRunBtn"),
    `50 s plan: "${await page.textContent("#relayPlan")}", run enabled: ${!(await page.isDisabled("#relayRunBtn"))}`);
  await page.fill("#relayTotal", "10");
  await page.dispatchEvent("#relayTotal", "change");
  await page.selectOption("#relayList .seg-start-ratio select", "9:16");
  check(jobs.length === before, "opening a long take from references or setting its plan submitted a job");
  await page.click("#relayRunBtn");
  await page.waitForFunction(() => document.querySelector("#relayList .seg-status")?.textContent === "Ready", null, { timeout: 10000 });
  lt = jobs.slice(before);
  check(JSON.stringify(lt.map(j => j.pipeline)) === JSON.stringify(["h3-r2v"]), `long take from references: ${JSON.stringify(lt.map(j => j.pipeline))}`);
  const seg1 = lt[0]?.params || {}, refsUp = seg1.references || [];
  check(refsUp.length === 2 && refsUp.every(x => /^inputs\/up-\d+\.png$/.test(x)) && seg1.aspect === "9:16" && !("image" in seg1) && !("continue_from" in seg1),
    `segment 1 from the references: ${JSON.stringify({ ...seg1, prompt: undefined })}`);
  check(/<Subject 1> is the main character in <Picture 1>, a woman in a green wool coat/.test(seg1.prompt || "")
    && /<Subject 2> is an additional reference in <Picture 2>/.test(seg1.prompt || "") && /garden path at dawn/.test(seg1.prompt || ""),
    `segment 1 from the references, prompt: ${seg1.prompt}`);
  // A cut in a long take: Ref2VA on the references and, as the setting, the previous
  // segment's transition frame (its last frame by default). The link starts nothing.
  await page.click("#relayAddBtn");
  const seg2 = '#relayList .relay-seg[data-seg="1"]';
  await page.fill(`${seg2} textarea`, "She walks toward the camera on another path.");
  await page.dispatchEvent(`${seg2} textarea`, "change");
  before = jobs.length;
  await page.click(`${seg2} .seg-link`);
  check((await page.textContent(`${seg2} .seg-link`)).trim() === "🎞 Cut (new shot from the references)", `cut link: "${await page.textContent(`${seg2} .seg-link`)}"`);
  check(jobs.length === before, "switching the link submitted a job");
  await page.click("#relayRunBtn");
  await page.waitForFunction(() => document.querySelector('#relayList .relay-seg[data-seg="1"] .seg-status')?.textContent === "Ready", null, { timeout: 10000 });
  await assembled(before);
  lt = jobs.slice(before);
  check(JSON.stringify(lt.map(j => j.pipeline)) === JSON.stringify(["video-frames", "h3-r2v", "video-stitch"]), `cut in a long take: ${JSON.stringify(lt.map(j => j.pipeline))}`);
  const cut = lt[1]?.params || {}, framesJob = lt[0];
  const seg1Clip = jobs.slice(0, before).filter(j => j.pipeline === "h3-r2v").pop();
  check(JSON.stringify(cut.references) === JSON.stringify([...refsUp, `outputs/${seg1Clip?.id}.png`]) && cut.aspect === "9:16",
    `cut in a long take, references: ${JSON.stringify({ refs: cut.references, aspect: cut.aspect })}`);
  check(/another path/.test(cut.prompt || "") && /<Subject 3> is the location as defined by <Picture 3>\./.test(cut.prompt || ""), `cut in a long take, prompt: ${cut.prompt}`);
  // Another transition frame of segment 1 (one where nobody is in view) becomes the cut's
  // setting; choosing it starts nothing.
  before = jobs.length;
  await page.$eval('#relayList .relay-seg[data-seg="0"] .relay-thumb:nth-of-type(2)', b => b.click());
  await page.waitForFunction(() => document.querySelector('#relayList .relay-seg[data-seg="1"] .seg-status')?.textContent === "To regenerate");
  check(jobs.length === before, "choosing a transition frame submitted a job");
  await page.click(`${seg2} .seg-regen`);
  await page.waitForFunction(() => document.querySelector('#relayList .relay-seg[data-seg="1"] .seg-status')?.textContent === "Ready", null, { timeout: 10000 });
  lt = jobs.slice(before);
  check(JSON.stringify(lt.map(j => j.pipeline)) === JSON.stringify(["h3-r2v"])
    && JSON.stringify(lt[0]?.params.references) === JSON.stringify([...refsUp, `outputs/${framesJob?.id}-3.png`]),
    `cut on a chosen transition frame: ${JSON.stringify(lt.map(j => [j.pipeline, j.params.references]))}`);

  // A setting reference is the long take's place: every segment sees it as the location.
  await page.click("#studioExitBtn");
  await page.evaluate(() => { localStorage.removeItem("studioProject"); });
  await page.reload({ waitUntil: "load" });
  await page.click('.usecase[data-pipeline="sequence"]');
  await page.setInputFiles("#refImagesInput", [{ name: "her.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") },
                                               { name: "garden.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") }]);
  await page.waitForFunction(() => document.querySelectorAll("#refSubjects .rs-role").length === 2);
  await page.selectOption("#refSubjects .ref-subject:nth-child(2) .rs-role", "setting");
  await page.fill("#brief", "She sits on the bench.");
  await page.click("#generateBtn");
  await page.waitForFunction(() => document.querySelectorAll("#relayList .relay-seg").length === 1);
  await page.click("#relayAddBtn");
  await page.fill('#relayList .relay-seg[data-seg="1"] textarea', "She stands up.");
  await page.dispatchEvent('#relayList .relay-seg[data-seg="1"] textarea', "change");
  before = jobs.length;
  await page.click("#relayRunBtn");
  await page.waitForFunction(() => [...document.querySelectorAll("#relayList .seg-status")].every(e => e.textContent === "Ready"), null, { timeout: 10000 });
  await assembled(before);
  lt = jobs.slice(before);
  check(JSON.stringify(lt.map(j => j.pipeline)) === JSON.stringify(["h3-r2v", "h3-r2v", "video-stitch"])
    && lt.slice(0, 2).every(j => j.params.references?.length === 2 && /<Subject 2> is the location as defined by <Picture 2>/.test(j.params.prompt || ""))
    && lt[1]?.params.continue_from === `outputs/${lt[0]?.id}.mp4`,
    `long take with a setting reference: ${JSON.stringify(lt.map(j => [j.pipeline, j.params.references]))}`);

  // ── Long take with no start image, from an imported screenplay file ──
  // The file goes into the brief (no job, no Gemma); the long take opens on its three
  // segments and shared fields as written; segment 1 is H3 text to video, the next ones
  // continue it with its last frame as the subject's reference.
  await page.click("#studioExitBtn");
  await page.evaluate(() => { localStorage.removeItem("studioProject"); });
  await page.reload({ waitUntil: "load" });
  await page.click('.usecase[data-pipeline="sequence"]');
  before = jobs.length;
  let chatsBefore = chats.length;
  await page.setInputFiles("#seqImportFile", { name: "garden.txt", mimeType: "text/plain", buffer: Buffer.from(SCREENPLAY) });
  await page.waitForFunction(() => /detailed_description/.test(document.getElementById("brief").value));
  await page.click("#generateBtn");
  await page.waitForSelector("#studioRelay:not([hidden])", { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll("#relayList .relay-seg").length === 3);
  check(jobs.length === before && chats.length === chatsBefore, `opening an imported screenplay: ${jobs.length - before} job(s), ${chats.length - chatsBefore} Gemma call(s)`);
  const cards = await page.$$eval("#relayList .relay-seg textarea", els => els.map(e => e.value));
  check(cards[0] === "<Subject 1> stands facing the camera. She blinks naturally and slowly begins walking. Photorealistic garden, gentle camera movement."
    && cards[2] === "<Subject 1> looks toward the camera and smiles.", `imported segments: ${JSON.stringify(cards)}`);
  const lens = await page.$$eval('#relayList .relay-seg input[type="number"]', els => els.map(e => e.value));
  check(JSON.stringify(lens) === JSON.stringify(["10", "12", "8"]), `imported lengths: ${JSON.stringify(lens)}`);
  const imported = await page.$$eval("#relayLook textarea", els => Object.fromEntries(els.map(e => [e.dataset.look, e.value])));
  check(imported.subjects === "<Subject 1> is an adult woman with auburn hair. Same outfit throughout." && imported.camera === "16:9 cinematic medium shots."
    && imported.lighting === "Soft natural morning sunlight." && imported.sound === "Birdsong and soft footsteps." && imported.music === ""
    && imported.retention === "Preserve the same facial identity and clothing across all segments.", `imported shared fields: ${JSON.stringify(imported)}`);
  check(await page.isVisible("#relayList .seg-start-ratio"), "a long take with no start image does not offer its video format");
  await page.selectOption("#relayList .seg-start-ratio select", "9:16");
  await page.click("#relayRunBtn");
  await page.waitForFunction(() => [...document.querySelectorAll("#relayList .seg-status")].every(e => e.textContent === "Ready"), null, { timeout: 10000 });
  await assembled(before);
  lt = jobs.slice(before);
  check(JSON.stringify(lt.map(j => j.pipeline)) === JSON.stringify(["h3-t2v", "h3-r2v", "h3-r2v", "video-stitch"]), `long take from text: ${JSON.stringify(lt.map(j => j.pipeline))}`);
  const t2v = lt[0]?.params || {};
  check(t2v.aspect === "9:16" && t2v.duration === 10 && !("image" in t2v) && !/<Picture/.test(t2v.prompt || "")
    && /subject_definitions:\n<Subject 1> is an adult woman with auburn hair/.test(t2v.prompt || "") && !/\[reference generation\]/.test(t2v.prompt || "")
    && /retention_analysis:\nPreserve the same facial identity/.test(t2v.prompt || ""), `segment 1 from text: ${JSON.stringify(t2v)}`);
  const after1 = lt[1]?.params || {};
  check(after1.continue_from === `outputs/${lt[0]?.id}.mp4` && JSON.stringify(after1.references) === JSON.stringify([`outputs/${lt[0]?.id}.png`])
    && after1.duration === 12 && /<Subject 1> is the main character in <Picture 1>\.\n<Subject 1> is an adult woman/.test(after1.prompt || ""),
    `segment 2 after text: ${JSON.stringify(after1)}`);
  check(lt[2]?.params.continue_from === `outputs/${lt[1]?.id}.mp4`, "segment 3 does not continue segment 2");

  // A described scene (no <Subject N>), from a picture: segment 1 starts on the picture and
  // keeps it (i2v: Ref2VA cut away from an empty place after 2 frames), the segments after it
  // see it as the scene's reference, the location.
  visionSheet = false;
  await page.click("#studioExitBtn");
  await page.evaluate(() => { localStorage.removeItem("studioProject"); });
  await page.reload({ waitUntil: "load" });
  await page.click('.usecase[data-pipeline="sequence"]');
  await page.setInputFiles("#imageInput", { name: "forest.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") });
  await page.fill("#brief", SCENE);
  await page.click("#generateBtn");
  await page.waitForSelector("#studioRelay:not([hidden])", { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll("#relayList .relay-seg").length === 2);
  before = jobs.length;
  await page.click("#relayRunBtn");
  await page.waitForFunction(() => [...document.querySelectorAll("#relayList .seg-status")].every(e => e.textContent === "Ready"), null, { timeout: 10000 });
  await assembled(before);
  lt = jobs.slice(before);
  check(JSON.stringify(lt.map(j => j.pipeline)) === JSON.stringify(["h3-i2v", "h3-r2v", "video-stitch"])
    && /<Subject 1> is the location as defined by <Picture 1>/.test(lt[1]?.params.prompt || "") && !/main character/.test(lt[1]?.params.prompt || ""),
    `described scene: ${JSON.stringify(lt.map(j => j.pipeline))} ${lt[1]?.params.prompt}`);
  check(/^For the target video, at 0\.00 seconds into the target video, <Picture 1> \(from \[Shot 1\]\) is fully referenced\./.test(lt[0]?.params.prompt || "")
    && /<Subject 1> is the location as defined by <Picture 1>/.test(lt[0]?.params.prompt || "") && !/main character/.test(lt[0]?.params.prompt || "")
    && !!lt[0]?.params.image && lt[1]?.params.references?.[0] === lt[0]?.params.image
    && lt[1]?.params.continue_from === `outputs/${lt[0]?.id}.mp4`,
    `described scene, segment 1 does not start on its picture: ${JSON.stringify(lt.map(j => ({ ...j.params, prompt: undefined })))}`);

  // The Relay's own import splits the file as written, without Gemma.
  chatsBefore = chats.length;
  await page.setInputFiles("#relayImportFile", { name: "garden.txt", mimeType: "text/plain", buffer: Buffer.from(SCREENPLAY) });
  await page.waitForFunction(() => document.querySelectorAll("#relayList .relay-seg").length === 3);
  check(chats.length === chatsBefore && dialogs > 0, `the Relay import: ${chats.length - chatsBefore} Gemma call(s), confirmation asked: ${dialogs > 0}`);

  // A new long take holds its screenplay in its card: splitting it loses nothing, so nothing
  // is asked; a card rewritten by hand is asked about before it is replaced.
  visionSheet = false;
  await page.click("#studioExitBtn");
  await page.evaluate(() => { localStorage.removeItem("studioProject"); });
  await page.reload({ waitUntil: "load" });
  await page.click('.usecase[data-pipeline="sequence"]');
  check(await page.inputValue("#pipelineSelect") === "sequence" && await page.isHidden("#modelSelect"),
    "the long video card does not open the long take, or shows its one-engine menu");
  await page.setInputFiles("#imageInput", { name: "start.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") });
  await page.fill("#brief", "She walks through the garden, stops by a tree, then looks at the sun.");
  await page.click("#generateBtn");
  await page.waitForSelector("#studioRelay:not([hidden])", { timeout: 10000 });
  await page.fill("#relayTotal", "30");
  await page.dispatchEvent("#relayTotal", "change");
  dialogs = 0; before = jobs.length;
  // Gemma says segment 3 starts a new scene (bad numbers are dropped): it opens with a cut.
  SPLIT.cuts = [3, 1, 9, "x"];
  await page.click("#relayComposeBtn");
  await page.waitForFunction(() => /gravel path/.test(document.querySelector("#relayList .relay-seg textarea")?.value || ""));
  check(dialogs === 0, "splitting a long take that only holds its screenplay asked for a confirmation");
  const links = await page.$$eval("#relayList .relay-seg .seg-link", els => els.map(e => e.hidden ? "-" : e.textContent));
  check(/🔗/.test(links[1]) && /🎞/.test(links[2]), `a new scene in the split is not a cut: ${JSON.stringify(links)}`);
  await page.fill('#relayList .relay-seg[data-seg="1"] textarea', "She sits on a bench.");
  await page.dispatchEvent('#relayList .relay-seg[data-seg="1"] textarea', "change");
  await page.click("#relayComposeBtn");
  await page.waitForFunction(() => /flowering tree/.test(document.querySelector('#relayList .relay-seg[data-seg="1"] textarea')?.value || ""));
  check(dialogs === 1, `replacing a rewritten segment asked ${dialogs} time(s)`);
  check(jobs.length === before, "splitting the screenplay submitted a job");

  // Sheets under the references: one click, one job, the sheet joins the list with its role;
  // a character photo's sheet takes the photo's place. Writing the brief or adding a photo
  // submits nothing.
  await page.click("#studioExitBtn");
  await page.evaluate(() => { localStorage.removeItem("studioProject"); });
  await page.reload({ waitUntil: "load" });
  await page.click('.usecase[data-pipeline="sequence"]');
  before = jobs.length;
  await page.fill("#brief", "A fox runs through a snowy birch forest at dawn.");
  const rows = () => page.$$eval("#refSubjects .ref-subject", els => els.map(e => ({
    name: e.querySelector(".rs-name").textContent, role: e.querySelector(".rs-role")?.value, sheet: !!e.querySelector(".rs-sheet") })));
  await page.click("#seqCharSheetBtn");
  await page.waitForFunction(() => document.querySelectorAll("#refSubjects .ref-subject").length === 1, null, { timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector("#seqCharSheetBtn").disabled);
  await page.click("#seqSetSheetBtn");
  await page.waitForFunction(() => document.querySelectorAll("#refSubjects .ref-subject").length === 2, null, { timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector("#seqSetSheetBtn").disabled);
  let sj = jobs.slice(before), r = await rows();
  check(JSON.stringify(sj.map(j => j.pipeline)) === JSON.stringify(["krea2-t2i", "krea2-t2i"]) && sj.every(j => j.params.count === 1),
    `sheets from the brief: ${JSON.stringify(sj.map(j => j.pipeline))}`);
  check(r[0]?.role === "character" && r[0]?.name === `${sj[0]?.id}.png` && !r[0]?.sheet
    && r[1]?.role === "setting" && r[1]?.name === `${sj[1]?.id}.png` && !r[1]?.sheet, `sheets in the references: ${JSON.stringify(r)}`);
  before = jobs.length;
  await page.setInputFiles("#refImagesInput", { name: "fox.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") });
  r = await rows();
  check(jobs.length === before && r.length === 3 && r[2]?.role === "character" && r[2]?.sheet,
    `a character photo: ${jobs.length - before} job(s), rows ${JSON.stringify(r)}`);
  await page.click("#refSubjects .ref-subject:nth-child(3) .rs-sheet");
  await page.waitForFunction(() => /^job-/.test(document.querySelector("#refSubjects .ref-subject:nth-child(3) .rs-name")?.textContent || ""), null, { timeout: 10000 });
  sj = jobs.slice(before); r = await rows();
  check(sj.length === 1 && sj[0].pipeline === "qwen-image-2.1" && sj[0].params.images?.length === 1 && sj[0].params.count === 1,
    `sheet from a photo: ${JSON.stringify(sj.map(j => ({ pipeline: j.pipeline, images: j.params.images })))}`);
  check(r.length === 3 && r[2]?.name === `${sj[0]?.id}.png` && r[2]?.role === "character" && !r[2]?.sheet,
    `the photo's sheet does not take its place: ${JSON.stringify(r)}`);
  if (SHOTS) {
    await page.selectOption("#langSelect", "fr");
    await page.setInputFiles("#refImagesInput", { name: "lea.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") });
    for (const [w, h] of [[1440, 900], [390, 844]])
      for (const theme of ["light", "dark"]) {
        await page.setViewportSize({ width: w, height: h });
        await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
        await page.locator(".usecases").screenshot({ path: path.join(SHOTS, `cards-${w}-${theme}.png`) });
        await page.locator("#refExtrasWrap").screenshot({ path: path.join(SHOTS, `sheets-${w}-${theme}.png`) });
      }
  }

  check(!errs.length, `page errors: ${errs.join(" | ")}`);
  await browser.close();
  server.close();
  if (fails.length) { console.log("FAIL\n- " + fails.join("\n- ")); process.exit(1); }
  console.log("All Relay checks passed.");
})().catch(e => { console.error("ERROR (test could not run): " + e.stack); process.exit(2); });
