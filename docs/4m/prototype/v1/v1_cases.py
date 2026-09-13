# -*- coding: utf-8 -*-
"""
v1_cases.py — v1.0 반례 배터리를 **데이터(cases.json)** 로 만든다.
python(v1_cases_run.py) 과 node:sqlite(v1_cases_run.mjs) 가 같은 파일을 읽어 같은 순서로 실행하므로
두 런타임 결과 차이가 곧 런타임 차이다.

케이스 = { id, group, title, setup:[sql…], attack: sql, expect: 'reject'|'accept', msg?: 오류문자열 포함 조건, post?: {sql, expect} }
케이스마다 새 DB(선행 테이블 + ddl-v1.sql + uom 5 + 분류 2) 에서 돌린다.
실행: python v1_cases.py  → cases.json
"""
from __future__ import annotations
import json, os
import common as C

CASES = []


def add(cid, group, title, setup, attack, expect, msg=None, post=None, note=None):
    CASES.append(dict(id=cid, group=group, title=title, setup=setup, attack=attack, expect=expect,
                      msg=msg, post=post, note=note))


# ── SQL 조각 (item_id 를 몰라도 되게 전부 서브쿼리) ────────────────────────
def I(pn, t="SA", uom="EA", ph=0, cls=1, status="ACTIVE", trace="NONE"):
    return (f"INSERT INTO item(pn,name,class_id,item_type,source_type,base_uom,is_phantom,status,trace_mode)"
            f" VALUES ('{pn}','{pn}',{cls},'{t}','MAKE','{uom}',{ph},'{status}','{trace}')")

def iid(pn): return f"(SELECT item_id FROM item WHERE pn='{pn}')"

def H(pn, status="ACTIVE", base_qty=1, uom="EA", vf="2026-01-01", vt="9999-12-31", alt="00", rev="A", bom_id=None):
    cols = "parent_item_id,base_qty,base_uom,status,valid_from,valid_to,alt_no,rev" + (",bom_id" if bom_id else "")
    vals = f"{iid(pn)},{base_qty},'{uom}','{status}','{vf}','{vt}','{alt}','{rev}'" + (f",{bom_id}" if bom_id else "")
    return f"INSERT INTO bom_header({cols}) VALUES ({vals})"

def hid(pn, rev="A", alt="00"):
    return f"(SELECT bom_id FROM bom_header WHERE parent_item_id={iid(pn)} AND rev='{rev}' AND alt_no='{alt}')"

def L(parent, child, qty=1, uom="EA", vf="2026-01-01", vt="9999-12-31", alt=None, prio=None, no=10,
      bop=None, note=None, scrap=0, basis="NET", rev="A"):
    cols = ["bom_id", "line_no", "child_item_id", "qty_per", "uom_code", "valid_from", "valid_to", "scrap_pct", "qty_basis"]
    vals = [hid(parent, rev), str(no), iid(child), str(qty), f"'{uom}'", f"'{vf}'", f"'{vt}'", str(scrap), f"'{basis}'"]
    if alt is not None: cols.append("alt_group"); vals.append(f"'{alt}'")
    if prio is not None: cols.append("alt_priority"); vals.append(str(prio))
    if bop: cols.append("bop_link"); vals.append(f"'{bop}'")
    if note: cols.append("note"); vals.append(f"'{note}'")
    return f"INSERT INTO bom_line({','.join(cols)}) VALUES ({','.join(vals)})"

def lid(parent, child, rev="A"):
    return f"(SELECT line_id FROM bom_line WHERE bom_id={hid(parent, rev)} AND child_item_id={iid(child)})"

PROC = ["INSERT INTO products(code,name) VALUES ('P','P')",
        "INSERT INTO processes(id,product_code,op,seq,line) VALUES (1,'P','OP-1',1,'L1'),(2,'P','OP-2',2,'L1'),(3,'P','OP-3',3,'L1'),(9,'P','OP-X',1,'L9')"]

def PM_IN(op_id, parent, child, split=100):
    return f"INSERT INTO process_material(process_id,io,line_id,split_pct) VALUES ({op_id},'IN',{lid(parent, child)},{split})"

def PM_OUT(op_id, pn, final=1, state=None, qty=1):
    st = f"'{state}'" if state else "NULL"
    return f"INSERT INTO process_material(process_id,io,item_id,is_final,out_state,qty_out) VALUES ({op_id},'OUT',{iid(pn)},{final},{st},{qty})"

def LOT(no, pn, qty=10, uom="EA", parent=None, kind="LOT", lot_id=None):
    par = f"(SELECT lot_id FROM mat_lot WHERE lot_no='{parent}')" if parent else "NULL"
    cols = "lot_no,item_id,qty,uom_code,parent_lot_id,lot_kind" + (",lot_id" if lot_id else "")
    vals = f"'{no}',{iid(pn)},{qty},'{uom}',{par},'{kind}'" + (f",{lot_id}" if lot_id else "")
    return f"INSERT INTO mat_lot({cols}) VALUES ({vals})"

def lotid(no): return f"(SELECT lot_id FROM mat_lot WHERE lot_no='{no}')"

def GEN(out, inn, proc="NULL", qty=1, uom="EA"):
    return (f"INSERT INTO lot_genealogy(out_lot_id,in_lot_id,process_id,qty_consumed,uom_code)"
            f" VALUES ({lotid(out)},{lotid(inn)},{proc},{qty},'{uom}')")


# ══════════════════════════════════════════════════════════════════════════
# 1. D-19 · uom_conv (식 인덱스) · R-7c
# ══════════════════════════════════════════════════════════════════════════
base = [I("SC-1011", "RM", "kg")]
add("C01", "D-19", "전역 환산 kg→g 는 초기값으로 이미 1행 — 같은 행 2번째 INSERT(item NULL)", [],
    "INSERT INTO uom_conv(from_uom,to_uom,factor) VALUES ('kg','g',1000)", "reject", "UNIQUE",
    note="v0.9 PK(식) 문법오류 → v1 식 인덱스 ux_uom_conv. NULL 이 0 으로 접혀 전역 중복이 잡혀야 한다")
add("C02", "D-19", "전역 환산 g→kg 0.001 (역방향 행)", [],
    "INSERT INTO uom_conv(from_uom,to_uom,factor) VALUES ('g','kg',0.001)", "accept",
    note="DDL 규칙은 '양방향을 두 행으로 넣지 않는다' 인데 DB 는 막지 않는다 → 의견(적재기 책임)")
add("C03", "R-7c", "품목 한정 환산 SHT→kg (SC-1011) — 차원 교차지만 item_id 지정", base,
    f"INSERT INTO uom_conv(from_uom,to_uom,factor,item_id) VALUES ('SHT','kg',0.010625,{iid('SC-1011')})", "accept")
add("C04", "R-7c", "전역 환산 EA→kg (COUNT↔MASS) — 차원 교차 전역", [],
    "INSERT INTO uom_conv(from_uom,to_uom,factor) VALUES ('EA','kg',2)", "reject", "R-7c")
add("C05", "D-19", "from_uom = to_uom", [],
    "INSERT INTO uom_conv(from_uom,to_uom,factor) VALUES ('EA','EA',1)", "reject", "CHECK")
add("C06", "D-19", "품목 한정 환산 같은 (from,to,item) 2번째", base + [
    f"INSERT INTO uom_conv(from_uom,to_uom,factor,item_id) VALUES ('SHT','kg',0.01,{iid('SC-1011')})"],
    f"INSERT INTO uom_conv(from_uom,to_uom,factor,item_id) VALUES ('SHT','kg',0.02,{iid('SC-1011')})", "reject", "UNIQUE")
add("C07", "D-19", "factor 0 (같은 차원 g→kg)", [],
    "INSERT INTO uom_conv(from_uom,to_uom,factor) VALUES ('g','kg',0)", "reject", "CHECK")
add("C08", "R-7c", "UPDATE 로 전역 환산을 차원 교차로", [
    "INSERT INTO uom_conv(from_uom,to_uom,factor) VALUES ('g','kg',0.001)"],
    "UPDATE uom_conv SET to_uom='EA' WHERE from_uom='g' AND to_uom='kg'", "reject", "R-7c")

# ══════════════════════════════════════════════════════════════════════════
# 2. R-1 순환 (D-3 D-4 D-1 D-5) — 핵심
# ══════════════════════════════════════════════════════════════════════════
for st in ("DRAFT", "APPROVED", "ACTIVE"):
    add(f"C10-{st[0]}", "R-1", f"자기참조 FS-7010→FS-7010 (header {st})", [I("FS-7010"), H("FS-7010", st)],
        L("FS-7010", "FS-7010"), "reject", "R-1")
for st in ("DRAFT", "APPROVED", "ACTIVE"):
    add(f"C11-{st[0]}", "R-1 D-3", f"A→B→A · 양쪽 header {st}", [I("A"), I("B"), H("A", st), H("B", st), L("A", "B")],
        L("B", "A"), "reject", "R-1", note="v0.9 는 DRAFT 에서 뚫렸다(D-3)")
add("C12", "R-1 D-4", "A→B→C→A · 중간 B 의 header 만 DRAFT",
    [I("A"), I("B"), I("C"), H("A"), H("B", "DRAFT"), H("C"), L("A", "B"), L("B", "C")], L("C", "A"), "reject", "R-1")
add("C12b", "R-1", "A→B→C→A · 중간 B 의 header 가 OBSOLETE 이면 구조상 순환이 아니다 (허용이 맞다)",
    [I("A"), I("B"), I("C"), H("A"), H("B", "OBSOLETE"), H("C"), L("A", "B"), L("B", "C")], L("C", "A"), "accept",
    note="OBSOLETE 는 제외가 설계. 되살리는 순간은 C18 이 막아야 한다")

def chain(n, status="ACTIVE", bottom_up=False):
    s = []
    for i in range(n): s += [I(f"X{i}")]
    for i in range(n): s += [H(f"X{i}", status)]
    rng = range(n - 2, -1, -1) if bottom_up else range(n - 1)
    for i in rng: s += [L(f"X{i}", f"X{i+1}")]
    return s

for n in (2, 3, 5, 10, 11, 12, 13, 20, 33, 63, 64, 65, 70):
    add(f"C13-{n:02d}", "R-1 D-1", f"순환 길이 {n} (X0→…→X{n-1}→X0), 전부 ACTIVE", chain(n), L(f"X{n-1}", "X0"), "reject", "R-1",
        note="v0.9 가드 depth<10 은 길이 12+ 통과(D-1). v1 은 64 + 한계 도달 RAISE")
add("C14a", "R-1 한계", "비순환 사슬 64간선(65노드) 을 아래서 위로 쌓기 — 마지막 X0→X1 INSERT 가 깊이 63 을 훑는다",
    chain(65, bottom_up=True)[:-1], L("X0", "X1"), "accept", note="깊이 한계 64 안쪽은 정상 데이터")
add("C14b", "R-1 한계", "비순환 사슬 65간선(66노드) 아래서 위로 — 깊이 64 도달 → 설계상 거부('깊이 64 초과')",
    chain(66, bottom_up=True)[:-1], L("X0", "X1"), "reject", "R-1",
    note="순환이 아닌데 거부된다 — R-2 최대 레벨 10 이 있으므로 실무 영향 없음. 메시지가 '순환 또는 깊이' 라 구분 불가(의견)")
add("C15", "R-1 D-5", "UPDATE bom_line.child_item_id 로 A→B→A 만들기",
    [I("A"), I("B"), I("Z"), H("A"), H("B"), L("A", "B"), L("B", "Z")],
    f"UPDATE bom_line SET child_item_id={iid('A')} WHERE line_id={lid('B','Z')}", "reject", "R-1")
add("C16", "R-1 D-5", "UPDATE bom_line.bom_id 로 라인을 다른 부모 밑으로 옮겨 순환",
    [I("A"), I("B"), I("Z"), H("A"), H("B"), H("Z"), L("A", "B"), L("Z", "A")],
    f"UPDATE bom_line SET bom_id={hid('B')} WHERE line_id={lid('Z','A')}", "reject", "R-1",
    note="Z→A 라인을 B 밑으로 옮기면 B→A→B")
add("C17", "R-1 헤더", "UPDATE bom_header.parent_item_id 로 순환 (B 의 BOM 을 A 가 소유하게)",
    [I("A"), I("B"), I("C"), H("A"), H("C"), L("A", "B"), L("C", "A")],
    f"UPDATE bom_header SET parent_item_id={iid('B')} WHERE bom_id={hid('C')}", "reject", "R-1",
    note="C 의 BOM(C→A) 부모를 B 로 바꾸면 B→A→B")
add("C18", "R-1 헤더", "OBSOLETE 헤더 되살리기(→ACTIVE) 로 순환 완성 — B(OBSOLETE)→A 가 먼저, 그 뒤 A→B(ACTIVE) 는 통과(잠복 순환)",
    [I("A"), I("B"), H("B", "OBSOLETE"), L("B", "A"), H("A"), L("A", "B")],
    f"UPDATE bom_header SET status='ACTIVE' WHERE bom_id={hid('B')}", "reject", "R-1",
    note="OBSOLETE 헤더 밑의 라인은 순환 검사에서 빠지므로 잠복 순환이 생길 수 있다 — 되살리는 순간 trg_bom_header_cycle_upd 가 막아야 한다")
add("C19", "R-1 거짓양성", "깊이 9 사슬 + 같은 자식(SHARED) 3부모 — 정상 데이터", chain(10) + [I("SHARED", "PT"), L("X0", "SHARED", no=90), L("X3", "SHARED", no=90)],
    L("X7", "SHARED", no=90), "accept")
add("C20", "R-1 거짓양성", "라인을 다른 부모로 옮기기(순환 아님) — 정상 UPDATE",
    [I("A"), I("B"), I("C"), I("Z"), H("A"), H("B"), L("A", "B"), L("A", "Z")],
    f"UPDATE bom_line SET bom_id={hid('B')} WHERE line_id={lid('A','Z')}", "accept")
add("C21", "R-1 거짓양성", "DRAFT rev B 를 같은 부모에 추가하고 라인 넣기 (ECO 준비)",
    [I("A"), I("B"), H("A"), L("A", "B"), H("A", "DRAFT", rev="B")], L("A", "B", rev="B"), "accept")

# ══════════════════════════════════════════════════════════════════════════
# 3. R-3 · R-9 · D-6 · D-7 (유효일자)
# ══════════════════════════════════════════════════════════════════════════
pc = [I("P"), I("C", "PT"), H("P")]
add("C30", "R-3", "같은 부모·자식·NULL그룹·같은 valid_from 2행", pc + [L("P", "C")], L("P", "C", no=20), "reject", ["R-9", "UNIQUE"],
    note="BEFORE INSERT 트리거(R-9)가 UNIQUE 인덱스보다 먼저 실행돼 메시지는 R-9 다. ux_bom_line_dup 는 2선 방어")
add("C31", "R-9", "같은 부모·자식, 시작일만 다르게 겹침 (01-01~ vs 03-01~)", pc + [L("P", "C")],
    L("P", "C", no=20, vf="2026-03-01"), "reject", "R-9")
add("C32", "R-9 거짓양성", "같은 부모·자식, 기간이 안 겹침 (~06-30 / 07-01~)", pc + [L("P", "C", vt="2026-06-30")],
    L("P", "C", no=20, vf="2026-07-01"), "accept")
add("C33", "R-9 D-7", "UPDATE 로 기간 겹침 만들기", pc + [L("P", "C", vt="2026-06-30"), L("P", "C", no=20, vf="2026-07-01")],
    f"UPDATE bom_line SET valid_from='2026-01-01' WHERE line_id=(SELECT line_id FROM bom_line WHERE line_no=20)", "reject", "R-9")
add("C34", "D-6", "bom_line valid_to < valid_from", pc, L("P", "C", vf="2026-12-31", vt="2026-01-01"), "reject", "CHECK")
add("C35", "D-6", "bom_header valid_to < valid_from", [I("Q")], H("Q", vf="2026-12-31", vt="2026-01-01"), "reject", "CHECK")
add("C36", "R-9 거짓양성", "같은 자식이 다른 대체그룹으로 겹침 — 허용(그룹이 다르면 다른 라인)",
    pc + [I("C2", "PT"), L("P", "C", alt="G1", prio=1)], L("P", "C", no=20, alt="G2", prio=1), "accept")

# ══════════════════════════════════════════════════════════════════════════
# 4. R-9b 헤더 겹침 (D-12)
# ══════════════════════════════════════════════════════════════════════════
add("C40", "R-9b D-12", "같은 부모에 ACTIVE rev A·B 가 같은 기간", [I("P"), H("P")], H("P", rev="B"), "reject", "R-9b")
add("C41", "R-9b 거짓양성", "DRAFT rev B 는 ACTIVE 와 겹쳐도 된다", [I("P"), H("P")], H("P", "DRAFT", rev="B"), "accept")
add("C42", "R-9b D-12", "DRAFT rev B 를 ACTIVE 로 승격 — 직전 rev 미종료", [I("P"), H("P"), H("P", "DRAFT", rev="B")],
    f"UPDATE bom_header SET status='ACTIVE' WHERE bom_id={hid('P','B')}", "reject", "R-9b")
add("C43", "R-9b 거짓양성", "직전 rev 의 valid_to 를 끊은 뒤 rev B 승격", [I("P"), H("P", vt="2026-06-30"), H("P", "DRAFT", rev="B", vf="2026-07-01")],
    f"UPDATE bom_header SET status='ACTIVE' WHERE bom_id={hid('P','B')}", "accept")
add("C44", "R-9b 거짓양성", "alt_no 가 다르면 겹쳐도 된다 (대체 BOM)", [I("P"), H("P")], H("P", alt="01"), "accept")
add("C45", "R-9b D-12", "APPROVED 와 ACTIVE 도 겹치면 안 된다", [I("P"), H("P", "APPROVED")], H("P", rev="B"), "reject", "R-9b")

# ══════════════════════════════════════════════════════════════════════════
# 5. D-13 대체 그룹
# ══════════════════════════════════════════════════════════════════════════
alt = [I("P"), I("M1", "PT"), I("M2", "PT"), H("P"), L("P", "M1", alt="MAG", prio=1)]
add("C50", "D-13", "같은 그룹·같은 우선순위(1,1) 같은 기간", alt, L("P", "M2", no=20, alt="MAG", prio=1), "reject", "D-13")
add("C51", "D-13 거짓양성", "같은 그룹·다른 우선순위(1,2) 동시 유효 — 대체품의 정의", alt, L("P", "M2", no=20, alt="MAG", prio=2), "accept",
    note="전개는 is_primary(최소 priority) 만 계상 — TC-44 가 확인")
add("C52", "D-13", "UPDATE 로 우선순위 중복 만들기", alt + [L("P", "M2", no=20, alt="MAG", prio=2)],
    f"UPDATE bom_line SET alt_priority=1 WHERE line_id={lid('P','M2')}", "reject", "D-13")
add("C53", "D-13", "alt_group 만 있고 alt_priority NULL", alt, L("P", "M2", no=20, alt="MAG"), "reject", "CHECK")
add("C54", "D-13", "alt_priority 0", alt, L("P", "M2", no=20, alt="MAG", prio=0), "reject", "CHECK")
add("C55", "D-13", "같은 우선순위(1,1), M2 는 2027 부터 — M1 이 9999 까지라 겹친다", alt,
    L("P", "M2", no=20, alt="MAG", prio=1, vf="2027-01-01"), "reject", "D-13")
add("C56", "D-13 거짓양성", "M1 을 2026-12-31 로 끊고 M2(1) 를 2027 부터", alt[:-1] + [L("P", "M1", alt="MAG", prio=1, vt="2026-12-31")],
    L("P", "M2", no=20, alt="MAG", prio=1, vf="2027-01-01"), "accept")

# ══════════════════════════════════════════════════════════════════════════
# 6. R-7 · R-8 · R-7b · R-14 · R-20 · R-6 (D-20)
# ══════════════════════════════════════════════════════════════════════════
u = [I("P"), I("E", "PT", "EA"), I("K", "RM", "kg"), I("S", "SA", "SHT"), H("P")]
add("C60", "R-7 D-20", "자식 base_uom EA 인데 라인 단위 g (환산 없음)", u, L("P", "E", uom="g"), "reject", "R-7")
add("C61", "R-7 거짓양성", "자식 kg 인데 라인 g — 전역 kg→g 환산 있음", u, L("P", "K", qty=850, uom="g"), "accept")
add("C62a", "R-7", "자식 kg 인데 라인 SHT — 환산 없음", u, L("P", "K", qty=80, uom="SHT"), "reject", "R-7")
add("C62b", "R-7 거짓양성", "자식 kg 인데 라인 SHT — 품목 한정 SHT→kg 환산 있음",
    u + [f"INSERT INTO uom_conv(from_uom,to_uom,factor,item_id) VALUES ('SHT','kg',0.01,{iid('K')})"],
    L("P", "K", qty=80, uom="SHT"), "accept")
add("C62c", "R-7", "품목 한정 환산이 **다른 품목**용이면 안 된다",
    u + [f"INSERT INTO uom_conv(from_uom,to_uom,factor,item_id) VALUES ('SHT','kg',0.01,{iid('E')})"],
    L("P", "K", qty=80, uom="SHT"), "reject", "R-7")
add("C63", "R-8 D-20", "0.5 EA (decimals 0)", u, L("P", "E", qty=0.5), "reject", "R-8")
add("C64a", "R-8", "0.0001 kg (decimals 3)", u, L("P", "K", qty=0.0001, uom="kg"), "reject", "R-8")
add("C64b", "R-8 거짓양성", "0.85 kg (decimals 3)", u, L("P", "K", qty=0.85, uom="kg"), "accept")
add("C64c", "R-8 거짓양성", "0.5 g (decimals 2)", u + [I("G", "CN", "g")], L("P", "G", qty=0.5, uom="g"), "accept")
add("C65", "R-8 D-20", "UPDATE qty_per → 0.5 EA", u + [L("P", "E")],
    f"UPDATE bom_line SET qty_per=0.5 WHERE line_id={lid('P','E')}", "reject", "R-8")
add("C65b", "R-7 D-20", "UPDATE uom_code → g (자식 EA)", u + [L("P", "E")],
    f"UPDATE bom_line SET uom_code='g' WHERE line_id={lid('P','E')}", "reject", "R-7")
add("C66", "R-7b", "bom_header.base_uom(kg) ≠ 부모 item.base_uom(EA)", [I("P")], H("P", uom="kg"), "reject", "R-7b")
add("C66b", "R-7b", "UPDATE bom_header.base_uom 을 다른 단위로", [I("P"), H("P")],
    f"UPDATE bom_header SET base_uom='g' WHERE bom_id={hid('P')}", "reject", "R-7b")
add("C67", "R-14", "비말단 분류(is_leaf=0)에 품목", [], I("N1", cls=2), "reject", "R-14")
add("C67b", "R-14", "UPDATE class_id 를 비말단으로", [I("N1")], f"UPDATE item SET class_id=2 WHERE pn='N1'", "reject", "R-14")
add("C68a", "R-20", "pn 에 '/' (HA-3000/EX-5000)", [], I("HA-3000/EX-5000"), "reject", "CHECK")
add("C68b", "R-20", "pn 에 공백", [], I("HA 3000"), "reject", "CHECK")
add("C68c", "R-20", "pn 33자", [], I("X" * 33), "reject", "CHECK")
add("C69a", "R-6", "qty_per 0", u, L("P", "E", qty=0), "reject", "CHECK")
add("C69b", "R-6", "qty_per 음수", u, L("P", "E", qty=-1), "reject", "CHECK")
add("C69c", "R-6", "scrap_pct 100 (0 나눗셈)", u, L("P", "E", scrap=100), "reject", "CHECK")
add("C69d", "R-6", "scrap_pct 음수", u, L("P", "E", scrap=-5), "reject", "CHECK")
add("C69e", "R-6", "base_qty 0", [I("Q")], H("Q", base_qty=0), "reject", "CHECK")
add("C70", "D-8", "bop_link NONE 인데 note 없음", u, L("P", "E", bop="NONE"), "reject", "CHECK")
add("C70b", "D-8 거짓양성", "bop_link NONE + note 사유", u, L("P", "E", bop="NONE", note="사급"), "accept")
add("C71", "item", "item_type 범위 밖 'XX'", [], I("Q", "XX"), "reject", "CHECK")
add("C72", "item", "status 범위 밖", [], I("Q", status="DELETED"), "reject", "CHECK")
add("C73", "item", "base_uom 코드표에 없는 '말'", [], I("Q", uom="말"), "reject", "FOREIGN KEY")

# ══════════════════════════════════════════════════════════════════════════
# 7. D-8 팬텀 ↔ bop_link · process_material 정합 · R-22
# ══════════════════════════════════════════════════════════════════════════
ph = PROC + [I("FG", "FG"), I("HA", "SA", ph=1), I("HS", "PT"), I("SA", "SA"), H("FG"), H("HA"), H("SA")]
add("C80", "D-8", "팬텀 아닌 자식에 bop_link=PHANTOM", ph, L("FG", "SA", bop="PHANTOM"), "reject", "D-8")
add("C81", "D-8 자동", "팬텀 자식 라인은 bop_link 를 안 써도 PHANTOM 으로 자동 설정", ph, L("FG", "HA"), "accept",
    post=dict(sql=f"SELECT bop_link FROM bom_line WHERE line_id={lid('FG','HA')}", expect="PHANTOM"))
add("C82", "D-8", "PHANTOM 라인에 IN 행", ph + [L("FG", "HA")], PM_IN(1, "FG", "HA"), "reject", "D-8")
add("C82b", "D-8", "NONE 라인에 IN 행", ph + [L("FG", "SA", bop="NONE", note="사급")], PM_IN(1, "FG", "SA"), "reject", "D-8")
add("C83", "V12-7", "팬텀 품목에 OUT 행", ph, PM_OUT(1, "HA"), "reject", "V12-7")
add("C84", "D-8", "IN 행이 있는 품목을 팬텀으로 바꾸기", ph + [L("FG", "SA"), PM_IN(1, "FG", "SA")],
    "UPDATE item SET is_phantom=1 WHERE pn='SA'", "reject", "D-8")
add("C84b", "D-8", "OUT 행이 있는 품목을 팬텀으로 바꾸기", ph + [PM_OUT(1, "SA")],
    "UPDATE item SET is_phantom=1 WHERE pn='SA'", "reject", "D-8")
add("C85", "D-8 자동", "IN/OUT 없는 품목을 팬텀으로 바꾸면 그 라인이 PHANTOM 으로 따라간다", ph + [L("FG", "SA")],
    "UPDATE item SET is_phantom=1 WHERE pn='SA'", "accept",
    post=dict(sql=f"SELECT bop_link FROM bom_line WHERE line_id={lid('FG','SA')}", expect="PHANTOM"))
add("C85b", "D-8 자동", "팬텀 해제(1→0) 하면 라인이 REQUIRED 로 돌아온다", ph + [L("FG", "HA")],
    "UPDATE item SET is_phantom=0 WHERE pn='HA'", "accept",
    post=dict(sql=f"SELECT bop_link FROM bom_line WHERE line_id={lid('FG','HA')}", expect="REQUIRED"))
add("C86a", "PM CHECK", "IN 행에 line_id 없음", ph, "INSERT INTO process_material(process_id,io) VALUES (1,'IN')", "reject", "CHECK")
add("C86b", "PM CHECK", "OUT is_final=0 인데 out_state 없음", ph, PM_OUT(1, "SA", final=0), "reject", "CHECK")
add("C86c", "PM CHECK", "IN 행에 item_id 도 같이", ph + [L("FG", "SA")],
    f"INSERT INTO process_material(process_id,io,line_id,item_id) VALUES (1,'IN',{lid('FG','SA')},{iid('SA')})", "reject", "CHECK")
add("C86d", "PM", "split_pct 0 / 101", ph + [L("FG", "SA")], PM_IN(1, "FG", "SA", split=101), "reject", "CHECK")
add("C87", "PM UNIQUE", "같은 (공정, 라인) IN 2번", ph + [L("FG", "SA"), PM_IN(1, "FG", "SA")], PM_IN(1, "FG", "SA"), "reject", "UNIQUE")
add("C87b", "PM 거짓양성", "같은 라인을 두 공정에 50/50 분할 투입", ph + [L("FG", "SA"), PM_IN(1, "FG", "SA", 50)], PM_IN(2, "FG", "SA", 50), "accept")
# R-22: SA 의 자식 HS 를 OP-3 에 투입하는데 SA 는 OP-2 에서 산출(is_final) → seq 3 > 2 (같은 라인 L1)
r22 = ph + [L("SA", "HS"), PM_OUT(2, "SA")]
add("C90", "R-22", "자식 IN seq(3) > 부모 OUT seq(2), 같은 라인", r22, PM_IN(3, "SA", "HS"), "reject", "R-22")
add("C90b", "R-22 거짓양성", "자식 IN seq(1) ≤ 부모 OUT seq(2)", r22, PM_IN(1, "SA", "HS"), "accept")
add("C90c", "R-22 거짓양성", "자식 IN seq 가 크지만 다른 라인(L9) — 경고 뷰 몫, 트리거는 허용", r22, PM_IN(9, "SA", "HS"), "accept",
    post=dict(sql="SELECT count(*) FROM v_chk_r22_seq", expect="1"))
add("C91", "R-22", "OUT(is_final) 을 넣는데 이미 더 늦은 IN 이 있다", ph + [L("SA", "HS"), PM_IN(3, "SA", "HS")], PM_OUT(2, "SA"), "reject", "R-22")
add("C91b", "R-22 거짓양성", "OUT is_final=0(진행 상태) 은 seq 검사 대상이 아니다", ph + [L("SA", "HS"), PM_IN(3, "SA", "HS")],
    PM_OUT(2, "SA", final=0, state="진행"), "accept")
add("C92", "R-22 UPD", "UPDATE 로 IN 공정을 늦은 공정으로 옮기기", r22 + [PM_IN(1, "SA", "HS")],
    f"UPDATE process_material SET process_id=3 WHERE io='IN' AND line_id={lid('SA','HS')}", "reject", "R-22")

# ══════════════════════════════════════════════════════════════════════════
# 8. R-13 로트 계보 (D-14 D-15 D-16 D-17)
# ══════════════════════════════════════════════════════════════════════════
lots = [I("A", "PT"), LOT("LA", "A"), LOT("LB", "A"), LOT("LC", "A")]
add("C100", "R-13 D-14", "lot_genealogy 자기참조 (in = out)", lots, GEN("LA", "LA"), "reject", ["R-13", "CHECK"],
    note="트리거(depth 0 에서 out=in 발견)가 CHECK 보다 먼저 실행돼 메시지는 R-13. CHECK 는 2선 방어")
add("C101", "R-13 D-15", "계보 순환: LA→LB 있는데 LB→LA", lots + [GEN("LB", "LA")], GEN("LA", "LB"), "reject", "R-13")
add("C102", "R-13 D-15", "분할+투입 섞인 순환: LA 분할→LA1, LA1 투입→LB, LB 투입→LA",
    lots + [LOT("LA1", "A", parent="LA", kind="SUBLOT"), GEN("LB", "LA1")], GEN("LA", "LB"), "reject", "R-13")
add("C103", "R-13 D-15", "분할 순환: LA 의 부모를 자기 서브로트 LA1 로 UPDATE",
    lots + [LOT("LA1", "A", parent="LA", kind="SUBLOT")],
    f"UPDATE mat_lot SET parent_lot_id={lotid('LA1')} WHERE lot_no='LA'", "reject", "R-13")
add("C103b", "R-13 D-15", "분할 순환(투입 경유): LA 투입→LB, LB 의 부모를 LA 의 서브로트로… → LA 의 부모를 LB 로 UPDATE",
    lots + [GEN("LB", "LA")], f"UPDATE mat_lot SET parent_lot_id={lotid('LB')} WHERE lot_no='LA'", "reject", "R-13")
add("C104", "R-13", "mat_lot 자기 분할 (parent = self)", lots,
    f"UPDATE mat_lot SET parent_lot_id=lot_id WHERE lot_no='LA'", "reject", ["R-13", "CHECK"])
add("C104b", "R-13 INSERT", "INSERT 시 parent_lot_id 가 자기 하류 — 새 lot_id 를 명시(=100)해도 하류에 100 은 없다",
    lots, LOT("LX", "A", parent="LA", lot_id=100), "accept",
    note="trg_lot_split_cycle_ins 는 INSERT 에서 실질적으로 발동 조건이 없다(새 로트는 누구의 하류도 아님). 죽은 코드지만 무해 → 의견")
add("C105", "R-13 UPD", "UPDATE lot_genealogy 로 순환 (LB→LC 를 LB→LA 로… in_lot 을 바꿔서)",
    lots + [GEN("LB", "LA"), GEN("LC", "LB")],
    f"UPDATE lot_genealogy SET in_lot_id={lotid('LC')} WHERE out_lot_id={lotid('LA')} OR (out_lot_id={lotid('LB')} AND in_lot_id={lotid('LA')})",
    "reject", "R-13", note="LB←LA 를 LB←LC 로 바꾸면 LC←LB←LC")
add("C106", "D-16", "같은 계보 간선 2번 (process_id NULL)", lots + [GEN("LB", "LA")], GEN("LB", "LA"), "reject", "UNIQUE")
add("C106b", "D-16", "같은 계보 간선 2번 (process_id 지정)", PROC + lots + [GEN("LB", "LA", proc=1)], GEN("LB", "LA", proc=1), "reject", "UNIQUE")
add("C106c", "D-16 거짓양성", "같은 로트 쌍이지만 다른 공정 — 허용(재투입)", PROC + lots + [GEN("LB", "LA", proc=1)], GEN("LB", "LA", proc=2), "accept")
add("C107", "R-13 길이", "계보 순환 길이 70 (선형 70 간선 뒤 되돌아오기)",
    [I("A", "PT")] + [LOT(f"L{i}", "A") for i in range(70)] + [GEN(f"L{i+1}", f"L{i}") for i in range(69)],
    GEN("L0", "L69"), "reject", "R-13")
add("C108", "D-17", "qty_init 이 qty 로 자동 채워진다", [I("A", "PT")], LOT("LA", "A", qty=850), "accept",
    post=dict(sql="SELECT qty_init FROM mat_lot WHERE lot_no='LA'", expect="850.0"))
add("C109", "D-17", "qty_init UPDATE", lots, "UPDATE mat_lot SET qty_init=1 WHERE lot_no='LA'", "reject", "D-17")
add("C109b", "D-17 거짓양성", "qty(현재 수량) UPDATE 는 된다 (차감은 서비스 계층)", lots, "UPDATE mat_lot SET qty=3 WHERE lot_no='LA'", "accept",
    post=dict(sql="SELECT count(*) FROM v_chk_lot_qty", expect="1"), note="qty 만 줄이고 계보가 없으면 v_chk_lot_qty 가 잡는다")
add("C110", "lot CHECK", "SERIAL 인데 qty 2", [I("A", "PT")], LOT("SN1", "A", qty=2, kind="SERIAL"), "reject", "CHECK")
add("C111", "lot CHECK", "qty 음수", [I("A", "PT")], LOT("LN", "A", qty=-1), "reject", "CHECK")
add("C112", "lot", "lot_no 중복", lots, LOT("LA", "A"), "reject", "UNIQUE")
add("C113", "gen CHECK", "qty_consumed 0", lots, GEN("LB", "LA", qty=0), "reject", "CHECK")

# ══════════════════════════════════════════════════════════════════════════
# 9. R-11 삭제 금지 · 기타
# ══════════════════════════════════════════════════════════════════════════
add("C120", "R-11", "DELETE item", [I("A")], "DELETE FROM item WHERE pn='A'", "reject", "R-11")
add("C121", "R-11", "DELETE bom_header", [I("A"), H("A")], f"DELETE FROM bom_header WHERE bom_id={hid('A')}", "reject", "R-11")
add("C122", "R-11", "DELETE bom_line (header ACTIVE)", [I("A"), I("B"), H("A"), L("A", "B")], f"DELETE FROM bom_line WHERE line_id={lid('A','B')}", "reject", "R-11")
add("C122b", "R-11 거짓양성", "DELETE bom_line (header DRAFT) — 허용", [I("A"), I("B"), H("A", "DRAFT"), L("A", "B")],
    f"DELETE FROM bom_line WHERE line_id={lid('A','B')}", "accept")
add("C123", "eco", "요청자 = 승인자", ["INSERT INTO users(id,emp_no,name) VALUES (7,'E7','x')"],
    "INSERT INTO eco(eco_no,title,reason,requested_by,approved_by) VALUES ('ECO-1','t','품질',7,7)", "reject", "CHECK")
add("C124", "mat_class", "분류 자기 부모", ["INSERT INTO mat_class(class_id,class_code,name) VALUES (9,'SELF','x')"],
    "UPDATE mat_class SET parent_class_id=9 WHERE class_id=9", "reject", "CHECK")
add("C125", "uom", "차원별 기준단위 2개", [], "INSERT INTO uom(uom_code,name_ko,dim,decimals,is_base) VALUES ('PCS','개','COUNT',0,1)", "reject", "UNIQUE")


def main():
    path = os.path.join(C.HERE, "cases.json")
    json.dump(dict(_about="v1.0 반례 배터리 — python·node 공용 (v1_cases.py 가 생성)", count=len(CASES), cases=CASES),
              open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    groups = {}
    for c in CASES: groups[c["group"].split()[0]] = groups.get(c["group"].split()[0], 0) + 1
    print(f"cases.json — {len(CASES)} 건 · reject {sum(1 for c in CASES if c['expect']=='reject')} · accept {sum(1 for c in CASES if c['expect']=='accept')}")
    print(groups)


if __name__ == "__main__":
    main()
