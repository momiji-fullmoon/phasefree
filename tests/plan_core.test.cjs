const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/plan-core.js');

const before = '2026-07-27T08:00:00+09:00';
const quake = '2026-07-28T16:27:00+09:00';
const after = '2026-07-29T08:00:00+09:00';
const assets = [{id:'NT-BR-001',type:'BR',cond:0,insp:2024}, {id:'NT-BR-002',type:'BR',cond:1,insp:2023}];
const definitions = [{id:'T-ROAD-01',version:'v1',kind:'inspection',types:['BR'],checks:['構造','機能'],
  references:[{documentId:'D1',versionId:'D1-v1',sectionId:'S1',text:'確認済み原文のテストデータ'}]}];
function fixture() {
  const state = P.createState();
  const make = (phase,id,at) => P.createCase(state,{id,phase,name:id,judgmentAt:at,eventAt:phase==='post'?quake:'2026-01-01T00:00:00+09:00',
    definitions,documents:[{id:'D1',versionId:'D1-v1'}],view:{ev:phase==='post'?1:0,crew:{road:1,life:0,river:0},budget:6,depot:0,must:[],excl:[]}});
  const normal = make('normal','N',before), post = make('post','E',quake);
  const nr = P.ensureRuns(state,normal.id,assets), er = P.ensureRuns(state,post.id,assets);
  return {state,normal,post,nr,er};
}
function observe(state,run,input={}) {
  return P.addObservation(state,{runId:run.id,observedAt:before,availableAt:before,registeredAt:'2026-10-19T01:00:00Z',
    actor:'担当者',notes:'点検所見',source:'staff',status:'completed',damage:'unknown',condition:3,
    checked:[...run.definition.checks],updatesBaseline:true,...input});
}
function snapshot(state,caseId,reason='no_team') {
  const rows = Object.fromEntries(P.activeRuns(state,caseId).map(r=>[r.id,{reason}]));
  return P.reconcile(state,caseId,rows,assets.map(a=>({assetId:a.id,observationId:null})),{hours:6});
}
function bundle(state) { return P.exportBundle(state,{phase:'normal',tab:'rplan'}); }

test('replanning reuses execution IDs; case and new event get different IDs',()=>{
  const {state,normal,nr,er}=fixture();
  const ids=nr.map(r=>r.id);
  for(let i=0;i<4;i++) assert.deepEqual(P.ensureRuns(state,normal.id,assets).map(r=>r.id),ids);
  assert.equal(state.runs.length,4);
  assert.equal(nr[0].taskId,er[0].taskId);
  assert.notEqual(nr[0].id,er[0].id);
  P.startEvent(state,normal.id,before,'再点検');
  assert.ok(P.ensureRuns(state,normal.id,assets).every(r=>!ids.includes(r.id)));
  assert.equal(state.runs.length,6);
});
test('execution fixes document and task versions independently of source updates',()=>{
  const {state,normal,nr}=fixture();
  const source = P.clone(definitions); source[0].version='v2';
  P.createCase(state,{id:'N2',phase:'normal',name:'new',judgmentAt:before,eventAt:before,definitions:source,documents:[{id:'D1',versionId:'D1-v2'}]});
  const newer=P.ensureRuns(state,'N2',assets);
  assert.equal(nr[0].definitionVersion,'v1');
  assert.equal(nr[0].documents[0].versionId,'D1-v1');
  assert.equal(newer[0].definitionVersion,'v2');
  assert.equal(P.getCase(state,normal.id).definitions[0].version,'v1');
});
test('available-at controls baseline; registered-at is a separate audit timestamp',()=>{
  const {state,nr}=fixture();
  const o=observe(state,nr[0]);
  assert.equal(P.baseline(state,assets[0],before).observationId,o.id);
  assert.equal(P.baseline(state,assets[0],before).condition,3);
  assert.equal(P.baseline(state,assets[0],'2026-07-26T23:59:00+09:00').observationId,null);
});
test('past observation with future availability does not leak into initial earthquake prior',()=>{
  const {state,nr}=fixture();
  observe(state,nr[0],{availableAt:after});
  assert.equal(P.baseline(state,assets[0],after,quake).condition,0);
  assert.equal(P.baseline(state,assets[0],after).condition,3);
});
test('post-earthquake inspection never changes pre-earthquake baseline; next routine case can adopt it',()=>{
  const {state,er}=fixture();
  const o=observe(state,er[0],{observedAt:after,availableAt:after,damage:'damaged'});
  assert.equal(P.baseline(state,assets[0],after,quake).observationId,null);
  assert.equal(P.baseline(state,assets[0],after).observationId,o.id);
});
test('unknown result stays unknown while task can be operationally completed',()=>{
  const {state,nr}=fixture();
  const o=observe(state,nr[0],{condition:null,updatesBaseline:false});
  snapshot(state,'N');
  assert.equal(nr[0].status,'completed');
  assert.equal(nr[0].reason,null);
  assert.equal(o.damage,'unknown');
  assert.equal(P.baseline(state,assets[0],before).observationId,null);
});
test('all checks are needed for completion, but incomplete work can be recorded as deferred',()=>{
  const {state,nr}=fixture();
  assert.throws(()=>observe(state,nr[0],{checked:[]}),/全確認項目/);
  assert.equal(state.observations.length,0);
  observe(state,nr[0],{checked:[],status:'deferred',updatesBaseline:false,reason:'unreachable'});
  snapshot(state,'N');
  assert.equal(nr[0].status,'deferred');
  assert.equal(nr[0].reason,'unreachable');
});
test('simulation replay is idempotent and staff observations supersede simulation',()=>{
  const {state,er}=fixture();
  const data={observedAt:after,availableAt:after,source:'synthetic',sourceEventKey:'F1',damage:'no_damage',condition:null,updatesBaseline:false};
  const o=observe(state,er[0],data), sequence=state.sequence;
  assert.equal(observe(state,er[0],data).id,o.id);
  assert.equal(state.sequence,sequence);
  observe(state,er[0],{observedAt:quake,availableAt:quake,damage:'damaged',updatesBaseline:false});
  assert.equal(P.latestObservation(state,er[0].id,after).source,'staff');
});
test('future field results are retained but not yet applied when timeline is rewound',()=>{
  const {state,post,er}=fixture();
  observe(state,er[0],{observedAt:after,availableAt:after,source:'synthetic',updatesBaseline:false,condition:null});
  assert.equal(P.latestObservation(state,er[0].id,quake),null);
  post.judgmentAt=after; snapshot(state,post.id);
  assert.equal(er[0].status,'completed');
  post.judgmentAt=quake; snapshot(state,post.id);
  assert.equal(er[0].status,'unassigned');
  assert.equal(state.observations.length,1);
});
test('assignment reasons persist separately and do not become execution completion',()=>{
  for(const reason of ['no_team','unreachable','time_limit','candidate_limit','information_missing']) {
    const {state,nr}=fixture(); snapshot(state,'N',reason);
    assert.equal(nr[0].status,'unassigned'); assert.equal(nr[0].reason,reason);
    assert.equal(state.snapshots[0].rows[0].status,'unassigned');
  }
});
test('assignment contains schedule only; no observation is inferred',()=>{
  const {state,nr}=fixture();
  P.reconcile(state,'N',{[nr[0].id]:{assignment:{team:'道路班1',etaHours:1}}},[],{});
  assert.equal(nr[0].status,'planned');
  assert.equal(state.observations.length,0);
  assert.equal(P.baseline(state,assets[0],before).observationId,null);
});
test('revision proposal traces original version, observation and planning snapshot',()=>{
  const {state,nr}=fixture();
  const o=observe(state,nr[0],{status:'deferred',reason:'no_team',updatesBaseline:false});
  snapshot(state,'N');
  const proposals=P.deriveRevisions(state,'N'), p=proposals.find(p=>p.reason==='no_team');
  assert.ok(p.evidence.some(e=>e.kind==='observation'&&e.id===o.id));
  assert.ok(p.evidence.some(e=>e.kind==='snapshot'));
  assert.equal(p.references[0].versionId,'D1-v1');
  P.reviewRevision(state,p.id,'reflected','次の巡回は2班で実施','担当者');
  assert.equal(P.visibleRevisions(state,'N').find(x=>x.id===p.id).newEvidence,false);
  observe(state,nr[1],{status:'deferred',reason:'no_team',updatesBaseline:false});
  P.deriveRevisions(state,'N');
  assert.equal(P.visibleRevisions(state,'N').find(x=>x.id===p.id).newEvidence,true);
});
test('future revision evidence is hidden from an earlier judgment time',()=>{
  const {state,normal,nr}=fixture();
  observe(state,nr[0],{observedAt:after,availableAt:after,status:'followup',updatesBaseline:false});
  P.deriveRevisions(state,'N');
  assert.equal(P.visibleRevisions(state,'N').length,0);
  normal.judgmentAt=after;
  assert.equal(P.visibleRevisions(state,'N').length,1);
});
test('JSON round-trip preserves executions, observations, frozen versions and input snapshots',()=>{
  const {state,nr}=fixture(); observe(state,nr[0]); snapshot(state,'N'); P.deriveRevisions(state,'N');
  const exported=bundle(state), restored=P.validateBundle(JSON.parse(JSON.stringify(exported)),assets);
  assert.deepEqual(restored.state,state);
  const count=restored.state.runs.length;
  P.ensureRuns(restored.state,'N',assets);
  assert.equal(restored.state.runs.length,count);
});
test('JSON object key order does not change document or definition identity',()=>{
  const {state}=fixture(), data=bundle(state);
  for(const r of data.state.runs) r.definition=Object.fromEntries(Object.entries(r.definition).reverse());
  assert.doesNotThrow(()=>P.validateBundle(data,assets));
});
test('invalid import is rejected without mutating live state',()=>{
  const {state,nr}=fixture(); observe(state,nr[0]); snapshot(state,'N');
  const original=JSON.stringify(state);
  for(const mutate of [
    b=>b.version=2,
    b=>b.state.observations[0].assetId='unknown',
    b=>b.state.observations.push(P.clone(b.state.observations[0])),
    b=>b.state.runs[0].definition.version='v99',
    b=>b.state.observations[0].availableAt='yesterday',
    b=>b.state.cases[0].view.crew.road=10000,
    b=>b.state.sequence=0,
  ]) {
    const bad=bundle(state); mutate(bad); assert.throws(()=>P.validateBundle(bad,assets));
    assert.equal(JSON.stringify(state),original);
  }
});
test('invalid observation dates, source or baseline flags are rejected atomically',()=>{
  const {state,nr}=fixture();
  for(const change of [{availableAt:'2026-07-26T00:00:00Z'},{observedAt:'2026-07-27T08:00'},
    {source:'invented'},{condition:9},{source:'synthetic'},{notes:''}]) {
    assert.throws(()=>observe(state,nr[0],change)); assert.equal(state.observations.length,0);
  }
});
