"""Embed the plan modules in index.html for standalone file:// distribution."""
import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
START = "/* BEGIN PLAN_P1_BUNDLE */"
END = "/* END PLAN_P1_BUNDLE */"


def build(check=False):
    path = ROOT / "index.html"
    html = path.read_text(encoding="utf-8")
    if html.count(START) != 1 or html.count(END) != 1:
        raise ValueError("Expected one plan bundle placeholder")
    code = "\n".join((ROOT / "js" / name).read_text(encoding="utf-8").rstrip()
                     for name in ("plan-core.js", "plan-storage.js", "plan-ui.js"))
    if "</script" in code.lower():
        raise ValueError("Unexpected script closing tag in embedded code")
    a, b = html.index(START), html.index(END) + len(END)
    result = html[:a] + START + "\n" + code + "\n" + END + html[b:]
    if check:
        if result != html:
            raise ValueError("Embedded plan modules are stale; run tools/build_phase_free_demo.py")
    elif result != html:
        path.write_text(result, encoding="utf-8")
    print(f"Plan bundle {'verified' if check else 'built'}: index.html {path.stat().st_size:,} bytes")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    build(parser.parse_args().check)
