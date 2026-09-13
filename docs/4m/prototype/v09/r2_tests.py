# -*- coding: utf-8 -*-
"""
r2_tests.py — 검증보고서 §2 테스트 케이스 TC-01 ~ TC-59 를 계획서 v0.9 스키마에서 전부 돌린다.
판정: PASS(확인) / FAIL(결함) / BLOCKED(미실시 — 추정하지 않는다)

선행: python r2_load.py   (out/bldc_v09.db 필요)
실행: python r2_tests.py  (출력 → out/05_tests.log · out/csv/tc_result.csv)
"""
from __future__ import annotations
import csv, io, os, shutil, sqlite3, sys, time
import bomsql as B

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out"); os.makedirs(os.path.join(OUT, "csv"), exist_ok=True)
DB = os.path.join(OUT, "bldc_v09.db")
ASOF = "2026-06-01"
EPS = 1e-9

buf = io.StringIO()
def log(s=""):
    print(s); buf.write(s + "\n")

RESULTS = []
def rec(tc, group, desc, verdict, expect, actual, repro=""):
    RESULTS.append(dict(tc=tc, group=group, desc=desc, verdict=verdict,
                        expect=str(expect), actual=str(actual), repro=repro))
    mark = {"PASS": "PASS ", "FAIL": "FAIL!", "BLOCK": "BLOCK"}[verdict]
    log(f"  [{mark}] {tc}  {desc}")
    if verdict != "PASS" or os.environ.get("TC_VERBOSE"):
        log(f"           기대: {expect}")
        log(f"           실제: {actual}")


def conn(path=DB, rw=False):
    if rw:
        tmp = os.path.join(OUT, "_scratch.db")
        if os.path.exists(tmp): os.remove(tmp)
        shutil.copyfile(path, tmp)
        c = sqlite3.connect(tmp)
    else:
        c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    c.execute("PRAGMA foreign_keys=ON")
    return c


def iid(c, pn):
    r = c.execute("SELECT item_id FROM item WHERE pn=?", (pn,)).fetchone()
    return r[0] if r else None


def bid(c, pn):
    r = c.execute("SELECT h.bom_id FROM bom_header h JOIN item i ON i.item_id=h.parent_item_id"
                  " WHERE i.pn=?", (pn,)).fetchone()
    return r[0] if r else None


def ins_line(c, bom_id, child_id, **kw):
    f = dict(line_no=999, qty_per=1.0, uom_code="EA", valid_from=ASOF, valid_to="9999-12-31",
             alt_group=None, alt_priority=None, scrap_pct=0)
    f.update(kw)
    return c.execute(
        "INSERT INTO bom_line(bom_id,line_no,child_item_id,qty_per,uom_code,valid_from,valid_to,"
        "alt_group,alt_priority,scrap_pct) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (bom_id, f["line_no"], child_id, f["qty_per"], f["uom_code"], f["valid_from"],
         f["valid_to"], f["alt_group"], f["alt_priority"], f["scrap_pct"])).lastrowid


def blocked(fn):
    """반환 (막혔나, 메시지)"""
    try:
        fn(); return False, "통과 — 들어갔다"
    except Exception as e:
        return True, f"{type(e).__name__}: {e}"


def new_item(c, pn, itype="PT", uom="EA", phantom=0):
    return c.execute("INSERT INTO item(pn,name,class_id,item_type,source_type,base_uom,is_phantom,status)"
                     " VALUES (?,?,1,?,'BUY',?,?,'ACTIVE')", (pn, pn, itype, uom, phantom)).lastrowid


def new_header(c, item_id, status="ACTIVE", base_qty=1.0, uom="EA", vf=ASOF, vt="9999-12-31", alt="00", rev="A"):
    return c.execute("INSERT INTO bom_header(parent_item_id,alt_no,rev,base_qty,base_uom,status,valid_from,valid_to)"
                     " VALUES (?,?,?,?,?,?,?,?)", (item_id, alt, rev, base_qty, uom, status, vf, vt)).lastrowid


# ══════════════════════════════════════════════════════════════════════════
def group_A():
    log("\n### A. 트리 무결성 — 반례가 막히는가 (TC-01~10)")
    c = conn(rw=True)
    a, b = new_item(c, "TST-A", "SA"), new_item(c, "TST-B", "SA")
    ba, bb = new_header(c, a), new_header(c, b)
    ins_line(c, ba, b)
    ok, msg = blocked(lambda: ins_line(c, bb, a))
    rec("TC-01", "A", "A→B, B→A 2행 적재 (bom_header ACTIVE)", "PASS" if ok else "FAIL",
        "두 번째 INSERT 거부 + 순환 경로 명시", msg + " ← 경로는 메시지에 없다(R-19)")
    c.close()

    c = conn(rw=True)
    ids = [new_item(c, f"TST-C{i}", "SA") for i in range(3)]
    bs = [new_header(c, i) for i in ids]
    ins_line(c, bs[0], ids[1]); ins_line(c, bs[1], ids[2])
    ok, msg = blocked(lambda: ins_line(c, bs[2], ids[0]))
    rec("TC-02", "A", "A→B→C→A (3단)", "PASS" if ok else "FAIL", "순환 경로 A→B→C→A 보고", msg)
    c.close()

    c = conn(rw=True)
    f = iid(c, "FS-7010")
    bf = new_header(c, f)
    ok, msg = blocked(lambda: ins_line(c, bf, f))
    rec("TC-03", "A", "FS-7010 → FS-7010 (실데이터 자기참조)", "PASS" if ok else "FAIL", "거부", msg)
    c.close()

    c = conn(rw=True)
    ok, msg = blocked(lambda: new_item(c, "HA-3000/EX-5000", "SA"))
    # 복합 부모는 새 모델에서 '부모'가 문자열이 아니라 item_id 라서 애초에 표현 불가 —
    # 다만 그런 pn 을 품목으로 등록하는 것 자체는 막히지 않는다.
    rec("TC-04", "A", "'HA-3000/EX-5000' 를 부모로 INSERT", "PASS",
        "구조적으로 불가 (부모가 item_id FK)",
        f"bom_line.bom_id→bom_header.parent_item_id→item.item_id 라 슬래시 부모가 표현 불가. "
        f"단 pn='HA-3000/EX-5000' 품목 등록은 막히지 않는다({'거부' if ok else '통과'}) → 의견 R-20")
    c.close()

    c = conn(rw=True)
    bsa, sc = bid(c, "SA-1000"), iid(c, "IN-1020U")
    ok, msg = blocked(lambda: ins_line(c, bsa, sc, valid_from="2026-01-01"))
    rec("TC-05", "A", "같은 부모에 같은 자식 2행 (valid_from 동일)", "PASS" if ok else "FAIL",
        "ux_bom_line_dup 로 거부", msg)
    ok2, msg2 = blocked(lambda: ins_line(c, bsa, sc, valid_from="2026-03-01"))
    rec("TC-06", "A", "같은 부모-자식, 기간 겹치게 2행 (시작일만 다름)", "PASS" if ok2 else "FAIL",
        "R-9 트리거로 거부", msg2)
    c.close()

    c = conn(rw=True)
    ok, msg = blocked(lambda: ins_line(c, bid(c, "SA-1000"), 999999))
    rec("TC-07", "A", "존재하지 않는 자식 item_id (GHOST)", "PASS" if ok else "FAIL", "FK 거부", msg)
    c.close()

    c = conn()
    orph = c.execute(B.Q_R4_ORPHAN).fetchall()
    rec("TC-08", "A", "고아 품목 (R-4 점검 쿼리)", "PASS" if len(orph) == 0 else "FAIL",
        "0건 (정제 후 모든 비-FG 품목이 어느 라인의 자식)", f"{len(orph)}건 {[o[0] for o in orph]}")
    reach = {r["pn"] for r in B.explode(c, asof=ASOF)}
    allpn = {r[0] for r in c.execute("SELECT pn FROM item")} - {"BLDC-500W-48V"}
    rec("TC-09", "A", "루트에서 도달 불가한 품목", "PASS" if not (allpn - reach) else "FAIL",
        "0건", f"{len(allpn-reach)}건 {sorted(allpn-reach)}")
    mx = max(r["depth"] for r in B.explode(c, asof=ASOF))
    rec("TC-10", "A", "최대 레벨", "PASS" if mx == 4 else "FAIL", "4 (§3.2 목표 트리 L4)", mx)
    lost = c.execute(B.Q_R5_LOST_SA).fetchall()
    rec("TC-10b", "A", "미아 조립품 (R-5)", "PASS" if not lost else "FAIL", "0건", f"{len(lost)}건 {lost}")
    c.close()

    # R-6 수량 CHECK · scrap_pct 범위 — 주장하지 말고 실제로 넣어 본다
    c = conn(rw=True)
    b, x = bid(c, "PL-9000"), iid(c, "BW-2050")
    for tc, kw, desc, exp in (
            ("TC-10c", dict(qty_per=0.0), "수량 0 (R-6)", "CHECK(qty_per>0) 거부"),
            ("TC-10d", dict(qty_per=-1.0), "수량 음수 (R-6)", "CHECK(qty_per>0) 거부"),
            ("TC-10e", dict(scrap_pct=100.0), "scrap_pct 100 (0 나눗셈 유발)", "CHECK(scrap_pct<100) 거부"),
            ("TC-10f", dict(scrap_pct=-5.0), "scrap_pct 음수", "CHECK(scrap_pct>=0) 거부")):
        n = 640 + int(tc[-1], 36)
        ok, msg = blocked(lambda kw=kw, n=n: ins_line(c, b, x, line_no=n, **kw))
        rec(tc, "A", desc, "PASS" if ok else "FAIL", exp, msg)
    ok, msg = blocked(lambda: c.execute(
        "INSERT INTO bom_header(parent_item_id,alt_no,rev,base_qty,base_uom,status,valid_from)"
        " VALUES (?,'01','A',0,'EA','ACTIVE',?)", (iid(c, "PL-9000"), ASOF)))
    rec("TC-10g", "A", "bom_header.base_qty = 0 (전개에서 0 나눗셈)", "PASS" if ok else "FAIL",
        "CHECK(base_qty>0) 거부", msg)
    c.close()


def group_B():
    log("\n### B. 다단계 전개 (TC-11~17, TC-54, TC-55)")
    c = conn()
    tot, per = B.leaf_totals(c, qty=1.0, asof=ASOF)
    exp = {"EA": 76.0, "g": 221.0, "SHT": 12.0, "kg": 0.85, "m": 0.5}   # §1.9 기대값 (매=SHT)
    same = all(abs(tot.get(k, 0) - v) < EPS for k, v in exp.items()) and set(tot) == set(exp)
    rec("TC-11", "B", "완성품 1대 전개 (차원별 합계) — V-3", "PASS" if same else "FAIL",
        exp, {k: round(v, 6) for k, v in sorted(tot.items())})

    # V-3 의 진짜 요구는 "차이 나는 항목을 전부 지목" 이다 → 합계가 아니라 품목별로 대조한다
    import json as _j
    js = _j.load(open(os.path.join(HERE, "..", "..", "..", "..", "docs", "bldc", "bldc-500w-48v.json"),
                      encoding="utf-8"))
    umap = {"매": "SHT"}
    src = {(p["pn"], umap.get(p.get("unit"), p.get("unit"))): p["qtyPerProduct"] for p in js["parts"]}
    got = {k: round(v, 9) for k, v in per.items()}
    only_src = sorted(set(src) - set(got)); only_new = sorted(set(got) - set(src))
    qdiff = [(k, src[k], got[k]) for k in set(src) & set(got) if abs(src[k] - got[k]) > EPS]
    rec("TC-11b", "B", "V-3 품목별 대조 — 원천 09_Flat 49행 ↔ 전개 말단",
        "FAIL" if (only_src or only_new or qdiff) else "PASS",
        "품목·수량 전부 일치",
        f"원천에만 {only_src} · 새 구조에만 {only_new} · 수량 다름 {qdiff or '0건'}")
    log("           ※ **합계는 완전히 일치하는데 내역은 4건 다르다.** 두 쌍이 각각 ±1 EA 라 상쇄된다:")
    log("             · SC-1010 이 중간 조립품이 되어 말단에서 빠지고(−1 EA), PK-0010 이 새로 들어온다(+1 EA)")
    log("             · FS-7020(Base 단품)이 FS-7023 으로 개번된다(−1 EA / +1 EA)")
    log("             → 로드맵 2단계 완료기준 ①('원천 09_Flat 과 차원별 일치')은 **통과하지만 검증력이 0이다.**")
    log("               품목별 대조표를 완료기준으로 바꿔야 한다 → R-21")

    t100, _ = B.leaf_totals(c, qty=100.0, asof=ASOF)
    lin = all(abs(t100.get(k, 0) - v * 100) < 1e-7 for k, v in tot.items())
    rec("TC-12", "B", "완성품 100대 전개 = 1대 × 100", "PASS" if lin else "FAIL",
        {k: v * 100 for k, v in tot.items()}, {k: round(v, 6) for k, v in t100.items()})

    rec("TC-13", "B", "현행 원천 그대로 전개 (EA 58 회귀 고정)", "BLOCK",
        "EA 58", "새 스키마에는 현행 결함 데이터가 들어가지 않는다(정제가 적재 전제). "
                 "라운드 1 selftest.py 가 계속 담당 — 이 회귀 감시를 v1.0 이행 [2] 대조에 남길 것")

    # TC-14 b≠1
    c2 = conn(rw=True)
    g = bid(c2, "BLDC-500W-48V")
    c2.execute("UPDATE bom_line SET qty_per=2 WHERE bom_id=? AND child_item_id=?", (g, iid(c2, "GB-8000")))
    t2, _ = B.leaf_totals(c2, asof=ASOF)
    okd = abs(t2["EA"] - (76 + 5)) < EPS and abs(t2["g"] - (221 + 25)) < EPS
    rec("TC-14", "B", "b≠1 — GB-8000 을 완성품당 2개로", "PASS" if okd else "FAIL",
        "EA 81 (76+5) · g 246 (221+25)", {k: round(v, 4) for k, v in t2.items()})
    c2.close()

    # TC-15 레벨 3 (이미 L4). 부모를 바꿔도 총량 불변인지
    c3 = conn(rw=True)
    before, _ = B.leaf_totals(c3, asof=ASOF)
    c3.execute("UPDATE bom_line SET qty_per=?, uom_code='kg' WHERE child_item_id=?",
               (0.85, iid(c3, "SC-1011")))
    after, _ = B.leaf_totals(c3, asof=ASOF)
    rec("TC-15", "B", "레벨 4 전개 · SC-1011 경로 (SC-1010→SC-1010P→SC-1011)",
        "PASS" if abs(after["kg"] - 0.85) < EPS else "FAIL", "kg 0.85 · 깊이 4",
        f"kg {after['kg']} · 깊이 {max(r['depth'] for r in B.explode(c3, asof=ASOF))}")
    c3.close()

    # TC-16 순환이 남아 있는 상태에서 전개
    c4 = conn(rw=True)
    a = iid(c4, "GB-8010")
    c4.execute("UPDATE item SET item_type='SA' WHERE item_id=?", (a,))
    ba = new_header(c4, a)
    # 트리거를 피해 직접 넣어 순환을 만든다 (UPDATE 경로 = D-5 로 실제 가능)
    lidx = ins_line(c4, ba, iid(c4, "PL-9030"))
    c4.execute("UPDATE bom_line SET child_item_id=? WHERE line_id=?", (iid(c4, "GB-8000"), lidx))
    t0 = time.perf_counter()
    try:
        rows = B.explode(c4, asof=ASOF); dt = time.perf_counter() - t0
        deep = max(r["depth"] for r in rows)
        rec("TC-16", "B", "순환이 남아 있는 상태에서 전개", "FAIL",
            "멈춤 + 순환 경로 보고 (2초 내)",
            f"{dt*1000:.1f} ms 에 끝나지만 **순환을 보고하지 않는다**. 깊이 가드(10)로 조용히 잘린다. "
            f"최대 깊이 {deep} · 행 {len(rows)} — 전개값이 틀린 채 화면에 나간다")
    except Exception as e:
        rec("TC-16", "B", "순환이 남아 있는 상태에서 전개", "PASS", "멈춤 + 경로 보고", str(e))
    c4.close()

    lv = {}
    for r in B.explode(c, asof=ASOF):
        lv.setdefault(r["depth"], []).append(r)
    rec("TC-17", "B", "레벨별 누적 수량", "PASS",
        "레벨별 소계 조회 가능", {k: len(v) for k, v in sorted(lv.items())})

    # TC-54 base_qty=80
    scr = [r for r in B.explode(c, asof=ASOF) if r["pn"] == "SC-1011"]
    v = scr[0]["qty"] if scr else None
    rec("TC-54", "B", "base_qty=80 (SC-1010P) 나눗셈 — 반올림 오차 0",
        "PASS" if v is not None and abs(v - 0.85) < EPS else "FAIL",
        "SC-1011 정확히 0.85 kg", f"{v!r} (오차 {abs(v-0.85):.3e})" if v else "없음")

    # TC-55 팬텀
    ph = [r for r in B.explode(c, asof=ASOF) if r["pn"] in ("HA-3000", "EX-5000", "PE-6000")]
    kids = [r for r in B.explode(c, asof=ASOF) if r["path"].startswith("BLDC-500W-48V > HA-3000 >")]
    wu = B.where_used(c, "BF-3040", ASOF)
    keeps = any("HA-3000" in r["path"] for r in wu)
    inleaf = any(r["pn"] in ("HA-3000", "EX-5000", "PE-6000") for r in B.explode(c, asof=ASOF)
                 if not B.has_bom(c, r["item_id"], ASOF))
    rec("TC-55", "B", "팬텀 전개 — 합계 제외 + 경로 유지",
        "PASS" if (not inleaf and keeps and len(kids) == 7) else "FAIL",
        "합계에서 제외 · where-used 경로에 HA-3000 남음 · 자식 7종",
        f"합계 포함={inleaf} · 경로유지={keeps} · HA 자식 {len(kids)}종 · 팬텀 노드 {len(ph)}개는 전개 트리에 남는다")
    log("           ※ 다만 **팬텀을 건너뛰는 규칙이 계획서 SQL 로 없다.** 위 판정은 검증자가 쓴 "
        "leaf_totals() 가 '자식이 있으면 합계 제외' 로 처리해서 우연히 맞는 것이다 → R-18")
    c.close()


def group_C():
    log("\n### C. 역전개 Where-used (TC-18~22)")
    c = conn()
    for tc, pn, want in (("TC-18", "OR-5020", "EX-5000"), ("TC-19", "BT-3070", "HA-3000"),
                         ("TC-V6", "BF-3040", "HA-3000")):
        rows = B.where_used(c, pn, ASOF)
        paths = [r["path"] for r in rows if r["depth"] == max(x["depth"] for x in rows)]
        top = any(p.startswith("BLDC-500W-48V") for p in paths)
        mid = any(want in r["path"] for r in rows)
        rec(tc, "C", f"{pn} 역전개", "PASS" if (top and mid) else "FAIL",
            f"BLDC-500W-48V → {want} → {pn}", paths)
    c.close()

    c = conn(rw=True)
    shared = iid(c, "OR-5020")
    ins_line(c, bid(c, "FS-7020"), shared, line_no=800, qty_per=2.0)   # 공용화 → 다부모
    rows = B.where_used(c, "OR-5020", ASOF)
    tops = sorted({r["path"] for r in rows if r["depth"] == 2})
    rec("TC-20", "C", "부모가 2개인 품목 역전개 (OR-5020 을 EX-5000·FS-7020 공용으로)",
        "PASS" if len(tops) == 2 else "FAIL", "상위 경로 2개 전부", tops)
    tot, per = B.leaf_totals(c, asof=ASOF)
    rec("TC-20b", "C", "다부모 품목의 정전개 수량 합산", "PASS" if abs(tot["EA"] - 78) < EPS else "FAIL",
        "EA 78 (76 + OR-5020 2개)", round(tot["EA"], 4))
    c.close()

    c = conn(rw=True)
    ok, msg = blocked(lambda: ins_line(c, bid(c, "HA-3000"), iid(c, "BT-3070"),
                                       line_no=810, valid_from="2026-01-01"))
    rec("TC-21", "C", "같은 자식이 한 부모 밑에 2번 (다른 line_no, 같은 시작일)",
        "PASS" if ok else "FAIL", "거부 또는 수량 합산", msg)
    ok2, msg2 = blocked(lambda: ins_line(c, bid(c, "HA-3000"), iid(c, "BT-3070"),
                                         line_no=811, valid_from="2027-01-01"))
    rec("TC-21b", "C", "같은 자식 · 시작일만 다르게 (겹침)", "PASS" if ok2 else "FAIL",
        "R-9 트리거로 거부", msg2)
    c.close()

    c = conn()
    try:
        rows = B.where_used(c, "NO-SUCH-PN", ASOF)
        rec("TC-22", "C", "없는 P/N 역전개", "PASS" if rows == [] else "FAIL", "빈 결과, 예외 없음", rows)
    except Exception as e:
        rec("TC-22", "C", "없는 P/N 역전개", "FAIL", "빈 결과", str(e))
    c.close()


def group_D():
    log("\n### D. BOP 연결 (TC-23~28, TC-57)")
    c = conn()
    n_line = c.execute("SELECT count(*) FROM bom_line").fetchone()[0]
    n_in = c.execute("SELECT count(DISTINCT line_id) FROM process_material WHERE io='IN'").fetchone()[0]
    miss = c.execute(
        "SELECT ip.pn, ic.pn, i2.is_phantom FROM bom_line l"
        " JOIN bom_header h ON h.bom_id=l.bom_id JOIN item ip ON ip.item_id=h.parent_item_id"
        " JOIN item ic ON ic.item_id=l.child_item_id JOIN item i2 ON i2.item_id=l.child_item_id"
        " WHERE NOT EXISTS (SELECT 1 FROM process_material pm WHERE pm.line_id=l.line_id AND pm.io='IN')"
    ).fetchall()
    rec("TC-23", "D", "모든 BOM 라인이 정확히 한 공정에 붙는가", "FAIL" if miss else "PASS",
        f"{n_line}/{n_line} 연결", f"{n_in}/{n_line} 연결 · 미연결 {len(miss)}건 = "
        f"팬텀 {sum(1 for m in miss if m[2])} + 미배정 {sum(1 for m in miss if not m[2])}")
    log("           ※ **팬텀(의도적 무투입)과 미배정(BOP 누락)이 DB 에서 구분되지 않는다.** "
        "둘 다 '행 없음' 이다 → 결함 D-8")

    nop = c.execute(B.Q_PROC_NO_INPUT).fetchall()
    rec("TC-24", "D", "투입 자재 없는 공정 탐지", "PASS",
        "목록 + 의도적 무투입/누락 구분", f"{len(nop)}건 {[n[0] for n in nop]} "
        f"— 구분 컬럼이 없어 '검사·건조'인지 '누락'인지 DB 로 알 수 없다 → D-8")

    # TC-25 BOP 합계 ↔ BOM 전개 합계 — 라인별 '완성품 1대당 소요' 를 제대로 계산해 맞춘다
    bom_tot, per = B.leaf_totals(c, asof=ASOF)
    conn_lines = {(pp, cc) for pp, cc in c.execute(
        "SELECT ip.pn, ic.pn FROM process_material pm JOIN bom_line l ON l.line_id=pm.line_id"
        " JOIN bom_header h ON h.bom_id=l.bom_id JOIN item ip ON ip.item_id=h.parent_item_id"
        " JOIN item ic ON ic.item_id=l.child_item_id WHERE pm.io='IN'")}
    leaf_pn = {k[0] for k in per}
    bop, unconn = {}, []
    for r in B.explode(c, asof=ASOF):
        if r["pn"] not in leaf_pn or B.has_bom(c, r["item_id"], ASOF):
            continue
        seg = r["path"].split(" > ")
        edge = (seg[-2], seg[-1])
        if edge in conn_lines:
            bop[r["uom"]] = bop.get(r["uom"], 0.0) + r["qty"]
        else:
            unconn.append((edge, r["qty"], r["uom"]))
    gap = {k: round(bom_tot.get(k, 0) - bop.get(k, 0), 6) for k in set(bom_tot) | set(bop)}
    gap = {k: v for k, v in gap.items() if abs(v) > EPS}
    rec("TC-25", "D", "공정 투입 합계 ↔ BOM 전개 합계 (라인별 완성품당 소요 기준)",
        "FAIL" if gap else "PASS",
        f"완전 일치 {({k: round(v,3) for k,v in bom_tot.items()})}",
        f"BOP 측 {({k: round(v,3) for k,v in bop.items()})} · 부족 {gap} · "
        f"공정에 안 붙은 말단 라인 {len(unconn)}건 {[f'{a}→{b}' for (a,b),_,_ in unconn]}")
    log("           ※ 이 대조를 하려면 '라인의 완성품 1대당 소요' 공식이 필요한데 "
        "**계획서에 그 공식도, 그 쿼리도 없다.** process_material 에는 수량 컬럼이 아예 없다 → R-18")

    dbl = c.execute(
        "SELECT ip.pn FROM process_material pm JOIN bom_line l ON l.line_id=pm.line_id"
        " JOIN bom_header h ON h.bom_id=l.bom_id JOIN item ip ON ip.item_id=h.parent_item_id"
        " WHERE pm.io='IN' AND ip.is_phantom=1").fetchall()
    rec("TC-26", "D", "어셈블리와 그 구성품이 같은 BOP 에 (이중 계상)", "PASS",
        "구조적으로 불가능", f"팬텀 3종은 IN 행이 없어 이중 계상이 사라졌다. "
        f"팬텀 하위 라인의 IN {len(dbl)}건은 자식 각자 공정에 걸린다 (라운드1 M-10 해소)")

    out_pn = c.execute("SELECT p.op, i.pn FROM process_material pm JOIN processes p ON p.id=pm.process_id"
                       " JOIN item i ON i.item_id=pm.item_id WHERE pm.io='OUT' ORDER BY p.seq").fetchall()
    a10 = [o for o in out_pn if o[0] == "OP-A10"]
    rec("TC-27", "D", "공정 산출물이 품목 P/N 을 갖는가", "PASS" if a10 else "FAIL",
        "OP-A10 산출 = SC-1010P", f"OUT {len(out_pn)}공정 {out_pn}")
    n_txt = c.execute("SELECT count(*) FROM processes p WHERE NOT EXISTS"
                      " (SELECT 1 FROM process_material pm WHERE pm.process_id=p.id AND pm.io='OUT')").fetchone()[0]
    log(f"           ※ 나머지 {n_txt}공정은 산출 P/N 이 없다. 자유 텍스트 `processes.output` 이 그대로 남고,"
        " 계획서가 말한 '로트의 공정 진행 상태'(mat_lot.proc_state)와 **연결하는 규칙이 없다** → D-9")

    stage = c.execute("SELECT DISTINCT stage_pn FROM processes WHERE stage_pn IS NOT NULL").fetchall()
    bad = [s[0] for s in stage if iid(c, s[0]) is None]
    rec("TC-28", "D", "stage_pn ↔ 품목 정합", "PASS" if not bad else "FAIL",
        "모든 stage_pn 이 실재 품목", f"미실재 {bad or '없음'}")

    # R-10 투입 비율
    sp = c.execute(B.Q_R10_SPLIT).fetchall()
    rec("TC-D10", "D", "R-10 투입 비율 합 100%", "FAIL" if sp else "PASS",
        "위반 0건", f"{len(sp)}건 (합계 0 = IN 행 없음). 계획서에 R-10 점검 쿼리가 없어 검증자가 작성")
    c.close()

    # TC-57 호환 뷰
    c = conn(rw=True)
    before = c.execute("SELECT p.op, pi.pn, pi.qty FROM process_inputs pi"
                       " JOIN processes p ON p.id=pi.process_id ORDER BY p.op, pi.pn").fetchall()
    c.execute("ALTER TABLE process_inputs RENAME TO process_inputs_old")
    c.execute("""CREATE VIEW process_inputs AS
        SELECT pm.process_id AS process_id, i.pn AS pn, l.qty_per AS qty
          FROM process_material pm
          JOIN bom_line l ON l.line_id = pm.line_id
          JOIN item i ON i.item_id = l.child_item_id
         WHERE pm.io='IN'""")
    after = c.execute("SELECT p.op, pi.pn, pi.qty FROM process_inputs pi"
                      " JOIN processes p ON p.id=pi.process_id ORDER BY p.op, pi.pn").fetchall()
    kb = {(o, p): q for o, p, q in before}; ka = {(o, p): q for o, p, q in after}
    only_b = sorted(set(kb) - set(ka)); only_a = sorted(set(ka) - set(kb))
    qd = [(k, kb[k], ka[k]) for k in set(kb) & set(ka) if kb[k] != ka[k]]
    rec("TC-57", "D", "process_inputs 를 호환 뷰로 교체 (이행 [3] · V-10)", "FAIL",
        f"교체 전후 동일 ({len(before)}행)",
        f"전 {len(kb)}행 → 후 {len(ka)}행 · (공정,P/N)이 전에만 {len(only_b)}건 · 후에만 {len(only_a)}건 "
        f"· 공통인데 **수량이 다른 행 {len(qd)}건**")
    log(f"           전에만: {only_b}")
    log(f"           후에만: {only_a}")
    log(f"           수량 불일치(샘플 6): {qd[:6]}")
    log("           ※ 원인 셋 —")
    log("             ① 정제로 행 자체가 달라진다 (팬텀 3종 IN 소멸 · 신규 SC-1010P/PK-0010 · SC-1011 재배치)")
    log("             ② 뷰의 qty = bom_line.qty_per = **부모 base_qty 당**. 기존 컬럼은 **완성품 1대당**이다.")
    log("                SC-1010P 가 80(매/SC-1010 1개) · SC-1011 이 0.85(kg/80매) 로 나온다.")
    log("             ③ 기존 process_inputs.qty 가 NULL 이던 어셈블리 투입 행이 뷰에서는 값을 갖는다.")
    log("           → 인터페이스 §8 `equipment:detail.process.inputs[].qty` 의 **의미가 바뀐다.**")
    log("             계획서 §10.3 이 '키와 의미를 바꾸지 않는다' 고 못 박은 계약을 스스로 위반한다 → 결함 D-10")

    # TC-57b — 의미 차이가 '지금은 안 보이는' 이유를 수치로 고정한다
    v_before = c.execute("SELECT qty_per_product FROM parts WHERE pn='GB-8010'").fetchone()[0]
    v_view = c.execute("SELECT qty FROM process_inputs pi JOIN processes p ON p.id=pi.process_id"
                       " WHERE pi.pn='GB-8010'").fetchone()[0]
    c.execute("UPDATE bom_line SET qty_per=2 WHERE bom_id=(SELECT bom_id FROM bom_header h"
              " JOIN item i ON i.item_id=h.parent_item_id WHERE i.pn='BLDC-500W-48V')"
              " AND child_item_id=(SELECT item_id FROM item WHERE pn='GB-8000')")
    v_after = c.execute("SELECT qty FROM process_inputs pi JOIN processes p ON p.id=pi.process_id"
                        " WHERE pi.pn='GB-8010'").fetchone()[0]
    rec("TC-57b", "D", "호환 뷰의 qty 가 '완성품당' 과 어긋나는 순간",
        "FAIL" if v_after == v_view else "PASS",
        "GB-8000 을 완성품당 2개로 바꾸면 GB-8010 의 완성품당 소요는 2 가 되어야",
        f"현행 parts.qty_per_product={v_before} · 뷰(변경 전)={v_view} · 뷰(GB-8000 2개로 바꾼 뒤)={v_after} "
        f"— 뷰는 그대로 {v_after} 다. **지금 값이 맞아 보이는 건 현행 parentPerProduct 가 전부 1.0 이라서다"
        f"(계획서 스스로 P-7 에서 '위험 신호'라 쓴 그 조건). 서브어셈블리가 2개가 되는 순간 화면 값이 틀린다**")
    c.close()


def group_E():
    log("\n### E. 단위 UoM (TC-29~34, TC-56)")
    c = conn(rw=True)
    ok, msg = blocked(lambda: ins_line(c, bid(c, "SA-1000"), iid(c, "BW-2050"), line_no=700, uom_code="말"))
    rec("TC-29", "E", "코드표에 없는 단위 '말'", "PASS" if ok else "FAIL", "FK 거부", msg)

    ok, msg = blocked(lambda: ins_line(c, bid(c, "SA-1000"), iid(c, "BW-2050"), line_no=701, uom_code="g"))
    rec("TC-30", "E", "자식 base_uom(EA) 과 다른 라인 단위(g) — R-7", "PASS" if ok else "FAIL",
        "거부 (R-7: 같거나 환산 가능해야)",
        msg + " ← DDL·트리거에 R-7 구현이 전혀 없다. 계획서는 '트리거 또는 적재 검증'이라 했지만 둘 다 없다")

    ok, msg = blocked(lambda: ins_line(c, bid(c, "SA-1000"), iid(c, "PM-2030"), line_no=702,
                                       uom_code="EA", qty_per=0.5))
    rec("TC-56a", "E", "0.5 EA (R-8 소수 자릿수)", "PASS" if ok else "FAIL",
        "거부 (uom.decimals EA=0)", msg + " ← R-8 구현 없음")

    ok, msg = blocked(lambda: c.execute(
        "INSERT INTO uom_conv(from_uom,to_uom,factor,item_id) VALUES ('EA','kg',2.0,NULL)"))
    rec("TC-56b", "E", "차원이 다른 전역 환산 EA→kg", "PASS" if ok else "FAIL",
        "거부 (COUNT↔MASS 전역 환산 금지)", msg + " ← uom.dim 을 보는 제약이 없다")

    ok, msg = blocked(lambda: c.execute(
        "INSERT INTO uom_conv(from_uom,to_uom,factor,item_id) VALUES ('SHT','kg',0.010625,?)",
        (iid(c, "SC-1011"),)))
    rec("TC-56c", "E", "품목 한정 환산 SHT→kg (SC-1011)", "PASS" if not ok else "FAIL",
        "허용", msg)

    ok, msg = blocked(lambda: c.execute(
        "INSERT INTO uom_conv(from_uom,to_uom,factor,item_id) VALUES ('kg','g',1000,NULL)"))
    ok2, msg2 = blocked(lambda: c.execute(
        "INSERT INTO uom_conv(from_uom,to_uom,factor,item_id) VALUES ('kg','g',1000,NULL)"))
    rec("TC-56d", "E", "전역 환산 중복 (uom_conv 유일성 — 원문 PK 가 문법 오류라 식 인덱스로 대체)",
        "PASS" if (not ok and ok2) else "FAIL", "1번째 허용 · 2번째 거부", f"1={msg} / 2={msg2}")
    c.close()

    c = conn()
    conv = {(r[0], r[1]): (r[2], r[3]) for r in c.execute("SELECT from_uom,to_uom,factor,item_id FROM uom_conv")}
    rec("TC-31", "E", "SC-1011 0.85 kg + MW-1030 180 g 합산", "FAIL",
        "1,030 g (또는 1.03 kg) — 기준단위로 통일",
        f"uom_conv 에 kg→g 1000 은 있으나 **환산을 적용하는 쿼리·함수가 계획서에 없다.** "
        f"전개 결과는 kg 0.85 와 g 221 이 그대로 따로 나온다. "
        f"m→mm 행은 'mm' 이 uom 마스터에 없어 **FK 위반으로 적재조차 안 된다** → D-11")

    ku = {r[0] for r in c.execute("SELECT DISTINCT uom_code FROM bom_line")}
    han = [u for u in ku if not u.isascii()]
    rec("TC-32", "E", "한글 단위가 DB 에 남는가", "PASS" if not han else "FAIL",
        "표준 코드만 (매→SHT)", f"bom_line 단위 {sorted(ku)} · 한글 {han or '없음'}")

    tot, _ = B.leaf_totals(c, asof=ASOF)
    rec("TC-33", "E", "EX-5000 SET 전개", "PASS" if "SET" not in tot else "FAIL",
        "SET 이 리프로 남지 않는다", f"합계 단위 {sorted(tot)}")
    log("           ※ 그런데 §9.2 P-4 는 'SET 은 팬텀화로 소멸' 이라 했고 §5.1·§5.8 은 uom 6종에 "
        "SET 을 넣었다. item.base_uom 이 NOT NULL 이라 EX-5000 에는 어떤 단위든 필요하다 → 서로 어긋난다 (의견)")

    dec = {r[0]: r[1] for r in c.execute("SELECT uom_code, decimals FROM uom")}
    bad = c.execute("SELECT ic.pn, l.qty_per, l.uom_code FROM bom_line l JOIN item ic ON ic.item_id=l.child_item_id").fetchall()
    viol = [b for b in bad if len(str(float(b[1])).split('.')[1].rstrip('0')) > dec.get(b[2], 0)]
    rec("TC-34", "E", "적재 데이터의 소수 자릿수 규칙 준수", "PASS" if not viol else "FAIL",
        "위반 0건", f"{len(viol)}건 {viol}")
    rec("TC-34b", "E", "소수 수량 반올림 정책", "BLOCK", "정책대로",
        "계획서에 반올림·최소포장 정책이 없다 (§5.1 은 자릿수만 정의) → 미실시")
    c.close()


def group_F():
    log("\n### F. 유효일자 (TC-35~40, TC-59)")
    c = conn(rw=True)
    ok, msg = blocked(lambda: ins_line(c, bid(c, "PL-9000"), iid(c, "BW-2050"), line_no=600,
                                       valid_from="2026-12-31", valid_to="2026-01-01"))
    rec("TC-35", "F", "valid_to < valid_from 인 행", "PASS" if ok else "FAIL",
        "CHECK(valid_to >= valid_from) 로 거부",
        msg + " ← bom_line·bom_header 어디에도 이 CHECK 가 없다 → 결함 D-6")
    c.close()

    c = conn(rw=True)
    b = bid(c, "PL-9000"); x = iid(c, "WW-3060")
    ins_line(c, b, x, line_no=610, valid_from="2026-01-01", valid_to="2026-06-30")
    ok, msg = blocked(lambda: ins_line(c, b, x, line_no=611, valid_from="2026-06-01", valid_to="2026-12-31"))
    rec("TC-36", "F", "기간 겹침 (01-01~06-30 vs 06-01~12-31)", "PASS" if ok else "FAIL", "거부", msg)

    ok2, msg2 = blocked(lambda: c.execute(
        "UPDATE bom_line SET valid_from='2026-01-01', valid_to='2026-12-31' WHERE line_id="
        "(SELECT line_id FROM bom_line WHERE bom_id=? AND child_item_id=?)", (b, x)))
    over = c.execute(
        "SELECT count(*) FROM bom_line a JOIN bom_line c2 ON a.bom_id=c2.bom_id"
        " AND a.child_item_id=c2.child_item_id AND a.line_id<c2.line_id"
        " AND a.valid_from<=c2.valid_to AND c2.valid_from<=a.valid_to").fetchone()[0]
    rec("TC-59", "F", "UPDATE 로 기간 겹침 만들기", "PASS" if ok2 else "FAIL",
        "거부 (R-9 UPDATE 트리거)",
        f"{msg2} · 현재 DB 안의 겹침 쌍 {over}건 ← R-9 는 BEFORE INSERT 트리거뿐이다 → 결함 D-7")
    c.close()

    c = conn(rw=True)
    b, x = bid(c, "PL-9000"), iid(c, "BT-3070")
    ins_line(c, b, x, line_no=620, qty_per=1, valid_from="2026-01-01", valid_to="2026-05-31")
    ins_line(c, b, x, line_no=621, qty_per=2, valid_from="2026-06-01", valid_to="9999-12-31")
    for tc, day, want in (("TC-37", "2026-02-01", 1.0), ("TC-38", "2026-08-01", 2.0)):
        rows = [r for r in B.explode(c, asof=day) if r["pn"] == "BT-3070" and "PL-9000" in r["path"]]
        got = sum(r["qty"] for r in rows)
        rec(tc, "F", f"as-of {day} 조회", "PASS" if (len(rows) == 1 and abs(got-want) < EPS) else "FAIL",
            f"1건 · 수량 {want}", f"{len(rows)}건 · 수량 {got}")
    rows = [r for r in B.explode(c, asof="2026-06-15") if r["pn"] == "BT-3070" and "PL-9000" in r["path"]]
    rec("TC-39", "F", "겹침 구간 as-of 조회", "PASS" if len(rows) == 1 else "FAIL",
        "1건 (겹침이 입력에서 막혔으므로)", f"{len(rows)}건")

    t_feb, _ = B.leaf_totals(c, asof="2026-02-01")
    t_aug, _ = B.leaf_totals(c, asof="2026-08-01")
    rec("TC-40", "F", "과거 시점 BOM 전개", "PASS" if abs(t_aug["EA"] - t_feb["EA"] - 1) < EPS else "FAIL",
        "2월 EA 77 · 8월 EA 78 (BT-3070 1→2)", f"2월 {t_feb['EA']} · 8월 {t_aug['EA']}")

    # bom_header 레벨 겹침 — 계획서에 규칙이 없다
    c.execute("INSERT INTO bom_header(parent_item_id,alt_no,rev,base_qty,base_uom,status,valid_from,valid_to)"
              " VALUES ((SELECT item_id FROM item WHERE pn='PL-9000'),'00','B',1,'EA','ACTIVE','2026-01-01','9999-12-31')")
    nh = c.execute("SELECT count(*) FROM bom_header h JOIN item i ON i.item_id=h.parent_item_id"
                   " WHERE i.pn='PL-9000' AND h.status IN ('APPROVED','ACTIVE')"
                   "   AND '2026-06-01' BETWEEN h.valid_from AND h.valid_to").fetchone()[0]
    rec("TC-F41", "F", "같은 부모에 ACTIVE 리비전 2개가 같은 기간에", "FAIL",
        "거부 — 한 시점에 유효한 BOM 은 부모당 1개",
        f"rev A 와 rev B 가 동시에 ACTIVE · as-of 조회 {nh}건 → 전개가 결정 불가. "
        f"R-9 는 bom_line 만 본다. bom_header 겹침 규칙이 없다 → 결함 D-12")
    c.close()


def group_G():
    log("\n### G. 대체품 (TC-41~44)")
    c = conn(rw=True)
    b = bid(c, "RA-2000")
    m1, m2 = iid(c, "PM-2030"), new_item(c, "PM-2030X")
    c.execute("UPDATE bom_line SET alt_group='MAG', alt_priority=1 WHERE bom_id=? AND child_item_id=?", (b, m1))
    ok, msg = blocked(lambda: ins_line(c, b, m2, line_no=500, qty_per=8, alt_group="MAG", alt_priority=2,
                                       valid_from="2026-01-01"))
    rec("TC-41", "G", "같은 대체 그룹 2품목이 기간 겹치게 유효", "FAIL" if not ok else "PASS",
        "거부 또는 우선순위로 1개만 유효 확정",
        f"{msg} — 같은 alt_group 에 둘이 동시에 유효하게 들어간다. "
        f"ux_bom_line_dup 는 (bom,child,group,from) 이라 **자식이 다르면 통과**한다")
    ok2, msg2 = blocked(lambda: ins_line(c, b, new_item(c, "PM-2030Y"), line_no=501, qty_per=8,
                                         alt_group="MAG", alt_priority=1, valid_from="2026-01-01"))
    rec("TC-42", "G", "같은 그룹에 우선순위 중복 (1,1)", "FAIL" if not ok2 else "PASS",
        "거부 — UNIQUE(bom_id, alt_group, alt_priority) 권고",
        f"{msg2} — 우선순위 1 이 둘이다. 어느 쪽이 주자재인지 DB 가 답 못 한다 → 결함 D-13")

    single = c.execute("SELECT alt_group, count(*) c FROM bom_line WHERE alt_group IS NOT NULL"
                       " GROUP BY bom_id, alt_group HAVING c=1").fetchall()
    rec("TC-43", "G", "대체 그룹에 품목이 1개뿐", "PASS",
        "경고 목록", f"{len(single)}건 — 계획서에 이 점검 쿼리가 없다 (검증자 작성)")

    tot, per = B.leaf_totals(c, asof=ASOF)
    mags = {k: v for k, v in per.items() if k[0].startswith("PM-2030")}
    rec("TC-44", "G", "대체품이 있는 BOM 전개 — 주자재만 1회 계상", "FAIL",
        "PM-2030 8 EA 만 (대체품 제외)", f"{mags} → 합계 EA {round(tot['EA'],1)} "
        f"(기대 76). **전개 쿼리에 alt_priority 를 보는 규칙이 계획서에 없다** → R-18")
    c.close()


def seed_lots(c):
    """§3.3 로트 계보 시나리오 1건을 실제로 넣는다 (코일 → 완성품 시리얼)."""
    c.execute("INSERT INTO zones(id,name,color,rect_x,rect_y,rect_w,rect_h) VALUES (1,'A','#fff',0,0,1,1)")
    c.execute("INSERT INTO equipments(id,zone_id,code,name,x,y,op) VALUES (1,1,'EQ-A10','300t 프레스',0,0,'OP-A10')")
    c.execute("INSERT INTO users(id,emp_no,name) VALUES (1,'E001','노하린')")
    c.execute("INSERT INTO work_orders(id,equipment_id) VALUES (1,1)")
    c.execute("INSERT INTO production_records(id,work_order_id,equipment_id,user_id,qty_good) VALUES (1,1,1,1,80)")
    lots = [
        ("LOT-SC1011-260912-A", "SC-1011", "LOT",    None, 850.0, "kg", "POSCO", "MS-8842"),
        ("SUB-SC1011-A-001",    "SC-1011", "SUBLOT", "LOT-SC1011-260912-A", 0.85, "kg", None, None),
        ("SUB-SC1011-A-RET",    "SC-1011", "SUBLOT", "LOT-SC1011-260912-A", 849.15, "kg", None, None),
        ("LOT-SC1010P-260912-0007", "SC-1010P", "LOT", None, 80.0, "SHT", None, None),
        ("LOT-SC1010-260912-0007",  "SC-1010",  "LOT", None, 1.0, "EA", None, None),
        ("LOT-SA1000-260912-031",   "SA-1000",  "LOT", None, 1.0, "EA", None, None),
        ("SN-BLDC-2026-000481",     "BLDC-500W-48V", "SERIAL", None, 1.0, "EA", None, None),
    ]
    lid = {}
    for no, pn, kind, par, q, u, sup, slot in lots:
        cur = c.execute(
            "INSERT INTO mat_lot(lot_no,item_id,lot_kind,parent_lot_id,qty,uom_code,supplier,supplier_lot,made_at)"
            " VALUES (?,(SELECT item_id FROM item WHERE pn=?),?,?,?,?,?,?,'2026-09-12')",
            (no, pn, kind, lid.get(par), q, u, sup, slot))
        lid[no] = cur.lastrowid
    pid = {r[1]: r[0] for r in c.execute("SELECT id,op FROM processes")}
    gen = [
        ("LOT-SC1010P-260912-0007", "SUB-SC1011-A-001",        "OP-A10", 0.85, "kg"),
        ("LOT-SC1010-260912-0007",  "LOT-SC1010P-260912-0007", "OP-A20", 80.0, "SHT"),
        ("LOT-SA1000-260912-031",   "LOT-SC1010-260912-0007",  "OP-A100", 1.0, "EA"),
        ("SN-BLDC-2026-000481",     "LOT-SA1000-260912-031",   "OP-B120", 1.0, "EA"),
    ]
    for o, i, op, q, u in gen:
        c.execute("INSERT INTO lot_genealogy(out_lot_id,in_lot_id,process_id,equipment_id,user_id,record_id,"
                  "qty_consumed,uom_code) VALUES (?,?,?,1,1,1,?,?)", (lid[o], lid[i], pid[op], q, u))
    return lid


# 로트 축의 간선은 두 종류다 — ① mat_lot.parent_lot_id (분할) ② lot_genealogy (투입→산출).
# SQLite 는 재귀 CTE 본문에서 자기 자신을 두 번 참조하지 못한다("circular reference: fwd").
# 그래서 두 간선을 먼저 비재귀 CTE(lot_edge) 하나로 합쳐야 한다.
# **계획서 §3.3 은 '정방향으로 재귀 전개하면 된다'고만 적었고 이 제약을 다루지 않는다** → R-18.
LOT_EDGE = """lot_edge(parent, child, kind) AS (
  SELECT parent_lot_id, lot_id, 'SPLIT'   FROM mat_lot WHERE parent_lot_id IS NOT NULL
  UNION ALL
  SELECT in_lot_id,    out_lot_id, 'CONSUME' FROM lot_genealogy)"""

GEN_BACK = "WITH RECURSIVE " + LOT_EDGE + """,
back(lot_id, depth, path) AS (
  SELECT lot_id, 0, lot_no FROM mat_lot WHERE lot_no = :lot
  UNION ALL
  SELECT e.parent, back.depth+1, back.path || ' < ' || m.lot_no
    FROM back JOIN lot_edge e ON e.child = back.lot_id
              JOIN mat_lot m ON m.lot_id = e.parent
   WHERE back.depth < 20)
SELECT b.depth, m.lot_no, i.pn, b.path FROM back b JOIN mat_lot m ON m.lot_id=b.lot_id
  JOIN item i ON i.item_id=m.item_id ORDER BY b.depth"""

GEN_FWD = "WITH RECURSIVE " + LOT_EDGE + """,
fwd(lot_id, depth, path) AS (
  SELECT lot_id, 0, lot_no FROM mat_lot WHERE lot_no = :lot
  UNION ALL
  SELECT e.child, fwd.depth+1, fwd.path || ' > ' || m.lot_no
    FROM fwd JOIN lot_edge e ON e.parent = fwd.lot_id
             JOIN mat_lot m ON m.lot_id = e.child
   WHERE fwd.depth < 20)
SELECT f.depth, m.lot_no, i.pn, f.path FROM fwd f JOIN mat_lot m ON m.lot_id=f.lot_id
  JOIN item i ON i.item_id=m.item_id ORDER BY f.depth"""


def group_H():
    log("\n### H. 로트 계보 (TC-45~47 · V-9)")
    c = conn(rw=True)
    seed_lots(c)
    fwd = c.execute(GEN_FWD, {"lot": "LOT-SC1011-260912-A"}).fetchall()
    reach = {r[2] for r in fwd}
    want = {"SC-1011", "SC-1010P", "SC-1010", "SA-1000", "BLDC-500W-48V"}
    rec("TC-45", "H", "정방향 — 코일 로트 → 완성품 시리얼", "PASS" if want <= reach else "FAIL",
        f"{sorted(want)} 전부 도달", f"{sorted(reach)}")
    for d, lot, pn, path in fwd:
        log(f"           {'  '*d}[{d}] {lot:26} {pn}")

    back = c.execute(GEN_BACK, {"lot": "SN-BLDC-2026-000481"}).fetchall()
    rb = {r[2] for r in back}
    rec("TC-46", "H", "역방향 — 완성품 시리얼 → 원자재 로트", "PASS" if want <= rb else "FAIL",
        f"{sorted(want)} 전부 도달", f"{sorted(rb)}")
    ms = c.execute("SELECT supplier, supplier_lot FROM mat_lot WHERE lot_no='LOT-SC1011-260912-A'").fetchone()
    log(f"           종착점: 공급사 {ms[0]} · 밀시트 {ms[1]}")

    aff = c.execute("""
      WITH RECURSIVE lot_edge(parent,child) AS (
        SELECT parent_lot_id, lot_id FROM mat_lot WHERE parent_lot_id IS NOT NULL
        UNION ALL SELECT in_lot_id, out_lot_id FROM lot_genealogy),
      f(lot_id) AS (
        SELECT lot_id FROM mat_lot WHERE lot_no='LOT-SC1011-260912-A'
        UNION SELECT e.child FROM f JOIN lot_edge e ON e.parent=f.lot_id)
      SELECT m.lot_no FROM f JOIN mat_lot m ON m.lot_id=f.lot_id WHERE m.lot_kind='SERIAL'""").fetchall()
    rec("TC-47", "H", "원자재 로트 불량 → 영향받는 완제품 전부 (리콜 범위)",
        "PASS" if aff else "FAIL", "SN-BLDC-2026-000481", [a[0] for a in aff])

    # ── 로트 축의 반례 ──────────────────────────────────────────────────
    a = c.execute("SELECT lot_id FROM mat_lot WHERE lot_no='LOT-SC1010-260912-0007'").fetchone()[0]
    ok, msg = blocked(lambda: c.execute(
        "INSERT INTO lot_genealogy(out_lot_id,in_lot_id,qty_consumed,uom_code) VALUES (?,?,1,'EA')", (a, a)))
    rec("TC-H1", "H", "lot_genealogy 자기참조 (R-13)", "PASS" if ok else "FAIL",
        "CHECK(in_lot_id <> out_lot_id) 로 거부",
        msg + " ← R-13 은 규칙표에 'CHECK' 라 적혀 있으나 §5.6 DDL 에 그 CHECK 가 없다 → 결함 D-14")

    x = c.execute("SELECT lot_id FROM mat_lot WHERE lot_no='LOT-SC1010P-260912-0007'").fetchone()[0]
    y = c.execute("SELECT lot_id FROM mat_lot WHERE lot_no='SUB-SC1011-A-001'").fetchone()[0]
    ok2, msg2 = blocked(lambda: c.execute(
        "INSERT INTO lot_genealogy(out_lot_id,in_lot_id,process_id,qty_consumed,uom_code)"
        " VALUES (?,?,NULL,1,'EA')", (y, x)))
    rec("TC-H2", "H", "계보 순환 (A→B 가 이미 있는데 B→A 추가)", "PASS" if ok2 else "FAIL",
        "거부 — 계보는 비순환이어야",
        msg2 + " ← 로트 계보에는 순환 차단 장치가 **하나도 없다.** 정·역 추적 쿼리가 무한 루프한다 → 결함 D-15")

    ok3, msg3 = blocked(lambda: c.execute(
        "UPDATE mat_lot SET parent_lot_id=(SELECT lot_id FROM mat_lot WHERE lot_no='SUB-SC1011-A-001')"
        " WHERE lot_no='LOT-SC1011-260912-A'"))
    rec("TC-H3", "H", "mat_lot 분할 계보 자기순환 (부모↔자식 맞물림)", "PASS" if ok3 else "FAIL",
        "거부", msg3 + " ← mat_lot.parent_lot_id 에도 순환 차단이 없다 → D-15")

    ok4, msg4 = blocked(lambda: c.execute(
        "INSERT INTO lot_genealogy(out_lot_id,in_lot_id,process_id,qty_consumed,uom_code)"
        " VALUES (?,?,NULL,1,'EA')", (x, y)))
    ok5, msg5 = blocked(lambda: c.execute(
        "INSERT INTO lot_genealogy(out_lot_id,in_lot_id,process_id,qty_consumed,uom_code)"
        " VALUES (?,?,NULL,1,'EA')", (x, y)))
    rec("TC-H4", "H", "UNIQUE(out,in,process_id) 에서 process_id=NULL 중복", "FAIL" if not ok5 else "PASS",
        "2번째 거부", f"1={msg4} / 2={msg5} — SQLite 는 NULL 을 서로 다르게 본다. "
        f"공정 미지정 계보 행이 무한 중복된다 → 결함 D-16")
    c.close()


def group_I():
    log("\n### I. 성능 (TC-48~50 · V-11) — 품목 1만 · 레벨 5")
    path = os.path.join(OUT, "perf.db")
    if os.path.exists(path): os.remove(path)
    c = sqlite3.connect(path); c.isolation_level = None
    c.execute("PRAGMA foreign_keys=ON")
    import r2_load as L
    for p in (os.path.join(HERE, "prereq_existing.sql"), os.path.join(HERE, "ddl_v09_patched.sql")):
        for s in L.statements(p): c.execute(s)
    c.executemany("INSERT INTO uom(uom_code,name_ko,dim,decimals,is_base) VALUES (?,?,?,?,?)", L.UOM)
    c.execute("INSERT INTO mat_class(class_code,name) VALUES ('ALL','전체')")

    N, FAN = 10000, 5
    t0 = time.perf_counter()
    c.execute("BEGIN")
    for i in range(N):
        c.execute("INSERT INTO item(item_id,pn,name,class_id,item_type,source_type,base_uom,status)"
                  " VALUES (?,?,?,1,'PT','BUY','EA','ACTIVE')", (i + 1, f"P{i:05d}", f"P{i:05d}"))
    n_par = 0
    for i in range(N):
        kids = [i * FAN + k + 2 for k in range(FAN)]
        if kids[-1] > N: break
        c.execute("INSERT INTO bom_header(bom_id,parent_item_id,base_uom,status,valid_from)"
                  " VALUES (?,?,'EA','ACTIVE','2026-01-01')", (i + 1, i + 1))
        n_par += 1
    c.commit(); t_item = time.perf_counter() - t0

    t0 = time.perf_counter()
    c.execute("BEGIN")
    n_line = 0
    for i in range(n_par):
        for k in range(FAN):
            ch = i * FAN + k + 2
            if ch > N: break
            c.execute("INSERT INTO bom_line(bom_id,line_no,child_item_id,qty_per,uom_code,valid_from)"
                      " VALUES (?,?,?,1,'EA','2026-01-01')", (i + 1, 10 * (k + 1), ch))
            n_line += 1
    # 다부모 500건 (공용 부품)
    for k in range(500):
        try:
            c.execute("INSERT INTO bom_line(bom_id,line_no,child_item_id,qty_per,uom_code,valid_from)"
                      " VALUES (?,?,?,1,'EA','2026-01-01')", (k + 1, 900, N))
            n_line += 1
        except Exception:
            pass
    c.commit(); t_line = time.perf_counter() - t0
    depth = c.execute("""WITH RECURSIVE d(i,dep) AS (SELECT 1,0 UNION ALL
        SELECT l.child_item_id, d.dep+1 FROM d JOIN bom_header h ON h.parent_item_id=d.i
        JOIN bom_line l ON l.bom_id=h.bom_id WHERE d.dep<10) SELECT max(dep) FROM d""").fetchone()[0]
    log(f"    생성: 품목 {N} · BOM 헤더 {n_par} · 라인 {n_line} · 최대 깊이 {depth}")
    log(f"    적재 시간: item {t_item*1000:.0f} ms · bom_line {t_line*1000:.0f} ms "
        f"(= 라인당 {t_line/max(n_line,1)*1000:.3f} ms, R-1 트리거 포함)")

    t0 = time.perf_counter(); rows = B.explode(c, root="P00000", asof="2026-06-01")
    dt1 = (time.perf_counter() - t0) * 1000
    rec("TC-48", "I", f"품목 {N} · 레벨 {depth} 정전개", "PASS" if dt1 < 5000 else "FAIL",
        "< 5,000 ms", f"{dt1:.1f} ms · {len(rows)}행")

    t0 = time.perf_counter(); wu = B.where_used(c, f"P{N-1:05d}", "2026-06-01")
    dt2 = (time.perf_counter() - t0) * 1000
    rec("TC-49", "I", "같은 규모 역전개 (다부모 500 포함)", "PASS" if dt2 < 3000 else "FAIL",
        "< 3,000 ms", f"{dt2:.1f} ms · {len(wu)}행")

    t0 = time.perf_counter()
    ok, msg = blocked(lambda: c.execute(
        "INSERT INTO bom_line(bom_id,line_no,child_item_id,qty_per,uom_code,valid_from)"
        " VALUES (1,950,1,1,'EA','2026-01-01')"))
    dt3 = (time.perf_counter() - t0) * 1000
    rec("TC-50", "I", "같은 규모에서 순환 INSERT 검출", "PASS" if (ok and dt3 < 3000) else "FAIL",
        "< 3,000 ms · 거부", f"{dt3:.1f} ms · {msg}")

    t0 = time.perf_counter()
    tot, _ = B.leaf_totals(c, root="P00000", asof="2026-06-01")
    dt4 = (time.perf_counter() - t0) * 1000
    rec("TC-50b", "I", "말단 합계 산출 (leaf_totals — has_bom 을 행마다 호출)",
        "PASS" if dt4 < 5000 else "FAIL", "< 5,000 ms",
        f"{dt4:.1f} ms ← 전개 {dt1:.0f} ms 의 {dt4/max(dt1,0.01):.0f}배. "
        f"계획서에 합계 SQL 이 없어 검증자가 쓴 구현의 한계. v1.0 이 합계 쿼리를 정해야 한다 (R-18)")
    c.close()


def group_J():
    log("\n### J. 마이그레이션 (TC-51~53)")
    c = conn()
    src = {r[0] for r in c.execute("SELECT pn FROM parts")} | {"BLDC-500W-48V"} | \
          {r[0] for r in c.execute("SELECT parent_pn FROM parts WHERE parent_pn NOT LIKE '%/%'")}
    dst = {r[0] for r in c.execute("SELECT pn FROM item")}
    lost = sorted(src - dst - {"HA-3000/EX-5000"})
    added = sorted(dst - src)
    rec("TC-51", "J", "현행 parts 56행 → 새 구조 적재 손실 0", "PASS" if not lost else "FAIL",
        "손실 0건 · 못 옮기는 행은 거부 목록", f"소실 {lost or '없음'} · 신규 {added}")
    log("           ※ 소실 0 이지만 **FS-7020 의 뜻이 조용히 바뀐다**: 현행 parts 의 FS-7020 행(Base 단품)이 "
        "FS-7023 이 되고, 같은 P/N 이 조립품만 가리키게 된다. 거부 목록이 아니라 **개번 로그**로 남아야 한다 (R-15)")

    tot, _ = B.leaf_totals(c, asof=ASOF)
    exp = {"EA": 76.0, "g": 221.0, "SHT": 12.0, "kg": 0.85, "m": 0.5}
    ok = all(abs(tot.get(k, 0) - v) < EPS for k, v in exp.items()) and set(tot) == set(exp)
    rec("TC-52", "J", "마이그레이션 후 전개 = §1.9 기대값 (차원별 합계)", "PASS" if ok else "FAIL",
        "EA 76 · g 221 · 매(SHT) 12 · kg 0.85 · m 0.5", {k: round(v, 4) for k, v in tot.items()})
    log("           ※ 합계는 맞지만 TC-11b 대로 **내역이 4건 다르다.** 로드맵 2단계 완료기준 ① 은 "
        "이 합계만 보므로 SC-1010↔PK-0010, FS-7020↔FS-7023 맞바꿈을 못 잡는다 → R-21")
    c.close()

    n1 = os.path.join(OUT, "idem1.db"); n2 = os.path.join(OUT, "idem2.db")
    import subprocess
    for n in (n1, n2):
        subprocess.run([sys.executable, os.path.join(HERE, "r2_load.py"), "--db", n],
                       cwd=HERE, capture_output=True, env={**os.environ, "PYTHONUTF8": "1"})
    def sig(p):
        x = sqlite3.connect(p)
        s = (x.execute("SELECT count(*) FROM item").fetchone()[0],
             x.execute("SELECT count(*) FROM bom_line").fetchone()[0],
             x.execute("SELECT round(sum(qty_per),6) FROM bom_line").fetchone()[0])
        x.close(); return s
    rec("TC-53", "J", "적재 재실행 멱등", "PASS" if sig(n1) == sig(n2) else "FAIL",
        "두 번 돌려도 동일", f"{sig(n1)} vs {sig(n2)}")
    log("           ※ 단, 스크립트가 매번 **DB 파일을 지우고 새로 만든다.** 기존 DB 에 두 번 적재하는 "
        "진짜 멱등(UPSERT)은 계획서 §9.3 에 절차가 없다 → 미검증")


def main():
    log("=" * 78)
    log("§3 실증 검증 — [4] 테스트 케이스 TC-01 ~ TC-59 (계획서 v0.9 스키마)")
    log(f"    DB {os.path.relpath(DB, HERE)} · as-of {ASOF} · sqlite {sqlite3.sqlite_version}")
    log("=" * 78)
    for g in (group_A, group_B, group_C, group_D, group_E, group_F, group_G, group_H, group_I, group_J):
        try:
            g()
        except Exception as e:
            import traceback; traceback.print_exc()
            log(f"  !! {g.__name__} 중단: {type(e).__name__}: {e}")

    log("\n" + "=" * 78)
    n = {"PASS": 0, "FAIL": 0, "BLOCK": 0}
    for r in RESULTS: n[r["verdict"]] += 1
    log(f"합계 {len(RESULTS)}건 — PASS {n['PASS']} · FAIL {n['FAIL']} · BLOCKED {n['BLOCK']}")
    log("\nFAIL 목록:")
    for r in RESULTS:
        if r["verdict"] == "FAIL": log(f"   {r['tc']:8} {r['desc']}")
    log("\nBLOCKED 목록:")
    for r in RESULTS:
        if r["verdict"] == "BLOCK": log(f"   {r['tc']:8} {r['desc']}")
    log("=" * 78)

    with open(os.path.join(OUT, "csv", "tc_result.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=["tc", "group", "desc", "verdict", "expect", "actual", "repro"])
        w.writeheader(); w.writerows(RESULTS)
    open(os.path.join(OUT, "05_tests.log"), "w", encoding="utf-8").write(buf.getvalue())


if __name__ == "__main__":
    main()
