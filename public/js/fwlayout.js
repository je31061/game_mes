/* 상세 패널 위치 토글 (스프린트 4) — window.FWLayout
 *
 * 목록 + 상세로 된 화면들이 공통으로 쓴다. 상세를 **목록 아래**에 둘지 **오른쪽**에 둘지 고르고, 고른 값은 브라우저에 남는다.
 * 화면마다 따로 만들면 곧 어긋나기 때문에 여기 하나만 둔다 — 쓰는 쪽은 버튼을 넣을 자리(slot)와 클래스를 붙일 대상(target)만 준다.
 *
 *   FWLayout.mount(slotEl, { key: 'items', target: splitEl, def: 'right', onChange })
 *     → target 에 `pos-below` 또는 `pos-right` 클래스를 붙인다. 실제 배치는 각 화면 CSS 가 그 클래스로 정한다.
 *     → 폭이 모자라면 CSS(@container)가 오른쪽 지정을 무시하고 아래로 내린다. JS 는 폭을 재지 않는다.
 *
 *   FWLayout.get(key, def) / FWLayout.set(key, pos)   저장값만 읽고 쓴다 (localStorage 'fw.layout.<key>')
 */
(function () {
  'use strict';

  const KEY = (k) => 'fw.layout.' + k;
  const POS = ['below', 'right'];
  const LABEL = { below: '아래', right: '오른쪽' };
  // 목록(가로줄)과 상세(오른쪽 칸)를 도형으로 보여 준다 — 글자만 있으면 어느 쪽이 켜졌는지 잘 안 보인다
  const ICON = {
    below: '<svg viewBox="0 0 16 12" width="16" height="12" aria-hidden="true"><rect x="1" y="1" width="14" height="5" rx="1"/><rect x="1" y="8" width="14" height="3" rx="1" class="d"/></svg>',
    right: '<svg viewBox="0 0 16 12" width="16" height="12" aria-hidden="true"><rect x="1" y="1" width="9" height="10" rx="1"/><rect x="11.5" y="1" width="3.5" height="10" rx="1" class="d"/></svg>',
  };

  function get(key, def) {
    try {
      const v = localStorage.getItem(KEY(key));
      return POS.includes(v) ? v : (def || 'below');
    } catch (e) { return def || 'below'; }
  }
  function set(key, pos) {
    try { localStorage.setItem(KEY(key), POS.includes(pos) ? pos : 'below'); } catch (e) { /* 시크릿 모드 등 — 저장만 못 할 뿐 동작은 한다 */ }
  }
  function apply(target, pos) {
    if (!target) return;
    target.classList.toggle('pos-right', pos === 'right');
    target.classList.toggle('pos-below', pos !== 'right');
  }

  // ── 두 단의 경계 ──────────────────────────────────────────────────────────
  // 기본은 정확히 반반(50%)이다. 경계를 끌면 비율이 바뀌고 그 값도 화면별로 남는다.
  // 두 번 누르면 다시 정확히 반반으로 돌아온다. 25~75% 밖으로는 못 간다 — 한쪽이 쓸 수 없게 좁아지는 것을 막는다.
  const SKEY = (k) => 'fw.split.' + k;
  const DEF_PCT = 50;
  function getPct(key) {
    const n = Number(localStorage.getItem(SKEY(key)));
    return Number.isFinite(n) && n >= 25 && n <= 75 ? n : DEF_PCT;
  }
  function setPct(target, key, pct) {
    const v = Math.min(75, Math.max(25, Math.round(pct * 10) / 10));
    target.style.setProperty('--fwsplit', v + '%');
    try { localStorage.setItem(SKEY(key), String(v)); } catch (e) { /* 저장만 못 한다 */ }
    const h = target.querySelector(':scope > .fwi-split-handle');
    if (h) h.setAttribute('aria-valuenow', String(Math.round(v)));
    return v;
  }
  // 경계 손잡이를 두 칸 사이에 끼워 넣는다 (화면 모듈은 손대지 않는다)
  function ensureHandle(target, key) {
    let h = target.querySelector(':scope > .fwi-split-handle');
    if (h) return h;
    h = document.createElement('div');
    h.className = 'fwi-split-handle';
    h.setAttribute('role', 'separator');
    h.setAttribute('aria-orientation', 'vertical');
    h.setAttribute('aria-label', '목록과 상세의 경계 — 끌어서 비율 조절, 두 번 누르면 반반');
    h.setAttribute('tabindex', '0');
    h.setAttribute('aria-valuemin', '25'); h.setAttribute('aria-valuemax', '75');
    h.innerHTML = '<span></span>';
    if (target.children.length > 1) target.insertBefore(h, target.children[1]);
    else target.appendChild(h);

    let dragging = false;
    const pctFrom = (clientX) => {
      const r = target.getBoundingClientRect();
      return r.width ? ((clientX - r.left) / r.width) * 100 : DEF_PCT;
    };
    const move = (ev) => { if (dragging) { ev.preventDefault(); setPct(target, key, pctFrom(ev.clientX)); } };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      target.classList.remove('dragging');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    h.addEventListener('mousedown', (ev) => {
      if (!target.classList.contains('pos-right')) return;   // 아래 배치일 때는 경계가 없다
      ev.preventDefault();
      dragging = true;
      target.classList.add('dragging');
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    h.addEventListener('dblclick', () => setPct(target, key, DEF_PCT));
    h.addEventListener('keydown', (ev) => {
      const cur = getPct(key);
      if (ev.key === 'ArrowLeft') { ev.preventDefault(); setPct(target, key, cur - 2); }
      else if (ev.key === 'ArrowRight') { ev.preventDefault(); setPct(target, key, cur + 2); }
      else if (ev.key === 'Home' || ev.key === 'Enter') { ev.preventDefault(); setPct(target, key, DEF_PCT); }
    });
    return h;
  }

  function mount(slot, opts) {
    const o = opts || {};
    if (!slot || !o.target) return null;
    let pos = get(o.key, o.def);
    apply(o.target, pos);
    ensureHandle(o.target, o.key);
    setPct(o.target, o.key, getPct(o.key));
    slot.classList.add('fwi-layout');
    slot.setAttribute('role', 'group');
    slot.setAttribute('aria-label', '상세 위치');
    const draw = () => {
      slot.innerHTML = `<span class="fwi-layout-t">상세</span>` + POS.map((p) =>
        `<button type="button" data-pos="${p}" class="${p === pos ? 'on' : ''}" title="상세를 목록 ${LABEL[p]}에 둔다" aria-pressed="${p === pos}">${ICON[p]}<i>${LABEL[p]}</i></button>`).join('');
      slot.querySelectorAll('button[data-pos]').forEach((b) => {
        b.onclick = () => {
          pos = b.dataset.pos;
          set(o.key, pos);
          apply(o.target, pos);
          draw();
          if (typeof o.onChange === 'function') o.onChange(pos);
        };
      });
    };
    draw();
    return { get: () => pos, set: (p) => { pos = p; set(o.key, p); apply(o.target, p); draw(); } };
  }

  window.FWLayout = { get, set, apply, mount, getPct, setPct };
})();
