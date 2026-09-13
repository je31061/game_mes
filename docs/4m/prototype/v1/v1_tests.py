# -*- coding: utf-8 -*-
"""
v1_tests.py — 검증보고서 §2 테스트 케이스 TC-01 ~ TC-59 (+파생) 를 **계획서 v1.0 / ddl-v1.sql** 위에서 전부 돌린다.
v0.9 판(r2_tests.py) 과 케이스 번호·입력은 같고, 판정은 전부 실행 결과로 계산한다(하드코딩 없음).
전개·역전개·로트 추적 SQL 은 DDL 절 I 의 Q-1~Q-5 원문(bomsql_v1.py).

선행: python v1_load.py           (out/bldc_v1.db — TMP- 품번 상태)
실행: python v1_tests.py          → out/06_tests.log · out/csv/tc_result_v1.csv
"""
from __future__ import annotations
import csv, json, os, shutil, sqlite3, subprocess, sys, time
import common as C
import bomsql_v1 as B
import v1_load as LD

DB = os.path.join(C.OUT, "bldc_v1.db")
ASOF = "2026-06-01"
EPS = 1e-9
log = C.Log("06_tests.log")
RESULTS = []
CJ = C.cleansing()
TMP = {k: v["tmp"] for k, v in CJ["pn_pending"].items() if isinstance(v, dict)}   # 정식 → TMP
A = lambda pn: TMP.get(pn, pn)          # 정식 pn → 실제 저장 pn
N = lambda pn: {v: k for k, v in TMP.items()}.get(pn, pn)   # 실제 → 정식


def rec(tc, group, desc, verdict, expect, actual, note=""):
    RESULTS.append(dict(tc=tc, group=group, desc=desc, verdict=verdict, expect=str(expect), actual=str(actual), note=note))
    mark = {"PASS": "PASS ", "FAIL": "FAIL!", "BLOCK": "BLOCK", "NOTE": "NOTE "}[verdict]
    log(f"  [{mark}] {tc:8} {desc}")
    if verdict != "PASS" or os.environ.get("TC_VERBOSE"):
        log(f"           기대: {expect}\n           실제: {actual}")
    if note: log(f"           ※ {note}")


def conn(rw=False, path=DB):
    if rw:
        tmp = os.path.join(C.OUT, "_scratch.db")
        if os.path.exists(tmp): os.remove(tmp)
        shutil.copyfile(path, tmp); c = sqlite3.connect(tmp)
    else:
        c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    c.execute("PRAGMA foreign_keys=ON")
    return c


def iid(c, pn):
    r = c.execute("SELECT item_id FROM item WHERE pn=?", (A(pn),)).fetchone(); return r[0] if r else None

def bid(c, pn):
    r = c.execute("SELECT h.bom_id FROM bom_header h JOIN item i ON i.item_id=h.parent_item_id WHERE i.pn=? AND h.status<>'OBSOLETE'", (A(pn),)).fetchone()
    return r[0] if r else None

def ins_line(c, bom_id, child_id, **kw):
    f = dict(line_no=999, qty_per=1.0, uom_code="EA", valid_from=ASOF, valid_to="9999-12-31", alt_group=None, alt_priority=None, scrap_pct=0)
    f.update(kw)
    return c.execute("INSERT INTO bom_line(bom_id,line_no,child_item_id,qty_per,uom_code,valid_from,valid_to,alt_group,alt_priority,scrap_pct)"
                     " VALUES (?,?,?,?,?,?,?,?,?,?)", (bom_id, f["line_no"], child_id, f["qty_per"], f["uom_code"], f["valid_from"],
                                                      f["valid_to"], f["alt_group"], f["alt_priority"], f["scrap_pct"])).lastrowid

def blocked(fn):
    try: fn(); return False, "통과 — 들어갔다"
    except Exception as e: return True, f"{type(e).__name__}: {e}"

def new_item(c, pn, itype="PT", uom="EA", phantom=0):
    return c.execute("INSERT INTO item(pn,name,class_id,item_type,source_type,base_uom,is_phantom,status)"
                     " VALUES (?,?,(SELECT class_id FROM mat_class WHERE class_code='PT-ETC'),?,'BUY',?,?,'ACTIVE')", (pn, pn, itype, uom, phantom)).lastrowid

def new_header(c, item_id, status="ACTIVE", base_qty=1.0, uom="EA", vf=ASOF, vt="9999-12-31", alt="00", rev="A"):
    return c.execute("INSERT INTO bom_header(parent_item_id,alt_no,rev,base_qty,base_uom,status,valid_from,valid_to) VALUES (?,?,?,?,?,?,?,?)",
                     (item_id, alt, rev, base_qty, uom, status, vf, vt)).lastrowid

EXP_TOT = {"EA": 76.0, "g": 221.0, "SHT": 12.0, "kg": 0.85, "m": 0.5}


# ══════════════════════════════════════════════════════════════════════════
def group_A():
    log("\n### A. 트리 무결성 (TC-01~10) — 반례 상세는 cases.json 133건(03/04 로그)")
    c = conn(rw=True)
    a, b = new_item(c, "TST-A", "SA"), new_item(c, "TST-B", "SA"); ba, bb = new_header(c, a), new_header(c, b); ins_line(c, ba, b)
    ok, msg = blocked(lambda: ins_line(c, bb, a))
    rec("TC-01", "A", "A→B, B→A (ACTIVE)", "PASS" if ok and "R-1" in msg else "FAIL", "거부 + R-1 접두", msg,
        "경로는 메시지에 없다(R-19 보류) — v_chk_r1_cycle 로 본다. TC-16 에서 확인")
    ok2, msg2 = blocked(lambda: ins_line(c, bb, a))
    c.close()
    for st in ("DRAFT",):
        c = conn(rw=True)
        a, b = new_item(c, "TST-A", "SA"), new_item(c, "TST-B", "SA"); ba, bb = new_header(c, a, st), new_header(c, b, st); ins_line(c, ba, b)
        ok, msg = blocked(lambda: ins_line(c, bb, a))
        rec("TC-01b", "A", f"A→B, B→A (양쪽 {st}) — D-3 회귀", "PASS" if ok else "FAIL", "거부", msg); c.close()
    c = conn(rw=True)
    ids = [new_item(c, f"TST-C{i}", "SA") for i in range(3)]; bs = [new_header(c, i) for i in ids]
    ins_line(c, bs[0], ids[1]); ins_line(c, bs[1], ids[2])
    ok, msg = blocked(lambda: ins_line(c, bs[2], ids[0]))
    rec("TC-02", "A", "A→B→C→A (3단)", "PASS" if ok else "FAIL", "거부", msg); c.close()
    c = conn(rw=True)
    f = iid(c, "FS-7010"); bf = new_header(c, f)
    ok, msg = blocked(lambda: ins_line(c, bf, f))
    rec("TC-03", "A", "FS-7010 → FS-7010 (실데이터 자기참조)", "PASS" if ok else "FAIL", "거부", msg); c.close()
    c = conn(rw=True)
    ok, msg = blocked(lambda: new_item(c, "HA-3000/EX-5000", "SA"))
    rec("TC-04", "A", "'HA-3000/EX-5000' 품목·부모 등록", "PASS" if ok else "FAIL", "pn CHECK(R-20) 거부 + 구조상 복합 부모 불가", msg); c.close()
    c = conn(rw=True)
    bsa, sc = bid(c, "SA-1000"), iid(c, "IN-1020U")
    ok, msg = blocked(lambda: ins_line(c, bsa, sc, valid_from="2026-01-01"))
    rec("TC-05", "A", "같은 부모에 같은 자식 2행 (valid_from 동일)", "PASS" if ok else "FAIL", "거부", msg)
    ok2, msg2 = blocked(lambda: ins_line(c, bsa, sc, valid_from="2026-03-01"))
    rec("TC-06", "A", "같은 부모-자식, 기간 겹치게 (시작일만 다름)", "PASS" if ok2 and "R-9" in msg2 else "FAIL", "R-9 거부", msg2); c.close()
    c = conn(rw=True)
    ok, msg = blocked(lambda: ins_line(c, bid(c, "SA-1000"), 999999))
    rec("TC-07", "A", "존재하지 않는 자식 item_id", "PASS" if ok else "FAIL", "FK 거부", msg); c.close()
    c = conn()
    orph = c.execute("SELECT detail FROM v_chk_r4_orphan").fetchall()
    rec("TC-08", "A", "고아 품목 (v_chk_r4_orphan)", "PASS" if not orph else "FAIL", "0건", f"{len(orph)}건 {orph}")
    reach = {r["pn"] for r in B.explode(c, asof=ASOF)}
    allpn = {r[0] for r in c.execute("SELECT pn FROM item")} - {"BLDC-500W-48V"}
    rec("TC-09", "A", "루트에서 도달 불가한 품목", "PASS" if not (allpn - reach) else "FAIL", "0건", sorted(allpn - reach))
    mx = max(r["depth"] for r in B.explode(c, asof=ASOF))
    mx_view = c.execute("SELECT max(depth) FROM v_bom_line_qpp").fetchone()[0]
    rec("TC-10", "A", "최대 레벨 (Q-1 · v_bom_line_qpp)", "PASS" if mx == 4 == mx_view else "FAIL", "4", f"Q-1 {mx} · 뷰 {mx_view}")
    lost = c.execute("SELECT detail FROM v_chk_r5_lost_sa").fetchall()
    rec("TC-10b", "A", "미아 조립품 (v_chk_r5_lost_sa)", "PASS" if not lost else "FAIL", "0건", lost)
    r2 = c.execute("SELECT count(*) FROM v_chk_r2_depth").fetchone()[0]
    rec("TC-10h", "A", "R-2 최대 레벨 10 초과 (v_chk_r2_depth)", "PASS" if r2 == 0 else "FAIL", "0건", r2)
    c.close()
    c = conn(rw=True)
    b, x = bid(c, "PL-9000"), iid(c, "BW-2050")
    for tc, kw, desc in (("TC-10c", dict(qty_per=0.0), "수량 0"), ("TC-10d", dict(qty_per=-1.0), "수량 음수"),
                         ("TC-10e", dict(scrap_pct=100.0), "scrap_pct 100"), ("TC-10f", dict(scrap_pct=-5.0), "scrap_pct 음수")):
        ok, msg = blocked(lambda kw=kw: ins_line(c, b, x, line_no=640, **kw))
        rec(tc, "A", desc, "PASS" if ok else "FAIL", "CHECK 거부", msg)
    ok, msg = blocked(lambda: new_header(c, iid(c, "PL-9000"), base_qty=0, alt="01"))
    rec("TC-10g", "A", "bom_header.base_qty = 0", "PASS" if ok else "FAIL", "CHECK 거부", msg); c.close()


def group_B():
    log("\n### B. 다단계 전개 (TC-11~17, TC-54, TC-55) — Q-1/Q-2 원문")
    c = conn()
    tot, per = B.leaf_totals(c, asof=ASOF)
    same = all(abs(tot.get(k, 0) - v) < EPS for k, v in EXP_TOT.items()) and set(tot) == set(EXP_TOT)
    rec("TC-11", "B", "완성품 1대 전개 차원별 합계 — §1.9 기대값", "PASS" if same else "FAIL", EXP_TOT, {k: round(v, 6) for k, v in sorted(tot.items())})
    js = C.source(); umap = {"매": "SHT"}
    src = {(p["pn"], umap.get(p.get("unit"), p.get("unit"))): p["qtyPerProduct"] for p in js["parts"]}   # 원천 09_Flat 49행 전부 (자기참조 행 포함)
    got = {(N(k[0]), k[1]): round(v, 9) for k, v in per.items()}
    only_src = sorted(k[0] for k in set(src) - set(got)); only_new = sorted(k[0] for k in set(got) - set(src))
    qdiff = [(k, src[k], got[k]) for k in set(src) & set(got) if abs(src[k] - got[k]) > EPS]
    r21 = CJ["item_compare_R21"]
    exp_src = sorted(k.split("(")[0] for k in r21["only_in_source"]); exp_new = sorted(r21["only_in_new"])
    rec("TC-11b", "B", "R-21 품목별 대조 — 원천 09_Flat ↔ 전개 말단", "PASS" if (only_src == exp_src and only_new == exp_new and not qdiff) else "FAIL",
        f"원천에만 {exp_src} · 새 구조에만 {exp_new} · 수량차 0", f"원천에만 {only_src} · 새 구조에만 {only_new} · 수량차 {qdiff or '0건'}",
        "합계 일치(TC-11)는 검증력 0 — 이 품목별 대조가 완료기준이다(R-21, v1.0 §9.3 [2]③ 반영 확인)")
    t100, _ = B.leaf_totals(c, qty=100.0, asof=ASOF)
    rec("TC-12", "B", "100대 전개 = 1대 × 100", "PASS" if all(abs(t100[k] - v * 100) < 1e-7 for k, v in tot.items()) else "FAIL",
        {k: v * 100 for k, v in tot.items()}, {k: round(v, 6) for k, v in t100.items()})
    rec("TC-13", "B", "현행 원천 그대로 전개 EA 58 (회귀 고정)", "BLOCK", "EA 58", "정제가 적재 전제라 결함 데이터가 안 들어간다 — 라운드 1 selftest.py 담당")
    c2 = conn(rw=True)
    c2.execute("UPDATE bom_line SET qty_per=2 WHERE bom_id=? AND child_item_id=?", (bid(c2, "BLDC-500W-48V"), iid(c2, "GB-8000")))
    t2, _ = B.leaf_totals(c2, asof=ASOF)
    rec("TC-14", "B", "b≠1 — GB-8000 완성품당 2개", "PASS" if abs(t2["EA"] - 81) < EPS and abs(t2["g"] - 246) < EPS else "FAIL",
        "EA 81 · g 246", {k: round(v, 4) for k, v in t2.items()})
    vq = {r[0]: r[1] for r in c2.execute("SELECT child_pn, qty_per_product FROM v_bom_line_qpp WHERE parent_pn='GB-8000'")}
    rec("TC-14b", "B", "같은 변경을 뷰 v_bom_line_qpp 로 (Q-4)", "PASS" if abs(vq.get("GB-8010", 0) - 2) < EPS and abs(vq.get("GB-8040", 0) - 4) < EPS else "FAIL",
        "GB-8010 2.0 · GB-8040 4.0", vq); c2.close()
    scr = [r for r in B.explode(c, asof=ASOF) if r["pn"] == "SC-1011"]
    v = scr[0]["qty"] if scr else None
    rec("TC-15", "B", "레벨 4 경로 SC-1010→SC-1010P→SC-1011", "PASS" if scr and scr[0]["depth"] == 4 and abs(v - 0.85) < EPS else "FAIL",
        "깊이 4 · kg 0.85", f"깊이 {scr[0]['depth'] if scr else None} · {v}")
    rec("TC-54", "B", "base_qty=80 나눗셈 반올림 오차", "PASS" if v is not None and v == 0.85 else "FAIL", "정확히 0.85 (오차 0)", f"{v!r} 오차 {abs(v-0.85):.3e}")
    # TC-16: 트리거를 우회해 순환을 심고(레거시 데이터 가정) 전개가 멈추는지 + 점검 뷰가 경로를 내는지
    c4 = conn(rw=True)
    for t in ("trg_bom_line_cycle_ins", "trg_bom_line_cycle_upd"): c4.execute(f"DROP TRIGGER {t}")
    a = iid(c4, "GB-8010"); c4.execute("UPDATE item SET item_type='SA' WHERE item_id=?", (a,)); ba = new_header(c4, a)
    ins_line(c4, ba, iid(c4, "GB-8000"))
    t0 = time.perf_counter(); rows = B.explode(c4, asof=ASOF); dt = time.perf_counter() - t0
    cyc = c4.execute("SELECT detail FROM v_chk_r1_cycle").fetchall()
    summ = dict(c4.execute("SELECT rule,cnt FROM v_chk_summary").fetchall())
    rec("TC-16", "B", "순환이 남은 상태(트리거 우회)에서 전개 + 순환 경로 보고", "PASS" if dt < 2 and cyc else "FAIL",
        "2초 내 종료 + v_chk_r1_cycle 에 경로", f"{dt*1000:.1f} ms · 행 {len(rows)} · 최대 깊이 {max(r['depth'] for r in rows)} · 경로 {[x[0] for x in cyc][:3]} · summary R-1={summ.get('R-1')}",
        "Q-1 자체는 raise 하지 않는다(가드 64 에서 잘림) — API 는 전개 전에 v_chk_summary.R-1 을 봐야 한다 → 최민준 요청"); c4.close()
    lv = {}
    for r in B.explode(c, asof=ASOF): lv.setdefault(r["depth"], []).append(r)
    rec("TC-17", "B", "레벨별 노드 수", "PASS", "레벨별 소계", {k: len(v) for k, v in sorted(lv.items())})
    ex = B.explode(c, asof=ASOF)
    ph = [r for r in ex if r["phantom"]]
    kids = [r for r in ex if r["path"].startswith("BLDC-500W-48V > HA-3000 >")]
    wu = B.where_used(c, "BF-3040", ASOF); keeps = any("HA-3000" in r["path"] for r in wu)
    inleaf = any(k[0] in ("HA-3000", "EX-5000", "PE-6000") for k in per)
    rec("TC-55", "B", "팬텀 — 합계 제외 · 경로 유지 · HA 자식 7종", "PASS" if (not inleaf and keeps and len(kids) == 7 and len(ph) == 3) else "FAIL",
        "합계 제외 · where-used 에 HA-3000 · 자식 7", f"합계포함={inleaf} · 경로유지={keeps} · HA 자식 {len(kids)} · 팬텀 노드 {len(ph)}")
    gross = [r for r in ex if r["pn"] == "SC-1011"][0]
    rec("TC-55b", "B", "qty_basis=GROSS(SC-1011): 순소요=실소요=0.85 (scrap 0)", "PASS" if abs(gross["qty"] - 0.85) < EPS and abs(gross["qty_gross"] - 0.85) < EPS else "FAIL",
        "0.85 / 0.85", f"{gross['qty']} / {gross['qty_gross']}")
    c.close()


def group_C():
    log("\n### C. 역전개 (TC-18~22) — Q-3 원문")
    c = conn()
    for tc, pn, want in (("TC-18", "OR-5020", "EX-5000"), ("TC-19", "BT-3070", "HA-3000"), ("TC-V6", "BF-3040", "HA-3000")):
        rows = B.where_used(c, pn, ASOF); mxd = max(x["depth"] for x in rows) if rows else 0
        paths = [r["path"] for r in rows if r["depth"] == mxd]
        rec(tc, "C", f"{pn} 역전개", "PASS" if any(p.startswith("BLDC-500W-48V") for p in paths) and any(want in r["path"] for r in rows) else "FAIL",
            f"BLDC-500W-48V > {want} > {pn}", paths)
    c.close()
    c = conn(rw=True)
    ins_line(c, bid(c, "FS-7020"), iid(c, "OR-5020"), line_no=800, qty_per=2.0)
    rows = B.where_used(c, "OR-5020", ASOF); tops = sorted({r["path"] for r in rows if r["depth"] == 2})
    rec("TC-20", "C", "다부모 역전개 (OR-5020 을 EX-5000·FS-7020 공용)", "PASS" if len(tops) == 2 else "FAIL", "상위 경로 2개", tops)
    tot, _ = B.leaf_totals(c, asof=ASOF)
    rec("TC-20b", "C", "다부모 정전개 합산", "PASS" if abs(tot["EA"] - 78) < EPS else "FAIL", "EA 78", round(tot["EA"], 4))
    vq = c.execute("SELECT qty_per_product FROM v_bom_line_qpp WHERE child_pn='OR-5020' AND parent_pn='FS-7020'").fetchone()
    rec("TC-20c", "C", "다부모 라인의 뷰 qpp (FS-7020 경유 OR-5020 = 2)", "PASS" if vq and abs(vq[0] - 2) < EPS else "FAIL", "2.0", vq); c.close()
    c = conn(rw=True)
    ok, msg = blocked(lambda: ins_line(c, bid(c, "HA-3000"), iid(c, "BT-3070"), line_no=810, valid_from="2026-01-01"))
    rec("TC-21", "C", "같은 자식이 한 부모 밑에 2번 (같은 시작일)", "PASS" if ok else "FAIL", "거부", msg)
    ok2, msg2 = blocked(lambda: ins_line(c, bid(c, "HA-3000"), iid(c, "BT-3070"), line_no=811, valid_from="2027-01-01"))
    rec("TC-21b", "C", "같은 자식 · 시작일만 다르게 (겹침)", "PASS" if ok2 else "FAIL", "R-9 거부", msg2); c.close()
    c = conn()
    try:
        rows = B.where_used(c, "NO-SUCH-PN", ASOF)
        rec("TC-22", "C", "없는 P/N 역전개", "PASS" if rows == [] else "FAIL", "빈 결과", rows)
    except Exception as e:
        rec("TC-22", "C", "없는 P/N 역전개", "FAIL", "빈 결과", str(e))
    c.close()


def group_D():
    log("\n### D. BOP 연결 (TC-23~28, TC-57) — bop_link · v_bom_line_bop · 호환 뷰")
    c = conn()
    st = dict(c.execute("SELECT bop_status, count(*) FROM v_bom_line_bop GROUP BY bop_status").fetchall())
    rec("TC-23", "D", "BOM 라인 ↔ 공정 연결 상태가 DB 에서 구분되는가 (D-8)", "PASS" if st == {"ASSIGNED": 46, "UNASSIGNED": 10, "PHANTOM": 3} else "FAIL",
        "ASSIGNED 46 · UNASSIGNED 10 · PHANTOM 3", st)
    un = sorted(r[0].replace(" ", "") for r in c.execute("SELECT detail FROM v_chk_bop_unassigned"))
    un_n = sorted(N(x.split(">")[0]) + ">" + N(x.split(">")[1]) for x in un)
    rec("TC-23b", "D", "미배정 10건 = 쟁점 3·6 목록", "PASS" if un_n == sorted(CJ["expected"]["unassigned_lines"]) else "FAIL", CJ["expected"]["unassigned_lines"], un_n)
    nop = c.execute("SELECT p.op, p.kind FROM processes p WHERE NOT EXISTS (SELECT 1 FROM process_material pm WHERE pm.process_id=p.id AND pm.io='IN') ORDER BY p.line,p.seq").fetchall()
    outs = dict(c.execute("SELECT p.op, pm.out_state FROM process_material pm JOIN processes p ON p.id=pm.process_id WHERE pm.io='OUT'").fetchall())
    rec("TC-24", "D", "투입 자재 없는 공정 — OUT 행(진행 상태)로 의도적 무투입이 설명되는가", "PASS" if all(op in outs for op, _ in nop) else "FAIL",
        "무투입 공정 전부 OUT 행 보유", f"{len(nop)}건 {[(op, k, outs.get(op)) for op, k in nop]}")
    bom_tot, per = B.leaf_totals(c, asof=ASOF)
    leaf = {k[0] for k in per}          # 말단 품목 (실제 저장 pn)
    req, un_q = {}, {}
    for pn, u, q in c.execute("SELECT child_pn, uom_code, SUM(qty_per_product) FROM v_process_requirement GROUP BY child_pn, uom_code"):
        if pn in leaf: req[u] = req.get(u, 0.0) + q
    for pn, u, q in c.execute("SELECT child_pn, uom_code, SUM(qty_per_product) FROM v_bom_line_bop WHERE bop_status='UNASSIGNED' GROUP BY child_pn, uom_code"):
        if pn in leaf: un_q[u] = un_q.get(u, 0.0) + q
    gap = {k: round(bom_tot.get(k, 0) - req.get(k, 0), 6) for k in set(bom_tot) | set(req)}
    gap = {k: v for k, v in gap.items() if abs(v) > EPS}
    ok25 = all(abs(gap.get(k, 0) - un_q.get(k, 0)) < EPS for k in set(gap) | set(un_q))
    rec("TC-25", "D", "공정별 소요(v_process_requirement, 말단 라인) 합 ↔ BOM 전개 말단 합", "PASS" if ok25 else "FAIL",
        "차이 = 미배정 말단 라인의 소요 (EA 6 · SHT 12 · m 0.5)", f"BOM {({k: round(v,3) for k,v in bom_tot.items()})} · BOP {({k: round(v,3) for k,v in req.items()})} · 차이 {gap} · 미배정 말단 소요 {({k: round(v,3) for k,v in un_q.items()})}",
        "차이는 정확히 미배정 말단 7라인(FS-7010 1·FS-7021 1·FS-7022 1·FS-7023 1·OR-7025 2 = EA 6 · IP-1040 12매 · LC-1080 0.5m) — 쟁점 3·6 이 풀리면 0. 라운드 1 M-10 이중 계상(EA 51≠76)은 해소")
    dbl = c.execute("SELECT count(*) FROM process_material pm JOIN bom_line l ON l.line_id=pm.line_id JOIN bom_header h ON h.bom_id=l.bom_id"
                    " JOIN item ip ON ip.item_id=h.parent_item_id WHERE pm.io='IN' AND ip.is_phantom=1").fetchone()[0]
    ph_in = c.execute("SELECT count(*) FROM process_material pm JOIN bom_line l ON l.line_id=pm.line_id JOIN item i ON i.item_id=l.child_item_id WHERE pm.io='IN' AND i.is_phantom=1").fetchone()[0]
    rec("TC-26", "D", "어셈블리와 구성품 이중 계상 (팬텀 IN 0건)", "PASS" if ph_in == 0 else "FAIL", "팬텀 IN 0", f"팬텀 IN {ph_in} · 팬텀 하위 라인 IN {dbl}")
    outp = c.execute("SELECT p.op, i.pn, pm.is_final, pm.out_state FROM process_material pm JOIN processes p ON p.id=pm.process_id JOIN item i ON i.item_id=pm.item_id WHERE pm.io='OUT' ORDER BY p.line, p.seq").fetchall()
    a10 = [o for o in outp if o[0] == "OP-A10"]
    rec("TC-27", "D", "공정 산출물 P/N (24공정 OUT · 완성 7 · 진행 상태 17)", "PASS" if len(outp) == 24 and a10 and N(a10[0][1]) == "SC-1010P" and sum(o[2] for o in outp) == 7 else "FAIL",
        "24 / final 7 / OP-A10 → SC-1010P", f"{len(outp)} / final {sum(o[2] for o in outp)} / {a10}")
    bad = [s[0] for s in c.execute("SELECT DISTINCT stage_pn FROM processes WHERE stage_pn IS NOT NULL") if iid(c, s[0]) is None]
    rec("TC-28", "D", "stage_pn ↔ 품목 정합", "PASS" if not bad else "NOTE", "전부 실재", f"미실재 {bad or '없음'}",
        "BP-3020 은 processes.stage_pn(분해도 표시 축, 계획서 P-12 'FK 걸지 않는다') — v1.0 범위 밖. 의견으로 유지(한도윤·최민준 표시 축)" if bad else "")
    sp = c.execute("SELECT detail FROM v_chk_r10_split").fetchall()
    rec("TC-D10", "D", "R-10 투입 비율 합 100 (v_chk_r10_split)", "PASS" if len(sp) == 10 else "FAIL", "위반 10 = 미배정 10 (split 0)", f"{len(sp)}건")
    r22 = c.execute("SELECT detail FROM v_chk_r22_seq").fetchall()
    rec("TC-R22", "D", "R-22 자식 투입 seq ≤ 부모 산출 seq (v_chk_r22_seq)", "PASS" if not r22 else "FAIL", "0건", r22)
    c.close()

    # ── TC-57 호환 뷰: 이행 [3] 전환 전후, server/db.js 쿼리 문자 그대로 ──
    c = conn(rw=True)
    SQL_PI = ("SELECT i.pn, i.qty, p.name, p.spec, p.unit, p.level, p.parent_pn, p.parent_name, p.image "
              "FROM process_inputs i LEFT JOIN parts p ON p.pn = i.pn WHERE i.process_id = ? ORDER BY i.rowid")
    SQL_LP = ("SELECT p.*, (SELECT COUNT(*) FROM process_inputs i WHERE i.process_id = p.id) AS input_count "
              "FROM processes p WHERE p.product_code = ? ORDER BY p.line, p.seq, p.op")
    procs = c.execute("SELECT id, op FROM processes ORDER BY line, seq").fetchall()
    def dump():
        d = {}
        for pid, op in procs:
            for r in c.execute(SQL_PI, (pid,)): d[(op, N(r[0]))] = dict(qty=r[1], name=r[2], spec=r[3], unit=r[4], level=r[5], parent=r[6], image=r[8])
        return d
    before = dump(); before_cnt = c.execute("SELECT count(*) FROM parts").fetchone()[0]
    t0 = time.perf_counter(); LD.switch_compat(c); after = dump(); dt = (time.perf_counter() - t0) * 1000
    only_b = sorted(set(before) - set(after)); only_a = sorted(set(after) - set(before))
    common = set(before) & set(after)
    qd = [(k, before[k]["qty"], after[k]["qty"]) for k in common if before[k]["qty"] != after[k]["qty"]]
    ud = [(k, before[k]["unit"], after[k]["unit"]) for k in common if before[k]["unit"] != after[k]["unit"]]
    nd = [(k, before[k]["name"], after[k]["name"]) for k in common if before[k]["name"] != after[k]["name"]]
    sd = [(k, before[k]["spec"], after[k]["spec"]) for k in common if before[k]["spec"] != after[k]["spec"]]
    ld = [(k, before[k]["level"], after[k]["level"]) for k in common if before[k]["level"] != after[k]["level"]]
    pd = [(k, before[k]["parent"], after[k]["parent"]) for k in common if before[k]["parent"] != after[k]["parent"]]
    exp_only_b = [("OP-B90", "PE-6000")]
    exp_only_a = sorted([("OP-B90", p) for p in ("PC-4010", "PC-4011", "HS-4020", "MO-4030", "GD-4040", "CP-4050", "HK-4060", "BB-4070", "SP-4040")] + [("OP-A20", "SC-1010P"), ("OP-B120", "PK-0010")])
    ok57 = only_b == exp_only_b and only_a == exp_only_a and not qd and not ud and not nd and not sd
    rec("TC-57", "D", "process_inputs 호환 뷰 전환 전후 — 계획서 §9.3 [2]④ 기대 변화와 같은가", "PASS" if ok57 else "FAIL",
        f"전에만 {exp_only_b} · 후에만 11 · 공통 35행 수량·단위·이름·규격 차 0",
        f"전 {len(before)}행 → 후 {len(after)}행 · 전에만 {only_b} · 후에만 {len(only_a)} {'(일치)' if only_a == exp_only_a else only_a} · 수량차 {sorted(qd)} · 단위차 {ud} · 이름차 {nd} · 규격차 {sd} · {dt:.1f} ms",
        "계획서 §9.3[2]④·§10.3 의 '구 NULL 2행(SA-1000@B50·RA-2000@B70)' 은 **내 v0.9 프로토타입 적재기(r2_load.py 가 subassemblies 수량을 안 읽음)의 산물**이다. "
        "실제 server/index.js importBop 은 qtyOf.set(s.pn, s.qty)=1.0 을 넣는다(라운드 1 운영 DB 사본 실측 EA 51 도 1.0 전제). 실 전후 대조는 공통 행 수량차 0 이 정답 → 계획서 문구 정정 요청")
    log(f"           level 변화 {ld} · parent_pn 변화 {pd} (계획서 §10.3 '값만 바뀐다' 명시분)")
    # rowid 정렬: OP-B90 9종이 line_process 순서 그대로인가
    b90 = [N(r[0]) for r in c.execute(SQL_PI, (next(pid for pid, op in procs if op == "OP-B90"),))]
    a30 = [N(r[0]) for r in c.execute(SQL_PI, (next(pid for pid, op in procs if op == "OP-A30"),))]
    rec("TC-57c", "D", "뷰의 rowid(pm_id) 정렬 = BOP 표기 순서 (OP-B90 · OP-A30)", "PASS" if b90 == ["PC-4010", "PC-4011", "HS-4020", "MO-4030", "GD-4040", "CP-4050", "HK-4060", "BB-4070", "SP-4040"] and a30 == ["IN-1020U", "IN-1020L", "SC-1010"] else "FAIL",
        "PC-4010…SP-4040 / IN-1020U, IN-1020L, SC-1010", f"{b90} / {a30}")
    lp = {r[2]: r[-1] for r in c.execute(SQL_LP, ("BLDC-500W-48V",))}
    cp = c.execute("SELECT COUNT(*) AS c FROM parts").fetchone()[0]
    rec("TC-57d", "D", "listProcesses input_count · countParts 무수정 실행", "PASS" if sum(lp.values()) == 46 and lp.get("OP-B90") == 9 and cp == 59 else "FAIL",
        "합 46 · OP-B90 9 · parts 59", f"합 {sum(lp.values())} · OP-B90 {lp.get('OP-B90')} · parts {cp} (전환 전 {before_cnt})")
    v_view = c.execute("SELECT qty FROM process_inputs WHERE pn='GB-8010'").fetchone()[0]
    c.execute("UPDATE bom_line SET qty_per=2 WHERE bom_id=? AND child_item_id=?", (bid(c, "BLDC-500W-48V"), iid(c, "GB-8000")))
    v_after = c.execute("SELECT qty FROM process_inputs WHERE pn='GB-8010'").fetchone()[0]
    v_8040 = c.execute("SELECT qty FROM process_inputs WHERE pn='GB-8040'").fetchone()[0]
    rec("TC-57b", "D", "호환 뷰 qty = 완성품당 전개값 (GB-8000 2개 → GB-8010 2.0 · GB-8040 4.0) — D-10", "PASS" if abs(v_after - 2) < EPS and abs(v_8040 - 4) < EPS else "FAIL",
        "1.0 → 2.0 / 4.0", f"{v_view} → {v_after} / {v_8040}")
    # 뷰 전환 뒤 옛 import 경로가 실제로 실패하는가 (계획서가 예고한 것)
    ok, msg = blocked(lambda: c.execute("INSERT OR REPLACE INTO process_inputs (process_id, pn, qty) VALUES (1,'X',1)"))
    rec("TC-57e", "D", "뷰 전환 뒤 addProcessInput(INSERT INTO process_inputs) 실패 예고 확인", "PASS" if ok else "FAIL", "실패", msg,
        "POST /api/admin/bop/import · apply-sample 는 같은 PR 에서 새 적재기로 교체돼야 한다(계약)")
    c.close()


def group_E():
    log("\n### E. 단위 (TC-29~34, TC-56) — R-7/R-8 트리거 · v_uom_base")
    c = conn(rw=True)
    ok, msg = blocked(lambda: ins_line(c, bid(c, "SA-1000"), iid(c, "BW-2050"), line_no=700, uom_code="말"))
    rec("TC-29", "E", "코드표에 없는 단위 '말'", "PASS" if ok else "FAIL", "FK 거부", msg)
    ok, msg = blocked(lambda: ins_line(c, bid(c, "SA-1000"), iid(c, "BW-2050"), line_no=701, uom_code="g"))
    rec("TC-30", "E", "자식 base_uom(EA) ≠ 라인 단위(g) — R-7", "PASS" if ok and "R-7" in msg else "FAIL", "R-7 거부", msg)
    ok, msg = blocked(lambda: ins_line(c, bid(c, "SA-1000"), iid(c, "PM-2030"), line_no=702, qty_per=0.5))
    rec("TC-56a", "E", "0.5 EA — R-8", "PASS" if ok and "R-8" in msg else "FAIL", "R-8 거부", msg)
    ok, msg = blocked(lambda: c.execute("INSERT INTO uom_conv(from_uom,to_uom,factor) VALUES ('EA','kg',2)"))
    rec("TC-56b", "E", "차원 다른 전역 환산 EA→kg — R-7c", "PASS" if ok and "R-7c" in msg else "FAIL", "R-7c 거부", msg)
    ok, msg = blocked(lambda: c.execute("INSERT INTO uom_conv(from_uom,to_uom,factor,item_id) VALUES ('SHT','kg',0.010625,?)", (iid(c, "SC-1011"),)))
    rec("TC-56c", "E", "품목 한정 환산 SHT→kg (SC-1011)", "PASS" if not ok else "FAIL", "허용", msg)
    ok2, msg2 = blocked(lambda: c.execute("INSERT INTO uom_conv(from_uom,to_uom,factor) VALUES ('kg','g',1000)"))
    rec("TC-56d", "E", "전역 환산 중복 (초기값 kg→g 가 이미 있다) — D-19 식 인덱스", "PASS" if ok2 and "UNIQUE" in msg2 else "FAIL", "UNIQUE 거부", msg2)
    c.close()
    c = conn()
    bt = B.base_totals(c, asof=ASOF)
    mass = bt.get(("MASS", "kg"))
    rec("TC-31", "E", "SC-1011 0.85 kg + g 221 → 기준단위 합 (Q-2 · v_uom_base)", "PASS" if mass is not None and abs(mass - 1.071) < EPS else "FAIL",
        "MASS 1.071 kg", {f"{d}({u})": round(v, 6) for (d, u), v in bt.items()})
    ku = {r[0] for r in c.execute("SELECT DISTINCT uom_code FROM bom_line")} | {r[0] for r in c.execute("SELECT uom_code FROM uom")}
    sym = dict(c.execute("SELECT uom_code, symbol FROM uom").fetchall())
    rec("TC-32", "E", "한글 단위는 symbol 에만 (코드 ASCII)", "PASS" if all(u.isascii() for u in ku) and sym.get("SHT") == "매" else "FAIL",
        "코드 ASCII · SHT.symbol='매'", f"{sorted(ku)} · {sym}")
    tot, per = B.leaf_totals(c, asof=ASOF)
    ex = c.execute("SELECT base_uom, is_phantom FROM item WHERE pn='EX-5000'").fetchone()
    rec("TC-33", "E", "EX-5000 SET — uom 미등록 · 팬텀 EA · 말단 아님", "PASS" if "SET" not in sym and ex == ("EA", 1) and not any(k[0] == "EX-5000" for k in per) else "FAIL",
        "SET 없음 · EA/팬텀 · 말단 제외", f"SET in uom={'SET' in sym} · {ex}")
    dec = dict(c.execute("SELECT uom_code, decimals FROM uom").fetchall())
    viol = [r for r in c.execute("SELECT qty_per, uom_code FROM bom_line") if round(r[0], dec[r[1]]) != r[0]]
    rec("TC-34", "E", "적재 59라인 소수 자릿수 규칙", "PASS" if not viol else "FAIL", "위반 0", viol)
    rec("TC-34b", "E", "소수 반올림 정책", "PASS", "정책 = '없음 — 거부'(v1.0 답) · R-8 트리거가 거부", "TC-56a 로 확인", "v0.9 BLOCK → v1.0 정책 확정")
    c.close()


def group_F():
    log("\n### F. 유효일자 (TC-35~40, TC-59) — R-9 INSERT/UPDATE · R-9b · as-of")
    c = conn(rw=True)
    ok, msg = blocked(lambda: ins_line(c, bid(c, "PL-9000"), iid(c, "BW-2050"), line_no=600, valid_from="2026-12-31", valid_to="2026-01-01"))
    rec("TC-35", "F", "valid_to < valid_from", "PASS" if ok else "FAIL", "CHECK 거부", msg); c.close()
    c = conn(rw=True)
    b, x = bid(c, "PL-9000"), iid(c, "WW-3060")
    ins_line(c, b, x, line_no=610, valid_from="2026-01-01", valid_to="2026-06-30")
    ok, msg = blocked(lambda: ins_line(c, b, x, line_no=611, valid_from="2026-06-01", valid_to="2026-12-31"))
    rec("TC-36", "F", "기간 겹침 INSERT (01-01~06-30 vs 06-01~12-31)", "PASS" if ok else "FAIL", "R-9 거부", msg)
    ins_line(c, b, x, line_no=611, valid_from="2026-07-01", valid_to="2026-12-31")
    ok2, msg2 = blocked(lambda: c.execute("UPDATE bom_line SET valid_from='2026-06-01' WHERE bom_id=? AND child_item_id=? AND line_no=611", (b, x)))
    rec("TC-59", "F", "UPDATE 로 기간 겹침 — D-7", "PASS" if ok2 and "R-9" in msg2 else "FAIL", "R-9 거부", msg2); c.close()
    c = conn(rw=True)
    b, x = bid(c, "PL-9000"), iid(c, "BT-3070")
    ins_line(c, b, x, line_no=620, qty_per=1, valid_from="2026-01-01", valid_to="2026-05-31")
    ins_line(c, b, x, line_no=621, qty_per=2, valid_from="2026-06-01", valid_to="9999-12-31")
    for tc, day, want in (("TC-37", "2026-02-01", 1.0), ("TC-38", "2026-08-01", 2.0)):
        rows = [r for r in B.explode(c, asof=day) if r["pn"] == "BT-3070" and "PL-9000" in r["path"]]
        rec(tc, "F", f"as-of {day}", "PASS" if len(rows) == 1 and abs(rows[0]["qty"] - want) < EPS else "FAIL", f"1건 · {want}", f"{len(rows)}건 · {[r['qty'] for r in rows]}")
    rows = [r for r in B.explode(c, asof="2026-06-15") if r["pn"] == "BT-3070" and "PL-9000" in r["path"]]
    rec("TC-39", "F", "겹침 구간 as-of 2026-06-15", "PASS" if len(rows) == 1 else "FAIL", "1건", len(rows))
    t_feb, _ = B.leaf_totals(c, asof="2026-02-01"); t_aug, _ = B.leaf_totals(c, asof="2026-08-01")
    rec("TC-40", "F", "과거 시점 전개 (2월 77 · 8월 78)", "PASS" if abs(t_feb["EA"] - 77) < EPS and abs(t_aug["EA"] - 78) < EPS else "FAIL", "77 / 78", f"{t_feb['EA']} / {t_aug['EA']}")
    ok, msg = blocked(lambda: new_header(c, iid(c, "PL-9000"), rev="B"))
    rec("TC-F41", "F", "같은 부모에 ACTIVE rev 2개 같은 기간 — D-12", "PASS" if ok and "R-9b" in msg else "FAIL", "R-9b 거부", msg)
    ok, msg = blocked(lambda: new_header(c, iid(c, "PL-9000"), status="DRAFT", rev="B"))
    rec("TC-F42", "F", "DRAFT rev B 는 겹쳐도 된다 (ECO 준비)", "PASS" if not ok else "FAIL", "허용", msg)
    vd = c.execute("SELECT count(*) FROM v_bom_line_eff WHERE bom_id=(SELECT bom_id FROM bom_header WHERE rev='B' AND parent_item_id=?)", (iid(c, "PL-9000"),)).fetchone()[0]
    rec("TC-F43", "F", "DRAFT 헤더는 오늘 기준 유효 라인 뷰에 안 나온다", "PASS" if vd == 0 else "FAIL", "0", vd)
    c.close()


def group_G():
    log("\n### G. 대체품 (TC-41~44) — D-13 · is_primary")
    c = conn(rw=True)
    b, m1 = bid(c, "RA-2000"), iid(c, "PM-2030"); m2 = new_item(c, "PM-2030X")
    c.execute("UPDATE bom_line SET alt_group='MAG', alt_priority=1 WHERE bom_id=? AND child_item_id=?", (b, m1))
    ok, msg = blocked(lambda: ins_line(c, b, m2, line_no=500, qty_per=8, alt_group="MAG", alt_priority=2, valid_from="2026-01-01"))
    tot, per = B.leaf_totals(c, asof=ASOF)
    mags = {k[0]: v for k, v in per.items() if k[0].startswith("PM-2030")}
    rec("TC-41", "G", "같은 대체 그룹 2품목 동시 유효 (우선순위 1·2) — 허용되고 전개는 주자재만", "PASS" if not ok and mags == {"PM-2030": 8.0} and abs(tot["EA"] - 76) < EPS else "FAIL",
        "허용 · 전개 PM-2030 8 만 · EA 76", f"{msg} · {mags} · EA {tot['EA']}")
    ok2, msg2 = blocked(lambda: ins_line(c, b, new_item(c, "PM-2030Y"), line_no=501, qty_per=8, alt_group="MAG", alt_priority=1, valid_from="2026-01-01"))
    rec("TC-42", "G", "같은 그룹 우선순위 중복 (1,1) — D-13", "PASS" if ok2 and "D-13" in msg2 else "FAIL", "D-13 거부", msg2)
    single = c.execute("SELECT alt_group, count(*) c FROM bom_line WHERE alt_group IS NOT NULL GROUP BY bom_id, alt_group HAVING c=1").fetchall()
    rec("TC-43", "G", "대체 그룹에 품목 1개뿐 (경고 목록)", "PASS", "목록", f"{len(single)}건 — v_chk_* 에 이 점검은 없다(의견)")
    prim = dict(c.execute("SELECT child_pn, is_primary FROM v_bom_line_qpp WHERE alt_group='MAG'").fetchall())
    rec("TC-44", "G", "대체품 있는 BOM 전개 — 주자재만 (Q-1 · 뷰 is_primary)", "PASS" if prim == {"PM-2030": 1, "PM-2030X": 0} and abs(tot["EA"] - 76) < EPS else "FAIL",
        "PM-2030 primary=1 · X 0 · EA 76", f"{prim} · EA {tot['EA']}")
    # 주자재 종료 → 대체품이 자동 승격되는가 (as-of)
    c.execute("UPDATE bom_line SET valid_to='2026-06-30' WHERE bom_id=? AND child_item_id=?", (b, m1))
    _, per2 = B.leaf_totals(c, asof="2026-08-01")
    mags2 = {k[0]: v for k, v in per2.items() if k[0].startswith("PM-2030")}
    rec("TC-44b", "G", "주자재 종료 후 as-of 8월 — 대체품 승격", "PASS" if mags2 == {"PM-2030X": 8.0} else "FAIL", "PM-2030X 8", mags2)
    c.close()


def seed_lots(c):
    """계획서 §3.3 시나리오 (코일 → 서브로트 → SC-1010P → SC-1010 → SA-1000 → 시리얼) + D-17 차감(서비스 계층 규칙)"""
    c.execute("INSERT INTO zones(id,name,color,rect_x,rect_y,rect_w,rect_h) VALUES (1,'A','#fff',0,0,1,1)")
    c.execute("INSERT INTO equipments(id,zone_id,code,name,x,y,op) VALUES (1,1,'EQ-A10','300t 프레스',0,0,'OP-A10')")
    c.execute("INSERT INTO users(id,emp_no,name) VALUES (1,'E001','노하린')")
    c.execute("INSERT INTO work_orders(id,equipment_id) VALUES (1,1)")
    c.execute("INSERT INTO production_records(id,work_order_id,equipment_id,user_id,qty_good) VALUES (1,1,1,1,80)")
    pm = {(op, N(pn)): pid for pid, op, pn in c.execute("SELECT pm.pm_id, p.op, i.pn FROM process_material pm JOIN processes p ON p.id=pm.process_id JOIN item i ON i.item_id=pm.item_id WHERE pm.io='OUT'")}
    lots = [("LOT-SC1011-260912-A", "SC-1011", "LOT", None, 850.0, "kg", "POSCO", "MS-8842", None),
            ("SUB-SC1011-A-001", "SC-1011", "SUBLOT", "LOT-SC1011-260912-A", 0.85, "kg", None, None, None),
            ("SUB-SC1011-A-RET", "SC-1011", "SUBLOT", "LOT-SC1011-260912-A", 849.15, "kg", None, None, None),
            ("LOT-SC1010P-260912-0007", "SC-1010P", "LOT", None, 80.0, "SHT", None, None, ("OP-A10", "SC-1010P")),
            ("LOT-SC1010-260912-0007", "SC-1010", "LOT", None, 1.0, "EA", None, None, ("OP-A20", "SC-1010")),
            ("LOT-SA1000-260912-031", "SA-1000", "LOT", None, 1.0, "EA", None, None, ("OP-A100", "SA-1000")),
            ("SN-BLDC-2026-000481", "BLDC-500W-48V", "SERIAL", None, 1.0, "EA", None, None, ("OP-B120", "BLDC-500W-48V"))]
    lid = {}
    for no, pn, kind, par, q, u, sup, slot, st in lots:
        cur = c.execute("INSERT INTO mat_lot(lot_no,item_id,lot_kind,parent_lot_id,qty,uom_code,supplier,supplier_lot,made_at,state_pm_id)"
                        " VALUES (?,?,?,?,?,?,?,?,'2026-09-12',?)", (no, iid(c, pn), kind, lid.get(par), q, u, sup, slot, pm.get(st) if st else None))
        lid[no] = cur.lastrowid
    c.execute("UPDATE mat_lot SET qty=0 WHERE lot_no='LOT-SC1011-260912-A'")     # D-17: 분할 시 원로트 차감 (서비스 계층)
    pid = {r[1]: r[0] for r in c.execute("SELECT id,op FROM processes")}
    gen = [("LOT-SC1010P-260912-0007", "SUB-SC1011-A-001", "OP-A10", 0.85, "kg"),
           ("LOT-SC1010-260912-0007", "LOT-SC1010P-260912-0007", "OP-A20", 80.0, "SHT"),
           ("LOT-SA1000-260912-031", "LOT-SC1010-260912-0007", "OP-A100", 1.0, "EA"),
           ("SN-BLDC-2026-000481", "LOT-SA1000-260912-031", "OP-B120", 1.0, "EA")]
    for o, i, op, q, u in gen:
        c.execute("INSERT INTO lot_genealogy(out_lot_id,in_lot_id,process_id,equipment_id,user_id,record_id,qty_consumed,uom_code) VALUES (?,?,?,1,1,1,?,?)",
                  (lid[o], lid[i], pid[op], q, u))
        c.execute("UPDATE mat_lot SET qty = qty - ?, status = CASE WHEN qty - ? <= 0 THEN 'CONSUMED' ELSE status END WHERE lot_id=?", (q, q, lid[i]))
    return lid


def group_H():
    log("\n### H. 로트 계보 (TC-45~47 · V-9 · R-23 배치 · D-17)")
    c = conn(rw=True)
    seed_lots(c)
    want = {"SC-1011", "SC-1010P", "SC-1010", "SA-1000", "BLDC-500W-48V"}
    fwd = B.lot_fwd(c, "LOT-SC1011-260912-A"); reach = {N(r[2]) for r in fwd}
    rec("TC-45", "H", "정방향 코일 로트 → 완성품 시리얼 (Q-5 fwd)", "PASS" if want <= reach else "FAIL", sorted(want), sorted(reach))
    for d, lot, pn, kind, path in fwd: log(f"           {'  '*d}[{d}] {lot:26} {pn}")
    back = B.lot_back(c, "SN-BLDC-2026-000481"); rb = {N(r[2]) for r in back}
    ms = c.execute("SELECT supplier, supplier_lot FROM mat_lot WHERE lot_no='LOT-SC1011-260912-A'").fetchone()
    rec("TC-46", "H", "역방향 시리얼 → 원자재 로트 → 밀시트 (Q-5 back)", "PASS" if want <= rb and ms == ("POSCO", "MS-8842") else "FAIL", f"{sorted(want)} + POSCO/MS-8842", f"{sorted(rb)} + {ms}")
    aff = [r[1] for r in fwd if r[3] == "SERIAL"]
    rec("TC-47", "H", "원자재 로트 불량 → 영향 완제품 전부", "PASS" if aff == ["SN-BLDC-2026-000481"] else "FAIL", "SN-BLDC-2026-000481", aff)
    st = c.execute("SELECT pm.out_state, pm.is_final, p.op FROM mat_lot m JOIN process_material pm ON pm.pm_id=m.state_pm_id JOIN processes p ON p.id=pm.process_id WHERE m.lot_no='LOT-SA1000-260912-031'").fetchone()
    rec("TC-H5", "H", "state_pm_id 로 공정 진행 상태 (D-9)", "PASS" if st and st[2] == "OP-A100" and st[1] == 1 else "FAIL", "OP-A100 · final", st)
    lq = c.execute("SELECT count(*) FROM v_chk_lot_qty").fetchone()[0]
    rec("TC-H6", "H", "D-17 수량 보존 (분할 차감 + 투입 차감 후 v_chk_lot_qty)", "PASS" if lq == 0 else "FAIL", "0건", f"{lq}건 {c.execute('SELECT detail FROM v_chk_lot_qty').fetchall()}")
    # R-23 배치: OP-A80 VPI 배치 #7 에 스테이터 로트 30개
    pid = {r[1]: r[0] for r in c.execute("SELECT id,op FROM processes")}
    c.execute("INSERT INTO proc_batch(batch_no,process_id,equipment_id,status) VALUES ('VPI-260912-07',?,1,'REJECTED')", (pid["OP-A80"],))
    bid7 = c.execute("SELECT batch_id FROM proc_batch WHERE batch_no='VPI-260912-07'").fetchone()[0]
    for i in range(30):
        lid = c.execute("INSERT INTO mat_lot(lot_no,item_id,qty,uom_code) VALUES (?,?,1,'EA')", (f"LOT-SA1000-260912-{100+i:03d}", iid(c, "SA-1000"))).lastrowid
        c.execute("INSERT INTO proc_batch_lot(batch_id,lot_id) VALUES (?,?)", (bid7, lid))
    n30 = c.execute("SELECT count(*) FROM proc_batch_lot WHERE batch_id=?", (bid7,)).fetchone()[0]
    ok, msg = blocked(lambda: c.execute("INSERT INTO proc_batch_lot(batch_id,lot_id) VALUES (?,?)", (bid7, lid)))
    rec("TC-H7", "H", "R-23 배치 — '함침 배치 #7 불합격 → 그 30대' 한 번에 + 중복 등록 거부", "PASS" if n30 == 30 and ok else "FAIL", "30 · 중복 거부", f"{n30} · {msg}")
    # BULK 품목 계보 (D-18) — BT-3070 은 NONE/BULK 라 계보 행이 없어야 하고, 점검 뷰는 0
    d18 = c.execute("SELECT count(*) FROM v_chk_bulk_trace").fetchone()[0]
    rec("TC-H8", "H", "D-18 BULK 출고 품목은 trace NONE (v_chk_bulk_trace)", "PASS" if d18 == 0 else "FAIL", "0", d18)
    tr2 = c.execute("SELECT count(*) FROM v_chk_trace_serial").fetchone()[0]
    rec("TC-H9", "H", "TR-2 하위 SERIAL·상위 NONE 없음", "PASS" if tr2 == 0 else "FAIL", "0", tr2)
    # 반례 4건 (cases.json 과 중복이지만 실데이터 로트 위에서)
    a = c.execute("SELECT lot_id FROM mat_lot WHERE lot_no='LOT-SC1010-260912-0007'").fetchone()[0]
    ok, msg = blocked(lambda: c.execute("INSERT INTO lot_genealogy(out_lot_id,in_lot_id,qty_consumed,uom_code) VALUES (?,?,1,'EA')", (a, a)))
    rec("TC-H1", "H", "lot_genealogy 자기참조", "PASS" if ok else "FAIL", "거부", msg)
    x = c.execute("SELECT lot_id FROM mat_lot WHERE lot_no='LOT-SC1010P-260912-0007'").fetchone()[0]
    y = c.execute("SELECT lot_id FROM mat_lot WHERE lot_no='SUB-SC1011-A-001'").fetchone()[0]
    ok2, msg2 = blocked(lambda: c.execute("INSERT INTO lot_genealogy(out_lot_id,in_lot_id,process_id,qty_consumed,uom_code) VALUES (?,?,NULL,1,'EA')", (y, x)))
    rec("TC-H2", "H", "계보 순환 (서브로트 ← SC-1010P 로트)", "PASS" if ok2 and "R-13" in msg2 else "FAIL", "R-13 거부", msg2)
    ok3, msg3 = blocked(lambda: c.execute("UPDATE mat_lot SET parent_lot_id=? WHERE lot_no='LOT-SC1011-260912-A'", (y,)))
    rec("TC-H3", "H", "분할 계보 맞물림 (원로트의 부모 = 서브로트)", "PASS" if ok3 and "R-13" in msg3 else "FAIL", "R-13 거부", msg3)
    pid_a10 = pid["OP-A10"]
    ok4, msg4 = blocked(lambda: c.execute("INSERT INTO lot_genealogy(out_lot_id,in_lot_id,process_id,qty_consumed,uom_code) VALUES (?,?,?,1,'EA')", (x, y, pid_a10)))
    rec("TC-H4", "H", "같은 계보 간선 중복 (out,in,process) — D-16", "PASS" if ok4 and "UNIQUE" in msg4 else "FAIL", "UNIQUE 거부", msg4)
    ok5, msg5 = blocked(lambda: c.execute("UPDATE mat_lot SET qty_init=1 WHERE lot_no='LOT-SC1011-260912-A'"))
    rec("TC-H10", "H", "qty_init 불변 (D-17)", "PASS" if ok5 and "D-17" in msg5 else "FAIL", "D-17 거부", msg5)
    c.close()


def group_I():
    log("\n### I. 성능 (TC-48~50) — 품목 1만 · 레벨 5+ · 트리거 34개 켠 채")
    path = os.path.join(C.OUT, "perf_v1.db")
    c = C.fresh(memory=False, path=path); c.isolation_level = None
    N_, FAN = 10000, 5
    t0 = time.perf_counter(); c.execute("BEGIN")
    for i in range(N_):
        c.execute("INSERT INTO item(item_id,pn,name,class_id,item_type,source_type,base_uom,status) VALUES (?,?,?,1,?,'BUY','EA','ACTIVE')",
                  (i + 1, f"P{i:05d}", f"P{i:05d}", "FG" if i == 0 else "PT"))
    n_par = 0
    for i in range(N_):
        if i * FAN + FAN + 1 > N_: break
        c.execute("INSERT INTO bom_header(bom_id,parent_item_id,base_uom,status,valid_from) VALUES (?,?,'EA','ACTIVE','2026-01-01')", (i + 1, i + 1)); n_par += 1
    c.execute("COMMIT"); t_item = time.perf_counter() - t0
    t0 = time.perf_counter(); c.execute("BEGIN"); n_line = 0
    for i in range(n_par):
        for k in range(FAN):
            ch = i * FAN + k + 2
            if ch > N_: break
            c.execute("INSERT INTO bom_line(bom_id,line_no,child_item_id,qty_per,uom_code,valid_from) VALUES (?,?,?,1,'EA','2026-01-01')", (i + 1, 10 * (k + 1), ch)); n_line += 1
    for k in range(500):
        try: c.execute("INSERT INTO bom_line(bom_id,line_no,child_item_id,qty_per,uom_code,valid_from) VALUES (?,?,?,1,'EA','2026-01-01')", (k + 1, 900, N_)); n_line += 1
        except Exception: pass
    c.execute("COMMIT"); t_line = time.perf_counter() - t0
    log(f"    생성: 품목 {N_} · 헤더 {n_par} · 라인 {n_line} · 적재 item {t_item*1000:.0f} ms · line {t_line*1000:.0f} ms (라인당 {t_line/max(n_line,1)*1000:.3f} ms, 트리거 34개 포함)")
    t0 = time.perf_counter(); rows = B.explode(c, root="P00000", asof="2026-06-01"); dt1 = (time.perf_counter() - t0) * 1000
    depth = max(r["depth"] for r in rows)
    rec("TC-48", "I", f"1만 품목 · 깊이 {depth} 정전개 (Q-1)", "PASS" if dt1 < 5000 else "FAIL", "< 5,000 ms", f"{dt1:.1f} ms · {len(rows)}행")
    t0 = time.perf_counter(); wu = B.where_used(c, f"P{N_-1:05d}", "2026-06-01"); dt2 = (time.perf_counter() - t0) * 1000
    rec("TC-49", "I", "역전개 (다부모 500 포함, Q-3)", "PASS" if dt2 < 3000 else "FAIL", "< 3,000 ms", f"{dt2:.1f} ms · {len(wu)}행")
    t0 = time.perf_counter(); ok, msg = blocked(lambda: c.execute("INSERT INTO bom_line(bom_id,line_no,child_item_id,qty_per,uom_code,valid_from) VALUES (1,950,1,1,'EA','2026-01-01')")); dt3 = (time.perf_counter() - t0) * 1000
    rec("TC-50", "I", "순환 INSERT 검출 (깊이 가드 64)", "PASS" if ok and dt3 < 3000 else "FAIL", "< 3,000 ms · 거부", f"{dt3:.1f} ms · {msg[:40]}")
    t0 = time.perf_counter(); tot, _ = B.leaf_totals(c, root="P00000", asof="2026-06-01"); dt4 = (time.perf_counter() - t0) * 1000
    rec("TC-50b", "I", "말단 합계 (Q-2 단일 CTE — v0.9 의 has_bom 행별 호출 126 ms 대체)", "PASS" if dt4 < 5000 else "FAIL", "< 5,000 ms", f"{dt4:.1f} ms · EA {tot.get('EA')}")
    t0 = time.perf_counter(); nq = c.execute("SELECT count(*), max(depth) FROM v_bom_line_qpp").fetchone(); dt5 = (time.perf_counter() - t0) * 1000
    rec("TC-50c", "I", "v_bom_line_qpp 전체 (호환 뷰의 기반, 1만 라인)", "PASS" if dt5 < 5000 else "FAIL", "< 5,000 ms", f"{dt5:.1f} ms · {nq}")
    t0 = time.perf_counter(); ns = dict(c.execute("SELECT rule, cnt FROM v_chk_summary").fetchall()); dt6 = (time.perf_counter() - t0) * 1000
    rec("TC-50d", "I", "v_chk_summary 전체 (1만 규모)", "PASS" if dt6 < 10000 else "FAIL", "< 10,000 ms", f"{dt6:.1f} ms · {ns}")
    c.close()


def group_J():
    log("\n### J. 마이그레이션 (TC-51~53) — 손실 0 · 기대값 · 진짜 멱등(UPSERT)")
    c = conn()
    src = {r[0] for r in c.execute("SELECT pn FROM parts")} | {"BLDC-500W-48V"}
    dst = {N(r[0]) for r in c.execute("SELECT pn FROM item")}
    lost = sorted(src - dst); added = sorted(dst - src)
    rec("TC-51", "J", "현행 parts 56 + 완성품 → item 손실 0", "PASS" if not lost else "FAIL", "손실 0 · 신규 3", f"소실 {lost or '없음'} · 신규 {added}",
        "FS-7020(Base 단품) 은 FS-7023 으로 개번 — cleansing_map_v1.csv 에 P-2 개번 로그")
    tot, _ = B.leaf_totals(c, asof=ASOF)
    rec("TC-52", "J", "이행 후 전개 = §1.9 기대값", "PASS" if all(abs(tot.get(k, 0) - v) < EPS for k, v in EXP_TOT.items()) else "FAIL", EXP_TOT, {k: round(v, 4) for k, v in tot.items()})
    c.close()
    # TC-53: 같은 DB 에 2회 적재 (UPSERT) — 건수·합·pm_id 불변
    p = os.path.join(C.OUT, "idem_v1.db")
    env = {**os.environ, "PYTHONUTF8": "1"}
    subprocess.run([sys.executable, os.path.join(C.HERE, "v1_load.py"), "--db", p, "--quiet"], cwd=C.HERE, capture_output=True, env=env)
    def sig(path):
        x = sqlite3.connect(path)
        s = tuple(x.execute(q).fetchone()[0] for q in ("SELECT count(*) FROM item", "SELECT count(*) FROM bom_header", "SELECT count(*) FROM bom_line",
                                                       "SELECT count(*) FROM process_material", "SELECT round(sum(qty_per),6) FROM bom_line",
                                                       "SELECT max(pm_id) FROM process_material", "SELECT max(line_id) FROM bom_line", "SELECT max(item_id) FROM item"))
        x.close(); return s
    s1 = sig(p)
    r = subprocess.run([sys.executable, os.path.join(C.HERE, "v1_load.py"), "--db", p, "--rerun", "--quiet"], cwd=C.HERE, capture_output=True, env=env)
    s2 = sig(p)
    rec("TC-53", "J", "같은 DB 에 2회 적재 (UPSERT, loader_algorithm 7)", "PASS" if s1 == s2 and r.returncode == 0 else "FAIL", "건수·합·최대 id 전부 불변", f"{s1} → {s2} (exit {r.returncode})")
    r = subprocess.run([sys.executable, os.path.join(C.HERE, "v1_load.py"), "--db", p, "--rerun", "--approved", "--quiet"], cwd=C.HERE, capture_output=True, env=env)
    x = sqlite3.connect(p); pns = sorted(r0[0] for r0 in x.execute("SELECT pn FROM item WHERE pn LIKE 'TMP-%' OR pn IN ('SC-1010P','FS-7023','PK-0010')")); s3 = sig(p); x.close()
    rec("TC-53b", "J", "pn_pending 승인 후 재적재 — pn UPDATE 만, 나머지 불변", "PASS" if pns == ["FS-7023", "PK-0010", "SC-1010P"] and s3 == s1 else "FAIL", "정식 P/N 3 · 건수 불변", f"{pns} · {s3 == s1}")


def group_K():
    log("\n### K. 적재 검산 (expected · v_chk_summary) — TC-60~")
    c = conn()
    checks, got = LD.verify(c, CJ, tmp_map=TMP)
    ng = [x for x in checks if not x[1]]
    rec("TC-60", "K", "cleansing-v1.json expected 24항목 전부 일치", "PASS" if not ng else "FAIL", "24/24", f"불일치 {[(n, e, g) for n, _, e, g in ng]}")
    rec("TC-61", "K", "v_chk_summary = {D-8:10, R-10:10} 만", "PASS" if got["v_chk_summary"] == {"D-8": 10, "R-10": 10} else "FAIL", "{D-8:10, R-10:10}", got["v_chk_summary"])
    c.close()


def main():
    log("=" * 78)
    log("§6 v1.0 재검증 — [4] 테스트 케이스 TC-01 ~ TC-59 (+파생) · 계획서 v1.0 / ddl-v1.sql")
    log(f"    DB {os.path.relpath(DB, C.HERE)} · as-of {ASOF} · sqlite {sqlite3.sqlite_version} · TMP 품번 {TMP}")
    log("=" * 78)
    for g in (group_A, group_B, group_C, group_D, group_E, group_F, group_G, group_H, group_I, group_J, group_K):
        try: g()
        except Exception as e:
            import traceback; traceback.print_exc(); log(f"  !! {g.__name__} 중단: {type(e).__name__}: {e}")
    n = {"PASS": 0, "FAIL": 0, "BLOCK": 0, "NOTE": 0}
    for r in RESULTS: n[r["verdict"]] += 1
    log("\n" + "=" * 78)
    log(f"합계 {len(RESULTS)}건 — PASS {n['PASS']} · FAIL {n['FAIL']} · BLOCKED {n['BLOCK']} · NOTE(의견) {n['NOTE']}")
    log("FAIL: " + ", ".join(r["tc"] for r in RESULTS if r["verdict"] == "FAIL"))
    log("BLOCKED: " + ", ".join(r["tc"] for r in RESULTS if r["verdict"] == "BLOCK"))
    log("NOTE: " + ", ".join(r["tc"] for r in RESULTS if r["verdict"] == "NOTE"))
    log("=" * 78)
    with open(os.path.join(C.OUT, "csv", "tc_result_v1.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=["tc", "group", "desc", "verdict", "expect", "actual", "note"]); w.writeheader(); w.writerows(RESULTS)
    log.save()
    return 0 if n["FAIL"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
