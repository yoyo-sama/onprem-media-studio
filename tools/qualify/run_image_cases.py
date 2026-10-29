"""Render the image qualification cases on a running server, one after the other.

    python tools/qualify/run_image_cases.py                    # every case, http://localhost:8090
    python tools/qualify/run_image_cases.py --only sheet-human shot-2509-solo

Each case is a job posted to /api/jobs, exactly as a client click would post it;
'@<id>' in a case is replaced by the first output of that earlier case (a shot
uses the sheets just rendered). The script only renders: a case is qualified
when a person has looked at the images next to the 1.4 render of the same
prompt (docs/IMAGE-ENGINES.md § Qualification), never because its job ended "done".
"""

import argparse
import json
import sys
import time
from pathlib import Path

import httpx

CASES = Path(__file__).with_name("image_cases.json")


def substitute(value, outputs):
    if isinstance(value, list):
        return [substitute(v, outputs) for v in value]
    if isinstance(value, str) and value.startswith("@"):
        if not outputs.get(value[1:]):
            raise SystemExit(f"Case needs {value[1:]}, which has no output in this run")
        return outputs[value[1:]][0]
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", default="http://localhost:8090")
    parser.add_argument("--only", nargs="*", help="case ids (their '@' dependencies must be listed too)")
    parser.add_argument("--report", default="qualify-images.json")
    args = parser.parse_args()

    cases = json.loads(CASES.read_text())["cases"]
    if args.only:
        cases = [c for c in cases if c["id"] in args.only]
    client = httpx.Client(base_url=args.server, timeout=30)
    outputs, report = {}, []
    for case in cases:
        params = {k: substitute(v, outputs) for k, v in case["params"].items()}
        job = client.post("/api/jobs", json={"pipeline": case["pipeline"], "params": params})
        job.raise_for_status()
        job = job.json()
        while job["status"] in ("queued", "running"):
            time.sleep(2)
            job = client.get(f"/api/jobs/{job['id']}").json()
            print(f"\r{case['id']}: {job['status']} {job['progress']:.0%} {job['message'][:60]:<60}", end="")
        seconds = (job["finished"] or 0) - (job["started"] or 0)
        print(f"\r{case['id']}: {job['status']} in {seconds:.0f} s {' ' * 60}")
        if job["status"] != "done":
            print(f"  {job['error']}", file=sys.stderr)
        outputs[case["id"]] = job["outputs"]
        report.append({"id": case["id"], "compare": case["compare"], "status": job["status"],
                       "seconds": round(seconds), "error": job["error"],
                       "outputs": [f"{args.server}/{o}" for o in job["outputs"]]})
    Path(args.report).write_text(json.dumps(report, indent=2) + "\n")
    print(f"Report: {args.report}")
    return 0 if all(r["status"] == "done" for r in report) else 1


if __name__ == "__main__":
    sys.exit(main())
