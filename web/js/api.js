// Server access for the Studio and the Canvas: REST calls, the event WebSocket, job
// waiting and the LLM. Every error thrown here carries the server's own message.

async function call(method, url, body, raw) {
  const opts = { method, headers: {} };
  if (raw !== undefined) opts.body = raw;
  else if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  let res;
  try { res = await fetch(url, opts); }
  catch (err) { throw new Error(`server unreachable (${err.message})`); }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON: the status says enough */ }
  if (!res.ok) {
    const detail = data?.detail;
    const err = new Error(typeof detail === "string" ? detail
      : Array.isArray(detail) ? detail.map(d => d.msg || JSON.stringify(d)).join("; ")
      : `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}
const get = url => call("GET", url);
const post = (url, body) => call("POST", url, body ?? {});
const query = params => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "" && v !== false) q.set(k, v === true ? "1" : v);
  const s = q.toString();
  return s ? `?${s}` : "";
};

export const api = {
  health: () => get("/api/health"),
  models: () => get("/api/models"),
  pipelines: () => get("/api/pipelines"),
  modelSize: id => get(`/api/models/${encodeURIComponent(id)}/size`),
  instructions: () => get("/api/instructions"),
  setInstruction: (name, text) => call("PUT", `/api/instructions/${encodeURIComponent(name)}`, { text }),
  resetInstruction: name => call("DELETE", `/api/instructions/${encodeURIComponent(name)}`),
  downloadModel: id => post(`/api/models/${encodeURIComponent(id)}/download`),
  jobs: () => get("/api/jobs"),
  job: id => get(`/api/jobs/${encodeURIComponent(id)}`),
  submit: (pipeline, params, origin) => post("/api/jobs", { pipeline, params, origin }),
  cancel: id => post(`/api/jobs/${encodeURIComponent(id)}/cancel`),
  // Raw image bytes in, {ref, width, height} out: `ref` goes in a job's image fields.
  upload: blob => call("POST", "/api/inputs", undefined, blob),
  chat: body => post("/api/llm/chat", body),
  loras: () => get("/api/loras"),
  updateStatus: () => get("/api/update/status"),
  updateApply: () => post("/api/update/apply"),
  gallery: {
    health: () => get("/api/gallery/health"),
    assets: filters => get(`/api/gallery/assets${query(filters)}`),
    asset: key => get(`/api/gallery/asset${query({ key })}`),
    dates: filters => get(`/api/gallery/dates${query(filters)}`),
    facets: scope => get(`/api/gallery/facets${query({ scope })}`),
    fav: (keys, fav) => post("/api/gallery/fav", { keys, fav }),
    tag: (keys, add, remove) => post("/api/gallery/tag", { keys, add, remove }),
    rename: (key, name) => post("/api/gallery/rename", { key, name }),
    trash: keys => post("/api/gallery/trash", { keys }),
    restore: keys => post("/api/gallery/restore", { keys }),
  },
};

// URL of a file reference (`outputs/…`, `inputs/…`).
export const refURL = ref => "/" + String(ref).split("/").map(encodeURIComponent).join("/");

// LoRA upload with progress (fetch has no upload progress). Resolves with the server's answer.
export function uploadLora(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/loras/h3?name=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* status only */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data?.detail || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("network error"));
    xhr.send(file);
  });
}

// ── Events ────────────────────────────────────────────────────────────────────
// One WebSocket per page, reconnected after a drop. On reconnection the jobs still
// awaited are read again, so a `done` sent during the drop is not lost.

const listeners = { job: new Set(), model: new Set(), open: new Set() };
const waits = new Map();   // job id → [{resolve, reject}]
let socket = null;

export function on(type, fn) { listeners[type].add(fn); return () => listeners[type].delete(fn); }

function settle(job) {
  const list = waits.get(job.id);
  if (!list || !["done", "error", "cancelled"].includes(job.status)) return;
  waits.delete(job.id);
  for (const w of list) {
    if (job.status === "done") w.resolve(job);
    else {
      const err = new Error(job.status === "cancelled" ? "cancelled" : job.error || "job failed");
      err.job = job;
      w.reject(err);
    }
  }
}

export function connect() {
  if (socket) return;
  socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`);
  socket.onopen = async () => {
    for (const fn of listeners.open) fn();
    for (const id of [...waits.keys()]) {
      try { const job = await api.job(id); for (const fn of listeners.job) fn(job); settle(job); }
      catch { /* the server lost the job (restart): reported by the next wait */ }
    }
  };
  socket.onclose = () => { socket = null; setTimeout(connect, 3000); };
  socket.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === "job") { for (const fn of listeners.job) fn(msg.job); settle(msg.job); }
    else if (msg.type === "model") for (const fn of listeners.model) fn(msg);
  };
}

// Resolves with the finished job; rejects when it fails or is cancelled.
export function waitJob(job) {
  return new Promise((resolve, reject) => {
    if (!waits.has(job.id)) waits.set(job.id, []);
    waits.get(job.id).push({ resolve, reject });
    settle(job);
    // A job that ended between the submission and this call: read it once.
    api.job(job.id).then(settle, () => {});
  });
}

// ── LLM ───────────────────────────────────────────────────────────────────────
// The `llm` function the prompt compilers take: one system + user turn, JSON answer
// parsed. `images` are raw base64 strings.
export async function llmJSON(system, user, images) {
  const { content } = await api.chat({ system, prompt: user, images: images || [], json_mode: true });
  try { return JSON.parse(content); }
  catch {
    const m = /\{[\s\S]*\}/.exec(content);
    if (m) return JSON.parse(m[0]);
    throw new Error("the LLM answer is not JSON");
  }
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("file could not be read"));
    reader.readAsDataURL(blob);
  });
}
