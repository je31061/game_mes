// r2_v1_node.mjs — V-1 을 **운영 런타임(node:sqlite)** 에서 그대로 반복한다.
// 운영은 server/db.js 가 node:sqlite 를 쓴다. python 에서 되는 것이 여기서도 되는지 확인해야 한다.
// 실행: node r2_v1_node.mjs        (출력 → out/03_v1_node.log)
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });

const lines = [];
const log = (s = '') => { console.log(s); lines.push(s); };

const readSql = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');

function fresh() {
  const db = new DatabaseSync(':memory:');           // foreign keys 기본 ON
  db.exec(readSql('prereq_existing.sql'));
  db.exec(readSql('ddl_v09_patched.sql'));
  db.exec("INSERT INTO uom(uom_code,name_ko,dim,decimals,is_base) VALUES ('EA','개','COUNT',0,1)");
  db.exec("INSERT INTO mat_class(class_code,name) VALUES ('TEST','시험')");
  return db;
}
const item = (db, pn, t = 'SA') => Number(db.prepare(
  "INSERT INTO item(pn,name,class_id,item_type,source_type,base_uom) VALUES (?,?,1,?,'MAKE','EA')")
  .run(pn, pn, t).lastInsertRowid);
const header = (db, id, st = 'ACTIVE') => Number(db.prepare(
  "INSERT INTO bom_header(parent_item_id,base_uom,status,valid_from) VALUES (?,'EA',?,'2026-01-01')")
  .run(id, st).lastInsertRowid);
const line = (db, bom, child, no = 10) => Number(db.prepare(
  "INSERT INTO bom_line(bom_id,line_no,child_item_id,qty_per,uom_code,valid_from) VALUES (?,?,?,1,'EA','2026-01-01')")
  .run(bom, no, child).lastInsertRowid);
function tryLine(db, bom, child, no = 10) {
  try { line(db, bom, child, no); return [false, '통과 — 막지 못했다']; }
  catch (e) { return [true, `${e.constructor.name}: ${e.message}`]; }
}
function makeChain(db, n, st) {
  const ids = [...Array(n)].map((_, i) => item(db, `X${i}`));
  const boms = ids.map((i) => header(db, i, st));
  for (let i = 0; i < n - 1; i++) line(db, boms[i], ids[i + 1]);
  return tryLine(db, boms[n - 1], ids[0]);
}

const results = [];
function rec(tag, blocked, expect, msg) {
  const v = blocked === expect ? '확인' : '결함';
  results.push([tag, v]);
  log(`[${blocked === expect ? 'OK ' : '!! '}] ${tag}`);
  log(`       기대=${expect ? '차단' : '통과'} 실제=${blocked ? '차단' : '통과'} · ${msg}`);
}

log('='.repeat(78));
log('V-1 · §6 R-1 순환 참조 트리거 실증 — node:sqlite (운영 런타임)');
{
  const d = new DatabaseSync(':memory:');
  log(`    node ${process.version} · sqlite ${d.prepare('select sqlite_version() v').get().v}`);
  d.close();
}
log('='.repeat(78));

// [0] 원문 DDL 이 node:sqlite 에서도 거부되는가
log('\n[0] ddl_v09_raw.sql(계획서 원문) 을 node:sqlite 로 실행');
try {
  const d = new DatabaseSync(':memory:');
  d.exec(readSql('prereq_existing.sql'));
  d.exec(readSql('ddl_v09_raw.sql'));
  log('    [!!] 통과했다 — python 과 결과가 다르다');
  d.close();
} catch (e) {
  log(`    [OK] 거부: ${e.message}`);
  log('    → python sqlite3(3.50.4) 과 node:sqlite 가 **같은 이유로** 거부한다. 런타임 문제가 아니라 문법 문제다.');
}

// [1] 트리거 생성
{
  const db = fresh();
  const trg = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all().map(r => r.name);
  log(`\n[1] 생성된 트리거: ${JSON.stringify(trg)}`);
  db.close();
}

// [2] 자기참조
log('\n[2] 자기참조 — 실데이터 `FS-7010 → FS-7010`');
for (const st of ['DRAFT', 'APPROVED', 'ACTIVE']) {
  const db = fresh(); const fid = item(db, 'FS-7010'); const b = header(db, fid, st);
  const [blocked, msg] = tryLine(db, b, fid);
  rec(`V-1a FS-7010→FS-7010 (status='${st}')`, blocked, true, msg); db.close();
}

// [3] 길이 2 순환
log('\n[3] 길이 2 순환 `A→B→A`');
for (const st of ['DRAFT', 'APPROVED', 'ACTIVE']) {
  const db = fresh(); const [blocked, msg] = makeChain(db, 2, st);
  rec(`V-1b A→B→A (양쪽 status='${st}')`, blocked, true, msg); db.close();
}

// [4] 상태 혼재
log('\n[4] 상태 혼재 — 중간 BOM 하나만 DRAFT');
{
  const db = fresh();
  const a = item(db, 'A'), b = item(db, 'B'), c = item(db, 'C');
  const ba = header(db, a, 'ACTIVE'), bb = header(db, b, 'DRAFT'), bc = header(db, c, 'ACTIVE');
  line(db, ba, b); line(db, bb, c);
  const [blocked, msg] = tryLine(db, bc, a);
  rec('V-1c A→B→C→A (B의 BOM만 DRAFT)', blocked, true, msg); db.close();
}

// [5] 길이 경계
log('\n[5] 순환 길이 2~20 (전부 ACTIVE)');
{
  const passed = [];
  for (let n = 2; n <= 20; n++) {
    const db = fresh(); const [blocked] = makeChain(db, n, 'ACTIVE');
    if (!blocked) passed.push(n); db.close();
  }
  const blockedList = []; for (let n = 2; n <= 20; n++) if (!passed.includes(n)) blockedList.push(n);
  log(`    차단된 길이 : [${blockedList}]`);
  log(`    통과한 길이 : [${passed}]`);
  results.push(['V-1d 순환 길이 경계', passed.length ? '결함' : '확인']);
  log(`    → ${passed.length ? '결함' : '확인'}`);
}

// [6] UPDATE
log('\n[6] UPDATE 로 순환 만들기');
{
  const db = fresh();
  const a = item(db, 'A'), b = item(db, 'B'), z = item(db, 'Z');
  const ba = header(db, a, 'ACTIVE'), bb = header(db, b, 'ACTIVE');
  line(db, ba, b); const lid = line(db, bb, z);
  let blocked, msg;
  try {
    db.prepare('UPDATE bom_line SET child_item_id=? WHERE line_id=?').run(a, lid);
    blocked = false; msg = '통과 — UPDATE 로 A→B→A 순환이 완성됐다';
  } catch (e) { blocked = true; msg = e.message; }
  rec('V-1e UPDATE bom_line SET child_item_id → 순환', blocked, true, msg); db.close();
}

// [7] 거짓양성
log('\n[7] 거짓양성 점검 — 깊이 9 사슬 + 같은 자식 3부모');
{
  const db = fresh(); let ok = true;
  const ids = [...Array(10)].map((_, i) => item(db, `N${i}`));
  const boms = ids.map(i => header(db, i, 'ACTIVE'));
  for (let i = 0; i < 9; i++) { try { line(db, boms[i], ids[i + 1]); } catch (e) { ok = false; log('   거짓양성! ' + e.message); } }
  const sh = item(db, 'SHARED', 'PT');
  for (const i of [0, 3, 7]) { try { line(db, boms[i], sh, 90); } catch (e) { ok = false; log('   거짓양성(다부모)! ' + e.message); } }
  rec('V-1f 거짓양성 없음', !ok, false, ok ? '정상 데이터가 전부 들어갔다' : '정상 데이터를 막았다'); db.close();
}

// [8] 지연
log('\n[8] INSERT 지연 — 10단 전개를 유발하는 위치');
{
  const db = fresh();
  const ids = [...Array(11)].map((_, i) => item(db, `D${i}`));
  const boms = ids.map(i => header(db, i, 'ACTIVE'));
  for (let i = 0; i < 10; i++) {
    line(db, boms[i], ids[i + 1], 10);
    for (let k = 0; k < 4; k++) line(db, boms[i], item(db, `D${i}_L${k}`, 'PT'), 20 + k);
  }
  const d0 = db.prepare("SELECT item_id FROM item WHERE pn='D0'").get().item_id;
  const pb = [...Array(200)].map((_, i) => header(db, item(db, `P${i}`), 'ACTIVE'));
  const t0 = process.hrtime.bigint();
  for (const b of pb) line(db, b, d0, 10);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / pb.length;
  log(`    10단 전개 유발 INSERT 200행 · 행당 평균 **${ms.toFixed(3)} ms**`);
  db.close();
}

log('\n' + '='.repeat(78));
const ng = results.filter(r => r[1] === '결함');
log(`V-1(node:sqlite) 요약 — 확인 ${results.length - ng.length} · 결함 ${ng.length}`);
for (const [t, v] of results) log(`   [${v}] ${t}`);
log('='.repeat(78));
fs.writeFileSync(path.join(OUT, '03_v1_node.log'), lines.join('\n'), 'utf8');
