#!/usr/bin/env python3
"""Inline the page's images and video as data URIs: one self-contained HTML file.
    python3 inline.py doc-assets-anime/index.html doc-assets-anime/making-of-anime.html"""
import base64, mimetypes, re, sys
from pathlib import Path
src, out = Path(sys.argv[1]), Path(sys.argv[2])
html = src.read_text(encoding="utf-8")
def data(m):
    attr, path = m.group(1), m.group(2)
    f = src.parent / path
    mime = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
    return f'{attr}="data:{mime};base64,{base64.b64encode(f.read_bytes()).decode()}"'
html = re.sub(r'\b(src|poster)="((?:film|sheets|frames|drifts)/[^"]+)"', data, html)
out.write_text(html, encoding="utf-8")
print(out, round(out.stat().st_size / 1e6, 1), "MB")
