// mock/mock-server.mjs — **도구 자체 시험용** 계약(§10) 참조 스텁. 운영 서버가 아니다.
// 노하린 프로토타입 DB(prototype/v1/out/bldc_v1_compat.db 사본) 위에서 §10 라우트를 최소로 흉내 내
// acceptance.mjs 가 끝까지 도는지(판정 로직·출력) 확인한다. 실서버 인수는 반드시 최민준의 server/index.js 로 한다.
// 실행: node mock/mock-server.mjs [port=3009]   → FW_URL=http://localhost:3009 FW_TOKEN=mock node acceptance.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');
const PROTO = path.join(ROOT, 'docs', '4m', 'prototype', 'v1');
const PORT = Number(process.argv[2] || process.env.PORT || 3009);
const DATA = process.env.FW_DATA_DIR ? path.resolve(process.env.FW_DATA_DIR) : path.join(HERE, 'data');
fs.mkdirSync(DATA, { recursive: true });
const DB = path.join(DATA, 'factory.db');
if (!fs.existsSync(DB)) fs.copyFileSync(path.join(PROTO, 'out', 'bldc_v1_compat.db'), DB);
const db = new DatabaseSync(DB);
db.exec('PRAGMA foreign_keys=ON');
const CJ = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', '4m', 'cleansing-v1.json'), 'utf8'));
const q = (s) => db.prepare(s);
const B = '/api/admin/materials';
const today = () => new Date().toISOString().slice(0, 10);
const asof = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : today());
const r9 = (x) => Math.round(x * 1e9) / 1e9;
const item = (pn) => q('SELECT i.*, c.class_code, c.name AS class_name FROM item i JOIN mat_class c ON c.class_id=i.class_id WHERE pn=?').get(String(pn));
const itemJson = (r) => ({ pn: r.pn, name: r.name, spec: r.spec, kind: r.is_phantom ? 'PHANTOM' : ({ FG: 'FG', SA: 'SA', PT: 'PART', RM: 'RAW', PK: 'PKG', CN: 'CN' })[r.item_type], classId: r.class_id, className: r.class_name, uom: r.base_uom, status: r.status, traceKind: r.trace_mode, isTmp: r.pn.startsWith('TMP-') });
const Q1 = fs.readFileSync(path.join(PROTO, 'bomsql_v1.py'), 'utf8');
const pick = (name) => { const m = Q1.match(new RegExp(name + ' = (?:Q1 \\+ )?"""([\\s\\S]*?)"""')); return m[1]; };
const Q1_BASE = pick('Q1'), Q1_SELECT = Q1_BASE + 'SELECT item_id, pn, depth, qty, qty_gross, uom, path, is_phantom, line_id FROM ex WHERE depth > 0';
const Q3 = pick('Q3');
const tx = (fn) => { db.exec('SAVEPOINT s'); try { const r = fn(); db.exec('RELEASE s'); return r; } catch (e) { db.exec('ROLLBACK TO s'); db.exec('RELEASE s'); throw e; } };

function explode(root, asOf, depth = 64) {
  const rows = q(Q1_SELECT.replace('ex.depth < 64', `ex.depth < ${depth}`)).all({ ':root': root, ':qty': 1, ':asof': asOf });
  const byPath = new Map(), top = [], all = [];
  for (const r of rows) {
    const l = q('SELECT l.*, h.base_qty FROM bom_line l JOIN bom_header h ON h.bom_id=l.bom_id WHERE line_id=?').get(r.line_id);
    const ops = q("SELECT p.op FROM process_material pm JOIN processes p ON p.id=pm.process_id WHERE pm.line_id=? AND pm.io='IN' ORDER BY pm.pm_id").all(r.line_id).map(x => x.op);
    const state = l.bop_link === 'PHANTOM' ? 'phantom' : l.bop_link === 'NONE' ? 'none' : ops.length ? 'linked' : 'unassigned';
    const parts = r.path.split(' > '); const parentPn = parts[parts.length - 2];
    const it = q('SELECT name, item_type FROM item WHERE item_id=?').get(r.item_id);
    const node = { lineId: r.line_id, level: r.depth, parentPn, pn: r.pn, name: it.name, kind: it.item_type, uom: r.uom, qtyPer: l.qty_per, qtyPerProduct: r9(r.qty), scrapRate: l.scrap_pct, qtyBasis: l.qty_basis, phantom: !!r.is_phantom, altGroup: l.alt_group, altPriority: l.alt_priority, bop: { op: ops[0] || null, mode: ops.length ? 'IN' : null, state }, effFrom: l.valid_from, effTo: l.valid_to, children: [] };
    all.push(node); byPath.set(r.path, node);
    const parent = byPath.get(parts.slice(0, -1).join(' > '));
    (parent ? parent.children : top).push(node);
  }
  const totals = {};
  for (const n of all) if (!n.children.length && !n.phantom) totals[n.uom] = r9((totals[n.uom] || 0) + n.qtyPerProduct);
  const ri = item(root);
  return { root: { pn: ri.pn, name: ri.name, kind: ri.item_type, uom: ri.base_uom }, nodes: top, totals };
}
const hdrJson = (h) => ({ id: h.bom_id, status: h.status, effFrom: h.valid_from, effTo: h.valid_to, rev: h.rev, lineCount: q('SELECT count(*) c FROM bom_line WHERE bom_id=?').get(h.bom_id).c,
  lines: q('SELECT l.*, c.pn FROM bom_line l JOIN item c ON c.item_id=l.child_item_id WHERE bom_id=? ORDER BY line_no').all(h.bom_id).map(l => ({ id: l.line_id, pn: l.pn, qtyPer: l.qty_per, uom: l.uom_code, altGroup: l.alt_group, altPriority: l.alt_priority })) });
const procJson = (pr) => ({
  op: pr.op,
  inputs: q("SELECT pm.pm_id, pm.line_id, pm.split_pct, pm.issue_method, c.pn, (SELECT qty_per_product FROM v_bom_line_qpp v WHERE v.line_id=pm.line_id) qpp FROM process_material pm JOIN bom_line l ON l.line_id=pm.line_id JOIN item c ON c.item_id=l.child_item_id WHERE pm.io='IN' AND pm.process_id=? ORDER BY pm.pm_id").all(pr.id)
    .map(r => ({ pmId: r.pm_id, lineId: r.line_id, pn: r.pn, qtyPerProduct: r9(r.qpp * r.split_pct / 100), splitPct: r.split_pct, issueMethod: r.issue_method })),
  outputs: q("SELECT i.pn, pm.is_final, pm.out_state FROM process_material pm JOIN item i ON i.item_id=pm.item_id WHERE pm.io='OUT' AND pm.process_id=?").all(pr.id).map(r => ({ pn: r.pn, isFinal: !!r.is_final, outState: r.out_state })),
  unassigned: q("SELECT child_pn pn FROM v_bom_line_bop WHERE bop_status='UNASSIGNED'").all(),
});
const lotJson = (m) => m && ({ id: m.lot_id, lotNo: m.lot_no, pn: q('SELECT pn FROM item WHERE item_id=?').get(m.item_id).pn, kind: m.lot_kind, parentLotId: m.parent_lot_id, qty: m.qty, qtyInit: m.qty_init, uom: m.uom_code, status: m.status, supplier: m.supplier, supplierLot: m.supplier_lot });
const lot = (id) => q('SELECT * FROM mat_lot WHERE lot_id=?').get(Number(id));
const GEN = (dir) => `WITH RECURSIVE e(p,c,kind,pid,qty,uom) AS (SELECT parent_lot_id, lot_id, 'SPLIT', NULL, qty_init, uom_code FROM mat_lot WHERE parent_lot_id IS NOT NULL UNION ALL SELECT in_lot_id, out_lot_id, 'CONSUME', process_id, qty_consumed, uom_code FROM lot_genealogy),
 w(lot_id, depth, path, kind, pid, qty, uom) AS (SELECT lot_id, 0, '/'||lot_id, NULL, NULL, NULL, NULL FROM mat_lot WHERE lot_id=:lot UNION SELECT ${dir === 'back' ? 'e.p' : 'e.c'}, w.depth+1, w.path||'/'||${dir === 'back' ? 'e.p' : 'e.c'}, e.kind, e.pid, e.qty, e.uom FROM w JOIN e ON ${dir === 'back' ? 'e.c' : 'e.p'}=w.lot_id WHERE w.depth<64)
 SELECT w.*, m.lot_no, m.lot_kind, m.supplier, m.supplier_lot, i.pn, p.op FROM w JOIN mat_lot m ON m.lot_id=w.lot_id JOIN item i ON i.item_id=m.item_id LEFT JOIN processes p ON p.id=w.pid ORDER BY w.depth, w.path`;

const routes = [];
const on = (m, re, fn) => routes.push([m, re, fn]);
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const fail = (res, e, code = 400) => json(res, code, { error: String(e?.message || e) });

on('POST', /^\/api\/login$/, (b, res) => json(res, 200, { token: 'mock', user: { role: 'admin' } }));
on('GET', /^\/api\/admin\/bop$/, (b, res) => {
  const procs = q("SELECT p.*, (SELECT COUNT(*) FROM process_inputs i WHERE i.process_id = p.id) AS input_count FROM processes p WHERE p.product_code = ? ORDER BY p.line, p.seq, p.op").all('BLDC-500W-48V');
  json(res, 200, { processes: procs.map(p => ({ op: p.op, inputCount: p.input_count })), summary: { processes: procs.length, parts: q('SELECT COUNT(*) AS c FROM parts').get().c, inputs: procs.reduce((s, p) => s + p.input_count, 0) } });
});
on('GET', new RegExp(`^${B}/summary$`), (b, res) => json(res, 200, { items: q('SELECT count(*) c FROM item').get().c, classes: q('SELECT count(*) c FROM mat_class').get().c, bomHeaders: q('SELECT count(*) c FROM bom_header').get().c, bomLines: q('SELECT count(*) c FROM bom_line').get().c, lots: q('SELECT count(*) c FROM mat_lot').get().c, check: Object.fromEntries(q('SELECT rule, cnt FROM v_chk_summary').all().map(r => [r.rule, r.cnt])) }));
on('GET', new RegExp(`^${B}/check$`), (b, res) => json(res, 200, { summary: {}, details: { 'D-8': q('SELECT detail FROM v_chk_bop_unassigned').all().map(r => r.detail) } }));
on('GET', new RegExp(`^${B}/uom$`), (b, res) => json(res, 200, q('SELECT * FROM uom').all().map(u => ({ code: u.uom_code, name: u.name_ko, kind: u.dim, decimals: u.decimals }))));
on('GET', new RegExp(`^${B}/classes$`), (b, res) => json(res, 200, q('SELECT c.*, (SELECT count(*) FROM item i WHERE i.class_id=c.class_id) n FROM mat_class c ORDER BY sort_no').all().map(c => ({ id: c.class_id, code: c.class_code, name: c.name, parentId: c.parent_class_id, itemCount: c.n }))));
on('GET', new RegExp(`^${B}/items$`), (b, res, m, qs) => {
  let sql = 'SELECT i.*, c.class_code, c.name AS class_name FROM item i JOIN mat_class c ON c.class_id=i.class_id WHERE 1=1'; const p = [];
  if (qs.get('q')) { sql += ' AND (i.pn LIKE ? OR i.name LIKE ?)'; p.push(`%${qs.get('q')}%`, `%${qs.get('q')}%`); }
  if (qs.get('kind') === 'PHANTOM') sql += ' AND i.is_phantom=1';
  if (qs.get('classId')) { sql += ' AND i.class_id=?'; p.push(Number(qs.get('classId'))); }
  json(res, 200, q(sql).all(...p).map(itemJson));
});
on('GET', new RegExp(`^${B}/items/([^/]+)$`), (b, res, m) => {
  const r = item(decodeURIComponent(m[1])); if (!r) return json(res, 404, { error: 'no item' });
  json(res, 200, { item: itemJson(r), whereUsed: q('SELECT p.pn parentPn, p.name parentName, l.qty_per qtyPer, l.uom_code uom, h.bom_id headerId, h.status FROM bom_line l JOIN bom_header h ON h.bom_id=l.bom_id JOIN item p ON p.item_id=h.parent_item_id WHERE l.child_item_id=?').all(r.item_id),
    headers: q('SELECT * FROM bom_header WHERE parent_item_id=?').all(r.item_id).map(hdrJson).map(h => { delete h.lines; return h; }), lots: q('SELECT count(*) c FROM mat_lot WHERE item_id=?').get(r.item_id).c });
});
on('POST', new RegExp(`^${B}/items$`), (b, res) => { try { tx(() => q("INSERT INTO item(pn,name,class_id,item_type,source_type,base_uom,status,trace_mode) VALUES (?,?,?,?,?,?,?,?)").run(b.pn, b.name || b.pn, b.classId, b.kind || 'PT', b.sourceType || 'BUY', b.uom || 'EA', b.status || 'ACTIVE', b.traceKind || 'NONE')); json(res, 201, { ok: true, item: itemJson(item(b.pn)) }); } catch (e) { fail(res, e); } });
on('DELETE', new RegExp(`^${B}/items/([^/]+)$`), (b, res) => json(res, 405, { error: 'R-11: item 은 삭제하지 않는다' }));
on('GET', new RegExp(`^${B}/bom/([^/]+)$`), (b, res, m, qs) => { const pn = decodeURIComponent(m[1]); if (!item(pn)) return json(res, 404, { error: 'no item' }); json(res, 200, explode(pn, asof(qs.get('asOf')), Number(qs.get('depth')) || 64)); });
on('GET', new RegExp(`^${B}/where-used/([^/]+)$`), (b, res, m, qs) => {
  const pn = decodeURIComponent(m[1]); if (!item(pn)) return json(res, 404, { error: 'no item' });
  const rows = q(Q3).all({ ':pn': pn, ':asof': asof(qs.get('asOf')) });
  const maxd = Math.max(0, ...rows.map(r => r.depth));
  const paths = rows.filter(r => r.depth === maxd && r.pn === 'BLDC-500W-48V').map(r => r.path.split(' > ').reverse().map(p => ({ pn: p, name: item(p)?.name, qtyPer: 1 })));
  json(res, 200, { pn, paths });
});
on('GET', new RegExp(`^${B}/bom-headers/([^/]+)$`), (b, res, m) => { const r = item(decodeURIComponent(m[1])); if (!r) return json(res, 404, { error: 'no' }); json(res, 200, { pn: r.pn, headers: q('SELECT * FROM bom_header WHERE parent_item_id=?').all(r.item_id).map(hdrJson) }); });
on('POST', new RegExp(`^${B}/bom-headers$`), (b, res) => { try { const r = item(b.pn); const id = tx(() => Number(q('INSERT INTO bom_header(parent_item_id,rev,base_qty,base_uom,status,valid_from,valid_to) VALUES (?,?,?,?,?,?,?)').run(r.item_id, b.rev || 'A', b.baseQty || 1, b.baseUom || r.base_uom, b.status || 'DRAFT', b.effFrom || '2026-01-01', b.effTo || '9999-12-31').lastInsertRowid)); json(res, 201, { ok: true, header: hdrJson(q('SELECT * FROM bom_header WHERE bom_id=?').get(id)) }); } catch (e) { fail(res, e); } });
on('PUT', new RegExp(`^${B}/bom-headers/(\\d+)$`), (b, res, m) => { try { tx(() => q('UPDATE bom_header SET status=COALESCE(?,status) WHERE bom_id=?').run(b.status ?? null, Number(m[1]))); json(res, 200, { ok: true }); } catch (e) { fail(res, e); } });
on('POST', new RegExp(`^${B}/bom-lines$`), (b, res) => {
  try {
    const c = item(b.pn ?? b.childPn); if (!c) return json(res, 404, { error: 'no child' });
    if (!(Number(b.qtyPer) > 0)) return json(res, 400, { error: 'qtyPer 는 0 보다 커야 합니다.' });
    const h = q('SELECT * FROM bom_header WHERE bom_id=?').get(Number(b.headerId ?? b.bomId));
    const id = tx(() => Number(q('INSERT INTO bom_line(bom_id,line_no,child_item_id,qty_per,uom_code,alt_group,alt_priority,valid_from,valid_to) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(h.bom_id, 990, c.item_id, Number(b.qtyPer), b.uom || c.base_uom, b.altGroup ?? null, b.altPriority ?? null, b.effFrom || h.valid_from, b.effTo || '9999-12-31').lastInsertRowid));
    json(res, 201, { ok: true, line: { id } });
  } catch (e) { fail(res, e); }
});
on('PUT', new RegExp(`^${B}/bom-lines/(\\d+)$`), (b, res, m) => { try { tx(() => { if (b.qtyPer !== undefined) q('UPDATE bom_line SET qty_per=? WHERE line_id=?').run(Number(b.qtyPer), Number(m[1])); if (b.altGroup !== undefined) q('UPDATE bom_line SET alt_group=?, alt_priority=? WHERE line_id=?').run(b.altGroup, b.altPriority ?? null, Number(m[1])); }); json(res, 200, { ok: true }); } catch (e) { fail(res, e); } });
on('DELETE', new RegExp(`^${B}/bom-lines/(\\d+)$`), (b, res, m) => { try { tx(() => q('DELETE FROM bom_line WHERE line_id=?').run(Number(m[1]))); json(res, 200, { ok: true }); } catch (e) { fail(res, e); } });
on('GET', new RegExp(`^${B}/process/([^/]+)$`), (b, res, m) => { const pr = q('SELECT * FROM processes WHERE op=?').get(decodeURIComponent(m[1])); if (!pr) return json(res, 404, { error: 'no op' }); json(res, 200, procJson(pr)); });
on('PUT', new RegExp(`^${B}/process/([^/]+)/links$`), (b, res, m) => {
  const pr = q('SELECT * FROM processes WHERE op=?').get(decodeURIComponent(m[1])); if (!pr) return json(res, 404, { error: 'no op' });
  try {
    tx(() => {
      const ins = (b.links || []).filter(l => (l.mode || 'IN') === 'IN').sort((a, c) => (a.seq || 0) - (c.seq || 0));
      const cur = q("SELECT pm_id, line_id FROM process_material WHERE process_id=? AND io='IN' ORDER BY pm_id").all(pr.id);
      if (cur.length === ins.length && cur.every((c, i) => c.line_id === Number(ins[i].lineId))) return;
      q("DELETE FROM process_material WHERE process_id=? AND io='IN'").run(pr.id);
      for (const l of ins) q("INSERT INTO process_material(process_id,io,line_id,split_pct) VALUES (?,'IN',?,?)").run(pr.id, Number(l.lineId), l.splitPct ?? 100);
    });
    json(res, 200, { ok: true, ...procJson(pr) });
  } catch (e) { fail(res, e); }
});
on('GET', new RegExp(`^${B}/lots$`), (b, res, m, qs) => json(res, 200, q(qs.get('pn') ? 'SELECT m.* FROM mat_lot m JOIN item i ON i.item_id=m.item_id WHERE i.pn=?' : 'SELECT * FROM mat_lot').all(...(qs.get('pn') ? [qs.get('pn')] : [])).map(lotJson)));
on('GET', new RegExp(`^${B}/lots/(\\d+)$`), (b, res, m) => { const l = lot(m[1]); l ? json(res, 200, lotJson(l)) : json(res, 404, { error: 'no lot' }); });
on('POST', new RegExp(`^${B}/lots$`), (b, res) => {
  try {
    const it = item(b.pn); if (!it) return json(res, 404, { error: 'no item' });
    const parent = b.parentLotId ? lot(b.parentLotId) : null;
    let pm = null; if (b.stateOp) pm = q("SELECT pm.pm_id FROM process_material pm JOIN processes p ON p.id=pm.process_id WHERE pm.io='OUT' AND pm.item_id=? AND p.op=?").get(it.item_id, b.stateOp)?.pm_id ?? null;
    const id = tx(() => {
      if (parent) { if (parent.qty < Number(b.qty)) throw new Error(`D-17: 부모 로트 잔량(${parent.qty})보다 큰 수량은 분할할 수 없습니다.`); q('UPDATE mat_lot SET qty=qty-? WHERE lot_id=?').run(Number(b.qty), parent.lot_id); }
      return Number(q('INSERT INTO mat_lot(lot_no,item_id,lot_kind,parent_lot_id,qty,uom_code,state_pm_id,supplier,supplier_lot) VALUES (?,?,?,?,?,?,?,?,?)').run(b.lotNo, it.item_id, b.kind || (parent ? 'SUBLOT' : 'LOT'), parent?.lot_id ?? null, Number(b.qty), b.uom || it.base_uom, pm, b.supplier ?? null, b.supplierLot ?? null).lastInsertRowid);
    });
    json(res, 201, { ok: true, lot: lotJson(lot(id)) });
  } catch (e) { fail(res, e); }
});
on('POST', new RegExp(`^${B}/lots/(\\d+)/consume$`), (b, res, m) => {
  try {
    const out = lot(m[1]), inn = lot(b.inLotId); if (!out || !inn) return json(res, 404, { error: 'no lot' });
    const pr = b.op ? q('SELECT id FROM processes WHERE op=?').get(b.op) : null;
    tx(() => {
      if (!b.force && inn.qty < Number(b.qty)) throw new Error('D-17: 잔량 부족');
      q('INSERT INTO lot_genealogy(out_lot_id,in_lot_id,process_id,qty_consumed,uom_code) VALUES (?,?,?,?,?)').run(out.lot_id, inn.lot_id, pr?.id ?? null, Number(b.qty), b.uom || inn.uom_code);
      q("UPDATE mat_lot SET qty=MAX(0,qty-?), status=CASE WHEN qty-?<=0 THEN 'CONSUMED' ELSE status END WHERE lot_id=?").run(Number(b.qty), Number(b.qty), inn.lot_id);
    });
    json(res, 201, { ok: true, outLot: lotJson(lot(out.lot_id)), inLot: lotJson(lot(inn.lot_id)) });
  } catch (e) { fail(res, e); }
});
on('GET', new RegExp(`^${B}/lots/(\\d+)/genealogy$`), (b, res, m, qs) => {
  const l = lot(m[1]); if (!l) return json(res, 404, { error: 'no lot' });
  const rows = q(GEN(qs.get('dir') === 'fwd' ? 'fwd' : 'back')).all({ ':lot': l.lot_id });
  const byPath = new Map(); let root = null;
  for (const r of rows) { const n = { lotId: r.lot_id, lotNo: r.lot_no, pn: r.pn, kind: r.lot_kind, supplier: r.supplier, supplierLot: r.supplier_lot, edge: r.kind ? { kind: r.kind, op: r.op, qty: r.qty, uom: r.uom } : null, children: [] }; byPath.set(r.path, n); const p = byPath.get(r.path.slice(0, r.path.lastIndexOf('/'))); if (p) p.children.push(n); else root = n; }
  json(res, 200, { lot: lotJson(l), tree: root ? root.children : [] });
});
on('POST', new RegExp(`^${B}/import-sample$`), (b, res) => {
  db.exec('PRAGMA wal_checkpoint(FULL)');
  const r = spawnSync('python', [path.join(PROTO, 'v1_load.py'), '--db', DB, '--rerun', '--quiet'], { env: { ...process.env, PYTHONUTF8: '1' }, encoding: 'utf8' });
  if (r.status !== 0) return json(res, 400, { error: r.stderr || r.stdout, mismatches: [] });
  const counts = { item: q('SELECT count(*) c FROM item').get().c, bom_line: q('SELECT count(*) c FROM bom_line').get().c, process_material: q('SELECT count(*) c FROM process_material').get().c };
  const check = Object.fromEntries(q('SELECT rule, cnt FROM v_chk_summary').all().map(x => [x.rule, x.cnt]));
  json(res, 200, { ok: true, counts, check, expectedMatch: counts.item === 60 && counts.bom_line === 59 && counts.process_material === 70, mismatches: [] });
});

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let body = '';
  req.on('data', (c) => body += c);
  req.on('end', () => {
    if (!u.pathname.startsWith('/api/login') && req.headers['x-auth-token'] !== 'mock') return json(res, 401, { error: '인증이 필요합니다.' });
    for (const [m, re, fn] of routes) { const mm = m === req.method && u.pathname.match(re); if (mm) { try { return fn(body ? JSON.parse(body) : {}, res, mm, u.searchParams); } catch (e) { return fail(res, e, 500); } } }
    json(res, 404, { error: `no route ${req.method} ${u.pathname}` });
  });
}).listen(PORT, () => console.log(`[mock] http://localhost:${PORT}  db=${DB}  (도구 자체 시험용 스텁 — 운영 서버 아님)`));
