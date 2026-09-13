// lib/compat.mjs — 호환 계약(인터페이스 §7·§10 · 계획서 §9.3 [2]④ · §10.3) 검사 — DB 직접 조회.
// `equipment:detail` 은 소켓이라 HTTP 로 못 부른다. 대신 그 응답을 만드는 server/db.js `queries.processInputs` SQL 을
// **문자 그대로** 격리 DB(FW_DATA_DIR/factory.db) 에 실행해, 이행 전(process_inputs_legacy 표) 과 후(process_inputs 뷰) 를 대조한다.
// 운영 DB 는 절대 열지 않는다 — 호출자가 FW_DATA_DIR 임시 폴더의 DB 경로를 준다.
import { DatabaseSync } from 'node:sqlite';

// server/db.js queries.processInputs — 한 글자도 바꾸지 않는다 (2026-09-13 기준)
export const SQL_PROCESS_INPUTS = `
    SELECT i.pn, i.qty, p.name, p.spec, p.unit, p.level, p.parent_pn, p.parent_name, p.image
    FROM process_inputs i LEFT JOIN parts p ON p.pn = i.pn
    WHERE i.process_id = ? ORDER BY i.rowid`;
export const SQL_LIST_PROCESSES = `
    SELECT p.*, (SELECT COUNT(*) FROM process_inputs i WHERE i.process_id = p.id) AS input_count
    FROM processes p WHERE p.product_code = ? ORDER BY p.line, p.seq, p.op`;
export const SQL_COUNT_PARTS = 'SELECT COUNT(*) AS c FROM parts';

// 계획서 §9.3 [2]④ 가 예고한 변화 (검증보고서 §6 TC-57 로 정정: 공통 행 수량차는 0 — '구 NULL 2행' 은 v0.9 프로토타입 산물)
export const EXPECTED_DELTA = {
  onlyBefore: [['OP-B90', 'PE-6000']],
  onlyAfter: [
    ...['PC-4010', 'PC-4011', 'HS-4020', 'MO-4030', 'GD-4040', 'CP-4050', 'HK-4060', 'BB-4070', 'SP-4040'].map(p => ['OP-B90', p]),
    ['OP-A20', 'SC-1010P'], ['OP-B120', 'PK-0010'],
  ].sort(),
  commonRows: 35, beforeRows: 36, afterRows: 46, partsBefore: 56, partsAfter: 59,
};

export function openRO(dbPath) {
  return new DatabaseSync(dbPath, { readOnly: true });
}

/** legacy 표(before) 와 뷰(after) 를 같은 SQL 로 덤프해 대조. tmpMap: 정식 pn → TMP- pn */
export function compatDiff(db, { tmpMap = {}, productCode = 'BLDC-500W-48V' } = {}) {
  const norm = (pn) => { for (const [k, v] of Object.entries(tmpMap)) if (pn === v) return k; return pn; };
  const kinds = Object.fromEntries(db.prepare("SELECT name, type FROM sqlite_master WHERE name IN ('parts','process_inputs','parts_legacy','process_inputs_legacy')").all().map(r => [r.name, r.type]));
  const procs = db.prepare('SELECT id, op FROM processes WHERE product_code = ? ORDER BY line, seq').all(productCode);
  const dump = (piTable, partsTable) => {
    const sql = SQL_PROCESS_INPUTS.replace('FROM process_inputs i', `FROM ${piTable} i`).replace('LEFT JOIN parts p', `LEFT JOIN ${partsTable} p`);
    const st = db.prepare(sql); const out = {}; const order = {};
    for (const { id, op } of procs) {
      const rows = st.all(id); order[op] = rows.map(r => norm(r.pn));
      for (const r of rows) out[`${op}|${norm(r.pn)}`] = { qty: r.qty, name: r.name, spec: r.spec, unit: r.unit, level: r.level, parentPn: r.parent_pn, parentName: r.parent_name, image: r.image };
    }
    return { rows: out, order };
  };
  const result = { kinds, procs: procs.length };
  if (kinds.process_inputs !== 'view') { result.state = 'legacy(전환 전)'; result.before = dump('process_inputs', 'parts'); return result; }
  result.state = 'compat(전환 후)';
  const after = dump('process_inputs', 'parts'); result.after = after;
  result.partsAfter = db.prepare(SQL_COUNT_PARTS).get().c;
  result.listProcesses = Object.fromEntries(db.prepare(SQL_LIST_PROCESSES).all(productCode).map(r => [r.op, r.input_count]));
  if (kinds.process_inputs_legacy === 'table' && kinds.parts_legacy === 'table') {
    const before = dump('process_inputs_legacy', 'parts_legacy'); result.before = before;
    result.partsBefore = db.prepare("SELECT COUNT(*) AS c FROM parts_legacy").get().c;
    const kb = Object.keys(before.rows), ka = Object.keys(after.rows);
    const onlyBefore = kb.filter(k => !(k in after.rows)).map(k => k.split('|')).sort();
    const onlyAfter = ka.filter(k => !(k in before.rows)).map(k => k.split('|')).sort();
    const common = kb.filter(k => k in after.rows);
    const diffs = (f) => common.filter(k => String(before.rows[k][f]) !== String(after.rows[k][f])).map(k => [k, before.rows[k][f], after.rows[k][f]]);
    result.diff = {
      beforeRows: kb.length, afterRows: ka.length, commonRows: common.length, onlyBefore, onlyAfter,
      qty: diffs('qty'), unit: diffs('unit'), name: diffs('name'), spec: diffs('spec'), level: diffs('level'), parentPn: diffs('parentPn'), parentName: diffs('parentName'), image: diffs('image'),
    };   // level·parentPn 은 §10.3 예고분, parentName 은 예고에 없던 값 변화(최민준 handoff ①) — 판정엔 안 넣고 기록만
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    result.verdict = {
      onlyBefore: eq(onlyBefore, EXPECTED_DELTA.onlyBefore), onlyAfter: eq(onlyAfter, EXPECTED_DELTA.onlyAfter),
      rows: kb.length === EXPECTED_DELTA.beforeRows && ka.length === EXPECTED_DELTA.afterRows && common.length === EXPECTED_DELTA.commonRows,
      qtyUnitNameSpec: result.diff.qty.length === 0 && result.diff.unit.length === 0 && result.diff.name.length === 0 && result.diff.spec.length === 0,
      parts: result.partsBefore === EXPECTED_DELTA.partsBefore && result.partsAfter === EXPECTED_DELTA.partsAfter,
    };
    result.verdict.all = Object.values(result.verdict).every(Boolean);
  } else {
    result.note = 'legacy 표가 없어 전후 대조 불가 (새 DB 에서 바로 뷰로 시작) — 전환 전 스냅샷(compat-diff.mjs --snapshot) 과 비교하라';
  }
  return result;
}
