// LoRA stack picker, shared by the Studio form and the Canvas panel: up to MAX_LORAS
// rows of (file, strength) for one engine family's folder (GET /api/loras lists the
// files per folder; a job sends `loras: [{name, strength}]`, studio/loras.py checks
// it). The rows edit the array they are given in place and call onChange; nothing is
// submitted from here.

import { tx, txAttr } from "./i18n.js";

export const MAX_LORAS = 4;  // studio/loras.py MAX_STACK
// Folder → the engine family it serves (product names, not translated).
export const LORA_FOLDERS = { h3: "MiniMax H3" };
export const STRENGTH = { min: -2, max: 2, step: 0.05 };

// folder → file names, as the page last read them; `onLoraFiles` hears each new list.
let files = {};
const listeners = new Set();
export function setLoraFiles(listing) {
  files = Object.fromEntries(Object.entries(listing || {}).map(([folder, list]) => [folder, list.map(l => l.name)]));
  listeners.forEach(fn => fn());
}
export const onLoraFiles = fn => listeners.add(fn);
export const loraFiles = folder => files[folder] || [];

const clampStrength = v => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(STRENGTH.max, Math.max(STRENGTH.min, Math.round(n * 100) / 100)) : 1;
};
// What a job sends: complete rows only, strengths in range.
export const stackParams = stack => (stack || []).filter(l => l?.name).map(l => ({ name: l.name, strength: clampStrength(l.strength) }));
// "a ×0.8, b ×1" (file names without the extension), for card lines and the gallery.
export const stackLabel = stack => (stack || []).map(l => `${l.name.replace(/\.safetensors$/, "")}${l.strength == null ? "" : ` ×${l.strength}`}`).join(", ");

const short = name => name.replace(/\.safetensors$/, "");

// Draws the rows of `stack` (an array of {name, strength}) into `box`.
export function renderLoraStack(box, { folder, stack, onChange = () => {} }) {
  const redraw = () => renderLoraStack(box, { folder, stack, onChange });
  const changed = () => { onChange(stack); redraw(); };
  const available = loraFiles(folder);
  box.classList.add("lora-stack");
  const rows = stack.map((entry, i) => {
    const row = document.createElement("div");
    row.className = "lora-row";
    // A file used by another row is not offered (the server refuses a file listed twice);
    // a file no longer on the server stays shown, and the server says it is missing.
    const others = new Set(stack.filter((_, j) => j !== i).map(l => l.name));
    const names = available.filter(n => !others.has(n));
    if (!names.includes(entry.name)) names.unshift(entry.name);
    const sel = document.createElement("select");
    sel.dataset.raw = "";  // file names are not translated
    sel.replaceChildren(...names.map(n => new Option(short(n), n)));
    sel.value = entry.name;
    txAttr(sel, "aria-label", "LoRA {n}", { n: i + 1 });
    sel.addEventListener("change", () => { entry.name = sel.value; changed(); });
    const strength = document.createElement("input");
    strength.type = "number";
    Object.assign(strength, { min: STRENGTH.min, max: STRENGTH.max, step: STRENGTH.step, value: entry.strength ?? 1 });
    txAttr(strength, "aria-label", "Strength of LoRA {n} (-2 to 2)", { n: i + 1 });
    txAttr(strength, "title", "Strength (-2 to 2)");
    strength.addEventListener("change", () => {
      entry.strength = clampStrength(strength.value);
      strength.value = entry.strength;
      onChange(stack);
    });
    const x = document.createElement("button");
    x.type = "button";
    x.className = "lora-x";
    x.textContent = "✕";
    txAttr(x, "aria-label", "Remove this LoRA");
    x.addEventListener("click", () => { stack.splice(i, 1); changed(); });
    row.append(sel, strength, x);
    return row;
  });
  const free = available.filter(n => !stack.some(l => l.name === n));
  const add = document.createElement("button");
  add.type = "button";
  add.className = "lora-add";
  tx(add, stack.length >= MAX_LORAS ? "{n} LoRAs at most" : "＋ Add a LoRA", { n: MAX_LORAS });
  add.disabled = stack.length >= MAX_LORAS || !free.length;
  add.addEventListener("click", () => { stack.push({ name: free[0], strength: 1 }); changed(); });
  const parts = [...rows, add];
  if (!available.length) {
    const hint = document.createElement("div");
    hint.className = "lora-hint";
    tx(hint, "No LoRA for this engine yet: add one under Models › LoRAs.");
    parts.push(hint);
  }
  box.replaceChildren(...parts);
  return box;
}

// The same stack as toggle chips (the assistant's cards): one chip per file of the
// folder, a click turns it on (strength 1, editable beside it) or off, at most MAX_LORAS
// on. Nothing is drawn when the folder is empty and nothing is on.
export function renderLoraChips(box, { folder, stack, onChange = () => {}, disabled = false }) {
  const redraw = () => renderLoraChips(box, { folder, stack, onChange, disabled });
  const names = [...new Set([...loraFiles(folder), ...stack.map(l => l.name)])];
  box.className = "lora-chips";
  box.hidden = !names.length;
  const parts = names.map(name => {
    const entry = stack.find(l => l.name === name);
    const chip = document.createElement("span");
    chip.className = "lora-chip-wrap";
    const b = document.createElement("button");
    b.type = "button";
    b.className = "lora-chip" + (entry ? " active" : "");
    b.dataset.raw = "";
    b.dataset.lora = name;
    b.textContent = short(name);
    b.setAttribute("aria-pressed", String(!!entry));
    b.disabled = disabled || (!entry && stack.length >= MAX_LORAS);
    if (b.disabled && !disabled) txAttr(b, "title", "{n} LoRAs at most", { n: MAX_LORAS });
    b.addEventListener("click", () => {
      const i = stack.findIndex(l => l.name === name);
      if (i >= 0) stack.splice(i, 1); else stack.push({ name, strength: 1 });
      onChange(stack);
      redraw();
    });
    chip.appendChild(b);
    if (entry) {
      const strength = document.createElement("input");
      strength.type = "number";
      strength.className = "lora-chip-strength";
      Object.assign(strength, { min: STRENGTH.min, max: STRENGTH.max, step: STRENGTH.step, value: entry.strength ?? 1, disabled });
      txAttr(strength, "aria-label", "Strength of {name} (-2 to 2)", { name: short(name) });
      strength.addEventListener("change", () => {
        entry.strength = clampStrength(strength.value);
        strength.value = entry.strength;
        onChange(stack);
      });
      chip.appendChild(strength);
    }
    return chip;
  });
  const label = tx(document.createElement("span"), "LoRA");
  label.className = "lora-chips-label";
  box.replaceChildren(label, ...parts);
  return box;
}
