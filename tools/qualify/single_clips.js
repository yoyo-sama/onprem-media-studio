#!/usr/bin/env node
// Two single H3 clips through the real Studio form, as a person would click them, to check
// the coherence guards of every H3 prompt outside the long take (PR #60): a 10 s Text2Video
// of a cyclist waving one hand (anatomy: no third hand), and a 10 s Video from references on a
// character sheet (the sheet described once: no doubled subject). One job each, in turn. Needs
// a running server on the GB10 and Playwright with its Chromium. Writes report.json (the
// prompts sent, the jobs) and page screenshots; the frames are inspected by a person, never
// trusted from "done".
//
//   node tools/qualify/single_clips.js http://localhost:8090/ ./out-clips [sheet.png]
"use strict";
const fs = require("fs"), path = require("path");
const { chromium } = require("playwright");

const BASE = (process.argv[2] || "http://localhost:8090/").replace(/\/?$/, "/");
const OUT = path.resolve(process.argv[3] || "out-clips");
const SHEET = path.resolve(process.argv[4] || path.join(__dirname, "anime_take", "sheets", "riko.png"));
const MIN = 60e3;
const CLIPS = [
  { name: "t2v-wave", pipeline: "text2video", refs: [],
    brief: "Une jeune femme aux cheveux bruns attachés, en coupe-vent jaune, roule à vélo le long d'un canal en fin "
      + "d'après-midi. Elle lève la main droite pour saluer un ami sur le quai, la main gauche reste sur le guidon, "
      + "puis elle sourit et continue sa route. Travelling latéral qui la suit." },
  { name: "r2v-sheet", pipeline: "reference2video", refs: [SHEET],
    brief: "La jeune coursière de la planche traverse une place de village en courant, un colis sous le bras gauche, "
      + "et fait un grand signe de la main droite à un passant. Caméra à hauteur d'épaule qui la suit." },
];
const api = async p => (await fetch(BASE + p)).json();
const pending = s => ["queued", "running"].includes(s);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const t0 = Date.now(), say = msg => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)} s] ${msg}`);
  const health = await api("api/health");
  if (health.queue) { say(`queue not empty (${health.queue}): nothing done`); process.exit(3); }
  const browser = await chromium.launch();
  const errors = [], report = [];
  for (const clip of CLIPS) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => { try { localStorage.setItem("lang", "en"); } catch { /* no storage */ } });
    const page = await ctx.newPage();
    const jobs = [];
    page.on("response", async r => {
      if (!r.url().endsWith("/api/jobs") || r.request().method() !== "POST") return;
      try { const body = JSON.parse(r.request().postData()); const j = await r.json();
            jobs.push({ id: j.id, pipeline: body.pipeline, params: body.params }); say(`${clip.name} job ${j.id}: ${body.pipeline}`); }
      catch (e) { errors.push(`${clip.name} job capture: ${e.message}`); }
    });
    page.on("pageerror", e => errors.push(`${clip.name}: ${e.message}`));
    page.on("dialog", d => d.accept());
    await page.goto(BASE + "index.html#studio", { waitUntil: "load" });
    await page.click('.usecase[data-pipeline="text2image"]');
    await page.selectOption("#pipelineSelect", clip.pipeline);
    if (clip.refs.length) {
      await page.setInputFiles("#refImagesInput", clip.refs);
      await page.waitForFunction(n => document.querySelectorAll("#refSubjects .ref-subject").length === n, clip.refs.length, { timeout: MIN });
    }
    await page.fill("#brief", clip.brief);
    await page.fill("#videoDuration", "10");
    await page.dispatchEvent("#videoDuration", "input");
    await page.screenshot({ path: path.join(OUT, `${clip.name}-1-form.png`), fullPage: true });
    say(`${clip.name}: generate`);
    await page.click("#generateBtn");
    for (let w = 0; w < 15 * 60 && !jobs.length; w++) await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(OUT, `${clip.name}-2-queued.png`), fullPage: true });
    await ctx.close();
    const job = jobs[0];
    if (!job) { errors.push(`${clip.name}: no job submitted`); report.push({ ...clip, jobs }); continue; }
    let r = await api(`api/jobs/${job.id}`);
    while (pending(r.status)) { await new Promise(res => setTimeout(res, 10000)); r = await api(`api/jobs/${job.id}`); }
    say(`${clip.name}: ${r.status} ${(r.outputs || []).join(" ")}`);
    report.push({ ...clip, jobs: jobs.map(j => ({ ...j, status: r.status, outputs: r.outputs, error: r.error })) });
  }
  await browser.close();
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ clips: report, errors, seconds: Math.round((Date.now() - t0) / 1000) }, null, 2));
  say(`done, ${errors.length} error(s)`);
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
