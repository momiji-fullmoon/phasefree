var PlanCore = (() => {
  "use strict";
  const clone = value => JSON.parse(JSON.stringify(value));
  const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === "object" ?
    Object.fromEntries(Object.keys(value).sort().map(k => [k, ordered(value[k])])) : value;
  const equal = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
  const time = value => {
    if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT/.test(value) || !/(Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("日時が不正です");
    return Date.parse(value);
  };
  const key = (prefix, parts) => prefix + ":" + parts.map(x => encodeURIComponent(String(x))).join("|");
  const nextId = (s, prefix) => prefix + "-" + (++s.sequence);
  const sourceRank = { synthetic: 0, public_report: 1, staff: 2 };
  const states = new Set(["completed", "followup", "deferred"]);
  const reasons = {
    no_team: "担当班なし", unreachable: "到達不能", time_limit: "時間不足",
    candidate_limit: "探索候補数の上限", information_missing: "必要情報未確認",
    below_threshold: "推定値が候補閾値未満", excluded: "担当者が除外",
    awaiting_time: "判断時点より後の事象", deferred: "未実施", followup: "追加調査",
    unknown_result: "損傷状態未確認", condition: "点検所見の継続確認"
  };
  function createState() {
    return { schemaVersion: 1, sequence: 0, activeCases: {}, cases: [], runs: [], observations: [], revisions: [], snapshots: [] };
  }
  function getCase(s, id) {
    const c = s.cases.find(x => x.id === id);
    if (!c) throw new Error("案件がありません: " + id);
    return c;
  }
  function createCase(s, input) {
    const id = input.id || nextId(s, "CASE");
    if (s.cases.some(c => c.id === id)) throw new Error("案件IDが重複しています");
    if (!["normal", "post"].includes(input.phase)) throw new Error("案件の種別が不正です");
    time(input.judgmentAt); time(input.eventAt);
    const c = {
      id, name: input.name, phase: input.phase, judgmentAt: input.judgmentAt,
      events: [{ id: input.eventId || "INITIAL", at: input.eventAt, name: input.eventName || "初回点検" }],
      activeEventId: input.eventId || "INITIAL", earthquakeAt: input.phase === "post" ? input.eventAt : null,
      definitions: clone(input.definitions), documents: clone(input.documents),
      scope: "demo_unverified", ingested: [], view: clone(input.view || {}), planVersion: 0
    };
    s.cases.push(c); s.activeCases[c.phase] = c.id;
    return c;
  }
  function startEvent(s, caseId, at, name) {
    const c = getCase(s, caseId); time(at);
    if (time(at) > time(c.judgmentAt)) throw new Error("再点検事象は判断時点以前を指定してください");
    const event = { id: nextId(s, "RECHECK"), at, name: name || "再点検" };
    c.events.push(event); c.activeEventId = event.id;
    return event;
  }
  function ensureRuns(s, caseId, assets) {
    const c = getCase(s, caseId), event = c.events.find(e => e.id === c.activeEventId);
    const byId = new Map(s.runs.map(r => [r.id, r]));
    const result = [];
    for (const a of assets) for (const def of c.definitions) {
      if (!def.types.includes(a.type)) continue;
      const id = key("RUN", [c.id, event.id, def.id, def.version, a.id]);
      let r = byId.get(id);
      if (!r) {
        r = { id, caseId: c.id, eventId: event.id, assetId: a.id, assetType: a.type,
          taskId: def.id, definitionVersion: def.version, definition: clone(def),
          documents: clone(c.documents), eventAt: event.at,
          assetReference: clone(a.reference || { manager: null, status: "unverified" }),
          status: "pending", assignment: null, reason: null };
        s.runs.push(r); byId.set(id, r);
      }
      result.push(r);
    }
    return result;
  }
  function eligible(o, at) { return time(o.observedAt) <= time(at) && time(o.availableAt) <= time(at); }
  function latestObservation(s, runId, at) {
    return s.observations.filter(o => o.runId === runId && eligible(o, at))
      .sort((a, b) => sourceRank[b.source] - sourceRank[a.source] || time(b.availableAt) - time(a.availableAt) || time(b.observedAt) - time(a.observedAt) || b.order - a.order)[0] || null;
  }
  function addObservation(s, input) {
    const r = s.runs.find(x => x.id === input.runId);
    if (!r) throw new Error("対象の業務実行がありません");
    const c = getCase(s, r.caseId);
    for (const v of [input.observedAt, input.availableAt, input.registeredAt]) time(v);
    if (time(input.availableAt) < time(input.observedAt)) throw new Error("利用可能日時は実施日時以後にしてください");
    if (time(input.observedAt) < time(r.eventAt)) throw new Error("開始事象より前の実施記録です");
    if (!states.has(input.status) || !Object.hasOwn(sourceRank, input.source)) throw new Error("記録の状態・出所が不正です");
    if (!["unknown", "no_damage", "damaged"].includes(input.damage)) throw new Error("損傷の所見が不正です");
    if (input.condition != null && (!Number.isInteger(input.condition) || input.condition < 0 || input.condition > 3)) throw new Error("健全度はI〜IVを指定してください");
    if (!String(input.actor || "").trim()) throw new Error("記録者を入力してください");
    if (!String(input.notes || "").trim()) throw new Error("所見・未実施理由を入力してください");
    const checks = r.definition.checks;
    if (!Array.isArray(input.checked) || input.checked.some(x => !checks.includes(x))) throw new Error("確認項目が業務定義と一致しません");
    if (input.status === "completed" && checks.some(x => !input.checked.includes(x))) throw new Error("完了には全確認項目の確認が必要です");
    if (input.updatesBaseline && (input.source !== "staff" || input.condition == null || input.status !== "completed")) throw new Error("基準状態への採用には、健全度付きの職員入力・点検完了が必要です");
    if (input.sourceEventKey) {
      const previous = s.observations.find(o => o.runId === r.id && o.sourceEventKey === input.sourceEventKey);
      if (previous) return previous;
    }
    const o = {
      id: nextId(s, "OBS"), order: s.sequence, runId: r.id, caseId: c.id, assetId: r.assetId,
      taskId: r.taskId, definitionVersion: r.definitionVersion,
      observedAt: input.observedAt, availableAt: input.availableAt, registeredAt: input.registeredAt,
      actor: String(input.actor).trim(), source: input.source, sourceEventKey: input.sourceEventKey || null,
      status: input.status, damage: input.damage, condition: input.condition ?? null,
      checked: [...new Set(input.checked)], notes: String(input.notes).trim(),
      reason: input.status === "deferred" ? String(input.reason || "deferred") : null,
      updatesBaseline: !!input.updatesBaseline, attachments: String(input.attachments || "")
    };
    s.observations.push(o);
    return o;
  }
  function baseline(s, asset, at, before) {
    const cutoff = before ? Math.min(time(at), time(before) - 1) : time(at);
    const records = s.observations.filter(o => o.assetId === asset.id && o.updatesBaseline && o.source === "staff" &&
      o.status === "completed" && o.condition != null && time(o.observedAt) <= cutoff && time(o.availableAt) <= cutoff)
      .sort((a, b) => time(b.observedAt) - time(a.observedAt) || time(b.availableAt) - time(a.availableAt) || b.order - a.order);
    const o = records[0];
    return { condition: o ? o.condition : asset.cond, inspectionYear: o ? Number(o.observedAt.slice(0, 4)) : asset.insp,
      observedAt: o ? o.observedAt : null, observationId: o ? o.id : null, source: o ? "staff" : "seed_register",
      availableAt: o ? o.availableAt : null, cutoffAt: new Date(cutoff).toISOString() };
  }
  function activeRuns(s, caseId) {
    const c = getCase(s, caseId);
    return s.runs.filter(r => r.caseId === c.id && r.eventId === c.activeEventId);
  }
  function stateAt(s, r, at) {
    const o = latestObservation(s, r.id, at);
    return o ? { status: o.status, observation: o, reason: o.reason || (o.status === "followup" ? "followup" : null) } :
      { status: r.status, observation: null, reason: r.reason };
  }
  function reconcile(s, caseId, decisions, inputs, context) {
    const c = getCase(s, caseId), rows = [];
    for (const r of activeRuns(s, caseId)) {
      const o = latestObservation(s, r.id, c.judgmentAt), d = decisions[r.id] || { reason: "information_missing" };
      r.assignment = o && o.status === "completed" ? null : clone(d.assignment || null);
      r.reason = time(r.eventAt) > time(c.judgmentAt) ? "awaiting_time" : o?.status === "completed" ? null : o?.status === "deferred" ? o.reason || "deferred" : d.reason || null;
      r.status = o ? o.status : r.assignment ? "planned" : "unassigned";
      rows.push({ runId: r.id, assetId: r.assetId, taskId: r.taskId, status: r.status, reason: r.reason,
        assignment: clone(r.assignment), observationId: o ? o.id : null, definitionVersion: r.definitionVersion });
    }
    c.planVersion++;
    const snap = { id: nextId(s, "SNAP"), caseId, eventId: c.activeEventId, judgmentAt: c.judgmentAt,
      version: c.planVersion, createdAt: new Date().toISOString(), documents: clone(c.documents),
      model: "demo-prior-condition-v1", context: clone(context), inputs: clone(inputs), rows };
    s.snapshots.push(snap);
    return snap;
  }
  function deriveRevisions(s, caseId) {
    const c = getCase(s, caseId), groups = new Map(), runMap = new Map(s.runs.map(r => [r.id, r]));
    function add(r, reason, evidence) {
      const id = key("REV", [c.id, r.taskId, reason]);
      const reference = r.definition.references.find(q => q.requirementId === (c.phase === "normal" ? "RK2" : "RK1")) || r.definition.references[0];
      if (!groups.has(id)) groups.set(id, { id, caseId: c.id, taskId: r.taskId, reason, evidence: [], runIds: [], assetIds: [],
        references: clone(r.definition.references), before: reference?.text || "該当原文は未提供・未確認",
        proposal: reason === "condition" ? "継続所見を次回巡回の確認項目と対象条件に反映する案" :
          reason === "information_missing" ? "管理者・連絡先・参照資料を確認し、業務の適用範囲を具体化する案" :
          reason === "no_team" || reason === "time_limit" ? "班数・稼働時間・応援手順を再確認し、未割当業務の実施条件を見直す案" :
          "未実施・追加調査の理由を確認し、確認方法と再点検の開始条件を具体化する案" });
      const p = groups.get(id); p.evidence.push(evidence); p.runIds.push(r.id); p.assetIds.push(r.assetId);
    }
    for (const o of s.observations.filter(o => o.caseId === c.id)) {
      const r = runMap.get(o.runId);
      const reason = o.status === "deferred" ? o.reason || "deferred" : o.status === "followup" ? "followup" :
        o.condition >= 2 ? "condition" : o.damage === "unknown" ? "unknown_result" : null;
      if (reason) add(r, reason, { kind: "observation", id: o.id, availableAt: o.availableAt });
    }
    const latest = s.snapshots.filter(x => x.caseId === c.id).at(-1);
    if (latest) for (const row of latest.rows) {
      if (row.status === "unassigned" && ["information_missing", "no_team", "time_limit", "unreachable"].includes(row.reason))
        add(runMap.get(row.runId), row.reason, { kind: "snapshot", id: latest.id, availableAt: latest.judgmentAt });
    }
    for (const p of groups.values()) {
      p.evidence = [...new Map(p.evidence.map(e => [e.kind + e.id, e])).values()];
      p.runIds = [...new Set(p.runIds)]; p.assetIds = [...new Set(p.assetIds)];
      const old = s.revisions.find(x => x.id === p.id);
      if (old) Object.assign(old, p);
      else s.revisions.push({ ...p, status: "proposed", reviewNote: "", reviewedEvidence: [], reviewedBy: null });
    }
    return visibleRevisions(s, caseId);
  }
  function visibleRevisions(s, caseId) {
    const c = getCase(s, caseId);
    return s.revisions.filter(p => p.caseId === caseId).map(p => {
      const evidence = p.evidence.filter(e => time(e.availableAt) <= time(c.judgmentAt));
      const observationIds = new Set(evidence.filter(e => e.kind === "observation").map(e => e.id));
      const snapshots = evidence.filter(e => e.kind === "snapshot").map(e => s.snapshots.find(x => x.id === e.id));
      const runIds = new Set(s.observations.filter(o => observationIds.has(o.id)).map(o => o.runId));
      for (const snap of snapshots) for (const row of snap.rows) if (row.taskId === p.taskId && row.reason === p.reason) runIds.add(row.runId);
      return { ...p, evidence, runIds: [...runIds], assetIds: [...new Set(s.runs.filter(r => runIds.has(r.id)).map(r => r.assetId))],
        newEvidence: evidence.some(e => !p.reviewedEvidence.includes(e.kind + ":" + e.id)) };
    }).filter(p => p.evidence.length);
  }
  function reviewRevision(s, id, status, note, actor) {
    const p = s.revisions.find(x => x.id === id);
    if (!p || !["proposed", "reviewed", "reflected", "dismissed"].includes(status)) throw new Error("見直し候補の状態が不正です");
    if (!String(note || "").trim() || !String(actor || "").trim()) throw new Error("確認者・確認内容を入力してください");
    p.status = status; p.reviewNote = String(note); p.reviewedBy = String(actor); p.reviewedAt = new Date().toISOString();
    p.reviewedEvidence = visibleRevisions(s, p.caseId).find(x => x.id === id).evidence.map(e => e.kind + ":" + e.id);
    return p;
  }
  function exportBundle(s, session) {
    return clone({ format: "kumamoto-phase-free-plan", version: 1, exportedAt: new Date().toISOString(), state: s, session });
  }
  function validateBundle(bundle, assets, limits = {}) {
    if (!bundle || bundle.format !== "kumamoto-phase-free-plan" || bundle.version !== 1 || bundle.state?.schemaVersion !== 1) throw new Error("対応していない保存形式です");
    const s = clone(bundle.state), assetIds = new Set(assets.map(a => a.id));
    if (!Number.isSafeInteger(s.sequence) || s.sequence < 0) throw new Error("保存データの連番が不正です");
    function index(items, label) {
      if (!Array.isArray(items)) throw new Error(label + "が配列ではありません");
      const map = new Map();
      for (const x of items) {
        if (!x || typeof x.id !== "string" || !x.id || map.has(x.id)) throw new Error(label + "のIDが不正・重複しています");
        map.set(x.id, x);
      }
      return map;
    }
    const cases = index(s.cases, "案件"), runs = index(s.runs, "業務実行"), obs = index(s.observations, "実施記録"), snaps = index(s.snapshots, "計画入力");
    index(s.revisions, "見直し候補");
    for (const c of cases.values()) {
      if (!["normal", "post"].includes(c.phase)) throw new Error("案件の種別が不正です");
      time(c.judgmentAt); if (c.earthquakeAt) time(c.earthquakeAt);
      const events = index(c.events, "事象");
      for (const e of events.values()) time(e.at);
      if (!events.has(c.activeEventId) || !Array.isArray(c.definitions) || !Array.isArray(c.documents) || !c.view || !Array.isArray(c.ingested) || !Number.isSafeInteger(c.planVersion)) throw new Error("案件の参照・版が不正です");
      if (!c.view.crew || ["road", "life", "river"].some(g => !Number.isInteger(c.view.crew[g]) || c.view.crew[g] < 0 || c.view.crew[g] > 6) ||
          !Number.isFinite(c.view.budget) || c.view.budget < 0 || c.view.budget > 24 || !Number.isInteger(c.view.depot) || c.view.depot < 0 ||
          limits.nodeCount != null && c.view.depot >= limits.nodeCount ||
          !Number.isInteger(c.view.ev) || c.view.ev < 0 || c.view.ev > (limits.eventCount || 18) || !Array.isArray(c.view.must) || !Array.isArray(c.view.excl) ||
          [...c.view.must, ...c.view.excl].some(id => !assetIds.has(id))) throw new Error("案件の班・稼働時間・対象施設が不正です");
      index(c.definitions, "業務定義"); index(c.documents, "文献版");
      for (const d of c.definitions) {
        if (!d.id || !d.version || !Array.isArray(d.types) || !Array.isArray(d.checks) || !Array.isArray(d.references)) throw new Error("業務定義が不正です");
        if (d.references.some(q => !c.documents.some(doc => doc.id === q.documentId && doc.versionId === q.versionId) || typeof q.text !== "string")) throw new Error("文献版・章節の参照が一致しません");
      }
    }
    for (const [phase, id] of Object.entries(s.activeCases || {})) if (!cases.has(id) || cases.get(id).phase !== phase) throw new Error("選択中の案件が不正です");
    for (const r of runs.values()) {
      const c = cases.get(r.caseId);
      if (!c || !assetIds.has(r.assetId) || !c.events.some(e => e.id === r.eventId)) throw new Error("業務実行の案件・施設・事象が不明です");
      const def = c.definitions.find(d => d.id === r.taskId && d.version === r.definitionVersion);
      if (!def || !equal(def, r.definition) || !equal(c.documents, r.documents)) throw new Error("業務定義・文献版が一致しません");
      if (r.id !== key("RUN", [c.id, r.eventId, r.taskId, r.definitionVersion, r.assetId])) throw new Error("業務実行IDと参照が一致しません");
      time(r.eventAt);
    }
    const sourceEvents = new Set();
    for (const o of obs.values()) {
      const r = runs.get(o.runId);
      if (!r || o.caseId !== r.caseId || o.assetId !== r.assetId || o.taskId !== r.taskId || o.definitionVersion !== r.definitionVersion) throw new Error("実施記録の参照が不正です");
      for (const t of [o.observedAt, o.availableAt, o.registeredAt]) time(t);
      if (time(o.availableAt) < time(o.observedAt) || time(o.observedAt) < time(r.eventAt) || !states.has(o.status) || !Object.hasOwn(sourceRank, o.source) || !["unknown", "no_damage", "damaged"].includes(o.damage)) throw new Error("実施記録の状態・日時が不正です");
      if (!Number.isSafeInteger(o.order) || o.order > s.sequence || !o.actor || !o.notes || !Array.isArray(o.checked) || o.checked.some(x => !r.definition.checks.includes(x))) throw new Error("実施記録の確認項目が不正です");
      if (o.condition != null && (!Number.isInteger(o.condition) || o.condition < 0 || o.condition > 3)) throw new Error("実施記録の健全度が不正です");
      if (o.status === "completed" && r.definition.checks.some(x => !o.checked.includes(x))) throw new Error("完了記録の確認項目が不足しています");
      if (o.updatesBaseline && (o.source !== "staff" || o.status !== "completed" || o.condition == null)) throw new Error("基準状態の採用条件が不正です");
      if (o.sourceEventKey) {
        const k = key("SOURCE", [o.runId, o.sourceEventKey]);
        if (sourceEvents.has(k)) throw new Error("同じ業務実行・事象の投入記録が重複しています");
        sourceEvents.add(k);
      }
    }
    for (const p of s.snapshots) {
      if (!cases.has(p.caseId) || !Array.isArray(p.inputs) || !Array.isArray(p.rows)) throw new Error("計画入力が不正です");
      time(p.judgmentAt);
      for (const row of p.rows) if (!runs.has(row.runId) || runs.get(row.runId).caseId !== p.caseId || row.observationId && obs.get(row.observationId)?.runId !== row.runId) throw new Error("計画入力の参照が不正です");
      for (const a of p.inputs) if (!assetIds.has(a.assetId) || a.observationId && obs.get(a.observationId)?.assetId !== a.assetId) throw new Error("入力状態の施設・所見が不正です");
    }
    for (const p of s.revisions) {
      if (!cases.has(p.caseId) || !Array.isArray(p.evidence) || !Array.isArray(p.reviewedEvidence) || !Array.isArray(p.runIds) || !Array.isArray(p.assetIds)) throw new Error("見直し候補が不正です");
      if (!["proposed", "reviewed", "reflected", "dismissed"].includes(p.status) || !Array.isArray(p.references) ||
          p.status !== "proposed" && (!p.reviewedBy || !p.reviewNote)) throw new Error("見直し候補の確認記録が不正です");
      for (const e of p.evidence) { time(e.availableAt); if (!(e.kind === "observation" ? obs.has(e.id) : e.kind === "snapshot" && snaps.has(e.id))) throw new Error("見直し候補の根拠が不明です"); }
      if (p.runIds.some(id => !runs.has(id)) || p.assetIds.some(id => !assetIds.has(id))) throw new Error("見直し候補の対象が不明です");
    }
    const session = clone(bundle.session || {});
    if (!["normal", "post"].includes(session.phase) || !s.activeCases[session.phase]) throw new Error("表示中の案件が不正です");
    for (const x of [...s.cases, ...s.observations, ...s.snapshots, ...s.cases.flatMap(c => c.events)]) {
      const n = x.id.match(/^(?:CASE|OBS|SNAP|RECHECK)-(\d+)$/);
      if (n && Number(n[1]) > s.sequence) throw new Error("保存データの連番が参照IDより小さくなっています");
    }
    return { state: s, session };
  }
  return { clone, time, key, createState, createCase, getCase, startEvent, ensureRuns, activeRuns, eligible,
    latestObservation, addObservation, baseline, stateAt, reconcile, deriveRevisions, visibleRevisions,
    reviewRevision, exportBundle, validateBundle, reasons };
})();
if (typeof module !== "undefined" && module.exports) module.exports = PlanCore;
