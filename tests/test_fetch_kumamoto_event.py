"""ネットワークを使わず、取得漏れ・中断・再実行の回帰を検証する。"""
import importlib.util
import io
import json
import struct
import tempfile
import unittest
import urllib.error
import zipfile
import zlib
from pathlib import Path
from unittest import mock


SPEC = importlib.util.spec_from_file_location("event_fetch", Path(__file__).resolve().parents[1] / "tools/fetch_kumamoto_event.py")
FETCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FETCH)


def png(pixel=b"\x11\x22\x33"):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"\0" + pixel)) + chunk(b"IEND", b"")


class Response:
    status = 200

    def __init__(self, data, declared=None):
        self.stream = io.BytesIO(data)
        self.headers = {} if declared is None else {"Content-Length": str(declared)}
        self.read_sizes = []

    def read(self, size):
        self.read_sizes.append(size)
        return self.stream.read(size)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class FetchTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="event-fetch-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.archive = FETCH.Archive(self.root, attempts=1)
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(FETCH.time, "sleep").start()
        mock.patch("sys.stdout", new=io.StringIO()).start()

    def manifest(self):
        return json.loads((self.root / "manifest.json").read_text())

    def download(self, url="https://example.test/image.png", data=None, **kwargs):
        response = Response(png() if data is None else data)
        with mock.patch.object(FETCH.urllib.request, "urlopen", return_value=response) as request:
            result = self.archive.fetch(url, "images", **kwargs)
        return result, request

    def test_distinct_urls_with_same_basename_are_not_cached_as_one_image(self):
        first, _ = self.download("https://example.test/before/PREVIEW.png")
        second, request = self.download("https://example.test/after/PREVIEW.png", png(b"\x44\x55\x66"))
        self.assertNotEqual(first, second)
        self.assertEqual(request.call_count, 1)
        self.assertEqual(len(self.archive.entries), 2)
        self.assertEqual(len({e["file"] for e in self.manifest()["files"]}), 2)

    def test_valid_cache_checks_hash_and_does_not_make_a_request(self):
        data, _ = self.download()
        with mock.patch.object(FETCH.urllib.request, "urlopen") as request:
            self.assertEqual(self.archive.fetch("https://example.test/image.png", "images"), data)
        request.assert_not_called()
        self.assertEqual(self.archive.entries["images/image.png"]["last_action"], "cached")

    def test_oversize_colliding_basename_does_not_relabel_another_source(self):
        self.download("https://example.test/before/PREVIEW.png")
        response = Response(png(), declared=100_000_000)
        with mock.patch.object(FETCH.urllib.request, "urlopen", return_value=response):
            self.archive.fetch("https://example.test/after/PREVIEW.png", "images", max_bytes=100)
        self.assertEqual(self.archive.entries["images/PREVIEW.png"]["url"], "https://example.test/before/PREVIEW.png")
        self.assertEqual(self.archive.summary()["statuses"], {"skipped_size": 1, "stored": 1})

    def test_corrupt_nonempty_cache_is_downloaded_again(self):
        self.download()
        (self.root / "images/image.png").write_bytes(b"partial-10")
        result, request = self.download()
        self.assertEqual(result, png())
        self.assertEqual(request.call_count, 1)

    def test_same_size_modified_valid_file_is_not_accepted_as_cache(self):
        url = "https://example.test/report.html"
        self.download(url, b"<html><body>first</body></html>")
        (self.root / "images/report.html").write_bytes(b"<html><body>other</body></html>")
        result, request = self.download(url, b"<html><body>first</body></html>")
        self.assertIn(b"first", result)
        self.assertEqual(request.call_count, 1)

    def test_large_content_length_is_rejected_before_reading_body(self):
        response = Response(png(), declared=100_000_000)
        with mock.patch.object(FETCH.urllib.request, "urlopen", return_value=response):
            self.assertIsNone(self.archive.fetch("https://example.test/large.png", "images", max_bytes=100))
        self.assertEqual(response.read_sizes, [])
        self.assertFalse((self.root / "images/large.png").exists())
        self.assertEqual(self.archive.summary()["statuses"], {"skipped_size": 1})

    def test_stream_without_length_reads_at_most_limit_plus_one(self):
        response = Response(png())
        with mock.patch.object(FETCH.urllib.request, "urlopen", return_value=response):
            self.archive.fetch("https://example.test/large.png", "images", max_bytes=10)
        self.assertEqual(response.stream.tell(), 11)
        self.assertEqual(response.read_sizes, [11])
        self.assertFalse(list(self.root.rglob("*.part")))

    def test_incomplete_response_keeps_old_file_and_removes_temporary(self):
        url = "https://example.test/image.png"
        self.download(url)
        target = self.root / "images/image.png"
        target.write_bytes(b"broken")
        response = Response(png()[:20], declared=len(png()))
        with mock.patch.object(FETCH.urllib.request, "urlopen", return_value=response):
            self.assertIsNone(self.archive.fetch(url, "images"))
        self.assertEqual(target.read_bytes(), b"broken")
        self.assertFalse(list(self.root.rglob("*.part")))
        self.assertEqual(self.archive.entries["images/image.png"]["status"], "error")
        self.download(url)
        self.assertNotIn("error", self.manifest()["files"][0])

    def test_failed_atomic_replace_does_not_publish_partial_download(self):
        original_replace = FETCH.os.replace

        def fail_image(source, target):
            if Path(target).suffix == ".png":
                raise OSError("simulated interrupted publish")
            return original_replace(source, target)

        with mock.patch.object(FETCH.os, "replace", side_effect=fail_image):
            result, _ = self.download()
        self.assertIsNone(result)
        self.assertFalse((self.root / "images/image.png").exists())
        self.assertFalse(list(self.root.rglob("*.part")))
        self.download()
        self.assertEqual(self.archive.summary()["stored_files"], 1)

    def test_html_error_page_is_not_stored_as_pdf(self):
        result, _ = self.download("https://example.test/report.pdf", b"<html><body>unavailable</body></html>")
        self.assertIsNone(result)
        self.assertFalse((self.root / "images/report.pdf").exists())

    def test_subset_run_preserves_other_urls_hashes_and_manual_entries(self):
        self.download()
        self.archive.manual("https://example.test/manual.zip", "gsi", "manual.zip", "pending")
        original = self.archive.entries["images/image.png"].copy()
        self.archive = FETCH.Archive(self.root, attempts=1)
        self.archive.reconcile()
        self.download("https://example.test/other.png")
        stored = {e["file"]: e for e in self.manifest()["files"]}
        self.assertEqual(stored["images/image.png"]["url"], original["url"])
        self.assertEqual(stored["images/image.png"]["sha256"], original["sha256"])
        self.assertEqual(stored["gsi/manual.zip"]["status"], "manual")
        self.assertEqual(self.archive.summary()["stored_files"], 2)

    def test_completed_download_is_checkpointed_before_later_interruption(self):
        self.download()
        # 新しいプロセスに相当する再読込。mainの終了処理に依存せず保存済みであること。
        resumed = FETCH.Archive(self.root)
        self.assertEqual(resumed.entries["images/image.png"]["status"], "stored")
        self.assertEqual(resumed.entries["images/image.png"]["bytes"], len(png()))

    def test_source_checked_migration_preserves_data_and_prevents_wrong_scene_reuse(self):
        url = "https://example.test/before/PREVIEW.png"
        self.download(url)
        self.archive.migrate("images/PREVIEW.png", "images/after/PREVIEW.png", "https://example.test/after/PREVIEW.png")
        self.assertTrue((self.root / "images/PREVIEW.png").exists())
        self.archive.migrate("images/PREVIEW.png", "images/before/PREVIEW.png", url)
        self.assertFalse((self.root / "images/PREVIEW.png").exists())
        self.assertEqual((self.root / "images/before/PREVIEW.png").read_bytes(), png())
        self.assertEqual(self.archive.summary()["stored_files"], 1)

    def test_reconcile_repairs_legacy_zero_byte_too_big_record(self):
        path = self.root / "dpm.png"
        path.write_bytes(png())
        (self.root / "manifest.json").write_text(json.dumps({"files": [{"file": "dpm.png", "url": "https://example.test/dpm.png", "status": "too-big(>7000000)", "bytes": 0}]}))
        self.archive = FETCH.Archive(self.root)
        self.archive.reconcile()
        entry = self.manifest()["files"][0]
        self.assertEqual(entry["status"], "stored")
        self.assertEqual(entry["bytes"], len(png()))
        self.assertEqual(len(entry["sha256"]), 64)

    def test_jma_rate_is_read_from_file_instead_of_assuming_200hz(self):
        data = b"SITE CODE= station\n LAT.=32\n LON.=130\n SAMPLING RATE= 100Hz\n UNIT = gal(cm/s/s)\nINITIAL TIME = 2026 07 28 16 27 00\n NS,EW,UD\n0.1,0.2,0.3\n"
        self.download("https://example.test/acc.csv", data)
        self.assertEqual(self.archive.entries["images/acc.csv"]["metadata"]["sampling_rate_hz"], 100)

    def test_usgs_magnitude_is_kept_in_source_scale(self):
        data = json.dumps({"type": "Feature", "properties": {"mag": 6.8, "magType": "mww", "title": "USGS"}}).encode()
        self.download("https://example.test/event.geojson", data)
        self.assertEqual(self.archive.entries["images/event.geojson"]["metadata"]["magnitude"], 6.8)

    def test_http_404_is_recorded_once_and_is_a_run_error(self):
        error = urllib.error.HTTPError("https://example.test/gone.png", 404, "gone", {}, None)
        self.archive.attempts = 3
        with mock.patch.object(FETCH.urllib.request, "urlopen", side_effect=error) as request:
            self.archive.fetch(error.url, "images")
        self.assertEqual(request.call_count, 1)
        self.assertEqual(len(self.archive.run_errors), 1)
        self.assertEqual(self.archive.summary()["stored_files"], 0)

    def test_kmz_structure_is_validated(self):
        payload = io.BytesIO()
        with zipfile.ZipFile(payload, "w") as archive:
            archive.writestr("doc.kml", "<kml/>")
        result, _ = self.download("https://example.test/map.kmz", payload.getvalue())
        self.assertEqual(result, payload.getvalue())
        self.assertEqual(self.archive.entries["images/map.kmz"]["format"], "kmz")

    def test_kmz_network_dependencies_are_recorded(self):
        payload = io.BytesIO()
        with zipfile.ZipFile(payload, "w") as archive:
            archive.writestr("doc.kml", '<kml><NetworkLink><Link><href>https://example.test/tile.kml</href></Link></NetworkLink></kml>')
        self.download("https://example.test/map.kmz", payload.getvalue())
        metadata = self.archive.entries["images/map.kmz"]["metadata"]
        self.assertEqual(metadata["network_links"], 1)
        self.assertEqual(metadata["external_references"], ["https://example.test/tile.kml"])

    def test_kmz_missing_embedded_image_is_not_stored(self):
        payload = io.BytesIO()
        with zipfile.ZipFile(payload, "w") as archive:
            archive.writestr("doc.kml", '<kml><GroundOverlay><Icon><href>missing.png</href></Icon></GroundOverlay></kml>')
        result, _ = self.download("https://example.test/map.kmz", payload.getvalue())
        self.assertIsNone(result)
        self.assertFalse((self.root / "images/map.kmz").exists())

    def test_satellite_plan_keeps_scenes_geodata_and_explicit_dpm_exception(self):
        paths = ["before/PREVIEW.JPG", "after/PREVIEW.JPG", "CHIBA/Uki.kmz", "CHIBA/Uki.pdf", "MBRSC/areas.zip",
                 "EOS-RS_20260729_DPM_S1/EOS-RS_20260729_DPM_S1_Japan_Kumamoto_Earthquake_v0.9_MAIN.png",
                 "E04/jp_eos4_fre_30jul26_hh_sc1_jpg.jpg", "E04/jp_eos4_fre_30jul26_hh_sc1_jpg_sml.jpg",
                 "E04/jp_eos4_frs_30jul26_hh_sc2_jpg.jpg", "E04/jp_eos4_mrs_31jul26_hh_jpg.jpg", "R2/jp_r2_l4_02aug26_jpg.jpg"]
        page = "".join(f'<a href="article20260728JP/{p}">asset</a>' for p in paths).encode()
        assets = list(FETCH.satellite_assets(page))
        self.assertEqual(len({f"{a['group']}/{a['name']}" for a in assets}), len(paths))
        self.assertEqual(sum(a["excluded"] for a in assets), 4)
        self.assertEqual(sum(a["group"].endswith("products") for a in assets), 3)
        dpm = next(a for a in assets if a["name"].endswith("_MAIN.png"))
        self.assertGreater(dpm["max_bytes"], 12_704_520)


if __name__ == "__main__":
    unittest.main()
