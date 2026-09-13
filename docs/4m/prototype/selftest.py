# -*- coding: utf-8 -*-
"""
selftest.py — 임시 SQLite에 BLDC 실데이터를 넣고 검증 루틴을 자체 시험한다.

두 가지를 한다.
  A. 실데이터 전개 대조 — 완성품 1대 총 소요량을 엑셀 09 시트 수기값과 맞춰 본다.
     현행 그대로 / 복합 부모만 분해 / 자기 참조까지 정정 — 세 단계로 나눠
     **어느 결함이 몇 개를 깎아먹는지** 숫자로 분리한다.
  B. 반례 주입 — 순환·자기참조·중복자식·단위불일치·유효일자겹침·고아·수량0/음수·
     대체품 동시유효·복합부모를 일부러 넣고 검출기가 **전부 걸러내는지** 본다.
     하나라도 통과하면 그 스키마는 결함이다.

여기 쓰는 임시 스키마는 **검증용 자리표시자**다. 윤태경의 확정 DDL이 아니다.
스키마가 확정되면 `bomkit.Mapping` 만 바꿔 끼우고 이 파일은 그대로 쓴다.

운영 DB(data/factory.db)는 읽지도 쓰지도 않는다. tempfile 에만 쓴다.

실행:  python selftest.py        (전체)
       python selftest.py --perf (성능 시험 포함)
"""
from __future__ import annotations

import argparse
import os
import random
import sqlite3
import sys
import tempfile
import time

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # pragma: no cover
    pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bomkit  # noqa: E402
from bomkit import (Mapping, as_of_edges, detect_cycles, explode,  # noqa: E402
                    find_alternate_conflicts, find_composite_parents,
                    find_duplicate_edges, find_effectivity_overlaps, find_orphans,
                    find_qty_anomalies, find_unit_conflicts, from_sqlite, where_used)
import load_source  # noqa: E402

# 엑셀 09_BOM_Flat_Consolidated 를 손으로 집계한 기대값 (완성품 1대)
EXPECTED = {"EA": 76.0, "g": 221.0, "매": 12.0, "kg": 0.85, "m": 0.5}
EXPECTED_FLAT_SUM = 310.35   # 09 시트 J53 표기값 (단위 혼재 — 참조용)

RESULTS = []


def check(name, ok, got="", want="", note=""):
    RESULTS.append((name, bool(ok), str(got), str(want), note))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}"
          + (f"\n         got={got}  want={want}" if not ok or got else "")
          + (f"\n         {note}" if note else ""))
    return ok


def head(t):
    print("\n" + "─" * 76 + f"\n{t}\n" + "─" * 76)


# ══════════════════════════════════════════ 임시 스키마 (자리표시자 2종)
# 둘 다 윤태경의 확정 DDL이 아니다. "제약이 없으면 무엇이 들어오는가"와
# "제약을 걸면 무엇이 막히는가"를 나눠 보기 위한 대조군이다.

LOOSE_DDL = """
CREATE TABLE items (
  pn TEXT PRIMARY KEY, name TEXT, unit TEXT, item_type TEXT
);
CREATE TABLE bom_edges (
  id INTEGER PRIMARY KEY,
  parent_pn TEXT, child_pn TEXT, qty_per_parent REAL, unit TEXT,
  valid_from TEXT, valid_to TEXT, alt_group TEXT, alt_priority INTEGER, seq INTEGER
);
CREATE INDEX ix_edge_parent ON bom_edges(parent_pn);
CREATE INDEX ix_edge_child  ON bom_edges(child_pn);
"""

# 현행 `parts` 의 평면 구조에 없는 제약을 전부 넣어 본 안. 무엇이 DDL만으로
# 막히고 무엇이 못 막히는지(= 응용 로직/트리거가 반드시 필요한 항목) 가른다.
STRICT_DDL = """
PRAGMA foreign_keys = ON;
CREATE TABLE uom (code TEXT PRIMARY KEY, base TEXT, factor REAL);
INSERT INTO uom(code,base,factor) VALUES
  ('EA','EA',1),('SET','SET',1),('g','g',1),('kg','g',1000),('m','mm',1000),('매','SHT',1);
CREATE TABLE items (
  pn TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  unit TEXT NOT NULL REFERENCES uom(code),
  item_type TEXT NOT NULL CHECK(item_type IN ('PRODUCT','ASSY','PART','RAW'))
);
CREATE TABLE bom_edges (
  id INTEGER PRIMARY KEY,
  parent_pn TEXT NOT NULL REFERENCES items(pn),
  child_pn  TEXT NOT NULL REFERENCES items(pn),
  qty_per_parent REAL NOT NULL CHECK(qty_per_parent > 0),
  unit TEXT NOT NULL REFERENCES uom(code),
  valid_from TEXT NOT NULL DEFAULT '1900-01-01',
  valid_to   TEXT NOT NULL DEFAULT '9999-12-31',
  alt_group TEXT, alt_priority INTEGER, seq INTEGER,
  CHECK(parent_pn <> child_pn),                    -- 자기 참조 차단
  CHECK(parent_pn NOT LIKE '%/%'),                 -- 한 칸에 부모 둘 차단
  CHECK(valid_to >= valid_from),                   -- 기간 역전 차단
  UNIQUE(parent_pn, child_pn, valid_from)          -- 같은 시작일 중복 차단
);
"""


def make_db(items, edges, path=None, ddl=None, strict=False):
    if path and os.path.exists(path):
        os.remove(path)
    con = sqlite3.connect(path or ":memory:")
    con.executescript(ddl or LOOSE_DDL)
    if strict:
        con.execute("PRAGMA foreign_keys = ON")
    con.executemany("INSERT OR REPLACE INTO items(pn,name,unit,item_type) VALUES(?,?,?,?)",
                    [(i["pn"], i.get("name") or i["pn"], i.get("unit") or "EA",
                      i.get("itemType") or "PART") for i in items])
    con.executemany(
        "INSERT INTO bom_edges(parent_pn,child_pn,qty_per_parent,unit,valid_from,valid_to,"
        "alt_group,alt_priority,seq) VALUES(?,?,?,?,?,?,?,?,?)",
        [(e["parentPn"], e["childPn"], e["qtyPerParent"], e.get("unit"),
          e.get("validFrom"), e.get("validTo"), e.get("altGroup"),
          e.get("altPriority"), e.get("seq")) for e in edges])
    con.commit()
    return con


def fmt_units(d):
    return "  ".join(f"{u}={v:g}" for u, v in sorted(d.items(), key=lambda x: -abs(x[1])))


# ══════════════════════════════════════════ A. 실데이터 전개
def part_a(tmpdir):
    head("A. 실데이터 전개 — 완성품 1대 총 소요량 (기대값 = 엑셀 09 시트 수기 집계)")
    print(f"  수기 기대값: {fmt_units(EXPECTED)}   (단위 무시 단순합 {EXPECTED_FLAT_SUM})")

    js = load_source.read_json_source(load_source.DEF_JSON)
    xl = load_source.read_xlsx_source(load_source.DEF_XLSX)

    # A-0 원천 자체 검산: 엑셀 09 의 a×b == 총소요, 단위별 합계가 기대값과 같은가
    agg = {}
    for r in xl["flat"]:
        agg[r["unit"]] = agg.get(r["unit"], 0.0) + r["qtyPerProduct"]
    check("A-0 엑셀 09 단위별 합계 = 수기 기대값",
          all(abs(agg.get(u, 0) - v) < 1e-9 for u, v in EXPECTED.items()),
          fmt_units(agg), fmt_units(EXPECTED))
    check("A-0b 엑셀 09 a×b = 총소요 (49행 전부)",
          all(abs(r["qtyPerParent"] * r["parentPerProduct"] - r["qtyPerProduct"]) < 1e-9
              for r in xl["flat"]), "", "")

    root = js["product"]["code"]
    scenarios = []

    # ── ① 현행 그대로 ────────────────────────────────────────
    n1 = load_source.normalize(js, xl, split_composite=False)
    scenarios.append(("① 현행 원천 그대로", n1))

    # ── ② 복합 부모만 분해 ──────────────────────────────────
    n2 = load_source.normalize(js, xl, split_composite=True)
    scenarios.append(("② +복합부모 HA-3000/EX-5000 분해", n2))

    # ── ③ 자기 참조까지 정정 ────────────────────────────────
    n3 = load_source.normalize(js, xl, split_composite=True)
    fixed = []
    for e in n3["edges"]:
        if e["parentPn"] == e["childPn"] == "FS-7010":
            continue                                     # L1 중복 등재 — 관계 삭제
        if e["parentPn"] == e["childPn"] == "FS-7020":
            fixed.append({**e, "childPn": "FS-7020B"})    # 동명이품 — 자식에 새 P/N
            continue
        fixed.append(e)
    n3["edges"] = fixed
    n3["items"].append({"pn": "FS-7020B", "name": "Flange Base", "unit": "EA", "srcLevel": "L2"})
    scenarios.append(("③ +자기참조 2건 정정", n3))

    prev = None
    for si, (label, norm) in enumerate(scenarios, 1):
        dbp = os.path.join(tmpdir, f"proto_s{si}.db")
        con = make_db(norm["items"], norm["edges"], dbp)
        items, edges = from_sqlite(con, Mapping())
        cyc = detect_cycles(edges)
        res = explode(edges, root, 1.0)
        got = {k: round(v, 6) for k, v in res["byUnit"].items()}
        diff = {u: round(got.get(u, 0) - v, 6) for u, v in EXPECTED.items()
                if abs(got.get(u, 0) - v) > 1e-9}
        print(f"\n  {label}")
        print(f"     순환 {len(cyc)}건 {[ '->'.join(c) for c in cyc ] if cyc else ''}")
        print(f"     전개 결과: {fmt_units(got)}   깊이 {res['depthMax']}  "
              f"리프 {len(res['totals'])}품목")
        print(f"     기대 대비 차이: {diff if diff else '없음 (일치)'}")
        if prev is not None:
            print(f"     직전 시나리오 대비 EA {got.get('EA',0)-prev:+g}")
        prev = got.get("EA", 0)
        con.close()

    # 판정
    dbp = os.path.join(tmpdir, "proto_final.db")
    con = make_db(n3["items"], n3["edges"], dbp)
    items, edges = from_sqlite(con, Mapping())
    res = explode(edges, root, 1.0)
    got = res["byUnit"]
    check("A-1 ③ 전개 = 수기 기대값 (전부 정정 시 일치해야 한다)",
          all(abs(got.get(u, 0) - v) < 1e-9 for u, v in EXPECTED.items()),
          fmt_units({k: round(v, 4) for k, v in got.items()}), fmt_units(EXPECTED))
    check("A-2 ③ 순환 0건", not detect_cycles(edges), len(detect_cycles(edges)), 0)
    check("A-3 ③ 전개 깊이 = 2 (제품→L1→L2/L3)", res["depthMax"] == 2, res["depthMax"], 2,
          "L3 로 표기된 SC-1011 이 SC-1010 이 아니라 SA-1000 에 달려 있어 실제 깊이는 2다")

    # 100대 선형성
    r100 = explode(edges, root, 100.0)
    check("A-4 100대 전개 = 1대 × 100 (선형)",
          all(abs(r100["byUnit"].get(u, 0) - v * 100) < 1e-6 for u, v in EXPECTED.items()),
          fmt_units({k: round(v, 2) for k, v in r100["byUnit"].items()}),
          fmt_units({k: v * 100 for k, v in EXPECTED.items()}))

    # 역전개
    head("A-5 역전개 (where-used)")
    for pn in ("OR-5020", "BT-3070", "SC-1011", "GB-8040"):
        w = where_used(edges, pn)
        print(f"  {pn:10s} 직상위={w['directParents']}  루트={w['roots']}")
        for p in w["paths"]:
            print("             " + " → ".join(p))
    w = where_used(edges, "OR-5020")
    check("A-5 OR-5020 역전개가 완성품까지 도달", w["roots"] == [root], w["roots"], [root])
    w2 = where_used(edges, "BT-3070")
    check("A-5b BT-3070 직상위 = HA-3000 (분해 후)", w2["directParents"] == ["HA-3000"],
          w2["directParents"], ["HA-3000"])

    # 같은 품명이 두 부모에 쓰이는 진짜 다부모 사례가 있는가
    multi = [i["pn"] for i in items
             if len({e["parentPn"] for e in edges if e["childPn"] == i["pn"]}) > 1]
    check("A-6 실데이터에 부모가 2개 이상인 품목", len(multi) == 0, multi, "[]",
          "현행 데이터에는 없다 — 다대다 요구는 O-Ring 류(OR-5020 / OR-7025)가 "
          "**P/N을 달리 매겨 회피**하고 있기 때문. 공용화하면 즉시 다부모가 된다.")
    con.close()
    return n3, items, edges


# ══════════════════════════════════════════ B. 반례 주입
CE_LABEL = {}  # edge index -> 반례 이름 (STRICT DDL 대조용)


def part_b(tmpdir):
    head("B. 반례 주입 — 검출기가 전부 걸러내는가 (막지 못하면 결함)")
    it = [{"pn": p, "name": p, "unit": "EA"} for p in
          ("P0", "A", "B", "C", "D", "E", "F", "G", "H", "X", "Y", "Z", "SELF", "ORPH", "ALT1", "ALT2")]
    ed = [
        # ① 순환 A→B→A
        {"parentPn": "A", "childPn": "B", "qtyPerParent": 1, "unit": "EA"},
        {"parentPn": "B", "childPn": "A", "qtyPerParent": 1, "unit": "EA"},
        # ② 더 긴 순환 C→D→E→C
        {"parentPn": "C", "childPn": "D", "qtyPerParent": 1, "unit": "EA"},
        {"parentPn": "D", "childPn": "E", "qtyPerParent": 1, "unit": "EA"},
        {"parentPn": "E", "childPn": "C", "qtyPerParent": 1, "unit": "EA"},
        # ③ 자기 참조
        {"parentPn": "SELF", "childPn": "SELF", "qtyPerParent": 1, "unit": "EA"},
        # ④ 같은 부모에 같은 자식 두 번
        {"parentPn": "P0", "childPn": "F", "qtyPerParent": 1, "unit": "EA"},
        {"parentPn": "P0", "childPn": "F", "qtyPerParent": 2, "unit": "EA"},
        # ⑤ 단위 불일치 (같은 자식이 자리마다 EA / g)
        {"parentPn": "P0", "childPn": "G", "qtyPerParent": 1, "unit": "EA"},
        {"parentPn": "X", "childPn": "G", "qtyPerParent": 5, "unit": "g"},
        # ⑥ 수량 0 / 음수 / NULL
        {"parentPn": "P0", "childPn": "H", "qtyPerParent": 0, "unit": "EA"},
        {"parentPn": "P0", "childPn": "X", "qtyPerParent": -3, "unit": "EA"},
        {"parentPn": "P0", "childPn": "Y", "qtyPerParent": None, "unit": "EA"},
        # ⑦ 유효일자 겹침 (같은 부모-자식, 기간이 겹친다)
        {"parentPn": "P0", "childPn": "Z", "qtyPerParent": 1, "unit": "EA",
         "validFrom": "2026-01-01", "validTo": "2026-06-30"},
        {"parentPn": "P0", "childPn": "Z", "qtyPerParent": 2, "unit": "EA",
         "validFrom": "2026-06-01", "validTo": "2026-12-31"},
        # ⑧ 대체품 동시 유효 (같은 그룹, 기간 겹침, 우선순위도 같음)
        {"parentPn": "P0", "childPn": "ALT1", "qtyPerParent": 1, "unit": "EA",
         "altGroup": "AG1", "altPriority": 1, "validFrom": "2026-01-01", "validTo": None},
        {"parentPn": "P0", "childPn": "ALT2", "qtyPerParent": 1, "unit": "EA",
         "altGroup": "AG1", "altPriority": 1, "validFrom": "2026-03-01", "validTo": None},
        # ⑨ 부모가 품목표에 없음 (미아)
        {"parentPn": "GHOST-9999", "childPn": "D", "qtyPerParent": 1, "unit": "EA"},
        # ⑩ 한 칸에 부모 둘
        {"parentPn": "HA-3000/EX-5000", "childPn": "NP-5010", "qtyPerParent": 1, "unit": "EA"},
        # ⑪ 미등록 단위
        {"parentPn": "P0", "childPn": "E", "qtyPerParent": 1, "unit": "말"},
    ]
    # ⑫ ORPH = 어느 부모에도 없음 (edge 없음)

    con = make_db(it, ed, os.path.join(tmpdir, "counterexamples.db"))  # LOOSE_DDL
    items, edges = from_sqlite(con, Mapping())
    check(f"B-00 제약 없는 스키마에 반례 {len(ed)}건이 전부 적재됨",
          len(edges) == len(ed), len(edges), len(ed),
          "현행 `parts` 처럼 제약이 없으면 이 모든 것이 그대로 들어온다")

    cyc = detect_cycles(edges)
    cyc_s = {tuple(sorted(set(c))) for c in cyc}
    check("B-01 순환 A→B→A 검출", ("A", "B") in cyc_s, sorted(cyc_s), "('A','B') 포함")
    check("B-02 순환 C→D→E→C 검출", ("C", "D", "E") in cyc_s, sorted(cyc_s), "('C','D','E') 포함")
    check("B-03 자기 참조 SELF→SELF 검출", ("SELF",) in cyc_s, sorted(cyc_s), "('SELF',) 포함")

    d = find_duplicate_edges(edges)
    check("B-04 중복 자식 P0→F 검출", any(x["key"] == {"parentPn": "P0", "childPn": "F"} for x in d),
          [x["key"] for x in d], "P0→F")

    u = find_unit_conflicts(items, edges, canon=load_source.UNIT_CANON)
    check("B-05 단위 불일치 G(EA vs g) 검출", any(x["pn"] == "G" for x in u["edgeDisagree"]),
          u["edgeDisagree"], "G")
    check("B-06 미등록 단위 '말' 검출", "말" in u["unregistered"], u["unregistered"], "'말' 포함")

    q = find_qty_anomalies(edges)
    npn = {e["childPn"] for e in q["nonPositive"]}
    check("B-07 수량 0 (H) 검출", "H" in npn, sorted(npn), "H 포함")
    check("B-08 수량 음수 (X=-3) 검출", "X" in npn, sorted(npn), "X 포함")
    check("B-09 수량 NULL (Y) 검출", any(e["childPn"] == "Y" for e in q["null"]),
          [e["childPn"] for e in q["null"]], "Y")

    ov = find_effectivity_overlaps(edges)
    check("B-10 유효일자 겹침 P0→Z (06-01~06-30) 검출",
          any(x["childPn"] == "Z" for x in ov), [x["childPn"] for x in ov], "Z")

    al = find_alternate_conflicts(edges)
    check("B-11 대체품 AG1 동시 유효 검출", len(al["simultaneous"]) >= 1,
          len(al["simultaneous"]), ">=1")
    check("B-12 대체품 우선순위 중복(1,1) 검출", len(al["priorityDup"]) >= 1,
          al["priorityDup"], ">=1")

    orp = find_orphans(items, edges, roots=("P0",))
    check("B-13 고아 품목 ORPH (부모 없음) 검출", "ORPH" in orp["noParent"], orp["noParent"], "ORPH 포함")
    check("B-14 미아 — 부모 GHOST-9999 가 품목표에 없음",
          "GHOST-9999" in orp["parentNotInItems"], orp["parentNotInItems"], "GHOST-9999 포함")
    check("B-15 루트에서 도달 불가 품목 검출", len(orp["unreachable"]) > 0,
          orp["unreachable"], ">0")

    cp = find_composite_parents(edges)
    check("B-16 복합 부모 'HA-3000/EX-5000' 검출", any(x["parentPn"] == "HA-3000/EX-5000" for x in cp),
          [x["parentPn"] for x in cp], "HA-3000/EX-5000")

    # as-of 조회
    a1 = as_of_edges(edges, "2026-02-01")
    a2 = as_of_edges(edges, "2026-08-01")
    z1 = [e["qtyPerParent"] for e in a1 if e["childPn"] == "Z"]
    z2 = [e["qtyPerParent"] for e in a2 if e["childPn"] == "Z"]
    check("B-17 as-of 2026-02-01 → Z 1건만 유효", z1 == [1], z1, [1])
    check("B-18 as-of 2026-08-01 → Z 1건만 유효(겹침 구간 밖)", z2 == [2], z2, [2])
    z3 = [e["qtyPerParent"] for e in as_of_edges(edges, "2026-06-15") if e["childPn"] == "Z"]
    check("B-19 as-of 2026-06-15 (겹침 구간) → 2건 = 어느 쪽인지 결정 불가",
          len(z3) == 2, z3, "2건", "설계는 이 상태를 **입력 단계에서** 막아야 한다")

    # 전개가 순환에서 무한루프 하지 않는가
    t0 = time.perf_counter()
    r = explode(edges, "A", 1.0)
    el = time.perf_counter() - t0
    check("B-20 순환이 있어도 전개가 멈춘다 (무한루프 방지)", el < 2.0 and r["cyclesHit"],
          f"{el*1000:.1f}ms, cyclesHit={len(r['cyclesHit'])}", "<2s & 순환 보고")

    allres = bomkit.run_all(items, edges, roots=("P0",), canon=load_source.UNIT_CANON)
    check("B-21 run_all 이 차단 사유를 집계", allres["blocking"] >= 10, allres["blocking"], ">=10")
    con.close()

    # ── B-22 제약을 건 DDL 은 어느 반례를 '입력 단계에서' 막는가 ──────────
    head("B-22 STRICT DDL 대조 — DDL만으로 막히는 것 / 응용 로직이 있어야 막히는 것")
    cases = [
        ("자기 참조 SELF→SELF", dict(parentPn="SELF", childPn="SELF", qtyPerParent=1, unit="EA")),
        ("한 칸에 부모 둘", dict(parentPn="HA-3000/EX-5000", childPn="F", qtyPerParent=1, unit="EA")),
        ("수량 0", dict(parentPn="P0", childPn="H", qtyPerParent=0, unit="EA")),
        ("수량 음수", dict(parentPn="P0", childPn="X", qtyPerParent=-3, unit="EA")),
        ("수량 NULL", dict(parentPn="P0", childPn="Y", qtyPerParent=None, unit="EA")),
        ("부모가 품목표에 없음", dict(parentPn="GHOST-9999", childPn="D", qtyPerParent=1, unit="EA")),
        ("미등록 단위 '말'", dict(parentPn="P0", childPn="E", qtyPerParent=1, unit="말")),
        ("유효기간 역전(to<from)", dict(parentPn="P0", childPn="G", qtyPerParent=1, unit="EA",
                                        validFrom="2026-12-01", validTo="2026-01-01")),
        ("같은 시작일 중복 자식", dict(parentPn="P0", childPn="F", qtyPerParent=2, unit="EA",
                                       validFrom="2026-01-01")),
        ("── 아래는 DDL로 막히지 않는다 ──", None),
        ("순환 A→B→A (2단계)", dict(parentPn="B", childPn="A", qtyPerParent=1, unit="EA")),
        ("유효일자 겹침(시작일은 다름)", dict(parentPn="P0", childPn="Z", qtyPerParent=2, unit="EA",
                                              validFrom="2026-06-01", validTo="2026-12-31")),
        ("대체품 동시 유효", dict(parentPn="P0", childPn="ALT2", qtyPerParent=1, unit="EA",
                                  altGroup="AG1", altPriority=1, validFrom="2026-03-01")),
        ("같은 P/N 단위 불일치(다른 자리)", dict(parentPn="X", childPn="G", qtyPerParent=5, unit="g")),
    ]
    scon = make_db(it, [
        {"parentPn": "P0", "childPn": "F", "qtyPerParent": 1, "unit": "EA",
         "validFrom": "2026-01-01", "validTo": "9999-12-31"},
        {"parentPn": "P0", "childPn": "Z", "qtyPerParent": 1, "unit": "EA",
         "validFrom": "2026-01-01", "validTo": "2026-06-30"},
        {"parentPn": "P0", "childPn": "ALT1", "qtyPerParent": 1, "unit": "EA",
         "validFrom": "2026-01-01", "validTo": "9999-12-31", "altGroup": "AG1", "altPriority": 1},
        {"parentPn": "A", "childPn": "B", "qtyPerParent": 1, "unit": "EA",
         "validFrom": "2026-01-01", "validTo": "9999-12-31"},
        {"parentPn": "P0", "childPn": "G", "qtyPerParent": 1, "unit": "EA",
         "validFrom": "2026-01-01", "validTo": "9999-12-31"},
    ], os.path.join(tmpdir, "strict.db"), ddl=STRICT_DDL, strict=True)

    blocked, passed = [], []
    for label, e in cases:
        if e is None:
            print(f"  {label}")
            continue
        try:
            scon.execute(
                "INSERT INTO bom_edges(parent_pn,child_pn,qty_per_parent,unit,valid_from,valid_to,"
                "alt_group,alt_priority) VALUES(?,?,?,?,?,?,?,?)",
                (e["parentPn"], e["childPn"], e["qtyPerParent"], e.get("unit"),
                 e.get("validFrom") or "1900-01-01", e.get("validTo") or "9999-12-31",
                 e.get("altGroup"), e.get("altPriority")))
            scon.commit()
            passed.append(label)
            print(f"    통과 ->  {label}   (DDL로 못 막음 — 응용 로직/트리거 필요)")
        except sqlite3.Error as ex:
            blocked.append(label)
            print(f"    차단 OK  {label}   [{type(ex).__name__}: {str(ex)[:60]}]")
    check("B-22 STRICT DDL 이 9개 반례를 입력 단계에서 차단", len(blocked) == 9,
          f"{len(blocked)}건 차단 / {len(passed)}건 통과", "9건 차단",
          "통과분(" + ", ".join(passed) + ")은 DDL로 막을 수 없으므로 "
          "트리거·검증 배치·입력 화면 검사 중 하나를 반드시 설계에 넣어야 한다")
    scon.close()


# ══════════════════════════════════════════ C. 성능
def part_c(tmpdir, n_items=10000, levels=5):
    head(f"C. 성능 — 품목 {n_items:,}건 · 레벨 {levels} 규모 전개/역전개")
    random.seed(7)
    per = n_items // levels
    items, edges, by_lvl = [{"pn": "ROOT", "name": "ROOT", "unit": "EA"}], [], {0: ["ROOT"]}
    for lv in range(1, levels + 1):
        cur = []
        for i in range(per):
            pn = f"L{lv}-{i:05d}"
            cur.append(pn)
            items.append({"pn": pn, "name": pn, "unit": "EA"})
            par = random.choice(by_lvl[lv - 1])
            edges.append({"parentPn": par, "childPn": pn,
                          "qtyPerParent": random.choice([1, 1, 2, 4]), "unit": "EA"})
        by_lvl[lv] = cur
    # 부모가 2개인 공용 부품 500건 (다대다 부하)
    for i in range(500):
        edges.append({"parentPn": random.choice(by_lvl[levels - 1]),
                      "childPn": random.choice(by_lvl[levels]),
                      "qtyPerParent": 1, "unit": "EA"})

    dbp = os.path.join(tmpdir, "perf.db")
    t0 = time.perf_counter(); con = make_db(items, edges, dbp); t_load = time.perf_counter() - t0
    t0 = time.perf_counter(); it2, ed2 = from_sqlite(con, Mapping()); t_read = time.perf_counter() - t0
    t0 = time.perf_counter(); cyc = detect_cycles(ed2); t_cyc = time.perf_counter() - t0
    t0 = time.perf_counter(); ex = explode(ed2, "ROOT", 1.0); t_exp = time.perf_counter() - t0
    leaf = random.choice(by_lvl[levels])
    t0 = time.perf_counter(); wu = where_used(ed2, leaf); t_wu = time.perf_counter() - t0

    print(f"  품목 {len(items):,} · 관계 {len(edges):,} (공용부품 500건 포함)")
    print(f"  적재       {t_load*1000:8.1f} ms")
    print(f"  읽기       {t_read*1000:8.1f} ms")
    print(f"  순환검출   {t_cyc*1000:8.1f} ms  (검출 {len(cyc)}건)")
    print(f"  정전개     {t_exp*1000:8.1f} ms  (노드 {len(ex['lines']):,} · 깊이 {ex['depthMax']})")
    print(f"  역전개     {t_wu*1000:8.1f} ms  ({leaf} 경로 {len(wu['paths'])}개)")
    check("C-1 순환검출 < 3s", t_cyc < 3.0, f"{t_cyc:.3f}s", "<3s")
    check("C-2 정전개 < 5s", t_exp < 5.0, f"{t_exp:.3f}s", "<5s")
    check("C-3 역전개 < 3s", t_wu < 3.0, f"{t_wu:.3f}s", "<3s")
    con.close()


# ══════════════════════════════════════════ D. 미실시
def part_d():
    head("D. 이번 라운드 미실시 (스키마·데이터가 없어 시험 불가)")
    for t, why in [
        ("로트 계보 정·역방향 추적", "운영 DB에 로트/입고/투입/산출 테이블이 하나도 없다. "
                                     "lot·inventory·receipt·issue·genealogy 전부 부재 — 설계 후 재시도."),
        ("대체품 실데이터 검증", "BLDC 원천에 대체품 데이터가 없다. B-11/B-12 는 합성 데이터."),
        ("유효일자 실데이터 검증", "원천에 유효일자 컬럼이 없다. B-10/B-17~19 는 합성 데이터."),
        ("단위 환산 실검증", "환산표(g↔kg, m↔mm, 매→SHT, SET→구성)가 아직 정의되지 않았다."),
        ("BOP 투입지점 수량 검증", "process_inputs.qty 가 '제품 1대당'이라 공정 1회 투입량이 아니다. "
                                    "배치 크기(A80·A90 30ea/배치)와의 관계가 정의되지 않았다."),
    ]:
        print(f"  [미실시] {t}\n           └ {why}")
        RESULTS.append((f"[미실시] {t}", None, "", "", why))


# ══════════════════════════════════════════
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--perf", action="store_true", help="성능 시험 포함")
    ap.add_argument("--keep", action="store_true", help="임시 DB 파일 유지(경로 출력)")
    a = ap.parse_args()

    tmpdir = tempfile.mkdtemp(prefix="fw-bom-proto-")
    print(f"임시 작업 폴더: {tmpdir}   (운영 DB는 열지 않는다)")
    try:
        part_a(tmpdir)
        part_b(tmpdir)
        if a.perf:
            part_c(tmpdir)
        part_d()
    finally:
        if not a.keep:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)
        else:
            print(f"\n임시 DB 유지: {tmpdir}")

    head("종합")
    ran = [r for r in RESULTS if r[1] is not None]
    p = sum(1 for r in ran if r[1])
    f = [r for r in ran if not r[1]]
    skipped = [r for r in RESULTS if r[1] is None]
    print(f"  PASS {p} / {len(ran)}   FAIL {len(f)}   미실시 {len(skipped)}")
    for r in f:
        print(f"   FAIL {r[0]}  got={r[2]} want={r[3]}")
    return 0 if not f else 1


if __name__ == "__main__":
    sys.exit(main())
