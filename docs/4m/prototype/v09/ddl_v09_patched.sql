-- ============================================================================
-- ddl_v09_patched.sql — ddl_v09_raw.sql 에 **최소 1건**만 고친 판.
-- 고친 것: P-DDL-1 (uom_conv PRIMARY KEY 식 제약 → 식 인덱스) — 이것 없이는 적재 자체가 안 된다.
-- 고치지 않은 것: R-1 트리거 status 필터, UPDATE 트리거 부재, valid_to>=valid_from CHECK 부재,
--   R-13 CHECK 부재 등 **의심 결함은 전부 원문 그대로 남겼다** (깨지는지 봐야 하므로).
-- ============================================================================
-- ============================================================================
-- 자재관리-기준-계획서 v0.9 §5 DDL 초안 + §6 트리거 초안 — **원문 그대로**
-- 옮긴이: 노하린 (검증). 한 글자도 고치지 않았다. 주석도 원문 그대로 옮겼다.
-- 출처: docs/4m/자재관리-기준-계획서.md  L361-377(5.1) L393-406(5.2) L411-435(5.3)
--       L444-489(5.4) L498-515(5.5) L524-561(5.6) L570-582(5.7)
--       L622-640(R-1 트리거) L650-662(R-9 트리거)
-- 이 파일이 그대로 실행되지 않으면 그 자체가 결함이다.
-- ============================================================================

-- ── §5.1 단위 (UoM) ─────────────────────────────────────────────────────────
CREATE TABLE uom (
  uom_code   TEXT PRIMARY KEY,          -- 'EA','SET','SHT','kg','g','m'  (표준 코드, 화면 표기와 분리)
  name_ko    TEXT NOT NULL,             -- '개','세트','매','킬로그램','그램','미터'
  dim        TEXT NOT NULL,             -- COUNT | MASS | LENGTH | AREA | VOLUME  (차원)
  decimals   INTEGER NOT NULL DEFAULT 0,-- 허용 소수 자릿수. 수량 입력 검증의 근거
  is_base    INTEGER NOT NULL DEFAULT 0 -- 차원별 기준 단위 1개 (MASS는 kg, LENGTH는 m)
);

-- [노하린 수정 P-DDL-1] 원문의 PRIMARY KEY (from_uom, to_uom, COALESCE(item_id,0)) 는
--   SQLite 문법 오류다: "expressions prohibited in PRIMARY KEY and UNIQUE constraints".
--   테이블 제약에는 식(expression)을 못 쓴다. **식 인덱스(CREATE UNIQUE INDEX)로는 쓸 수 있다** —
--   계획서가 ux_bom_line_dup 에서 이미 쓴 바로 그 방법이다. 의미를 그대로 살린 최소 수정:
CREATE TABLE uom_conv (
  from_uom   TEXT NOT NULL REFERENCES uom(uom_code),
  to_uom     TEXT NOT NULL REFERENCES uom(uom_code),
  factor     REAL NOT NULL CHECK (factor > 0),  -- to_qty = from_qty * factor
  item_id    INTEGER REFERENCES item(item_id)   -- NULL = 전역 환산, 값 있으면 그 품목에만
);
CREATE UNIQUE INDEX ux_uom_conv ON uom_conv(from_uom, to_uom, COALESCE(item_id, 0));

-- ── §5.2 품목 분류 (축 ①) ───────────────────────────────────────────────────
CREATE TABLE mat_class (
  class_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  class_code      TEXT NOT NULL UNIQUE,   -- 'PT-BRG'
  name            TEXT NOT NULL,          -- '베어링'
  parent_class_id INTEGER REFERENCES mat_class(class_id),  -- NULL = 최상위. 자기참조 = 분류 트리
  is_leaf         INTEGER NOT NULL DEFAULT 1,  -- 1이면 품목을 붙일 수 있다
  -- 아래는 하위 품목이 상속받는 기본 정책 (품목에서 개별 override 가능)
  def_trace_mode  TEXT,                   -- LOT | SERIAL | NONE (§8)
  def_issue_method TEXT,                  -- BACKFLUSH | PICK | BULK
  shelf_life_days INTEGER,                -- 유효기한 관리 필요 시 (화학품 CN-CHM)
  sort_no         INTEGER NOT NULL DEFAULT 0,
  note            TEXT
);

-- ── §5.3 품목 마스터 (ISA-95 Material Definition) ───────────────────────────
CREATE TABLE item (
  item_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  pn           TEXT NOT NULL UNIQUE,   -- 사내 품번 'SC-1010'. 표시·검색의 기본 키
  name         TEXT NOT NULL,          -- 'Stator Core (적층완료)'
  name_ko      TEXT,                   -- '스테이터 코어' (현장 표기)
  spec         TEXT,                   -- '규소강판 50W470 0.5t / H40' — 규격·재질 자유 텍스트
  class_id     INTEGER NOT NULL REFERENCES mat_class(class_id),  -- 말단 분류 1개 (축 ①)
  item_type    TEXT NOT NULL,          -- FG 완제품 | SA 조립품 | PT 단품 | RM 원자재 | CN 부자재 | PK 포장재
  source_type  TEXT NOT NULL,          -- MAKE 사내제작 | BUY 구매 | BOTH
  base_uom     TEXT NOT NULL REFERENCES uom(uom_code),  -- 이 품목의 기준 단위. BOM·재고·로트가 모두 이 단위
  is_phantom   INTEGER NOT NULL DEFAULT 0,  -- 1 = 팬텀 조립품 (§4.4). 전개·출고에서 건너뛴다
  trace_mode   TEXT NOT NULL DEFAULT 'NONE',-- LOT | SERIAL | NONE (§8). 분류 기본값을 상속받아 채운다
  status       TEXT NOT NULL DEFAULT 'DRAFT',-- DRAFT|APPROVED|ACTIVE|BLOCKED|OBSOLETE (§7.2). 삭제 대신 이 값
  gtin         TEXT,                   -- GS1 외부 식별자. 사내 pn과 분리 (표준 §2). 지금은 전부 NULL
  drawing_no   TEXT,                   -- 도면번호 (설계 원천 추적)
  std_cost     REAL,                   -- 참조 단가(₩). xlsx 단가 열 보존용, 원가 계산은 범위 밖
  image        TEXT,                   -- public/assets/parts/<file> — 현행 parts.image 그대로 이관
  eff_from     TEXT NOT NULL DEFAULT (date('now')),
  obsoleted_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_item_class  ON item(class_id);
CREATE INDEX idx_item_status ON item(status);

-- ── §5.4 BOM 헤더 / 라인 (축 ②) ─────────────────────────────────────────────
CREATE TABLE bom_header (
  bom_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_item_id INTEGER NOT NULL REFERENCES item(item_id),  -- 이 BOM이 만드는 품목(부모)
  bom_type       TEXT NOT NULL DEFAULT 'PROD',  -- PROD 양산 | ENG 설계검토 (설계 BOM과 양산 BOM 분리)
  alt_no         TEXT NOT NULL DEFAULT '00',    -- 대체 BOM 번호(공법 차이). 지금은 '00' 고정
  rev            TEXT NOT NULL DEFAULT 'A',     -- 리비전. ECO로만 올린다 (§7.3)
  base_qty       REAL NOT NULL DEFAULT 1 CHECK (base_qty > 0),  -- 이 BOM이 산출하는 부모 수량
  base_uom       TEXT NOT NULL REFERENCES uom(uom_code),        -- base_qty의 단위 (= item.base_uom)
  status         TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT|APPROVED|ACTIVE|OBSOLETE
  valid_from     TEXT NOT NULL,                 -- 유효 시작일 'YYYY-MM-DD'
  valid_to       TEXT NOT NULL DEFAULT '9999-12-31',
  eco_no         TEXT REFERENCES eco(eco_no),   -- 이 리비전을 만든 변경 건
  approved_by    INTEGER REFERENCES users(id),
  approved_at    TEXT,
  note           TEXT,
  UNIQUE (parent_item_id, bom_type, alt_no, rev)
);

CREATE TABLE bom_line (
  line_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  bom_id        INTEGER NOT NULL REFERENCES bom_header(bom_id) ON DELETE RESTRICT,
  line_no       INTEGER NOT NULL,        -- 표시 순서 10,20,30… (삽입 여유)
  child_item_id INTEGER NOT NULL REFERENCES item(item_id),   -- 자식 품목 = 모자관계의 '자(子)'
  qty_per       REAL NOT NULL CHECK (qty_per > 0),           -- 부모 base_qty 당 소요량. 0·음수 금지
  uom_code      TEXT NOT NULL REFERENCES uom(uom_code),      -- 소요량 단위 (자식 base_uom과 같거나 환산 가능해야)
  scrap_pct     REAL NOT NULL DEFAULT 0 CHECK (scrap_pct >= 0 AND scrap_pct < 100),
                                          -- 공정 스크랩률(%). 실소요 = qty_per / (1 - scrap_pct/100)
  alt_group     TEXT,                     -- 대체 그룹 키. 같은 값끼리 서로 대체 가능 (NULL = 대체 없음)
  alt_priority  INTEGER,                  -- 그룹 내 우선순위 1이 주(主)
  is_optional   INTEGER NOT NULL DEFAULT 0,-- 1 = 선택 사양 (옵션 품목)
  valid_from    TEXT NOT NULL,
  valid_to      TEXT NOT NULL DEFAULT '9999-12-31',
  eco_no        TEXT REFERENCES eco(eco_no),
  note          TEXT
);
CREATE INDEX idx_bom_line_bom   ON bom_line(bom_id);
CREATE INDEX idx_bom_line_child ON bom_line(child_item_id);   -- 역전개(where-used) 인덱스
-- 같은 부모 밑 같은 자식 중복 금지. 대체그룹·유효시작일이 다르면 허용 (SQLite 식 인덱스로 NULL 처리)
CREATE UNIQUE INDEX ux_bom_line_dup
  ON bom_line(bom_id, child_item_id, COALESCE(alt_group,'-'), valid_from);

-- ── §5.5 공정 ↔ 자재 연결 (BOM ↔ BOP) ──────────────────────────────────────
CREATE TABLE process_material (
  pm_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  process_id  INTEGER NOT NULL REFERENCES processes(id),  -- 기존 processes 테이블 재사용
  io          TEXT NOT NULL CHECK (io IN ('IN','OUT')),   -- IN 투입 | OUT 산출
  line_id     INTEGER REFERENCES bom_line(line_id),       -- io='IN'일 때 필수. 소요량은 여기서 읽는다
  item_id     INTEGER REFERENCES item(item_id),           -- io='OUT'일 때 필수. 이 공정이 만드는 품목
  split_pct   REAL NOT NULL DEFAULT 100
                CHECK (split_pct > 0 AND split_pct <= 100),-- 한 라인을 여러 공정에 나눠 투입할 때의 비율
  qty_out     REAL,                                        -- io='OUT'일 때 1회 산출 수량 (예: OP-A10 → 80 SHT)
  issue_method TEXT NOT NULL DEFAULT 'BACKFLUSH',          -- BACKFLUSH | PICK | BULK (§4.5)
  note        TEXT,
  CHECK ( (io='IN'  AND line_id IS NOT NULL AND item_id IS NULL)
       OR (io='OUT' AND item_id IS NOT NULL AND line_id IS NULL) )
);
CREATE INDEX idx_pm_process ON process_material(process_id);
CREATE UNIQUE INDEX ux_pm_in  ON process_material(process_id, line_id) WHERE io='IN';
CREATE UNIQUE INDEX ux_pm_out ON process_material(process_id, item_id) WHERE io='OUT';

-- ── §5.6 로트 / 서브로트 (축 ③) ────────────────────────────────────────────
CREATE TABLE mat_lot (
  lot_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  lot_no       TEXT NOT NULL UNIQUE,   -- 'LOT-SC1011-260912-A' 또는 시리얼 'SN-BLDC-2026-000481'
  item_id      INTEGER NOT NULL REFERENCES item(item_id),
  lot_kind     TEXT NOT NULL DEFAULT 'LOT',  -- LOT 원로트 | SUBLOT 분할 | SERIAL 개체
  parent_lot_id INTEGER REFERENCES mat_lot(lot_id), -- 자기참조 = 분할 계보 (ISA-95 Lot/Sublot을 한 테이블로)
  qty          REAL NOT NULL CHECK (qty >= 0),      -- 이 로트의 수량 (0 = 전량 소진)
  uom_code     TEXT NOT NULL REFERENCES uom(uom_code),
  status       TEXT NOT NULL DEFAULT 'AVAILABLE',
                -- AVAILABLE 사용가능 | HOLD 보류 | CONSUMED 소진 | SCRAPPED 폐기 | SHIPPED 출하
  proc_state   TEXT,                    -- 공정 진행 상태 (P/N을 안 붙인 중간 산출 표현, 예: 'OP-A80 완료')
  supplier     TEXT,                    -- 입고 로트일 때 공급사
  supplier_lot TEXT,                    -- 공급사 로트/밀시트 번호 (역추적의 종착점)
  made_at      TEXT,                    -- 생산·입고 일시
  expire_at    TEXT,                    -- 유효기한 (분류 shelf_life_days에서 계산)
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_lot_item   ON mat_lot(item_id, status);
CREATE INDEX idx_lot_parent ON mat_lot(parent_lot_id);

CREATE TABLE lot_genealogy (
  gen_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  out_lot_id    INTEGER NOT NULL REFERENCES mat_lot(lot_id),  -- 산출(자식) 로트
  in_lot_id     INTEGER NOT NULL REFERENCES mat_lot(lot_id),  -- 투입(부모) 로트
  process_id    INTEGER REFERENCES processes(id),             -- 어느 공정에서 합쳐졌나
  equipment_id  INTEGER REFERENCES equipments(id),            -- 어느 설비에서 (Machine 축 연결)
  user_id       INTEGER REFERENCES users(id),                 -- 누가 (Man 축 연결)
  record_id     INTEGER REFERENCES production_records(id),    -- 어느 실적으로 (백플러시 근거)
  qty_consumed  REAL NOT NULL CHECK (qty_consumed > 0),       -- 실제 투입량 (소요량과 다를 수 있다)
  uom_code      TEXT NOT NULL REFERENCES uom(uom_code),
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (out_lot_id, in_lot_id, process_id)
);
CREATE INDEX idx_gen_out ON lot_genealogy(out_lot_id);   -- 역방향 추적 (완성품 → 원자재)
CREATE INDEX idx_gen_in  ON lot_genealogy(in_lot_id);    -- 정방향 추적 (원자재 → 완성품)

-- ── §5.7 변경 관리 (ECO) ───────────────────────────────────────────────────
CREATE TABLE eco (
  eco_no       TEXT PRIMARY KEY,        -- 'ECO-2026-0001'
  title        TEXT NOT NULL,
  reason       TEXT NOT NULL,           -- 변경 사유 (품질/원가/공급/설계)
  scope        TEXT,                    -- 영향 품목·BOM 요약
  status       TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT|REVIEW|APPROVED|APPLIED|REJECTED
  effective_at TEXT,                    -- 적용 예정일 = 새 BOM의 valid_from
  requested_by INTEGER REFERENCES users(id),
  approved_by  INTEGER REFERENCES users(id),
  approved_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ── §6 R-1 순환 참조 트리거 (초안) ─────────────────────────────────────────
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

-- ── §6 R-9 유효일자 겹침 트리거 (초안) ─────────────────────────────────────
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
