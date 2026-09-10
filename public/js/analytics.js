/* Factory World — 실적 분석 화면 (서지안, 인터페이스 §5)
 *
 * window.FWAnalytics.mount(container, api) — admin.js 가 📈 탭을 열 때마다 호출한다 (멱등).
 *   첫 호출: 컨테이너에 골격(필터·섹션)을 만들고 데이터를 읽는다.
 *   이후 호출: 골격은 그대로 두고 현재 필터로 데이터만 다시 읽는다.
 * api(path) 는 admin.js 의 인증 fetch 래퍼 (JSON 반환, 실패 시 throw — e.message === 'auth' 면 게이트로 이미 이동).
 * 지표 정의는 docs/분석-정의.md. 차트는 외부 라이브러리 없이 인라인 SVG, 색은 테마 변수(css/analytics.css).
 */
(function () {
  'use strict';
  const TYPE_LABEL = { press: '프레스', welder: '용접기', robot: '로봇', assembly: '조립 라인', inspector: '검사기', packer: '포장기', cnc: 'CNC 가공기', generic: '미지정',
    // 인터페이스 §9 (스프린트 2)
    stacker: '적층기', winder: '와인더', vpi: '함침조', oven: '건조로', magnetizer: '착자기', balancer: '밸런싱 머신', dispenser: '디스펜서', smt: 'SMT' };
  const SOURCE_LABEL = { gateway: '자동 수집', manual: '수동', mixed: '수동+자동', none: '변경 없음' };
  const MODE_LABEL = { live: 'LIVE', sim: 'SIM', none: '이력 없음' };
  const LB_DEFAULTS = { hours: 20, oee: 0.85, targetUph: 60 };   // xlsx 12_Line_Balance 기준값 (분석-정의.md §8)
  const states = new WeakMap();   // container → { api, els, filters, data, lb }

  // ── 유틸 ──────────────────────────────────────────────
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const p2 = (n) => String(n).padStart(2, '0');
  const localDate = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return localDate(d); };
  const pct = (v, digits = 1) => (v === null || v === undefined ? '—' : (v * 100).toFixed(digits) + '%');
  const num = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('ko-KR'));
  const fmtMin = (m) => {
    if (m === null || m === undefined) return '—';
    const t = Math.round(m); const h = Math.floor(t / 60), mm = t % 60;
    return h ? `${h}h ${p2(mm)}m` : `${mm}m`;
  };
  const fmtSec = (s) => (s === null || s === undefined ? '—' : s >= 3600 ? (s / 3600).toFixed(1) + 'h' : s >= 60 ? (s / 60).toFixed(1) + 'm' : s + 's');
  const fmtTs = (s) => (s ? String(s).slice(5, 16) : '—');
  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  // ── 골격 ──────────────────────────────────────────────
  function build(container, api) {
    container.classList.add('fwa');
    container.innerHTML = `
      <h2>실적 분석 <small>설비별 OEE · 일별 생산실적 · 게이트웨이 연결 품질 · 라인 밸런스 — 정의: docs/분석-정의.md</small></h2>
      <div class="fwa-filters">
        <label>기간</label>
        <input type="date" class="fwa-from"> <span class="muted">~</span> <input type="date" class="fwa-to">
        <div class="fwa-presets">
          <button data-preset="today">오늘</button><button data-preset="7">7일</button><button data-preset="30">30일</button><button data-preset="all" disabled title="데이터가 있는 가장 이른 날부터">전체</button>
        </div>
        <label>설비</label>
        <select class="fwa-eq"><option value="">전체 설비</option></select>
        <button class="fwa-go">조회</button>
        <span class="fwa-status muted" style="font-size:12px"></span>
      </div>
      <div class="fwa-msg"></div>
      <div class="fwa-body"></div>
      <div class="fwa-foot">
        가동률 = RUN 시간 ÷ 계획 시간(설정 <code>shiftMinutesPerDay</code> 없으면 24h/일) · 성능 = (양품+불량) ÷ 목표수량 · 품질 = 양품 ÷ (양품+불량) · OEE = 세 값의 곱(하나라도 없으면 계산하지 않음). 가동률·성능은 100%로 상한(초과 생산은 비고·달성률에 표시).
        실적·목표는 <b>수동 입력</b>(작업지시 완료 시 작업자가 입력)이고, 상태 이력은 <b>변경 시점만</b> 남으므로 첫 로그 이전 시간은 "상태 미확인"으로 따로 보고한다.
        라인 밸런스: 유효 C/T = C/T ÷ 병렬 대수 · 병목 = 유효 C/T 최대인 비배치 공정 · UPH = 3600 ÷ 병목 C/T · 일 생산량 = 가동시간×3600×OEE ÷ 병목 C/T · 배치 공정은 개당 C/T(= C/T ÷ 배치 크기)를 병기하고 합계·병목에서 제외. C/T는 BOP <b>설계값</b>이며 OEE는 가정값이다. 자세한 정의·한계는 <code>docs/분석-정의.md</code>.
      </div>`;
    const $ = (sel) => container.querySelector(sel);
    const els = {
      from: $('.fwa-from'), to: $('.fwa-to'), eq: $('.fwa-eq'), go: $('.fwa-go'), status: $('.fwa-status'),
      msg: $('.fwa-msg'), body: $('.fwa-body'), presets: [...container.querySelectorAll('.fwa-presets button')],
    };
    const st = { api, els, filters: { from: daysAgo(6), to: localDate(new Date()), equipmentId: '' }, dataFrom: null, equipments: [], loading: false, preset: '7',
      // 라인 밸런스 설정값 (기간 필터와 무관) — hints: 비고 "병렬 N대 권장" 적용, parallel: 사용자가 표에서 바꾼 병렬 대수
      lb: { product: '', hours: LB_DEFAULTS.hours, oee: LB_DEFAULTS.oee, targetUph: LB_DEFAULTS.targetUph, parallel: {}, hints: true, data: null, loading: false } };
    states.set(container, st);
    els.from.value = st.filters.from; els.to.value = st.filters.to;

    const readFilters = () => { st.filters = { from: els.from.value, to: els.to.value, equipmentId: els.eq.value }; };
    els.go.onclick = () => { readFilters(); st.preset = null; load(container); };
    els.eq.onchange = () => { readFilters(); load(container); };
    els.from.onchange = els.to.onchange = () => { st.preset = null; markPreset(st); };
    els.presets.forEach(b => {
      b.onclick = () => {
        const p = b.dataset.preset;
        const today = localDate(new Date());
        if (p === 'today') { els.from.value = today; els.to.value = today; }
        else if (p === 'all') { if (!st.dataFrom) return; els.from.value = st.dataFrom; els.to.value = today; }
        else { els.from.value = daysAgo(Number(p) - 1); els.to.value = today; }
        st.preset = p; readFilters(); load(container);
      };
    });
    markPreset(st);
    return st;
  }

  function markPreset(st) { st.els.presets.forEach(b => b.classList.toggle('on', b.dataset.preset === st.preset)); }

  // ── 데이터 로드 ───────────────────────────────────────
  async function load(container) {
    const st = states.get(container);
    if (!st || st.loading) return;
    const { api, els, filters } = st;
    st.loading = true; els.go.disabled = true; els.status.textContent = '불러오는 중…'; els.msg.innerHTML = '';
    markPreset(st);
    try {
      const qs = new URLSearchParams();
      if (filters.from) qs.set('from', filters.from);
      if (filters.to) qs.set('to', filters.to);
      const qsEq = new URLSearchParams(qs);
      if (filters.equipmentId) qsEq.set('equipmentId', filters.equipmentId);
      const [oee, prod, gw, eqList, lb] = await Promise.all([
        api('/api/admin/analytics/oee?' + qsEq),
        api('/api/admin/analytics/production?' + qsEq),
        api('/api/admin/analytics/gateway?' + qs),
        st.equipments.length ? null : api('/api/admin/equipments').catch(() => null),
        fetchLineBalance(st),   // 실패해도 다른 섹션은 그려진다 (ok:false + reason)
      ]);
      st.lb.data = lb;
      if (eqList?.equipments) {
        st.equipments = eqList.equipments;
        const cur = els.eq.value;
        els.eq.innerHTML = '<option value="">전체 설비</option>' + st.equipments.map(e =>
          `<option value="${e.id}">${esc(e.code)} · ${esc(e.name)}</option>`).join('');
        els.eq.value = cur;
      }
      st.dataFrom = oee.range.dataFrom || null;
      els.presets.find(b => b.dataset.preset === 'all').disabled = !st.dataFrom;
      st.data = { oee, prod, gw };
      render(container, st);
      els.status.textContent = `${oee.range.from} ~ ${oee.range.to} · 계획 ${fmtMin(oee.range.plannedMinPerEquipment)}/설비 (${oee.range.shiftMinutesPerDay}분/일${oee.range.shiftConfigured ? '' : ' · 설정 없음 → 24h'}) · 기준 시각 ${oee.range.now}`;
    } catch (e) {
      if (e.message === 'auth') return;   // admin.js 가 이미 게이트로 보냄
      els.status.textContent = '';
      els.msg.innerHTML = `<div class="fwa-note fwa-err">분석 데이터를 불러오지 못했습니다: ${esc(e.message)}</div>`;
      console.error('[analytics]', e);
    } finally {
      st.loading = false; els.go.disabled = false;
    }
  }

  // ── 렌더 ──────────────────────────────────────────────
  function render(container, st) {
    const { oee, prod, gw } = st.data;
    const s = oee.summary;
    const hasLogs = s.equipmentsWithLogs > 0;
    const hasProd = (s.good + s.defect + s.target) > 0;
    const parts = [];

    // 기간에 아무 데이터도 없으면 이유와 함께 안내
    if (!hasLogs && !hasProd) {
      parts.push(`<div class="fwa-empty"><b>데이터 없음</b>이 기간(${esc(oee.range.from)} ~ ${esc(oee.range.to)})에는 상태 로그·작업지시·실적이 없습니다.
        ${st.dataFrom ? `가장 이른 데이터는 <b style="display:inline">${esc(st.dataFrom)}</b> — 위의 [전체] 버튼으로 그 날부터 볼 수 있습니다.` : '아직 기록된 데이터가 없습니다.'}</div>`);
    }

    // 1. 요약
    parts.push('<h3>요약 <span>설비별 합계로 다시 계산(가중 합산)</span></h3>');
    parts.push(`<div class="fwa-cards">
      ${card('가동률', s.availability, `RUN ${fmtMin(s.runMin)} / 계획 ${fmtMin(s.plannedMin)}`)}
      ${card('성능', s.performance, s.target ? `실적 ${num(s.good + s.defect)} / 목표 ${num(s.target)}${s.attainment > 1 ? ` · 달성률 ${pct(s.attainment, 0)}` : ''}` : '목표수량 없음')}
      ${card('품질', s.quality, (s.good + s.defect) ? `양품 ${num(s.good)} · 불량 ${num(s.defect)}` : '실적 없음')}
      ${card('OEE', s.oee, s.oee === null ? '세 값이 모두 있어야 계산' : `OEE 산출 설비 ${s.equipmentsWithOee}/${s.equipments}`)}
      <div class="fwa-card"><div class="k">데이터 범위</div><div class="v" style="font-size:16px">${s.equipmentsWithLogs}<span class="muted" style="font-size:12px;font-weight:400"> / ${s.equipments}대 상태 이력</span></div><div class="s">실적 입력 ${num(oee.equipments.reduce((a, e) => a + e.records, 0))}건 · 작업지시 ${num(oee.equipments.reduce((a, e) => a + e.orders, 0))}건</div></div>
    </div>`);
    const unknownTotal = oee.equipments.reduce((a, e) => a + e.unknownMin, 0);
    if (hasLogs && unknownTotal > 0) {
      parts.push(`<div class="fwa-note fwa-warn">상태 미확인 시간 합계 <b>${fmtMin(unknownTotal)}</b> — 첫 상태 로그 이전 시간은 어느 상태에도 넣지 않았습니다. 가동률 분모(계획 시간)에는 포함되므로 실제보다 낮게 나올 수 있습니다.</div>`);
    }

    // 2. OEE 표 + 차트
    parts.push(`<h3>설비별 OEE <span>${oee.equipments.length}대</span></h3>`);
    if (oee.equipments.length === 0) {
      parts.push('<div class="fwa-empty"><b>설비 없음</b>선택한 설비가 없거나 삭제되었습니다.</div>');
    } else {
      parts.push(`<div class="fwa-chart" data-chart="oee">
        <div class="fwa-legend"><span><i class="a"></i>가동률</span><span><i class="p"></i>성능</span><span><i class="q"></i>품질</span><span><i class="o"></i>OEE</span></div>
        ${oeeChart(oee.equipments)}</div>`);
      parts.push(`<div class="fwa-scroll" style="margin-top:10px"><table><thead><tr>
        <th>설비</th><th>유형</th><th>가동률</th><th>성능</th><th>품질</th><th>OEE</th>
        <th class="num">RUN</th><th class="num">양품/불량</th><th class="num">목표</th><th>상태 출처</th><th>비고</th></tr></thead><tbody>
        ${oee.equipments.map(e => `<tr>
          <td><b>${esc(e.name)}</b> <span class="muted">${esc(e.code)}</span></td>
          <td class="muted">${esc(TYPE_LABEL[e.type] || e.type)}</td>
          <td>${mini(e.availability, 'a')}</td>
          <td>${mini(e.performance, 'p')}</td>
          <td>${mini(e.quality, 'q')}</td>
          <td>${mini(e.oee, 'o')}</td>
          <td class="num" title="IDLE ${fmtMin(e.minutes.IDLE)} · STOP ${fmtMin(e.minutes.STOP)} · ALARM ${fmtMin(e.minutes.ALARM)}${e.unknownMin ? ` · 미확인 ${fmtMin(e.unknownMin)}` : ''}">${fmtMin(e.runMin)}</td>
          <td class="num">${num(e.good)} / ${num(e.defect)}</td>
          <td class="num">${e.target ? num(e.target) : '<span class="muted">—</span>'}</td>
          <td><span class="tag ${e.statusSource}">${SOURCE_LABEL[e.statusSource] || e.statusSource}</span></td>
          <td class="notes">${e.notes.map(esc).join(' · ')}</td>
        </tr>`).join('')}
      </tbody></table></div>`);
    }

    // 3. 일별 생산 추이
    parts.push(`<h3>일별 생산 추이 <span>${prod.range.from} ~ ${prod.range.to} · ${prod.days.length}일${st.filters.equipmentId ? ' · 선택 설비' : ' · 전체 설비'}</span></h3>`);
    if (prod.total.good + prod.total.defect + prod.total.target === 0) {
      parts.push('<div class="fwa-empty"><b>실적 없음</b>이 기간에 입력된 생산실적·작업지시가 없습니다. 실적은 작업자가 작업지시(퀘스트)를 완료할 때 수동으로 입력됩니다.</div>');
    } else {
      parts.push(`<div class="fwa-chart" data-chart="prod">
        <div class="fwa-legend"><span><i class="good"></i>양품</span><span><i class="defect"></i>불량</span><span><i class="line target"></i>목표수량</span></div>
        ${prodChart(prod.days)}</div>`);
      const withData = prod.byEquipment.filter(e => e.good + e.defect + e.target > 0);
      parts.push(`<div class="fwa-scroll" style="margin-top:10px"><table><thead><tr><th>설비</th><th class="num">양품</th><th class="num">불량</th><th class="num">불량률</th><th class="num">목표</th><th class="num">달성률</th><th class="num">작업지시</th><th class="num">실적 입력</th></tr></thead><tbody>
        ${withData.map(e => `<tr><td><b>${esc(e.name)}</b> <span class="muted">${esc(e.code)}</span></td>
          <td class="num">${num(e.good)}</td><td class="num">${num(e.defect)}</td>
          <td class="num">${e.good + e.defect ? pct(e.defect / (e.good + e.defect)) : '—'}</td>
          <td class="num">${e.target ? num(e.target) : '—'}</td>
          <td class="num">${e.target ? pct((e.good + e.defect) / e.target) : '<span class="muted">목표 없음</span>'}</td>
          <td class="num">${num(e.orders)}</td><td class="num">${num(e.records)}</td></tr>`).join('')}
        <tr><td><b>합계</b></td><td class="num"><b>${num(prod.total.good)}</b></td><td class="num"><b>${num(prod.total.defect)}</b></td>
          <td class="num">${prod.total.good + prod.total.defect ? pct(prod.total.defect / (prod.total.good + prod.total.defect)) : '—'}</td>
          <td class="num"><b>${num(prod.total.target)}</b></td>
          <td class="num">${prod.total.target ? pct((prod.total.good + prod.total.defect) / prod.total.target) : '—'}</td>
          <td class="num">${num(prod.total.orders)}</td><td class="num">${num(prod.total.records)}</td></tr>
      </tbody></table></div>`);
      const silent = prod.byEquipment.length - withData.length;
      if (silent > 0) parts.push(`<div class="fwa-note">실적·작업지시가 없는 설비 ${silent}대는 표에서 생략했습니다.</div>`);
    }

    // 4. 게이트웨이 연결 품질
    parts.push(`<h3>게이트웨이 연결 품질 <span>상태 이력 기준 · 게이트웨이 계정이 기록한 상태 변경만 집계</span></h3>`);
    if (gw.equipments.length === 0) {
      parts.push('<div class="fwa-empty"><b>연동 설비 없음</b>data_source 에 프로토콜이 설정된 설비가 없고, 이 기간에 게이트웨이가 기록한 상태 변경도 없습니다.</div>');
    } else {
      parts.push(`<div class="fwa-scroll"><table><thead><tr>
        <th>설비</th><th>프로토콜</th><th>모드</th><th class="num">상태 변경(자동)</th><th class="num">수동</th><th class="num">알람</th>
        <th class="num">주기 설정</th><th class="num">간격 중앙값</th><th class="num">최대 간격</th><th>기간 내 첫/마지막</th><th>마지막 수집</th><th>현재</th></tr></thead><tbody>
        ${gw.equipments.map(g => `<tr>
          <td><b>${esc(g.name)}</b> <span class="muted">${esc(g.code)}</span></td>
          <td>${g.protocol ? esc(String(g.protocol).toUpperCase()) : '<span class="muted">미설정</span>'}</td>
          <td><span class="tag ${g.mode}">${MODE_LABEL[g.mode] || g.mode}</span></td>
          <td class="num">${num(g.samples)}</td>
          <td class="num ${g.manualChanges ? '' : 'na'}">${num(g.manualChanges)}</td>
          <td class="num ${g.alarmCount ? '' : 'na'}">${num(g.alarmCount)}</td>
          <td class="num">${g.intervalMs ? g.intervalMs + 'ms' : '—'}</td>
          <td class="num">${fmtSec(g.medianGapSec)}</td>
          <td class="num" ${g.maxGapSec && g.intervalMs && g.maxGapSec * 1000 > g.intervalMs * 60 ? 'title="설정 주기의 60배 이상 — 연결 끊김 또는 상태 안정(이력만으로는 구분 불가)"' : ''}>${fmtSec(g.maxGapSec)}</td>
          <td class="muted">${g.firstInRange ? `${fmtTs(g.firstInRange)} ~ ${fmtTs(g.lastInRange)}` : '—'}</td>
          <td class="muted">${g.lastSeen ? esc(g.lastSeen) : '—'}</td>
          <td><span class="tag ${g.currentStatus}">${esc(g.currentStatus)}</span></td>
        </tr>`).join('')}
      </tbody></table></div>
      <div class="fwa-note">게이트웨이는 상태가 <b>바뀔 때만</b> 로그를 남기므로 "상태 변경(자동)"은 폴링 횟수가 아닙니다. 로그가 없는 구간은 연결 끊김인지 상태 유지인지 이력만으로는 알 수 없습니다. SIM 은 시뮬레이션 데이터입니다.</div>`);
    }

    // 5. 라인 밸런스 (자체 컨테이너 — 설정값을 바꾸면 이 부분만 다시 그린다)
    parts.push('<div class="fwa-lb"></div>');

    st.els.body.innerHTML = parts.join('');
    bindTooltips(st.els.body);
    renderLineBalance(container, st);
  }

  // ── 라인 밸런스 (분석-정의.md §8) ─────────────────────────
  const KIND_CLASS = { '표준': 'std', '병목': 'bt', 'QC': 'qc', '배치': 'batch', '완성': 'fin' };
  const fmtCt = (s) => (s === null || s === undefined ? '—' : (Number.isInteger(s) ? String(s) : s.toFixed(s < 10 ? 2 : 1)) + '초');

  function lbQuery(lb) {
    const qs = new URLSearchParams();
    if (lb.product) qs.set('product', lb.product);
    qs.set('hours', lb.hours); qs.set('oee', lb.oee); qs.set('targetUph', lb.targetUph);
    if (lb.hints) qs.set('hints', '1');
    for (const [op, n] of Object.entries(lb.parallel)) qs.set(`parallel[${op}]`, n);
    return qs;
  }
  async function fetchLineBalance(st) {
    try { return await st.api('/api/admin/analytics/line-balance?' + lbQuery(st.lb)); }
    catch (e) {
      if (e.message === 'auth') throw e;
      return { ok: false, reason: `라인 밸런스 API를 호출하지 못했습니다 (${e.message}) — 서버가 새 server/analytics.js로 재기동되었는지 확인`, lines: [], summary: null, products: [], error: true };
    }
  }
  async function reloadLineBalance(container) {
    const st = states.get(container);
    if (!st || st.lb.loading) return;
    st.lb.loading = true;
    const box = st.els.body.querySelector('.fwa-lb');
    if (box) box.classList.add('loading');
    try { st.lb.data = await fetchLineBalance(st); renderLineBalance(container, st); }
    catch (e) { if (e.message !== 'auth') console.error('[analytics] line-balance', e); }
    finally { st.lb.loading = false; }
  }

  function renderLineBalance(container, st) {
    const box = st.els.body.querySelector('.fwa-lb');
    if (!box) return;
    const lb = st.lb, d = lb.data || { ok: false, reason: '응답 없음', lines: [], products: [] };
    const parts = [];
    parts.push(`<h3>라인 밸런스 <span>BOP 공정 C/T 기준 설계 능력 · 기간 필터와 무관${d.ok ? ` · ${esc(d.product.name || d.product.code)} <span class="muted">${esc(d.product.code)}</span>` : ''}</span></h3>`);
    // 설정값
    const products = d.products || [];
    parts.push(`<div class="fwa-lb-ctl">
      ${products.length > 1 ? `<label>제품</label><select class="lb-product">${products.map(p => `<option value="${esc(p.code)}"${p.code === (d.product?.code || '') ? ' selected' : ''}>${esc(p.code)} · ${esc(p.name || '')}</option>`).join('')}</select>` : ''}
      <label>가동시간</label><input type="number" class="lb-hours" min="0.1" max="24" step="0.5" value="${lb.hours}"><span class="muted">h/일</span>
      <label>OEE 가정</label><input type="number" class="lb-oee" min="0.01" max="1" step="0.01" value="${lb.oee}">
      <label>목표 UPH</label><input type="number" class="lb-target" min="1" max="100000" step="1" value="${lb.targetUph}">
      <label class="lb-chk"><input type="checkbox" class="lb-hints"${lb.hints ? ' checked' : ''}> 비고의 "병렬 N대 권장" 적용</label>
      <button class="lb-reset" title="가동 20h · OEE 0.85 · 목표 UPH 60 · 병렬 1(권장 적용)">기준값(xlsx)</button>
      ${d.ok ? `<span class="muted lb-status">일 가동초 ${num(d.params.dailySec)} = ${d.params.hours}h × 3600 × ${d.params.oee} · 목표 C/T ${fmtCt(d.params.taktSec)}</span>` : ''}
    </div>`);

    if (!d.ok) {
      const schema = d.schema || {};
      const hint = d.error ? '' : schema.processes === false
        ? '스키마(인터페이스 §7)가 아직 적용되지 않았습니다. 최민준의 스키마 반영 후 서버를 재기동하면 표시됩니다.'
        : '관리자 콘솔 → <b style="display:inline">제품 라인 적용</b>(BOP JSON 가져오기)을 실행하면 공정 24건이 들어오고 이 카드가 채워집니다.';
      parts.push(`<div class="fwa-empty"><b>데이터 없음 · ${esc(d.reason || '이유 없음')}</b>${hint}</div>`);
      box.innerHTML = parts.join('');
      bindLineBalance(container, st, box);
      return;
    }

    // 제품 요약 타일
    const s = d.summary, p = d.params;
    parts.push(`<div class="fwa-cards fwa-lb-cards">
      <div class="fwa-card"><div class="k">제품 UPH</div><div class="v${s.uph === null ? ' na' : ''}">${s.uph === null ? '계산 불가' : num(s.uph)}</div><div class="s">가장 느린 라인(${esc(s.slowestLine || '—')}) 기준 · 목표 ${num(s.targetUph)}</div></div>
      <div class="fwa-card"><div class="k">일 생산량</div><div class="v${s.dailyOutput === null ? ' na' : ''}">${s.dailyOutput === null ? '계산 불가' : num(s.dailyOutput) + '<span class="unit">대</span>'}</div><div class="s">${p.hours}h × 3600 × OEE ${p.oee} ÷ 병목 C/T</div></div>
      <div class="fwa-card"><div class="k">목표 달성률</div><div class="v${s.attainment === null ? ' na' : s.attainment >= 1 ? ' ok' : ' low'}">${s.attainment === null ? '계산 불가' : pct(s.attainment, 0)}</div><div class="s">제품 UPH ÷ 목표 UPH ${num(s.targetUph)}</div></div>
      <div class="fwa-card"><div class="k">설비 연결</div><div class="v${s.linked < s.processes ? ' low' : ''}">${s.linked}<span class="unit">/ ${s.processes}공정</span></div><div class="s">${d.schema.equipmentOp ? 'equipments.op 기준' : 'equipments.op 컬럼 없음(스키마 전)'}</div></div>
    </div>`);
    if (s.unlinked.length) parts.push(`<div class="fwa-note fwa-warn"><b>설비 미연결 공정 ${s.unlinked.length}개</b>: ${s.unlinked.map(esc).join(', ')} — 맵에 설비가 없거나 설비의 공정(op)이 비어 있습니다. 관리자 콘솔 설비 마스터에서 공정을 지정하거나 제품 라인 배치 JSON을 적용하세요.</div>`);
    for (const line of d.lines) for (const w of line.warnings) parts.push(`<div class="fwa-note fwa-warn"><b>${esc(line.line)}</b> · ${esc(w)}</div>`);

    // 라인 공통 스케일 (초) — 유효 C/T·배치 개당 C/T·목표 C/T·병목 C/T 중 최대
    let maxSec = p.taktSec;
    for (const l of d.lines) for (const pr of l.processes) maxSec = Math.max(maxSec, pr.effectiveCtSec || 0, pr.perUnitCtSec || 0, (pr.parallel > 1 && pr.ctSec) || 0);
    const scale = niceCt(maxSec);

    d.lines.forEach((line, li) => {
      const b = line.bottleneck;
      parts.push(`<div class="fwa-lb-line">
        <div class="fwa-lb-head"><b>${esc(line.line)}</b><span class="muted">${line.processCount}공정 · 흐름 ${line.flowCount} · 배치 ${line.batchCount} · 설비 연결 ${line.linkedCount}/${line.processCount}</span></div>
        <div class="fwa-lb-tiles">
          <div><i>병목 공정</i><b>${b ? `${esc(b.op)} <span class="muted">${esc(b.name)}</span>` : '—'}</b>${b && b.tiedWith.length ? `<small>동률: ${b.tiedWith.map(esc).join(', ')}</small>` : ''}</div>
          <div><i>병목 C/T</i><b>${b ? fmtCt(b.effectiveCtSec) : '—'}</b>${b && b.parallel > 1 ? `<small>${fmtCt(b.ctSec)} ÷ 병렬 ${b.parallel}대</small>` : ''}</div>
          <div><i>UPH</i><b>${line.uph === null ? '—' : num(line.uph)}</b><small>3600 ÷ ${b ? fmtCt(b.effectiveCtSec) : '—'}</small></div>
          <div><i>일 생산량</i><b>${line.dailyOutput === null ? '—' : num(line.dailyOutput) + '대'}</b><small>${num(p.dailySec)}초 ÷ 병목 C/T</small></div>
          <div><i>목표 달성률</i><b class="${line.attainment === null ? '' : line.attainment >= 1 ? 'ok' : 'low'}">${line.attainment === null ? '—' : pct(line.attainment, 0)}</b><small>UPH ÷ 목표 ${num(p.targetUph)}${line.overTakt.length ? ` · 초과 ${line.overTakt.map(esc).join(', ')}` : ''}</small></div>
          <div><i>밸런스 효율</i><b>${line.balanceEff === null ? '—' : pct(line.balanceEff, 1)}</b><small>Σ유효 C/T ${fmtCt(line.sumEffectiveCtSec)} ÷ (${line.flowCount} × ${b ? fmtCt(b.effectiveCtSec) : '—'})</small></div>
        </div>
        <div class="fwa-chart" data-chart="lb">
          <div class="fwa-legend"><span><i class="ct"></i>유효 C/T</span><span><i class="bt"></i>병목</span><span><i class="batch"></i>배치 개당 C/T (C/T ÷ 배치 크기)</span><span><i class="raw"></i>병렬 전 C/T</span><span><i class="line takt"></i>목표 C/T ${fmtCt(p.taktSec)}</span><span><i class="dot linked"></i>설비 연결(색 = 현재 상태)</span><span><i class="dot unlinked"></i>미연결</span></div>
          ${lbChart(line, scale, p, li)}
        </div>
        <div class="fwa-scroll" style="margin-top:8px"><table class="fwa-lb-table"><thead><tr>
          <th>공정</th><th>공정명</th><th>유형</th><th class="num">C/T</th><th class="num">병렬</th><th class="num">유효 / 개당 C/T</th><th>설비</th><th>설비 힌트(BOP)</th><th>비고</th></tr></thead><tbody>
          ${line.processes.map(pr => `<tr class="${pr.isBottleneck ? 'is-bt' : ''}${pr.isBatch ? ' is-batch' : ''}">
            <td><b>${esc(pr.op)}</b></td>
            <td>${esc(pr.name)}${pr.qc ? `<div class="muted qc">QC: ${esc(pr.qc)}</div>` : ''}</td>
            <td><span class="tag kind-${KIND_CLASS[pr.kind] || 'std'}">${esc(pr.kind || '—')}</span>${pr.isBottleneck ? ' <span class="tag bt">병목</span>' : ''}</td>
            <td class="num">${fmtCt(pr.ctSec)}${pr.isBatch ? `<div class="muted">/ ${pr.batchSize ? pr.batchSize + 'ea 배치' : '배치 크기 미상'}</div>` : ''}</td>
            <td class="num"><input type="number" class="lb-par" data-op="${esc(pr.op)}" min="1" max="20" step="1" value="${pr.parallel}" title="병렬 대수${pr.parallelHint ? ` · 비고 권장 ${pr.parallelHint}대` : ''}"></td>
            <td class="num">${pr.isBatch ? (pr.perUnitCtSec === null ? '<span class="muted">—</span>' : `${fmtCt(pr.perUnitCtSec)}<span class="muted">/ea</span>`) : fmtCt(pr.effectiveCtSec)}</td>
            <td>${pr.equipment ? `<span class="tag ${esc(pr.equipment.status)}">${esc(pr.equipment.status)}</span> ${esc(pr.equipment.code)} <span class="muted">${esc(pr.equipment.name)}${pr.linkedCount > 1 ? ` 외 ${pr.linkedCount - 1}대` : ''}</span>` : '<span class="tag unlinked">미연결</span>'}</td>
            <td class="muted">${esc(pr.equipmentHint || '—')}</td>
            <td class="notes">${[...(pr.note ? [pr.note] : []), ...pr.notes].map(esc).join(' · ')}</td>
          </tr>`).join('')}
          <tr class="sum"><td colspan="3"><b>라인 C/T 합계</b> <span class="muted">비배치 ${line.flowCount}공정 · 배치 제외</span></td>
            <td class="num"><b>${fmtCt(line.sumCtSec)}</b></td><td></td><td class="num"><b>${fmtCt(line.sumEffectiveCtSec)}</b></td><td colspan="3" class="muted">UPH ${line.uph === null ? '—' : num(line.uph)} · 일 ${line.dailyOutput === null ? '—' : num(line.dailyOutput)}대</td></tr>
        </tbody></table></div>
      </div>`);
    });
    parts.push('<div class="fwa-note">C/T는 BOP 시트의 <b>설계값</b>(수기)이고 OEE는 가정값입니다. 배치 공정은 xlsx와 같이 합계·병목에서 제외하되, 개당 C/T가 병목보다 크면 위에 경고를 냅니다. 라인은 직렬(아마추어 → 조립)이라 제품 UPH는 느린 라인이 정합니다. 라인 간 버퍼·재공·수율은 고려하지 않습니다.</div>');
    box.innerHTML = parts.join('');
    box.classList.remove('loading');
    bindTooltips(box);
    bindLineBalance(container, st, box);
  }

  function bindLineBalance(container, st, box) {
    const lb = st.lb;
    const q = (sel) => box.querySelector(sel);
    const numIn = (el, key, min, max, def) => {
      el.onchange = () => { const v = Number(el.value); lb[key] = Number.isFinite(v) && v >= min && v <= max ? v : def; el.value = lb[key]; reloadLineBalance(container); };
    };
    if (q('.lb-hours')) numIn(q('.lb-hours'), 'hours', 0.1, 24, LB_DEFAULTS.hours);
    if (q('.lb-oee')) numIn(q('.lb-oee'), 'oee', 0.01, 1, LB_DEFAULTS.oee);
    if (q('.lb-target')) numIn(q('.lb-target'), 'targetUph', 1, 100000, LB_DEFAULTS.targetUph);
    if (q('.lb-hints')) q('.lb-hints').onchange = (ev) => { lb.hints = ev.target.checked; lb.parallel = {}; reloadLineBalance(container); };
    if (q('.lb-product')) q('.lb-product').onchange = (ev) => { lb.product = ev.target.value; lb.parallel = {}; reloadLineBalance(container); };
    if (q('.lb-reset')) q('.lb-reset').onclick = () => { Object.assign(lb, { hours: LB_DEFAULTS.hours, oee: LB_DEFAULTS.oee, targetUph: LB_DEFAULTS.targetUph, parallel: {}, hints: true }); reloadLineBalance(container); };
    box.querySelectorAll('.lb-par').forEach(el => {
      el.onchange = () => {
        const v = Math.round(Number(el.value));
        if (!Number.isFinite(v) || v < 1 || v > 20) { el.value = 1; }
        lb.parallel[el.dataset.op] = Math.min(20, Math.max(1, v || 1));
        reloadLineBalance(container);
      };
    });
  }

  /** 초 단위 축 최대값 — 5칸 눈금이 보기 좋게 */
  function niceCt(v) {
    const p = Math.pow(10, Math.floor(Math.log10(Math.max(1, v))));
    for (const m of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }

  // ── 차트 3: 라인별 공정 C/T 가로 막대 (병목 강조 · 배치 빗금 · 병렬 전 C/T 점선 · 목표 C/T 선) ──
  function lbChart(line, scale, params, idx) {
    const procs = line.processes;
    const W = 720, left = 178, right = 118, rowH = 24, barH = 12, top = 22, bottom = 8;
    const H = top + procs.length * rowH + bottom;
    const plotW = W - left - right;
    const x = (v) => left + Math.min(1, Math.max(0, v / scale)) * plotW;
    const hatchId = `fwa-hatch-${idx}`;
    let out = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(line.line)} 공정별 C/T">
      <defs><pattern id="${hatchId}" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)"><line class="hatch" x1="0" y1="0" x2="0" y2="6"/></pattern></defs>`;
    for (let i = 0; i <= 5; i++) {
      const v = (scale / 5) * i;
      out += `<line class="${i === 0 ? 'axis' : 'grid'}" x1="${x(v)}" y1="${top - 6}" x2="${x(v)}" y2="${H - bottom}"/>`;
      out += `<text class="lbl" x="${x(v)}" y="${top - 10}" text-anchor="middle">${num(v)}s</text>`;
    }
    // 목표 C/T 선 (takt) — 넘는 공정은 목표 UPH 를 못 맞춘다
    if (params.taktSec <= scale) out += `<line class="takt" x1="${x(params.taktSec)}" y1="${top - 4}" x2="${x(params.taktSec)}" y2="${H - bottom}"/>`;
    procs.forEach((pr, i) => {
      const y0 = top + i * rowH, yb = y0 + (rowH - barH) / 2, cy = y0 + rowH / 2;
      // 설비 연결 점 (색 = 현재 상태)
      const eq = pr.equipment;
      out += eq ? `<circle class="eqdot ${esc(eq.status)}" cx="10" cy="${cy}" r="4"/>` : `<circle class="eqdot unlinked" cx="10" cy="${cy}" r="3.5"/>`;
      out += `<text class="lbl strong" x="22" y="${cy + 4}">${esc(pr.op)}</text>`;
      out += `<text class="lbl" x="82" y="${cy + 4}">${esc(trunc(pr.name, 12))}</text>`;
      if (pr.isBatch) {
        if (pr.perUnitCtSec !== null) out += `<rect class="bar-batch" x="${left}" y="${yb}" width="${Math.max(1, x(pr.perUnitCtSec) - left)}" height="${barH}" rx="2" fill="url(#${hatchId})"/>`;
        out += `<text class="val" x="${W - right + 6}" y="${cy + 4}">${pr.perUnitCtSec === null ? '개당 —' : fmtCt(pr.perUnitCtSec) + '/ea'} <tspan class="m">${fmtCt(pr.ctSec)}${pr.batchSize ? '/' + pr.batchSize + 'ea' : ''}</tspan></text>`;
      } else if (pr.effectiveCtSec !== null) {
        if (pr.parallel > 1 && pr.ctSec <= scale) out += `<rect class="bar-raw" x="${left}" y="${yb}" width="${Math.max(1, x(pr.ctSec) - left)}" height="${barH}" rx="2"/>`;
        out += `<rect class="${pr.isBottleneck ? 'bar-bt' : 'bar-ct'}" x="${left}" y="${yb}" width="${Math.max(1, x(pr.effectiveCtSec) - left)}" height="${barH}" rx="2"/>`;
        out += `<text class="val${pr.isBottleneck ? ' strong' : ''}" x="${W - right + 6}" y="${cy + 4}">${fmtCt(pr.effectiveCtSec)}${pr.parallel > 1 ? ` <tspan class="m">${fmtCt(pr.ctSec)}×${pr.parallel}</tspan>` : ''}${pr.isBottleneck ? ' <tspan class="bt">병목</tspan>' : ''}</text>`;
      } else {
        out += `<text class="lbl" x="${W - right + 6}" y="${cy + 4}">C/T 없음</text>`;
      }
      const tip = `<b>${esc(pr.op)} ${esc(pr.name)}</b> <span class="m">${esc(pr.kind || '')}</span><br>C/T ${fmtCt(pr.ctSec)}${pr.isBatch ? ` / ${pr.batchSize ? pr.batchSize + 'ea 배치 → 개당 ' + fmtCt(pr.perUnitCtSec) : '배치 크기 미상'}` : pr.parallel > 1 ? ` ÷ 병렬 ${pr.parallel}대 = ${fmtCt(pr.effectiveCtSec)}` : ''}<br>설비 ${eq ? `${esc(eq.code)} ${esc(eq.name)} <span class="m">(${esc(eq.status)}${pr.linkedCount > 1 ? ` · ${pr.linkedCount}대` : ''})</span>` : '<span class="m">미연결</span>'}${pr.equipmentHint ? `<br><span class="m">BOP 설비: ${esc(pr.equipmentHint)}</span>` : ''}${pr.notes.length ? `<br><span class="m">${pr.notes.map(esc).join(' · ')}</span>` : ''}`;
      out += `<rect class="hit" x="0" y="${y0}" width="${W}" height="${rowH}" data-tip="${esc(tip)}"/>`;
    });
    return out + '</svg>';
  }
  function trunc(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  function card(k, v, sub) {
    return `<div class="fwa-card"><div class="k">${k}</div><div class="v${v === null ? ' na' : ''}">${v === null ? '계산 불가' : pct(v)}</div><div class="s">${sub}</div></div>`;
  }
  function mini(v, cls) {
    if (v === null || v === undefined) return '<span class="muted">—</span>';
    return `<span class="fwa-mb"><i><b class="${cls}" style="width:${clamp01(v) * 100}%"></b></i><span>${pct(v)}</span></span>`;
  }

  // ── 차트 1: 설비별 가동률·성능·품질 막대 + OEE 점 (가로) ──
  function oeeChart(eqs) {
    const W = 720, left = 96, right = 72, rowH = 32, barH = 7, gap = 2, top = 18;
    const H = top + eqs.length * rowH + 14;
    const plotW = W - left - right;
    const x = (v) => left + clamp01(v) * plotW;   // 모든 값은 0~1 (서버에서 상한)
    let out = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="설비별 OEE 구성 요소">`;
    // 격자 0/50/100%
    for (const t of [0, .5, 1]) {
      out += `<line class="${t === 0 ? 'axis' : 'grid'}" x1="${x(t)}" y1="${top - 6}" x2="${x(t)}" y2="${H - 12}"/>`;
      out += `<text class="lbl" x="${x(t)}" y="${top - 9}" text-anchor="middle">${t * 100}%</text>`;
    }
    eqs.forEach((e, i) => {
      const y0 = top + i * rowH;
      out += `<text class="lbl strong" x="${left - 8}" y="${y0 + 15}" text-anchor="end">${esc(e.code)}</text>`;
      // null 인 요소는 막대를 그리지 않는다 (오른쪽 'OEE —' 와 표의 비고가 이유를 말한다)
      [['a', e.availability], ['p', e.performance], ['q', e.quality]].forEach(([cls, v], j) => {
        const y = y0 + 2 + j * (barH + gap);
        if (v !== null) out += `<rect class="bar-${cls}" x="${left}" y="${y}" width="${Math.max(0, x(v) - left)}" height="${barH}" rx="2"/>`;
      });
      if (e.oee !== null) {
        out += `<circle class="oee-dot" cx="${x(e.oee)}" cy="${y0 + 2 + barH * 1.5 + gap}" r="4"/>`;
        out += `<text class="val" x="${W - right + 8}" y="${y0 + 17}">OEE ${pct(e.oee)}</text>`;
      } else {
        out += `<text class="lbl" x="${W - right + 8}" y="${y0 + 17}">OEE —</text>`;
      }
      const tip = `<b>${esc(e.name)}</b> <span class="m">${esc(e.code)}</span><br>가동률 ${pct(e.availability)} <span class="m">(RUN ${fmtMin(e.runMin)} / ${fmtMin(e.plannedMin)})</span><br>성능 ${pct(e.performance)} <span class="m">(${num(e.good + e.defect)} / ${e.target ? num(e.target) : '목표 없음'})</span><br>품질 ${pct(e.quality)} <span class="m">(양품 ${num(e.good)} · 불량 ${num(e.defect)})</span><br>OEE ${pct(e.oee)}`;
      out += `<rect class="hit" x="0" y="${y0}" width="${W}" height="${rowH}" data-tip="${esc(tip)}"/>`;
    });
    return out + '</svg>';
  }

  // ── 차트 2: 일별 양품/불량 누적 막대 + 목표 표시선 (세로) ──
  function prodChart(days) {
    const W = 720, H = 210, left = 46, right = 12, top = 14, bottom = 30;
    const plotW = W - left - right, plotH = H - top - bottom;
    const maxV = Math.max(1, ...days.map(d => Math.max(d.good + d.defect, d.target)));
    const nice = niceMax(maxV);
    const y = (v) => top + plotH - (v / nice) * plotH;
    const slot = plotW / days.length;
    const bw = Math.max(3, Math.min(28, slot * 0.6));
    const labelEvery = Math.ceil(days.length / 12);
    let out = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="일별 생산실적">`;
    for (let i = 0; i <= 4; i++) {
      const v = (nice / 4) * i;
      out += `<line class="${i === 0 ? 'axis' : 'grid'}" x1="${left}" y1="${y(v)}" x2="${W - right}" y2="${y(v)}"/>`;
      out += `<text class="lbl" x="${left - 6}" y="${y(v) + 4}" text-anchor="end">${num(Math.round(v))}</text>`;
    }
    days.forEach((d, i) => {
      const cx = left + slot * i + slot / 2, x0 = cx - bw / 2;
      if (d.good > 0) out += `<rect class="bar-good" x="${x0}" y="${y(d.good)}" width="${bw}" height="${y(0) - y(d.good)}" rx="${d.defect ? 0 : 3}"/>`;
      if (d.defect > 0) out += `<rect class="bar-defect cap" x="${x0}" y="${y(d.good + d.defect)}" width="${bw}" height="${y(d.good) - y(d.good + d.defect)}" rx="3"/>`;
      if (d.target > 0) out += `<line class="target" x1="${x0 - 3}" y1="${y(d.target)}" x2="${x0 + bw + 3}" y2="${y(d.target)}"/>`;
      if (d.good + d.defect > 0 && days.length <= 31) out += `<text class="val" x="${cx}" y="${y(d.good + d.defect) - 4}" text-anchor="middle">${num(d.good + d.defect)}</text>`;
      const last = days.length - 1;
      const labeled = i === last || (i % labelEvery === 0 && last - i >= Math.ceil(labelEvery / 2));   // 마지막 날은 항상 표시
      if (labeled) out += `<text class="lbl${i === last ? ' strong' : ''}" x="${cx}" y="${H - 10}" text-anchor="middle">${d.date.slice(5)}</text>`;
      const tip = `<b>${d.date}</b><br>양품 ${num(d.good)} · 불량 ${num(d.defect)}${d.good + d.defect ? ` <span class="m">(불량률 ${pct(d.defect / (d.good + d.defect))})</span>` : ''}<br>목표 ${d.target ? num(d.target) : '—'} · 작업지시 ${num(d.orders)}건 · 실적 입력 ${num(d.records)}건`;
      out += `<rect class="hit" x="${left + slot * i}" y="${top}" width="${slot}" height="${plotH}" data-tip="${esc(tip)}"/>`;
    });
    return out + '</svg>';
  }
  function niceMax(v) {
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 4, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }

  // ── 툴팁: .hit[data-tip] 위에 마우스가 오면 차트 상자 안에 표시 ──
  function bindTooltips(root) {
    root.querySelectorAll('.fwa-chart').forEach(chart => {
      let tip = null;
      chart.addEventListener('mousemove', (ev) => {
        const hit = ev.target.closest('.hit');
        if (!hit) { if (tip) { tip.remove(); tip = null; } return; }
        if (!tip) { tip = document.createElement('div'); tip.className = 'fwa-tip'; chart.appendChild(tip); }
        tip.innerHTML = hit.dataset.tip;
        const r = chart.getBoundingClientRect();
        const x = Math.max(80, Math.min(r.width - 80, ev.clientX - r.left));
        tip.style.left = x + 'px'; tip.style.top = (ev.clientY - r.top) + 'px';
      });
      chart.addEventListener('mouseleave', () => { if (tip) { tip.remove(); tip = null; } });
    });
  }

  // ── 공개 API ─────────────────────────────────────────
  window.FWAnalytics = {
    mount(container, api) {
      if (!container) throw new Error('컨테이너가 없습니다');
      if (!states.get(container)) build(container, api);
      else states.get(container).api = api;
      load(container);
    },
  };
})();
