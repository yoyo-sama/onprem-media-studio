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
    assert out["res"]["look"] == {"camera": "medium shots", "lighting": "soft light", "sound": "birdsong", "music": "", "subjects": ""}
    assert "exactly 2 segments" in out["system"] and '"soundscape"' in out["system"]
    # A subject with a reference: its look comes from it, the split is not asked for it.
    assert '"subjects"' not in out["system"]


def test_compose_scenario_asks_the_subjects_look_with_no_reference():
    # A take from the text: the look is only in the scenario, written once in the shared
    # fields (the jacket changed at segment 3 on the GB10, 2026-11-25).
    out = run("""const answer = {framing: "medium shots", lighting: "soft light", soundscape: "birdsong", music: "",
                   subjects: "A woman with short red hair, a denim jacket over a green sweater.", segments: ["She walks.", "She stops."]};
      const calls = [];
      const llm = async (system, user) => { calls.push(system); return answer; };
      const res = await P.composeScenario(llm, "a walk", 2, "", 10, []);
      console.log(JSON.stringify({res, system: calls[0]}));""")
    assert out["res"]["look"]["subjects"] == "A woman with short red hair, a denim jacket over a green sweater."
    assert '"subjects": one English paragraph' in out["system"] and '"subjects": "..."' in out["system"]


# ── Screenplay files (the owner's layout, 2026-11-20) ─────────────────────────

SCREENPLAY = """subject_definitions:
<Subject 1> is the same adult woman shown in the uploaded
starting image. Same outfit throughout.

summary:
A cinematic video of the woman walking through a garden.

retention_analysis:
Preserve the same facial identity.

camera_direction:
16:9 cinematic medium shots, slow smooth tracking.

lighting:
Soft natural morning sunlight.

detailed_description:
[Shot 1] Photorealistic garden, gentle camera movement.

Segment 1 (00:00.000–00:10.000) – Introduction
<Subject 1> stands facing the camera. She blinks
naturally and slowly begins walking.
Segment 2 (00:10.000–00:22.000) – Walking
<Subject 1> continues walking along the garden path.

[Shot 2] Close-up by a flowering tree.
Segment 3 (00:22.000–00:30.000) – Closing
<Subject 1> smiles.

overall_soundscape:
Birdsong and soft footsteps.

non_diegetic_music:
N/A
"""


def parse(text):
    return run(f"console.log(JSON.stringify(P.parseScreenplay({json.dumps(text)})));")


def test_screenplay_file_gives_segments_lengths_and_shared_fields_word_for_word():
    p = parse(SCREENPLAY)
    assert [s["prompt"] for s in p["segments"]] == [
        "<Subject 1> stands facing the camera. She blinks naturally and slowly begins walking. "
        "Photorealistic garden, gentle camera movement.",
        "<Subject 1> continues walking along the garden path.",
        "<Subject 1> smiles. Close-up by a flowering tree."]
    assert [s["duration"] for s in p["segments"]] == [10, 12, 8]
    assert [s["mode"] for s in p["segments"]] == ["continue", "continue", "cut"]
    assert p["look"] == {"camera": "16:9 cinematic medium shots, slow smooth tracking.", "lighting": "Soft natural morning sunlight.",
                         "sound": "Birdsong and soft footsteps.", "music": "",
                         "subjects": "<Subject 1> is the same adult woman shown in the uploaded starting image. Same outfit throughout.",
                         "retention": "Preserve the same facial identity."}
    assert p["scene"] == "A cinematic video of the woman walking through a garden. Photorealistic garden, gentle camera movement."


def test_screenplay_of_a_described_scene_without_subject_markers_or_timestamps():
    p = parse("detailed_description:\n[Shot 1] A misty pine forest at dawn.\nSegment 1 – The deer\nA deer steps out of the fog.\n"
              "Segment 2: The deer walks to a stream.\n")
    assert [s["prompt"] for s in p["segments"]] == ["A deer steps out of the fog. A misty pine forest at dawn.",
                                                    "The deer walks to a stream."]
    assert [s["duration"] for s in p["segments"]] == [0, 0] and p["given"] == []
    # Shots with no segment line: one segment per shot, a later one a cut.
    p = parse("[Shot 1] A city street at night, rain.\n[Shot 2] A taxi stops.")
    assert [(s["prompt"], s["mode"]) for s in p["segments"]] == [("A city street at night, rain.", "continue"), ("A taxi stops.", "cut")]
    assert parse("A woman walks in a garden and smiles.") is None


def test_shared_subjects_and_retention_follow_the_app_definitions():
    p = segment_prompt({"subjects": "<Subject 1> wears a red scarf.", "retention": "Same scarf in every shot."})
    assert field(p, "subject_definitions").endswith("\n<Subject 1> wears a red scarf.")
    assert field(p, "retention_analysis").endswith("\nSame scarf in every shot.")
    # Empty: the prompt is the one the app always sent.
    assert segment_prompt({"subjects": "", "retention": ""}) == segment_prompt({})


def test_text_segment_has_no_picture_and_no_task_tag():
    p = run("""console.log(JSON.stringify(P.buildRelayTextPrompt("<Subject 1> walks along the path",
        {subjects: "<Subject 1> is a woman in a green coat.", lighting: "Soft light", sound: "Birdsong"}, "none")));""")
    assert "<Picture" not in p and "[reference generation]" not in p
    assert field(p, "subject_definitions") == "<Subject 1> is a woman in a green coat."
    assert field(p, "summary") == "<Subject 1> walks along the path"
    assert field(p, "detailed_description") == "<Subject 1> walks along the path. Soft light."
    assert field(p, "retention_analysis") == "—"
