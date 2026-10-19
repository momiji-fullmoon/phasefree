#!/usr/bin/env python3
"""施設ごとの地盤・地質属性の取得（J-SHIS 表層地盤V4・地震ハザード・地すべり地形、産総研 シームレス地質図 1.3.1）

使い方:
    python ground.py facilities_latlon.json ground.json
    # facilities_latlon.json は [{"c":資産ID,...,"lat":..,"lon":..}]（ground.py 内で抽出済みならそのまま使う）

- 認証不要。J-SHIS とシームレス地質図の取得間隔を 0.5 秒あけ、失敗は null で記録して続行
- 出力は資産ID→属性の辞書。岩相・AVSなどの値は、施設の被害や安全性を直接判定しない（調査対象の選別に使う属性として記録）
- J-SHIS の place は 経度,緯度 の順。シームレス地質図の point は 緯度,経度 の順（アダプタで吸収）
- J-SHIS の再配布条件に注意：原データそのままの第三者配布はせず、出典表示を保持する
"""
import json, os, sys, time, gzip, urllib.request

UA = "kumamoto-demo-ground/1.0 (research; AIST)"
SSHIS = "https://www.j-shis.bosai.go.jp/map/api/"
SGM = "https://gbank.gsj.jp/seamless/v2/api/1.3.1/"

def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            b = r.read()
            if b[:2] == b"\x1f\x8b":
                b = gzip.decompress(b)
            return r.status, b
    except Exception as e:
        return -1, str(e).encode()

def jshis_mesh(lat, lon):
    st, b = get(f"{SSHIS}sstrct/V4/meshinfo.geojson?position={lon},{lat}&epsg=4326")
    out = {}
    if st != 200:
        return {"err": st}
    j = json.loads(b)
    f = (j.get("features") or [{}])[0]
    p = f.get("properties") or {}
    out = dict(JNAME=p.get("JNAME"), JCODE=p.get("JCODE"), AVS=p.get("AVS"),
               ARV=p.get("ARV"), AVS_EB=p.get("AVS_EB"), AVS_REF=p.get("AVS_REF"),
               meshcode=j.get("metaData", {}).get("meshcode"), version=j.get("metaData", {}).get("version"))
    # 近傍メッシュでnullの場合はfeaturesの1件目の属性を採る
    return out if any(v for v in out.values() if v is not None) else(out if out else {"err": "empty"})

def jshis_pshm(lat, lon):
    st, b = get(f"{SSHIS}pshm/Y2024/AVR/TTL_MTTL/meshinfo.geojson?position={lon},{lat}&epsg=4326&attr=T30_I55_PS")
    if st != 200:
        return {"err": st}
    j = json.loads(b)
    f = (j.get("features") or [{}])[0]
    return dict(T30_I55_PS=f.get("properties", {}).get("T30_I55_PS"), meshcode=j.get("metaData", {}).get("meshcode"))

def jshis_slide(lat, lon):
    st, b = get(f"{SSHIS}landslide/isContaining.json?position={lon},{lat}&epsg=4326")
    if st != 200:
        return {"err": st}
    j = json.loads(b)
    sc = j.get("metaData", {}).get("scarps") or []
    mm = j.get("metaData", {}).get("movingmass_polygons") or []
    return dict(isContaining=j.get("isContaining"), scarps=len(sc), moving=len(mm),
                meshcode=j.get("metaData", {}).get("meshcode"))

def sgm(lat, lon):
    st, b = get(f"{SGM}legend.json?point={lat},{lon}")
    if st not in (200, 204):
        return {"err": st}
    try:
        j = json.loads(b)
    except Exception:
        return {"err": "notjson", "body": b[:100].decode("utf-8", "replace")}
    if not j:
        return {}  # 海域など凡例なし
    r = {}
    if isinstance(j, list):
        r = j[0] if len(j) == 1 else {"multi": len(j), "first": j[0]}
    elif isinstance(j, dict):
        r = j
    return dict(symbol=r.get("symbol"), title=r.get("title"), age_ja=r.get("formationAge_ja"),
                group_ja=r.get("group_ja")) if not r.get("multi") else dict(multi=r["multi"], symbol=r["first"].get("symbol"), title=r["first"].get("title"))

def fetch_one(lat, lon):
    d = {}
    d["mesh"] = jshis_mesh(lat, lon); time.sleep(0.5)
    d["pshm"] = jshis_pshm(lat, lon); time.sleep(0.5)
    d["slide"] = jshis_slide(lat, lon); time.sleep(0.5)
    d["geo"] = sgm(lat, lon); time.sleep(0.3)
    return d

def main():
    srcf, outf = sys.argv[1], sys.argv[2]
    facs = json.load(open(srcf, encoding="utf-8"))
    cache = json.load(open(outf, encoding="utf-8")) if os.path.exists(outf) else {}
    for n, rec in enumerate(facs):
        key, lat, lon = rec["id"], rec["lat"], rec["lon"]
        old = cache.get(key)
        if old and all(old.values()) and not any(isinstance(v, dict) and "err" in v for v in old.values()):
            continue
        cache[key] = fetch_one(rec["lat"], rec["lon"])
        if n % 20 == 4:
            json.dump(cache, open(outf, "w", encoding="utf-8"), ensure_ascii=False)
            print(f"{n+1}/{len(facs)}")
    json.dump(cache, open(outf, "w", encoding="utf-8"), ensure_ascii=False)
    errs = sum(1 for v in cache.values() for k in v if v[k] and isinstance(v[k], dict) and "err" in v[k])
    print(f"→ {outf}: {len(cache)} 件, エラー {errs}")

if __name__ == "__main__":
    main()
