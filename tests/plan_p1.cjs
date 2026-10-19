const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs/promises');

const root = path.resolve(__dirname, '..');
async function ready(p) { await p.waitForFunction(() => typeof OPS !== 'undefined' && OPS.ready && S.plan); await p.evaluate(() => PLAN_READY); }
async function saved(p) { await p.evaluate(() => OPS.saveQueue); }
async function record(p, assetId, options) {
  await p.evaluate(id => { S.sel=AS.find(a=>a.id===id).i; S.tab='why'; render(); }, assetId);
  await p.click('#tabbody button[data-plan-record]');
  const form=p.locator('#plan-record-form');
  await form.locator('[name=actor]').fill('P1検証担当');
  await form.locator('[name=status]').selectOption(options.status || 'completed');
  await form.locator('[name=damage]').selectOption(options.damage || 'unknown');
  await form.locator('[name=condition]').selectOption(options.condition == null ? '' : String(options.condition));
  if(options.reason) await form.locator('[name=reason]').selectOption(options.reason);
  if(options.observedAt) await form.locator('[name=observedAt]').fill(options.observedAt);
  if(options.availableAt) await form.locator('[name=availableAt]').fill(options.availableAt);
  if(options.checks !== false) for(const c of await form.locator('[name=checked]').all()) await c.check();
  await form.locator('[name=notes]').fill(options.notes);
  await form.locator('button[type=submit]').click();
  await p.waitForFunction(note=>OPS.state.observations.some(o=>o.notes===note),options.notes);
  await saved(p);
  return p.evaluate(note=>OPS.state.observations.find(o=>o.notes===note),options.notes);
}
async function flow(browser,url) {
  const context=await browser.newContext({viewport:{width:1440,height:1100}}), p=await context.newPage(), errors=[];
  p.on('pageerror',e=>errors.push(e.message));
  await p.goto(url); await ready(p);
  const target=await p.evaluate(()=>{
    const a=AS.find(a=>TYPES[a.type].grp==='road'&&a.p0>.01&&a.p0<.95);
    return {id:a.id,p0:a.p0,condition:a.cond,newCondition:a.cond>=2?0:3,normalScore:scoreNormal(a).score};
  });
  const initialIds=await p.evaluate(()=>OPS.state.runs.map(r=>r.id));
  const normal=await record(p,target.id,{condition:target.newCondition,notes:'平時の所見を次回判断に反映するP1検証'});
  assert.equal(normal.source,'staff'); assert.equal(normal.caseId,'C-NORM'); assert.equal(normal.updatesBaseline,true);
  assert.notEqual(await p.evaluate(id=>scoreNormal(AS.find(a=>a.id===id)).score,target.id),target.normalScore);
  await p.click('#ph-post'); await saved(p);
  const adopted=await p.evaluate(id=>{const a=AS.find(a=>a.id===id);return {baseline:planPrior(a),confirmed:S.confirmed.has(a.i)};},target.id);
  assert.equal(adopted.baseline.observationId,normal.id); assert.equal(adopted.confirmed,false);
  assert.ok(Math.abs(adopted.baseline.p0-target.p0)>1e-6,'stored routine record must change the actual earthquake prior');
  const deferred=await record(p,target.id,{status:'deferred',reason:'unreachable',checks:false,notes:'通行止めのため未実施：迂回と管理者照会が必要'});
  assert.equal(deferred.caseId,'C-EMG'); assert.notEqual(deferred.runId,normal.runId); assert.equal(deferred.damage,'unknown');
  assert.equal(await p.evaluate(id=>S.confirmed.has(AS.find(a=>a.id===id).i),target.id),false);
  const runCount=await p.evaluate(()=>OPS.state.runs.length);
  await p.evaluate(()=>{recompute('P1重複防止1');recompute('P1重複防止2');});
  assert.equal(await p.evaluate(()=>OPS.state.runs.length),runCount);
  await p.click('#ph-normal'); await p.click('#ph-post'); await saved(p);
  assert.equal(await p.evaluate(()=>OPS.state.observations.length),2);
  assert.equal(await p.evaluate(()=>OPS.state.runs.length),runCount);
  assert.equal(await p.evaluate(id=>planPrior(AS.find(a=>a.id===id)).observationId,target.id),normal.id);

  await p.evaluate(()=>{S.crew.road=0; recompute('担当班なしの検証');S.tab='plan';renderTabs();});
  assert.ok(await p.locator('#plan-unassigned details[data-reason=no_team]').count());
  assert.equal(await p.evaluate(()=>PlanCore.activeRuns(OPS.state,planCaseCurrent().id).filter(r=>r.reason==='no_team').every(r=>r.status!=='completed')),true);
  await p.evaluate(()=>{S.crew.road=3;recompute('班を復元');RP.view='rev';S.tab='rplan';render();});
  const revision=await p.evaluate(id=>PlanCore.visibleRevisions(OPS.state,planCaseCurrent().id).find(p=>p.evidence.some(e=>e.id===id)),deferred.id);
  assert.ok(revision); assert.ok(revision.references.every(r=>r.versionId));
  const review=p.locator(`[data-revision-id="${revision.id}"] form`);
  await review.locator('[name=status]').selectOption('reflected');
  await review.locator('[name=note]').fill('次回点検に迂回条件の確認を反映（アプリ内）');
  await review.locator('button[type=submit]').click(); await saved(p);
  assert.equal(await p.evaluate(id=>OPS.state.revisions.find(p=>p.id===id).status,revision.id),'reflected');

  await p.evaluate(()=>{RP.view='records';S.tab='rplan';render();});
  const downloadPromise=p.waitForEvent('download'); await p.click('[data-plan-action=export]');
  const download=await downloadPromise, stream=await download.createReadStream(), chunks=[];
  for await(const c of stream) chunks.push(c);
  const exported=Buffer.concat(chunks), data=JSON.parse(exported.toString());
  assert.equal(data.state.observations.length,2); assert.ok(data.state.snapshots.some(s=>s.inputs.some(a=>a.observationId===normal.id)));
  assert.equal(data.state.snapshots.at(-1).context.modelParameters.sigma,.4);
  assert.ok(data.state.snapshots.at(-1).inputs.every(a=>Number.isFinite(a.intensity)&&Number.isFinite(a.theta)));
  await p.reload(); await ready(p); await saved(p);
  assert.equal(await p.evaluate(()=>S.phase),'post');
  assert.deepEqual(await p.evaluate(()=>OPS.state.observations.map(o=>o.id)),[normal.id,deferred.id]);
  assert.equal(await p.evaluate(()=>OPS.saveKind),'saved');
  await p.evaluate(()=>{S.tab='rplan';render();});
  const bad={...data,version:999};
  await p.locator('#plan-import').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(bad))});
  await p.waitForFunction(()=>OPS.error.includes('対応していない'));
  assert.equal(await p.evaluate(()=>OPS.state.observations.length),2);
  await p.locator('#plan-import').setInputFiles({name:'records.json',mimeType:'application/json',buffer:exported});
  await p.waitForFunction(()=>OPS.state.observations.length===2&&OPS.error===''); await saved(p);
  assert.deepEqual(await p.evaluate(()=>OPS.state.observations.map(o=>o.id)),[normal.id,deferred.id]);
  assert.equal(await p.evaluate(()=>OPS.state.runs.length),runCount);

  await p.evaluate(()=>{RP.view='records';S.tab='rplan';render();});
  const pinned=await p.evaluate(id=>OPS.state.runs.find(r=>r.id===id).definition.references[0],normal.runId);
  await p.evaluate(()=>{PLAN_DOCS[0].secs[0].t='新しい版の仮本文（旧実行を差し替えない検証）';});
  await p.evaluate(id=>{RP.sourceRunId=id;RP.view='docs';S.tab='rplan';render();},normal.runId);
  assert.ok((await p.locator('#plan-pinned-source').innerText()).includes(pinned.text));
  assert.equal((await p.locator('#plan-pinned-source').innerText()).includes('新しい版の仮本文'),false);

  await p.evaluate(()=>{while(S.ev<EVENTS.length && !planCaseCurrent().ingested.includes('F1')) injectNext();}); await saved(p);
  const simulation=await p.evaluate(()=>OPS.state.observations.filter(o=>o.sourceEventKey==='F1').map(o=>o.id));
  assert.ok(simulation.length); assert.equal(await p.evaluate(()=>OPS.state.observations.filter(o=>o.sourceEventKey==='F1').every(o=>o.source==='synthetic')),true);
  await p.evaluate(()=>planRewind());
  assert.equal(await p.evaluate(()=>S.confirmed.size),0);
  await p.evaluate(()=>{while(S.ev<EVENTS.length&&EVENTS[S.ev-1].k!=='F1')injectNext();});
  assert.deepEqual(await p.evaluate(()=>OPS.state.observations.filter(o=>o.sourceEventKey==='F1').map(o=>o.id)),simulation);
  await p.evaluate(()=>{RP.view='tasks';S.tab='rplan';render();});
  const originalCase=await p.evaluate(()=>planCaseCurrent().id);
  await p.click('[data-plan-action=recheck]'); await saved(p);
  const recheck=await p.evaluate(id=>({run:planRunFor(AS.find(a=>a.id===id)),count:OPS.state.observations.length}),target.id);
  assert.notEqual(recheck.run.id,deferred.runId); assert.equal(recheck.run.status==='completed',false);
  await p.click('[data-plan-action=new-case]'); await saved(p);
  assert.notEqual(await p.evaluate(()=>planCaseCurrent().id),originalCase);
  assert.equal(await p.evaluate(()=>OPS.state.observations.length),recheck.count);
  await p.evaluate(async()=>{const actual=OPS.storage.save; OPS.storage.save=async()=>{throw new Error('quota-test');};await planPersist();OPS.storage.save=actual;});
  assert.equal(await p.evaluate(()=>OPS.saveKind),'error');
  assert.ok((await p.locator('[data-plan-save-status]').innerText()).includes('quota-test'));
  await p.evaluate(()=>planPersist()); await saved(p);
  assert.deepEqual(errors,[]);
  console.log(`${new URL(url).protocol} P1: routine → earthquake, deferred work, revision, reload, JSON, replay, recheck and save failure OK (${exported.length} byte export; ${initialIds.length} initial executions)`);
  await context.close();
}
async function unavailable(browser,url) {
  const context=await browser.newContext();
  await context.addInitScript(()=>Object.defineProperty(globalThis,'indexedDB',{value:undefined,configurable:true}));
  const p=await context.newPage(); await p.goto(url); await ready(p);
  assert.equal(await p.evaluate(()=>OPS.saveKind),'error');
  assert.ok((await p.evaluate(()=>OPS.saveStatus)).includes('JSON'));
  const id=await p.evaluate(()=>AS.find(a=>a.type==='BR').id);
  await record(p,id,{notes:'保存領域なしでも記録・JSON書出しが使える',condition:2});
  assert.equal(await p.evaluate(()=>OPS.state.observations.length),1);
  assert.equal(await p.evaluate(()=>OPS.saveKind),'error');
  console.log('IndexedDB unavailable: memory record retained, explicit unsaved state OK');
  await context.close();
}
async function temporal(browser,url) {
  const context=await browser.newContext(), p=await context.newPage(), errors=[];
  p.on('pageerror',e=>errors.push(e.message)); await p.goto(url); await ready(p);
  const target=await p.evaluate(()=>{const a=AS.find(a=>a.type==='BR'&&a.p0>.01&&a.p0<.95);return {id:a.id,p0:a.p0,condition:a.cond>=2?0:3};});
  const o=await record(p,target.id,{condition:target.condition,availableAt:'2026-08-01T08:00',notes:'将来利用可能となる所見の時点制御テスト'});
  assert.equal(await p.evaluate(id=>planBaseline(AS.find(a=>a.id===id)).observationId,target.id),null);
  await p.evaluate(()=>{ensureDP();globalThis.previousDPlan=S.dp.res;});
  await p.locator('#plan-judgment').fill('2026-08-02T08:00'); await p.locator('#plan-judgment').press('Tab');
  await p.waitForFunction(id=>planBaseline(AS.find(a=>a.id===id)).observationId!=null,target.id);
  assert.equal(await p.evaluate(id=>planBaseline(AS.find(a=>a.id===id)).observationId,target.id),o.id);
  assert.equal(await p.evaluate(()=>{ensureDP();return S.dp.res!==globalThis.previousDPlan;}),true,'time-dependent plan caches must be rebuilt');
  await p.click('#ph-post');
  assert.equal(await p.evaluate(id=>planPrior(AS.find(a=>a.id===id)).observationId,target.id),null);
  assert.equal(await p.evaluate(id=>planPrior(AS.find(a=>a.id===id)).p0,target.id),target.p0);
  assert.deepEqual(errors,[]);
  console.log('Time control: future availability excluded; routine date adopts record and refreshes plan; earthquake cutoff excludes it');
  await context.close();
}
(async()=>{
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    const file=url.pathname==='/index.html'?'index.html':url.pathname==='/kumamoto_event_data/manifest.json'?'kumamoto_event_data/manifest.json':null;
    if(!file){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type',file.endsWith('.json')?'application/json':'text/html; charset=utf-8');res.end(await fs.readFile(path.join(root,file)));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch();
  try {
    const local='file://'+path.join(root,'index.html');
    await flow(browser,local);
    await flow(browser,`http://127.0.0.1:${server.address().port}/index.html`);
    await unavailable(browser,local);
    await temporal(browser,local);
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
