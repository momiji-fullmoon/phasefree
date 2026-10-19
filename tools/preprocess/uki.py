import sys,json,base64,io,numpy as np
from PIL import Image
im=np.asarray(Image.open(sys.argv[1]).convert("RGB")).astype(float)
R,G,B=im[...,0],im[...,1],im[...,2]
white=(R>245)&(G>245)&(B>245)
idx=np.clip(1-G/255,0,1); idx[white]=0
# mask north arrow (top-right)
idx[:80,1260:]=0
h,w=idx.shape
# coarse grid for sampling (~25 m cells): 1337x898 px over ~6.7x4.5 km -> 1px~5m ; use 5x5 blocks
bs=5; gh,gw=h//bs,w//bs
g=idx[:gh*bs,:gw*bs].reshape(gh,bs,gw,bs).mean(axis=(1,3))
q=np.clip(np.round(g*255),0,255).astype(np.uint8)
print("grid",gw,gh,"mean",g.mean().round(3),"p95",np.percentile(g,95).round(3),"colored frac",(~white).mean().round(3))
# transparent overlay downscaled
rgba=np.dstack([im,np.where(white,0,255)]).astype(np.uint8); rgba[:80,1260:,3]=0
ov=Image.fromarray(rgba,"RGBA").resize((334,225),Image.LANCZOS).quantize(colors=48,method=Image.FASTOCTREE)
buf=io.BytesIO();ov.save(buf,"PNG",optimize=True)
print("overlay bytes",len(buf.getvalue()))
json.dump({"w":gw,"h":gh,"grid":base64.b64encode(q.tobytes()).decode(),"img":"data:image/png;base64,"+base64.b64encode(buf.getvalue()).decode(),
 "quad":[[130.65437,32.627139],[130.72566,32.62618],[130.72644,32.66671],[130.65512,32.667671]]},open(sys.argv[2],"w"))
