# -*- coding: utf-8 -*-
"""
r2_v1.py — V-1 (최우선) : §6 R-1 순환 참조 트리거의 `WITH RECURSIVE` 가 실제로 동작하는가.
python sqlite3 판. 같은 시험을 r2_v1_node.mjs 가 node:sqlite 로 반복한다(운영은 node:sqlite).

실행: python r2_v1.py     (출력 → out/02_v1_python.log)
"""
from __future__ import annotations
import os, sqlite3, sys, time, io

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out"); os.makedirs(OUT, exist_ok=True)
DDL = os.path.join(HERE, "ddl_v09_patched.sql")
PREREQ = os.path.join(HERE, "prereq_existing.sql")


def statements(path):
    sql = open(path, encoding="utf-8").read()
    buf, out = [], []
    for line in sql.splitlines(True):
        buf.append(line)
        t = "".join(buf)
        if sqlite3.complete_statement(t):
            out.append(t); buf = []
    if "".join(buf).strip():
        out.append("".join(buf))
    return out


def fresh():
    con = sqlite3.connect(":memory:")
    con.execute("PRAGMA foreign_keys=ON")
    for p in (PREREQ, DDL):
        for s in statements(p):
            try: con.execute(s)
            except sqlite3.OperationalError as e:
                if "syntax error" in str(e) or "prohibited" in str(e): raise
    con.execute("INSERT INTO uom(uom_code,name_ko,dim,decimals,is_base) VALUES ('EA','개','COUNT',0,1)")
    con.execute("INSERT INTO mat_class(class_code,name) VALUES ('TEST','시험')")
    return con


def item(con, pn, itype="SA"):
    cur = con.execute(
        "INSERT INTO item(pn,name,class_id,item_type,source_type,base_uom) VALUES (?,?,1,?,'MAKE','EA')",
        (pn, pn, itype))
    return cur.lastrowid


def header(con, item_id, status="ACTIVE"):
    cur = con.execute(
        "INSERT INTO bom_header(parent_item_id,base_uom,status,valid_from) VALUES (?,'EA',?,'2026-01-01')",
        (item_id, status))
    return cur.lastrowid


def line(con, bom_id, child_id, no=10, qty=1.0):
    return con.execute(
        "INSERT INTO bom_line(bom_id,line_no,child_item_id,qty_per,uom_code,valid_from)"
        " VALUES (?,?,?,?,'EA','2026-01-01')", (bom_id, no, child_id, qty)).lastrowid


def try_line(con, bom_id, child_id, no=10):
    """반환: (차단됐나, 메시지)"""
    try:
        line(con, bom_id, child_id, no)
        return False, "통과 — 막지 못했다"
    except Exception as e:
        return True, f"{type(e).__name__}: {e}"


def make_chain(con, n, status):
    """X0→X1→…→X(n-1) 사슬을 만들고, 마지막 X(n-1)→X0 (순환 완성)을 시도한다."""
    ids = [item(con, f"X{i}") for i in range(n)]
    boms = [header(con, i, status) for i in ids]
    for i in range(n - 1):
        line(con, boms[i], ids[i + 1])
    return try_line(con, boms[n - 1], ids[0])


def main():
    buf = io.StringIO()
    def log(s=""):
        print(s); buf.write(s + "\n")

    log("=" * 78)
    log("V-1 · §6 R-1 순환 참조 트리거 실증 — python sqlite3")
    log(f"    python {sys.version.split()[0]} · sqlite3 라이브러리 {sqlite3.sqlite_version}")
    log("=" * 78)
    results = []

    def rec(tag, blocked, expect, msg):
        verdict = "확인" if blocked == expect else "결함"
        results.append((tag, verdict, blocked, expect, msg))
        mark = "OK " if blocked == expect else "!! "
        log(f"[{mark}] {tag}")
        log(f"       기대={'차단' if expect else '통과'} 실제={'차단' if blocked else '통과'} · {msg}")

    # ── 1. 트리거가 애초에 만들어졌는가 ──────────────────────────────────
    con = fresh()
    trg = [r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")]
    log(f"\n[1] 생성된 트리거: {trg}")
    log(f"    → 트리거 본문의 WITH RECURSIVE 가 CREATE 단계에서 거부되지 않았다: "
        f"{'확인' if 'trg_bom_line_cycle_ins' in trg else '결함'}")
    con.close()

    # ── 2. 자기참조 FS-7010 → FS-7010 (실데이터) ────────────────────────
    log("\n[2] 자기참조 — 실데이터 `FS-7010 → FS-7010`")
    for st in ("DRAFT", "APPROVED", "ACTIVE"):
        con = fresh()
        fid = item(con, "FS-7010")
        b = header(con, fid, st)
        blocked, msg = try_line(con, b, fid)
        rec(f"V-1a FS-7010→FS-7010 (bom_header.status='{st}')", blocked, True, msg)
        con.close()

    # ── 3. 길이 2 순환 A→B→A ────────────────────────────────────────────
    log("\n[3] 길이 2 순환 `A→B→A`")
    for st in ("DRAFT", "APPROVED", "ACTIVE"):
        con = fresh()
        blocked, msg = make_chain(con, 2, st)
        rec(f"V-1b A→B→A (양쪽 bom_header.status='{st}')", blocked, True, msg)
        con.close()

    # ── 4. 상태가 섞인 경우 ─────────────────────────────────────────────
    log("\n[4] 상태 혼재 — 중간 BOM 하나만 DRAFT")
    con = fresh()
    a, b_, c = item(con, "A"), item(con, "B"), item(con, "C")
    ba, bb, bc = header(con, a, "ACTIVE"), header(con, b_, "DRAFT"), header(con, c, "ACTIVE")
    line(con, ba, b_); line(con, bb, c)
    blocked, msg = try_line(con, bc, a)
    rec("V-1c A→B→C→A (B의 BOM만 DRAFT)", blocked, True, msg)
    con.close()

    # ── 5. 순환 길이별 경계 ─────────────────────────────────────────────
    log("\n[5] 순환 길이 2~20 (전부 ACTIVE) — 깊이 가드 `d.depth < 10` 의 경계")
    passed_through = []
    for n in range(2, 21):
        con = fresh()
        blocked, msg = make_chain(con, n, "ACTIVE")
        if not blocked:
            passed_through.append(n)
        con.close()
    log(f"    차단된 길이 : {[n for n in range(2,21) if n not in passed_through]}")
    log(f"    통과한 길이 : {passed_through}")
    results.append(("V-1d 순환 길이 경계", "확인" if not passed_through else "결함",
                    not passed_through, True,
                    f"길이 {passed_through} 가 통과한다 (가드 d.depth<10)" if passed_through else "전 길이 차단"))
    log(f"    → {'확인' if not passed_through else '결함: 위 길이의 순환이 그대로 들어간다'}")

    # ── 6. UPDATE 경로 ──────────────────────────────────────────────────
    log("\n[6] UPDATE 로 순환 만들기 (계획서: 'UPDATE용 동일 트리거 1개를 추가한다' — 초안에 코드 없음)")
    con = fresh()
    a, b_, z = item(con, "A"), item(con, "B"), item(con, "Z")
    ba, bb = header(con, a, "ACTIVE"), header(con, b_, "ACTIVE")
    line(con, ba, b_)                      # A→B
    lid = line(con, bb, z)                 # B→Z (정상)
    try:
        con.execute("UPDATE bom_line SET child_item_id=? WHERE line_id=?", (a, lid))
        blocked, msg = False, "통과 — UPDATE 로 B→A 가 들어가 A→B→A 순환이 완성됐다"
    except Exception as e:
        blocked, msg = True, f"{type(e).__name__}: {e}"
    rec("V-1e UPDATE bom_line SET child_item_id → 순환", blocked, True, msg)
    n_cyc = con.execute(
        "SELECT count(*) FROM bom_line l JOIN bom_header h ON h.bom_id=l.bom_id"
        " WHERE l.child_item_id=h.parent_item_id").fetchone()[0]
    log(f"       (참고) 자기참조 라인 수={n_cyc} · 실제 저장된 라인: "
        f"{con.execute('SELECT count(*) FROM bom_line').fetchone()[0]}")
    con.close()

    # ── 7. 거짓양성 — 정상 트리는 들어가야 ──────────────────────────────
    log("\n[7] 거짓양성 점검 — 정상 깊은 트리(깊이 9)와 다부모(공용부품)")
    con = fresh()
    ids = [item(con, f"N{i}") for i in range(10)]
    boms = [header(con, i, "ACTIVE") for i in ids]
    ok = True
    for i in range(9):
        try: line(con, boms[i], ids[i + 1])
        except Exception as e: ok = False; log(f"       거짓양성! {e}")
    shared = item(con, "SHARED", "PT")
    try:
        for i in (0, 3, 7):
            line(con, boms[i], shared, no=90)
    except Exception as e:
        ok = False; log(f"       거짓양성(다부모)! {e}")
    rec("V-1f 거짓양성 없음 (깊이 9 사슬 + 같은 자식 3부모)", not ok, False,
        "정상 데이터가 전부 들어갔다" if ok else "정상 데이터를 막았다")
    con.close()

    # ── 8. 지연 측정 ────────────────────────────────────────────────────
    log("\n[8] INSERT 지연 — 10단 전개가 걸리는 위치에서")
    # 깊이 10 · 층마다 자식 5개인 사슬을 만들고, 그 꼭대기(D0)를 자식으로 넣는 INSERT 를 측정한다.
    # (자식이 리프면 CTE 가 1행에서 끝나 아무것도 측정되지 않는다 — 반드시 꼭대기를 넣어야 한다)
    con = fresh()
    ids = [item(con, f"D{i}") for i in range(11)]
    boms = [header(con, i, "ACTIVE") for i in ids]
    for i in range(10):
        line(con, boms[i], ids[i + 1], no=10)
        for k in range(4):                       # 층마다 리프 4개 → 전개 폭 확보
            line(con, boms[i], item(con, f"D{i}_L{k}", "PT"), no=20 + k)
    walked = con.execute("""
        WITH RECURSIVE down(item_id,depth) AS (
          SELECT (SELECT item_id FROM item WHERE pn='D0'), 0
          UNION ALL
          SELECT l.child_item_id, d.depth+1 FROM down d
            JOIN bom_header h ON h.parent_item_id=d.item_id AND h.status IN ('APPROVED','ACTIVE')
            JOIN bom_line l ON l.bom_id=h.bom_id WHERE d.depth < 10)
        SELECT count(*), max(depth) FROM down""").fetchone()
    log(f"    트리거 CTE 가 실제로 훑는 행 수 = {walked[0]} · 최대 depth = {walked[1]}")
    probes = [(item(con, f"P{i}"),) for i in range(200)]
    pboms = [header(con, p[0], "ACTIVE") for p in probes]
    d0 = con.execute("SELECT item_id FROM item WHERE pn='D0'").fetchone()[0]
    t0 = time.perf_counter()
    for pb in pboms:
        line(con, pb, d0, no=10)
    dt = (time.perf_counter() - t0) / len(pboms) * 1000
    log(f"    10단 전개를 유발하는 INSERT 200행 · 행당 평균 **{dt:.3f} ms**")
    con.close()

    # ── 요약 ────────────────────────────────────────────────────────────
    log("\n" + "=" * 78)
    ng = [r for r in results if r[1] == "결함"]
    log(f"V-1 요약 — 확인 {len(results)-len(ng)} · 결함 {len(ng)}")
    for t, v, *_ in results:
        log(f"   [{v}] {t}")
    log("=" * 78)
    open(os.path.join(OUT, "02_v1_python.log"), "w", encoding="utf-8").write(buf.getvalue())


if __name__ == "__main__":
    main()
