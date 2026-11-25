#!/usr/bin/env node
// A 30 s Text2Video through the real Studio, with the page closed while the chain renders:
// the long take must finish on the server alone (PR #58). Text2Video, 30 s, Generate (opens the
// long take, Gemma splits the brief into 3 segments), "Generate the chain"; once the 3 segments
// and the assembly are queued, the browser closes. The script then follows the jobs through the
// API only, and at the end opens the page again (same browser profile) to check that the
// Studio shows the assembled take. Needs a running server on the GB10 and Playwright with its
// Chromium. Writes report.json and page screenshots to the output folder; the frames are
// inspected by a person.
//
//   node tools/qualify/closed_page_take.js http://localhost:8090/ ./control-test-closed
"use strict";
const fs = require("fs"), path = require("path");
const { chromium } = require("playwright");

const BASE = (process.argv[2] || "http://localhost:8090/").replace(/\/?$/, "/");
const OUT = path.resolve(process.argv[3] || ".");
const TOTAL = 30, MIN = 60e3;
const BRIEF = "Une femme d'une trentaine d'années aux cheveux roux courts, veste en jean sur un pull vert, traverse "
  + "un marché couvert le matin. Elle s'arrête devant un étal de fruits, choisit une pomme, la montre au marchand en "
  + "souriant, puis repart entre les étals sous la verrière.";
const api = async p => (await fetch(BASE + p)).json();
const pending = s => ["queued", "running"].includes(s);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = path.join(OUT, "profile");
  const t0 = Date.now(), stamp = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;
  const say = msg => console.log(`[${stamp()}] ${msg}`);
  const jobs = [], errors = [];
  const open = async () => {
    const ctx = await chromium.launchPersistentContext(profile, { viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => { try { localStorage.setItem("lang", "en"); } catch { /* no storage */ } });
    const page = ctx.pages()[0] || await ctx.newPage();
    page.on("pageerror", e => errors.push(e.message));
    page.on("dialog", d => d.accept());
    return { ctx, page, shot: name => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true }) };
  };

  let { ctx, page, shot } = await open();
  page.on("response", async r => {
    if (!r.url().endsWith("/api/jobs") || r.request().method() !== "POST") return;
    try { const body = JSON.parse(r.request().postData()); const j = await r.json();
          jobs.push({ id: j.id, pipeline: body.pipeline, params: body.params, at: stamp() });
          say(`job ${j.id}: ${body.pipeline}`); } catch (e) { errors.push(`job capture: ${e.message}`); }
  });
  await page.goto(BASE + "index.html#studio", { waitUntil: "load" });
  await page.click('.usecase[data-pipeline="text2image"]');
  await page.selectOption("#pipelineSelect", "text2video");
  await page.fill("#brief", BRIEF);
  await page.fill("#videoDuration", String(TOTAL));
  await page.dispatchEvent("#videoDuration", "input");
  await shot("1-form");
  say("generate: opens the long take, Gemma splits the brief");
  await page.click("#generateBtn");
  await page.waitForSelector("#studioRelay:not([hidden])", { timeout: 15 * MIN });
  await page.waitForFunction(() => { const a = [...document.querySelectorAll("#relayList .relay-seg textarea")];
    return a.length > 1 && a.every(x => x.value.trim()); }, null, { timeout: 15 * MIN });
  const segments = await page.$$eval("#relayList .relay-seg", els => els.map(e => ({
    text: e.querySelector("textarea").value, duration: e.querySelector('input[type="number"]')?.value })));
  say(`split: ${segments.length} segment(s), ${segments.map(s => s.duration).join(" + ")} s`);
  await shot("2-split");
  say("generate the chain");
  await page.click("#relayRunBtn");
  const queued = segments.length + 1;
  for (let w = 0; w < 120 && jobs.length < queued; w++) await page.waitForTimeout(1000);
  await page.waitForTimeout(3000);
  await shot("3-queued");
  const first = await api(`api/jobs/${jobs[0]?.id}`);
  say(`${jobs.length} job(s) queued, segment 1 is ${first.status}: closing the browser`);
  await ctx.close();
  const closedAt = new Date().toISOString();

  // The page is gone: the server alone carries the chain.
  let stitch = jobs.find(j => j.pipeline === "video-stitch"), done = null;
  for (let w = 0; w < 1080 && !done; w++) {
    const all = await Promise.all(jobs.map(j => api(`api/jobs/${j.id}`)));
    if (all.some(j => ["error", "cancelled"].includes(j.status)) || (stitch && !pending(all[jobs.indexOf(stitch)].status))) done = all;
    else await new Promise(r => setTimeout(r, 10000));
  }
  for (const [i, r] of (done || []).entries())
    Object.assign(jobs[i], { status: r.status, outputs: r.outputs, message: r.message, error: r.error, started: r.started, finished: r.finished });
  say(`jobs: ${jobs.map(j => `${j.pipeline} ${j.status}`).join(", ")}`);

  // The page again: it follows the chain it left and shows the take.
  ({ ctx, page, shot } = await open());
  await page.goto(BASE + "index.html#studio", { waitUntil: "load" });
  let player = null;
  try {
    await page.waitForFunction(() => document.querySelector("#relayPlayer video")?.getAttribute("src"), null, { timeout: 2 * MIN });
    player = await page.getAttribute("#relayPlayer video", "src");
  } catch (e) { errors.push(`reopened page: no take in the player (${e.message.split("\n")[0]})`); }
  await shot("4-reopened");
  await ctx.close();
  stitch = jobs.find(j => j.pipeline === "video-stitch");
  const report = { brief: BRIEF, total: TOTAL, segments, closedAt, jobs, player,
                   take: stitch && { id: stitch.id, status: stitch.status, outputs: stitch.outputs },
                   errors, seconds: Math.round((Date.now() - t0) / 1000) };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  say(`done: take ${stitch?.status || "not queued"}, player ${player ? "shows it" : "empty"}, ${errors.length} page error(s)`);
  process.exit(stitch?.status === "done" && player && !errors.length ? 0 : 1);
})().catch(e => { console.error(e.stack); process.exit(2); });
