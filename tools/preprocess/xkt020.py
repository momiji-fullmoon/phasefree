# XKT020（大規模盛土造成地・不動産情報ライブラリ）タイル reputable を、
# アプリの地図に埋め込めるよう、熊本県内で表示枠内のポリゴンに絞り minify する。
#
# 入力: kumamoto_real_data.zip 内 reinfolib/XKT020/*.geojson
#       （tools/fetch_kumamoto_real.py が tiling for bbox で取得）
# 出力: tools/preprocess/xkt020.min.json … index.html に const XKT=<json>; として埋め込む
#   要素: {n:管理番号, c:市区町村, k:区分(谷埋め型/腹付け型), r:[[x,y],...]（ページ座標・1 桁）}
#   ページ座標への換算は index.html と同じ: x=(lon-130.28)*843, y=(32.92-lat)*1000
#   内側リング（真の孔）は現データに 1 件あるが捨てる（概略範囲に影響しないため）。
import json, zipfile, glob

KX, KY, LON0, LAT0 = 843, 1000, 130.28, 32.92   # index.html の定義と同じ
FRAME = (32.17, 32.90, 130.33, 130.92)

def main(zip_path="kumamoto_real_data.zip", out="xkt020.min.json"):
    with zipfile.ZipFile(zip_path) as zf:
        names = [n for n in zf.namelist() if n.startswith("reinfolib/XKT020/") and n.endswith(".geojson")]
        feats = []
        for n in sorted(names):
            d = json.loads(zf.read(n).decode())
            feats += d["features"]
    kept, skipped = [], {"x-42": 0, "out-of-frame": 0, "not-poly": 0, "empty": 0}
    for ft in feats:
        g = ft["geometry"]; p = ft["properties"]
        if p.get("prefecture_code") != "43":
            skipped["x-42"] += 1; continue
        if g["type"] == "Polygon": rings = [g["coordinates"][:1]]
        elif g["type"] == "MultiPolygon": rings = [c[:1] for c in g["coordinates"]]
        else: skipped["not-poly"] += 1; continue
        pts = [pt for rr in rings for pt in rr[0]]
        if not pts: skipped["empty"] += 1; continue
        cx = sum(pt[0] for pt in pts) / len(pts); cy = sum(pt[1] for pt in pts) / len(pts)
        if not (FRAME[0] <= cy <= FRAME[1] and FRAME[2] <= cx <= FRAME[3]):
            skipped["out-of-frame"] += 1; continue
        kept.append({"n": p.get("embankment_number"), "c": p.get("city_name"),
                     "k": p.get("embankment_classification"),
                     "r": [[[round((lo - LON0) * KX, 1), round((LAT0 - la) * KY, 1)] for lo, la in rr[0]] for rr in rings]})
        # 出力の "r" は [リング, リング…]（MultiPolygon は複数リング）、各リングは [[x,y],…]
    text = json.dumps(kept, ensure_ascii=False, separators=(",", ":"))
    with open(out, "w") as fh:
        fh.write(text)
    import collections
    k_c = collections.Counter(k["k"] for k in kept)
    print(f"features={len(feats)} kept={len(kept)} polys={sum(len(x['r']) for x in kept)} skipped={skipped} bytes={len(text)}")
    print("classification:", dict(k_c))

if __name__ == "__main__":
    import sys
    zip_path = sys.argv[1] if len(sys.argv) > 1 else "kumamoto_real_data.zip"
    out = sys.argv[2] if len(sys.argv) > 2 else "xkt020.min.json"
    main(zip_path, out)
