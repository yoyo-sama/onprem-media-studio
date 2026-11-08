// Canvas page: cards on a litegraph graph, the properties panel of the selected card,
// the palette that adds cards, persistence in this browser, theme and language.
// What a card does is in canvas-nodes.js; the gallery drawer in canvas-gallery.js.
// Nothing here submits a job: only Generate does, through the card.

import { api, connect } from "./api.js";
import { LANG, L, setLang, t, tx } from "./i18n.js";
import * as F from "./form.js";
import { CARDS, STATUS_COLOR, SLOT_IMG_REF, importFile, onChange, setStatus } from "./canvas-nodes.js";
import { renderLoraStack, setLoraFiles } from "./lora-stack.js";
import { initGallery } from "./canvas-gallery.js";
import { initModelNotice, showModelNotice } from "./model-notice.js";
import { $, MOBILE, fillSelect, initTheme } from "./ui.js";

const P = window.Prompts;
const STORAGE_KEY = "canvasGraphState";
const canvasEl = $("lgcanvas"), mediaLayer = $("mediaLayer");
const skin = n => CARDS[n.type];

// ── Sheets below 768 px ───────────────────────────────────────────────────────
// body[data-sheet] ("palette", "props" or absent) is the only state: the CSS shows the
// named sheet. Without effect on a wider screen.
function setSheet(name) {
  document.body.dataset.sheet = name;
  $("sheetMenu").setAttribute("aria-expanded", String(name === "palette"));
  $("sheetProps").setAttribute("aria-expanded", String(name === "props"));
}
const toggleSheet = name => setSheet(document.body.dataset.sheet === name ? "" : name);
$("sheetMenu").onclick = () => toggleSheet("palette");
$("sheetProps").onclick = () => toggleSheet("props");

// ── Colours drawn on the canvas ───────────────────────────────────────────────
// The 2D context does not read CSS variables: same roles as the tokens of canvas.css,
// read at each frame, so a theme change shows at the next repaint.
const THEME_COLORS = {
  light: {
    titleBar: "#ffffff", titleBarSel: "#343ced", titleRule: "#e3e8ef", titleRuleSel: "rgba(255,255,255,.35)",
    statusDot: "#94a3b8", mediaBed: "#0e1524",
    footer: "#ffffff", footerRule: "#e3e8ef", footerText: "#8a94a6",
    selHalo: "rgba(52,60,237,.12)", selBorder: "#343ced", selHandleStroke: "#ffffff",
    nodeBg: "#ffffff", nodeTitle: "#6b778c", nodeTitleSel: "#ffffff", shadow: "rgba(15,23,42,.14)",
    link: "#343ced", slotOff: "#c8cede", stage: "#f7f8fb", dot: "#dfe4ec",
  },
  dark: {
    titleBar: "#1b1f2b", titleBarSel: "#5a63f5", titleRule: "#2c3244", titleRuleSel: "rgba(255,255,255,.35)",
    statusDot: "#94a3b8", mediaBed: "#0b0e16",
    footer: "#1b1f2b", footerRule: "#2c3244", footerText: "#8b98ad",
    selHalo: "rgba(90,99,245,.22)", selBorder: "#5a63f5", selHandleStroke: "#12141c",
    nodeBg: "#1b1f2b", nodeTitle: "#c8d2e4", nodeTitleSel: "#ffffff", shadow: "rgba(0,0,0,.55)",
    link: "#5a63f5", slotOff: "#4a5570", stage: "#0d0f16", dot: "#2b3346",
  },
};
const TC = () => THEME_COLORS[document.documentElement.dataset.theme === "dark" ? "dark" : "light"];

// Dot grid painted by litegraph (it follows pan and zoom), one 22×22 tile.
function dotGrid(c) {
  const tile = document.createElement("canvas");
  tile.width = tile.height = 22;
  const g = tile.getContext("2d");
  g.fillStyle = c.stage; g.fillRect(0, 0, 22, 22);
  g.fillStyle = c.dot; g.beginPath(); g.arc(1, 1, 1, 0, Math.PI * 2); g.fill();
  return tile.toDataURL("image/png");
}
// Writes the theme into what litegraph reads besides our drawing functions.
function applyCanvasTheme() {
  const c = TC();
  LiteGraph.NODE_DEFAULT_COLOR = c.nodeBg;
  LiteGraph.NODE_DEFAULT_BGCOLOR = c.nodeBg;
  LiteGraph.NODE_TITLE_COLOR = c.nodeTitle;
  LiteGraph.NODE_SELECTED_TITLE_COLOR = c.nodeTitleSel;
  LiteGraph.NODE_TEXT_COLOR = c.nodeTitle;
  LiteGraph.NODE_BOX_OUTLINE_COLOR = c.selBorder;
  LiteGraph.DEFAULT_SHADOW_COLOR = c.shadow;
  LiteGraph.LINK_COLOR = c.link;
  lgcanvas.node_title_color = c.nodeTitle;
  lgcanvas.default_link_color = c.link;
  lgcanvas.default_connection_color = { input_off: c.slotOff, input_on: c.link, output_off: c.slotOff, output_on: c.link };
  lgcanvas.clear_background_color = c.stage;
  lgcanvas.background_image = dotGrid(c);
  // litegraph caches the pattern and rebuilds it only when it is null.
  lgcanvas._pattern = null;
  lgcanvas._bg_img = null;
  lgcanvas.setDirty(true, true);
}

// ── Card drawing ──────────────────────────────────────────────────────────────
// Header, placeholder gradient (the media overlay covers it once there is a result)
// and a footer with the status or the card's summary. Drawn text is translated at
// each frame, so a language change shows at the next repaint.
const FOOTER_H = 24;
function shorten(ctx, text, max) {
  let s = String(text || "");
  if (ctx.measureText(s).width <= max) return s;
  while (s.length > 1 && ctx.measureText(s + "…").width > max) s = s.slice(0, -1);
  return s + "…";
}
function onDrawTitleBar(ctx, titleHeight, size) {
  const c = TC();
  ctx.beginPath();
  ctx.roundRect(0, -titleHeight, size[0] + 1, titleHeight, [14, 14, 0, 0]);
  ctx.fillStyle = this.is_selected ? c.titleBarSel : c.titleBar;
  ctx.fill();
  ctx.fillStyle = this.is_selected ? c.titleRuleSel : c.titleRule;
  ctx.fillRect(0, -1, size[0] + 1, 1);
}
function onDrawTitleBox(ctx, titleHeight) {
  ctx.beginPath();
  ctx.arc(titleHeight * 0.5, titleHeight * -0.5, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = this.boxcolor || TC().statusDot;
  ctx.fill();
}
// "Run after: …" while a connected card upstream has produced nothing yet.
function waitingFor(node) {
  const names = (node.inputs || []).map((_, i) => node.getInputNode(i))
    .filter(up => up && !up.properties.outFile).map(up => t(skin(up).label));
  return names.length ? t("Run after: {names}", { names: names.join(", ") }) : "";
}
function onDrawBackground(ctx) {
  if (this.flags.collapsed) return;
  const s = skin(this), c = TC(), w = this.size[0], bh = this.size[1] - FOOTER_H;
  if (this.properties.src) {
    ctx.fillStyle = c.mediaBed;
    ctx.fillRect(0, 0, w, bh);
  } else {
    const g = ctx.createLinearGradient(0, 0, w, bh);
    g.addColorStop(0, s.grad[0]); g.addColorStop(1, s.grad[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, bh);
    if (s.video) {  // ▶ on video cards
      const cx = w / 2, cy = bh / 2, r = 13;
      ctx.fillStyle = "rgba(255,255,255,.85)";
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.55, cy - r); ctx.lineTo(cx + r * 0.9, cy); ctx.lineTo(cx - r * 0.55, cy + r);
      ctx.closePath(); ctx.fill();
    }
  }
  ctx.fillStyle = c.footer;
  ctx.fillRect(0, bh, w, FOOTER_H);
  ctx.fillStyle = c.footerRule;
  ctx.fillRect(0, bh, w, 1);
  ctx.font = "10.5px Inter, system-ui, sans-serif";
  ctx.textAlign = "left";
  const busy = this.status === "running" || this.status === "error";
  ctx.fillStyle = busy ? STATUS_COLOR[this.status] : c.footerText;
  const text = busy && this.statusMsg ? t(...this.statusMsg) : (this.status === "idle" && waitingFor(this)) || s.meta(this);
  ctx.fillText(shorten(ctx, text, w - 24), 12, bh + 15);
  if (this.status === "running" && typeof this.progress === "number") {
    ctx.fillStyle = STATUS_COLOR.running;
    ctx.fillRect(12, bh + 19, (w - 24) * Math.max(0, Math.min(100, this.progress)) / 100, 3);
  }
}

// "+" on a free image input: adds an Image import card connected to it. Drawn in
// onDrawForeground (node coordinates) and hit in onMouseDown, which litegraph calls
// only when the click missed the slot box (x from -5 to 25): hence x = 34.
const PLUS_X = 34, PLUS_R = 9;
const PLUS_INPUTS = {
  "simple/video": ["image"],
  "simple/qwen_edit": ["image", SLOT_IMG_REF],
  "adv/r2v": ["charsheet", "locsheet", SLOT_IMG_REF],
};
const plusSlots = node => (PLUS_INPUTS[node.type] && !node.flags.collapsed
  ? node.inputs.flatMap((s, i) => (PLUS_INPUTS[node.type].includes(s.name) && s.link == null ? [i] : [])) : []);
const plusPos = (node, i) => [PLUS_X, node.getConnectionPos(true, i)[1] - node.pos[1]];
function onDrawForeground(ctx) {
  const c = TC();
  ctx.save();
  for (const i of plusSlots(this)) {
    const [x, y] = plusPos(this, i);
    ctx.beginPath(); ctx.arc(x, y, PLUS_R, 0, Math.PI * 2);
    ctx.fillStyle = c.selBorder; ctx.fill();
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(x - 4, y); ctx.lineTo(x + 4, y); ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4); ctx.stroke();
  }
  if (this.is_selected && !this.flags.collapsed) {
    const w = this.size[0], h = this.size[1], th = LiteGraph.NODE_TITLE_HEIGHT;
    ctx.beginPath(); ctx.roundRect(-2, -th - 2, w + 4, h + th + 4, [16]);
    ctx.lineWidth = 4; ctx.strokeStyle = c.selHalo; ctx.stroke();
    ctx.beginPath(); ctx.roundRect(0, -th, w, h + th, [14]);
    ctx.lineWidth = 2; ctx.strokeStyle = c.selBorder; ctx.stroke();
    for (const [x, y] of [[0, -th], [w, -th], [0, h], [w, h]]) {
      ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = c.selBorder; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = c.selHandleStroke; ctx.stroke();
    }
  }
  ctx.restore();
}
function onMouseDownPlus(e, local) {
  for (const i of plusSlots(this)) {
    const [x, y] = plusPos(this, i);
    if (Math.hypot(local[0] - x, local[1] - y) <= PLUS_R) {
      addImportCard(this, i);
      return true;  // no drag of the card
    }
  }
  return false;
}
// Title: card name, then the start of its text ("Character sheet — a lighthouse…").
function getTitle() {
  const s = skin(this), subj = s.subject ? String(this.properties[s.subject] || "").trim() : "";
  return t(s.label) + (subj ? " — " + (subj.length <= 22 ? subj : subj.slice(0, 22).trim() + "…") : "");
}
for (const type of Object.keys(CARDS)) {
  Object.assign(LiteGraph.registered_node_types[type].prototype, { onDrawTitleBar, onDrawTitleBox, onDrawBackground, onDrawForeground, getTitle });
  if (PLUS_INPUTS[type]) LiteGraph.registered_node_types[type].prototype.onMouseDown = onMouseDownPlus;
}
// Slot names are internal: an empty label hides them, links still use the name.
function hideSlotLabels(node) {
  for (const s of [...(node.inputs || []), ...(node.outputs || [])]) s.label = "";
}

// ── Graph and canvas ──────────────────────────────────────────────────────────
const graph = new LGraph();
const lgcanvas = new LGraphCanvas(canvasEl, graph);
lgcanvas.render_canvas_border = false;
lgcanvas.show_info = false;
lgcanvas.round_radius = 14;
lgcanvas.title_text_font = "700 12px Inter, system-ui, sans-serif";
lgcanvas.inner_text_font = "11px Inter, system-ui, sans-serif";
lgcanvas.links_render_mode = LiteGraph.SPLINE_LINK;
lgcanvas.connections_width = 2;
lgcanvas.render_connection_arrows = true;
lgcanvas.render_curved_connections = true;
lgcanvas.render_connections_border = false;
lgcanvas.allow_searchbox = false;  // litegraph's own node list would offer cards outside this page
applyCanvasTheme();

// Without arguments resize() takes the size of #stage and repaints when it changed.
// Never write canvasEl.width first: the canvas would be cleared and not repainted.
window.addEventListener("resize", () => lgcanvas.resize());
lgcanvas.resize();

// ── Media overlays ────────────────────────────────────────────────────────────
// A real <img> or <video controls> over each card that has a result, placed at each
// frame from the card's position and the view transform (screen = (graph + offset) ×
// scale). It leaves free the band of inputs under the title (20 px per row) and the
// footer.
function overlayTop(node) {
  return Math.max(44, 20 * Math.max((node.inputs || []).length, (node.outputs || []).length) + 4);
}
function buildOverlay(node) {
  node.overlay?.remove();
  const src = node.properties.src, box = document.createElement("div");
  box.className = "media-overlay";
  const el = document.createElement(/\.mp4$/i.test(node.properties.outFile || "") ? "video" : "img");
  if (el.tagName === "VIDEO") Object.assign(el, { controls: true, loop: true, playsInline: true, preload: "metadata" });
  else el.alt = "";
  el.src = src;
  box.appendChild(el);
  mediaLayer.appendChild(box);
  node.overlay = box;
  box._src = src;
}
function syncOverlays() {
  const ds = lgcanvas.ds, s = ds.scale, [ox, oy] = ds.offset;
  for (const node of graph._nodes) {
    const src = node.properties.src;
    if (src && node.overlay?._src !== src) buildOverlay(node);
    const box = node.overlay;
    if (!box) continue;
    // Geometry is written only when it changed (kept on the box as a key).
    if (node.flags.collapsed || !src) {
      if (box._k !== "hidden") { box.style.display = "none"; box._k = "hidden"; }
      continue;
    }
    const top = overlayTop(node);
    const w = node.size[0] + "px", h = Math.max(0, node.size[1] - FOOTER_H - top) + "px";
    const tr = `translate(${(node.pos[0] + ox) * s}px,${(node.pos[1] + top + oy) * s}px) scale(${s})`;
    const k = `${w}|${h}|${tr}`;
    if (box._k === k) continue;
    box._k = k;
    Object.assign(box.style, { display: "", width: w, height: h, transform: tr });
  }
  if (selected) updateLiveProps();
  requestAnimationFrame(syncOverlays);
}

// ── Persistence in this browser ───────────────────────────────────────────────
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(graph.serialize())); }
  catch (err) { console.warn("Canvas: state not saved", err); }  // full or blocked storage
}
onChange(save);
graph.onNodeAdded = node => { hideSlotLabels(node); save(); };
graph.onNodeRemoved = node => {
  node.overlay?.remove();
  node.overlay = null;
  if (node === selected) showProps(null);
  save();
};
graph.onConnectionChange = save;
lgcanvas.onNodeMoved = save;
canvasEl.addEventListener("mouseup", save);

function restore() {
  let saved = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* storage unavailable: empty canvas */ }
  if (!saved) return;
  try {
    const state = JSON.parse(saved);
    // litegraph does not fail on {"nodes": "x"}: it builds a ghost card.
    if (state.nodes && !Array.isArray(state.nodes)) throw new Error("nodes is not an array");
    if ((state.nodes || []).some(n => !CARDS[n.type])) throw new Error("unknown card type");
    graph.configure(state);
  } catch (err) {
    console.warn("Canvas: unreadable saved state", err);
    graph.clear(); mediaLayer.replaceChildren();
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* nothing to remove */ }
    alert(t("The saved canvas could not be read: the canvas starts empty."));
  }
}

// ── Adding cards ──────────────────────────────────────────────────────────────
// New cards without a position take the first free cell of a 2-column grid right of
// the palette (cells of 380 × 380 graph units, the largest card plus a gap).
const AUTO = { cols: 2, x: 300, y: 60, cell: 380 };
function nextAutoPos(n) {
  const title = LiteGraph.NODE_TITLE_HEIGHT;
  const free = (x, y) => graph._nodes.every(o => {
    const [ox, oy, ow, oh] = o.getBounding();
    return x + n.size[0] <= ox || ox + ow <= x || y + n.size[1] <= oy || oy + oh <= y - title;
  });
  for (let i = 0; ; i++) {
    const x = AUTO.x + (i % AUTO.cols) * AUTO.cell, y = AUTO.y + Math.floor(i / AUTO.cols) * AUTO.cell;
    if (free(x, y)) return [x, y];
  }
}
function addNode(type, pos, props) {
  const n = LiteGraph.createNode(type);
  n.pos = pos || nextAutoPos(n);
  if (props) Object.assign(n.properties, props);
  graph.add(n);
  return n;
}
function select(node) {
  lgcanvas.selectNode(node);
  lgcanvas.onSelectionChange(lgcanvas.selected_nodes);
}
// The one place that adds an Image import card, connected to `slot` of `target` when
// given (the "+" of a free input). The selection waits a tick after a "+": litegraph
// selects the clicked card right after onMouseDown.
function addImportCard(target, slot) {
  const n = addNode("simple/import", target ? [target.pos[0] - 380, target.pos[1] + 40 * slot] : null);
  if (target) n.connect(0, target, slot);
  target ? setTimeout(() => select(n), 0) : select(n);
  return n;
}

const PIPELINE_ORDER = ["adv/charsheet", "adv/locsheet", "adv/storyboard", "adv/cutvideo", "adv/final_video", "adv/r2v",
                        "simple/krea2", "simple/qwen_edit", "simple/video", "simple/import"];
const PIPELINE_CATEGORIES = {
  image: ["simple/krea2", "simple/qwen_edit", "adv/charsheet", "adv/locsheet", "adv/storyboard", "simple/import"],
  video: ["simple/video", "adv/cutvideo", "adv/final_video", "adv/r2v", "simple/import"],
};
function refreshModelSelect() {
  const s = CARDS[$("pipelineSelect").value];
  fillSelect($("modelSelect"), s.modelValues || [["", s.model]]);
  $("modelSelect").disabled = !s.modelValues;
}
function applyCategory(cat) {
  fillSelect($("pipelineSelect"), PIPELINE_ORDER.filter(type => PIPELINE_CATEGORIES[cat].includes(type)).map(type => [type, CARDS[type].label]));
  for (const [id, c] of [["advCatImage", "image"], ["advCatVideo", "video"]]) {
    $(id).classList.toggle("open", cat === c);
    $(id).setAttribute("aria-pressed", String(cat === c));
  }
  refreshModelSelect();
}
$("pipelineSelect").onchange = refreshModelSelect;
$("advCatImage").onclick = () => applyCategory("image");
$("advCatVideo").onclick = () => applyCategory("video");
$("addCard").onclick = () => {
  const type = $("pipelineSelect").value, s = CARDS[type];
  if (type === "simple/import") { addImportCard(); return; }
  select(addNode(type, null, s.modelValues ? { [s.modelProp]: $("modelSelect").value } : null));
  if (MOBILE.matches) fitView();
};
$("advToggle").onclick = () => {
  const open = $("advBlock").hidden;
  $("advBlock").hidden = !open;
  $("advChevron").textContent = open ? "▴" : "▾";
  $("advToggle").setAttribute("aria-expanded", String(open));
};

// ── Use cases: ready-made graphs, connected, nothing generated ────────────────
function setTeaserOpen(open) {
  $("ucTeaserOptions").hidden = !open;
  $("ucTeaser").classList.toggle("open", open);
  $("ucTeaser").setAttribute("aria-expanded", String(open));
}
$("ucPoster").onclick = () => {
  setTeaserOpen(false);
  select(addNode("simple/krea2"));
  if (MOBILE.matches) fitView();
};
$("ucTeaser").onclick = () => setTeaserOpen($("ucTeaserOptions").hidden);
// Video card fed by an Image import card; the video card ends up selected (after the
// import card's own delayed selection).
$("ucTeaserImage").onclick = () => {
  const video = addNode("simple/video");
  addImportCard(video, 0);
  setTimeout(() => { select(video); if (MOBILE.matches) fitView(); }, 0);
};
$("ucTeaserSheets").onclick = () => {
  const [charsheet, locsheet, r2v] = ["adv/charsheet", "adv/locsheet", "adv/r2v"].map(type => addNode(type));
  charsheet.connect(0, r2v, 0);
  locsheet.connect(0, r2v, 1);
  select(r2v);
  if (MOBILE.matches) fitView();
};
// Character + setting → storyboard → cuts → final video, left to right, after the
// cards already there; the first card to run is selected.
$("ucTrailer").onclick = () => {
  setTeaserOpen(false);
  const GAP_X = 80, GAP_Y = 60, old = graph._nodes.slice();
  const x0 = old.length ? Math.max(...old.map(n => n.pos[0] + n.size[0])) + GAP_X : AUTO.x;
  const y0 = old.length ? Math.min(...old.map(n => n.pos[1])) : AUTO.y;
  const [charsheet, locsheet, storyboard, cutvideo, finalVideo] =
    ["adv/charsheet", "adv/locsheet", "adv/storyboard", "adv/cutvideo", "adv/final_video"].map(type => addNode(type, [0, 0]));
  charsheet.pos = [x0, y0];
  locsheet.pos = [x0, y0 + charsheet.size[1] + GAP_Y];
  const mid = y0 + (charsheet.size[1] + GAP_Y + locsheet.size[1]) / 2;
  let x = x0 + Math.max(charsheet.size[0], locsheet.size[0]);
  for (const n of [storyboard, cutvideo, finalVideo]) { x += GAP_X; n.pos = [x, mid - n.size[1] / 2]; x += n.size[0]; }
  charsheet.connect(0, storyboard, 0);
  locsheet.connect(0, storyboard, 1);
  storyboard.connect(0, cutvideo, 0);
  cutvideo.connect(0, finalVideo, 0);
  save();
  select(charsheet);
  fitView();
};

// ⤢ fits the cards (titles included) into the space the panels leave free, at a
// scale between 0.2 and 1. An empty graph gets the default view.
function fitView() {
  const ds = lgcanvas.ds, M = 24, top = el => (el ? el.getBoundingClientRect().top - M : Infinity);
  if (!graph._nodes.length) { ds.offset[0] = 0; ds.offset[1] = 0; ds.scale = 1; lgcanvas.setDirty(true, true); return; }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of graph._nodes) {
    const b = n.getBounding();
    x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[0] + b[2]); y1 = Math.max(y1, b[1] + b[3]);
  }
  const L0 = MOBILE.matches ? M : $("palette").getBoundingClientRect().right + M;
  const R = MOBILE.matches || $("props").hidden ? innerWidth - M : $("props").getBoundingClientRect().left - M;
  const B = Math.min(innerHeight - M, MOBILE.matches ? top($(document.body.dataset.sheet) || $("sheetBar")) : top($("cgDrawer")));
  const s = Math.max(0.2, Math.min((R - L0) / (x1 - x0), (B - M) / (y1 - y0), 1));
  ds.scale = s;
  ds.offset[0] = (L0 + R) / 2 / s - (x0 + x1) / 2;
  ds.offset[1] = (M + B) / 2 / s - (y0 + y1) / 2;
  lgcanvas.setDirty(true, true);
}
$("btnFit").onclick = fitView;
$("btnClear").onclick = () => {
  if (!confirm(t("Delete every card on the canvas? This cannot be undone."))) return;
  graph.clear(); mediaLayer.replaceChildren();
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* nothing saved */ }
  showProps(null);
};

// ── Properties panel ──────────────────────────────────────────────────────────
let selected = null;
function setProp(node, key, value) {
  node.properties[key] = value;
  node.setDirtyCanvas(true, true);
  save();
}

// ✨ under a text field: the Studio's enrichment of the same workflow (instruction per
// model, reference tokens kept, camera move put back). The field is written only when
// the enrichment applied; otherwise the reason shows under the button.
function addEnrichButton(row, node, f, input) {
  const wfId = f.enrich?.(node);
  if (!wfId) return;
  const btn = tx(document.createElement("button"), "✨ Enrich ({llm})", { llm: P.LLM_NAME });
  btn.type = "button";
  btn.className = "btn-outline";
  btn.dataset.enrich = f.k;
  const err = document.createElement("div");
  err.className = "field-error";
  btn.onclick = async () => {
    btn.disabled = true;
    tx(btn, "Enriching…");
    err.textContent = "";
    let warning = "";
    try {
      await F.loadInstructions();
      const out = await P.enrichBrief(F.llm, F.workflow(wfId), input.value, "",
        (level, text, params) => { if (level === "warn") warning = t(text, params); });
      if (!out) throw new Error(warning);
      input.value = out.brief;
      setProp(node, f.k, out.brief);
    } catch (e) {
      err.textContent = t("Enrichment failed: {error}", { error: e.message });
    } finally {
      btn.disabled = false;
      tx(btn, "✨ Enrich ({llm})", { llm: P.LLM_NAME });
    }
  };
  row.append(btn, err);
}

function fieldInput(node, f, s) {
  const value = node.properties[f.k];
  if (f.type === "textarea") {
    const el = document.createElement("textarea");
    el.value = value || "";
    if (f.placeholder) el.placeholder = f.placeholder;  // an English example, never translated
    el.oninput = () => setProp(node, f.k, el.value);
    return el;
  }
  if (f.type === "select") {
    const el = document.createElement("select");
    fillSelect(el, f.values(), value);
    el.onchange = () => {
      setProp(node, f.k, el.value);
      if (f.k === s.modelProp) showProps(node);  // the engine decides which fields show
    };
    return el;
  }
  if (f.type === "loras") {
    // One stack per folder: an engine switch keeps the other engine's stack.
    const stacks = node.properties.loras ??= {}, folder = f.folder(node);
    const box = renderLoraStack(document.createElement("div"), {
      folder, stack: (stacks[folder] ??= []), onChange: () => setProp(node, f.k, stacks) });
    box.setAttribute("role", "group");
    return box;
  }
  if (f.type === "file") {
    const el = document.createElement("input");
    el.type = "file";
    el.accept = "image/*";
    el.onchange = async () => {
      const file = el.files[0];
      el.value = "";
      if (file) { await importFile(node, file); showProps(node); }
    };
    return el;
  }
  const el = document.createElement("input");
  el.type = "number";
  if (f.min != null) el.min = f.min;
  if (f.max != null) el.max = f.max;
  el.value = value;
  el.onchange = () => {
    let v = Math.round(Number(el.value) || 0);
    if (f.min != null) v = Math.max(f.min, v);
    if (f.max != null) v = Math.min(f.max, v);
    el.value = v;
    setProp(node, f.k, v);
  };
  return el;
}

function showProps(node) {
  const prev = selected;
  selected = node;
  $("props").hidden = !node;
  $("sheetProps").disabled = !node;
  showModelNotice($("propsModelNotice"), node && skin(node).engines ? skin(node).engines(node.properties) : []);
  if (!node) {
    $("propsFields").replaceChildren();
    if (document.body.dataset.sheet === "props") setSheet("");
    return;
  }
  if (MOBILE.matches && node !== prev) setSheet("props");  // a newly selected card opens its sheet
  const s = skin(node);
  $("propsCardTitle").textContent = node.getTitle();
  const model = s.modelValues ? (s.modelValues.find(m => m[0] === node.properties[s.modelProp]) || ["", s.model])[1] : s.model;
  $("propsCardType").textContent = `${s.tech} · ${model}`;
  $("propsPreview").textContent = (s.preview ? node.properties[s.preview] : s.meta(node)) || "—";
  const rows = [];
  for (const f of s.fields) {
    if (f.when && !f.when(node)) continue;
    const row = document.createElement("div");
    row.className = "row";
    const id = "pf-" + f.k;
    const label = document.createElement("label");
    label.htmlFor = id;
    label.id = id + "-label";
    label.textContent = t(f.label);
    const input = fieldInput(node, f, s);
    input.id = id;
    if (f.type === "loras") input.setAttribute("aria-labelledby", label.id);
    row.append(label, input);
    if (f.hint) {
      const hint = document.createElement("div");
      hint.className = "field-hint";
      hint.id = id + "-hint";
      hint.textContent = t(f.hint);
      input.setAttribute("aria-describedby", hint.id);
      row.appendChild(hint);
    }
    if (f.type === "textarea") addEnrichButton(row, node, f, input);
    rows.push(row);
  }
  $("propsFields").replaceChildren(...rows);
  updateLiveProps();
}
// What moves during a render, without rebuilding the fields (that would lose typing).
// Runs at each frame: the DOM is written only when something changed.
const STATUS_WORD = { idle: L("Waiting"), running: L("Running"), done: L("Done"), error: L("Error") };
function updateLiveProps() {
  const st = selected.status || "idle";
  const text = selected.statusMsg ? t(...selected.statusMsg) : t(STATUS_WORD[st] || st);
  const action = t(selected.properties.outFile ? "Regenerate" : "Generate");
  const status = $("propsStatus"), regen = $("btnRegen");
  if (status.dataset.status !== st) status.dataset.status = st;
  if (status.textContent !== text) status.textContent = text;
  if (regen.textContent !== action) regen.textContent = action;
  regen.hidden = !selected.generate;
}

lgcanvas.onSelectionChange = sel => {
  lgcanvas.highlighted_links = {};  // litegraph paints them white, invisible on a light stage
  const ids = Object.keys(sel || {});
  showProps(ids.length === 1 ? sel[ids[0]] : null);
};
$("btnRegen").onclick = () => selected?.generate?.();
$("btnDup").onclick = () => {
  if (!selected) return;
  const clone = addNode(selected.type, [selected.pos[0] + 40, selected.pos[1] + 40], structuredClone(selected.properties));
  clone.size = selected.size.slice();
  if (clone.properties.outFile) setStatus(clone, "done");
  save();
  select(clone);
};

// ── Start ─────────────────────────────────────────────────────────────────────
initTheme();
$("themeBtn").addEventListener("click", applyCanvasTheme);
$("langSelect").value = LANG;
$("langSelect").addEventListener("change", () => setLang($("langSelect").value));
document.addEventListener("langchange", () => {
  if (selected) showProps(selected);
  lgcanvas.setDirty(true, true);  // drawn text is translated at the next repaint
});
applyCategory("image");
restore();
graph._nodes.forEach(hideSlotLabels);
setLang(LANG);
initGallery({ graph, lgcanvas, save });
initModelNotice();
requestAnimationFrame(syncOverlays);
if (MOBILE.matches) { setSheet(graph._nodes.length ? "" : "palette"); fitView(); }
connect();
api.loras().then(r => { setLoraFiles(r); if (selected) showProps(selected); },
  err => console.warn("Canvas: LoRA list unavailable", err));

// Hooks for automated tests.
window.__canvas = { graph, lgcanvas, save, addNode, CARDS, showProps, fitView, get selected() { return selected; } };
