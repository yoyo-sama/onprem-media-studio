"""web/js/prompts.js against AI Content Studio 1.4 (tools/parity-prompts.js).

Needs Node and a 1.4 checkout holding the reference commit, next to this
repository (`../dellaicontent`) or named by STUDIO_V14_REPO; skipped otherwise.
"""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
V14 = Path(os.environ.get("STUDIO_V14_REPO", ROOT.parent / "dellaicontent"))
REF_REV = "234f37c"


def has_reference() -> bool:
    if shutil.which("node") is None or shutil.which("git") is None or not V14.is_dir():
        return False
    found = subprocess.run(["git", "-C", str(V14), "cat-file", "-e", f"{REF_REV}^{{commit}}"], capture_output=True)
    return found.returncode == 0


@pytest.mark.skipif(not has_reference(), reason=f"needs node and a 1.4 checkout with {REF_REV}")
def test_prompts_match_1_4():
    done = subprocess.run(["node", str(ROOT / "tools" / "parity-prompts.js"), str(V14)],
                          capture_output=True, text=True, timeout=120)
    assert done.returncode == 0, done.stdout[-3000:] + done.stderr[-2000:]
    assert "comparisons equal to 1.4" in done.stdout


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_prompts_module_loads_in_node():
    code = "const P = require(process.argv[1]); if (!P.compileKeyframePrompt || !P.enrichBrief) process.exit(1);"
    assert subprocess.run(["node", "-e", code, str(ROOT / "web" / "js" / "prompts.js")]).returncode == 0
