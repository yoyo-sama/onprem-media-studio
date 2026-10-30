// Notice under an engine choice when a model that engine renders with is not installed:
// the server downloads it inside the first job. Showing the notice submits nothing and
// downloads nothing.
import { api, on } from "./api.js";
import { LANG, pct, t, tx } from "./i18n.js";

let needs = null;    // pipeline id → catalog ids it renders with
let models = null;   // catalog id → {label, installed, gated, progress}
const notices = new Map();   // element → pipeline ids, for the refresh after an event
const sizes = {};            // catalog id → bytes left to download, null while unknown

// Asked once per model, only for a model that is missing: the server reads the file
// list from Hugging Face. Unreachable or gated: the notice goes without a size.
function askSize(id) {
  if (id in sizes) return;
  sizes[id] = null;
  api.modelSize(id).then(r => { sizes[id] = r.bytes; refresh(); }).catch(() => {});
}
const gb = bytes => t("{n} GB", { n: (bytes / 1e9).toLocaleString(LANG, { maximumFractionDigits: 1 }) });

async function load() {
  try {
    const [pipelines, list] = await Promise.all([needs ? null : api.pipelines(), api.models()]);
    if (pipelines) needs = Object.fromEntries(pipelines.map(p => [p.id, p.models]));
    models = Object.fromEntries(list.map(m => [m.id, m]));
  } catch { return; }  // server unreachable: no notice rather than a wrong one
  refresh();
}

function refresh() {
  for (const [el, pipelines] of notices) {
    if (el.isConnected) render(el, pipelines);
    else notices.delete(el);
  }
}

function render(el, pipelines) {
  const ids = [...new Set(pipelines.flatMap(p => needs?.[p] || []))];
  const missing = ids.map(id => models?.[id]).filter(m => m && !m.installed);
  el.replaceChildren(...missing.map(m => {
    const line = document.createElement("span"), size = sizes[m.id];
    if (m.progress != null) return tx(line, "{name}: downloading ({pct}).", { name: m.label, pct: pct(Math.round(m.progress * 100)) });
    askSize(m.id);
    const part = (text, params) => tx(document.createElement("span"), text, params);
    line.append(size ? part("{name} is not installed: about {size} will be downloaded at the first render.", { name: m.label, size: gb(size) })
      : part("{name} is not installed: it will be downloaded at the first render.", { name: m.label }));
    if (m.gated) line.append(" ", part("Hugging Face access required (HF_TOKEN and the licence accepted)."));
    return line;
  }));
  el.hidden = !missing.length;
}

// Shows in `el` the models the given pipelines (engine ids) still have to download.
export function showModelNotice(el, pipelines) {
  notices.set(el, pipelines);
  render(el, pipelines);
}

let started = false;
export function initModelNotice() {
  if (started) return;
  started = true;
  load();
  on("model", msg => {
    if (models?.[msg.id] && msg.progress != null && msg.progress < 1 && !msg.error) {
      models[msg.id].progress = msg.progress;
      refresh();
    } else load();
  });
  document.addEventListener("langchange", refresh);  // the percentage is formatted per language
  // A job downloads its missing models itself: its end can change what is installed.
  on("job", job => { if (job.status === "done" || job.status === "error") load(); });
}
