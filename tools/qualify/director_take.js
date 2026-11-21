#!/usr/bin/env node
// A three-scene story told to the assistant, rendered as a person would click it: the
// message (automatic role), the Director's questions answered towards a subject sheet,
// the sheet card's Generate, then "🎞 Open the long take" and "Generate the chain" in the
// Studio. Gemma's replies decide the path; at most MAX_TURNS messages. Needs a running
// server on the GB10 and Playwright with its Chromium. Writes report.json (the transcript,
// the cards, the jobs) and page screenshots to the output folder; the frames are inspected
// by a person, never trusted from "done".
//
//   node tools/qualify/director_take.js http://localhost:8090/ ./control-test-a
"use strict";
const fs = require("fs"), path = require("path");
const { chromium } = require("playwright");

const BASE = (process.argv[2] || "http://localhost:8090/").replace(/\/?$/, "/");
const OUT = process.argv[3] || ".";
const STORY = "Un homme d'une soixantaine d'années, barbe grise courte, ciré jaune et bonnet de laine bleu marine. "
  + "À l'aube, il prépare sa barque en bois dans un petit port breton, sous un ciel rose. "
  + "En fin de matinée, en pleine mer, il remonte son filet et éclate de rire en découvrant un gros poisson argenté. "
  + "Au crépuscule, rentré chez lui, il ôte son bonnet et s'assoit près de la cheminée avec une tasse fumante. "
  + "Fais-en une vidéo d'environ 30 secondes.";
const MAX_TURNS = 6, MIN = 60e3;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const t0 = Date.now(), stamp = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;
  const say = msg => console.log(`[${stamp()}] ${msg}`);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => { try { localStorage.setItem("lang", "en"); } catch { /* no storage */ } });
  const page = await ctx.newPage();
  const jobs = [], errors = [], turns = [];
  page.on("response", async r => {
    if (!r.url().endsWith("/api/jobs") || r.request().method() !== "POST") return;
    try { const body = JSON.parse(r.request().postData()); const job = await r.json();
          jobs.push({ id: job.id, pipeline: body.pipeline, params: body.params, at: stamp() });
          say(`job ${job.id}: ${body.pipeline}`); } catch (e) { errors.push(`job capture: ${e.message}`); }
  });
  page.on("pageerror", e => errors.push(e.message));
  page.on("dialog", d => d.accept());
  const shot = name => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  const lastReply = () => page.locator("#chatLog .chat-msg.from-assistant").last();
  const replyDone = () => page.waitForFunction(() => document.getElementById("chatStopBtn").hidden, null, { timeout: 15 * MIN });

  async function send(text) {
    say(`→ ${text.slice(0, 80)}`);
    await page.fill("#chatInput", text);
    await page.click("#chatSendBtn");
    await page.waitForTimeout(1000);
    await replyDone();
  }
  // Cards of the last reply, as the page drew them.
  const cards = () => lastReply().evaluate(el => [...el.querySelectorAll(".chat-card")].map(c => ({
    id: c.dataset.card || "", head: c.querySelector(".cc-head")?.textContent.trim() || "",
    question: c.querySelector(".cc-question")?.textContent || "",
    options: [...c.querySelectorAll(".cc-options button")].map(b => b.textContent.trim()),
    buttons: [...c.querySelectorAll(".cc-actions button")].map(b => ({ text: b.textContent.trim(), disabled: b.disabled })),
    text: [...c.querySelectorAll("textarea")].map(t => t.value) })));
  const record = async () => {
    const reply = await lastReply().evaluate(el => el.innerText);
    const cs = await cards();
    turns.push({ at: stamp(), reply, cards: cs });
    say(`← ${cs.length} card(s): ${cs.map(c => c.head || "question").join(" | ")}`);
    return cs;
  };
  const cardButton = (id, re) => page.locator(`.chat-card[data-card="${id}"] .cc-actions button`).filter({ hasText: re });

  await page.goto(BASE + "index.html", { waitUntil: "load" });
  await page.waitForSelector("#chatInput");
  await send(STORY);
  let take = null;
  for (let turn = 1; turn <= MAX_TURNS && !take; turn++) {
    const cs = await record();
    await shot(`chat-${turn}`);
    take = cs.find(c => /Long take/.test(c.head));
    if (take) break;
    const sheets = cs.filter(c => /sheet/i.test(c.head) && c.buttons.some(b => /^Generate$/.test(b.text) && !b.disabled));
    const question = cs.find(c => c.options.length);
    if (sheets.length) {
      for (const c of sheets) {
        say(`generate ${c.id} (${c.head})`);
        await cardButton(c.id, /^Generate$/).click();
      }
      await page.waitForFunction(ids => ids.every(id => /Done|Error/.test(
        document.querySelector(`.chat-card[data-card="${id}"] .status`)?.textContent || "")), sheets.map(c => c.id), { timeout: 30 * MIN, polling: 3000 });
      await send("Les fiches sont prêtes. Propose le plan-séquence.");
    } else if (question) {
      // Towards a sheet of the fisherman: the option that makes one, else the first.
      const pick = question.options.find(o => /sheet|fiche|planche|casting/i.test(o) && !/without|sans|skip|non\b/i.test(o)) || question.options[0];
      say(`question "${question.question}" → ${pick}`);
      await page.locator("#chatLog .chat-question .cc-options button").filter({ hasText: pick }).last().click();
      await page.waitForTimeout(1000);
      await replyDone();
    } else await send("Oui, continue.");
  }
  if (!take) throw new Error(`no long take card after ${MAX_TURNS} turns`);
  fs.writeFileSync(path.join(OUT, "screenplay.txt"), take.text.join("\n\n"));

  say(`open the long take (${take.id})`);
  await cardButton(take.id, /Open the long take/).click();
  await page.waitForSelector("#studioRelay:not([hidden])", { timeout: 15 * MIN });
  await page.waitForTimeout(3000);
  // A screenplay outside the H3 layout opens as one card: Gemma splits it.
  if (await page.locator("#relayList .relay-seg").count() < 2) {
    say("split the screenplay with Gemma");
    await page.waitForSelector("#relayComposeBtn:not([disabled])", { timeout: 2 * MIN });
    await page.click("#relayComposeBtn");
    await page.waitForFunction(() => { const a = [...document.querySelectorAll("#relayList .relay-seg textarea")];
      return a.length > 1 && a.every(x => x.value.trim()); }, null, { timeout: 15 * MIN });
  }
  const segments = await page.$$eval("#relayList .relay-seg", els => els.map(e => ({
    text: e.querySelector("textarea").value,
    link: e.querySelector(".seg-link") && !e.querySelector(".seg-link").hidden ? e.querySelector(".seg-link").textContent.trim() : "",
    duration: e.querySelector('input[type="number"]')?.value })));
  say(`segments: ${segments.map(s => s.link || "start").join(" | ")}`);
  await shot("studio-segments");
  say("generate the chain");
  await page.waitForSelector("#relayRunBtn:not([disabled])", { timeout: 5 * MIN });
  await page.click("#relayRunBtn");
  await page.waitForFunction(() => { const s = [...document.querySelectorAll("#relayList .seg-status")].map(e => e.textContent);
    return s.length && (s.every(x => x === "Ready") || s.some(x => x === "Error")); }, null, { timeout: 180 * MIN, polling: 5000 });
  const status = await page.$$eval("#relayList .seg-status", els => els.map(e => e.textContent));
  say(`segments: ${status.join(", ")}`);
  let stitched = null;
  for (let w = 0; w < 360 && !stitched; w++) {
    const stitch = jobs.find(j => j.pipeline === "video-stitch");
    if (stitch) { const j = await (await fetch(`${BASE}api/jobs/${stitch.id}`)).json();
                  if (!["queued", "running"].includes(j.status)) stitched = j; }
    if (!stitched) await page.waitForTimeout(10000);
  }
  for (const j of jobs) {
    const r = await (await fetch(`${BASE}api/jobs/${j.id}`)).json();
    Object.assign(j, { status: r.status, outputs: r.outputs, message: r.message });
  }
  await shot("studio-done");
  const report = { story: STORY, turns, card: take, segments, status,
                   take: stitched && { id: stitched.id, status: stitched.status, outputs: stitched.outputs },
                   jobs, errors, seconds: Math.round((Date.now() - t0) / 1000) };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  say(`done: take ${stitched ? stitched.status : "not assembled"}, ${errors.length} page error(s)`);
  await browser.close();
  process.exit(stitched?.status === "done" && !errors.length ? 0 : 1);
})().catch(e => { console.error(e.stack); process.exit(2); });
