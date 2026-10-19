#!/usr/bin/env python3
"""熊本デモ用の実データ取得スクリプト（国土交通データプラットフォーム + xROAD 橋梁 + 不動産情報ライブラリ）

使い方（Python 3.8+、追加パッケージ不要）:
    export DPF_KEY=（国土交通データプラットフォームのAPIキー）
    export REINFOLIB_KEY=（不動産情報ライブラリのAPIキー）   # Windows PowerShell: $env:REINFOLIB_KEY="..."
    python fetch_kumamoto_real.py            # 全部
    python fetch_kumamoto_real.py dpf        # DPFだけ（xroad / reinfolib も指定可）
    → kumamoto_real_data.zip ができるので、それをチャットに添付する

- APIキーは環境変数から読むだけで、出力ファイルには書き込まない（manifest の URL にも含めない）
- 範囲：熊本県南部のデモ範囲（北緯32.17–32.90、東経130.33–130.92）
- 不動産情報ライブラリはタイル（z/x/y）単位の取得。サーバーへの負荷を避けるため 0.25 秒間隔
- 応答はそのまま保存し、件数と HTTP 状態を manifest.json に記録する（加工はチャット側で行う）
"""
import gzip, io, json, math, os, sys, time, urllib.error, urllib.request, zipfile
from datetime import datetime, timezone

BBOX = dict(s=32.17, n=32.90, w=130.33, e=130.92)
OUT = "kumamoto_real_data.zip"
UA = "kumamoto-demo-fetch/1.0 (research; AIST)"
REINFO = "https://www.reinfolib.mlit.go.jp/ex-api/external/{api}?response_format=geojson&z={z}&x={x}&y={y}"
# (API識別子, 内容, 試すズーム)。ズームの受付範囲はAPIごとに違うため、順に試して最初に通ったものを使う
REINFO_APIS = [
    ("XKT020", "大規模盛土造成地", [13, 14, 15, 11]),
    ("XKT006", "学校", [13, 14, 15]),
    ("XKT010", "医療機関", [13, 14, 15]),
    ("XKT011", "福祉施設", [13, 14, 15]),
    ("XKT018", "市区町村役場・集会施設等", [13, 14, 15]),
    ("XGT001", "指定緊急避難場所", [13, 14, 15]),
    ("XKT021", "地すべり防止地区", [13, 14, 15, 11]),
    ("XKT022", "急傾斜地崩壊危険区域", [13, 14, 15, 11]),
    ("XKT025", "液状化（地形区分に基づく発生傾向）", [13, 14, 15, 11]),
    ("XKT026", "洪水浸水想定区域", [13, 14, 15, 11]),
    ("XKT027", "高潮浸水想定区域", [13, 14, 15, 11]),
    ("XKT028", "津波浸水想定", [13, 14, 15, 11]),
    ("XKT029", "土砂災害警戒区域", [13, 14, 15, 11]),
    ("XKT013", "将来推計人口（250mメッシュ）", [13, 14, 15, 11]),
]
XROAD = "https://road-structures-db.mlit.go.jp/xROAD/api/v1/{kind}?pref=43&limit=10000"
XROAD_KINDS = ["bridges", "tunnels"]  # tunnels は無い場合あり（状態を記録して続行）


def tiles(z):
    def tx(lon): return int((lon + 180) / 360 * 2 ** z)
    def ty(lat):
        r = math.radians(lat)
        return int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** z)
    return [(x, y) for x in range(tx(BBOX["w"]), tx(BBOX["e"]) + 1) for y in range(ty(BBOX["n"]), ty(BBOX["s"]) + 1)]


def get(url, headers=None, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "gzip", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            b = r.read()
            if r.headers.get("Content-Encoding") == "gzip" or b[:2] == b"\x1f\x8b":
                b = gzip.decompress(b)
            return r.status, b
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:500]
    except Exception as e:  # 接続失敗など
        return -1, str(e).encode()


DPF = "https://data-platform.mlit.go.jp/api/v1/"
# (データセットID, 内容, 1件あたり取得するか, 上限件数)。IDは公式サンプルで確認できたもの
DPF_SETS = [
    ("rsdb_bridge", "全国道路施設点検DB 橋梁", 20000),
    ("cals_construction", "電子納品 工事", 5000),
    ("cals_design", "電子納品 業務", 5000),
    ("cals_pointcloud", "電子納品 3次元点群", 5000),
    ("nlni_ksj-p04", "医療機関", 5000),
    ("nlni_ksj-p20", "避難施設", 5000),
    ("nlni_ksj-a27", "小学校区", 5000),
    ("rtc_2021", "道路交通センサス2021", 20000),
    ("hwq_rain", "水文水質DB 雨量観測所", 2000),
]
CATALOG_Q = """query { dataCatalog(IDs: null) { id title datasets { id title data_count description spatial temporal
  accrualPeriodicity modified dpf_data_update_date accessRights license licenseURL download_method homepage
  datatype_desc { attributes { name display_name variable_type } } } } }"""
SEARCH_Q = """query { search(first: %d, size: %d, term: %s, attributeFilter: %s) { totalNumber searchResults {
  id title catalog_id dataset_id lat lon year metadata shape files { id original_path } relatedData { id title catalog_id dataset_id } } } }"""


def dpf(q, key):
    body = json.dumps({"query": q}).encode()
    req = urllib.request.Request(DPF, data=body, method="POST", headers={"User-Agent": UA, "Content-Type": "application/json", "apikey": key})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read()[:500].decode("utf-8", "replace")}
    except Exception as e:
        return -1, {"error": str(e)}


def gql_filter(dsid, pref):
    conds = ['{ attributeName: "DPF:dataset_id", is: %s }' % json.dumps(dsid)]
    if pref:
        conds.append('{ attributeName: "DPF:prefecture_name", is: "熊本県" }')
    return "{ AND: [ %s ] }" % ", ".join(conds)


def dpf_fetch_set(zf, man, key, dsid, label, cap):
    rec = {"label": label, "mode": None, "total": None, "fetched": 0, "in_bbox": 0, "errors": []}
    for pref, term in ((True, '""'), (False, '"熊本"')):
        st, j = dpf(SEARCH_Q % (0, 1, term, gql_filter(dsid, pref)), key)
        tot = (((j or {}).get("data") or {}).get("search") or {}).get("totalNumber") if st == 200 else None
        if tot:
            rec["mode"] = "prefecture_filter" if pref else "term=熊本"
            rec["total"] = tot
            break
        rec["errors"].append({"status": st, "pref": pref, "body": str(j)[:200]})
        time.sleep(0.3)
    if not rec["total"]:
        man["dpf"][dsid] = rec
        print(f"DPF {dsid}: 該当なし／取得失敗")
        return
    out, first, size = [], 0, 100
    while first < min(rec["total"], cap):
        st, j = dpf(SEARCH_Q % (first, size, '""' if rec["mode"] == "prefecture_filter" else '"熊本"', gql_filter(dsid, rec["mode"] == "prefecture_filter")), key)
        if st != 200 or "errors" in j:
            rec["errors"].append({"first": first, "status": st, "body": str(j)[:200]})
            break
        rs = j["data"]["search"]["searchResults"]
        if not rs:
            break
        out.extend(rs)
        first += size
        time.sleep(0.3)
    rec["fetched"] = len(out)
    rec["in_bbox"] = sum(1 for r in out if r.get("lat") and r.get("lon") and BBOX["s"] <= float(r["lat"]) <= BBOX["n"] and BBOX["w"] <= float(r["lon"]) <= BBOX["e"])
    # レコード単位の取得区分：metadata/shape だけか、files / downloadURLs / dataURLs があるか
    def cls(r):
        m = r.get("metadata") or {}
        if r.get("files"):
            return "files"
        if m.get("DPF:downloadURLs"):
            return "downloadURLs"
        if m.get("DPF:dataURLs"):
            return "dataURLs_only"
        return "metadata_shape"
    rec["record_access"] = {}
    for r in out:
        k = cls(r)
        rec["record_access"][k] = rec["record_access"].get(k, 0) + 1
    zf.writestr(f"dpf/{dsid}.json", json.dumps(out, ensure_ascii=False))
    man["dpf"][dsid] = rec
    print(f"DPF {dsid}: 全 {rec['total']} 件中 {rec['fetched']} 件取得（範囲内 {rec['in_bbox']}）{rec['record_access']}")


def main():
    key = os.environ.get("REINFOLIB_KEY", "").strip()
    dkey = os.environ.get("DPF_KEY", "").strip()
    only = set(sys.argv[1:]) or {"dpf", "xroad", "reinfolib"}
    started = datetime.now(timezone.utc).isoformat()
    man = {"started_utc": started, "bbox": BBOX, "dpf": {}, "xroad": {}, "reinfolib": {}}
    zf = zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED)

    # 0) 国土交通データプラットフォーム（APIキー必須）
    if "dpf" in only and not dkey:
        print("DPF_KEY が未設定のため、DPFは取得しません")
    elif "dpf" in only:
        st, cat = dpf(CATALOG_Q, dkey)
        zf.writestr("dpf/_catalog.json", json.dumps(cat, ensure_ascii=False))
        man["dpf"]["_catalog"] = {"status": st}
        try:
            cats = cat["data"]["dataCatalog"]
            man["dpf"]["_catalog"]["catalogs"] = len(cats)
            # 熊本県施設管理DBなど、タイトル・説明に「熊本」を含むデータセットを探す
            kuma = [(c["id"], d["id"], d["title"], d.get("data_count")) for c in cats for d in (c.get("datasets") or [])
                    if "熊本" in (d.get("title") or "") + (d.get("description") or "") + (c.get("title") or "")]
            man["dpf"]["_catalog"]["kumamoto_datasets"] = kuma
            print(f"DPF カタログ: {len(cats)} 件、熊本を含むデータセット {len(kuma)} 件")
        except Exception as e:
            kuma = []
            print("DPF カタログの取得に失敗:", st, str(cat)[:200])
        for dsid, label, cap in DPF_SETS + [(d, t, 3000) for (_, d, t, _) in kuma[:20]]:
            dpf_fetch_set(zf, man, dkey, dsid, label, cap)

    # 1) xROAD（無料API、キー不要）。全件数は offset ページングで取得（1回は10000件上限）
    for kind in (XROAD_KINDS if "xroad" in only else []):
        rec = {"count": None, "fetched": 0, "pages": 0, "errors": [], "meta": None}
        merged, offset = [], 0
        while True:
            url = XROAD.format(kind=kind) + f"&offset={offset}"
            st, b = get(url, timeout=180)
            try:
                j = json.loads(b)
                page = j.get("result")
                rs = j.get("resultset") or {}
                total = rs.get("count")
            except Exception:
                page, total = None, None
            if st != 200 or not isinstance(page, list) or total is None or rs.get("is_error"):
                rec["errors"].append({"offset": offset, "status": st, "body": b[:200].decode("utf-8", "replace")})
                break
            merged.extend(page)
            offset += len(page)
            rec["count"], rec["pages"], rec["meta"] = total, rec["pages"] + 1, rec["meta"] or j.get("metadata")
            if not page or offset >= total:
                break
            time.sleep(0.25)
        rec["fetched"] = len(merged)
        man["xroad"][kind] = rec
        if merged:
            zf.writestr(f"xroad_{kind}_pref43.json", json.dumps(
                {"metadata": rec["meta"], "resultset": {"count": rec["count"], "offset": 0, "limit": rec["fetched"]},
                 "result": merged}, ensure_ascii=False))
        print(f"xROAD {kind}: 全 {rec['count']} 件中 {rec['fetched']} 件取得（{rec['pages']}回）エラー {len(rec['errors'])}")

    # 2) 不動産情報ライブラリ（APIキー必須）
    if "reinfolib" not in only:
        pass
    elif not key:
        print("REINFOLIB_KEY が未設定のため、不動産情報ライブラリは取得しません")
    else:
        for api, label, zooms in REINFO_APIS:
            used, feats, fails = None, 0, []
            for z in zooms:
                ts = tiles(z)
                st, b = get(REINFO.format(api=api, z=z, x=ts[len(ts) // 2][0], y=ts[len(ts) // 2][1]), {"Ocp-Apim-Subscription-Key": key})
                if st in (200, 204):
                    used = z
                    break
                fails.append({"z": z, "status": st, "body": b[:200].decode("utf-8", "replace")})
                time.sleep(0.25)
            rec = {"label": label, "zoom": used, "tiles": 0, "features": 0, "errors": [], "probe_failures": fails,
                   "url_template": REINFO.format(api=api, z="{z}", x="{x}", y="{y}")}
            if used is None:
                man["reinfolib"][api] = rec
                print(f"{api} {label}: 受付ズームが見つからない（{fails[:1]}）")
                continue
            for (x, y) in tiles(used):
                st, b = get(REINFO.format(api=api, z=used, x=x, y=y), {"Ocp-Apim-Subscription-Key": key})
                time.sleep(0.25)
                if st == 200 and b:
                    try:
                        n = len(json.loads(b).get("features", []))
                    except Exception:
                        n = -1
                    if n:
                        zf.writestr(f"reinfolib/{api}/{used}_{x}_{y}.geojson", b)
                        rec["tiles"] += 1
                        rec["features"] += max(n, 0)
                elif st not in (200, 204, 404):
                    rec["errors"].append({"x": x, "y": y, "status": st})
            man["reinfolib"][api] = rec
            print(f"{api} {label}: z={used}, タイル {rec['tiles']}, 地物 {rec['features']}, エラー {len(rec['errors'])}")

    man["finished_utc"] = datetime.now(timezone.utc).isoformat()
    man["note"] = "APIキーは含まない。出典：国土交通データプラットフォーム、国土交通省 全国道路施設点検データベース（xROAD）、国土交通省 不動産情報ライブラリ。fileDownloadURLs（有効期限60秒）による原ファイルの取得は行っていない"
    zf.writestr("manifest.json", json.dumps(man, ensure_ascii=False, indent=1))
    zf.close()
    print(f"→ {OUT} を作成しました")


if __name__ == "__main__":
    sys.exit(main())
