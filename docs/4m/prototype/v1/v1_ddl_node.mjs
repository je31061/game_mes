// v1_ddl_node.mjs — [1] ddl-v1.sql 을 **운영 런타임 node:sqlite** 로 실행한다.
//   [a] 단독 · [b] 선행 테이블 뒤 · [c] 2회째(멱등) · [d] 객체 수 · foreign_keys 기본값
// 실행: node v1_ddl_node.mjs   → out/02_ddl_node.log
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');
const OUT = path.join(HERE, 'out'); fs.mkdirSync(OUT, { recursive: true });
const DDL = fs.readFileSync(path.join(ROOT, 'docs', '4m', 'ddl-v1.sql'), 'utf8');
const PREREQ = fs.readFileSync(path.join(HERE, '..', 'v09', 'prereq_existing.sql'), 'utf8');

const lines = []; const log = (s = '') => { console.log(s); lines.push(s); };
const objects = (db) => {
  const d = {};
  for (const r of db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all())
    (d[r.type] ||= []).push(r.name);
  return d;
};
const verdicts = [];
const rec = (t, ok, d) => { verdicts.push([t, ok, d]); log(`   [${ok ? '확인' : '결함'}] ${t} — ${d}`); };

log('='.repeat(78));
log('§6 v1.0 재검증 — [1] ddl-v1.sql 원문 실행 (node:sqlite = 운영 런타임)');
{ const d = new DatabaseSync(':memory:'); log(`    node ${process.version} · sqlite ${d.prepare('select sqlite_version() v').get().v} · foreign_keys 기본=${d.prepare('PRAGMA foreign_keys').get().foreign_keys}`); d.close(); }
log('='.repeat(78));

// [a] 단독 — exec 한 번 (최민준이 db.js 에서 쓸 방식 그대로)
log('\n[a] 단독 exec');
try { const d = new DatabaseSync(':memory:'); d.exec(DDL); const o = objects(d); rec('DDL-a 단독 exec', true, `table ${o.table?.length} index ${o.index?.length} trigger ${o.trigger?.length} view ${o.view?.length}`); d.close(); }
catch (e) { rec('DDL-a 단독 exec', false, e.message); }

// [b] 선행 뒤 + [d] 객체 수 + [c] 2회째
log('\n[b] 선행 테이블 뒤 exec · [c] 2회째 · [d] 객체 수');
{
  const d = new DatabaseSync(':memory:');
  d.exec(PREREQ);
  const pre = new Set(objects(d).table || []);
  let ok = true, msg = '';
  try { d.exec(DDL); } catch (e) { ok = false; msg = e.message; }
  const o = objects(d);
  const newTables = (o.table || []).filter(t => !pre.has(t));
  const got = { table: newTables.length, index: (o.index || []).length, trigger: (o.trigger || []).length, view: (o.view || []).length };
  rec('DDL-b 선행 테이블 뒤 exec', ok, ok ? JSON.stringify(got) : msg);
  rec('DDL-d 객체 수 = 12/20/34/19', got.table === 12 && got.index === 20 && got.trigger === 34 && got.view === 19, JSON.stringify(got));
  log(`    트리거: ${JSON.stringify(o.trigger)}`);
  let ok2 = true, msg2 = '';
  try { d.exec(DDL); } catch (e) { ok2 = false; msg2 = e.message; }
  const o2 = objects(d);
  const same = JSON.stringify(o) === JSON.stringify(o2);
  rec('DDL-c 2회째 멱등', ok2 && same, ok2 ? `객체 불변=${same}` : msg2);
  d.close();
}

log('\n' + '='.repeat(78));
const ng = verdicts.filter(v => !v[1]);
log(`판정 — 확인 ${verdicts.length - ng.length} · 결함 ${ng.length}`);
log('='.repeat(78));
fs.writeFileSync(path.join(OUT, '02_ddl_node.log'), lines.join('\n') + '\n', 'utf8');
process.exit(ng.length ? 1 : 0);
