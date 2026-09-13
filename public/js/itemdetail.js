/* 품목 세부 · 거래처 연결 (스프린트 4) — window.FWItemDetail = { mount(container, api) }
 *
 * 📦 품목 등록이 "품번을 만드는" 화면이라면, 여기는 만들어 둔 품번 하나를 골라 **살을 붙이는** 화면이다.
 *   ① 품목 요약(읽기)  ② 식별정보(도면번호·GTIN·참조단가·이미지)  ③ 거래처 연결(매입처·매출처)  ④ BOM 요약(읽기)
 * 한 품목에 공급사가 여럿인 것이 정상이라 거래처는 표(item_partner)로 붙이고 공급사마다 품번·단가·리드타임·최소발주량을 따로 둔다.
 * 스타일은 품목 등록과 같은 css/items.css 의 .fwi-* 를 쓴다.
 *
 * 쓰는 API (인터페이스 §11.5):
 *   GET  /api/admin/materials/items?q=          품목 고르기
 *   GET  /api/admin/materials/items/:pn         요약 + whereUsed
 *   PUT  /api/admin/materials/items/:pn         식별정보 저장
 *   GET  /api/admin/partners?status=ACTIVE      거래처 고르기
 *   GET/POST/PUT/DELETE /api/admin/item-partners[?pn=]   거래처 연결
 */
(function () {
  'use strict';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
  const money = (n, c) => (n === null || n === undefined ? '' : `${Number(n).toLocaleString('ko-KR')} ${c || 'KRW'}`);
  const plain = (m) => (/UNIQUE constraint failed: item_partner/.test(m) ? `이미 연결된 거래처입니다 — 같은 역할로는 한 번만 붙습니다. (${m})` : m);

  let api = null, root = null;
  const S = { pn: '', item: null, links: [], partners: [], items: [], pending: null, busy: false };

  function mount(container, apiFn) {
    api = apiFn; root = container;
    if (!root.dataset.fwdReady) { skeleton(); root.dataset.fwdReady = '1'; }
    reload().catch((e) => msg(plain(e.message), true));
  }

  // 다른 화면(거래처 역조회 등)이 "이 품번을 열어라" 하고 부른다.
  // 탭을 방금 누른 참이면 mount 가 아직 안 끝났을 수 있어 예약해 두고 reload 뒤에 연다.
  function openFrom(pn) {
    if (!pn) return;
    S.pending = String(pn);
    if (root && api) applyPending();
  }
  function applyPending() {
    const pn = S.pending; S.pending = null;
    if (pn) open(pn);
  }

  const $ = (id) => root.querySelector('#' + id);
  const val = (id) => ($(id) ? $(id).value.trim() : '');
  function msg(text, bad) {
    const el = $('fwd-msg'); if (!el) return;
    el.textContent = text || ''; el.className = 'fwi-msg' + (text ? (bad ? ' bad' : ' ok') : '');
  }

  function skeleton() {
    root.innerHTML = `
      <div class="fwi">
        <h2>품목 세부 <small>품번 하나를 골라 식별정보와 거래처를 붙인다 · 품번을 새로 만드는 곳은 📦 품목 등록</small></h2>
        <div class="fwi-bar">
          <input id="fwd-pn" list="fwd-pns" placeholder="품번으로 찾기 (예: BRG-6003)" autocomplete="off">
          <datalist id="fwd-pns"></datalist>
          <button id="fwd-open" type="button">불러오기</button>
          <span class="fwi-count" id="fwd-msg"></span>
        </div>
        <div id="fwd-body"></div>
      </div>`;
    $('fwd-open').onclick = () => open(val('fwd-pn'));
    $('fwd-pn').addEventListener('change', () => open(val('fwd-pn')));
    $('fwd-pn').addEventListener('keydown', (e) => { if (e.key === 'Enter') open(val('fwd-pn')); });
  }

  async function reload() {
    const [items, partners] = await Promise.all([
      api('/api/admin/materials/items'),
      api('/api/admin/partners?status=ACTIVE').catch(() => []),
    ]);
    S.items = items; S.partners = Array.isArray(partners) ? partners : [];
    $('fwd-pns').innerHTML = S.items.map((i) => `<option value="${esc(i.pn)}">${esc(i.nameKo || i.name)}</option>`).join('');
    if (S.pending) applyPending();
    else if (S.pn) await open(S.pn);
    else renderEmpty();
  }

  function renderEmpty() {
    $('fwd-body').innerHTML = `<p class="fwi-none">위에서 품번을 고르면 그 품목의 식별정보·거래처·BOM 을 여기서 다룹니다.
      등록된 품목은 ${S.items.length}건, 거래중인 거래처는 ${S.partners.length}곳입니다.</p>`;
  }

  async function open(pn) {
    if (!pn) return renderEmpty();
    try {
      const d = await api('/api/admin/materials/items/' + encodeURIComponent(pn));
      S.pn = d.item.pn; S.item = d.item; S.item.whereUsed = d.whereUsed || []; S.item.headers = d.headers || [];
      S.links = await api('/api/admin/item-partners?pn=' + encodeURIComponent(S.pn)).catch(() => []);
      $('fwd-pn').value = S.pn;
      render(); msg('');
    } catch (e) { msg(plain(e.message), true); }
  }

  function render() {
    const it = S.item;
    const buy = S.links.filter((l) => l.role === 'BUY'), sell = S.links.filter((l) => l.role === 'SELL');
    $('fwd-body').innerHTML = `
      <div class="fwi-main">
        <div class="fwi-head">
          <b>${esc(it.pn)}</b>
          <span class="fwi-sub">${esc(it.nameKo || it.name)} · ${esc(it.groupName || it.kind)} · ${esc(it.className || '')} · 기준단위 ${esc(it.uomSymbol || it.uom)} · ${esc(it.status)}</span>
        </div>

        <h4 class="fwd-h">식별정보</h4>
        <div class="fwi-grid">
          <label>도면번호<input id="fwd-drawing" value="${esc(it.drawingNo || '')}" autocomplete="off"></label>
          <label>GTIN(바코드)<input id="fwd-gtin" value="${esc(it.gtin || '')}" autocomplete="off">
            <small>GS1 외부 식별자입니다. 사내 품번과 별개로 둡니다.</small></label>
          <label>참조 단가<input id="fwd-cost" type="number" min="0" step="any" value="${it.stdCost ?? ''}">
            <small>원가 전개에는 쓰지 않습니다 — 참조값입니다. 실제 매입가는 아래 거래처별 단가입니다.</small></label>
          <label>이미지 파일<input id="fwd-image" value="${esc(it.image || '')}" placeholder="public/assets/parts/&lt;파일&gt;" autocomplete="off"></label>
        </div>
        <div class="fwi-foot"><button id="fwd-save" type="button">식별정보 저장</button></div>

        <h4 class="fwd-h">매입처 <span class="fwd-cnt">${buy.length}곳</span></h4>
        ${linkTable(buy, 'BUY')}
        <h4 class="fwd-h">매출처 <span class="fwd-cnt">${sell.length}곳</span></h4>
        ${linkTable(sell, 'SELL')}

        <div class="fwi-attach" id="fwd-add">
          <select id="fwd-role">${opt([['BUY', '매입처'], ['SELL', '매출처']], 'BUY')}</select>
          <input id="fwd-partner" list="fwd-partners" placeholder="거래처 코드/상호" autocomplete="off">
          <datalist id="fwd-partners">${S.partners.map((p) => `<option value="${esc(p.code)}">${esc(p.name)} (${esc(p.kindName)})</option>`).join('')}</datalist>
          <input id="fwd-ppn" placeholder="거래처 품번" autocomplete="off">
          <input id="fwd-price" type="number" min="0" step="any" placeholder="단가">
          <select id="fwd-cur">${opt([['KRW', 'KRW'], ['USD', 'USD'], ['JPY', 'JPY'], ['EUR', 'EUR'], ['CNY', 'CNY']], 'KRW')}</select>
          <input id="fwd-lead" type="number" min="0" step="1" placeholder="리드타임(일)">
          <input id="fwd-ouom" placeholder="발주단위" maxlength="16" list="fwd-ouoms">
          <datalist id="fwd-ouoms"><option value="BOX"><option value="CASE"><option value="ROLL"><option value="CAN"><option value="BAG"><option value="PLT"><option value="DRUM"></datalist>
          <input id="fwd-oqty" type="number" min="0" step="any" placeholder="입수량">
          <input id="fwd-moq" type="number" min="0" step="any" placeholder="최소발주">
          <label class="fwd-chk"><input id="fwd-primary" type="checkbox"> 주거래처</label>
          <button id="fwd-attach" type="button">연결</button>
        </div>
        <p class="fwi-hint">거래처의 <b>거래구분</b>과 역할이 맞아야 붙습니다 — 매출 전용 거래처를 매입처로 붙이려 하면 막습니다.
          주거래처는 품목·역할당 한 곳이고, 새로 지정하면 이전 주거래처는 자동으로 내려갑니다. 단가·리드타임은 발주 참고값이고 원가 전개에는 쓰지 않습니다.<br>
          <b>발주단위</b>는 이 거래처에 주문하는 단위입니다 — 비우면 품목의 기본 입고단위(${esc(it.inUom ? `${it.inUom} = ${it.inQty} ${it.uomSymbol || it.uom}` : `${it.uomSymbol || it.uom} 낱개`)})를 따르고, 표에 <b>*</b> 로 표시됩니다.
          <b>최소발주</b>는 발주단위 기준입니다 — 5 BOX 는 500 EA 로 환산해 함께 보여 줍니다. 재고·BOM 은 언제나 기준단위(${esc(it.uomSymbol || it.uom)})로만 돕니다.</p>

        <h4 class="fwd-h">BOM <span class="fwd-cnt">읽기 전용</span></h4>
        <p class="fwi-hint">${it.hasBomText || bomSummary(it)} 구조를 고치는 곳은 📦 품목 등록의 <b>BOM 연결</b>과 🧩 자재 탭입니다.</p>
      </div>`;
    $('fwd-save').onclick = saveIdent;
    $('fwd-attach').onclick = attach;
    root.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => detach(b.dataset.del); });
    root.querySelectorAll('[data-primary]').forEach((b) => { b.onclick = () => setPrimary(b.dataset.primary); });
  }

  const opt = (pairs, sel) => pairs.map(([v, t]) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(t)}</option>`).join('');

  function bomSummary(it) {
    const used = (it.whereUsed || []).filter((w) => w.status !== 'OBSOLETE');
    const own = (it.headers || []).filter((h) => h.status !== 'OBSOLETE');
    return `${used.length ? `상위 품목 ${used.map((w) => esc(w.parentPn)).join(' · ')} 에 들어갑니다.` : '아직 어느 BOM 에도 들어 있지 않습니다.'}`
      + ` 자체 BOM 은 ${own.length ? `${own.length}개(라인 ${own.reduce((a, h) => a + (h.lineCount || 0), 0)}건)` : '없습니다'}.`;
  }

  // 발주단위 표기: 저장값이 있으면 그대로, 없으면 품목의 기본 입고단위를 물려받았다는 뜻이라 회색 * 로 표시한다
  const orderCell = (l) => {
    const conv = l.effOrderQty > 1 ? ` <span class="muted">= ${esc(l.effOrderQty)} ${esc(l.baseUom)}</span>` : '';
    const mark = l.orderSource === 'partner' ? '' : `<span class="muted" title="${l.orderSource === 'item' ? '품목의 기본 입고단위를 따름' : '발주단위를 따로 정하지 않음(낱개)'}">*</span>`;
    return `${esc(l.effOrderUom)}${mark}${conv}`;
  };
  const moqCell = (l) => {
    if (l.moq == null) return '';
    const base = l.moqBase != null && l.effOrderQty > 1 ? ` <span class="muted">(${esc(l.moqBase)} ${esc(l.baseUom)})</span>` : '';
    return `${esc(l.moq)} ${esc(l.effOrderUom)}${base}`;
  };

  function linkTable(rows, role) {
    if (!rows.length) return `<p class="fwi-none">연결된 ${role === 'BUY' ? '매입처' : '매출처'}가 없습니다.</p>`;
    return `<table class="fwi-bomtable fwd-links">
      <tr><th>거래처</th><th>거래처 품번</th><th class="r">단가</th><th class="r">리드타임</th><th>발주단위</th><th class="r">최소발주</th><th>유효기간</th><th>주거래</th><th></th></tr>
      ${rows.map((l) => `<tr>
        <td><b>${esc(l.partnerCode)}</b> <span class="muted">${esc(l.partnerName)}</span>${l.partnerStatus !== 'ACTIVE' ? ` <span class="fwi-ph">${esc(l.partnerStatus === 'HOLD' ? '보류' : '종료')}</span>` : ''}</td>
        <td class="mono">${esc(l.partnerPn || '')}</td>
        <td class="r">${esc(money(l.price, l.currency))}${l.price != null ? ` <span class="muted">/ ${esc(l.priceUom || '')}</span>` : ''}</td>
        <td class="r">${l.leadDays != null ? esc(l.leadDays) + '일' : ''}</td>
        <td>${orderCell(l)}</td>
        <td class="r">${moqCell(l)}</td>
        <td class="muted">${esc(l.validFrom)} ~ ${esc(l.validTo === '9999-12-31' ? '' : l.validTo)}</td>
        <td class="c">${l.isPrimary ? '<span class="fwi-badge on">주거래</span>' : `<button type="button" class="ghost sm" data-primary="${l.id}">지정</button>`}</td>
        <td class="r"><button type="button" class="ghost sm" data-del="${l.id}">해제</button></td>
      </tr>`).join('')}
    </table>`;
  }

  async function saveIdent() {
    if (S.busy) return;
    S.busy = true; $('fwd-save').disabled = true;
    try {
      await api('/api/admin/materials/items/' + encodeURIComponent(S.pn), {
        method: 'PUT',
        body: JSON.stringify({ drawingNo: val('fwd-drawing') || null, gtin: val('fwd-gtin') || null, stdCost: val('fwd-cost') || null, image: val('fwd-image') || null }),
      });
      msg(`${S.pn} 식별정보를 저장했습니다.`);
      await open(S.pn); msg(`${S.pn} 식별정보를 저장했습니다.`);
    } catch (e) { msg(plain(e.message), true); }
    finally { S.busy = false; const b = $('fwd-save'); if (b) b.disabled = false; }
  }

  async function attach() {
    const partner = val('fwd-partner');
    if (!partner) return msg('거래처를 고르세요.', true);
    try {
      const r = await api('/api/admin/item-partners', {
        method: 'POST',
        body: JSON.stringify({
          pn: S.pn, partnerCode: partner, role: val('fwd-role'), partnerPn: val('fwd-ppn') || null,
          price: val('fwd-price') || null, currency: val('fwd-cur'), leadDays: val('fwd-lead') || null,
          orderUom: val('fwd-ouom') || null, orderQty: val('fwd-oqty') || null,
          moq: val('fwd-moq') || null, isPrimary: $('fwd-primary').checked,
        }),
      });
      msg(`${r.link.partnerCode} ${r.link.partnerName} 을 ${r.link.roleName}로 연결했습니다.${r.link.isPrimary ? ' 주거래처로 지정했습니다.' : ''}`);
      const keep = msgText();
      await open(S.pn); msg(keep);
    } catch (e) { msg(plain(e.message), true); }
  }
  const msgText = () => ($('fwd-msg') ? $('fwd-msg').textContent : '');

  async function setPrimary(id) {
    try {
      await api('/api/admin/item-partners/' + id, { method: 'PUT', body: JSON.stringify({ isPrimary: true }) });
      await open(S.pn); msg('주거래처를 바꿨습니다. 이전 주거래처는 내려갔습니다.');
    } catch (e) { msg(plain(e.message), true); }
  }

  async function detach(id) {
    const l = S.links.find((x) => String(x.id) === String(id));
    if (!confirm(`${l ? l.partnerCode + ' ' + l.partnerName : '이 거래처'} 연결을 해제합니다.\n거래처 자체는 남고 이 품목과의 연결만 지웁니다. 계속할까요?`)) return;
    try {
      await api('/api/admin/item-partners/' + id, { method: 'DELETE' });
      await open(S.pn); msg('연결을 해제했습니다.');
    } catch (e) { msg(plain(e.message), true); }
  }

  window.FWItemDetail = { mount, open: openFrom };
})();
