var OPS = { state: PlanCore.createState(), ready: false, storage: null, saveQueue: Promise.resolve(),
  saveStatus: "保存領域を確認中", saveKind: "pending", error: "", session: {}, autosave: true };
const PLAN_SOURCE = { staff: "職員入力", synthetic: "シナリオ投入（合成）", public_report: "公表資料の暫定判読" };
const PLAN_RUN_STATUS = { pending: "未割当", planned: "予定に割当", unassigned: "未割当・保留", completed: "点検完了", followup: "追加調査", deferred: "未実施" };
const planDate = iso => new Date(Date.parse(iso) + 9 * 3600000).toISOString().slice(0, 16).replace("T", " ");
const planInputDate = iso => planDate(iso).replace(" ", "T");
const planParseDate = value => { const iso = value + ":00+09:00"; PlanCore.time(iso); return new Date(iso).toISOString(); };
const planCaseCurrent = () => PlanCore.getCase(OPS.state, OPS.state.activeCases[S.phase]);
const planAssets = () => AS.map(a => ({ id: a.id, type: a.type, reference: {
  externalId: a.x?.id || null, manager: a.x?.a || null, status: a.x ? "registry_known_scope_unconfirmed" : "unverified", synthetic: !a.x } }));
function planDefinitions() {
  const refs = PLAN_REQS.map(q => {
    const d = PLAN_DOCS.find(d => d.id === q.doc), section = d.secs.find(s => s.s === q.sec);
    return { requirementId: q.id, documentId: d.id, versionId: d.id + "@p0-unverified-v1", sectionId: section.s,
      text: section.t, verified: false, textKind: "demo_summary", url: d.url || null, page: null };
  });
  const inspection = { version: "demo-inspection-v1", kind: "inspection", checks: ["構造・変状の確認", "通行・機能の確認", "写真・位置・連絡事項の記録"],
    serviceMinutes: Object.fromEntries(TKEYS.map(t => [t, TYPES[t].svc])), references: refs.filter(r => ["RK1", "RK2", "RK4"].includes(r.requirementId)),
    ownerStatus: "demo_unverified" };
  return [{ ...inspection, id: "T-ROAD-01", name: "道路施設の状態確認（平時・地震後共通）", types: ["BR", "TN", "SL", "CV"] },
    { ...inspection, id: "T-SERVICE-01", name: "河川・ライフライン施設の状態確認（デモ）", types: ["LV", "PT", "SW", "WS"] },
    { id: "T-COOP-01", version: "demo-coordination-v1", name: "管理者・連絡先の照会", kind: "coordination", types: TKEYS,
      checks: ["管理者・管理範囲", "連絡先・報告先", "参照資料・応援条件"], references: refs.filter(r => ["RK3", "RK4", "RK5"].includes(r.requirementId)),
      serviceMinutes: {}, ownerStatus: "unverified" }];
}
function planCreateCase(phase, name, id) {
  const post = phase === "post", at = post ? "2026-07-28T16:27:00+09:00" : "2026-07-27T08:00:00+09:00";
  return PlanCore.createCase(OPS.state, { id, phase, name: name || (post ? "地震対応（デモ案件）" : "平時巡回（デモ案件）"), judgmentAt: at,
    eventAt: post ? at : "2026-01-01T00:00:00+09:00", eventId: post ? "EQ-20260728" : "PATROL-2026",
    eventName: post ? "令和8年熊本地震のシナリオ" : "2026年の平時巡回",
    documents: PLAN_DOCS.map(d => ({ id: d.id, versionId: d.id + "@p0-unverified-v1", title: d.n, status: d.st })),
    definitions: planDefinitions(), view: { ev: post ? 1 : 0, crew: post ? { road: 3, life: 2, river: 1 } : { road: 2, life: 1, river: 1 },
      budget: post ? 6 : 7, depot: post ? 6 : 0, must: [], excl: [], approved: null } });
}
function planCaptureView() {
  const c = OPS.state.cases.find(c => c.id === OPS.state.activeCases[S.phase]); if (!c) return;
  c.view = { ev: S.ev, crew: { ...S.crew }, budget: S.budget, depot: S.depot,
    must: [...S.must].map(i => AS[i].id), excl: [...S.excl].map(i => AS[i].id), approved: S.approved };
}
function planApplyView(c) {
  RP.runId = null; RP.sourceRunId = null;
  S.phase = c.phase; S.ev = c.phase === "post" ? Math.max(1, Math.min(EVENTS.length, c.view.ev || 1)) : 0;
  S.crew = { ...c.view.crew }; S.budget = c.view.budget; S.depot = c.view.depot;
  const toIndices = ids => new Set((ids || []).map(id => AS.find(a => a.id === id)?.i).filter(i => i != null));
  S.must = toIndices(c.view.must); S.excl = toIndices(c.view.excl); S.approved = c.view.approved;
  S.planVer = c.planVersion; S.firstPlanMs = null; S.flood = null; S.rc.res = null; S.dp.res = null;
  S.rank = new Map(); S.prevRank = new Map(); S.changed = new Set();
}
function planEventAt(dt) { return new Date(Date.parse(planCaseCurrent().earthquakeAt) + dt * 60000).toISOString(); }
function planPrepare() {
  const c = planCaseCurrent();
  if (c.phase === "post") c.judgmentAt = planEventAt(EVENTS[S.ev - 1].dt);
  const inputKey = c.id + "|" + c.judgmentAt + "|" + OPS.state.observations.length;
  if (OPS.inputKey !== inputKey) { S.dp.res = null; S.rc.res = null; OPS.inputKey = inputKey; }
  const runs = PlanCore.ensureRuns(OPS.state, c.id, planAssets());
  S.confirmed = new Map();
  for (const r of runs.filter(r => r.definition.kind === "inspection")) {
    const o = PlanCore.latestObservation(OPS.state, r.id, c.judgmentAt);
    if (c.phase === "post" && o && o.damage !== "unknown") {
      const a = AS.find(a => a.id === r.assetId);
      S.confirmed.set(a.i, { damaged: o.damage === "damaged", t: planDate(o.observedAt), real: o.source === "public_report",
        source: o.source, observationId: o.id, staff: o.source === "staff" });
    }
  }
}
function planBaseline(a, at) {
  const c = planCaseCurrent();
  return PlanCore.baseline(OPS.state, a, at || c.judgmentAt, c.phase === "post" ? c.earthquakeAt : null);
}
function planPrior(a) {
  const b = planBaseline(a), penalty = [0, .1, .35, .7];
  const delta = penalty[a.cond] - penalty[b.condition], theta = a.theta + delta;
  return { ...b, theta, theta0: a.theta0 + delta, p0: clamp(Phi((a.I - theta) / .4), .005, .97) };
}
function planRunFor(a) {
  const c = planCaseCurrent();
  return PlanCore.activeRuns(OPS.state, c.id).find(r => r.assetId === a.id && r.definition.kind === "inspection");
}
function planShouldVisit(a) {
  const r = planRunFor(a); if (!r) return true;
  if (Date.parse(r.eventAt) > Date.parse(planCaseCurrent().judgmentAt)) return false;
  const o = PlanCore.latestObservation(OPS.state, r.id, planCaseCurrent().judgmentAt);
  return !o || !["completed", "deferred"].includes(o.status);
}
function planServiceMinutes(a, post) {
  const r = planRunFor(a);
  return (r?.definition.serviceMinutes[a.type] ?? TYPES[a.type].svc) * (post ? 1 : 1.5);
}
function planFinish(plan, pool, candidates, graph, post) {
  const c = planCaseCurrent(), assignments = new Map(), decisions = {}, runs = PlanCore.activeRuns(OPS.state, c.id);
  const poolIds = new Set(pool.map(a => a.id)), candidateIds = new Set(candidates.map(a => a.id));
  for (const route of plan.routes) for (const stop of route.stops) {
    const a = AS[stop.a], matching = runs.filter(r => r.assetId === a.id && r.definition.kind === "inspection");
    stop.runIds = matching.map(r => r.id); stop.caseId = c.id; stop.serviceMinutes = planServiceMinutes(a, post);
    for (const r of matching) assignments.set(r.id, { team: route.label, etaHours: stop.eta, serviceMinutes: stop.serviceMinutes });
  }
  for (const r of runs) {
    const a = AS.find(a => a.id === r.assetId), group = TYPES[a.type].grp;
    let reason = null;
    if (r.definition.kind === "coordination") reason = "information_missing";
    else if (S.excl.has(a.i)) reason = "excluded";
    else if (!candidateIds.has(a.id)) reason = "below_threshold";
    else if (!S.crew[group]) reason = "no_team";
    else {
      const edge = EDGES[a.e];
      const distance = Math.min(graph.D[S.depot][edge.a] + a.t * edge.len / edge.spd, graph.D[S.depot][edge.b] + (1 - a.t) * edge.len / edge.spd);
      if (!Number.isFinite(distance)) reason = "unreachable";
      else if (!poolIds.has(a.id)) reason = "candidate_limit";
      else if (!assignments.has(r.id)) reason = "time_limit";
    }
    decisions[r.id] = { assignment: assignments.get(r.id) || null, reason: assignments.has(r.id) ? null : reason };
  }
  const inputs = AS.map(a => { const b = planPrior(a); return { assetId: a.id, observationId: b.observationId, condition: b.condition,
    inspectionYear: b.inspectionYear, theta: b.theta, p0: b.p0, score: a.prio, availableAt: b.availableAt, cutoffAt: b.cutoffAt,
    intensity: a.I, seedCondition: a.cond, liquefaction: a.liq, faultDistanceKm: a.dF, importance: a.imp,
    ownership: a.x ? "registry_known_scope_unconfirmed" : "unverified" }; });
  const snap = PlanCore.reconcile(OPS.state, c.id, decisions, inputs, { phase: S.phase, ev: S.ev, crew: { ...S.crew }, hours: S.budget,
    depot: NODES[S.depot].name, closedEdges: [...(post ? closedAt(S.ev) : [])], scope: c.scope,
    must: [...S.must].map(i => AS[i].id), excluded: [...S.excl].map(i => AS[i].id), candidateLimitPerGroup: 30,
    modelParameters: { sigma: .4, conditionPenalties: [0, .1, .35, .7], probabilityFloor: .005, probabilityCeiling: .97,
      speedFactor: post ? .75 : 1, serviceMultiplier: post ? 1 : 1.5, damageCandidateThreshold: .12 } });
  S.planVer = snap.version; plan.snapshotId = snap.id;
  PlanCore.deriveRevisions(OPS.state, c.id); planCaptureView(); planPersist();
}
function planScenarioObservation(event) {
  const c = planCaseCurrent(); if (c.ingested.includes(event.k)) return;
  const field = event.kind === "field", report = event.kind === "fs";
  if (!field && !report) return;
  const targets = field ? S.plan.routes.flatMap(r => r.stops.slice(0, 3).map(st => AS[st.a])) : AS.filter(a => a.anchor?.startsWith("FS"));
  for (const a of targets) {
    const r = planRunFor(a); if (!r) continue;
    PlanCore.addObservation(OPS.state, { runId: r.id, observedAt: planEventAt(event.dt), availableAt: planEventAt(event.dt),
      registeredAt: new Date().toISOString(), actor: report ? "公開速報の暫定判読" : "シナリオ点検班", source: report ? "public_report" : "synthetic",
      sourceEventKey: event.k, status: report ? "followup" : "completed", damage: (report || a.damaged) ? "damaged" : "no_damage",
      condition: null, checked: report ? [] : [...r.definition.checks], updatesBaseline: false,
      notes: report ? SRC.FS.t + "（位置対応・被害程度は暫定。職員の実施記録とは別）" : "シナリオ投入による合成の点検結果（職員入力ではない）" });
  }
  c.ingested.push(event.k);
}
function planSetSaveStatus(kind, message) {
  OPS.saveKind = kind; OPS.saveStatus = message;
  document.querySelectorAll("[data-plan-save-status]").forEach(el => { el.textContent = message; el.dataset.state = kind; });
}
function planBundle() {
  planCaptureView();
  return PlanCore.exportBundle(OPS.state, { phase: S.phase, tab: S.tab, selectedAssetId: AS[S.sel]?.id || null, rplanView: RP.view });
}
function planPersist() {
  if (!OPS.ready || !OPS.storage || !OPS.autosave) return OPS.saveQueue;
  const bundle = planBundle(), generation = OPS.saveGeneration = (OPS.saveGeneration || 0) + 1;
  planSetSaveStatus("pending", "保存中…");
  OPS.saveQueue = OPS.saveQueue.catch(() => {}).then(() => OPS.storage.save(bundle)).then(() => {
    if (generation === OPS.saveGeneration) planSetSaveStatus("saved", "ブラウザ保存済み（" + new Date().toLocaleTimeString("ja-JP") + "）"); return true;
  }).catch(error => { if (generation === OPS.saveGeneration) planSetSaveStatus("error", "未保存：" + error.message + "。JSON書出しを利用できます"); return false; });
  return OPS.saveQueue;
}
async function planImport(bundle) {
  const result = PlanCore.validateBundle(bundle, planAssets(), { nodeCount: NODES.length, eventCount: EVENTS.length });
  await OPS.saveQueue;
  OPS.state = result.state; OPS.session = result.session;
  OPS.error = "";
  if (OPS.storage) OPS.autosave = true;
  planApplyView(planCaseCurrentForPhase(result.session.phase));
  RP.view = ["docs", "prep", "tasks", "records", "rev"].includes(result.session.rplanView) ? result.session.rplanView : "records";
  RP.runId = null; S.sel = AS.find(a => a.id === result.session.selectedAssetId)?.i ?? null; S.tab = "rplan";
  compute("JSONから案件・記録・計画入力を復元"); render(); await planPersist();
}
const planCaseCurrentForPhase = phase => OPS.state.activeCases[phase] ? PlanCore.getCase(OPS.state, OPS.state.activeCases[phase]) : planCreateCase(phase);
async function bootPlanApp() {
  try {
    OPS.storage = await PlanStorage.open();
    const saved = await OPS.storage.load();
    if (saved) {
      const restored = PlanCore.validateBundle(saved, planAssets(), { nodeCount: NODES.length, eventCount: EVENTS.length }); OPS.state = restored.state; OPS.session = restored.session;
      planSetSaveStatus("saved", "ブラウザの案件・実施記録を復元済み");
    }
  } catch (error) {
    OPS.autosave = false;
    planSetSaveStatus("error", "復元・保存を利用できません：" + error.message + "（JSON入出力を利用できます）");
  }
  if (!OPS.state.cases.length) { planCreateCase("normal", null, "C-NORM"); planCreateCase("post", null, "C-EMG"); }
  OPS.ready = true;
  const phase = OPS.session.phase || "normal"; planApplyView(planCaseCurrentForPhase(phase));
  RP.view = OPS.session.rplanView || "docs";
  S.tab = ["ai", "rplan", "plan", "why", "metrics", "data", "list"].includes(OPS.session.tab) ? OPS.session.tab : "ai";
  S.sel = AS.find(a => a.id === OPS.session.selectedAssetId)?.i ?? null;
  compute("案件と記録から点検計画を構成"); render(); setView("map"); await planPersist();
}
function planActivateCase(id) {
  planCaptureView();
  const c = PlanCore.getCase(OPS.state, id); OPS.state.activeCases[c.phase] = id;
  planApplyView(c); RP.runId = null; S.tab = "rplan"; compute("案件を切替（履歴は保持）"); render();
}
function planRewind() {
  const c = planCaseCurrent(); c.view.ev = 1; S.ev = 1; S.rc.res = null;
  recompute("同じ案件の時系列を巻き戻す（将来の記録は保持し、判断には未採用）");
}
function planRecordForm(runId) {
  const r = OPS.state.runs.find(r => r.id === runId); if (!r) return "";
  const c = PlanCore.getCase(OPS.state, r.caseId), a = AS.find(a => a.id === r.assetId);
  const prior = PlanCore.latestObservation(OPS.state, r.id, c.judgmentAt);
  return `<div class="sec" id="plan-record-editor"><h3>実施記録：${esc(a.name)}（${esc(a.id)}）</h3>
    <p class="sub">${esc(c.id)} ／ ${esc(r.taskId)}@${esc(r.definitionVersion)} ／ 事象 ${esc(r.eventId)}。予定への割当と実施の完了は別に記録します。追記により旧記録も残ります。</p>
    ${prior ? `<p class="sub">直近の記録：${esc(prior.id)}・${esc(PLAN_SOURCE[prior.source])}・${esc(PLAN_RUN_STATUS[prior.status])}・${esc(prior.notes)}</p>` : ""}
    <form id="plan-record-form" data-run-id="${esc(r.id)}"><div class="params">
    <label>記録者<input name="actor" value="担当者" required maxlength="100"></label>
    <label>実施日時（JST）<input name="observedAt" type="datetime-local" value="${planInputDate(c.judgmentAt)}" required></label>
    <label>利用可能日時（JST）<input name="availableAt" type="datetime-local" value="${planInputDate(c.judgmentAt)}" required></label>
    <label>実施状態<select name="status"><option value="completed">点検完了</option value="followup">追加調査</option><option value="deferred">未実施</option></select></label>
    <label>損傷所見<select name="damage"><option value="unknown">未確認</option><option value="no_damage">異常なしを確認</option><option value="damaged">損傷ありを確認</option></select></label>
    <label>健全度<select name="condition"><option value="">未確認・変更なし</option>${COND_S.map((n, i) => `<option value="${i}">${n}</option>`).join("")}</select></label>
    <label>未実施理由<select name="reason">${["deferred", "no_team", "unreachable", "time_limit", "information_missing"].map(k => `<option value="${k}">${PlanCore.reasons[k]}</option>`).join("")}</select></label></div>
    <fieldset><legend>確認項目（点検完了には全項目の確認が必要）</legend>${r.definition.checks.map(x => `<label style="display:block"><input type="checkbox" name="checked" value="${esc(x)}"> ${esc(x)}</label>`).join("")}</fieldset>
    <p><label><input name="updatesBaseline" type="checkbox" ${c.phase === "normal" ? "checked" : ""}> 健全度付きで完了した場合、次回の基準状態に採用（発災後の記録は初動の事前確率には遡及しない）</label></p>
    <label style="display:block">所見・未実施理由<textarea name="notes" rows="3" required maxlength="4000" style="width:100%"></textarea></label>
    <label>写真・資料の参照先<input name="attachments" style="width:100%" placeholder="ファイル名や資料ID（画像本体はJSONに含めません）"></label>
    <p class="sub">利用可能日時は判断への採用時点です。登録日時は実際の登録時刻として別に保持します。未確認を「異常なし」に読み替えません。</p>
    <button class="btn primary" type="submit">職員入力として記録する</button><span id="plan-record-message" role="status" aria-live="polite"></span></form></div>`;
}
function planWorkspaceHeader() {
  const c = planCaseCurrent();
  return `<div class="sec"><h3>案件・保存状態</h3><div class="params">
    <label>案件<select id="plan-case">${OPS.state.cases.map(x => `<option value="${esc(x.id)}" ${x.id === c.id ? "selected" : ""}>${esc(x.id)}：${esc(x.name)}（${x.phase === "post" ? "発災後" : "平時"}）</option>`).join("")}</select></label>
    <label>判断時点（JST）<input id="plan-judgment" type="datetime-local" value="${planInputDate(c.judgmentAt)}" ${c.phase === "post" ? "disabled" : ""}></label>
    <button class="btn" data-plan-action="new-case">同じフェーズで別案件を作る</button><button class="btn" data-plan-action="recheck">現在時点で再点検を開始</button></div>
    <p class="sub">表示モードの切替は案件・実施記録を消しません。別案件・再点検には新しいIDを付けます。現在の事象：${esc(c.activeEventId)}。管轄・担当はデモ設定で、管理者照会は別業務として保留します。</p>
    <div class="actions"><span class="chip" data-plan-save-status data-state="${esc(OPS.saveKind)}">${esc(OPS.saveStatus)}</span>
    <button class="btn" data-plan-action="save">今すぐ保存</button><button class="btn" data-plan-action="export">JSON書出し</button>
    <label class="btn">JSON読込み<input id="plan-import" type="file" accept="application/json,.json" style="max-width:200px"></label></div>
    <p id="plan-io-message" role="status" aria-live="polite">${esc(OPS.error)}</p></div>`;
}
function planLedger(caseId, assetId) {
  const c = PlanCore.getCase(OPS.state, caseId);
  const records = OPS.state.observations.filter(o => o.caseId === c.id && (!assetId || o.assetId === assetId)).sort((a, b) => b.order - a.order);
  return `<div class="sec"><h3>実施記録 ${assetId ? esc(assetId) : esc(c.id)}（${records.length}件）</h3>${records.length ? `<div class="tblwrap"><table class="tbl"><thead><tr><th>記録・業務実行</th><th>施設・出所</th><th>実施・利用可能日時（JST）</th><th>実施状態・所見</th><th>根拠</th></tr></thead><tbody>${records.map(o => {
    const a = AS.find(a => a.id === o.assetId), r = OPS.state.runs.find(r => r.id === o.runId), included = PlanCore.eligible(o, c.judgmentAt);
    return `<tr data-observation-id="${esc(o.id)}"><td>${esc(o.id)}<div class="sub">${esc(r.taskId)}@${esc(r.definitionVersion)}<br>${esc(r.eventId)}</div></td><td><button class="btn" data-plan-asset="${esc(a.id)}">${esc(a.name)}</button><div class="sub">${esc(PLAN_SOURCE[o.source])}・${esc(o.actor)}</div></td>
      <td>${planDate(o.observedAt)}<div class="sub">利用可能 ${planDate(o.availableAt)}<br>登録 ${esc(o.registeredAt)}${included ? "" : "<br>判断時点より後：計算に未採用"}</div></td>
      <td>${esc(PLAN_RUN_STATUS[o.status])} ／ ${o.damage === "unknown" ? "損傷未確認" : o.damage === "damaged" ? "損傷あり" : "異常なしを確認"}${o.condition == null ? "" : " ／ 健全度" + COND_S[o.condition]}
      <div class="sub">${esc(o.notes)}${o.updatesBaseline ? "<br>基準状態への採用対象" : ""}${o.attachments ? "<br>資料：" + esc(o.attachments) : ""}</div></td>
      <td>${r.definition.references.map(q => `<button class="btn" data-plan-doc="${esc(q.documentId)}" data-plan-run="${esc(r.id)}">${esc(q.versionId)} ${esc(q.sectionId)}</button>`).join("")}</td></tr>`;
  }).join("")}</tbody></table></div>` : `<p class="empty">実施記録はありません。予定への割当だけでは完了・異常なしにはしません。</p>`}</div>`;
}
function planUnassigned() {
  const c = planCaseCurrent(), runs = PlanCore.activeRuns(OPS.state, c.id), groups = new Map();
  for (const r of runs) {
    const st = PlanCore.stateAt(OPS.state, r, c.judgmentAt);
    if (st.status === "completed" || r.assignment && !["deferred", "followup"].includes(st.status)) continue;
    const reason = r.reason || st.reason || "information_missing";
    if (!groups.has(reason)) groups.set(reason, []); groups.get(reason).push(r);
  }
  return `<div class="sec" id="plan-unassigned"><h3>未割当・保留と実施できなかった理由</h3><p class="sub">探索は各部局の上位30候補を対象にするため、候補数上限と時間不足を分けて表示します。管理者・担当範囲の照会は現地点検の予定とは別に残します。</p>
    ${[...groups].map(([reason, rs]) => `<details data-reason="${esc(reason)}"><summary>${esc(PlanCore.reasons[reason] || reason)}：${rs.length}件</summary><div class="tblwrap"><table class="tbl"><tbody>${rs.slice(0, 40).map(r => `<tr><td>${esc(r.assetId)} ／ ${esc(r.taskId)}</td><td>${esc(AS.find(a => a.id === r.assetId).name)}</td><td><button class="btn" data-plan-record="${esc(r.id)}">実施記録・理由</button></td></tr>`).join("")}</tbody></table></div>${rs.length > 40 ? `<p class="sub">先頭40件を表示。全件はJSONに含まれます。</p>` : ""}</details>`).join("") || `<p class="empty">未割当・保留はありません。</p>`}</div>`;
}
function planTasksView() {
  const c = planCaseCurrent(), active = c.phase === "post" ? "T-EMG-01" : "T-OPEN-01";
  let h = `<div class="sec"><h3>業務一覧（共通定義 T-ROAD-01@demo-inspection-v1）</h3><p class="sub">平時巡回・地震後点検は同じ業務定義を使い、案件・事象ごとに別の実行IDで管理します。</p>`;
  for (const t of PLAN_TASKS) {
    const coord = t.id === "T-COOP-01", applicable = coord || t.id === active;
    const as = planTaskAssets(t).sort((a, b) => Number(!!teamOf(b.i)) - Number(!!teamOf(a.i)));
    const defId = coord ? "T-COOP-01" : "T-ROAD-01";
    const runs = PlanCore.activeRuns(OPS.state, c.id).filter(r => r.taskId === defId);
    h += `<div class="sec" data-plan-task="${t.id}"><h3>${esc(t.id)} ${esc(t.n)} ${applicable ? "" : "（他フェーズ用の表示）"}</h3>
      <p class="sub">担当：${esc(t.owner)} ／ 開始条件：${esc(t.cond)}<br>確認項目（アプリの提案）：${esc(t.checks)}<br>必要資源：${esc(t.res)} ／ 完了条件：${esc(t.done)}</p>
      <p>${t.reqs.map(id => { const q = PLAN_REQS.find(q => q.id === id); return `<button class="btn" data-plan-doc="${q.doc}">${esc(q.id)} ${esc(q.n)}</button>`; }).join(" ")}</p>
      <p>${as.length}施設 ／ 現在の訪問 ${applicable && !coord ? runs.filter(r => r.assignment).length : 0}件 ／ 実施完了 ${applicable ? runs.filter(r => PlanCore.stateAt(OPS.state, r, c.judgmentAt).status === "completed").length : 0}件 <button class="btn" data-rp="PLAN">点検計画を開く</button></p>
      <div class="tblwrap"><table class="tbl"><tbody>${as.slice(0, 8).map(a => {
        const r = runs.find(r => r.assetId === a.id); return `<tr data-a="${a.i}"><td>${esc(a.id)}</td><td>${esc(a.name)}<div class="sub">${esc(NODES[a.town].name)}・${a.x ? "台帳管理者 " + esc(a.x.a) + "（管轄適用未確認）" : "管理者未確認"}</div></td><td>${r && applicable ? `<button class="btn" data-plan-record="${esc(r.id)}">実施記録</button>` : "他フェーズの業務"}</td></tr>`;
      }).join("")}</tbody></table></div></div>`;
  }
  return h + `</div>` + planUnassigned();
}
function planRevisionsView() {
  const c = planCaseCurrent(), proposals = PlanCore.visibleRevisions(OPS.state, c.id);
  return `<div class="sec"><h3>実施記録・未割当理由からの見直し候補</h3><p class="sub">未確認の原文は改定済みにしません。ここで記録するのはアプリ内の確認・反映状況です。法定計画の策定・修正・公表の実施とは区別します。</p>
    ${proposals.map(p => `<div class="sec" data-revision-id="${esc(p.id)}"><h3>${esc(PlanCore.reasons[p.reason] || p.reason)} ${p.status !== "proposed" && p.newEvidence ? "（新しい根拠あり）" : ""}</h3>
      <p>変更前の参照記載（仮要旨・原文未確認）：${esc(p.before)}</p><p>変更・運用見直し案：${esc(p.proposal)}</p>
      <p>${p.references.map(q => `<button class="btn" data-plan-doc="${esc(q.documentId)}" data-plan-run="${esc(p.runIds[0] || "")}">${esc(q.versionId)} ${esc(q.sectionId)}</button>`).join(" ")}</p>
      <p class="sub">根拠 ${p.evidence.length}件：${p.evidence.map(e => `<button class="btn" data-plan-evidence="${esc(e.id)}">${esc(e.id)}</button>`).join(" ")}</p>
      <form data-plan-review="${esc(p.id)}"><label>確認状況<select name="status">${Object.entries({ proposed: "候補", reviewed: "確認済み", reflected: "反映記録済み（アプリ内）", dismissed: "採用しない" }).map(([v, n]) => `<option value="${v}" ${p.status === v ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      <label>確認者<input name="actor" value="${esc(p.reviewedBy || "担当者")}" required></label><label>確認・反映内容<input name="note" value="${esc(p.reviewNote)}" required></label><button class="btn" type="submit">確認状況を記録</button></form></div>`).join("") || `<p class="empty">根拠となる記録・未割当理由はまだありません。</p>`}</div>`;
}
function renderPlanWorkspace() {
  const nav = { docs: "根拠資料", prep: "整合性・実施準備", tasks: "業務一覧", records: "実施記録", rev: "見直し候補" };
  let h = planWorkspaceHeader() + `<div class="actions">${Object.entries(nav).map(([v, n]) => `<button class="btn ${RP.view === v ? "primary" : ""}" data-rp="${v}">${n}</button>`).join("")}</div>`;
  if (RP.view === "docs") {
    const r = OPS.state.runs.find(r => r.id === RP.sourceRunId);
    if (r) h += `<div class="sec" id="plan-pinned-source"><h3>この実行で固定した文献版・参照記載</h3><p class="sub">${esc(r.id)}。以下は当時の実行に固定した要旨・版です。参照資料の更新で差し替えません。</p>${r.definition.references.map(q => `<blockquote><b>${esc(q.versionId)} ${esc(q.sectionId)}</b>（${q.verified ? "本文確認済み" : "仮要旨・原文未確認"}）<p>${esc(q.text)}</p></blockquote>`).join("")}</div>`;
    h += rplanDocRows() + "</div>";
  }
  else if (RP.view === "prep") h += rplanChecks();
  else if (RP.view === "tasks") h += planTasksView();
  else if (RP.view === "rev") h += planRevisionsView();
  else {
    h += planLedger(planCaseCurrent().id);
    if (S.phase === "post") {
      const previous = OPS.state.cases.filter(c => c.phase === "normal");
      h += `<details><summary>平時案件の所見を参照（発災前に利用できた所見のみ初動の事前確率へ採用）</summary>${previous.map(c => planLedger(c.id)).join("")}</details>`;
    }
    const snapshot = OPS.state.snapshots.filter(s => s.caseId === planCaseCurrent().id).at(-1);
    if (snapshot) h += `<details><summary>現在の計画入力 ${esc(snapshot.id)}（文献版・基準状態・採用所見・未確認項目）</summary><pre class="code">${esc(JSON.stringify(snapshot, null, 2))}</pre></details>`;
  }
  if (RP.runId) h += planRecordForm(RP.runId);
  return h;
}
function planVisitDetails(a) {
  const r = planRunFor(a); if (!r) return "";
  const state = PlanCore.stateAt(OPS.state, r, planCaseCurrent().judgmentAt);
  return `<div class="sub">共通業務 ${esc(r.taskId)}・${esc(PLAN_RUN_STATUS[state.status])} ／ 担当：${esc(TYPES[a.type].dept)}（デモ） ／ 作業 ${planServiceMinutes(a, S.phase === "post")}分<br>
    確認：${r.definition.checks.map(esc).join("・")} ／ 必要資源：班・車両・記録端末<br>
    <button class="btn" data-plan-record="${esc(r.id)}">実施記録</button> ${r.definition.references.map(q => `<button class="btn" data-plan-doc="${esc(q.documentId)}" data-plan-run="${esc(r.id)}">${esc(q.versionId)} ${esc(q.sectionId)}</button>`).join(" ")}</div>`;
}
function planAssetHistory(a) {
  const b = planPrior(a), r = planRunFor(a), records = OPS.state.observations.filter(o => o.assetId === a.id);
  return `<div class="sec"><h3>計画・業務と実施記録</h3><p>採用した基準状態：健全度${COND_S[b.condition]}・点検 ${b.inspectionYear}年 ／ ${b.observationId ? "職員入力 " + esc(b.observationId) : "初期台帳（記録追加なし）"}<br>採用期限：${planDate(b.cutoffAt)} ／ 耐力指標 ${b.theta.toFixed(2)}・事前確率 ${pct(b.p0)}</p>
    ${r ? `<button class="btn" data-plan-record="${esc(r.id)}">この施設の実施記録</button>` : ""}
    <p class="sub">同じ施設の記録 ${records.length}件（案件・事象は別管理）。業務完了と損傷状態は別です。</p>
    ${records.length ? `<details><summary>案件別の履歴</summary>${[...new Set(records.map(o => o.caseId))].map(id => planLedger(id, a.id)).join("")}</details>` : ""}</div>`;
}
function planMetrics() {
  const c = planCaseCurrent(), observations = OPS.state.observations.filter(o => o.caseId === c.id), proposals = PlanCore.visibleRevisions(OPS.state, c.id);
  return `<div class="sec"><h3>案件別の実施・見直し記録</h3><p>${esc(c.id)}：実施記録 ${observations.length}件（職員入力 ${observations.filter(o => o.source === "staff").length}・合成 ${observations.filter(o => o.source === "synthetic").length}・公表資料 ${observations.filter(o => o.source === "public_report").length}）<br>
    見直し候補 ${proposals.length}件 ／ 反映記録済み ${proposals.filter(p => p.status === "reflected" && !p.newEvidence).length}件。<span data-plan-save-status>${esc(OPS.saveStatus)}</span></p>
    <button class="btn" data-rp="records">実施記録と計画入力へ</button><button class="btn" data-rp="rev">見直し候補へ</button></div>`;
}
function planProgress() {
  const c = planCaseCurrent(), runs = PlanCore.activeRuns(OPS.state, c.id), reasons = {};
  for (const r of runs) if (r.reason) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  return { case_id: c.id, event_id: c.activeEventId, judgment_at: c.judgmentAt, document_versions: c.documents,
    execution_count: runs.length, completed: runs.filter(r => r.status === "completed").length,
    observations: OPS.state.observations.filter(o => o.caseId === c.id && PlanCore.eligible(o, c.judgmentAt)).length,
    unassigned_reasons: reasons, revision_candidates: PlanCore.visibleRevisions(OPS.state, c.id).length,
    storage: { status: OPS.saveKind, message: OPS.saveStatus }, scope: c.scope };
}
function wirePlan() {
  const caseSelect = document.getElementById("plan-case"); if (caseSelect) caseSelect.onchange = e => planActivateCase(e.target.value);
  const judgment = document.getElementById("plan-judgment"); if (judgment) judgment.onchange = e => {
    try {
      const c = planCaseCurrent(), at = planParseDate(e.target.value);
      if (Date.parse(at) < Date.parse(c.events[0].at)) throw new Error("判断時点は案件の開始事象以後を指定してください");
      c.judgmentAt = at; recompute("平時の判断時点を変更");
    } catch (error) { planShowError(error); }
  };
  const form = document.getElementById("plan-record-form"); if (form) form.onsubmit = async e => {
    e.preventDefault(); const data = new FormData(form);
    try {
      const condition = data.get("condition") === "" ? null : Number(data.get("condition"));
      const status = data.get("status");
      const o = PlanCore.addObservation(OPS.state, { runId: form.dataset.runId, observedAt: planParseDate(data.get("observedAt")),
        availableAt: planParseDate(data.get("availableAt")), registeredAt: new Date().toISOString(), actor: data.get("actor"), source: "staff",
        status, damage: data.get("damage"), condition, checked: data.getAll("checked"), notes: data.get("notes"), reason: data.get("reason"),
        attachments: data.get("attachments"), updatesBaseline: data.has("updatesBaseline") && condition != null && status === "completed" });
      log("担当者", `${o.id} ${o.assetId}：${PLAN_RUN_STATUS[o.status]}（職員入力・案件 ${o.caseId}）`);
      S.rc.res = null; S.dp.res = null; recompute("職員の実施記録から計画と基準状態を更新");
      await planPersist(); const message = document.getElementById("plan-record-message"); if (message) message.textContent = "記録しました：" + o.id;
    } catch (error) { const message = document.getElementById("plan-record-message"); if (message) message.textContent = error.message; }
  };
  document.querySelectorAll("[data-plan-review]").forEach(form => { form.onsubmit = async e => {
    e.preventDefault(); const data = new FormData(form);
    try { PlanCore.reviewRevision(OPS.state, form.dataset.planReview, data.get("status"), data.get("note"), data.get("actor")); await planPersist(); renderTabs(); }
    catch (error) { planShowError(error); }
  }; });
  const upload = document.getElementById("plan-import"); if (upload) upload.onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    try { if (file.size > 64_000_000) throw new Error("JSONは64MB以内にしてください"); await planImport(JSON.parse(await file.text())); }
    catch (error) { planShowError(error); }
  };
}
function planShowError(error) {
  OPS.error = error.message; const el = document.getElementById("plan-io-message"); if (el) el.textContent = OPS.error;
}
document.addEventListener("click", async e => {
  const record = e.target.closest("[data-plan-record]"), action = e.target.closest("[data-plan-action]"),
    doc = e.target.closest("[data-plan-doc]"), asset = e.target.closest("[data-plan-asset]"), evidence = e.target.closest("[data-plan-evidence]");
  try {
    if (record) { RP.runId = record.dataset.planRecord; RP.view = "records"; S.tab = "rplan"; render(); document.getElementById("plan-record-editor")?.scrollIntoView({ block: "start" }); }
    else if (doc) { RP.doc = doc.dataset.planDoc; RP.sourceRunId = doc.dataset.planRun || null; RP.view = "docs"; RP.runId = null; S.tab = "rplan"; render(); document.getElementById(RP.sourceRunId ? "plan-pinned-source" : "plan-doc-" + RP.doc)?.scrollIntoView({ block: "start" }); }
    else if (asset) select(AS.find(a => a.id === asset.dataset.planAsset).i);
    else if (evidence) {
      const o = OPS.state.observations.find(o => o.id === evidence.dataset.planEvidence);
      RP.view = "records"; RP.runId = o?.runId || null; renderTabs();
      document.querySelector(o ? `[data-observation-id="${o.id}"]` : "#tabbody pre")?.scrollIntoView({ block: "center" });
    } else if (action) {
      const kind = action.dataset.planAction;
      if (kind === "save") await planPersist();
      if (kind === "export") {
        await planPersist(); const a = document.createElement("a"), url = URL.createObjectURL(new Blob([JSON.stringify(planBundle(), null, 2)], { type: "application/json" }));
        a.href = url; a.download = "phase-free-records-" + planCaseCurrent().id + ".json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      if (kind === "new-case") {
        planCaptureView(); const c = planCreateCase(S.phase); planApplyView(c); RP.runId = null;
        S.tab = "rplan"; compute("新しい案件を開始（旧案件は保持）"); render();
      }
      if (kind === "recheck") {
        const c = planCaseCurrent(); PlanCore.startEvent(OPS.state, c.id, c.judgmentAt, "担当者が開始した再点検"); RP.runId = null;
        recompute("別の開始事象で再点検（旧実行・実績は保持）");
      }
    }
  } catch (error) { planShowError(error); }
});
