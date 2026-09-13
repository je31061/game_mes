# -*- coding: utf-8 -*-
"""
v1_ddl.py — [1] ddl-v1.sql 을 원문 그대로 문 단위로 실행한다 (python sqlite3).
  [a] 단독(선행 테이블 없음) · [b] 선행 테이블 뒤 · [c] 같은 DB 2회째(멱등) · [d] 객체 수 대조(윤태경 주장: 85문 = 테이블 12·인덱스 20·트리거 34·뷰 19)
실행: python v1_ddl.py   → out/01_ddl_python.log
"""
from __future__ import annotations
import sqlite3, sys
import common as C

log = C.Log("01_ddl_python.log")


def main():
    log("=" * 78)
    log("§6 v1.0 재검증 — [1] ddl-v1.sql 원문 실행 (python sqlite3)")
    log(f"    python {sys.version.split()[0]} · sqlite3 {sqlite3.sqlite_version} · 파일 {C.DDL}")
    log("=" * 78)
    verdicts = []

    # [a] 단독
    log("\n[a] 단독 — 선행 테이블 없이")
    con = sqlite3.connect(":memory:"); con.execute("PRAGMA foreign_keys=ON")
    n, ok, fails = C.run_ddl(con, log=lambda s: None)
    log(f"    문 {n} · 성공 {ok} · 실패 {len(fails)}")
    for f in fails: log(f"      FAIL L{f[0]} {f[1]} — {f[2]}")
    verdicts.append(("DDL-a 단독 실행", n == 85 and not fails, f"{n}문 · 실패 {len(fails)}"))
    con.close()

    # [b] 선행 테이블 뒤
    log("\n[b] 선행 테이블(v09/prereq_existing.sql = server/db.js 사본) 뒤")
    con = sqlite3.connect(":memory:"); con.execute("PRAGMA foreign_keys=ON")
    for _, s in C.statements(C.PREREQ): con.execute(s)
    n, ok, fails = C.run_ddl(con, log=log)
    log(f"    문 {n} · 성공 {ok} · 실패 {len(fails)}")
    verdicts.append(("DDL-b 선행 테이블 뒤 실행", n == 85 and not fails, f"{n}문 · 실패 {len(fails)}"))

    # [d] 객체 수
    obj = C.objects(con)
    pre = {r[0] for r in sqlite3.connect(":memory:").execute("select 1")}  # dummy
    pcon = sqlite3.connect(":memory:")
    for _, s in C.statements(C.PREREQ): pcon.execute(s)
    pre_tables = set(C.objects(pcon).get("table", [])); pcon.close()
    new_tables = [t for t in obj.get("table", []) if t not in pre_tables]
    cnt = {k: len(v) for k, v in obj.items()}
    log(f"\n[d] 객체 수: 전체 table {cnt.get('table',0)} (선행 {len(pre_tables)} + 신규 {len(new_tables)}) · index {cnt.get('index',0)} · trigger {cnt.get('trigger',0)} · view {cnt.get('view',0)}")
    log(f"    신규 테이블: {new_tables}")
    log(f"    트리거({cnt.get('trigger',0)}): {obj.get('trigger')}")
    log(f"    뷰({cnt.get('view',0)}): {obj.get('view')}")
    exp = dict(table=12, index=20, trigger=34, view=19)
    got = dict(table=len(new_tables), index=cnt.get("index", 0), trigger=cnt.get("trigger", 0), view=cnt.get("view", 0))
    verdicts.append(("DDL-d 객체 수 = 12/20/34/19", got == exp, f"{got}"))

    # [c] 2회째 (멱등)
    log("\n[c] 같은 DB 에 2회째 실행 (IF NOT EXISTS 멱등)")
    n2, ok2, fails2 = C.run_ddl(con, log=lambda s: None)
    obj2 = C.objects(con); cnt2 = {k: len(v) for k, v in obj2.items()}
    log(f"    문 {n2} · 성공 {ok2} · 실패 {len(fails2)} · 객체 수 불변 {cnt == cnt2}")
    verdicts.append(("DDL-c 2회째 멱등", not fails2 and cnt == cnt2, f"실패 {len(fails2)} · 객체 {cnt2}"))

    # PRAGMA · INSERT · DROP 이 없다는 주장 확인
    import re
    bad = []
    for start, stmt in C.statements(C.DDL):
        head = re.sub(r"--[^\n]*", "", stmt).strip().upper()
        if not head.startswith("CREATE"):
            bad.append((start, head[:40]))
    log(f"\n[e] 문 단위로 CREATE 가 아닌 문(PRAGMA/INSERT/DROP/UPDATE): {bad or '없음'} — 트리거 본문 안의 UPDATE(D-8 보정·D-17 qty_init)는 CREATE TRIGGER 한 문이다")
    verdicts.append(("DDL-e PRAGMA·INSERT·DROP 없음 (85문 전부 CREATE)", not bad, f"{bad or '없음'}"))
    con.close()

    log("\n" + "=" * 78)
    ng = [v for v in verdicts if not v[1]]
    log(f"판정 — 확인 {len(verdicts)-len(ng)} · 결함 {len(ng)}")
    for t, okv, d in verdicts: log(f"   [{'확인' if okv else '결함'}] {t} — {d}")
    log("=" * 78)
    log.save()
    return 0 if not ng else 1


if __name__ == "__main__":
    sys.exit(main())
