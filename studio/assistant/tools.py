"""Tools the creative assistant can call, one per Studio pipeline, plus two for the
conversation itself (ask_choices, handoff).

A generation tool never renders anything: the browser turns the call into an action
card, and the user's click on that card runs the same code as the Studio form.
`normalize()` checks a call against its schema here, so a card never carries a
parameter the Studio would reject or silently drop: values out of range are brought
back into range and the card shows a warning.
"""

import json

RATIOS = ["16:9", "9:16", "1:1", "4:5"]
# Ids of web/js/prompts.js STYLE_PACKS (tests/test_assistant.py keeps them equal).
STYLES = ["none", "editorial", "analog35", "documentary", "cinematic", "noir", "arthouse", "scifi",
          "quiet_luxury", "product", "anime", "screenprint", "oil", "dreamlike"]
# Market presets of the Studio's local versions (web/js/generate.js MARKETS).
MARKETS = ["na", "latam", "europe", "mea", "africa", "asia"]
MIN_SECONDS, MAX_SECONDS = 5, 15


class ToolError(ValueError):
    pass


def _str(desc):
    return {"type": "string", "description": desc}


def _int(desc, low, high, default):
    return {"type": "integer", "description": f"{desc} ({low} to {high}, default {default})",
            "minimum": low, "maximum": high, "default": default}


def _enum(desc, values, default=None):
    out = {"type": "string", "enum": values, "description": desc}
    if default is not None:
        out["default"] = default
    return out


def _ids(desc, low, high):
    return {"type": "array", "items": {"type": "string"}, "minItems": low, "maxItems": high, "description": desc}


IMAGE_ID = "Id of an image from the reference table (A1, C2#1…)"
DURATION = _int("Clip length in seconds", MIN_SECONDS, MAX_SECONDS, 5)
RATIO = _enum("Aspect ratio", RATIOS, "16:9")
STYLE = _enum("Style preset added to the prompt", STYLES, "none")

# name → (description, properties, required). The order is the order the model sees.
SCHEMAS: dict[str, tuple[str, dict, list[str]]] = {
    "ask_choices": (
        "Ask the user one question shown as buttons. The last option is always free text (added by the app). "
        "Their answer arrives as their next message. Use it for every question.",
        {"question": _str("The question, short"),
         "options": {"type": "array", "items": {"type": "string"}, "minItems": 2, "maxItems": 4,
                     "description": "2 to 4 concrete options, each a short result-oriented phrase"}},
        ["question", "options"]),
    "handoff": (
        "Hand the conversation to another role when the request belongs to it.",
        {"role": _str("Id of the role taking over"), "goal": _str("What that role must achieve, one sentence")},
        ["role", "goal"]),
    "create_image": (
        "Card: text to image. Krea 2 Turbo (default) for photorealism and posters; Qwen Image 2.1 when the image "
        "must carry legible text.",
        {"prompt": _str("Image prompt in English, positive wording"),
         "engine": _enum("Engine", ["krea2", "qwen"], "krea2"), "ratio": RATIO,
         "count": _int("Number of variants", 1, 4, 1), "style": STYLE},
        ["prompt"]),
    "edit_image": (
        "Card: edit an image with Qwen Image 2.1. The input image is <image1>, references are <image2>…; "
        "cite them in the instruction. The result keeps the input image's size. With markets: one render per market.",
        {"instruction": _str("Edit instruction in English: what changes and what stays"),
         "image": _str(IMAGE_ID + " for the image to edit"),
         "references": _ids("Extra reference images, " + IMAGE_ID, 0, 9),
         "markets": {"type": "array", "items": {"type": "string", "enum": MARKETS},
                     "description": "Market presets, one render each (na, latam, europe, mea, africa, asia)"}},
        ["instruction", "image"]),
    "character_sheet": (
        "Card: a character sheet (multi-view reference, neutral light) of one subject; from a photo of it when "
        "one is given.",
        {"description": _str("What the subject is, in English: face, build, hair, costume, materials. No scene."),
         "photo": _ids("The image of this very subject the user gave (photo or drawing), to draw the sheet from; "
                       "always pass it when the user attached one. " + IMAGE_ID, 0, 1),
         "kind": _enum("human for a person, other for an animal, creature, robot or object", ["human", "other"], "human"),
         "style": STYLE},
        ["description"]),
    "location_sheet": (
        "Card: a setting sheet (multi-view reference of one empty place, Krea 2).",
        {"description": _str("What the place is, in English: architecture, layout, materials, palette, light"),
         "style": STYLE},
        ["description"]),
    "video_from_text": (
        "Card: MiniMax H3 text to video with native sound, one continuous shot.",
        {"prompt": _str("Video prompt in English: subject, action, camera move, light, sound"),
         "duration": DURATION, "ratio": RATIO},
        ["prompt"]),
    "video_from_image": (
        "Card: MiniMax H3 image to video, starting on the image; with last_image the clip ends on it "
        "(first and last frame).",
        {"prompt": _str("Motion prompt in English: what moves, the camera, the sound"),
         "image": _str(IMAGE_ID + " for the first frame"),
         "last_image": _str(IMAGE_ID + " for the last frame (optional)"),
         "duration": DURATION},
        ["prompt", "image"]),
    "image_sequence": (
        "Card: a clip through 2 to 6 key images, one H3 segment per pair (first and last frame), joined.",
        {"prompt": _str("Motion prompt in English, shared by every segment"),
         "images": _ids("Key images in order, " + IMAGE_ID, 2, 6),
         "duration": _int("Length of each segment in seconds", MIN_SECONDS, MAX_SECONDS, 5)},
        ["prompt", "images"]),
    "join_videos": (
        "Card: join clips end to end with hard cuts.",
        {"clips": _ids("Clips in order, ids of videos from the reference table", 2, 32)},
        ["clips"]),
    "campaign": (
        "Card: a full campaign from one brief: posters, thumbnails and a social image (Krea 2) plus a vertical "
        "H3 teaser.",
        {"brief": _str("Campaign brief in English"), "variants": _int("Poster variants", 1, 4, 3),
         "duration": DURATION, "style": STYLE},
        ["brief"]),
    "storyboard": (
        "Card: opens the step-by-step storyboard director with the brief filled in (sheets, shot images, cuts, "
        "each approved by the user).",
        {"brief": _str("The user's story, completed with the staging they settled, in English"),
         "subject_sheets": _ids("Character or subject sheets the conversation already holds, one per recurring "
                                "subject, main subject first; the director uses them instead of drawing new ones, "
                                + IMAGE_ID, 0, 4),
         "setting_sheet": _ids("The setting sheet the conversation already holds, if any, " + IMAGE_ID, 0, 1),
         "shots": _int("Number of shots", 4, 16, 6), "duration": _int("Length of each cut in seconds",
                                                                         MIN_SECONDS, MAX_SECONDS, 5),
         "ratio": RATIO},
        ["brief"]),
    "reference_video": (
        "Card: one MiniMax H3 clip that keeps characters, places and objects from reference images; the user "
        "renders it from the card or opens the step-by-step director.",
        {"brief": _str("What happens in the clip, in English, one continuous shot. Name each reference by its id "
                       "alone, as the subject of the sentence (\"A1 rides a motorcycle along a jungle track, A2 "
                       "charging behind him\"), never \"the man from A1\": each id becomes that reference's "
                       "<Subject N> token in the H3 prompt"),
         "references": _ids("Reference images, main character first, " + IMAGE_ID, 0, 9),
         "kinds": {"type": "array", "items": {"type": "string"}, "maxItems": 9,
                   "description": "Role of each reference, in the same order: character, setting or object"},
         "duration": DURATION, "ratio": RATIO},
        ["brief"]),
}
CONVERSATION_TOOLS = ["ask_choices", "handoff"]
GENERATION_TOOLS = [n for n in SCHEMAS if n not in CONVERSATION_TOOLS]

# One line per engine family, for the instructions of the roles that use it.
ENGINE_NOTES = {
    "create_image": "create_image: Krea 2 Turbo (photorealism, posters; no reliable text) or Qwen Image 2.1 "
                    "(text in the image). Ratios 16:9, 9:16, 1:1, 4:5; 1 to 4 variants.",
    "edit_image": "edit_image: Qwen Image 2.1 editing. The input image is <image1>, up to 9 references "
                  "<image2>…<image10>; one image per render, at the input image's size.",
    "character_sheet": "character_sheet: one subject on a multi-view sheet (1920×1088, neutral light), drawn by "
                       "Krea 2 from the description, or by Qwen Image 2.1 from a photo of the subject (photo).",
    "location_sheet": "location_sheet: one empty place on a multi-view sheet (Krea 2, 1920×1088).",
    "video_from_text": "video_from_text: MiniMax H3, 5 to 15 s, native sound (ambience, voices), one continuous "
                       "shot; the length snaps to the engine's frame grid.",
    "video_from_image": "video_from_image: MiniMax H3 from a first image, optionally to a last image, 5 to 15 s, "
                        "native sound. Each clip also leaves its last frame as an image.",
    "image_sequence": "image_sequence: 2 to 6 key images, one H3 segment per pair, joined.",
    "join_videos": "join_videos: clips end to end, hard cuts.",
    "campaign": "campaign: posters, thumbnails and a social image (Krea 2) plus a 9:16 H3 teaser from one brief.",
    "storyboard": "storyboard: opens the step-by-step director (sheets, shot images with Qwen Image 2.1, H3 cuts); "
                  "the user approves each step. Sheets already in the conversation go in subject_sheets and "
                  "setting_sheet: the director keeps them and draws only the missing ones.",
    "reference_video": "reference_video: H3 keeps characters, places and objects from up to 9 reference images "
                       "(each named by its id in the brief, with its kind); rendered from the card, or through the "
                       "director, which draws sheets first.",
}


def specs(names: list[str]) -> list[dict]:
    """OpenAI tool definitions for llama-server."""
    out = []
    for name in names:
        desc, props, required = SCHEMAS[name]
        out.append({"type": "function", "function": {
            "name": name, "description": desc,
            "parameters": {"type": "object", "properties": props, "required": required}}})
    return out


def engines_text(names: list[str]) -> str:
    return "\n".join(f"- {ENGINE_NOTES[n]}" for n in names if n in ENGINE_NOTES)


def _text(args: dict, key: str, required: bool) -> str | None:
    value = args.get(key)
    if value is None or (isinstance(value, str) and not value.strip()):
        if required:
            raise ToolError(f"{key} is missing")
        return None
    if not isinstance(value, str):
        raise ToolError(f"{key} must be text")
    return value.strip()


def normalize(name: str, raw, known_ids) -> tuple[dict, list[str]]:
    """The call's arguments as the card uses them, and warnings for what was changed.
    `raw` is the JSON text (or dict) the model sent; `known_ids(id)` tells whether an
    image id exists in the conversation. ToolError when the call cannot become a card."""
    if name not in SCHEMAS:
        raise ToolError(f"unknown tool {name!r}")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw or "{}")
        except ValueError as exc:
            raise ToolError(f"arguments are not JSON ({exc})") from exc
    if not isinstance(raw, dict):
        raise ToolError("arguments must be an object")
    _, props, required = SCHEMAS[name]
    out, warnings = {}, []
    for key, prop in props.items():
        if key not in raw or raw[key] is None:
            if key in required:
                raise ToolError(f"{key} is missing")
            if "default" in prop:
                out[key] = prop["default"]
            continue
        value = raw[key]
        kind = prop["type"]
        if kind == "string" and "enum" in prop:
            if value not in prop["enum"]:
                fallback = prop.get("default", prop["enum"][0])
                warnings.append(f"{key} {value!r} unknown, {fallback!r} used")
                value = fallback
        elif kind == "string":
            value = _text(raw, key, key in required)
            if value is None:
                continue
        elif kind == "integer":
            try:
                number = int(round(float(value)))
            except (TypeError, ValueError):
                number = prop["default"]
                warnings.append(f"{key} {value!r} is not a number, {number} used")
            clamped = min(prop["maximum"], max(prop["minimum"], number))
            if clamped != number:
                warnings.append(f"{key} {number} out of range, {clamped} used")
            value = clamped
        elif kind == "array":
            if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
                raise ToolError(f"{key} must be a list of ids")
            allowed = prop["items"].get("enum")
            if allowed:
                value = [v for v in dict.fromkeys(value) if v in allowed]
            if len(value) > prop["maxItems"]:
                warnings.append(f"{key}: only the first {prop['maxItems']} kept")
                value = value[:prop["maxItems"]]
            if len(value) < prop.get("minItems", 0):
                raise ToolError(f"{key} needs at least {prop['minItems']} items")
        out[key] = value
    unknown = sorted(set(raw) - set(props))
    if unknown:
        warnings.append("ignored: " + ", ".join(unknown))
    for key in ("image", "last_image", "references", "images", "clips", "subject_sheets", "setting_sheet", "photo"):
        for ref in ([out[key]] if isinstance(out.get(key), str) else out.get(key) or []):
            if not known_ids(ref):
                warnings.append(f"{ref} is not in the reference table")
    return out, warnings
