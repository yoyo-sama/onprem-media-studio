#!/usr/bin/env python3
"""Three character sheets for the 3-minute anime, Krea 2 Turbo + the retroanime LoRA,
two candidates each, through the Studio's HTTP API (the same job Text2Image sends).
Refuses to start when the queue is not empty. Writes sheets.json next to this file.

    python3 sheets.py [http://localhost:8090]
"""
import json, sys, time, urllib.request
from pathlib import Path

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8090").rstrip("/")
HERE = Path(__file__).resolve().parent

STYLE = ("Character model sheet of one original character drawn in the style of a 1990s Japanese TV anime: "
         "hand-drawn cel animation look, bold clean black outlines, flat cel shading with crisp two-tone shadows, "
         "bright saturated colors, rounded friendly shapes, big expressive eyes, playful humorous adventure manga feel. ")
LAYOUT = ("The sheet shows the same character four times side by side across a plain flat off-white background, full body, "
          "at the same scale: front view, three-quarter view, side profile view and back view, standing in a relaxed neutral pose, "
          "plus one large head close-up with a happy expression in the top left corner. Every view shows exactly the same design, "
          "colors and proportions. Clean flat off-white background, no scenery, no text, no letters, no labels, no captions, "
          "no logo, no panel borders, no grid lines.")
CHARACTERS = {
    "riko": "The character: a cheerful 12-year-old courier girl, small, energetic and slightly chubby-cheeked, big round "
            "dark-brown eyes, short messy teal bob haircut with one upturned cowlick, rosy cheeks, wide toothy grin. She wears an "
            "oversized round white aviator helmet with big amber goggles pushed up on the forehead, a bright red short-sleeved "
            "jumpsuit with rolled-up legs, a long yellow scarf, brown fingerless gloves, chunky white sneakers with red soles, "
            "and a brown leather courier satchel across her chest. ",
    "kettle": "The character: a small round sidekick robot shaped like a plump sky-blue enamel teapot, about knee height, "
              "with a short curved spout as its nose, a round lid on top with a red knob like a tiny hat, two big round black "
              "button eyes with white highlights, a small smiling mouth, a curved handle on its back, short stubby white "
              "mechanical legs with round feet, two small flexible hose arms with three-fingered white hands, and a few brass "
              "rivets. It is a robot, not a human: no hair, no clothes. ",
    "baron": "The character: a tall, very skinny, comically pompous sky-pirate gentleman in his fifties, long thin legs, "
             "pointed chin, an enormous curly black handlebar moustache much wider than his face, bushy black eyebrows, a small "
             "round monocle on his right eye, a purple long-tailed coat with big gold buttons, a white frilly cravat, green and "
             "yellow striped trousers, shiny black knee boots, and a small brass propeller cap on his head. ",
}
LORA = [{"name": "retroanime.safetensors", "strength": 0.8}]


def call(path, body=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"} if body is not None else {})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


health = call("/api/health")
if health.get("queue"):
    sys.exit(f"The queue is not empty ({health['queue']} job(s)): nothing submitted.")
jobs = {}
for i, (name, desc) in enumerate(CHARACTERS.items()):
    params = {"prompt": STYLE + desc + LAYOUT, "width": 1920, "height": 1088, "count": 2, "seed": 4242 + i, "loras": LORA}
    job = call("/api/jobs", {"pipeline": "krea2-t2i", "params": params, "origin": "anime3min"})
    jobs[name] = job["id"]
    print(f"{name}: job {job['id']}", flush=True)
result = {}
for name, jid in jobs.items():
    while True:
        j = call(f"/api/jobs/{jid}")
        if j["status"] not in ("queued", "running"):
            break
        time.sleep(5)
    result[name] = {"job": jid, "status": j["status"], "outputs": j.get("outputs"), "error": j.get("error")}
    print(f"{name}: {j['status']} {j.get('outputs')}", flush=True)
(HERE / "sheets.json").write_text(json.dumps(result, indent=2))
print("sheets.json written")
