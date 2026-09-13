/* 거래처 (스프린트 4) — window.FWPartners = { mount(container, api) }
 *
 * 품목 등록 화면(js/items.js)과 같은 구조·같은 스타일(css/items.css 의 .fwi-*)을 쓴다 —
 * 위쪽 시트(고정 머리글·정렬·CSV·폭 반응형) + 행을 누르면 아래에 등록/수정 폼.
 * 매입처와 매출처를 한 표에 두고 거래구분으로 나눈다. 지우지 않고 상태(거래중·보류·종료)로 관리한다.
 *
 * 쓰는 API (인터페이스 §12):
 *   GET  /api/admin/partners/meta          거래구분·상태 목록 + 건수 + 다음 자동 코드
 *   GET  /api/admin/partners?q=&kind=      목록 (매입/매출을 고르면 '매입·매출'도 함께 나온다)
 *   GET  /api/admin/partners/:code         한 건
 *   POST /api/admin/partners               등록·수정(코드 기준 upsert, 코드를 비우면 자동 채번)
 *   PUT  /api/admin/partners/:code         코드를 바꿀 때
 */
(function () {
  'use strict';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plain = (m) => (/UNIQUE constraint failed: partners\.code/.test(m) ? `이미 있는 거래처 코드입니다. (${m})`
    : /UNIQUE constraint failed: partners\.biz_no/.test(m) ? `같은 사업자등록번호가 이미 등록돼 있습니다. (${m})` : m);

  const COLS = [
    { key: 'code', label: '거래처 코드', cls: 'mono b stick', pri: 1, get: (p) => p.code },
    { key: 'name', label: '거래처명', pri: 1, get: (p) => p.name },
    { key: 'kindName', label: '거래구분', cls: 'c', pri: 1, get: (p) => p.kindName },
    { key: 'bizNo', label: '사업자등록번호', cls: 'c mono', pri: 2, get: (p) => p.bizNo || '' },
    { key: 'ceo', label: '대표자', cls: 'c dim', pri: 3, get: (p) => p.ceo || '' },
    { key: 'bizType', label: '업태', cls: 'dim', pri: 4, get: (p) => p.bizType || '' },
    { key: 'bizItem', label: '종목', cls: 'dim', pri: 4, get: (p) => p.bizItem || '' },
    { key: 'tel', label: '전화', cls: 'c mono', pri: 2, get: (p) => p.tel || '' },
    { key: 'mgrName', label: '담당자', cls: 'c dim', pri: 3, get: (p) => p.mgrName || '' },
    { key: 'linkedItems', label: '연결 품목', cls: 'r', pri: 2, sort: (p) => p.linkedItems ?? -1,
      get: (p) => (p.linkedItems == null ? '' : p.linkedItems ? `${p.linkedItems}건` : '') },
    { key: 'payTerms', label: '결제조건', cls: 'dim', pri: 4, get: (p) => p.payTerms || '' },
    { key: 'currency', label: '통화', cls: 'c dim', pri: 4, get: (p) => p.currency || '' },
    { key: 'status', label: '상태', cls: 'c', pri: 1, get: (p) => p.statusName || p.status },
  ];
  const colCls = (c, extra) => [c.cls || '', 'pri' + (c.pri || 1), extra || ''].filter(Boolean).join(' ');

  let api = null, root = null;
  const S = { meta: null, rows: [], sel: null, filter: '', kind: '', sort: { key: 'code', dir: 1 }, busy: false };

  function mount(container, apiFn) {
    api = apiFn; root = container;
    if (!root.dataset.fwpReady) { skeleton(); root.dataset.fwpReady = '1'; }
    reload().catch((e) => msg(plain(e.message), true));
  }

  function skeleton() {
    root.innerHTML = `
      <div class="fwi">
        <h2>거래처 <small>매입처·매출처를 한 곳에서 관리한다 · 품목과의 연결은 품목 세부 등록에서</small></h2>
        <div class="fwi-bar">
          <input id="fwp-q" placeholder="코드·상호·사업자번호·대표자·담당자 검색" autocomplete="off">
          <button id="fwp-new" type="button">+ 새 거래처</button>
          <button id="fwp-csv" type="button" class="ghost">⬇ 엑셀(CSV)</button>
          <span class="fwi-count" id="fwp-count"></span>
        </div>
        <div class="fwi-chips" id="fwp-chips"></div>
        <div class="fwi-sheetwrap"><table class="fwi-sheet" id="fwp-sheet"></table></div>
        <p class="fwi-hint">머리글을 누르면 그 열로 정렬합니다. 행을 누르면 아래에서 고칠 수 있습니다.
          <b>매입</b>이나 <b>매출</b>을 고르면 <b>매입·매출</b> 거래처도 함께 나옵니다 — 실제로 그 역할을 하기 때문입니다.</p>
        <section class="fwi-main" id="fwp-editor" hidden>
          <div class="fwi-head">
            <b id="fwp-title">새 거래처</b>
            <span class="fwi-sub" id="fwp-sub"></span>
            <button id="fwp-close" type="button" class="ghost sm">닫기</button>
          </div>
          <div class="fwi-grid" id="fwp-grid"></div>
          <div class="fwi-foot">
            <button id="fwp-save" type="button">저장</button>
            <button id="fwp-reset" type="button" class="ghost">되돌리기</button>
            <span id="fwp-msg" class="fwi-msg"></span>
          </div>
          <div class="fwi-bom" id="fwp-items"></div>
        </section>
      </div>`;
    $('fwp-q').addEventListener('input', (e) => { S.filter = e.target.value.trim(); load(); });
    $('fwp-new').onclick = () => { S.sel = null; openEditor(); msg(''); };
    $('fwp-close').onclick = () => { S.sel = null; $('fwp-editor').hidden = true; renderSheet(); };
    $('fwp-csv').onclick = exportCsv;
    $('fwp-reset').onclick = () => { renderForm(); msg(''); };
    $('fwp-save').onclick = save;
  }

  const $ = (id) => root.querySelector('#' + id);
  const val = (id) => ($(id) ? $(id).value.trim() : '');
  function msg(text, bad) {
    const el = $('fwp-msg'); if (!el) return;
    el.textContent = text || ''; el.className = 'fwi-msg' + (text ? (bad ? ' bad' : ' ok') : '');
  }

  async function reload() {
    S.meta = await api('/api/admin/partners/meta');
    renderChips();
    await load();
  }

  function renderChips() {
    const k = S.meta.kinds;
    $('fwp-chips').innerHTML = [`<button type="button" class="fwi-chip${S.kind ? '' : ' on'}" data-k="">전체 <i>${S.meta.total}</i></button>`]
      .concat(k.map((x) => `<button type="button" class="fwi-chip${S.kind === x.code ? ' on' : ''}" data-k="${esc(x.code)}" title="${esc(x.hint)}">${esc(x.name)} <i>${x.count}</i></button>`))
      .join('');
    $('fwp-chips').querySelectorAll('button').forEach((b) => { b.onclick = () => { S.kind = b.dataset.k; renderChips(); load(); }; });
  }

  async function load() {
    const qs = new URLSearchParams();
    if (S.filter) qs.set('q', S.filter);
    if (S.kind) qs.set('kind', S.kind);
    try { S.rows = await api('/api/admin/partners' + (qs.toString() ? '?' + qs : '')); }
    catch (e) { S.rows = []; msg(plain(e.message), true); }
    renderSheet();
  }

  function sorted() {
    const c = COLS.find((x) => x.key === S.sort.key) || COLS[0];
    const key = c.sort || ((p) => String(c.get(p) ?? '').toLowerCase());
    return S.rows.slice().sort((a, b) => {
      const x = key(a), y = key(b);
      if (x === y) return String(a.code).localeCompare(String(b.code));
      return (x > y ? 1 : -1) * S.sort.dir;
    });
  }

  function renderSheet() {
    const rows = sorted();
    $('fwp-count').textContent = S.rows.length ? `${S.rows.length}건${S.filter ? ` · "${S.filter}"` : ''}` : '';
    const head = `<thead><tr><th class="no">#</th>${COLS.map((c) =>
      `<th data-k="${c.key}" class="${colCls(c, S.sort.key === c.key ? 'on' : '')}">${esc(c.label)}<i>${S.sort.key === c.key ? (S.sort.dir > 0 ? '▲' : '▼') : ''}</i></th>`).join('')}</tr></thead>`;
    const body = rows.length
      ? `<tbody>${rows.map((p, n) => `
          <tr data-code="${esc(p.code)}" class="${S.sel && S.sel.code === p.code ? 'on' : ''}${p.status === 'CLOSED' ? ' off' : ''}">
            <td class="no">${n + 1}</td>
            ${COLS.map((c) => `<td class="${colCls(c)}">${esc(c.get(p) ?? '')}</td>`).join('')}
          </tr>`).join('')}</tbody>`
      : `<tbody><tr><td class="fwi-none" colspan="${COLS.length + 1}">등록된 거래처가 없습니다. 위 [+ 새 거래처]로 등록하세요.</td></tr></tbody>`;
    $('fwp-sheet').innerHTML = head + body;
    $('fwp-sheet').querySelectorAll('th[data-k]').forEach((th) => {
      th.onclick = () => { const k = th.dataset.k; S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : 1 }; renderSheet(); };
    });
    $('fwp-sheet').querySelectorAll('tr[data-code]').forEach((tr) => { tr.onclick = () => select(tr.dataset.code); });
  }

  function exportCsv() {
    if (!S.rows.length) return;
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const extra = [['주소', (p) => [p.zipcode, p.addr].filter(Boolean).join(' ')], ['이메일', (p) => p.email || ''], ['비고', (p) => p.note || '']];
    const lines = [['#'].concat(COLS.map((c) => c.label), extra.map((e) => e[0])).map(cell).join(',')]
      .concat(sorted().map((p, n) => [n + 1].concat(COLS.map((c) => c.get(p) ?? ''), extra.map((e) => e[1](p))).map(cell).join(',')));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `거래처목록-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function select(code, keepMsg) {
    try {
      const d = await api('/api/admin/partners/' + encodeURIComponent(code));
      S.sel = d.partner;
      S.sel.links = await api('/api/admin/partners/' + encodeURIComponent(code) + '/items').catch(() => []);
      openEditor();
      if (!keepMsg) msg('');
      load();
    } catch (e) { msg(plain(e.message), true); }
  }

  function openEditor() {
    $('fwp-editor').hidden = false;
    renderForm(); renderLinks();
    if (!S.sel) { $('fwp-editor').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); setTimeout(() => $('fwp-name') && $('fwp-name').focus(), 250); }
  }

  const opts = (pairs, sel) => pairs.map(([v, t]) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(t)}</option>`).join('');

  function renderForm() {
    const p = S.sel, kinds = S.meta.kinds.map((k) => [k.code, k.name]), sts = S.meta.statuses.map((s) => [s.code, s.name]);
    $('fwp-title').textContent = p ? p.name : '새 거래처';
    $('fwp-sub').textContent = p
      ? `${p.code} · ${p.kindName} · 등록 ${String(p.createdAt || '').slice(0, 10)}`
      : '필수는 거래처명과 거래구분 두 칸입니다. 코드를 비우면 자동으로 붙습니다.';
    const v = (k) => esc(p ? p[k] || '' : '');
    $('fwp-grid').innerHTML = `
      <label>거래처 코드
        <input id="fwp-code" value="${v('code')}" placeholder="${esc(S.meta.nextCode)} (비우면 자동)" maxlength="20" autocomplete="off">
        <small>비우고 저장하면 <b>${esc(S.meta.nextCode)}</b> 가 붙습니다. 사내 코드가 있으면 그대로 쓰세요.</small></label>
      <label class="req">거래처명
        <input id="fwp-name" value="${v('name')}" placeholder="예) (주)대한베어링" autocomplete="off"></label>
      <label class="req">거래구분
        <select id="fwp-kind">${opts(kinds, p ? p.kind : 'BUY')}</select>
        <small id="fwp-khint"></small></label>
      <label>사업자등록번호
        <input id="fwp-bizno" value="${v('bizNo')}" placeholder="123-45-67890" autocomplete="off">
        <small>자릿수 검증식까지 확인합니다. 없으면 비워 두세요.</small></label>
      <label>대표자
        <input id="fwp-ceo" value="${v('ceo')}" autocomplete="off"></label>
      <label>업태
        <input id="fwp-biztype" value="${v('bizType')}" placeholder="예) 제조업" autocomplete="off"></label>
      <label>종목
        <input id="fwp-bizitem" value="${v('bizItem')}" placeholder="예) 베어링 도매" autocomplete="off"></label>
      <label>대표 전화
        <input id="fwp-tel" value="${v('tel')}" placeholder="031-000-0000" autocomplete="off"></label>
      <label>팩스
        <input id="fwp-fax" value="${v('fax')}" autocomplete="off"></label>
      <label>대표 이메일
        <input id="fwp-email" value="${v('email')}" placeholder="sales@example.com" autocomplete="off"></label>
      <label>우편번호
        <input id="fwp-zip" value="${v('zipcode')}" maxlength="10" autocomplete="off"></label>
      <label>주소
        <input id="fwp-addr" value="${v('addr')}" autocomplete="off"></label>
      <label>담당자
        <input id="fwp-mgr" value="${v('mgrName')}" placeholder="상대 쪽 창구" autocomplete="off"></label>
      <label>담당자 연락처
        <input id="fwp-mgrtel" value="${v('mgrTel')}" autocomplete="off"></label>
      <label>담당자 이메일
        <input id="fwp-mgremail" value="${v('mgrEmail')}" autocomplete="off"></label>
      <label>결제조건
        <input id="fwp-pay" value="${v('payTerms')}" placeholder="예) 월말마감 익월말 현금" autocomplete="off"></label>
      <label>통화
        <select id="fwp-cur">${opts([['KRW', 'KRW 원'], ['USD', 'USD 달러'], ['JPY', 'JPY 엔'], ['EUR', 'EUR 유로'], ['CNY', 'CNY 위안']], p ? p.currency : 'KRW')}</select></label>
      <label>상태
        <select id="fwp-status">${opts(sts, p ? p.status : 'ACTIVE')}</select>
        <small>거래처는 지우지 않습니다 — 안 쓰면 <b>거래종료</b>로 바꿉니다. 과거 전표가 거래처를 잃지 않도록.</small></label>
      <label>비고
        <input id="fwp-note" value="${v('note')}" autocomplete="off"></label>`;
    $('fwp-kind').onchange = kindHint;
    kindHint();
  }

  // ── 역조회: 이 거래처와 연결된 품목 (인터페이스 §11.5 GET /partners/:code/items) ──
  function renderLinks() {
    const box = $('fwp-items'), p = S.sel;
    if (!p) { box.innerHTML = ''; return; }
    const rows = p.links || [];
    const buy = rows.filter((l) => l.role === 'BUY'), sell = rows.filter((l) => l.role === 'SELL');
    box.innerHTML = `
      <div class="fwi-bomhead"><b>연결된 품목</b><span>${esc(p.code)} 이(가) 대는 품목과 사 가는 품목 — 연결을 고치는 곳은 <b>품목 세부</b>입니다</span></div>
      ${rows.length ? `${table('이 거래처에서 사 오는 품목(매입)', buy)}${table('이 거래처에 파는 품목(매출)', sell)}`
        : `<p class="fwi-none">연결된 품목이 없습니다. <b>기준정보 › 품목 세부</b>에서 품번을 고른 뒤 이 거래처를 붙이세요.</p>`}`;
    box.querySelectorAll('[data-pn]').forEach((b) => { b.onclick = () => openItem(b.dataset.pn); });
  }

  function table(title, rows) {
    if (!rows.length) return '';
    return `<h4 class="fwd-h">${esc(title)} <span class="fwd-cnt">${rows.length}건</span></h4>
      <table class="fwi-bomtable fwd-links">
        <tr><th>품번</th><th>품명</th><th>거래처 품번</th><th class="r">단가</th><th class="r">리드타임</th><th class="r">최소발주</th><th>주거래</th><th></th></tr>
        ${rows.map((l) => `<tr>
          <td><b>${esc(l.pn)}</b></td>
          <td class="muted">${esc(l.itemName || '')}</td>
          <td class="mono">${esc(l.partnerPn || '')}</td>
          <td class="r">${l.price == null ? '' : esc(Number(l.price).toLocaleString('ko-KR') + ' ' + (l.currency || 'KRW'))}</td>
          <td class="r">${l.leadDays == null ? '' : esc(l.leadDays) + '일'}</td>
          <td class="r">${l.moq == null ? '' : esc(l.moq) + (l.orderUom ? ' ' + esc(l.orderUom) : '')}</td>
          <td class="c">${l.isPrimary ? '<span class="fwi-badge on">주거래</span>' : ''}</td>
          <td class="r"><button type="button" class="ghost sm" data-pn="${esc(l.pn)}">품목 세부 →</button></td>
        </tr>`).join('')}
      </table>`;
  }

  // 품목 세부 탭으로 넘긴다 — 탭 버튼을 눌러 모듈을 띄우고 그 품번을 열게 한다
  function openItem(pn) {
    const btn = document.querySelector('.nav button[data-tab="itemdetail"]');
    if (!btn) return;
    btn.click();
    if (window.FWItemDetail && typeof window.FWItemDetail.open === 'function') window.FWItemDetail.open(pn);
  }

  function kindHint() {
    const k = S.meta.kinds.find((x) => x.code === val('fwp-kind'));
    if ($('fwp-khint')) $('fwp-khint').textContent = k ? k.hint : '';
  }

  async function save() {
    if (S.busy) return;
    const name = val('fwp-name');
    if (!name) return msg('거래처명을 적어 주세요.', true);
    const body = {
      code: val('fwp-code') || null, name, kind: val('fwp-kind'), bizNo: val('fwp-bizno') || null,
      ceo: val('fwp-ceo') || null, bizType: val('fwp-biztype') || null, bizItem: val('fwp-bizitem') || null,
      tel: val('fwp-tel') || null, fax: val('fwp-fax') || null, email: val('fwp-email') || null,
      zipcode: val('fwp-zip') || null, addr: val('fwp-addr') || null,
      mgrName: val('fwp-mgr') || null, mgrTel: val('fwp-mgrtel') || null, mgrEmail: val('fwp-mgremail') || null,
      payTerms: val('fwp-pay') || null, currency: val('fwp-cur'), status: val('fwp-status'), note: val('fwp-note') || null,
    };
    S.busy = true; $('fwp-save').disabled = true;
    try {
      const renaming = S.sel && body.code && S.sel.code !== body.code;
      const r = renaming
        ? await api('/api/admin/partners/' + encodeURIComponent(S.sel.code), { method: 'PUT', body: JSON.stringify(body) })
        : await api('/api/admin/partners', { method: 'POST', body: JSON.stringify(body) });
      msg(r.created ? `거래처 ${r.partner.code} ${r.partner.name} 을 등록했습니다.` : `거래처 ${r.partner.code} 을 저장했습니다.`);
      S.meta = await api('/api/admin/partners/meta');
      renderChips();
      await select(r.partner.code, true);
    } catch (e) { msg(plain(e.message), true); }
    finally { S.busy = false; const b = $('fwp-save'); if (b) b.disabled = false; }
  }

  window.FWPartners = { mount };
})();
