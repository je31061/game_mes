// v1_cases_run.mjs — cases.json 의 반례 배터리를 **운영 런타임 node:sqlite** 로 실행한다.
// python 판(v1_cases_run.py) 과 같은 파일·같은 순서. 결과 차이 = 런타임 차이.
// 실행: node v1_cases_run.mjs   → out/04_cases_node.log · out/cases_node.json
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');
const OUT = path.join(HERE, 'out'); fs.mkdirSync(OUT, { recursive: true });
const DDL = fs.readFileSync(path.join(ROOT, 'docs', '4m', 'ddl-v1.sql'), 'utf8');
const PREREQ = fs.readFileSync(path.join(HERE, '..', 'v09', 'prereq_existing.sql'), 'utf8');
const CJ = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', '4m', 'cleansing-v1.json'), 'utf8'));
const cases = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8')).cases;

const lines = []; const log = (s = '') => { console.log(s); lines.push(s); };

function fresh() {
  const db = new DatabaseSync(':memory:');           // foreign_keys 기본 ON (v1_ddl_node 에서 확인)
  db.exec(PREREQ); db.exec(DDL);
  const u = db.prepare('INSERT OR IGNORE INTO uom(uom_code,symbol,name_ko,dim,decimals,is_base) VALUES (?,?,?,?,?,?)');
  for (const x of CJ.uom) u.run(x.code, x.symbol, x.name_ko, x.dim, x.decimals, x.is_base);
  const c = db.prepare('INSERT OR IGNORE INTO uom_conv(from_uom,to_uom,factor,item_id,note) VALUES (?,?,?,?,?)');
  for (const x of CJ.uom_conv) c.run(x.from, x.to, x.factor, null, x.note ?? null);
  db.exec("INSERT INTO mat_class(class_id,class_code,name,is_leaf) VALUES (1,'TEST','시험용 말단',1)");
  db.exec("INSERT INTO mat_class(class_id,class_code,name,is_leaf) VALUES (2,'NONLEAF','시험용 비말단',0)");
  return db;
}

function runCase(c) {
  const db = fresh();
  try { for (const s of c.setup) db.exec(s); }
  catch (e) { db.close(); return { id: c.id, outcome: 'error', detail: `setup 실패: ${e.message}` }; }
  const t0 = process.hrtime.bigint();
  let got, msg = '';
  try { db.exec(c.attack); got = 'accept'; } catch (e) { got = 'reject'; msg = `${e.constructor.name}: ${e.message}`; }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  let ok = got === c.expect;
  if (ok && c.msg && got === 'reject') {
    const wants = Array.isArray(c.msg) ? c.msg : [c.msg];
    if (!wants.some(w => msg.includes(w))) { ok = false; msg += `  ← 기대 메시지 ${JSON.stringify(wants)} 없음`; }
  }
  let post = null;
  if (ok && c.post) {
    try {
      const row = db.prepare(c.post.sql).get();
      post = row ? String(Object.values(row)[0]) : null;
      const exp = String(c.post.expect);
      const same = post === exp || (Number.isFinite(Number(post)) && Number.isFinite(Number(exp)) && Number(post) === Number(exp));
      if (!same) { ok = false; msg += `  ← 사후 확인 기대 ${c.post.expect} 실제 ${post}`; }
    } catch (e) { ok = false; msg += `  ← 사후 확인 오류 ${e.message}`; }
  }
  db.close();
  return { id: c.id, outcome: ok ? '확인' : '결함', got, ms: Math.round(ms * 1000) / 1000, msg, post };
}

log('='.repeat(78));
log('§6 v1.0 재검증 — [2] 반례 배터리 (node:sqlite = 운영 런타임)');
{ const d = new DatabaseSync(':memory:'); log(`    node ${process.version} · sqlite ${d.prepare('select sqlite_version() v').get().v} · 케이스 ${cases.length}건`); d.close(); }
log('='.repeat(78));
const results = []; let cur = null;
for (const c of cases) {
  const g = c.group.split(' ')[0];
  if (g !== cur) { log(`\n── ${c.group} ──`); cur = g; }
  const r = runCase(c); r.group = c.group; r.title = c.title; r.expect = c.expect; results.push(r);
  const mark = { '확인': 'OK ', '결함': '!! ', error: 'ERR' }[r.outcome];
  log(`  [${mark}] ${c.id.padEnd(7)} ${c.title}`);
  if (r.outcome !== '확인') log(`          기대=${c.expect} 실제=${r.got} · ${r.msg || r.detail}`);
}
const nOk = results.filter(r => r.outcome === '확인').length, nNg = results.filter(r => r.outcome === '결함').length, nEr = results.filter(r => r.outcome === 'error').length;
log('\n' + '='.repeat(78));
log(`합계 ${results.length} — 확인 ${nOk} · 결함 ${nNg} · 오류 ${nEr}`);
for (const r of results) if (r.outcome !== '확인') log(`   [${r.outcome}] ${r.id} ${r.title}`);

// python 결과와 대조
const pyPath = path.join(OUT, 'cases_python.json');
if (fs.existsSync(pyPath)) {
  const py = JSON.parse(fs.readFileSync(pyPath, 'utf8')).results;
  const diff = [];
  for (const r of results) { const p = py.find(x => x.id === r.id); if (!p || p.outcome !== r.outcome || p.got !== r.got) diff.push([r.id, p?.got, r.got]); }
  log(`\npython 대조 — 결과(got/outcome) 다른 케이스 ${diff.length}건 ${JSON.stringify(diff)}`);
}
log('='.repeat(78));
fs.writeFileSync(path.join(OUT, 'cases_node.json'), JSON.stringify({ runtime: `node ${process.version}`, results }, null, 1), 'utf8');
fs.writeFileSync(path.join(OUT, '04_cases_node.log'), lines.join('\n') + '\n', 'utf8');
process.exit(nNg || nEr ? 1 : 0);
