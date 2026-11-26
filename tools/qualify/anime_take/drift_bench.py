#!/usr/bin/env python3
"""Drift bench on the anime takes (GB10). Two hypotheses, each against the render that showed
the defect, with the SAME seed and the same request; only the prompt changes.

1. Doubled subject: Gemma's description of a sheet ("a girl shown in four poses") makes H3 draw
   the subject twice. Gemma describes the 3 sheets with the current instruction and with the
   new one (3 runs each); every description is checked for layout words (views, poses...).
2. Cuts inside a clip: nothing in a segment's prompt says it is one shot, and H3 (trained on
   edited videos) cuts or dissolves inside a 10 s clip. Clips that cut are rendered again with
   one sentence added to detailed_description.

Writes bench.json next to this file. Refuses when the queue is not empty.
    python3 drift_bench.py [http://localhost:8090]
"""
import base64, json, re, sys, time, urllib.request
from pathlib import Path

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8090").rstrip("/")
HERE = Path(__file__).resolve().parent
P = "job-cd0f95-"

OLD_VISION = ('You are describing a reference image for a video model. Describe ONLY what is visibly present, so the subject '
              'stays IDENTICAL across shots. No camera, scene, action or mood wording, no speculation about story. Answer ONLY '
              'with JSON with these fields, each a dense ~10-20 word English string: {"subject":"...","appearance":"...",'
              '"materials":"...","palette":"..."}.')
NEW_VISION = ('You are describing a reference image for a video model. The image shows ONE subject (a person, an animal, '
              'a thing or a place); a reference sheet may draw or photograph it several times (views, poses, close-ups). '
              'Describe that subject ONCE, as the single thing it is, so it stays IDENTICAL across shots: what it is and how '
              'it looks. Never mention views, poses, angles, a sheet, a layout, how many times it is shown, or the plain '
              'background behind it. No camera, scene, action or mood wording, no speculation about story. Answer ONLY with '
              'JSON with these fields, each a dense ~10-20 word English string: {"subject":"...","appearance":"...",'
              '"materials":"...","palette":"..."}.')
FIELDS = ["subject", "appearance", "materials", "palette"]
LAYOUT = re.compile(r"\b(views?|poses?|angles?|turnaround|sheet|headshots?|close-?ups?|multiple|several times|"
                    r"(?:plain|white|off-white|grey|gray|neutral|blank|pale)[\w\s-]{0,12}(?:background|backdrop))\b", re.I)
CONT = ("The whole clip is one single continuous shot from its first frame to its last: the camera never cuts away "
        "and never dissolves to another view.")
ONCE = " Each character appears exactly once in the frame."
SHEETS = ["sheets/riko.png", "sheets/kettle.png", "sheets/baron.png"]
CUT_CLIPS = [P + "9", P + "13", P + "16"]   # take 1 seg 6 (cut at 56.3 s), take 2 seg 3 (20.5 s), seg 6 (50.1 s)
DOUBLE_CLIP = P + "28"                       # take 3 seg 4 redone from the clean seg 3 (job 27): Riko still doubled


def call(path, body=None, timeout=60):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"} if body is not None else {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def describe(system, image):
    b64 = base64.b64encode((HERE / image).read_bytes()).decode()
    out = call("/api/llm/chat", {"system": system, "prompt": "Describe this reference image.", "images": [b64],
                                 "json_mode": True}, timeout=300)["content"]
    m = re.search(r"\{[\s\S]*\}", out)
    data = json.loads(m.group(0)) if m else {}
    return ", ".join(str(data.get(k, "")).strip() for k in FIELDS if str(data.get(k, "")).strip())


def with_cont(prompt):
    return prompt.replace("\n\noverall_soundscape:", " " + CONT + "\n\noverall_soundscape:", 1)


def wait(jid):
    while True:
        j = call(f"/api/jobs/{jid}")
        if j["status"] not in ("queued", "running"):
            return j
        time.sleep(10)


if call("/api/health").get("queue"):
    sys.exit("The queue is not empty: nothing done.")
bench = {"vision": {}, "renders": []}
for sheet in SHEETS:
    for name, system in (("old", OLD_VISION), ("new", NEW_VISION)):
        runs = [describe(system, sheet) for _ in range(3)]
        bench["vision"].setdefault(sheet, {})[name] = [{"text": r, "layout_words": LAYOUT.findall(r)} for r in runs]
        print(sheet, name, [len(LAYOUT.findall(r)) for r in runs], flush=True)
(HERE / "bench.json").write_text(json.dumps(bench, indent=2))

# The doubled clip: the new descriptions (first run of each sheet) in subject_definitions, the
# once sentence in retention_analysis, the continuity sentence. Same seed, same continuation.
descs = [bench["vision"][s]["new"][0]["text"].rstrip(". ") for s in SHEETS]
jobs = []
old = call(f"/api/jobs/{DOUBLE_CLIP}")
req = dict(old["request"])
prompt = req["prompt"]
def redef(m):
    n = int(m.group(2))
    return f"{m.group(1)}, {descs[n - 1]}." if 1 <= n <= len(descs) else m.group(0)
head, rest = prompt.split("subject_definitions:\n", 1)
defs, tail = rest.split("\n\nsummary:", 1)
defs = "\n".join(re.sub(r"^(<Subject (\d+)> .*?<Picture \d+>)(?:, .*)?\.$", redef, line) for line in defs.split("\n"))
prompt = head + "subject_definitions:\n" + defs + "\n\nsummary:" + tail
prompt = prompt.replace("\n\ndetailed_description:", ONCE + "\n\ndetailed_description:", 1)
req["prompt"], req["seed"] = with_cont(prompt), old["params"]["seed"]
new = call("/api/jobs", {"pipeline": old["pipeline"], "params": req, "origin": "drift-bench"})
jobs.append({"case": "double", "old": DOUBLE_CLIP, "new": new["id"], "prompt": req["prompt"]})
for jid in CUT_CLIPS:
    old = call(f"/api/jobs/{jid}")
    req = dict(old["request"])
    req["prompt"], req["seed"] = with_cont(req["prompt"]), old["params"]["seed"]
    new = call("/api/jobs", {"pipeline": old["pipeline"], "params": req, "origin": "drift-bench"})
    jobs.append({"case": "cut", "old": jid, "new": new["id"]})
for j in jobs:
    r = wait(j["new"])
    j.update(status=r["status"], outputs=r.get("outputs"), error=r.get("error"),
             old_outputs=call(f"/api/jobs/{j['old']}").get("outputs"))
    print(j["case"], j["old"], "->", j["new"], r["status"], flush=True)
bench["renders"] = jobs
(HERE / "bench.json").write_text(json.dumps(bench, indent=2))
print("bench.json written")
