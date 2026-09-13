# -*- coding: utf-8 -*-
"""
common.py — prototype/v1 공용. 노하린 소유.
  · ddl-v1.sql(윤태경 원문) 을 **한 글자도 고치지 않고** 문 단위로 올린다.
  · 선행 테이블은 v09/prereq_existing.sql (server/db.js 사본) 을 그대로 재사용한다.
  · 운영 DB(data/factory.db) 는 열지 않는다. 여기서 만드는 DB 는 전부 out/ 또는 :memory:.
"""
from __future__ import annotations
import io, json, os, re, sqlite3, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))   # …/factory-world-master
OUT = os.path.join(HERE, "out")
os.makedirs(os.path.join(OUT, "csv"), exist_ok=True)

DDL = os.path.join(ROOT, "docs", "4m", "ddl-v1.sql")
CLEANSING = os.path.join(ROOT, "docs", "4m", "cleansing-v1.json")
SRC_JSON = os.path.join(ROOT, "docs", "bldc", "bldc-500w-48v.json")
PREREQ = os.path.join(HERE, "..", "v09", "prereq_existing.sql")

if hasattr(sys.stdout, "reconfigure"):
    try: sys.stdout.reconfigure(encoding="utf-8")
    except Exception: pass


def statements(path: str):
    """SQLite 자신의 sqlite3_complete() 로 문 경계를 판정. 주석만인 문은 제외. [(시작줄, 문)]"""
    sql = open(path, encoding="utf-8").read()
    out, buf, start, lineno = [], [], 1, 0
    for line in sql.splitlines(True):
        lineno += 1
        if not buf: start = lineno
        buf.append(line)
        t = "".join(buf)
        if sqlite3.complete_statement(t):
            if not _only_comment(t): out.append((start, t))
            buf = []
    if buf and not _only_comment("".join(buf)):
        out.append((start, "".join(buf)))
    return out


def _only_comment(t: str) -> bool:
    body = re.sub(r"--[^\n]*", "", t)
    return not body.strip().strip(";").strip()


def label(stmt: str) -> str:
    stmt = re.sub(r"--[^\n]*", "", stmt)
    m = re.search(r"(?is)^\s*(CREATE\s+(?:UNIQUE\s+)?\w+)\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w\.\"]+)", stmt)
    return f"{m.group(1).upper()} {m.group(2)}" if m else stmt.strip().splitlines()[0][:60]


def run_ddl(con, path=DDL, log=None):
    """문 단위 실행. 반환 (총문수, 성공, 실패목록[(줄, 라벨, 오류)])"""
    ok, fails = 0, []
    for start, stmt in statements(path):
        try:
            con.execute(stmt); ok += 1
            if log: log(f"  [OK  ] L{start:<4} {label(stmt)}")
        except Exception as e:
            fails.append((start, label(stmt), f"{type(e).__name__}: {e}"))
            if log: log(f"  [FAIL] L{start:<4} {label(stmt)}\n         └─ {type(e).__name__}: {e}")
    return ok + len(fails), ok, fails


def objects(con):
    rows = con.execute("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").fetchall()
    d = {}
    for t, n in rows: d.setdefault(t, []).append(n)
    return d


def cleansing():
    return json.load(open(CLEANSING, encoding="utf-8"))


def source():
    return json.load(open(SRC_JSON, encoding="utf-8"))


def seed_uom(con):
    """cleansing-v1.json 의 uom 5 · uom_conv 1 을 그대로 (INSERT OR IGNORE — 멱등)"""
    cj = cleansing()
    for u in cj["uom"]:
        con.execute("INSERT OR IGNORE INTO uom(uom_code,symbol,name_ko,dim,decimals,is_base) VALUES (?,?,?,?,?,?)",
                    (u["code"], u["symbol"], u["name_ko"], u["dim"], u["decimals"], u["is_base"]))
    for c in cj["uom_conv"]:
        con.execute("INSERT OR IGNORE INTO uom_conv(from_uom,to_uom,factor,item_id,note) VALUES (?,?,?,?,?)",
                    (c["from"], c["to"], c["factor"], None, c.get("note")))


def fresh(memory=True, path=None, prereq=True, uom=True):
    """선행 테이블 + ddl-v1.sql + (uom 5 · 검증용 말단 분류 2개) 를 올린 새 DB."""
    if memory:
        con = sqlite3.connect(":memory:")
    else:
        if os.path.exists(path): os.remove(path)
        con = sqlite3.connect(path)
    con.execute("PRAGMA foreign_keys=ON")
    if prereq:
        for _, s in statements(PREREQ): con.execute(s)
    n, ok, fails = run_ddl(con)
    if fails:
        raise RuntimeError(f"ddl-v1.sql 실패 {len(fails)}건: {fails[:3]}")
    if uom:
        seed_uom(con)
        con.execute("INSERT INTO mat_class(class_id,class_code,name,is_leaf) VALUES (1,'TEST','시험용 말단',1)")
        con.execute("INSERT INTO mat_class(class_id,class_code,name,is_leaf) VALUES (2,'NONLEAF','시험용 비말단',0)")
    return con


class Log:
    def __init__(self, fname):
        self.buf = io.StringIO(); self.fname = fname
    def __call__(self, s=""):
        print(s); self.buf.write(s + "\n")
    def save(self):
        open(os.path.join(OUT, self.fname), "w", encoding="utf-8").write(self.buf.getvalue())
