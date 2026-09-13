/* server/materials.js — 자재(Material) v1.0: 적재기 + 관리자 API (스프린트 3, 인터페이스 §10)
 *
 * 원천 계약: docs/4m/ddl-v1.sql(스키마·트리거·호환 뷰, 윤태경) · docs/4m/cleansing-v1.json(적재 규칙) · 계획서 §5.9 기준 쿼리(Q-1 정전개 · Q-3 역전개 · Q-5 로트 추적).
 *  - loadMaterials(db, { source, cleansing, strict })   원천 BOP JSON(docs/bldc/bldc-500w-48v.json) 을 cleansing 규칙대로
 *                                                        uom → mat_class → item → bom_header → bom_line → OUT 24 → IN 46 순서로 UPSERT(멱등, 삭제 없음).
 *                                                        db.js 의 이행 [1], 기동 시드(FW_SEED_PRODUCT_LINE), POST /api/admin/bop/import·apply-sample, POST …/materials/import-sample 가 공용.
 *  - registerMaterials(app, { requireAdmin, db, queries, settings, afterChange })   /api/admin/materials/* 라우트 (index.js 가 analytics 처럼 동적 import).
 *  - readMaterialFiles()                                  두 원천 파일 읽기 (없으면 null).
 * 이 파일은 db.js 를 import 하지 않는다 — db.js 가 적재기를 import 하므로(이행 [1]) 순환이 생긴다. db 는 인자로 받는다.
 * 트리거가 거부한 쓰기(RAISE 'R-1: …' 등)는 node:sqlite 가 그 문자열을 그대로 message 로 주므로 API 는 400 { error } 에 그대로 담는다. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.join(__dirname, '..');
export const CLEANSING_FILE = path.join(PROJECT_ROOT, 'docs', '4m', 'cleansing-v1.json');
export const SOURCE_FILE = path.join(PROJECT_ROOT, 'docs', 'bldc', 'bldc-500w-48v.json');
const PARTS_DIR = path.join(PROJECT_ROOT, 'public', 'assets', 'parts');   // 단품 이미지 <PN>.png (인터페이스 §8)

const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
const today = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const r9 = (v) => (v === null || v === undefined ? v : Math.round(v * 1e9) / 1e9);   // 전개 계산값의 부동소수 잡음 제거 (0.85/80×80 = 0.85)

export function readMaterialFiles() {
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  return { cleansing: read(CLEANSING_FILE), source: read(SOURCE_FILE), files: { cleansing: CLEANSING_FILE, source: SOURCE_FILE } };
}

// ────────────────────────────────────────────────────────────────────────────
// 적재기 (cleansing-v1.json loader_algorithm 1~7)
// ────────────────────────────────────────────────────────────────────────────
export function loadMaterials(db, { source, cleansing, strict = false, imageDir = PARTS_DIR } = {}) {
  const prod = source?.product;
  const code = prod?.code ? String(prod.code) : null;
  const fg = cleansing?.defaults?.fg_pn;
  if (!code || !fg) throw new Error('원천 JSON(product.code) 또는 적재 규칙(defaults.fg_pn) 이 없습니다.');
  if (code !== fg) throw new Error(`적재 규칙 fg_pn(${fg}) 과 원천 제품(${code}) 이 다릅니다 — 이 제품용 cleansing 파일이 필요합니다.`);
  const d = cleansing.defaults;
  const warnings = [];
  const q = (sql) => db.prepare(sql);

  // 선행 테이블: processes 가 있어야 OUT/IN 을 넣을 수 있다 (노하린 지적 — FK 대상 4개는 db.js 가 먼저 만든다)
  const procRows = q('SELECT id, op, seq, line FROM processes WHERE product_code = ?').all(code);
  if (!procRows.length) throw new Error(`processes 에 ${code} 공정이 없습니다 — BOP(공정) 를 먼저 가져오세요.`);
  const procByOp = new Map(procRows.map(p => [p.op, p]));

  // ── 논리 P/N → 실제 P/N (pn_pending: 승인 전에는 TMP-) ──
  const pending = cleansing.pn_pending || {};
  const tmp = {};
  const actualOf = (logical) => {
    const p = pending[logical];
    if (!p || typeof p !== 'object') return logical;
    if (p.approved === true) return logical;
    return p.tmp || logical;
  };

  db.exec('SAVEPOINT fw_mat');
  try {
    // 1. uom · uom_conv · mat_class (INSERT OR IGNORE — 멱등, 이름·표기는 갱신)
    const insUom = q(`INSERT OR IGNORE INTO uom (uom_code, symbol, name_ko, dim, decimals, is_base) VALUES (?, ?, ?, ?, ?, ?)`);
    const updUom = q(`UPDATE uom SET symbol = ?, name_ko = ?, decimals = ? WHERE uom_code = ?`);
    for (const u of cleansing.uom || []) {
      insUom.run(u.code, u.symbol ?? null, u.name_ko, u.dim, num(u.decimals) ?? 0, u.is_base ? 1 : 0);
      updUom.run(u.symbol ?? null, u.name_ko, num(u.decimals) ?? 0, u.code);
    }
    const insConv = q(`INSERT OR IGNORE INTO uom_conv (from_uom, to_uom, factor, item_id, note) VALUES (?, ?, ?, ?, ?)`);
    for (const c of cleansing.uom_conv || []) {
      const itemId = c.item ? (q('SELECT item_id FROM item WHERE pn = ?').get(actualOf(c.item))?.item_id ?? null) : null;
      if (c.item && itemId === null) { warnings.push(`uom_conv ${c.from}→${c.to}: 품목 ${c.item} 이 아직 없어 건너뜀`); continue; }
      insConv.run(c.from, c.to, Number(c.factor), itemId, c.note || null);
    }
    const upClass = q(`
      INSERT INTO mat_class (class_code, name, parent_class_id, is_leaf, def_trace_mode, def_issue_method, shelf_life_days, sort_no)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(class_code) DO UPDATE SET name = excluded.name, parent_class_id = excluded.parent_class_id, is_leaf = excluded.is_leaf,
        def_trace_mode = excluded.def_trace_mode, def_issue_method = excluded.def_issue_method, shelf_life_days = excluded.shelf_life_days, sort_no = excluded.sort_no`);
    const classId = new Map();
    for (const c of cleansing.mat_class || []) {
      const parentId = c.parent ? classId.get(c.parent) : null;
      if (c.parent && parentId === undefined) throw new Error(`mat_class ${c.code}: 상위 분류 ${c.parent} 가 앞에 없습니다 (표 순서).`);
      upClass.run(c.code, c.name, parentId ?? null, c.leaf ? 1 : 0, c.def_trace_mode || null, c.def_issue_method || null, num(c.shelf_life_days), num(c.sort) ?? 0);
      classId.set(c.code, q('SELECT class_id FROM mat_class WHERE class_code = ?').get(c.code).class_id);
    }

    // 2. 품목 정의: 원천 product 1 + subassemblies + parts(자기참조 규칙 적용) + new_items. 이름·규격은 원천, 속성은 items 표
    const subs = Array.isArray(source.subassemblies) ? source.subassemblies : [];
    const parts = Array.isArray(source.parts) ? source.parts : [];
    const attrs = cleansing.items || {};
    const selfRules = new Map((cleansing.self_reference || []).map(r => [r.pn, r]));
    const split = cleansing.parent_split || null;
    const reparent = new Map((cleansing.reparent || []).map(r => [r.pn, r]));
    const unitMap = cleansing.unit_map || {};
    const lineAttrs = new Map((cleansing.line_attrs || []).map(a => [`${a.parent}>${a.child}`, a]));
    const defs = new Map();   // 논리 pn → { name, nameKo, spec }
    const spec = prod.spec || {};
    defs.set(code, { name: String(prod.name || code), nameKo: null,
      spec: [spec['정격 출력'], spec['정격 전압'], spec['정격 회전수']].filter(Boolean).join(' / ') || null });
    const partByPn = new Map();
    for (const p of parts) if (p?.pn && !partByPn.has(String(p.pn))) partByPn.set(String(p.pn), p);
    for (const s of subs) {
      if (!s?.pn) continue;
      const own = partByPn.get(String(s.pn));
      const rule = selfRules.get(String(s.pn));
      // 자기참조 행이 '자식을 개번' 하는 경우(FS-7020) 그 행의 규격은 자식 것이므로 쓰지 않는다. DEMOTE(FS-7010) 는 같은 물건이라 규격을 가져온다
      const ownSpec = own && own.parentPn === own.pn && rule?.action === 'RENUMBER_CHILD' ? null : (own?.spec || null);
      defs.set(String(s.pn), { name: String(s.name || own?.name || s.pn), nameKo: null, spec: ownSpec ?? (s.note || null) });
    }
    // 간선(부모→자식) 후보 — 원천 순서 유지 (line_no · IN 정렬의 근거)
    const edges = [];
    for (const s of subs) if (s?.pn) edges.push({ parent: code, child: String(s.pn), qty: num(s.qty) ?? 1, unit: s.unit || 'EA', note: null });
    for (const p of parts) {
      if (!p?.pn) continue;
      let parent = String(p.parentPn || ''), child = String(p.pn);
      if (parent === child) {
        const rule = selfRules.get(child);
        if (!rule) throw new Error(`자기참조 행 ${child}→${child} 에 self_reference 규칙이 없습니다.`);
        if (rule.action === 'DEMOTE') continue;                          // 조립품 지위 해제 — 행 자체를 버린다
        if (rule.action === 'RENUMBER_CHILD') child = String(rule.child_new_pn);
        else throw new Error(`self_reference ${child}: 알 수 없는 action ${rule.action}`);
      }
      if (split && parent === split.from) {                               // 'HA-3000/EX-5000' → 단일 부모
        let to = null, rest = null;
        for (const [k, v] of Object.entries(split.to || {})) { if (Array.isArray(v) && v.includes(child)) to = k; else if (v === 'REST') rest = k; }
        parent = to || rest;
        if (!parent) throw new Error(`parent_split: ${child} 의 부모를 정할 수 없습니다.`);
      }
      const rp = reparent.get(child);
      if (rp && parent === rp.from) {
        const target = pending[rp.to]?.rejected === true && rp.fallback_to ? rp.fallback_to : rp.to;
        parent = String(target);
      }
      if (!defs.has(child)) defs.set(child, { name: String(p.name || child), nameKo: null, spec: p.spec || null });
      edges.push({ parent, child, qty: num(p.qtyPerParent), unit: p.unit || 'EA', note: null });
    }
    for (const n of cleansing.new_items || []) {
      const cur = defs.get(n.pn) || {};
      defs.set(n.pn, { name: n.name || cur.name || n.pn, nameKo: n.name_ko || cur.nameKo || null, spec: n.spec || cur.spec || null });
    }
    for (const x of cleansing.extra_lines || []) {
      edges.push({ parent: String(x.parent), child: String(x.child), qty: num(x.qty), unit: x.uom || 'EA', lineNo: num(x.line_no), note: x.source ? `원천: ${x.source}` : null });
    }
    // 부모 사슬(이미지 폴백용: 자기 → 가장 가까운 조상 중 <PN>.png 가 있는 것 — 현행 parts.image 규칙(pn → parentPn)의 다단 일반화)
    const parentOf = new Map();
    for (const e of edges) if (!parentOf.has(e.child)) parentOf.set(e.child, e.parent);
    const hasImg = (pn) => !!pn && !/[\\/\s]/.test(pn) && fs.existsSync(path.join(imageDir, `${pn}.png`));
    const imageFor = (logical) => {
      let cur = logical;
      for (let i = 0; i < 12 && cur; i++) {
        const a = actualOf(cur);
        if (hasImg(a)) return `${a}.png`;
        if (a !== cur && hasImg(cur)) return `${cur}.png`;
        cur = parentOf.get(cur);
      }
      return null;
    };

    // 3. 품목 UPSERT (pn 기준). 승인된 pn_pending 은 TMP → 정식 pn 으로 UPDATE 한 번 (FK 는 item_id 라 영향 없음)
    for (const [logical, p] of Object.entries(pending)) {
      if (!p || typeof p !== 'object' || !p.tmp) continue;
      const hasTmp = !!q('SELECT 1 FROM item WHERE pn = ?').get(p.tmp), hasReal = !!q('SELECT 1 FROM item WHERE pn = ?').get(logical);
      if (p.approved === true && hasTmp && !hasReal) { q('UPDATE item SET pn = ?, updated_at = datetime(\'now\',\'localtime\') WHERE pn = ?').run(logical, p.tmp); warnings.push(`${p.tmp} → ${logical} 품번 승인 반영`); }
      if (p.approved !== true && hasReal && !hasTmp) { pending[logical] = { ...p, approved: true }; warnings.push(`${logical}: DB 에 이미 정식 품번이 있어 TMP 로 되돌리지 않음`); }
      tmp[logical] = actualOf(logical);
      if (tmp[logical] === logical) delete tmp[logical];
    }
    const upItem = q(`
      INSERT INTO item (pn, name, name_ko, spec, class_id, item_type, source_type, base_uom, is_phantom, trace_mode, status, image, eff_from)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pn) DO UPDATE SET name = excluded.name, name_ko = excluded.name_ko, spec = excluded.spec, class_id = excluded.class_id,
        item_type = excluded.item_type, source_type = excluded.source_type, base_uom = excluded.base_uom, is_phantom = excluded.is_phantom,
        trace_mode = excluded.trace_mode, image = excluded.image, updated_at = datetime('now','localtime')`);
    const itemId = new Map();   // 논리 pn → item_id
    for (const [logical, def] of defs) {
      const a = attrs[logical];
      if (!Array.isArray(a)) throw new Error(`cleansing items 표에 없는 품목: ${logical}`);
      const [cls, type, src, uom, phantom, trace] = a;
      if (!classId.has(cls)) throw new Error(`${logical}: 분류 ${cls} 가 mat_class 표에 없습니다.`);
      const pn = actualOf(logical);
      upItem.run(pn, def.name, def.nameKo, def.spec, classId.get(cls), type, src, uom, phantom ? 1 : 0, trace || 'NONE', d.item_status || 'ACTIVE', imageFor(logical), d.valid_from || today());
      itemId.set(logical, q('SELECT item_id FROM item WHERE pn = ?').get(pn).item_id);
    }
    const idOf = (logical) => {
      const id = itemId.get(logical);
      if (id === undefined) throw new Error(`품목 ${logical} 이 정의되지 않았습니다.`);
      return id;
    };

    // 4. bom_header (parent, bom_type, alt_no, rev) 기준 UPSERT — 상태·유효일자는 최초 INSERT 때만
    const validNote = d._valid_from_note ? `valid_from ${d.valid_from}: ${d._valid_from_note}` : null;
    const bomId = new Map();   // 논리 parent pn → bom_id
    for (const h of cleansing.bom_headers || []) {
      const pid = idOf(h.parent);
      const key = [pid, d.bom_type || 'PROD', d.alt_no || '00', d.rev || 'A'];
      const cur = q('SELECT bom_id FROM bom_header WHERE parent_item_id = ? AND bom_type = ? AND alt_no = ? AND rev = ?').get(...key);
      const note = [h.note, validNote].filter(Boolean).join(' · ') || null;
      if (cur) { q('UPDATE bom_header SET base_qty = ?, base_uom = ?, note = ? WHERE bom_id = ?').run(num(h.base_qty) ?? 1, h.base_uom || 'EA', note, cur.bom_id); bomId.set(h.parent, cur.bom_id); }
      else {
        const r = q(`INSERT INTO bom_header (parent_item_id, bom_type, alt_no, rev, base_qty, base_uom, status, valid_from, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(...key, num(h.base_qty) ?? 1, h.base_uom || 'EA', d.bom_status || 'ACTIVE', d.valid_from || today(), note);
        bomId.set(h.parent, Number(r.lastInsertRowid));
      }
    }

    // 5. bom_line — (bom_id, child, alt_group NULL, valid_from) 기준 UPSERT. bop_link 는 넣지 않는다(팬텀 자식은 트리거가 PHANTOM)
    const lineNoCounter = new Map();
    const lineId = new Map();   // 'parent>child' → line_id
    for (const e of edges) {
      const bid = bomId.get(e.parent);
      if (bid === undefined) throw new Error(`bom_line ${e.parent}>${e.child}: 부모 ${e.parent} 의 bom_header 가 표에 없습니다.`);
      const cid = idOf(e.child);
      const uom = unitMap[e.unit] || e.unit || 'EA';
      const lineNo = e.lineNo ?? (lineNoCounter.set(e.parent, (lineNoCounter.get(e.parent) || 0) + 10), lineNoCounter.get(e.parent));
      if (e.lineNo !== undefined && e.lineNo !== null) lineNoCounter.set(e.parent, Math.max(lineNoCounter.get(e.parent) || 0, e.lineNo));
      const la = lineAttrs.get(`${e.parent}>${e.child}`);
      const note = [e.note, la?.note].filter(Boolean).join(' · ') || null;
      const qtyBasis = la?.qty_basis || 'NET';
      if (e.qty === null || !(e.qty > 0)) throw new Error(`bom_line ${e.parent}>${e.child}: 수량이 없습니다.`);
      const vf = d.valid_from || today();
      const cur = q(`SELECT line_id FROM bom_line WHERE bom_id = ? AND child_item_id = ? AND alt_group IS NULL AND valid_from = ?`).get(bid, cid, vf);
      if (cur) {
        q('UPDATE bom_line SET line_no = ?, qty_per = ?, uom_code = ?, qty_basis = ?, scrap_pct = ?, note = ? WHERE line_id = ?')
          .run(lineNo, e.qty, uom, qtyBasis, num(d.scrap_pct) ?? 0, note, cur.line_id);
        lineId.set(`${e.parent}>${e.child}`, cur.line_id);
      } else {
        const r = q(`INSERT INTO bom_line (bom_id, line_no, child_item_id, qty_per, uom_code, qty_basis, scrap_pct, valid_from, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(bid, lineNo, cid, e.qty, uom, qtyBasis, num(d.scrap_pct) ?? 0, vf, note);
        lineId.set(`${e.parent}>${e.child}`, Number(r.lastInsertRowid));
      }
    }

    // 6. process_material OUT 24 (먼저 — R-22 트리거가 IN 삽입 시 OUT 을 참조)
    let outN = 0, inN = 0;
    for (const [op, item, isFinal, outState, qtyOut] of cleansing.process_out?.rows || []) {
      const pr = procByOp.get(op);
      if (!pr) throw new Error(`process_out ${op}: processes 에 없는 공정입니다.`);
      const iid = idOf(item);
      const cur = q(`SELECT pm_id FROM process_material WHERE process_id = ? AND item_id = ? AND io = 'OUT'`).get(pr.id, iid);
      if (cur) q('UPDATE process_material SET is_final = ?, out_state = ?, qty_out = ? WHERE pm_id = ?').run(isFinal ? 1 : 0, outState ?? null, num(qtyOut), cur.pm_id);
      else q(`INSERT INTO process_material (process_id, io, item_id, is_final, out_state, qty_out) VALUES (?, 'OUT', ?, ?, ?, ?)`).run(pr.id, iid, isFinal ? 1 : 0, outState ?? null, num(qtyOut));
      outN++;
    }
    // 7. process_material IN 46 — line_process.rows 순서대로 (pm_id = 상태창 정렬 키). op 가 null 이면 넣지 않는다(미배정)
    for (const [parent, child, op, confidence, issue, reason] of cleansing.line_process?.rows || []) {
      if (!op) continue;
      const pr = procByOp.get(op);
      if (!pr) throw new Error(`line_process ${parent}>${child}: processes 에 없는 공정 ${op}`);
      const lid = lineId.get(`${parent}>${child}`);
      if (lid === undefined) throw new Error(`line_process ${parent}>${child}: 해당 bom_line 이 없습니다.`);
      const note = [confidence ? `[${confidence}]` : null, reason].filter(Boolean).join(' ');
      const cur = q(`SELECT pm_id FROM process_material WHERE process_id = ? AND line_id = ? AND io = 'IN'`).get(pr.id, lid);
      if (cur) q('UPDATE process_material SET issue_method = ?, note = ? WHERE pm_id = ?').run(issue || d.issue_method || 'BACKFLUSH', note || null, cur.pm_id);
      else q(`INSERT INTO process_material (process_id, io, line_id, issue_method, note) VALUES (?, 'IN', ?, ?, ?)`).run(pr.id, lid, issue || d.issue_method || 'BACKFLUSH', note || null);
      inN++;
    }

    // 8. expected · v_chk_summary 대조
    const check = verifyLoad(db, { cleansing, code, tmp });
    if (strict && !check.expectedMatch) {
      const err = new Error(`expected 대조 불일치 ${check.mismatches.length}건: ${check.mismatches.map(m => m.key).join(', ')}`);
      err.mismatches = check.mismatches; err.counts = check.counts;
      throw err;
    }
    db.exec('RELEASE fw_mat');
    return { ok: true, product: code, loaded: { out: outN, in: inN, items: defs.size, lines: edges.length }, ...check, tmp, warnings };
  } catch (e) {
    db.exec('ROLLBACK TO fw_mat'); db.exec('RELEASE fw_mat');
    throw e;
  }
}

// 적재 결과 검산 — cleansing.expected 의 키를 그대로 계산해 비교 (문자열 키는 TMP → 논리 P/N 으로 되돌려 비교)
export function verifyLoad(db, { cleansing, code, tmp = {} } = {}) {
  const q = (sql) => db.prepare(sql);
  const logicalOf = (pn) => Object.entries(tmp).find(([, a]) => a === pn)?.[0] || pn;
  const cnt = (sql, ...p) => q(sql).get(...p).c;
  const grp = (sql, k, v, ...p) => Object.fromEntries(q(sql).all(...p).map(r => [r[k], r[v]]));
  const counts = {
    uom: cnt('SELECT COUNT(*) c FROM uom'), uom_conv: cnt('SELECT COUNT(*) c FROM uom_conv'),
    mat_class: cnt('SELECT COUNT(*) c FROM mat_class'), mat_class_leaf: cnt('SELECT COUNT(*) c FROM mat_class WHERE is_leaf = 1'),
    item: cnt('SELECT COUNT(*) c FROM item'),
    item_by_type: grp('SELECT item_type k, COUNT(*) v FROM item GROUP BY item_type', 'k', 'v'),
    item_phantom: cnt('SELECT COUNT(*) c FROM item WHERE is_phantom = 1'),
    trace_mode: grp('SELECT trace_mode k, COUNT(*) v FROM item GROUP BY trace_mode', 'k', 'v'),
    bom_header: cnt('SELECT COUNT(*) c FROM bom_header'), bom_line: cnt('SELECT COUNT(*) c FROM bom_line'),
    bom_line_by_bop_link: { REQUIRED: 0, PHANTOM: 0, NONE: 0, ...grp('SELECT bop_link k, COUNT(*) v FROM bom_line GROUP BY bop_link', 'k', 'v') },
    process_material_in: cnt(`SELECT COUNT(*) c FROM process_material WHERE io = 'IN'`),
    process_material_out: cnt(`SELECT COUNT(*) c FROM process_material WHERE io = 'OUT'`),
    process_material_out_final: cnt(`SELECT COUNT(*) c FROM process_material WHERE io = 'OUT' AND is_final = 1`),
    max_depth: q('SELECT COALESCE(MAX(depth), 0) m FROM v_bom_line_qpp WHERE root_pn = ?').get(code).m,
    bop_status: { ASSIGNED: 0, UNASSIGNED: 0, PHANTOM: 0, ...grp('SELECT bop_status k, COUNT(*) v FROM v_bom_line_bop WHERE root_pn = ? GROUP BY bop_status', 'k', 'v', code) },
    unassigned_lines: q(`SELECT parent_pn, child_pn FROM v_bom_line_bop WHERE root_pn = ? AND bop_status = 'UNASSIGNED' ORDER BY line_id`).all(code)
      .map(r => `${logicalOf(r.parent_pn)}>${logicalOf(r.child_pn)}`),
    leaf_totals_per_product: grp(`
      SELECT q.uom_code k, SUM(q.qty_per_product) v FROM v_bom_line_qpp q
       WHERE q.root_pn = ? AND q.is_primary = 1 AND q.child_is_phantom = 0
         AND NOT EXISTS (SELECT 1 FROM v_bom_line_eff e WHERE e.parent_item_id = q.child_item_id)
       GROUP BY q.uom_code`, 'k', 'v', code),
    compat_process_inputs_rows: cnt('SELECT COUNT(*) c FROM v_process_inputs_compat'),
    compat_parts_rows: cnt('SELECT COUNT(*) c FROM v_parts_compat'),
    v_chk_summary: grp('SELECT rule k, cnt v FROM v_chk_summary', 'k', 'v'),
  };
  counts.node_minus_edge = counts.item - counts.bom_line;
  // 차원 기준단위 합계 (참고값 — expected.leaf_totals_in_base 는 서술형이라 비교하지 않음)
  counts.leaf_totals_in_base = grp(`
    SELECT b.dim k, SUM(q.qty_per_product * b.to_base) v FROM v_bom_line_qpp q JOIN v_uom_base b ON b.uom_code = q.uom_code
     WHERE q.root_pn = ? AND q.is_primary = 1 AND q.child_is_phantom = 0
       AND NOT EXISTS (SELECT 1 FROM v_bom_line_eff e WHERE e.parent_item_id = q.child_item_id)
     GROUP BY b.dim`, 'k', 'v', code);
  const expected = cleansing?.expected || {};
  const mismatches = [];
  const near = (a, b) => typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : a === b;
  for (const [key, exp] of Object.entries(expected)) {
    if (key.startsWith('_') || key === 'leaf_totals_in_base') continue;
    const act = counts[key];
    if (key === 'unassigned_lines') {
      const a = [...(act || [])].sort(), e = [...exp].sort();
      if (a.length !== e.length || a.some((v, i) => v !== e[i])) mismatches.push({ key, expected: exp, actual: act });
    } else if (key === 'v_chk_summary') {
      const e = Object.fromEntries(Object.entries(exp).filter(([k]) => !k.startsWith('_')));
      const a = act || {};
      const keys = new Set([...Object.keys(e), ...Object.keys(a)]);
      if ([...keys].some(k => (e[k] || 0) !== (a[k] || 0))) mismatches.push({ key, expected: e, actual: a });
    } else if (exp && typeof exp === 'object') {
      const a = act || {};
      const keys = new Set([...Object.keys(exp), ...Object.keys(a)]);
      if ([...keys].some(k => !near(exp[k] ?? 0, a[k] ?? 0))) mismatches.push({ key, expected: exp, actual: a });
    } else if (!near(exp, act)) mismatches.push({ key, expected: exp, actual: act });
  }
  return { counts, expected, expectedMatch: mismatches.length === 0, mismatches, check: counts.v_chk_summary };
}

// ────────────────────────────────────────────────────────────────────────────
// 관리자 API (인터페이스 §10)
// ────────────────────────────────────────────────────────────────────────────
const KIND_ALIAS = { PART: 'PT', RAW: 'RM', PKG: 'PK', CONSUMABLE: 'CN' };   // §10 표기 → DDL item_type
const HEADER_STATUS = ['DRAFT', 'APPROVED', 'ACTIVE', 'OBSOLETE'];
const ITEM_STATUS = ['DRAFT', 'APPROVED', 'ACTIVE', 'BLOCKED', 'OBSOLETE'];

export function registerMaterials(app, { requireAdmin, db, queries, settings, afterChange = () => {} } = {}) {
  const q = (sql) => db.prepare(sql);
  const fail = (res, e, status = 400) => res.status(status).json({ error: String(e?.message || e) });
  const tx = (fn) => { db.exec('SAVEPOINT fw_api'); try { const r = fn(); db.exec('RELEASE fw_api'); return r; } catch (e) { db.exec('ROLLBACK TO fw_api'); db.exec('RELEASE fw_api'); throw e; } };
  const asOf = (v) => isDate(v) ? String(v) : today();
  const itemRow = (pn) => q(`
    SELECT i.*, c.class_code, c.name AS class_name, COALESCE(u.symbol, u.uom_code) AS uom_symbol
      FROM item i JOIN mat_class c ON c.class_id = i.class_id JOIN uom u ON u.uom_code = i.base_uom WHERE i.pn = ?`).get(String(pn));
  const itemJson = (r) => r && ({
    itemId: r.item_id, pn: r.pn, name: r.name, nameKo: r.name_ko, spec: r.spec, kind: r.item_type, classId: r.class_id, classCode: r.class_code, className: r.class_name,
    uom: r.base_uom, uomSymbol: r.uom_symbol, status: r.status, traceKind: r.trace_mode, isTmp: /^TMP-/.test(r.pn), isPhantom: !!r.is_phantom, phantom: !!r.is_phantom,
    sourceType: r.source_type, image: r.image, gtin: r.gtin, drawingNo: r.drawing_no, stdCost: r.std_cost, effFrom: r.eff_from, obsoletedAt: r.obsoleted_at, createdAt: r.created_at, updatedAt: r.updated_at,
  });
  const headerJson = (h) => ({
    id: h.bom_id, pn: h.parent_pn, parentPn: h.parent_pn, parentName: h.parent_name, bomType: h.bom_type, altNo: h.alt_no, rev: h.rev, baseQty: h.base_qty, baseUom: h.base_uom,
    status: h.status, effFrom: h.valid_from, effTo: h.valid_to, ecoNo: h.eco_no, approvedBy: h.approved_by, approvedAt: h.approved_at, note: h.note, lineCount: h.line_count,
  });
  const HEADER_SQL = `
    SELECT h.*, p.pn AS parent_pn, p.name AS parent_name, (SELECT COUNT(*) FROM bom_line l WHERE l.bom_id = h.bom_id) AS line_count
      FROM bom_header h JOIN item p ON p.item_id = h.parent_item_id`;
  const lineJson = (l) => ({
    id: l.line_id, lineId: l.line_id, headerId: l.bom_id, lineNo: l.line_no, parentPn: l.parent_pn, parentName: l.parent_name, pn: l.child_pn, name: l.child_name, kind: l.child_type,
    phantom: !!l.child_is_phantom, qtyPer: l.qty_per, uom: l.uom_code, qtyBasis: l.qty_basis, scrapRate: l.scrap_pct, altGroup: l.alt_group, altPriority: l.alt_priority,
    isOptional: !!l.is_optional, bopLink: l.bop_link, effFrom: l.valid_from, effTo: l.valid_to, ecoNo: l.eco_no, note: l.note, headerStatus: l.header_status, baseQty: l.base_qty,
  });
  const LINE_SQL = `
    SELECT l.*, h.status AS header_status, h.base_qty, p.pn AS parent_pn, p.name AS parent_name,
           c.pn AS child_pn, c.name AS child_name, c.item_type AS child_type, c.is_phantom AS child_is_phantom
      FROM bom_line l JOIN bom_header h ON h.bom_id = l.bom_id JOIN item p ON p.item_id = h.parent_item_id JOIN item c ON c.item_id = l.child_item_id`;
  const lotJson = (m) => ({
    id: m.lot_id, lotNo: m.lot_no, pn: m.pn, name: m.item_name, kind: m.lot_kind, parentLotId: m.parent_lot_id, parentLotNo: m.parent_lot_no, qty: m.qty, qtyInit: m.qty_init,
    uom: m.uom_code, status: m.status, statePmId: m.state_pm_id, stateOp: m.state_op, stateText: m.state_text, supplier: m.supplier, supplierLot: m.supplier_lot,
    madeAt: m.made_at, expireAt: m.expire_at, createdAt: m.created_at,
  });
  const LOT_SQL = `
    SELECT m.*, i.pn, i.name AS item_name, pl.lot_no AS parent_lot_no, p.op AS state_op,
           CASE WHEN pm.pm_id IS NULL THEN NULL WHEN pm.is_final = 1 THEN '완성' ELSE pm.out_state END AS state_text
      FROM mat_lot m JOIN item i ON i.item_id = m.item_id
      LEFT JOIN mat_lot pl ON pl.lot_id = m.parent_lot_id
      LEFT JOIN process_material pm ON pm.pm_id = m.state_pm_id LEFT JOIN processes p ON p.id = pm.process_id`;
  const orNull = (v) => (v === undefined || v === '' ? null : v);
  const bool01 = (v, def) => v === undefined ? def : (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
  const B = '/api/admin/materials';

  // ── 요약 (v_chk_summary 그대로) ──
  app.get(`${B}/summary`, requireAdmin, (req, res) => {
    try {
      const c = (sql) => q(sql).get().c;
      const legacy = q(`SELECT type FROM sqlite_master WHERE name = 'parts'`).get()?.type;
      res.json({
        items: c('SELECT COUNT(*) c FROM item'), classes: c('SELECT COUNT(*) c FROM mat_class'),
        bomHeaders: c('SELECT COUNT(*) c FROM bom_header'), bomLines: c('SELECT COUNT(*) c FROM bom_line'), lots: c('SELECT COUNT(*) c FROM mat_lot'),
        processMaterial: { in: c(`SELECT COUNT(*) c FROM process_material WHERE io = 'IN'`), out: c(`SELECT COUNT(*) c FROM process_material WHERE io = 'OUT'`) },
        itemsByKind: Object.fromEntries(q('SELECT item_type k, COUNT(*) v FROM item GROUP BY item_type').all().map(r => [r.k, r.v])),
        phantoms: c('SELECT COUNT(*) c FROM item WHERE is_phantom = 1'), tmpItems: c(`SELECT COUNT(*) c FROM item WHERE pn LIKE 'TMP-%'`),
        check: Object.fromEntries(q('SELECT rule, cnt FROM v_chk_summary').all().map(r => [r.rule, r.cnt])),
        schema: { compatViews: legacy === 'view', legacyTables: legacy === 'table' },
      });
    } catch (e) { fail(res, e, 500); }
  });
  // 점검 상세 (v_chk_* 전부) — 콘솔 무결성 카드용
  app.get(`${B}/check`, requireAdmin, (req, res) => {
    try {
      const views = ['v_chk_r1_cycle', 'v_chk_r2_depth', 'v_chk_r4_orphan', 'v_chk_r5_lost_sa', 'v_chk_r10_split', 'v_chk_bop_unassigned', 'v_chk_r12_phantom_empty', 'v_chk_r22_seq', 'v_chk_trace_serial', 'v_chk_bulk_trace', 'v_chk_lot_qty'];
      const details = {};
      for (const v of views) for (const r of q(`SELECT rule, detail FROM ${v}`).all()) (details[r.rule] ??= []).push(r.detail);
      res.json({ summary: Object.fromEntries(q('SELECT rule, cnt FROM v_chk_summary').all().map(r => [r.rule, r.cnt])), details });
    } catch (e) { fail(res, e, 500); }
  });

  // ── 단위 · 분류 ──
  app.get(`${B}/uom`, requireAdmin, (req, res) => {
    res.json(q('SELECT uom_code, symbol, name_ko, dim, decimals, is_base FROM uom ORDER BY dim, is_base DESC, uom_code').all()
      .map(u => ({ code: u.uom_code, symbol: u.symbol || u.uom_code, name: u.name_ko, kind: u.dim, decimals: u.decimals, isBase: !!u.is_base })));
  });
  app.get(`${B}/classes`, requireAdmin, (req, res) => {
    const rows = q(`
      WITH RECURSIVE t(class_id, level) AS (
        SELECT class_id, 0 FROM mat_class WHERE parent_class_id IS NULL
        UNION ALL SELECT c.class_id, t.level + 1 FROM mat_class c JOIN t ON t.class_id = c.parent_class_id)
      SELECT c.*, t.level, (SELECT COUNT(*) FROM item i WHERE i.class_id = c.class_id) AS item_count
        FROM mat_class c JOIN t ON t.class_id = c.class_id ORDER BY c.sort_no, c.class_id`).all();
    res.json(rows.map(c => ({
      id: c.class_id, code: c.class_code, name: c.name, parentId: c.parent_class_id, level: c.level, itemCount: c.item_count, isLeaf: !!c.is_leaf,
      sortNo: c.sort_no, defTraceMode: c.def_trace_mode, defIssueMethod: c.def_issue_method, shelfLifeDays: c.shelf_life_days, note: c.note,
    })));
  });

  // ── 품목 ──
  app.get(`${B}/items`, requireAdmin, (req, res) => {
    const { q: text, classId, status, kind } = req.query;
    const where = [], p = [];
    if (text) { where.push('(i.pn LIKE ? OR i.name LIKE ? OR i.name_ko LIKE ? OR i.spec LIKE ?)'); const t = `%${String(text).trim()}%`; p.push(t, t, t, t); }
    if (classId) { where.push(`i.class_id IN (WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT c.class_id FROM mat_class c JOIN t ON t.id = c.parent_class_id) SELECT id FROM t)`); p.push(Number(classId)); }
    if (status) { where.push('i.status = ?'); p.push(String(status).toUpperCase()); }
    if (kind) {
      const k = String(kind).toUpperCase();
      if (k === 'PHANTOM') where.push('i.is_phantom = 1');
      else { where.push('i.item_type = ?'); p.push(KIND_ALIAS[k] || k); }
    }
    const rows = q(`
      SELECT i.*, c.class_code, c.name AS class_name, COALESCE(u.symbol, u.uom_code) AS uom_symbol
        FROM item i JOIN mat_class c ON c.class_id = i.class_id JOIN uom u ON u.uom_code = i.base_uom
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.item_type, i.pn`).all(...p);
    res.json(rows.map(itemJson));
  });
  app.get(`${B}/items/:pn`, requireAdmin, (req, res) => {
    const r = itemRow(req.params.pn);
    if (!r) return res.status(404).json({ error: `품목 ${req.params.pn} 이 없습니다.` });
    const whereUsed = q(`${LINE_SQL} WHERE l.child_item_id = ? ORDER BY h.status, l.bom_id, l.line_no`).all(r.item_id)
      .map(l => ({ lineId: l.line_id, parentPn: l.parent_pn, parentName: l.parent_name, qtyPer: l.qty_per, uom: l.uom_code, headerId: l.bom_id, status: l.header_status, bopLink: l.bop_link, effFrom: l.valid_from, effTo: l.valid_to }));
    const headers = q(`${HEADER_SQL} WHERE h.parent_item_id = ? ORDER BY h.bom_id`).all(r.item_id).map(headerJson);
    const lots = q('SELECT COUNT(*) c FROM mat_lot WHERE item_id = ?').get(r.item_id).c;
    const outAt = q(`SELECT p.op, pm.is_final, pm.out_state, pm.qty_out FROM process_material pm JOIN processes p ON p.id = pm.process_id WHERE pm.io = 'OUT' AND pm.item_id = ? ORDER BY p.line, p.seq`).all(r.item_id)
      .map(o => ({ op: o.op, isFinal: !!o.is_final, outState: o.out_state, qtyOut: o.qty_out }));
    const inAt = q(`SELECT DISTINCT p.op FROM process_material pm JOIN processes p ON p.id = pm.process_id JOIN bom_line l ON l.line_id = pm.line_id WHERE pm.io = 'IN' AND l.child_item_id = ? ORDER BY p.line, p.seq`).all(r.item_id).map(o => o.op);
    res.json({ item: itemJson(r), whereUsed, headers, lots, outAt, inAt });
  });
  function itemUpsert(body, existing) {
    const b = body || {};
    const pn = String(b.pn ?? existing?.pn ?? '').trim();
    if (!pn) throw new Error('pn 이 필요합니다.');
    let classId = b.classId !== undefined ? Number(b.classId) : existing?.class_id;
    if (b.classCode) classId = q('SELECT class_id FROM mat_class WHERE class_code = ?').get(String(b.classCode))?.class_id;
    if (!classId) throw new Error('classId(또는 classCode) 가 필요합니다.');
    const kind = String(b.kind ?? b.itemType ?? existing?.item_type ?? 'PT').toUpperCase();
    const itemType = KIND_ALIAS[kind] || kind;
    const sourceType = String(b.sourceType ?? existing?.source_type ?? (['FG', 'SA'].includes(itemType) ? 'MAKE' : 'BUY')).toUpperCase();
    const uom = String(b.uom ?? b.baseUom ?? existing?.base_uom ?? 'EA');
    const status = String(b.status ?? existing?.status ?? 'ACTIVE').toUpperCase();
    if (!ITEM_STATUS.includes(status)) throw new Error(`status 는 ${ITEM_STATUS.join('/')} 중 하나입니다.`);
    const isPhantom = bool01(b.isPhantom ?? b.phantom, existing?.is_phantom ?? 0);
    const trace = String(b.traceKind ?? b.traceMode ?? existing?.trace_mode ?? 'NONE').toUpperCase();
    const vals = {
      name: String(b.name ?? existing?.name ?? pn).trim(), name_ko: orNull(b.nameKo ?? existing?.name_ko), spec: orNull(b.spec ?? existing?.spec),
      class_id: classId, item_type: itemType, source_type: sourceType, base_uom: uom, is_phantom: isPhantom, trace_mode: trace, status,
      gtin: orNull(b.gtin ?? existing?.gtin), drawing_no: orNull(b.drawingNo ?? existing?.drawing_no), std_cost: num(b.stdCost ?? existing?.std_cost),
      image: orNull(b.image ?? existing?.image),
    };
    if (existing) {
      q(`UPDATE item SET pn = ?, name = ?, name_ko = ?, spec = ?, class_id = ?, item_type = ?, source_type = ?, base_uom = ?, is_phantom = ?, trace_mode = ?, status = ?,
                gtin = ?, drawing_no = ?, std_cost = ?, image = ?, obsoleted_at = CASE WHEN ? = 'OBSOLETE' THEN COALESCE(obsoleted_at, datetime('now','localtime')) ELSE NULL END,
                updated_at = datetime('now','localtime') WHERE item_id = ?`)
        .run(pn, vals.name, vals.name_ko, vals.spec, vals.class_id, vals.item_type, vals.source_type, vals.base_uom, vals.is_phantom, vals.trace_mode, vals.status,
          vals.gtin, vals.drawing_no, vals.std_cost, vals.image, vals.status, existing.item_id);
    } else {
      q(`INSERT INTO item (pn, name, name_ko, spec, class_id, item_type, source_type, base_uom, is_phantom, trace_mode, status, gtin, drawing_no, std_cost, image, eff_from)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(pn, vals.name, vals.name_ko, vals.spec, vals.class_id, vals.item_type, vals.source_type, vals.base_uom, vals.is_phantom, vals.trace_mode, vals.status,
          vals.gtin, vals.drawing_no, vals.std_cost, vals.image, isDate(b.effFrom) ? b.effFrom : today());
    }
    return itemRow(pn);
  }
  app.post(`${B}/items`, requireAdmin, (req, res) => {
    try {
      const pn = String(req.body?.pn || '').trim();
      if (!pn) return res.status(400).json({ error: 'pn 이 필요합니다.' });
      const existing = q('SELECT * FROM item WHERE pn = ?').get(pn);
      const item = tx(() => itemUpsert(req.body, existing));
      afterChange();
      res.status(existing ? 200 : 201).json({ ok: true, created: !existing, item: itemJson(item) });
    } catch (e) { fail(res, e); }
  });
  app.put(`${B}/items/:pn`, requireAdmin, (req, res) => {
    try {
      const existing = q('SELECT * FROM item WHERE pn = ?').get(String(req.params.pn));
      if (!existing) return res.status(404).json({ error: `품목 ${req.params.pn} 이 없습니다.` });
      const item = tx(() => itemUpsert(req.body, existing));
      afterChange();
      res.json({ ok: true, item: itemJson(item) });
    } catch (e) { fail(res, e); }
  });
  app.delete(`${B}/items/:pn`, requireAdmin, (req, res) => res.status(405).json({ error: 'R-11: item 은 삭제하지 않는다 — PUT 으로 status=OBSOLETE 로 전환' }));

  // ── BOM 정전개 (Q-1, as-of · 트리 중첩) ──
  const uomBase = () => Object.fromEntries(q('SELECT uom_code, symbol, dim, base_uom, to_base FROM v_uom_base').all().map(u => [u.uom_code, u]));
  const EXPLODE_SQL = `
    WITH RECURSIVE eff AS (
      SELECT h.bom_id, h.parent_item_id, h.base_qty, h.rev, l.line_id, l.line_no, l.child_item_id, l.uom_code, l.bop_link, l.qty_per, l.qty_basis, l.scrap_pct,
             l.alt_group, l.alt_priority, l.is_optional, l.valid_from, l.valid_to, l.note,
             CASE WHEN l.qty_basis = 'GROSS' THEN (1.0 - l.scrap_pct / 100.0) ELSE 1.0 END AS nf,
             CASE WHEN l.qty_basis = 'GROSS' THEN 1.0 ELSE 1.0 / (1.0 - l.scrap_pct / 100.0) END AS gf
        FROM bom_header h JOIN bom_line l ON l.bom_id = h.bom_id
       WHERE h.status IN ('APPROVED','ACTIVE') AND :asof BETWEEN h.valid_from AND h.valid_to
         AND :asof BETWEEN l.valid_from AND l.valid_to
         AND (l.alt_group IS NULL OR l.alt_priority = (SELECT MIN(alt_priority) FROM bom_line l2
               WHERE l2.bom_id = l.bom_id AND l2.alt_group = l.alt_group AND :asof BETWEEN l2.valid_from AND l2.valid_to))),
    ex(item_id, depth, qty, qty_gross, line_id, path) AS (
      SELECT i.item_id, 0, CAST(:qty AS REAL), CAST(:qty AS REAL), NULL, '' FROM item i WHERE i.pn = :root
      UNION ALL
      SELECT e.child_item_id, ex.depth + 1, ex.qty * e.qty_per * e.nf / e.base_qty, ex.qty_gross * e.qty_per * e.gf / e.base_qty, e.line_id, ex.path || '/' || e.line_id
        FROM ex JOIN eff e ON e.parent_item_id = ex.item_id
       WHERE ex.depth < :maxDepth)
    SELECT ex.depth, ex.qty, ex.qty_gross, ex.path,
           c.item_id, c.pn, c.name, c.item_type, c.base_uom, c.is_phantom, c.trace_mode, c.status AS item_status, c.image,
           e.line_id, e.line_no, e.qty_per, e.uom_code, e.qty_basis, e.scrap_pct, e.alt_group, e.alt_priority, e.is_optional, e.bop_link, e.valid_from, e.valid_to, e.note, e.base_qty, e.bom_id, e.rev, e.nf,
           (SELECT group_concat(p.op, ',') FROM process_material pm JOIN processes p ON p.id = pm.process_id WHERE pm.line_id = e.line_id AND pm.io = 'IN' ORDER BY pm.pm_id) AS in_ops,
           (SELECT p.op FROM process_material pm JOIN processes p ON p.id = pm.process_id WHERE pm.item_id = c.item_id AND pm.io = 'OUT' AND pm.is_final = 1 ORDER BY p.seq LIMIT 1) AS out_op,
           (SELECT parent_pn FROM v_parts_compat v WHERE v.pn = c.pn) AS compat_parent
      FROM ex JOIN item c ON c.item_id = ex.item_id LEFT JOIN eff e ON e.line_id = ex.line_id
     WHERE ex.depth > 0`;
  function explode(rootPn, { asof, qty = 1, maxDepth = 64 } = {}) {
    const root = itemRow(rootPn);
    if (!root) return null;
    const rows = q(EXPLODE_SQL).all({ asof, qty, root: root.pn, maxDepth });
    const byPath = new Map();
    const nodes = [];
    for (const r of rows) {
      const inOps = r.in_ops ? r.in_ops.split(',') : [];
      const state = r.bop_link === 'PHANTOM' ? 'phantom' : r.bop_link === 'NONE' ? 'none' : inOps.length ? 'linked' : 'unassigned';
      const node = {
        lineId: r.line_id, headerId: r.bom_id, rev: r.rev, level: r.depth, lineNo: r.line_no, parentPn: null, pn: r.pn, name: r.name, kind: r.item_type, uom: r.uom_code, itemUom: r.base_uom,
        qtyPer: r.qty_per, baseQty: r.base_qty, qtyPerParent: r9(r.qty_per * r.nf / r.base_qty), qtyPerProduct: r9(r.qty), qtyPerProductGross: r9(r.qty_gross),
        scrapRate: r.scrap_pct, qtyBasis: r.qty_basis, phantom: !!r.is_phantom, traceKind: r.trace_mode, itemStatus: r.item_status, image: r.image,
        altGroup: r.alt_group, altPriority: r.alt_priority, isOptional: !!r.is_optional, bopLink: r.bop_link,
        bop: { op: inOps[0] || (state === 'phantom' ? null : r.out_op) || null, mode: inOps.length ? 'IN' : (r.out_op && state !== 'phantom' ? 'OUT' : null), state, inOps, outOp: r.out_op || null },
        effFrom: r.valid_from, effTo: r.valid_to, note: r.note, children: [], _path: r.path,
      };
      byPath.set(r.path, node);
      nodes.push(node);
    }
    const top = [];
    for (const n of nodes) {
      const parentPath = n._path.slice(0, n._path.lastIndexOf('/'));
      const parent = byPath.get(parentPath);
      if (parent) { parent.children.push(n); n.parentPn = parent.pn; } else { top.push(n); n.parentPn = root.pn; }
    }
    const sortRec = (arr) => { arr.sort((a, b) => (a.lineNo ?? 0) - (b.lineNo ?? 0) || a.lineId - b.lineId); for (const c of arr) { sortRec(c.children); delete c._path; } };
    sortRec(top);
    // 말단 합계 (Q-2): 자식이 없고 팬텀이 아닌 노드 — 라인 단위별 · 차원 기준단위 환산
    const ub = uomBase();
    const totals = {}, totalsBase = {};
    for (const n of nodes) {
      if (n.children.length || n.phantom) continue;
      totals[n.uom] = (totals[n.uom] || 0) + n.qtyPerProduct;
      const u = ub[n.uom];
      if (u && u.to_base !== null) { const k = `${u.dim}(${u.base_uom})`; totalsBase[k] = (totalsBase[k] || 0) + n.qtyPerProduct * u.to_base; }
    }
    for (const k of Object.keys(totals)) totals[k] = r9(totals[k]);
    for (const k of Object.keys(totalsBase)) totalsBase[k] = r9(totalsBase[k]);
    return { root: { pn: root.pn, name: root.name, kind: root.item_type, uom: root.base_uom, phantom: !!root.is_phantom, status: root.status }, asOf: asof, qty, nodes: top, count: nodes.length, totals, totalsBase };
  }
  // [노하린 요청 2026-09-13 20:10 (1)] 전개 전 R-1 확인 — Q-1/Q-3 재귀는 순환이 남아 있어도 raise 하지 않고 깊이 가드 64 에서 조용히 잘린다(TC-16).
  // 트리거 뒤로는 순환이 못 들어오지만 레거시 이행·DB 직접 편집 시점엔 들어올 수 있다. v_chk_r1_cycle(경로) 을 먼저 보고
  // 요청 품목·결과 노드가 순환에 걸리면 409 { error:'R-1: …', warnings }, 순환이 다른 곳에만 있으면 정상 응답에 warnings[] 를 붙인다. ?force=1 이면 잘린 결과라도 준다.
  const r1Cycles = () => q('SELECT detail FROM v_chk_r1_cycle').all().map(r => r.detail);
  const flatPns = (nodes, acc = []) => { for (const n of nodes) { acc.push(n.pn); flatPns(n.children || [], acc); } return acc; };
  function cycleGuard(pns, force) {
    const cycles = r1Cycles();
    if (!cycles.length) return null;
    const inCycle = new Set(cycles.flatMap(p => p.split(' > ')));
    const touched = [...new Set(pns.filter(pn => inCycle.has(pn)))];
    const blocked = touched.length > 0 && !force;
    const error = blocked
      ? `R-1: BOM 순환 참조 ${cycles.length}건이 남아 있어 전개 결과를 신뢰할 수 없다 (${touched.join(', ')}) — GET /api/admin/materials/check 의 v_chk_r1_cycle 경로를 끊은 뒤 다시 호출 (force=1 이면 깊이 64 에서 잘린 결과를 준다)`
      : null;
    return { blocked, error, warnings: [{ rule: 'R-1', count: cycles.length, cycles, touched }] };
  }
  app.get(`${B}/bom/:pn`, requireAdmin, (req, res) => {
    try {
      const depth = Math.max(1, Math.min(64, Number(req.query.depth) || 64));
      const qty = Number(req.query.qty) > 0 ? Number(req.query.qty) : 1;
      const r = explode(req.params.pn, { asof: asOf(req.query.asOf), qty, maxDepth: depth });
      if (!r) return res.status(404).json({ error: `품목 ${req.params.pn} 이 없습니다.` });
      const g = cycleGuard([r.root.pn, ...flatPns(r.nodes)], req.query.force === '1');
      if (g?.blocked) return res.status(409).json({ error: g.error, warnings: g.warnings });
      if (g) r.warnings = g.warnings;
      res.json(r);
    } catch (e) { fail(res, e, 500); }
  });

  // ── 역전개 where-used (Q-3) ──
  const WHERE_USED_SQL = `
    WITH RECURSIVE up(item_id, depth, qty, path_ids, path_qty) AS (
      SELECT i.item_id, 0, 1.0, CAST(i.item_id AS TEXT), '1' FROM item i WHERE i.pn = :pn
      UNION ALL
      SELECT p.item_id, up.depth + 1, up.qty * l.qty_per / h.base_qty, up.path_ids || ',' || p.item_id, up.path_qty || ',' || (l.qty_per / h.base_qty)
        FROM up JOIN bom_line l ON l.child_item_id = up.item_id AND :asof BETWEEN l.valid_from AND l.valid_to
        JOIN bom_header h ON h.bom_id = l.bom_id AND h.status IN ('APPROVED','ACTIVE') AND :asof BETWEEN h.valid_from AND h.valid_to
        JOIN item p ON p.item_id = h.parent_item_id
       WHERE up.depth < 64)
    SELECT up.*, i.pn, i.name,
           (SELECT COUNT(*) FROM bom_line l2 JOIN bom_header h2 ON h2.bom_id = l2.bom_id
             WHERE l2.child_item_id = up.item_id AND h2.status IN ('APPROVED','ACTIVE')
               AND :asof BETWEEN h2.valid_from AND h2.valid_to AND :asof BETWEEN l2.valid_from AND l2.valid_to) AS n_parents
      FROM up JOIN item i ON i.item_id = up.item_id WHERE up.depth > 0 ORDER BY up.depth, up.path_ids`;
  app.get(`${B}/where-used/:pn`, requireAdmin, (req, res) => {
    try {
      const item = itemRow(req.params.pn);
      if (!item) return res.status(404).json({ error: `품목 ${req.params.pn} 이 없습니다.` });
      const asof = asOf(req.query.asOf);
      const rows = q(WHERE_USED_SQL).all({ pn: item.pn, asof });
      const nameOf = new Map([[String(item.item_id), { pn: item.pn, name: item.name }]]);
      for (const r of rows) nameOf.set(String(r.item_id), { pn: r.pn, name: r.name });
      const paths = rows.filter(r => r.n_parents === 0).map(r => {
        const ids = r.path_ids.split(','), qs = r.path_qty.split(',');
        let cum = 1;
        return ids.map((id, i) => { const per = Number(qs[i]); cum *= per; return { ...nameOf.get(id), qtyPer: r9(per), qtyCum: r9(cum) }; });
      });
      const parents = rows.filter(r => r.depth === 1).map(r => ({ pn: r.pn, name: r.name, qtyPer: r9(r.qty) }));
      const g = cycleGuard([item.pn, ...paths.flat().map(x => x.pn), ...parents.map(x => x.pn)], req.query.force === '1');   // 순환 안의 품목은 n_parents=0 경로가 없어 paths 가 조용히 비므로 먼저 막는다
      if (g?.blocked) return res.status(409).json({ error: g.error, warnings: g.warnings });
      res.json({ pn: item.pn, name: item.name, asOf: asof, paths, parents, ...(g ? { warnings: g.warnings } : {}) });
    } catch (e) { fail(res, e, 500); }
  });

  // ── BOM 헤더 ──
  app.get(`${B}/bom-headers/:pn`, requireAdmin, (req, res) => {
    const item = itemRow(req.params.pn);
    if (!item) return res.status(404).json({ error: `품목 ${req.params.pn} 이 없습니다.` });
    const headers = q(`${HEADER_SQL} WHERE h.parent_item_id = ? ORDER BY h.bom_id`).all(item.item_id).map(headerJson);
    for (const h of headers) h.lines = q(`${LINE_SQL} WHERE l.bom_id = ? ORDER BY l.line_no, l.line_id`).all(h.id).map(lineJson);
    res.json({ pn: item.pn, name: item.name, headers });
  });
  app.post(`${B}/bom-headers`, requireAdmin, (req, res) => {
    try {
      const b = req.body || {};
      const item = itemRow(b.pn ?? b.parentPn);
      if (!item) return res.status(404).json({ error: `품목 ${b.pn ?? b.parentPn} 이 없습니다.` });
      const status = String(b.status || 'DRAFT').toUpperCase();
      if (!HEADER_STATUS.includes(status)) return res.status(400).json({ error: `status 는 ${HEADER_STATUS.join('→')} 중 하나입니다.` });
      const validFrom = isDate(b.effFrom ?? b.validFrom) ? (b.effFrom ?? b.validFrom) : today();
      const validTo = isDate(b.effTo ?? b.validTo) ? (b.effTo ?? b.validTo) : '9999-12-31';
      const id = tx(() => Number(q(`
        INSERT INTO bom_header (parent_item_id, bom_type, alt_no, rev, base_qty, base_uom, status, valid_from, valid_to, eco_no, approved_by, approved_at, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(item.item_id, String(b.bomType || 'PROD').toUpperCase(), String(b.altNo || '00'), String(b.rev || 'A'), num(b.baseQty) ?? 1, String(b.baseUom || item.base_uom), status,
          validFrom, validTo, orNull(b.ecoNo), status === 'DRAFT' ? null : req.user.id, status === 'DRAFT' ? null : new Date().toISOString().slice(0, 19).replace('T', ' '), orNull(b.note)).lastInsertRowid));
      afterChange();
      res.status(201).json({ ok: true, header: headerJson(q(`${HEADER_SQL} WHERE h.bom_id = ?`).get(id)) });
    } catch (e) { fail(res, e); }
  });
  app.put(`${B}/bom-headers/:id`, requireAdmin, (req, res) => {
    try {
      const cur = q('SELECT * FROM bom_header WHERE bom_id = ?').get(Number(req.params.id));
      if (!cur) return res.status(404).json({ error: 'BOM 헤더가 없습니다.' });
      const b = req.body || {};
      let status = cur.status, approvedBy = cur.approved_by, approvedAt = cur.approved_at;
      if (b.status !== undefined) {
        status = String(b.status).toUpperCase();
        if (!HEADER_STATUS.includes(status)) return res.status(400).json({ error: `status 는 ${HEADER_STATUS.join('→')} 중 하나입니다.` });
        if (HEADER_STATUS.indexOf(status) < HEADER_STATUS.indexOf(cur.status)) return res.status(400).json({ error: `상태는 앞으로만 간다: ${cur.status} → ${status} 불가 (${HEADER_STATUS.join(' → ')})` });
        if (status !== cur.status && status !== 'DRAFT' && !approvedBy) { approvedBy = req.user.id; approvedAt = new Date().toISOString().slice(0, 19).replace('T', ' '); }
      }
      const validFrom = isDate(b.effFrom ?? b.validFrom) ? (b.effFrom ?? b.validFrom) : cur.valid_from;
      const validTo = isDate(b.effTo ?? b.validTo) ? (b.effTo ?? b.validTo) : cur.valid_to;
      tx(() => q(`UPDATE bom_header SET status = ?, valid_from = ?, valid_to = ?, base_qty = ?, note = ?, eco_no = ?, approved_by = ?, approved_at = ? WHERE bom_id = ?`)
        .run(status, validFrom, validTo, num(b.baseQty) ?? cur.base_qty, b.note !== undefined ? orNull(b.note) : cur.note, b.ecoNo !== undefined ? orNull(b.ecoNo) : cur.eco_no, approvedBy, approvedAt, cur.bom_id));
      afterChange();
      res.json({ ok: true, header: headerJson(q(`${HEADER_SQL} WHERE h.bom_id = ?`).get(cur.bom_id)) });
    } catch (e) { fail(res, e); }
  });

  // ── BOM 라인 ──
  const lineById = (id) => q(`${LINE_SQL} WHERE l.line_id = ?`).get(Number(id));
  app.get(`${B}/bom-lines/:id`, requireAdmin, (req, res) => {
    const l = lineById(req.params.id);
    if (!l) return res.status(404).json({ error: 'BOM 라인이 없습니다.' });
    res.json(lineJson(l));
  });
  app.post(`${B}/bom-lines`, requireAdmin, (req, res) => {
    try {
      const b = req.body || {};
      const bomId = Number(b.headerId ?? b.bomId);
      const header = q('SELECT * FROM bom_header WHERE bom_id = ?').get(bomId);
      if (!header) return res.status(404).json({ error: 'BOM 헤더(headerId)가 없습니다.' });
      const child = itemRow(b.pn ?? b.childPn);
      if (!child) return res.status(404).json({ error: `자식 품목 ${b.pn ?? b.childPn} 이 없습니다.` });
      const qtyPer = num(b.qtyPer);
      if (qtyPer === null || qtyPer <= 0) return res.status(400).json({ error: 'qtyPer 는 0 보다 커야 합니다.' });
      const lineNo = num(b.lineNo) ?? ((q('SELECT COALESCE(MAX(line_no), 0) m FROM bom_line WHERE bom_id = ?').get(bomId).m) + 10);
      const id = tx(() => Number(q(`
        INSERT INTO bom_line (bom_id, line_no, child_item_id, qty_per, uom_code, qty_basis, scrap_pct, alt_group, alt_priority, is_optional, bop_link, valid_from, valid_to, eco_no, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(bomId, lineNo, child.item_id, qtyPer, String(b.uom || child.base_uom), String(b.qtyBasis || 'NET').toUpperCase(), num(b.scrapRate ?? b.scrapPct) ?? 0,
          orNull(b.altGroup), num(b.altPriority), bool01(b.isOptional, 0), String(b.bopLink || 'REQUIRED').toUpperCase(),
          isDate(b.effFrom ?? b.validFrom) ? (b.effFrom ?? b.validFrom) : header.valid_from, isDate(b.effTo ?? b.validTo) ? (b.effTo ?? b.validTo) : '9999-12-31',
          orNull(b.ecoNo), orNull(b.note)).lastInsertRowid));
      afterChange();
      res.status(201).json({ ok: true, line: lineJson(lineById(id)) });
    } catch (e) { fail(res, e); }
  });
  app.put(`${B}/bom-lines/:id`, requireAdmin, (req, res) => {
    try {
      const cur = q('SELECT * FROM bom_line WHERE line_id = ?').get(Number(req.params.id));
      if (!cur) return res.status(404).json({ error: 'BOM 라인이 없습니다.' });
      const b = req.body || {};
      let childId = cur.child_item_id;
      if (b.pn !== undefined || b.childPn !== undefined) {
        const child = itemRow(b.pn ?? b.childPn);
        if (!child) return res.status(404).json({ error: `자식 품목 ${b.pn ?? b.childPn} 이 없습니다.` });
        childId = child.item_id;
      }
      const qtyPer = b.qtyPer !== undefined ? num(b.qtyPer) : cur.qty_per;
      if (qtyPer === null || qtyPer <= 0) return res.status(400).json({ error: 'qtyPer 는 0 보다 커야 합니다.' });
      tx(() => q(`UPDATE bom_line SET bom_id = ?, line_no = ?, child_item_id = ?, qty_per = ?, uom_code = ?, qty_basis = ?, scrap_pct = ?, alt_group = ?, alt_priority = ?, is_optional = ?,
                       bop_link = ?, valid_from = ?, valid_to = ?, eco_no = ?, note = ? WHERE line_id = ?`)
        .run(num(b.headerId ?? b.bomId) ?? cur.bom_id, num(b.lineNo) ?? cur.line_no, childId, qtyPer, b.uom !== undefined ? String(b.uom) : cur.uom_code,
          b.qtyBasis !== undefined ? String(b.qtyBasis).toUpperCase() : cur.qty_basis, num(b.scrapRate ?? b.scrapPct) ?? cur.scrap_pct,
          b.altGroup !== undefined ? orNull(b.altGroup) : cur.alt_group, b.altPriority !== undefined ? num(b.altPriority) : cur.alt_priority,
          b.isOptional !== undefined ? bool01(b.isOptional, 0) : cur.is_optional, b.bopLink !== undefined ? String(b.bopLink).toUpperCase() : cur.bop_link,
          isDate(b.effFrom ?? b.validFrom) ? (b.effFrom ?? b.validFrom) : cur.valid_from, isDate(b.effTo ?? b.validTo) ? (b.effTo ?? b.validTo) : cur.valid_to,
          b.ecoNo !== undefined ? orNull(b.ecoNo) : cur.eco_no, b.note !== undefined ? orNull(b.note) : cur.note, cur.line_id));
      afterChange();
      res.json({ ok: true, line: lineJson(lineById(cur.line_id)) });
    } catch (e) { fail(res, e); }
  });
  app.delete(`${B}/bom-lines/:id`, requireAdmin, (req, res) => {
    try {
      const cur = q('SELECT * FROM bom_line WHERE line_id = ?').get(Number(req.params.id));
      if (!cur) return res.status(404).json({ error: 'BOM 라인이 없습니다.' });
      tx(() => q('DELETE FROM bom_line WHERE line_id = ?').run(cur.line_id));   // 승인 BOM 의 라인은 트리거(R-11)가 거부 → 400
      afterChange();
      res.json({ ok: true, deleted: cur.line_id });
    } catch (e) { fail(res, e); }
  });

  // ── 공정별 IN / OUT (bop_link · process_material) ──
  const PROC_IN_SQL = `
    SELECT pm.pm_id, pm.line_id, pm.split_pct, pm.issue_method, pm.note, l.qty_per, l.uom_code, l.bop_link, h.base_qty,
           p.pn AS parent_pn, p.name AS parent_name, c.pn, c.name, c.item_type, c.trace_mode, c.image,
           (SELECT v.qty_per_product FROM v_bom_line_qpp v WHERE v.line_id = pm.line_id AND v.is_primary = 1 LIMIT 1) AS qty_per_product,
           (SELECT COALESCE(u.symbol, u.uom_code) FROM uom u WHERE u.uom_code = l.uom_code) AS uom_symbol
      FROM process_material pm JOIN bom_line l ON l.line_id = pm.line_id JOIN bom_header h ON h.bom_id = l.bom_id
      JOIN item p ON p.item_id = h.parent_item_id JOIN item c ON c.item_id = l.child_item_id
     WHERE pm.io = 'IN' AND pm.process_id = ? ORDER BY pm.pm_id`;
  const PROC_OUT_SQL = `
    SELECT pm.pm_id, pm.item_id, pm.is_final, pm.out_state, pm.qty_out, pm.note, i.pn, i.name, i.base_uom
      FROM process_material pm JOIN item i ON i.item_id = pm.item_id WHERE pm.io = 'OUT' AND pm.process_id = ? ORDER BY pm.pm_id`;
  const UNASSIGNED_SQL = `
    SELECT b.line_id, b.parent_pn, b.child_pn, b.qty_per_product, b.uom_code, b.root_pn, c.name
      FROM v_bom_line_bop b JOIN item c ON c.pn = b.child_pn WHERE b.bop_status = 'UNASSIGNED' ORDER BY b.line_id`;
  function processJson(pr) {
    const inputs = q(PROC_IN_SQL).all(pr.id).map((r, i) => ({
      pmId: r.pm_id, seq: i + 1, lineId: r.line_id, parentPn: r.parent_pn, parentName: r.parent_name, pn: r.pn, name: r.name, kind: r.item_type, traceKind: r.trace_mode, image: r.image,
      qtyPer: r.qty_per, baseQty: r.base_qty, qtyPerProduct: r.qty_per_product === null ? null : r9(r.qty_per_product * r.split_pct / 100), uom: r.uom_code, uomSymbol: r.uom_symbol,
      splitPct: r.split_pct, issueMethod: r.issue_method, note: r.note, mode: 'IN',
    }));
    const outputs = q(PROC_OUT_SQL).all(pr.id).map(r => ({ pmId: r.pm_id, pn: r.pn, name: r.name, uom: r.base_uom, isFinal: !!r.is_final, outState: r.out_state, qtyOut: r.qty_out, note: r.note, mode: 'OUT' }));
    const unassigned = q(UNASSIGNED_SQL).all().filter(r => r.root_pn === pr.product_code)
      .map(r => ({ lineId: r.line_id, parentPn: r.parent_pn, pn: r.child_pn, name: r.name, qtyPerProduct: r9(r.qty_per_product), uom: r.uom_code }));
    return { op: pr.op, process: { id: pr.id, productCode: pr.product_code, op: pr.op, seq: pr.seq, line: pr.line, name: pr.name, kind: pr.kind, output: pr.output, inputText: pr.input_text }, inputs, outputs, unassigned };
  }
  const procByOp = (op) => q('SELECT * FROM processes WHERE op = ? ORDER BY product_code LIMIT 1').get(String(op));
  app.get(`${B}/process/:op`, requireAdmin, (req, res) => {
    const pr = procByOp(req.params.op);
    if (!pr) return res.status(404).json({ error: `공정 ${req.params.op} 이 없습니다.` });
    try { res.json(processJson(pr)); } catch (e) { fail(res, e, 500); }
  });
  app.get(`${B}/process`, requireAdmin, (req, res) => {
    try {
      const rows = q(`
        SELECT p.id, p.product_code, p.op, p.seq, p.line, p.name, p.kind,
               (SELECT COUNT(*) FROM process_material pm WHERE pm.process_id = p.id AND pm.io = 'IN') AS in_count,
               (SELECT COUNT(*) FROM process_material pm WHERE pm.process_id = p.id AND pm.io = 'OUT') AS out_count,
               (SELECT group_concat(i.pn || CASE WHEN pm.is_final = 1 THEN '' ELSE '(' || pm.out_state || ')' END, ', ') FROM process_material pm JOIN item i ON i.item_id = pm.item_id WHERE pm.process_id = p.id AND pm.io = 'OUT') AS outputs
          FROM processes p ORDER BY p.product_code, p.line, p.seq`).all();
      res.json(rows.map(r => ({ id: r.id, productCode: r.product_code, op: r.op, seq: r.seq, line: r.line, name: r.name, kind: r.kind, inCount: r.in_count, outCount: r.out_count, outputs: r.outputs })));
    } catch (e) { fail(res, e, 500); }
  });
  // 공정-자재 연결 편집: links 의 IN 집합이 이 공정의 IN 행 전체를 대체(순서 = seq → pm_id). mode 'OUT' 항목이 하나라도 있으면 OUT 집합도 대체
  app.put(`${B}/process/:op/links`, requireAdmin, (req, res) => {
    const pr = procByOp(req.params.op);
    if (!pr) return res.status(404).json({ error: `공정 ${req.params.op} 이 없습니다.` });
    const links = Array.isArray(req.body?.links) ? req.body.links : null;
    if (!links) return res.status(400).json({ error: 'links 배열이 필요합니다.' });
    try {
      tx(() => {
        const ins = links.filter(l => String(l.mode || 'IN').toUpperCase() === 'IN').map((l, i) => ({ ...l, lineId: Number(l.lineId), _i: num(l.seq) ?? (i + 1) })).sort((a, b) => a._i - b._i);
        for (const l of ins) if (!q('SELECT 1 FROM bom_line WHERE line_id = ?').get(l.lineId)) throw new Error(`lineId ${l.lineId} 가 없습니다.`);
        // [서지안 요청 2026-09-13 21:30 (2) 채택] 항목에 splitPct·issueMethod·note 가 없으면(undefined) 같은 lineId 의 기존 값을 유지한다
        // — seq 만 보내는 스크립트가 SP-4040 PICK 을 BACKFLUSH 로 덮지 않게. 새 lineId 는 기본값 100 / BACKFLUSH / null. note:'' 는 비우기.
        const cur = q(`SELECT pm_id, line_id, split_pct, issue_method, note FROM process_material WHERE process_id = ? AND io = 'IN' ORDER BY pm_id`).all(pr.id);
        const prev = new Map(cur.map(c => [c.line_id, c]));
        const inVals = (l) => {
          const p = prev.get(l.lineId);
          return [num(l.splitPct) ?? p?.split_pct ?? 100,
                  l.issueMethod ? String(l.issueMethod).toUpperCase() : (p?.issue_method || 'BACKFLUSH'),
                  l.note === undefined ? (p?.note ?? null) : orNull(l.note)];
        };
        const sameOrder = cur.length === ins.length && cur.every((c, i) => c.line_id === ins[i].lineId);
        if (sameOrder) {
          for (let i = 0; i < ins.length; i++) q('UPDATE process_material SET split_pct = ?, issue_method = ?, note = ? WHERE pm_id = ?').run(...inVals(ins[i]), cur[i].pm_id);
        } else {
          q(`DELETE FROM process_material WHERE process_id = ? AND io = 'IN'`).run(pr.id);
          for (const l of ins) q(`INSERT INTO process_material (process_id, io, line_id, split_pct, issue_method, note) VALUES (?, 'IN', ?, ?, ?, ?)`).run(pr.id, l.lineId, ...inVals(l));
        }
        const outs = links.filter(l => String(l.mode || '').toUpperCase() === 'OUT');
        if (outs.length) {
          const keep = new Set();
          for (const o of outs) {
            const item = itemRow(o.pn);
            if (!item) throw new Error(`OUT 품목 ${o.pn} 이 없습니다.`);
            const ex = q(`SELECT pm_id, is_final, out_state, qty_out, note FROM process_material WHERE process_id = ? AND item_id = ? AND io = 'OUT'`).get(pr.id, item.item_id);
            const isFinal = bool01(o.isFinal, ex ? ex.is_final : 1);   // OUT 도 같은 규칙: 없는 필드는 기존 값 유지
            const outState = isFinal ? null : (o.outState === undefined ? (ex?.out_state ?? null) : orNull(o.outState));
            const qtyOut = o.qtyOut === undefined ? (ex?.qty_out ?? null) : num(o.qtyOut);
            const note = o.note === undefined ? (ex?.note ?? null) : orNull(o.note);
            if (ex) { q('UPDATE process_material SET is_final = ?, out_state = ?, qty_out = ?, note = ? WHERE pm_id = ?').run(isFinal, outState, qtyOut, note, ex.pm_id); keep.add(ex.pm_id); }
            else keep.add(Number(q(`INSERT INTO process_material (process_id, io, item_id, is_final, out_state, qty_out, note) VALUES (?, 'OUT', ?, ?, ?, ?, ?)`).run(pr.id, item.item_id, isFinal, outState, qtyOut, note).lastInsertRowid));
          }
          for (const r of q(`SELECT pm_id FROM process_material WHERE process_id = ? AND io = 'OUT'`).all(pr.id)) if (!keep.has(r.pm_id)) q('DELETE FROM process_material WHERE pm_id = ?').run(r.pm_id);
        }
      });
      afterChange();
      res.json({ ok: true, ...processJson(pr) });
    } catch (e) { fail(res, e); }
  });

  // ── 로트 · 계보 ──
  app.get(`${B}/lots`, requireAdmin, (req, res) => {
    const where = [], p = [];
    if (req.query.pn) { where.push('i.pn = ?'); p.push(String(req.query.pn)); }
    if (req.query.q) { where.push('(m.lot_no LIKE ? OR m.supplier_lot LIKE ? OR i.pn LIKE ?)'); const t = `%${String(req.query.q).trim()}%`; p.push(t, t, t); }
    if (req.query.status) { where.push('m.status = ?'); p.push(String(req.query.status).toUpperCase()); }
    const rows = q(`${LOT_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.lot_id DESC LIMIT 500`).all(...p);
    res.json(rows.map(lotJson));
  });
  const lotById = (id) => q(`${LOT_SQL} WHERE m.lot_id = ?`).get(Number(id));
  app.get(`${B}/lots/:id`, requireAdmin, (req, res) => {
    const m = lotById(req.params.id);
    if (!m) return res.status(404).json({ error: '로트가 없습니다.' });
    res.json(lotJson(m));
  });
  app.post(`${B}/lots`, requireAdmin, (req, res) => {
    try {
      const b = req.body || {};
      const lotNo = String(b.lotNo || '').trim();
      if (!lotNo) return res.status(400).json({ error: 'lotNo 가 필요합니다.' });
      const parent = b.parentLotId ? q('SELECT * FROM mat_lot WHERE lot_id = ?').get(Number(b.parentLotId)) : (b.parentLotNo ? q('SELECT * FROM mat_lot WHERE lot_no = ?').get(String(b.parentLotNo)) : null);
      if ((b.parentLotId || b.parentLotNo) && !parent) return res.status(404).json({ error: '부모 로트가 없습니다.' });
      const item = b.pn ? itemRow(b.pn) : (parent ? q('SELECT i.* FROM item i WHERE i.item_id = ?').get(parent.item_id) : null);
      if (!item) return res.status(404).json({ error: `품목 ${b.pn ?? ''} 이 없습니다.` });
      if (parent && parent.item_id !== item.item_id) return res.status(400).json({ error: '분할(서브로트)은 부모 로트와 같은 품목이어야 합니다.' });
      const qty = num(b.qty);
      if (qty === null || qty < 0) return res.status(400).json({ error: 'qty 가 필요합니다 (0 이상).' });
      const kind = String(b.kind || (parent ? 'SUBLOT' : 'LOT')).toUpperCase();
      let statePmId = num(b.statePmId);
      if (b.stateOp) {
        const pm = q(`SELECT pm.pm_id FROM process_material pm JOIN processes p ON p.id = pm.process_id WHERE pm.io = 'OUT' AND pm.item_id = ? AND p.op = ?`).get(item.item_id, String(b.stateOp));
        if (!pm) return res.status(400).json({ error: `공정 ${b.stateOp} 에 ${item.pn} 의 산출(OUT) 행이 없습니다.` });
        statePmId = pm.pm_id;
      }
      const id = tx(() => {
        if (parent) {
          if (parent.qty < qty) throw new Error(`D-17: 부모 로트 잔량(${parent.qty})보다 큰 수량은 분할할 수 없습니다.`);
          q('UPDATE mat_lot SET qty = qty - ? WHERE lot_id = ?').run(qty, parent.lot_id);   // D-17: 수량 변동은 qty 와 계보로 (서비스 계층)
        }
        return Number(q(`
          INSERT INTO mat_lot (lot_no, item_id, lot_kind, parent_lot_id, qty, uom_code, status, state_pm_id, supplier, supplier_lot, made_at, expire_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(lotNo, item.item_id, kind, parent?.lot_id ?? null, qty, String(b.uom || item.base_uom), String(b.status || 'AVAILABLE').toUpperCase(), statePmId,
            orNull(b.supplier), orNull(b.supplierLot), orNull(b.madeAt), orNull(b.expireAt)).lastInsertRowid);
      });
      res.status(201).json({ ok: true, lot: lotJson(lotById(id)) });
    } catch (e) { fail(res, e); }
  });
  app.put(`${B}/lots/:id`, requireAdmin, (req, res) => {
    try {
      const cur = q('SELECT * FROM mat_lot WHERE lot_id = ?').get(Number(req.params.id));
      if (!cur) return res.status(404).json({ error: '로트가 없습니다.' });
      const b = req.body || {};
      tx(() => q('UPDATE mat_lot SET status = ?, state_pm_id = ?, supplier = ?, supplier_lot = ?, made_at = ?, expire_at = ? WHERE lot_id = ?')
        .run(b.status !== undefined ? String(b.status).toUpperCase() : cur.status, b.statePmId !== undefined ? num(b.statePmId) : cur.state_pm_id,
          b.supplier !== undefined ? orNull(b.supplier) : cur.supplier, b.supplierLot !== undefined ? orNull(b.supplierLot) : cur.supplier_lot,
          b.madeAt !== undefined ? orNull(b.madeAt) : cur.made_at, b.expireAt !== undefined ? orNull(b.expireAt) : cur.expire_at, cur.lot_id));
      res.json({ ok: true, lot: lotJson(lotById(cur.lot_id)) });
    } catch (e) { fail(res, e); }
  });
  // 투입 계보: 이 로트(:id, 산출) 에 in 로트가 qty 만큼 들어갔다 — lot_genealogy 1행 + 투입 로트 qty 차감 (D-17)
  app.post(`${B}/lots/:id/consume`, requireAdmin, (req, res) => {
    try {
      const out = q('SELECT * FROM mat_lot WHERE lot_id = ?').get(Number(req.params.id));
      if (!out) return res.status(404).json({ error: '산출 로트가 없습니다.' });
      const b = req.body || {};
      const inLot = b.inLotId ? q('SELECT * FROM mat_lot WHERE lot_id = ?').get(Number(b.inLotId)) : q('SELECT * FROM mat_lot WHERE lot_no = ?').get(String(b.inLotNo || ''));
      if (!inLot) return res.status(404).json({ error: '투입 로트(inLotId|inLotNo)가 없습니다.' });
      const qty = num(b.qty);
      if (qty === null || qty <= 0) return res.status(400).json({ error: 'qty 는 0 보다 커야 합니다.' });
      const pr = b.op ? procByOp(b.op) : null;
      if (b.op && !pr) return res.status(404).json({ error: `공정 ${b.op} 이 없습니다.` });
      const id = tx(() => {
        if (!b.force && inLot.qty < qty) throw new Error(`D-17: 투입 로트 잔량(${inLot.qty})보다 큰 수량은 투입할 수 없습니다 (force 로 무시 가능).`);
        const r = q(`INSERT INTO lot_genealogy (out_lot_id, in_lot_id, process_id, equipment_id, user_id, record_id, qty_consumed, uom_code)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(out.lot_id, inLot.lot_id, pr?.id ?? null, num(b.equipmentId), num(b.userId) ?? req.user.id, num(b.recordId), qty, String(b.uom || inLot.uom_code));
        q(`UPDATE mat_lot SET qty = MAX(0, qty - ?), status = CASE WHEN qty - ? <= 0 AND status = 'AVAILABLE' THEN 'CONSUMED' ELSE status END WHERE lot_id = ?`).run(qty, qty, inLot.lot_id);
        return Number(r.lastInsertRowid);
      });
      res.status(201).json({ ok: true, genId: id, outLot: lotJson(lotById(out.lot_id)), inLot: lotJson(lotById(inLot.lot_id)) });
    } catch (e) { fail(res, e); }
  });
  const GENEALOGY_SQL = (dir) => `
    WITH RECURSIVE lot_edge(parent, child, kind, process_id, equipment_id, user_id, qty, uom, created_at, gen_id) AS (
      SELECT parent_lot_id, lot_id, 'SPLIT', NULL, NULL, NULL, qty_init, uom_code, created_at, NULL FROM mat_lot WHERE parent_lot_id IS NOT NULL
      UNION ALL
      SELECT in_lot_id, out_lot_id, 'CONSUME', process_id, equipment_id, user_id, qty_consumed, uom_code, created_at, gen_id FROM lot_genealogy),
    walk(lot_id, depth, via, kind, process_id, equipment_id, user_id, qty, uom, edge_at, gen_id, path) AS (
      SELECT lot_id, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '/' || lot_id FROM mat_lot WHERE lot_id = :lot
      UNION
      SELECT ${dir === 'back' ? 'e.parent' : 'e.child'}, w.depth + 1, w.lot_id, e.kind, e.process_id, e.equipment_id, e.user_id, e.qty, e.uom, e.created_at, e.gen_id,
             w.path || '/' || ${dir === 'back' ? 'e.parent' : 'e.child'}
        FROM walk w JOIN lot_edge e ON ${dir === 'back' ? 'e.child' : 'e.parent'} = w.lot_id WHERE w.depth < 64)
    SELECT w.*, m.lot_no, m.lot_kind, m.qty AS lot_qty, m.qty_init, m.uom_code, m.status, m.supplier, m.supplier_lot, m.state_pm_id, i.pn, i.name,
           p.op, eq.code AS equipment_code, eq.name AS equipment_name, u.name AS user_name,
           sp.op AS state_op, CASE WHEN spm.pm_id IS NULL THEN NULL WHEN spm.is_final = 1 THEN '완성' ELSE spm.out_state END AS state_text
      FROM walk w JOIN mat_lot m ON m.lot_id = w.lot_id JOIN item i ON i.item_id = m.item_id
      LEFT JOIN processes p ON p.id = w.process_id LEFT JOIN equipments eq ON eq.id = w.equipment_id LEFT JOIN users u ON u.id = w.user_id
      LEFT JOIN process_material spm ON spm.pm_id = m.state_pm_id LEFT JOIN processes sp ON sp.id = spm.process_id
     ORDER BY w.depth, w.path`;
  app.get(`${B}/lots/:id/genealogy`, requireAdmin, (req, res) => {
    try {
      const m = lotById(req.params.id);
      if (!m) return res.status(404).json({ error: '로트가 없습니다.' });
      const dir = String(req.query.dir || 'back').toLowerCase() === 'fwd' ? 'fwd' : 'back';
      const rows = q(GENEALOGY_SQL(dir)).all({ lot: m.lot_id });
      const byPath = new Map();
      let root = null;
      for (const r of rows) {
        const node = {
          lotId: r.lot_id, lotNo: r.lot_no, pn: r.pn, name: r.name, kind: r.lot_kind, qty: r.lot_qty, qtyInit: r.qty_init, uom: r.uom_code, status: r.status,
          supplier: r.supplier, supplierLot: r.supplier_lot, stateOp: r.state_op, stateText: r.state_text, depth: r.depth,
          edge: r.kind ? { kind: r.kind, qty: r.qty, uom: r.uom, op: r.op, equipment: r.equipment_code ? { code: r.equipment_code, name: r.equipment_name } : null, user: r.user_name, at: r.edge_at, genId: r.gen_id } : null,
          children: [],
        };
        byPath.set(r.path, node);
        const parentPath = r.path.slice(0, r.path.lastIndexOf('/'));
        const parent = byPath.get(parentPath);
        if (parent) parent.children.push(node); else if (r.depth === 0) root = node;
      }
      res.json({ lot: lotJson(m), dir, tree: root ? root.children : [], nodes: rows.length - 1 });
    } catch (e) { fail(res, e, 500); }
  });

  // ── 샘플 적재 (cleansing-v1.json, 멱등 UPSERT) ──
  app.post(`${B}/import-sample`, requireAdmin, (req, res) => {
    const { cleansing, source, files } = readMaterialFiles();
    if (!cleansing || !source) return res.status(404).json({ error: `원천 파일이 없습니다: ${[!cleansing && files.cleansing, !source && files.source].filter(Boolean).join(', ')}` });
    try {
      const r = loadMaterials(db, { source, cleansing, strict: !!req.body?.strict });
      afterChange();
      res.json({ ok: true, product: r.product, counts: r.counts, check: r.check, expectedMatch: r.expectedMatch, mismatches: r.mismatches, tmp: r.tmp, warnings: r.warnings });
    } catch (e) { res.status(400).json({ error: String(e.message || e), mismatches: e.mismatches || [], counts: e.counts || null }); }
  });
}
