// Builds tools/qualify/image_cases.json from the prompt compilers of a 1.4 checkout,
// so that the 2.0 engines are qualified on exactly the prompts 1.4 sends.
//
//   node tools/qualify/export_1_4_prompts.js ../dellaicontent > tools/qualify/image_cases.json
//
// The 1.4 code is only executed to read its output; nothing of it is copied here.
"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const repo = path.resolve(process.argv[2] || "../dellaicontent");
require(path.join(repo, "js/engine.js"));
const E = globalThis.Engine;
const commit = execSync("git rev-parse --short HEAD", { cwd: repo }).toString().trim();

// The campaign suffixes live in index.html (buildCampaignFullGraph), not in engine.js.
const studio = fs.readFileSync(path.join(repo, "index.html"), "utf8");
const noLettering = studio.match(/const NO_LETTERING = "([^"]+)";/)[1];
const campaignSuffix = name =>
  studio.match(new RegExp(`\\["${name}", \\d+, \\d+, \\w+, \`([^\`]+)\`\\]`))[1].replace("${NO_LETTERING}", noLettering);

const STYLE = "cinematic";
const style = E.styleTextFor(STYLE);
const brief = "A lighthouse keeper repairing the lamp of an old stone lighthouse at dusk, storm clouds over the sea";

const human = {
  kind: "human",
  face: "a weathered man in his sixties with a short grey beard and deep-set blue eyes",
  hair: "short wavy grey hair",
  outfit: "a dark navy wool fisherman sweater, oilskin trousers and black rubber boots",
  accessories: "a brass pocket watch on a chain",
  palette: "navy, slate grey and brass",
};
const lion = {
  kind: "other",
  subject: "an adult male lion",
  form: "a powerful quadruped on four legs with a thick dark mane",
  surface: "short tawny fur, darker mane",
  details: "amber eyes, a scar across the nose",
  palette: "tawny gold and dark brown",
};
const setting = {
  place: "the lamp room at the top of an old stone lighthouse on a rocky coast",
  architecture: "a round room with tall windows all around and a huge Fresnel lens in the centre",
  materials: "whitewashed stone, brass fittings, worn wooden floor",
  lighting: "fading dusk light through the windows",
  palette: "slate blue, brass and warm white",
};
const charDesc = E.charDescFromFields(human);
const lionDesc = E.charDescFromFields(lion);
const locDesc = E.locDescFromFields(setting);
const shot = { camera: "medium", lighting: "golden_hour", emotion: "calm concentration", extra: "",
  action: "the keeper kneels beside the great lens and tightens a brass screw with a small wrench" };
const shotDual = { camera: "wide", lighting: "golden_hour", emotion: "", extra: "",
  action: "the keeper stands face to face with the lion, one hand raised slowly towards its mane" };
const keyframe = (s, subjects) => E.compileKeyframePrompt(s, subjects, locDesc, STYLE);
const solo = keyframe(shot, [{ desc: charDesc, kind: "human" }]);
const dual = keyframe(shotDual, [{ desc: charDesc, kind: "human" }, { desc: lionDesc, kind: "other" }]);
const SEED = 42;
const SHEET = { width: 1920, height: 1088, seed: SEED };  // 1.4 sheets: 16:9 1920×1088, one image

const cases = [
  { id: "t2i", pipeline: "krea2-t2i", compare: "1.4 Text2Image, Krea 2 Turbo, 16:9, 2 variants, style cinematic",
    params: { prompt: `${brief} ${style}`, width: 1280, height: 720, count: 2, seed: SEED } },
  ...[["poster", 832, 1216, 2], ["thumbnail", 1280, 720, 2], ["social", 1024, 1024, 1]].map(([name, w, h, count], i) => ({
    id: `campaign-${name}`, pipeline: "krea2-t2i", compare: `1.4 campaign_full, ${name} (seed + ${200 + i})`,
    params: { prompt: `${brief} ${campaignSuffix(name)} ${style}`, width: w, height: h, count, seed: SEED + 200 + i } })),
  { id: "sheet-human", pipeline: "krea2-t2i", compare: "1.4 storyboard_v2, subject sheet, human, turnaround template",
    params: { prompt: E.charsheetPromptFrom(charDesc, "human", "turnaround", STYLE), ...SHEET } },
  { id: "sheet-lion", pipeline: "krea2-t2i", compare: "1.4 storyboard_v2, subject sheet, non-human (lesson #25: no costumed biped)",
    params: { prompt: E.charsheetPromptFrom(lionDesc, "other", "turnaround", STYLE), ...SHEET } },
  { id: "sheet-setting", pipeline: "krea2-t2i", compare: "1.4 storyboard_v2, setting sheet",
    params: { prompt: E.locsheetPromptFrom(locDesc, STYLE), ...SHEET } },
  { id: "shot-21-solo", pipeline: "qwen-image-2.1", compare: "1.4 storyboard_v2_qwen21 keyframe, one subject, 1344×768",
    params: { prompt: solo, subjects: ["@sheet-human"], setting: "@sheet-setting", width: 1344, height: 768, seed: SEED } },
  { id: "shot-21-dual", pipeline: "qwen-image-2.1", compare: "1.4 storyboard_v2_qwen21 keyframe, two subjects, 1344×768",
    params: { prompt: dual, subjects: ["@sheet-human", "@sheet-lion"], setting: "@sheet-setting", width: 1344, height: 768, seed: SEED } },
  { id: "i2i-21", pipeline: "qwen-image-2.1", compare: "1.4 Image2Image, Qwen Image 2.1 (size follows the input)",
    params: { prompt: "Turn the scene into a snowy winter night, snow covering the rocks and the lighthouse, keep the composition unchanged.",
      images: ["@campaign-thumbnail"], seed: SEED } },
  { id: "i2i-21-refs", pipeline: "qwen-image-2.1", compare: "1.4 Image2Image, Qwen Image 2.1 with one extra reference",
    params: { prompt: "Place the lion from <image2> on the rocks in front of the lighthouse in <image1>, keep the rest of <image1> unchanged.",
      images: ["@campaign-thumbnail", "@sheet-lion"], seed: SEED } },
  { id: "t2i-21", pipeline: "qwen-image-2.1", compare: "1.4 Text2Image, Qwen Image 2.1, 16:9 (1.4: 1280×720; 2.0 needs multiples of 32)",
    params: { prompt: brief, width: 1344, height: 768, count: 1, seed: SEED } },
];

process.stdout.write(JSON.stringify({
  _comment: "Generated by export_1_4_prompts.js; '@<id>' stands for the first output of that case.",
  source: `yoyo-sama/dellaicontent@${commit}`,
  cases,
}, null, 2) + "\n");
