/* Factory World — 관리자 콘솔 */
(function () {
  const $ = (id) => document.getElementById(id);
  const STATUS_LABEL = { RUN: '가동', IDLE: '대기', STOP: '정지', ALARM: '알람' };
  // 설비 유형 (docs/team/인터페이스.md §1) — 서버 /api/admin/equipments 의 types 로 목록을 덮어쓴다
  const TYPE_LABEL = {
    press: '프레스', welder: '용접기', robot: '로봇', assembly: '조립 라인',
    inspector: '검사기', packer: '포장기', cnc: 'CNC 가공기',
    // 스프린트 2 (§9) BLDC 라인 — 스프라이트는 한도윤, 없으면 기본 큐브
    stacker: '자동 적층기', winder: '니들 와인더', vpi: '진공 함침조 (VPI)', oven: '열풍 건조로',
    magnetizer: '착자기', balancer: '밸런싱 머신', dispenser: '접착 디스펜서', smt: 'SMT · 자동 결선',
    generic: '미지정 (기본 큐브)',
  };
  let eqTypes = Object.keys(TYPE_LABEL);
  const typeOpts = (sel) => eqTypes.map(t =>
    `<option value="${t}"${t === (sel || 'generic') ? ' selected' : ''}>${esc(TYPE_LABEL[t] || t)}</option>`).join('');
  // 공정(BOP) select — 서버 /api/admin/equipments 의 processes [{productCode, op, seq, line, name}]
  let bopProcesses = [];
  const opOpts = (sel) => `<option value=""${!sel ? ' selected' : ''}>— 없음 —</option>` + bopProcesses.map(p =>
    `<option value="${esc(p.op)}"${p.op === sel ? ' selected' : ''}>${esc(p.op)} ${esc(p.name || '')}</option>`).join('')
    + (sel && !bopProcesses.some(p => p.op === sel) ? `<option value="${esc(sel)}" selected>${esc(sel)} (BOP에 없음)</option>` : '');
  let token = localStorage.getItem('fw.adminToken') || localStorage.getItem('fw.token');
  let zones = [];

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token, ...(opts.headers || {}) },
    });
    if (res.status === 401 || res.status === 403) {
      showGate(res.status === 403 ? '관리자 권한이 없는 계정입니다.' : '');
      throw new Error('auth');
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '요청 실패');
    return data;
  }

  // ── 인증 게이트 ────────────────────────
  function showGate(msg) {
    $('gate').classList.remove('hidden');
    $('console').classList.add('hidden');
    if (msg) $('g-error').textContent = '⚠ ' + msg;
  }
  function showConsole() {
    $('gate').classList.add('hidden');
    $('console').classList.remove('hidden');
    loadDashboard();
    loadGateway();
    loadBackup().catch(() => {});
    loadEquipments();
    loadUsers();
    loadPolicy().catch(() => {});
    searchLogs();
    loadEditor().then(() => loadWorkOrders()).catch(() => {});
  }

  $('g-login').onclick = async () => {
    try {
      const res = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ empNo: $('g-empno').value.trim(), name: $('g-name').value.trim(), password: $('g-pw').value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '로그인 실패');
      if (data.user.role !== 'admin') throw new Error('관리자 권한이 없는 계정입니다.');
      token = data.token;
      localStorage.setItem('fw.adminToken', token);
      showConsole();
    } catch (e) { $('g-error').textContent = '⚠ ' + e.message; }
  };

  // ── 탭 전환 ────────────────────────────
  document.querySelectorAll('.nav button').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('.nav button').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.tabview').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      $('tab-' + b.dataset.tab).classList.add('active');
      if (b.dataset.tab === 'dashboard') { loadDashboard(); loadGateway(); loadBackup().catch(() => {}); }
      if (b.dataset.tab === 'mapeditor') loadEditor();
      if (b.dataset.tab === 'alarms') loadAlarmReport().catch(() => {});
      if (b.dataset.tab === 'workorders') loadWorkOrders().catch(() => {});
      if (b.dataset.tab === 'analytics') mountAnalytics();
    };
  });

  // ── 실적 분석 탭 훅 (서지안, 인터페이스 §5): js/analytics.js 가 window.FWAnalytics.mount(container, api) 를 제공 ──
  function mountAnalytics() {
    const box = $('tab-analytics');
    if (window.FWAnalytics && typeof window.FWAnalytics.mount === 'function') {
      try { window.FWAnalytics.mount(box, api); }
      catch (e) { console.error('[analytics] mount 실패:', e); box.innerHTML = `<h2>실적 분석</h2><p class="muted">분석 화면을 불러오지 못했습니다: ${esc(e.message)}</p>`; }
      return;
    }
    box.innerHTML = `<h2>실적 분석 <small class="muted">OEE · 일별 생산실적 · 게이트웨이 연결 품질</small></h2>
      <p class="muted">분석 모듈(js/analytics.js)이 아직 배치되지 않았습니다. 라운드 2에서 추가됩니다.</p>`;
  }

  // ── 대시보드 ───────────────────────────
  async function loadDashboard() {
    const d = await api('/api/admin/overview');
    zones = d.zones;
    $('dash-time').textContent = new Date().toLocaleString('ko-KR');
    const a = d.alarmStats;
    $('kpi-cards').innerHTML = `
      <div class="card"><div class="k">금일 알람</div><div class="v">${a.count}<small>건${a.ongoing ? ` (진행중 ${a.ongoing})` : ''}</small></div></div>
      <div class="card"><div class="k">평균 알람 대응 시간</div><div class="v">${a.avgMinutes === null ? '-' : a.avgMinutes}<small>분</small></div></div>
      <div class="card"><div class="k">금일 대화</div><div class="v">${d.today.messages}<small>건</small></div></div>
      <div class="card"><div class="k">금일 파일</div><div class="v">${d.today.files}<small>건</small></div></div>
      <div class="card"><div class="k">현재 접속</div><div class="v">${d.online.length}<small>명 ${esc(d.online.map(o => o.name).join(', '))}</small></div></div>`;

    $('eq-share').innerHTML = d.equipments.map(eq => {
      const b = eq.breakdown;
      const total = b.RUN + b.IDLE + b.STOP + b.ALARM;
      const pct = (k) => total > 0 ? (b[k] / total * 100) : 0;
      const uptime = total > 0 ? Math.round(pct('RUN')) : null;
      const zone = zones.find(z => z.id === eq.zone_id);
      return `<tr>
        <td><b>${esc(eq.name)}</b> <span class="muted">${esc(eq.code)}${zone ? ' · ' + esc(zone.name) : ''}</span></td>
        <td><span class="chip ${eq.status}">${STATUS_LABEL[eq.status]}</span></td>
        <td><div class="sbar">${['RUN', 'IDLE', 'STOP', 'ALARM'].map(k =>
          `<div class="p-${k}" style="width:${pct(k)}%" title="${STATUS_LABEL[k]} ${Math.round(pct(k))}%"></div>`).join('')}</div></td>
        <td>${uptime === null ? '-' : uptime + '%'}</td>
        <td>${esc(eq.manager || '-')}</td>
      </tr>`;
    }).join('');
  }

  // ── 가상 PLC 게이트웨이 ─────────────────
  let gwRunning = false;

  async function loadGateway() {
    const d = await api('/api/admin/gateway');
    renderGateway(d);
  }

  function renderGateway(d) {
    gwRunning = d.running;
    $('gw-state').textContent = d.running ? '● 가동 중' : '중지됨';
    $('gw-state').style.color = d.running ? 'var(--run)' : 'var(--muted)';
    $('gw-toggle').textContent = d.running ? '■ 게이트웨이 중지' : '▶ 게이트웨이 시작';
    $('gw-rows').innerHTML = d.equipments.length ? d.equipments.map(e => `<tr>
      <td><b>${esc(e.name)}</b> <span class="muted">${esc(e.code)}</span></td>
      <td>${esc(e.protocol.toUpperCase())}</td>
      <td>${e.mode === 'live'
        ? `<span class="chip ${e.connected ? 'RUN' : 'STOP'}">LIVE${d.running ? (e.connected ? '' : ' 연결 중…') : ''}</span>`
        : e.mode === 'unknown'
          ? '<span class="chip" style="background:var(--panel2);color:var(--muted)" title="게이트웨이를 시작하면 드라이버 설치 여부에 따라 LIVE/SIM으로 판정됩니다">시작 시 판정</span>'
          : `<span class="chip IDLE" title="${e.driverMissing ? '드라이버 라이브러리 미설치 — README의 OPC-UA/Modbus 활성화 참조' : '시뮬레이션'}">SIM${e.driverMissing ? ' · 드라이버 미설치' : ''}</span>`}</td>
      <td class="muted" style="font-size:11px">${esc(e.tag || '-')}</td>
      <td>${e.intervalMs}ms</td>
      <td>${e.value === null ? '-' : e.value + '°'}</td>
      <td><span class="chip ${e.status}">${STATUS_LABEL[e.status]}</span></td>
    </tr>`).join('') : '<tr><td colspan="7" class="muted">연동 설정된 설비가 없습니다. 맵 에디터에서 설비에 프로토콜을 지정하세요.</td></tr>';
  }

  $('gw-toggle').onclick = async () => {
    const d = await api('/api/admin/gateway/' + (gwRunning ? 'stop' : 'start'), { method: 'POST' });
    renderGateway(d);
    if (d.running) loadDashboard();
  };

  // ── 백업 (NFR-04) ───────────────────────
  async function loadBackup() {
    const d = await api('/api/admin/backup');
    const last = d.last
      ? (d.last.ok ? `마지막 백업 ${d.last.at} (${d.last.trigger === 'auto' ? '자동' : '수동'}) · 파일 ${d.last.uploads}개`
                   : `마지막 백업 실패 ${d.last.at}: ${d.last.error}`)
      : '아직 백업 기록이 없습니다';
    $('bk-info').textContent = `${last} · 매일 ${String(d.hour).padStart(2, '0')}:00 자동 · 보관 ${d.backups.length}개 · ${d.root}`;
    $('bk-info').style.color = d.last && !d.last.ok ? 'var(--stop)' : '';
  }
  $('bk-run').onclick = async () => {
    $('bk-run').disabled = true; $('bk-run').textContent = '백업 중…';
    try {
      await api('/api/admin/backup', { method: 'POST' });
      await loadBackup();
    } catch (e) { if (e.message !== 'auth') alert(e.message); }
    $('bk-run').disabled = false; $('bk-run').textContent = '💾 지금 백업';
  };

  // 대시보드가 열려 있는 동안 자동 갱신 (3초)
  setInterval(() => {
    const dashActive = document.querySelector('#tab-dashboard')?.classList.contains('active');
    const consoleVisible = !$('console').classList.contains('hidden');
    if (dashActive && consoleVisible) {
      loadGateway().catch(() => {});
      if (gwRunning) loadDashboard().catch(() => {});
    }
  }, 3000);

  // ── 대화 로그 ──────────────────────────
  async function searchLogs() {
    const p = new URLSearchParams();
    if ($('f-eq').value) p.set('equipmentId', $('f-eq').value);
    if ($('f-q').value.trim()) p.set('q', $('f-q').value.trim());
    if ($('f-from').value) p.set('from', $('f-from').value);
    if ($('f-to').value) p.set('to', $('f-to').value);
    const rows = await api('/api/admin/messages?' + p.toString());
    $('log-rows').innerHTML = rows.length ? rows.map(m => {
      let content = m.content;
      if (m.type === 'file') {
        try { const f = JSON.parse(m.content); content = `📎 ${f.name}`; } catch {}
      }
      return `<tr>
        <td class="muted">${m.created_at.slice(0, 16)}</td>
        <td>${m.equipment_name ? esc(m.equipment_name) : '📢 전체'}</td>
        <td>${esc(m.sender_name)}</td>
        <td class="muted">${m.type}</td>
        <td class="msg-content">${esc(content)}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="5" class="muted">검색 결과가 없습니다.</td></tr>';
  }
  $('f-search').onclick = searchLogs;
  $('f-q').addEventListener('keydown', e => { if (e.key === 'Enter') searchLogs(); });

  // ── 알람 대응 리포트 ────────────────────
  function fmtDur(sec) {
    if (sec === null || sec === undefined) return '-';
    if (sec < 60) return `${sec}초`;
    if (sec < 3600) return `${Math.floor(sec / 60)}분 ${sec % 60}초`;
    return `${Math.floor(sec / 3600)}시간 ${Math.floor((sec % 3600) / 60)}분`;
  }

  async function loadAlarmReport() {
    const p = new URLSearchParams();
    if ($('al-eq').value) p.set('equipmentId', $('al-eq').value);
    if ($('al-from').value) p.set('from', $('al-from').value);
    if ($('al-to').value) p.set('to', $('al-to').value);
    const d = await api('/api/admin/alarm-report?' + p.toString());
    const s = d.summary;
    $('al-cards').innerHTML = `
      <div class="card"><div class="k">알람 건수</div><div class="v">${s.count}<small>건${s.ongoing ? ` (진행중 ${s.ongoing})` : ''}</small></div></div>
      <div class="card"><div class="k">평균 대응 시간</div><div class="v">${s.avgSec === null ? '-' : fmtDur(s.avgSec)}</div></div>
      <div class="card"><div class="k">최장 대응 시간</div><div class="v">${s.maxSec === null ? '-' : fmtDur(s.maxSec)}</div></div>
      <div class="card"><div class="k">협업 발생 알람</div><div class="v">${s.withCollab}<small>건 (대화/파일 발생)</small></div></div>`;
    $('al-rows').innerHTML = d.episodes.length ? d.episodes.map(e => `<tr>
      <td><b>${esc(e.equipment)}</b> <span class="muted">${esc(e.code)}</span></td>
      <td class="muted">${e.start.slice(5, 16)}</td>
      <td class="muted">${e.ongoing ? '<span class="chip ALARM">진행중</span>' : e.end.slice(5, 16)}</td>
      <td><b>${fmtDur(e.durationSec)}</b></td>
      <td>${esc(e.resolvedBy || '-')}</td>
      <td>${e.messages}</td>
      <td>${e.participants}</td>
      <td>${e.files}</td>
    </tr>`).join('') : '<tr><td colspan="8" class="muted">기간 내 알람이 없습니다.</td></tr>';
    // 설비 필터 옵션 (설비 목록 재사용)
    if ($('al-eq').options.length <= 1 && edEquipments.length) {
      $('al-eq').innerHTML = '<option value="">전체 설비</option>' +
        edEquipments.map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
    }
  }
  $('al-search').onclick = () => loadAlarmReport().catch(e => { if (e.message !== 'auth') alert(e.message); });

  // ── 작업지시 관리 ───────────────────────
  const WO_STATUS = { OPEN: '모집 중', IN_PROGRESS: '진행 중', DONE: '완료', CANCELED: '취소' };

  async function loadWorkOrders() {
    const rows = await api('/api/admin/workorders');
    if ($('wo-eq').options.length === 0 && edEquipments.length) {
      $('wo-eq').innerHTML = edEquipments.map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
    }
    $('wo-rows').innerHTML = rows.length ? rows.map(w => `<tr>
      <td class="muted">${w.id}</td>
      <td>${esc(w.equipmentName)}</td>
      <td><b>${esc(w.title)}</b>${w.description ? `<div class="muted" style="font-size:11px">${esc(w.description)}</div>` : ''}</td>
      <td>${w.targetQty}</td>
      <td class="muted">${w.dueDate || '-'}</td>
      <td><span class="chip ${w.status === 'DONE' ? 'RUN' : w.status === 'IN_PROGRESS' ? 'IDLE' : w.status === 'CANCELED' ? 'STOP' : 'ALARM'}" style="${w.status === 'OPEN' ? 'background:rgba(79,195,247,.15);color:var(--accent)' : ''}">${WO_STATUS[w.status]}</span></td>
      <td>${esc(w.assigneeName || '-')}</td>
      <td>${w.qtyGood !== null && w.qtyGood !== undefined ? `${w.qtyGood} / ${w.qtyDefect}` : '-'}</td>
      <td class="muted" style="font-size:11px">${(w.createdAt || '').slice(5, 16)}<br>${esc(w.createdByName || '')}</td>
      <td>${['OPEN', 'IN_PROGRESS'].includes(w.status) ? `<button class="wo-cancel" data-id="${w.id}" style="border-color:var(--stop);color:var(--stop);background:rgba(248,113,113,.1)">취소</button>` : ''}</td>
    </tr>`).join('') : '<tr><td colspan="10" class="muted">작업지시가 없습니다.</td></tr>';

    $('wo-rows').querySelectorAll('.wo-cancel').forEach(b => {
      b.onclick = async () => {
        if (!confirm('이 작업지시를 취소할까요?')) return;
        try {
          await api(`/api/admin/workorders/${b.dataset.id}/cancel`, { method: 'PUT' });
          loadWorkOrders();
        } catch (e) { if (e.message !== 'auth') alert(e.message); }
      };
    });
  }

  $('wo-add').onclick = async () => {
    try {
      await api('/api/admin/workorders', {
        method: 'POST',
        body: JSON.stringify({
          equipmentId: Number($('wo-eq').value),
          title: $('wo-title').value.trim(),
          description: $('wo-desc').value.trim(),
          targetQty: Number($('wo-qty').value) || 0,
          dueDate: $('wo-due').value || null,
        }),
      });
      $('wo-title').value = ''; $('wo-desc').value = ''; $('wo-qty').value = '';
      loadWorkOrders();
    } catch (e) { if (e.message !== 'auth') alert(e.message); }
  };

  // ── 설비 관리 ──────────────────────────
  // 설비 마스터: 서버는 숨긴 설비(hidden=1)도 준다 — 숨김 행은 흐리게 + "숨김" 표시 + [복원], 보이는 행은 [저장]·[숨김]
  async function loadEquipments() {
    const d = await api('/api/admin/equipments');
    zones = d.zones;
    if (Array.isArray(d.types) && d.types.length) eqTypes = d.types;
    if (Array.isArray(d.processes)) bopProcesses = d.processes;
    const allZones = [...zones, ...(d.hiddenZones || [])];
    const zoneOpts = (sel) => allZones.map(z =>
      `<option value="${z.id}"${z.id === sel ? ' selected' : ''}>${esc(z.name)}${z.hidden ? ' (숨김)' : ''}</option>`).join('');
    $('f-eq').innerHTML = '<option value="">전체 설비</option>' +
      d.equipments.map(e => `<option value="${e.id}">${esc(e.name)}${e.hidden ? ' (숨김)' : ''}</option>`).join('');
    $('n-zone').innerHTML = zoneOpts(zones[0]?.id);
    if (!$('n-type').options.length) $('n-type').innerHTML = typeOpts('generic');
    $('n-op').innerHTML = opOpts($('n-op').value || '');
    $('eq-rows').innerHTML = d.equipments.map(eq => eq.hidden ? `<tr data-id="${eq.id}" style="opacity:.55">
      <td><b>${esc(eq.code)}</b></td>
      <td>${esc(eq.name)} <span class="chip" style="background:var(--panel2);color:var(--muted)" title="라인 전환으로 숨김 — 맵·분석·게이트웨이에서 제외, 이력은 보존">숨김</span></td>
      <td class="muted">${esc(TYPE_LABEL[eq.type] || eq.type || '')}</td>
      <td class="muted">${esc(eq.op || '-')}</td>
      <td class="muted">${esc(allZones.find(z => z.id === eq.zone_id)?.name || '-')}</td>
      <td class="muted">${eq.x}</td><td class="muted">${eq.y}</td>
      <td class="muted">${esc(eq.manager || '')}</td>
      <td><button class="e-restore" title="맵·분석 대상으로 되돌립니다 (속한 존도 함께 복원)">복원</button></td>
    </tr>` : `<tr data-id="${eq.id}">
      <td><input class="e-code" value="${esc(eq.code)}"></td>
      <td><input class="e-name" value="${esc(eq.name)}"></td>
      <td><select class="e-type">${typeOpts(eq.type)}</select></td>
      <td><select class="e-op">${opOpts(eq.op || '')}</select></td>
      <td><select class="e-zone">${zoneOpts(eq.zone_id)}</select></td>
      <td><input class="e-x narrow" type="number" value="${eq.x}"></td>
      <td><input class="e-y narrow" type="number" value="${eq.y}"></td>
      <td><input class="e-manager" value="${esc(eq.manager || '')}"></td>
      <td style="white-space:nowrap"><button class="e-save">저장</button>
        <button class="e-hide" style="border-color:var(--border);color:var(--muted);background:none" title="삭제 대신 숨김 — 이력을 보존한 채 맵·분석에서 제외">숨김</button></td>
    </tr>`).join('');

    $('eq-rows').querySelectorAll('.e-save').forEach(btn => {
      btn.onclick = async () => {
        const tr = btn.closest('tr');
        try {
          await api('/api/admin/equipments/' + tr.dataset.id, {
            method: 'PUT',
            body: JSON.stringify({
              code: tr.querySelector('.e-code').value.trim(),
              name: tr.querySelector('.e-name').value.trim(),
              type: tr.querySelector('.e-type').value,
              op: tr.querySelector('.e-op').value || null,
              zoneId: Number(tr.querySelector('.e-zone').value),
              x: Number(tr.querySelector('.e-x').value),
              y: Number(tr.querySelector('.e-y').value),
              manager: tr.querySelector('.e-manager').value.trim(),
            }),
          });
          btn.textContent = '저장됨 ✓';
          setTimeout(() => btn.textContent = '저장', 1500);
        } catch (e) { alert(e.message); }
      };
    });
    const setHidden = async (tr, hidden) => {
      try {
        await api('/api/admin/equipments/' + tr.dataset.id, { method: 'PUT', body: JSON.stringify({ hidden }) });
        await loadEquipments(); loadEditor().catch(() => {});
      } catch (e) { if (e.message !== 'auth') alert(e.message); }
    };
    $('eq-rows').querySelectorAll('.e-hide').forEach(btn => {
      btn.onclick = () => { const tr = btn.closest('tr'); if (confirm(`${tr.querySelector('.e-code').value} 설비를 숨길까요? (이력은 보존되며 [복원]으로 되돌릴 수 있습니다)`)) setHidden(tr, true); };
    });
    $('eq-rows').querySelectorAll('.e-restore').forEach(btn => { btn.onclick = () => setHidden(btn.closest('tr'), false); });
  }

  $('n-add').onclick = async () => {
    try {
      await api('/api/admin/equipments', {
        method: 'POST',
        body: JSON.stringify({
          code: $('n-code').value.trim(),
          name: $('n-name').value.trim(),
          type: $('n-type').value,
          op: $('n-op').value || null,
          zoneId: Number($('n-zone').value),
          x: Number($('n-x').value),
          y: Number($('n-y').value),
          manager: $('n-manager').value.trim(),
        }),
      });
      $('n-code').value = ''; $('n-name').value = ''; $('n-manager').value = ''; $('n-type').value = 'generic'; $('n-op').value = '';
      loadEquipments();
    } catch (e) { alert(e.message); }
  };

  // ── 사용자 관리 ────────────────────────
  async function loadUsers() {
    const users = await api('/api/admin/users');
    $('user-rows').innerHTML = users.map(u => `<tr data-id="${u.id}">
      <td class="muted">${u.id}</td>
      <td>${esc(u.emp_no)}</td>
      <td>${esc(u.name)}</td>
      <td>${u.role === 'system' ? '<span class="muted">시스템</span>' : `<select class="u-role">
        <option value="worker"${u.role === 'worker' ? ' selected' : ''}>작업자</option>
        <option value="maintainer"${u.role === 'maintainer' ? ' selected' : ''}>보전</option>
        <option value="admin"${u.role === 'admin' ? ' selected' : ''}>관리자</option>
      </select>`}</td>
      <td>${u.role === 'system' ? '' : `<input class="u-team" value="${esc(u.team || '')}" placeholder="팀명" style="width:90px">`}</td>
      <td class="muted">${u.created_at.slice(0, 10)}</td>
      <td class="muted" style="font-size:11px">${u.role === 'system' ? '' : (u.has_password ? '설정됨' : '<span style="color:var(--idle)">미설정 (첫 로그인 대기)</span>')}</td>
      <td>${u.role === 'system' ? '' : `<button class="u-save">저장</button>
        <button class="u-reset" style="border-color:var(--stop);color:var(--stop);background:rgba(248,113,113,.1)" title="비밀번호 초기화 — 다음 로그인 시 재설정">비번 초기화</button>`}</td>
    </tr>`).join('');

    $('user-rows').querySelectorAll('.u-save').forEach(btn => {
      btn.onclick = async () => {
        const tr = btn.closest('tr');
        try {
          await api(`/api/admin/users/${tr.dataset.id}/team`, {
            method: 'PUT',
            body: JSON.stringify({ team: tr.querySelector('.u-team').value.trim() }),
          });
          // 자신의 역할 변경은 서버가 거부하므로 실패해도 팀 저장은 유지
          try {
            await api(`/api/admin/users/${tr.dataset.id}/role`, {
              method: 'PUT',
              body: JSON.stringify({ role: tr.querySelector('.u-role').value }),
            });
          } catch (e) { if (!String(e.message).includes('자신의 역할')) throw e; }
          btn.textContent = '저장됨 ✓';
          setTimeout(() => btn.textContent = '저장', 1500);
        } catch (e) { if (e.message !== 'auth') alert(e.message); }
      };
    });
    $('user-rows').querySelectorAll('.u-reset').forEach(btn => {
      btn.onclick = async () => {
        const tr = btn.closest('tr');
        if (!confirm('이 사용자의 비밀번호를 초기화할까요? 다음 로그인 시 입력하는 비밀번호로 재설정됩니다.')) return;
        try {
          await api(`/api/admin/users/${tr.dataset.id}/reset-password`, { method: 'POST' });
          btn.textContent = '초기화됨 ✓';
          setTimeout(() => btn.textContent = '비번 초기화', 2000);
        } catch (e) { if (e.message !== 'auth') alert(e.message); }
      };
    });
  }

  // ── 사용자 사전 등록 · 운영 정책 ────────
  $('nu-add').onclick = async () => {
    try {
      await api('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          empNo: $('nu-empno').value.trim(), name: $('nu-name').value.trim(),
          role: $('nu-role').value, team: $('nu-team').value.trim(),
        }),
      });
      $('nu-empno').value = ''; $('nu-name').value = ''; $('nu-team').value = '';
      loadUsers();
    } catch (e) { if (e.message !== 'auth') alert(e.message); }
  };

  function renderPolicy(p) {
    $('pol-self').checked = !!p.allowSelfRegister;
    $('pol-retention').value = p.retentionDays ?? 0;
    $('pol-shift').value = p.shiftMinutesPerDay ?? '';   // null = 미설정(24h)
    $('pol-info').textContent = p.lastPurge
      ? `마지막 정리 ${p.lastPurge.at} — 메시지 ${p.lastPurge.removedMessages}건 · 파일 ${p.lastPurge.removedFiles}건 (${p.lastPurge.retentionDays}일 기준)`
      : '아직 정리 실행 기록이 없습니다';
  }
  async function loadPolicy() { renderPolicy(await api('/api/admin/policy')); }
  $('pol-save').onclick = async () => {
    const shiftRaw = $('pol-shift').value.trim();
    if (shiftRaw !== '' && !(Number.isInteger(Number(shiftRaw)) && Number(shiftRaw) >= 1 && Number(shiftRaw) <= 1440)) {
      return alert('1일 계획 가동 시간은 1~1440 사이의 정수(분)여야 합니다. 24시간 기준으로 두려면 비워 두세요.');
    }
    try {
      renderPolicy(await api('/api/admin/policy', {
        method: 'PUT',
        body: JSON.stringify({
          allowSelfRegister: $('pol-self').checked,
          retentionDays: Number($('pol-retention').value) || 0,
          shiftMinutesPerDay: shiftRaw === '' ? null : Number(shiftRaw),
        }),
      }));
      $('pol-save').textContent = '저장됨 ✓'; setTimeout(() => $('pol-save').textContent = '정책 저장', 1500);
    } catch (e) { if (e.message !== 'auth') alert(e.message); }
  };
  $('pol-purge').onclick = async () => {
    const days = Number($('pol-retention').value) || 0;
    if (!days) return alert('보존 기간이 0(무기한)입니다. 먼저 일수를 입력하고 저장하세요.');
    if (!confirm(`${days}일이 지난 대화와 파일을 삭제합니다. 오늘 백업이 있어야 실행됩니다. 계속할까요?`)) return;
    try {
      const r = await api('/api/admin/policy/purge', { method: 'POST' });
      if (r.skipped) alert(r.reason); else await loadPolicy();
    } catch (e) { if (e.message !== 'auth') alert(e.message); }
  };

  // ── 테마 전환 (다크 / 흰 바탕) ─────────
  $('btn-theme').onclick = (e) => {
    e.preventDefault();
    const light = document.documentElement.dataset.theme !== 'light';
    localStorage.setItem('fw.theme', light ? 'light' : 'dark');
    location.reload();
  };
  const cssVar = (n, def) => (getComputedStyle(document.documentElement).getPropertyValue(n) || '').trim() || def;

  // ── 맵 에디터 ──────────────────────────
  const CELL = 30, GW = 24, GH = 16;
  let edZones = [], edEquipments = [], edLinks = [];
  let edPlan = null, edPlanImg = null;   // 공장 평면도 설정·이미지
  let edSelEq = null;          // 선택된 설비
  let edDrawZone = null;       // 영역 그리기 중인 존 id
  let edDrag = null;           // {eq, gx, gy}
  let edRect = null;           // 그리기 중 rect {x0,y0,x1,y1}
  let edLinkMode = false;      // 라인 연결 모드
  let edLinkFrom = null;       // 연결 시작 설비
  const canvas = () => $('map-canvas');

  let edHiddenZones = [];
  async function loadEditor() {
    const d = await api('/api/admin/equipments');
    edZones = d.zones || [];
    edHiddenZones = d.hiddenZones || [];
    edEquipments = (d.equipments || []).filter(e => !e.hidden);   // 숨긴 설비는 에디터 맵에 그리지 않음 (설비 관리 탭에서 복원)
    if (Array.isArray(d.processes)) bopProcesses = d.processes;
    edLinks = await api('/api/admin/links').catch(() => []);
    await loadFloorplan();
    renderZoneList();
    renderLinkList();
    renderMap();
    loadBopInfo().catch(() => {});
  }

  // ── 제품 라인 (BOP·BOM·분해도, 스프린트 2) ──
  async function loadBopInfo() {
    const d = await api('/api/admin/bop');
    if (!d.product) { $('bop-info').textContent = '가져온 제품 공정(BOP)이 없습니다. [제품 라인 적용]을 누르거나 BOP JSON을 가져오세요.'; return; }
    const s = d.summary;
    $('bop-info').innerHTML = `<b>${esc(d.product.name)}</b> (${esc(d.product.code)}) — 공정 ${s.processes} · 단품 ${s.parts} · 투입 ${s.inputs} · 설비 연결 ${s.linked}/${s.processes}`
      + (s.unlinked.length ? ` · <span style="color:var(--idle)">설비 없는 공정: ${s.unlinked.map(esc).join(', ')}</span>` : ' · 전 공정 연결됨')
      + (d.product.importedAt ? ` <span class="muted">(가져옴 ${esc(d.product.importedAt)})</span>` : '');
  }
  $('lay-apply-sample').onclick = async () => {
    if (!confirm('BLDC 500W 제품 라인을 적용합니다.\n1) docs/bldc/bldc-500w-48v.json → 공정·단품 가져오기\n2) docs/bldc/layout-bldc-500w.json → 존 2·설비 24·라인 23 배치 (replace: 파일에 없는 기존 설비·존은 숨김)\n\n기존 설비의 이력은 지워지지 않으며 설비 관리에서 복원할 수 있습니다. 계속할까요?')) return;
    $('lay-apply-sample').disabled = true;
    try {
      const r = await api('/api/admin/bop/apply-sample', { method: 'POST' });
      const b = r.bop, l = r.layout;
      $('lay-info').textContent = `제품 라인 적용 완료 — BOP: 공정 ${b.processes}·단품 ${b.parts}·투입 ${b.inputs} / 배치: 존 +${l.zones.created}/수정 ${l.zones.updated}/숨김 ${l.zones.hidden} · 설비 +${l.equipments.created}/수정 ${l.equipments.updated}/숨김 ${l.equipments.hidden}/복원 ${l.equipments.restored} · 라인 +${l.links.created}`
        + (l.warnings.length ? ` · 경고 ${l.warnings.length}건: ${l.warnings.slice(0, 3).join(' / ')}` : '');
      await loadEditor(); loadEquipments();
    } catch (e) { if (e.message !== 'auth') alert(e.message); }
    $('lay-apply-sample').disabled = false;
  };
  $('bop-import').addEventListener('change', async () => {
    const f = $('bop-import').files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const r = await api('/api/admin/bop/import', { method: 'POST', body: JSON.stringify(data) });
      $('lay-info').textContent = `BOP 가져오기 완료 — ${r.product}: 공정 ${r.processes} · 서브어셈블리 ${r.subassemblies} · 단품 ${r.parts} · 투입 ${r.inputs} · 분해도 ${r.stages}단계`
        + (r.warnings.length ? ` · 경고 ${r.warnings.length}건: ${r.warnings.slice(0, 3).join(' / ')}` : '');
      await loadEditor(); loadEquipments();
    } catch (e) { if (e.message !== 'auth') alert('BOP 가져오기 실패: ' + e.message); }
    $('bop-import').value = '';
  });

  // ── 공장 평면도 (배경 옵션) ───────────
  async function loadFloorplan() {
    edPlan = await api('/api/admin/floorplan').catch(() => null);
    edPlanImg = null;
    if (edPlan?.file) {
      const img = new Image();
      img.onload = () => { edPlanImg = img; renderMap(); };
      img.src = `/api/floorplan/image?f=${encodeURIComponent(edPlan.file)}&token=${encodeURIComponent(token)}&t=${Date.now()}`;
      $('fp-opacity').value = edPlan.opacity;
      $('fp-show').checked = !!edPlan.showInGame;
      $('fp-x').value = edPlan.rect.x; $('fp-y').value = edPlan.rect.y; $('fp-w').value = edPlan.rect.w; $('fp-h').value = edPlan.rect.h;
      $('fp-info').textContent = `${edPlan.name} · ${edPlan.uploadedAt || ''}`;
    } else {
      $('fp-info').textContent = '평면도 없음 — PNG/JPG/WEBP/SVG를 올리면 배경으로 깔립니다';
    }
  }
  async function saveFloorplan(patch) {
    try {
      edPlan = await api('/api/admin/floorplan', { method: 'PUT', body: JSON.stringify(patch) });
      renderMap();
    } catch (e) { if (e.message !== 'auth') alert(e.message); }
  }
  $('fp-file').addEventListener('change', async () => {
    const f = $('fp-file').files[0];
    if (!f) return;
    if (f.size > 15 * 1024 * 1024) return alert('15MB 이하만 업로드할 수 있습니다.');
    try {
      const res = await fetch(`/api/admin/floorplan?name=${encodeURIComponent(f.name)}`, {
        method: 'POST', headers: { 'X-Auth-Token': token }, body: f,
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || '업로드 실패');
      $('ed-hint').textContent = '평면도가 업로드되었습니다. 투명도·범위를 조정하고 존/설비를 도면 위에 배치하세요.';
      await loadFloorplan(); renderMap();
    } catch (e) { alert(e.message); }
    $('fp-file').value = '';
  });
  let fpOpTimer = null;
  $('fp-opacity').addEventListener('input', () => {
    if (!edPlan) return;
    edPlan.opacity = Number($('fp-opacity').value); renderMap();
    clearTimeout(fpOpTimer);
    fpOpTimer = setTimeout(() => saveFloorplan({ opacity: edPlan.opacity }), 400);
  });
  $('fp-show').addEventListener('change', () => edPlan && saveFloorplan({ showInGame: $('fp-show').checked }));
  $('fp-apply').onclick = () => edPlan && saveFloorplan({ rect: {
    x: Number($('fp-x').value), y: Number($('fp-y').value), w: Number($('fp-w').value), h: Number($('fp-h').value),
  } });
  $('fp-delete').onclick = async () => {
    if (!edPlan?.file || !confirm('평면도를 제거할까요? (존·설비 배치는 유지됩니다)')) return;
    try { await api('/api/admin/floorplan', { method: 'DELETE' }); await loadFloorplan(); renderMap(); }
    catch (e) { if (e.message !== 'auth') alert(e.message); }
  };

  // ── 배치 데이터 JSON 내보내기/가져오기 ──
  $('lay-export').onclick = async () => {
    try {
      const d = await api('/api/admin/layout');
      const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'factory-world-layout.json'; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) { if (e.message !== 'auth') alert(e.message); }
  };
  $('lay-import').addEventListener('change', async () => {
    const f = $('lay-import').files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const r = await api('/api/admin/layout', { method: 'POST', body: JSON.stringify(data) });
      $('lay-info').textContent = `가져오기 완료 — 존 +${r.zones.created}/수정 ${r.zones.updated}${r.zones.hidden ? `/숨김 ${r.zones.hidden}` : ''} · 설비 +${r.equipments.created}/수정 ${r.equipments.updated}${r.equipments.hidden ? `/숨김 ${r.equipments.hidden}` : ''}${r.equipments.restored ? `/복원 ${r.equipments.restored}` : ''} · 라인 +${r.links.created}`
        + (r.warnings.length ? ` · 경고 ${r.warnings.length}건: ${r.warnings.slice(0, 3).join(' / ')}` : '');
      await loadEditor(); loadEquipments();
    } catch (e) { if (e.message !== 'auth') alert('가져오기 실패: ' + e.message); }
    $('lay-import').value = '';
  });

  function renderMap() {
    const cv = canvas(), ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    // 평면도 배경 (옵션)
    if (edPlan?.file && edPlanImg) {
      const r = edPlan.rect || { x: 0, y: 0, w: GW, h: GH };
      ctx.save(); ctx.globalAlpha = edPlan.opacity ?? 0.6;
      ctx.drawImage(edPlanImg, r.x * CELL, r.y * CELL, r.w * CELL, r.h * CELL);
      ctx.restore();
      ctx.strokeStyle = cssVar('--accent', '#4fc3f7'); ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.strokeRect(r.x * CELL + 0.5, r.y * CELL + 0.5, r.w * CELL - 1, r.h * CELL - 1);
      ctx.setLineDash([]);
    }
    const labelColor = cssVar('--map-label', '#aab3cc'), textColor = cssVar('--map-text', '#e6e9f2');
    // 존
    for (const z of edZones) {
      ctx.fillStyle = z.color + '59';
      ctx.fillRect(z.rect_x * CELL, z.rect_y * CELL, z.rect_w * CELL, z.rect_h * CELL);
      ctx.strokeStyle = z.color; ctx.lineWidth = 2;
      ctx.strokeRect(z.rect_x * CELL + 1, z.rect_y * CELL + 1, z.rect_w * CELL - 2, z.rect_h * CELL - 2);
      ctx.fillStyle = labelColor; ctx.font = 'bold 11px sans-serif';
      ctx.fillText(z.name, z.rect_x * CELL + 6, z.rect_y * CELL + 15);
    }
    // 그리드
    ctx.strokeStyle = cssVar('--ed-grid', 'rgba(255,255,255,.05)'); ctx.lineWidth = 1;
    for (let x = 0; x <= GW; x++) { ctx.beginPath(); ctx.moveTo(x * CELL, 0); ctx.lineTo(x * CELL, GH * CELL); ctx.stroke(); }
    for (let y = 0; y <= GH; y++) { ctx.beginPath(); ctx.moveTo(0, y * CELL); ctx.lineTo(GW * CELL, y * CELL); ctx.stroke(); }
    // 공정 라인 (부하 색상)
    const center = (id) => {
      const eq = edEquipments.find(q => q.id === id);
      return eq ? { x: eq.x * CELL + CELL / 2, y: eq.y * CELL + CELL / 2 } : null;
    };
    for (const l of edLinks) {
      const a = center(l.fromId), b = center(l.toId);
      if (!a || !b) continue;
      const color = l.level >= 90 ? '#ef4444' : l.level >= 70 ? '#fb923c' : l.level >= 40 ? '#fbbf24' : '#34d399';
      ctx.strokeStyle = color; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      // 방향 화살표
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(mx + Math.cos(ang) * 7, my + Math.sin(ang) * 7);
      ctx.lineTo(mx + Math.cos(ang + 2.5) * 6, my + Math.sin(ang + 2.5) * 6);
      ctx.lineTo(mx + Math.cos(ang - 2.5) * 6, my + Math.sin(ang - 2.5) * 6);
      ctx.closePath(); ctx.fill();
      if (l.level > 3) {
        ctx.font = 'bold 9px sans-serif';
        ctx.fillText(`${l.level}%`, mx + 5, my - 5);
      }
    }
    // 라인 연결 모드: 시작 설비 강조
    if (edLinkFrom) {
      const c = center(edLinkFrom.id);
      if (c) {
        ctx.strokeStyle = '#4fc3f7'; ctx.lineWidth = 2; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.arc(c.x, c.y, CELL * 0.65, 0, 7); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // 설비
    for (const eq of edEquipments) {
      const gx = edDrag && edDrag.eq === eq ? edDrag.gx : eq.x;
      const gy = edDrag && edDrag.eq === eq ? edDrag.gy : eq.y;
      const px = gx * CELL + 3, py = gy * CELL + 3, s = CELL - 6;
      ctx.fillStyle = '#39415c';
      ctx.fillRect(px, py, s, s);
      ctx.strokeStyle = edSelEq && edSelEq.id === eq.id ? '#4fc3f7' : '#1a1e2c';
      ctx.lineWidth = edSelEq && edSelEq.id === eq.id ? 2 : 1;
      ctx.strokeRect(px, py, s, s);
      const stc = { RUN: '#34d399', IDLE: '#fbbf24', STOP: '#f87171', ALARM: '#ef4444' }[eq.status] || '#888';
      ctx.fillStyle = stc; ctx.beginPath(); ctx.arc(px + s - 5, py + 5, 3, 0, 7); ctx.fill();
      if (eq.data_source) { ctx.fillStyle = '#4fc3f7'; ctx.font = '8px sans-serif'; ctx.fillText('⚡', px + 2, py + 9); }
      ctx.fillStyle = textColor; ctx.font = '8px sans-serif';
      ctx.fillText(eq.code, px, py + s + 1);
    }
    // 존 그리기 프리뷰
    if (edRect) {
      const x = Math.min(edRect.x0, edRect.x1), y = Math.min(edRect.y0, edRect.y1);
      const w = Math.abs(edRect.x1 - edRect.x0) + 1, h = Math.abs(edRect.y1 - edRect.y0) + 1;
      ctx.strokeStyle = '#4fc3f7'; ctx.lineWidth = 2; ctx.setLineDash([5, 3]);
      ctx.strokeRect(x * CELL, y * CELL, w * CELL, h * CELL);
      ctx.setLineDash([]);
    }
  }

  function cellOf(e) {
    const r = canvas().getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(GW - 1, Math.floor((e.clientX - r.left) / CELL))),
      y: Math.max(0, Math.min(GH - 1, Math.floor((e.clientY - r.top) / CELL))),
    };
  }

  function zoneAt(gx, gy) {
    return edZones.find(z => gx >= z.rect_x && gx < z.rect_x + z.rect_w && gy >= z.rect_y && gy < z.rect_y + z.rect_h);
  }

  function initEditorEvents() {
    const cv = canvas();
    cv.addEventListener('mousedown', async (e) => {
      const c = cellOf(e);
      if (edDrawZone !== null) { edRect = { x0: c.x, y0: c.y, x1: c.x, y1: c.y }; renderMap(); return; }
      const eq = edEquipments.find(q => q.x === c.x && q.y === c.y);
      // 라인 연결 모드: A 클릭 → B 클릭 (연속 체인)
      if (edLinkMode) {
        if (!eq) { edLinkFrom = null; renderMap(); $('ed-hint').textContent = '라인 연결: 시작 설비를 클릭하세요.'; return; }
        if (!edLinkFrom) {
          edLinkFrom = eq; renderMap();
          $('ed-hint').textContent = `라인 연결: ${eq.name} → 연결할 설비를 클릭하세요.`;
        } else if (edLinkFrom.id !== eq.id) {
          try {
            await api('/api/admin/links', { method: 'POST', body: JSON.stringify({ fromId: edLinkFrom.id, toId: eq.id }) });
            $('ed-hint').textContent = `라인 연결됨: ${edLinkFrom.name} → ${eq.name}. 계속 연결하려면 다음 설비를 클릭하세요.`;
            edLinkFrom = eq; // 체인 연결
            edLinks = await api('/api/admin/links').catch(() => edLinks);
            renderLinkList(); renderMap();
          } catch (err) { if (err.message !== 'auth') $('ed-hint').textContent = '⚠ ' + err.message; }
        }
        return;
      }
      if (eq) { edDrag = { eq, gx: eq.x, gy: eq.y }; selectEq(eq); }
    });
    cv.addEventListener('mousemove', (e) => {
      const c = cellOf(e);
      if (edRect) { edRect.x1 = c.x; edRect.y1 = c.y; renderMap(); return; }
      if (edDrag) { edDrag.gx = c.x; edDrag.gy = c.y; renderMap(); }
    });
    cv.addEventListener('mouseup', async () => {
      if (edRect && edDrawZone !== null) {
        const x = Math.min(edRect.x0, edRect.x1), y = Math.min(edRect.y0, edRect.y1);
        const w = Math.abs(edRect.x1 - edRect.x0) + 1, h = Math.abs(edRect.y1 - edRect.y0) + 1;
        try {
          await api('/api/admin/zones/' + edDrawZone, { method: 'PUT', body: JSON.stringify({ rectX: x, rectY: y, rectW: w, rectH: h }) });
        } catch (e) { if (e.message !== 'auth') alert(e.message); }
        edRect = null; edDrawZone = null; cv.style.cursor = 'default';
        $('ed-hint').textContent = '존 영역이 저장되었습니다.';
        await loadEditor(); loadEquipments();
        return;
      }
      if (edDrag) {
        const { eq, gx, gy } = edDrag;
        edDrag = null;
        if (gx !== eq.x || gy !== eq.y) {
          const zone = zoneAt(gx, gy);
          try {
            await api('/api/admin/equipments/' + eq.id, {
              method: 'PUT',
              body: JSON.stringify({ x: gx, y: gy, zoneId: zone ? zone.id : eq.zone_id }),
            });
          } catch (e) { if (e.message !== 'auth') alert(e.message); }
          await loadEditor(); loadEquipments();
        } else renderMap();
      }
    });
  }

  function renderZoneList() {
    $('ed-zones').innerHTML = edZones.map(z => `<div data-id="${z.id}" style="display:flex;gap:6px;align-items:center;padding:4px 0">
      <input type="color" class="z-color" value="${z.color}" style="width:30px;height:26px;padding:1px;border:1px solid var(--border);border-radius:5px;background:none">
      <input class="z-name" value="${esc(z.name)}" style="flex:1;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:#0e1220;color:var(--text);font-size:12px">
      <span class="muted" style="font-size:11px">${z.rect_w}×${z.rect_h}</span>
      <button class="z-draw" style="padding:5px 8px;font-size:11px">영역</button>
      <button class="z-save" style="padding:5px 8px;font-size:11px">저장</button>
      <button class="z-del" style="padding:5px 8px;font-size:11px;border-color:var(--stop);color:var(--stop);background:rgba(248,113,113,.1)">✕</button>
    </div>`).join('');

    $('ed-zones').querySelectorAll('[data-id]').forEach(row => {
      const id = Number(row.dataset.id);
      row.querySelector('.z-draw').onclick = () => {
        edDrawZone = id; canvas().style.cursor = 'crosshair';
        $('ed-hint').textContent = '맵 위에서 드래그하여 존 영역을 지정하세요.';
      };
      row.querySelector('.z-save').onclick = async () => {
        try {
          await api('/api/admin/zones/' + id, {
            method: 'PUT',
            body: JSON.stringify({ name: row.querySelector('.z-name').value.trim(), color: row.querySelector('.z-color').value }),
          });
          await loadEditor();
        } catch (e) { if (e.message !== 'auth') alert(e.message); }
      };
      row.querySelector('.z-del').onclick = async () => {
        if (!confirm('이 존을 삭제할까요?')) return;
        try {
          await api('/api/admin/zones/' + id, { method: 'DELETE' });
          await loadEditor();
        } catch (e) { if (e.message !== 'auth') alert(e.message); }
      };
    });
    // 라인 전환(replace)으로 숨긴 존 — 복원 버튼
    $('ed-hidden-zones').innerHTML = edHiddenZones.length
      ? `숨긴 존 ${edHiddenZones.length}개: ` + edHiddenZones.map(z =>
          `<span style="margin-right:6px">${esc(z.name)} <button class="z-restore" data-id="${z.id}" style="padding:1px 7px;font-size:10px">복원</button></span>`).join('')
      : '';
    $('ed-hidden-zones').querySelectorAll('.z-restore').forEach(b => {
      b.onclick = async () => {
        try { await api('/api/admin/zones/' + b.dataset.id, { method: 'PUT', body: JSON.stringify({ hidden: false }) }); await loadEditor(); loadEquipments(); }
        catch (e) { if (e.message !== 'auth') alert(e.message); }
      };
    });
  }

  // 라인 연결 모드 토글 + 목록
  $('ed-link-mode').onclick = () => {
    edLinkMode = !edLinkMode;
    edLinkFrom = null;
    $('ed-link-mode').style.background = edLinkMode ? 'rgba(79,195,247,.35)' : '';
    canvas().style.cursor = edLinkMode ? 'crosshair' : 'default';
    $('ed-hint').textContent = edLinkMode
      ? '라인 연결: 시작 설비를 클릭하세요.'
      : '설비를 클릭하면 우측에서 상세·연동 설정을 편집할 수 있습니다.';
    renderMap();
  };

  function renderLinkList() {
    $('ed-links').innerHTML = edLinks.length ? edLinks.map(l => `
      <div style="display:flex;align-items:center;gap:8px;padding:3px 0">
        <span>${esc(l.fromName)} → ${esc(l.toName)}</span>
        <span style="font-size:11px;color:${l.level >= 90 ? 'var(--stop)' : l.level >= 40 ? 'var(--idle)' : 'var(--run)'}">부하 ${l.level}%</span>
        <button class="l-del" data-id="${l.id}" style="padding:2px 8px;font-size:11px;border:1px solid var(--stop);color:var(--stop);background:rgba(248,113,113,.1);border-radius:5px">✕</button>
      </div>`).join('') : '라인이 없습니다. [라인 연결 모드]로 설비를 이어보세요.';
    $('ed-links').querySelectorAll('.l-del').forEach(b => {
      b.onclick = async () => {
        try {
          await api('/api/admin/links/' + b.dataset.id, { method: 'DELETE' });
          edLinks = await api('/api/admin/links').catch(() => []);
          renderLinkList(); renderMap();
        } catch (e) { if (e.message !== 'auth') alert(e.message); }
      };
    });
  }

  $('ed-newzone-add').onclick = async () => {
    const name = $('ed-newzone-name').value.trim();
    if (!name) return alert('존 이름을 입력해 주세요.');
    try {
      await api('/api/admin/zones', { method: 'POST', body: JSON.stringify({ name, color: '#3d5a80' }) });
      $('ed-newzone-name').value = '';
      await loadEditor();
    } catch (e) { if (e.message !== 'auth') alert(e.message); }
  };

  function selectEq(eq) {
    edSelEq = eq;
    $('ed-eq-panel').classList.remove('hidden');
    $('ed-eq-title').textContent = `${eq.name} (${eq.code})`;
    $('ed-eq-name').value = eq.name;
    $('ed-eq-type').innerHTML = typeOpts(eq.type);
    $('ed-eq-op').innerHTML = opOpts(eq.op || '');
    $('ed-eq-manager').value = eq.manager || '';
    let ds = null;
    try { ds = eq.data_source ? JSON.parse(eq.data_source) : null; } catch {}
    $('ed-eq-protocol').value = ds?.protocol || '';
    $('ed-eq-address').value = ds?.address || '';
    $('ed-eq-tag').value = ds?.tag || '';
    $('ed-eq-interval').value = ds?.intervalMs || 1000;
    $('ed-eq-unit').value = ds?.unitId ?? 1;
    $('ed-eq-regtype').value = ds?.regType || 'holding';
    $('ed-eq-valuetag').value = ds?.valueTag || '';
    $('ed-eq-map').value = ds?.statusMap ? Object.entries(ds.statusMap).map(([k, v]) => `${k}=${v}`).join(', ') : '';
    updateDsFields();
    renderMap();
  }

  // 프로토콜별로 필요한 입력만 표시 (server/drivers/*.js 설정 규약)
  const DS_HINT = {
    '': '수동 입력 상태입니다. 프로토콜을 지정하면 게이트웨이가 자동 수집합니다.',
    mqtt: '브로커 주소(mqtt://호스트:1883)와 토픽. payload는 RUN/IDLE/STOP/ALARM 평문, {"status":"RUN","value":72.5} JSON, 또는 상태 매핑으로 변환할 원시값.',
    opcua: 'opc.tcp://호스트:4840 과 상태 노드 ID(ns=2;s=...). node-opcua 미설치 시 시뮬레이션으로 대체 가동됩니다 (npm install node-opcua).',
    modbus: '호스트:포트(기본 502), 레지스터 주소(0 기반), 유닛 ID. modbus-serial 미설치 시 시뮬레이션으로 대체 가동됩니다 (npm install modbus-serial).',
    sim: '실제 장비 없이 확률 기반으로 상태를 전이시키는 데모 모드입니다.',
  };
  const DS_TAG_LABEL = { mqtt: '토픽', opcua: '상태 노드 ID', modbus: '레지스터 주소', sim: '태그(표시용)', '': '태그/토픽' };
  const DS_ADDR_PH = { mqtt: 'mqtt://192.168.0.5:1883', opcua: 'opc.tcp://192.168.0.10:4840', modbus: '192.168.0.20:502', sim: '(없음)', '': '' };
  function updateDsFields() {
    const p = $('ed-eq-protocol').value;
    document.querySelectorAll('.ds-modbus').forEach(el => el.style.display = p === 'modbus' ? '' : 'none');
    document.querySelectorAll('.ds-opcua').forEach(el => el.style.display = p === 'opcua' ? '' : 'none');
    document.querySelectorAll('.ds-map').forEach(el => el.style.display = p && p !== 'sim' ? '' : 'none');
    $('ed-eq-tag-label').textContent = DS_TAG_LABEL[p] || '태그/토픽';
    $('ed-eq-address').placeholder = '예: ' + (DS_ADDR_PH[p] || '');
    $('ed-ds-hint').textContent = '※ ' + (DS_HINT[p] || DS_HINT['']);
  }
  $('ed-eq-protocol').onchange = updateDsFields;

  // "0=IDLE, 1=RUN" 형식 → {"0":"IDLE","1":"RUN"}
  function parseStatusMap(text) {
    const map = {};
    for (const part of String(text || '').split(/[,\n]/)) {
      const [k, v] = part.split('=').map(s => s?.trim());
      if (k && v) map[k] = v.toUpperCase();
    }
    return Object.keys(map).length ? map : undefined;
  }

  $('ed-eq-save').onclick = async () => {
    if (!edSelEq) return;
    const protocol = $('ed-eq-protocol').value;
    const dataSource = protocol ? {
      protocol,
      address: $('ed-eq-address').value.trim(),
      tag: $('ed-eq-tag').value.trim(),
      intervalMs: Number($('ed-eq-interval').value) || 1000,
      statusMap: parseStatusMap($('ed-eq-map').value),
      unitId: Number($('ed-eq-unit').value),
      regType: $('ed-eq-regtype').value,
      valueTag: $('ed-eq-valuetag').value.trim() || undefined,
    } : {};
    try {
      await api('/api/admin/equipments/' + edSelEq.id, {
        method: 'PUT',
        body: JSON.stringify({
          name: $('ed-eq-name').value.trim(),
          type: $('ed-eq-type').value,
          op: $('ed-eq-op').value || null,
          manager: $('ed-eq-manager').value.trim(),
          dataSource,
        }),
      });
      $('ed-hint').textContent = '설비가 저장되었습니다.';
      await loadEditor(); loadEquipments();
      edSelEq = edEquipments.find(q => q.id === edSelEq.id) || null;
      if (edSelEq) selectEq(edSelEq);
    } catch (e) { if (e.message !== 'auth') alert(e.message); }
  };

  initEditorEvents();

  // ── 로그아웃 ───────────────────────────
  $('btn-logout').onclick = (e) => {
    e.preventDefault();
    if (!confirm('로그아웃할까요? 이 브라우저에 저장된 로그인(관리자 콘솔·게임)이 모두 지워집니다.')) return;
    localStorage.removeItem('fw.adminToken');
    localStorage.removeItem('fw.token');
    token = null;
    showGate('');
  };

  // ── 시작 ──────────────────────────────
  // 저장된 세션이 있으면 확인하는 동안 로그인 폼을 띄우지 않는다 (테마 전환·게임에서 넘어올 때 다시 로그인하는 것처럼 보이지 않게)
  if (token) {
    $('gate').classList.add('hidden');
    const tried = token;
    api('/api/admin/overview').then(showConsole).catch((e) => {
      if (e.message === 'auth') {
        if (localStorage.getItem('fw.adminToken') === tried) localStorage.removeItem('fw.adminToken');   // 만료된 콘솔 세션 정리
      } else {
        showGate('서버에 연결할 수 없습니다. 잠시 후 새로고침해 주세요.');
      }
    });
  } else {
    showGate('');
  }
})();
