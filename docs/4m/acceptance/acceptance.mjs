// acceptance.mjs — 자재(Material) API 인수 테스트. 노하린 소유.
// 검증보고서 §2 TC-01~59 를 **실서버 API(인터페이스 §10 라우트)** 로 실행한다. fetch 만 쓴다(socket.io-client 불필요).
//
// 입력(환경변수)
//   FW_URL            서버 (기본 http://localhost:3003)
//   FW_TOKEN          관리자 JWT. 없으면 FW_ADMIN_EMPNO(기본 admin)·FW_ADMIN_NAME(기본 관리자)·FW_ADMIN_PASSWORD 로 POST /api/login
//   FW_DATA_DIR       격리 서버의 데이터 폴더 — 있으면 DB 직접 조회(호환 계약 전후 대조·뷰 확인)를 한다. 운영 data/ 를 주지 마라
//   FW_ASOF           as-of 기준일 (기본 2026-06-01)
//   FW_READONLY=1     쓰기(트리거·라인·로트) 검사를 건너뛴다 — 공유 서버에서 돌릴 때
//   FW_SKIP_IMPORT=1  import-sample 호출을 건너뛴다
// 출력: out/acceptance-<시각>.json · out/acceptance-latest.json · out/acceptance-latest.md (판정표)
// 판정: PASS / FAIL(재현 절차·기대·실제 기록) / BLOCK(못 함 — 추정하지 않는다) / NOTE(의견)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const OUT = path.join(HERE, 'out'); fs.mkdirSync(OUT, { recursive: true });
const URL_ = (process.env.FW_URL || 'http://localhost:3003').replace(/\/$/, '');
const ASOF = process.env.FW_ASOF || '2026-06-01';
const READONLY = process.env.FW_READONLY === '1';
const SKIP_IMPORT = process.env.FW_SKIP_IMPORT === '1';
const DATA_DIR = process.env.FW_DATA_DIR ? path.resolve(process.env.FW_DATA_DIR) : null;
if (DATA_DIR && DATA_DIR === path.join(ROOT, 'data')) { console.error('FW_DATA_DIR 가 운영 data/ 다 — 중단. 격리 폴더를 줘라.'); process.exit(2); }
const B = '/api/admin/materials';
const EPS = 1e-9;
const CJ = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', '4m', 'cleansing-v1.json'), 'utf8'));
const EXP = CJ.expected;
const TMP = Object.fromEntries(Object.entries(CJ.pn_pending).filter(([, v]) => v && typeof v === 'object').map(([k, v]) => [k, v.tmp]));
const A = (pn) => TMP[pn] || pn;                              // 정식 → 실제(TMP-) 후보
const N = (pn) => Object.entries(TMP).find(([, t]) => t === pn)?.[0] || pn;   // 실제 → 정식
const EXP_TOT = { EA: 76, g: 221, SHT: 12, kg: 0.85, m: 0.5 };
const RUN = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const TAG = `AT${Date.now().toString(36).slice(-4).toUpperCase()}`;   // 이번 실행이 만든 데이터 접두

// ── HTTP ──────────────────────────────────────────────────────────────────
let TOKEN = process.env.FW_TOKEN || null;
async function http(method, p, body, { raw = false, noAuth = false } = {}) {
  const t0 = performance.now();
  const res = await fetch(URL_ + p, { method, headers: { 'content-type': 'application/json', ...(TOKEN && !noAuth ? { 'x-auth-token': TOKEN } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const ms = Math.round(performance.now() - t0);
  const text = await res.text(); let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text: raw ? text : text.slice(0, 300), ms };
}
const GET = (p, o) => http('GET', p, undefined, o), POST = (p, b, o) => http('POST', p, b, o), PUT = (p, b) => http('PUT', p, b), DEL = (p) => http('DELETE', p);

// ── 결과 ──────────────────────────────────────────────────────────────────
const R = [];
const log = (s = '') => console.log(s);
function rec(tc, group, desc, verdict, expect, actual, extra = {}) {
  R.push({ tc, group, desc, verdict, expect: String(expect), actual: typeof actual === 'string' ? actual : JSON.stringify(actual), ...extra });
  const m = { PASS: 'PASS ', FAIL: 'FAIL!', BLOCK: 'BLOCK', NOTE: 'NOTE ' }[verdict];
  log(`  [${m}] ${tc.padEnd(7)} ${desc}${extra.ms !== undefined ? `  (${extra.ms} ms)` : ''}`);
  if (verdict !== 'PASS') { log(`           기대: ${expect}`); log(`           실제: ${R[R.length - 1].actual.slice(0, 400)}`); }
  if (extra.note) log(`           ※ ${extra.note}`);
}
const near = (a, b) => Math.abs(Number(a) - Number(b)) < EPS;
const totKey = (t, k) => (k === 'SHT' ? (t.SHT ?? t['매']) : t[k]);
const totalsMatch = (t) => t && Object.entries(EXP_TOT).every(([k, v]) => near(totKey(t, k), v)) && Object.keys(t).length === 5;
const flat = (nodes, acc = []) => { for (const n of nodes || []) { acc.push(n); flat(n.children, acc); } return acc; };
const rejectedWith = (r, prefix) => r.status === 400 && typeof r.json?.error === 'string' && (prefix ? r.json.error.includes(prefix) : true);
async function step(tc, group, desc, fn) {
  const t0 = performance.now();
  try { await fn(Math.round); }
  catch (e) { rec(tc, group, desc, 'FAIL', '예외 없음', `예외: ${e?.stack || e}`, { ms: Math.round(performance.now() - t0) }); }
}

// ══════════════════════════════════════════════════════════════════════════
async function phase0_auth() {
  log('\n### 0. 연결 · 인증');
  await step('AT-00', '0', '토큰 없이 summary → 401', async () => {
    const r = await GET(`${B}/summary`, { noAuth: true });
    rec('AT-00', '0', '토큰 없이 summary → 401', r.status === 401 ? 'PASS' : 'FAIL', '401', `${r.status} ${r.text}`, { ms: r.ms });
  });
  if (!TOKEN) {
    const r = await POST('/api/login', { empNo: process.env.FW_ADMIN_EMPNO || 'admin', name: process.env.FW_ADMIN_NAME || '관리자', password: process.env.FW_ADMIN_PASSWORD || '' });
    if (r.status === 200 && r.json?.token) { TOKEN = r.json.token; rec('AT-01', '0', 'POST /api/login (관리자) → 토큰', 'PASS', '200 token', `role=${r.json.user?.role}`, { ms: r.ms }); }
    else { rec('AT-01', '0', 'POST /api/login (관리자) → 토큰', 'FAIL', '200 token', `${r.status} ${r.text}`, { ms: r.ms }); throw new Error('로그인 실패 — 이후 검사 불가'); }
  }
  const r = await GET(`${B}/summary`);
  const keys = ['items', 'classes', 'bomHeaders', 'bomLines', 'lots', 'check'];
  rec('AT-02', '0', 'GET summary 응답 키 (items·classes·bomHeaders·bomLines·lots·check)', r.status === 200 && keys.every(k => k in (r.json || {})) ? 'PASS' : 'FAIL', keys.join(','), r.json ? Object.keys(r.json) : r.text, { ms: r.ms });
  return r.json;
}

async function phase1_import() {
  log('\n### 1. 적재 · 멱등 (TC-51~53 · TC-60·61)');
  if (SKIP_IMPORT) { rec('AT-10', '1', 'import-sample', 'BLOCK', '-', 'FW_SKIP_IMPORT=1'); return; }
  const r1 = await POST(`${B}/import-sample`, {});
  const ok1 = r1.status === 200 && r1.json?.ok && r1.json?.expectedMatch === true && Array.isArray(r1.json?.mismatches) && r1.json.mismatches.length === 0;
  rec('AT-10', '1', 'import-sample #1 → ok · expectedMatch true · mismatches []', ok1 ? 'PASS' : 'FAIL', 'expectedMatch true', r1.json ? { status: r1.status, expectedMatch: r1.json.expectedMatch, mismatches: r1.json.mismatches, counts: r1.json.counts } : r1.text, { ms: r1.ms });
  const chk1 = r1.json?.check;
  rec('AT-11', '1', 'import-sample.check = {D-8:10, R-10:10}', JSON.stringify(chk1) === JSON.stringify(EXP.v_chk_summary && { 'D-8': 10, 'R-10': 10 }) ? 'PASS' : 'FAIL', '{D-8:10,R-10:10}', chk1);
  const s1 = (await GET(`${B}/summary`)).json;
  const r2 = await POST(`${B}/import-sample`, {});
  const s2 = (await GET(`${B}/summary`)).json;
  const same = s1 && s2 && ['items', 'classes', 'bomHeaders', 'bomLines'].every(k => s1[k] === s2[k]) && JSON.stringify(r1.json?.counts) === JSON.stringify(r2.json?.counts);
  rec('AT-12', '1', 'import-sample #2 (멱등) → summary 건수·counts 동일', same ? 'PASS' : 'FAIL', '동일', { s1: pick(s1), s2: pick(s2), counts2: r2.json?.counts }, { ms: r2.ms });
  rec('AT-13', '1', 'summary 건수 = expected (item 60 · header 11 · line 59 · class 24)', s2 && s2.items === EXP.item && s2.bomHeaders === EXP.bom_header && s2.bomLines === EXP.bom_line && s2.classes === EXP.mat_class ? 'PASS' : 'FAIL', `${EXP.item}/${EXP.bom_header}/${EXP.bom_line}/${EXP.mat_class}`, pick(s2));
  rec('AT-14', '1', 'summary.check = {D-8:10, R-10:10} (그 밖의 규칙 0)', JSON.stringify(s2?.check) === JSON.stringify({ 'D-8': 10, 'R-10': 10 }) ? 'PASS' : 'FAIL', '{D-8:10,R-10:10}', s2?.check);
  function pick(s) { return s && { items: s.items, classes: s.classes, bomHeaders: s.bomHeaders, bomLines: s.bomLines, lots: s.lots, check: s.check }; }
}

async function phase2_master() {
  log('\n### 2. 단위 · 분류 · 품목 (TC-29~34)');
  const u = await GET(`${B}/uom`);
  const codes = (u.json || []).map(x => x.code).sort();
  const dec = Object.fromEntries((u.json || []).map(x => [x.code, x.decimals]));
  rec('AT-20', '2', 'uom 5종 (EA·SHT·kg·g·m) · SET 없음 · decimals EA0 SHT0 kg3 g2 m2', JSON.stringify(codes) === JSON.stringify(['EA', 'SHT', 'g', 'kg', 'm']) && dec.EA === 0 && dec.kg === 3 && dec.g === 2 ? 'PASS' : 'FAIL', 'EA,SHT,g,kg,m', { codes, dec }, { ms: u.ms });
  const c = await GET(`${B}/classes`);
  const cls = c.json || [];
  const roots = cls.filter(x => x.parentId === null || x.parentId === undefined).length;
  const leaves = cls.filter(x => !cls.some(y => y.parentId === x.id)).length;
  const itemSum = cls.reduce((s, x) => s + (x.itemCount || 0), 0);
  rec('AT-21', '2', 'classes 24 · 최상위 6 · 말단 18 · itemCount 합 60', cls.length === 24 && roots === 6 && leaves === 18 && itemSum === 60 ? 'PASS' : 'FAIL', '24/6/18/60', { n: cls.length, roots, leaves, itemSum }, { ms: c.ms });
  const it = await GET(`${B}/items`);
  const items = it.json || [];
  const byKind = {}; for (const x of items) byKind[x.kind] = (byKind[x.kind] || 0) + 1;
  const tmp = items.filter(x => x.isTmp).map(x => x.pn).sort();
  rec('AT-22', '2', 'items 60 · isTmp 3 (TMP-)', items.length === 60 && tmp.length === 3 ? 'PASS' : 'FAIL', '60 / 3', { n: items.length, tmp, byKind }, { ms: it.ms });
  const kinds = new Set(items.map(x => x.kind));
  const contractKinds = ['FG', 'SA', 'PHANTOM', 'PART', 'RAW', 'PKG'];
  rec('AT-22b', '2', 'items[].kind 값이 §10 열거(FG/SA/PHANTOM/PART/RAW/PKG) 안인가', [...kinds].every(k => contractKinds.includes(k)) ? 'PASS' : 'NOTE', contractKinds.join('/'), [...kinds].sort(),
    { note: [...kinds].every(k => contractKinds.includes(k)) ? '' : '§10 열거에 CN(부자재 6종)이 없고 서버는 item_type 원값(FG/SA/PT/RM/CN/PK)을 낸다 — 계약 문구 정정 필요(서지안 화면 매핑 확인)' });
  const ph = await GET(`${B}/items?kind=PHANTOM`);
  rec('AT-23', '2', 'items?kind=PHANTOM → 3 (HA-3000·EX-5000·PE-6000)', JSON.stringify((ph.json || []).map(x => x.pn).sort()) === JSON.stringify(['EX-5000', 'HA-3000', 'PE-6000']) ? 'PASS' : 'FAIL', '3', (ph.json || []).map(x => x.pn), { ms: ph.ms });
  const qq = await GET(`${B}/items?q=SC-10`);
  const qs = (qq.json || []).map(x => N(x.pn)).sort();
  rec('AT-23b', '2', 'items?q=SC-10 → SC-1010 · SC-1011 (TMP-SC1010P 는 승인 전이라 문자열에 안 걸린다)', ['SC-1010', 'SC-1011'].every(p => qs.includes(p)) ? 'PASS' : 'FAIL', 'SC-1010,SC-1011', qs, { ms: qq.ms });
  const brg = cls.find(x => x.code === 'PT-BRG');
  const cq = brg ? await GET(`${B}/items?classId=${brg.id}`) : { json: [], ms: 0 };
  rec('AT-23c', '2', 'items?classId=PT-BRG → BF-3040 · BR-3050 · GB-8040', JSON.stringify((cq.json || []).map(x => x.pn).sort()) === JSON.stringify(['BF-3040', 'BR-3050', 'GB-8040']) ? 'PASS' : 'FAIL', '3', (cq.json || []).map(x => x.pn), { ms: cq.ms });
  const d = await GET(`${B}/items/OR-5020`);
  const wu = d.json?.whereUsed || [];
  rec('AT-24', '2', 'items/OR-5020 → whereUsed 부모 EX-5000 · headers [] · lots 0', d.status === 200 && wu.length === 1 && wu[0].parentPn === 'EX-5000' && (d.json.headers || []).length === 0 && d.json.lots === 0 ? 'PASS' : 'FAIL', 'EX-5000 / [] / 0', { status: d.status, wu, headers: d.json?.headers?.length, lots: d.json?.lots }, { ms: d.ms });
  const d2 = await GET(`${B}/items/SA-1000`);
  rec('AT-24b', '2', 'items/SA-1000 → headers 1 (ACTIVE, lineCount 9 — SC-1011 은 SC-1010P 밑) · whereUsed 부모 BLDC-500W-48V', d2.json?.headers?.length === 1 && d2.json.headers[0].status === 'ACTIVE' && d2.json.headers[0].lineCount === 9 && d2.json.whereUsed?.[0]?.parentPn === 'BLDC-500W-48V' ? 'PASS' : 'FAIL', '1 ACTIVE 9 / BLDC', { headers: d2.json?.headers, wu: d2.json?.whereUsed }, { ms: d2.ms });
  const nf = await GET(`${B}/items/NO-SUCH-PN`);
  rec('AT-24c', '2', 'items/NO-SUCH-PN → 404 {error}', nf.status === 404 && nf.json?.error ? 'PASS' : 'FAIL', '404', `${nf.status} ${nf.text}`, { ms: nf.ms });
  return { items, cls };
}

async function phase3_bom() {
  log('\n### 3. 정전개 (TC-10~17 · TC-54 · TC-55)');
  const r = await GET(`${B}/bom/BLDC-500W-48V?asOf=${ASOF}`);
  const j = r.json || {};
  rec('AT-30', '3', 'bom/BLDC-500W-48V totals = EA 76 · g 221 · SHT(매) 12 · kg 0.85 · m 0.5', totalsMatch(j.totals) ? 'PASS' : 'FAIL', JSON.stringify(EXP_TOT), j.totals, { ms: r.ms });
  const nodes = flat(j.nodes);
  const maxLv = Math.max(0, ...nodes.map(n => n.level));
  const phantoms = nodes.filter(n => n.phantom).map(n => n.pn).sort();
  const states = {}; for (const n of nodes) states[n.bop?.state] = (states[n.bop?.state] || 0) + 1;
  rec('AT-31', '3', 'nodes 59 · 최대 level 4 · 팬텀 3 · bop.state linked 46 / unassigned 10 / phantom 3', nodes.length === 59 && maxLv === 4 && phantoms.length === 3 && states.linked === 46 && states.unassigned === 10 && states.phantom === 3 ? 'PASS' : 'FAIL', '59/4/3/46/10/3', { n: nodes.length, maxLv, phantoms, states });
  const sc = nodes.find(n => N(n.pn) === 'SC-1011'), scp = nodes.find(n => N(n.pn) === 'SC-1010P');
  rec('AT-32', '3', 'SC-1011 노드 level 4 · qtyPerProduct 정확히 0.85 kg · SC-1010P qtyPer 80 SHT', sc && sc.level === 4 && sc.qtyPerProduct === 0.85 && sc.uom === 'kg' && scp && scp.qtyPer === 80 && scp.uom === 'SHT' ? 'PASS' : 'FAIL', 'L4 0.85 kg / 80 SHT', { sc: sc && { level: sc.level, q: sc.qtyPerProduct, uom: sc.uom }, scp: scp && { qtyPer: scp.qtyPer, uom: scp.uom, qpp: scp.qtyPerProduct } });
  const unass = nodes.filter(n => n.bop?.state === 'unassigned').map(n => `${N(n.parentPn)}>${N(n.pn)}`).sort();
  rec('AT-33', '3', '미배정 10 = 쟁점 3·6 목록', JSON.stringify(unass) === JSON.stringify([...EXP.unassigned_lines].sort()) ? 'PASS' : 'FAIL', EXP.unassigned_lines.join(','), unass);
  const d1 = await GET(`${B}/bom/BLDC-500W-48V?asOf=${ASOF}&depth=1`);
  const n1 = flat(d1.json?.nodes);
  rec('AT-34', '3', 'depth=1 → 완성품 직하 10 (서브어셈블리 9 + PK-0010)', n1.length === 10 && n1.every(n => n.level === 1) ? 'PASS' : 'FAIL', '10 · level 1', { n: n1.length, pns: n1.map(n => n.pn) }, { ms: d1.ms });
  const ha = await GET(`${B}/bom/HA-3000?asOf=${ASOF}`);
  const hn = flat(ha.json?.nodes);
  rec('AT-35', '3', 'bom/HA-3000 (팬텀 루트) → 자식 7 · totals EA 14', hn.length === 7 && near(ha.json?.totals?.EA, 14) ? 'PASS' : 'FAIL', '7 / EA 14', { n: hn.length, totals: ha.json?.totals }, { ms: ha.ms });
  const gb = await GET(`${B}/bom/GB-8000?asOf=${ASOF}`);
  rec('AT-36', '3', 'bom/GB-8000 → totals EA 5 · g 25', near(gb.json?.totals?.EA, 5) && near(gb.json?.totals?.g, 25) ? 'PASS' : 'FAIL', 'EA 5 g 25', gb.json?.totals, { ms: gb.ms });
  const nf = await GET(`${B}/bom/NO-SUCH`);
  rec('AT-37', '3', 'bom/NO-SUCH → 404', nf.status === 404 ? 'PASS' : 'FAIL', '404', `${nf.status}`, { ms: nf.ms });
  const old = await GET(`${B}/bom/BLDC-500W-48V?asOf=2025-12-31`);
  rec('AT-38', '3', 'as-of 2025-12-31 (valid_from 2026-01-01 이전) → 노드 0 · totals {}', flat(old.json?.nodes).length === 0 && Object.keys(old.json?.totals || {}).length === 0 ? 'PASS' : 'FAIL', '0 / {}', { n: flat(old.json?.nodes).length, totals: old.json?.totals }, { ms: old.ms });
  return nodes;
}

async function phase4_whereused() {
  log('\n### 4. 역전개 (TC-18~22)');
  for (const [tc, pn, mid] of [['AT-40', 'OR-5020', 'EX-5000'], ['AT-41', 'BF-3040', 'HA-3000'], ['AT-42', 'BT-3070', 'HA-3000']]) {
    const r = await GET(`${B}/where-used/${pn}?asOf=${ASOF}`);
    const paths = r.json?.paths || [];
    const ok = paths.length >= 1 && paths.every(p => p[0]?.pn === pn && p[p.length - 1]?.pn === 'BLDC-500W-48V') && paths.some(p => p.some(x => x.pn === mid));
    rec(tc, '4', `where-used/${pn} → 경로 ${pn} … ${mid} … BLDC-500W-48V (루트까지)`, ok ? 'PASS' : 'FAIL', `[${pn} > ${mid} > BLDC-500W-48V]`, paths.map(p => p.map(x => x.pn).join(' > ')), { ms: r.ms });
  }
  const sc = await GET(`${B}/where-used/SC-1011?asOf=${ASOF}`);
  const p = sc.json?.paths?.[0] || [];
  rec('AT-43', '4', 'where-used/SC-1011 → 4단 경로 (SC-1011 > SC-1010P > SC-1010 > SA-1000 > BLDC)', p.length === 5 && p.map(x => N(x.pn)).join('>') === 'SC-1011>SC-1010P>SC-1010>SA-1000>BLDC-500W-48V' ? 'PASS' : 'FAIL', '5 노드', p.map(x => x.pn), { ms: sc.ms });
  const nf = await GET(`${B}/where-used/NO-SUCH`);
  rec('AT-44', '4', 'where-used/NO-SUCH → 404 (500 아님)', nf.status === 404 ? 'PASS' : 'FAIL', '404', `${nf.status}`, { ms: nf.ms });
  const fg = await GET(`${B}/where-used/BLDC-500W-48V`);
  rec('AT-45', '4', 'where-used/BLDC-500W-48V (루트) → paths [] · 오류 아님', fg.status === 200 && Array.isArray(fg.json?.paths) && fg.json.paths.length === 0 ? 'PASS' : 'FAIL', '200 []', `${fg.status} ${JSON.stringify(fg.json?.paths)}`, { ms: fg.ms });
}

async function phase5_process() {
  log('\n### 5. 공정 IN/OUT (TC-23~27 · D-8 · R-10 · R-22)');
  const ops = ['OP-A10', 'OP-A20', 'OP-A30', 'OP-A40', 'OP-A50', 'OP-A60', 'OP-A70', 'OP-A80', 'OP-A90', 'OP-A100', 'OP-B10', 'OP-B20', 'OP-B30', 'OP-B40', 'OP-B50', 'OP-B60', 'OP-B70', 'OP-B80', 'OP-B85', 'OP-B87', 'OP-B90', 'OP-B100', 'OP-B110', 'OP-B120'];
  let nin = 0, nout = 0, nfinal = 0, ms = 0; const per = {}; let bad = [];
  for (const op of ops) {
    const r = await GET(`${B}/process/${op}`); ms += r.ms;
    if (r.status !== 200) { bad.push([op, r.status]); continue; }
    per[op] = { in: (r.json.inputs || []).map(x => N(x.pn)), out: (r.json.outputs || []).map(x => ({ pn: N(x.pn), final: x.isFinal })), un: (r.json.unassigned || []).length };
    nin += per[op].in.length; nout += per[op].out.length; nfinal += per[op].out.filter(o => o.final).length;
  }
  rec('AT-50', '5', '24공정 process/:op → IN 합 46 · OUT 24 · 완성(isFinal) 7 · 오류 0', bad.length === 0 && nin === 46 && nout === 24 && nfinal === 7 ? 'PASS' : 'FAIL', '46/24/7', { nin, nout, nfinal, bad }, { ms });
  rec('AT-51', '5', 'OP-B90 inputs 9 = BOP 표기 순서 (PC-4010 … SP-4040)', JSON.stringify(per['OP-B90']?.in) === JSON.stringify(['PC-4010', 'PC-4011', 'HS-4020', 'MO-4030', 'GD-4040', 'CP-4050', 'HK-4060', 'BB-4070', 'SP-4040']) ? 'PASS' : 'FAIL', 'PC-4010…SP-4040', per['OP-B90']?.in);
  rec('AT-52', '5', 'OP-A10 IN [SC-1011] · OUT SC-1010P(final) · OP-A70 IN [] · OUT SA-1000(진행)', per['OP-A10']?.in?.join() === 'SC-1011' && per['OP-A10']?.out?.[0]?.pn === 'SC-1010P' && per['OP-A10'].out[0].final && per['OP-A70']?.in?.length === 0 && per['OP-A70']?.out?.[0]?.pn === 'SA-1000' && !per['OP-A70'].out[0].final ? 'PASS' : 'FAIL', 'A10 / A70', { A10: per['OP-A10'], A70: per['OP-A70'] });
  const nf = await GET(`${B}/process/OP-ZZ`);
  rec('AT-53', '5', 'process/OP-ZZ → 404', nf.status === 404 ? 'PASS' : 'FAIL', '404', `${nf.status}`, { ms: nf.ms });
  const bop = await GET('/api/admin/bop');
  const sm = bop.json?.summary || {}; const b90 = (bop.json?.processes || []).find(p => p.op === 'OP-B90');
  rec('AT-54', '5', 'GET /api/admin/bop (기존 계약) → summary.inputs 46 · parts 59 · OP-B90 inputCount 9 · processes 24', sm.inputs === 46 && sm.parts === 59 && b90?.inputCount === 9 && sm.processes === 24 ? 'PASS' : 'FAIL', '46/59/9/24', { summary: sm, b90: b90?.inputCount }, { ms: bop.ms, note: '호환 뷰(process_inputs·parts) 위에서 기존 listProcesses·countParts 가 그대로 도는지' });
  const chk = await GET(`${B}/check`);
  rec('AT-55', '5', 'GET check (있으면) → details D-8 10건 = 미배정 목록', chk.status === 404 ? 'NOTE' : (chk.json?.details?.['D-8']?.length === 10 ? 'PASS' : 'FAIL'), '10', chk.status === 404 ? '라우트 없음 (§10 밖 — 있으면 좋은 것)' : chk.json?.details?.['D-8'], { ms: chk.ms });
}

// ── 쓰기 검사 ─────────────────────────────────────────────────────────────
async function findHeader(pn) { const r = await GET(`${B}/bom-headers/${pn}`); return (r.json?.headers || []).find(h => h.status === 'ACTIVE') || (r.json?.headers || [])[0]; }
async function findLine(parentPn, childPn) { const h = await findHeader(parentPn); return (h?.lines || []).find(l => N(l.pn) === childPn) || null; }

async function phase6_triggers(ctx) {
  log('\n### 6. 트리거 거부 → 400 + 접두 문자열 (TC-01~07 · 29·30 · 35·36·59 · 41·42 · 56 · R-11)');
  if (READONLY) { rec('AT-60', '6', '쓰기 검사', 'BLOCK', '-', 'FW_READONLY=1'); return; }
  const gb = await findHeader('GB-8000'), pl = await findHeader('PL-9000'), ra = await findHeader('RA-2000'), fg = await findHeader('BLDC-500W-48V');
  if (!gb || !pl || !ra || !fg) { rec('AT-60', '6', 'bom-headers 조회', 'FAIL', '헤더 4', { gb: !!gb, pl: !!pl, ra: !!ra, fg: !!fg }); return; }
  let r = await POST(`${B}/bom-lines`, { headerId: gb.id, pn: 'BLDC-500W-48V', qtyPer: 1, uom: 'EA' });
  rec('AT-60', '6', 'R-1 순환: GB-8000 BOM 에 BLDC-500W-48V 를 자식으로 → 400 "R-1:"', rejectedWith(r, 'R-1:') ? 'PASS' : 'FAIL', '400 R-1:', `${r.status} ${r.text}`, { ms: r.ms });
  r = await POST(`${B}/bom-lines`, { headerId: pl.id, pn: 'PL-9010', qtyPer: 1, uom: 'EA', effFrom: '2026-03-01' });
  rec('AT-61', '6', 'R-9 겹침: PL-9000 에 PL-9010 을 2026-03-01 부터 한 번 더 → 400 "R-9:"', rejectedWith(r, 'R-9:') ? 'PASS' : 'FAIL', '400 R-9:', `${r.status} ${r.text}`, { ms: r.ms });
  r = await POST(`${B}/bom-lines`, { headerId: pl.id, pn: 'PL-9010', qtyPer: 1, uom: 'EA', effFrom: '2026-01-01' });
  rec('AT-61b', '6', 'R-3 중복: 같은 자식·같은 시작일 → 400 (R-9 또는 UNIQUE)', r.status === 400 && (r.json?.error?.includes('R-9') || r.json?.error?.includes('UNIQUE')) ? 'PASS' : 'FAIL', '400', `${r.status} ${r.text}`, { ms: r.ms });
  r = await POST(`${B}/bom-lines`, { headerId: pl.id, pn: 'BW-2050', qtyPer: 0, uom: 'EA' });
  rec('AT-62', '6', 'R-6 수량 0 → 400', r.status === 400 ? 'PASS' : 'FAIL', '400', `${r.status} ${r.text}`, { ms: r.ms });
  r = await POST(`${B}/bom-lines`, { headerId: pl.id, pn: 'BW-2050', qtyPer: 0.5, uom: 'EA' });
  rec('AT-63', '6', 'R-8 소수: 0.5 EA → 400 "R-8:"', rejectedWith(r, 'R-8:') ? 'PASS' : 'FAIL', '400 R-8:', `${r.status} ${r.text}`, { ms: r.ms });
  r = await POST(`${B}/bom-lines`, { headerId: pl.id, pn: 'BW-2050', qtyPer: 1, uom: 'g' });
  rec('AT-64', '6', 'R-7 단위: EA 품목에 g → 400 "R-7:"', rejectedWith(r, 'R-7:') ? 'PASS' : 'FAIL', '400 R-7:', `${r.status} ${r.text}`, { ms: r.ms });
  r = await POST(`${B}/bom-lines`, { headerId: pl.id, pn: 'BW-2050', qtyPer: 1, uom: 'EA', effFrom: '2026-12-31', effTo: '2026-01-01' });
  rec('AT-64b', '6', 'D-6 valid_to < valid_from → 400', r.status === 400 ? 'PASS' : 'FAIL', '400', `${r.status} ${r.text}`, { ms: r.ms });
  const l = await findLine('PL-9000', 'PL-9010');
  r = l ? await DEL(`${B}/bom-lines/${l.id}`) : { status: 0, text: '라인 못 찾음', ms: 0 };
  rec('AT-65', '6', 'R-11 승인 라인 삭제 → 400 "R-11:"', rejectedWith(r, 'R-11:') ? 'PASS' : 'FAIL', '400 R-11:', `${r.status} ${r.text}`, { ms: r.ms });
  r = await DEL(`${B}/items/PL-9010`);
  rec('AT-65b', '6', 'DELETE items/:pn → 거부 (405/400, R-11)', (r.status === 405 || r.status === 400) && r.json?.error ? 'PASS' : 'FAIL', '405|400', `${r.status} ${r.text}`, { ms: r.ms });
  // 대체품 (TC-41·42·44)
  const mag = ctx.cls.find(c => c.code === 'PT-MAG');
  r = await POST(`${B}/items`, { pn: `${TAG}-PM-X`, name: '대체 자석(시험)', classId: mag?.id, kind: 'PT', uom: 'EA', sourceType: 'BUY', status: 'ACTIVE', traceKind: 'LOT' });
  const okItem = r.status === 200 || r.status === 201;
  rec('AT-66a', '6', 'POST items (대체 자석 시험 품목) → 200/201', okItem ? 'PASS' : 'FAIL', '201', `${r.status} ${r.text}`, { ms: r.ms });
  const pm = await findLine('RA-2000', 'PM-2030');
  r = pm ? await PUT(`${B}/bom-lines/${pm.id}`, { altGroup: 'MAG', altPriority: 1 }) : { status: 0, text: 'PM-2030 라인 없음' };
  rec('AT-66b', '6', 'PUT bom-lines PM-2030 altGroup=MAG priority 1 → 200', r.status === 200 ? 'PASS' : 'FAIL', '200', `${r.status} ${r.text}`, { ms: r.ms });
  r = await POST(`${B}/bom-lines`, { headerId: ra.id, pn: `${TAG}-PM-X`, qtyPer: 8, uom: 'EA', altGroup: 'MAG', altPriority: 1 });
  rec('AT-66c', '6', 'D-13 우선순위 중복 (1,1) → 400 "D-13:"', rejectedWith(r, 'D-13:') ? 'PASS' : 'FAIL', '400 D-13:', `${r.status} ${r.text}`, { ms: r.ms });
  r = await POST(`${B}/bom-lines`, { headerId: ra.id, pn: `${TAG}-PM-X`, qtyPer: 8, uom: 'EA', altGroup: 'MAG', altPriority: 2 });
  rec('AT-66d', '6', '대체품 우선순위 2 → 201 (동시 유효 허용)', r.status === 201 || r.status === 200 ? 'PASS' : 'FAIL', '201', `${r.status} ${r.text}`, { ms: r.ms });
  const bom = await GET(`${B}/bom/BLDC-500W-48V?asOf=${ASOF}`);
  const magNodes = flat(bom.json?.nodes).filter(n => n.altGroup === 'MAG').map(n => ({ pn: n.pn, q: n.qtyPerProduct }));
  rec('AT-66e', '6', 'TC-44 대체품 있는 전개 — 주자재 PM-2030 만 계상 · totals EA 76 불변', totalsMatch(bom.json?.totals) && magNodes.length === 1 && magNodes[0].pn === 'PM-2030' ? 'PASS' : 'FAIL', 'PM-2030 8 · EA 76', { magNodes, totals: bom.json?.totals }, { ms: bom.ms });
  // 헤더 (R-9b · D-12)
  r = await POST(`${B}/bom-headers`, { pn: 'PL-9000', status: 'ACTIVE', rev: 'B', baseQty: 1, baseUom: 'EA', effFrom: '2026-01-01' });
  rec('AT-67', '6', 'R-9b 같은 부모 ACTIVE rev B 같은 기간 → 400 "R-9b:"', rejectedWith(r, 'R-9b:') ? 'PASS' : 'FAIL', '400 R-9b:', `${r.status} ${r.text}`, { ms: r.ms });
  r = await POST(`${B}/bom-headers`, { pn: 'PL-9000', status: 'DRAFT', rev: 'B', baseQty: 1, baseUom: 'EA', effFrom: '2026-01-01' });
  const draftId = r.json?.header?.id;
  rec('AT-67b', '6', 'DRAFT rev B → 201 (ECO 준비 허용)', (r.status === 201 || r.status === 200) && draftId ? 'PASS' : 'FAIL', '201', `${r.status} ${r.text}`, { ms: r.ms });
  r = draftId ? await PUT(`${B}/bom-headers/${draftId}`, { status: 'ACTIVE' }) : { status: 0, text: '-' };
  rec('AT-67c', '6', 'DRAFT → ACTIVE 승격 (직전 rev 미종료) → 400 "R-9b:"', rejectedWith(r, 'R-9b:') ? 'PASS' : 'FAIL', '400 R-9b:', `${r.status} ${r.text}`, { ms: r.ms });
  r = await POST(`${B}/bom-headers`, { pn: 'PL-9000', status: 'ACTIVE', rev: 'C', baseQty: 1, baseUom: 'kg' });
  rec('AT-67d', '6', 'R-7b 헤더 base_uom ≠ 품목 base_uom → 400 "R-7b:"', rejectedWith(r, 'R-7b:') ? 'PASS' : 'FAIL', '400 R-7b:', `${r.status} ${r.text}`, { ms: r.ms });
  // D-8 팬텀 라인 IN
  const haLine = await findLine('BLDC-500W-48V', 'HA-3000');
  const b50 = await GET(`${B}/process/OP-B50`);
  const links = (b50.json?.inputs || []).map((x, i) => ({ lineId: x.lineId, mode: 'IN', seq: i + 1, splitPct: x.splitPct, issueMethod: x.issueMethod }));
  r = haLine ? await PUT(`${B}/process/OP-B50/links`, { links: [...links, { lineId: haLine.id, mode: 'IN', seq: 99 }] }) : { status: 0, text: 'HA-3000 라인 없음' };
  rec('AT-68', '6', 'D-8 팬텀 라인(BLDC>HA-3000)에 IN 연결 → 400 "D-8:"', rejectedWith(r, 'D-8:') ? 'PASS' : 'FAIL', '400 D-8:', `${r.status} ${r.text}`, { ms: r.ms });
  const b50b = await GET(`${B}/process/OP-B50`);
  rec('AT-68b', '6', '거부된 links 편집 뒤 OP-B50 IN 이 원래대로 (롤백)', JSON.stringify((b50b.json?.inputs || []).map(x => x.lineId)) === JSON.stringify(links.map(x => x.lineId)) ? 'PASS' : 'FAIL', links.map(x => x.lineId).join(','), (b50b.json?.inputs || []).map(x => x.lineId).join(','), { ms: b50b.ms });
  r = await PUT(`${B}/process/OP-B50/links`, { links });
  const b50c = await GET(`${B}/process/OP-B50`);
  rec('AT-68c', '6', '같은 links 를 다시 PUT (순서 동일) → 200 · pm_id 불변', r.status === 200 && JSON.stringify((b50c.json?.inputs || []).map(x => x.pmId)) === JSON.stringify((b50.json?.inputs || []).map(x => x.pmId)) ? 'PASS' : 'FAIL', 'pmId 동일', { before: (b50.json?.inputs || []).map(x => x.pmId), after: (b50c.json?.inputs || []).map(x => x.pmId) }, { ms: r.ms });
  // R-14 · R-20 품목
  const nonleaf = ctx.cls.find(c => c.code === 'PT');
  r = await POST(`${B}/items`, { pn: `${TAG}-NL`, name: 'x', classId: nonleaf?.id, kind: 'PT', uom: 'EA', sourceType: 'BUY' });
  rec('AT-69', '6', 'R-14 비말단 분류(PT)에 품목 → 400 "R-14:"', rejectedWith(r, 'R-14:') ? 'PASS' : 'FAIL', '400 R-14:', `${r.status} ${r.text}`, { ms: r.ms });
  r = await POST(`${B}/items`, { pn: 'HA-3000/EX-5000', name: 'x', classId: mag?.id, kind: 'PT', uom: 'EA', sourceType: 'BUY' });
  rec('AT-69b', '6', 'R-20 pn 에 "/" → 400 (CHECK)', r.status === 400 ? 'PASS' : 'FAIL', '400', `${r.status} ${r.text}`, { ms: r.ms });
  r = await POST(`${B}/items`, { pn: `${TAG}-U`, name: 'x', classId: mag?.id, kind: 'PT', uom: '말', sourceType: 'BUY' });
  rec('AT-69c', '6', 'TC-29 코드표에 없는 단위 "말" → 400 (FK)', r.status === 400 ? 'PASS' : 'FAIL', '400', `${r.status} ${r.text}`, { ms: r.ms });
}

async function phase7_asof(ctx) {
  log('\n### 7. as-of · 라인 편집 (TC-37~40 · TC-14)');
  if (READONLY) { rec('AT-70', '7', 'as-of 쓰기 검사', 'BLOCK', '-', 'FW_READONLY=1'); return; }
  const etc = ctx.cls.find(c => c.code === 'PT-ETC');
  const pl = await findHeader('PL-9000');
  let r = await POST(`${B}/items`, { pn: `${TAG}-ASOF`, name: 'as-of 시험 품목', classId: etc?.id, kind: 'PT', uom: 'EA', sourceType: 'BUY' });
  r = await POST(`${B}/bom-lines`, { headerId: pl.id, pn: `${TAG}-ASOF`, qtyPer: 1, uom: 'EA', effFrom: '2027-01-01' });
  rec('AT-70', '7', 'PL-9000 에 2027-01-01 부터 유효한 라인 추가 → 201', r.status === 201 || r.status === 200 ? 'PASS' : 'FAIL', '201', `${r.status} ${r.text}`, { ms: r.ms });
  const now = await GET(`${B}/bom/PL-9000?asOf=${ASOF}`), fut = await GET(`${B}/bom/PL-9000?asOf=2027-06-01`);
  const inNow = flat(now.json?.nodes).some(n => n.pn === `${TAG}-ASOF`), inFut = flat(fut.json?.nodes).some(n => n.pn === `${TAG}-ASOF`);
  rec('AT-71', '7', `as-of ${ASOF} 에는 없고 2027-06-01 에는 있다`, !inNow && inFut ? 'PASS' : 'FAIL', 'false / true', { inNow, inFut });
  const t = await GET(`${B}/bom/BLDC-500W-48V?asOf=2027-06-01`);
  rec('AT-72', '7', 'as-of 2027-06-01 완성품 전개 EA 77 (76 + 시험 품목 1)', near(t.json?.totals?.EA, 77) ? 'PASS' : 'FAIL', '77', t.json?.totals, { ms: t.ms });
  // TC-14 b≠1: GB-8000 2개 → GB-8010 2 · GB-8040 4 · totals EA 81 g 246 — 확인 후 되돌린다
  const gbl = await findLine('BLDC-500W-48V', 'GB-8000');
  r = gbl ? await PUT(`${B}/bom-lines/${gbl.id}`, { qtyPer: 2 }) : { status: 0 };
  const b2 = await GET(`${B}/bom/BLDC-500W-48V?asOf=${ASOF}`);
  const n2 = flat(b2.json?.nodes); const g10 = n2.find(n => n.pn === 'GB-8010'), g40 = n2.find(n => n.pn === 'GB-8040');
  const p85 = await GET(`${B}/process/OP-B85`);
  const p10 = (p85.json?.inputs || []).find(x => x.pn === 'GB-8010');
  rec('AT-73', '7', 'TC-14/57b GB-8000 2개 → GB-8010 qpp 2 · GB-8040 4 · totals EA 81 g 246 · process/OP-B85 GB-8010 2', r.status === 200 && g10?.qtyPerProduct === 2 && g40?.qtyPerProduct === 4 && near(b2.json?.totals?.EA, 81) && near(b2.json?.totals?.g, 246) && p10?.qtyPerProduct === 2 ? 'PASS' : 'FAIL', '2/4/81/246/2', { put: r.status, g10: g10?.qtyPerProduct, g40: g40?.qtyPerProduct, totals: b2.json?.totals, p10: p10?.qtyPerProduct });
  if (gbl) await PUT(`${B}/bom-lines/${gbl.id}`, { qtyPer: 1 });
  const b3 = await GET(`${B}/bom/BLDC-500W-48V?asOf=${ASOF}`);
  rec('AT-74', '7', '되돌린 뒤 totals 원상 (EA 76)', totalsMatch(b3.json?.totals) ? 'PASS' : 'FAIL', 'EA 76', b3.json?.totals);
}

async function phase8_lots() {
  log('\n### 8. 로트 계보 1건 정·역 (TC-45~47 · D-17 · R-13)');
  if (READONLY) { rec('AT-80', '8', '로트 쓰기 검사', 'BLOCK', '-', 'FW_READONLY=1'); return; }
  const P = (pn) => A(pn);
  const mk = async (body) => { const r = await POST(`${B}/lots`, body); return { r, id: r.json?.lot?.id ?? r.json?.id ?? null }; };
  const coil = await mk({ lotNo: `${TAG}-LOT-SC1011-A`, pn: 'SC-1011', qty: 850, uom: 'kg', supplier: 'POSCO', supplierLot: 'MS-8842' });
  rec('AT-80', '8', 'POST lots 코일 입고 로트 850 kg (POSCO / MS-8842) → 201', coil.id ? 'PASS' : 'FAIL', '201 id', `${coil.r.status} ${coil.r.text}`, { ms: coil.r.ms });
  if (!coil.id) return;
  const sub = await mk({ lotNo: `${TAG}-SUB-001`, pn: 'SC-1011', qty: 0.85, uom: 'kg', parentLotId: coil.id });
  const coil2 = (await GET(`${B}/lots/${coil.id}`)).json;
  rec('AT-81', '8', '분할 서브로트 0.85 kg (parentLotId) → 201 · 원로트 잔량 849.15 (D-17 차감)', sub.id && near(coil2?.qty, 849.15) && near(coil2?.qtyInit, 850) ? 'PASS' : 'FAIL', '201 / 849.15 / init 850', { status: sub.r.status, qty: coil2?.qty, qtyInit: coil2?.qtyInit, text: sub.r.text }, { ms: sub.r.ms });
  let r = await POST(`${B}/lots`, { lotNo: `${TAG}-SUB-BIG`, pn: 'SC-1011', qty: 9999, uom: 'kg', parentLotId: coil.id });
  rec('AT-81b', '8', '잔량보다 큰 분할 → 400 (D-17)', r.status === 400 ? 'PASS' : 'FAIL', '400', `${r.status} ${r.text}`, { ms: r.ms });
  const consumeRoute = async (outId, body) => POST(`${B}/lots/${outId}/consume`, body);
  const p1 = await mk({ lotNo: `${TAG}-LOT-SC1010P-7`, pn: P('SC-1010P'), qty: 80, uom: 'SHT', stateOp: 'OP-A10' });
  if (!p1.id) { rec('AT-82', '8', 'SC-1010P 산출 로트 생성', 'FAIL', '201', `${p1.r.status} ${p1.r.text}`); return; }
  r = await consumeRoute(p1.id, { inLotId: sub.id, qty: 0.85, uom: 'kg', op: 'OP-A10' });
  if (r.status === 404 && !r.json?.error?.includes('로트')) { rec('AT-82', '8', 'POST lots/:id/consume (투입 계보) 라우트', 'BLOCK', '201', `${r.status} — §10 에 계보 쓰기 라우트가 없다. 정·역 추적은 DB 직접 주입 없이는 검증 불가`, { note: '§10 에 lot_genealogy 쓰기 라우트 추가 요청' }); return; }
  rec('AT-82', '8', 'consume: SC-1010P 로트 ← 서브로트 0.85 kg @OP-A10 → 201 · 서브로트 잔량 0/CONSUMED', (r.status === 201 || r.status === 200) && near(r.json?.inLot?.qty, 0) ? 'PASS' : 'FAIL', '201 / 0', `${r.status} ${r.text}`, { ms: r.ms });
  const c1 = await mk({ lotNo: `${TAG}-LOT-SC1010-7`, pn: 'SC-1010', qty: 1, uom: 'EA', stateOp: 'OP-A20' });
  await consumeRoute(c1.id, { inLotId: p1.id, qty: 80, uom: 'SHT', op: 'OP-A20' });
  const sa = await mk({ lotNo: `${TAG}-LOT-SA1000-31`, pn: 'SA-1000', qty: 1, uom: 'EA', stateOp: 'OP-A100' });
  await consumeRoute(sa.id, { inLotId: c1.id, qty: 1, uom: 'EA', op: 'OP-A100' });
  const sn = await mk({ lotNo: `${TAG}-SN-000481`, pn: 'BLDC-500W-48V', qty: 1, uom: 'EA', kind: 'SERIAL', stateOp: 'OP-B120' });
  r = await consumeRoute(sn.id, { inLotId: sa.id, qty: 1, uom: 'EA', op: 'OP-B120' });
  rec('AT-83', '8', '계보 4단 등록 (SC-1010P → SC-1010 → SA-1000 → 시리얼) → 201', sn.id && (r.status === 201 || r.status === 200) ? 'PASS' : 'FAIL', '201', `${r.status} ${r.text}`, { ms: r.ms });
  const fwd = await GET(`${B}/lots/${coil.id}/genealogy?dir=fwd`);
  const fl = flat(fwd.json?.tree); const fpn = new Set(fl.map(n => N(n.pn)));
  rec('AT-84', '8', 'genealogy fwd (코일 → 시리얼): SC-1011·SC-1010P·SC-1010·SA-1000·BLDC 전부 도달 · 시리얼 1', ['SC-1010P', 'SC-1010', 'SA-1000', 'BLDC-500W-48V'].every(p => fpn.has(p)) && fl.filter(n => n.kind === 'SERIAL').length === 1 ? 'PASS' : 'FAIL', '5품목 · SERIAL 1', { reach: [...fpn], serial: fl.filter(n => n.kind === 'SERIAL').map(n => n.lotNo) }, { ms: fwd.ms });
  const back = await GET(`${B}/lots/${sn.id}/genealogy?dir=back`);
  const bl = flat(back.json?.tree); const bpn = new Set(bl.map(n => N(n.pn))); const coilNode = bl.find(n => n.lotNo === `${TAG}-LOT-SC1011-A`);
  rec('AT-85', '8', 'genealogy back (시리얼 → 코일): 밀시트 MS-8842 · 공급사 POSCO 까지 도달 · 간선에 공정·수량', ['SA-1000', 'SC-1010', 'SC-1010P', 'SC-1011'].every(p => bpn.has(p)) && coilNode?.supplierLot === 'MS-8842' && bl.some(n => n.edge?.op === 'OP-A10' && near(n.edge?.qty, 0.85)) ? 'PASS' : 'FAIL', 'MS-8842 / OP-A10 0.85', { reach: [...bpn], coil: coilNode && { supplier: coilNode.supplier, supplierLot: coilNode.supplierLot }, edges: bl.map(n => n.edge && [n.edge.kind, n.edge.op, n.edge.qty]) }, { ms: back.ms });
  r = await consumeRoute(sub.id, { inLotId: p1.id, qty: 1, uom: 'SHT', force: true });
  rec('AT-86', '8', 'R-13 계보 순환 (서브로트 ← SC-1010P 로트) → 400 "R-13:"', rejectedWith(r, 'R-13:') ? 'PASS' : 'FAIL', '400 R-13:', `${r.status} ${r.text}`, { ms: r.ms });
  r = await consumeRoute(c1.id, { inLotId: c1.id, qty: 1, uom: 'EA', force: true });
  rec('AT-86b', '8', 'R-13 자기참조 (in = out) → 400', r.status === 400 ? 'PASS' : 'FAIL', '400', `${r.status} ${r.text}`, { ms: r.ms });
  r = await consumeRoute(c1.id, { inLotId: p1.id, qty: 1, uom: 'SHT', op: 'OP-A20', force: true });
  rec('AT-86c', '8', 'D-16 같은 간선(out,in,공정) 중복 → 400 (UNIQUE)', r.status === 400 ? 'PASS' : 'FAIL', '400', `${r.status} ${r.text}`, { ms: r.ms });
  const ls = await GET(`${B}/lots?pn=SC-1011`);
  rec('AT-87', '8', 'lots?pn=SC-1011 → 이번 실행 로트 2 (원로트 + 서브로트)', (ls.json || []).filter(x => x.lotNo.startsWith(TAG)).length === 2 ? 'PASS' : 'FAIL', '2', (ls.json || []).filter(x => x.lotNo.startsWith(TAG)).map(x => [x.lotNo, x.qty, x.status]), { ms: ls.ms });
  const s = await GET(`${B}/summary`);
  rec('AT-88', '8', '계보 등록 뒤 v_chk_summary 에 D-17(수량 보존 위반) 0', !s.json?.check?.['D-17'] ? 'PASS' : 'FAIL', 'D-17 없음', s.json?.check, { ms: s.ms });
}

async function phase9_compat() {
  log('\n### 9. 호환 계약 — DB 직접 (equipment:detail 대체) · 성능');
  if (!DATA_DIR) { rec('AT-90', '9', 'FW_DATA_DIR 격리 DB 전후 대조', 'BLOCK', '-', 'FW_DATA_DIR 미지정 — node compat-diff.mjs <db> 로 별도 실행'); }
  else {
    const dbPath = path.join(DATA_DIR, 'factory.db');
    try {
      const { openRO, compatDiff } = await import('./lib/compat.mjs');
      const db = openRO(dbPath); const c = compatDiff(db, { tmpMap: TMP }); db.close();
      fs.writeFileSync(path.join(OUT, `compat-diff-${RUN}.json`), JSON.stringify(c, null, 1), 'utf8');
      rec('AT-90', '9', 'process_inputs · parts 가 뷰(이행 [3]) 이고 *_legacy 표가 남아 있다', c.kinds.process_inputs === 'view' && c.kinds.parts === 'view' && c.kinds.process_inputs_legacy === 'table' && c.kinds.parts_legacy === 'table' ? 'PASS' : 'FAIL', 'view/view/table/table', c.kinds);
      if (c.diff) {
        rec('AT-91', '9', 'queries.processInputs SQL 그대로 — legacy 36행 ↔ 뷰 46행 · 전에만 (B90,PE-6000) · 후에만 11 · 공통 35 수량/단위/이름/규격 차 0', c.verdict.all ? 'PASS' : 'FAIL', 'verdict all true', { verdict: c.verdict, onlyBefore: c.diff.onlyBefore, onlyAfter: c.diff.onlyAfter.length, qty: c.diff.qty, unit: c.diff.unit, name: c.diff.name.length, spec: c.diff.spec.length, level: c.diff.level, parentPn: c.diff.parentPn.length }, { note: 'level·parentPn 변화는 계획서 §10.3 예고분(값만 바뀐다)' });
        rec('AT-92', '9', 'parts_legacy 56 · parts(뷰) 59 · listProcesses input_count 합 46', c.partsBefore === 56 && c.partsAfter === 59 && Object.values(c.listProcesses).reduce((a, b) => a + b, 0) === 46 ? 'PASS' : 'FAIL', '56/59/46', { partsBefore: c.partsBefore, partsAfter: c.partsAfter, sum: Object.values(c.listProcesses).reduce((a, b) => a + b, 0) });
      } else rec('AT-91', '9', '전후 대조', 'BLOCK', '-', c.note);
    } catch (e) { rec('AT-90', '9', 'DB 직접 조회', 'FAIL', '열림', `${e.message}`); }
  }
  const perf = [];
  for (const p of [`${B}/bom/BLDC-500W-48V?asOf=${ASOF}`, `${B}/where-used/BF-3040`, `${B}/summary`, `${B}/items`, `${B}/process/OP-B90`, `/api/admin/bop`]) { const r = await GET(p); perf.push([p.replace(B, ''), r.ms]); }
  rec('AT-93', '9', '응답 시간 — 전개·역전개·요약·품목·공정·bop 각 < 1,000 ms', perf.every(x => x[1] < 1000) ? 'PASS' : 'FAIL', '< 1000', perf);
}

// ══════════════════════════════════════════════════════════════════════════
function writeReport() {
  const n = { PASS: 0, FAIL: 0, BLOCK: 0, NOTE: 0 }; for (const r of R) n[r.verdict]++;
  const md = [];
  md.push(`# 자재 API 인수 테스트 결과 — ${RUN}`);
  md.push(``, `서버 ${URL_} · as-of ${ASOF} · 데이터 접두 ${TAG} · FW_DATA_DIR ${DATA_DIR || '(미지정)'} · readonly=${READONLY}`);
  md.push(``, `**합계 ${R.length} — PASS ${n.PASS} · FAIL ${n.FAIL} · BLOCK ${n.BLOCK} · NOTE ${n.NOTE}**`, ``);
  md.push(`| # | 구분 | 검사 | 판정 | 기대 | 실제 | ms |`, `|---|---|---|---|---|---|---:|`);
  const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 220);
  for (const r of R) md.push(`| ${r.tc} | ${r.group} | ${esc(r.desc)} | **${r.verdict}** | ${esc(r.expect)} | ${esc(r.actual)} | ${r.ms ?? ''} |`);
  const notes = R.filter(r => r.note); if (notes.length) { md.push(``, `## 비고`); for (const r of notes) md.push(`- ${r.tc}: ${r.note}`); }
  fs.writeFileSync(path.join(OUT, `acceptance-${RUN}.json`), JSON.stringify({ run: RUN, url: URL_, asof: ASOF, tag: TAG, dataDir: DATA_DIR, summary: n, results: R }, null, 1), 'utf8');
  fs.writeFileSync(path.join(OUT, 'acceptance-latest.json'), JSON.stringify({ run: RUN, url: URL_, summary: n, results: R }, null, 1), 'utf8');
  fs.writeFileSync(path.join(OUT, 'acceptance-latest.md'), md.join('\n') + '\n', 'utf8');
  log(`\n${'='.repeat(78)}\n합계 ${R.length} — PASS ${n.PASS} · FAIL ${n.FAIL} · BLOCK ${n.BLOCK} · NOTE ${n.NOTE}`);
  log(`FAIL: ${R.filter(r => r.verdict === 'FAIL').map(r => r.tc).join(', ') || '없음'}`);
  log(`→ out/acceptance-${RUN}.json · out/acceptance-latest.md`);
  return n;
}

(async () => {
  log('='.repeat(78)); log(`자재 API 인수 테스트 — ${URL_} · as-of ${ASOF} · ${RUN}`); log('='.repeat(78));
  try {
    await phase0_auth();
    await phase1_import();
    const ctx = await phase2_master();
    await phase3_bom();
    await phase4_whereused();
    await phase5_process();
    await phase6_triggers(ctx);
    await phase7_asof(ctx);
    await phase8_lots();
    await phase9_compat();
  } catch (e) { log(`!! 중단: ${e.message}`); }
  const n = writeReport();
  process.exit(n.FAIL ? 1 : 0);
})();
