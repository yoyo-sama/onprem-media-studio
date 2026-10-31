// The creative assistant: the page's first mode, a chat in the main area. The server
// picks the role best placed to answer and streams its reply; every tool call the role
// makes arrives as a card. A card runs only on the user's click, through the same
// functions as the Studio form (generate.js), and its result is reported back so later
// turns can use it (C3#1…). Storyboard and reference-to-video cards run the director:
// their click switches to the Studio, fills the form and starts the step-by-step
// review there, the only way to run them.

import { api, chatStream, refURL } from "./api.js";
import { L, LANG, t, translateTree, tx, txAttr } from "./i18n.js";
import { $, LLM, MOBILE, fillSelect, log, notice, promptLog, runJob, undoToast, warn } from "./ui.js";
import { openLightbox } from "./gallery.js";
import { drawMascots, setCostume, setMood } from "./mascot.js";
import * as F from "./form.js";
import * as G from "./generate.js";

const P = F.P;
const MAX_ATTACHMENTS = 6;
const ORIGIN = "assistant";
const VIDEO = /\.(mp4|webm|mov)$/i;
const CONV_KEY = "chatConversation", ROLE_KEY = "chatRole", LIBRARY_KEY = "assistantLibrary";

let hooks = {};
let roles = [];             // the server's role records
let conv = null;            // the conversation shown; null = a new one
let pinned = null;          // role chosen by the user; null = automatic
let answerTo = null;        // question card the next message answers ("Other…")
let attachments = [];       // images of the next message: {name, ref | blob}
let streaming = null;       // AbortController of the turn in progress
const drafts = new Map();   // card id → arguments edited on the card
const running = new Set();  // card ids rendering from this page

const saveLocal = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* this page only */ } };
const readLocal = k => { try { return localStorage.getItem(k); } catch { return null; } };

// Shipped role names, for translation (a role the user wrote keeps its own name).
L("General assistant"); L("Director"); L("Casting and sets"); L("Ad art director"); L("Localisation");
L("Product and fashion campaign"); L("Transition editor");
const roleName = id => { const r = roles.find(x => x.id === id); return r ? t(r.name) : id || "—"; };

// ── Cards ─────────────────────────────────────────────────────────────────────
// `text`: the argument shown in the card's text box; `fields`: settings the user can
// change; `images`: arguments holding image ids; `enrich`: the workflow whose Gemma
// instruction ✨ uses; `form`: the Studio form can take the card over; `director`: the
// card's Generate is the director's, in the Studio.
const CARD_UI = {
  create_image: { title: L("Image"), text: "prompt", fields: ["engine", "ratio", "count", "style"], form: true,
                  enrich: a => (a.engine === "qwen" ? "qwen21_t2i" : "krea2_t2i") },
  edit_image: { title: L("Image editing"), text: "instruction", images: ["image", "references"], form: true,
                enrich: () => "qwen21_i2i" },
  character_sheet: { title: L("Subject sheet"), text: "description", fields: ["kind", "style"] },
  location_sheet: { title: L("Setting sheet"), text: "description", fields: ["style"] },
  video_from_text: { title: L("Video from a text"), text: "prompt", fields: ["duration", "ratio"], form: true,
                     enrich: () => "h3_t2v" },
  video_from_image: { title: L("Video from an image"), text: "prompt", images: ["image", "last_image"], fields: ["duration"],
                      form: true, enrich: () => "h3_i2v" },
  image_sequence: { title: L("Multi-image sequence"), text: "prompt", images: ["images"], fields: ["duration"], form: true,
                    enrich: () => "h3_sequence" },
  join_videos: { title: L("Joined clips"), images: ["clips"] },
  campaign: { title: L("Campaign"), text: "brief", fields: ["variants", "duration", "style"], form: true,
              enrich: () => "campaign" },
  storyboard: { title: L("Storyboard"), text: "brief", fields: ["shots", "duration", "ratio"], form: true, director: true },
  reference_video: { title: L("Reference to video"), text: "brief", images: ["references"], fields: ["duration", "ratio"],
                     form: true, director: true },
};
const IMAGE_LABELS = {
  image: L("Image"), references: L("References"), last_image: L("Last frame"), images: L("Key images"), clips: L("Clips"),
};
const FIELDS = {
  engine: { label: L("Engine"), options: () => [["krea2", "Krea 2 Turbo"], ["qwen", "Qwen Image 2.1"]] },
  ratio: { label: L("Ratio"), options: () => Object.keys(F.RATIOS).map(r => [r, r]) },
  style: { label: L("Style"), options: () => Object.entries(P.STYLE_PACKS).map(([id, s]) => [id, s.label]) },
  kind: { label: L("Subject type"), options: () => [["human", L("Human")], ["other", L("Other (animal, creature, robot, object…)")]] },
  count: { label: L("Variants"), min: 1, max: 4 },
  variants: { label: L("Variants"), min: 1, max: 4 },
  duration: { label: L("Video length (s)"), min: 5, max: 15 },
  shots: { label: L("Number of shots"), min: 4, max: 16 },
};
const STATUS = {
  proposed: ["", L("Proposed")], running: ["running", L("Running…")], done: ["done", L("Done")],
  error: ["error", L("Error")], cancelled: ["fallback", L("Cancelled")], opened: ["done", L("Opened in the Studio")],
  launched: ["done", L("Director started")],
};

const findCard = id => {
  for (const m of conv?.messages || []) for (const c of m.cards || []) if (c.id === id) return c;
  return null;
};
// File reference of an image id (A1, C3#2), null while it has none.
function refOf(id) {
  for (const m of conv?.messages || []) for (const a of m.attachments || []) if (a.id === id) return a.ref;
  const m = /^(C\d+)#(\d+)$/.exec(id || "");
  return m ? findCard(m[1])?.state.outputs?.[+m[2] - 1] || null : null;
}
const argsOf = card => ({ ...card.args, ...(drafts.get(card.id) || {}) });
const imageIds = (card, a = argsOf(card)) => (CARD_UI[card.tool].images || []).flatMap(k => [].concat(a[k] || []));
const fileName = ref => String(ref).split("/").pop();

function setDraft(card, key, value) {
  drafts.set(card.id, { ...(drafts.get(card.id) || {}), [key]: value });
}

function button(text, title, fn, cls = "secondary-btn") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  tx(b, text);
  if (title) txAttr(b, "title", title);
  b.addEventListener("click", fn);
  return b;
}
function rawText(tag, text, cls) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  el.dataset.raw = "";
  el.textContent = text;
  return el;
}

function thumb(ref, caption) {
  const fig = document.createElement("figure");
  fig.className = "cc-thumb";
  if (ref && VIDEO.test(ref)) {
    const v = document.createElement("video");
    v.src = refURL(ref); v.controls = true; v.preload = "metadata"; v.playsInline = true;
    fig.appendChild(v);
  } else if (ref) {
    const img = document.createElement("img");
    img.src = refURL(ref); img.alt = ""; img.loading = "lazy";
    img.addEventListener("click", () => openLightbox({ url: img.src, type: "image" }));
    fig.appendChild(img);
  } else fig.appendChild(document.createElement("div")).className = "cc-missing";
  fig.appendChild(rawText("figcaption", caption));
  return fig;
}

function renderQuestion(card, live) {
  const el = document.createElement("div");
  el.className = "chat-card chat-question";
  el.appendChild(rawText("p", card.args.question || "", "cc-question"));
  const st = card.state;
  if (st.status === "answered") {
    el.appendChild(rawText("p", `→ ${st.answer || ""}`, "cc-answer"));
    return el;
  }
  const row = document.createElement("div");
  row.className = "cc-options";
  for (const option of card.args.options || []) {
    const b = rawText("button", option, "secondary-btn");
    b.type = "button";
    b.disabled = live;
    b.addEventListener("click", () => send(option, card.id));
    row.appendChild(b);
  }
  const other = button("Other…", "Answer in your own words", () => {
    answerTo = card.id;
    renderAnswering();
    $("chatInput").focus();
  });
  other.disabled = live;
  row.appendChild(other);
  el.appendChild(row);
  return el;
}

// `live`: the card arrived in the reply being streamed; its buttons wait for the end.
function renderCard(card, live = false) {
  if (card.invalid) {
    const el = document.createElement("p");
    el.className = "chat-note";
    tx(el, "A proposal was set aside: {reason}", { reason: card.invalid });
    return el;
  }
  if (card.tool === "ask_choices") return renderQuestion(card, live);
  const ui = CARD_UI[card.tool];
  if (!ui) return document.createElement("div");
  const a = argsOf(card), st = card.state, busy = st.status === "running" || running.has(card.id);
  const el = document.createElement("div");
  el.className = "chat-card";
  el.dataset.card = card.id;

  const head = document.createElement("div");
  head.className = "cc-head";
  const name = document.createElement("strong");
  tx(name, "{id} · {title}", { id: card.id, title: t(ui.title) });
  const [cls, label] = STATUS[st.status] || STATUS.proposed;
  const status = tx(document.createElement("span"), label);
  status.className = `status ${cls}`;
  head.append(name, status);
  el.appendChild(head);

  for (const w of card.warnings || []) el.appendChild(rawText("p", `⚠ ${w}`, "cc-warn"));

  if (ui.text) {
    const area = document.createElement("textarea");
    area.rows = 4;
    area.spellcheck = false;
    area.value = a[ui.text] || "";
    area.disabled = busy;
    txAttr(area, "aria-label", "Prompt");
    area.addEventListener("input", () => setDraft(card, ui.text, area.value));
    el.appendChild(area);
  }

  if (ui.fields?.length) {
    const row = document.createElement("div");
    row.className = "cc-fields";
    for (const key of ui.fields) {
      const def = FIELDS[key], lab = document.createElement("label");
      lab.appendChild(tx(document.createElement("span"), def.label));
      let input;
      if (def.options) {
        input = document.createElement("select");
        fillSelect(input, def.options(), String(a[key]));
        input.addEventListener("change", () => setDraft(card, key, input.value));
      } else {
        input = document.createElement("input");
        input.type = "number"; input.min = def.min; input.max = def.max; input.value = a[key];
        input.addEventListener("change", () => {
          const v = Math.min(def.max, Math.max(def.min, parseInt(input.value, 10) || def.min));
          input.value = v;
          setDraft(card, key, v);
        });
      }
      input.disabled = busy;
      lab.appendChild(input);
      row.appendChild(lab);
    }
    el.appendChild(row);
  }
  if (a.markets?.length)
    el.appendChild(tx(document.createElement("p"), "Markets: {list}", { list: a.markets.map(m => t(G.MARKETS[m]?.label || m)).join(", ") })).className = "hint";

  const missing = [];
  for (const key of ui.images || []) {
    const ids = [].concat(a[key] || []);
    if (!ids.length) continue;
    const row = document.createElement("div");
    row.className = "cc-images";
    row.appendChild(tx(document.createElement("span"), IMAGE_LABELS[key]));
    for (const id of ids) {
      const ref = refOf(id);
      if (!ref) missing.push(id);
      row.appendChild(thumb(ref, id));
    }
    el.appendChild(row);
  }

  const actions = document.createElement("div");
  actions.className = "cc-actions";
  if (ui.director) {
    const b = button("🎬 Launch the director", "Switches to the Studio and starts the step-by-step review with this brief",
      () => openInStudio(card, true), "primary-btn");
    b.disabled = live || busy || missing.length > 0;
    const o = button("Open in the Studio", "Fills the Studio form without starting anything", () => openInStudio(card));
    o.disabled = b.disabled;
    actions.append(b, o);
  } else {
    const again = ["done", "error", "cancelled"].includes(st.status);
    const b = button(again ? "Generate again" : "Generate", null, () => runCard(card), "primary-btn");
    b.disabled = live || busy || missing.length > 0;
    actions.appendChild(b);
    if (ui.enrich) {
      const e = button("✨ Enrich", "Rewrites this card's prompt with the engine's Gemma instruction, without starting a render",
        () => enrichCard(card, el.querySelector("textarea"), e));
      e.disabled = live || busy;
      actions.appendChild(e);
    }
    if (ui.form && hooks.openInStudio) {
      const o = button("Open in the Studio", "Fills the Studio form with this card, to go on there", () => openInStudio(card));
      o.disabled = live || busy || missing.length > 0;
      actions.appendChild(o);
    }
  }
  el.appendChild(actions);
  if (missing.length && !live)
    el.appendChild(tx(document.createElement("p"), "Waiting for {ids}: generate the card that makes it first.", { ids: missing.join(", ") })).className = "hint";
  if (st.error) el.appendChild(rawText("p", st.error, "cc-warn"));

  const outputs = st.outputs || [];
  if (outputs.length) {
    const grid = document.createElement("div");
    grid.className = "cc-outputs";
    outputs.forEach((ref, i) => {
      // An H3 clip's last frame is a reference for the next clip, not a result to show.
      if (!VIDEO.test(ref) && i > 0 && VIDEO.test(outputs[i - 1])) return;
      const fig = thumb(ref, `${card.id}#${i + 1}`);
      if (!VIDEO.test(ref) && hooks.useAsInput) {
        const use = button("→ Use in the Studio", "Makes this image the Studio's input image", () => hooks.useAsInput({ ref, filename: fileName(ref) }));
        use.classList.add("cc-use");
        fig.appendChild(use);
      }
      grid.appendChild(fig);
    });
    el.appendChild(grid);
  }
  translateTree(el);
  return el;
}

// ── Running a card ────────────────────────────────────────────────────────────
function need(id) {
  const ref = refOf(id);
  if (!ref) throw new Error(t("{id} is not available yet.", { id }));
  return ref;
}

// The job promises of a card, submitted through the Studio's own flows.
async function submitCard(card, a) {
  const seed = Math.floor(Math.random() * 2 ** 31);
  const label = what => ["{id} · {what}", { id: card.id, what: t(what) }];
  const title = CARD_UI[card.tool].title, opts = { origin: ORIGIN, seed };
  const sheet = prompt => [runJob("krea2-t2i", { prompt, ...P.SHEET_SIZE, count: 1, seed }, {
    origin: ORIGIN, label: label(title), sub: ["{info} · seed {seed}", { info: "Krea 2", seed }] })];
  switch (card.tool) {
    case "create_image": {
      const style = P.styleTextFor(a.style);
      return G.runPlain(F.workflow(a.engine === "qwen" ? "qwen21_t2i" : "krea2_t2i"),
        { ...opts, specs: [{ prompt: style ? `${a.prompt} ${style}` : a.prompt, label: label(title) }], ratio: a.ratio, count: a.count });
    }
    case "edit_image": {
      const specs = a.markets?.length
        ? a.markets.map(m => ({ prompt: G.marketPrompt(a.instruction, m), label: label(G.MARKETS[m].label) }))
        : [{ prompt: a.instruction, label: label(title) }];
      return G.runPlain(F.workflow("qwen21_i2i"), { ...opts, specs, image: need(a.image), refs: (a.references || []).map(need) });
    }
    case "character_sheet": return sheet(P.charsheetPromptFrom(a.description, a.kind, "auto", a.style));
    case "location_sheet": return sheet(P.locsheetPromptFrom(a.description, a.style));
    case "video_from_text":
      return G.runPlain(F.workflow("h3_t2v"), { ...opts, specs: [{ prompt: a.prompt, label: label(title) }], ratio: a.ratio, duration: a.duration });
    case "video_from_image":
      return G.runPlain(F.workflow("h3_i2v"), { ...opts, specs: [{ prompt: a.prompt, label: label(title) }], duration: a.duration,
        image: need(a.image), last: a.last_image ? need(a.last_image) : null });
    case "image_sequence": {
      const refs = a.images.map(need);
      const aspect = await G.seqAspect({ ref: refs[0] });
      return [G.runSequence({ ...opts, refs, durs: refs.map(() => a.duration), text: a.prompt, aspect })];
    }
    case "join_videos":
      return [runJob("video-concat", { clips: a.clips.map(need) }, { origin: ORIGIN, label: label(title), sub: ["{n} clip(s)", { n: a.clips.length }] })];
    case "campaign":
      return G.runCampaign({ ...opts, text: a.brief, styleId: a.style, count: a.variants, duration: a.duration });
  }
  throw new Error(`unknown card ${card.tool}`);
}

async function report(cid, card, body) {
  const updated = await api.chatCard(cid, card.id, body);
  if (conv?.id !== cid) return;
  Object.assign(findCard(card.id) || {}, updated);
  if (body.args) drafts.delete(card.id);
  renderLog();
  return updated;
}

async function runCard(card) {
  if (running.has(card.id)) return;
  const cid = conv.id, args = argsOf(card);
  const key = CARD_UI[card.tool].text;
  if (key && !String(args[key] || "").trim()) { notice(false, "Empty prompt: write what you want first."); return; }
  running.add(card.id);
  try {
    // The server checks the edited settings again: what runs is what it kept.
    const kept = (await report(cid, card, { status: "running", args }))?.args || args;
    const results = await Promise.allSettled(await submitCard(card, kept));
    const outputs = results.flatMap(r => (r.status === "fulfilled" ? r.value.outputs : []));
    const failed = results.find(r => r.status === "rejected");
    if (failed && !outputs.length) throw failed.reason;
    running.delete(card.id);
    await report(cid, card, { status: "done", outputs });
    setMood("happy", 2400);
  } catch (err) {
    running.delete(card.id);
    const cancelled = err.message === "cancelled" || err.message === t("Project cancelled.");
    if (!cancelled) { warn(err); setMood("sad", 2400); }
    report(cid, card, { status: cancelled ? "cancelled" : "error", ...(cancelled ? {} : { error: err.message }) }).catch(warn);
  }
}

async function enrichCard(card, area, btn) {
  const ui = CARD_UI[card.tool], a = argsOf(card), wf = F.workflow(ui.enrich(a));
  if (!area?.value.trim()) return;
  btn.disabled = true;
  log("req", "Enriching the prompt with {llm}…", { llm: LLM });
  try {
    await F.loadInstructions();
    const out = await P.enrichBrief(F.llm, wf, area.value, P.styleTextFor(a.style || "none"), promptLog);
    if (out) {
      const before = area.value;
      area.value = out.brief;
      setDraft(card, ui.text, out.brief);
      undoToast("Card prompt enriched.", {}, () => { area.value = before; setDraft(card, ui.text, before); });
    }
  } catch (err) { log("warn", "Enrichment unavailable: {error}", { error: err.message }); }
  finally { btn.disabled = false; }
}

// `launch`: a director card's own button, which starts the director once the form is
// filled (the click is the user's Generate).
async function openInStudio(card, launch = false) {
  const a = argsOf(card), images = {}, cid = conv.id;
  try {
    for (const id of imageIds(card, a)) images[id] = { name: fileName(need(id)), ref: need(id) };
    const image = id => images[id] || null;
    if (launch) await hooks.launchDirector(card.tool, a, image);
    else await hooks.openInStudio(card.tool, a, image);
    await report(cid, card, { status: launch ? "launched" : "opened", args: a });
  } catch (err) { warn(err); }
}

// ── Conversation ──────────────────────────────────────────────────────────────
function renderMessage(m) {
  if (m.type === "role") {
    const p = document.createElement("p");
    p.className = "chat-note";
    tx(p, m.auto ? "{role} takes over." : "You chose {role}.", { role: roleName(m.to) });
    if (m.goal) p.appendChild(rawText("span", ` ${m.goal}`));
    return p;
  }
  const el = document.createElement("div");
  el.className = `chat-msg ${m.type === "user" ? "from-user" : "from-assistant"}`;
  if (m.type === "assistant") el.appendChild(tx(document.createElement("div"), "{role}", { role: roleName(m.role) })).className = "chat-who";
  if (m.text) el.appendChild(rawText("div", m.text, "chat-text"));
  if (m.attachments?.length) {
    const row = document.createElement("div");
    row.className = "cc-images";
    for (const att of m.attachments) row.appendChild(thumb(att.ref, att.id));
    el.appendChild(row);
  }
  for (const card of m.cards || []) el.appendChild(renderCard(card));
  return el;
}

function renderLog() {
  const box = $("chatLog"), stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.replaceChildren(...(conv?.messages || []).map(renderMessage));
  translateTree(box);
  $("chatStarters").hidden = !!conv?.messages?.length;
  renderRole();
  if (stick) box.scrollTop = box.scrollHeight;
}

function renderRole() {
  setCostume(pinned || conv?.role || "assistant");
  const badge = $("chatRoleNow");
  if (pinned) tx(badge, "Role: {role} (your choice)", { role: roleName(pinned) });
  else if (conv) tx(badge, "Role: {role} (automatic)", { role: roleName(conv.role) });
  else tx(badge, "Role: chosen automatically");
}

function renderAnswering() {
  const box = $("chatAnswering"), card = answerTo && findCard(answerTo);
  box.hidden = !card;
  if (!card) return;
  box.replaceChildren(tx(document.createElement("span"), "Answering: {question}", { question: card.args.question || "" }),
    button("✕", "Not an answer to this question", () => { answerTo = null; renderAnswering(); }));
}

async function refreshList() {
  let list = [];
  try { list = await api.chats(); } catch (err) { warn(err); }
  fillSelect($("chatConvSelect"), [["", L("New conversation")], ...list.map(c => [c.id, c.title || c.id])], conv?.id || "");
  [...$("chatConvSelect").options].slice(1).forEach(o => { o.dataset.raw = ""; });
  $("chatDeleteBtn").disabled = !conv;
}

async function openConversation(id) {
  if (id !== conv?.id) drafts.clear();
  answerTo = null;
  if (!id) conv = null;
  else {
    try { conv = await api.chatLoad(id); }
    catch (err) { conv = null; if (err.status !== 404) warn(err); }
  }
  saveLocal(CONV_KEY, conv?.id || null);
  renderAnswering();
  renderLog();
  await refreshList();
}

// ── Sending ───────────────────────────────────────────────────────────────────
function setBusy(on) {
  $("chatSendBtn").hidden = on;
  $("chatStopBtn").hidden = !on;
  $("chatConvSelect").disabled = on;
  $("chatNewBtn").disabled = on;
}

async function send(text, answer = answerTo) {
  if (streaming) return;
  text = String(text || "").trim();
  if (!text && !attachments.length) return;
  const atts = attachments.slice();
  let refs;
  try { refs = await Promise.all(atts.map(F.imageRef)); }
  catch (err) { warn(err); return; }
  const input = $("chatInput"), typed = input.value;
  if (text === typed.trim()) input.value = "";
  attachments = [];
  answerTo = null;
  renderAttachments();
  renderAnswering();
  streaming = new AbortController();
  setBusy(true);
  setMood("thinking");
  let cid = conv?.id || null, bubble = null, textEl = null, failed = false;
  const box = $("chatLog");
  const scroll = () => { box.scrollTop = box.scrollHeight; };
  const ensureBubble = () => {
    if (bubble) return;
    bubble = document.createElement("div");
    bubble.className = "chat-msg from-assistant";
    bubble.appendChild(tx(document.createElement("div"), "{role}", { role: roleName(conv?.role) })).className = "chat-who";
    textEl = rawText("div", "", "chat-text typing");
    bubble.appendChild(textEl);
    box.appendChild(bubble);
  };
  try {
    await chatStream({ conversation: cid, text, attachments: refs, role: pinned, answer_to: answer || null, lang: LANG }, ev => {
      if (ev.type === "conversation") {
        cid = ev.id;
        if (!conv || conv.id !== ev.id) conv = { id: ev.id, title: ev.title, role: pinned || "assistant", messages: [] };
        conv.messages.push(ev.message);
        renderLog();
        ensureBubble();
      } else if (ev.type === "role") {
        conv.role = ev.role;
        renderRole();
        const empty = bubble && !textEl.textContent && !bubble.querySelector(".chat-card, .chat-note, .cc-warn");
        if (ev.changed) {
          const note = renderMessage({ type: "role", to: ev.role, auto: ev.auto, goal: ev.goal });
          translateTree(note);
          if (empty) box.insertBefore(note, bubble);
          else { textEl?.classList.remove("typing"); box.appendChild(note); bubble = null; }
        }
        if (bubble) tx(bubble.querySelector(".chat-who"), "{role}", { role: roleName(ev.role) });
        else ensureBubble();
      } else if (ev.type === "text") {
        ensureBubble();
        textEl.classList.remove("typing");
        textEl.textContent += ev.delta;
        setMood("talking");
      } else if (ev.type === "card") {
        ensureBubble();
        textEl.classList.remove("typing");
        bubble.appendChild(renderCard(ev.card, true));
        setMood("happy", 1600);
      } else if (ev.type === "error") {
        failed = true;
        ensureBubble();
        textEl.classList.remove("typing");
        bubble.appendChild(tx(document.createElement("p"), "The assistant is unavailable: {error}", { error: ev.message })).className = "cc-warn";
      }
      scroll();
    }, streaming.signal);
  } catch (err) {
    if (err.name !== "AbortError") {
      failed = true;
      notice(false, "The assistant is unavailable: {error}", { error: err.message });
      // Refused before anything was stored: the message goes back to the input.
      if (!cid) { input.value = typed; attachments = atts; renderAttachments(); }
    }
  } finally {
    streaming = null;
    setBusy(false);
    setMood("idle");
    if (failed) setMood("sad", 3000);
    if (cid) await openConversation(cid);
  }
}

// ── Attachments ───────────────────────────────────────────────────────────────
function addAttachments(images) {
  const room = MAX_ATTACHMENTS - attachments.length;
  attachments.push(...images.slice(0, Math.max(0, room)));
  if (images.length > room) notice(false, "At most {max} images here: the extra ones were ignored.", { max: MAX_ATTACHMENTS });
  renderAttachments();
}
function renderAttachments() {
  $("chatAtts").replaceChildren(...attachments.map((img, i) => {
    const fig = thumb(null, img.name);
    const pic = document.createElement("img");
    pic.alt = "";
    pic.src = F.imageURL(img);
    fig.replaceChild(pic, fig.firstChild);
    fig.appendChild(button("✕", "Remove this image", () => { attachments.splice(i, 1); renderAttachments(); }, "cc-x"));
    return fig;
  }));
  translateTree($("chatAtts"));
}

function initDrop() {
  const panel = $("assistantChat");
  const has = e => { const ty = e.dataTransfer?.types; return !!ty && (ty.includes("Files") || ty.includes("application/json")); };
  panel.addEventListener("dragover", e => { if (!has(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; panel.classList.add("drop-over"); });
  panel.addEventListener("dragleave", e => { if (!panel.contains(e.relatedTarget)) panel.classList.remove("drop-over"); });
  panel.addEventListener("drop", e => {
    if (!has(e)) return;
    e.preventDefault();
    panel.classList.remove("drop-over");
    const files = [...e.dataTransfer.files];
    if (files.length) {
      const images = files.filter(f => /^image\//.test(f.type));
      if (images.length < files.length) notice(false, "Only images can be attached.");
      addAttachments(images.map(f => ({ name: f.name, blob: f })));
      return;
    }
    let asset = null;
    try { asset = JSON.parse(e.dataTransfer.getData("application/json")); } catch { /* not a gallery image */ }
    if (!asset?.ref) return;
    if (asset.type === "video") { notice(false, "Only images can be attached."); return; }
    addAttachments([{ name: asset.filename, ref: asset.ref }]);
  });
}

// ── Panel ─────────────────────────────────────────────────────────────────────
// Starting points: they fill the input, the user still sends.
const STARTERS = [
  L("I need a poster for a product launch"),
  L("Turn my story into a short trailer"),
  L("Adapt this ad for other markets"),
  L("Animate this image into a short clip"),
];

let loaded = false;
// Called each time the page switches to the assistant: the first time loads the roles
// and the last conversation.
export async function showAssistant() {
  if (!loaded) {
    loaded = true;
    await loadRoles();
    await openConversation(readLocal(CONV_KEY));
  }
  if (!MOBILE.matches) $("chatInput").focus();
}

// A gallery image used from the assistant becomes an attachment of the next message.
export function attachAsset(a) {
  addAttachments([{ name: a.filename, ref: a.ref }]);
  notice(true, "{name} attached to your next message.", { name: a.filename });
}
// A prompt taken from the gallery goes to the message box, with Undo.
export function reusePrompt(text) {
  const input = $("chatInput"), before = input.value;
  input.value = text;
  undoToast("Prompt copied into your message.", {}, () => { input.value = before; });
  input.focus();
}

// The library (gallery and job queue) beside the chat, open or closed as last left.
function setLibrary(open) {
  $("assistantLibrary").hidden = !open;
  $("libraryBtn").setAttribute("aria-pressed", String(open));
  document.body.classList.toggle("library-open", open);
  saveLocal(LIBRARY_KEY, open ? "1" : null);
}

async function loadRoles() {
  try { roles = await api.roles(); } catch (err) { warn(err); }
  const saved = readLocal(ROLE_KEY);
  pinned = roles.some(r => r.id === saved) ? saved : null;
  fillSelect($("chatRoleSelect"), [["", L("Automatic")], ...roles.map(r => [r.id, r.name])], pinned || "");
}

// ── Role editor (Models panel) ────────────────────────────────────────────────
const NEW_ROLE = `---
id: my_role
name: My role
when: When the user asks for …
tools: create_image
---
`;
export async function loadRolePanel() {
  try { roles = await api.roles(); } catch (err) { warn(err); return; }
  const cur = $("roleEditSelect").value;
  fillSelect($("roleEditSelect"), [...roles.map(r => [r.id, r.name]), ["", L("+ New role")]], cur || roles[0]?.id || "");
  showRole();
}
function showRole() {
  const r = roles.find(x => x.id === $("roleEditSelect").value);
  $("roleEditText").value = r ? r.text : NEW_ROLE;
  tx($("roleState"), "{n} replaced", { n: roles.filter(x => x.replaced || !x.builtin).length });
  tx($("roleEditHint"), !r ? "A new role: give it its own id." : !r.builtin ? "A role you added."
    : r.replaced ? "Your text (replaces the shipped role)." : "Shipped role.");
  tx($("roleEditReset"), r && !r.builtin ? "Delete the role" : "Restore the original");
  $("roleEditReset").disabled = !r || (r.builtin && !r.replaced);
}
async function saveRole(reset) {
  const text = $("roleEditText").value, id = reset ? $("roleEditSelect").value : /^id:\s*(\S+)/m.exec(text)?.[1];
  if (!id) { log("warn", "The role header needs an id line."); return; }
  try {
    roles = reset ? await api.resetRole(id) : await api.setRole(id, text);
    log("ok", reset ? "Role restored: {id}." : "Role saved: {id}.", { id });
    fillSelect($("roleEditSelect"), [...roles.map(r => [r.id, r.name]), ["", L("+ New role")]], roles.some(r => r.id === id) ? id : roles[0]?.id);
    showRole();
    fillSelect($("chatRoleSelect"), [["", L("Automatic")], ...roles.map(r => [r.id, r.name])], pinned || "");
  } catch (err) { warn(err); }
}

// ── Setup ─────────────────────────────────────────────────────────────────────
// `h.openInStudio(tool, args, image)` fills the form (image(id) → {name, ref});
// `h.launchDirector(tool, args, image)` fills it and starts the director;
// `h.useAsInput(asset)` makes an image the form's input (and shows the Studio).
export function initChat(h) {
  hooks = h;
  drawMascots();
  setLibrary(readLocal(LIBRARY_KEY) === "1" && !MOBILE.matches);
  $("libraryBtn").addEventListener("click", () => setLibrary($("assistantLibrary").hidden));
  $("libraryCloseBtn").addEventListener("click", () => setLibrary(false));
  $("chatForm").addEventListener("submit", e => { e.preventDefault(); send($("chatInput").value); });
  // The character listens while the user types.
  $("chatInput").addEventListener("input", () => { if (!streaming) setMood($("chatInput").value.trim() ? "listening" : "idle"); });
  $("chatInput").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send($("chatInput").value); }
  });
  $("chatStopBtn").addEventListener("click", () => streaming?.abort());
  $("chatAttachBtn").addEventListener("click", () => $("chatFiles").click());
  $("chatFiles").addEventListener("change", () => {
    addAttachments([...$("chatFiles").files].map(f => ({ name: f.name, blob: f })));
    $("chatFiles").value = "";
  });
  $("chatNewBtn").addEventListener("click", () => openConversation(null));
  $("chatConvSelect").addEventListener("change", () => openConversation($("chatConvSelect").value || null));
  $("chatDeleteBtn").addEventListener("click", async () => {
    if (!conv || !confirm(t("Delete this conversation for good?"))) return;
    try { await api.chatDelete(conv.id); await openConversation(null); } catch (err) { warn(err); }
  });
  $("chatRoleSelect").addEventListener("change", () => {
    pinned = $("chatRoleSelect").value || null;
    saveLocal(ROLE_KEY, pinned);
    renderRole();
  });
  $("chatStarterList").replaceChildren(...STARTERS.map(text => button(text, null, () => {
    $("chatInput").value = t(text);
    $("chatInput").focus();
    setMood("listening");
  })));
  $("roleEditSelect").addEventListener("change", showRole);
  $("roleEditSave").addEventListener("click", () => saveRole(false));
  $("roleEditReset").addEventListener("click", () => saveRole(true));
  initDrop();
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !$("assistantLibrary").hidden && MOBILE.matches && $("lightbox").hidden) setLibrary(false);
  });
  document.addEventListener("langchange", () => { if (loaded) renderLog(); });
}
