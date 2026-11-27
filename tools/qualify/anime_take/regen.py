#!/usr/bin/env python3
"""Regenerate segments 3, 4 and 6 of take 3 of the 3-minute anime with new seeds, then stitch
take 3 again and join the three takes again. Each job is the one the Studio sent (its `request`),
only the seed and the clips it waits for change. Refuses when the queue is not empty.
Writes regen.json next to this file.

    python3 regen.py [http://localhost:8090]
"""
import json, sys, time, urllib.request
from pathlib import Path

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8090").rstrip("/")
HERE = Path(__file__).resolve().parent
P = "job-cd0f95-"
SEGMENTS = [P + "20", P + "21", P + "23"]          # take 3: segments 3, 4 and 6
STITCH, TAKE1, TAKE2 = P + "24", P + "10", P + "17"
SEED_SHIFT = 7919


def call(path, body=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"} if body is not None else {})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def swap(value, ids):
    """The request with every {"job": old} that was regenerated pointing at its new job."""
    if isinstance(value, dict) and set(value) == {"job", "output"}:
        return {"job": ids.get(value["job"], value["job"]), "output": value["output"]}
    if isinstance(value, dict):
        return {k: swap(v, ids) for k, v in value.items()}
    if isinstance(value, list):
        return [swap(v, ids) for v in value]
    return value


def wait(jid):
    while True:
        j = call(f"/api/jobs/{jid}")
        if j["status"] not in ("queued", "running"):
            return j
        time.sleep(10)


if call("/api/health").get("queue"):
    sys.exit("The queue is not empty: nothing submitted.")
ids, log = {}, {"segments": []}
for old_id in SEGMENTS:
    old = call(f"/api/jobs/{old_id}")
    req = swap(old["request"], ids)
    req["seed"] = (old["params"]["seed"] + SEED_SHIFT) % (2**31)
    new = call("/api/jobs", {"pipeline": old["pipeline"], "params": req, "origin": "anime3min"})
    ids[old_id] = new["id"]
    log["segments"].append({"old": old_id, "new": new["id"], "seed": req["seed"],
                            "continue_from": req.get("continue_from")})
    print(f"{old_id} -> {new['id']} seed {req['seed']} continue_from {req.get('continue_from')}", flush=True)
old = call(f"/api/jobs/{STITCH}")
stitch = call("/api/jobs", {"pipeline": "video-stitch", "params": swap(old["request"], ids), "origin": "anime3min"})
print(f"stitch {stitch['id']}: {swap(old['request'], ids)}", flush=True)
log["stitch"] = stitch["id"]
for jid in list(ids.values()) + [stitch["id"]]:
    j = wait(jid)
    print(f"{jid}: {j['status']} {j.get('outputs')} {j.get('error') or ''}", flush=True)
    if j["status"] != "done":
        log["failed"] = jid
        (HERE / "regen.json").write_text(json.dumps(log, indent=2))
        sys.exit(1)
mp4 = lambda j: next(o for o in j["outputs"] if o.endswith(".mp4"))
clips = [mp4(call(f"/api/jobs/{TAKE1}")), mp4(call(f"/api/jobs/{TAKE2}")), mp4(call(f"/api/jobs/{stitch['id']}"))]
film = call("/api/jobs", {"pipeline": "video-concat", "params": {"clips": clips, "smooth_audio": True}, "origin": "anime3min"})
j = wait(film["id"])
log["film"] = {"id": film["id"], "status": j["status"], "outputs": j.get("outputs"), "error": j.get("error"), "clips": clips}
print(f"film {film['id']}: {j['status']} {j.get('outputs')}", flush=True)
(HERE / "regen.json").write_text(json.dumps(log, indent=2))
