#!/usr/bin/env node
// NODE_PATH=$(npm root -g) node tools/assistant-ui.js [screenshot folder]
//
// The assistant mode in a headless Chromium (Playwright), with /api stubbed and a scripted
// reply (a handoff, five cards and a question): the page opens on the assistant; switching
// modes, the library, a starter, an attachment, sending, editing a card start no job;
// Generate on a card submits exactly one job with the card's edited settings and reports it
// (running, then done with its files); a card that needs another card's result waits for
// it; "Open in the Studio" switches to the Studio and fills the form, starting nothing (Undo
// puts the brief back); a choice button answers the question; a video-from-references card
// renders from the card or opens in the Studio form, where Generate submits one h3-r2v job
// with the same references (refused with no image, nothing to review; a sheet button submits
// only its sheet's job); the gallery's "→ Use as input" goes to the pipeline on screen (r2v
// references, sequence, input image) and starts nothing. With a folder, screenshots of the
// assistant in light and dark at 390, 768, 1250 and 1440 px.
// Exit 0 = all green, 1 = a check failed.
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
const ROLES = [["assistant", "General assistant"], ["director", "Director"], ["ad_director", "Ad art director"]]
  .map(([id, name]) => ({ id, name, when: "x", tools: [], text: `---\nid: ${id}\nname: ${name}\n---\nhi`, builtin: true, replaced: false }));
const card = (id, tool, args, extra = {}) => ({ id, tool, call_id: `call_${id}`, args, warnings: [], state: { status: "proposed" }, ...extra });
const CARDS = [
  card("C1", "create_image", { prompt: "a perfume bottle on wet black stone", engine: "krea2", ratio: "4:5", count: 1, style: "product" }),
  card("C2", "edit_image", { instruction: "Replace the background of <image1> with a beach", image: "A1", references: [], markets: ["europe"] }),
  card("C3", "video_from_image", { prompt: "slow push-in, waves", image: "C1#1", duration: 6 }, { warnings: ["duration 3 out of range, 5 used"] }),
  card("C4", "ask_choices", { question: "Which mood?", options: ["Sunny", "Night", "Autre…"] }),
  card("C5", "reference_video", { brief: "A detective enters a studio", duration: 7, ratio: "16:9" }),
  card("C10", "reference_video", { brief: "A1 rides a motorcycle along a jungle track, an elephant charging behind him.",
                                  references: ["A1"], kinds: ["character"], music: "A slow romantic piano score", duration: 5, ratio: "16:9" }),
  card("C11", "create_image", { prompt: 'A cafe chalkboard reading "Menu du jour"', engine: "krea2", ratio: "16:9", count: 1, style: "none" }),
  card("C12", "long_take", { screenplay: "summary:\nA walk.\n\ndetailed_description:\nSegment 1 (00:00–00:10) – Start\nA woman walks along a garden path.\nSegment 2 (00:10–00:20) – End\nShe stops by a tree and smiles.\n\nnon_diegetic_music:\nN/A" }),
  card("C13", "long_take", { screenplay: "A woman walks along a garden path.", total: 40, first_frame: "C1#1", references: ["A1"], kinds: ["setting"] }),
  card("C14", "location_sheet", { description: "a small harbour at dawn", style: "none" },
       { state: { status: "done", outputs: ["outputs/harbour.png"] } }),
  card("C15", "long_take", { screenplay: "Harbour at dawn. A woman walks along the quay.", references: ["C8#1", "C14#1"] }),
  card("C8", "character_sheet", { description: "a woman in a red coat", photo: ["A1"], kind: "human", style: "none" }),
  card("C16", "long_take", { screenplay: "Harbour at dawn. A woman walks along the quay.\n\nAt dusk she sits by the fire." }),
  card("C6", "join_videos", { clips: ["C3#1", "C9#1"] }, { invalid: "clips needs at least 2 items" }),
];
const GALLERY_IMAGE = { key: "krea2-t2i/g1.png", filename: "g1.png", folder: "krea2-t2i", type: "image", url: "/outputs/krea2-t2i/g1.png",
  ref: "outputs/krea2-t2i/g1.png", thumb: "/outputs/krea2-t2i/g1.png", ts: 1, prompt: "a lighthouse", pipeline: "krea2-t2i",
  origin: "studio", loras: [], seed: 1, w: 1, h: 1, duration: null, size: 1, fav: false, tags: [], app: true, trash: null };
const GALLERY_VIDEO = { ...GALLERY_IMAGE, key: "h3-t2v/v1.mp4", filename: "v1.mp4", folder: "h3-t2v", type: "video",
  url: "/outputs/h3-t2v/v1.mp4", ref: "outputs/h3-t2v/v1.mp4", pipeline: "h3-t2v", duration: 5 };
const INPUT_IMAGE = { ...GALLERY_IMAGE, key: "inputs/ab12.png", filename: "ab12.png", folder: "", url: "/inputs/ab12.png",
  ref: "inputs/ab12.png", thumb: "/inputs/ab12.png", prompt: null, pipeline: null, origin: null, input: true };
(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  const fails = [], log = [];
  const check = (ok, msg) => { if (!ok) fails.push(msg); };
  const jobs = [], done = {}, chatBodies = [], cardPosts = [], llmBodies = [];
  let conv = null, n = 0;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route("**/api/**", async route => {
    const req = route.request(), p = new URL(req.url()).pathname;
    const json = (b, s = 200) => route.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
    if (p === "/api/jobs" && req.method() === "POST") {
      const job = JSON.parse(req.postData()), jid = `job-${++n}`;
      jobs.push(job);
      const outs = job.pipeline.startsWith("h3-") ? [`outputs/${jid}.mp4`, `outputs/${jid}-last.png`] : [`outputs/${jid}.png`];
      // H3 jobs stay queued until the test sends their events on the socket.
      done[jid] = job.pipeline.startsWith("h3-") ? { id: jid, status: "queued", progress: 0, outputs: [], later: outs }
        : { id: jid, status: "done", outputs: outs };
      return json(done[jid], 201);
    }
    if (p.startsWith("/api/jobs/")) return json(done[p.split("/").pop()] || {});
    if (p === "/api/inputs") {
      // The test's clip and sound are tagged in their first bytes.
      const head = (req.postDataBuffer() || Buffer.alloc(0)).subarray(0, 5).toString();
      return json({ ref: head === "VIDEO" ? "inputs/clip.mp4" : head === "AUDIO" ? "inputs/voice.wav" : "inputs/att.png" }, 201);
    }
    if (p === "/api/loras") return json({ h3: [{ name: "neon.safetensors", size: 1 }, { name: "anime.safetensors", size: 1 }] });
    if (p === "/api/instructions") return json({});
    if (p === "/api/roles") return json(ROLES);
    if (p === "/api/llm/chat") {
      llmBodies.push(req.postData());
      await new Promise(r => setTimeout(r, 1500));  // Gemma takes its time
      return json({ detail: "LLM stubbed out" }, 503);
    }
    if (p === "/api/chats") return json(conv ? [{ id: conv.id, title: conv.title, updated: 1, role: conv.role }] : []);
    if (p === "/api/chat") {
      const body = JSON.parse(req.postData());
      chatBodies.push(body);
      const first = !conv;
      if (first) conv = { id: "c-1700000000000-abcdef", title: body.text.slice(0, 60), role: "assistant", messages: [] };
      const user = { type: "user", text: body.text, attachments: body.attachments.map((ref, i) => ({ id: `A${i + 1}`, ref })) };
      conv.messages.push(user);
      const ev = [{ type: "conversation", id: conv.id, title: conv.title, message: user }];
      if (first) {
        conv.messages.push({ type: "role", from: "assistant", to: "ad_director", auto: true });
        conv.role = "ad_director";
        const msg = { type: "assistant", role: "ad_director", text: "Here is a plan.", cards: CARDS };
        conv.messages.push(msg);
        ev.push({ type: "role", role: "ad_director", from: "assistant", auto: true, changed: true, goal: "" },
          { type: "role", role: "ad_director", auto: true, changed: false },
          { type: "text", delta: "Here is " }, { type: "text", delta: "a plan." },
          ...CARDS.map(c => ({ type: "card", card: c })));
      } else {
        conv.messages.push({ type: "assistant", role: "ad_director", text: "Noted.", cards: [] });
        ev.push({ type: "role", role: "ad_director", auto: true, changed: false }, { type: "text", delta: "Noted." });
      }
      ev.push({ type: "done" });
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: ev.map(e => `data: ${JSON.stringify(e)}\n\n`).join("") });
    }
    let m;
    if ((m = /^\/api\/chats\/([^/]+)\/cards\/([^/]+)$/.exec(p))) {
      const body = JSON.parse(req.postData());
      cardPosts.push([m[2], body]);
      const c = conv.messages.flatMap(x => x.cards || []).find(x => x.id === m[2]);
      if (body.args) c.args = body.args;
      c.state = { status: body.status, ...(body.outputs?.length ? { outputs: body.outputs } : {}), ...(body.error ? { error: body.error } : {}) };
      return json(c);
    }
    if ((m = /^\/api\/chats\/([^/]+)$/.exec(p))) return conv ? json(conv) : json({ detail: "Unknown" }, 404);
    if (p === "/api/gallery/inputs") return json({ items: [INPUT_IMAGE], next: null, counts: { image: 1, video: 0 } });
    if (p === "/api/gallery/assets") {
      const video = new URL(req.url()).searchParams.get("type") === "video";
      return json({ items: [video ? GALLERY_VIDEO : GALLERY_IMAGE], next: null, counts: { image: 1, video: 1 } });
    }
    return json({ detail: "x" }, 404);
  });
  // Images the director reads back (sheets handed over by a card).
  await ctx.route(/\/(outputs|inputs)\//, route => route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(PNG, "base64") }));
  let socket = null;
  await ctx.routeWebSocket("**/api/ws", ws => { socket = ws; });
  const send = job => socket.send(JSON.stringify({ type: "job", job }));
  await ctx.route("**/outputs/**", r => r.fulfill({ contentType: "image/png", body: Buffer.from(PNG, "base64") }));
  await ctx.route("**/inputs/**", r => r.fulfill({ contentType: "image/png", body: Buffer.from(PNG, "base64") }));
  const page = await ctx.newPage();
  const errs = []; page.on("pageerror", e => errs.push(e.message));
  page.on("dialog", d => d.accept());
  await page.goto(base + "index.html", { waitUntil: "load" });
  await page.evaluate(() => localStorage.setItem("lang", "fr"));
  await page.reload({ waitUntil: "load" });
  // The page opens on the assistant; the modes and the library start nothing.
  await page.waitForSelector("#assistantView", { state: "visible" });
  check(await page.isHidden("main.layout"), "Studio form shown in the assistant mode");
  check(await page.$("#assistantLibraryBody #galleryBlock") !== null, "library not in the assistant");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/assistant-welcome-1440.png` });
  await page.click('.rail-mode[data-mode="studio"]');
  check(await page.isVisible("main.layout") && await page.isHidden("#assistantView"), "Studio mode not shown");
  check(await page.$(".output-panel #galleryBlock") !== null && new URL(page.url()).hash === "#studio", "gallery or address not back in the Studio");
  await page.click('.rail-mode[data-mode="assistant"]');
  await page.click("#libraryBtn");
  check(await page.isVisible("#galleryBlock"), "library button does not show the gallery");
  await page.click("#libraryBtn");
  check(await page.isHidden("#assistantLibrary"), "library button does not close the library");
  await page.click("#chatStarterList button >> nth=0");
  check((await page.inputValue("#chatInput")).length > 5, "starter did not fill the input");
  check(chatBodies.length === 0, "a starter sent a message");
  await page.setInputFiles("#chatFiles", { name: "bottle.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") });
  await page.fill("#chatInput", "Une pub pour mon parfum");
  await page.press("#chatInput", "Enter");
  await page.waitForSelector('.chat-card[data-card="C1"] .primary-btn:not([disabled])');
  check(chatBodies[0]?.attachments?.[0] === "inputs/att.png" && chatBodies[0].lang === "fr", "attachment or lang missing: " + JSON.stringify(chatBodies[0]));
  check(jobs.length === 0, "jobs before any card click");
  check(await page.isDisabled('.chat-card[data-card="C3"] .primary-btn'), "C3 runnable before C1 has rendered");
  check((await page.textContent("#chatLog")).includes("prend le relais"), "handoff note missing");
  check(await page.getAttribute(".chat-head .mascot", "data-costume") === "ad_director", "the character did not put on the role's costume");
  check((await page.textContent("#chatLog")).includes("Une proposition a été écartée"), "invalid card note missing");
  // Editing a card starts nothing.
  await page.fill('.chat-card[data-card="C1"] textarea', "a perfume bottle on wet black stone, morning mist");
  await page.selectOption('.chat-card[data-card="C1"] select >> nth=1', "1:1");
  check(jobs.length === 0, "a card edit submitted a job");
  if (SHOTS) {
    for (const theme of ["light", "dark"]) for (const w of [390, 768, 1250, 1440]) {
      await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
      await page.setViewportSize({ width: w, height: 900 });
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${SHOTS}/chat-${theme}-${w}.png` });
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    await page.click("#libraryBtn");
    for (const w of [390, 1440]) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${SHOTS}/library-${w}.png` });
    }
    await page.click("#libraryCloseBtn");
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  check(jobs.length === 0, "a screenshot step submitted a job");
  await page.click('.chat-card[data-card="C1"] .primary-btn');
  await page.waitForSelector('.chat-card[data-card="C1"] .status.done');
  check(jobs.length === 1 && jobs[0].pipeline === "krea2-t2i", "C1 did not submit one krea2 job: " + JSON.stringify(jobs.map(j => j.pipeline)));
  check(jobs[0]?.params.width === 1024 && jobs[0].params.prompt.startsWith("a perfume bottle on wet black stone, morning mist "), "C1 edits not in the job: " + JSON.stringify(jobs[0]?.params));
  check(jobs[0]?.origin === "assistant", "origin");
  check(cardPosts[0]?.[1].status === "running" && cardPosts[0][1].args.ratio === "1:1", "running report lacks the edited args");
  await page.waitForSelector('.chat-card[data-card="C3"] .primary-btn:not([disabled])');
  // LoRA chips: none on an engine without LoRAs; on the H3 card, a click turns one on,
  // its strength shows beside it, and nothing is submitted.
  check(!(await page.$('.chat-card[data-card="C1"] .lora-chips:not([hidden]) .lora-chip')), "C1 (Krea 2) shows H3 LoRA chips");
  await page.click('.chat-card[data-card="C3"] .lora-chip[data-lora="neon.safetensors"]');
  await page.click('.chat-card[data-card="C3"] .lora-chip[data-lora="anime.safetensors"]');
  await page.fill('.chat-card[data-card="C3"] .lora-chip-wrap:has([data-lora="anime.safetensors"]) input', "0.6");
  await page.dispatchEvent('.chat-card[data-card="C3"] .lora-chip-wrap:has([data-lora="anime.safetensors"]) input', "change");
  check(await page.getAttribute('.chat-card[data-card="C3"] .lora-chip[data-lora="neon.safetensors"]', "aria-pressed") === "true", "C3: the LoRA chip did not turn on");
  check(jobs.length === 1, "turning a LoRA chip on submitted a job");
  if (SHOTS) await (await page.$('.chat-card[data-card="C3"]')).screenshot({ path: `${SHOTS}/card-loras-1440.png` });
  await page.click('.chat-card[data-card="C3"] .primary-btn');
  // The card shows its job's progress while it renders.
  await page.waitForSelector('.chat-card[data-card="C3"] .cc-progress');
  const h3 = Object.values(done).find(j => j.status === "queued");
  send({ ...h3, status: "running", progress: 0.4, message: "Denoising step 4/10" });
  await page.waitForTimeout(300);
  const bar = await page.$eval('.chat-card[data-card="C3"] .cc-progress', b => [b.querySelector("progress").value, b.textContent]);
  check(bar[0] === 40 && bar[1].includes("40") && bar[1].includes("Denoising step 4/10"), "card progress not shown: " + JSON.stringify(bar));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/card-progress-1440.png` });
  Object.assign(h3, { status: "done", progress: 1, outputs: h3.later });
  send(h3);
  await page.waitForSelector('.chat-card[data-card="C3"] .status.done');
  check(!(await page.$('.chat-card[data-card="C3"] .cc-progress')), "progress still shown after the render");
  check(jobs.length === 2 && jobs[1].pipeline === "h3-i2v" && jobs[1].params.image === "outputs/job-1.png", "C3 job wrong: " + JSON.stringify(jobs[1]));
  check(JSON.stringify(jobs[1]?.params.loras) === JSON.stringify([{ name: "neon.safetensors", strength: 1 }, { name: "anime.safetensors", strength: 0.6 }]),
    "C3: the job does not carry the LoRAs turned on: " + JSON.stringify(jobs[1]?.params.loras));
  check((await page.$$('.chat-card[data-card="C3"] .cc-outputs figure')).length === 1, "C3 should show the clip only (last frame hidden)");
  // A video-from-references card has no director button: Generate and Open in the Studio.
  check(JSON.stringify(await page.$$eval('.chat-card[data-card="C5"] .cc-actions button', bs => bs.map(b => b.textContent)))
    === '["🎞 Générer la vidéo","Ouvrir dans le Studio"]', "C5 buttons: " + await page.textContent('.chat-card[data-card="C5"] .cc-actions'));
  // Open in the Studio: switches to the Studio, fills the form, starts nothing.
  await page.click('.chat-card[data-card="C5"] .cc-actions button >> nth=1');
  await page.waitForTimeout(300);
  check(await page.evaluate(() => document.body.dataset.mode) === "studio", "Open in the Studio did not switch to the Studio");
  check(await page.inputValue("#brief") === "A detective enters a studio", "C5 brief not in the form");
  check(await page.inputValue("#pipelineSelect") === "reference2video" && await page.inputValue("#videoDuration") === "7", "C5 settings not in the form");
  check(jobs.length === 2, "Open in the Studio submitted a job");
  await page.click("#undoToastBtn");
  check(await page.inputValue("#brief") === "", "undo did not restore the brief");
  // C2 opened in the form: input image and market.
  await page.click('.rail-mode[data-mode="assistant"]');
  await page.click('.chat-card[data-card="C2"] .cc-actions button >> nth=2');
  await page.waitForTimeout(300);
  check(await page.inputValue("#pipelineSelect") === "image2image" && await page.inputValue("#modelSelect") === "qwen21_i2i", "C2 pipeline");
  check(!(await page.isHidden("#assetChip")), "C2 input image not set");
  check((await page.$$(".market-chip.active")).length === 1, "C2 market not selected");
  // A question answered by a button; the model's own "Other…" is not shown twice.
  await page.click('.rail-mode[data-mode="assistant"]');
  check((await page.$$(".chat-question .cc-options button")).length === 3, "the model's own Other… duplicates the card's");
  await page.click('.chat-question .cc-options button >> nth=1');
  await page.waitForTimeout(500);
  check(chatBodies[1]?.answer_to === "C4" && chatBodies[1].text === "Night", "answer not sent: " + JSON.stringify(chatBodies[1]));
  check(jobs.length === 2, "jobs after the answer");
  // A subject sheet from a photo: one Qwen Image 2.1 edit of the photo into five views, at the sheets' size.
  await page.click('.rail-mode[data-mode="assistant"]');
  const before8 = jobs.length;
  await page.click('.chat-card[data-card="C8"] .primary-btn');
  await page.waitForSelector('.chat-card[data-card="C8"] .status.done');
  const j8 = jobs[before8];
  check(jobs.length === before8 + 1 && j8.pipeline === "qwen-image-2.1" && JSON.stringify(j8.params.images) === '["inputs/att.png"]'
    && j8.params.width === 1920 && j8.params.height === 1088 && j8.params.prompt.startsWith("Using <image1> as the only identity reference, create one character reference sheet of the person from <image1>: a woman in a red coat.")
    && j8.params.prompt.includes("Five views, each appearing exactly once. On the left, a column of two close views stacked"), "sheet from a photo: " + JSON.stringify(j8));
  // Video from references in the Studio form: nothing to review. With no reference image,
  // Generate refuses on screen without a job; the sheet button submits only its sheet's job
  // and the sheet joins the references as the character; Generate is then one h3-r2v job.
  await page.click('.rail-mode[data-mode="studio"]');
  if (await page.isVisible("#studioExitBtn")) await page.click("#studioExitBtn");
  await page.click('.usecase[data-pipeline="text2image"]');
  await page.fill("#brief", "A detective walks through a dark forest");
  await page.selectOption("#pipelineSelect", "reference2video");
  check((await page.textContent("#generateBtn")).trim() === "Générer la vidéo" && await page.isHidden("#styleWrap")
    && !(await page.$("#skipSheetsToggle")) && !(await page.$("#sheetTemplateWrap")) && await page.isVisible("#seqCharSheetBtn"),
    "video from references: form (" + (await page.textContent("#generateBtn")).trim() + ")");
  const beforeF = jobs.length;
  await page.click("#generateBtn");
  await page.waitForTimeout(400);
  check(jobs.length === beforeF && /au moins une image/.test(await page.textContent("#generateError"))
    && await page.evaluate(() => document.body.dataset.studio) !== "1",
    "video from references with no image: " + JSON.stringify({ jobs: jobs.length - beforeF, error: await page.textContent("#generateError") }));
  await page.click("#seqCharSheetBtn");
  const sheetIn = await page.waitForFunction(() => document.querySelectorAll("#refSubjects .ref-subject").length === 1, null, { timeout: 20000 })
    .then(() => true, () => false);
  const jSheet = jobs[beforeF];
  check(sheetIn && jobs.length === beforeF + 1 && jSheet.pipeline === "krea2-t2i" && jSheet.params.width === 1920
    && await page.inputValue("#refSubjects .rs-role") === "character", "video from references: the subject sheet: " + JSON.stringify(jobs.slice(beforeF)));
  const beforeG = jobs.length;
  await page.click("#generateBtn");
  for (let i = 0; i < 50 && jobs.length === beforeG; i++) await page.waitForTimeout(200);
  const jG = jobs[beforeG], pG = jG?.params.prompt || "";
  check(jobs.length === beforeG + 1 && jG.pipeline === "h3-r2v" && JSON.stringify(jG.params.references) === `["outputs/job-${n - 1}.png"]`
    && pG.startsWith("subject_definitions:\n<Subject 1> is the main character in <Picture 1>.") && pG.includes("A detective walks through a dark forest")
    && jG.params.aspect === "16:9" && await page.evaluate(() => document.body.dataset.studio) !== "1",
    "video from references: not one h3-r2v job on the sheet: " + JSON.stringify(jG));
  // A character photo becomes its five-view sheet in its place: one Qwen Image 2.1 job.
  await page.setInputFiles("#refImagesInput", { name: "me.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") });
  check(JSON.stringify(await page.$$eval("#refSubjects .rs-role", els => els.map(e => e.value))) === '["character","object"]',
    "video from references: a second image is not an object by default");
  await page.selectOption("#refSubjects .ref-subject >> nth=1 >> select", "character");
  const beforeP = jobs.length;
  await page.click("#refSubjects .ref-subject >> nth=1 >> .rs-sheet");
  await page.waitForFunction(() => !document.querySelector("#refSubjects .ref-subject:nth-child(2) .rs-sheet"), null, { timeout: 20000 }).catch(() => {});
  const jP = jobs[beforeP];
  check(jobs.length === beforeP + 1 && jP.pipeline === "qwen-image-2.1" && jP.params.images?.length === 1 && jP.params.prompt.startsWith("Using <image1>")
    && (await page.$$("#refSubjects .ref-subject")).length === 2, "video from references: sheet from a photo: " + JSON.stringify(jP));
  for (const j of Object.values(done).filter(j => j.status === "queued")) {
    Object.assign(j, { status: "done", progress: 1, outputs: j.later });
    send(j);
  }
  while (await page.$("#refSubjects .rs-x")) await page.click("#refSubjects .rs-x >> nth=0");
  // Reference to video from the card: a reference added from the computer, its role set,
  // then one h3-r2v job whose prompt is the six-field block with A1 as <Subject 1>.
  await page.click('.rail-mode[data-mode="assistant"]');
  const c10 = '.chat-card[data-card="C10"]';
  await page.waitForSelector(`${c10} .cc-refs`);
  check((await page.textContent(`${c10} .cc-refs figcaption`)).startsWith("<Subject 1> · A1"), "C10: A1 not shown as <Subject 1>");
  await page.setInputFiles(`${c10} .cc-refs input[type=file]`, { name: "jungle.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") });
  await page.waitForFunction(sel => document.querySelectorAll(`${sel} .cc-refs figure`).length === 2, c10);
  await page.selectOption(`${c10} .cc-refs figure >> nth=1 >> select`, "setting");
  // A clip and a sound: a clip is <Video 1> for its camera movement, or a subject; a sound is <Audio 1>.
  await page.setInputFiles(`${c10} .cc-refs input[type=file]`, [
    { name: "ride.mp4", mimeType: "video/mp4", buffer: Buffer.from("VIDEO clip") },
    { name: "voice.wav", mimeType: "audio/wav", buffer: Buffer.from("AUDIO sound") }]);
  await page.waitForFunction(sel => document.querySelectorAll(`${sel} .cc-refs figure`).length === 4, c10);
  const caps10 = () => page.$$eval(`${c10} .cc-refs figcaption`, f => f.map(x => x.textContent));
  let caps = await caps10();
  check(caps[2] === "<Video 1> · clip.mp4" && caps[3] === "<Audio 1> · voice.wav", "C10: clip and sound labels: " + caps);
  check(await page.$$eval(`${c10} .cc-refs figure >> nth=3 >> audio`, a => a.length) === 1, "C10: the sound has no player");
  await page.selectOption(`${c10} .cc-refs figure >> nth=2 >> select`, "character");
  caps = await caps10();
  check(caps[2] === "<Subject 3> · clip.mp4", "C10: a clip as a character is not <Subject 3>: " + caps[2]);
  await page.selectOption(`${c10} .cc-refs figure >> nth=2 >> select`, "motion");
  if (SHOTS) await (await page.$(c10)).screenshot({ path: `${SHOTS}/r2v-card-1440.png` });
  const before10 = jobs.length;
  check(jobs.length === before10, "C10: editing the references submitted a job");
  await page.click(`${c10} .cc-actions .primary-btn`);
  await page.waitForTimeout(2500);  // Gemma's vision (stubbed out, 1.5 s) describes each reference first
  const j10 = jobs[before10];
  check(jobs.length === before10 + 1 && j10.pipeline === "h3-r2v"
    && JSON.stringify(j10.params.references) === JSON.stringify(["inputs/att.png", "inputs/att.png", "inputs/clip.mp4", "inputs/voice.wav"]),
    "C10: not one h3-r2v job with the four references in order: " + JSON.stringify(j10));
  const p10 = j10?.params.prompt || "";
  check(p10.startsWith("subject_definitions:\n<Subject 1> is the main character in <Picture 1>.\n<Subject 2> is the location as defined by <Picture 2>.\n"
      + "<Video 1> is the camera-movement and pacing reference for the target video.\n<Audio 1> is the voice-timbre reference for <Subject 1> (S1).\n\n"
      + "summary:\n[reference generation + audio reference] ")
    && p10.includes("\n<Video 1> (camera movement and pacing): weak_reference - ") && p10.includes("\n<Audio 1>: reference - ")
    && p10.includes("detailed_description:\n<Subject 1> is in <Subject 2>. <Subject 1> rides a motorcycle") && !p10.includes("A1")
    && p10.endsWith("non_diegetic_music:\nA slow romantic piano score"),
    "C10: prompt not in the H3 grammar: " + p10);
  check(j10?.params.duration === 5 && j10.params.aspect === "16:9", "C10: settings");
  check(JSON.stringify(j10?.params.loras) === "[]", "C10: LoRAs sent though none was turned on: " + JSON.stringify(j10?.params.loras));
  // The same card opened in the Studio: its references go to the list with their roles, the
  // brief names them by their labels, and one job carries the four references.
  for (const j of Object.values(done).filter(j => j.status === "queued")) {
    Object.assign(j, { status: "done", progress: 1, outputs: j.later });
    send(j);
  }
  await page.waitForSelector(`${c10} .cc-actions button:nth-child(2):not([disabled])`, { timeout: 5000 });
  await page.click(`${c10} .cc-actions button >> nth=1`);
  await page.waitForFunction(() => document.querySelectorAll("#refSubjects .ref-subject").length === 4, null, { timeout: 5000 }).catch(() => {});
  const tags = () => page.$$eval("#refSubjects .rs-tag", els => els.map(e => e.textContent));
  const st = await tags();
  check(JSON.stringify(st) === JSON.stringify(["Sujet 1", "Sujet 2", "Vidéo 1", "Son 1"]), "Studio r2v: reference labels: " + st);
  check(JSON.stringify(await page.$$eval("#refSubjects .rs-role", els => els.map(e => e.value))) === '["character","setting","motion","voice"]',
    "Studio r2v: the roles did not follow the card");
  check((await page.inputValue("#brief")).startsWith("<Subject 1> rides a motorcycle"), "Studio r2v: the brief still names A1: " + await page.inputValue("#brief"));
  if (SHOTS) await (await page.$("#refExtrasWrap")).screenshot({ path: `${SHOTS}/r2v-studio-refs-1440.png` });
  const beforeS = jobs.length;
  check(beforeS === jobs.length, "Studio r2v: opening the card submitted a job");
  await page.click("#generateBtn");
  // Two vision calls now (the character, then the free reference): wait for the job.
  for (let i = 0; i < 50 && jobs.length === beforeS; i++) await page.waitForTimeout(200);
  await page.waitForTimeout(300);
  const jS = jobs[beforeS], pS = jS?.params.prompt || "";
  check(jobs.length === beforeS + 1 && jS.pipeline === "h3-r2v"
    && JSON.stringify(jS.params.references) === JSON.stringify(["inputs/att.png", "inputs/att.png", "inputs/clip.mp4", "inputs/voice.wav"]),
    "Studio r2v: not one job with the four references in order: " + JSON.stringify(jS));
  check(pS.includes("<Subject 1> is the main character in <Picture 1>") && pS.includes("<Subject 2> is the location as defined by <Picture 2>")
    && pS.includes("detailed_description:\n<Subject 1> is in <Subject 2>. <Subject 1> rides a motorcycle"),
    "Studio r2v: the images are not the character and the setting: " + pS.slice(0, 600));
  check(pS.includes("\n<Video 1> is the camera-movement and pacing reference for the target video.\n<Audio 1> is the voice-timbre reference for <Subject 1> (S1).\n")
    && pS.includes("summary:\n[reference generation + audio reference] "), "Studio r2v: prompt: " + pS);
  // "→ Use as input" from the gallery goes to the pipeline on screen: in reference to
  // video an image or a clip joins the references and reaches the job; in a long take,
  // the card offers first frame or reference; with an input image field, the input; Text2Video opens Image2Video,
  // Text2Image opens Image2Image; a clip elsewhere is refused. No job but Generate.
  const useBtn = '.output-panel #galleryBlock .asset-actions button:has-text("→ Utiliser en entrée")';
  const galleryTab = type => page.$eval(type === "video" ? "#tabVideos" : "#tabImages", b => b.click());
  const use = () => page.$eval(useBtn, b => b.click());
  const beforeU = jobs.length;
  await use();
  await galleryTab("video");
  await page.waitForTimeout(400);
  await use();
  await page.waitForTimeout(300);
  check(await page.inputValue("#pipelineSelect") === "reference2video" && await page.isHidden("#assetChip")
    && JSON.stringify(await tags()) === JSON.stringify(["Sujet 1", "Sujet 2", "Vidéo 1", "Son 1", "Sujet 3", "Vidéo 2"]),
    "Use as input in r2v did not add the image and the clip: " + await page.inputValue("#pipelineSelect") + " " + JSON.stringify(await tags()));
  check(jobs.length === beforeU, "Use as input submitted a job");
  await page.click("#generateBtn");
  for (let i = 0; i < 50 && jobs.length === beforeU; i++) await page.waitForTimeout(200);
  check(jobs.length === beforeU + 1 && JSON.stringify(jobs[beforeU].params.references) === JSON.stringify(
    ["inputs/att.png", "inputs/att.png", "inputs/clip.mp4", "inputs/voice.wav", "outputs/krea2-t2i/g1.png", "outputs/h3-t2v/v1.mp4"]),
    "r2v job without the gallery image and clip: " + JSON.stringify(jobs[beforeU]?.params.references));
  const afterU = jobs.length;
  await page.selectOption("#pipelineSelect", "text2image");
  await use();
  check(await page.inputValue("#pipelineSelect") === "text2image" && await page.isHidden("#assetChip"), "a clip changed Text2Image");
  await galleryTab("image");
  await page.waitForTimeout(400);
  // In a long take an image card offers "→ First frame" and "→ Reference" instead. Its
  // goal card opens it alone: no Pipeline menu.
  await page.$eval('.usecase[data-pipeline="sequence"]', b => b.click());
  check(await page.inputValue("#pipelineSelect") === "sequence" && await page.isHidden("#pipelineWrap"), "the long take card shows a Pipeline menu");
  const card0 = ".output-panel #galleryBlock .asset:first-child .asset-actions";
  const shown = () => page.$$eval(`${card0} button`, bs => bs.filter(b => b.offsetParent).map(b => b.textContent));
  const seqBtns = await shown();
  check(seqBtns.includes("→ Première image") && seqBtns.includes("→ Référence") && !seqBtns.includes("→ Utiliser en entrée"),
    "long take gallery buttons: " + JSON.stringify(seqBtns));
  await page.$eval(`${card0} button:first-child`, b => b.click());
  await page.waitForSelector("#lbFirst", { state: "visible" });
  check(await page.isVisible("#lbRef") && await page.isHidden("#lbUse"), "the lightbox of a long take does not offer first frame and reference");
  await page.click("#lightboxClose");
  await page.$eval(`${card0} button.first-use`, b => b.click());
  check(await page.inputValue("#pipelineSelect") === "sequence" && await page.isVisible("#assetChip"), "→ First frame in the long take is not its first frame");
  await page.click("#assetChipClear");
  const refs0 = (await page.$$("#refSubjects .ref-subject")).length;
  await page.$eval(`${card0} button.ref-use`, b => b.click());
  check((await page.$$("#refSubjects .ref-subject")).length === refs0 + 1 && await page.isHidden("#assetChip"), "→ Reference did not add a reference");
  await page.$eval("#refSubjects .ref-subject:last-child .rs-x", b => b.click());
  await page.$eval('.usecase[data-pipeline="text2image"]', b => b.click());
  check(await page.isVisible("#pipelineWrap"), "the general card has no Pipeline menu");
  check(!(await shown()).includes("→ Référence") && (await shown()).includes("→ Utiliser en entrée"), "Text2Image shows → Reference: " + JSON.stringify(await shown()));
  await page.selectOption("#pipelineSelect", "text2video");
  await use();
  check(await page.inputValue("#pipelineSelect") === "image2video" && await page.isVisible("#assetChip"), "Use as input in t2v did not open i2v");
  await page.click("#assetChipClear");
  await page.selectOption("#pipelineSelect", "text2image");
  await use();
  check(await page.inputValue("#pipelineSelect") === "image2image" && await page.isVisible("#assetChip"), "Use as input in t2i did not open i2i");
  check(jobs.length === afterU, "Use as input submitted a job");
  await page.click("#assetChipClear");
  // "Inputs" lists the files sent to renders, read-only, and goes back to the outputs.
  await page.click("#galleryInputsBtn");
  await page.waitForTimeout(400);
  const gridKeys = () => page.$$eval(".output-panel #galleryGrid .asset", els => els.map(e => e.dataset.key));
  check(JSON.stringify(await gridKeys()) === '["inputs/ab12.png"]' && await page.isHidden("#gallerySearch")
    && await page.isHidden("#galleryTrashBtn") && !(await page.$(".output-panel #galleryGrid .asset .fav-btn")),
    "Inputs view: " + JSON.stringify(await gridKeys()));
  await use();
  check(await page.inputValue("#pipelineSelect") === "image2image" && await page.textContent("#assetChipName") === "Galerie : ab12.png",
    "Use as input from the inputs: " + await page.textContent("#assetChipName"));
  await page.click("#galleryInputsBtn");
  await page.waitForTimeout(400);
  check(JSON.stringify(await gridKeys()) === '["krea2-t2i/g1.png"]' && await page.isVisible("#gallerySearch"), "back from the inputs");
  check(jobs.length === afterU, "the inputs view submitted a job");
  await page.click("#assetChipClear");
  await page.selectOption("#pipelineSelect", "reference2video");
  // With no reference left, Generate is refused on screen, without a job; one image is
  // enough: it is the character, and the brief alone gives the place.
  while (await page.$("#refSubjects .rs-x")) await page.click("#refSubjects .rs-x >> nth=0");
  const beforeK = jobs.length;
  await page.click("#generateBtn");
  await page.waitForTimeout(500);
  check(jobs.length === beforeK && await page.isVisible("#generateError")
    && /au moins une image/.test(await page.textContent("#generateError")),
    "video from references without an image: " + JSON.stringify({ jobs: jobs.length - beforeK, error: await page.textContent("#generateError") }));
  await page.setInputFiles("#refImagesInput", { name: "her.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") });
  check(JSON.stringify(await tags()) === '["Sujet 1"]', "one reference: " + JSON.stringify(await tags()));
  await page.click("#generateBtn");
  for (let i = 0; i < 50 && jobs.length === beforeK; i++) await page.waitForTimeout(200);
  const jK = jobs[beforeK], pK = jK?.params.prompt || "";
  check(jobs.length === beforeK + 1 && jK.pipeline === "h3-r2v" && jK.params.references.length === 1
    && pK.includes("<Subject 1> is the main character in <Picture 1>") && !pK.includes("<Subject 2>")
    && await page.isHidden("#generateError"),
    "video from references with one image: " + JSON.stringify(jK && { refs: jK.params.references, prompt: pK.slice(0, 400) }));
  // MOSS-Image: the Mode field shows for that engine only (Standard on a card that has
  // none), and the chosen mode reaches the job.
  await page.click('.rail-mode[data-mode="assistant"]');
  const c11 = '.chat-card[data-card="C11"]', selects = () => page.$$eval(`${c11} .cc-fields select`, els => els.map(e => e.value));
  check(JSON.stringify(await selects()) === '["krea2","16:9","none"]', "MOSS: a Mode field on a Krea 2 card: " + JSON.stringify(await selects()));
  await page.selectOption(`${c11} .cc-fields select >> nth=0`, "moss");
  check(JSON.stringify(await selects()) === '["moss","standard","16:9","none"]', "MOSS: Mode field missing or not on Standard: " + JSON.stringify(await selects()));
  await page.selectOption(`${c11} .cc-fields select >> nth=1`, "quality");
  const before11 = jobs.length;
  check(before11 === jobs.length, "MOSS: a field change submitted a job");
  await page.click(`${c11} .primary-btn`);
  await page.waitForSelector(`${c11} .status.done`);
  const j11 = jobs[before11];
  check(jobs.length === before11 + 1 && j11.pipeline === "moss-image" && j11.params.mode === "quality" && j11.params.width === 1280
    && j11.params.prompt === 'A cafe chalkboard reading "Menu du jour"', "MOSS card job: " + JSON.stringify(j11));
  // The long take card opens the Studio's long take on its segments (no image: text to
  // video first) and renders nothing: the chain starts from the Relay.
  const before12 = jobs.length, llm12 = llmBodies.length;
  await page.click('.chat-card[data-card="C12"] .primary-btn');
  const lt12 = await page.waitForFunction(() => document.querySelectorAll("#relayList .relay-seg").length === 2 && !document.getElementById("studioRelay").hidden,
    null, { timeout: 10000 }).then(() => true, () => false);
  check(lt12 && await page.evaluate(() => document.body.dataset.mode) === "studio" && await page.inputValue("#pipelineSelect") === "sequence",
    "the long take card did not open the long take");
  check(await page.inputValue('#relayList .relay-seg[data-seg="1"] textarea') === "She stops by a tree and smiles.", "the long take card's segments");
  // A laid-out screenplay that defines no subjects: one Gemma call for its recurring props
  // (stubbed out here: the field stays empty, the segments as written), then the card is reported.
  for (let w = 0; w < 50 && !cardPosts.some(([id, b]) => id === "C12" && b.status === "launched"); w++) await page.waitForTimeout(200);
  check(jobs.length === before12 && cardPosts.some(([id, b]) => id === "C12" && b.status === "launched"), "the long take card submitted a job or was not reported");
  check(llmBodies.slice(llm12).filter(b => b.includes("Find the objects, vehicles, animals and minor characters")).length === 1
    && !llmBodies.slice(llm12).some(b => b.includes("shot-list writer")), "the long take card's screenplay: props not asked once, or split by Gemma");
  await page.click("#studioExitBtn");
  // With a first frame and a reference: the first frame is the form's input image (no
  // video format to choose), the reference keeps its role; still no job.
  await page.click('.rail-mode[data-mode="assistant"]');
  const llm13 = llmBodies.length;
  await page.click('.chat-card[data-card="C13"] .primary-btn');
  const lt13 = await page.waitForFunction(() => document.querySelectorAll("#relayList .relay-seg").length >= 1 && !document.getElementById("studioRelay").hidden,
    null, { timeout: 10000 }).then(() => true, () => false);
  check(lt13 && await page.inputValue("#pipelineSelect") === "sequence" && !(await page.$eval("#assetChip", e => e.hidden))
    && await page.isHidden("#relayList .seg-start-row"), "the long take card with a first frame did not open on it");
  check(jobs.length === before12, "the long take card with images submitted a job");
  // A prose screenplay opens at the card's total length and is split by Gemma (stubbed out
  // here: the segments stay as the length laid them out), as "✨ Split the screenplay" does;
  // a laid-out one (C12) is not.
  for (let w = 0; w < 100 && !llmBodies.slice(llm13).some(b => b.includes("shot-list writer")); w++) await page.waitForTimeout(100);
  await page.waitForFunction(() => !document.getElementById("relayComposeBtn").textContent.includes("…"), null, { timeout: 10000 }).catch(() => {});
  check(await page.inputValue("#relayTotal") === "40", "the long take card's total length: " + await page.inputValue("#relayTotal"));
  // The Gemma calls after the click: the two images described, then the split into 4 segments.
  const split = llmBodies.slice(llm13).filter(b => b.includes("shot-list writer"));
  check(split.length === 1 && split[0].includes("exactly 4 consecutive") && split[0].includes("A woman walks along a garden path.")
    && await page.$$eval("#relayList .relay-seg", e => e.length) === 4, "the long take card's prose screenplay was not split at its length");
  await page.click("#studioExitBtn");
  await page.click('.rail-mode[data-mode="assistant"]');
  // References with no kinds from Gemma: a sheet keeps the role of the card that made it
  // (a setting sheet is the setting, not a second character).
  await page.click('.chat-card[data-card="C15"] .primary-btn');
  await page.waitForFunction(() => !document.getElementById("studioRelay").hidden, null, { timeout: 10000 }).catch(() => {});
  const roles15 = await page.$$eval("#refSubjects .rs-role", e => e.map(x => x.value));
  check(JSON.stringify(roles15) === '["character","setting"]', `the long take card's sheets without kinds: ${JSON.stringify(roles15)}`);
  check(jobs.length === before12, "the long take card with sheets submitted a job");
  await page.click("#studioExitBtn");
  await page.click('.rail-mode[data-mode="assistant"]');
  // A long take card that names no references takes the conversation's sheets made before
  // it, the subject first, each with its card's role.
  await page.click('.chat-card[data-card="C16"] .primary-btn');
  await page.waitForFunction(() => !document.getElementById("studioRelay").hidden, null, { timeout: 10000 }).catch(() => {});
  const roles16 = await page.$$eval("#refSubjects .rs-role", e => e.map(x => x.value));
  check(JSON.stringify(roles16) === '["character","setting"]', `the long take card without references: ${JSON.stringify(roles16)}`);
  await page.click("#studioExitBtn");
  await page.click('.rail-mode[data-mode="assistant"]');
  // A reload opens on the welcome; the conversation stays in the list.
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(600);
  check(await page.isVisible("#chatStarters") && (await page.$$("#chatLog > *")).length === 0, "reload did not open on the welcome");
  check(await page.$$eval("#chatConvSelect option", o => o.length) === 2, "the earlier conversation is not in the list");
  check(!errs.length, "page errors: " + errs.join(" | "));
  await browser.close(); server.close();
  console.log(fails.length ? "FAIL\n" + fails.join("\n") : "Assistant mode: all checks passed.");
  process.exit(fails.length ? 1 : 0);
})();
