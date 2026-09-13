-- 계획서 §5 DDL이 참조하는 **기존 운영 테이블**의 최소 사본.
-- 출처: server/db.js (원문 컬럼 정의를 그대로 옮김 — 운영 DB는 열지 않았다).
-- 계획서가 재사용을 전제하는 테이블: processes / equipments / users / production_records
-- 이 파일이 없으면 PRAGMA foreign_keys=ON 에서 process_material·lot_genealogy INSERT가 전부 실패한다.

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  emp_no TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'worker',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, color TEXT NOT NULL,
  rect_x INTEGER NOT NULL, rect_y INTEGER NOT NULL,
  rect_w INTEGER NOT NULL, rect_h INTEGER NOT NULL
);

CREATE TABLE equipments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id INTEGER NOT NULL REFERENCES zones(id),
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  x INTEGER NOT NULL, y INTEGER NOT NULL,
  manager TEXT,
  status TEXT NOT NULL DEFAULT 'IDLE',
  status_since TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  type TEXT NOT NULL DEFAULT 'generic',
  op TEXT                                  -- 설비 ↔ 공정 연결 (인터페이스 §7)
);

CREATE TABLE work_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER REFERENCES equipments(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE production_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER REFERENCES work_orders(id),
  equipment_id INTEGER REFERENCES equipments(id),
  user_id INTEGER REFERENCES users(id),
  qty_good INTEGER NOT NULL DEFAULT 0,
  qty_defect INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE products (
  code TEXT PRIMARY KEY, name TEXT, spec_json TEXT
);

CREATE TABLE processes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_code TEXT NOT NULL REFERENCES products(code),
  op TEXT NOT NULL, seq INTEGER, line TEXT, name TEXT,
  equipment_hint TEXT, input_text TEXT, output TEXT,
  ct_sec REAL, kind TEXT, qc TEXT, note TEXT, stage_pn TEXT,
  UNIQUE(product_code, op)
);

-- 현행 평면 테이블 (마이그레이션 원본 · TC-51~53 · V-10 호환 뷰 대조용)
CREATE TABLE parts (
  pn TEXT PRIMARY KEY, name TEXT, spec TEXT, level TEXT,
  parent_pn TEXT, parent_name TEXT,
  qty_per_parent REAL, qty_per_product REAL, unit TEXT, image TEXT
);
CREATE TABLE process_inputs (
  process_id INTEGER NOT NULL REFERENCES processes(id),
  pn TEXT NOT NULL, qty REAL,
  PRIMARY KEY (process_id, pn)
);
