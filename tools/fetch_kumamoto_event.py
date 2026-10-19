#!/usr/bin/env python3
"""熊本地震の公開資料を取得し、検証済みファイルと未取得項目の来歴を保存する。

python3 tools/fetch_kumamoto_event.py              # 全グループ
python3 tools/fetch_kumamoto_event.py jma sat_asia  # 指定グループ（既存の来歴を保持）
python3 tools/fetch_kumamoto_event.py --audit       # 通信せず再検証・集計

公開されていることと再配布条件は別なので、利用条件は各提供元を参照する。
"""
import argparse
import csv
import hashlib
import html
import http.client
import json
import math
import os
import posixpath
import re
import struct
import sys
import tempfile
import time
import zipfile
import zlib
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urljoin, urlsplit
import urllib.request
import urllib.error

BASE = Path(__file__).resolve().parent.parent
OUT = BASE / "kumamoto_event_data"
UA = {"User-Agent": "kumamoto-infra-demo/2.0 (academic demo; respects site terms)"}
SLEEP = 0.4
CHUNK_SIZE = 64 * 1024
MAX_BYTES = 64_000_000
IMAGE_MAX_BYTES = 7_000_000
DPM_MAX_BYTES = 20_000_000
EVENT = "2026-07-28 16:27 JST Kumamoto M7.1 (令和8年熊本地震、JMA)"
SAT_PAGE = "https://sentinel-asia.org/EO/2026/article20260728JP.html"
STORED_LEGACY = {"stored", "skip", "200", "saved(外部手動取り込み)"}
ARCHIVE = None

# 前版でURLが欠落した3ファイル。出典は保存済みのJMA索引・Sentinel Asia掲載リンク。
IMPORTED_SOURCES = {
    "jma_reports/20260728_kumamoto_jishin.html": "https://www.jma.go.jp/jma/menu/20260728_kumamoto_jishin.html",
    "sentinel_asia/files/584e07bb46af479cbe435978514c9a92": "https://storymaps.arcgis.com/collections/584e07bb46af479cbe435978514c9a92?item=1",
    "sentinel_asia/files/9afbac2a722f4070a7236cf972fca61e": "https://storymaps.arcgis.com/collections/9afbac2a722f4070a7236cf972fca61e?item=1",
}


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_file(path, expected=None):
    """標準ライブラリで形式・終端・構造を検査し、実サイズとハッシュを返す。"""
    size = path.stat().st_size
    if size == 0:
        raise ValueError("empty file")
    with path.open("rb") as stream:
        head = stream.read(4096)
        stream.seek(max(0, size - 4096))
        tail = stream.read()
    suffix = path.suffix.lower()
    kind = expected or {
        ".jpg": "jpeg", ".jpeg": "jpeg", ".png": "png", ".pdf": "pdf",
        ".kmz": "kmz", ".zip": "zip", ".csv": "csv", ".tif": "tiff",
        ".tiff": "tiff", ".json": "json", ".geojson": "json", ".html": "html",
    }.get(suffix)
    if not kind:
        kind = "html" if b"<html" in head.lower() else None
    metadata = {}
    if kind == "jpeg":
        valid = head.startswith(b"\xff\xd8\xff") and tail.rstrip().endswith(b"\xff\xd9")
    elif kind == "png":
        valid = head.startswith(b"\x89PNG\r\n\x1a\n")
        if valid:
            with path.open("rb") as stream:
                stream.seek(8)
                while True:
                    chunk_header = stream.read(8)
                    if len(chunk_header) != 8:
                        raise ValueError("truncated PNG chunk")
                    length, tag = struct.unpack(">I4s", chunk_header)
                    if stream.tell() + length + 4 > size:
                        raise ValueError("truncated PNG data")
                    crc = zlib.crc32(tag)
                    remaining = length
                    while remaining:
                        data = stream.read(min(CHUNK_SIZE, remaining))
                        crc = zlib.crc32(data, crc)
                        remaining -= len(data)
                    if struct.unpack(">I", stream.read(4))[0] != crc & 0xffffffff:
                        raise ValueError("PNG checksum mismatch")
                    if tag == b"IEND":
                        valid = length == 0 and not stream.read(1)
                        break
    elif kind == "pdf":
        valid = head.startswith(b"%PDF-") and b"%%EOF" in tail
    elif kind in ("kmz", "zip"):
        with zipfile.ZipFile(path) as archive:
            valid = archive.testzip() is None
            if kind == "kmz":
                kmls = [n for n in archive.namelist() if n.lower().endswith(".kml")]
                valid = valid and bool(kmls)
                tags, external = Counter(), set()
                for name in kmls:
                    try:
                        root = ET.fromstring(archive.read(name))
                    except ET.ParseError as error:
                        raise ValueError(f"invalid KML: {name}") from error
                    if root.tag.rsplit("}", 1)[-1] != "kml":
                        raise ValueError(f"not a KML document: {name}")
                    for element in root.iter():
                        tag = element.tag.rsplit("}", 1)[-1]
                        tags[tag] += 1
                        if tag == "href" and element.text:
                            href = element.text.strip()
                            if urlsplit(href).scheme:
                                external.add(href)
                            elif not href.startswith("#"):
                                member = posixpath.normpath(posixpath.join(posixpath.dirname(name), unquote(href)))
                                if member not in archive.namelist():
                                    raise ValueError(f"missing KMZ member: {member}")
                metadata.update(kml_documents=len(kmls), ground_overlays=tags["GroundOverlay"],
                                network_links=tags["NetworkLink"], external_references=sorted(external))
            metadata["archive_members"] = len(archive.namelist())
    elif kind == "csv":
        with path.open(encoding="cp932", newline="") as stream:
            header = [stream.readline() for _ in range(7)]
            rate = re.search(r"SAMPLING RATE=\s*([\d.]+)Hz", "".join(header))
            if not header[0].startswith("SITE CODE=") or not rate or header[6].strip() != "NS,EW,UD":
                raise ValueError("not a JMA acceleration CSV")
            rows = 0
            for row in csv.reader(stream):
                if len(row) != 3 or not all(math.isfinite(float(v)) for v in row):
                    raise ValueError("invalid acceleration row")
                rows += 1
            metadata = {
                "sampling_rate_hz": float(rate.group(1)), "samples": rows,
                "unit": header[4].split("=", 1)[1].strip(),
                "initial_time_jst": header[5].split("=", 1)[1].strip(),
            }
            valid = rows > 0
    elif kind == "json":
        with path.open(encoding="utf-8") as stream:
            value = json.load(stream)
        valid = isinstance(value, (dict, list))
        if isinstance(value, dict) and value.get("type") == "Feature" and "properties" in value:
            properties = value["properties"]
            metadata = {"magnitude": properties.get("mag"), "magnitude_type": properties.get("magType"), "title": properties.get("title")}
    elif kind == "tiff":
        valid = head[:4] in (b"II*\x00", b"MM\x00*")
        if valid:
            order = "<" if head.startswith(b"II") else ">"
            offset = struct.unpack(order + "I", head[4:8])[0]
            with path.open("rb") as stream:
                if offset < 8 or offset + 2 > size:
                    raise ValueError("invalid TIFF directory")
                stream.seek(offset)
                count = struct.unpack(order + "H", stream.read(2))[0]
                if offset + 2 + 12 * count + 4 > size:
                    raise ValueError("truncated TIFF directory")
                for _ in range(count):
                    tag, typ, n, raw = struct.unpack(order + "HHI4s", stream.read(12))
                    if tag in (256, 257) and n == 1 and typ in (3, 4):
                        metadata["width" if tag == 256 else "height"] = struct.unpack(order + ("H" if typ == 3 else "I"), raw[:2] if typ == 3 else raw)[0]
            valid = metadata.get("width", 0) > 0 and metadata.get("height", 0) > 0
    elif kind == "html":
        valid = b"<html" in head.lower() and b"</html>" in tail.lower()
    else:
        raise ValueError(f"unrecognized format: {path.name}")
    if not valid:
        raise ValueError(f"invalid or truncated {kind}")
    info = {"bytes": size, "sha256": sha256_file(path), "format": kind}
    if metadata:
        info["metadata"] = metadata
    return info


class TooLarge(Exception):
    def __init__(self, limit, observed):
        super().__init__(f"size {observed:,} exceeds {limit:,} bytes")
        self.limit, self.observed = limit, observed


class Archive:
    """1ファイル1項目のmanifestを保持し、更新ごとに原子的に保存する。"""

    def __init__(self, out=OUT, timeout=30, attempts=2):
        self.out = Path(out)
        self.out.mkdir(parents=True, exist_ok=True)
        self.timeout, self.attempts = timeout, attempts
        self.run_errors = set()
        manifest_path = self.out / "manifest.json"
        self.document = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
        self.entries = {}
        for entry in self.document.get("files", []):
            key = self.safe_key(entry["file"])
            previous = self.entries.get(key)
            if previous and previous.get("url") and entry.get("url") and previous["url"] != entry["url"]:
                raise ValueError(f"conflicting source URLs in manifest: {key}")
            self.entries[key] = dict(entry)

    @staticmethod
    def safe_key(name):
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts or not path.parts:
            raise ValueError(f"invalid archive path: {name}")
        return path.as_posix()

    def info(self, key, expected=None):
        info = validate_file(self.out / key, expected)
        previous = self.entries.get(key, {})
        if previous.get("sha256") and previous["sha256"] != info["sha256"]:
            raise ValueError("stored SHA-256 mismatch")
        if str(previous.get("status")) in STORED_LEGACY and previous.get("bytes", 0) > 0 and previous["bytes"] != info["bytes"]:
            raise ValueError("stored size mismatch")
        return info

    def summary(self):
        statuses = Counter(str(entry.get("status", "unknown")) for entry in self.entries.values())
        groups = {}
        for key, entry in self.entries.items():
            if entry.get("status") == "stored":
                row = groups.setdefault(key.split("/")[0], {"files": 0, "bytes": 0})
                row["files"] += 1
                row["bytes"] += entry["bytes"]
        return {"stored_files": sum(g["files"] for g in groups.values()),
                "stored_bytes": sum(g["bytes"] for g in groups.values()),
                "statuses": dict(sorted(statuses.items())), "groups": dict(sorted(groups.items()))}

    def checkpoint(self):
        self.document.update({"schema_version": 2, "event": EVENT, "updated_utc": utc_now(),
                              "files": [self.entries[k] for k in sorted(self.entries)], "summary": self.summary()})
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.out, prefix=".manifest-", suffix=".part", delete=False) as stream:
                temporary = Path(stream.name)
                json.dump(self.document, stream, ensure_ascii=False, indent=2)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.out / "manifest.json")
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def record(self, key, url, **changes):
        previous = self.entries.get(key, {})
        if previous.get("url") and url and previous["url"] != url:
            raise ValueError(f"source URL conflict: {key}")
        entry = {**previous, "group": key.rsplit("/", 1)[0], "file": key,
                 "url": url or previous.get("url", ""), "verified_utc": utc_now(), **changes}
        if entry.get("status") == "stored":
            entry.pop("error", None)
            entry.pop("observed_bytes", None)
        self.entries[key] = entry
        self.checkpoint()
        return entry

    def reconcile(self):
        """未指定グループを含めて現物と照合。失敗・未取得・出典も保持する。"""
        for path in sorted(self.out.rglob("*")):
            if not path.is_file() or path.name in ("manifest.json", ".DS_Store") or path.name.endswith(".part"):
                continue
            key = path.relative_to(self.out).as_posix()
            entry = self.entries.setdefault(key, {"group": key.rsplit("/", 1)[0], "file": key, "url": IMPORTED_SOURCES.get(key, "")})
            if not entry.get("url") and key in IMPORTED_SOURCES:
                entry["url"] = IMPORTED_SOURCES[key]
                entry["source_note"] = "前版で欠落したURLを提供元の掲載リンクから復元"
            try:
                info = self.info(key, entry.get("format"))
            except (ValueError, OSError, zipfile.BadZipFile, UnicodeError, struct.error) as error:
                entry.update(status="invalid", observed_bytes=path.stat().st_size, error=str(error), verified_utc=utc_now())
            else:
                entry.update(info, status="stored" if entry.get("url") else "unattributed", verified_utc=utc_now())
                entry.pop("error", None)
        for key, entry in self.entries.items():
            if not (self.out / key).is_file():
                if str(entry.get("status")) in STORED_LEGACY:
                    entry["status"] = "missing"
                entry["bytes"] = 0
        self.checkpoint()

    def migrate(self, old_key, key, url):
        """前版の平坦な画像保存先を、URLを確認してシーン別の保存先へ移す。"""
        old_key, key = self.safe_key(old_key), self.safe_key(key)
        old = self.entries.get(old_key)
        if old_key == key or not old or old.get("url") != url or not (self.out / old_key).is_file() or (self.out / key).exists():
            return
        info = self.info(old_key)
        target = self.out / key
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(self.out / old_key, target)
        del self.entries[old_key]
        self.entries[key] = {**old, **info, "file": key, "group": key.rsplit("/", 1)[0], "status": "stored", "migrated_from": old_key}
        self.checkpoint()

    def skipped(self, url, group, name, reason, max_bytes, observed=None):
        key = self.safe_key(f"{group}/{name}")
        if (self.out / key).is_file():
            info = self.info(key)
            self.record(key, url, **info, status="stored", last_action="cached")
        else:
            self.record(key, url, status="skipped_size", bytes=0, limit_bytes=max_bytes, remote_bytes=observed, note=reason)

    def fetch(self, url, group, name=None, max_bytes=MAX_BYTES):
        basename = PurePosixPath(urlsplit(url).path).name or "index.html"
        key = self.safe_key(f"{group}/{name or basename}")
        previous = self.entries.get(key, {})
        if previous.get("url") and previous["url"] != url:
            if name is not None:
                raise ValueError(f"explicit filename has another source URL: {key}")
            stem, suffix = os.path.splitext(basename)
            key = self.safe_key(f"{group}/{stem}--{hashlib.sha256(url.encode()).hexdigest()[:16]}{suffix}")
            previous = self.entries.get(key, {})
        target = self.out / key
        resolved_group, resolved_name = key.rsplit("/", 1)
        if target.is_file() and previous.get("url") == url:
            try:
                info = self.info(key, previous.get("format"))
            except (ValueError, OSError, zipfile.BadZipFile, UnicodeError, struct.error) as error:
                print(f"  retry {key}: {error}")
            else:
                if info["bytes"] <= max_bytes:
                    self.record(key, url, **info, status="stored", last_action="cached")
                    print(f"  cache {key} {info['bytes']:,} bytes")
                    return target.read_bytes()
                self.skipped(url, resolved_group, resolved_name, "既存ファイルは取得上限を超えるため現物を保持", max_bytes, info["bytes"])
                return None
        elif target.exists():
            raise ValueError(f"unattributed file would be overwritten: {key}")
        target.parent.mkdir(parents=True, exist_ok=True)
        kind = previous.get("format")
        last_error, http_status = None, None
        for attempt in range(1, self.attempts + 1):
            temporary = None
            try:
                req = urllib.request.Request(url, headers=UA)
                with urllib.request.urlopen(req, timeout=self.timeout) as response:
                    http_status = response.status
                    if http_status != 200:
                        raise ValueError(f"unexpected HTTP status {http_status}")
                    length = response.headers.get("Content-Length")
                    length = int(length) if length is not None else None
                    if length is not None and length > max_bytes:
                        raise TooLarge(max_bytes, length)
                    with tempfile.NamedTemporaryFile(dir=target.parent, prefix=f".{target.name}.", suffix=".part", delete=False) as stream:
                        temporary = Path(stream.name)
                        count = 0
                        while True:
                            chunk = response.read(min(CHUNK_SIZE, max_bytes - count + 1))
                            if not chunk:
                                break
                            count += len(chunk)
                            if count > max_bytes:
                                raise TooLarge(max_bytes, count)
                            stream.write(chunk)
                        stream.flush()
                        os.fsync(stream.fileno())
                    if length is not None and count != length:
                        raise ValueError(f"incomplete response: {count}/{length} bytes")
                    # 一時ファイルの拡張子は .part なので、本来の保存先から形式を決める。
                    if kind is None:
                        suffix = target.suffix.lower()
                        kind = {".jpg": "jpeg", ".jpeg": "jpeg", ".png": "png", ".pdf": "pdf", ".kmz": "kmz", ".zip": "zip", ".csv": "csv", ".tif": "tiff", ".tiff": "tiff", ".json": "json", ".geojson": "json", ".html": "html"}.get(suffix)
                    info = validate_file(temporary, kind)
                    headers = {k: response.headers.get(k) for k in ("ETag", "Last-Modified") if response.headers.get(k)}
                os.replace(temporary, target)
                self.record(key, url, **info, status="stored", last_action="downloaded", fetched_utc=utc_now(), http_status=http_status, response_headers=headers, attempts=attempt)
                self.run_errors.discard(key)
                print(f"  ok    {key} {count:,} bytes")
                time.sleep(SLEEP)
                return target.read_bytes()
            except TooLarge as error:
                self.skipped(url, resolved_group, resolved_name, str(error), error.limit, error.observed)
                print(f"  size  {key}: {error}")
                return None
            except (OSError, ValueError, urllib.error.URLError, http.client.HTTPException, zipfile.BadZipFile, UnicodeError, struct.error) as error:
                last_error = str(error)
                http_status = getattr(error, "code", http_status)
                self.record(key, url, status="error", error=last_error, http_status=http_status, attempts=attempt,
                            bytes=target.stat().st_size if target.is_file() else 0)
                print(f"  error {key}: {last_error}")
                if isinstance(error, urllib.error.HTTPError) and 400 <= error.code < 500:
                    break
                if attempt < self.attempts:
                    time.sleep(1)
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
        self.run_errors.add(key)
        return None

    def manual(self, url, group, name, note):
        key = self.safe_key(f"{group}/{name}")
        if (self.out / key).is_file():
            self.record(key, url, **self.info(key), status="stored", note=note)
        else:
            self.record(key, url, status="manual", bytes=0, note=note)


def fetch(url, group, name=None, max_bytes=MAX_BYTES):
    return ARCHIVE.fetch(url, group, name, max_bytes)


def manual(url, group, name, note):
    ARCHIVE.manual(url, group, name, note)


# ---------------------------------------------------------------- 気象庁
def jma():
    base = "https://www.data.jma.go.jp/eqev/data/kyoshin/jishin/2607281627_kumamoto/"
    page = fetch(base + "index.html", "jma_kyoshin")
    if page:
        text = page.decode("utf-8", "ignore")
        csvs = sorted(set(re.findall(r'href="(data/acc\d+\.csv)"', text)))
        print(f"  強震波形CSV {len(csvs)} 観測点")
        for c in csvs:
            fetch(base + c, "jma_kyoshin/wp")
    for u in [
        "https://www.jma.go.jp/jma/menu/20260728_kumamoto_jishin.html",
        "https://www.jma.go.jp/jma/press/2607/28a/202607281730.html",   # 第1報（17:30）
        "https://www.jma.go.jp/jma/press/2607/28b/202607281915.html",   # 第2報（名称定義・19:15）
        "https://www.jma.go.jp/jma/press/2607/28d/202607282030.html",   # 第3報（20:30）
        "https://www.jma.go.jp/jma/menu/kumamoto_kaisetsu_20260908.pdf",  # 特設ページ掲載の活動状況（9/8）
        "https://www.jma.go.jp/jma/press/2609/24a/kaisetsu202609241400.pdf",  # 第12報（9/24）
    ]:
        fetch(u, "jma_reports")
    # 気象庁以外の公的機関の震度観測点一覧（公益財団法人地震予知総合研究振興会）
    fetch("https://www.adep.or.jp/kanren/Eq_data/260728a.html", "jma_reports/adep")


# ------------------------------------------------------- 地震調査研究推進本部
def jishin():
    for u in [
        "https://www.static.jishin.go.jp/resource/monthly/2026/20260728_kumamoto_1.pdf",  # 7/29評価
        "https://www.static.jishin.go.jp/resource/monthly/2026/20260728_kumamoto_2.pdf",  # 8/12評価
    ]:
        fetch(u, "jishin_honbu")


# ---------------------------------------------------------------- 国土地理院
def gsi():
    # 以前の直接取得では接続タイムアウト。原因は未確認なので bot ブロックと断定しない。
    manual("https://www.gsi.go.jp/BOUSAI/20260728_kumamoto_earthquake.html", "gsi",
           "BOUSAI_20260728_kumamoto_earthquake.html", "空中写真/地殻変動/斜面崩壊/1秒解析の索引。直接取得は接続タイムアウト、ローカル未保存")
    manual("https://www1.gsi.go.jp/geowww/saigai/20260728_kumamoto/hokai/kumamoto_yatsushiro0814.zip", "gsi",
           "hokai_kumamoto_yatsushiro0814.zip", "斜面崩壊・堆積分布 GeoJSON (56KB)。直接取得は接続タイムアウト、ローカル未保存")
    manual("https://www.gsi.go.jp/common/000280149.pdf", "gsi", "chihen3_siryou1.pdf", "電子基準点変動 資料1 (2.7MB)。接続タイムアウト、ローカル未保存")
    manual("https://www.gsi.go.jp/common/000280150.pdf", "gsi", "chihen3_siryou2.pdf", "電子基準点変動 資料2 (474KB)。接続タイムアウト、ローカル未保存")
    manual("https://www1.gsi.go.jp/geowww/katsudanso/geotiff/194.zip", "gsi", "activefault_hinagu.zip", "活断層図GeoTIFF 日奈久。接続タイムアウト、ローカル未保存")
    # 3D干渉解析GeoTIFF（だいち2号/4号・NISAR、東西/南北/上下 各18MB）は insarmap.gsi.go.jp から取得可
    for n in ["ew", "ns", "ud"]:
        fetch(f"https://insarmap.gsi.go.jp/geotiff/2026kumamoto/urgent_earthquake_20260728R8kumamoto_3d_9obs_clip.{n}.mask.tif",
              "gsi", f"insar3d_{n}.tif")


# ---------------------------------------------------------------- 国土交通省
def mlit():
    for u in [
        "https://www.mlit.go.jp/saigai/saigai_260728.html",          # 国交省 熊本地震特設ページ
        "https://www.qsr.mlit.go.jp/bousai_joho/r80728kumamotozisinn.html",  # 九州地方整備局 対応状況（46報）
        "https://committees.jsce.or.jp/eec205/node/69",              # JSCE 掲載「被害状況等について」
    ]:
        fetch(u, "reports_mlit")


# ---------------------------------------------------------------- 内閣府・消防庁
def cabnet():
    for u in [
        "https://www.bousai.go.jp/updates/r8kumamoto_jishin/status/pdf/r8kumamoto_jishin_20260729.pdf",
        "https://www.bousai.go.jp/updates/r8kumamoto_jishin/status/pdf/r8kumamoto_jishin_20260805.pdf",
        "https://www.bousai.go.jp/updates/r8kumamoto_jishin/status/pdf/r8kumamoto_jishin_20260815.pdf",
        "https://www.bousai.go.jp/updates/r8kumamoto_jishin/status/pdf/r8kumamoto_jishin_20260825.pdf",
        "https://www.bousai.go.jp/updates/r8kumamoto_jishin/status/pdf/r8kumamoto_jishin_20261005.pdf",
    ]:
        fetch(u, "reports_cabnet")
    for u in [
        "https://www.fdma.go.jp/disaster/info/items/878b23d33db5f5e642d2ee38ecd24674b7ef2664.pdf",  # 第53報 8/15
        "https://www.fdma.go.jp/disaster/info/items/20260728kumamotojishin61.pdf",                  # 第61報 8/25
        "https://www.fdma.go.jp/disaster/info/items/20260728kumamotojishin65.pdf",                  # 第65報 9/24
    ]:
        fetch(u, "reports_fdma")


def pref():
    for u in [
        "https://www.pref.kumamoto.jp/uploaded/attachment/315575.pdf",   # 人的被害等（7/30 07:00）
        "https://www.pref.kumamoto.jp/soshiki/32/274465.html",          # 被災状況の報告（熊本県）
    ]:
        fetch(u, "reports_pref")


# ---------------------------------------------------------------- 強震・専門委会 一次論文
def expert():
    """JSCE被害調査委員会 + 大学研究室の速報（震度・基礎・時刻歴・地割れの一次資料）。"""
    for u, n in [
        ("https://committees.jsce.or.jp/eec205/system/files/20260728_Kumamoto_Jichitai_Shindokei_Zantei.pdf", "jichitai_shindokei_zantei.pdf"),
        ("https://committees.jsce.or.jp/eec205/system/files/20260804_R8_Kumamoto_M7.1_Kansoku_Hakei_Bunseki_Zantei_v2.pdf", "kansoku_hakei_bunseki_zantei.pdf"),
        ("https://committees.jsce.or.jp/eec205/system/files/20260731_R8_Kumamoto_Ueda_Takatoku_Inoue_Sasaki.pdf", "ueda_takatoku_sasaki.pdf"),
        ("https://committees.jsce.or.jp/eec205/system/files/20260804_KMM012_Yatsushiro_2016_2026_Comparison.pdf", "kmm012_yatsushiro_2016_2026.pdf"),
        ("http://wwwcatfish.dpri.kyoto-u.ac.jp/~goto/eq/20260728/report0.pdf", "dpri_goto_report0.pdf"),
        ("http://www-solid.eps.s.u-tokyo.ac.jp/~ando/kuma/Hinagu_fault_offset.pdf", "ut_ando_hinagu_fault_offset.pdf"),
        ("http://dynamics.kuciv.kyoto-u.ac.jp/reports/ku-strdyn_lab-20260728.pdf", "ku_strdyn_lab.pdf"),
    ]:
        fetch(u, "reports_expert", n)


# ---------------------------------------------------------------- Sentinel Asia / 衛星
def satellite_assets(page):
    """公開画像と位置情報付き成果物を、シーンを保った保存先へ対応させる。"""
    urls = set()
    for href in re.findall(r'''href\s*=\s*["']([^"']+)["']''', page.decode("utf-8", "strict"), re.I):
        url = urljoin(SAT_PAGE, html.unescape(href))
        if url.startswith(SAT_PAGE.removesuffix(".html") + "/"):
            urls.add(url)
    for url in sorted(urls):
        name = urlsplit(url).path.split("/article20260728JP/", 1)[1]
        suffix = PurePosixPath(name).suffix.lower()
        if suffix not in {".jpg", ".jpeg", ".png", ".kmz", ".zip", ".pdf", ".tif", ".tiff"}:
            continue
        image = suffix in {".jpg", ".jpeg", ".png"}
        basename = PurePosixPath(name).name
        excluded = image and bool(re.match(r"jp_(?:eos4_(?:fre|frs|mrs)_|r2_l4_)", basename)) and "_sml" not in basename
        limit = DPM_MAX_BYTES if basename.endswith("_DPM_S1_Japan_Kumamoto_Earthquake_v0.9_MAIN.png") else IMAGE_MAX_BYTES if image else MAX_BYTES
        yield {"url": url, "group": "sentinel_asia/img" if image else "sentinel_asia/products",
               "name": name, "max_bytes": limit, "excluded": excluded}


def sat_asia():
    page = fetch(SAT_PAGE, "sentinel_asia")
    if page:
        for asset in satellite_assets(page):
            key = f"{asset['group']}/{asset['name']}"
            # 元URLが一致する前版ファイルだけ移行し、別シーンを同じ画像で代用しない。
            ARCHIVE.migrate(f"sentinel_asia/img/{PurePosixPath(asset['name']).name}", key, asset["url"])
            if asset["excluded"]:
                ARCHIVE.skipped(asset["url"], asset["group"], asset["name"],
                                "巨大SAR元画像は容量方針により除外。同じシーンのsml版を取得", asset["max_bytes"])
            else:
                fetch(asset["url"], asset["group"], asset["name"], max_bytes=asset["max_bytes"])


# ---------------------------------------------------------------- USGS
def usgs():
    for u in [
        "https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/us6000tgb9.geojson",
        "https://earthquake.usgs.gov/earthquakes/eventpage/us6000tgb9/shakemap/global/downloads",
    ]:
        fetch(u, "usgs")


# ------------------------------------------------------------- 防災科研・民間衛星
def topics():
    # K-NET/KiK-net の topics ページ（要点は公開。波形本体は会員制DL基盤/申請制）
    for t in ("20260728162700", "20260728170800"):
        fetch(f"https://www.kyoshin.bosai.go.jp/ja/topics/{t}", "kyoshin_topics")
    manual("https://www.kyoshin.bosai.go.jp/kyoshin/topics/html/20260728162700/20260728162700/index.html", "kyoshin_topics",
           "tbh_20260728162700.html", "補足ページの実在・取得方法は未確認。本震topicsは別項目に保存済み")
    manual("https://www.pasco.co.jp/News/press/026/", "pasco_gm", "press_026.html",
           "以前の候補URLは404。対応する公表ページとALOS-2成果物の提供条件を要確認")


GROUPS = [jma, jishin, gsi, mlit, cabnet, pref, expert, sat_asia, usgs, topics]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("groups", nargs="*", help="取得グループ: " + ", ".join(g.__name__ for g in GROUPS))
    parser.add_argument("--audit", action="store_true", help="通信せず全ファイルとmanifestを照合")
    parser.add_argument("--output", type=Path, default=OUT)
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("--attempts", type=int, default=2)
    args = parser.parse_args(argv)
    names = {g.__name__ for g in GROUPS}
    if set(args.groups) - names:
        parser.error("unknown groups: " + ", ".join(sorted(set(args.groups) - names)))
    if args.timeout <= 0 or args.attempts < 1:
        parser.error("timeout must be positive and attempts must be at least 1")
    global ARCHIVE
    ARCHIVE = Archive(args.output, timeout=args.timeout, attempts=args.attempts)
    ARCHIVE.reconcile()
    try:
        if not args.audit:
            for group in GROUPS:
                if not args.groups or group.__name__ in args.groups:
                    print(f"== {group.__name__}")
                    group()
    finally:
        ARCHIVE.checkpoint()
    summary = ARCHIVE.summary()
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return int(bool(ARCHIVE.run_errors) or any(summary["statuses"].get(k, 0) for k in ("error", "invalid", "missing", "unattributed")))


if __name__ == "__main__":
    sys.exit(main())
