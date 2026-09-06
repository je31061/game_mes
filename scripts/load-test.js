/* 동시 접속 부하 테스트 (NFR-01: 50명 기준 위치 동기화 200ms 이내, 채팅 1초 이내)
 *
 * 사용: node scripts/load-test.js [--users 50] [--duration 60] [--url http://localhost:3001]
 *
 * 운영 DB를 오염시키지 않도록 테스트 전용 데이터 폴더로 서버를 따로 띄워서 실행한다:
 *   (PowerShell)  $env:FW_DATA_DIR='data-loadtest'; $env:PORT=3001; npm start
 *   (cmd)         set FW_DATA_DIR=data-loadtest && set PORT=3001 && npm start
 *
 * 각 가상 사용자는 사번 lt-<n>으로 로그인(없으면 자동 등록)해 소켓 접속 후
 * 150ms마다 이동을 보내고, 10초마다 전체 채널에 채팅을 보낸다.
 * 지연 측정: 보낸 쪽이 좌표(x)에 고유값을 심고, 받는 쪽이 같은 x를 받은 시각과의 차이를 계산.
 * 채팅은 본문에 전송 시각을 넣어 수신 시각과 비교. (모두 같은 프로세스 시계이므로 오차 없음)
 */
import { io } from 'socket.io-client';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return a;
}, []));
const USERS = Number(args.users || 50);
const DURATION = Number(args.duration || 60);
const URL = String(args.url || 'http://localhost:3001');
const MOVE_MS = 150, CHAT_MS = 10000;
const MOVE_P95_LIMIT = 200, CHAT_P95_LIMIT = 1000;

const moveSent = new Map();   // key -> t0
const moveLat = [], chatLat = [];
let connected = 0, errors = 0, moveRecv = 0, chatRecv = 0;

function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

async function login(i) {
  const res = await fetch(`${URL}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empNo: `lt-${i}`, name: `부하테스트${i}`, password: 'loadtest' }),
  });
  if (!res.ok) throw new Error(`login ${i}: ${res.status}`);
  return (await res.json()).token;
}

async function spawnUser(i) {
  const token = await login(i);
  const socket = io(URL, { auth: { token, color: '#4fc3f7', badge: '부하' }, transports: ['websocket'] });
  let mySocketId = null, x = 12, y = 8, timers = [];

  await new Promise((resolve, reject) => {
    socket.on('init', (d) => { mySocketId = d.me.socketId; connected++; resolve(); });
    socket.on('connect_error', (e) => { errors++; reject(e); });
    setTimeout(() => reject(new Error(`init timeout ${i}`)), 15000);
  });

  socket.on('player:moved', (d) => {
    const key = `${d.socketId}|${d.x}`;
    const t0 = moveSent.get(key);
    if (t0 !== undefined) { moveLat.push(performance.now() - t0); moveRecv++; moveSent.delete(key); }
  });
  socket.on('chat:message', (m) => {
    if (m.type !== 'text' || !String(m.content).startsWith('lt:')) return;
    const t0 = Number(String(m.content).slice(3));
    if (Number.isFinite(t0)) { chatLat.push(performance.now() - t0); chatRecv++; }
  });

  timers.push(setInterval(() => {
    // 고유한 x 값(소수 6자리)으로 이 이동을 식별
    x = Math.max(0.5, Math.min(23.5, x + (Math.random() - 0.5)));
    y = Math.max(0.5, Math.min(15.5, y + (Math.random() - 0.5)));
    x = Number(x.toFixed(6));
    moveSent.set(`${mySocketId}|${x}`, performance.now());
    socket.emit('player:move', { x, y, moving: true, dir: 'down' });
  }, MOVE_MS));
  timers.push(setInterval(() => {
    socket.emit('chat:send', { channel: 'all', text: `lt:${performance.now()}` }, () => {});
  }, CHAT_MS + Math.random() * 2000));

  return () => { timers.forEach(clearInterval); socket.disconnect(); };
}

console.log(`[load-test] ${URL} — 사용자 ${USERS}명, ${DURATION}초`);
const stops = [];
const t0 = performance.now();
for (let i = 1; i <= USERS; i++) {
  try { stops.push(await spawnUser(i)); }
  catch (e) { errors++; console.error(`[load-test] 사용자 ${i} 접속 실패: ${e.message}`); }
  if (i % 10 === 0) console.log(`[load-test] 접속 ${i}/${USERS}`);
}
console.log(`[load-test] 접속 완료 ${connected}명 (${Math.round(performance.now() - t0)}ms), 측정 시작`);

await new Promise(r => setTimeout(r, DURATION * 1000));
stops.forEach(s => s());

// 오래된 미수신 이동(volatile 드롭)은 손실로 집계
const lost = moveSent.size;
const summary = {
  users: USERS, connected, errors, seconds: DURATION,
  move: { received: moveRecv, lost, p50: pct(moveLat, 0.5), p95: pct(moveLat, 0.95), max: pct(moveLat, 1) },
  chat: { received: chatRecv, p50: pct(chatLat, 0.5), p95: pct(chatLat, 0.95), max: pct(chatLat, 1) },
};
const fmt = (v) => v === null ? '-' : `${v.toFixed(1)}ms`;
console.log('\n=== 결과 ===');
console.log(`접속 ${connected}/${USERS} · 오류 ${errors}`);
console.log(`이동 동기화: 수신 ${moveRecv}건 · 손실 ${lost}건 · p50 ${fmt(summary.move.p50)} · p95 ${fmt(summary.move.p95)} · max ${fmt(summary.move.max)}  (기준 p95 ≤ ${MOVE_P95_LIMIT}ms)`);
console.log(`채팅 전달:   수신 ${chatRecv}건 · p50 ${fmt(summary.chat.p50)} · p95 ${fmt(summary.chat.p95)} · max ${fmt(summary.chat.max)}  (기준 p95 ≤ ${CHAT_P95_LIMIT}ms)`);
const pass = connected === USERS
  && summary.move.p95 !== null && summary.move.p95 <= MOVE_P95_LIMIT
  && (summary.chat.p95 === null || summary.chat.p95 <= CHAT_P95_LIMIT);
console.log(pass ? '\n판정: 통과 (NFR-01)' : '\n판정: 미달 — 위 수치를 확인하세요');
process.exit(pass ? 0 : 1);
