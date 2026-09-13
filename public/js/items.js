/* 품목 등록 (스프린트 4) — window.FWItems = { mount(container, api) }
 *
 * 자재 탭(js/materials.js)은 이미 있는 기준을 보는 화면이다. 이 화면은 그 반대 — 품번 하나를 새로 만들고 BOM 에 붙이는 일만 한다.
 * 그래서 필수는 세 칸(품번·품명·품목구분)뿐이고, 품목구분을 고르면 분류·조달·추적·사용기한 기본값이 서버(GET item-groups)가 준 값으로 따라온다.
 * 사용자가 직접 건드린 칸은 다시 덮어쓰지 않는다(touched).
 *
 * 쓰는 API (인터페이스 §11):
 *   GET  /api/admin/materials/item-groups     품목구분 9종 + 각 구분의 분류 후보·기본값
 *   GET  /api/admin/materials/uom             기준단위
 *   GET  /api/admin/materials/items?q=&group= 목록
 *   GET  /api/admin/materials/items/:pn       상세 (whereUsed 포함)
 *   POST /api/admin/materials/items           등록·수정(품번 기준 upsert)
 *   PUT  /api/admin/materials/items/:pn       품번을 바꿀 때
 *   POST /api/admin/materials/bom-attach      상위 품목 BOM 에 이 품목을 한 줄 붙인다
 *   PUT/DELETE /api/admin/materials/bom-lines/:id   BOM 에서 빼기 (운영 BOM 은 유효일로 끊는다)
 */
(function () {
  'use strict';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TRACE = [['NONE', '관리 안 함'], ['LOT', '로트(묶음) 관리'], ['SERIAL', '시리얼(개체) 관리']];
  const SOURCE = [['BUY', '구매'], ['MAKE', '생산'], ['BOTH', '구매·생산 둘 다']];
  const STATUS = [['ACTIVE', '사용'], ['DRAFT', '작성중'], ['BLOCKED', '사용중지'], ['OBSOLETE', '단종']];
  const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

  // 서버(트리거)가 내는 규칙 위반 메시지를 현장 말로 바꾼다. 원문은 뒤에 괄호로 남겨 근거를 잃지 않는다.
  const PLAIN = [
    [/^R-22/, '그 공정은 상위 품목이 이미 완성된 뒤입니다 — 상위 품목을 만드는 공정보다 앞선 공정을 고르세요.'],
    [/^R-1:/, '넣을 수 없습니다 — 이렇게 넣으면 서로가 서로의 부품이 되는 순환이 생깁니다.'],
    [/^R-9/, '단위가 맞지 않습니다 — 소요량 단위는 그 품목의 기준단위와 같은 종류여야 합니다.'],
    [/^R-11/, '이미 승인된 BOM 입니다 — 지우는 대신 유효일로 끊습니다.'],
    [/^R-13/, '팬텀(가상) 조립품에는 이렇게 붙일 수 없습니다.'],
    [/CHECK constraint failed: pn /, '품번 형식이 맞지 않습니다 — 32자 이내, 공백과 / 는 쓸 수 없습니다.'],
    [/UNIQUE constraint failed: item\.pn/, '이미 있는 품번입니다.'],
  ];
  const plain = (m) => {
    const hit = PLAIN.find(([re]) => re.test(m));
    return hit ? `${hit[1]} (${m})` : m;
  };

  let api = null, root = null;
  const S = { groups: [], uoms: [], procs: [], items: [], sel: null, filter: '', group: '', touched: new Set(), busy: false };

  function mount(container, apiFn) {
    api = apiFn; root = container;
    if (!root.dataset.fwiReady) { skeleton(); root.dataset.fwiReady = '1'; }
    reload().catch((e) => msg(plain(e.message), true));
  }

  // ── 뼈대 ──────────────────────────────────────────────────────────────────
  function skeleton() {
    root.innerHTML = `
      <div class="fwi">
        <h2>품목 등록 <small>품번을 만들고 BOM 에 붙인다 · 보기·전개는 🧩 자재 탭</small></h2>
        <div class="fwi-wrap">
          <aside class="fwi-side">
            <div class="fwi-search">
              <input id="fwi-q" placeholder="품번·품명 검색" autocomplete="off">
              <button id="fwi-new" type="button">+ 새 품목</button>
            </div>
            <div class="fwi-chips" id="fwi-chips"></div>
            <div class="fwi-list" id="fwi-list"></div>
          </aside>
          <section class="fwi-main">
            <div class="fwi-head">
              <b id="fwi-title">새 품목</b>
              <span class="fwi-sub" id="fwi-sub">필수는 품번 · 품명 · 품목구분 세 칸입니다. 나머지는 구분을 고르면 채워집니다.</span>
            </div>
            <div class="fwi-grid" id="fwi-grid"></div>
            <div class="fwi-foot">
              <button id="fwi-save" type="button">저장</button>
              <button id="fwi-reset" type="button" class="ghost">되돌리기</button>
              <span id="fwi-msg" class="fwi-msg"></span>
            </div>
            <div class="fwi-bom" id="fwi-bom"></div>
          </section>
        </div>
      </div>`;
    root.querySelector('#fwi-q').addEventListener('input', (e) => { S.filter = e.target.value.trim(); loadList(); });
    root.querySelector('#fwi-new').onclick = () => { S.sel = null; S.touched.clear(); renderForm(); renderBom(); msg(''); };
    root.querySelector('#fwi-reset').onclick = () => { S.touched.clear(); renderForm(); msg(''); };
    root.querySelector('#fwi-save').onclick = save;
  }

  async function reload() {
    const [groups, uoms, procs] = await Promise.all([
      api('/api/admin/materials/item-groups'), api('/api/admin/materials/uom'),
      api('/api/admin/materials/process').catch(() => []),
    ]);
    S.groups = groups; S.uoms = uoms; S.procs = Array.isArray(procs) ? procs : [];
    renderChips(); renderForm(); renderBom();
    await loadList();
  }

  const $ = (id) => root.querySelector('#' + id);
  const val = (id) => ($(id) ? $(id).value.trim() : '');
  function msg(text, bad) {
    const el = $('fwi-msg'); if (!el) return;
    el.textContent = text || ''; el.className = 'fwi-msg' + (text ? (bad ? ' bad' : ' ok') : '');
  }

  // ── 왼쪽: 구분 칩 + 목록 ──────────────────────────────────────────────────
  function renderChips() {
    $('fwi-chips').innerHTML = [`<button type="button" class="fwi-chip${S.group ? '' : ' on'}" data-g="">전체</button>`]
      .concat(S.groups.map((g) => `<button type="button" class="fwi-chip${S.group === g.code ? ' on' : ''}" data-g="${esc(g.code)}" title="${esc(g.hint)}">${esc(g.name)} <i>${g.itemCount}</i></button>`))
      .join('');
    $('fwi-chips').querySelectorAll('button').forEach((b) => {
      b.onclick = () => { S.group = b.dataset.g; renderChips(); loadList(); };
    });
  }

  async function loadList() {
    const qs = new URLSearchParams();
    if (S.filter) qs.set('q', S.filter);
    if (S.group) qs.set('group', S.group);
    try {
      S.items = await api('/api/admin/materials/items' + (qs.toString() ? '?' + qs : ''));
    } catch (e) { S.items = []; msg(plain(e.message), true); }
    const box = $('fwi-list');
    if (!S.items.length) { box.innerHTML = `<p class="fwi-none">해당하는 품목이 없습니다.</p>`; return; }
    box.innerHTML = S.items.map((i) => `
      <button type="button" class="fwi-row${S.sel && S.sel.pn === i.pn ? ' on' : ''}" data-pn="${esc(i.pn)}">
        <span class="pn">${esc(i.pn)}</span>
        <span class="nm">${esc(i.nameKo || i.name)}</span>
        <span class="tag">${esc(i.groupName || i.kind)}</span>
        ${i.status === 'ACTIVE' ? '' : `<span class="st">${esc(statusName(i.status))}</span>`}
      </button>`).join('');
    box.querySelectorAll('.fwi-row').forEach((b) => { b.onclick = () => select(b.dataset.pn); });
    datalistParents();
  }
  const statusName = (c) => (STATUS.find((s) => s[0] === c) || [c, c])[1];

  // keepMsg: 저장·붙이기 직후에는 방금 띄운 안내를 지우지 않는다 (상세를 다시 읽어도 결과 문구가 남아야 한다)
  async function select(pn, keepMsg) {
    try {
      const d = await api('/api/admin/materials/items/' + encodeURIComponent(pn));
      S.sel = d.item; S.sel.whereUsed = d.whereUsed || []; S.sel.headers = d.headers || [];
      S.touched.clear(); renderForm(); renderBom();
      if (!keepMsg) msg('');
      loadList();
    } catch (e) { msg(plain(e.message), true); }
  }

  // ── 가운데: 등록 폼 ────────────────────────────────────────────────────────
  const opts = (pairs, sel) => pairs.map(([v, t]) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(t)}</option>`).join('');

  function renderForm() {
    const it = S.sel, g = groupOf(it ? it.group : (S.groups[0] || {}).code);
    $('fwi-title').textContent = it ? `${it.pn}` : '새 품목';
    $('fwi-sub').textContent = it
      ? `${it.groupName || it.kind} · 등록 ${String(it.createdAt || '').slice(0, 10)}${it.isTmp ? ' · 임시 품번(TMP-)' : ''}`
      : '필수는 품번 · 품명 · 품목구분 세 칸입니다. 나머지는 구분을 고르면 채워집니다.';

    const uomOpts = S.uoms.map((u) => [u.code, `${u.symbol} (${u.name})`]);
    $('fwi-grid').innerHTML = `
      <label class="req">품번
        <input id="fwi-pn" value="${esc(it ? it.pn : '')}" placeholder="예) BRG-6003" maxlength="32" autocomplete="off">
        <small>32자 이내. 공백과 <code>/</code> 는 쓸 수 없습니다.</small></label>
      <label class="req">품명
        <input id="fwi-name" value="${esc(it ? (it.nameKo || it.name) : '')}" placeholder="예) 볼베어링 6003ZZ" autocomplete="off"></label>
      <label class="req">품목구분
        <select id="fwi-group">${opts(S.groups.map((x) => [x.code, x.name]), it ? it.group : g.code)}</select>
        <small id="fwi-ghint">${esc(g.hint || '')}</small></label>
      <label>분류
        <select id="fwi-class"></select>
        <small>구분 안에서 더 나누는 칸입니다. 맞는 것이 없으면 가장 가까운 것을 고르세요.</small></label>
      <label>규격·재질
        <input id="fwi-spec" value="${esc(it ? it.spec || '' : '')}" placeholder="예) SUS304 · φ35×10" autocomplete="off"></label>
      <label class="req">기준단위
        <select id="fwi-uom">${opts(uomOpts, it ? it.uom : 'EA')}</select>
        <small>재고·BOM·로트가 전부 이 단위로 돕니다. 나중에 바꾸기 어렵습니다.</small></label>
      <label>입고단위
        <div class="fwi-inline">
          <input id="fwi-inuom" value="${esc(it ? it.inUom || '' : '')}" placeholder="BOX" maxlength="16" autocomplete="off" list="fwi-inuoms">
          <span>1 =</span>
          <input id="fwi-inqty" type="number" min="0" step="any" value="${it && it.inQty != null ? it.inQty : ''}" placeholder="1">
          <b id="fwi-inbase"></b>
        </div>
        <small id="fwi-inprev">사는 단위와 쓰는 단위가 다를 때만 적습니다. 예) 1 BOX = 100 EA</small>
        <datalist id="fwi-inuoms"><option value="BOX"><option value="CASE"><option value="ROLL"><option value="CAN"><option value="BAG"><option value="PLT"><option value="DRUM"></datalist></label>
      <label>사용기한
        <div class="fwi-inline"><input id="fwi-shelf" type="number" min="1" step="1" value="${it && it.shelfLifeDays != null ? it.shelfLifeDays : ''}" placeholder="무기한"><span>일</span></div>
        <small id="fwi-shelfhint"></small></label>
      <label>추적 단위
        <select id="fwi-trace">${opts(TRACE, it ? it.traceKind : g.traceKind)}</select>
        <small>로트를 쌓기 시작한 뒤에는 줄일 수 없습니다 — 애매하면 로트로 두세요.</small></label>
      <label>조달
        <select id="fwi-source">${opts(SOURCE, it ? it.sourceType : g.sourceType)}</select></label>
      <label>상태
        <select id="fwi-status">${opts(STATUS, it ? it.status : 'DRAFT')}</select>
        <small>새 품목은 <b>작성중</b>으로 시작합니다. 아래에서 BOM 에 붙이면 <b>사용</b>으로 바뀝니다. 품목은 지우지 않고 <b>단종</b>으로 바꿉니다.</small></label>`;

    fillClasses(it ? it.group : g.code, it ? it.classId : null);
    ['fwi-class', 'fwi-uom', 'fwi-trace', 'fwi-source', 'fwi-shelf', 'fwi-inuom', 'fwi-inqty'].forEach((id) => {
      const el = $(id); if (el) el.addEventListener('change', () => S.touched.add(id));
    });
    $('fwi-group').onchange = onGroupChange;
    $('fwi-uom').addEventListener('change', inPreview);
    $('fwi-inuom').addEventListener('input', inPreview);
    $('fwi-inqty').addEventListener('input', inPreview);
    $('fwi-pn').addEventListener('input', () => { const e = $('fwi-pn'); e.value = e.value.replace(/\s+/g, ''); });
    inPreview(); shelfHint();
  }

  const groupOf = (code) => S.groups.find((x) => x.code === code) || S.groups[0] || { code: '', classes: [], hint: '' };

  function fillClasses(groupCode, classId) {
    const g = groupOf(groupCode), sel = $('fwi-class');
    if (!sel) return;
    sel.innerHTML = opts(g.classes.map((c) => [String(c.id), c.name]), String(classId ?? g.defaultClassId ?? ''));
  }

  function onGroupChange() {
    const g = groupOf(val('fwi-group'));
    $('fwi-ghint').textContent = g.hint || '';
    fillClasses(g.code, null);
    // 사용자가 손대지 않은 칸만 구분 기본값으로 맞춘다
    if (!S.touched.has('fwi-trace')) $('fwi-trace').value = g.traceKind || 'NONE';
    if (!S.touched.has('fwi-source')) $('fwi-source').value = g.sourceType || 'BUY';
    if (!S.touched.has('fwi-shelf')) $('fwi-shelf').value = g.shelfLifeDays ?? '';
    shelfHint();
  }

  function shelfHint() {
    const g = groupOf(val('fwi-group')), c = g.classes.find((x) => String(x.id) === val('fwi-class'));
    const el = $('fwi-shelfhint'); if (!el) return;
    el.innerHTML = val('fwi-shelf')
      ? `입고일 + ${esc(val('fwi-shelf'))}일 이 그 로트의 유효일이 됩니다.`
      : (c && c.shelfLifeDays ? `비우면 분류 기본값 <b>${c.shelfLifeDays}일</b>을 씁니다.` : '비우면 기한 관리를 하지 않습니다.');
  }

  function inPreview() {
    const base = val('fwi-uom') || 'EA', u = val('fwi-inuom'), q = num(val('fwi-inqty'));
    if ($('fwi-inbase')) $('fwi-inbase').textContent = base;
    const el = $('fwi-inprev'); if (!el) return;
    el.innerHTML = u
      ? `발주·입고는 <b>${esc(u)}</b> 단위로, 재고·BOM 은 <b>${esc(base)}</b> 로 봅니다 — 1 ${esc(u)} = ${q && q > 0 ? q : 1} ${esc(base)}.`
      : '사는 단위와 쓰는 단위가 다를 때만 적습니다. 예) 1 BOX = 100 EA';
    shelfHint();
  }

  // ── 저장 ──────────────────────────────────────────────────────────────────
  async function save() {
    if (S.busy) return;
    const pn = val('fwi-pn'), name = val('fwi-name');
    if (!pn) return msg('품번을 적어 주세요.', true);
    if (/[\s/]/.test(pn)) return msg('품번에 공백이나 / 는 쓸 수 없습니다.', true);
    if (!name) return msg('품명을 적어 주세요.', true);
    const body = {
      pn, name, group: val('fwi-group'), classId: num(val('fwi-class')), spec: val('fwi-spec') || null,
      uom: val('fwi-uom'), traceKind: val('fwi-trace'), sourceType: val('fwi-source'), status: val('fwi-status'),
      shelfLifeDays: val('fwi-shelf') || null, inUom: val('fwi-inuom') || null, inQty: val('fwi-inqty') || null,
    };
    S.busy = true; $('fwi-save').disabled = true;
    try {
      const renaming = S.sel && S.sel.pn !== pn;
      const r = renaming
        ? await api('/api/admin/materials/items/' + encodeURIComponent(S.sel.pn), { method: 'PUT', body: JSON.stringify(body) })
        : await api('/api/admin/materials/items', { method: 'POST', body: JSON.stringify(body) });
      msg(r.created ? `품목 ${pn} 을 등록했습니다. 아래에서 BOM 에 붙일 수 있습니다.` : `품목 ${pn} 을 저장했습니다.`);
      await select(pn, true);
    } catch (e) { msg(plain(e.message), true); }
    finally { S.busy = false; const b = $('fwi-save'); if (b) b.disabled = false; }
  }

  // ── 아래: BOM 연결 ────────────────────────────────────────────────────────
  function datalistParents() {
    const dl = root.querySelector('#fwi-parents');
    if (dl) dl.innerHTML = S.items.map((i) => `<option value="${esc(i.pn)}">${esc(i.nameKo || i.name)}</option>`).join('');
  }

  function renderBom() {
    const box = $('fwi-bom'), it = S.sel;
    if (!it) {
      box.innerHTML = `<div class="fwi-bomhead"><b>BOM 연결</b><span>품목을 저장하면 여기서 상위 품목에 붙일 수 있습니다.</span></div>`;
      return;
    }
    const rows = (it.whereUsed || []).filter((w) => w.status !== 'OBSOLETE');
    box.innerHTML = `
      <div class="fwi-bomhead"><b>BOM 연결</b><span>${esc(it.pn)} 이 들어가는 상위 품목 — 모자(母子)관계 한 단계</span></div>
      ${rows.length ? `<table class="fwi-bomtable">
        <tr><th>상위 품목(모품목)</th><th class="r">소요량</th><th>BOM 상태</th><th></th></tr>
        ${rows.map((w) => `<tr>
          <td><b>${esc(w.parentPn)}</b> <span class="muted">${esc(w.parentName || '')}</span></td>
          <td class="r">${w.qtyPer} ${esc(w.uom)}</td>
          <td><span class="fwi-badge ${w.status === 'ACTIVE' ? 'on' : ''}">${esc(w.status === 'ACTIVE' ? '운영' : w.status === 'DRAFT' ? '작성중' : '승인')}</span></td>
          <td class="r"><button type="button" class="ghost sm" data-line="${w.lineId}" data-st="${esc(w.status)}" data-parent="${esc(w.parentPn)}">빼기</button></td>
        </tr>`).join('')}</table>`
        : `<p class="fwi-none">아직 어느 BOM 에도 들어 있지 않습니다.</p>`}
      ${!rows.length && it.status === 'ACTIVE' && it.kind !== 'FG'
        ? `<p class="fwi-warn">쓰이는 곳이 없는 <b>사용</b> 품목입니다 — 자재 점검(R-4)에 고아로 잡힙니다. BOM 에 붙이거나, 단독으로 쓰는 품목이면 그대로 두셔도 됩니다.</p>` : ''}
      <div class="fwi-attach">
        <input id="fwi-parent" list="fwi-parents" placeholder="상위 품목 품번" autocomplete="off">
        <datalist id="fwi-parents"></datalist>
        <span>에</span>
        <input id="fwi-qty" type="number" min="0" step="any" placeholder="소요량">
        <b>${esc(it.uom)}</b>
        <span>투입 공정</span>
        <select id="fwi-op">${opts([['', '나중에 정함']].concat(S.procs.map((p) => [p.op, `${p.op} ${p.name}`])), '')}</select>
        <button type="button" id="fwi-attach">붙이기</button>
      </div>
      <p class="fwi-hint">완성품 1대에 몇 개 들어가는지가 아니라 <b>상위 품목 1개당</b> 몇 개인지를 적습니다.
        투입 공정을 비워 두면 <b>미배정</b>으로 남아 자재 점검(D-8)에 뜹니다 — 나중에 🧩 자재 탭에서 붙일 수 있습니다.</p>`;
    datalistParents();
    box.querySelectorAll('[data-line]').forEach((b) => { b.onclick = () => detach(b.dataset.line, b.dataset.st, b.dataset.parent); });
    $('fwi-attach').onclick = attach;
  }

  async function attach() {
    const parentPn = val('fwi-parent'), qty = num(val('fwi-qty'));
    if (!parentPn) return msg('상위 품목 품번을 고르세요.', true);
    if (!qty || qty <= 0) return msg('소요량은 0 보다 커야 합니다.', true);
    try {
      const op = val('fwi-op');
      const r = await api('/api/admin/materials/bom-attach', {
        method: 'POST', body: JSON.stringify({ parentPn, childPn: S.sel.pn, qtyPer: qty, uom: S.sel.uom, op: op || null }),
      });
      // 작성중이던 품목은 BOM 에 자리를 잡는 순간 사용으로 올린다 (쓰이지 않는 ACTIVE 품목은 자재 점검에서 고아 R-4 로 잡힌다)
      let promoted = false;
      if (S.sel.status === 'DRAFT') {
        await api('/api/admin/materials/items/' + encodeURIComponent(S.sel.pn), { method: 'PUT', body: JSON.stringify({ status: 'ACTIVE' }) });
        promoted = true;
      }
      msg(`${parentPn} BOM 에 ${S.sel.pn} ${qty} ${S.sel.uom} 을 붙였습니다.`
        + (r.linkedOp ? ` 투입 공정은 ${r.linkedOp} 입니다.` : ' 투입 공정은 아직 미배정입니다.')
        + (r.createdHeader ? ' 상위 품목의 BOM 을 새로 만들었습니다.' : '') + (promoted ? ' 상태를 사용으로 올렸습니다.' : ''));
      await select(S.sel.pn, true);
    } catch (e) { msg(plain(e.message), true); }
  }

  async function detach(lineId, status, parentPn) {
    const live = status !== 'DRAFT';
    if (!confirm(live
      ? `${parentPn} 은 이미 운영 중인 BOM 입니다.\n지금부터 안 들어가는 것으로 끊습니다(과거 기록은 그대로 남습니다). 계속할까요?`
      : `${parentPn} BOM 에서 이 줄을 지웁니다. 계속할까요?`)) return;
    try {
      if (live) {
        const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        await api('/api/admin/materials/bom-lines/' + lineId, { method: 'PUT', body: JSON.stringify({ effTo: y }) });
        msg(`${parentPn} BOM 에서 ${y} 자로 끊었습니다.`);
      } else {
        await api('/api/admin/materials/bom-lines/' + lineId, { method: 'DELETE' });
        msg(`${parentPn} BOM 에서 지웠습니다.`);
      }
      await select(S.sel.pn, true);
    } catch (e) { msg(plain(e.message), true); }
  }

  window.FWItems = { mount };
})();
