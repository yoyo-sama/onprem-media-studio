"""Same-origin check for the routes that change files or the installation.

JSON routes are already out of reach of a cross-site form (FastAPI refuses a
body that is not JSON, and a JSON request from another site needs a CORS
preflight this server never grants). The routes that take a raw body or no
body at all (uploads, update) are not, hence this check, applied to every
route that moves, renames or writes files.
"""

from urllib.parse import urlsplit

from fastapi import HTTPException, Request


def same_origin(request: Request) -> None:
    headers = request.headers
    if headers.get("sec-fetch-site", "same-origin") != "same-origin":
        raise HTTPException(403, "Cross-origin request refused")
    source = headers.get("origin") or headers.get("referer")
    host = (headers.get("host") or "").lower()
    try:
        same = bool(source and host) and urlsplit(source).netloc.lower() == host
    except ValueError:
        same = False
    if not same:
        raise HTTPException(403, "Cross-origin request refused (no matching Origin or Referer)")
