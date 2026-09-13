// 2라운드 — 윤태경 결의안(docs/4m/쟁점3-결의안.md) 실증. 노하린.
// 운영 DB(data/factory.db) 는 열지 않는다. 사본 factory-snapshot.db 를 복사한 resolution.db 에서만 돈다.
// 실행: node docs/4m/prototype/issue3/resolution-check.mjs   (cwd = 저장소 루트)
//
// 이 스크립트는 "손으로 INSERT" 가 아니라 **운영 적재기 그 자체**(server/materials.js loadMaterials)를
// 결의안 명세대로 고친 cleansing/source JSON 사본에 물려 돌린다. 원본 JSON 은 건드리지 않는다.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMaterials } from '../../../../server/materials.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');
const SNAP = path.join(HERE, 'factory-snapshot.db');
const WORK = path.join(HERE, 'resolution.db');

const out = [];
const P = (s = '') => { out.push(s); console.log(s); };
const H = (s) => { P(''); P('='.repeat(78)); P(s); };
let fail = 0, pass = 0;
const chk = (id, ok, label, got, want) => {
  if (ok) { pass++; P(`  [OK  ] ${id} ${label}`); }
  else { fail++; P(`  [FAIL] ${id} ${label}\n         실측 ${JSON.stringify(got)}\n         기대 ${JSON.stringify(want)}`); }
  return ok;
};
// 키 순서에 의존하지 않는 정규화 비교 (객체는 키 정렬)
const norm = (v) => Array.isArray(v) ? v.map(norm)
  : (v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, norm(v[k])])) : v);
const eq = (id, got, want, label) => chk(id, JSON.stringify(norm(got)) === JSON.stringify(norm(want)), label, got, want);

function freshDb(tag = '') {
  const file = tag ? WORK.replace(/\.db$/, `-${tag}.db`) : WORK;
  for (const ext of ['', '-wal', '-shm']) { const p = file + ext; if (fs.existsSync(p)) fs.unlinkSync(p); }
  fs.copyFileSync(SNAP, file);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = OFF');   // server/db.js 와 동일 (어디에도 ON 이 없다)
  return db;
}
const g1 = (db, sql, ...p) => db.prepare(sql).get(...p);
const gA = (db, sql, ...p) => db.prepare(sql).all(...p);
const gN = (db, sql, ...p) => Object.values(g1(db, sql, ...p))[0];

// ───────────────────────────────────────────────────────────────────────────
// 결의안 §4.4·§4.5 명세를 원본 JSON 사본에 적용 (원본 파일은 읽기만 한다)
// ───────────────────────────────────────────────────────────────────────────
const rawSource = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/bldc/bldc-500w-48v.json'), 'utf8'));
const rawClean = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/4m/cleansing-v1.json'), 'utf8'));

function amendedSource() {
  const s = structuredClone(rawSource);
  const i87 = s.processes.findIndex(p => p.op === 'OP-B87');
  if (i87 < 0) throw new Error('OP-B87 없음');
  s.processes.splice(i87 + 1, 0,
    { op: 'OP-B88', seq: 11, line: '조립 라인', name: '플랜지샤프트 No.2 조립', equipment: '플랜지샤프트 조립지그',
      inputText: 'FS-7023, FS-7021, FS-7022, OR-7025', inputs: ['FS-7023', 'FS-7021', 'FS-7022', 'OR-7025'],
      output: 'FS-7020 완성', ctSec: 25.0, kind: '표준', qc: '부싱 압입 완료, O-Ring 2개소 장착 확인',
      note: '원천 누락 보완 (AM-1) — 쟁점 3, PM 승인 2026-09-13. C/T·QC 는 잠정', stagePn: 'FS-7020' },
    { op: 'OP-B89', seq: 12, line: '조립 라인', name: '동력전달부 체결', equipment: '전동 토크드라이버, 체결 지그',
      inputText: 'FS-7010, FS-7020, GB-8000, PL-9000', inputs: ['FS-7010', 'FS-7020', 'GB-8000', 'PL-9000'],
      output: '동력전달부 결합', ctSec: 40.0, kind: '표준', qc: '체결 상태 확인, 출력축 회전 이상음 無',
      note: '원천 누락 보완 (AM-1) — 쟁점 3, PM 승인 2026-09-13. C/T·QC 는 잠정', stagePn: 'FS-7010' });
  const renum = { 'OP-B90': 13, 'OP-B100': 14, 'OP-B110': 15, 'OP-B120': 16 };
  for (const p of s.processes) if (renum[p.op]) p.seq = renum[p.op];
  s.version = 2;
  s.source = { ...s.source, amendments: [{ id: 'AM-1', date: '2026-09-13', issue: '쟁점 3', source_modified: false, process_count_after: 26 }] };
  return s;
}

function amendedCleansing() {
  const c = structuredClone(rawClean);
  // (b) line_process 미배정 8행 → 배정 (배열 순서 = B88 블록 → B89 블록)
  const rows = c.line_process.rows.filter(r => !(
    (r[0] === 'BLDC-500W-48V' && ['FS-7010', 'FS-7020', 'GB-8000', 'PL-9000'].includes(r[1])) ||
    (r[0] === 'FS-7020' && ['FS-7023', 'FS-7021', 'FS-7022', 'OR-7025'].includes(r[1]))));
  rows.push(
    ['FS-7020', 'FS-7023', 'OP-B88', 'AMENDED', 'BACKFLUSH', '원천 BOP 누락 보완 — OP-B88 신설. 09시트 C40'],
    ['FS-7020', 'FS-7021', 'OP-B88', 'AMENDED', 'BACKFLUSH', '09시트 C41 (V12-1 해소)'],
    ['FS-7020', 'FS-7022', 'OP-B88', 'AMENDED', 'BACKFLUSH', '09시트 C42 (V12-1 해소)'],
    ['FS-7020', 'OR-7025', 'OP-B88', 'AMENDED', 'BULK', '09시트 C43. 2 EA · trace NONE ↔ BULK (D-18)'],
    ['BLDC-500W-48V', 'FS-7010', 'OP-B89', 'AMENDED', 'BACKFLUSH', '원천 BOP 누락 보완 — OP-B89 신설. 분해도 stage 5'],
    ['BLDC-500W-48V', 'FS-7020', 'OP-B89', 'AMENDED', 'BACKFLUSH', 'stage 6 · OP-B88 산출물'],
    ['BLDC-500W-48V', 'GB-8000', 'OP-B89', 'AMENDED', 'BACKFLUSH', 'stage 7 · OP-B85 산출물'],
    ['BLDC-500W-48V', 'PL-9000', 'OP-B89', 'AMENDED', 'BACKFLUSH', 'stage 8 · OP-B87 산출물']);
  c.line_process.rows = rows;
  // (c) process_out — OP-B87 뒤에 2행
  const o87 = c.process_out.rows.findIndex(r => r[0] === 'OP-B87');
  c.process_out.rows.splice(o87 + 1, 0, ['OP-B88', 'FS-7020', 1, null, 1], ['OP-B89', 'BLDC-500W-48V', 0, '동력전달부 결합', null]);
  // (d) line_attrs "부모 추정" note 고쳐쓰기
  for (const a of c.line_attrs) {
    if (a.parent === 'FS-7020' && ['FS-7021', 'FS-7022', 'OR-7025'].includes(a.child)) {
      a.note = `부모 확정 — 09_BOM_Flat_Consolidated 상위 P/N = FS-7020 손입력 기재. 쟁점 3 닫힘 2026-09-13`;
    }
  }
  // (e) expected 갱신
  const e = c.expected;
  e.process_material_in = 54; e.process_material_out = 26; e.process_material_out_final = 8;
  e.bop_status = { ASSIGNED: 54, UNASSIGNED: 2, PHANTOM: 3 };
  e.unassigned_lines = ['SA-1000>IP-1040', 'SA-1000>LC-1080'];
  e.compat_process_inputs_rows = 54;
  e.v_chk_summary = { 'D-8': 2, 'R-10': 2, _others: 0 };
  c.version = '1.1';
  return c;
}

// importBop 의 공정 UPSERT 부분만 그대로 재현 (server/db.js queries.upsertProcess)
const UPSERT_PROC = `
  INSERT INTO processes (product_code, op, seq, line, name, equipment_hint, input_text, output, ct_sec, kind, qc, note, stage_pn)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(product_code, op) DO UPDATE SET
    seq = excluded.seq, line = excluded.line, name = excluded.name, equipment_hint = excluded.equipment_hint,
    input_text = excluded.input_text, output = excluded.output, ct_sec = excluded.ct_sec, kind = excluded.kind,
    qc = excluded.qc, note = excluded.note, stage_pn = excluded.stage_pn`;
function applyProcesses(db, src) {
  const st = db.prepare(UPSERT_PROC);
  for (const pr of src.processes) st.run(src.product.code, String(pr.op), pr.seq ?? null, pr.line ?? null, pr.name ?? null,
    pr.equipment ?? null, pr.inputText ?? null, pr.output ?? null, pr.ctSec ?? null, pr.kind ?? null, pr.qc ?? null, pr.note ?? null, pr.stagePn ?? null);
  // products.spec_json 의 exploded 는 원본 그대로(§4.5(g) 변경 없음) — 갱신 불필요
}

// importLayout 의 설비 UPSERT 부분 재현 (clampInt 0..23 / 0..15 포함)
const MAP_W = 24, MAP_H = 16;
const clampInt = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : dflt; };
const NEW_LAYOUT = [
  ['OP-B10', 1, 10], ['OP-B20', 4, 10], ['OP-B30', 7, 10], ['OP-B40', 10, 10],
  ['OP-B50', 13, 10], ['OP-B60', 16, 10], ['OP-B70', 19, 10], ['OP-B80', 22, 10],
  ['OP-B85', 1, 13], ['OP-B87', 4, 13], ['OP-B88', 7, 13], ['OP-B89', 10, 13],
  ['OP-B90', 13, 13], ['OP-B100', 16, 13], ['OP-B110', 19, 13], ['OP-B120', 22, 13],
];
function applyLayout(db) {
  const zone = g1(db, `SELECT * FROM zones WHERE name = '조립 라인'`);
  for (const [code, x0, y0] of NEW_LAYOUT) {
    const x = clampInt(x0, 0, MAP_W - 1, 0), y = clampInt(y0, 0, MAP_H - 1, 0);
    const cur = g1(db, 'SELECT * FROM equipments WHERE code = ?', code);
    if (cur) db.prepare('UPDATE equipments SET zone_id=?, x=?, y=?, hidden=0 WHERE id=?').run(zone.id, x, y, cur.id);
    else db.prepare(`INSERT INTO equipments (zone_id, code, name, x, y, manager, type, op, hidden) VALUES (?,?,?,?,?,'', 'assembly', ?, 0)`)
      .run(zone.id, code, code === 'OP-B88' ? '플랜지샤프트 조립 지그' : '동력전달부 체결기', x, y, code);
  }
}

// ───────────────────────────────────────────────────────────────────────────
H('0. 기준선 — 사본 DB(무변경)');
{
  const db = freshDb('base');
  P(`  processes ${gN(db, 'SELECT COUNT(*) c FROM processes')} · pm IN ${gN(db, `SELECT COUNT(*) c FROM process_material WHERE io='IN'`)}`
    + ` · OUT ${gN(db, `SELECT COUNT(*) c FROM process_material WHERE io='OUT'`)}(final ${gN(db, `SELECT COUNT(*) c FROM process_material WHERE io='OUT' AND is_final=1`)})`
    + ` · parts ${gN(db, 'SELECT COUNT(*) c FROM parts')} · process_inputs ${gN(db, 'SELECT COUNT(*) c FROM process_inputs')}`);
  P('  v_chk_summary: ' + JSON.stringify(gA(db, 'SELECT rule, cnt FROM v_chk_summary')));
  P('  조립 라인 총 C/T ' + gN(db, `SELECT COALESCE(SUM(ct_sec),0) c FROM processes WHERE line='조립 라인'`)
    + ' · MAX ' + gN(db, `SELECT MAX(ct_sec) c FROM processes WHERE line='조립 라인'`));
  P('  60초 동률 공정: ' + JSON.stringify(gA(db, `SELECT op, ct_sec FROM processes WHERE line='조립 라인' AND ct_sec >= 60 ORDER BY seq`)));
  db.close();
}

// ───────────────────────────────────────────────────────────────────────────
H('1. 결의안 권고안 A 적용 — 운영 적재기(loadMaterials) 그대로 사용');
const db = freshDb('main');
const src = amendedSource(), cl = amendedCleansing();
let res1;
try {
  applyProcesses(db, src);
  P('  ① processes UPSERT 26행 완료 (seq 재번호 포함) — 트리거 없음, 예외 없음');
  const seqAfter = gA(db, `SELECT op, seq FROM processes WHERE line='조립 라인' ORDER BY seq`).map(r => `${r.op}=${r.seq}`).join(',');
  P('     ' + seqAfter);
  res1 = loadMaterials(db, { source: src, cleansing: cl, strict: false });
  P(`  ② loadMaterials 완료 — OUT ${res1.loaded.out}행 · IN ${res1.loaded.in}행 처리`);
  P(`     expected 대조: ${res1.expectedMatch ? '일치' : '불일치 ' + res1.mismatches.length + '건'}`);
  for (const m of res1.mismatches || []) P(`     [MISMATCH] ${m.key}  실측 ${JSON.stringify(m.actual)}  기대 ${JSON.stringify(m.expected)}`);
  for (const w of res1.warnings || []) P(`     [warn] ${w}`);
  applyLayout(db);
  P('  ③ equipments UPSERT 16행 완료');
} catch (e) {
  P('  [적재 실패] ' + e.message);
  throw e;
}
chk('L-1', res1.expectedMatch, 'expected 대조 전체 일치', res1.mismatches?.map(m => m.key), []);

// ───────────────────────────────────────────────────────────────────────────
H('2. 수용 기준 A-1 ~ A-22 (1라운드 §4) — N=2, F=1, P=0');
const N = 2, F = 1, P0 = 0;

eq('A-1', gN(db, 'SELECT COUNT(*) c FROM processes'), 24 + N, '공정 수 = 26');

{
  const r = g1(db, `SELECT COUNT(*) n, COUNT(DISTINCT seq) d, MIN(seq) lo, MAX(seq) hi FROM processes WHERE line='조립 라인'`);
  eq('A-2', [r.n, r.d, r.lo, r.hi], [14 + N, 14 + N, 1, 14 + N], '조립 라인 seq 1~16 중복·결번 0');
  const amat = g1(db, `SELECT COUNT(*) n, COUNT(DISTINCT seq) d, MIN(seq) lo, MAX(seq) hi FROM processes WHERE line='아마추어 라인'`);
  eq('A-2b', [amat.n, amat.d, amat.lo, amat.hi], [10, 10, 1, 10], '아마추어 라인 불변');
}

eq('A-3', gN(db, `SELECT COUNT(*) c FROM processes p WHERE (SELECT COUNT(*) FROM process_material m WHERE m.process_id=p.id AND m.io='OUT') <> 1`), 0, '공정당 OUT 정확히 1행');

{
  const r = g1(db, `SELECT COUNT(*) n, SUM(is_final) f FROM process_material WHERE io='OUT'`);
  eq('A-4', [r.n, r.f], [24 + N, 7 + F], 'OUT 26행 · is_final 8');
}

{
  const d8 = gA(db, 'SELECT detail FROM v_chk_bop_unassigned').map(r => r.detail).sort();
  eq('A-5', d8, ['SA-1000 > IP-1040', 'SA-1000 > LC-1080'], 'D-8 미배정 = 쟁점 6 의 2건뿐');
  const r10 = gA(db, 'SELECT detail FROM v_chk_r10_split').map(r => r.detail.replace(/ split=.*/, '')).sort();
  eq('A-6', r10, ['SA-1000 > IP-1040', 'SA-1000 > LC-1080'], 'R-10 = 같은 2건');
}

{
  const r22 = gA(db, 'SELECT detail FROM v_chk_r22_seq');
  eq('A-7', r22.length, 0, 'R-22 (재번호 UPDATE 직후 뷰 재조회) 0건');
  if (r22.length) for (const r of r22) P('        ' + r.detail);
}

{
  const sum = Object.fromEntries(gA(db, 'SELECT rule, cnt FROM v_chk_summary').map(r => [r.rule, r.cnt]));
  eq('A-8', sum, { 'D-8': 2, 'R-10': 2 }, 'v_chk_summary = D-8 2 · R-10 2 뿐');
}

{
  const leaf = gN(db, `SELECT ROUND(SUM(q.qty_per_product),4) c FROM v_bom_line_qpp q
     WHERE q.is_primary=1 AND NOT EXISTS(SELECT 1 FROM bom_header h WHERE h.parent_item_id=q.child_item_id AND h.status<>'OBSOLETE')`);
  const leafN = gN(db, `SELECT COUNT(DISTINCT q.child_item_id) c FROM v_bom_line_qpp q
     WHERE q.is_primary=1 AND NOT EXISTS(SELECT 1 FROM bom_header h WHERE h.parent_item_id=q.child_item_id AND h.status<>'OBSOLETE')`);
  eq('A-9', [leaf, leafN], [310.35, 49], '잎 소요량 합 310.35 (09!I53) · 잎 품목 49');
}

{
  const want = { 'BLDC-500W-48V>FS-7010': 1, 'BLDC-500W-48V>FS-7020': 1, 'BLDC-500W-48V>GB-8000': 1, 'BLDC-500W-48V>PL-9000': 1,
    'FS-7020>FS-7023': 1, 'FS-7020>FS-7021': 1, 'FS-7020>FS-7022': 1, 'FS-7020>OR-7025': 2 };
  const got = Object.fromEntries(gA(db, `SELECT parent_pn||'>'||child_pn k, qty_per_product v, uom_code u FROM v_bom_line_qpp
      WHERE child_pn IN ('FS-7010','FS-7020','GB-8000','PL-9000','FS-7023','FS-7021','FS-7022','OR-7025') AND is_primary=1`).map(r => [r.k, r.v]));
  eq('A-10', got, want, '8건 완성품당 소요량');
  const uoms = [...new Set(gA(db, `SELECT uom_code u FROM v_bom_line_qpp WHERE child_pn IN ('FS-7010','FS-7020','GB-8000','PL-9000','FS-7023','FS-7021','FS-7022','OR-7025')`).map(r => r.u))];
  eq('A-10b', uoms, ['EA'], '8건 단위 전부 EA');
}

eq('A-11', gN(db, `SELECT COUNT(*) c FROM process_material WHERE io='IN'`), 54 - P0, 'IN 54행');
eq('A-12', gN(db, 'SELECT COUNT(*) c FROM parts'), 59, 'parts 호환 뷰 59 불변');
{
  eq('A-13', gN(db, 'SELECT COUNT(*) c FROM process_inputs'), 54 - P0, 'process_inputs 54');
  eq('A-13b', gN(db, 'SELECT COUNT(*) c FROM (SELECT process_id,pn FROM process_inputs GROUP BY 1,2 HAVING COUNT(*)>1)'), 0, 'process_inputs (process_id,pn) 중복 0');
}

{
  const self = gA(db, `SELECT p.op FROM process_material o JOIN processes p ON p.id=o.process_id
     WHERE o.io='OUT' AND EXISTS(SELECT 1 FROM process_material m JOIN bom_line l ON l.line_id=m.line_id
        WHERE m.process_id=o.process_id AND m.io='IN' AND l.child_item_id=o.item_id)`);
  eq('A-14', self.map(r => r.op), [], '자기 산출·투입(수명 0 로트) 0건');
}

{
  const gaps = gA(db, `SELECT s.value->>'stage' st, s.value->>'pn' pn FROM products p, json_each(json_extract(p.spec_json,'$.exploded')) s
     WHERE NOT EXISTS (SELECT 1 FROM processes pr WHERE pr.product_code=p.code AND pr.stage_pn = s.value->>'pn')`);
  eq('A-15', gaps.map(r => `${r.st}:${r.pn}`), [], '분해도 9단계 전부 공정 ≥1');
}

{
  const n = gN(db, 'SELECT COUNT(*) c FROM equipments WHERE zone_id=6 AND hidden=0');
  chk('A-16', n === 14 + N && n <= 16, `조립 라인 설비 ${n}대 (=16, ≤16)`, n, 16);
}

{
  const zone = g1(db, 'SELECT * FROM zones WHERE id=6');
  const outside = gA(db, `SELECT code,x,y FROM equipments WHERE hidden=0 AND zone_id=6 AND NOT (x>=? AND x<? AND y>=? AND y<?)`,
    zone.rect_x, zone.rect_x + zone.rect_w, zone.rect_y, zone.rect_y + zone.rect_h);
  eq('A-17a', outside, [], '조립 라인 설비 전부 zone rect(0,8,24,8) 안');
  const offmap = gA(db, `SELECT code,x,y FROM equipments WHERE hidden=0 AND (x<0 OR x>${MAP_W - 1} OR y<0 OR y>${MAP_H - 1})`);
  eq('A-17b', offmap, [], '표시 설비 전부 맵 24×16 안');
  const dupVis = gA(db, `SELECT x,y,group_concat(code) codes FROM equipments WHERE hidden=0 GROUP BY x,y HAVING COUNT(*)>1`);
  eq('A-17c', dupVis, [], 'hidden=0 좌표 충돌 0');
  const dupAll = gA(db, `SELECT x,y,group_concat(code) codes FROM equipments GROUP BY x,y HAVING COUNT(*)>1`);
  eq('A-17d', dupAll, [], '숨김 11대 포함 좌표 충돌 0 (기존 (11,13) CNC-01↔OP-B90 해소)');
}

{
  const noEq = gA(db, `SELECT op FROM processes WHERE op NOT IN (SELECT op FROM equipments WHERE hidden=0 AND op IS NOT NULL)`).map(r => r.op);
  const noPr = gA(db, `SELECT code FROM equipments WHERE hidden=0 AND op IS NOT NULL AND op NOT IN (SELECT op FROM processes)`).map(r => r.code);
  eq('A-18', [noEq, noPr], [[], []], '설비↔공정 1:1 (양방향 0행)');
}

eq('A-19', gN(db, `SELECT COUNT(*) c FROM mat_lot m WHERE m.state_pm_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM process_material pm WHERE pm.pm_id=m.state_pm_id)`), 0, '로트 계보 dangling 0');

{
  const r = g1(db, `SELECT SUM(ct_sec) s, MAX(ct_sec) m FROM processes WHERE line='조립 라인'`);
  eq('A-20', [r.s, r.m], [530, 60], '조립 라인 총 C/T 530 · MAX 60 (UPH 60 유지)');
  const tops = gA(db, `SELECT op, ct_sec FROM processes WHERE line='조립 라인' AND ct_sec=(SELECT MAX(ct_sec) FROM processes WHERE line='조립 라인') ORDER BY seq`);
  P('       병목 동률: ' + JSON.stringify(tops.map(t => `${t.op} ${t.ct_sec}`)));
}

// A-21 멱등성 — 같은 적재를 한 번 더
{
  const before = gA(db, `SELECT pm_id, io, process_id, COALESCE(line_id,-1) l, COALESCE(item_id,-1) i FROM process_material ORDER BY pm_id`);
  const beforeItems = gA(db, 'SELECT item_id, pn FROM item ORDER BY item_id');
  const beforeLines = gA(db, 'SELECT line_id, bom_id, child_item_id, qty_per FROM bom_line ORDER BY line_id');
  applyProcesses(db, src);
  const res2 = loadMaterials(db, { source: src, cleansing: cl, strict: false });
  applyLayout(db);
  const after = gA(db, `SELECT pm_id, io, process_id, COALESCE(line_id,-1) l, COALESCE(item_id,-1) i FROM process_material ORDER BY pm_id`);
  const afterItems = gA(db, 'SELECT item_id, pn FROM item ORDER BY item_id');
  const afterLines = gA(db, 'SELECT line_id, bom_id, child_item_id, qty_per FROM bom_line ORDER BY line_id');
  chk('A-21a', res2.expectedMatch, '2회차 expected 대조 일치', res2.mismatches?.map(m => m.key), []);
  eq('A-21b', JSON.stringify(after) === JSON.stringify(before), true, '2회차 process_material pm_id 집합 동일');
  eq('A-21c', JSON.stringify(afterItems) === JSON.stringify(beforeItems), true, '2회차 item_id 동일');
  eq('A-21d', JSON.stringify(afterLines) === JSON.stringify(beforeLines), true, '2회차 bom_line line_id 동일');
  const sum2 = Object.fromEntries(gA(db, 'SELECT rule, cnt FROM v_chk_summary').map(r => [r.rule, r.cnt]));
  eq('A-21e', sum2, { 'D-8': 2, 'R-10': 2 }, '2회차 v_chk_summary 동일');
  const eq2 = gA(db, 'SELECT code,x,y FROM equipments WHERE zone_id=6 AND hidden=0 ORDER BY y,x');
  eq('A-21f', eq2.length, 16, '2회차 설비 16대 동일');
}

P('  A-22 (원천 문서 정합 — 11!A1 "12 공정" 등) 은 DB 로 판정 불가. §7 본문에서 서술 판정.');

// ───────────────────────────────────────────────────────────────────────────
H('3. 맵 좌표 전수 — 결의안 §4.6');
{
  P('  존: ' + JSON.stringify(gA(db, 'SELECT id,name,rect_x,rect_y,rect_w,rect_h,hidden FROM zones')));
  P('  MAP 24×16');
  const rows = gA(db, 'SELECT code,x,y,hidden,zone_id FROM equipments ORDER BY hidden, y, x');
  for (const r of rows) P(`   ${r.hidden ? '숨김' : '표시'} ${String(r.code).padEnd(8)} (${r.x},${r.y}) zone ${r.zone_id}`);
  const y10 = rows.filter(r => !r.hidden && r.y === 10).map(r => r.x).sort((a, b) => a - b);
  const y13 = rows.filter(r => !r.hidden && r.y === 13).map(r => r.x).sort((a, b) => a - b);
  eq('M-1', y10, [1, 4, 7, 10, 13, 16, 19, 22], '1행(y=10) x 8칸');
  eq('M-2', y13, [1, 4, 7, 10, 13, 16, 19, 22], '2행(y=13) x 8칸');
  const hid = rows.filter(r => r.hidden).map(r => `${r.code}(${r.x},${r.y})`);
  P('  숨김 11대: ' + hid.join(' '));
  const clash = rows.filter(r => r.hidden).filter(h => rows.some(v => !v.hidden && v.x === h.x && v.y === h.y));
  eq('M-3', clash.map(r => r.code), [], '숨김 설비 ↔ 표시 설비 좌표 충돌 0');
  // 3행을 만들 여지
  P('  참고: zone rect y 8~15 에서 y=10·13 만 사용. y=8,9,11,12,14,15 는 비어 있다 (3행 여지는 남는다 — 다만 숨김 ASM/INS/PKG 4대가 y=11 을 점유)');
  const y11 = rows.filter(r => r.y === 11).map(r => `${r.code}(${r.x},11)`);
  P('  y=11 점유(전부 숨김): ' + y11.join(' '));
}

// ───────────────────────────────────────────────────────────────────────────
H('3b. 결의안 §4.6 의 links 변경 — 배치 API 로 실현되는가');
{
  // importLayout 의 links 단계는 createLink(INSERT, UNIQUE 충돌 시 무시) 뿐이다. 삭제가 없다.
  const FILE_LINKS_NEW = [ // §4.6: B87→B90 을 B87→B88 로 "바꾸고" B88→B89, B89→B90 추가
    ['OP-B87', 'OP-B88'], ['OP-B88', 'OP-B89'], ['OP-B89', 'OP-B90'],
  ];
  P('  변경 전 equipment_links: ' + gN(db, 'SELECT COUNT(*) c FROM equipment_links') + '행 (파일 23 + 숨김 설비 레거시 4)');
  const idOfEq = (code) => gN(db, 'SELECT id c FROM equipments WHERE code=?', code);
  for (const [a, b] of FILE_LINKS_NEW) {
    try { db.prepare('INSERT INTO equipment_links (from_id,to_id) VALUES (?,?)').run(idOfEq(a), idOfEq(b)); } catch { /* 이미 있음 */ }
  }
  const stale = gA(db, `SELECT a.code f, b.code t FROM equipment_links l JOIN equipments a ON a.id=l.from_id JOIN equipments b ON b.id=l.to_id
      WHERE a.code='OP-B87' OR b.code='OP-B90' ORDER BY a.code`);
  P('  적용 후 equipment_links: ' + gN(db, 'SELECT COUNT(*) c FROM equipment_links') + '행');
  P('  B87·B90 주변 링크: ' + JSON.stringify(stale.map(r => `${r.f}→${r.t}`)));
  const hasStale = stale.some(r => r.f === 'OP-B87' && r.t === 'OP-B90');
  chk('K-1', !hasStale, '§4.6 이 "바꾼다" 고 한 OP-B87→OP-B90 이 실제로 사라진다', hasStale ? '남아 있다' : '사라짐', '사라짐');
  P('  -> importLayout(server/index.js:334) 의 링크 단계는 createLink(INSERT) 뿐이고 삭제가 없다.');
  P('     replace:true 는 설비·존만 hidden 처리하고 equipment_links 는 건드리지 않는다.');
  P('     즉 JSON 에서 한 줄을 지워도 운영 DB 에서는 안 지워진다. 컨베이어가 B87 → B90 으로 신설 2대를 건너뛴 채 남는다.');
  // 되돌려 놓는다 (뒤 단계에 영향 없게)
  for (const [a, b] of FILE_LINKS_NEW) db.prepare('DELETE FROM equipment_links WHERE from_id=? AND to_id=?').run(idOfEq(a), idOfEq(b));
}

H('4. E-2 재시험 — 결의안이 seq UPDATE 구멍을 닫았는가');
{
  const d2 = freshDb('e2');
  applyProcesses(d2, src);
  loadMaterials(d2, { source: src, cleansing: cl, strict: false });
  P('  적재 완료. R-22 뷰: ' + gN(d2, 'SELECT COUNT(*) c FROM v_chk_r22_seq'));
  // 결의안이 제시한 방어책 = "적용 순서 고정 + 사후 뷰 확인". 그 방어를 우회하는 경로가 남았는지 본다.
  let blocked = false;
  try { d2.prepare(`UPDATE processes SET seq = 3 WHERE op='OP-B89'`).run(); }
  catch (e) { blocked = true; P('  [거부] ' + e.message); }
  P(`  OP-B89 를 seq 12 → 3 으로 되돌림: ${blocked ? '막힘' : '통과 — 아무 트리거도 없다'}`);
  const r22 = gA(d2, 'SELECT detail FROM v_chk_r22_seq');
  P(`  R-22 뷰: ${r22.length}건` + (r22.length ? ' → ' + JSON.stringify(r22.slice(0, 3).map(r => r.detail)) : ''));
  P('  ※ FS-7020 자식 IN@B88(11) vs FS-7020 OUT@B88(11) 은 그대로라 안 걸린다.');
  P('     "완성품 자식 IN@B89(3) vs 완성품 OUT@B120(16)" 도 3<16 이라 안 걸린다.');
  P('     즉 B89 를 B85·B87·B88 보다 앞으로 밀어도 R-22 뷰는 0 을 유지한다 ↓');
  // 진짜 위험: 자식이 MAKE 인데 그 자식을 만드는 공정보다 먼저 소비
  const early = gA(d2, `
    SELECT ic.pn child, pc.op||'(seq '||pc.seq||')' consumed_at, pm.op||'(seq '||pm.seq||')' made_at
      FROM bom_line l JOIN item ic ON ic.item_id = l.child_item_id
      JOIN process_material pi ON pi.line_id = l.line_id AND pi.io='IN'
      JOIN processes pc ON pc.id = pi.process_id
      JOIN process_material po ON po.item_id = l.child_item_id AND po.io='OUT' AND po.is_final=1
      JOIN processes pm ON pm.id = po.process_id
     WHERE pc.line = pm.line AND pc.seq < pm.seq`);
  P(`  [새 점검] 자식을 만들기 전에 소비하는 쌍: ${early.length}건 → ` + JSON.stringify(early.map(r => `${r.child} 소비 ${r.consumed_at} < 산출 ${r.made_at}`)));
  P('  -> R-22 는 "부모 OUT vs 자식 IN" 만 본다. "자식 OUT vs 자식 IN" 은 아무도 안 본다. 결의안도 이 뷰를 추가하지 않았다.');
  d2.close();
}

H('5. E-3 재시험 — OUT 없는 공정을 잡는 장치가 생겼는가');
{
  const d3 = freshDb('e3');
  const s3 = structuredClone(src);
  const c3 = structuredClone(cl);
  // 결의안대로 공정 2개는 넣되, cleansing 편집자가 process_out 2행을 빠뜨린 경우(§4.4(c) 누락)
  c3.process_out.rows = c3.process_out.rows.filter(r => r[0] !== 'OP-B89');
  applyProcesses(d3, s3);
  let err = null;
  try { loadMaterials(d3, { source: s3, cleansing: c3, strict: false }); } catch (e) { err = e.message; }
  P('  process_out 에서 OP-B89 행만 뺀 채 적재: ' + (err ? '거부 — ' + err : '통과'));
  const noOut = gA(d3, `SELECT op FROM processes p WHERE NOT EXISTS(SELECT 1 FROM process_material m WHERE m.process_id=p.id AND m.io='OUT')`).map(r => r.op);
  P('  OUT 0행 공정: ' + JSON.stringify(noOut));
  P('  v_chk_summary: ' + JSON.stringify(gA(d3, 'SELECT rule,cnt FROM v_chk_summary')));
  P('  expected 대조로는 잡히는가 → process_material_out ' + gN(d3, `SELECT COUNT(*) c FROM process_material WHERE io='OUT'`) + ' vs expected 26');
  d3.close();
}

H('5b. E-9 재판정 — 결의안이 "그 경로를 안 탄다" 고 한 주장이 맞는가');
{
  const d5 = freshDb('e9');
  // 변경 전 상태에서 로트 3건을 만들어 state_pm_id 를 물린다 (실적 적재 1단계를 흉내)
  const pm = (op, pn) => gN(d5, `SELECT pm.pm_id c FROM process_material pm JOIN processes p ON p.id=pm.process_id
      JOIN item i ON i.item_id=pm.item_id WHERE pm.io='OUT' AND p.op=? AND i.pn=?`, op, pn);
  const iid = (pn) => gN(d5, 'SELECT item_id c FROM item WHERE pn=?', pn);
  for (const [lot, op, pn] of [['GB-TEST-001', 'OP-B85', 'GB-8000'], ['PL-TEST-001', 'OP-B87', 'PL-9000'], ['FG-TEST-001', 'OP-B110', 'BLDC-500W-48V']])
    d5.prepare(`INSERT INTO mat_lot (lot_no,item_id,lot_kind,qty,uom_code,status,state_pm_id) VALUES (?,?,'LOT',1,'EA','AVAILABLE',?)`).run(lot, iid(pn), pm(op, pn));
  const before = gA(d5, 'SELECT lot_no, state_pm_id FROM mat_lot ORDER BY lot_no');
  const pmBefore = gA(d5, `SELECT pm_id, io, process_id, COALESCE(line_id,-1) l, COALESCE(item_id,-1) i FROM process_material ORDER BY pm_id`);
  P('  로트 3건 생성: ' + JSON.stringify(before));
  // 결의안 §8 순서 그대로: ① 공정 UPSERT(seq 재번호) → ③ 자재 적재
  applyProcesses(d5, src);
  loadMaterials(d5, { source: src, cleansing: cl, strict: false });
  const pmAfter = gA(d5, `SELECT pm_id, io, process_id, COALESCE(line_id,-1) l, COALESCE(item_id,-1) i FROM process_material ORDER BY pm_id`);
  const kept = pmBefore.every(b => pmAfter.some(a => a.pm_id === b.pm_id && a.io === b.io && a.process_id === b.process_id && a.l === b.l && a.i === b.i));
  chk('E9-1', kept, '적재기 경로에서 기존 pm_id 50행이 그대로 유지된다 (DELETE 없음)', kept, true);
  const dangling = gA(d5, `SELECT lot_no, state_pm_id FROM mat_lot m WHERE m.state_pm_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM process_material pm WHERE pm.pm_id=m.state_pm_id)`);
  eq('E9-2', dangling, [], '로트 상태 포인터 끊김 0 — 윤태경 §6.1 E-9 주장 성립');
  const disp = gA(d5, `SELECT m.lot_no, p.op, COALESCE(pm.out_state,'완성') st FROM mat_lot m
      LEFT JOIN process_material pm ON pm.pm_id=m.state_pm_id LEFT JOIN processes p ON p.id=pm.process_id ORDER BY m.lot_no`);
  P('  적재 후 로트 상태 표시: ' + JSON.stringify(disp));
  // 그러나 콘솔 편집 경로(PUT /process/:op/links, materials.js:828 sameOrder=false)는 여전히 끊는다
  const p85 = gN(d5, `SELECT id c FROM processes WHERE op='OP-B85'`);
  d5.prepare(`DELETE FROM process_material WHERE process_id=? AND io='OUT'`).run(p85);
  const dang2 = gA(d5, `SELECT lot_no, state_pm_id FROM mat_lot m WHERE m.state_pm_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM process_material pm WHERE pm.pm_id=m.state_pm_id)`);
  P('  [대조] 콘솔 links 편집·되돌리기(§7 5·6번)의 DELETE 를 흉내: 끊긴 로트 ' + JSON.stringify(dang2));
  P('  -> 적재기는 순수 UPSERT(materials.js 6·7단계)라 안 끊는다. 끊는 것은 PUT links 의 sameOrder=false 분기와 명시 DELETE 뿐이다.');
  d5.close();
}

H('5c. 결의안 §6 전제 검증 — "bom_line 에 INSERT/UPDATE/DELETE 가 하나도 없다"');
{
  const d6 = freshDb('bl');
  const before = gA(d6, 'SELECT line_id, note FROM bom_line ORDER BY line_id');
  applyProcesses(d6, src);
  loadMaterials(d6, { source: src, cleansing: cl, strict: false });
  const after = gA(d6, 'SELECT line_id, note FROM bom_line ORDER BY line_id');
  const changed = after.filter((a, i) => a.note !== before[i].note);
  P(`  bom_line 행수 ${before.length} → ${after.length} (구조 불변)`);
  P(`  note 가 실제로 바뀐 행: ${changed.length}건 → ` + JSON.stringify(changed.map(c => c.line_id)));
  for (const c of changed) P(`     line_id ${c.line_id}: ${String(c.note).slice(0, 70)}…`);
  P('  -> 적재기 5단계는 매 실행 59행 전부에 UPDATE bom_line SET line_no,qty_per,uom_code,qty_basis,scrap_pct,note 를 건다.');
  P('     §4.4(d) 가 note 3건을 의도적으로 고쳐 쓰므로 "UPDATE 가 하나도 없다" 는 전제는 문자 그대로는 거짓이다(무해하지만 부정확).');
  d6.close();
}

H('5d. ddl-v1.sql 의 CREATE VIEW IF NOT EXISTS 함정 — 뷰 정의 개정이 반영되는가');
{
  const d7 = freshDb('view');
  const t0 = gN(d7, `SELECT COUNT(*) c FROM v_chk_bop_unassigned`);
  d7.exec(`CREATE VIEW IF NOT EXISTS v_chk_bop_unassigned AS SELECT 'D-8' AS rule, 'CHANGED' AS detail`);
  const t1 = gA(d7, 'SELECT detail FROM v_chk_bop_unassigned LIMIT 1');
  P(`  기존 뷰에 IF NOT EXISTS 로 새 정의를 실행: 결과 ${JSON.stringify(t1)} (기준 ${t0}건)`);
  chk('V-1', t1[0]?.detail !== 'CHANGED', '뷰 정의 개정이 조용히 무시된다 (= 함정 확인)', t1[0]?.detail, '기존 정의 유지');
  d7.exec(`DROP VIEW IF EXISTS v_chk_bop_unassigned`);
  P('  -> 윤태경이 "점검 뷰 추가는 계획서 개정 항목" 으로 미룬 v_chk_proc_no_out 도, 기존 뷰를 고치는 개정은');
  P('     CREATE VIEW IF NOT EXISTS 로는 배포된 DB 에 반영되지 않는다. DROP VIEW IF EXISTS → CREATE VIEW 쌍이 필요하다.');
  d7.close();
}

H('5e. 내가 제안하는 seq UPDATE 트리거가 결의안의 재번호를 막지 않는가 (반례 시험)');
{
  const TRG = `
CREATE TRIGGER IF NOT EXISTS trg_proc_seq_upd BEFORE UPDATE OF seq, line ON processes
BEGIN
  SELECT RAISE(ABORT, 'R-22(seq): 이 공정의 투입이 부모 산출 공정보다 늦어진다')
   WHERE EXISTS (SELECT 1 FROM process_material pi
                   JOIN bom_line l ON l.line_id = pi.line_id
                   JOIN bom_header h ON h.bom_id = l.bom_id
                   JOIN process_material po ON po.item_id = h.parent_item_id AND po.io='OUT' AND po.is_final=1
                   JOIN processes pp ON pp.id = po.process_id
                  WHERE pi.process_id = NEW.id AND pi.io='IN' AND pp.id <> NEW.id
                    AND pp.line = NEW.line AND NEW.seq > pp.seq);
  SELECT RAISE(ABORT, 'R-22(seq): 이 산출 공정보다 늦게 투입되는 자식 라인이 생긴다')
   WHERE EXISTS (SELECT 1 FROM process_material po
                   JOIN bom_header h ON h.parent_item_id = po.item_id
                   JOIN bom_line l ON l.bom_id = h.bom_id
                   JOIN process_material pi ON pi.line_id = l.line_id AND pi.io='IN'
                   JOIN processes pc ON pc.id = pi.process_id
                  WHERE po.process_id = NEW.id AND po.io='OUT' AND po.is_final=1 AND pc.id <> NEW.id
                    AND pc.line = NEW.line AND pc.seq > NEW.seq);
  SELECT RAISE(ABORT, 'R-23(seq): 만들기 전에 소비하는 자재가 생긴다')
   WHERE EXISTS (SELECT 1 FROM process_material pi
                   JOIN bom_line l ON l.line_id = pi.line_id
                   JOIN process_material po ON po.item_id = l.child_item_id AND po.io='OUT' AND po.is_final=1
                   JOIN processes pm ON pm.id = po.process_id
                  WHERE pi.process_id = NEW.id AND pi.io='IN' AND pm.id <> NEW.id
                    AND pm.line = NEW.line AND NEW.seq < pm.seq);
END;`;
  fs.writeFileSync(path.join(HERE, 'patch-seq-trigger.sql'), TRG.trim() + '\n', 'utf8');
  // (가) 변경 전 DB 에 트리거를 먼저 걸고, 결의안의 적용 순서(배열 순서 = 오름차순)로 재번호해 본다
  const d8 = freshDb('trg');
  d8.exec(TRG);
  let blocked = null;
  try { applyProcesses(d8, src); } catch (e) { blocked = e.message; }
  P('  (가) 트리거를 건 상태에서 결의안 배열 순서(오름차순) UPSERT: ' + (blocked ? '거부 — ' + blocked : '통과'));
  chk('T-1', blocked === null, '트리거가 결의안의 정상 재번호를 막지 않는다', blocked, null);
  if (!blocked) {
    loadMaterials(d8, { source: src, cleansing: cl, strict: false });
    eq('T-2', gN(d8, 'SELECT COUNT(*) c FROM v_chk_r22_seq'), 0, '트리거를 건 채 적재해도 R-22 0');
    // (나) 이제 E-2 의 공격을 재현 — 막히는가
    let atk = null;
    try { d8.prepare(`UPDATE processes SET seq=3 WHERE op='OP-B89'`).run(); } catch (e) { atk = e.message; }
    chk('T-3', atk !== null, 'E-2 공격(B89 를 앞으로 밀기)이 트리거에 막힌다', atk, '거부');
    if (atk) P('       ' + atk);
    let atk2 = null;
    try { d8.prepare(`UPDATE processes SET seq=99 WHERE op='OP-B89'`).run(); } catch (e) { atk2 = e.message; }
    chk('T-4', atk2 !== null, 'E-2 공격(B89 를 완성품 뒤로 밀기)이 트리거에 막힌다', atk2, '거부');
    if (atk2) P('       ' + atk2);
  }
  // (다) 한계 — +3 이동처럼 중간 상태가 어긋나는 대량 UPDATE 는 트리거가 거부한다
  const d9 = freshDb('trg2');
  d9.exec(TRG);
  let bulk = null;
  try { d9.prepare(`UPDATE processes SET seq = seq + 3 WHERE line='조립 라인' AND seq >= 11`).run(); } catch (e) { bulk = e.message; }
  P('  (다) seq+3 대량 UPDATE(순서 보존, 중간 상태 어긋남 가능): ' + (bulk ? '거부 — ' + bulk : '통과'));
  P('     사유: seq 11~14 구간(B90·B100·B110·B120)의 IN 행은 부모가 전부 팬텀(PE-6000·EX-5000)이거나 0행이라');
  P('           R-22 의 앵커(부모의 is_final OUT)가 아예 없다. 이 데이터에서는 중간 상태가 걸릴 일이 없었다.');
  const d10 = freshDb('trg3');
  d10.exec(TRG);
  let bulk2 = null;
  try { d10.prepare(`UPDATE processes SET seq = seq + 10 WHERE line='조립 라인' AND seq >= 5`).run(); } catch (e) { bulk2 = e.message; }
  P('  (라) seq+10 대량 UPDATE(중간 상태가 실제로 어긋나는 경우): ' + (bulk2 ? '거부 — ' + bulk2 : '통과'));
  const d11 = freshDb('trg4');
  d11.exec(TRG);
  let desc = null;
  try { for (const r of gA(d11, `SELECT op, seq FROM processes WHERE line='조립 라인' AND seq >= 5 ORDER BY seq DESC`)) d11.prepare('UPDATE processes SET seq=? WHERE op=?').run(r.seq + 10, r.op); }
  catch (e) { desc = e.message; }
  P('  (마) 같은 +10 을 내림차순 1행씩: ' + (desc ? '거부 — ' + desc : '통과'));
  P('     -> 결론: 트리거는 행 단위라 "중간 상태" 를 허용하지 않는다. 재번호는 반드시 내림차순 1행씩(상향 이동) 돌려야 한다.');
  P('        [부수 발견] 팬텀 부모 라인은 R-22 의 앵커가 없다 — 조립 라인 IN 46행 중 20행이 그렇다(HA-3000 7 · PE-6000 10 · EX-5000 3).');
  d9.close(); d10.close(); d11.close(); d8.close();
}

H('6. 보완안 검증 — 내가 제안하는 점검 뷰·인덱스가 실제로 도는가 (멱등)');
{
  const d4 = freshDb('patch');
  applyProcesses(d4, src);
  loadMaterials(d4, { source: src, cleansing: cl, strict: false });
  const DDL = fs.readFileSync(path.join(HERE, 'patch-checks.sql'), 'utf8');
  try { d4.exec(DDL); P('  1회차 실행 OK'); d4.exec(DDL); P('  2회차 실행 OK (멱등)'); }
  catch (e) { P('  [실패] ' + e.message); fail++; }
  for (const v of ['v_chk_proc_no_out', 'v_chk_self_feed', 'v_chk_make_before_use', 'v_chk_lot_state_dangling', 'v_chk_eq_pos']) {
    const rows = gA(d4, `SELECT detail FROM ${v}`);
    P(`  ${v}: ${rows.length}건` + (rows.length ? ' → ' + JSON.stringify(rows.map(r => r.detail)) : ''));
  }
  P('  ※ 위 d4 는 설비 좌표를 아직 안 옮긴 상태 — D-21 1건은 기존 (11,13) 겹침이다. §4.6 적용 후 ↓');
  applyLayout(d4);
  P('  §4.6 좌표 적용 후 v_chk_eq_pos: ' + JSON.stringify(gA(d4, 'SELECT detail FROM v_chk_eq_pos').map(r => r.detail)));
  // 결의안이 빠뜨린 항목을 이 뷰들이 실제로 잡는가 (반례 2건)
  {
    const dX = freshDb('neg');
    const sX = structuredClone(src), cX = structuredClone(cl);
    cX.process_out.rows = cX.process_out.rows.filter(r => r[0] !== 'OP-B89');   // §4.4(c) 를 반만 반영
    applyProcesses(dX, sX); loadMaterials(dX, { source: sX, cleansing: cX, strict: false });
    dX.exec(fs.readFileSync(path.join(HERE, 'patch-checks.sql'), 'utf8'));
    P('  [반례 1] OUT 행 누락 → v_chk_proc_no_out: ' + JSON.stringify(gA(dX, 'SELECT detail FROM v_chk_proc_no_out').map(r => r.detail)));
    dX.close();
    const dY = freshDb('neg2');
    const sY = structuredClone(src), cY = structuredClone(cl);
    for (const r of cY.line_process.rows) if (r[2] === 'OP-B88') r[2] = 'OP-B89';   // (A2) 단일 공정안
    cY.process_out.rows = cY.process_out.rows.map(r => r[0] === 'OP-B88' ? ['OP-B89', 'FS-7020', 1, null, 1] : r).filter(r => !(r[0] === 'OP-B89' && r[1] === 'BLDC-500W-48V'));
    sY.processes = sY.processes.filter(p => p.op !== 'OP-B88');
    applyProcesses(dY, sY); loadMaterials(dY, { source: sY, cleansing: cY, strict: false });
    dY.exec(fs.readFileSync(path.join(HERE, 'patch-checks.sql'), 'utf8'));
    P('  [반례 2] (A2) 단일 공정안 → v_chk_self_feed: ' + JSON.stringify(gA(dY, 'SELECT detail FROM v_chk_self_feed').map(r => r.detail)));
    P('            현행 v_chk_summary 로는: ' + JSON.stringify(gA(dY, 'SELECT rule,cnt FROM v_chk_summary')));
    dY.close();
  }
  P('  확장 요약 v_chk_summary2: ' + JSON.stringify(gA(d4, 'SELECT rule, cnt FROM v_chk_summary2')));
  // 유니크 인덱스가 현행 26행에 무중단으로 붙는가
  try { d4.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_proc_seq ON processes(product_code, line, seq)'); P('  ux_proc_seq 생성 OK (기존 26행에 중복 없음)'); }
  catch (e) { P('  [실패] ux_proc_seq: ' + e.message); fail++; }
  let dup = false;
  try { d4.prepare(`UPDATE processes SET seq=15 WHERE op='OP-B89'`).run(); } catch (e) { dup = true; P('  [거부] seq 동률 UPDATE -> ' + e.message); }
  chk('X-1', dup, '인덱스 추가 후 seq 동률 UPDATE 가 막힌다', dup, true);
  d4.close();
}

H('7. 결과');
P(`  OK ${pass} · FAIL ${fail}`);
db.close();
fs.writeFileSync(path.join(HERE, 'resolution-out.txt'), out.join('\n') + '\n', 'utf8');
