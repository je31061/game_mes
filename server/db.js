import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

export { DATA_DIR };
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'factory.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    emp_no TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'worker',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS zones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    rect_x INTEGER NOT NULL, rect_y INTEGER NOT NULL,
    rect_w INTEGER NOT NULL, rect_h INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS equipments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    zone_id INTEGER NOT NULL REFERENCES zones(id),
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    x INTEGER NOT NULL, y INTEGER NOT NULL,
    manager TEXT,
    status TEXT NOT NULL DEFAULT 'IDLE',
    status_since TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    type TEXT NOT NULL DEFAULT 'generic'    -- 설비 유형 (스프라이트·분석 분류, docs/team/인터페이스.md §1)
  );

  CREATE TABLE IF NOT EXISTS equipment_status_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    equipment_id INTEGER NOT NULL REFERENCES equipments(id),
    status TEXT NOT NULL,
    reason TEXT,
    changed_by INTEGER REFERENCES users(id),
    changed_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,            -- 'eq:<equipmentId>' 또는 'all'
    equipment_id INTEGER,
    sender_id INTEGER NOT NULL REFERENCES users(id),
    sender_name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text', -- text | file | system
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER REFERENCES messages(id),
    equipment_id INTEGER,
    stored_name TEXT NOT NULL,
    original_name TEXT NOT NULL,
    size INTEGER NOT NULL,
    uploaded_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel, id);
  CREATE INDEX IF NOT EXISTS idx_status_log_eq ON equipment_status_log(equipment_id, id);

  -- ── 공정 라인 (설비 간 연결 — 심시티식 흐름/부하 시각화) ──
  CREATE TABLE IF NOT EXISTS equipment_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER NOT NULL REFERENCES equipments(id),
    to_id INTEGER NOT NULL REFERENCES equipments(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(from_id, to_id)
  );

  -- ── Phase 3: 작업지시(퀘스트) · 실적 · 게이미피케이션 ──
  CREATE TABLE IF NOT EXISTS work_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    equipment_id INTEGER NOT NULL REFERENCES equipments(id),
    title TEXT NOT NULL,
    description TEXT,
    target_qty INTEGER NOT NULL DEFAULT 0,
    due_date TEXT,
    status TEXT NOT NULL DEFAULT 'OPEN',   -- OPEN | IN_PROGRESS | DONE | CANCELED
    assignee_id INTEGER REFERENCES users(id),
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    accepted_at TEXT,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS production_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_order_id INTEGER REFERENCES work_orders(id),
    equipment_id INTEGER REFERENCES equipments(id),
    user_id INTEGER REFERENCES users(id),
    qty_good INTEGER NOT NULL DEFAULT 0,
    qty_defect INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS point_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    points INTEGER NOT NULL,
    kind TEXT NOT NULL,                    -- quest | alarm | bonus
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS user_badges (
    user_id INTEGER NOT NULL REFERENCES users(id),
    badge_key TEXT NOT NULL,
    earned_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (user_id, badge_key)
  );

  -- ── 운영 설정 (key/value) — 게이트웨이 가동 여부, 마지막 백업 등 재시작 후에도 유지할 상태 ──
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  -- ── 스프린트 2: 제품 공정(BOP) · 단품(BOM) (docs/team/인터페이스.md §7) ──
  -- 원천은 docs/bldc/bldc-500w-48v.json — POST /api/admin/bop/import 로 upsert. 설비는 equipments.op 로 공정에 연결.
  CREATE TABLE IF NOT EXISTS products (
    code TEXT PRIMARY KEY,
    name TEXT,
    spec_json TEXT                         -- { spec, exploded[], lineBalance, source } (JSON의 비표 블록 원문 보관)
  );
  CREATE TABLE IF NOT EXISTS processes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_code TEXT NOT NULL REFERENCES products(code),
    op TEXT NOT NULL,                      -- 'OP-A40'
    seq INTEGER,
    line TEXT,
    name TEXT,
    equipment_hint TEXT,                   -- BOP 시트의 설비 란 (자유 텍스트)
    input_text TEXT,
    output TEXT,
    ct_sec REAL,
    kind TEXT,                             -- 표준 | 병목 | 배치 | QC | 완성
    qc TEXT,
    note TEXT,
    stage_pn TEXT,                         -- 분해도 단계 P/N (null = 완성품 공정)
    UNIQUE(product_code, op)
  );
  CREATE TABLE IF NOT EXISTS parts (
    pn TEXT PRIMARY KEY,
    name TEXT,
    spec TEXT,
    level TEXT,                            -- L1(서브어셈블리) | L2 | L3
    parent_pn TEXT,
    parent_name TEXT,
    qty_per_parent REAL,
    qty_per_product REAL,
    unit TEXT,
    image TEXT                             -- public/assets/parts/<file> 가 있을 때 파일명
  );
  CREATE TABLE IF NOT EXISTS process_inputs (
    process_id INTEGER NOT NULL REFERENCES processes(id),
    pn TEXT NOT NULL,
    qty REAL,
    PRIMARY KEY (process_id, pn)
  );
`);

// ── 설비 유형 (인터페이스 §1) — 스프라이트(한도윤)·분석(서지안)이 이 값으로 분기 ──
// 스프린트 2(§9): BLDC 라인용 8종 추가 — stacker(적층기) winder(와인더) vpi(함침조) oven(건조로) magnetizer(착자기) balancer(밸런서) dispenser(디스펜서) smt(SMT)
export const EQUIPMENT_TYPES = [
  'press', 'welder', 'robot', 'assembly', 'inspector', 'packer', 'cnc',
  'stacker', 'winder', 'vpi', 'oven', 'magnetizer', 'balancer', 'dispenser', 'smt',
  'generic',
];
export const EQUIPMENT_TYPE_LABELS = {
  press: '프레스', welder: '용접기', robot: '로봇', assembly: '조립 라인',
  inspector: '검사기', packer: '포장기', cnc: 'CNC 가공기',
  stacker: '자동 적층기', winder: '니들 와인더', vpi: '진공 함침조 (VPI)', oven: '열풍 건조로',
  magnetizer: '착자기', balancer: '밸런싱 머신', dispenser: '접착 디스펜서', smt: 'SMT · 자동 결선',
  generic: '미지정',
};
// BLDC 500W 라인 공정번호 → 유형 (인터페이스 §9 표). 코드가 공정번호(OP-*)인 설비의 유형 추정에 사용
const OP_TYPE = {
  'OP-A10': 'press', 'OP-A20': 'stacker', 'OP-A30': 'assembly', 'OP-A40': 'winder', 'OP-A50': 'assembly',
  'OP-A60': 'robot', 'OP-A70': 'inspector', 'OP-A80': 'vpi', 'OP-A90': 'oven', 'OP-A100': 'inspector',
  'OP-B10': 'press', 'OP-B20': 'dispenser', 'OP-B30': 'magnetizer', 'OP-B40': 'balancer', 'OP-B50': 'press',
  'OP-B60': 'press', 'OP-B70': 'assembly', 'OP-B80': 'assembly', 'OP-B85': 'assembly', 'OP-B87': 'assembly',
  'OP-B90': 'smt', 'OP-B100': 'assembly', 'OP-B110': 'inspector', 'OP-B120': 'packer',
};
// 설비 코드 접두로 유형 추정 (시드 매핑 규칙: PRS→press, WLD-03→robot, 그 외 WLD→welder, ASM→assembly, INS→inspector, PKG→packer, CNC→cnc,
// 스프린트 2: STK→stacker, WND→winder, VPI→vpi, OVN→oven, MAG→magnetizer, BAL→balancer, DSP→dispenser, SMT→smt, OP-*는 §9 표)
export function inferEquipmentType(code) {
  const c = String(code || '').toUpperCase();
  if (c === 'WLD-03') return 'robot';
  if (OP_TYPE[c]) return OP_TYPE[c];
  const prefix = {
    'PRS-': 'press', 'WLD-': 'welder', 'ASM-': 'assembly', 'INS-': 'inspector', 'PKG-': 'packer', 'CNC-': 'cnc',
    'STK-': 'stacker', 'WND-': 'winder', 'VPI-': 'vpi', 'OVN-': 'oven', 'MAG-': 'magnetizer', 'BAL-': 'balancer',
    'DSP-': 'dispenser', 'SMT-': 'smt',
  };
  for (const [p, t] of Object.entries(prefix)) if (c.startsWith(p)) return t;
  return 'generic';
}

// ── 시드 데이터 (최초 1회) ─────────────────────────────
const zoneCount = db.prepare('SELECT COUNT(*) AS c FROM zones').get().c;
if (zoneCount === 0) {
  const insZone = db.prepare('INSERT INTO zones (name, color, rect_x, rect_y, rect_w, rect_h) VALUES (?, ?, ?, ?, ?, ?)');
  const insEqRaw = db.prepare('INSERT INTO equipments (zone_id, code, name, x, y, manager, type) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insEq = { run: (zone, code, name, x, y, manager) => insEqRaw.run(zone, code, name, x, y, manager, inferEquipmentType(code)) };

  const press = insZone.run('프레스 존', '#2d4a6b', 1, 1, 10, 6).lastInsertRowid;
  const weld = insZone.run('용접 존', '#5b3a5e', 13, 1, 10, 6).lastInsertRowid;
  const asm = insZone.run('조립 존', '#2f5d43', 1, 9, 10, 6).lastInsertRowid;
  const insp = insZone.run('검사/출하 존', '#6b5a2d', 13, 9, 10, 6).lastInsertRowid;

  insEq.run(press, 'PRS-01', '프레스 1호기', 3, 2, '김보전');
  insEq.run(press, 'PRS-02', '프레스 2호기', 6, 2, '김보전');
  insEq.run(press, 'PRS-03', '프레스 3호기', 9, 2, '박정비');
  insEq.run(weld, 'WLD-01', '용접기 1호', 15, 2, '박정비');
  insEq.run(weld, 'WLD-02', '용접기 2호', 18, 2, '이설비');
  insEq.run(weld, 'WLD-03', '용접 로봇', 21, 4, '이설비');
  insEq.run(asm, 'ASM-01', '조립 라인 A', 3, 11, '최라인');
  insEq.run(asm, 'ASM-02', '조립 라인 B', 7, 11, '최라인');
  insEq.run(insp, 'INS-01', '검사기 1호', 15, 11, '정품질');
  insEq.run(insp, 'PKG-01', '포장기 1호', 19, 11, '정품질');

  // 데모용 초기 상태
  db.prepare("UPDATE equipments SET status='RUN' WHERE code IN ('PRS-01','PRS-02','WLD-01','ASM-01','ASM-02','INS-01')").run();
  db.prepare("UPDATE equipments SET status='ALARM' WHERE code='PRS-03'").run();
  db.prepare("UPDATE equipments SET status='STOP' WHERE code='WLD-03'").run();
}

// 마이그레이션: 비밀번호 해시 (NFR-03 — 기존 사용자는 첫 로그인 시 비밀번호 등록)
if (!db.prepare("PRAGMA table_info(users)").all().some(c => c.name === 'password_hash')) {
  db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
}

// 마이그레이션: 팀(부서) — 팀 단위 리더보드용
if (!db.prepare("PRAGMA table_info(users)").all().some(c => c.name === 'team')) {
  db.exec('ALTER TABLE users ADD COLUMN team TEXT');
}

// 마이그레이션: 설비 연동 설정 (Phase 2 게이트웨이 대비 — 프로토콜/주소/태그)
if (!db.prepare("PRAGMA table_info(equipments)").all().some(c => c.name === 'data_source')) {
  db.exec('ALTER TABLE equipments ADD COLUMN data_source TEXT');
}

// 마이그레이션: 공정 라인 부하(재공 %) 영속화 — 재시작 시 정체 상태 유지
if (!db.prepare("PRAGMA table_info(equipment_links)").all().some(c => c.name === 'load')) {
  db.exec('ALTER TABLE equipment_links ADD COLUMN load REAL NOT NULL DEFAULT 0');
}

// 마이그레이션: 설비 유형 (스프린트 1) — 기존 DB는 컬럼 추가 후 코드 접두로 1회 매핑 (이후 관리자가 바꾼 값은 유지)
if (!db.prepare("PRAGMA table_info(equipments)").all().some(c => c.name === 'type')) {
  db.exec("ALTER TABLE equipments ADD COLUMN type TEXT NOT NULL DEFAULT 'generic'");
  const setType = db.prepare('UPDATE equipments SET type = ? WHERE id = ?');
  let mapped = 0;
  for (const eq of db.prepare('SELECT id, code FROM equipments').all()) {
    const t = inferEquipmentType(eq.code);
    if (t !== 'generic') { setType.run(t, eq.id); mapped++; }
  }
  console.log(`[db] equipments.type 컬럼 추가 — 코드 접두로 ${mapped}대 유형 매핑`);
}

// 마이그레이션: 스프린트 2 — 설비 ↔ 공정 연결(op), 라인 전환 시 숨김(hidden — 삭제 대신 맵·분석에서 제외, 이력 보존)
if (!db.prepare("PRAGMA table_info(equipments)").all().some(c => c.name === 'op')) {
  db.exec('ALTER TABLE equipments ADD COLUMN op TEXT');
  console.log('[db] equipments.op 컬럼 추가 (공정 연결)');
}
if (!db.prepare("PRAGMA table_info(equipments)").all().some(c => c.name === 'hidden')) {
  db.exec('ALTER TABLE equipments ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
  console.log('[db] equipments.hidden 컬럼 추가 (라인 전환 숨김)');
}
if (!db.prepare("PRAGMA table_info(zones)").all().some(c => c.name === 'hidden')) {
  db.exec('ALTER TABLE zones ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
  console.log('[db] zones.hidden 컬럼 추가 (라인 전환 숨김)');
}

// 관리자 계정 시드 (idempotent — 매 부팅 시 확인)
if (!db.prepare("SELECT 1 FROM users WHERE emp_no = 'admin'").get()) {
  db.prepare("INSERT INTO users (emp_no, name, role) VALUES ('admin', '관리자', 'admin')").run();
}
// 게이트웨이 시스템 계정 (자동 수집 상태 변경의 행위자)
if (!db.prepare("SELECT 1 FROM users WHERE emp_no = 'gateway'").get()) {
  db.prepare("INSERT INTO users (emp_no, name, role) VALUES ('gateway', '설비 게이트웨이', 'system')").run();
}

// ── 운영 설정 헬퍼 ────────────────────────────────────
const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(`
  INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now','localtime'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
export const settings = {
  get(key, def = null) {
    const row = getSettingStmt.get(key);
    if (!row || row.value === null) return def;
    try { return JSON.parse(row.value); } catch { return row.value; }
  },
  set(key, value) { setSettingStmt.run(key, JSON.stringify(value)); },
};

// ── 쿼리 헬퍼 ─────────────────────────────────────────
export const queries = {
  findUserByEmpNo: db.prepare('SELECT * FROM users WHERE emp_no = ?'),
  createUser: db.prepare('INSERT INTO users (emp_no, name, role) VALUES (?, ?, ?)'),
  getUser: db.prepare('SELECT * FROM users WHERE id = ?'),
  setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  setTeam: db.prepare('UPDATE users SET team = ? WHERE id = ?'),
  teamLeaderboard: db.prepare(`
    SELECT u.team, COALESCE(SUM(l.points), 0) AS points, COUNT(DISTINCT u.id) AS members
    FROM point_log l JOIN users u ON u.id = l.user_id
    WHERE u.team IS NOT NULL AND u.team != ''
    GROUP BY u.team ORDER BY points DESC LIMIT 10`),

  // 숨김(hidden=1) 존·설비는 맵(init·world:refresh)·근접 판정·분석·게이트웨이·내보내기 대상에서 제외 — 관리자 콘솔 설비 마스터만 *All 로 전체 조회
  listZones: db.prepare('SELECT * FROM zones WHERE hidden = 0'),
  listAllZones: db.prepare('SELECT * FROM zones ORDER BY id'),
  listEquipments: db.prepare('SELECT * FROM equipments WHERE hidden = 0'),
  listAllEquipments: db.prepare('SELECT * FROM equipments ORDER BY hidden, id'),
  setEquipmentHidden: db.prepare('UPDATE equipments SET hidden = ? WHERE id = ?'),
  setZoneHidden: db.prepare('UPDATE zones SET hidden = ? WHERE id = ?'),
  setEquipmentOp: db.prepare('UPDATE equipments SET op = ? WHERE id = ?'),
  getEquipment: db.prepare('SELECT * FROM equipments WHERE id = ?'),
  setEquipmentStatus: db.prepare("UPDATE equipments SET status = ?, status_since = datetime('now','localtime') WHERE id = ?"),
  logStatus: db.prepare('INSERT INTO equipment_status_log (equipment_id, status, reason, changed_by) VALUES (?, ?, ?, ?)'),
  recentStatusLog: db.prepare(`
    SELECT l.*, u.name AS changed_by_name FROM equipment_status_log l
    LEFT JOIN users u ON u.id = l.changed_by
    WHERE l.equipment_id = ? ORDER BY l.id DESC LIMIT 10`),

  saveMessage: db.prepare('INSERT INTO messages (channel, equipment_id, sender_id, sender_name, type, content) VALUES (?, ?, ?, ?, ?, ?)'),
  getMessage: db.prepare('SELECT * FROM messages WHERE id = ?'),
  recentMessages: db.prepare('SELECT * FROM messages WHERE channel = ? ORDER BY id DESC LIMIT 50'),

  saveFile: db.prepare('INSERT INTO files (message_id, equipment_id, stored_name, original_name, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)'),
  getFile: db.prepare('SELECT * FROM files WHERE id = ?'),
  filesByEquipment: db.prepare('SELECT * FROM files WHERE equipment_id = ? ORDER BY id DESC LIMIT 20'),

  // ── 관리자 콘솔용 ──
  listUsers: db.prepare('SELECT id, emp_no, name, role, team, created_at, (password_hash IS NOT NULL) AS has_password FROM users ORDER BY id'),
  createUserFull: db.prepare('INSERT INTO users (emp_no, name, role, team) VALUES (?, ?, ?, ?)'),
  // ── 보존 기간 정책 (FR-08): 대화·파일을 N일 지나면 정리 — 백업 이후에 실행 ──
  filesBefore: db.prepare("SELECT id, stored_name FROM files WHERE created_at < datetime('now','localtime', ?)"),
  deleteFilesBefore: db.prepare("DELETE FROM files WHERE created_at < datetime('now','localtime', ?)"),
  deleteMessagesBefore: db.prepare("DELETE FROM messages WHERE created_at < datetime('now','localtime', ?)"),
  setUserRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
  createEquipment: db.prepare('INSERT INTO equipments (zone_id, code, name, x, y, manager, type) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  updateEquipment: db.prepare('UPDATE equipments SET zone_id = ?, code = ?, name = ?, x = ?, y = ?, manager = ?, data_source = ?, type = ? WHERE id = ?'),
  findZoneByName: db.prepare('SELECT * FROM zones WHERE name = ?'),
  findEquipmentByCode: db.prepare('SELECT * FROM equipments WHERE code = ?'),
  createZone: db.prepare('INSERT INTO zones (name, color, rect_x, rect_y, rect_w, rect_h) VALUES (?, ?, ?, ?, ?, ?)'),
  updateZone: db.prepare('UPDATE zones SET name = ?, color = ?, rect_x = ?, rect_y = ?, rect_w = ?, rect_h = ? WHERE id = ?'),
  deleteZone: db.prepare('DELETE FROM zones WHERE id = ?'),
  getZone: db.prepare('SELECT * FROM zones WHERE id = ?'),
  countEqInZone: db.prepare('SELECT COUNT(*) AS c FROM equipments WHERE zone_id = ?'),
  // ── 공정 라인 ──
  listLinks: db.prepare(`
    SELECT l.id, l.from_id, l.to_id, l.load, f.name AS from_name, f.code AS from_code,
           t.name AS to_name, t.code AS to_code
    FROM equipment_links l
    JOIN equipments f ON f.id = l.from_id
    JOIN equipments t ON t.id = l.to_id
    WHERE f.hidden = 0 AND t.hidden = 0 ORDER BY l.id`),   // 숨긴 설비에 걸린 라인은 부하 틱·맵에서 제외 (레코드는 보존)
  createLink: db.prepare('INSERT INTO equipment_links (from_id, to_id) VALUES (?, ?)'),
  setLinkLoad: db.prepare('UPDATE equipment_links SET load = ? WHERE id = ?'),
  deleteLink: db.prepare('DELETE FROM equipment_links WHERE id = ?'),
  getLink: db.prepare('SELECT * FROM equipment_links WHERE id = ?'),
  deleteLinksOfEquipment: db.prepare('DELETE FROM equipment_links WHERE from_id = ? OR to_id = ?'),

  // ── Phase 3: 작업지시 · 실적 · 포인트 ──
  createWorkOrder: db.prepare('INSERT INTO work_orders (equipment_id, title, description, target_qty, due_date, created_by) VALUES (?, ?, ?, ?, ?, ?)'),
  getWorkOrder: db.prepare('SELECT * FROM work_orders WHERE id = ?'),
  acceptWorkOrder: db.prepare("UPDATE work_orders SET status = 'IN_PROGRESS', assignee_id = ?, accepted_at = datetime('now','localtime') WHERE id = ? AND status = 'OPEN'"),
  completeWorkOrder: db.prepare("UPDATE work_orders SET status = 'DONE', completed_at = datetime('now','localtime') WHERE id = ? AND status = 'IN_PROGRESS' AND assignee_id = ?"),
  cancelWorkOrder: db.prepare("UPDATE work_orders SET status = 'CANCELED' WHERE id = ? AND status IN ('OPEN','IN_PROGRESS')"),
  activeWorkOrders: db.prepare(`
    SELECT w.*, e.name AS equipment_name, e.code AS equipment_code, u.name AS assignee_name
    FROM work_orders w JOIN equipments e ON e.id = w.equipment_id
    LEFT JOIN users u ON u.id = w.assignee_id
    WHERE w.status IN ('OPEN','IN_PROGRESS') ORDER BY w.id DESC LIMIT 50`),
  myRecentDone: db.prepare(`
    SELECT w.*, e.name AS equipment_name, e.code AS equipment_code,
           r.qty_good, r.qty_defect
    FROM work_orders w JOIN equipments e ON e.id = w.equipment_id
    LEFT JOIN production_records r ON r.work_order_id = w.id
    WHERE w.assignee_id = ? AND w.status = 'DONE' ORDER BY w.id DESC LIMIT 5`),
  allWorkOrders: db.prepare(`
    SELECT w.*, e.name AS equipment_name, e.code AS equipment_code,
           u.name AS assignee_name, c.name AS created_by_name,
           r.qty_good, r.qty_defect
    FROM work_orders w JOIN equipments e ON e.id = w.equipment_id
    LEFT JOIN users u ON u.id = w.assignee_id
    LEFT JOIN users c ON c.id = w.created_by
    LEFT JOIN production_records r ON r.work_order_id = w.id
    ORDER BY w.id DESC LIMIT 100`),
  addRecord: db.prepare('INSERT INTO production_records (work_order_id, equipment_id, user_id, qty_good, qty_defect, note) VALUES (?, ?, ?, ?, ?, ?)'),
  addPoints: db.prepare('INSERT INTO point_log (user_id, points, kind, reason) VALUES (?, ?, ?, ?)'),
  userPoints: db.prepare('SELECT COALESCE(SUM(points), 0) AS p FROM point_log WHERE user_id = ?'),
  leaderboard: db.prepare(`
    SELECT u.id, u.name, COALESCE(SUM(l.points), 0) AS points,
           (SELECT COUNT(*) FROM user_badges b WHERE b.user_id = u.id) AS badges
    FROM point_log l JOIN users u ON u.id = l.user_id
    GROUP BY u.id ORDER BY points DESC LIMIT 10`),
  addBadge: db.prepare('INSERT OR IGNORE INTO user_badges (user_id, badge_key) VALUES (?, ?)'),
  userBadges: db.prepare('SELECT badge_key, earned_at FROM user_badges WHERE user_id = ? ORDER BY earned_at'),
  questDoneCount: db.prepare("SELECT COUNT(*) AS c FROM work_orders WHERE assignee_id = ? AND status = 'DONE'"),
  alarmResolveCount: db.prepare("SELECT COUNT(*) AS c FROM point_log WHERE user_id = ? AND kind = 'alarm'"),
  perfectCount: db.prepare('SELECT COUNT(*) AS c FROM production_records WHERE user_id = ? AND qty_defect = 0 AND qty_good > 0 AND work_order_id IS NOT NULL'),

  // ── 설비 상태창 게이지 (설계서 6.3: 목표 대비 진행률) · 출근 브리핑 (6.1) ──
  eqTodayProduction: db.prepare(`
    SELECT COALESCE(SUM(qty_good), 0) AS good, COALESCE(SUM(qty_defect), 0) AS defect
    FROM production_records WHERE equipment_id = ? AND created_at >= date('now','localtime')`),
  eqTargetQty: db.prepare(`
    SELECT COALESCE(SUM(target_qty), 0) AS target, COUNT(*) AS orders
    FROM work_orders WHERE equipment_id = ?
      AND (status IN ('OPEN','IN_PROGRESS') OR (status = 'DONE' AND completed_at >= date('now','localtime')))`),
  alarmEquipments: db.prepare("SELECT id, code, name, status_since FROM equipments WHERE status = 'ALARM' AND hidden = 0 ORDER BY status_since"),
  countOpenQuests: db.prepare("SELECT COUNT(*) AS c FROM work_orders WHERE status = 'OPEN'"),
  countMyQuests: db.prepare("SELECT COUNT(*) AS c FROM work_orders WHERE status = 'IN_PROGRESS' AND assignee_id = ?"),
  recentNotices: db.prepare(`
    SELECT sender_name, content, created_at FROM messages
    WHERE channel = 'all' AND type = 'text' AND created_at >= date('now','localtime')
    ORDER BY id DESC LIMIT 3`),

  todayLogs: db.prepare(`
    SELECT * FROM equipment_status_log
    WHERE equipment_id = ? AND changed_at >= date('now','localtime') ORDER BY id`),
  countToday: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM messages WHERE created_at >= date('now','localtime') AND type != 'system') AS messages,
      (SELECT COUNT(*) FROM files WHERE created_at >= date('now','localtime')) AS files,
      (SELECT COUNT(*) FROM equipment_status_log WHERE changed_at >= date('now','localtime') AND status = 'ALARM') AS alarms`),

  // ── 스프린트 2: 제품 공정(BOP) · 단품(BOM) (인터페이스 §7) ──
  upsertProduct: db.prepare(`
    INSERT INTO products (code, name, spec_json) VALUES (?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET name = excluded.name, spec_json = excluded.spec_json`),
  listProducts: db.prepare('SELECT code, name FROM products ORDER BY code'),
  getProduct: db.prepare('SELECT * FROM products WHERE code = ?'),
  upsertProcess: db.prepare(`
    INSERT INTO processes (product_code, op, seq, line, name, equipment_hint, input_text, output, ct_sec, kind, qc, note, stage_pn)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_code, op) DO UPDATE SET
      seq = excluded.seq, line = excluded.line, name = excluded.name, equipment_hint = excluded.equipment_hint,
      input_text = excluded.input_text, output = excluded.output, ct_sec = excluded.ct_sec, kind = excluded.kind,
      qc = excluded.qc, note = excluded.note, stage_pn = excluded.stage_pn`),
  getProcess: db.prepare('SELECT * FROM processes WHERE product_code = ? AND op = ?'),
  processByOp: db.prepare('SELECT * FROM processes WHERE op = ? ORDER BY product_code LIMIT 1'),   // 설비 op → 공정 (제품이 하나인 파일럿 전제)
  listProcesses: db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM process_inputs i WHERE i.process_id = p.id) AS input_count
    FROM processes p WHERE p.product_code = ? ORDER BY p.line, p.seq, p.op`),
  upsertPart: db.prepare(`
    INSERT INTO parts (pn, name, spec, level, parent_pn, parent_name, qty_per_parent, qty_per_product, unit, image)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pn) DO UPDATE SET
      name = excluded.name, spec = excluded.spec, level = excluded.level, parent_pn = excluded.parent_pn,
      parent_name = excluded.parent_name, qty_per_parent = excluded.qty_per_parent, qty_per_product = excluded.qty_per_product,
      unit = excluded.unit, image = excluded.image`),
  countParts: db.prepare('SELECT COUNT(*) AS c FROM parts'),
  deleteProcessInputs: db.prepare('DELETE FROM process_inputs WHERE process_id = ?'),
  addProcessInput: db.prepare('INSERT OR REPLACE INTO process_inputs (process_id, pn, qty) VALUES (?, ?, ?)'),
  processInputs: db.prepare(`
    SELECT i.pn, i.qty, p.name, p.spec, p.unit, p.level, p.parent_pn, p.parent_name, p.image
    FROM process_inputs i LEFT JOIN parts p ON p.pn = i.pn
    WHERE i.process_id = ? ORDER BY i.rowid`),
  equipmentsByOp: db.prepare('SELECT id, code, name, hidden FROM equipments WHERE op = ? ORDER BY hidden, id'),
};
