#!/usr/bin/env node
// NODE_PATH=$(npm root -g) node tools/assistant-ui.js [screenshot folder]
//
// The assistant panel in a headless Chromium (Playwright), with /api stubbed and a scripted
// reply (a handoff, five cards and a question): opening the panel, a starter, an attachment,
// sending, editing a card start no job; Generate on a card submits exactly one job with the
// card's edited settings and reports it (running, then done with its files); a card that
// needs another card's result waits for it; "Open in the Studio" fills the form and starts
// nothing (Undo puts the brief back); a choice button answers the question. With a folder,
// screenshots of the panel in light and dark at 390, 768, 1250 and 1440 px.
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
  card("C4", "ask_choices", { question: "Which mood?", options: ["Sunny", "Night"] }),
  card("C5", "storyboard", { brief: "A detective enters a studio", shots: 5, duration: 5, ratio: "16:9" }),
  card("C6", "join_videos", { clips: ["C3#1", "C9#1"] }, { invalid: "clips needs at least 2 items" }),
];
(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  const fails = [], log = [];
  const check = (ok, msg) => { if (!ok) fails.push(msg); };
  const jobs = [], done = {}, chatBodies = [], cardPosts = [];
  let conv = null, n = 0;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route("**/api/**", async route => {
    const req = route.request(), p = new URL(req.url()).pathname;
    const json = (b, s = 200) => route.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
    if (p === "/api/jobs" && req.method() === "POST") {
      const job = JSON.parse(req.postData()), jid = `job-${++n}`;
      jobs.push(job);
      const outs = job.pipeline.startsWith("h3-") ? [`outputs/${jid}.mp4`, `outputs/${jid}-last.png`] : [`outputs/${jid}.png`];
      done[jid] = { id: jid, status: "done", outputs: outs };
      return json(done[jid], 201);
    }
    if (p.startsWith("/api/jobs/")) return json(done[p.split("/").pop()] || {});
    if (p === "/api/inputs") return json({ ref: "inputs/att.png" }, 201);
    if (p === "/api/loras") return json({ h3: [] });
    if (p === "/api/instructions") return json({});
    if (p === "/api/roles") return json(ROLES);
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
    if (p === "/api/gallery/assets") return json({ items: [], next: null, counts: { image: 0, video: 0 } });
    return json({ detail: "x" }, 404);
  });
  await ctx.route("**/outputs/**", r => r.fulfill({ contentType: "image/png", body: Buffer.from(PNG, "base64") }));
  await ctx.route("**/inputs/**", r => r.fulfill({ contentType: "image/png", body: Buffer.from(PNG, "base64") }));
  const page = await ctx.newPage();
  const errs = []; page.on("pageerror", e => errs.push(e.message));
  page.on("dialog", d => d.accept());
  await page.goto(base + "index.html", { waitUntil: "load" });
  await page.evaluate(() => localStorage.setItem("lang", "fr"));
  await page.reload({ waitUntil: "load" });
  await page.click("#railAssistant");
  await page.waitForSelector("#chatPanel:not([hidden])");
  await page.click("#chatStarters button >> nth=0");
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
  check((await page.textContent("#chatLog")).includes("Une proposition a été écartée"), "invalid card note missing");
  // Editing a card starts nothing.
  await page.fill('.chat-card[data-card="C1"] textarea', "a perfume bottle on wet black stone, morning mist");
  await page.selectOption('.chat-card[data-card="C1"] select >> nth=1', "1:1");
  check(jobs.length === 0, "a card edit submitted a job");
  if (SHOTS) for (const theme of ["light", "dark"]) for (const w of [390, 768, 1250, 1440]) {
    await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/chat-${theme}-${w}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.click('.chat-card[data-card="C1"] .primary-btn');
  await page.waitForSelector('.chat-card[data-card="C1"] .status.done');
  check(jobs.length === 1 && jobs[0].pipeline === "krea2-t2i", "C1 did not submit one krea2 job: " + JSON.stringify(jobs.map(j => j.pipeline)));
  check(jobs[0]?.params.width === 1024 && jobs[0].params.prompt.startsWith("a perfume bottle on wet black stone, morning mist "), "C1 edits not in the job: " + JSON.stringify(jobs[0]?.params));
  check(jobs[0]?.origin === "assistant", "origin");
  check(cardPosts[0]?.[1].status === "running" && cardPosts[0][1].args.ratio === "1:1", "running report lacks the edited args");
  await page.waitForSelector('.chat-card[data-card="C3"] .primary-btn:not([disabled])');
  await page.click('.chat-card[data-card="C3"] .primary-btn');
  await page.waitForSelector('.chat-card[data-card="C3"] .status.done');
  check(jobs.length === 2 && jobs[1].pipeline === "h3-i2v" && jobs[1].params.image === "outputs/job-1.png", "C3 job wrong: " + JSON.stringify(jobs[1]));
  check((await page.$$('.chat-card[data-card="C3"] .cc-outputs figure')).length === 1, "C3 should show the clip only (last frame hidden)");
  // Open in the Studio: fills the form, starts nothing.
  await page.click('.chat-card[data-card="C5"] .primary-btn');
  await page.waitForTimeout(300);
  check(await page.inputValue("#brief") === "A detective enters a studio", "storyboard brief not in the form");
  check(await page.inputValue("#pipelineSelect") === "storyboard" && await page.inputValue("#shotCount") === "5", "storyboard settings not in the form");
  check(jobs.length === 2, "Open in the Studio submitted a job");
  await page.click("#undoToastBtn");
  check(await page.inputValue("#brief") === "", "undo did not restore the brief");
  // C2 opened in the form: input image and market.
  await page.click('.chat-card[data-card="C2"] .cc-actions button >> nth=2');
  await page.waitForTimeout(300);
  check(await page.inputValue("#pipelineSelect") === "image2image" && await page.inputValue("#modelSelect") === "qwen21_i2i", "C2 pipeline");
  check(!(await page.isHidden("#assetChip")), "C2 input image not set");
  check((await page.$$(".market-chip.active")).length === 1, "C2 market not selected");
  // A question answered by a button.
  await page.click("#railAssistant"); await page.click("#railAssistant");
  await page.click('.chat-question .cc-options button >> nth=1');
  await page.waitForTimeout(500);
  check(chatBodies[1]?.answer_to === "C4" && chatBodies[1].text === "Night", "answer not sent: " + JSON.stringify(chatBodies[1]));
  check(jobs.length === 2, "jobs after the answer");
  check(!errs.length, "page errors: " + errs.join(" | "));
  await browser.close(); server.close();
  console.log(fails.length ? "FAIL\n" + fails.join("\n") : "Assistant panel: all checks passed.");
  process.exit(fails.length ? 1 : 0);
})();
