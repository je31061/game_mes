/* 실적 분석 API (서지안, 인터페이스 §4)
 *
 * 모든 정의는 docs/분석-정의.md 와 같은 말로 적는다. 여기 주석과 문서가 다르면 문서가 맞다.
 *
 *  GET /api/admin/analytics/oee?from&to&equipmentId      설비별 가동률·성능·품질·OEE
 *  GET /api/admin/analytics/production?from&to&equipmentId 일별·설비별 생산실적
 *  GET /api/admin/analytics/gateway?from&to             게이트웨이 연결 품질(상태 이력 기준)
 *
 * 시각: DB 문자열은 서버 로컬 'YYYY-MM-DD HH:MM:SS'. 기간은 alarm-report 와 같이
 *      `${from} 00:00:00` ~ `${to} 23:59:59` 문자열 비교, ms 계산은 [기간 시작, min(기간 끝, 지금)].
 */

const STATES = ['RUN', 'IDLE', 'STOP', 'ALARM'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const p2 = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const localTs = (d) => `${localDate(d)} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
const toMs = (s) => new Date(String(s).replace(' ', 'T')).getTime();   // 로컬 시각 문자열 → ms
const round1 = (x) => Math.round(x * 10) / 10;
const ratio = (num, den) => (den > 0 ? Number((num / den).toFixed(4)) : null); // 소수 4자리 비율, 분모 0 → null
const product = (...vs) => (vs.some(v => v === null) ? null : Number(vs.reduce((a, b) => a * b, 1).toFixed(4)));
const parseDs = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

/** 기간 파라미터 해석. 기본: 오늘 포함 최근 7일. 잘못된 형식이면 { error } */
function parseRange(query) {
  const now = new Date();
  const today = localDate(now);
  let { from, to } = query;
  if (from && !DATE_RE.test(from)) return { error: 'from 은 YYYY-MM-DD 형식이어야 합니다.' };
  if (to && !DATE_RE.test(to)) return { error: 'to 는 YYYY-MM-DD 형식이어야 합니다.' };
  if (!to) to = today;
  if (!from) { const d = new Date(now); d.setDate(d.getDate() - 6); from = localDate(d); }
  if (from > to) return { error: 'from 이 to 보다 늦습니다.' };
  const fromTs = `${from} 00:00:00`, toTs = `${to} 23:59:59`;
  const startMs = toMs(fromTs);
  const endMs = Math.min(toMs(toTs) + 999, now.getTime());   // 미래는 계산하지 않는다
  // 기간의 날짜 목록 (양끝 포함)
  const days = [];
  for (const d = new Date(startMs); localDate(d) <= to; d.setDate(d.getDate() + 1)) days.push(localDate(d));
  return { from, to, fromTs, toTs, startMs, endMs, now, nowTs: localTs(now), today, days };
}

/** 계획 시간(분) — 분석-정의.md §2: 지난 날 = 하루 계획 분, 오늘 = min(계획, 경과), 미래 = 0 */
function plannedMinutes(range, shiftMinutesPerDay) {
  const dayStart = new Date(range.now); dayStart.setHours(0, 0, 0, 0);
  const elapsedToday = Math.max(0, (range.now.getTime() - dayStart.getTime()) / 60000);
  let total = 0, elapsedDays = 0;
  for (const d of range.days) {
    if (d < range.today) { total += shiftMinutesPerDay; elapsedDays++; }
    else if (d === range.today) { total += Math.min(shiftMinutesPerDay, elapsedToday); elapsedDays++; }
  }
  return { plannedMin: round1(total), elapsedDays };
}

/** 근무 시간 설정 — settings.policy.shiftMinutesPerDay (1~1440), 없으면 1440(24h) */
function shiftMinutes(settings) {
  const v = Number(settings.get('policy', {})?.shiftMinutesPerDay);
  return Number.isFinite(v) && v >= 1 && v <= 1440 ? v : 1440;
}

export function registerAnalytics(app, { requireAdmin, db, queries, settings }) {
  const stmts = {
    // 설비별 전체 상태 이력 (기간 이전의 마지막 상태를 시작 상태로 쓰기 위해 전부 읽는다 — 현재 규모 수백 건)
    allLogs: db.prepare(`
      SELECT id, equipment_id, status, reason, changed_by, changed_at
      FROM equipment_status_log ORDER BY equipment_id, id`),
    gatewayUserId: db.prepare("SELECT id FROM users WHERE emp_no = 'gateway'"),
    // 기간 내 실적 (설비별) — created_at 기준
    prodByEq: db.prepare(`
      SELECT equipment_id, COALESCE(SUM(qty_good),0) AS good, COALESCE(SUM(qty_defect),0) AS defect, COUNT(*) AS records
      FROM production_records WHERE created_at BETWEEN ? AND ? GROUP BY equipment_id`),
    prodByDay: db.prepare(`
      SELECT substr(created_at,1,10) AS date, COALESCE(SUM(qty_good),0) AS good, COALESCE(SUM(qty_defect),0) AS defect, COUNT(*) AS records
      FROM production_records WHERE created_at BETWEEN ? AND ? GROUP BY date`),
    prodByDayEq: db.prepare(`
      SELECT substr(created_at,1,10) AS date, COALESCE(SUM(qty_good),0) AS good, COALESCE(SUM(qty_defect),0) AS defect, COUNT(*) AS records
      FROM production_records WHERE created_at BETWEEN ? AND ? AND equipment_id = ? GROUP BY date`),
    // 기간 내 목표수량 — 분석-정의.md §3.1: DONE 은 completed_at, OPEN/IN_PROGRESS 는 created_at 기준 (eqTargetQty 와 같은 규칙)
    targetByEq: db.prepare(`
      SELECT equipment_id, COALESCE(SUM(target_qty),0) AS target, COUNT(*) AS orders
      FROM work_orders
      WHERE (status = 'DONE' AND completed_at BETWEEN ? AND ?)
         OR (status IN ('OPEN','IN_PROGRESS') AND created_at BETWEEN ? AND ?)
      GROUP BY equipment_id`),
    targetByDay: db.prepare(`
      SELECT substr(CASE WHEN status = 'DONE' THEN completed_at ELSE created_at END,1,10) AS date,
             COALESCE(SUM(target_qty),0) AS target, COUNT(*) AS orders
      FROM work_orders
      WHERE ((status = 'DONE' AND completed_at BETWEEN ? AND ?)
         OR (status IN ('OPEN','IN_PROGRESS') AND created_at BETWEEN ? AND ?))
        AND (? IS NULL OR equipment_id = ?)
      GROUP BY date`),
    // 데이터가 존재하는 가장 이른 날짜 (화면의 "전체 기간" 프리셋용)
    dataFrom: db.prepare(`
      SELECT MIN(d) AS d FROM (
        SELECT MIN(changed_at) AS d FROM equipment_status_log
        UNION ALL SELECT MIN(created_at) FROM production_records
        UNION ALL SELECT MIN(created_at) FROM work_orders)`),
  };

  const gatewayId = () => stmts.gatewayUserId.get()?.id ?? null;

  /** equipmentId 필터 → 설비 배열 (없는 id면 빈 배열) */
  function targetEquipments(query) {
    if (query.equipmentId) return [queries.getEquipment.get(Number(query.equipmentId))].filter(Boolean);
    return queries.listEquipments.all();
  }

  /** 설비별 로그 묶음 Map<equipment_id, log[]> (id 순) */
  function logsByEquipment() {
    const m = new Map();
    for (const l of stmts.allLogs.all()) {
      if (!m.has(l.equipment_id)) m.set(l.equipment_id, []);
      m.get(l.equipment_id).push(l);
    }
    return m;
  }

  /** 상태 점유 시간(분) — 분석-정의.md §1 (todayStatusBreakdown 의 기간 확장판) */
  function statusMinutes(eq, logs, range) {
    const acc = { RUN: 0, IDLE: 0, STOP: 0, ALARM: 0 };
    // 구간 목록: 로그가 없으면 status_since 부터 현재 상태 (대시보드와 같은 폴백)
    const segs = logs.length
      ? logs.map(l => ({ t: toMs(l.changed_at), status: l.status }))
      : [{ t: toMs(eq.status_since), status: eq.status }];
    const nowMs = range.now.getTime();
    for (let i = 0; i < segs.length; i++) {
      const s = Math.max(segs[i].t, range.startMs);
      const e = Math.min(i + 1 < segs.length ? segs[i + 1].t : nowMs, range.endMs);
      if (e > s && acc[segs[i].status] !== undefined) acc[segs[i].status] += e - s;
    }
    const out = {};
    for (const k of STATES) out[k] = round1(acc[k] / 60000);
    const coveredMin = round1(STATES.reduce((s, k) => s + out[k], 0));
    const lengthMin = Math.max(0, (range.endMs - range.startMs) / 60000);
    return { minutes: out, coveredMin, unknownMin: round1(Math.max(0, lengthMin - coveredMin)) };
  }

  /** 기간 내 상태 변경의 출처: gateway | manual | mixed | none */
  function statusSource(logs, range, gwId) {
    let gw = 0, man = 0;
    for (const l of logs) {
      if (l.changed_at < range.fromTs || l.changed_at > range.toTs) continue;
      if (l.changed_by === gwId) gw++; else man++;
    }
    return gw && man ? 'mixed' : gw ? 'gateway' : man ? 'manual' : 'none';
  }

  // ── OEE ──────────────────────────────────────────────
  app.get('/api/admin/analytics/oee', requireAdmin, (req, res) => {
    const range = parseRange(req.query);
    if (range.error) return res.status(400).json({ error: range.error });
    const shift = shiftMinutes(settings);
    const { plannedMin, elapsedDays } = plannedMinutes(range, shift);
    const eqs = targetEquipments(req.query);
    const logs = logsByEquipment();
    const gwId = gatewayId();
    const prod = new Map(stmts.prodByEq.all(range.fromTs, range.toTs).map(r => [r.equipment_id, r]));
    const tgt = new Map(stmts.targetByEq.all(range.fromTs, range.toTs, range.fromTs, range.toTs).map(r => [r.equipment_id, r]));

    const equipments = eqs.map(eq => {
      const eqLogs = logs.get(eq.id) || [];
      const st = statusMinutes(eq, eqLogs, range);
      const pr = prod.get(eq.id) || { good: 0, defect: 0, records: 0 };
      const tg = tgt.get(eq.id) || { target: 0, orders: 0 };
      const runMin = st.minutes.RUN;
      const output = pr.good + pr.defect;
      const notes = [];
      // 가동률 = RUN / 계획 (상한 1) — 분석-정의.md §3
      let availability = plannedMin > 0 ? ratio(runMin, plannedMin) : null;
      if (availability !== null && availability > 1) { availability = 1; notes.push('RUN이 계획 시간을 초과(근무시간 외 가동) → 가동률 100% 상한'); }
      if (plannedMin === 0) notes.push('계획 시간 0 (미래 기간)');
      // 성능 = (양품+불량) / 목표 (상한 1 — 초과 생산은 비고와 달성률로 보여 준다), 품질 = 양품 / (양품+불량)
      let performance = tg.target > 0 ? ratio(output, tg.target) : null;
      if (performance !== null && performance > 1) { notes.push(`목표 초과 생산 ${output}/${tg.target} (달성률 ${Math.round(performance * 100)}%) → 성능 100% 상한`); performance = 1; }
      const quality = output > 0 ? ratio(pr.good, output) : null;
      const oee = product(availability, performance, quality);
      if (st.coveredMin === 0) notes.push('기간 내 상태 로그 없음');
      else if (st.unknownMin > 0) notes.push(`상태 미확인 ${st.unknownMin}분(첫 로그 이전)`);
      if (tg.target === 0) notes.push('목표 없음(성능 —)');
      if (output === 0) notes.push('실적 없음(품질 —)');
      return {
        id: eq.id, code: eq.code, name: eq.name, type: eq.type || 'generic',
        availability, performance, quality, oee,
        runMin, plannedMin, coveredMin: st.coveredMin, unknownMin: st.unknownMin, minutes: st.minutes,
        good: pr.good, defect: pr.defect, target: tg.target, orders: tg.orders, records: pr.records,
        statusSource: statusSource(eqLogs, range, gwId),
        notes,
      };
    });

    // 요약은 합계로 재계산 (가중 합산) — 분석-정의.md §3.2
    const sum = (k) => equipments.reduce((s, e) => s + (e[k] || 0), 0);
    const sRun = round1(sum('runMin')), sPlanned = round1(sum('plannedMin'));
    const sGood = sum('good'), sDefect = sum('defect'), sTarget = sum('target');
    const sOut = sGood + sDefect;
    const sA = sPlanned > 0 ? Math.min(1, ratio(sRun, sPlanned)) : null;
    const sP = sTarget > 0 ? Math.min(1, ratio(sOut, sTarget)) : null;
    const sQ = sOut > 0 ? ratio(sGood, sOut) : null;
    const summary = {
      equipments: equipments.length,
      equipmentsWithOee: equipments.filter(e => e.oee !== null).length,
      equipmentsWithLogs: equipments.filter(e => e.coveredMin > 0).length,
      runMin: sRun, plannedMin: sPlanned, good: sGood, defect: sDefect, target: sTarget,
      attainment: sTarget > 0 ? ratio(sOut, sTarget) : null,   // 달성률(상한 없음) — 성능과 달리 초과분을 그대로 보여 준다
      availability: sA, performance: sP, quality: sQ,
      oee: product(sA, sP, sQ),
    };
    res.json({
      range: {
        from: range.from, to: range.to, days: range.days.length, elapsedDays,
        shiftMinutesPerDay: shift, shiftConfigured: settings.get('policy', {})?.shiftMinutesPerDay != null,
        plannedMinPerEquipment: plannedMin, now: range.nowTs,
        dataFrom: (stmts.dataFrom.get()?.d || '').slice(0, 10) || null,
      },
      equipments, summary,
    });
  });

  // ── 일별·설비별 생산실적 ───────────────────────────────
  app.get('/api/admin/analytics/production', requireAdmin, (req, res) => {
    const range = parseRange(req.query);
    if (range.error) return res.status(400).json({ error: range.error });
    const eqId = req.query.equipmentId ? Number(req.query.equipmentId) : null;
    const eqs = targetEquipments(req.query);
    const dayProd = new Map((eqId
      ? stmts.prodByDayEq.all(range.fromTs, range.toTs, eqId)
      : stmts.prodByDay.all(range.fromTs, range.toTs)).map(r => [r.date, r]));
    const dayTgt = new Map(stmts.targetByDay.all(range.fromTs, range.toTs, range.fromTs, range.toTs, eqId, eqId).map(r => [r.date, r]));
    // 기간의 모든 날짜를 넣는다 (없는 날은 0) — 분석-정의.md §4
    const days = range.days.map(date => {
      const p = dayProd.get(date) || { good: 0, defect: 0, records: 0 };
      const t = dayTgt.get(date) || { target: 0, orders: 0 };
      return { date, good: p.good, defect: p.defect, records: p.records, target: t.target, orders: t.orders };
    });
    const prod = new Map(stmts.prodByEq.all(range.fromTs, range.toTs).map(r => [r.equipment_id, r]));
    const tgt = new Map(stmts.targetByEq.all(range.fromTs, range.toTs, range.fromTs, range.toTs).map(r => [r.equipment_id, r]));
    const byEquipment = eqs.map(eq => {
      const p = prod.get(eq.id) || { good: 0, defect: 0, records: 0 };
      const t = tgt.get(eq.id) || { target: 0, orders: 0 };
      return { id: eq.id, code: eq.code, name: eq.name, type: eq.type || 'generic',
        good: p.good, defect: p.defect, records: p.records, target: t.target, orders: t.orders };
    });
    const total = days.reduce((s, d) => ({ good: s.good + d.good, defect: s.defect + d.defect, target: s.target + d.target, orders: s.orders + d.orders, records: s.records + d.records }),
      { good: 0, defect: 0, target: 0, orders: 0, records: 0 });
    res.json({ range: { from: range.from, to: range.to, days: range.days.length }, days, byEquipment, total });
  });

  // ── 게이트웨이 연결 품질 (상태 이력 기준) ───────────────
  app.get('/api/admin/analytics/gateway', requireAdmin, (req, res) => {
    const range = parseRange(req.query);
    if (range.error) return res.status(400).json({ error: range.error });
    const gwId = gatewayId();
    const logs = logsByEquipment();
    const all = queries.listEquipments.all();
    // 대상: data_source 프로토콜이 있는 설비 ∪ 기간 내 게이트웨이 로그가 있는 설비 — 분석-정의.md §5
    const equipments = all.map(eq => {
      const ds = parseDs(eq.data_source);
      const eqLogs = logs.get(eq.id) || [];
      const inRange = eqLogs.filter(l => l.changed_at >= range.fromTs && l.changed_at <= range.toTs);
      const gw = inRange.filter(l => l.changed_by === gwId);
      if (!ds?.protocol && gw.length === 0) return null;
      const gaps = [];
      for (let i = 1; i < gw.length; i++) gaps.push((toMs(gw[i].changed_at) - toMs(gw[i - 1].changed_at)) / 1000);
      gaps.sort((a, b) => a - b);
      const median = gaps.length ? (gaps.length % 2 ? gaps[(gaps.length - 1) / 2] : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2) : null;
      const lastGw = [...eqLogs].reverse().find(l => l.changed_by === gwId) || null;
      const lastReason = gw.length ? String(gw[gw.length - 1].reason || '') : '';
      // mode: 기간 내 마지막 게이트웨이 로그 reason 에 'SIM' 이 있으면 sim, 없으면 live, 로그 없으면 none
      const mode = gw.length === 0 ? 'none' : /\bSIM\b/.test(lastReason) ? 'sim' : 'live';
      return {
        id: eq.id, code: eq.code, name: eq.name, type: eq.type || 'generic',
        protocol: ds?.protocol || null, intervalMs: ds?.intervalMs || (ds ? 1000 : null), mode,
        samples: gw.length, statusChanges: inRange.length, manualChanges: inRange.length - gw.length,
        alarmCount: gw.filter(l => l.status === 'ALARM').length,
        lastSeen: lastGw?.changed_at || null,
        firstInRange: gw[0]?.changed_at || null, lastInRange: gw[gw.length - 1]?.changed_at || null,
        medianGapSec: median === null ? null : round1(median),
        maxGapSec: gaps.length ? round1(gaps[gaps.length - 1]) : null,
        currentStatus: eq.status,
      };
    }).filter(Boolean);
    res.json({ range: { from: range.from, to: range.to, gatewayUserId: gwId }, equipments });
  });
}
