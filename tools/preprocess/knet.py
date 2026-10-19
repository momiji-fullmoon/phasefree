"""K-NET/KiK-net ASCII -> station PGA (3-comp vector) and JMA instrumental intensity."""
import sys, os, glob, json, numpy as np

def read(fn):
    with open(fn, encoding="latin-1") as f: lines=f.read().splitlines()
    h={}
    for ln in lines[:17]:
        k=ln[:18].strip(); v=ln[18:].strip(); h[k]=v
    num,den=h["Scale Factor"].split("(gal)/")
    sf=float(num)/float(den)
    data=np.array(" ".join(lines[17:]).split(),dtype=float)
    acc=(data-data.mean())*sf
    fs=float(h["Sampling Freq(Hz)"].replace("Hz",""))
    return dict(code=h["Station Code"],lat=float(h["Station Lat."]),lon=float(h["Station Long."]),fs=fs,acc=acc,maxacc=float(h["Max. Acc. (gal)"]))

def jma_intensity(x,y,z,fs):
    n=max(len(x),len(y),len(z)); N=1<<int(np.ceil(np.log2(n)))
    f=np.fft.rfftfreq(N,1/fs); f[0]=1e-6
    X=f/10.0
    F1=np.sqrt(1/f); F2=(1+0.694*X**2+0.241*X**4+0.0557*X**6+0.009664*X**8+0.00134*X**10+0.000155*X**12)**-0.5
    F3=np.sqrt(1-np.exp(-(f/0.5)**3)); F=F1*F2*F3; F[0]=0
    out=[]
    for c in (x,y,z):
        s=np.zeros(N); s[:len(c)]=c
        out.append(np.fft.irfft(np.fft.rfft(s)*F,N)[:n])
    a=np.sqrt(out[0]**2+out[1]**2+out[2]**2)
    srt=np.sort(a)[::-1]; k=int(round(0.3*fs))
    a0=srt[k-1] if k<=len(srt) else srt[-1]
    I=2*np.log10(a0)+0.94
    return float(np.floor(round(I,3)*10+1e-9)/10) if I>0 else 0.0  # JMA: 小数第3位四捨五入→第2位切捨て→第1位表示

res={}
for root in sys.argv[1:]:
    ev=os.path.basename(root.rstrip("/"))
    st={}
    for net,suf in (("knet",("EW","NS","UD")),("kik",("EW2","NS2","UD2"))):
        for fe in glob.glob(os.path.join(root,net,"ascii","*."+suf[0])):
            base=fe[:-len(suf[0])]
            try:
                c=[read(base+s) for s in suf]
            except Exception as e:
                continue
            m=c[0]
            if not (31.9<=m["lat"]<=33.3 and 130.1<=m["lon"]<=131.2): continue
            L=min(len(q["acc"]) for q in c)
            ax,ay,az=(q["acc"][:L] for q in c)
            pga3=float(np.max(np.sqrt(ax**2+ay**2+az**2)))
            I=jma_intensity(ax,ay,az,m["fs"])
            st[m["code"]]=dict(net="K-NET" if net=="knet" else "KiK-net",lat=m["lat"],lon=m["lon"],pga=round(pga3,1),pgaH=round(max(c[0]["maxacc"],c[1]["maxacc"]),1),I=I)
    res[ev]=st
    print(ev,len(st),"stations; max I",max(v["I"] for v in st.values()),"max PGA",max(v["pga"] for v in st.values()))
json.dump(res,open(os.environ.get("OUT","knet.json"),"w"),ensure_ascii=False)
