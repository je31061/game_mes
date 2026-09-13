# -*- coding: utf-8 -*-
"""
r2_load.py — BLDC 실데이터를 계획서 v0.9 스키마(ddl_v09_patched.sql)에 적재한다.
정제 규칙은 계획서 §9.2(P-1~P-14) · §3.2 목표 트리 · §4.3/4.4 를 **그대로** 적용한다.
수량·단위는 지어내지 않고 전부 원천(bldc-500w-48v.json)에서 읽는다.
적재 중 막힌 행은 전부 out/04_load.log 와 out/csv/load_rejects.csv 에 남긴다.

실행: python r2_load.py [--status ACTIVE|DRAFT]   (기본 ACTIVE)
산출: out/bldc_v09.db · out/04_load.log · out/csv/cleansing_map.csv · out/csv/load_rejects.csv
"""
from __future__ import annotations
import argparse, csv, io, json, os, sqlite3, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))   # …/factory-world-master
OUT = os.path.join(HERE, "out"); os.makedirs(os.path.join(OUT, "csv"), exist_ok=True)
SRC = os.path.join(ROOT, "docs", "bldc", "bldc-500w-48v.json")

VF = "2026-01-01"           # 유효 시작일 (원천에 없다 — 적재 기준일로 고정, 지어낸 값이 아님을 명시)

# ── 단위 마스터 (§5.1) ───────────────────────────────────────────────────────
UOM = [  # code, 한글, 차원, 소수자리, 기준단위
    ("EA", "개", "COUNT", 0, 1), ("SET", "세트", "COUNT", 0, 0), ("SHT", "매", "COUNT", 0, 0),
    ("kg", "킬로그램", "MASS", 3, 1), ("g", "그램", "MASS", 2, 0), ("m", "미터", "LENGTH", 2, 1),
]
UOM_CONV = [("kg", "g", 1000.0, None), ("m", "mm", 1000.0, None), ("SHT", "kg", 0.010625, "SC-1011")]
SRC_UNIT = {"EA": "EA", "SET": "SET", "매": "SHT", "kg": "kg", "g": "g", "m": "m"}

# ── §9.2 P-1 : 'HA-3000/EX-5000' 10행 분리 ─────────────────────────────────
P1_EX = {"NP-5010", "OR-5020", "CG-5030"}          # 나머지 7종은 HA-3000
# ── §9.2 P-2 : 자기참조 2건 ────────────────────────────────────────────────
P2_DEMOTE = "FS-7010"                               # 조립품 지위 해제 → 완성품 직하 단품
P2_RENUM = ("FS-7020", "FS-7023")                   # 자식 개번 (쟁점 1, PM 미승인)
# ── §9.2 P-3 : SC-1011 재배치 ──────────────────────────────────────────────
P3_NEW_PARENT = "SC-1010P"
# ── §4.3 / P-9 : 신규 품목 3종 ─────────────────────────────────────────────
NEW_ITEMS = [
    ("SC-1010P", "스테이터 편 (블랭킹편)", "SA", "MAKE", "SHT", 0),
    ("FS-7023", "Flange Shaft No.2 (Base)", "PT", "BUY", "EA", 0),
    ("PK-0010", "Carton (포장 박스)", "PK", "BUY", "EA", 0),
]
# ── §4.4 : 팬텀 3종 ────────────────────────────────────────────────────────
PHANTOM = {"HA-3000", "EX-5000", "PE-6000"}
# ── §4.3 : 산출 P/N 8건 (공정, 품목, 1회 산출수량) ─────────────────────────
OUT_PN = [("OP-A10", "SC-1010P", 80.0), ("OP-A20", "SC-1010", 1.0), ("OP-A100", "SA-1000", 1.0),
          ("OP-B40", "RA-2000", 1.0), ("OP-B85", "GB-8000", 1.0), ("OP-B87", "PL-9000", 1.0),
          ("OP-B90", "PE-6000", 1.0), ("OP-B120", "BLDC-500W-48V", 1.0)]
# ── §3.2 트리 주석의 투입 공정 (라인 = (부모pn, 자식pn) → op) ──────────────
#     '' = 미정(쟁점 3·6) · None = 팬텀 라인(IN 없음, §4.4)
LINE_OP = {
    ("BLDC-500W-48V", "SA-1000"): "OP-B50", ("BLDC-500W-48V", "RA-2000"): "OP-B70",
    ("BLDC-500W-48V", "HA-3000"): None, ("BLDC-500W-48V", "EX-5000"): None,
    ("BLDC-500W-48V", "PE-6000"): None, ("BLDC-500W-48V", "FS-7010"): "",
    ("BLDC-500W-48V", "FS-7020"): "", ("BLDC-500W-48V", "GB-8000"): "",
    ("BLDC-500W-48V", "PL-9000"): "", ("BLDC-500W-48V", "PK-0010"): "OP-B120",
    ("SA-1000", "SC-1010"): "OP-A30", ("SA-1000", "IN-1020U"): "OP-A30",
    ("SA-1000", "IN-1020L"): "OP-A30", ("SA-1000", "IP-1040"): "OP-A30*",
    ("SA-1000", "MW-1030"): "OP-A40", ("SA-1000", "LC-1080"): "OP-A50*",
    ("SA-1000", "LW-1050"): "OP-A60", ("SA-1000", "TM-1060"): "OP-A60",
    ("SA-1000", "IV-1070"): "OP-A80",
    ("SC-1010", "SC-1010P"): "OP-A20", ("SC-1010P", "SC-1011"): "OP-A10",
    ("RA-2000", "SH-2010"): "OP-B10", ("RA-2000", "RC-2020"): "OP-B10",
    ("RA-2000", "PM-2030"): "OP-B20", ("RA-2000", "AD-2040"): "OP-B20",
    ("RA-2000", "BW-2050"): "OP-B40",
    ("HA-3000", "HS-3010"): "OP-B50", ("HA-3000", "BF-3040"): "OP-B60",
    ("HA-3000", "BR-3050"): "OP-B60", ("HA-3000", "WW-3060"): "OP-B60",
    ("HA-3000", "BP-3020F"): "OP-B80", ("HA-3000", "BP-3020R"): "OP-B80",
    ("HA-3000", "BT-3070"): "OP-B80",
    ("EX-5000", "OR-5020"): "OP-B100", ("EX-5000", "CG-5030"): "OP-B100",
    ("EX-5000", "NP-5010"): "OP-B120",
    ("PE-6000", "CN-4030"): "OP-B100",
    ("FS-7020", "FS-7023"): "", ("FS-7020", "FS-7021"): "",
    ("FS-7020", "FS-7022"): "", ("FS-7020", "OR-7025"): "",
}
for pn in ("PC-4010", "PC-4011", "HS-4020", "MO-4030", "GD-4040", "CP-4050", "HK-4060", "BB-4070", "SP-4040"):
    LINE_OP[("PE-6000", pn)] = "OP-B90"
for pn in ("GB-8010", "GB-8020", "GB-8030", "GB-8040", "GB-8050"):
    LINE_OP[("GB-8000", pn)] = "OP-B85"
for pn in ("PL-9010", "PL-9020", "PL-9030", "PL-9040"):
    LINE_OP[("PL-9000", pn)] = "OP-B87"

# ── 품목 유형 (§5.3 item_type) — 조립품 여부는 구조가 결정, 나머지는 P/N 계열 ──
RM = {"SC-1011"}; CN = {"AD-2040", "IV-1070", "SP-4040", "GB-8050"}; PK = {"PK-0010"}
MAKE = {"SC-1010", "SC-1010P", "SA-1000", "RA-2000", "GB-8000", "PL-9000",
        "HA-3000", "EX-5000", "PE-6000", "FS-7020", "BLDC-500W-48V"}


def statements(path):
    sql = open(path, encoding="utf-8").read(); buf, out = [], []
    for ln in sql.splitlines(True):
        buf.append(ln); t = "".join(buf)
        if sqlite3.complete_statement(t): out.append(t); buf = []
    if "".join(buf).strip(): out.append("".join(buf))
    return out


def build_tree(js, log, rules):
    """원천 → (items, edges). 정제 규칙 적용 이력을 rules 에 기록한다."""
    parts = js["parts"]; subs = js["subassemblies"]; prod = js["product"]
    items = {}   # pn -> dict
    edges = []   # (parent, child, qty, unit, note)

    def add_item(pn, name, spec, unit):
        if pn not in items:
            items[pn] = dict(pn=pn, name=name, spec=spec, unit=unit)

    add_item(prod["code"], prod["name"], "", "EA")
    for s in subs:
        add_item(s["pn"], s["name"], s.get("note", ""), s.get("unit", "EA"))
    for p in parts:
        add_item(p["pn"], p["name"], p.get("spec", ""), p.get("unit", "EA"))

    # L1: 서브어셈블리 9 → 완성품 직하
    for s in subs:
        if s["pn"] == P2_DEMOTE:
            rules.append((P2_DEMOTE, "P-2", "조립품 지위 해제 → 완성품 직하 단품", "§9.2 P-2"))
        edges.append((prod["code"], s["pn"], float(s["qty"]), s.get("unit", "EA"), "L1"))

    # L2/L3: parts
    for p in parts:
        parent, child = p["parentPn"], p["pn"]
        if parent == "HA-3000/EX-5000":                                   # P-1
            new = "EX-5000" if child in P1_EX else "HA-3000"
            rules.append((child, "P-1", f"부모 'HA-3000/EX-5000' → '{new}'", "§9.2 P-1"))
            parent = new
        if parent == child:                                               # P-2
            if child == P2_DEMOTE:
                rules.append((child, "P-2", "자기참조 행 삭제 (L1 등재만 남긴다)", "§9.2 P-2"))
                continue
            if child == P2_RENUM[0]:
                rules.append((child, "P-2", f"자식 개번 {P2_RENUM[0]} → {P2_RENUM[1]} (쟁점 1·PM 미승인)", "§9.2 P-2"))
                child = P2_RENUM[1]
        if child == "SC-1011":                                            # P-3
            rules.append((child, "P-3", f"부모 '{parent}' → '{P3_NEW_PARENT}'", "§9.2 P-3"))
            parent = P3_NEW_PARENT
        edges.append((parent, child, float(p["qtyPerParent"]), p.get("unit", "EA"), p["level"]))

    # 신규 3종 + §4.3 중간재 라인
    for pn, name, *_ in NEW_ITEMS:
        add_item(pn, name, "", dict((n[0], n[4]) for n in NEW_ITEMS)[pn])
        rules.append((pn, "P-8/P-9", "신규 품목 등록 (쟁점 2·PM 미승인)", "§4.3 / §9.2"))
    items["SC-1010P"]["unit"] = "SHT"; items["FS-7023"]["unit"] = "EA"; items["PK-0010"]["unit"] = "EA"
    edges.append(("SC-1010", "SC-1010P", 80.0, "매", "L3"))     # §3.2 · P-9 '블랭킹편 ×80'
    rules.append(("SC-1010P", "P-9", "BOP 축약 '블랭킹편 ×80' → SC-1010P 80 SHT 라인 신설", "§9.2 P-9"))
    edges.append((prod["code"], "PK-0010", 1.0, "EA", "L1"))
    rules.append(("PK-0010", "P-9", "BOP 'NP-5010, Carton' 의 Carton → PK-0010 1 EA 라인 신설", "§9.2 P-9"))
    return items, edges


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--status", default="ACTIVE", choices=["ACTIVE", "DRAFT", "APPROVED"])
    ap.add_argument("--db", default=os.path.join(OUT, "bldc_v09.db"))
    a = ap.parse_args()

    buf = io.StringIO()
    def log(s=""):
        print(s); buf.write(s + "\n")

    js = json.load(open(SRC, encoding="utf-8"))
    rules, rejects = [], []
    items, edges = build_tree(js, log, rules)

    log("=" * 78)
    log("§3 실증 검증 — [3] BLDC 실데이터 적재 (계획서 §9.2 정제 규칙 그대로)")
    log(f"    원천 {os.path.relpath(SRC, ROOT)} · bom_header.status='{a.status}' · valid_from={VF}")
    log("=" * 78)
    log(f"\n정제 규칙 적용 {len(rules)}건 → out/csv/cleansing_map.csv")
    for pn, code, what, src in rules[:6]:
        log(f"    {code:6} {pn:12} {what}")
    log(f"    … 이하 {max(0,len(rules)-6)}건")

    if os.path.exists(a.db): os.remove(a.db)
    con = sqlite3.connect(a.db); con.execute("PRAGMA foreign_keys=ON")
    for p in (os.path.join(HERE, "prereq_existing.sql"), os.path.join(HERE, "ddl_v09_patched.sql")):
        for s in statements(p): con.execute(s)

    # 단위
    con.executemany("INSERT INTO uom(uom_code,name_ko,dim,decimals,is_base) VALUES (?,?,?,?,?)", UOM)
    # 분류 (말단 1개로 단순화 — 축 ① 자체는 이번 검증 대상이 아니다)
    con.execute("INSERT INTO mat_class(class_code,name,is_leaf) VALUES ('ALL','전체(검증용 말단분류)',1)")

    # 기존 운영 테이블 (BOP 대조·호환뷰 시험용)
    con.execute("INSERT INTO products(code,name) VALUES (?,?)", (js["product"]["code"], js["product"]["name"]))
    for p in js["processes"]:
        con.execute("INSERT INTO processes(product_code,op,seq,line,name,equipment_hint,input_text,output,ct_sec,kind,qc,note,stage_pn)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (js["product"]["code"], p["op"], p.get("seq"), p.get("line"), p.get("name"),
                     p.get("equipment"), p.get("inputText"), p.get("output"), p.get("ctSec"),
                     p.get("kind"), p.get("qc"), p.get("note"), p.get("stagePn")))
    proc_id = {r[1]: r[0] for r in con.execute("SELECT id,op FROM processes")}

    # 현행 parts / process_inputs (마이그레이션 원본)
    for p in js["parts"]:
        con.execute("INSERT OR REPLACE INTO parts(pn,name,spec,level,parent_pn,parent_name,qty_per_parent,qty_per_product,unit)"
                    " VALUES (?,?,?,?,?,?,?,?,?)",
                    (p["pn"], p["name"], p.get("spec"), p["level"], p["parentPn"], p.get("parentName"),
                     p["qtyPerParent"], p["qtyPerProduct"], p.get("unit")))
    for p in js["processes"]:
        qmap = {}
        for pn in p.get("inputs", []):
            src_row = next((x for x in js["parts"] if x["pn"] == pn), None)
            qmap[pn] = src_row["qtyPerProduct"] if src_row else None
        for pn, q in qmap.items():
            con.execute("INSERT OR IGNORE INTO process_inputs(process_id,pn,qty) VALUES (?,?,?)",
                        (proc_id[p["op"]], pn, q))

    # ── item ────────────────────────────────────────────────────────────
    has_children = {e[0] for e in edges}
    item_id = {}
    for pn, it in items.items():
        if pn == P2_DEMOTE:
            itype = "PT"                                   # §9.2 P-2 단품 재분류
        elif pn == js["product"]["code"]:
            itype = "FG"
        elif pn in PK: itype = "PK"
        elif pn in RM: itype = "RM"
        elif pn in CN: itype = "CN"
        elif pn in has_children: itype = "SA"
        else: itype = "PT"
        uom = SRC_UNIT.get(it["unit"], it["unit"])
        try:
            cur = con.execute(
                "INSERT INTO item(pn,name,spec,class_id,item_type,source_type,base_uom,is_phantom,status)"
                " VALUES (?,?,?,1,?,?,?,?,?)",
                (pn, it["name"], it.get("spec"), itype, "MAKE" if pn in MAKE else "BUY",
                 uom, 1 if pn in PHANTOM else 0, "ACTIVE"))
            item_id[pn] = cur.lastrowid
        except Exception as e:
            rejects.append(("item", pn, "", str(e)))
    log(f"\nitem 적재 {len(item_id)} / {len(items)}")

    # ── bom_header / bom_line ───────────────────────────────────────────
    parents = sorted({e[0] for e in edges})
    bom_id = {}
    for pn in parents:
        base_qty, base_uom = 1.0, items[pn]["unit"]
        if pn == "SC-1010P":                       # §3.2 · §5.4 : base_qty = 80 SHT
            base_qty, base_uom = 80.0, "매"
        try:
            cur = con.execute(
                "INSERT INTO bom_header(parent_item_id,base_qty,base_uom,status,valid_from) VALUES (?,?,?,?,?)",
                (item_id[pn], base_qty, SRC_UNIT.get(base_uom, base_uom), a.status, VF))
            bom_id[pn] = cur.lastrowid
        except Exception as e:
            rejects.append(("bom_header", pn, "", str(e)))
    log(f"bom_header 적재 {len(bom_id)} (계획서 §5.8 예상 11)")

    line_id = {}
    no = {}
    for parent, child, qty, unit, lv in edges:
        no[parent] = no.get(parent, 0) + 10
        try:
            cur = con.execute(
                "INSERT INTO bom_line(bom_id,line_no,child_item_id,qty_per,uom_code,valid_from,note)"
                " VALUES (?,?,?,?,?,?,?)",
                (bom_id[parent], no[parent], item_id[child], qty,
                 SRC_UNIT.get(unit, unit), VF, lv))
            line_id[(parent, child)] = cur.lastrowid
        except Exception as e:
            rejects.append(("bom_line", parent, child, str(e)))
            log(f"  [막힘] bom_line {parent} → {child} {qty}{unit} : {e}")
    log(f"bom_line 적재 {len(line_id)} (계획서 §5.8 예상 59)")

    # ── process_material ────────────────────────────────────────────────
    n_in = n_out = 0
    unassigned, phantom_lines = [], []
    for (parent, child), lid in line_id.items():
        op = LINE_OP.get((parent, child), "MISSING")
        if op is None:
            phantom_lines.append((parent, child)); continue
        if op in ("", "MISSING"):
            unassigned.append((parent, child, op)); continue
        est = op.endswith("*"); opc = op.rstrip("*")
        try:
            con.execute("INSERT INTO process_material(process_id,io,line_id,issue_method,note)"
                        " VALUES (?,'IN',?,?,?)",
                        (proc_id[opc], lid, "BACKFLUSH", "추정(쟁점 6)" if est else None))
            n_in += 1
        except Exception as e:
            rejects.append(("process_material IN", parent, child, str(e)))
    for op, pn, q in OUT_PN:
        try:
            con.execute("INSERT INTO process_material(process_id,io,item_id,qty_out) VALUES (?,'OUT',?,?)",
                        (proc_id[op], item_id[pn], q))
            n_out += 1
        except Exception as e:
            rejects.append(("process_material OUT", op, pn, str(e)))
    con.commit()
    log(f"process_material IN {n_in} · OUT {n_out} "
        f"(계획서 §5.8 예상 IN 48=확정46+추정2 · OUT 8)")
    log(f"   미배정 라인 {len(unassigned)}건 : {[f'{p}→{c}' for p,c,_ in unassigned]}")
    log(f"   팬텀 라인(IN 없음) {len(phantom_lines)}건 : {[f'{p}→{c}' for p,c in phantom_lines]}")

    # ── 적재 결과 요약 ──────────────────────────────────────────────────
    log("\n" + "-" * 78)
    q = lambda s: con.execute(s).fetchone()[0]
    log(f"  item {q('select count(*) from item')} · bom_header {q('select count(*) from bom_header')}"
        f" · bom_line {q('select count(*) from bom_line')}"
        f" · process_material {q('select count(*) from process_material')}")
    log(f"  노드 {q('select count(*) from item')} − 간선 {q('select count(*) from bom_line')} = "
        f"{q('select count(*) from item') - q('select count(*) from bom_line')}  (1이면 트리)")
    log(f"  막힌 행 {len(rejects)}건")
    for r in rejects[:20]:
        log(f"    {r}")

    with open(os.path.join(OUT, "csv", "cleansing_map.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f); w.writerow(["pn", "rule", "action", "source"]); w.writerows(rules)
    with open(os.path.join(OUT, "csv", "load_rejects.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f); w.writerow(["table", "a", "b", "error"]); w.writerows(rejects)
    open(os.path.join(OUT, "04_load.log"), "w", encoding="utf-8").write(buf.getvalue())
    con.close()
    log(f"\n→ {os.path.relpath(a.db, ROOT)} 생성 완료")


if __name__ == "__main__":
    main()
