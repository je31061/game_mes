// compat-diff.mjs — 호환 계약 전후 대조 (DB 직접). 서버 없이 돈다.
//   node compat-diff.mjs <격리 DB 경로>                 : 전환 후 DB 에서 legacy 표 ↔ 뷰 대조 → out/compat-diff.json
//   node compat-diff.mjs <DB> --snapshot out/before.json : 전환 전(legacy 표) 서버의 DB 를 덤프해 저장
//   node compat-diff.mjs <DB> --against out/before.json  : 전환 후 DB 를 저장된 스냅샷과 대조
// 운영 DB(data/factory.db) 경로를 주지 마라 — FW_DATA_DIR 임시 폴더의 DB 만.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRO, compatDiff, EXPECTED_DELTA } from './lib/compat.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const OUT = path.join(HERE, 'out'); fs.mkdirSync(OUT, { recursive: true });
const [dbPath, mode, arg] = process.argv.slice(2);
if (!dbPath) { console.error('usage: node compat-diff.mjs <db> [--snapshot out.json | --against before.json]'); process.exit(2); }
if (path.resolve(dbPath) === path.join(ROOT, 'data', 'factory.db')) { console.error('운영 DB 는 열지 않는다. FW_DATA_DIR 격리 DB 경로를 줘라.'); process.exit(2); }
const cj = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', '4m', 'cleansing-v1.json'), 'utf8'));
const tmpMap = Object.fromEntries(Object.entries(cj.pn_pending).filter(([, v]) => v && typeof v === 'object').map(([k, v]) => [k, v.tmp]));

const db = openRO(dbPath);
const r = compatDiff(db, { tmpMap });
db.close();
if (mode === '--snapshot') {
  const snap = r.before || r.after;
  fs.writeFileSync(arg || path.join(OUT, 'compat-before.json'), JSON.stringify({ state: r.state, rows: snap.rows, order: snap.order }, null, 1), 'utf8');
  console.log(`스냅샷 저장 (${r.state}, ${Object.keys(snap.rows).length}행) → ${arg || 'out/compat-before.json'}`);
  process.exit(0);
}
if (mode === '--against') {
  const before = JSON.parse(fs.readFileSync(arg, 'utf8')).rows; const after = (r.after || r.before).rows;
  const kb = Object.keys(before), ka = Object.keys(after), common = kb.filter(k => k in after);
  const onlyBefore = kb.filter(k => !(k in after)).map(k => k.split('|')).sort(), onlyAfter = ka.filter(k => !(k in before)).map(k => k.split('|')).sort();
  const diffs = (f) => common.filter(k => String(before[k][f]) !== String(after[k][f])).map(k => [k, before[k][f], after[k][f]]);
  r.diff = { beforeRows: kb.length, afterRows: ka.length, commonRows: common.length, onlyBefore, onlyAfter, qty: diffs('qty'), unit: diffs('unit'), name: diffs('name'), spec: diffs('spec'), level: diffs('level'), parentPn: diffs('parentPn') };
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  r.verdict = { onlyBefore: eq(onlyBefore, EXPECTED_DELTA.onlyBefore), onlyAfter: eq(onlyAfter, EXPECTED_DELTA.onlyAfter), rows: kb.length === 36 && ka.length === 46 && common.length === 35,
    qtyUnitNameSpec: !r.diff.qty.length && !r.diff.unit.length && !r.diff.name.length && !r.diff.spec.length };
  r.verdict.all = Object.values(r.verdict).every(Boolean);
}
fs.writeFileSync(path.join(OUT, 'compat-diff.json'), JSON.stringify(r, null, 1), 'utf8');
console.log(`상태 ${r.state} · 공정 ${r.procs}`);
if (r.diff) {
  console.log(`전 ${r.diff.beforeRows}행 → 후 ${r.diff.afterRows}행 · 공통 ${r.diff.commonRows} · 전에만 ${JSON.stringify(r.diff.onlyBefore)} · 후에만 ${r.diff.onlyAfter.length}`);
  console.log(`공통 행 차이 — qty ${r.diff.qty.length} · unit ${r.diff.unit.length} · name ${r.diff.name.length} · spec ${r.diff.spec.length} · level ${r.diff.level.length}(예고) · parentPn ${r.diff.parentPn.length}(예고)`);
  console.log(`판정 ${JSON.stringify(r.verdict)}`);
} else console.log(r.note || '');
console.log('→ out/compat-diff.json');
process.exit(r.verdict && !r.verdict.all ? 1 : 0);
