// Generates the Factory World intro artboards (.dc.html) + canvas.json
import { writeFileSync } from 'node:fs';

const W = 1200;

// ── palette (lifted from public/css/style.css and docs/구축경과보고.html)
const D = { bg: '#0d0f17', panel: '#161a26', panel2: '#1e2333', border: '#2c3348', text: '#e6e9f2', muted: '#8b93a8', accent: '#4fc3f7' };
const S = { run: '#34d399', idle: '#fbbf24', stop: '#f87171', alarm: '#ef4444' };
const L = { bg: '#f4f6fa', surface: '#ffffff', ink: '#1a2230', muted: '#5b6478', line: '#dde3ee', accent: '#1c7fb5', soft: '#e3f1f9', ok: '#15803d', warn: '#b45309', chip: '#eef2f8' };
const FONT = '"Noto Sans KR", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';

const head = (dark) => `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;900&amp;display=swap">
  <style>
    body { margin: 0; background: ${dark ? D.bg : L.bg}; color: ${dark ? D.text : L.ink}; font-family: ${FONT}; line-height: 1.65; font-size: 15px; -webkit-font-smoothing: antialiased; }
    a { color: ${dark ? D.accent : L.accent}; } a:hover { color: ${dark ? '#8ad8fa' : '#155f88'}; }
    * { box-sizing: border-box; }
    h1, h2, h3, p { margin: 0; }
    table { border-collapse: collapse; width: 100%; }
    th, td { text-align: left; vertical-align: top; }
  </style>
</helmet>
`;
const tail = `</x-dc>
</body>
</html>
`;

// section header (light)
const sectionHead = (num, eyebrow, title, lede) => `
  <div style="display: flex; flex-direction: column; gap: 10px; margin-bottom: 34px;">
    <div style="display: flex; align-items: center; gap: 12px;">
      <span style="display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 6px; background: ${L.ink}; color: #ffffff; font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums;">${num}</span>
      <span style="font-size: 12px; letter-spacing: 0.18em; color: ${L.accent}; font-weight: 700;">${eyebrow}</span>
    </div>
    <h2 style="font-size: 30px; line-height: 1.3; letter-spacing: -0.01em; font-weight: 700; text-wrap: balance;">${title}</h2>
    ${lede ? `<p style="color: ${L.muted}; font-size: 16px; max-width: 64ch;">${lede}</p>` : ''}
  </div>`;

// ── SVG helpers: isometric cubes
const TW = 64, TH = 32;
const iso = (i, j, ox, oy) => [ox + (i - j) * (TW / 2), oy + (i + j) * (TH / 2)];
const tile = (i, j, ox, oy, fill, stroke) => {
  const [x, y] = iso(i, j, ox, oy);
  return `<polygon points="${x},${y} ${x + TW / 2},${y + TH / 2} ${x},${y + TH} ${x - TW / 2},${y + TH / 2}" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`;
};
const cube = (i, j, ox, oy, h, top, left, right, stroke = 'rgba(0,0,0,.35)') => {
  const [x, y] = iso(i, j, ox, oy);
  const t = `${x},${y - h} ${x + TW / 2},${y + TH / 2 - h} ${x},${y + TH - h} ${x - TW / 2},${y + TH / 2 - h}`;
  const lf = `${x - TW / 2},${y + TH / 2 - h} ${x},${y + TH - h} ${x},${y + TH} ${x - TW / 2},${y + TH / 2}`;
  const rf = `${x},${y + TH - h} ${x + TW / 2},${y + TH / 2 - h} ${x + TW / 2},${y + TH / 2} ${x},${y + TH}`;
  return `<polygon points="${lf}" fill="${left}" stroke="${stroke}" stroke-width="1"/><polygon points="${rf}" fill="${right}" stroke="${stroke}" stroke-width="1"/><polygon points="${t}" fill="${top}" stroke="${stroke}" stroke-width="1"/>`;
};
const statusCap = (i, j, ox, oy, h, color) => {
  const [x, y] = iso(i, j, ox, oy);
  const cx = x, cy = y + TH / 2 - h;
  return `<ellipse cx="${cx}" cy="${cy}" rx="9" ry="4.5" fill="${color}"/>`;
};
const person = (x, y, color, label) => `
  <ellipse cx="${x}" cy="${y + 12}" rx="10" ry="4" fill="rgba(0,0,0,.35)"/>
  <rect x="${x - 6}" y="${y - 10}" width="12" height="16" rx="3" fill="${color}"/>
  <circle cx="${x}" cy="${y - 16}" r="6" fill="#f3d9b1"/>
  ${label ? `<text x="${x}" y="${y - 27}" text-anchor="middle" font-size="10" font-weight="700" fill="${color}" font-family="${FONT.replace(/"/g, '&quot;')}">${label}</text>` : ''}`;

// ── Hero map (dark)
function heroMap() {
  const ox = 300, oy = 40;
  const zones = [
    { i0: 0, j0: 0, n: 3, fill: 'rgba(79,195,247,.14)' },
    { i0: 3, j0: 0, n: 3, fill: 'rgba(52,211,153,.12)' },
    { i0: 0, j0: 3, n: 3, fill: 'rgba(251,191,36,.10)' },
    { i0: 3, j0: 3, n: 3, fill: 'rgba(248,113,113,.10)' },
  ];
  let s = '';
  for (const z of zones) for (let i = 0; i < z.n; i++) for (let j = 0; j < z.n; j++) s += tile(z.i0 + i, z.j0 + j, ox, oy, z.fill, 'rgba(255,255,255,.08)');
  const eq = [
    { i: 1, j: 1, st: S.run }, { i: 4, j: 1, st: S.run }, { i: 4, j: 4, st: S.idle }, { i: 1, j: 4, st: S.alarm }, { i: 3, j: 3, st: S.run },
  ];
  for (const e of eq.sort((a, b) => (a.i + a.j) - (b.i + b.j))) {
    s += cube(e.i, e.j, ox, oy, 34, '#2b3a55', '#1a2439', '#223050');
    s += statusCap(e.i, e.j, ox, oy, 34, e.st);
    if (e.st === S.alarm) { const [x, y] = iso(e.i, e.j, ox, oy); s += `<ellipse cx="${x}" cy="${y + TH / 2}" rx="40" ry="20" fill="none" stroke="${S.alarm}" stroke-width="1.5" opacity=".7"/><ellipse cx="${x}" cy="${y + TH / 2}" rx="54" ry="27" fill="none" stroke="${S.alarm}" stroke-width="1" opacity=".35"/>`; }
  }
  const [ax, ay] = iso(2, 4, ox, oy); const [bx, by] = iso(1, 5, ox, oy);
  s += person(ax, ay + 10, '#4fc3f7', 'A') + person(bx + 6, by + 6, '#ffa03c', 'B');
  const [px, py] = iso(1, 4, ox, oy);
  s += `<g><rect x="${px - 44}" y="${py - 96}" width="88" height="24" rx="6" fill="${D.panel}" stroke="${D.border}"/><text x="${px}" y="${py - 80}" text-anchor="middle" font-size="11" font-weight="700" fill="${D.text}" font-family="${FONT.replace(/"/g, '&quot;')}">프레스 3호기</text><polygon points="${px - 5},${py - 72} ${px + 5},${py - 72} ${px},${py - 66}" fill="${D.panel}" stroke="${D.border}"/></g>`;
  return `<svg viewBox="0 0 600 300" width="600" height="300" xmlns="http://www.w3.org/2000/svg" style="display: block;">${s}</svg>`;
}

const legendDot = (c, t) => `<span style="display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: ${D.muted};"><span style="width: 10px; height: 10px; border-radius: 50%; background: ${c}; box-shadow: 0 0 8px ${c};"></span>${t}</span>`;

const Main = head(true) + `
<div style="width: ${W}px; min-height: 660px; padding: 64px 72px 44px; display: flex; flex-direction: column; justify-content: space-between; gap: 40px; background: radial-gradient(1200px 500px at 50% 115%, rgba(79,195,247,.18), transparent 60%), radial-gradient(700px 300px at 20% 100%, rgba(255,160,60,.12), transparent 60%), linear-gradient(180deg, #0a0c14 0%, #10131f 55%, #171c2c 100%);">
  <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 48px; align-items: center;">
    <div style="display: flex; flex-direction: column; gap: 18px;">
      <div style="font-size: 12px; letter-spacing: 0.3em; color: ${D.muted}; font-weight: 500;">사내 소개 · ICT 총괄 · 2026</div>
      <h1 style="font-size: 54px; font-weight: 900; letter-spacing: 8px; line-height: 1.1; background: linear-gradient(180deg, #dff3ff, #4fc3f7 70%, #2a86b8); -webkit-background-clip: text; background-clip: text; color: transparent;">FACTORY WORLD</h1>
      <div style="font-size: 17px; font-weight: 700; color: ${D.text}; letter-spacing: 0.02em;">게임형 MES <span style="color: ${D.muted}; font-weight: 400;">·</span> 디지털 트윈형 협업 MES</div>
      <p style="font-size: 17px; line-height: 1.75; color: #c3c9d8; max-width: 44ch; text-wrap: pretty;">공장을 게임 맵으로 옮겼습니다. 작업자는 자기 캐릭터로 설비 앞에 모여 협업하고, 그 대화·파일·조치는 설비 이력으로 자동 기록됩니다.</p>
      <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px;">
        <span style="border: 1px solid ${D.border}; background: rgba(22,26,38,.85); border-radius: 20px; padding: 5px 13px; font-size: 12.5px; color: ${D.text};">공장 = 맵</span>
        <span style="border: 1px solid ${D.border}; background: rgba(22,26,38,.85); border-radius: 20px; padding: 5px 13px; font-size: 12.5px; color: ${D.text};">작업자 = 캐릭터</span>
        <span style="border: 1px solid ${D.border}; background: rgba(22,26,38,.85); border-radius: 20px; padding: 5px 13px; font-size: 12.5px; color: ${D.text};">설비 상태 = HUD</span>
        <span style="border: 1px solid ${D.border}; background: rgba(22,26,38,.85); border-radius: 20px; padding: 5px 13px; font-size: 12.5px; color: ${D.text};">협업 = 근접 대화</span>
      </div>
    </div>
    <div style="display: flex; flex-direction: column; align-items: center; gap: 14px;">
      ${heroMap()}
      <div style="display: flex; gap: 18px;">${legendDot(S.run, '가동')}${legendDot(S.idle, '대기')}${legendDot(S.stop, '정지')}${legendDot(S.alarm, '알람')}</div>
    </div>
  </div>
  <div style="display: flex; align-items: center; justify-content: space-between; gap: 24px; border-top: 1px solid ${D.border}; padding-top: 22px;">
    <div style="display: flex; align-items: center; gap: 14px;">
      <code style="font-family: Consolas, 'D2Coding', monospace; font-size: 13px; background: #0e1220; border: 1px solid ${D.border}; border-radius: 6px; padding: 6px 12px; color: ${D.accent};">npm install &amp;&amp; npm start</code>
      <span style="font-size: 13px; color: ${D.muted};">한 줄로 사내 PC 어디서나 실행 · 외부 인프라 없음</span>
    </div>
    <div style="font-size: 12px; letter-spacing: 0.25em; color: ${D.muted};">기안 『게임형 MES 시스템 구축 기안 및 기본설계서』 기반</div>
  </div>
</div>
` + tail;

// ── 01 Problem → Solution
const ico = (path) => `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex: none;">${path}</svg>`;
const I = {
  grid: ico('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>'),
  scatter: ico('<path d="M4 6h10M4 12h16M4 18h7"/><circle cx="18" cy="6" r="2"/><circle cx="15" cy="18" r="2"/>'),
  eye: ico('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M4 4l16 16"/>'),
  map: ico('<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 12l9 5 9-5"/><path d="M3 16l9 5 9-5"/>'),
  user: ico('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>'),
  hud: ico('<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M7 14l2-3 2 2 3-5 3 4"/><path d="M8 21h8"/>'),
  chat: ico('<path d="M4 5h16v11H9l-5 4V5z"/><path d="M8 9h8M8 12h5"/>'),
};
const problemItem = (icon, title, desc) => `
  <div style="display: flex; gap: 14px; align-items: flex-start;">
    <div style="width: 40px; height: 40px; border-radius: 8px; background: ${L.chip}; color: ${L.muted}; display: flex; align-items: center; justify-content: center; flex: none;">${icon}</div>
    <div style="display: flex; flex-direction: column; gap: 3px;">
      <h3 style="font-size: 16px; font-weight: 700;">${title}</h3>
      <p style="font-size: 14px; color: ${L.muted}; line-height: 1.6;">${desc}</p>
    </div>
  </div>`;
const solutionItem = (icon, eq, title, desc, bench) => `
  <div style="display: flex; gap: 14px; align-items: flex-start; padding: 16px 18px; background: ${L.surface}; border: 1px solid ${L.line}; border-radius: 10px;">
    <div style="width: 40px; height: 40px; border-radius: 8px; background: ${L.soft}; color: ${L.accent}; display: flex; align-items: center; justify-content: center; flex: none;">${icon}</div>
    <div style="display: flex; flex-direction: column; gap: 4px; flex: 1;">
      <div style="display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;">
        <h3 style="font-size: 16px; font-weight: 700;">${eq}</h3>
        ${bench ? `<span style="font-size: 11.5px; color: ${L.muted}; border: 1px solid ${L.line}; border-radius: 12px; padding: 1px 9px;">벤치마킹 · ${bench}</span>` : ''}
      </div>
      <p style="font-size: 14px; color: ${L.ink}; line-height: 1.6;">${title}</p>
      <p style="font-size: 13.5px; color: ${L.muted}; line-height: 1.6;">${desc}</p>
    </div>
  </div>`;

const Problem = head(false) + `
<div style="width: ${W}px; min-height: 680px; padding: 64px 72px;">
  ${sectionHead('01', '왜 만들었나', '표와 그리드 화면을 벗어나, 공장을 한 장의 맵으로', '기존 MES가 현장에서 겪는 세 가지 문제에 대해, 게임의 문법을 빌린 네 가지 답을 내놓았습니다.')}
  <div style="display: grid; grid-template-columns: 400px 56px minmax(0, 1fr); gap: 0; align-items: start;">
    <div style="display: flex; flex-direction: column; gap: 22px; padding: 26px 24px; background: ${L.chip}; border: 1px solid ${L.line}; border-radius: 12px;">
      <div style="font-size: 12px; letter-spacing: 0.16em; color: ${L.muted}; font-weight: 700;">기존 MES의 문제</div>
      ${problemItem(I.grid, '낮은 몰입도와 사용률', '표·그리드 화면이라 현장 몰입도가 낮습니다. 입력 회피와 형식적 사용이 만연합니다.')}
      ${problemItem(I.scatter, '흩어지는 대응 이력', '설비 이슈 대응이 전화·메신저에 흩어져 조직의 자산으로 남지 않습니다.')}
      ${problemItem(I.eye, '가시성 부족', '관리자와 현장이 같은 그림을 보지 못합니다.')}
    </div>
    <div style="display: flex; align-items: center; justify-content: center; height: 100%; min-height: 300px; color: ${L.accent};">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h15"/><path d="M13 6l6 6-6 6"/></svg>
    </div>
    <div style="display: flex; flex-direction: column; gap: 12px;">
      <div style="font-size: 12px; letter-spacing: 0.16em; color: ${L.accent}; font-weight: 700; padding: 0 4px;">해법 · 공장을 게임 맵으로</div>
      ${solutionItem(I.map, '공장 = 맵', '실제 레이아웃을 아이소메트릭(쿼터뷰) 타일맵으로 재현합니다.', '설비는 건물, 공정 구역은 존(Zone)으로 표현합니다.', '심시티')}
      ${solutionItem(I.user, '작업자 = 캐릭터', '로그인하면 자기 캐릭터로 "출근"합니다.', '색상·닉네임·직무 뱃지로 누가 어디에 있는지 한눈에 보입니다.', '')}
      ${solutionItem(I.hud, '설비 상태 = HUD', '설비를 클릭하면 게임식 상태창이 열립니다.', '가동/대기/정지/알람, 지속 시간, 금일 가동률(HP바), 이력, 첨부.', '')}
      ${solutionItem(I.chat, '협업 = 근접 대화', '두 명 이상이 같은 설비 근처에 모이면 그 설비 이름의 대화방이 자동으로 열립니다.', '대화·파일·조치가 그 설비의 이력으로 자동 기록됩니다.', '게더타운')}
    </div>
  </div>
</div>
` + tail;

// ── 02 Scenario
function panelSvg(step) {
  const ox = 88, oy = 22; const cubeCol = ['#c9d3e6', '#98a6c2', '#aebbd6'];
  let s = '';
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) s += tile(i, j, ox, oy, i === 1 && j === 1 ? '#e3f1f9' : '#ffffff', L.line);
  const press = (st) => cube(1, 1, ox, oy, 26, cubeCol[0], cubeCol[1], cubeCol[2], 'rgba(26,34,48,.35)') + statusCap(1, 1, ox, oy, 26, st);
  const [px, py] = iso(1, 1, ox, oy);
  const font = FONT.replace(/"/g, '&quot;');
  if (step === 1) {
    s += press(S.alarm);
    s += `<ellipse cx="${px}" cy="${py + 16}" rx="34" ry="17" fill="none" stroke="${S.alarm}" stroke-width="1.5" opacity=".8"/><ellipse cx="${px}" cy="${py + 16}" rx="48" ry="24" fill="none" stroke="${S.alarm}" stroke-width="1" opacity=".4"/>`;
    s += `<g transform="translate(${px + 44},${py - 44})"><circle cx="0" cy="0" r="13" fill="${S.alarm}"/><path d="M-4 3h8M-5 3c0-6 1-8 5-8s5 2 5 8M-1.5 5h3" stroke="#ffffff" stroke-width="1.6" fill="none" stroke-linecap="round"/></g>`;
    s += `<text x="${px}" y="${py + 52}" text-anchor="middle" font-size="10.5" font-weight="700" fill="${S.alarm}" font-family="${font}">3번 프레스 · ALARM</text>`;
  } else if (step === 2) {
    s += press(S.alarm);
    s += `<path d="M${px - 74} ${py + 42} C ${px - 50} ${py + 40}, ${px - 36} ${py + 32}, ${px - 22} ${py + 26}" stroke="#4fc3f7" stroke-width="1.5" stroke-dasharray="3 3" fill="none"/>`;
    s += `<path d="M${px + 74} ${py + 42} C ${px + 50} ${py + 40}, ${px + 36} ${py + 32}, ${px + 22} ${py + 26}" stroke="#ffa03c" stroke-width="1.5" stroke-dasharray="3 3" fill="none"/>`;
    s += person(px - 76, py + 36, '#4fc3f7', 'A') + person(px + 76, py + 36, '#ffa03c', 'B');
    s += `<text x="${px - 76}" y="${py + 62}" text-anchor="middle" font-size="9.5" fill="${L.muted}" font-family="${font}">현장</text><text x="${px + 76}" y="${py + 62}" text-anchor="middle" font-size="9.5" fill="${L.muted}" font-family="${font}">사무실</text>`;
  } else if (step === 3) {
    s += press(S.alarm);
    s += person(px - 24, py + 34, '#4fc3f7', '') + person(px + 24, py + 34, '#ffa03c', '');
    s += `<ellipse cx="${px}" cy="${py + 40}" rx="46" ry="16" fill="none" stroke="${L.accent}" stroke-width="1.2" stroke-dasharray="4 3"/>`;
    s += `<g><rect x="${px - 42}" y="${py - 50}" width="84" height="24" rx="6" fill="${L.ink}"/><text x="${px}" y="${py - 34}" text-anchor="middle" font-size="10.5" font-weight="700" fill="#ffffff" font-family="${font}">프레스 3호기</text><polygon points="${px - 5},${py - 26} ${px + 5},${py - 26} ${px},${py - 20}" fill="${L.ink}"/></g>`;
  } else if (step === 4) {
    s = '';
    s += `<rect x="14" y="16" width="148" height="88" rx="8" fill="#ffffff" stroke="${L.line}"/>`;
    s += `<rect x="24" y="26" width="8" height="8" rx="4" fill="#4fc3f7"/><text x="37" y="34" font-size="9.5" font-weight="700" fill="${L.ink}" font-family="${font}">A</text>`;
    s += `<g transform="translate(24,40)"><rect width="60" height="22" rx="4" fill="${L.soft}"/><rect x="6" y="5" width="12" height="12" rx="2" fill="none" stroke="${L.accent}" stroke-width="1.4"/><circle cx="10" cy="9" r="1.5" fill="${L.accent}"/><path d="M7 15l4-4 3 3 2-2 2 3" stroke="${L.accent}" stroke-width="1.2" fill="none"/><text x="24" y="15" font-size="9" fill="${L.ink}" font-family="${font}">현장 사진</text></g>`;
    s += `<rect x="144" y="66" width="8" height="8" rx="4" fill="#ffa03c" transform="translate(-118,4)"/><text x="39" y="78" font-size="9.5" font-weight="700" fill="${L.ink}" font-family="${font}">B</text>`;
    s += `<g transform="translate(24,82)"><rect width="80" height="16" rx="4" fill="#fff3e6"/><path d="M6 3h6l3 3v7H6z" fill="none" stroke="#b45309" stroke-width="1.2"/><text x="20" y="12" font-size="9" fill="${L.ink}" font-family="${font}">점검 매뉴얼.pdf</text></g>`;
  } else if (step === 5) {
    s = '';
    s += `<rect x="14" y="14" width="148" height="92" rx="8" fill="#ffffff" stroke="${L.line}"/>`;
    s += `<text x="24" y="31" font-size="9.5" font-weight="700" fill="${L.muted}" letter-spacing="1" font-family="${font}">설비 이력 · 프레스 3호기</text>`;
    const rows = [[S.alarm, 60], ['#4fc3f7', 76], ['#ffa03c', 52], [S.run, 68]];
    rows.forEach(([c, w], k) => { const y = 42 + k * 15; s += `<circle cx="28" cy="${y}" r="3" fill="${c}"/><rect x="36" y="${y - 3}" width="${w}" height="6" rx="3" fill="${L.line}"/>`; });
    s += `<g transform="translate(132,40)"><circle cx="0" cy="0" r="12" fill="${S.run}"/><path d="M-5 0l3.5 3.5L6 -4" stroke="#ffffff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g>`;
    s += `<g transform="translate(110,78)"><circle cx="0" cy="0" r="8" fill="none" stroke="${L.muted}" stroke-width="1.5"/><path d="M6 6l6 6" stroke="${L.muted}" stroke-width="1.5" stroke-linecap="round"/></g>`;
  }
  return `<svg viewBox="0 0 176 120" width="176" height="120" xmlns="http://www.w3.org/2000/svg" style="display: block;">${s}</svg>`;
}
const stepCard = (n, title, desc, meta) => `
  <div style="display: flex; flex-direction: column; gap: 12px; background: ${L.surface}; border: 1px solid ${L.line}; border-radius: 12px; padding: 16px 16px 18px; position: relative;">
    <div style="position: absolute; top: -14px; left: 16px; width: 28px; height: 28px; border-radius: 50%; background: ${L.ink}; color: #ffffff; font-size: 13px; font-weight: 700; display: flex; align-items: center; justify-content: center; border: 3px solid ${L.bg};">${n}</div>
    <div style="margin-top: 6px; display: flex; justify-content: center;">${panelSvg(n)}</div>
    <h3 style="font-size: 15.5px; font-weight: 700; line-height: 1.4;">${title}</h3>
    <p style="font-size: 13.5px; color: ${L.muted}; line-height: 1.6; text-wrap: pretty;">${desc}</p>
    ${meta ? `<p style="font-size: 12px; color: ${L.accent}; font-weight: 500; margin-top: auto;">${meta}</p>` : ''}
  </div>`;

const Scenario = head(false) + `
<div style="width: ${W}px; min-height: 640px; padding: 64px 72px;">
  ${sectionHead('02', '대표 시나리오 · 설비 이상 대응', '3번 프레스에 알람이 울리면', '현장 작업자와 사무실의 보전 담당이 같은 설비 앞에 "모여" 조치하고, 그 과정이 자동으로 기록되는 흐름입니다.')}
  <div style="position: relative; padding-top: 12px;">
    <div style="position: absolute; left: 60px; right: 60px; top: 90px; height: 2px; background: ${L.line};"></div>
    <div style="display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 16px; position: relative;">
      ${stepCard(1, '알람 발생', '3번 프레스에 알람. 맵 위 설비가 붉게 점멸하고 담당자에게 알림이 갑니다.', '')}
      ${stepCard(2, '설비 앞으로 이동', '현장 작업자 A와 사무실의 보전 담당 B가 각자 캐릭터를 3번 프레스 앞으로 이동합니다.', '')}
      ${stepCard(3, '대화방 자동 활성화', '근접하는 순간 ‘프레스 3호기’ 대화방이 열립니다. 근접 판정은 서버가 합니다.', '같은 설비 반경 2.4타일')}
      ${stepCard(4, '사진·매뉴얼 공유', 'A가 현장 사진을 올리고, B가 점검 매뉴얼 PDF를 전달해 조치 방법을 합의합니다.', '')}
      ${stepCard(5, '조치 완료 · 이력 저장', '대화·파일·소요 시간이 설비 이력으로 저장됩니다. 이후 같은 이슈에서 검색할 수 있습니다.', 'append-only 기록')}
    </div>
  </div>
  <div style="margin-top: 30px; display: flex; align-items: center; gap: 12px; padding: 14px 18px; background: ${L.soft}; border: 1px solid ${L.line}; border-radius: 8px; font-size: 14px; max-width: 78ch;">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${L.accent}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex: none;"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>
    <span>이 시나리오는 브라우저 2개 탭(작업자 / 보전·관리자)의 <b style="color: ${L.accent};">2인 동시 접속</b>으로 실제 동작을 검증했습니다.</span>
  </div>
</div>
` + tail;

// ── 03 Principles
const principle = (n, title, desc) => `
  <div style="display: flex; flex-direction: column; gap: 10px; background: ${L.surface}; border: 1px solid ${L.line}; border-radius: 12px; padding: 22px 22px 24px;">
    <div style="font-size: 12px; font-weight: 700; color: ${L.accent}; letter-spacing: 0.12em; font-variant-numeric: tabular-nums;">원칙 ${n}</div>
    <h3 style="font-size: 17px; font-weight: 700; line-height: 1.4; text-wrap: balance;">${title}</h3>
    <p style="font-size: 14px; color: ${L.muted}; line-height: 1.65; text-wrap: pretty;">${desc}</p>
  </div>`;
const Principles = head(false) + `
<div style="width: ${W}px; min-height: 520px; padding: 64px 72px;">
  ${sectionHead('03', '설계 원칙', '여섯 가지 원칙으로 범위를 좁히고, 기록의 신뢰를 지켰습니다', '')}
  <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px;">
    ${principle('1', '완성형을 처음부터 만들지 않는다', 'Phase 1은 "맵 + 협업"에만 집중합니다. 설비 연동(P2), 생산관리·게임성(P3)은 모듈로 추가합니다.')}
    ${principle('2', '맵과 설비는 코드가 아니라 데이터', '관리자 콘솔의 맵 에디터에서 존 영역·설비 배치·라인 연결을 드래그로 바꿉니다. 코드 수정이 없습니다.')}
    ${principle('3', '수동 상태 변경과 자동 수집은 같은 이벤트 규격', '그래서 MQTT 실연동을 붙일 때 게임 화면은 한 줄도 고치지 않았습니다.')}
    ${principle('4', '근접 판정은 서버가 한다', '누가 언제 어느 설비 앞에 있었는지, 기록의 신뢰성을 위해서입니다.')}
    ${principle('5', '기록은 append-only', '대화·파일·상태 변경은 수정·삭제할 수 없습니다. 감사 추적이 가능합니다.')}
    ${principle('6', '재미가 업무를 방해하지 않게', '1단계는 시각화와 협업에 집중하고, 게이미피케이션은 3단계로 유보했습니다.')}
  </div>
</div>
` + tail;

// ── 04 Process (roadmap + timeline)
const th = (t) => `<th style="font-size: 12px; letter-spacing: 0.06em; color: ${L.muted}; font-weight: 600; padding: 10px 14px; border-bottom: 1px solid ${L.line}; white-space: nowrap;">${t}</th>`;
const td = (t, extra = '') => `<td style="padding: 11px 14px; border-bottom: 1px solid ${L.line}; font-size: 13.5px; line-height: 1.55; ${extra}">${t}</td>`;
const roadmapRow = (phase, plan, actual, last) => `<tr>${td(`<b style="white-space: nowrap;">${phase}</b>`, last ? 'border-bottom: none;' : '')}${td(plan, last ? 'border-bottom: none;' : '')}${td(actual, `color: ${L.ink}; ${last ? 'border-bottom: none;' : ''}`)}</tr>`;
const tStep = (n, tag, title, desc) => `
  <div style="display: flex; gap: 14px; align-items: flex-start;">
    <div style="width: 26px; height: 26px; border-radius: 50%; background: ${L.accent}; color: #ffffff; font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex: none; margin-top: 2px;">${n}</div>
    <div style="display: flex; flex-direction: column; gap: 2px;">
      <div style="font-size: 11px; color: ${L.accent}; font-weight: 700; letter-spacing: 0.08em;">${tag}</div>
      <h3 style="font-size: 15px; font-weight: 700;">${title}</h3>
      <p style="font-size: 13px; color: ${L.muted}; line-height: 1.55;">${desc}</p>
    </div>
  </div>`;
const Process = head(false) + `
<div style="width: ${W}px; min-height: 780px; padding: 64px 72px;">
  ${sectionHead('04', '어떻게 진행했나', '3단계 로드맵을 세우고, 일곱 번에 나눠 쌓았습니다', '기획서의 단계별 범위와 실제 결과를 나란히 두었습니다. 아래는 구축 경과 보고 기준의 진행 순서입니다.')}
  <div style="background: ${L.surface}; border: 1px solid ${L.line}; border-radius: 10px; overflow: hidden; margin-bottom: 36px;">
    <table>
      <tr>${th('단계')}${th('기획 범위')}${th('실제 결과')}</tr>
      ${roadmapRow('Phase 1 (MVP)', '로그인 · 캐릭터 · 맵 · 상태창 · 다중접속 · 근접대화 · 파일 · 기록 · 관리자 콘솔', '<span style="color: ' + L.ok + '; font-weight: 700;">전부 구현.</span> 2인 동시 접속으로 대표 시나리오 검증', false)}
      ${roadmapRow('Phase 2', '설비 연동 게이트웨이 (OPC-UA / Modbus / MQTT)', 'MQTT는 <span style="color: ' + L.ok + '; font-weight: 700;">실연동(LIVE)</span>, OPC-UA / Modbus는 <span style="color: ' + L.warn + '; font-weight: 700;">시뮬레이션(SIM)</span>', false)}
      ${roadmapRow('Phase 3', '작업지시(퀘스트) · 실적 · 포인트/레벨/리더보드 · 라인 시뮬레이션', '퀘스트, 실적/불량 등록, 포인트·뱃지·개인/팀 리더보드, 심시티식 라인 부하(정체 알림) 구현', true)}
    </table>
  </div>
  <div style="font-size: 12px; letter-spacing: 0.16em; color: ${L.muted}; font-weight: 700; margin-bottom: 18px;">구축 진행 순서</div>
  <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px 40px;">
    ${tStep(1, 'PHASE 1 MVP', '게임형 협업 공간', '타이틀 로그인 → 캐릭터 → 아이소메트릭 맵 입장. 다중 접속, 설비 HUD, 근접 대화, 파일 공유, append-only 기록.')}
    ${tStep(2, 'FR-10', '관리자 콘솔', 'KPI 대시보드 · 대화 로그 검색 · 설비/사용자 마스터 관리 · 알람 대응 리포트.')}
    ${tStep(3, '맵 에디터 + 캐릭터', '데이터 기반 맵 편집, 도트 캐릭터', '존 영역·설비 배치를 드래그로 편집. 캐릭터는 외부 에셋 없이 절차 생성한 도트 스프라이트.')}
    ${tStep(4, 'PHASE 2 게이트웨이', '설비 자동 수집 — MQTT 실연동', '연동 설정을 읽어 상태를 자동 발행. 수동 변경과 같은 이벤트 규격이라 클라이언트 무수정.')}
    ${tStep(5, 'NFR-03', '인증 강화', 'scrypt 비밀번호, JWT 세션, 역할 3종(작업자 / 보전 / 관리자). 서버와 UI에서 이중 차단.')}
    ${tStep(6, 'PHASE 3 게임성', '퀘스트 · 포인트 · 리더보드', '작업지시가 현장에는 퀘스트로 표시. 수락·완료가 설비 이력에 자동 기록. 포인트·레벨·뱃지, 개인·팀 리더보드.')}
    ${tStep(7, '공정 라인 부하', '심시티식 라인 연결 · 정체 관리', '설비 간 라인을 연결하고 재공 부하를 모델링. 하류 정지 시 라인이 녹→황→적으로 변하고 정체 알림.')}
  </div>
</div>
` + tail;

// ── 05 Stack + verification
const stackRow = (plan, mvp, why, last) => `<tr>${td(`<b>${plan}</b>`, last ? 'border-bottom: none;' : '')}${td(mvp, last ? 'border-bottom: none;' : '')}${td(why, `color: ${L.muted}; ${last ? 'border-bottom: none;' : ''}`)}</tr>`;
const verify = (title, desc) => `
  <div style="display: flex; flex-direction: column; gap: 4px; padding: 16px 18px; background: ${L.surface}; border: 1px solid ${L.line}; border-radius: 10px;">
    <h3 style="font-size: 15px; font-weight: 700;">${title}</h3>
    <p style="font-size: 13.5px; color: ${L.muted}; line-height: 1.6;">${desc}</p>
  </div>`;
const Stack = head(false) + `
<div style="width: ${W}px; min-height: 520px; padding: 64px 72px;">
  ${sectionHead('05', 'MVP 기술 선택과 검증', '빨리 검증하려고 단순하게 골랐고, 전환 경로는 남겨 두었습니다', '')}
  <div style="display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 32px; align-items: start;">
    <div style="display: flex; flex-direction: column; gap: 16px;">
      <div style="background: ${L.surface}; border: 1px solid ${L.line}; border-radius: 10px; overflow: hidden;">
        <table>
          <tr>${th('기획서 목표 스택')}${th('MVP 선택')}${th('이유')}</tr>
          ${stackRow('Next.js', '순수 HTML/JS (빌드 없음)', '빠른 검증', false)}
          ${stackRow('NestJS', 'Express 단일 서버', '외부 인프라 0개로 실행', false)}
          ${stackRow('PostgreSQL', 'SQLite (Node 내장)', '스키마는 기획서 데이터 모델 유지', false)}
          ${stackRow('Redis', '메모리 Map', '다중 서버 확장 시 도입', false)}
          ${stackRow('MinIO', '로컬 파일 저장', '사전서명 URL로 전환 가능', false)}
          ${stackRow('Phaser 3 / Socket.IO', '동일', '그대로', true)}
        </table>
      </div>
      <div style="display: flex; align-items: center; gap: 14px; padding: 14px 18px; background: ${L.ink}; border-radius: 10px;">
        <code style="font-family: Consolas, 'D2Coding', monospace; font-size: 13.5px; background: #0e1220; border: 1px solid ${D.border}; border-radius: 6px; padding: 6px 12px; color: ${D.accent}; white-space: nowrap;">npm install &amp;&amp; npm start</code>
        <span style="font-size: 14px; color: #c3c9d8;">한 줄로 사내 PC 어디서나 뜹니다. 외부 인프라가 없습니다.</span>
      </div>
    </div>
    <div style="display: flex; flex-direction: column; gap: 12px;">
      <div style="font-size: 12px; letter-spacing: 0.16em; color: ${L.muted}; font-weight: 700; padding: 0 4px;">검증 방식</div>
      ${verify('브라우저 2개 탭 시나리오 검증', '작업자 / 보전·관리자 동시 접속으로 근접 대화 활성화, 실시간 동기화, 권한 차단, 퀘스트 보상, 라인 정체 알림을 확인했습니다.')}
      ${verify('MQTT 실제 발행', '로컬 브로커를 띄워 실제로 발행하고, 맵 반영과 이력 기록을 확인했습니다.')}
      ${verify('인증 경계 케이스', '누락(400) / 오류(401) / 권한 우회(403) 케이스를 포함해 확인했습니다.')}
    </div>
  </div>
</div>
` + tail;

// ── 06 Floorplan → map (평면도 배경 · 배치 JSON · AI 연동)
const fpFont = FONT.replace(/"/g, '&quot;');
const fpGrid = (ox, oy, cols, rows, cell) => {
  let s = '';
  for (let c = 0; c <= cols; c++) s += `<line x1="${ox + c * cell}" y1="${oy}" x2="${ox + c * cell}" y2="${oy + rows * cell}" stroke="${L.line}" stroke-width="1"/>`;
  for (let r = 0; r <= rows; r++) s += `<line x1="${ox}" y1="${oy + r * cell}" x2="${ox + cols * cell}" y2="${oy + r * cell}" stroke="${L.line}" stroke-width="1"/>`;
  return s;
};
// a schematic top-view floor plan: outer wall, partitions, machine footprints, a conveyor
const fpPlan = (ox, oy, w, h, op) => `
  <g stroke="#6f7d99" stroke-width="1.3" fill="none" opacity="${op}" stroke-linecap="round">
    <rect x="${ox}" y="${oy}" width="${w}" height="${h}"/>
    <path d="M${ox + w * 0.42} ${oy}v${h}M${ox} ${oy + h * 0.55}h${w * 0.42}M${ox + w * 0.42} ${oy + h * 0.5}h${w * 0.58}"/>
    <rect x="${ox + w * 0.07}" y="${oy + h * 0.12}" width="${w * 0.09}" height="${h * 0.18}"/>
    <rect x="${ox + w * 0.24}" y="${oy + h * 0.12}" width="${w * 0.09}" height="${h * 0.18}"/>
    <rect x="${ox + w * 0.07}" y="${oy + h * 0.66}" width="${w * 0.12}" height="${h * 0.2}"/>
    <rect x="${ox + w * 0.5}" y="${oy + h * 0.12}" width="${w * 0.14}" height="${h * 0.14}"/>
    <rect x="${ox + w * 0.74}" y="${oy + h * 0.12}" width="${w * 0.14}" height="${h * 0.14}"/>
    <rect x="${ox + w * 0.52}" y="${oy + h * 0.64}" width="${w * 0.1}" height="${h * 0.22}"/>
    <rect x="${ox + w * 0.78}" y="${oy + h * 0.64}" width="${w * 0.14}" height="${h * 0.12}"/>
    <path d="M${ox + w * 0.16} ${oy + h * 0.21}h${w * 0.08}M${ox + w * 0.64} ${oy + h * 0.19}h${w * 0.1}" stroke-dasharray="3 2"/>
    <path d="M${ox + w * 0.42} ${oy + h * 0.3}h-${w * 0.06}M${ox + w * 0.42} ${oy + h * 0.3}h${w * 0.06}" stroke-width="2"/>
  </g>`;
const fpCursor = (x, y) => `<path transform="translate(${x},${y})" d="M0 0l4.5 12 2.2-4.6 4.8-2.2z" fill="${L.ink}" stroke="#ffffff" stroke-width="1.2" stroke-linejoin="round"/>`;

function fpFigure1() {
  const ox = 10, oy = 8, cell = 20, cols = 14, rows = 8;
  let s = fpGrid(ox, oy, cols, rows, cell);
  s += fpPlan(ox + 6, oy + 6, cols * cell - 12, rows * cell - 12, 0.6);
  // zone being dragged out over the plan
  s += `<rect x="${ox + 2 * cell}" y="${oy + 1 * cell}" width="${5 * cell}" height="${3 * cell}" rx="2" fill="rgba(28,127,181,.12)" stroke="${L.accent}" stroke-width="1.4" stroke-dasharray="5 3"/>`;
  s += `<text x="${ox + 2 * cell + 6}" y="${oy + 1 * cell + 13}" font-size="9" font-weight="700" fill="${L.accent}" font-family="${fpFont}">프레스 존</text>`;
  s += fpCursor(ox + 7 * cell - 2, oy + 4 * cell - 2);
  // two equipment footprints snapped to tiles
  const eqBox = (c, r, st) => `<rect x="${ox + c * cell + 3}" y="${oy + r * cell + 3}" width="${cell - 6}" height="${cell - 6}" rx="2" fill="#c9d3e6" stroke="rgba(26,34,48,.4)"/><circle cx="${ox + c * cell + cell / 2}" cy="${oy + r * cell + cell / 2}" r="3.2" fill="${st}"/>`;
  s += eqBox(3, 2, S.run) + eqBox(5, 2, S.run);
  return `<svg viewBox="0 0 300 176" width="100%" xmlns="http://www.w3.org/2000/svg" style="display: block; width: 100%; height: auto;">${s}</svg>`;
}
function fpFigure3() {
  const ox = 10, oy = 8, cell = 20, cols = 14, rows = 8;
  let s = fpGrid(ox, oy, cols, rows, cell);
  s += fpPlan(ox + 6, oy + 6, cols * cell - 12, rows * cell - 12, 0.32);
  const zone = (c, r, w, h, name, color) => `<rect x="${ox + c * cell + 1}" y="${oy + r * cell + 1}" width="${w * cell - 2}" height="${h * cell - 2}" rx="2" fill="${color}" opacity=".22"/><rect x="${ox + c * cell + 1}" y="${oy + r * cell + 1}" width="${w * cell - 2}" height="${h * cell - 2}" rx="2" fill="none" stroke="${color}" stroke-width="1"/><text x="${ox + c * cell + 5}" y="${oy + r * cell + 11}" font-size="8.5" font-weight="700" fill="${L.ink}" font-family="${fpFont}">${name}</text>`;
  s += zone(0, 0, 6, 4, '프레스 존', '#2d4a6b') + zone(6, 0, 8, 4, '용접 존', '#6b3f2d') + zone(0, 4, 6, 4, '조립 존', '#2d6b4a') + zone(6, 4, 8, 4, '검사/출하', '#5a2d6b');
  const dot = (c, r, code, st) => `<circle cx="${ox + c * cell + cell / 2}" cy="${oy + r * cell + cell / 2}" r="6" fill="#ffffff" stroke="${L.ink}" stroke-width="1.2"/><circle cx="${ox + c * cell + cell / 2}" cy="${oy + r * cell + cell / 2}" r="2.6" fill="${st}"/><text x="${ox + c * cell + cell / 2}" y="${oy + r * cell + cell / 2 + 15}" text-anchor="middle" font-size="7.5" fill="${L.ink}" font-family="${fpFont}">${code}</text>`;
  s += dot(1, 1, 'PRS-01', S.run) + dot(3, 1, 'PRS-02', S.idle) + dot(8, 1, 'WLD-01', S.run) + dot(11, 1, 'WLD-02', S.run) + dot(2, 6, 'ASM-01', S.run) + dot(10, 6, 'INS-01', S.run);
  // link PRS-01 → PRS-02
  s += `<path d="M${ox + 1 * cell + cell / 2 + 7} ${oy + 1 * cell + cell / 2}h${2 * cell - 14}" stroke="${L.ink}" stroke-width="1" marker-end="url(#fpArrow)"/>`;
  // a misplaced equipment being dragged onto the right spot
  const gx = ox + 7 * cell + cell / 2, gy = oy + 6 * cell + cell / 2, tx = ox + 5 * cell + cell / 2, ty = oy + 6 * cell + cell / 2;
  s += `<circle cx="${gx}" cy="${gy}" r="6" fill="none" stroke="${L.muted}" stroke-width="1" stroke-dasharray="2 2"/>`;
  s += `<path d="M${gx - 8} ${gy}H${tx + 9}" stroke="${L.accent}" stroke-width="1.2" stroke-dasharray="3 2"/>`;
  s += `<circle cx="${tx}" cy="${ty}" r="6" fill="#ffffff" stroke="${L.accent}" stroke-width="1.6"/><circle cx="${tx}" cy="${ty}" r="2.6" fill="${S.run}"/><text x="${tx}" y="${ty + 15}" text-anchor="middle" font-size="7.5" font-weight="700" fill="${L.accent}" font-family="${fpFont}">ASM-02</text>`;
  s += fpCursor(tx + 3, ty + 2);
  return `<svg viewBox="0 0 300 176" width="100%" xmlns="http://www.w3.org/2000/svg" style="display: block; width: 100%; height: auto;"><defs><marker id="fpArrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0L6 3 0 6z" fill="${L.ink}"/></marker></defs>${s}</svg>`;
}
const fpControls = `
  <div style="display: flex; align-items: center; gap: 12px; font-size: 11.5px; color: ${L.muted};">
    <span style="white-space: nowrap;">투명도</span>
    <div style="flex: 1; height: 4px; border-radius: 2px; background: ${L.line}; position: relative;">
      <div style="position: absolute; left: 0; top: 0; height: 4px; width: 60%; background: ${L.accent}; border-radius: 2px;"></div>
      <div style="position: absolute; left: 60%; top: -5px; width: 14px; height: 14px; border-radius: 50%; background: #ffffff; border: 2px solid ${L.accent}; margin-left: -7px;"></div>
    </div>
    <span style="display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;">
      <span style="width: 28px; height: 16px; border-radius: 8px; background: ${L.ok}; position: relative; display: inline-block;"><span style="position: absolute; right: 2px; top: 2px; width: 12px; height: 12px; border-radius: 50%; background: #ffffff;"></span></span>
      게임 맵에도 표시
    </span>
  </div>`;
const fpJson = `
  <div style="display: flex; gap: 8px;">
    <span style="display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 700; color: ${L.ink}; border: 1px solid ${L.line}; background: ${L.surface}; border-radius: 6px; padding: 3px 9px;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v13M6 11l6 6 6-6M4 21h16"/></svg>내보내기</span>
    <span style="display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 700; color: #ffffff; background: ${L.accent}; border-radius: 6px; padding: 3px 9px;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17V4M6 10l6-6 6 6M4 21h16"/></svg>가져오기</span>
  </div>
  <div style="font-family: Consolas, 'D2Coding', monospace; font-size: 10px; line-height: 1.6; color: ${L.ink}; background: ${L.surface}; border: 1px solid ${L.line}; border-radius: 6px; padding: 9px 11px; white-space: pre; overflow: hidden; min-width: 0;">{ "map": { "w": 24, "h": 16 },
  "zones": [ {
    <b style="color: ${L.accent};">"name"</b>: "프레스 존",
    "rect": { "x": 1, "y": 1,
              "w": 10, "h": 6 }
  } ],
  "equipments": [ {
    <b style="color: ${L.accent};">"code"</b>: "PRS-01",
    "name": "프레스 1호기",
    "x": 3, "y": 2
  } ],
  "links": [ { "from": "PRS-01",
               "to": "PRS-02" } ]
}</div>
  <div style="font-size: 11.5px; color: ${L.muted};">존은 <b style="color: ${L.accent};">이름</b>, 설비는 <b style="color: ${L.accent};">코드</b> 기준으로 추가·갱신</div>`;
const fpChip = (t, dark) => `<span style="font-size: 11px; font-weight: 700; white-space: nowrap; border-radius: 6px; padding: 3px 8px; ${dark ? `background: ${L.ink}; color: #ffffff;` : `background: ${L.surface}; border: 1px solid ${L.line}; color: ${L.ink};`}">${t}</span>`;
const fpArrowSm = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="${L.muted}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="flex: none;"><path d="M5 12h13M13 6l6 6-6 6"/></svg>`;
const fpFlow = `
  <div style="display: flex; align-items: center; gap: 5px; flex-wrap: wrap;">
    ${fpChip('도면 이미지 + 프롬프트', false)}${fpArrowSm}${fpChip('Claude / Gemini', true)}${fpArrowSm}${fpChip('JSON 초안', false)}${fpArrowSm}${fpChip('가져오기', false)}${fpArrowSm}${fpChip('드래그 검수', false)}
  </div>`;
const fpCard = (n, icon, title, fig, desc, note) => `
  <div style="display: flex; flex-direction: column; gap: 12px; background: ${L.surface}; border: 1px solid ${L.line}; border-radius: 12px; padding: 18px 18px 20px;">
    <div style="display: flex; align-items: center; gap: 10px;">
      <div style="width: 28px; height: 28px; border-radius: 50%; background: ${L.ink}; color: #ffffff; font-size: 13px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex: none;">${n}</div>
      <div style="color: ${L.accent}; display: flex;">${icon}</div>
      <h3 style="font-size: 16px; font-weight: 700;">${title}</h3>
    </div>
    <div style="border: 1px solid ${L.line}; border-radius: 8px; background: ${L.bg}; padding: 10px; display: flex; flex-direction: column; gap: 9px;">${fig}</div>
    <p style="font-size: 13.5px; color: ${L.muted}; line-height: 1.6; text-wrap: pretty;">${desc}</p>
    ${note ? `<p style="font-size: 12px; color: ${L.accent}; font-weight: 500; margin-top: auto;">${note}</p>` : ''}
  </div>`;
const fpBetween = `<div style="display: flex; align-items: center; justify-content: center; color: ${L.accent}; padding-top: 110px;"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h15"/><path d="M13 6l6 6-6 6"/></svg></div>`;
const themeItem = (icon, title, desc) => `
  <div style="display: flex; gap: 12px; align-items: flex-start;">
    <div style="width: 36px; height: 36px; border-radius: 8px; background: ${L.chip}; color: ${L.ink}; display: flex; align-items: center; justify-content: center; flex: none;">${icon}</div>
    <div style="display: flex; flex-direction: column; gap: 2px;">
      <h3 style="font-size: 14.5px; font-weight: 700;">${title}</h3>
      <p style="font-size: 12.5px; color: ${L.muted}; line-height: 1.55;">${desc}</p>
    </div>
  </div>`;
const IFP = {
  image: ico('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 8"/>'),
  braces: ico('<path d="M8 3c-2 0-3 1-3 3v3c0 1.5-1 2.5-2 3 1 .5 2 1.5 2 3v3c0 2 1 3 3 3"/><path d="M16 3c2 0 3 1 3 3v3c0 1.5 1 2.5 2 3-1 .5-2 1.5-2 3v3c0 2-1 3-3 3"/>'),
  spark: ico('<path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/><path d="M19 15l1 2 2 1-2 1-1 2-1-2-2-1 2-1z"/>'),
  moon: ico('<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>'),
  bolt: ico('<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/>'),
  dpad: ico('<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z"/><path d="M12 6v2M12 16v2M6 12h2M16 12h2"/>'),
};
const Floorplan = head(false) + `
<div style="width: ${W}px; min-height: 1140px; padding: 64px 72px;">
  ${sectionHead('06', '도면으로 우리 공장 만들기', '도면이 있으면 반나절이면 우리 공장이 맵이 됩니다', '"맵은 코드가 아니라 데이터"라는 원칙의 실제 사용법입니다. 관리자 콘솔의 맵 에디터에서 세 가지를 제공합니다.')}
  <div style="display: grid; grid-template-columns: minmax(0, 1fr) 28px minmax(0, 1fr) 28px minmax(0, 1fr); gap: 8px; align-items: stretch;">
    ${fpCard(1, IFP.image, '평면도를 배경으로', fpFigure1() + fpControls, '건축 배치도·설비 설계도를 PNG/JPG/WEBP/SVG로 올리면 에디터 격자 아래에 깔립니다. 투명도와 덮을 타일 범위를 맞추고, 그 위에서 존을 드래그하고 설비를 끌어다 놓습니다. "게임 맵에도 표시"를 켜면 현장 화면의 아이소메트릭 바닥에 같은 도면이 투영됩니다.', 'PDF·DWG 도면은 이미지로 내보낸 뒤 사용')}
    ${fpBetween}
    ${fpCard(2, IFP.braces, '배치 데이터 JSON', fpJson, '존·설비·라인을 JSON으로 내보내고 가져옵니다. 존은 이름, 설비는 코드 기준으로 추가·갱신되며 삭제는 하지 않습니다. 이력이 걸려 있는 설비를 보호하기 위해서입니다.', '삭제 없음 · 이력 보호')}
    ${fpBetween}
    ${fpCard(3, IFP.spark, 'Claude / Gemini로 초안', fpFlow + fpFigure3(), '도면 이미지에 정해진 프롬프트(24×16 격자, 좌표 추정 규칙, JSON 스키마)를 붙여 AI에게 주면 배치 JSON 초안이 나옵니다. 가져오기 하면 도면 위에 존과 설비가 겹쳐 보이고, 어긋난 것만 드래그로 바로잡습니다.', 'AI가 초안을 잡고, 사람이 검수')}
  </div>
  <div style="margin-top: 26px; padding: 18px 22px; background: ${L.ink}; color: #ffffff; border-radius: 12px; display: flex; align-items: center; justify-content: space-between; gap: 24px;">
    <p style="font-size: 17px; font-weight: 700; line-height: 1.5;">도면이 있으면 반나절이면 우리 공장이 맵이 된다.</p>
    <p style="font-size: 13.5px; color: #c3c9d8; line-height: 1.6; text-align: right;">손으로 옮기지 않습니다. AI가 초안을 잡고 사람이 검수합니다.</p>
  </div>
  <div style="margin-top: 26px; padding-top: 22px; border-top: 1px solid ${L.line};">
    <div style="font-size: 12px; letter-spacing: 0.16em; color: ${L.muted}; font-weight: 700; margin-bottom: 14px;">화면 테마와 현장 기기</div>
    <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px;">
      ${themeItem(IFP.moon, '흰 바탕(라이트) 테마 전환', '기본은 다크 테마. 상단 버튼으로 흰 바탕으로 바꾸면 맵·상태창·관리자 콘솔이 함께 바뀝니다. 밝은 현장 조명, 경영진 보고 화면, 인쇄용이며 설정은 브라우저에 저장됩니다.')}
      ${themeItem(IFP.bolt, '저사양 모드', '점멸·자재 흐름 애니메이션을 끄고 30fps로 동작해 구형 태블릿에 대응합니다.')}
      ${themeItem(IFP.dpad, '터치 방향 패드', '태블릿 등 터치 기기에서는 좌하단에 방향 패드가 표시됩니다.')}
    </div>
  </div>
</div>
` + tail;

// ── 07 Impact + measurement
const effect = (title, desc) => `
  <div style="display: flex; flex-direction: column; gap: 6px; padding: 20px 20px 22px; background: ${L.surface}; border: 1px solid ${L.line}; border-radius: 12px;">
    <h3 style="font-size: 16px; font-weight: 700; line-height: 1.4;">${title}</h3>
    <p style="font-size: 13.5px; color: ${L.muted}; line-height: 1.6;">${desc}</p>
  </div>`;
const colHead = (t) => `<div style="font-size: 11.5px; color: ${L.muted}; font-weight: 600; letter-spacing: 0.04em; padding: 8px 10px; border-bottom: 1px solid ${L.line}; white-space: nowrap;">${t}</div>`;
const ghostRow = () => `<div style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-bottom: 1px solid ${L.line};">${[64, 40, 48, 70].map(w => `<div style="padding: 10px 10px;"><div style="height: 8px; width: ${w}%; border-radius: 4px; background: ${L.line};"></div></div>`).join('')}</div>`;
const Impact = head(false) + `
<div style="width: ${W}px; min-height: 480px; padding: 64px 72px;">
  ${sectionHead('07', '기대효과와 측정 근거', '"대응 시간 30% 단축"은 리포트로 확인합니다', '기대효과는 네 가지이고, 첫 번째 효과는 관리자 콘솔의 알람 대응 리포트가 숫자로 뒷받침합니다.')}
  <div style="display: grid; grid-template-columns: minmax(0, 1fr) 460px; gap: 32px; align-items: start;">
    <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px;">
      ${effect('이슈 대응 시간 단축', '파일럿 목표: 평균 30% 단축')}
      ${effect('설비별 조치 노하우의 자산화', '대화·파일·조치가 설비 이력으로 남아 다음 이슈에서 검색됩니다.')}
      ${effect('관리자·경영진의 한 화면 가시성', '현장과 관리자가 같은 맵을 봅니다.')}
      ${effect('낮은 진입 장벽 → 자발적 사용', '이후 MES 코어 기능을 확산하는 기반이 됩니다.')}
    </div>
    <div style="display: flex; flex-direction: column; gap: 12px;">
      <div style="font-size: 12px; letter-spacing: 0.16em; color: ${L.accent}; font-weight: 700; padding: 0 4px;">측정 근거 · 알람 대응 리포트</div>
      <div style="background: ${L.surface}; border: 1px solid ${L.line}; border-radius: 10px; overflow: hidden;">
        <div style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));">${colHead('알람 발생 → 해제')}${colHead('대응 시간')}${colHead('해제자')}${colHead('협업 지표')}</div>
        ${ghostRow()}${ghostRow()}${ghostRow()}
        <div style="padding: 10px 12px; font-size: 12px; color: ${L.muted}; text-align: center;">파일럿 데이터가 쌓이면 채워지는 표입니다 (예시 값 없음)</div>
      </div>
      <p style="font-size: 13.5px; color: ${L.muted}; line-height: 1.6; padding: 0 4px;">알람 발생 → 해제 에피소드별로 <b style="color: ${L.ink};">대응 시간, 해제자, 협업 지표(대화 수·참여자·파일)</b>를 기록합니다. 기간·설비 필터와 평균/최장 대응 시간 요약을 제공합니다.</p>
    </div>
  </div>
</div>
` + tail;

// ── 08 Status + next
const covRow = (id, req, st, ok, note, last) => `<tr>${td(`<span style="font-variant-numeric: tabular-nums; white-space: nowrap;">${id}</span>`, last ? 'border-bottom: none;' : '')}${td(req, last ? 'border-bottom: none;' : '')}${td(`<span style="color: ${ok ? L.ok : L.warn}; font-weight: 700; white-space: nowrap;">${st}</span>`, last ? 'border-bottom: none;' : '')}${td(note, `color: ${L.muted}; ${last ? 'border-bottom: none;' : ''}`)}</tr>`;
const task = (title, desc) => `
  <div style="display: flex; gap: 12px; align-items: flex-start;">
    <div style="width: 18px; height: 18px; border-radius: 4px; border: 1.5px solid ${L.muted}; flex: none; margin-top: 3px;"></div>
    <div style="display: flex; flex-direction: column; gap: 2px;">
      <h3 style="font-size: 15px; font-weight: 700;">${title}</h3>
      <p style="font-size: 13px; color: ${L.muted}; line-height: 1.55;">${desc}</p>
    </div>
  </div>`;
const statCard = (label, big, unit, sub, subColor) => `
  <div style="flex: 1; background: ${L.surface}; border: 1px solid ${L.line}; border-radius: 10px; padding: 16px 18px;">
    <div style="font-size: 12px; color: ${L.muted}; letter-spacing: 0.06em;">${label}</div>
    <div style="font-size: 30px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.2; margin-top: 4px;">${big}<span style="font-size: 16px; color: ${L.muted}; font-weight: 400;"> ${unit}</span></div>
    <div style="font-size: 12px; color: ${subColor}; margin-top: 2px; line-height: 1.5;">${sub}</div>
  </div>`;
const usabilityChip = (t) => `<span style="font-size: 12px; color: ${L.ink}; background: ${L.chip}; border: 1px solid ${L.line}; border-radius: 14px; padding: 3px 11px; white-space: nowrap;">${t}</span>`;
const Status = head(false) + `
<div style="width: ${W}px; min-height: 1120px; padding: 64px 72px;">
  ${sectionHead('08', '현재 상태와 다음 단계', '기능 요구사항 13개가 모두 동작하고 운영 기반을 갖췄습니다. 파일럿 라인을 기다리고 있습니다', '')}
  <div style="display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 32px; align-items: start;">
    <div style="display: flex; flex-direction: column; gap: 16px;">
      <div style="display: flex; gap: 12px;">
        ${statCard('기능 요구사항', '13', '/ 13', 'FR-11은 MQTT 실연동, OPC-UA / Modbus는 드라이버 준비(라이브러리 설치 시 연결)', L.muted)}
        ${statCard('외부 인프라', '0', '개', '단일 Node.js 서버로 실행', L.muted)}
        ${statCard('부하 테스트 (동시 50명)', '통과', '', '이동 동기화 p95 20ms · 채팅 12ms<br>(기준 200ms / 1초)', L.ok)}
      </div>
      <div style="background: ${L.surface}; border: 1px solid ${L.line}; border-radius: 10px; overflow: hidden;">
        <table>
          <tr>${th('ID')}${th('요구사항')}${th('상태')}${th('비고')}</tr>
          ${covRow('FR-01~03', '게임형 로그인 · 캐릭터 · 공장 맵', '완료', true, '맵 에디터(평면도 · 배치 JSON), 도트 캐릭터 절차 생성', false)}
          ${covRow('FR-04~05', '설비 상태창 · 다중 접속', '완료', true, '수동 변경 + 자동 수집, 진행률 게이지, 담당자 호출', false)}
          ${covRow('FR-06~09', '근접 대화 · 파일 · 기록 · 알림', '완료', true, '서버 근접 판정, append-only, 출근 브리핑', false)}
          ${covRow('FR-10', '관리자 콘솔', '완료', true, 'KPI · 로그 검색 · 마스터 · 맵 에디터 · 알람 리포트 · 백업', false)}
          ${covRow('FR-11', '설비 연동 (Phase 2)', '완료', true, 'MQTT 실연동. OPC-UA / Modbus 드라이버 준비(실 장비 검증 남음)', false)}
          ${covRow('FR-12~13', '생산관리 · 게이미피케이션 (Phase 3)', 'MVP 완료', true, '작업지시 퀘스트 · 실적 · 포인트/레벨/뱃지/리더보드', false)}
          ${covRow('NFR-01 · 04', '성능 · 운영', '완료', true, '동시 50명 부하 테스트 통과, 매일 자동 백업, 자동 재기동 · 재접속, HTTPS 옵션', false)}
          ${covRow('NFR-03', '보안 (인증 · 권한)', '완료', true, 'scrypt + JWT, 역할 기반. SSO/AD는 미적용', false)}
          ${covRow('NFR-02 · 06', '확장성 · 기록 무결성', '완료', true, '맵·설비 데이터 정의, 이벤트 규격 통일, append-only', true)}
        </table>
      </div>
      <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
        <span style="font-size: 12px; letter-spacing: 0.16em; color: ${L.muted}; font-weight: 700; margin-right: 4px;">현장 사용성</span>
        ${usabilityChip('목표 대비 진행률 게이지')}${usabilityChip('담당자 호출')}${usabilityChip('출근 브리핑')}${usabilityChip('저사양 모드')}${usabilityChip('태블릿 대응')}${usabilityChip('라이트 테마')}
      </div>
    </div>
    <div style="display: flex; flex-direction: column; gap: 18px;">
      <div style="font-size: 12px; letter-spacing: 0.16em; color: ${L.muted}; font-weight: 700; padding: 0 4px;">남은 과제</div>
      ${task('사내 계정 연동 (SSO / AD)', '현재 사내 인증 서버가 없어 파일럿용 자체 인증을 씁니다.')}
      ${task('OPC-UA / Modbus 실 장비 검증', '드라이버는 준비되어 있어, 라이브러리 설치 후 실 장비로 연결을 확인합니다.')}
      ${task('파일럿 라인 1개 선정 후 실사용 피드백', '선정된 라인에서 피드백을 모아 다음 단계 범위를 정합니다.')}
      ${task('사용자 사전 등록 정책', '지금은 신규 사번이 첫 로그인 때 자동 등록되는 파일럿 정책입니다.')}
      <div style="margin-top: 6px; padding: 18px 20px; background: ${L.ink}; color: #ffffff; border-radius: 12px; display: flex; flex-direction: column; gap: 6px;">
        <div style="font-size: 12px; letter-spacing: 0.16em; color: ${D.accent}; font-weight: 700;">협조 요청</div>
        <p style="font-size: 15px; font-weight: 700; line-height: 1.5;">파일럿 라인 1개 선정에 협조를 부탁드립니다.</p>
        <p style="font-size: 13px; color: #c3c9d8; line-height: 1.6;">선정된 라인에서 실사용 피드백을 모아 다음 단계 범위를 정하겠습니다.</p>
      </div>
    </div>
  </div>
</div>
` + tail;

// ── write files + canvas.json
const boards = [
  ['Main', Main, 660],
  ['Problem', Problem, 680],
  ['Scenario', Scenario, 640],
  ['Principles', Principles, 520],
  ['Process', Process, 780],
  ['Stack', Stack, 520],
  ['Floorplan', Floorplan, 1140],
  ['Impact', Impact, 480],
  ['Status', Status, 1120],
];
const titles = { Main: '표지', Problem: '01 왜 만들었나', Scenario: '02 대표 시나리오', Principles: '03 설계 원칙', Process: '04 진행 방식', Stack: '05 기술 선택과 검증', Floorplan: '06 도면으로 우리 공장 만들기', Impact: '07 기대효과와 측정 근거', Status: '08 현재 상태와 다음 단계' };
// Per-board x offsets. A hand-drag of Scenario (9px, saved version 1788695958-294a)
// was reverted on request so every board sits at x=0; add an entry here only when a
// deliberate offset should survive rebuilds. The editor also drops the default
// `print: "fixed"`, so it is not emitted; key order mirrors the editor's save.
const xOffsets = {};
let y = 0; const artboards = [];
for (const [name, html, h] of boards) {
  writeFileSync(`${name}.dc.html`, html);
  artboards.push({ file: `${name}.dc.html`, x: xOffsets[name] ?? 0, y, w: W, h, title: titles[name] });
  y += h + 120;
}
writeFileSync('canvas.json', JSON.stringify({ artboards, launch: { view: 'canvas' } }, null, 2));
console.log('wrote', boards.length, 'artboards');
