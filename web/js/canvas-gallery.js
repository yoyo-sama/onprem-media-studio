// Gallery drawer of the Canvas: the latest renders of this app, in two tabs, to open in
// a new tab or to drag onto an Image import card (no upload: the file is already on
// the server). Read from the gallery index.

import { api, on } from "./api.js";
import { adoptRef } from "./canvas-nodes.js";
import { $ } from "./ui.js";

const LIMIT = 40;
let tab = "image";
const tray = kind => $(kind === "image" ? "cgTrayImages" : "cgTrayVideos");
const isOpen = () => $("cgDrawer").classList.contains("expanded");

function thumb(a) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = `cg-thumb${a.type === "video" ? " video" : ""}`;
  el.title = a.filename;
  el.setAttribute("aria-label", a.filename);
  const img = document.createElement("img");
  img.src = a.thumb;
  img.alt = "";
  img.loading = "lazy";
  el.appendChild(img);
  el.onclick = () => window.open(a.url, "_blank", "noopener");
  el.draggable = true;
  el.addEventListener("dragstart", e => {
    e.dataTransfer.setData("application/json", JSON.stringify({ ref: a.ref, name: a.filename, type: a.type }));
    e.dataTransfer.effectAllowed = "copy";
  });
  return el;
}

async function load() {
  try {
    const page = await api.gallery.assets({ type: tab, limit: LIMIT });
    $("cgTabImages").querySelector(".cg-n").textContent = `(${page.counts.image})`;
    $("cgTabVideos").querySelector(".cg-n").textContent = `(${page.counts.video})`;
    tray(tab).replaceChildren(...page.items.map(thumb));
  } catch (err) { console.warn("Canvas: gallery unavailable", err); }  // the drawer stays as it was
}

function switchTab(kind) {
  tab = kind;
  $("cgTabImages").classList.toggle("active", kind === "image");
  $("cgTabVideos").classList.toggle("active", kind === "video");
  tray("image").hidden = kind !== "image";
  tray("video").hidden = kind !== "video";
  load();
}

// `graph` and `lgcanvas` of the page; `save` persists the graph.
export function initGallery({ graph, lgcanvas, save }) {
  $("cgTabImages").onclick = () => switchTab("image");
  $("cgTabVideos").onclick = () => switchTab("video");
  $("cgHandle").onclick = () => {
    const open = !isOpen();
    $("cgDrawer").classList.toggle("expanded", open);
    $("cgHandle").setAttribute("aria-expanded", String(open));
    if (open) load();
  };
  // A finished job shows at once in an open drawer.
  on("job", job => { if (job.status === "done" && isOpen()) load(); });

  // A gallery image dropped on an Image import card becomes its output.
  const canvasEl = lgcanvas.canvas;
  canvasEl.addEventListener("dragover", e => e.preventDefault());
  canvasEl.addEventListener("drop", e => {
    e.preventDefault();
    let item;
    try { item = JSON.parse(e.dataTransfer.getData("application/json")); } catch { return; }
    if (!item?.ref || item.type !== "image") return;
    // graph = screen / scale - offset (the inverse of the overlay placement).
    const rect = canvasEl.getBoundingClientRect(), ds = lgcanvas.ds;
    const node = graph.getNodeOnPos((e.clientX - rect.left) / ds.scale - ds.offset[0], (e.clientY - rect.top) / ds.scale - ds.offset[1]);
    if (node?.type !== "simple/import") return;
    adoptRef(node, item.ref, item.name);
    save();
  });
  load();
}
