#!/opt/miniconda3/bin/python
# xROAD 橋梁（熊本県 20291件・offset動けつき取得済みデータ）のうち、
# アプリの表示枠内のものを構造台帳候補として抽出・層化抽出して minify JSON を作る。
#
# 入力: kumamoto_real_data.zip 内 xroad_bridges_pref43.json
#       （tools/fetch_kumamoto_real.py が https://road-structures-db.mlit.go.jp/xROAD/api/v1/bridges?pref=43 で取得）
# 出力: tools/preprocess/xroadbr.min.json  … index.html に const XROADBR=<json>; として埋め込む
#       出力は 1 行の JSON 配列。要素のキー:
#         i=shisetsu_id(緯度経度), n=施設名, f=フリガナ, r=路線名, a=管理者, g=市区町村,
#         y=建設年度, l=橋長(m), w=幅員(m), tn=点検年度, h=判定区分(1〜4), s=措置状況(原コード),
#         la=緯度, lo=経度（いずれも実データ値を 4 桁に丸めた概略・表示用）
#
# 抽出条件（アプリとの整合）:
#   ・表示枠 lat 32.17-32.90 / lon 130.33-130.92 内（アプリ初回表示範囲）
#   ・施設名・路線名・建設年度・点検年度・判定区分が欠けていない
#   ・判定区分は 1/2/3/4 のみ（8:確認不能・9:未点検 相当は読み替えできないので除外）
#   ・市区町村名が空のレコード除外（管理者の所属が分からないため）
# 選び方: 市区町村ごとに seed 付きでシャッフルし、市区町村から交互に 360 件（余裕: 適用は 71 件）
import json, random, zipfile, sys
from collections import Counter

SEED = 20260407            # 再現可能なよう固定（README に明記）
N_KEEP = 360               # 埋め込み件数（実際の適用対象より多め）
FRAME = (32.17, 32.90, 130.33, 130.92)  # lat south, north, lon west, east
OK_HANTEI = {"1", "2", "3", "4"}

def load(zip_path):
    with zipfile.ZipFile(zip_path) as zf:
        d = json.loads(zf.read("xroad_bridges_pref43.json").decode())
    return d

def main(zip_path="kumamoto_real_data.zip", out="xroadbr.min.json"):
    d = load(zip_path)
    rs = d["result"]
    stats = Counter()
    ok = []
    for r in rs:
        stats["all"] += 1
        sk = r.get("shisetsu_kubun")
        y = r.get("syogen", {})
        sh = y.get("shisetsu", {})
        ro = y.get("rosen", {})
        ka = y.get("kanrisya", {})
        gy = y.get("gyousei_kuiki", {})
        ic = y.get("ichi", {})
        lat, lon = ic.get("ido"), ic.get("keido")
        t = r.get("tenken", {})
        kr = t.get("kiroku", {})
        sz = t.get("syuzen", {})
        hk = kr.get("hantei_kubun")
        name = sh.get("meisyou"); route = ro.get("meisyou")
        built = y.get("kasetsu_nendo"); tyear = t.get("nendo")
        city = gy.get("shikuchouson_mei")
        if sk != 1: stats["kubun!=1"] += 1; continue
        if lat is None or lon is None: stats["no-pos"] += 1; continue
        if not (FRAME[0] <= lat <= FRAME[1] and FRAME[2] <= lon <= FRAME[3]):
            stats["out-of-frame"] += 1; continue
        if not (name and route and built and tyear and city):
            stats["missing-fields"] += 1; continue
        if hk not in OK_HANTEI: stats["hantei!=1..4"] += 1; continue
        stats["ok"] += 1
        ok.append({
            "i": r.get("shisetsu_id"),
            "n": name, "f": sh.get("furigana"), "r": route, "a": ka.get("meisyou"),
            "g": city, "y": built, "l": y.get("kyouchou"), "w": y.get("fukuin"),
            "tn": tyear, "h": hk, "s": sz.get("sochi_joukyou"),
            "la": round(lat, 4), "lo": round(lon, 4),
        })
    # 市区町村ごとに seed 付きで並べ替え（並び順の偏りを除く）、全体は均等になるよう交互に取る
    rr = random.Random(SEED)
    groups = {}
    for rec in ok:
        groups.setdefault(rec["g"], []).append(rec)
    for g in groups: rr.shuffle(groups[g])
    keys = sorted(groups)
    pick = []
    idx = {g: 0 for g in keys}
    while len(pick) < min(N_KEEP, len(ok)):
        for g in keys:
            if idx[g] < len(groups[g]) and len(pick) < min(N_KEEP, len(ok)):
                pick.append(groups[g][idx[g]]); idx[g] += 1
    text = json.dumps(pick, ensure_ascii=False, separators=(",", ":"))
    with open(out, "w") as fh:
        fh.write(text)
    n_anchor = 8  # 公表被害に位置照合で対応づけた橋（FS1-6・R3・H2）は合成（BR全79件中）
    print(f"total={stats['all']} in-frame={stats['ok']} kept={len(pick)} "
          f"(app applies 79-{n_anchor}=71 of BR) bytes={len(text)}")
    by_c = Counter(p["g"] for p in pick)
    print("municipalities kept:", dict(by_c.most_common(5)))

if __name__ == "__main__":
    zip_path = sys.argv[1] if len(sys.argv) > 1 else "kumamoto_real_data.zip"
    out = sys.argv[2] if len(sys.argv) > 2 else "xroadbr.min.json"
    main(zip_path, out)
