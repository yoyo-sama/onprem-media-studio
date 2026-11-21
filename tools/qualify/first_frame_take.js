#!/usr/bin/env node
// A long take with a first frame and a reference, rendered through the real Studio: an
// empty café terrace drawn by Krea 2 (one API job) is the first frame, the woman's sheet
// comes from "✨ Subject sheet from the brief" (one Krea 2 job), then Generate (opens the
// long take), 30 s, "✨ Split the screenplay" and "Generate the chain". Segment 1 must start
// on the first frame (H3 i2v), the continuations keep the woman of the sheet (h3-r2v).
// Needs a running server on the GB10 and Playwright with its Chromium. Writes report.json
// and page screenshots to the output folder; the frames are inspected by a person.
//
//   node tools/qualify/first_frame_take.js http://localhost:8090/ ./control-test-c
"use strict";
const fs = require("fs"), path = require("path");
const { chromium } = require("playwright");

const BASE = (process.argv[2] || "http://localhost:8090/").replace(/\/?$/, "/");
const OUT = process.argv[3] || ".";
const TOTAL = 30, MIN = 60e3;
const FRAME = "An empty café terrace on a small Parisian square in the early morning, round marble tables and wicker chairs, "
  + "a stone fountain in the middle of the square, soft golden sunlight, wet cobblestones, no people, eye-level wide shot.";
const BRIEF = "Une femme d'une quarantaine d'années, cheveux noirs mi-longs ondulés, lunettes rondes à monture écaille, "
  + "trench beige sur une marinière, sac en cuir rouge. Le matin, elle arrive sur la terrasse vide d'un café d'une petite "
  + "place parisienne, s'assoit à une table ronde près de la fontaine et pose son sac. Le serveur lui apporte un café ; "
  + "elle sort un carnet et dessine la fontaine en souriant.";
const api = async (p, body) => (await fetch(BASE + p, body && { method: "POST", headers: { "Content-Type": "application/json" },
                                                                 body: JSON.stringify(body) })).json();

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const t0 = Date.now(), stamp = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;
  const say = msg => console.log(`[${stamp()}] ${msg}`);
  // The first frame: one Krea 2 image, through the API.
  let job = await api("api/jobs", { pipeline: "krea2-t2i", params: { prompt: FRAME, width: 1280, height: 720, count: 1, seed: 7 } });
  say(`first frame: job ${job.id}`);
  while (["queued", "running"].includes(job.status)) { await new Promise(r => setTimeout(r, 5000)); job = await api(`api/jobs/${job.id}`); }
  if (job.status !== "done") throw new Error(`first frame: ${job.status} ${job.message || ""}`);
  const frame = path.join(OUT, "first-frame.png");
  fs.writeFileSync(frame, Buffer.from(await (await fetch(BASE + job.outputs[0])).arrayBuffer()));

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => { try { localStorage.setItem("lang", "en"); } catch { /* no storage */ } });
  const page = await ctx.newPage();
  const jobs = [{ id: job.id, pipeline: "krea2-t2i", params: { prompt: FRAME }, at: "first frame" }], errors = [];
  page.on("response", async r => {
    if (!r.url().endsWith("/api/jobs") || r.request().method() !== "POST") return;
    try { const body = JSON.parse(r.request().postData()); const j = await r.json();
          jobs.push({ id: j.id, pipeline: body.pipeline, params: body.params, at: stamp() });
          say(`job ${j.id}: ${body.pipeline}`); } catch (e) { errors.push(`job capture: ${e.message}`); }
  });
  page.on("pageerror", e => errors.push(e.message));
  page.on("dialog", d => d.accept());
  const shot = name => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });

  await page.goto(BASE + "index.html#studio", { waitUntil: "load" });
  await page.click('.usecase[data-pipeline="sequence"]');
  await page.fill("#brief", BRIEF);
  say("subject sheet from the brief");
  await page.click("#seqCharSheetBtn");
  await page.waitForFunction(() => document.querySelectorAll("#refSubjects .ref-subject").length === 1, null, { timeout: 20 * MIN });
  await page.setInputFiles("#imageInput", frame);
  await page.waitForTimeout(2000);
  await shot("1-form");
  say("generate: opens the long take");
  await page.click("#generateBtn");
  await page.waitForSelector("#studioRelay:not([hidden])", { timeout: 15 * MIN });
  await page.fill("#relayTotal", String(TOTAL));
  await page.dispatchEvent("#relayTotal", "change");
  say("split the screenplay with Gemma");
  await page.waitForSelector("#relayComposeBtn:not([disabled])", { timeout: 2 * MIN });
  await page.click("#relayComposeBtn");
  await page.waitForFunction(() => { const a = [...document.querySelectorAll("#relayList .relay-seg textarea")];
    return a.length > 1 && a.every(x => x.value.trim()); }, null, { timeout: 15 * MIN });
  const segments = await page.$$eval("#relayList .relay-seg", els => els.map(e => ({
    text: e.querySelector("textarea").value,
    link: e.querySelector(".seg-link") && !e.querySelector(".seg-link").hidden ? e.querySelector(".seg-link").textContent.trim() : "",
    duration: e.querySelector('input[type="number"]')?.value })));
  say(`split: ${segments.map(s => s.link || "start").join(" | ")}`);
  await shot("2-split");
  say("generate the chain");
  await page.click("#relayRunBtn");
  await page.waitForFunction(() => { const s = [...document.querySelectorAll("#relayList .seg-status")].map(e => e.textContent);
    return s.length && (s.every(x => x === "Ready") || s.some(x => x === "Error")); }, null, { timeout: 180 * MIN, polling: 5000 });
  const status = await page.$$eval("#relayList .seg-status", els => els.map(e => e.textContent));
  say(`segments: ${status.join(", ")}`);
  let take = null;
  for (let w = 0; w < 360 && !take; w++) {
    const stitch = jobs.find(j => j.pipeline === "video-stitch");
    if (stitch) { const j = await api(`api/jobs/${stitch.id}`); if (!["queued", "running"].includes(j.status)) take = j; }
    if (!take) await page.waitForTimeout(10000);
  }
  for (const j of jobs) {
    const r = await api(`api/jobs/${j.id}`);
    Object.assign(j, { status: r.status, outputs: r.outputs, message: r.message });
  }
  await shot("3-done");
  const report = { frame: FRAME, brief: BRIEF, total: TOTAL, segments, status,
                   take: take && { id: take.id, status: take.status, outputs: take.outputs },
                   jobs, errors, seconds: Math.round((Date.now() - t0) / 1000) };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  say(`done: take ${take ? take.status : "not assembled"}, ${errors.length} page error(s)`);
  await browser.close();
  process.exit(take?.status === "done" && !errors.length ? 0 : 1);
})().catch(e => { console.error(e.stack); process.exit(2); });
