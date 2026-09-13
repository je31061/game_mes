# -*- coding: utf-8 -*-
"""
r2_ddl.py — 계획서 v0.9 §5·§6 DDL을 **원문 그대로** SQLite에 올린다.
문(statement) 단위로 쪼개 하나씩 실행하고, 실패한 문과 원문 줄번호·오류를 그대로 남긴다.

실행:  python r2_ddl.py            (출력 → out/01_ddl.log)
       python r2_ddl.py --patched  (수정본도 함께 시험)
"""
from __future__ import annotations
import os, re, sqlite3, sys, io

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)

RAW = os.path.join(HERE, "ddl_v09_raw.sql")
PATCHED = os.path.join(HERE, "ddl_v09_patched.sql")
PREREQ = os.path.join(HERE, "prereq_existing.sql")


def split_statements(sql: str):
    """SQLite 자신의 sqlite3_complete()(= sqlite3.complete_statement)로 문 경계를 판정한다.
    CREATE TRIGGER ... BEGIN ... END; 도 이 함수가 올바로 처리한다.
    반환: [(시작 줄번호, 문 텍스트), ...]"""
    out, buf, start = [], [], 1
    lineno = 0
    for line in sql.splitlines(True):
        lineno += 1
        if not buf:
            start = lineno
        buf.append(line)
        txt = "".join(buf)
        if sqlite3.complete_statement(txt):
            if not _is_only_comment(txt):
                out.append((start, txt))
            buf = []
    if buf and not _is_only_comment("".join(buf)):
        out.append((start, "".join(buf)))
    return out


def _is_only_comment(txt: str) -> bool:
    body = re.sub(r"--[^\n]*", "", txt)
    return not body.strip().strip(";").strip()


def label(stmt: str) -> str:
    m = re.search(r"(?is)^\s*(CREATE\s+(?:UNIQUE\s+)?\w+)\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w\.\"]+)", stmt)
    if m:
        return f"{m.group(1).upper().replace(chr(10),' ')} {m.group(2)}"
    return stmt.strip().splitlines()[0][:60]


def run_file(path, con, log, tag):
    sql = open(path, encoding="utf-8").read()
    stmts = split_statements(sql)
    ok = fail = 0
    failures = []
    for start, stmt in stmts:
        try:
            con.execute(stmt)
            ok += 1
            log(f"  [OK  ] L{start:<4} {label(stmt)}")
        except Exception as e:
            fail += 1
            failures.append((start, label(stmt), str(e), stmt))
            log(f"  [FAIL] L{start:<4} {label(stmt)}")
            log(f"         └─ {type(e).__name__}: {e}")
    log(f"  ── {tag}: 문 {len(stmts)}건 · 성공 {ok} · 실패 {fail}")
    return failures


def main():
    buf = io.StringIO()

    def log(s=""):
        print(s)
        buf.write(s + "\n")

    log("=" * 78)
    log("§3 실증 검증 — [1] 계획서 v0.9 §5·§6 DDL 원문 실행 시험")
    log(f"    python {sys.version.split()[0]} · sqlite3 {sqlite3.sqlite_version}")
    log("=" * 78)

    # ── (a) 원문 그대로 ────────────────────────────────────────────────────
    log("\n[a] ddl_v09_raw.sql — 계획서 원문 그대로 (선행 테이블 없음)")
    con = sqlite3.connect(":memory:")
    con.execute("PRAGMA foreign_keys=ON")
    f_raw_alone = run_file(RAW, con, log, "원문 단독")
    con.close()

    # ── (b) 기존 운영 테이블(processes 등)을 먼저 만든 뒤 원문 ─────────────
    log("\n[b] prereq_existing.sql(기존 운영 테이블) + ddl_v09_raw.sql")
    con = sqlite3.connect(":memory:")
    con.execute("PRAGMA foreign_keys=ON")
    run_file(PREREQ, con, lambda s: None, "prereq")
    f_raw = run_file(RAW, con, log, "원문 + 선행테이블")
    con.close()

    # ── (c) 수정본 ────────────────────────────────────────────────────────
    f_patched = None
    if os.path.exists(PATCHED):
        log("\n[c] prereq_existing.sql + ddl_v09_patched.sql — 노하린 최소 수정본")
        con = sqlite3.connect(":memory:")
        con.execute("PRAGMA foreign_keys=ON")
        run_file(PREREQ, con, lambda s: None, "prereq")
        f_patched = run_file(PATCHED, con, log, "수정본")
        con.close()

    log("\n" + "=" * 78)
    log("판정")
    log("=" * 78)
    if f_raw:
        log(f"  ▶ 결함: 계획서 §5 DDL은 **원문 그대로 실행되지 않는다**. 실패 {len(f_raw)}건")
        for start, lab, err, _ in f_raw:
            log(f"     - 계획서 기준 위치 L{start} (파일 ddl_v09_raw.sql) · {lab}")
            log(f"       오류: {err}")
    else:
        log("  ▶ 확인: 원문 DDL이 그대로 실행된다")
    if f_patched is not None:
        log(f"  ▶ 수정본 실패 {len(f_patched)}건")

    open(os.path.join(OUT, "01_ddl.log"), "w", encoding="utf-8").write(buf.getvalue())
    return 0


if __name__ == "__main__":
    sys.exit(main())
