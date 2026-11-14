// What every part of the Studio page shares: the event log, the job queue and the
// job runner, the undo and drop banners, the prompt editor and the theme.

import { api, on, waitJob } from "./api.js";
import { LANG, t, translateTree, tx } from "./i18n.js";

export const $ = id => document.getElementById(id);
export const LLM = window.Prompts.LLM_NAME;

// ── Event log ─────────────────────────────────────────────────────────────────
// `level`: req, ok, warn or sys. `text` is an English template, translated now.
const LEVEL_CODES = { req: "REQ", ok: "OK", warn: "WARN", sys: "SYS" };
export function log(level, text, params) {
  const box = $("events");
  if (!box) return;
  const row = document.createElement("div");
  row.className = "event";
  const time = document.createElement("span");
  time.textContent = new Date().toLocaleTimeString(LANG, { hour: "2-digit", minute: "2-digit" });
  const code = document.createElement("span");
  code.className = level;
  code.textContent = LEVEL_CODES[level] || level.toUpperCase();
  const msg = tx(document.createElement("span"), text, params);
  row.append(time, code, msg);
  box.prepend(row);
  while (box.children.length > 80) box.lastChild.remove();
}
// The `log` the prompt compilers take.
export const promptLog = (level, text, params) => log(level, text, params);
export const warn = err => log("warn", "{message}", { message: err?.message ?? String(err) });

// ── Undo banner ───────────────────────────────────────────────────────────────
// One banner at a time: a second one makes the first action final. The timer
// stops while the button has keyboard focus.
const UNDO_MS = 5000;
let undoTimer = 0, undoFn = null;
function hideUndo() { clearTimeout(undoTimer); undoTimer = 0; undoFn = null; $("undoToastBox").hidden = true; }
export function undoToast(text, params, fn) {
  clearTimeout(undoTimer);
  undoFn = fn;
  tx($("undoToastMsg"), text, params);
  $("undoToastBox").hidden = false;
  undoTimer = setTimeout(hideUndo, UNDO_MS);
}
export function initUndo() {
  $("undoToastBtn").addEventListener("click", () => { const f = undoFn; hideUndo(); if (f) f(); });
  $("undoToast").addEventListener("focusin", () => clearTimeout(undoTimer));
  $("undoToast").addEventListener("focusout", () => { if (undoFn) { clearTimeout(undoTimer); undoTimer = setTimeout(hideUndo, UNDO_MS); } });
}

// ── Short notice (drops, gallery actions) ────────────────────────────────────
let noticeTimer = 0;
export function notice(ok, text, params) {
  log(ok ? "ok" : "warn", text, params);
  tx($("dropToastMsg"), text, params);
  $("dropToastBox").hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { $("dropToastBox").hidden = true; }, 5000);
}

// ── Theme ─────────────────────────────────────────────────────────────────────
export function initTheme() {
  const apply = theme => {
    document.documentElement.dataset.theme = theme;
    $("themeBtn").textContent = theme === "dark" ? "☀️" : "🌙";
    try { localStorage.setItem("theme", theme); } catch { /* this page only */ }
  };
  let saved = null;
  try { saved = localStorage.getItem("theme"); } catch { /* default below */ }
  apply(saved || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  $("themeBtn").addEventListener("click", () => apply(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
}

// ── Jobs ──────────────────────────────────────────────────────────────────────
// runJob() submits one job, shows it in the queue and resolves with the finished
// job. cancelAll() cancels every job this page is waiting for; the orchestrations
// waiting on them stop with "Project cancelled."
const rows = new Map();         // job id → {el, status, label, start}
const active = new Set();       // ids submitted by this page and not finished
let cancelToken = 0, burst = { n: 0, done: 0, start: 0, pct: null };
let queueErr = false;
export const runningJobs = () => active.size;
const changeHandlers = new Set();
export const onJobsChange = fn => changeHandlers.add(fn);

function refreshQueue() {
  const list = $("jobList"), q = $("jobQueue");
  tx($("jobQueueTitle"), "Job queue ({n})", { n: list.children.length });
  $("jobQueueErr").hidden = !(queueErr && !q.open);
}

function renderSessionJobs() {
  const el = $("sbJobs");
  el.hidden = !active.size;
  if (!active.size) return;
  const s = Math.floor((Date.now() - burst.start) / 1000);
  const time = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  el.textContent = t("Job {k}/{n} · {time}", { k: Math.min(burst.done + 1, burst.n), n: burst.n, time })
    + (burst.pct === null ? "" : ` · ${t("{n}%", { n: burst.pct })}`);
}

function setStatus(row, cls, text, params) {
  row.status.className = `status ${cls}`;
  tx(row.status, text, params);
}

function finished(id) {
  if (!active.delete(id)) return false;
  burst.done++;
  burst.pct = null;
  renderSessionJobs();
  for (const fn of changeHandlers) fn();
  return true;
}

function onJobEvent(job) {
  const row = rows.get(job.id);
  if (!row) return;
  if (job.status === "running") {
    const p = Math.round((job.progress || 0) * 100);
    setStatus(row, "running", "Running {n}%", { n: p });
    row.sub.textContent = job.message || row.subText;
    burst.pct = p;
    $("stepInference")?.classList.add("active");
    renderSessionJobs();
  } else if (job.status === "done") {
    if (!finished(job.id)) return;
    setStatus(row, "done", "Done");
    const secs = ((Date.now() - row.start) / 1000).toFixed(1);
    if ($("latency")) $("latency").textContent = `${secs} s`;
    log("ok", "{label} finished in {secs} s.", { label: t(...row.label), secs });
    row.sub.textContent = row.subText;
    $("stepInference")?.classList.remove("active");
  } else if (job.status === "error" || job.status === "cancelled") {
    if (!finished(job.id)) return;
    setStatus(row, job.status === "error" ? "error" : "fallback", job.status === "error" ? "Error" : "Cancelled");
    if (job.status === "error") {
      if (!$("jobQueue").open) queueErr = true;
      log("warn", "{label}: {error}", { label: t(...row.label), error: job.error || "" });
    }
    refreshQueue();
    $("stepInference")?.classList.remove("active");
  }
}

export function initJobs() {
  const q = $("jobQueue");
  try { if (localStorage.getItem("jobQueueOpen") === "0") q.open = false; } catch { /* open */ }
  q.addEventListener("toggle", () => {
    if (q.open) queueErr = false;
    refreshQueue();
    try { localStorage.setItem("jobQueueOpen", q.open ? "1" : "0"); } catch { /* this page only */ }
  });
  refreshQueue();
  on("job", onJobEvent);
  setInterval(renderSessionJobs, 1000);
  showInterrupted();
}

// Jobs a server restart cut (read back by the server from its job history): listed once
// with a "Launch again" button. Nothing runs again without that click.
async function showInterrupted() {
  let jobs = [];
  try { jobs = await api.jobs(); } catch { return; }
  for (const job of jobs.filter(j => j.interrupted && !j.retried_as).slice(-8).reverse()) {
    const el = document.createElement("div");
    el.className = "job";
    el.innerHTML = `<div><strong data-raw></strong><span class="sub"></span></div><button type="button" class="secondary-btn"></button>`;
    el.querySelector("strong").textContent = job.pipeline;
    tx(el.querySelector(".sub"), "Cut by a server restart");
    const btn = tx(el.querySelector("button"), "Launch again");
    btn.addEventListener("click", () => {
      el.remove();
      refreshQueue();
      runJob(job.pipeline, job.request, { origin: job.origin, label: ["Launched again: {pipeline}", { pipeline: job.pipeline }],
                                          submit: () => api.retry(job.id) }).catch(warn);
    });
    $("jobList").append(el);
  }
  refreshQueue();
}

// A job submitted while a tag is set (`withJobTag`, read when runJob is called) is
// reported with that tag to the `onJobSubmitted` handlers: the assistant follows the
// jobs of its cards this way.
let jobTag = null;
const submitHandlers = new Set();
export const onJobSubmitted = fn => submitHandlers.add(fn);
export const currentJobTag = () => jobTag;
export function withJobTag(tag, fn) {
  const before = jobTag;
  jobTag = tag;
  try { return fn(); } finally { jobTag = before; }
}

// `label` and `sub` are [English template, params] pairs, shown translated.
// `submit` replaces the plain submission (a job launched again by its id);
// `onSubmitted(job)` is called once the server has the job (its id).
export async function runJob(pipeline, params, { origin, label, sub = ["", {}], submit, onSubmitted } = {}) {
  const token = cancelToken, tag = jobTag;
  const job = await (submit ? submit() : api.submit(pipeline, params, origin));
  for (const fn of submitHandlers) fn(job, tag);
  onSubmitted?.(job);
  const el = document.createElement("div");
  el.className = "job fade-in";
  el.innerHTML = `<div><strong></strong><span class="sub"></span></div><span class="status running"></span>`;
  const row = { el, status: el.querySelector(".status"), sub: el.querySelector(".sub"), label, start: Date.now() };
  tx(el.querySelector("strong"), ...label);
  row.subText = t(...sub);
  tx(row.sub, ...sub);
  rows.set(job.id, row);
  setStatus(row, "running", "Waiting");
  const list = $("jobList");
  list.prepend(el);
  while (list.children.length > 8) list.lastChild.remove();
  refreshQueue();
  if (!active.size) burst = { n: 0, done: 0, start: Date.now(), pct: null };
  burst.n++;
  active.add(job.id);
  renderSessionJobs();
  for (const fn of changeHandlers) fn();
  log("req", "Job submitted: {label}.", { label: t(...label) });
  onJobEvent(job);
  try {
    const done = await waitJob(job);
    if (token !== cancelToken) throw new Error(t("Project cancelled."));
    return done;
  } catch (err) {
    if (token !== cancelToken) throw new Error(t("Project cancelled."));
    throw err;
  }
}

export async function cancelAll() {
  cancelToken++;
  const ids = [...active];
  await Promise.all(ids.map(id => api.cancel(id).catch(warn)));
  return ids.length;
}
// Throws when cancelAll() ran after `token` was read (cancellableToken()).
export const cancellableToken = () => cancelToken;
export function checkCancelled(token) { if (token !== cancelToken) throw new Error(t("Project cancelled.")); }

// ── Prompt editor ─────────────────────────────────────────────────────────────
// One dialog for sheets, shot images, cuts and shot actions. `cfg.enrich(text)`
// returns the text enriched again; `cfg.apply(text)` uses it. The applied text is
// sent verbatim: the studio never compiles over it.
let editor = null;
export function openPromptEditor(cfg) {
  editor = cfg;
  tx($("promptModalTitle"), cfg.title);
  tx($("promptModalHint"), cfg.hint || "");
  $("promptModalText").value = cfg.text || "";
  tx($("promptModalApply"), cfg.applyLabel || "Apply and regenerate");
  $("promptModalEnrich").disabled = false;
  $("promptModal").hidden = false;
  $("promptModalText").focus();
}
function closePromptEditor() { $("promptModal").hidden = true; editor = null; }
export function initPromptEditor() {
  $("promptModalCancel").addEventListener("click", closePromptEditor);
  $("promptModalReset").addEventListener("click", () => { if (editor) $("promptModalText").value = editor.text || ""; });
  $("promptModalEnrich").addEventListener("click", async () => {
    if (!editor) return;
    const btn = $("promptModalEnrich"), area = $("promptModalText");
    btn.disabled = true;
    tx(btn, "Enriching…");
    log("req", "Enriching the prompt with {llm}…", { llm: LLM });
    try { area.value = await editor.enrich(area.value.trim()); }
    catch (err) { log("warn", "Enrichment unavailable: {error}", { error: err.message }); }
    finally { tx(btn, "✨ Enrich again"); btn.disabled = false; }
  });
  $("promptModalApply").addEventListener("click", () => {
    if (!editor) return;
    const text = $("promptModalText").value.trim(), apply = editor.apply;
    closePromptEditor();
    if (text) apply(text);
  });
  $("promptModal").addEventListener("click", e => { if (e.target === $("promptModal")) closePromptEditor(); });
  // Escape closes the editor before the lightbox behind it.
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !$("promptModal").hidden) { e.stopPropagation(); closePromptEditor(); }
  }, true);
}

// Fills a <select> with [value, English label] pairs, translated by translateTree.
export function fillSelect(sel, options, value) {
  sel.replaceChildren(...options.map(([v, label]) => new Option(label, v)));
  translateTree(sel);
  if (value !== undefined && options.some(([v]) => v === value)) sel.value = value;
}

export const clampInt = (v, lo, hi, dflt) => Math.min(hi, Math.max(lo, Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : dflt));
export const MOBILE = matchMedia("(max-width: 767px)");
