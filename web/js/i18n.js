// Interface translation: English source text is the key, French, Spanish and German
// come from DICT in i18n-dict.js (most of it carried over from 1.4). Text with parameters uses
// {name} placeholders: t("Shot {n}/{total}", {n: 1, total: 6}).
//
// translateTree() translates the text nodes, placeholder, title and aria-label of a
// subtree and remembers the English original, so a later language change starts
// from it again. An element marked data-raw (server data, file names, prompts) and
// everything inside it is left alone. Text set by code goes through tx() (or
// txAttr()), which keeps the English text and its parameters on the element and
// sets it again at each language change; other code-set text listens to the
// "langchange" event.

import { DICT } from "./i18n-dict.js";

export const LANGS = ["en", "fr", "es", "de"];

function pickLang() {
  let saved = null;
  try { saved = localStorage.getItem("lang"); } catch { /* storage unavailable */ }
  if (LANGS.includes(saved)) return saved;
  const nav = (navigator.language || "en").slice(0, 2).toLowerCase();
  return LANGS.includes(nav) ? nav : "en";
}

export let LANG = pickLang();

// Marks an English string for translation where it is not passed to t() or tx() at
// once (label tables): tests/test_i18n.py collects these too.
export const L = text => text;

export function t(text, params) {
  let out = LANG === "en" ? text : DICT[text]?.[LANG] ?? text;
  if (params) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
  return out;
}

const ATTRS = ["placeholder", "title", "aria-label"];
const raw = el => !!el.closest?.("[data-raw]");

function translateText(node) {
  const cur = node.nodeValue;
  // Text replaced by code since the last pass becomes the new original.
  if (node.__orig === undefined || (cur !== node.__orig && cur !== node.__done)) node.__orig = cur;
  const src = node.__orig, key = src.replace(/\s+/g, " ").trim();
  if (!key) return;
  const out = t(key);
  node.__done = out === key ? src : /^\s*/.exec(src)[0] + out + /\s*$/.exec(src)[0];
  if (node.nodeValue !== node.__done) node.nodeValue = node.__done;
}

function translateAttrs(el) {
  el.__att ??= {};
  for (const name of ATTRS) {
    if (!el.hasAttribute(name)) continue;
    const cur = el.getAttribute(name), st = el.__att[name];
    const orig = !st || (cur !== st.orig && cur !== st.done) ? cur : st.orig;
    const done = t(orig);
    el.__att[name] = { orig, done };
    if (cur !== done) el.setAttribute(name, done);
  }
}

export function translateTree(root) {
  if (!root || raw(root)) return;
  if (root.nodeType === Node.TEXT_NODE) return translateText(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: n => n.nodeType === Node.ELEMENT_NODE && (n.hasAttribute("data-raw") || n.tagName === "SCRIPT" || n.tagName === "STYLE")
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  for (let n = walker.currentNode; n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) translateText(n);
    else translateAttrs(n);
  }
}

// Sets the element's text (and returns the element), translated now and at every
// language change.
export function tx(el, text, params) {
  el.__tx = [text, params];
  el.setAttribute("data-tx", "");
  el.textContent = t(text, params);
  return el;
}
export function txAttr(el, name, text, params) {
  (el.__txa ??= {})[name] = [text, params];
  el.setAttribute("data-tx", "");
  el.setAttribute(name, t(text, params));
  return el;
}

export function setLang(lang) {
  if (!LANGS.includes(lang)) return;
  LANG = lang;
  try { localStorage.setItem("lang", lang); } catch { /* the choice lasts for this page only */ }
  document.documentElement.lang = lang;
  translateTree(document.body);
  for (const el of document.querySelectorAll("[data-tx]")) {
    if (el.__tx) el.textContent = t(...el.__tx);
    for (const [name, args] of Object.entries(el.__txa || {})) el.setAttribute(name, t(...args));
  }
  document.dispatchEvent(new CustomEvent("langchange"));
}

// "87%" in English, "87 %" elsewhere.
export const pct = n => t("{n}%", { n });
