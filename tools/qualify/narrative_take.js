#!/usr/bin/env node
// A three-scene story rendered through the real Studio, as a person would click it:
// "Narrative video" card, brief, "✨ Subject sheet from the brief" (one Krea 2 job), Generate
// (opens the long take), 40 s, "✨ Split the screenplay" (Gemma decides the cuts), "Generate
// the chain" (H3 segments, cuts on the sheet, then the stitched take). Needs a running server
// on the GB10 and Playwright with its Chromium. Writes report.json and page screenshots to
// the output folder; the frames are inspected by a person, never trusted from "done".
//
//   node tools/qualify/narrative_take.js http://localhost:8090/ ./narrative-test
"use strict";
const fs = require("fs"), path = require("path");
const { chromium } = require("playwright");

const BASE = (process.argv[2] || "http://localhost:8090/").replace(/\/?$/, "/");
const OUT = process.argv[3] || ".";
const TOTAL = 40;
const BRIEF = "Une jeune femme d'une trentaine d'années, cheveux auburn courts, manteau de laine vert sur un pull crème, "
  + "pantalon sombre et bottines marron. À l'aube, elle quitte son immeuble et descend une rue pavée encore vide, "
  + "un café à la main, en regardant les façades s'éclairer. Plus tard dans la matinée, assise dans un train, elle "
  + "regarde défiler la campagne par la fenêtre et sourit en relisant une vieille lettre. Le soir, elle arrive au bord "
  + "de la mer et marche pieds nus sur la plage au coucher du soleil, ses bottines à la main.";
const MIN = 60e3;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const t0 = Date.now(), stamp = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;
  const say = msg => console.log(`[${stamp()}] ${msg}`);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => { try { localStorage.setItem("lang", "en"); } catch { /* no storage */ } });
  const page = await ctx.newPage();
  const jobs = [], errors = [];
  page.on("response", async r => {
    if (!r.url().endsWith("/api/jobs") || r.request().method() !== "POST") return;
    try { const body = JSON.parse(r.request().postData()); const job = await r.json();
          jobs.push({ id: job.id, pipeline: body.pipeline, params: body.params, at: stamp() });
          say(`job ${job.id}: ${body.pipeline}`); } catch (e) { errors.push(`job capture: ${e.message}`); }
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
  // The take is assembled once every segment is ready: wait for that job to end.
  let take = null;
  for (let w = 0; w < 360 && !take; w++) {
    const stitch = jobs.find(j => j.pipeline === "video-stitch");
    if (stitch) { const j = await (await fetch(`${BASE}api/jobs/${stitch.id}`)).json();
                  if (!["queued", "running"].includes(j.status)) take = j; }
    if (!take) await page.waitForTimeout(10000);
  }
  for (const j of jobs) {
    const r = await (await fetch(`${BASE}api/jobs/${j.id}`)).json();
    Object.assign(j, { status: r.status, outputs: r.outputs, message: r.message });
  }
  await shot("3-done");
  const report = { brief: BRIEF, total: TOTAL, segments, status, take: take && { id: take.id, status: take.status, outputs: take.outputs },
                   jobs, errors, seconds: Math.round((Date.now() - t0) / 1000) };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  say(`done: take ${take ? take.status : "not assembled"}, ${errors.length} page error(s)`);
  await browser.close();
  process.exit(take?.status === "done" && !errors.length ? 0 : 1);
})().catch(e => { console.error(e.stack); process.exit(2); });
