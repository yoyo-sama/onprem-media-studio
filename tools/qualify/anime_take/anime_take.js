#!/usr/bin/env node
// A 3-minute anime rendered through the real Studio as three 60 s long takes (the long take
// holds 150 s at most), then joined. For each take, a fresh page: "Narrative video" card, the
// character sheets put in References (role: character), the take's screenplay (H3 layout,
// read as written, no Gemma split) pasted as the brief, Generate (opens the long take; Gemma
// only describes the sheets). The three takes are all prepared BEFORE any render, so no Gemma
// call runs beside an H3 render; then "Generate the chain" is clicked on each in turn (the
// server holds the three chains) and the pages close. The script follows the jobs through the
// API, then queues one video-concat of the three takes. Writes report.json and screenshots.
//
//   node anime_take.js http://localhost:8090/ ./out
//   ONLY=take1 node anime_take.js http://localhost:8090/ ./out-take1   (one take, not joined)
//   DRY=1 ONLY=take1 node anime_take.js http://localhost:8090/ ./out-dry  (stops before the chain:
//   Gemma calls only, no render; writes dry.json with the shared Subjects field and the log)
"use strict";
const fs = require("fs"), path = require("path");
const { chromium } = require("playwright");

const BASE = (process.argv[2] || "http://localhost:8090/").replace(/\/?$/, "/");
const OUT = path.resolve(process.argv[3] || "out");
const HERE = __dirname, MIN = 60e3;
const TAKES = [
  { name: "take1", screenplay: "take1.txt", refs: ["sheets/riko.png", "sheets/kettle.png"] },
  { name: "take2", screenplay: "take2.txt", refs: ["sheets/riko.png", "sheets/kettle.png", "sheets/baron.png"] },
  { name: "take3", screenplay: "take3.txt", refs: ["sheets/riko.png", "sheets/kettle.png", "sheets/baron.png"] },
].filter(t => !process.env.ONLY || process.env.ONLY.split(",").includes(t.name));
const api = async (p, body) => (await fetch(BASE + p, body ? { method: "POST", headers: { "Content-Type": "application/json" },
                                                               body: JSON.stringify(body) } : undefined)).json();
const pending = s => ["queued", "running"].includes(s);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const t0 = Date.now(), stamp = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;
  const say = msg => console.log(`[${stamp()}] ${msg}`);
  const health = await api("api/health");
  if (health.queue) { say(`queue not empty (${health.queue}): nothing done`); process.exit(3); }
  const browser = await chromium.launch();
  const errors = [], takes = [];
  for (const take of TAKES) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => { try { localStorage.setItem("lang", "en"); } catch { /* no storage */ } });
    const page = await ctx.newPage();
    const jobs = [];
    page.on("response", async r => {
      if (!r.url().endsWith("/api/jobs") || r.request().method() !== "POST") return;
      try { const body = JSON.parse(r.request().postData()); const j = await r.json();
            jobs.push({ id: j.id, pipeline: body.pipeline, params: body.params, at: stamp() });
            say(`${take.name} job ${j.id}: ${body.pipeline}`); } catch (e) { errors.push(`${take.name} job capture: ${e.message}`); }
    });
    page.on("pageerror", e => errors.push(`${take.name}: ${e.message}`));
    page.on("dialog", d => d.accept());
    const shot = n => page.screenshot({ path: path.join(OUT, `${take.name}-${n}.png`), fullPage: true });
    await page.goto(BASE + "index.html#studio", { waitUntil: "load" });
    await page.click('.usecase[data-pipeline="sequence"]');
    await page.setInputFiles("#refImagesInput", take.refs.map(f => path.join(HERE, f)));
    await page.waitForFunction(n => document.querySelectorAll("#refSubjects .ref-subject").length === n, take.refs.length, { timeout: MIN });
    await page.fill("#brief", fs.readFileSync(path.join(HERE, take.screenplay), "utf8"));
    await shot("1-form");
    say(`${take.name}: generate (opens the long take, Gemma describes ${take.refs.length} sheet(s))`);
    await page.click("#generateBtn");
    await page.waitForSelector("#studioRelay:not([hidden])", { timeout: 15 * MIN });
    await page.waitForFunction(() => { const a = [...document.querySelectorAll("#relayList .relay-seg textarea")];
      return a.length === 6 && a.every(x => x.value.trim()); }, null, { timeout: 15 * MIN });
    await page.waitForSelector("#relayRunBtn:not([disabled])", { timeout: 5 * MIN });
    const segments = await page.$$eval("#relayList .relay-seg", els => els.map(e => ({
      text: e.querySelector("textarea").value,
      link: e.querySelector(".seg-link") && !e.querySelector(".seg-link").hidden ? e.querySelector(".seg-link").textContent.trim() : "",
      duration: e.querySelector('input[type="number"]')?.value })));
    const plan = await page.textContent("#relayPlan");
    say(`${take.name}: ${plan} | ${segments.map(s => s.link || "start").join(" | ")}`);
    await shot("2-take");
    takes.push({ ...take, ctx, page, jobs, segments, plan, shot });
  }
  if (process.env.DRY) {
    const dry = [];
    for (const t of takes) dry.push({ name: t.name, jobs: t.jobs.length, plan: t.plan,
      subjects: await t.page.$eval('#relayLook textarea[data-look="subjects"]', e => e.value),
      log: await t.page.$$eval("#events .event", els => els.map(e => e.textContent.trim())) });
    fs.writeFileSync(path.join(OUT, "dry.json"), JSON.stringify({ takes: dry, errors }, null, 2));
    say(`dry run: ${dry.map(d => `${d.name} subjects ${d.subjects ? "filled" : "EMPTY"}, ${d.jobs} job(s)`).join("; ")}, ${errors.length} page error(s)`);
    await browser.close();
    process.exit(dry.every(d => d.subjects && !d.jobs) ? 0 : 1);
  }
  // Every take is ready: the chains, in order. Nothing above submitted a job.
  for (const take of takes) {
    say(`${take.name}: generate the chain`);
    await take.page.click("#relayRunBtn");
    for (let w = 0; w < 120 && take.jobs.length < 7; w++) await take.page.waitForTimeout(1000);
    await take.page.waitForTimeout(3000);
    await take.shot("3-queued");
    say(`${take.name}: ${take.jobs.length} job(s) queued`);
  }
  for (const take of takes) await take.ctx.close();
  await browser.close();

  // The server alone carries the chains.
  const all = takes.flatMap(t => t.jobs);
  let state = {};
  for (let w = 0; w < 6 * 360; w++) {
    for (const j of all) state[j.id] = await api(`api/jobs/${j.id}`);
    if (all.every(j => !pending(state[j.id].status))) break;
    if (w % 30 === 0) say(all.map(j => `${j.pipeline}:${state[j.id].status}`).join(" "));
    await new Promise(r => setTimeout(r, 10000));
  }
  for (const j of all) { const r = state[j.id];
    Object.assign(j, { status: r.status, outputs: r.outputs, error: r.error, message: r.message, started: r.started, finished: r.finished }); }
  const stitched = takes.map(t => t.jobs.find(j => j.pipeline === "video-stitch"));
  let film = null;
  if (takes.length === 1 && stitched[0]?.status === "done") {
    film = { id: stitched[0].id, status: "done", outputs: stitched[0].outputs };
  } else if (stitched.every(j => j?.status === "done")) {
    const clips = stitched.map(j => j.outputs.find(o => o.endsWith(".mp4")));
    say(`joining ${clips.join(", ")}`);
    const job = await api("api/jobs", { pipeline: "video-concat", params: { clips, smooth_audio: true }, origin: "anime3min" });
    let r = job;
    while (pending(r.status)) { await new Promise(res => setTimeout(res, 5000)); r = await api(`api/jobs/${job.id}`); }
    film = { id: job.id, status: r.status, outputs: r.outputs, error: r.error };
  }
  const report = { takes: takes.map(t => ({ name: t.name, refs: t.refs, plan: t.plan, segments: t.segments, jobs: t.jobs })),
                   film, errors, seconds: Math.round((Date.now() - t0) / 1000) };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  say(`done: film ${film ? film.status + " " + (film.outputs || []).join(" ") : "not joined"}, ${errors.length} page error(s)`);
  process.exit(film?.status === "done" ? 0 : 1);
})().catch(e => { console.error(e.stack); process.exit(2); });
