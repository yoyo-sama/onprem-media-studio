// Gallery of the output folder, read from the server's index (/api/gallery, see
// docs/GALLERY.md): tabs, filters, date groups, selection, favourites, tags, trash,
// renaming, and the lightbox with the details of an asset. "Inputs" shows instead the
// images and clips sent to renders (inputs/), read-only: no filter, tag or trash.
//
// The gallery submits one job only, on its own click: "Upscale ×2" in the lightbox.
// "Reuse the prompt" writes the brief only on that click, with Undo; "Use as input"
// and dragging a thumbnail only set an input.

import { api, on } from "./api.js";
import { L, LANG, t, translateTree, tx, txAttr } from "./i18n.js";
import { $, log, notice, runJob, undoToast, warn } from "./ui.js";

export const ENGINE_LABELS = {
  "krea2-t2i": "Krea 2", "qwen-edit-2509": "Qwen Edit 2509", "qwen-image-2.1": "Qwen Image 2.1", "moss-image": "MOSS-Image",
  "h3-t2v": L("MiniMax H3 · text to video"), "h3-i2v": L("MiniMax H3 · image to video"),
  "h3-r2v": L("MiniMax H3 · references"), "video-concat": L("Montage"), "image-grid": L("Contact sheet"),
  "video-frames": L("Clip frames"), "upscale-2x": L("Upscale ×2"),
};
export const ORIGIN_LABELS = {
  studio: "Studio", campaign: L("Campaign"), markets: L("Local versions"), sequence: L("Multi-image sequence"),
  storyboard: L("Storyboard"), relay: L("Long take (Relay)"), reference2video: L("Reference to video"), canvas: "Canvas",
  assistant: L("Assistant"),
};

const PAGE = 60;
const filter = { type: "image", q: "", pipeline: "", origin: "", tag: "", fav: false, from: null, to: null, scope: "app" };
let unit = "day", gotoEnd = null, periods = [], counts = { image: 0, video: 0 }, trashCount = 0;
let next = null, gen = 0, loading = false, booted = false;
let facets = { pipelines: [], origins: [], tags: [] };
let selecting = false, selTagOpen = false;
const selection = new Map();      // key → asset
const cards = new Map();          // key → card element
const closedGroups = new Set();
let hooks = {};

const saveLocal = (k, v) => { try { localStorage.setItem(k, v); } catch { /* this page only */ } };
const loadLocal = k => { try { return localStorage.getItem(k); } catch { return null; } };

export function assetTitle(a) {
  if (a.origin && a.origin !== "studio" && ORIGIN_LABELS[a.origin]) return t(ORIGIN_LABELS[a.origin]);
  return ENGINE_LABELS[a.pipeline] ? t(ENGINE_LABELS[a.pipeline]) : a.pipeline || t(a.type === "video" ? "Video" : "Image");
}
const excerpt = (text, max = 90) => {
  const c = Array.from(String(text || "").replace(/\s+/g, " ").trim());
  return c.length > max ? c.slice(0, max).join("").trimEnd() + "…" : c.join("");
};

// ── Listing ───────────────────────────────────────────────────────────────────
const query = (extra = {}) => ({ ...filter, from: filter.from ?? undefined, to: filter.to ?? undefined, limit: PAGE, ...extra });

const inInputs = () => filter.scope === "inputs";
const listing = extra => (inInputs() ? api.gallery.inputs({ type: filter.type, limit: PAGE, ...extra }) : api.gallery.assets(query(extra)));

async function list(cursor) {
  try { return await listing({ cursor }); }
  catch (err) { warn(err); return { items: [], next: null, counts }; }
}

export async function reload() {
  if (!booted) return;
  const g = ++gen;
  clearSelection();
  const r = await list(null);
  if (g !== gen) return;
  counts = r.counts;
  renderTabs();
  $("galleryGrid").replaceChildren();
  for (const a of r.items) place(a, false);
  next = r.next;
  pruneGroups();
  renderEmpty();
  watch();
  refreshDates();
}

async function more() {
  if (!next || loading) return;
  const g = gen, cursor = next;
  loading = true;
  const r = await list(cursor);
  loading = false;
  if (g !== gen || next !== cursor) return;
  for (const a of r.items) place(a, false);
  next = r.next;
  watch();
}
const observer = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) more(); }, { rootMargin: "600px" });
function watch() { observer.unobserve($("gallerySentinel")); observer.observe($("gallerySentinel")); }

async function refreshCounts() {
  try { counts = (await listing({ limit: 1 })).counts; renderTabs(); } catch { /* next reload */ }
}
async function refreshTrash() {
  try {
    const c = (await api.gallery.assets({ scope: "trash", limit: 1 })).counts;
    trashCount = c.image + c.video;
    renderTrashBtn();
  } catch { /* next time */ }
}
async function refreshFacets() {
  if (inInputs()) return;
  try { facets = await api.gallery.facets(filter.scope); renderFacets(); } catch { /* keep the old lists */ }
}

function renderTabs() {
  tx($("tabImages"), "Images ({n})", { n: counts.image });
  tx($("tabVideos"), "Videos ({n})", { n: counts.video });
  $("tabImages").classList.toggle("active", filter.type === "image");
  $("tabVideos").classList.toggle("active", filter.type === "video");
}

function renderEmpty() {
  const empty = $("galleryEmpty"), has = !!$("galleryGrid").querySelector(".asset");
  empty.hidden = has;
  if (has) return;
  const f = filter;
  tx(empty, f.q || f.pipeline || f.origin || f.fav || f.tag || f.from != null || f.to != null ? "No result for these filters."
    : f.scope === "trash" ? "The trash is empty."
    : f.scope === "inputs" ? (f.type === "video" ? "No clip used as an input yet." : "No image used as an input yet.")
    : f.type === "video" ? "No video yet." : "No image yet. Start a render.");
}

// ── Date groups ───────────────────────────────────────────────────────────────
function periodStart(ts, u) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  if (u === "week") d.setDate(d.getDate() - (d.getDay() + 6) % 7);
  else if (u === "month") d.setDate(1);
  return d.getTime();
}
// Noon of the period's first day: a daylight saving change never shows the day before.
function periodLabel(start, u = unit) {
  const d = new Date(+start + 43200000), f = o => new Intl.DateTimeFormat(LANG, o).format(d);
  if (u === "month") return f({ month: "long", year: "numeric" });
  const day = f(u === "day" ? { weekday: "long", day: "numeric", month: "long", year: "numeric" } : { day: "numeric", month: "long", year: "numeric" });
  return u === "week" ? t("Week of {date}", { date: day }) : day;
}
function group(ts, head) {
  const grid = $("galleryGrid"), start = periodStart(ts, unit), id = `${unit}:${start}`;
  let grp = [...grid.children].find(el => el.dataset.period === String(start));
  if (!grp) {
    grp = document.createElement("details");
    grp.className = "gallery-group date-group fade-in";
    grp.dataset.period = start;
    grp.open = !closedGroups.has(id);
    grp.innerHTML = `<summary class="folder-head"><span data-raw></span></summary><div class="gallery"></div>`;
    grp.querySelector("span").textContent = periodLabel(start);
    grp.addEventListener("toggle", () => { if (grp.open) closedGroups.delete(id); else closedGroups.add(id); });
    grid.insertBefore(grp, head ? grid.firstChild : null);
  }
  return grp.querySelector(".gallery");
}
function place(a, head) {
  const card = cardFor(a), g = group(a.ts, head);
  if (head) g.insertBefore(card, g.firstChild); else g.appendChild(card);
}
function pruneGroups() {
  for (const grp of $("galleryGrid").querySelectorAll(".gallery-group")) if (!grp.querySelector(".asset")) grp.remove();
}

// ── Cards ─────────────────────────────────────────────────────────────────────
function retitle(card) {
  const a = card._asset, meta = card.querySelector(".meta");
  meta.querySelector("strong").textContent = assetTitle(a);
  meta.querySelector(".asset-prompt").textContent = excerpt(a.prompt);
  const pill = (text, cls = "") => Object.assign(document.createElement("i"), { className: "tag-pill " + cls, textContent: text });
  const tags = a.tags || [], tg = meta.querySelector(".asset-tags");
  tg.replaceChildren(...tags.slice(0, 2).map(n => pill(n)), ...(tags.length > 2 ? [pill(`+${tags.length - 2}`, "more")] : []));
  tg.title = tags.join(", ");
  meta.querySelector(".asset-trashed").textContent = a.trash
    ? t("Deleted on {date}", { date: new Intl.DateTimeFormat(LANG, { dateStyle: "medium" }).format(a.trash.at) }) : "";
  meta.title = a.trash ? a.trash.origKey : a.key;
}

function mark(card) {
  const a = card._asset, sel = selection.has(a.key), star = card.querySelector(".fav-btn");
  card.classList.toggle("fav", !!a.fav);
  if (star) { star.classList.toggle("active", !!a.fav); star.setAttribute("aria-pressed", String(!!a.fav)); }
  card.classList.toggle("selected", sel);
  if (selecting) { card.tabIndex = 0; card.setAttribute("role", "checkbox"); card.setAttribute("aria-checked", String(sel)); }
  else { card.removeAttribute("tabindex"); card.removeAttribute("role"); card.removeAttribute("aria-checked"); }
}

function button(text, title, fn, cls) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  if (cls) b.className = cls;
  if (title) b.title = title;
  b.addEventListener("click", fn);
  return b;
}

function cardFor(a) {
  let card = cards.get(a.key);
  if (card) { card._asset = a; retitle(card); mark(card); return card; }
  const video = a.type === "video", trashed = !!a.trash;
  card = document.createElement("div");
  card.className = "asset fade-in";
  card._asset = a;
  card.dataset.key = a.key;
  const img = document.createElement("img");
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  img.src = a.thumb;
  card.appendChild(img);
  if (video) card.insertAdjacentHTML("beforeend", `<span class="vbadge" aria-hidden="true">▶</span>`);
  if (!trashed) {
    img.addEventListener("click", () => openLightbox(card._asset));
    img.draggable = true;
    img.addEventListener("dragstart", e => {
      const x = card._asset;
      e.dataTransfer.setData("application/json", JSON.stringify({ ref: x.ref, url: x.url, filename: x.filename, type: x.type }));
      e.dataTransfer.setData("text/plain", x.filename);
      e.dataTransfer.effectAllowed = "copy";
    });
  } else img.style.cursor = "default";
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.innerHTML = `<strong data-raw></strong><span class="asset-prompt" data-raw></span><div class="asset-tags" data-raw></div><div class="asset-trashed" data-raw></div>`;
  card.appendChild(meta);
  retitle(card);
  const actions = document.createElement("div");
  actions.className = "asset-actions";
  if (trashed) actions.append(button("Restore", null, () => restore([card._asset])));
  else {
    actions.append(button(video ? "▶ Play" : "⤢ Enlarge", null, () => openLightbox(card._asset)));
    actions.append(button("→ Use as input", null, () => hooks.useAsInput?.(card._asset)));
    if (!video) actions.append(button("➕ Sequence", "Add to the multi-image sequence", () => hooks.addToSequence?.(card._asset)));
    if (!a.input) {
      actions.append(button("★", "Favourite", () => setFavs([card._asset], !card._asset.fav), "fav-btn"));
      actions.append(button("🗑", "Delete from the gallery", () => remove([card._asset])));
    }
  }
  card.appendChild(actions);
  card.addEventListener("click", e => {
    if (!selecting) return;
    e.preventDefault(); e.stopPropagation();
    toggleSel(card);
  }, true);
  card.addEventListener("keydown", e => {
    if (selecting && e.target === card && (e.key === " " || e.key === "Enter")) { e.preventDefault(); toggleSel(card); }
  });
  translateTree(card);
  cards.set(a.key, card);
  mark(card);
  return card;
}

// A finished job's files: put at the top when they pass the current filters.
async function onJobDone(job) {
  const keys = job.outputs.filter(r => r.startsWith("outputs/")).map(r => r.slice(8));
  if (!keys.length || !booted) return;
  const details = (await Promise.all(keys.map(k => api.gallery.asset(k).catch(() => null)))).filter(Boolean);
  refreshCounts();
  refreshFacets();
  const f = filter;
  if (f.q || f.pipeline || f.origin || f.fav || f.tag || f.from != null || f.to != null || f.scope === "trash" || f.scope === "inputs") return;
  for (const a of details) if (a.type === f.type && (a.app || f.scope === "all")) place(a, true);
  renderEmpty();
}

// ── Actions ───────────────────────────────────────────────────────────────────
async function setFavs(items, fav) {
  try { await api.gallery.fav(items.map(a => a.key), fav); }
  catch (err) { warn(err); return notice(false, "Gallery action failed."); }
  for (const a of items) { a.fav = fav; const c = cards.get(a.key); if (c) mark(c); }
  if (filter.fav) reload(); else refreshCounts();
}

// Deleting moves to the trash; one Undo banner puts every card back.
async function remove(items) {
  let r;
  try { r = await api.gallery.trash(items.map(a => a.key)); }
  catch (err) { warn(err); return notice(false, "Gallery action failed."); }
  hooks.removed?.(items);
  for (const a of items) {
    log("sys", "“{file}” moved to the trash.", { file: a.key });
    cards.get(a.key)?.remove();
    cards.delete(a.key);
  }
  pruneGroups();
  renderEmpty();
  refreshCounts();
  refreshTrash();
  const trashKeys = r.trashed.map(x => x.trashKey);
  undoToast("Deleted from the gallery", {}, async () => {
    try { await api.gallery.restore(trashKeys); }
    catch (err) { warn(err); notice(false, "Gallery action failed."); }
    reload();
    refreshTrash();
  });
}

async function restore(items) {
  items = items.filter(a => a.trash);
  if (!items.length) return;
  let r;
  try { r = await api.gallery.restore(items.map(a => a.key)); }
  catch (err) { warn(err); return notice(false, "Gallery action failed."); }
  const renamed = r.restored.filter(x => items.find(a => a.key === x.trashKey)?.trash.origKey !== x.key).length;
  for (const a of items) cards.delete(a.key);
  reload();
  refreshTrash();
  refreshFacets();
  notice(true, renamed ? "{n} item(s) restored, {renamed} under a new name (the name was taken)." : "{n} item(s) restored.",
    { n: r.restored.length, renamed });
}

async function tagItems(items, add, remove_) {
  const r = await api.gallery.tag(items.map(a => a.key), add, remove_);
  for (const a of items) {
    const got = r.assets.find(x => x.key === a.key);
    if (got) a.tags = got.tags;
    const c = cards.get(a.key);
    if (c) { c._asset.tags = a.tags; retitle(c); }
  }
  refreshFacets();
  if (filter.tag) reload();
}

// ── Selection ─────────────────────────────────────────────────────────────────
function renderSelBar() {
  const trash = filter.scope === "trash";
  $("gallerySelBar").hidden = !selecting;
  tx($("gallerySelCount"), "{n} selected", { n: selection.size });
  $("gallerySelFav").hidden = $("gallerySelDel").hidden = $("gallerySelTag").hidden = trash;
  $("gallerySelRestore").hidden = !trash;
  $("gallerySelTagForm").hidden = trash || !selTagOpen;
  $("gallerySelTag").setAttribute("aria-expanded", String(!trash && selTagOpen));
  for (const id of ["gallerySelFav", "gallerySelDel", "gallerySelRestore", "gallerySelTag"]) $(id).disabled = !selection.size;
  $("gallerySelectBtn").classList.toggle("active", selecting);
  $("gallerySelectBtn").setAttribute("aria-pressed", String(selecting));
  $("galleryBlock").classList.toggle("selecting", selecting);
}
function toggleSel(card) {
  const a = card._asset;
  if (selection.has(a.key)) selection.delete(a.key); else selection.set(a.key, a);
  mark(card);
  renderSelBar();
}
function clearSelection() {
  const was = [...selection.keys()];
  selection.clear();
  for (const k of was) { const c = cards.get(k); if (c) mark(c); }
  renderSelBar();
}
function setSelecting(on) {
  selecting = on;
  selection.clear();
  for (const c of cards.values()) mark(c);
  renderSelBar();
}

// ── Filters ───────────────────────────────────────────────────────────────────
export function setFilter(patch) {
  Object.assign(filter, patch);
  syncControls();
  reload();
}

function syncControls() {
  $("galleryFavBtn").classList.toggle("active", filter.fav);
  $("galleryFavBtn").setAttribute("aria-pressed", String(filter.fav));
  $("galleryScopeBtn").classList.toggle("active", filter.scope === "all");
  $("galleryScopeBtn").setAttribute("aria-pressed", String(filter.scope === "all"));
  $("galleryDateUnit").value = unit;
  renderFacets();
  renderTrashBtn();
  renderInputsBtn();
  renderSelBar();
  renderDates();
}

// Inputs: only the tabs, the size, the grouping and the way back stay.
const OUTPUT_ONLY = ["gallerySearch", "galleryPipeline", "galleryFavBtn", "gallerySelectBtn", "galleryScopeBtn",
  "galleryTrashBtn", "galleryOrigin", "galleryTag", "galleryGoto"];
function renderInputsBtn() {
  const on_ = inInputs();
  $("galleryInputsBtn").classList.toggle("active", on_);
  $("galleryInputsBtn").setAttribute("aria-pressed", String(on_));
  for (const id of OUTPUT_ONLY) $(id).hidden = on_;
  for (const id of ["galleryFrom", "galleryTo"]) $(id).closest("label").hidden = on_;
}

function renderTrashBtn() {
  const on_ = filter.scope === "trash";
  tx($("galleryTrashBtn"), "Trash ({n})", { n: trashCount });
  $("galleryTrashBtn").classList.toggle("active", on_);
  $("galleryTrashBtn").setAttribute("aria-pressed", String(on_));
  $("galleryTrashHelp").hidden = !on_;
  $("galleryBlock").classList.toggle("trash", on_);
  $("galleryScopeBtn").disabled = on_;
}

// Facet menus: server data (engine and feature ids get a label, tag names stay raw).
function renderFacets() {
  const fill = (sel, all, entries, cur) => {
    const ids = [...new Set([...entries.map(e => e[0]), cur].filter(Boolean))];
    sel.replaceChildren(tx(new Option("", ""), all), ...ids.map(id => {
      const label = entries.find(e => e[0] === id)?.[1];
      const o = new Option(label ? t(label) : id, id);
      if (label) tx(o, label); else o.setAttribute("data-raw", "");
      return o;
    }));
    sel.value = cur;
  };
  fill($("galleryPipeline"), "All engines",
    facets.pipelines.filter(p => p.id).map(p => [p.id, ENGINE_LABELS[p.id]]), filter.pipeline);
  fill($("galleryOrigin"), "All features",
    facets.origins.filter(o => o.id).map(o => [o.id, ORIGIN_LABELS[o.id]]), filter.origin);
  fill($("galleryTag"), "All tags", facets.tags.map(x => [x.name, null]), filter.tag);
  $("galleryTagList").replaceChildren(...facets.tags.map(x => Object.assign(document.createElement("option"), { value: x.name })));
}

function renderDates() {
  for (const el of $("galleryGrid").querySelectorAll(".date-group")) el.querySelector("summary span").textContent = periodLabel(el.dataset.period);
  const sel = $("galleryGoto");
  sel.replaceChildren(tx(new Option("", ""), "Go to…"),
    ...periods.map(p => { const o = new Option(`${periodLabel(p.start)} (${p.count})`, String(p.end)); o.setAttribute("data-raw", ""); return o; }));
  sel.value = gotoEnd != null ? String(gotoEnd) : "";
}
async function refreshDates() {
  if (inInputs()) { periods = []; renderDates(); return; }
  try {
    const r = await api.gallery.dates({ ...query(), from: undefined, to: undefined, limit: undefined, unit, tz: new Date().getTimezoneOffset() });
    periods = r.periods;
    renderDates();
  } catch { /* the menu stays as it was */ }
}

// ── Lightbox ──────────────────────────────────────────────────────────────────
let lbAsset = null, lbSeq = 0, lbFull = false, lbOpener = null;

// `asset` = a gallery asset (with the details panel), or {url, type} for a plain view.
export function openLightbox(asset) {
  const video = asset.type === "video";
  const el = document.createElement(video ? "video" : "img");
  el.src = asset.url;
  if (video) Object.assign(el, { controls: true, autoplay: true, loop: true, playsInline: true }); else el.alt = "";
  $("lightboxContent").replaceChildren(el);
  lbAsset = asset.key && !asset.input ? asset : null;
  lbOpener = document.activeElement;
  const seq = ++lbSeq;
  $("lightbox").classList.toggle("has-meta", !!lbAsset);
  $("lightboxMeta").hidden = !lbAsset;
  $("lbRenameForm").hidden = true;
  lbSay(null);
  if (lbAsset) {
    lbFull = false;
    renderMeta();
    api.gallery.asset(asset.key).then(d => {
      if (seq !== lbSeq) return;
      Object.assign(asset, d);
      lbFull = true;
      renderMeta();
    }).catch(err => { if (seq === lbSeq) { warn(err); renderMeta(); } });
  }
  $("lightbox").hidden = false;
  $("lightboxClose").focus();
}
function closeLightbox() {
  if ($("lightbox").hidden) return;
  $("lightbox").hidden = true;
  $("lightboxContent").replaceChildren();
  lbAsset = null;
  lbSeq++;
  if (lbOpener?.isConnected) lbOpener.focus();
  lbOpener = null;
}
function lbSay(text, params) { if (text) tx($("lbMsg"), text, params); else $("lbMsg").textContent = ""; }

function renderMeta() {
  const a = lbAsset;
  if (!a) return;
  const dash = "—", set = (id, v) => { $(id).textContent = v ?? dash; }, video = a.type === "video";
  const prompt = a.prompt || "", full = lbFull || prompt.length < 400;
  $("lbPrompt").textContent = prompt || dash;
  $("lightboxCopy").hidden = !prompt;
  $("lightboxCopy").disabled = !full;
  set("lbSeed", a.seed);
  set("lbPipeline", a.pipeline ? (ENGINE_LABELS[a.pipeline] ? t(ENGINE_LABELS[a.pipeline]) : a.pipeline) : null);
  set("lbLoras", a.loras?.length ? a.loras.join(", ") : null);
  set("lbDims", a.w && a.h ? `${a.w} × ${a.h} px` : null);
  $("lbDurT").hidden = $("lbDur").hidden = !video;
  set("lbDur", video && a.duration != null ? `${+a.duration.toFixed(2)} s` : null);
  set("lbWeight", a.size != null ? t("{n} MB", { n: new Intl.NumberFormat(LANG, { maximumFractionDigits: a.size < 1048576 ? 3 : 1 }).format(a.size / 1048576) }) : null);
  set("lbDate", a.ts ? new Intl.DateTimeFormat(LANG, { dateStyle: "long", timeStyle: "medium" }).format(a.ts) : null);
  set("lbPath", a.key);
  $("lbReuse").disabled = !prompt || !full;
  $("lbTags").replaceChildren(...(a.tags || []).map(name => {
    const chip = document.createElement("span"), nameBtn = document.createElement("button"), x = document.createElement("button");
    chip.className = "tag-chip";
    nameBtn.type = x.type = "button";
    nameBtn.textContent = name;
    txAttr(nameBtn, "title", "Filter the gallery on this tag");
    nameBtn.addEventListener("click", () => { closeLightbox(); setFilter({ tag: name }); });
    x.className = "tag-x";
    x.textContent = "✕";
    txAttr(x, "title", "Remove the tag “{tag}”", { tag: name });
    txAttr(x, "aria-label", "Remove the tag “{tag}”", { tag: name });
    x.addEventListener("click", () => lbTag([], [name]));
    chip.append(nameBtn, x);
    return chip;
  }));
}

async function lbTag(add, remove_) {
  const a = lbAsset;
  if (!a) return;
  try { await tagItems([a], add, remove_); }
  catch (err) { warn(err); return lbSay("Gallery action failed."); }
  lbSay(null);
  renderMeta();
}

// One click, one job: the upscaled copy reaches the gallery when the job is done.
async function upscale(a) {
  tx($("lbMsg"), "Upscale ×2 started: the copy will appear in the gallery.");
  try {
    await runJob("upscale-2x", { source: a.ref }, { origin: "studio", label: ["Upscale ×2"], sub: ["{file}", { file: a.filename }] });
  } catch (err) {
    warn(err);
    if (lbAsset === a) tx($("lbMsg"), "Upscale ×2 failed: {error}", { error: err.message });
  }
}

function initLightbox() {
  const lb = $("lightbox");
  $("lightboxClose").addEventListener("click", closeLightbox);
  lb.addEventListener("click", e => { if (e.target === lb || e.target === $("lightboxBody")) closeLightbox(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeLightbox(); });
  // Focus stays in the dialog: Tab and Shift+Tab cycle over its visible controls.
  lb.addEventListener("keydown", e => {
    if (e.key !== "Tab") return;
    const f = [...lb.querySelectorAll("button, input, video[controls], [tabindex='0']")].filter(x => !x.disabled && x.getClientRects().length);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  $("lightboxCopy").addEventListener("click", async () => {
    const p = lbAsset?.prompt;
    if (!p) return;
    try {
      await navigator.clipboard.writeText(p);
      tx($("lightboxCopy"), "✓ Prompt copied");
      setTimeout(() => tx($("lightboxCopy"), "📋 Copy the prompt"), 1600);
    } catch { log("warn", "The browser refused the copy (clipboard)."); }
  });
  $("lbTagForm").addEventListener("submit", e => {
    e.preventDefault();
    const n = $("lbTagInput").value.trim();
    $("lbTagInput").value = "";
    if (n) lbTag([n], []);
  });
  $("lbUse").addEventListener("click", () => {
    const a = lbAsset;
    if (!a) return;
    closeLightbox();
    hooks.useAsInput?.(a);
  });
  $("lbUpscale").addEventListener("click", () => { if (lbAsset) upscale(lbAsset); });
  $("lbReuse").addEventListener("click", () => {
    const a = lbAsset;
    if (!a?.prompt) return;
    closeLightbox();
    hooks.reusePrompt?.(a);
  });
  $("lbRenameBtn").addEventListener("click", () => {
    const a = lbAsset;
    if (!a) return;
    $("lbRenameForm").hidden = false;
    $("lbRenameExt").textContent = /\.[^.]+$/.exec(a.filename)?.[0] ?? "";
    $("lbRenameInput").value = a.filename.replace(/\.[^.]+$/, "");
    lbSay(null);
    $("lbRenameInput").focus();
    $("lbRenameInput").select();
  });
  const closeRename = () => { $("lbRenameForm").hidden = true; lbSay(null); $("lbRenameBtn").focus(); };
  $("lbRenameCancel").addEventListener("click", closeRename);
  $("lbRenameInput").addEventListener("keydown", e => { if (e.key === "Escape") { e.stopPropagation(); closeRename(); } });
  $("lbRenameForm").addEventListener("submit", async e => {
    e.preventDefault();
    const a = lbAsset, ext = $("lbRenameExt").textContent;
    if (!a) return;
    let stem = $("lbRenameInput").value.trim();
    if (ext && stem.toLowerCase().endsWith(ext.toLowerCase())) stem = stem.slice(0, -ext.length);
    const name = stem + ext;
    if (!stem || name === a.filename) return closeRename();
    let r;
    try { r = await api.gallery.rename(a.key, name); }
    catch (err) { warn(err); return lbSay(err.status === 409 || err.status === 400 ? "{error}" : "Gallery action failed.", { error: err.message }); }
    const card = cards.get(a.key), oldKey = a.key;
    cards.delete(oldKey);
    Object.assign(a, r.asset);
    if (card?.isConnected) card.replaceWith(cardFor(a));
    log("ok", "“{old}” renamed to “{new}”.", { old: oldKey, new: a.key });
    closeRename();
    renderMeta();
    refreshFacets();
  });
}

// ── Health ────────────────────────────────────────────────────────────────────
async function health(n = 0) {
  let h = null;
  try { h = await api.gallery.health(); } catch { /* shown below */ }
  const note = $("galleryNote");
  note.hidden = !(h?.warning || !h || (h.scanning && !h.indexed));
  if (!h) tx(note, "Gallery unavailable: the server does not answer.");
  else if (h.warning) tx(note, "Gallery: {warning}", { warning: h.warning });
  else if (h.scanning && !h.indexed) tx(note, "Indexing in progress…");
  // The first scan of a large folder: list again when it is done.
  if (h?.scanning && n < 12) setTimeout(() => health(n + 1).then(() => n === 11 || reload()), 5000);
}

// ── Setup ─────────────────────────────────────────────────────────────────────
export function initGallery(h) {
  hooks = h;
  unit = ["day", "week", "month"].includes(loadLocal("galleryDateUnit")) ? loadLocal("galleryDateUnit") : "day";
  if (loadLocal("galleryScope") === "all") filter.scope = "all";
  const thumb = loadLocal("galleryThumb");
  if (thumb) $("galleryThumb").value = thumb;
  const applyThumb = () => $("galleryBlock").style.setProperty("--thumb", `${$("galleryThumb").value}px`);
  applyThumb();
  $("galleryThumb").addEventListener("input", applyThumb);
  $("galleryThumb").addEventListener("change", () => saveLocal("galleryThumb", $("galleryThumb").value));

  $("tabImages").addEventListener("click", () => setFilter({ type: "image" }));
  $("tabVideos").addEventListener("click", () => setFilter({ type: "video" }));
  let searchTimer = 0;
  $("gallerySearch").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => setFilter({ q: $("gallerySearch").value.trim() }), 200);
  });
  $("galleryPipeline").addEventListener("change", () => setFilter({ pipeline: $("galleryPipeline").value }));
  $("galleryOrigin").addEventListener("change", () => setFilter({ origin: $("galleryOrigin").value }));
  $("galleryTag").addEventListener("change", () => setFilter({ tag: $("galleryTag").value }));
  $("galleryFavBtn").addEventListener("click", () => setFilter({ fav: !filter.fav }));
  $("galleryScopeBtn").addEventListener("click", () => {
    const scope = filter.scope === "all" ? "app" : "all";
    saveLocal("galleryScope", scope);
    setFilter({ scope });
    refreshFacets();
  });
  $("galleryInputsBtn").addEventListener("click", () => {
    if (selecting) setSelecting(false);
    gotoEnd = null;
    $("gallerySearch").value = $("galleryFrom").value = $("galleryTo").value = "";
    setFilter(inInputs() ? { scope: loadLocal("galleryScope") === "all" ? "all" : "app" }
      : { scope: "inputs", q: "", pipeline: "", origin: "", tag: "", fav: false, from: null, to: null });
    refreshFacets();
  });
  $("galleryTrashBtn").addEventListener("click", () => {
    setFilter({ scope: filter.scope === "trash" ? (loadLocal("galleryScope") === "all" ? "all" : "app") : "trash" });
    refreshFacets();
  });
  // Local midnight; "To" includes its day, the server's `to` excludes it.
  const dayMs = (v, plus = 0) => { if (!v) return null; const [y, m, d] = v.split("-").map(Number); return new Date(y, m - 1, d + plus).getTime(); };
  for (const id of ["galleryFrom", "galleryTo"]) $(id).addEventListener("change", () => {
    gotoEnd = null;
    setFilter({ from: dayMs($("galleryFrom").value), to: dayMs($("galleryTo").value, 1) });
  });
  $("galleryDateUnit").addEventListener("change", () => {
    unit = $("galleryDateUnit").value;
    saveLocal("galleryDateUnit", unit);
    setFilter({});
  });
  $("galleryGoto").addEventListener("change", () => {
    const end = +$("galleryGoto").value;
    gotoEnd = end || null;
    $("galleryTo").value = "";
    setFilter({ to: gotoEnd });
  });

  $("gallerySelectBtn").addEventListener("click", () => setSelecting(!selecting));
  $("gallerySelNone").addEventListener("click", clearSelection);
  $("gallerySelFav").addEventListener("click", () => { const l = [...selection.values()]; setFavs(l, !l.every(a => a.fav)); });
  $("gallerySelTag").addEventListener("click", () => { selTagOpen = !selTagOpen; renderSelBar(); if (selTagOpen) $("gallerySelTagInput").focus(); });
  $("gallerySelTagForm").addEventListener("submit", async e => {
    e.preventDefault();
    const name = $("gallerySelTagInput").value.trim(), items = [...selection.values()];
    if (!name || !items.length) return;
    try { await tagItems(items, [name], []); }
    catch (err) { warn(err); return notice(false, "Gallery action failed."); }
    $("gallerySelTagInput").value = "";
    selTagOpen = false;
    renderSelBar();
    notice(true, "{n} item(s) tagged.", { n: items.length });
  });
  $("gallerySelRestore").addEventListener("click", () => restore([...selection.values()]));
  $("gallerySelDel").addEventListener("click", () => { const l = [...selection.values()]; clearSelection(); remove(l); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && selecting) setSelecting(false); });

  initLightbox();
  document.addEventListener("langchange", () => {
    for (const c of cards.values()) retitle(c);
    renderFacets();
    renderDates();
    if (lbAsset) renderMeta();
  });
  on("job", job => { if (job.status === "done") onJobDone(job); });
  booted = true;
  syncControls();
  reload();
  refreshTrash();
  refreshFacets();
  health();
}
