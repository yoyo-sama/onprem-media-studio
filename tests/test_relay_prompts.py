"""Relay prompts (web/js/prompts.js): the look shared by every segment is written once,
and a segment's prompt adds nothing the user did not write or approve."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

PROMPTS = Path(__file__).resolve().parent.parent / "web" / "js" / "prompts.js"
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")


def run(code: str):
    script = f"const P = require({json.dumps(str(PROMPTS))});\n(async () => {{ {code} }})();"
    done = subprocess.run(["node", "-e", script], capture_output=True, text=True, timeout=30)
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


def segment_prompt(look):
    return run(f"""console.log(JSON.stringify(P.buildRelaySegmentPrompt("<Subject 1> walks along the path; the camera tracks backward",
        {json.dumps(look)}, [{{desc: "a woman in a green coat"}}], "a walled garden", 10, false, "none")));""")


def field(prompt: str, name: str) -> str:
    return prompt.split(f"{name}:\n", 1)[1].split("\n\n", 1)[0]


def test_shared_look_goes_into_every_field():
    p = segment_prompt({"camera": "medium shots at eye level", "lighting": "Soft morning sunlight",
                        "sound": "Birdsong and footsteps", "music": "a gentle piano"})
    assert field(p, "detailed_description") == ("<Subject 1> is in <Subject 2>. <Subject 1> walks along the path; the camera "
                                                "tracks backward. Soft morning sunlight. Framing: medium shots at eye level.")
    assert field(p, "overall_soundscape") == "Birdsong and footsteps"
    assert field(p, "non_diegetic_music") == "a gentle piano"
    assert field(p, "summary").endswith("<Subject 1> walks along the path; the camera tracks backward")


def test_empty_look_adds_no_light_or_camera():
    p = segment_prompt({})
    body = field(p, "detailed_description")
    assert body == "<Subject 1> is in <Subject 2>. <Subject 1> walks along the path; the camera tracks backward."
    assert "golden" not in p and "steady framing" not in p
    assert field(p, "non_diegetic_music") == "None."


def test_compose_scenario_returns_segments_and_look():
    out = run("""const answer = {framing: "medium shots", lighting: "soft light, 8k", soundscape: "birdsong", music: "N/A",
                   segments: ["SUBJECTREF1 walks.", "", "SUBJECTREF1 stops."]};
      const calls = [];
      const llm = async (system, user) => { calls.push(system); return answer; };
      const res = await P.composeScenario(llm, "a walk", 2, "a garden", 10, [{desc: "a woman"}]);
      console.log(JSON.stringify({res, system: calls[0]}));""")
    assert out["res"]["segments"] == ["<Subject 1> walks.", "<Subject 1> stops."]
    assert out["res"]["look"] == {"camera": "medium shots", "lighting": "soft light", "sound": "birdsong", "music": ""}
    assert "exactly 2 segments" in out["system"] and '"soundscape"' in out["system"]
