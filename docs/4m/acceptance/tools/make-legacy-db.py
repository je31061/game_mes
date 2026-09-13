# -*- coding: utf-8 -*-
"""
make-legacy-db.py — 이행 리허설용 **legacy 상태 DB** 를 만든다 (운영 DB·백업을 열지 않기 위해).
  스프린트 2 스키마(server/db.js 사본 = prototype/v09/prereq_existing.sql) + products/processes 24 + 현행 parts 56 · process_inputs 36 을
  server/index.js 의 옛 importBop 규칙 그대로(prototype/v1/v1_load.py Loader.load_legacy) 넣는다. 자재(v1.0) 테이블은 만들지 않는다.
  이 DB 를 FW_DATA_DIR/factory.db 로 두고 새 서버를 띄우면 db.js 이행 [1]→[2]→[3] 이 실제로 돈다.
실행: python tools/make-legacy-db.py <출력 폴더>      → <폴더>/factory.db
"""
import os, sqlite3, sys
HERE = os.path.dirname(os.path.abspath(__file__))
PROTO = os.path.abspath(os.path.join(HERE, "..", "..", "prototype", "v1"))
sys.path.insert(0, PROTO)
import common as C            # noqa: E402
import v1_load as LD          # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    try: sys.stdout.reconfigure(encoding="utf-8")
    except Exception: pass

out_dir = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "out", "legacy"))
if out_dir == os.path.join(C.ROOT, "data"):
    print("운영 data/ 에는 만들지 않는다"); sys.exit(2)
os.makedirs(out_dir, exist_ok=True)
db = os.path.join(out_dir, "factory.db")
for f in (db, db + "-wal", db + "-shm"):
    if os.path.exists(f): os.remove(f)
con = sqlite3.connect(db); con.execute("PRAGMA foreign_keys=ON")
# 스프린트 2 의 4개 표만 (server/db.js 정의와 같은 사본). 나머지(users·zones·equipments·work_orders…)는 서버가 자기 정의로 만든다 —
# 축약 스텁을 미리 넣으면 db.js 의 prepare 가 컬럼 부재로 죽는다(1차 시도에서 겪었다)
LEGACY = ("products", "processes", "parts", "process_inputs")
import re
for _, s in C.statements(C.PREREQ):
    m = re.search(r"(?i)CREATE\s+TABLE\s+(\w+)", s)
    if m and m.group(1) in LEGACY: con.execute(s)
L = LD.Loader(con, C.cleansing(), C.source(), log=lambda s="": None)
L.load_legacy(); con.commit()
q = lambda s: con.execute(s).fetchone()[0]
print(f"legacy DB → {db}")
print(f"  products {q('SELECT count(*) FROM products')} · processes {q('SELECT count(*) FROM processes')} · parts {q('SELECT count(*) FROM parts')} · process_inputs {q('SELECT count(*) FROM process_inputs')}")
has_item = con.execute("SELECT 1 FROM sqlite_master WHERE name='item'").fetchone() is not None
print(f"  자재 테이블(item) 존재: {has_item}  (없어야 한다 — 서버가 만든다)")
con.close()
