/* Factory World — UI 흐름 · 소켓 · HUD · 채팅 */
(function () {
  const FW = (window.FW = window.FW || {});
  const $ = (id) => document.getElementById(id);
  const STATUS_LABEL = { RUN: '가동', IDLE: '대기', STOP: '정지', ALARM: '알람' };
  const COLORS = ['#4fc3f7', '#f78fb3', '#a3e635', '#fbbf24', '#c084fc', '#fb923c', '#5eead4'];

  let token = null, me = null, socket = null;
  let charColor = COLORS[0];
  const playersBySocket = new Map();

  // ── 화면 전환 ──────────────────────────
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    $(id).classList.add('active');
  }

  // ── SCR-01 로그인 ──────────────────────
  // 운영 정책에 따라 안내 문구 조정 (자동 등록이 꺼져 있으면 사전 등록 안내)
  fetch('/api/policy').then(r => r.json()).then(p => {
    if (p && p.allowSelfRegister === false) {
      $('login-pw').placeholder = '등록된 사번만 로그인 가능 (첫 로그인 시 비밀번호 설정)';
    }
  }).catch(() => {});
  $('login-btn').onclick = login;
  $('login-pw').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
  async function login() {
    const empNo = $('login-empno').value.trim();
    const name = $('login-name').value.trim();
    const password = $('login-pw').value;
    $('login-error').textContent = '';
    if (!empNo || !name || !password) { $('login-error').textContent = '⚠ 사번·이름·비밀번호를 입력해 주세요.'; return; }
    try {
      const res = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ empNo, name, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '로그인 실패');
      token = data.token; me = data.user;
      FW.token = token; // 게임 계층의 이미지 로딩(평면도)에 사용
      localStorage.setItem('fw.token', token);
      // 관리자 콘솔용 토큰은 별도 키 (게임에 다른 계정으로 접속해도 콘솔 세션 유지)
      if (me.role === 'admin') localStorage.setItem('fw.adminToken', token);
      $('btn-admin').style.display = me.role === 'admin' ? '' : 'none';
      $('char-nick').value = localStorage.getItem('fw.nick') || me.name;
      $('char-badge').value = localStorage.getItem('fw.badge') || '작업자';
      selectColor(localStorage.getItem('fw.color') || COLORS[0]);
      showScreen('screen-character');
    } catch (e) {
      $('login-error').textContent = '⚠ ' + e.message;
    }
  }

  // ── SCR-02 캐릭터 ──────────────────────
  const sw = $('swatches');
  COLORS.forEach(c => {
    const b = document.createElement('button');
    b.className = 'swatch'; b.style.background = c;
    b.onclick = () => selectColor(c);
    sw.appendChild(b);
  });
  function selectColor(c) {
    charColor = c;
    $('char-dot').style.background = c; $('char-dot').style.color = c;
    [...sw.children].forEach(el => el.classList.toggle('sel', el.style.background && rgbToHex(el.style.background) === c));
  }
  function rgbToHex(rgb) {
    const m = rgb.match(/\d+/g);
    if (!m) return rgb;
    return '#' + m.slice(0, 3).map(n => (+n).toString(16).padStart(2, '0')).join('');
  }

  $('enter-btn').onclick = () => {
    const nick = $('char-nick').value.trim() || me.name;
    const badge = $('char-badge').value;
    localStorage.setItem('fw.nick', nick);
    localStorage.setItem('fw.badge', badge);
    localStorage.setItem('fw.color', charColor);
    connect(nick, badge);
  };

  // ── 소켓 연결 ──────────────────────────
  function connect(nick, badge) {
    socket = io({ auth: { token, color: charColor, badge, nick } });
    FW.socket = socket;

    socket.on('connect_error', (e) => toast('서버 연결 실패: ' + e.message, true));

    socket.on('init', (data) => {
      data.me.name = nick; // 표시용 닉네임
      FW.myUserId = data.me.userId;
      myStats = data.stats;
      renderStatsPill();
      refreshQuests();
      playersBySocket.clear();
      data.players.forEach(p => playersBySocket.set(p.socketId, p));
      showScreen('screen-game');
      $('pill-user').textContent = `${nick} · ${badge}`;
      // 상태 변경 권한 (보전/관리자만 — NFR-03)
      const canSet = ['maintainer', 'admin'].includes(me.role);
      [...$('eq-status-btns').children].forEach(b => {
        b.disabled = !canSet;
        b.style.opacity = canSet ? '' : '.4';
        b.style.cursor = canSet ? '' : 'not-allowed';
        if (!canSet) b.title = '보전/관리자만 상태를 변경할 수 있습니다';
      });
      if (!canSet) $('eq-reason').placeholder = '상태 변경은 보전/관리자 권한이 필요합니다';
      renderOnline();
      initChat();
      if (!FW.phaserGame) {
        FW.startGame(data);
        toast(`${data.zones.length}개 존 · 설비 ${data.equipments.length}대 — 출근 완료!`);
        showBriefing(data.briefing);
        return;
      }
      // 재접속 (NFR-04): 서버는 새 소켓으로 보므로 맵·접속자를 다시 맞추고 내 위치를 알려준다
      FW.initData = data;
      FW.gameApi.reloadWorld(data.zones, data.equipments);
      FW.gameApi.setFloorplan(data.floorplan);
      FW.gameApi.setLinks(data.links, data.linkStates);
      FW.gameApi.resetPlayers(data.players);
      const pos = FW.gameApi.myPosition();
      if (pos) FW.sendMove(pos.x, pos.y, false, pos.dir);
      if (currentEqId) loadEquipmentDetail(currentEqId);
      toast('🔄 서버에 다시 연결되었습니다.');
    });
    socket.on('disconnect', (reason) => {
      if (reason !== 'io client disconnect') toast('⚠ 서버 연결이 끊겼습니다. 자동으로 다시 연결합니다…', true);
    });

    socket.on('player:joined', (p) => {
      playersBySocket.set(p.socketId, p);
      FW.gameApi.addPlayer(p);
      renderOnline();
      toast(`${p.name} 님 출근`);
    });
    socket.on('player:left', ({ socketId }) => {
      const p = playersBySocket.get(socketId);
      playersBySocket.delete(socketId);
      FW.gameApi.removePlayer(socketId);
      renderOnline();
      if (p) toast(`${p.name} 님 퇴근`);
    });
    socket.on('player:moved', (d) => FW.gameApi.movePlayer(d.socketId, d.x, d.y, d.moving, d.dir));

    // Phase 3: 포인트/뱃지/퀘스트 실시간 이벤트
    socket.on('points:awarded', (d) => {
      myStats = { ...(myStats || {}), points: d.total, level: d.level };
      renderStatsPill();
      toast(`⭐ +${d.points}P — ${d.reason}`);
      if (d.levelUp) toast(`🎉 레벨 업! Lv.${d.level} 달성`);
    });
    socket.on('badge:earned', (b) => toast(`${b.icon} 뱃지 획득: ${b.name} — ${b.desc}`));
    socket.on('quest:new', (q) => {
      toast(`📜 새 작업지시: ${q.title} (${q.equipmentName})`);
      refreshQuests();
    });
    socket.on('quest:update', () => refreshQuests());

    // 공정 라인 부하
    socket.on('link:load', (states) => FW.gameApi.updateLinkStates(states));
    socket.on('links:changed', ({ links, states }) => FW.gameApi.setLinks(links, states));
    socket.on('link:congested', ({ fromName, toName }) => {
      toast(`🚚 라인 정체: ${fromName} → ${toName} — 하류 설비를 확인하세요`, true);
    });

    // 담당자 호출 수신 (설계서 6.3 액션)
    socket.on('call:incoming', ({ equipmentId, equipmentName, from, note }) => {
      toast(`📣 ${from} 님이 『${equipmentName}』로 호출했습니다${note ? ` — ${note}` : ''}`, true);
      openEquipmentWindow(equipmentId);
    });

    socket.on('gateway:state', ({ running }) => {
      toast(running ? '🔌 설비 게이트웨이 연결 — 상태 자동 수집 시작' : '🔌 설비 게이트웨이 중지 — 수동 입력 모드');
    });

    // 관리자 콘솔에서 존/설비를 편집하면 새로고침 없이 맵에 반영 (NFR-02)
    socket.on('world:refresh', ({ zones, equipments, floorplan }) => {
      FW.initData.zones = zones;
      FW.initData.equipments = equipments;
      FW.initData.floorplan = floorplan;
      FW.gameApi.reloadWorld(zones, equipments);
      FW.gameApi.setFloorplan(floorplan);
      if (currentEqId) {
        if (equipments.some(e => e.id === currentEqId)) loadEquipmentDetail(currentEqId);
        else { $('eq-window').classList.remove('open'); currentEqId = null; }
      }
      toast('⚙ 설비 구성이 변경되어 맵에 반영되었습니다.');
    });

    socket.on('equipment:status', ({ equipment, changedBy }) => {
      FW.gameApi.setEquipmentStatus(equipment.id, equipment.status);
      if (equipment.status === 'ALARM') toast(`🚨 ${equipment.name} 알람 발생!`, true);
      if (currentEqId === equipment.id) loadEquipmentDetail(equipment.id);
    });

    // 채팅 이벤트
    socket.on('channel:enter', ({ equipmentId, equipmentName, auto, members }) => {
      addChannel(`eq:${equipmentId}`, equipmentName, members);
    });
    socket.on('channel:active', ({ equipmentId, equipmentName, members }) => {
      addChannel(`eq:${equipmentId}`, equipmentName, members);
      toast(`💬 『${equipmentName}』 대화방 활성화 (${members.length}명)`);
      openChat(`eq:${equipmentId}`);
    });
    socket.on('channel:exit', ({ equipmentId }) => removeChannel(`eq:${equipmentId}`));
    socket.on('channel:members', ({ equipmentId, members }) => {
      const ch = channels.get(`eq:${equipmentId}`);
      if (ch) { ch.members = members; if (activeChannel === `eq:${equipmentId}`) renderMembers(); }
    });
    socket.on('chat:message', (msg) => {
      const ch = channels.get(msg.channel);
      if (!ch) return;
      ch.messages.push(msg);
      if (activeChannel === msg.channel && $('chat-panel').classList.contains('open')) renderMessages();
      else { ch.unread++; renderTabs(); renderUnreadTotal(); }
    });
  }

  FW.sendMove = (x, y, moving, dir) => socket?.emit('player:move', { x, y, moving, dir });

  // ── 접속자 목록 ────────────────────────
  function renderOnline() {
    const list = $('online-list');
    const meRow = `<div class="row"><span class="dot" style="background:${charColor}"></span>${$('char-nick').value || me.name} <span class="badge">나</span></div>`;
    list.innerHTML = meRow + [...playersBySocket.values()].map(p =>
      `<div class="row"><span class="dot" style="background:${p.color}"></span>${esc(p.name)} <span class="badge">${esc(p.badge)}</span></div>`
    ).join('');
    $('online-count').textContent = playersBySocket.size + 1;
  }
  $('online-head').onclick = () => $('online-panel').classList.toggle('collapsed');

  // ── 토스트 ─────────────────────────────
  function toast(text, alarm) {
    const el = document.createElement('div');
    el.className = 'toast' + (alarm ? ' alarm' : '');
    el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; }, 3200);
    setTimeout(() => el.remove(), 3700);
  }
  FW.toast = toast;

  // ── SCR-04 설비 상태창 ─────────────────
  let currentEqId = null;
  FW.onOpenEquipment = (eqId) => { openEquipmentWindow(eqId); };

  function openEquipmentWindow(eqId) {
    currentEqId = eqId;
    $('eq-window').classList.add('open');
    loadEquipmentDetail(eqId);
  }
  $('eq-close').onclick = () => { $('eq-window').classList.remove('open'); currentEqId = null; };

  function loadEquipmentDetail(eqId) {
    socket.emit('equipment:detail', { equipmentId: eqId }, (res) => {
      if (!res || res.error) return;
      const eq = res.equipment;
      const zone = FW.initData.zones.find(z => z.id === eq.zone_id);
      const col = getComputedStyle(document.documentElement).getPropertyValue(`--${eq.status.toLowerCase()}`) || '#888';
      $('eq-name').textContent = eq.name;
      $('eq-code').textContent = `${eq.code} · ID ${eq.id}`;
      $('eq-lamp').style.color = col; $('eq-lamp').style.background = col;
      $('eq-zone').textContent = zone ? zone.name : '-';
      $('eq-manager').textContent = eq.manager || '-';
      let dsText = '수동 입력 (1단계)';
      if (eq.data_source) {
        try {
          const ds = JSON.parse(eq.data_source);
          dsText = `${ds.protocol.toUpperCase()} · ${ds.tag || ds.address}`;
        } catch {}
      }
      $('eq-datasource').textContent = dsText;
      $('eq-status').innerHTML = `<b class="s-${eq.status}">● ${STATUS_LABEL[eq.status]}</b>`;
      $('eq-duration').textContent = durationText(eq.status_since);
      $('eq-uptime-pct').textContent = res.uptime === null ? '-' : res.uptime + '%';
      $('eq-uptime-bar').style.width = (res.uptime ?? 0) + '%';
      // 목표 대비 진행률 (경험치바): 진행 중·금일 완료 작업지시의 목표수량 합 대비 금일 양품
      const p = res.production || { good: 0, defect: 0, target: 0, orders: 0 };
      const pct = p.target > 0 ? Math.min(100, Math.round(p.good / p.target * 100)) : null;
      $('eq-progress-pct').textContent = pct === null ? '-' : pct + '%';
      $('eq-progress-bar').style.width = (pct ?? 0) + '%';
      $('eq-progress-sub').textContent = p.target > 0
        ? `금일 양품 ${p.good} / 목표 ${p.target} · 불량 ${p.defect} · 작업지시 ${p.orders}건`
        : (p.good + p.defect > 0 ? `금일 양품 ${p.good} · 불량 ${p.defect} (목표 없음)` : '작업지시 없음');
      $('eq-call').classList.toggle('online', !!res.managerOnline);
      $('eq-call').title = eq.manager
        ? `담당자 ${eq.manager} — ${res.managerOnline ? '접속 중' : '미접속 (설비 이력에만 기록)'}`
        : '담당자가 지정되지 않은 설비입니다';
      [...$('eq-status-btns').children].forEach(b => {
        b.className = b.dataset.s === eq.status ? `sel-${eq.status}` : '';
      });
      $('eq-log').innerHTML = res.recentLog.length
        ? res.recentLog.map(l =>
            `<div class="lrow"><span class="lstatus s-${l.status}">${STATUS_LABEL[l.status]}</span><span>${l.changed_at.slice(5, 16)}</span><span>${esc(l.changed_by_name || '')}</span><span>${esc(l.reason || '')}</span></div>`
          ).join('')
        : '<div class="lrow">이력 없음</div>';
      $('eq-files').innerHTML = res.files.length
        ? res.files.map(f =>
            `<div class="lrow">📎 <a class="file-link" href="/api/files/${f.id}">${esc(f.original_name)}</a></div>`
          ).join('')
        : '<div class="lrow">첨부 없음</div>';
    });
  }

  [...$('eq-status-btns').children].forEach(btn => {
    btn.onclick = () => {
      if (!currentEqId) return;
      socket.emit('equipment:setStatus', {
        equipmentId: currentEqId, status: btn.dataset.s, reason: $('eq-reason').value.trim(),
      }, (res) => {
        if (res?.error) toast(res.error, true);
        else { $('eq-reason').value = ''; }
      });
    };
  });

  $('eq-open-chat').onclick = () => {
    if (!currentEqId) return;
    socket.emit('channel:join', { equipmentId: currentEqId });
    setTimeout(() => openChat(`eq:${currentEqId}`), 150);
  };

  $('eq-call').onclick = () => {
    if (!currentEqId) return;
    socket.emit('equipment:call', { equipmentId: currentEqId, note: $('eq-reason').value.trim() }, (res) => {
      if (res?.error) return toast('⚠ ' + res.error, true);
      toast(res.notified > 0
        ? `📣 담당자 ${res.manager} 님에게 호출을 보냈습니다`
        : `📣 담당자 ${res.manager} 님은 접속 중이 아닙니다 — 설비 이력에 호출을 기록했습니다`);
      $('eq-reason').value = '';
    });
  };

  // ── 출근 브리핑 (설계서 6.1) ────────────
  function showBriefing(b) {
    if (!b) return;
    const rows = [];
    for (const a of b.alarms || []) {
      rows.push(`<div class="b-row"><span class="b-ico">🚨</span><div><b class="b-link" data-eq="${a.id}">${esc(a.name)}</b> 알람 진행 중<div class="b-sub">${durationText(a.status_since)} 경과</div></div></div>`);
    }
    if (b.openQuests > 0 || b.myQuests > 0) {
      rows.push(`<div class="b-row"><span class="b-ico">📜</span><div>작업지시 <b>${b.openQuests}</b>건 모집 중${b.myQuests ? ` · 내 진행 중 <b>${b.myQuests}</b>건` : ''}<div class="b-sub">하단 📜 임무 버튼에서 확인</div></div></div>`);
    }
    for (const n of b.notices || []) {
      rows.push(`<div class="b-row"><span class="b-ico">📢</span><div>${esc(n.content)}<div class="b-sub">${esc(n.sender_name)} · ${n.created_at.slice(11, 16)}</div></div></div>`);
    }
    if (!rows.length) return; // 알릴 것이 없으면 팝업을 띄우지 않음 (업무 방해 최소화)
    $('brief-body').innerHTML = rows.join('');
    $('brief-body').querySelectorAll('.b-link').forEach(el => {
      el.onclick = () => { $('brief-panel').classList.remove('open'); openEquipmentWindow(Number(el.dataset.eq)); };
    });
    $('brief-panel').classList.add('open');
  }
  $('brief-close').onclick = () => $('brief-panel').classList.remove('open');

  // ── 테마 전환 (다크 / 흰 바탕) ─────────
  $('btn-theme').onclick = () => {
    const light = document.documentElement.dataset.theme !== 'light';
    localStorage.setItem('fw.theme', light ? 'light' : 'dark');
    toast(light ? '🌓 흰 바탕 테마로 전환합니다 — 화면을 다시 불러옵니다' : '🌓 다크 테마로 전환합니다 — 화면을 다시 불러옵니다');
    setTimeout(() => location.reload(), 900);
  };

  // ── 저사양 모드 (NFR-05: 구형 태블릿) ───
  FW.lowFx = localStorage.getItem('fw.lowfx') === '1';
  $('btn-lowfx').classList.toggle('on', FW.lowFx);
  $('btn-lowfx').onclick = () => {
    const next = !FW.lowFx;
    localStorage.setItem('fw.lowfx', next ? '1' : '0');
    toast(next ? '⚡ 저사양 모드를 켭니다 — 화면을 다시 불러옵니다' : '⚡ 저사양 모드를 끕니다 — 화면을 다시 불러옵니다');
    setTimeout(() => location.reload(), 900);
  };

  // ── 터치 이동 패드 (NFR-05) ────────────
  FW.touchDir = { up: false, down: false, left: false, right: false };
  document.querySelectorAll('#dpad button').forEach(b => {
    const dir = b.dataset.dir;
    const on = (e) => { e.preventDefault(); FW.touchDir[dir] = true; };
    const off = (e) => { e.preventDefault(); FW.touchDir[dir] = false; };
    b.addEventListener('pointerdown', on);
    b.addEventListener('pointerup', off);
    b.addEventListener('pointercancel', off);
    b.addEventListener('pointerleave', off);
  });

  function durationText(since) {
    const ms = Date.now() - new Date(since.replace(' ', 'T')).getTime();
    if (ms < 0) return '-';
    const m = Math.floor(ms / 60000);
    if (m < 1) return '방금 전부터';
    if (m < 60) return `${m}분`;
    return `${Math.floor(m / 60)}시간 ${m % 60}분`;
  }

  // ── SCR-05 대화 패널 ───────────────────
  const channels = new Map(); // key -> {name, messages:[], unread, members:[]}
  let activeChannel = 'all';

  function initChat() {
    channels.clear();
    channels.set('all', { name: '전체', messages: [], unread: 0, members: [] });
    socket.emit('chat:history', { channel: 'all' }, (msgs) => {
      channels.get('all').messages = msgs || [];
      renderTabs(); renderMessages();
    });
    renderTabs();
  }

  function addChannel(key, name, members) {
    if (!channels.has(key)) {
      channels.set(key, { name, messages: [], unread: 0, members: members || [] });
      socket.emit('chat:history', { channel: key }, (msgs) => {
        channels.get(key).messages = msgs || [];
        if (activeChannel === key) renderMessages();
      });
    } else {
      channels.get(key).members = members || channels.get(key).members;
    }
    renderTabs();
  }
  function removeChannel(key) {
    channels.delete(key);
    if (activeChannel === key) activeChannel = 'all';
    renderTabs(); renderMessages(); renderMembers();
  }

  function openChat(key) {
    if (key) activeChannel = channels.has(key) ? key : 'all';
    $('chat-panel').classList.add('open');
    document.body.classList.add('chat-open'); // 하단 버튼을 패널 왼쪽으로 비킴 (입력줄 겹침 방지)
    $('chat-toggle').innerHTML = '✕ 닫기 <span class="unread" id="chat-unread"></span>';
    const ch = channels.get(activeChannel);
    if (ch) ch.unread = 0;
    renderTabs(); renderMessages(); renderMembers(); renderUnreadTotal();
  }

  function renderTabs() {
    $('chat-tabs').innerHTML = '';
    for (const [key, ch] of channels) {
      const b = document.createElement('button');
      b.textContent = key === 'all' ? '📢 전체' : `🏭 ${ch.name}`;
      if (key === activeChannel) b.classList.add('active');
      if (ch.unread > 0) b.innerHTML += '<span class="dot"></span>';
      b.onclick = () => { activeChannel = key; ch.unread = 0; renderTabs(); renderMessages(); renderMembers(); renderUnreadTotal(); };
      $('chat-tabs').appendChild(b);
    }
  }
  function renderMembers() {
    const ch = channels.get(activeChannel);
    $('chat-members').textContent = activeChannel === 'all'
      ? '공장 전체 공지/대화 채널'
      : `참여: ${(ch?.members || []).map(m => m.name).join(', ') || '-'}`;
  }
  function renderMessages() {
    const ch = channels.get(activeChannel);
    const box = $('chat-messages');
    box.innerHTML = (ch?.messages || []).map(m => {
      if (m.type === 'system') return `<div class="msg system"><span class="bubble">${esc(m.content)}</span></div>`;
      const mine = m.senderId === FW.myUserId;
      const body = m.type === 'file'
        ? `📎 <a class="file-link" href="/api/files/${m.content.fileId}">${esc(m.content.name)}</a> <small>(${fmtSize(m.content.size)})</small>`
        : esc(m.content);
      return `<div class="msg${mine ? ' mine' : ''}">
        <div class="meta">${esc(m.senderName)} · ${m.createdAt.slice(11, 16)}</div>
        <span class="bubble">${body}</span></div>`;
    }).join('');
    box.scrollTop = box.scrollHeight;
  }
  function renderUnreadTotal() {
    let n = 0; channels.forEach(c => n += c.unread);
    $('chat-unread').textContent = n > 0 ? `(${n})` : '';
  }

  function closeChat() {
    $('chat-panel').classList.remove('open');
    document.body.classList.remove('chat-open');
    $('chat-toggle').innerHTML = '💬 대화 <span class="unread" id="chat-unread"></span>';
    renderUnreadTotal();
  }
  $('chat-toggle').onclick = () => {
    if ($('chat-panel').classList.contains('open')) closeChat();
    else openChat();
  };

  function sendChat() {
    const text = $('chat-input').value.trim();
    if (!text) return;
    socket.emit('chat:send', { channel: activeChannel, text }, (res) => {
      if (res?.error) toast(res.error, true);
    });
    $('chat-input').value = '';
  }
  $('chat-send-btn').onclick = sendChat;
  $('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
  $('chat-input').addEventListener('focus', () => FW.typing = true);
  $('chat-input').addEventListener('blur', () => FW.typing = false);

  // 파일 업로드
  $('chat-file-btn').onclick = () => $('chat-file').click();
  $('chat-file').addEventListener('change', () => {
    if ($('chat-file').files[0]) uploadFile($('chat-file').files[0]);
    $('chat-file').value = '';
  });
  const panel = $('chat-panel');
  panel.addEventListener('dragover', e => { e.preventDefault(); panel.classList.add('dragover'); });
  panel.addEventListener('dragleave', () => panel.classList.remove('dragover'));
  panel.addEventListener('drop', e => {
    e.preventDefault(); panel.classList.remove('dragover');
    if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]);
  });

  async function uploadFile(file) {
    if (file.size > 25 * 1024 * 1024) return toast('25MB 이하만 업로드할 수 있습니다.', true);
    toast(`업로드 중: ${file.name}`);
    try {
      const res = await fetch(`/api/upload?channel=${encodeURIComponent(activeChannel)}&name=${encodeURIComponent(file.name)}`, {
        method: 'POST', headers: { 'X-Auth-Token': token }, body: file,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '업로드 실패');
    } catch (e) { toast('⚠ ' + e.message, true); }
  }

  // ── Phase 3: 퀘스트 · 포인트 · 리더보드 ──
  let myStats = null;
  let questData = { active: [], myDone: [] };

  function renderStatsPill() {
    if (myStats) $('pill-level').textContent = `⭐ Lv.${myStats.level} · ${myStats.points.toLocaleString()}P`;
  }

  function refreshQuests() {
    if (!socket) return;
    socket.emit('quest:list', (res) => {
      if (!res) return;
      questData = res;
      if (res.stats) { myStats = res.stats; renderStatsPill(); }
      const openCount = res.active.filter(q => q.status === 'OPEN').length;
      $('quest-open-count').textContent = openCount > 0 ? `(${openCount})` : '';
      if ($('quest-panel').classList.contains('open')) renderQuests();
    });
  }

  function questCard(q) {
    const mine = q.assigneeId === FW.myUserId;
    const statusLabel = { OPEN: '모집 중', IN_PROGRESS: '진행 중', DONE: '완료' }[q.status] || q.status;
    let actions = '';
    if (q.status === 'OPEN') {
      actions = `<div class="q-actions"><button class="q-accept" data-id="${q.id}">✋ 수락하기</button></div>`;
    } else if (q.status === 'IN_PROGRESS' && mine) {
      actions = `<div class="q-actions"><button class="q-show-complete" data-id="${q.id}">✅ 완료 등록</button></div>
        <div class="q-complete-form" id="qform-${q.id}">
          <input type="number" min="0" class="q-good" placeholder="양품 수량">
          <input type="number" min="0" class="q-defect" placeholder="불량 수량">
          <input class="q-note" placeholder="품질 이슈/비고 (선택)" maxlength="200">
          <button class="q-submit" data-id="${q.id}">등록</button>
        </div>`;
    }
    const result = q.status === 'DONE' && q.qtyGood !== null
      ? `<div class="q-meta">실적: 양품 ${q.qtyGood} · 불량 ${q.qtyDefect}</div>` : '';
    return `<div class="quest-card">
      <div class="q-top"><span class="q-title">${esc(q.title)}</span><span class="q-status ${q.status}">${statusLabel}</span></div>
      <div class="q-meta">🏭 ${esc(q.equipmentName)} · 목표 ${q.targetQty}개${q.dueDate ? ` · 마감 ${q.dueDate}` : ''}${q.assigneeName ? ` · 담당 ${esc(q.assigneeName)}` : ''}</div>
      ${q.description ? `<div class="q-desc">${esc(q.description)}</div>` : ''}
      ${result}${actions}
    </div>`;
  }

  function renderQuests() {
    const { active, myDone } = questData;
    let html = '';
    html += '<div class="quest-section-title">진행 가능 · 진행 중</div>';
    html += active.length ? active.map(questCard).join('') : '<div class="q-meta" style="color:var(--muted)">현재 작업지시가 없습니다.</div>';
    if (myDone.length) {
      html += '<div class="quest-section-title">내 최근 완료</div>';
      html += myDone.map(questCard).join('');
    }
    $('quest-list').innerHTML = html;

    $('quest-list').querySelectorAll('.q-accept').forEach(b => {
      b.onclick = () => socket.emit('quest:accept', { id: Number(b.dataset.id) }, (res) => {
        if (res?.error) toast('⚠ ' + res.error); else toast('✋ 작업지시를 수락했습니다.');
      });
    });
    $('quest-list').querySelectorAll('.q-show-complete').forEach(b => {
      b.onclick = () => $('qform-' + b.dataset.id).classList.toggle('open');
    });
    $('quest-list').querySelectorAll('.q-submit').forEach(b => {
      b.onclick = () => {
        const form = $('qform-' + b.dataset.id);
        socket.emit('quest:complete', {
          id: Number(b.dataset.id),
          qtyGood: form.querySelector('.q-good').value,
          qtyDefect: form.querySelector('.q-defect').value,
          note: form.querySelector('.q-note').value.trim(),
        }, (res) => {
          if (res?.error) toast('⚠ ' + res.error);
        });
      };
    });
    // 입력 중 캐릭터 이동 방지
    $('quest-list').querySelectorAll('input').forEach(i => {
      i.addEventListener('focus', () => FW.typing = true);
      i.addEventListener('blur', () => FW.typing = false);
    });
  }

  $('quest-toggle').onclick = () => {
    const p = $('quest-panel');
    if (p.classList.contains('open')) { p.classList.remove('open'); return; }
    $('board-panel').classList.remove('open');
    p.classList.add('open');
    renderQuests();
    refreshQuests();
  };
  $('quest-close').onclick = () => $('quest-panel').classList.remove('open');

  function renderBoard(data) {
    const me = data.me;
    $('board-me').innerHTML = `<b>${esc(me.name)}</b>${me.team ? ` <span style="color:var(--accent)">[${esc(me.team)}]</span>` : ''} — Lv.${me.level} · ${me.points.toLocaleString()}P
      <span style="color:var(--muted)">(다음 레벨까지 ${(me.nextLevelAt - me.points).toLocaleString()}P)</span>
      <div class="b-badges">${me.badges.length ? me.badges.map(b => `${b.icon} ${esc(b.name)}`).join(' · ') : '획득한 뱃지가 없습니다'}</div>`;
    let html = '<div class="quest-section-title">개인 순위</div>';
    html += data.top.length ? data.top.map((r, i) => `
      <div class="board-row" ${r.id === FW.myUserId ? 'style="background:rgba(79,195,247,.08);border-radius:6px"' : ''}>
        <span class="b-rank top${i + 1}">${i + 1}</span>
        <span class="b-name">${esc(r.name)}</span>
        <span class="b-lv">Lv.${r.level}</span>
        <span class="b-pts">${r.points.toLocaleString()}P</span>
        <span class="b-lv">🏅${r.badges}</span>
      </div>`).join('') : '<div class="q-meta" style="color:var(--muted)">아직 포인트 기록이 없습니다.</div>';
    if (data.teams && data.teams.length) {
      html += '<div class="quest-section-title" style="margin-top:14px">팀 순위</div>';
      html += data.teams.map((t, i) => `
        <div class="board-row" ${t.team === me.team ? 'style="background:rgba(79,195,247,.08);border-radius:6px"' : ''}>
          <span class="b-rank top${i + 1}">${i + 1}</span>
          <span class="b-name">${esc(t.team)} <span style="color:var(--muted);font-size:11px">(${t.members}명)</span></span>
          <span class="b-pts">${t.points.toLocaleString()}P</span>
        </div>`).join('');
    }
    $('board-list').innerHTML = html;
  }

  // ── 비밀번호 변경 ──────────────────────
  $('btn-pw').onclick = () => { $('pw-panel').classList.toggle('open'); $('pw-msg').textContent = ''; };
  $('pw-close').onclick = () => $('pw-panel').classList.remove('open');
  ['pw-old', 'pw-new', 'pw-new2'].forEach(id => {
    $(id).addEventListener('focus', () => FW.typing = true);
    $(id).addEventListener('blur', () => FW.typing = false);
  });
  $('pw-submit').onclick = async () => {
    const oldPw = $('pw-old').value, nw = $('pw-new').value, nw2 = $('pw-new2').value;
    if (nw !== nw2) { $('pw-msg').textContent = '⚠ 새 비밀번호가 서로 다릅니다.'; return; }
    try {
      const res = await fetch('/api/password/change', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
        body: JSON.stringify({ oldPassword: oldPw, newPassword: nw }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '변경 실패');
      $('pw-old').value = $('pw-new').value = $('pw-new2').value = '';
      $('pw-panel').classList.remove('open');
      toast('🔑 비밀번호가 변경되었습니다.');
    } catch (e) { $('pw-msg').textContent = '⚠ ' + e.message; }
  };

  $('board-toggle').onclick = () => {
    const p = $('board-panel');
    if (p.classList.contains('open')) { p.classList.remove('open'); return; }
    $('quest-panel').classList.remove('open');
    socket.emit('leaderboard:get', (data) => { if (data) { renderBoard(data); p.classList.add('open'); } });
  };
  $('board-close').onclick = () => $('board-panel').classList.remove('open');

  // ── 유틸 ──────────────────────────────
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtSize(n) {
    if (n < 1024) return n + 'B';
    if (n < 1048576) return (n / 1024).toFixed(1) + 'KB';
    return (n / 1048576).toFixed(1) + 'MB';
  }
})();
