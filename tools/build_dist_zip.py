#!/usr/bin/env python3
"""熊本2026 インフラ初動AIデモの再配布用ZIPを生成する。

同梱物:
  index.html
  README.md
  README_FIRST.html  （docs/distribution/README_FIRST.html を ZIPのルートに同梱指示書として配置）
  vendor/            （Leaflet）
  kumamoto_event_data/（発災後アーカイブ + manifest.json）
  docs/              （実装仕様書・操作ノート・配布用テンプレート）

除外: .DS_Store、__pycache__/、*.pyc、このZIP自身（phasefree_kumamoto_demo*.zip）

使い方:
  python3 tools/build_dist_zip.py                 # 既定: workspace直下に phasefree_kumamoto_demo.zip
  python3 tools/build_dist_zip.py 出力先/名前.zip
"""
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ZIP_NAME = "phasefree_kumamoto_demo.zip"
REQUIRED = ["index.html", "README.md", "vendor/leaflet.js", "kumamoto_event_data/manifest.json"]
IGNORED_DIRS = {"__pycache__", ".git", ".opencode"}
IGNORED_FILES = {".DS_Store", ".np"}
IGNORED_SUFFIX = ".pyc"


def add_file(files, path, arc):
    if path.name in IGNORED_FILES or (path.is_file() and path.suffix == IGNORED_SUFFIX):
        return
    if path.name.startswith("phasefree_kumamoto_demo"):
        return
    files.append((path, arc))


def add_tree(files, base, prefix):
    for path in sorted(base.iterdir()):
        arc = f"{prefix}/{path.name}" if prefix else path.name
        if path.is_dir():
            if path.name not in IGNORED_DIRS:
                add_tree(files, path, arc)
        else:
            add_file(files, path, arc)


def main():
    for rel in REQUIRED:
        p = ROOT / rel
        if not p.is_file():
            sys.exit(f"missing {rel}: {p}")
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / ZIP_NAME
    if out.suffix != ".zip":
        sys.exit(f"output must be a .zip path: {out}")
    files = []
    add_file(files, ROOT / "index.html", "index.html")
    add_file(files, ROOT / "README.md", "README.md")
    add_file(files, ROOT / "docs" / "distribution" / "README_FIRST.html", "README_FIRST.html")
    add_tree(files, ROOT / "vendor", "vendor")
    add_tree(files, ROOT / "kumamoto_event_data", "kumamoto_event_data")
    add_tree(files, ROOT / "docs", "docs")
    total_src = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for path, arc in files:
            z.write(path, arc)
            total_src += path.stat().st_size
    stat = out.stat()
    print(f"zip created: {out}")
    print(f"entries: {len(files)}  source: {total_src:,} bytes  zip: {stat.st_size:,} bytes")


if __name__ == "__main__":
    main()
