import shapefile,json,sys,collections
D=sys.argv[1]; OUT=sys.argv[2]
W,E,Sb,N=130.15,131.05,32.05,33.0
def inb(pts): return any(W<=x<=E and Sb<=y<=N for x,y in pts)
def rnd(pts): 
    out=[];prev=None
    for x,y in pts:
        q=(round(x,4),round(y,4))
        if q!=prev: out.append(list(q));prev=q
    return out
def srs(r):
    for i in range(len(r)):
        try: sh=r.shape(i)
        except Exception: continue
        yield sh,r.record(i)
def parts(sh):
    idx=list(sh.parts)+[len(sh.points)]
    return [sh.points[idx[i]:idx[i+1]] for i in range(len(idx)-1)]
res={}
def lines(name,keyf=None):
    r=shapefile.Reader(f"{D}/{name}_jpn.shp",encoding="utf-8");feats=[];cnt=collections.Counter()
    for shp,rec0 in srs(r):
        for p in parts(shp):
            if inb(p):
                rec=rec0.as_dict();k=keyf(rec) if keyf else 0;cnt[k]+=1;feats.append([k,rnd(p)])
    print(name,len(feats),dict(cnt));return feats
res["coast"]=lines("coastl")
res["road"]=lines("roadl",lambda r:r["rtt"])
res["rail"]=lines("raill")
res["river"]=lines("riverl")
r=shapefile.Reader(f"{D}/polbnda_jpn.shp",encoding="utf-8");mun=[]
for shp,rec0 in srs(r):
    ps=[p for p in parts(shp)]
    if any(inb(p) for p in ps):
        rec=rec0.as_dict();mun.append({"n":rec["laa"],"c":rec["adm_code"],"pop":rec["pop"],"rings":[rnd(p) for p in ps]})
print("mun",len(mun),[m["n"] for m in mun][:40])
res["mun"]=mun
r=shapefile.Reader(f"{D}/builtupa_jpn.shp",encoding="utf-8");bu=[]
for shp,rec0 in srs(r):
    ps=parts(shp)
    if any(inb(p) for p in ps): bu.append({"n":rec0.as_dict()["nam"],"rings":[rnd(p) for p in ps]})
print("builtup",len(bu));res["built"]=bu
for nm in ["portp","airp","rstatp"]:
    r=shapefile.Reader(f"{D}/{nm}_jpn.shp",encoding="utf-8");pts=[]
    for shp,rec0 in srs(r):
        x,y=shp.points[0]
        if W<=x<=E and Sb<=y<=N: pts.append([rec0.as_dict()["nam"],round(x,4),round(y,4)])
    print(nm,pts);res[nm]=pts
s=json.dumps(res,separators=(",",":"),ensure_ascii=False);open(OUT,"w").write(s);print("bytes",len(s))
