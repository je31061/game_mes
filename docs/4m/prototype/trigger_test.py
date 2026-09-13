# -*- coding: utf-8 -*-
"""
trigger_test.py — 계획서 v0.9 §6 의 트리거 초안을 **원문 그대로** 시험한다.

윤태경 §13 의 검증 요청 V-1 · V-2 에 대한 답이다.
"SQLite 가 이 문법을 지원하는가"는 설계 판단이 아니라 **기술적 가부**라서
스키마 확정을 기다리지 않고 라운드 1에 돌렸다. 안 되면 설계를 되돌려야 하니까.

시험 대상 (계획서에서 복사, 한 글자도 고치지 않았다)
  R-1  trg_bom_line_cycle_ins   — 트리거 본문 안의 WITH RECURSIVE 로 순환 검출
  R-9  trg_bom_line_overlap_ins — 유효일자 겹침 차단
  ux_bom_line_dup               — COALESCE 식 유니크 인덱스

결과 요약 (SQLite 3.50.4)
  V-1  동작한다. 단 **순환 길이 12 이상을 놓친다**            (결함 D-1)
  V-2  인덱스는 동작. 단 **R-9 가 valid_to = NULL 에서 뚫린다** (결함 D-2)

실행:  python trigger_test.py
운영 DB는 열지 않는다. 전부 :memory: 다.
"""
from __future__ import annotations

import sqlite3
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

BASE_DDL = """
CREATE TABLE item(item_id INTEGER PRIMARY KEY, pn TEXT UNIQUE, item_type TEXT);
CREATE TABLE bom_header(bom_id INTEGER PRIMARY KEY, parent_item_id INT, status TEXT);
CREATE TABLE bom_line(line_id INTEGER PRIMARY KEY, bom_id INT, child_item_id INT,
                      qty REAL, alt_group TEXT, valid_from TEXT, valid_to TEXT);
"""

# ── 계획서 §6 R-1 원문 ────────────────────────────────────────────
TRG_CYCLE = """
CREATE TRIGGER trg_bom_line_cycle_ins BEFORE INSERT ON bom_line
BEGIN
  SELECT RAISE(ABORT, 'BOM 순환 참조 또는 레벨 초과')
  WHERE EXISTS (
    WITH RECURSIVE down(item_id, depth) AS (
      SELECT NEW.child_item_id, 0
      UNION ALL
      SELECT l.child_item_id, d.depth + 1
        FROM down d
        JOIN bom_header h ON h.parent_item_id = d.item_id
                         AND h.status IN ('APPROVED','ACTIVE')
        JOIN bom_line   l ON l.bom_id = h.bom_id
       WHERE d.depth < 10
    )
    SELECT 1 FROM down
     WHERE item_id = (SELECT parent_item_id FROM bom_header WHERE bom_id = NEW.bom_id)
  );
END;
"""

# ── 계획서 §6 R-9 원문 ────────────────────────────────────────────
TRG_OVERLAP = """
CREATE TRIGGER trg_bom_line_overlap_ins BEFORE INSERT ON bom_line
BEGIN
  SELECT RAISE(ABORT, 'BOM 라인 유효일자 겹침')
  WHERE EXISTS (
    SELECT 1 FROM bom_line x
     WHERE x.bom_id = NEW.bom_id
       AND x.child_item_id = NEW.child_item_id
       AND COALESCE(x.alt_group,'-') = COALESCE(NEW.alt_group,'-')
       AND NEW.valid_from <= x.valid_to
       AND NEW.valid_to   >= x.valid_from
  );
END;
"""

IDX_DUP = ("CREATE UNIQUE INDEX ux_bom_line_dup ON bom_line"
           "(bom_id, child_item_id, COALESCE(alt_group,'-'), valid_from)")

FAILS = []


def say(blocked, label, extra=""):
    tag = "차단 OK " if blocked else "통과 -> "
    print(f"  {tag} {label}" + (f"   [{extra}]" if extra else ""))


def chain_db(n, trg=TRG_CYCLE):
    """품목 1..n, 각 품목이 자기 BOM 을 갖고, 1→2→…→n 사슬을 만든다."""
    con = sqlite3.connect(":memory:")
    con.executescript(BASE_DDL)
    con.executescript(trg)
    for i in range(1, n + 1):
        con.execute("INSERT INTO item VALUES(?,?,?)", (i, f"P{i}", "SA"))
        con.execute("INSERT INTO bom_header VALUES(?,?,?)", (i, i, "ACTIVE"))
    for i in range(1, n):
        con.execute("INSERT INTO bom_line(bom_id,child_item_id,qty,valid_from,valid_to)"
                    " VALUES(?,?,1,'2026-01-01','9999-12-31')", (i, i + 1))
    con.commit()
    return con


def try_ins(con, bom, child, vf="2026-01-01", vt="9999-12-31", ag=None):
    """INSERT 를 시도하고, 막혔으면 예외를 돌려준다 (통과하면 None)."""
    try:
        con.execute("INSERT INTO bom_line(bom_id,child_item_id,qty,alt_group,valid_from,valid_to)"
                    " VALUES(?,?,1,?,?,?)", (bom, child, ag, vf, vt))
        con.commit()
        return None
    except sqlite3.Error as exc:
        return exc


def main():
    print(f"SQLite {sqlite3.sqlite_version}   (운영 DB 는 열지 않는다 — 전부 :memory:)")

    # ═══ V-1a 문법 성립 ═══
    print("\n[V-1a] 트리거 생성 — 본문 안의 WITH RECURSIVE 가 되는가")
    try:
        c = sqlite3.connect(":memory:")
        c.executescript(BASE_DDL)
        c.executescript(TRG_CYCLE)
        print("  OK  CREATE TRIGGER 성공 · CTE 안에서 NEW.child_item_id 참조 가능")
        c.close()
    except sqlite3.Error as exc:
        print(f"  FAIL CREATE TRIGGER 거부: {exc}")
        FAILS.append("V-1a")
        return 1

    # ═══ V-1b 자기 참조 ═══
    print("\n[V-1b] 자기 참조 A→A  (= 실데이터 FS-7010 · FS-7020 사례)")
    con = chain_db(3)
    exc = try_ins(con, 1, 1)
    say(bool(exc), "A 의 BOM 에 자식 A", str(exc) if exc else "")
    if not exc:
        FAILS.append("V-1b")
    con.close()

    # ═══ V-1c 거짓양성 ═══
    print("\n[V-1c] 정상 입력이 막히지는 않는가 (거짓양성)")
    con = chain_db(5)
    con.execute("INSERT INTO item VALUES(99,'Z','PART')")
    con.execute("INSERT INTO bom_header VALUES(99,99,'ACTIVE')")
    con.commit()
    exc = try_ins(con, 3, 99)
    if exc:
        print(f"  FAIL 정상 자식 입력이 막혔다: {exc}")
        FAILS.append("V-1c")
    else:
        print("  OK  정상 자식 입력 통과 — 거짓양성 없음")
    con.close()

    # ═══ V-1d 순환 길이별 한계 ═══  ★ 핵심
    print("\n[V-1d] 순환 길이별 차단 여부 — `WHERE d.depth < 10` 가드의 실제 한계")
    limit = None
    for L in range(2, 16):
        con = chain_db(L)
        exc = try_ins(con, L, 1)          # L → 1 로 닫으면 길이 L 순환
        blocked = bool(exc)
        print(f"    길이 {L:2d}  {'차단 OK' if blocked else '** 통과 — 막지 못함 **'}")
        if not blocked and limit is None:
            limit = L
        con.close()
    if limit is None:
        print("  OK  길이 15까지 전부 차단")
    else:
        print(f"\n  ** D-1 결함 ** 순환 길이 {limit} 이상은 통과한다 (실질 탐지 한계 = {limit - 1}).")
        print("     메시지는 'BOM 순환 참조 또는 레벨 초과' 인데, 레벨 초과로는 raise 하지 않고")
        print("     탐색을 포기할 뿐이다.  → 검증보고서 R-16")
        FAILS.append("V-1d")

    # ═══ V-1e INSERT 지연 ═══
    print("\n[V-1e] INSERT 지연 (트리거가 매 행마다 10단 전개)")
    N = 2000
    con = sqlite3.connect(":memory:")
    con.executescript(BASE_DDL)
    con.executescript(TRG_CYCLE)
    con.executemany("INSERT INTO item VALUES(?,?,?)",
                    [(i, f"P{i}", "SA") for i in range(1, N + 1)])
    con.executemany("INSERT INTO bom_header VALUES(?,?,?)",
                    [(i, i, "ACTIVE") for i in range(1, N + 1)])
    con.commit()
    t0 = time.perf_counter()
    for i in range(1, N):
        con.execute("INSERT INTO bom_line(bom_id,child_item_id,qty,valid_from,valid_to)"
                    " VALUES(?,?,1,'2026-01-01','9999-12-31')", (i, i + 1))
    con.commit()
    el = time.perf_counter() - t0
    print(f"  체인 {N-1}행 적재 {el*1000:.1f} ms  →  행당 {el/(N-1)*1000:.3f} ms   (허용 범위)")
    con.close()

    # ═══ V-2 식 인덱스 ═══
    print("\n[V-2] ux_bom_line_dup — COALESCE 식 유니크 인덱스")
    con = sqlite3.connect(":memory:")
    con.executescript(BASE_DDL)
    try:
        con.execute(IDX_DUP)
        print("  OK  식 인덱스 생성 성공")
    except sqlite3.Error as exc:
        print(f"  FAIL 식 인덱스 생성 거부: {exc}")
        FAILS.append("V-2")
        return 1
    try_ins(con, 1, 2)
    for label, kw, want_block in [
        ("같은 (bom,child,NULL그룹,같은 시작일) 2번째", dict(vf="2026-01-01"), True),
        ("같은 (bom,child,NULL그룹) 인데 시작일 다름", dict(vf="2026-06-01"), False),
        ("대체그룹만 다름", dict(vf="2026-01-01", ag="AG1"), False),
    ]:
        exc = try_ins(con, 1, 2, **kw)
        say(bool(exc), label, str(exc)[:50] if exc else "")
        if bool(exc) != want_block:
            print(f"       (기대: {'차단' if want_block else '통과'})")
    print("  → 시작일이 다른 겹침은 설계대로 R-9 트리거 몫이다. 역할 분담은 맞다.")
    con.close()

    # ═══ V-7 / R-9 겹침 트리거 ═══  ★ 핵심
    print("\n[V-7] R-9 유효일자 겹침 트리거 — valid_to 가 NULL 이면?")
    cases = [
        ("둘 다 날짜 있음 · 겹침", ("2026-01-01", "2026-06-30"), ("2026-06-01", "2026-12-31"), True),
        ("둘 다 날짜 있음 · 안 겹침", ("2026-01-01", "2026-05-31"), ("2026-06-01", "2026-12-31"), False),
        ("기존 행 valid_to = NULL", ("2026-01-01", None), ("2026-06-01", "2026-12-31"), True),
        ("신규 행 valid_to = NULL", ("2026-01-01", "2026-06-30"), ("2026-06-01", None), True),
        ("둘 다 valid_to = NULL", ("2026-01-01", None), ("2026-06-01", None), True),
    ]
    holes = 0
    for label, first, second, want_block in cases:
        con = sqlite3.connect(":memory:")
        con.executescript(BASE_DDL)
        con.executescript(TRG_OVERLAP)
        con.execute("INSERT INTO bom_line(bom_id,child_item_id,qty,valid_from,valid_to)"
                    " VALUES(1,2,1,?,?)", first)
        con.commit()
        exc = try_ins(con, 1, 2, vf=second[0], vt=second[1])
        blocked = bool(exc)
        mark = "OK " if blocked == want_block else "!! "
        print(f"  {mark}{label:26s} -> {'차단' if blocked else '통과'}"
              f"   (기대 {'차단' if want_block else '통과'})")
        if blocked != want_block:
            holes += 1
        con.close()
    if holes:
        print(f"\n  ** D-2 결함 ** {holes}가지 NULL 조합에서 겹침을 전혀 못 잡는다.")
        print("     SQL 3값 논리: `NEW.valid_to >= x.valid_from` 의 한쪽이 NULL 이면 결과가 NULL 이고")
        print("     EXISTS 는 거짓이 된다. '종료일 미정' 이 현업 최빈 상태라 사실상 상시 무력화.")
        print("     → 검증보고서 R-17 (valid_to NOT NULL DEFAULT '9999-12-31' 권장)")
        FAILS.append("V-7")

    print("\n" + "─" * 70)
    print("결론")
    print("  V-1  트리거는 **동작한다** — 설계 후퇴 불필요. 단 D-1(순환 길이 12+) 보완 필요")
    print("  V-2  식 인덱스 **동작** — R-9 와의 역할 분담 맞음")
    print("  V-7  R-9 트리거에 D-2(valid_to NULL) 구멍 — 반드시 보완")
    print(f"\n  발견한 결함: {', '.join(FAILS) if FAILS else '없음'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
