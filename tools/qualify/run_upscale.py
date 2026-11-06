"""Upscale ×2 the latest renders of the gallery on a running server and time each job.

    python tools/qualify/run_upscale.py                     # http://localhost:8090
    python tools/qualify/run_upscale.py --videos 2

Takes the latest Krea 2 image, the latest Qwen Image 2.1 image and the latest H3
videos, and posts one upscale-2x job for each, exactly as the gallery's
"Upscale ×2" click posts it. The report gives each source and its copy side by
side: the upscaler is qualified when a person has compared them at 100 %
(docs/IMAGE-ENGINES.md § Upscale ×2), never because the jobs ended "done".
The network's own time per job is in the container log: docker logs studio 2>&1 | grep 'render: upscale-2x'.
Standard library only: it runs with the host's python3, outside the container.
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


class Client:
    def __init__(self, base: str):
        self.base = base.rstrip("/")

    def call(self, path: str, body: dict | None = None) -> tuple[int, dict]:
        req = urllib.request.Request(self.base + path, method="POST" if body is not None else "GET",
                                     data=None if body is None else json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                return res.status, json.loads(res.read() or b"{}")
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read() or b"{}")

    def get(self, path: str) -> dict:
        status, body = self.call(path)
        if status != 200:
            raise SystemExit(f"GET {path}: HTTP {status} {body}")
        return body


def latest(client, kind: str, pipeline: str | None, n: int) -> list[dict]:
    query = {"type": kind, "limit": n, **({"pipeline": pipeline} if pipeline else {})}
    items = client.get("/api/gallery/assets?" + urllib.parse.urlencode(query))["items"]
    return [a for a in items if a.get("pipeline") != "upscale-2x"]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", default="http://localhost:8090")
    parser.add_argument("--videos", type=int, default=1, help="how many of the latest H3 videos")
    parser.add_argument("--report", default="qualify-upscale.json")
    args = parser.parse_args()

    client = Client(args.server)
    sources = latest(client, "image", "krea2-t2i", 1) + latest(client, "image", "qwen-image-2.1", 1)
    sources += [a for a in latest(client, "video", None, 20) if a.get("pipeline", "").startswith("h3-")][:args.videos]
    if not sources:
        raise SystemExit("No Krea 2, Qwen Image 2.1 or H3 render in the gallery: render one first.")
    report = []
    for a in sources:
        status, job = client.call("/api/jobs", {"pipeline": "upscale-2x", "params": {"source": a["ref"]}, "origin": "studio"})
        if status != 201:
            print(f"{a['ref']}: refused: {job.get('detail')}", file=sys.stderr)
            continue
        while job["status"] in ("queued", "running"):
            time.sleep(1)
            job = client.get(f"/api/jobs/{job['id']}")
            print(f"\r{a['ref']}: {job['status']} {job['progress']:.0%} {job['message'][:50]:<50}", end="")
        seconds = (job["finished"] or 0) - (job["started"] or 0)
        print(f"\r{a['ref']} ({a.get('w')}×{a.get('h')}): {job['status']} in {seconds:.1f} s{' ' * 50}")
        if job["status"] != "done":
            print(f"  {job['error']}", file=sys.stderr)
        report.append({"source": f"{args.server}/{a['ref']}", "size": [a.get("w"), a.get("h")],
                       "status": job["status"], "seconds": round(seconds, 1), "error": job["error"],
                       "outputs": [f"{args.server}/{o}" for o in job["outputs"]]})
    Path(args.report).write_text(json.dumps(report, indent=2) + "\n")
    print(f"Report: {args.report}")
    return 0 if report and all(r["status"] == "done" for r in report) else 1


if __name__ == "__main__":
    sys.exit(main())
