"""Every English interface string of the Studio and the Canvas has its French, Spanish
and German translation in web/js/i18n-dict.js, with the same {placeholders}.

The strings are collected without a browser: the text and translated attributes of
web/index.html and web/canvas.html outside [data-raw], and the string literals the
scripts pass to the functions that translate them (t, tx, txAttr, L, log, notice, say,
undoToast and a few local helpers, both branches of a ternary among them), the values of the `label`,
`sub`, `title`, `hint` and `applyLabel` keys (runJob, the prompt editor), literals set
as textContent, title or placeholder, and the markup set through innerHTML."""

import json
import re
import subprocess
from html.parser import HTMLParser
from pathlib import Path

import pytest

WEB = Path(__file__).resolve().parent.parent / "web"
LANGS = ("fr", "es", "de")
ATTRS = ("placeholder", "title", "aria-label")
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}

# Call name -> indexes of the arguments that hold English text (from "tab" on: local
# helpers of director.js, gallery.js, studio.js and canvas-nodes.js).
CALLS = {"t": (0,), "L": (0,), "tx": (1,), "txAttr": (2,), "log": (1,), "notice": (1,), "say": (2,),
         "undoToast": (0,), "tab": (1,), "button": (0, 1), "txAria": (1,), "setStatus": (2,), "done": (2,)}
CALL_RE = re.compile(r"(?<![\w$.])(" + "|".join(CALLS) + r")\(")
# Object keys whose value (or first array item) is English text: runJob's `label` and
# `sub`, the prompt editor's `title`, `hint` and `applyLabel`.
KEY_RE = re.compile(r"(?<![\w$])(?:label|sub|title|hint|applyLabel):\s*\[?")
# Text set directly, translated by a later translateTree() pass.
SET_RE = re.compile(r"\.(?:textContent|title|placeholder)\s*=\s*")
HTML_RE = re.compile(r"\.innerHTML\s*=\s*")


def needs_translation(text: str) -> bool:
    return bool(re.search(r"[A-Za-z]{2}", re.sub(r"\{\w+\}", "", text)))


class _Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack: list[tuple[str, bool]] = []  # (tag, skipped)
        self.found: set[str] = set()

    def skipped(self) -> bool:
        return bool(self.stack) and self.stack[-1][1]

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        skip = self.skipped() or "data-raw" in a or tag in ("script", "style")
        if not skip:
            for name in ATTRS:
                if a.get(name) and needs_translation(a[name]):
                    self.found.add(a[name].strip())
        if tag not in VOID:
            self.stack.append((tag, skip))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.stack.pop()

    def handle_endtag(self, tag):
        while self.stack:
            if self.stack.pop()[0] == tag:
                break

    def handle_data(self, data):
        text = re.sub(r"\s+", " ", data).strip()
        if text and not self.skipped() and needs_translation(text):
            self.found.add(text)


def _literal(src: str, i: int):
    """The string literal starting at src[i] and the index after it, or None for
    anything else (a template literal with ${} cannot be a dictionary key)."""
    while i < len(src) and src[i].isspace():
        i += 1
    if i >= len(src) or src[i] not in "\"'`":
        return None, i
    q, j, out = src[i], i + 1, []
    while src[j] != q:
        if src[j] == "\\":
            out.append(json.loads('"' + src[j:j + 2] + '"') if src[j + 1] in 'nt"\\' else src[j + 1])
            j += 2
            continue
        if q == "`" and src.startswith("${", j):
            return None, j
        out.append(src[j])
        j += 1
    return "".join(out), j + 1


def _args(src: str, i: int) -> list[tuple[int, int]]:
    """(start, end) of each top-level argument of the call whose "(" is at src[i - 1]."""
    starts, depth, j = [i], 0, i
    while j < len(src):
        c = src[j]
        if c in "\"'`":
            q, j = c, j + 1
            while src[j] != q:
                j += 2 if src[j] == "\\" else 1
        elif c == "/" and src[j + 1] == "/":
            j = src.index("\n", j)
        elif c in "([{":
            depth += 1
        elif c in ")]}":
            if depth == 0:
                return list(zip(starts, [k - 1 for k in starts[1:]] + [j]))
            depth -= 1
        elif c == "," and depth == 0:
            starts.append(j + 1)
        j += 1
    return []


def _results(src: str, start: int, end: int) -> list[str]:
    """The string literals an argument can evaluate to: the argument itself, or the
    branches of a ternary or `||` inside it, not the operands of a comparison."""
    out, j = [], start
    while j < end:
        if src[j] in "\"'`":
            before = src[start:j].rstrip()
            text, k = _literal(src, j)
            after = src[k:end].lstrip()
            call_arg = before.endswith("(") and re.search(r"[\w$\]]\($", before)  # $("id"), f("x")
            if (text is not None and (not before or before[-1] in "?:(|") and not call_arg
                    and not after.startswith(("?", "===", "!=="))):
                out.append(text)
            if text is None:  # template literal with ${}: skip it
                k = j + 1
                while src[k] != src[j]:
                    k += 2 if src[k] == "\\" else 1
                k += 1
            j = k
        else:
            j += 1
    return out


def _markup(src: str, i: int) -> str:
    """The literal at src[i] with its ${} expressions blanked: HTML set by innerHTML."""
    while src[i].isspace():
        i += 1
    if src[i] not in "\"'`":
        return ""
    q, j, out = src[i], i + 1, []
    while src[j] != q:
        if src[j] == "\\":
            out.append(src[j + 1])
            j += 2
        elif q == "`" and src.startswith("${", j):
            depth, j = 1, j + 2
            while depth:
                depth += {"{": 1, "}": -1}.get(src[j], 0)
                if src[j] == "`":  # nested template: skip it whole
                    j += 1
                    while src[j] != "`":
                        j += 2 if src[j] == "\\" else 1
                j += 1
            out.append(" ")
        else:
            out.append(src[j])
            j += 1
    return "".join(out)


def _statement_markup(src: str, i: int) -> str:
    """Every literal of the expression starting at src[i], up to its `;`, joined: the
    branches and concatenations of an innerHTML assignment."""
    out, depth, j = [], 0, i
    while not (src[j] == ";" and depth == 0):
        c = src[j]
        if c in "\"'`":
            markup = _markup(src, j)
            if "<" in markup:  # not the operand of a comparison
                out.append(markup)
            k = j + 1
            while src[k] != c:
                if src[k] == "\\":
                    k += 2
                elif c == "`" and src.startswith("${", k):
                    d, k = 1, k + 2
                    while d:
                        d += {"{": 1, "}": -1}.get(src[k], 0)
                        k += 1
                else:
                    k += 1
            j = k + 1
            continue
        depth += {"(": 1, "[": 1, "{": 1, ")": -1, "]": -1, "}": -1}.get(c, 0)
        j += 1
    return "".join(out)


def scripts() -> dict[str, str]:
    return {p.name: p.read_text(encoding="utf-8") for p in sorted((WEB / "js").glob("*.js"))}


def collect() -> dict[str, str]:
    """English string -> where it was first found."""
    found: dict[str, str] = {}
    for name in ("index.html", "canvas.html"):
        page = _Page()
        page.feed((WEB / name).read_text(encoding="utf-8"))
        for text in page.found:
            found.setdefault(text, name)
    for name, src in scripts().items():
        if name == "i18n.js":
            continue
        for m in CALL_RE.finditer(src):
            args = _args(src, m.end())
            for pos in CALLS[m.group(1)]:
                for text in _results(src, *args[pos]) if pos < len(args) else []:
                    if needs_translation(text):
                        found.setdefault(text, name)
        for m in SET_RE.finditer(src):
            text, _ = _literal(src, m.end())
            if text and needs_translation(text):
                found.setdefault(text, name)
        for m in HTML_RE.finditer(src):
            part = _Page()
            part.feed(_statement_markup(src, m.end()))
            for text in part.found:
                found.setdefault(text, name)
        for m in KEY_RE.finditer(src):
            text, _ = _literal(src, m.end())
            if text and needs_translation(text):
                found.setdefault(text, name)
    return found


def dictionary() -> dict:
    script = f"import {{ DICT }} from {json.dumps((WEB / 'js' / 'i18n-dict.js').as_uri())};" \
             "process.stdout.write(JSON.stringify(DICT));"
    out = subprocess.run(["node", "--input-type=module", "-e", script],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def placeholders(text: str) -> set[str]:
    return set(re.findall(r"\{(\w+)\}", text))


node = pytest.mark.skipif(subprocess.run(["which", "node"], capture_output=True).returncode != 0,
                          reason="node is not installed")


@node
def test_every_string_is_translated():
    found, dict_ = collect(), dictionary()
    missing = sorted(f"{where}: {text!r}" for text, where in found.items()
                     if not all(dict_.get(text, {}).get(lang) for lang in LANGS))
    assert not missing, f"{len(missing)} string(s) without a full translation:\n" + "\n".join(missing)


@node
def test_translations_keep_placeholders():
    wrong = [f"{text!r} [{lang}]" for text, tr in dictionary().items() for lang in LANGS
             if lang in tr and placeholders(tr[lang]) != placeholders(text)]
    assert not wrong, "placeholders differ:\n" + "\n".join(wrong)


@node
def test_no_unused_entries():
    found = collect()
    unused = sorted(k for k in dictionary() if k not in found and needs_translation(k))
    assert not unused, f"{len(unused)} entr(y/ies) no longer used:\n" + "\n".join(map(repr, unused))
