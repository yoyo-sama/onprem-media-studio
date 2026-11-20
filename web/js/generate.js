// The Studio's simple flows as functions of their settings: text and image to image or
// video and the campaign. The Studio form and the
// assistant's cards both call them, so a card submits exactly what the form would.
// Each returns the promise of its jobs; nothing here reads the form.

import { L, t } from "./i18n.js";
import { runJob } from "./ui.js";
import * as F from "./form.js";

const P = F.P;

// ── Target markets ────────────────────────────────────────────────────────────
export const MARKETS = {
  na: { label: L("North America"), cues: "New York and Los Angeles urban backdrop, bold dynamic typography, energetic premium blockbuster vibe" },
  latam: { label: L("Latin America"), cues: "Rio de Janeiro and Mexico City vibrancy, warm saturated color accents, festive energetic atmosphere" },
  europe: { label: L("Europe"), cues: "Parisian and Berlin refined atmosphere, elegant minimal typography, sophisticated muted palette accents" },
  mea: { label: L("Middle East"), cues: "Dubai futuristic skyline, luxurious gold accents, modest wardrobe styling, Arabic typographic cues" },
  africa: { label: L("Africa"), cues: "Lagos and Nairobi skyline energy, warm earth-tone accents, contemporary Afro-futurist visual cues" },
  asia: { label: L("Asia"), cues: "Tokyo and Seoul neon cityscape, CJK typography styling, high-tech night aesthetics" },
};
// The market name in the prompt is the English one: it is model input.
export const marketPrompt = (brief, id) =>
  `${brief} Adapt this asset for the ${MARKETS[id].label} market: ${MARKETS[id].cues}. Keep the composition, main character, logo placement and brand palette unchanged.`;

// ── Text and image to image or video ──────────────────────────────────────────
// One job per spec ({prompt, label}): one per market for local versions. `image` and
// `last`, `refs` are file references. Returns the job promises.
// `mode`: the MOSS-Image mode (F.MOSS_MODES), for that engine only.
export function runPlain(wf, { specs, origin, ratio, count = 1, duration = 5, loras = [], image = null, last = null, refs = [], seed,
                               mode = F.MOSS_DEFAULT_MODE }) {
  const [width, height] = (wf.engine === "qwen-image-2.1" ? F.QWEN21_RATIOS : F.RATIOS)[ratio] || [];
  // Image engines get `loras` only with a stack: without one their jobs stay as they were.
  const imageLoras = loras.length ? { loras } : {};
  return specs.map((spec, i) => {
    const s = F.seedPlus(seed, i);
    let params, info;
    if (wf.id === "krea2_t2i" || wf.id === "qwen21_t2i") {
      params = { prompt: spec.prompt, width, height, count, seed: s, ...imageLoras };
      info = `${width}×${height}`;
    } else if (wf.id === "moss_t2i") {
      params = { prompt: spec.prompt, mode, width, height, count, seed: s, ...imageLoras };
      info = `${width}×${height} · ${t(F.mossModeLabel(mode))}`;
    } else if (wf.id === "qwen21_i2i") {
      // The size follows the input image (~1 MP): the ratio plays no part here.
      params = { prompt: spec.prompt, images: [image, ...refs], seed: s, ...imageLoras };
      info = refs.length ? `Qwen Image 2.1 · +${refs.length} ref.` : "Qwen Image 2.1";
    } else if (wf.id === "h3_t2v") {
      params = { prompt: F.capH3(spec.prompt), duration, seed: s, loras, aspect: ratio };
      info = `${duration} s → ${P.h3RealDuration(duration).toFixed(2)} s`;
    } else {
      // H3 expects at the head of the prompt the moment each input image stands for.
      params = { prompt: F.capH3(`${P.h3Alignment(!!last, duration)}\n\n${spec.prompt}`), duration, seed: s, loras, image,
                 ...(last ? { last_image: last } : {}) };
      info = `${last ? "FL2VA" : "I2VA"} · ${duration} s → ${P.h3RealDuration(duration).toFixed(2)} s`;
    }
    return runJob(wf.engine, params, { origin, label: spec.label, sub: ["{info} · seed {seed}", { info, seed: s }] });
  });
}

// ── Campaign ──────────────────────────────────────────────────────────────────
// Posters, thumbnails and a social image (Krea 2), plus a vertical H3 teaser. Returns
// the job promises, images first.
const CAMPAIGN_NAMES = { poster: L("posters"), thumbnail: L("thumbnails"), social: L("social image") };
export function runCampaign({ text, styleId, count, duration, seed, origin = "campaign" }) {
  const jobs = P.CAMPAIGN_IMAGES.map((img, i) => runJob("krea2-t2i", {
    prompt: P.campaignPrompt(text, img.suffix, styleId), width: img.width, height: img.height,
    count: img.batch ? count : 1, seed: F.seedPlus(seed, 200 + i),
  }, { origin, label: ["Campaign · {name}", { name: t(CAMPAIGN_NAMES[img.name]) }],
       sub: ["{info} · seed {seed}", { info: `${img.width}×${img.height}`, seed: F.seedPlus(seed, 200 + i) }] }));
  jobs.push(runJob("h3-t2v", {
    prompt: F.capH3(P.campaignPrompt(text, P.CAMPAIGN_TEASER, styleId)), duration, seed, aspect: "9:16", loras: [],
  }, { origin, label: ["Campaign · teaser"], sub: ["{info} · seed {seed}", { info: `9:16 · ${duration} s`, seed }] }));
  return jobs;
}
