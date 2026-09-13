# -*- coding: utf-8 -*-
"""
v1_load.py — cleansing-v1.json 의 loader_algorithm 7단계를 그대로 구현한 **참조 적재기**(검증용).
  · 수량·이름·규격은 원천 bldc-500w-48v.json, 속성·정제 규칙은 cleansing-v1.json 에서만 읽는다.
  · 멱등: 같은 DB 에 다시 돌리면 UPSERT (item=pn · header=(parent,type,alt,rev) · line=(bom,child,alt_group,valid_from) · pm=(process,line|item,io)).
  · 선행 테이블(products/processes 24 + 현행 parts/process_inputs 36 = server/index.js importBop 과 같은 규칙) 도 같이 넣는다 → 호환 뷰 전후 대조(TC-57).
실행: python v1_load.py [--db out/bldc_v1.db] [--approved] [--rerun] [--compat]
  --approved : pn_pending 을 전부 승인된 것으로 (정식 P/N)
  --rerun    : 기존 DB 를 지우지 않고 다시 적재 (TC-53 진짜 멱등)
  --compat   : 적재 후 이행 [3] 뷰 전환 (DDL 절 H 블록 그대로)
산출: out/bldc_v1.db · out/05_load.log · out/csv/cleansing_map_v1.csv
"""
from __future__ import annotations
import argparse, csv, json, os, sqlite3, sys
import common as C
import bomsql_v1 as B

PARTS_DIR = os.path.join(C.ROOT, "public", "assets", "parts")


def image_for(*pns):
    for pn in pns:
        if pn and "/" not in pn and os.path.exists(os.path.join(PARTS_DIR, f"{pn}.png")):
            return f"{pn}.png"
    return None


class Loader:
    def __init__(self, con, cj, js, approved=False, log=print):
        self.con, self.cj, self.js, self.log = con, cj, js, log
        self.approved = approved
        self.rules = []          # 정제 이력 (pn, rule, action, source)
        self.rejects = []
        self.pn_actual = {}      # 정식 pn → 실제 저장 pn (TMP-)
        for pn, p in cj["pn_pending"].items():
            if not isinstance(p, dict): continue          # "_note"
            self.pn_actual[pn] = pn if (approved or p.get("approved")) else p["tmp"]

    # ── 0. 선행: products/processes + 현행 parts/process_inputs (importBop 규칙) ──
    def load_legacy(self):
        js, c = self.js, self.con
        prod = js["product"]
        c.execute("INSERT INTO products(code,name,spec_json) VALUES (?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name",
                  (prod["code"], prod["name"], json.dumps({"exploded": js.get("exploded", [])}, ensure_ascii=False)))
        for p in js["processes"]:
            c.execute("INSERT INTO processes(product_code,op,seq,line,name,equipment_hint,input_text,output,ct_sec,kind,qc,note,stage_pn)"
                      " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(product_code,op) DO UPDATE SET seq=excluded.seq,line=excluded.line,"
                      " name=excluded.name,output=excluded.output,stage_pn=excluded.stage_pn",
                      (prod["code"], p["op"], p.get("seq"), p.get("line"), p.get("name"), p.get("equipment"), p.get("inputText"),
                       p.get("output"), p.get("ctSec"), p.get("kind"), p.get("qc"), p.get("note"), p.get("stagePn")))
        kind = c.execute("SELECT type FROM sqlite_master WHERE name='process_inputs'").fetchone()
        if kind and kind[0] == "view":
            self.log("  (현행 parts/process_inputs 는 이미 뷰 — legacy 적재 생략)"); return
        rows, qty_of = {}, {}
        for p in js["parts"]:
            rows[p["pn"]] = (p["pn"], p.get("name"), p.get("spec"), p.get("level", "L2"), p.get("parentPn"), p.get("parentName"),
                             p.get("qtyPerParent"), p.get("qtyPerProduct"), p.get("unit", "EA"), image_for(p["pn"], p.get("parentPn")))
            qty_of[p["pn"]] = p.get("qtyPerProduct")
        for s in js["subassemblies"]:
            prev = rows.get(s["pn"])
            rows[s["pn"]] = (s["pn"], s.get("name") or (prev and prev[1]), (prev and prev[2]) or s.get("note"), "L1", prod["code"], prod["name"],
                             s.get("qty"), s.get("qty"), s.get("unit") or (prev and prev[8]) or "EA", image_for(s["pn"]))
            qty_of[s["pn"]] = s.get("qty")
        for r in rows.values():
            c.execute("INSERT OR REPLACE INTO parts(pn,name,spec,level,parent_pn,parent_name,qty_per_parent,qty_per_product,unit,image)"
                      " VALUES (?,?,?,?,?,?,?,?,?,?)", r)
        pid = {r[1]: r[0] for r in c.execute("SELECT id,op FROM processes")}
        for p in js["processes"]:
            c.execute("DELETE FROM process_inputs WHERE process_id=?", (pid[p["op"]],))
            for pn in p.get("inputs", []):
                c.execute("INSERT OR REPLACE INTO process_inputs(process_id,pn,qty) VALUES (?,?,?)", (pid[p["op"]], pn, qty_of.get(pn)))

    # ── 1. uom · uom_conv · mat_class ────────────────────────────────────
    def load_master(self):
        c, cj = self.con, self.cj
        C.seed_uom(c)
        ids = {}
        for m in cj["mat_class"]:
            c.execute("INSERT INTO mat_class(class_code,name,parent_class_id,is_leaf,def_trace_mode,def_issue_method,shelf_life_days,sort_no)"
                      " VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(class_code) DO UPDATE SET name=excluded.name,parent_class_id=excluded.parent_class_id,"
                      " is_leaf=excluded.is_leaf,def_trace_mode=excluded.def_trace_mode,def_issue_method=excluded.def_issue_method,"
                      " shelf_life_days=excluded.shelf_life_days,sort_no=excluded.sort_no",
                      (m["code"], m["name"], ids.get(m["parent"]) if m["parent"] else None, m["leaf"],
                       m.get("def_trace_mode"), m.get("def_issue_method"), m.get("shelf_life_days"), m["sort"]))
            ids[m["code"]] = c.execute("SELECT class_id FROM mat_class WHERE class_code=?", (m["code"],)).fetchone()[0]
        self.class_id = ids

    # ── 2. item 60 ───────────────────────────────────────────────────────
    def build_items(self):
        js, cj = self.js, self.cj
        items = {}   # 정식 pn → dict(name, name_ko, spec)
        prod = js["product"]
        items[prod["code"]] = dict(name=prod["name"], spec=None)
        for s in js["subassemblies"]:
            items.setdefault(s["pn"], dict(name=s["name"], spec=s.get("note")))
        for p in js["parts"]:
            if p["parentPn"] == p["pn"]:
                continue        # 자기참조 행 2건 제외 (P-2) — FS-7020 자식은 new_items 의 FS-7023
            items.setdefault(p["pn"], dict(name=p["name"], spec=p.get("spec")))
        for n in cj["new_items"]:
            items[n["pn"]] = dict(name=n["name"], name_ko=n.get("name_ko"), spec=n.get("spec"))
            self.rules.append((n["pn"], "P-8/P-9", f"신규 품목 ({self.pn_actual.get(n['pn'], n['pn'])})", n["source"]))
        return items

    def load_items(self, items):
        c, cj = self.con, self.cj
        attrs = cj["items"]
        n = 0
        for pn, it in items.items():
            a = attrs.get(pn)
            if not a:
                self.rejects.append(("item", pn, "cleansing items 표에 속성 없음")); continue
            cls, itype, src, uom, ph, trace = a
            actual = self.pn_actual.get(pn, pn)
            pend = cj["pn_pending"].get(pn)
            tmp = pend.get("tmp") if isinstance(pend, dict) else None
            row = c.execute("SELECT item_id, pn FROM item WHERE pn IN (?,?)", (actual, tmp or actual)).fetchone()
            parent_pn = None
            for p in self.js["parts"]:
                if p["pn"] == pn: parent_pn = p["parentPn"]; break
            img = image_for(pn, parent_pn if parent_pn and "/" not in parent_pn else None)
            vals = (actual, it["name"], it.get("name_ko"), it.get("spec"), self.class_id[cls], itype, src, uom, ph, trace,
                    cj["defaults"]["item_status"], img)
            try:
                if row:
                    c.execute("UPDATE item SET pn=?,name=?,name_ko=?,spec=?,class_id=?,item_type=?,source_type=?,base_uom=?,is_phantom=?,"
                              "trace_mode=?,status=?,image=?,updated_at=datetime('now','localtime') WHERE item_id=?", vals + (row[0],))
                else:
                    c.execute("INSERT INTO item(pn,name,name_ko,spec,class_id,item_type,source_type,base_uom,is_phantom,trace_mode,status,image)"
                              " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", vals)
                n += 1
            except Exception as e:
                self.rejects.append(("item", pn, f"{type(e).__name__}: {e}"))
        self.iid = {r[1]: r[0] for r in c.execute("SELECT item_id, pn FROM item")}
        return n

    def ID(self, pn):   # 정식 pn 으로 item_id
        return self.iid[self.pn_actual.get(pn, pn)]

    # ── 3. 간선 59 ───────────────────────────────────────────────────────
    def build_edges(self):
        js, cj = self.js, self.cj
        um = cj["unit_map"]
        edges = []   # (parent, child, qty, uom, line_no, note, qty_basis)
        no = {}
        def nxt(p): no[p] = no.get(p, 0) + 10; return no[p]
        fg = cj["defaults"]["fg_pn"]
        for s in js["subassemblies"]:
            edges.append((fg, s["pn"], float(s["qty"]), um[s.get("unit", "EA")], nxt(fg), None, "NET"))
            if s.get("unit") == "SET":
                self.rules.append((s["pn"], "P-4", "SET → EA (팬텀, SET 미등록)", "unit_map"))
        ps = cj["parent_split"]; sr = {r["pn"]: r for r in cj["self_reference"]}; rp = {r["pn"]: r for r in cj["reparent"]}
        for p in js["parts"]:
            parent, child = p["parentPn"], p["pn"]
            if parent == ps["from"]:
                new = next((k for k, v in ps["to"].items() if isinstance(v, list) and child in v), None) or \
                      next(k for k, v in ps["to"].items() if v == "REST")
                self.rules.append((child, "P-1", f"부모 {parent} → {new}", ps["evidence"][:40])); parent = new
            if parent == child:
                r = sr[child]
                if r["action"] == "DEMOTE":
                    self.rules.append((child, "P-2", "자기참조 행 삭제 (완성품 직하 단품)", r["evidence"][:40])); continue
                if r["action"] == "RENUMBER_CHILD":
                    self.rules.append((child, "P-2", f"자식 개번 → {r['child_new_pn']}", r["evidence"][:40])); child = r["child_new_pn"]
            if child in rp:
                r = rp[child]
                tgt = r["to"] if self.pn_actual.get(r["to"], r["to"]) in self.iid else r["fallback_to"]
                self.rules.append((child, "P-3", f"부모 {parent} → {tgt}", "P-3a/b")); parent = tgt
            edges.append((parent, child, float(p["qtyPerParent"]), um[p.get("unit", "EA")], nxt(parent), None, "NET"))
        for x in cj["extra_lines"]:
            edges.append((x["parent"], x["child"], float(x["qty"]), um.get(x["uom"], x["uom"]), x.get("line_no") or nxt(x["parent"]), x["source"], "NET"))
            self.rules.append((x["child"], "P-9", f"{x['parent']} → {x['child']} {x['qty']} {x['uom']} 라인 신설", x["source"]))
        la = {(a["parent"], a["child"]): a for a in cj["line_attrs"]}
        edges = [(pa, ch, q, u, ln, (la.get((pa, ch), {}).get("note") or nt), la.get((pa, ch), {}).get("qty_basis", basis))
                 for pa, ch, q, u, ln, nt, basis in edges]
        return edges

    def load_bom(self, edges):
        c, cj = self.con, self.cj
        d = cj["defaults"]
        hdr = {h["parent"]: h for h in cj["bom_headers"]}
        parents = []
        for e in edges:
            if e[0] not in parents: parents.append(e[0])
        self.bom_id = {}
        for pn in parents:
            h = hdr.get(pn, {"base_qty": 1, "base_uom": "EA"})
            key = (self.ID(pn), d["bom_type"], d["alt_no"], d["rev"])
            row = c.execute("SELECT bom_id FROM bom_header WHERE parent_item_id=? AND bom_type=? AND alt_no=? AND rev=?", key).fetchone()
            try:
                if row:
                    c.execute("UPDATE bom_header SET base_qty=?,base_uom=?,note=? WHERE bom_id=?", (h["base_qty"], h["base_uom"], h.get("note"), row[0]))
                    self.bom_id[pn] = row[0]
                else:
                    cur = c.execute("INSERT INTO bom_header(parent_item_id,bom_type,alt_no,rev,base_qty,base_uom,status,valid_from,note)"
                                    " VALUES (?,?,?,?,?,?,?,?,?)", key + (h["base_qty"], h["base_uom"], d["bom_status"], d["valid_from"], h.get("note")))
                    self.bom_id[pn] = cur.lastrowid
            except Exception as e:
                self.rejects.append(("bom_header", pn, f"{type(e).__name__}: {e}"))
        self.line_id = {}
        for parent, child, qty, uom, ln, note, basis in edges:
            bid, cid = self.bom_id[parent], self.ID(child)
            row = c.execute("SELECT line_id FROM bom_line WHERE bom_id=? AND child_item_id=? AND alt_group IS NULL AND valid_from=?",
                            (bid, cid, d["valid_from"])).fetchone()
            try:
                if row:
                    c.execute("UPDATE bom_line SET line_no=?,qty_per=?,uom_code=?,qty_basis=?,scrap_pct=?,note=? WHERE line_id=?",
                              (ln, qty, uom, basis, d["scrap_pct"], note, row[0]))
                    self.line_id[(parent, child)] = row[0]
                else:
                    cur = c.execute("INSERT INTO bom_line(bom_id,line_no,child_item_id,qty_per,uom_code,qty_basis,scrap_pct,valid_from,note)"
                                    " VALUES (?,?,?,?,?,?,?,?,?)", (bid, ln, cid, qty, uom, basis, d["scrap_pct"], d["valid_from"], note))
                    self.line_id[(parent, child)] = cur.lastrowid
            except Exception as e:
                self.rejects.append(("bom_line", f"{parent}>{child}", f"{type(e).__name__}: {e}"))

    # ── 5. process_material OUT 24 → IN 46 ──────────────────────────────
    def load_pm(self):
        c, cj = self.con, self.cj
        pid = {r[1]: r[0] for r in c.execute("SELECT id,op FROM processes")}
        n_out = n_in = 0
        for op, pn, is_final, state, qty_out in cj["process_out"]["rows"]:
            row = c.execute("SELECT pm_id FROM process_material WHERE process_id=? AND item_id=? AND io='OUT'", (pid[op], self.ID(pn))).fetchone()
            try:
                if row:
                    c.execute("UPDATE process_material SET is_final=?,out_state=?,qty_out=? WHERE pm_id=?", (is_final, state, qty_out, row[0]))
                else:
                    c.execute("INSERT INTO process_material(process_id,io,item_id,is_final,out_state,qty_out) VALUES (?,'OUT',?,?,?,?)",
                              (pid[op], self.ID(pn), is_final, state, qty_out))
                n_out += 1
            except Exception as e:
                self.rejects.append(("pm OUT", f"{op} {pn}", f"{type(e).__name__}: {e}"))
        self.unassigned = []
        for parent, child, op, conf, method, reason in cj["line_process"]["rows"]:
            lid = self.line_id.get((parent, child))
            if lid is None:
                self.rejects.append(("pm IN", f"{parent}>{child}", "라인 없음")); continue
            if op is None:
                if conf != "PHANTOM": self.unassigned.append(f"{parent}>{child}")
                continue
            row = c.execute("SELECT pm_id FROM process_material WHERE process_id=? AND line_id=? AND io='IN'", (pid[op], lid)).fetchone()
            try:
                if row:
                    c.execute("UPDATE process_material SET issue_method=?,note=? WHERE pm_id=?", (method, reason, row[0]))
                else:
                    c.execute("INSERT INTO process_material(process_id,io,line_id,issue_method,note) VALUES (?,'IN',?,?,?)", (pid[op], lid, method, reason))
                n_in += 1
            except Exception as e:
                self.rejects.append(("pm IN", f"{parent}>{child}@{op}", f"{type(e).__name__}: {e}"))
        return n_out, n_in

    def run(self):
        self.log("  [0] 선행 products/processes + 현행 parts/process_inputs"); self.load_legacy()
        self.log("  [1] uom · uom_conv · mat_class"); self.load_master()
        self.log("  [2] item"); items = self.build_items(); n = self.load_items(items)
        self.log(f"      item {n} / {len(items)} (pn_pending → {list(self.pn_actual.values())})")
        self.log("  [3][4] bom_header · bom_line"); edges = self.build_edges(); self.load_bom(edges)
        self.log(f"      header {len(self.bom_id)} · line {len(self.line_id)} (간선 {len(edges)})")
        self.log("  [5] process_material OUT → IN"); n_out, n_in = self.load_pm()
        self.log(f"      OUT {n_out} · IN {n_in} · 미배정 {len(self.unassigned)} {self.unassigned}")
        self.con.commit()
        self.log(f"  막힌 행 {len(self.rejects)}건 {self.rejects[:10]}")


# ── 6. expected 대조 ──────────────────────────────────────────────────────
def verify(con, cj, asof="2026-06-01", tmp_map=None):
    q = lambda s, *a: con.execute(s, a).fetchone()[0]
    exp = cj["expected"]; got = {}
    got["uom"] = q("SELECT count(*) FROM uom"); got["uom_conv"] = q("SELECT count(*) FROM uom_conv")
    got["mat_class"] = q("SELECT count(*) FROM mat_class"); got["mat_class_leaf"] = q("SELECT count(*) FROM mat_class WHERE is_leaf=1")
    got["item"] = q("SELECT count(*) FROM item")
    got["item_by_type"] = dict(con.execute("SELECT item_type, count(*) FROM item GROUP BY item_type").fetchall())
    got["item_phantom"] = q("SELECT count(*) FROM item WHERE is_phantom=1")
    got["trace_mode"] = dict(con.execute("SELECT trace_mode, count(*) FROM item GROUP BY trace_mode").fetchall())
    got["bom_header"] = q("SELECT count(*) FROM bom_header"); got["bom_line"] = q("SELECT count(*) FROM bom_line")
    got["node_minus_edge"] = got["item"] - got["bom_line"]
    got["max_depth"] = q("SELECT max(depth) FROM v_bom_line_qpp")
    got["bom_line_by_bop_link"] = dict(con.execute("SELECT bop_link, count(*) FROM bom_line GROUP BY bop_link").fetchall())
    got["process_material_in"] = q("SELECT count(*) FROM process_material WHERE io='IN'")
    got["process_material_out"] = q("SELECT count(*) FROM process_material WHERE io='OUT'")
    got["process_material_out_final"] = q("SELECT count(*) FROM process_material WHERE io='OUT' AND is_final=1")
    got["bop_status"] = dict(con.execute("SELECT bop_status, count(*) FROM v_bom_line_bop GROUP BY bop_status").fetchall())
    got["unassigned_lines"] = sorted(r[0] for r in con.execute("SELECT detail FROM v_chk_bop_unassigned"))
    tot, per = B.leaf_totals(con, asof=asof)
    got["leaf_totals_per_product"] = {k: round(v, 9) for k, v in tot.items()}
    bt = B.base_totals(con, asof=asof)
    got["leaf_totals_in_base"] = {f"{d}({u})": round(v, 9) for (d, u), v in bt.items()}
    got["leaf_items"] = len({k[0] for k in per})
    got["compat_process_inputs_rows"] = q("SELECT count(*) FROM v_process_inputs_compat")
    got["compat_parts_rows"] = q("SELECT count(*) FROM v_parts_compat")
    got["v_chk_summary"] = dict(con.execute("SELECT rule, cnt FROM v_chk_summary").fetchall())
    # 판정
    checks = []
    def chk(name, e, g): checks.append((name, e == g, e, g))
    for k in ("uom", "uom_conv", "mat_class", "mat_class_leaf", "item", "item_by_type", "item_phantom", "trace_mode", "bom_header", "bom_line",
              "node_minus_edge", "max_depth", "process_material_in", "process_material_out", "process_material_out_final", "bop_status",
              "compat_process_inputs_rows", "compat_parts_rows"):
        chk(k, exp[k], got[k])
    chk("bom_line_by_bop_link", {k: v for k, v in exp["bom_line_by_bop_link"].items() if v}, got["bom_line_by_bop_link"])
    # 미배정 목록: TMP- 이름 정규화
    norm = lambda s: s
    if tmp_map:
        def norm(s):
            for k, v in tmp_map.items(): s = s.replace(v, k)
            return s
    chk("unassigned_lines", sorted(exp["unassigned_lines"]), sorted(norm(s).replace(" ", "") for s in got["unassigned_lines"]))
    e_tot = exp["leaf_totals_per_product"]
    chk("leaf_totals_per_product", {k: float(v) for k, v in e_tot.items()}, got["leaf_totals_per_product"])
    chk("leaf_items 49", 49, got["leaf_items"])
    chk("MASS(kg) 1.071", 1.071, round(got["leaf_totals_in_base"].get("MASS(kg)", 0), 9))
    chk("v_chk_summary", {k: v for k, v in exp["v_chk_summary"].items() if not k.startswith("_")}, got["v_chk_summary"])
    return checks, got


def switch_compat(con):
    """이행 [3] — DDL 절 H 블록 그대로"""
    con.executescript("""
    BEGIN;
      ALTER TABLE process_inputs RENAME TO process_inputs_legacy;
      ALTER TABLE parts          RENAME TO parts_legacy;
      CREATE VIEW process_inputs AS SELECT * FROM v_process_inputs_compat;
      CREATE VIEW parts          AS SELECT * FROM v_parts_compat;
    COMMIT;""")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.join(C.OUT, "bldc_v1.db"))
    ap.add_argument("--approved", action="store_true")
    ap.add_argument("--rerun", action="store_true")
    ap.add_argument("--compat", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()
    log = C.Log("05_load.log") if not a.quiet else (lambda s="": None)
    cj, js = C.cleansing(), C.source()
    log("=" * 78)
    log("§6 v1.0 재검증 — [3] BLDC 실데이터 적재 (cleansing-v1.json loader_algorithm 그대로)")
    log(f"    db {os.path.relpath(a.db, C.ROOT)} · rerun={a.rerun} · approved={a.approved} · compat={a.compat}")
    log("=" * 78)
    if a.rerun and os.path.exists(a.db):
        con = sqlite3.connect(a.db); con.execute("PRAGMA foreign_keys=ON")
        n, ok, fails = C.run_ddl(con)          # 멱등 재실행
        log(f"  ddl-v1.sql 재실행 {n}문 실패 {len(fails)}")
    else:
        con = C.fresh(memory=False, path=a.db, uom=False)
    L = Loader(con, cj, js, approved=a.approved, log=log)
    L.run()
    tmp_map = {k: v["tmp"] for k, v in cj["pn_pending"].items() if isinstance(v, dict)}
    checks, got = verify(con, cj, tmp_map=tmp_map)
    log("\n[6] expected 대조")
    ng = 0
    for name, ok, e, g in checks:
        log(f"  [{'확인' if ok else '결함'}] {name:28} 기대 {e} · 실제 {g}")
        ng += 0 if ok else 1
    log(f"  → 일치 {len(checks)-ng} / 불일치 {ng}")
    if a.compat:
        switch_compat(con); log("\n[H] 이행 [3] 뷰 전환 완료 (process_inputs · parts → 뷰)")
    if not a.quiet:
        with open(os.path.join(C.OUT, "csv", "cleansing_map_v1.csv"), "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f); w.writerow(["pn", "rule", "action", "source"]); w.writerows(L.rules)
        log.save()
    con.close()
    return 0 if not (ng or L.rejects) else 1


if __name__ == "__main__":
    sys.exit(main())
