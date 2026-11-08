#!/usr/bin/env node
// NODE_PATH=$(npm root -g) node tools/lora-ui.js [screenshot folder]
//
// The LoRA stack in a headless Chromium (Playwright), /api stubbed: in the Studio, the
// stack shows for the workflows whose engine takes LoRAs (H3, Krea 2, Qwen Image 2.1,
// MOSS-Image), one stack per LoRA folder, takes up to 4 files (each once) with their
// strengths, editing it submits nothing, and Generate sends exactly the rows on screen;
// a workflow without LoRAs sends none, and coming back finds the stack as it was. The
// Models panel uploads into the chosen folder, or the one an engine prefix of the file name names. In the Canvas, a card saved with the old
// single `lora` property comes back as a one-row stack, and Generate sends the stack.
// With a folder, screenshots of the Studio form and the Canvas panel.
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
const FILES = ["anime.safetensors", "film-grain.safetensors", "neon.safetensors", "sketch.safetensors", "watercolor.safetensors"];
const LISTING = { h3: FILES.map(name => ({ name, size: 2 ** 20 })), krea2: [{ name: "realism.safetensors", size: 2 ** 20 }],
                  qwen21: [], moss: [{ name: "gouache.safetensors", size: 2 ** 20 }] };

(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  let browser;
  try { browser = await chromium.launch(); }
  catch (err) { console.error("ERROR (test could not run): " + err.message.split("\n")[0]); process.exit(2); }
  const fails = [];
  const check = (ok, msg) => { if (!ok) fails.push(msg); };
  const jobs = [], uploads = [];
  let n = 0;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route("**/api/**", async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname;
    const json = (b, s = 200) => route.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
    if (p === "/api/jobs" && req.method() === "POST") {
      jobs.push(JSON.parse(req.postData()));
      return json({ id: `job-${++n}`, status: "queued", progress: 0, outputs: [] }, 201);
    }
    if (p.startsWith("/api/jobs/")) return json({ id: p.split("/").pop(), status: "queued", progress: 0, outputs: [] });
    if (p === "/api/loras") return json(LISTING);
    if (p.startsWith("/api/loras/") && req.method() === "POST") {
      uploads.push([p, url.searchParams.get("name")]);
      return json({ folder: "h3", name: url.searchParams.get("name"), size: 3 }, 201);
    }
    if (p === "/api/instructions") return json({});
    if (p === "/api/roles") return json([]);
    if (p === "/api/chats") return json([]);
    if (p === "/api/inputs") return json({ ref: "inputs/up.png" }, 201);
    if (p.startsWith("/api/gallery/")) return json({ items: [], next: null, counts: { image: 0, video: 0 } });
    return json({ detail: "x" }, 404);
  });
  await ctx.routeWebSocket("**/api/ws", () => {});
  await ctx.route(/\/(outputs|inputs)\//, r => r.fulfill({ contentType: "image/png", body: Buffer.from(PNG, "base64") }));
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));
  page.on("dialog", d => d.accept());

  // ── Studio ──
  await page.goto(base + "index.html#studio", { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelector("#loraFolderSelect option"));
  const rows = () => page.$$eval("#loraStack .lora-row", rs => rs.map(r => [r.querySelector("select").value, r.querySelector("input").value]));
  await page.selectOption("#pipelineSelect", "text2image");
  check(await page.isVisible("#loraWrap"), "text2image (Krea 2) hides the LoRA stack");
  check((await rows()).length === 0, "the Krea 2 stack does not start empty");
  await page.selectOption("#pipelineSelect", "text2video");
  check(await page.isVisible("#loraWrap"), "text2video hides the LoRA stack");
  check((await rows()).length === 0, "the stack does not start empty");
  for (let i = 0; i < 4; i++) await page.click("#loraStack .lora-add");
  let r = await rows();
  check(r.length === 4 && new Set(r.map(x => x[0])).size === 4, `4 rows with 4 different files expected, got ${JSON.stringify(r)}`);
  check(await page.isDisabled("#loraStack .lora-add"), "a 5th LoRA can be added");
  // A file used by another row is not offered.
  const offered = await page.$$eval("#loraStack .lora-row:nth-child(2) option", os => os.map(o => o.value));
  check(!offered.includes(r[0][0]), "row 2 offers row 1's file");
  await page.click("#loraStack .lora-row:nth-child(4) .lora-x");
  await page.click("#loraStack .lora-row:nth-child(3) .lora-x");
  await page.selectOption("#loraStack .lora-row:nth-child(2) select", "watercolor.safetensors");
  await page.fill("#loraStack .lora-row:nth-child(1) input", "0.75");
  await page.dispatchEvent("#loraStack .lora-row:nth-child(1) input", "change");
  await page.fill("#loraStack .lora-row:nth-child(2) input", "-5");
  await page.dispatchEvent("#loraStack .lora-row:nth-child(2) input", "change");
  r = await rows();
  check(JSON.stringify(r) === JSON.stringify([["anime.safetensors", "0.75"], ["watercolor.safetensors", "-2"]]),
    `edited stack expected anime 0.75 + watercolor -2 (clamped), got ${JSON.stringify(r)}`);
  check(jobs.length === 0, "editing the stack submitted a job");
  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.locator(".generate-bar").screenshot({ path: path.join(SHOTS, "studio-lora-stack.png") });
  }
  await page.fill("#brief", "a lighthouse at night");
  await page.click("#generateBtn");
  await page.waitForFunction(() => !document.getElementById("generateBtn").disabled);
  await page.waitForTimeout(300);
  check(jobs.length === 1 && jobs[0].pipeline === "h3-t2v", `one h3-t2v job expected, got ${JSON.stringify(jobs.map(j => j.pipeline))}`);
  check(JSON.stringify(jobs[0]?.params.loras) === JSON.stringify([{ name: "anime.safetensors", strength: 0.75 },
    { name: "watercolor.safetensors", strength: -2 }]), `job loras: ${JSON.stringify(jobs[0]?.params.loras)}`);
  // Image to video: the same folder, so the same stack.
  await page.selectOption("#pipelineSelect", "image2video");
  check((await rows()).length === 2, "the H3 stack is not kept across H3 workflows");
  await page.selectOption("#pipelineSelect", "text2image");
  await page.click("#generateBtn");
  await page.waitForFunction(() => !document.getElementById("generateBtn").disabled);
  await page.waitForTimeout(300);
  const img = jobs.slice(1);
  check(img.length >= 1 && img.every(j => j.pipeline === "krea2-t2i" && !("loras" in j.params)),
    `text2image with an empty Krea 2 stack sent LoRAs: ${JSON.stringify(img.map(j => j.params.loras))}`);
  // Krea 2's own stack: its folder's files only.
  await page.click("#loraStack .lora-add");
  check(JSON.stringify(await rows()) === JSON.stringify([["realism.safetensors", "1"]]), `Krea 2 stack: ${JSON.stringify(await rows())}`);
  let before = jobs.length;
  await page.click("#generateBtn");
  await page.waitForFunction(() => !document.getElementById("generateBtn").disabled);
  await page.waitForTimeout(300);
  check(jobs.length > before && jobs.slice(before).every(j => j.pipeline === "krea2-t2i"
    && JSON.stringify(j.params.loras) === JSON.stringify([{ name: "realism.safetensors", strength: 1 }])),
    `Krea 2 job loras: ${JSON.stringify(jobs.slice(before).map(j => j.params.loras))}`);
  // MOSS-Image: another folder, so another stack.
  await page.selectOption("#modelSelect", "moss_t2i");
  check((await rows()).length === 0, "MOSS-Image shows the Krea 2 stack");
  await page.selectOption("#modelSelect", "krea2_t2i");
  check((await rows()).length === 1, "coming back to Krea 2 lost its stack");
  await page.selectOption("#pipelineSelect", "text2video");
  check((await rows()).length === 2, "coming back to text2video lost the stack");

  // Models panel: upload into the chosen folder.
  await page.click('.rail-btn[data-panel="models"]');
  await page.setInputFiles("#loraFile", { name: "new-style.safetensors", mimeType: "application/octet-stream", buffer: Buffer.from("abc") });
  await page.click("#loraUploadBtn");
  await page.waitForFunction(() => !document.getElementById("loraUploadBtn").disabled);
  check(JSON.stringify(uploads) === JSON.stringify([["/api/loras/h3", "new-style.safetensors"]]), `upload: ${JSON.stringify(uploads)}`);
  // A name with an engine prefix picks (and locks) its folder, whatever was chosen.
  await page.selectOption("#loraFolderSelect", "h3");
  await page.setInputFiles("#loraFile", { name: "Qwen_2.1-Unchained-V1.safetensors", mimeType: "application/octet-stream", buffer: Buffer.from("abc") });
  check(await page.inputValue("#loraFolderSelect") === "qwen21" && await page.isDisabled("#loraFolderSelect"),
    "a Qwen_2.1 file name does not select and lock the qwen21 folder");
  await page.click("#loraUploadBtn");
  await page.waitForFunction(() => !document.getElementById("loraUploadBtn").disabled);
  check(JSON.stringify(uploads[1]) === JSON.stringify(["/api/loras/qwen21", "Qwen_2.1-Unchained-V1.safetensors"]), `prefixed upload: ${JSON.stringify(uploads[1])}`);
  check(!(await page.isDisabled("#loraFolderSelect")), "the folder select stays locked after the upload");
  check((await page.$$("#loraList .model")).length === Object.values(LISTING).flat().length,
    "the Models panel does not list every LoRA");

  // ── Canvas ──
  jobs.length = 0;
  const saved = { last_node_id: 2, last_link_id: 0, links: [], groups: [], config: {}, version: 0.4, nodes: [
    { id: 1, type: "simple/import", pos: [300, 60], size: [320, 240], flags: {}, order: 0, mode: 0, outputs: [{ name: "image", type: 0, links: null }],
      properties: { filename: "a.png", src: "/inputs/a.png", outFile: "inputs/a.png" } },
    { id: 2, type: "simple/video", pos: [700, 60], size: [340, 260], flags: {}, order: 1, mode: 0, inputs: [{ name: "image", type: 0, link: null }],
      outputs: [{ name: "video", type: 0, links: null }], properties: { prompt: "slow push-in", duration: 5, lora: "neon.safetensors", src: "", outFile: null } },
  ] };
  await page.goto(base + "canvas.html", { waitUntil: "load" });
  await page.evaluate(s => localStorage.setItem("canvasGraphState", JSON.stringify(s)), saved);
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => window.__canvas?.graph._nodes.length === 2);
  const props = await page.evaluate(() => window.__canvas.graph.getNodeById(2).properties);
  check(!("lora" in props) && JSON.stringify(props.loras) === JSON.stringify({ h3: [{ name: "neon.safetensors", strength: 1 }] }),
    `old lora property not migrated: ${JSON.stringify(props)}`);
  await page.evaluate(() => {
    const C = window.__canvas, a = C.graph.getNodeById(1), v = C.graph.getNodeById(2);
    a.connect(0, v, 0);
    C.lgcanvas.selectNode(v);
    C.showProps(v);
  });
  await page.waitForSelector("#propsFields .lora-row");
  await page.click("#propsFields .lora-add");
  await page.fill("#propsFields .lora-row:nth-child(2) input", "0.5");
  await page.dispatchEvent("#propsFields .lora-row:nth-child(2) input", "change");
  check(jobs.length === 0, "editing the Canvas stack submitted a job");
  if (SHOTS) await page.locator("#props").screenshot({ path: path.join(SHOTS, "canvas-lora-stack.png") });
  await page.click("#btnRegen");
  await page.waitForTimeout(500);
  check(jobs.length === 1 && jobs[0].pipeline === "h3-i2v", `one h3-i2v job expected, got ${JSON.stringify(jobs.map(j => j.pipeline))}`);
  check(JSON.stringify(jobs[0]?.params.loras) === JSON.stringify([{ name: "neon.safetensors", strength: 1 }, { name: "anime.safetensors", strength: 0.5 }]),
    `Canvas job loras: ${JSON.stringify(jobs[0]?.params.loras)}`);
  const stored = JSON.parse(await page.evaluate(() => localStorage.getItem("canvasGraphState")));
  check(stored.nodes.find(x => x.id === 2).properties.loras.h3.length === 2, "the Canvas stack was not saved");

  check(!errs.length, "page errors: " + errs.join(" | "));
  await browser.close();
  server.close();
  if (fails.length) { console.log("FAIL\n- " + fails.join("\n- ")); process.exit(1); }
  console.log("ALL PASS (Studio and Canvas LoRA stacks)");
})().catch(err => { console.error("ERROR (test could not run): " + err.stack); process.exit(2); });
