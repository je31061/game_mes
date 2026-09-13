-- ============================================================================
-- ddl-v1.sql — 자재(Material) 관리 기준 v1.0 · 실행 가능한 DDL (확정판)
-- ----------------------------------------------------------------------------
-- 작성   윤태경 (자재 마스터·BOM 표준 설계) · 2026-09-13
-- 근거   docs/4m/자재관리-기준-계획서.md v1.0 §5(테이블) §6(규칙·트리거) §5.9(기준 쿼리)
--        docs/4m/검증보고서.md §5 결함 D-1~D-21 · V-12 · R-18~R-24 (노하린)
-- 대상   SQLite — 운영 런타임 node:sqlite (SQLite 3.53.0), 검증 런타임 python sqlite3 3.50.4
--
-- 실행 조건
--   1. 선행 테이블: users · equipments · processes · production_records (server/db.js 가 만든다)
--      → 이 파일은 그 테이블을 "참조"만 한다. 없어도 CREATE 는 통과하지만(SQLite 는 CREATE 시 이름을
--        해석하지 않는다) process_material / lot_genealogy / proc_batch INSERT 와 호환 뷰 조회가 실패한다.
--   2. PRAGMA foreign_keys = ON  (node:sqlite DatabaseSync 는 기본 ON, python sqlite3 는 직접 켠다)
--   3. 멱등: 모든 문이 IF NOT EXISTS. 같은 DB 에 두 번 실행해도 오류 없이 끝난다.
--      스키마를 바꿀 때는 이 파일을 고치지 말고 마이그레이션(ALTER)을 따로 쓴다 — 운영 DB 는 재생성하지 않는다.
--   4. 이 파일에는 PRAGMA · INSERT · DROP 이 없다. 데이터는 cleansing-v1.json 을 읽는 적재기(최민준)가 넣는다.
--
-- 절 구성
--   A. 마스터  uom · uom_conv · mat_class · item · eco
--   B. BOM     bom_header · bom_line
--   C. BOM↔BOP process_material
--   D. 로트    mat_lot · lot_genealogy · proc_batch · proc_batch_lot
--   E. 트리거  (규칙 R-1 R-7 R-8 R-9 R-9b R-11 R-13 R-22 · 결함 D-3 D-5 D-7 D-8 D-12 D-13 D-15 D-17)
--   F. 뷰      단위 환산 · 유효 라인 · 완성품당 소요량(qpp) · 호환 뷰(process_inputs / parts)
--   G. 점검 뷰 v_chk_* (R-2 R-4 R-5 R-10 R-12 R-22 · D-8 · 8.3 추적 정책 · D-17)
--   H. 이행 [3] 전환 블록 — 주석. 최민준이 실행 시점을 정한다
--   I. 매개변수 쿼리 참조 — 주석. as-of 전개·역전개·로트 추적 (계획서 §5.9 Q-1~Q-5 와 동일)
-- ============================================================================


-- ============================================================================
-- A. 마스터
-- ============================================================================

-- ── A-1 단위 (UoM) ──────────────────────────────────────────────────────────
-- 초기값 5종: EA(개) · SHT(매) · kg · g · m.  SET 은 등록하지 않는다 — EX-5000 은 팬텀이라
-- 기준단위를 EA 로 두면 되고, 실물 단위가 아닌 SET 을 마스터에 두면 P-4("SET 은 소멸")와 어긋난다(TC-33 의견 반영).
-- mm 은 쓰는 데이터가 없어 등록하지 않는다(D-11). 필요해지면 uom 에 행 추가 + uom_conv m→mm 1000.
CREATE TABLE IF NOT EXISTS uom (
  uom_code   TEXT PRIMARY KEY,                       -- 'EA','SHT','kg','g','m' — DB·API 가 쓰는 표준 코드
  symbol     TEXT,                                   -- 화면 표기 'EA','매','kg','g','m' — 호환 뷰 parts.unit 이 이 값 (NULL 이면 uom_code)
  name_ko    TEXT NOT NULL,                          -- '개','매','킬로그램','그램','미터'
  dim        TEXT NOT NULL CHECK (dim IN ('COUNT','MASS','LENGTH','AREA','VOLUME')),
  decimals   INTEGER NOT NULL DEFAULT 0 CHECK (decimals BETWEEN 0 AND 6),  -- 허용 소수 자릿수 (R-8)
  is_base    INTEGER NOT NULL DEFAULT 0 CHECK (is_base IN (0,1))           -- 차원별 기준단위 1개
);
-- 차원마다 기준단위는 정확히 하나 (부분 유니크 인덱스)
CREATE UNIQUE INDEX IF NOT EXISTS ux_uom_base ON uom(dim) WHERE is_base = 1;

-- ── A-2 단위 환산 ───────────────────────────────────────────────────────────
-- [D-19] v0.9 의 PRIMARY KEY(from,to,COALESCE(item_id,0)) 는 SQLite 문법 오류(제약에 식 불가).
--        → 제약을 빼고 식 인덱스로. PRIMARY KEY(from,to,item_id) 는 안 된다 — rowid 테이블 PK 열에 NULL 이
--          허용되어 전역 환산(item_id NULL)이 무제한 중복된다(노하린 근거 채택).
-- [R-24/V12-4] 초기값은 kg→g 1000 **한 행뿐**. SHT→kg 0.010625 는 환산계수가 아니라 코일 수율(0.85÷80)이라 넣지 않는다.
--        낱장 실중량은 원천에 없다 — 생산기술 실측 후에만 item_id=SC-1011 행으로 넣는다.
-- 규칙: to_qty = from_qty × factor. 역방향은 1/factor 로 계산한다(뷰 v_uom_base). 양방향을 두 행으로 넣지 않는다.
CREATE TABLE IF NOT EXISTS uom_conv (
  from_uom   TEXT NOT NULL REFERENCES uom(uom_code),
  to_uom     TEXT NOT NULL REFERENCES uom(uom_code),
  factor     REAL NOT NULL CHECK (factor > 0),
  item_id    INTEGER REFERENCES item(item_id),      -- NULL = 전역(같은 차원끼리만, 트리거 R-7) · 값 = 그 품목 전용(차원 교차 허용)
  note       TEXT,                                   -- 실측 근거 (예: '2026-10-01 생산기술 낱장 계량 n=50')
  CHECK (from_uom <> to_uom)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_uom_conv ON uom_conv(from_uom, to_uom, COALESCE(item_id, 0));

-- ── A-3 품목 분류 (축 ① · ISA-95 Material Class, 자기참조) ───────────────
CREATE TABLE IF NOT EXISTS mat_class (
  class_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  class_code       TEXT NOT NULL UNIQUE,             -- 'PT-BRG'
  name             TEXT NOT NULL,                    -- '베어링'
  parent_class_id  INTEGER REFERENCES mat_class(class_id),   -- NULL = 최상위 (FG SA PT RM CN PK)
  is_leaf          INTEGER NOT NULL DEFAULT 1 CHECK (is_leaf IN (0,1)),  -- 1 이면 품목을 붙일 수 있다
  -- 하위 품목이 상속받는 기본 정책 (품목에서 override)
  def_trace_mode   TEXT CHECK (def_trace_mode IN ('LOT','SERIAL','NONE')),
  def_issue_method TEXT CHECK (def_issue_method IN ('BACKFLUSH','PICK','BULK')),
  shelf_life_days  INTEGER CHECK (shelf_life_days IS NULL OR shelf_life_days > 0),
  sort_no          INTEGER NOT NULL DEFAULT 0,
  note             TEXT,
  CHECK (parent_class_id IS NULL OR parent_class_id <> class_id)
);

-- ── A-4 품목 마스터 (ISA-95 Material Definition) ────────────────────────────
-- products(완성품) + parts(서브어셈블리·단품) 를 한 테이블로. bom_line 의 FK 가 한 테이블을 가리켜야 순환을 SQL 로 막는다.
CREATE TABLE IF NOT EXISTS item (
  item_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  pn           TEXT NOT NULL UNIQUE
                 CHECK (pn NOT LIKE '%/%' AND pn NOT LIKE '% %' AND length(pn) <= 32),   -- [R-20] 'HA-3000/EX-5000' 같은 복합 P/N 차단
  name         TEXT NOT NULL,                        -- 'Stator Core'
  name_ko      TEXT,                                 -- 현장 표기
  spec         TEXT,                                 -- 규격·재질 자유 텍스트
  class_id     INTEGER NOT NULL REFERENCES mat_class(class_id),   -- 말단 분류 1개 (트리거 R-14)
  item_type    TEXT NOT NULL CHECK (item_type IN ('FG','SA','PT','RM','CN','PK')),
                 -- FG 완제품 | SA 사내 조립·가공 중간품(BOM 보유) | PT 단품 | RM 원자재 | CN 부자재 | PK 포장재
  source_type  TEXT NOT NULL CHECK (source_type IN ('MAKE','BUY','BOTH')),
  base_uom     TEXT NOT NULL REFERENCES uom(uom_code),   -- 이 품목의 기준단위. BOM·로트·재고가 전부 이 단위
  is_phantom   INTEGER NOT NULL DEFAULT 0 CHECK (is_phantom IN (0,1)),
                 -- 1 = 팬텀 조립품 (§4.4): 구조에는 있고 재고·로트·산출(OUT)·투입(IN) 행은 없다. 자식이 부모 공정으로 직접 간다
  trace_mode   TEXT NOT NULL DEFAULT 'NONE' CHECK (trace_mode IN ('LOT','SERIAL','NONE')),   -- §8
  status       TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','ACTIVE','BLOCKED','OBSOLETE')),  -- §7.2 삭제 대신 상태
  gtin         TEXT,                                 -- GS1 외부 식별자. 사내 pn 과 분리. 지금은 전부 NULL
  drawing_no   TEXT,
  std_cost     REAL CHECK (std_cost IS NULL OR std_cost >= 0),
                 -- 참조 단가(₩, xlsx 04~08 시트 보존용). **전개 합산에 쓰지 말 것** — 04시트 합계는 SC-1010 과 그 원소재 SC-1011 을
                 -- 둘 다 더한 값이다(노하린 V12-9). 원가 계산은 이 기준의 범위 밖.
  image        TEXT,                                 -- public/assets/parts/<file> — 현행 parts.image 그대로 이관
  -- ── 현장 등록 화면용 3종 (스프린트 4). 전부 NULL 허용 — 기존 60행과 적재기·점검 뷰에 영향 없다 ──
  item_group   TEXT,                                 -- 품목구분: PROD 제품 · GOODS 상품 · SEMI 반제품 · WIP 재공품 · PART 부품 · RAW 원자재 · SUB 부자재 · CONS 소모품 · PACK 포장재
                 -- item_type + source_type 을 현장 용어 한 칸으로 묶은 표시축. 계산·전개는 전부 item_type 으로 한다. NULL 이면 item_type 에서 유도해 보여준다
  shelf_life_days INTEGER CHECK (shelf_life_days IS NULL OR shelf_life_days > 0),
                 -- 사용기한(일). NULL = 무기한 또는 분류(mat_class.shelf_life_days) 기본값 상속. 로트 유효일 = 입고일 + 이 값
  in_uom       TEXT,                                 -- 입고단위 표기(BOX·CAN·ROLL·PLT…). 재고·BOM·로트는 언제나 base_uom 으로만 돈다 — 이건 발주·입고 화면 표기용
  in_qty       REAL CHECK (in_qty IS NULL OR in_qty > 0),   -- 입고단위 1 = base_uom 몇 개인가. 예) 1 BOX = 100 EA → in_uom 'BOX', in_qty 100
  eff_from     TEXT NOT NULL DEFAULT (date('now')),
  obsoleted_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_item_class  ON item(class_id);
CREATE INDEX IF NOT EXISTS idx_item_status ON item(status);
CREATE INDEX IF NOT EXISTS idx_item_type   ON item(item_type);

-- ── A-5 변경 관리 (ECO) — bom_header 가 참조하므로 먼저 정의 (다른 DB 이식 대비, 노하린 §5.2 메모) ──
CREATE TABLE IF NOT EXISTS eco (
  eco_no       TEXT PRIMARY KEY,                     -- 'ECO-2026-0001'
  title        TEXT NOT NULL,
  reason       TEXT NOT NULL,                        -- 품질 | 원가 | 공급 | 설계
  scope        TEXT,
  status       TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','REVIEW','APPROVED','APPLIED','REJECTED')),
  effective_at TEXT,                                 -- 적용일 = 새 rev 의 bom_header.valid_from
  requested_by INTEGER REFERENCES users(id),
  approved_by  INTEGER REFERENCES users(id),
  approved_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  CHECK (requested_by IS NULL OR approved_by IS NULL OR requested_by <> approved_by)   -- 요청자 ≠ 승인자 (§11.2 R5)
);


-- ============================================================================
-- B. 제품 구조 BOM (축 ② — 모자관계)
-- ============================================================================

-- ── B-1 BOM 헤더 ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bom_header (
  bom_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_item_id INTEGER NOT NULL REFERENCES item(item_id),     -- 이 BOM 이 만드는 품목 = 부모
  bom_type       TEXT NOT NULL DEFAULT 'PROD' CHECK (bom_type IN ('PROD','ENG')),
  alt_no         TEXT NOT NULL DEFAULT '00',                   -- 대체 BOM 번호. 지금은 '00' 고정
  rev            TEXT NOT NULL DEFAULT 'A',                    -- ECO 로만 올린다
  base_qty       REAL NOT NULL DEFAULT 1 CHECK (base_qty > 0),  -- 이 BOM 이 산출하는 부모 수량 (SC-1010P 는 80 SHT)
  base_uom       TEXT NOT NULL REFERENCES uom(uom_code),        -- = item.base_uom (트리거 R-7b)
  status         TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','ACTIVE','OBSOLETE')),
  valid_from     TEXT NOT NULL,                                 -- 'YYYY-MM-DD'
  valid_to       TEXT NOT NULL DEFAULT '9999-12-31',
  eco_no         TEXT REFERENCES eco(eco_no),
  approved_by    INTEGER REFERENCES users(id),
  approved_at    TEXT,
  note           TEXT,
  UNIQUE (parent_item_id, bom_type, alt_no, rev),
  CHECK (valid_to >= valid_from)                                -- [D-6]
);
CREATE INDEX IF NOT EXISTS idx_bom_header_parent ON bom_header(parent_item_id, status);

-- ── B-2 BOM 라인 (부모-자식 간선) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bom_line (
  line_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  bom_id        INTEGER NOT NULL REFERENCES bom_header(bom_id) ON DELETE RESTRICT,
  line_no       INTEGER NOT NULL,                   -- 표시 순서 10,20,30…
  child_item_id INTEGER NOT NULL REFERENCES item(item_id),   -- 자식
  qty_per       REAL NOT NULL CHECK (qty_per > 0),  -- 부모 base_qty 당 소요량 (원천 숫자 그대로. 0.85 kg / 80 매)
  uom_code      TEXT NOT NULL REFERENCES uom(uom_code),   -- 자식 base_uom 과 같거나 uom_conv 로 환산 가능 (트리거 R-7)
  qty_basis     TEXT NOT NULL DEFAULT 'NET' CHECK (qty_basis IN ('NET','GROSS')),
                  -- [V12-4] NET = 순소요(스크랩 미포함, 실소요 = qty_per/(1-s)) · GROSS = 손실 포함 실측 소요(qty_per 가 이미 실소요)
                  -- SC-1010P→SC-1011 0.85 kg 은 코일 투입 실측이라 GROSS. scrap_pct 가 나중에 채워져도 두 번 곱하지 않는다
  scrap_pct     REAL NOT NULL DEFAULT 0 CHECK (scrap_pct >= 0 AND scrap_pct < 100),   -- ISO 22400 scrap ratio 입력값. 초기 전부 0
  alt_group     TEXT,                               -- 대체 그룹 키 (NULL = 대체 없음)
  alt_priority  INTEGER,                            -- 그룹 내 우선순위. 1 = 주(主). 전개는 그룹당 최소값 1개만 계상
  is_optional   INTEGER NOT NULL DEFAULT 0 CHECK (is_optional IN (0,1)),
  bop_link      TEXT NOT NULL DEFAULT 'REQUIRED' CHECK (bop_link IN ('REQUIRED','PHANTOM','NONE')),
                  -- [D-8] REQUIRED = 투입(IN) 행이 있어야 한다 (없으면 '미배정' = BOP 누락)
                  --       PHANTOM  = 자식이 팬텀. IN 행 금지. 자식의 자식이 직접 공정으로 (트리거가 자동 설정)
                  --       NONE     = 의도적으로 BOP 에 걸지 않음 (사급·옵션 등, note 에 사유 필수)
  valid_from    TEXT NOT NULL,
  valid_to      TEXT NOT NULL DEFAULT '9999-12-31',
  eco_no        TEXT REFERENCES eco(eco_no),
  note          TEXT,
  CHECK (valid_to >= valid_from),                                  -- [D-6]
  CHECK ((alt_group IS NULL) = (alt_priority IS NULL)),            -- 그룹과 우선순위는 함께
  CHECK (alt_priority IS NULL OR alt_priority >= 1),
  CHECK (bop_link <> 'NONE' OR note IS NOT NULL)                   -- NONE 은 사유 필수
);
CREATE INDEX IF NOT EXISTS idx_bom_line_bom   ON bom_line(bom_id);
CREATE INDEX IF NOT EXISTS idx_bom_line_child ON bom_line(child_item_id);   -- where-used
-- [R-3] 같은 부모 밑 같은 자식 중복 금지 — 대체그룹·유효시작일이 다르면 허용 (V-2 확인)
CREATE UNIQUE INDEX IF NOT EXISTS ux_bom_line_dup
  ON bom_line(bom_id, child_item_id, COALESCE(alt_group,'-'), valid_from);


-- ============================================================================
-- C. BOM ↔ BOP 연결
-- ============================================================================
-- 수량은 여기 없다(qty_out 제외). 소요량은 bom_line.qty_per 하나뿐 — 완성품당 소요는 뷰 v_bom_line_qpp 가 계산한다.
-- [D-9] 산출(OUT) 행은 24공정 전부 갖는다: is_final=1 (P/N 산출 완료, 7건) / is_final=0 (같은 품목의 진행 상태, out_state 텍스트, 17건)
--       → mat_lot.state_pm_id 가 이 행을 가리켜 '이 로트는 OP-A80 함침 스테이터 상태' 를 표현한다. 자유 텍스트 이중 보관 없음.
CREATE TABLE IF NOT EXISTS process_material (
  pm_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  process_id   INTEGER NOT NULL REFERENCES processes(id),        -- 기존 processes 재사용 (쟁점 9 확정)
  io           TEXT NOT NULL CHECK (io IN ('IN','OUT')),
  line_id      INTEGER REFERENCES bom_line(line_id),             -- IN 필수
  item_id      INTEGER REFERENCES item(item_id),                 -- OUT 필수 (이 공정이 만들거나 진행시키는 품목)
  is_final     INTEGER NOT NULL DEFAULT 1 CHECK (is_final IN (0,1)),  -- OUT: 1 = 여기서 품목 완성(로트 확정) · 0 = 진행 상태
  out_state    TEXT,                                             -- OUT·is_final=0 일 때 필수: '함침 스테이터' 등 (processes.output 원문)
  split_pct    REAL NOT NULL DEFAULT 100 CHECK (split_pct > 0 AND split_pct <= 100),  -- 한 라인을 여러 공정에 나눠 투입할 때 (R-10 합 100)
  qty_out      REAL CHECK (qty_out IS NULL OR qty_out > 0),      -- OUT·is_final=1: 1회 산출 수량 (OP-A10 → 80 SHT)
  issue_method TEXT NOT NULL DEFAULT 'BACKFLUSH' CHECK (issue_method IN ('BACKFLUSH','PICK','BULK')),   -- §4.5 (IN 에만 의미)
  note         TEXT,
  CHECK ( (io = 'IN'  AND line_id IS NOT NULL AND item_id IS NULL AND out_state IS NULL AND is_final = 1)
       OR (io = 'OUT' AND item_id IS NOT NULL AND line_id IS NULL AND (is_final = 1 OR out_state IS NOT NULL)) )
);
CREATE INDEX IF NOT EXISTS idx_pm_process ON process_material(process_id);
CREATE INDEX IF NOT EXISTS idx_pm_line    ON process_material(line_id);
CREATE INDEX IF NOT EXISTS idx_pm_item    ON process_material(item_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pm_in  ON process_material(process_id, line_id) WHERE io = 'IN';
CREATE UNIQUE INDEX IF NOT EXISTS ux_pm_out ON process_material(process_id, item_id) WHERE io = 'OUT';


-- ============================================================================
-- D. 로트 / 서브로트 / 계보 / 배치 (축 ③ — 추적성)
-- ============================================================================

-- ── D-1 로트 (ISA-95 Material Lot / Sublot 을 자기참조 한 테이블로) ─────────
CREATE TABLE IF NOT EXISTS mat_lot (
  lot_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  lot_no        TEXT NOT NULL UNIQUE,                -- 'LOT-SC1011-260912-A' · 시리얼 'SN-BLDC-2026-000481'
  item_id       INTEGER NOT NULL REFERENCES item(item_id),
  lot_kind      TEXT NOT NULL DEFAULT 'LOT' CHECK (lot_kind IN ('LOT','SUBLOT','SERIAL')),
  parent_lot_id INTEGER REFERENCES mat_lot(lot_id),  -- 분할 계보 (서브로트의 서브로트 가능)
  qty           REAL NOT NULL CHECK (qty >= 0),      -- **현재** 수량. 분할·투입 시 차감 (D-17 규칙, 서비스 계층 트랜잭션)
  qty_init      REAL CHECK (qty_init IS NULL OR qty_init >= 0),   -- 생성 시 수량. 트리거가 qty 로 자동 채우고 이후 불변 (D-17 감사 기준)
  uom_code      TEXT NOT NULL REFERENCES uom(uom_code),
  status        TEXT NOT NULL DEFAULT 'AVAILABLE'
                  CHECK (status IN ('AVAILABLE','HOLD','CONSUMED','SCRAPPED','SHIPPED')),
  state_pm_id   INTEGER REFERENCES process_material(pm_id),   -- [D-9] 마지막으로 통과한 산출(OUT) 행 = 공정 진행 상태
  supplier      TEXT,
  supplier_lot  TEXT,                                -- 밀시트·공급사 로트 (역추적 종착점)
  made_at       TEXT,
  expire_at     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  CHECK (parent_lot_id IS NULL OR parent_lot_id <> lot_id),      -- 자기 분할 금지
  CHECK (lot_kind <> 'SERIAL' OR qty <= 1)                       -- 시리얼은 개체 1
);
CREATE INDEX IF NOT EXISTS idx_lot_item   ON mat_lot(item_id, status);
CREATE INDEX IF NOT EXISTS idx_lot_parent ON mat_lot(parent_lot_id);

-- ── D-2 계보 (투입 로트 → 산출 로트). 4M 이 한 행에서 만난다 ─────────────
CREATE TABLE IF NOT EXISTS lot_genealogy (
  gen_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  out_lot_id    INTEGER NOT NULL REFERENCES mat_lot(lot_id),   -- 산출(자식) 로트
  in_lot_id     INTEGER NOT NULL REFERENCES mat_lot(lot_id),   -- 투입(부모) 로트
  process_id    INTEGER REFERENCES processes(id),
  equipment_id  INTEGER REFERENCES equipments(id),             -- Machine
  user_id       INTEGER REFERENCES users(id),                  -- Man
  record_id     INTEGER REFERENCES production_records(id),     -- 실적 (백플러시 근거)
  qty_consumed  REAL NOT NULL CHECK (qty_consumed > 0),        -- 실투입 (소요량과 구분, 원칙 3)
  uom_code      TEXT NOT NULL REFERENCES uom(uom_code),
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  CHECK (in_lot_id <> out_lot_id)                              -- [R-13 / D-14]
);
-- [D-16] UNIQUE(out,in,process_id) 는 process_id NULL 에서 무력 → 식 인덱스
CREATE UNIQUE INDEX IF NOT EXISTS ux_gen_edge ON lot_genealogy(out_lot_id, in_lot_id, COALESCE(process_id, 0));
CREATE INDEX IF NOT EXISTS idx_gen_out ON lot_genealogy(out_lot_id);   -- 역방향
CREATE INDEX IF NOT EXISTS idx_gen_in  ON lot_genealogy(in_lot_id);    -- 정방향

-- ── D-3 배치 (ISA-88 배치 개념 — OP-A80 VPI · OP-A90 큐어링 30 ea/배치) ───
-- [R-23 / V12-5] 배치는 로트 '합침' 이 아니라 '같이 처리됨' 의 기록이다. 로트는 그대로, 배치가 로트를 묶는다.
--   → "함침 배치 #7 불합격 → 그 30 대" 는 proc_batch_lot 한 번 조회로 나온다. 팬텀·P/N 부여와 무관.
CREATE TABLE IF NOT EXISTS proc_batch (
  batch_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_no     TEXT NOT NULL UNIQUE,                 -- 'VPI-260912-07'
  process_id   INTEGER NOT NULL REFERENCES processes(id),
  equipment_id INTEGER REFERENCES equipments(id),
  record_id    INTEGER REFERENCES production_records(id),
  started_at   TEXT,
  ended_at     TEXT,
  status       TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED','REJECTED')),
  note         TEXT
);
CREATE TABLE IF NOT EXISTS proc_batch_lot (
  batch_id     INTEGER NOT NULL REFERENCES proc_batch(batch_id),
  lot_id       INTEGER NOT NULL REFERENCES mat_lot(lot_id),
  PRIMARY KEY (batch_id, lot_id)
);
CREATE INDEX IF NOT EXISTS idx_batch_lot_lot ON proc_batch_lot(lot_id);


-- ============================================================================
-- E. 트리거 (전부 IF NOT EXISTS — 멱등)
-- ============================================================================
-- RAISE 메시지는 SQLite 제약상 리터럴만 가능하다(경로를 넣을 수 없다, R-19 보류). 경로는 v_chk_r1_cycle 로 본다.

-- ── E-1 [R-1] 순환 참조 차단 — INSERT ─────────────────────────────────────
-- [D-3/D-4] 상태 필터 'APPROVED/ACTIVE' → OBSOLETE 만 제외 (DRAFT 도 본다: 구조 무결성은 승인과 무관)
-- [D-1]     깊이 가드 10 → 64, 한계 도달도 RAISE. 최대 레벨 10(R-2) 은 v_chk_r2_depth 로 분리
-- UNION(=중복 제거) 을 쓰므로 순환이 이미 있어도 (item_id, depth) 조합은 노드 수×64 를 넘지 않는다
CREATE TRIGGER IF NOT EXISTS trg_bom_line_cycle_ins BEFORE INSERT ON bom_line
BEGIN
  SELECT RAISE(ABORT, 'R-1: BOM 순환 참조 — 자식의 하위 구조에 부모가 있다 (또는 깊이 64 초과)')
  WHERE EXISTS (
    WITH RECURSIVE down(item_id, depth) AS (
      SELECT NEW.child_item_id, 0
      UNION
      SELECT l.child_item_id, d.depth + 1
        FROM down d
        JOIN bom_header h ON h.parent_item_id = d.item_id AND h.status <> 'OBSOLETE'
        JOIN bom_line   l ON l.bom_id = h.bom_id
       WHERE d.depth < 64
    )
    SELECT 1 FROM down
     WHERE item_id = (SELECT parent_item_id FROM bom_header WHERE bom_id = NEW.bom_id)
        OR depth >= 64
  );
END;

-- ── E-2 [R-1 / D-5] 순환 참조 차단 — UPDATE (자식·부모 변경) ─────────────
CREATE TRIGGER IF NOT EXISTS trg_bom_line_cycle_upd
BEFORE UPDATE OF bom_id, child_item_id ON bom_line
BEGIN
  SELECT RAISE(ABORT, 'R-1: BOM 순환 참조 — UPDATE 결과 자식의 하위 구조에 부모가 생긴다 (또는 깊이 64 초과)')
  WHERE EXISTS (
    WITH RECURSIVE down(item_id, depth) AS (
      SELECT NEW.child_item_id, 0
      UNION
      SELECT l.child_item_id, d.depth + 1
        FROM down d
        JOIN bom_header h ON h.parent_item_id = d.item_id AND h.status <> 'OBSOLETE'
        JOIN bom_line   l ON l.bom_id = h.bom_id AND l.line_id <> OLD.line_id
       WHERE d.depth < 64
    )
    SELECT 1 FROM down
     WHERE item_id = (SELECT parent_item_id FROM bom_header WHERE bom_id = NEW.bom_id)
        OR depth >= 64
  );
END;

-- ── E-3 [R-1] 헤더의 부모 변경 · OBSOLETE 해제 시에도 같은 검사 ────────────
CREATE TRIGGER IF NOT EXISTS trg_bom_header_cycle_upd
BEFORE UPDATE OF parent_item_id, status ON bom_header
WHEN NEW.status <> 'OBSOLETE' AND (NEW.parent_item_id <> OLD.parent_item_id OR OLD.status = 'OBSOLETE')
BEGIN
  SELECT RAISE(ABORT, 'R-1: BOM 헤더 변경으로 순환 참조가 생긴다')
  WHERE EXISTS (
    WITH RECURSIVE down(item_id, depth) AS (
      SELECT l.child_item_id, 0 FROM bom_line l WHERE l.bom_id = NEW.bom_id
      UNION
      SELECT l.child_item_id, d.depth + 1
        FROM down d
        JOIN bom_header h ON h.parent_item_id = d.item_id AND h.status <> 'OBSOLETE' AND h.bom_id <> NEW.bom_id
        JOIN bom_line   l ON l.bom_id = h.bom_id
       WHERE d.depth < 64
    )
    SELECT 1 FROM down WHERE item_id = NEW.parent_item_id OR depth >= 64
  );
END;

-- ── E-4 [R-9] 라인 유효일자 겹침 — INSERT / UPDATE [D-7] ─────────────────
CREATE TRIGGER IF NOT EXISTS trg_bom_line_overlap_ins BEFORE INSERT ON bom_line
BEGIN
  SELECT RAISE(ABORT, 'R-9: 같은 부모·자식·대체그룹의 라인 유효기간이 겹친다')
  WHERE EXISTS (
    SELECT 1 FROM bom_line x
     WHERE x.bom_id = NEW.bom_id
       AND x.child_item_id = NEW.child_item_id
       AND COALESCE(x.alt_group,'-') = COALESCE(NEW.alt_group,'-')
       AND NEW.valid_from <= x.valid_to
       AND NEW.valid_to   >= x.valid_from
  );
END;
CREATE TRIGGER IF NOT EXISTS trg_bom_line_overlap_upd
BEFORE UPDATE OF bom_id, child_item_id, alt_group, valid_from, valid_to ON bom_line
BEGIN
  SELECT RAISE(ABORT, 'R-9: UPDATE 결과 같은 부모·자식·대체그룹의 라인 유효기간이 겹친다')
  WHERE EXISTS (
    SELECT 1 FROM bom_line x
     WHERE x.line_id <> OLD.line_id
       AND x.bom_id = NEW.bom_id
       AND x.child_item_id = NEW.child_item_id
       AND COALESCE(x.alt_group,'-') = COALESCE(NEW.alt_group,'-')
       AND NEW.valid_from <= x.valid_to
       AND NEW.valid_to   >= x.valid_from
  );
END;

-- ── E-5 [R-9b / D-12] 헤더 유효기간 겹침 — 한 시점에 유효한 승인 BOM 은 부모(·유형·대체번호)당 1개 ──
-- DRAFT 끼리는 겹쳐도 된다(ECO 준비 중). 승인(APPROVED/ACTIVE) 되는 순간 검사한다.
CREATE TRIGGER IF NOT EXISTS trg_bom_header_overlap_ins BEFORE INSERT ON bom_header
WHEN NEW.status IN ('APPROVED','ACTIVE')
BEGIN
  SELECT RAISE(ABORT, 'R-9b: 같은 부모의 승인 BOM 유효기간이 겹친다 — 직전 rev 의 valid_to 를 먼저 끊어라')
  WHERE EXISTS (
    SELECT 1 FROM bom_header x
     WHERE x.parent_item_id = NEW.parent_item_id AND x.bom_type = NEW.bom_type AND x.alt_no = NEW.alt_no
       AND x.status IN ('APPROVED','ACTIVE')
       AND NEW.valid_from <= x.valid_to AND NEW.valid_to >= x.valid_from
  );
END;
CREATE TRIGGER IF NOT EXISTS trg_bom_header_overlap_upd
BEFORE UPDATE OF parent_item_id, bom_type, alt_no, status, valid_from, valid_to ON bom_header
WHEN NEW.status IN ('APPROVED','ACTIVE')
BEGIN
  SELECT RAISE(ABORT, 'R-9b: UPDATE 결과 같은 부모의 승인 BOM 유효기간이 겹친다')
  WHERE EXISTS (
    SELECT 1 FROM bom_header x
     WHERE x.bom_id <> OLD.bom_id
       AND x.parent_item_id = NEW.parent_item_id AND x.bom_type = NEW.bom_type AND x.alt_no = NEW.alt_no
       AND x.status IN ('APPROVED','ACTIVE')
       AND NEW.valid_from <= x.valid_to AND NEW.valid_to >= x.valid_from
  );
END;

-- ── E-6 [D-13] 대체 그룹 — 같은 그룹·같은 우선순위가 같은 기간에 둘일 수 없다 ──
-- (같은 그룹에 여러 품목이 동시에 유효한 것 자체는 정상 — 대체품의 정의. 전개는 최소 alt_priority 만 계상: v_bom_line_eff.is_primary)
CREATE TRIGGER IF NOT EXISTS trg_bom_line_alt_ins BEFORE INSERT ON bom_line
WHEN NEW.alt_group IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'D-13: 같은 대체 그룹에 같은 우선순위가 같은 기간에 둘이다 — 주자재를 정할 수 없다')
  WHERE EXISTS (
    SELECT 1 FROM bom_line x
     WHERE x.bom_id = NEW.bom_id AND x.alt_group = NEW.alt_group AND x.alt_priority = NEW.alt_priority
       AND NEW.valid_from <= x.valid_to AND NEW.valid_to >= x.valid_from
  );
END;
CREATE TRIGGER IF NOT EXISTS trg_bom_line_alt_upd
BEFORE UPDATE OF bom_id, alt_group, alt_priority, valid_from, valid_to ON bom_line
WHEN NEW.alt_group IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'D-13: UPDATE 결과 같은 대체 그룹에 같은 우선순위가 같은 기간에 둘이다')
  WHERE EXISTS (
    SELECT 1 FROM bom_line x
     WHERE x.line_id <> OLD.line_id
       AND x.bom_id = NEW.bom_id AND x.alt_group = NEW.alt_group AND x.alt_priority = NEW.alt_priority
       AND NEW.valid_from <= x.valid_to AND NEW.valid_to >= x.valid_from
  );
END;

-- ── E-7 [R-7 / R-8 / D-20] 단위 정합 · 소수 자릿수 — DB 에 박는다 ───────────
-- R-7: 라인 단위 = 자식 base_uom 이거나, uom_conv 에 (전역 또는 그 품목 전용) 환산이 어느 방향으로든 있어야 한다
-- R-8: ROUND(qty, uom.decimals) = qty. 반올림하지 않고 거부한다 (TC-34b 답: 반올림 정책은 '없음' — 입력을 고쳐라)
CREATE TRIGGER IF NOT EXISTS trg_bom_line_uom_ins BEFORE INSERT ON bom_line
BEGIN
  SELECT RAISE(ABORT, 'R-7: 라인 단위가 자식 기준단위와 다르고 uom_conv 환산도 없다')
  WHERE NEW.uom_code <> (SELECT base_uom FROM item WHERE item_id = NEW.child_item_id)
    AND NOT EXISTS (
      SELECT 1 FROM uom_conv c JOIN item i ON i.item_id = NEW.child_item_id
       WHERE ((c.from_uom = NEW.uom_code AND c.to_uom = i.base_uom) OR (c.from_uom = i.base_uom AND c.to_uom = NEW.uom_code))
         AND (c.item_id IS NULL OR c.item_id = NEW.child_item_id));
  SELECT RAISE(ABORT, 'R-8: 수량의 소수 자릿수가 단위 허용 자릿수(uom.decimals)를 넘는다')
  WHERE ROUND(NEW.qty_per, (SELECT decimals FROM uom WHERE uom_code = NEW.uom_code)) <> NEW.qty_per;
END;
CREATE TRIGGER IF NOT EXISTS trg_bom_line_uom_upd BEFORE UPDATE OF child_item_id, uom_code, qty_per ON bom_line
BEGIN
  SELECT RAISE(ABORT, 'R-7: 라인 단위가 자식 기준단위와 다르고 uom_conv 환산도 없다')
  WHERE NEW.uom_code <> (SELECT base_uom FROM item WHERE item_id = NEW.child_item_id)
    AND NOT EXISTS (
      SELECT 1 FROM uom_conv c JOIN item i ON i.item_id = NEW.child_item_id
       WHERE ((c.from_uom = NEW.uom_code AND c.to_uom = i.base_uom) OR (c.from_uom = i.base_uom AND c.to_uom = NEW.uom_code))
         AND (c.item_id IS NULL OR c.item_id = NEW.child_item_id));
  SELECT RAISE(ABORT, 'R-8: 수량의 소수 자릿수가 단위 허용 자릿수(uom.decimals)를 넘는다')
  WHERE ROUND(NEW.qty_per, (SELECT decimals FROM uom WHERE uom_code = NEW.uom_code)) <> NEW.qty_per;
END;
-- R-7b: 헤더 base_uom 은 부모 품목 base_uom 과 같아야 한다
CREATE TRIGGER IF NOT EXISTS trg_bom_header_uom_ins BEFORE INSERT ON bom_header
WHEN NEW.base_uom <> (SELECT base_uom FROM item WHERE item_id = NEW.parent_item_id)
BEGIN SELECT RAISE(ABORT, 'R-7b: bom_header.base_uom 은 부모 품목의 base_uom 과 같아야 한다'); END;
CREATE TRIGGER IF NOT EXISTS trg_bom_header_uom_upd BEFORE UPDATE OF base_uom, parent_item_id ON bom_header
WHEN NEW.base_uom <> (SELECT base_uom FROM item WHERE item_id = NEW.parent_item_id)
BEGIN SELECT RAISE(ABORT, 'R-7b: bom_header.base_uom 은 부모 품목의 base_uom 과 같아야 한다'); END;
-- R-7c: 전역 환산은 같은 차원끼리만 (EA→kg 전역 금지, SHT→kg 는 item_id 지정 시만)
CREATE TRIGGER IF NOT EXISTS trg_uom_conv_dim_ins BEFORE INSERT ON uom_conv
WHEN NEW.item_id IS NULL
  AND (SELECT dim FROM uom WHERE uom_code = NEW.from_uom) <> (SELECT dim FROM uom WHERE uom_code = NEW.to_uom)
BEGIN SELECT RAISE(ABORT, 'R-7c: 전역 환산은 같은 차원(dim) 사이에서만 — 차원 교차는 item_id 를 지정한 행으로'); END;
CREATE TRIGGER IF NOT EXISTS trg_uom_conv_dim_upd BEFORE UPDATE OF from_uom, to_uom, item_id ON uom_conv
WHEN NEW.item_id IS NULL
  AND (SELECT dim FROM uom WHERE uom_code = NEW.from_uom) <> (SELECT dim FROM uom WHERE uom_code = NEW.to_uom)
BEGIN SELECT RAISE(ABORT, 'R-7c: 전역 환산은 같은 차원(dim) 사이에서만 — 차원 교차는 item_id 를 지정한 행으로'); END;

-- ── E-8 [R-14] 품목은 말단 분류에만 ────────────────────────────────────────
CREATE TRIGGER IF NOT EXISTS trg_item_leaf_ins BEFORE INSERT ON item
WHEN (SELECT is_leaf FROM mat_class WHERE class_id = NEW.class_id) = 0
BEGIN SELECT RAISE(ABORT, 'R-14: 품목은 말단(is_leaf=1) 분류에만 붙는다'); END;
CREATE TRIGGER IF NOT EXISTS trg_item_leaf_upd BEFORE UPDATE OF class_id ON item
WHEN (SELECT is_leaf FROM mat_class WHERE class_id = NEW.class_id) = 0
BEGIN SELECT RAISE(ABORT, 'R-14: 품목은 말단(is_leaf=1) 분류에만 붙는다'); END;

-- ── E-9 [D-8] 팬텀 ↔ bop_link 정합 ─────────────────────────────────────────
-- 자식이 팬텀이면 라인은 자동으로 PHANTOM (적재기가 신경 쓸 필요 없다). 팬텀이 아닌 자식에 PHANTOM 을 적으면 거부.
CREATE TRIGGER IF NOT EXISTS trg_bom_line_phantom_chk_ins BEFORE INSERT ON bom_line
WHEN NEW.bop_link = 'PHANTOM' AND (SELECT is_phantom FROM item WHERE item_id = NEW.child_item_id) = 0
BEGIN SELECT RAISE(ABORT, 'D-8: bop_link=PHANTOM 은 자식 품목이 팬텀(is_phantom=1)일 때만'); END;
CREATE TRIGGER IF NOT EXISTS trg_bom_line_phantom_chk_upd BEFORE UPDATE OF bop_link, child_item_id ON bom_line
WHEN NEW.bop_link = 'PHANTOM' AND (SELECT is_phantom FROM item WHERE item_id = NEW.child_item_id) = 0
BEGIN SELECT RAISE(ABORT, 'D-8: bop_link=PHANTOM 은 자식 품목이 팬텀(is_phantom=1)일 때만'); END;
CREATE TRIGGER IF NOT EXISTS trg_bom_line_phantom_set_ins AFTER INSERT ON bom_line
WHEN NEW.bop_link <> 'PHANTOM' AND (SELECT is_phantom FROM item WHERE item_id = NEW.child_item_id) = 1
BEGIN UPDATE bom_line SET bop_link = 'PHANTOM' WHERE line_id = NEW.line_id; END;
CREATE TRIGGER IF NOT EXISTS trg_bom_line_phantom_set_upd AFTER UPDATE OF child_item_id, bop_link ON bom_line
WHEN NEW.bop_link <> 'PHANTOM' AND (SELECT is_phantom FROM item WHERE item_id = NEW.child_item_id) = 1
BEGIN UPDATE bom_line SET bop_link = 'PHANTOM' WHERE line_id = NEW.line_id; END;
-- 품목이 팬텀으로 바뀌면: 그 라인에 IN 행·그 품목에 OUT 행이 있으면 거부, 없으면 라인 bop_link 를 따라 바꾼다
CREATE TRIGGER IF NOT EXISTS trg_item_phantom_upd BEFORE UPDATE OF is_phantom ON item
WHEN NEW.is_phantom = 1 AND OLD.is_phantom = 0
BEGIN
  SELECT RAISE(ABORT, 'D-8: 팬텀으로 바꾸기 전에 이 품목 라인의 투입(IN) 행과 이 품목의 산출(OUT) 행을 먼저 제거하라')
  WHERE EXISTS (SELECT 1 FROM process_material pm JOIN bom_line l ON l.line_id = pm.line_id
                 WHERE pm.io = 'IN' AND l.child_item_id = NEW.item_id)
     OR EXISTS (SELECT 1 FROM process_material pm WHERE pm.io = 'OUT' AND pm.item_id = NEW.item_id);
END;
CREATE TRIGGER IF NOT EXISTS trg_item_phantom_cascade AFTER UPDATE OF is_phantom ON item
WHEN NEW.is_phantom <> OLD.is_phantom
BEGIN
  UPDATE bom_line SET bop_link = CASE WHEN NEW.is_phantom = 1 THEN 'PHANTOM' ELSE 'REQUIRED' END
   WHERE child_item_id = NEW.item_id AND bop_link IN ('PHANTOM','REQUIRED');
END;

-- ── E-10 [D-8 / V12-7 / R-22] process_material 정합 ───────────────────────
-- IN : REQUIRED 라인에만 · 자식 투입 공정 seq ≤ 부모 산출(is_final) 공정 seq (같은 processes.line 안에서만 비교)
-- OUT: 팬텀 품목 금지 · is_final=1 이면 그 품목 라인들의 IN seq 가 이 공정 seq 를 넘지 않아야
CREATE TRIGGER IF NOT EXISTS trg_pm_ins BEFORE INSERT ON process_material
BEGIN
  SELECT RAISE(ABORT, 'D-8: 팬텀(PHANTOM)·미연결(NONE) 라인에는 투입(IN) 행을 둘 수 없다')
   WHERE NEW.io = 'IN' AND (SELECT bop_link FROM bom_line WHERE line_id = NEW.line_id) <> 'REQUIRED';
  SELECT RAISE(ABORT, 'V12-7: 팬텀 품목은 산출(OUT) 행을 가질 수 없다 — 팬텀은 로트도 백플러시도 없다')
   WHERE NEW.io = 'OUT' AND (SELECT is_phantom FROM item WHERE item_id = NEW.item_id) = 1;
  SELECT RAISE(ABORT, 'R-22: 자식 투입 공정이 부모 산출 공정보다 늦다 (seq(child IN) > seq(parent OUT), 같은 라인)')
   WHERE NEW.io = 'IN' AND EXISTS (
     SELECT 1 FROM bom_line l
       JOIN bom_header h ON h.bom_id = l.bom_id
       JOIN process_material po ON po.item_id = h.parent_item_id AND po.io = 'OUT' AND po.is_final = 1
       JOIN processes pp ON pp.id = po.process_id
       JOIN processes pc ON pc.id = NEW.process_id
      WHERE l.line_id = NEW.line_id AND pc.line = pp.line AND pc.seq > pp.seq);
  SELECT RAISE(ABORT, 'R-22: 이 산출 공정보다 늦게 투입되는 자식 라인이 이미 있다 (같은 라인)')
   WHERE NEW.io = 'OUT' AND NEW.is_final = 1 AND EXISTS (
     SELECT 1 FROM bom_header h
       JOIN bom_line l ON l.bom_id = h.bom_id
       JOIN process_material pi ON pi.line_id = l.line_id AND pi.io = 'IN'
       JOIN processes pc ON pc.id = pi.process_id
       JOIN processes pp ON pp.id = NEW.process_id
      WHERE h.parent_item_id = NEW.item_id AND pc.line = pp.line AND pc.seq > pp.seq);
END;
CREATE TRIGGER IF NOT EXISTS trg_pm_upd BEFORE UPDATE OF process_id, io, line_id, item_id, is_final ON process_material
BEGIN
  SELECT RAISE(ABORT, 'D-8: 팬텀(PHANTOM)·미연결(NONE) 라인에는 투입(IN) 행을 둘 수 없다')
   WHERE NEW.io = 'IN' AND (SELECT bop_link FROM bom_line WHERE line_id = NEW.line_id) <> 'REQUIRED';
  SELECT RAISE(ABORT, 'V12-7: 팬텀 품목은 산출(OUT) 행을 가질 수 없다 — 팬텀은 로트도 백플러시도 없다')
   WHERE NEW.io = 'OUT' AND (SELECT is_phantom FROM item WHERE item_id = NEW.item_id) = 1;
  SELECT RAISE(ABORT, 'R-22: 자식 투입 공정이 부모 산출 공정보다 늦다 (seq(child IN) > seq(parent OUT), 같은 라인)')
   WHERE NEW.io = 'IN' AND EXISTS (
     SELECT 1 FROM bom_line l
       JOIN bom_header h ON h.bom_id = l.bom_id
       JOIN process_material po ON po.item_id = h.parent_item_id AND po.io = 'OUT' AND po.is_final = 1 AND po.pm_id <> OLD.pm_id
       JOIN processes pp ON pp.id = po.process_id
       JOIN processes pc ON pc.id = NEW.process_id
      WHERE l.line_id = NEW.line_id AND pc.line = pp.line AND pc.seq > pp.seq);
  SELECT RAISE(ABORT, 'R-22: 이 산출 공정보다 늦게 투입되는 자식 라인이 이미 있다 (같은 라인)')
   WHERE NEW.io = 'OUT' AND NEW.is_final = 1 AND EXISTS (
     SELECT 1 FROM bom_header h
       JOIN bom_line l ON l.bom_id = h.bom_id
       JOIN process_material pi ON pi.line_id = l.line_id AND pi.io = 'IN' AND pi.pm_id <> OLD.pm_id
       JOIN processes pc ON pc.id = pi.process_id
       JOIN processes pp ON pp.id = NEW.process_id
      WHERE h.parent_item_id = NEW.item_id AND pc.line = pp.line AND pc.seq > pp.seq);
END;

-- ── E-11 [R-13 / D-15] 로트 계보 순환 차단 (간선 2종 = 분할 parent_lot_id + 투입 lot_genealogy) ──
-- 재귀 CTE 는 자기 자신을 두 번 참조할 수 없으므로(노하린 §5.7) 간선을 먼저 비재귀 CTE e 로 합친다.
CREATE TRIGGER IF NOT EXISTS trg_gen_cycle_ins BEFORE INSERT ON lot_genealogy
BEGIN
  SELECT RAISE(ABORT, 'R-13: 로트 계보 순환 — 산출 로트의 하류에 투입 로트가 이미 있다 (또는 깊이 64 초과)')
  WHERE EXISTS (
    WITH RECURSIVE
      e(p, c) AS (SELECT in_lot_id, out_lot_id FROM lot_genealogy
                  UNION ALL
                  SELECT parent_lot_id, lot_id FROM mat_lot WHERE parent_lot_id IS NOT NULL),
      f(lot_id, depth) AS (SELECT NEW.out_lot_id, 0
                           UNION
                           SELECT e.c, f.depth + 1 FROM f JOIN e ON e.p = f.lot_id WHERE f.depth < 64)
    SELECT 1 FROM f WHERE lot_id = NEW.in_lot_id OR depth >= 64
  );
END;
CREATE TRIGGER IF NOT EXISTS trg_gen_cycle_upd BEFORE UPDATE OF in_lot_id, out_lot_id ON lot_genealogy
BEGIN
  SELECT RAISE(ABORT, 'R-13: UPDATE 결과 로트 계보에 순환이 생긴다')
  WHERE EXISTS (
    WITH RECURSIVE
      e(p, c) AS (SELECT in_lot_id, out_lot_id FROM lot_genealogy WHERE gen_id <> OLD.gen_id
                  UNION ALL
                  SELECT parent_lot_id, lot_id FROM mat_lot WHERE parent_lot_id IS NOT NULL),
      f(lot_id, depth) AS (SELECT NEW.out_lot_id, 0
                           UNION
                           SELECT e.c, f.depth + 1 FROM f JOIN e ON e.p = f.lot_id WHERE f.depth < 64)
    SELECT 1 FROM f WHERE lot_id = NEW.in_lot_id OR depth >= 64
  );
END;
-- 분할 계보(parent_lot_id) 도 같은 간선 집합으로 검사: 새 부모가 내 하류에 있으면 순환
CREATE TRIGGER IF NOT EXISTS trg_lot_split_cycle_ins BEFORE INSERT ON mat_lot
WHEN NEW.parent_lot_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'R-13: 분할 계보 순환 — 부모 로트가 이 로트의 하류에 있다')
  WHERE EXISTS (
    WITH RECURSIVE
      e(p, c) AS (SELECT in_lot_id, out_lot_id FROM lot_genealogy
                  UNION ALL
                  SELECT parent_lot_id, lot_id FROM mat_lot WHERE parent_lot_id IS NOT NULL),
      f(lot_id, depth) AS (SELECT NEW.lot_id, 0
                           UNION
                           SELECT e.c, f.depth + 1 FROM f JOIN e ON e.p = f.lot_id WHERE f.depth < 64)
    SELECT 1 FROM f WHERE lot_id = NEW.parent_lot_id OR depth >= 64
  );
END;
CREATE TRIGGER IF NOT EXISTS trg_lot_split_cycle_upd BEFORE UPDATE OF parent_lot_id ON mat_lot
WHEN NEW.parent_lot_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'R-13: 분할 계보 순환 — 부모 로트가 이 로트의 하류에 있다')
  WHERE EXISTS (
    WITH RECURSIVE
      e(p, c) AS (SELECT in_lot_id, out_lot_id FROM lot_genealogy
                  UNION ALL
                  SELECT parent_lot_id, lot_id FROM mat_lot WHERE parent_lot_id IS NOT NULL AND lot_id <> OLD.lot_id),
      f(lot_id, depth) AS (SELECT NEW.lot_id, 0
                           UNION
                           SELECT e.c, f.depth + 1 FROM f JOIN e ON e.p = f.lot_id WHERE f.depth < 64)
    SELECT 1 FROM f WHERE lot_id = NEW.parent_lot_id OR depth >= 64
  );
END;

-- ── E-12 [D-17] 로트 생성 수량 자동 기록 · 불변 ────────────────────────────
CREATE TRIGGER IF NOT EXISTS trg_lot_qty_init AFTER INSERT ON mat_lot
WHEN NEW.qty_init IS NULL
BEGIN UPDATE mat_lot SET qty_init = NEW.qty WHERE lot_id = NEW.lot_id; END;
CREATE TRIGGER IF NOT EXISTS trg_lot_qty_init_upd BEFORE UPDATE OF qty_init ON mat_lot
WHEN OLD.qty_init IS NOT NULL AND NEW.qty_init IS NOT OLD.qty_init
BEGIN SELECT RAISE(ABORT, 'D-17: qty_init(생성 수량)은 바꿀 수 없다 — 수량 변동은 qty 와 계보로'); END;

-- ── E-13 [R-11] 삭제 대신 상태 전환 ────────────────────────────────────────
CREATE TRIGGER IF NOT EXISTS trg_item_no_delete BEFORE DELETE ON item
BEGIN SELECT RAISE(ABORT, 'R-11: item 은 삭제하지 않는다 — status=OBSOLETE 로 전환'); END;
CREATE TRIGGER IF NOT EXISTS trg_bom_header_no_delete BEFORE DELETE ON bom_header
BEGIN SELECT RAISE(ABORT, 'R-11: bom_header 는 삭제하지 않는다 — status=OBSOLETE 로 전환'); END;
-- 라인은 헤더가 DRAFT 인 동안만 지울 수 있다. 승인 후에는 valid_to 로 끊는다 (§7.3 "BOM 을 덮어쓰지 않는다")
CREATE TRIGGER IF NOT EXISTS trg_bom_line_no_delete BEFORE DELETE ON bom_line
WHEN (SELECT status FROM bom_header WHERE bom_id = OLD.bom_id) <> 'DRAFT'
BEGIN SELECT RAISE(ABORT, 'R-11: 승인된 BOM 의 라인은 삭제하지 않는다 — valid_to 를 끊어라'); END;


-- ============================================================================
-- F. 뷰 — 기준 계산은 여기 한 곳에 (D-21 / R-18)
-- ============================================================================
-- 뷰는 매개변수를 못 받으므로 as-of = date('now') 고정. 임의 시점 조회는 절 I 의 Q-1/Q-3 (동일 규칙, :asof 바인딩).

-- ── F-1 단위 → 차원 기준단위 환산계수 (전역 환산만) ─────────────────────────
CREATE VIEW IF NOT EXISTS v_uom_base AS
SELECT u.uom_code, COALESCE(u.symbol, u.uom_code) AS symbol, u.dim, b.uom_code AS base_uom,
       CASE WHEN u.is_base = 1 THEN 1.0
            ELSE COALESCE(
              (SELECT c.factor FROM uom_conv c WHERE c.from_uom = u.uom_code AND c.to_uom = b.uom_code AND c.item_id IS NULL),
              1.0 / (SELECT c.factor FROM uom_conv c WHERE c.from_uom = b.uom_code AND c.to_uom = u.uom_code AND c.item_id IS NULL))
       END AS to_base                                  -- NULL = 환산 없음 (합계에서 별도 표시)
  FROM uom u JOIN uom b ON b.dim = u.dim AND b.is_base = 1;

-- ── F-2 오늘 기준 유효 라인 + 부모 1개당 소요 (규칙 ①②④⑤) ───────────────
--   ① qty_per_parent       = qty_per / base_qty                         (NET 기준)
--   ② qty_per_parent_gross = ① / (1 - scrap_pct/100)   [qty_basis='GROSS' 면 qty_per/base_qty 가 이미 gross]
--   ④ 대상 = bom_header.status IN (APPROVED, ACTIVE) AND as-of BETWEEN valid_from AND valid_to (헤더·라인 모두)
--   ⑤ 대체품: 같은 (bom_id, alt_group) 안에서 유효한 최소 alt_priority 만 is_primary=1
CREATE VIEW IF NOT EXISTS v_bom_line_eff AS
SELECT h.bom_id, h.parent_item_id, h.base_qty, h.rev,
       l.line_id, l.line_no, l.child_item_id, l.qty_per, l.uom_code, l.qty_basis, l.scrap_pct,
       l.alt_group, l.alt_priority, l.is_optional, l.bop_link,
       CASE WHEN l.alt_group IS NULL
              OR l.alt_priority = (SELECT MIN(l2.alt_priority) FROM bom_line l2
                                    WHERE l2.bom_id = l.bom_id AND l2.alt_group = l.alt_group
                                      AND date('now') BETWEEN l2.valid_from AND l2.valid_to)
            THEN 1 ELSE 0 END AS is_primary,
       -- 순/실소요 계수. 곱셈을 먼저, base_qty 나눗셈을 마지막에 해야 0.85/80×80 = 0.85 가 정확히 나온다 (V-4)
       CASE WHEN l.qty_basis = 'GROSS' THEN (1.0 - l.scrap_pct / 100.0) ELSE 1.0 END                 AS net_factor,
       CASE WHEN l.qty_basis = 'GROSS' THEN 1.0 ELSE 1.0 / (1.0 - l.scrap_pct / 100.0) END           AS gross_factor,
       l.qty_per * (CASE WHEN l.qty_basis = 'GROSS' THEN (1.0 - l.scrap_pct / 100.0) ELSE 1.0 END) / h.base_qty
                                                                              AS qty_per_parent,        -- 표시용 (부모 1개당 순소요)
       l.qty_per * (CASE WHEN l.qty_basis = 'GROSS' THEN 1.0 ELSE 1.0 / (1.0 - l.scrap_pct / 100.0) END) / h.base_qty
                                                                              AS qty_per_parent_gross   -- 표시용 (부모 1개당 실소요)
  FROM bom_header h
  JOIN bom_line   l ON l.bom_id = h.bom_id
 WHERE h.status IN ('APPROVED','ACTIVE')
   AND date('now') BETWEEN h.valid_from AND h.valid_to
   AND date('now') BETWEEN l.valid_from AND l.valid_to;

-- ── F-3 완성품(FG) 1대당 라인 소요량 — 공정별 소요량·호환 뷰의 근거 (규칙 ③ 팬텀은 건너뛰되 경로 유지) ──
--   qty_per_product(line) = Σ(경로) Π(상위 라인 qty_per_parent) × 이 라인 qty_per_parent
--   같은 품목이 여러 경로에 있으면 부모 노드 수량을 합산한 뒤 곱한다 (다부모 공용 부품 대응)
--   팬텀은 곱셈에 그대로 참여한다(qty_per 1) — 팬텀을 '건너뛴다' 는 뜻은 재고·IN·OUT 이 없다는 뜻이지 수량 경로에서 빠진다는 뜻이 아니다
CREATE VIEW IF NOT EXISTS v_bom_line_qpp AS
WITH RECURSIVE
  ex(root_item_id, item_id, depth, qpp_net, qpp_gross) AS (
    SELECT i.item_id, i.item_id, 0, 1.0, 1.0
      FROM item i WHERE i.item_type = 'FG' AND i.status <> 'OBSOLETE'
    UNION ALL
    SELECT ex.root_item_id, e.child_item_id, ex.depth + 1,
           ex.qpp_net   * e.qty_per * e.net_factor   / e.base_qty,
           ex.qpp_gross * e.qty_per * e.gross_factor / e.base_qty
      FROM ex JOIN v_bom_line_eff e ON e.parent_item_id = ex.item_id AND e.is_primary = 1
     WHERE ex.depth < 64
  ),
  node AS (
    SELECT root_item_id, item_id, MIN(depth) AS depth, SUM(qpp_net) AS qpp_net, SUM(qpp_gross) AS qpp_gross
      FROM ex GROUP BY root_item_id, item_id
  )
SELECT n.root_item_id, r.pn AS root_pn,
       e.line_id, e.bom_id, e.line_no, e.rev,
       e.parent_item_id, p.pn AS parent_pn, p.name AS parent_name, p.is_phantom AS parent_is_phantom,
       e.child_item_id,  c.pn AS child_pn,  c.name AS child_name, c.spec AS child_spec, c.image AS child_image,
       c.is_phantom AS child_is_phantom, c.item_type AS child_type, c.trace_mode AS child_trace_mode,
       n.depth + 1                                    AS depth,              -- 자식의 깊이 (FG = 0)
       e.qty_per_parent,
       n.qpp_net   * e.qty_per * e.net_factor   / e.base_qty   AS qty_per_product,    -- 완성품 1대당 순소요 (= 현행 parts.qty_per_product 의 의미)
       n.qpp_gross * e.qty_per * e.gross_factor / e.base_qty   AS qty_per_product_gross,
       e.uom_code, COALESCE(u.symbol, u.uom_code) AS uom_symbol,
       e.is_primary, e.alt_group, e.alt_priority, e.is_optional, e.bop_link
  FROM node n
  JOIN v_bom_line_eff e ON e.parent_item_id = n.item_id
  JOIN item r ON r.item_id = n.root_item_id
  JOIN item p ON p.item_id = e.parent_item_id
  JOIN item c ON c.item_id = e.child_item_id
  JOIN uom  u ON u.uom_code = e.uom_code;

-- ── F-4 라인별 BOP 연결 상태 (D-8: 팬텀 / 미배정 / 연결 / 의도적 미연결 을 DB 가 구분) ──
CREATE VIEW IF NOT EXISTS v_bom_line_bop AS
SELECT q.root_pn, q.line_id, q.parent_pn, q.child_pn, q.depth, q.qty_per_product, q.uom_code,
       q.bop_link,
       CASE q.bop_link
         WHEN 'PHANTOM' THEN 'PHANTOM'
         WHEN 'NONE'    THEN 'NONE'
         ELSE CASE WHEN EXISTS (SELECT 1 FROM process_material pm WHERE pm.line_id = q.line_id AND pm.io = 'IN')
                   THEN 'ASSIGNED' ELSE 'UNASSIGNED' END
       END AS bop_status,
       (SELECT group_concat(p.op, ',') FROM process_material pm JOIN processes p ON p.id = pm.process_id
         WHERE pm.line_id = q.line_id AND pm.io = 'IN') AS ops,
       (SELECT COALESCE(SUM(pm.split_pct), 0) FROM process_material pm WHERE pm.line_id = q.line_id AND pm.io = 'IN') AS split_sum
  FROM v_bom_line_qpp q
 WHERE q.is_primary = 1;

-- ── F-5 공정별 소요량 (D-21) — 공정 × 자식 품목 × 완성품 1대당 소요 ─────────
--   qty(process, line) = qty_per_product(line) × split_pct / 100
CREATE VIEW IF NOT EXISTS v_process_requirement AS
SELECT pm.process_id, p.op, p.seq, p.line AS proc_line,
       q.root_pn, q.line_id, q.parent_pn, q.child_item_id, q.child_pn, q.child_name,
       q.qty_per_product       * pm.split_pct / 100.0 AS qty_per_product,
       q.qty_per_product_gross * pm.split_pct / 100.0 AS qty_per_product_gross,
       q.uom_code, q.uom_symbol, pm.split_pct, pm.issue_method, q.child_trace_mode, pm.pm_id
  FROM process_material pm
  JOIN processes p ON p.id = pm.process_id
  JOIN v_bom_line_qpp q ON q.line_id = pm.line_id AND q.root_pn = p.product_code AND q.is_primary = 1
 WHERE pm.io = 'IN';

-- ── F-6 호환 뷰 ① process_inputs (인터페이스 §7 · server/db.js queries.processInputs 가 그대로 읽는다) ──
--   [D-10] qty = 완성품 1대당 순소요 (전개 계산값) — 현행 process_inputs.qty 와 같은 의미. qty_per 가 아니다.
--   rowid 컬럼: 현행 쿼리가 ORDER BY i.rowid 를 쓴다. 뷰에는 rowid 가 없으므로 pm_id 를 그 이름으로 내보낸다
--   (SQLite 는 뷰의 'rowid' 이름 컬럼을 i.rowid 로 해석한다 — python 3.50.4 · node 3.53.0 확인).
--   → 적재기는 IN 행을 BOP 투입 표기 순서대로 INSERT 해야 상태창의 단품 순서가 지금과 같다.
--   계약: item.pn(FG) = products.code = processes.product_code (파일럿 단일 제품과 같은 전제, processByOp 참조)
CREATE VIEW IF NOT EXISTS v_process_inputs_compat AS
SELECT pm.process_id AS process_id,
       q.child_pn    AS pn,
       q.qty_per_product * pm.split_pct / 100.0 AS qty,
       pm.pm_id      AS rowid
  FROM process_material pm
  JOIN processes p ON p.id = pm.process_id
  JOIN v_bom_line_qpp q ON q.line_id = pm.line_id AND q.root_pn = p.product_code AND q.is_primary = 1
 WHERE pm.io = 'IN';

-- ── F-7 호환 뷰 ② parts (queries.processInputs 가 LEFT JOIN parts p ON p.pn = i.pn 으로 이름·규격·단위·부모·이미지를 읽는다) ──
--   컬럼·의미는 현행 parts 와 동일. level = 'L' || 깊이 (현행은 유형과 깊이를 섞었다 — 값만 바뀐다: SC-1011 L3→L4)
--   unit = uom.symbol ('매' 그대로), parent_pn = 이 품목이 달린 라인의 부모 (다부모 품목은 최소 line_id 1건만 — 표시 축의 한계, 새 API 는 v_bom_line_qpp 를 쓴다)
--   완성품(FG) 행은 없다 (현행 parts 에도 없다). 팬텀은 있다 (현행 L1 과 같이).
CREATE VIEW IF NOT EXISTS v_parts_compat AS
SELECT q.child_pn        AS pn,
       q.child_name      AS name,
       q.child_spec      AS spec,
       'L' || q.depth    AS level,
       q.parent_pn       AS parent_pn,
       q.parent_name     AS parent_name,
       q.qty_per_parent  AS qty_per_parent,
       q.qty_per_product AS qty_per_product,
       q.uom_symbol      AS unit,
       q.child_image     AS image
  FROM v_bom_line_qpp q
 WHERE q.is_primary = 1
   AND q.line_id = (SELECT MIN(q2.line_id) FROM v_bom_line_qpp q2
                     WHERE q2.child_item_id = q.child_item_id AND q2.is_primary = 1);


-- ============================================================================
-- G. 점검 뷰 — 콘솔 "자재 무결성" 카드는 v_chk_summary 하나를 읽는다 (0건이면 초록)
-- ============================================================================

-- [R-1] 이미 들어 있는 순환의 경로 (트리거가 켜진 뒤에는 0건이어야 한다. RAISE 가 경로를 못 주므로 여기서 본다 — R-19 대안)
CREATE VIEW IF NOT EXISTS v_chk_r1_cycle AS
WITH RECURSIVE walk(start_id, item_id, depth, path) AS (
  SELECT h.parent_item_id, h.parent_item_id, 0, i.pn
    FROM bom_header h JOIN item i ON i.item_id = h.parent_item_id WHERE h.status <> 'OBSOLETE'
  UNION ALL
  SELECT w.start_id, l.child_item_id, w.depth + 1, w.path || ' > ' || c.pn
    FROM walk w
    JOIN bom_header h ON h.parent_item_id = w.item_id AND h.status <> 'OBSOLETE'
    JOIN bom_line   l ON l.bom_id = h.bom_id
    JOIN item       c ON c.item_id = l.child_item_id
   WHERE w.depth < 64 AND (w.depth = 0 OR w.item_id <> w.start_id)
)
SELECT 'R-1' AS rule, path AS detail FROM walk WHERE depth > 0 AND item_id = start_id;

-- [R-2] 최대 레벨 10 초과 (순환 트리거에서 분리)
CREATE VIEW IF NOT EXISTS v_chk_r2_depth AS
SELECT 'R-2' AS rule, root_pn || ' > … > ' || child_pn || ' (depth ' || depth || ')' AS detail
  FROM v_bom_line_qpp WHERE depth > 10;

-- [R-4] 고아 품목 — 완성품이 아닌데 어느 BOM 의 자식도 아니다
CREATE VIEW IF NOT EXISTS v_chk_r4_orphan AS
SELECT 'R-4' AS rule, i.pn || ' ' || i.name || ' (' || i.item_type || ')' AS detail
  FROM item i
 WHERE i.status IN ('APPROVED','ACTIVE') AND i.item_type <> 'FG'
   AND NOT EXISTS (SELECT 1 FROM bom_line l WHERE l.child_item_id = i.item_id);

-- [R-5] 미아 조립품 — SA/FG 인데 BOM 라인이 하나도 없다 (FS-7010 이 여기 걸려 단품으로 재분류됐다)
CREATE VIEW IF NOT EXISTS v_chk_r5_lost_sa AS
SELECT 'R-5' AS rule, i.pn || ' ' || i.name AS detail
  FROM item i
 WHERE i.item_type IN ('SA','FG') AND i.status <> 'OBSOLETE'
   AND NOT EXISTS (SELECT 1 FROM bom_header h JOIN bom_line l ON l.bom_id = h.bom_id
                    WHERE h.parent_item_id = i.item_id AND h.status <> 'OBSOLETE');

-- [R-10 / D-8] REQUIRED 라인인데 투입 비율 합이 100 이 아니다 (0 = 미배정)
CREATE VIEW IF NOT EXISTS v_chk_r10_split AS
SELECT 'R-10' AS rule, parent_pn || ' > ' || child_pn || ' split=' || split_sum || ' (' || bop_status || ')' AS detail
  FROM v_bom_line_bop WHERE bop_link = 'REQUIRED' AND split_sum <> 100;

-- [D-8] 미배정 라인 목록 (BOP 누락 후보 — 쟁점 3·6)
CREATE VIEW IF NOT EXISTS v_chk_bop_unassigned AS
SELECT 'D-8' AS rule, parent_pn || ' > ' || child_pn AS detail
  FROM v_bom_line_bop WHERE bop_status = 'UNASSIGNED';

-- [R-12] 팬텀인데 자식이 없다 (전개가 멈춘다)
CREATE VIEW IF NOT EXISTS v_chk_r12_phantom_empty AS
SELECT 'R-12' AS rule, i.pn AS detail
  FROM item i
 WHERE i.is_phantom = 1
   AND NOT EXISTS (SELECT 1 FROM bom_header h JOIN bom_line l ON l.bom_id = h.bom_id
                    WHERE h.parent_item_id = i.item_id AND h.status <> 'OBSOLETE');

-- [R-22] 자식 투입 공정이 부모 산출 공정보다 늦다 (트리거가 막지만 적재 순서에 따라 남을 수 있어 재점검) + 라인이 달라 비교 못 한 쌍
CREATE VIEW IF NOT EXISTS v_chk_r22_seq AS
SELECT 'R-22' AS rule,
       ip.pn || ' OUT@' || pp.op || '(seq ' || pp.seq || ') < ' || ic.pn || ' IN@' || pc.op || '(seq ' || pc.seq || ')'
       || CASE WHEN pc.line <> pp.line THEN ' [라인 다름 — 수동 확인]' ELSE '' END AS detail
  FROM bom_line l
  JOIN bom_header h ON h.bom_id = l.bom_id
  JOIN item ip ON ip.item_id = h.parent_item_id
  JOIN item ic ON ic.item_id = l.child_item_id
  JOIN process_material po ON po.item_id = ip.item_id AND po.io = 'OUT' AND po.is_final = 1
  JOIN processes pp ON pp.id = po.process_id
  JOIN process_material pi ON pi.line_id = l.line_id AND pi.io = 'IN'
  JOIN processes pc ON pc.id = pi.process_id
 WHERE (pc.line = pp.line AND pc.seq > pp.seq) OR pc.line <> pp.line;

-- [§8.3-2] 하위가 SERIAL 인데 상위가 NONE (개체를 넣었는데 어디 들어갔는지 모른다)
CREATE VIEW IF NOT EXISTS v_chk_trace_serial AS
SELECT 'TR-2' AS rule, p.pn || '(NONE) > ' || c.pn || '(SERIAL)' AS detail
  FROM bom_line l JOIN bom_header h ON h.bom_id = l.bom_id
  JOIN item p ON p.item_id = h.parent_item_id JOIN item c ON c.item_id = l.child_item_id
 WHERE c.trace_mode = 'SERIAL' AND p.trace_mode = 'NONE' AND p.is_phantom = 0;

-- [D-18] BULK 출고인데 로트 추적 품목 (BULK 은 계보 행을 만들 근거가 없다 → NONE 이어야)
CREATE VIEW IF NOT EXISTS v_chk_bulk_trace AS
SELECT 'D-18' AS rule, c.pn || ' issue=BULK trace=' || c.trace_mode AS detail
  FROM process_material pm JOIN bom_line l ON l.line_id = pm.line_id JOIN item c ON c.item_id = l.child_item_id
 WHERE pm.io = 'IN' AND pm.issue_method = 'BULK' AND c.trace_mode <> 'NONE';

-- [D-17] 로트 수량 보존: qty_init = qty + Σ직계 서브로트 qty_init + Σ투입(qty_consumed)  (같은 단위 전제)
CREATE VIEW IF NOT EXISTS v_chk_lot_qty AS
SELECT 'D-17' AS rule,
       m.lot_no || ' init=' || m.qty_init || ' now=' || m.qty || ' split=' || s.q || ' consumed=' || g.q AS detail
  FROM mat_lot m
  JOIN (SELECT p.lot_id, COALESCE(SUM(c.qty_init), 0) AS q FROM mat_lot p LEFT JOIN mat_lot c ON c.parent_lot_id = p.lot_id GROUP BY p.lot_id) s ON s.lot_id = m.lot_id
  JOIN (SELECT p.lot_id, COALESCE(SUM(x.qty_consumed), 0) AS q FROM mat_lot p LEFT JOIN lot_genealogy x ON x.in_lot_id = p.lot_id GROUP BY p.lot_id) g ON g.lot_id = m.lot_id
 WHERE m.qty_init IS NOT NULL AND ABS(m.qty_init - (m.qty + s.q + g.q)) > 0.000001;

-- 요약 — 규칙별 건수
CREATE VIEW IF NOT EXISTS v_chk_summary AS
SELECT rule, COUNT(*) AS cnt FROM (
  SELECT rule FROM v_chk_r1_cycle          UNION ALL
  SELECT rule FROM v_chk_r2_depth          UNION ALL
  SELECT rule FROM v_chk_r4_orphan         UNION ALL
  SELECT rule FROM v_chk_r5_lost_sa        UNION ALL
  SELECT rule FROM v_chk_r10_split         UNION ALL
  SELECT rule FROM v_chk_bop_unassigned    UNION ALL
  SELECT rule FROM v_chk_r12_phantom_empty UNION ALL
  SELECT rule FROM v_chk_r22_seq           UNION ALL
  SELECT rule FROM v_chk_trace_serial      UNION ALL
  SELECT rule FROM v_chk_bulk_trace        UNION ALL
  SELECT rule FROM v_chk_lot_qty
) GROUP BY rule;


-- ============================================================================
-- H. 이행 [3] 전환 블록 — **주석**. 최민준이 [2] 대조(품목별 대조표 R-21) 를 통과한 뒤 한 트랜잭션으로 실행한다
-- ============================================================================
-- BEGIN;
--   ALTER TABLE process_inputs RENAME TO process_inputs_legacy;
--   ALTER TABLE parts          RENAME TO parts_legacy;
--   CREATE VIEW process_inputs AS SELECT * FROM v_process_inputs_compat;   -- rowid 컬럼 포함
--   CREATE VIEW parts          AS SELECT * FROM v_parts_compat;
-- COMMIT;
-- 되돌리기: DROP VIEW process_inputs; DROP VIEW parts; ALTER TABLE ..._legacy RENAME TO ...;
-- 주의: 뷰로 바뀐 뒤 queries.upsertPart / addProcessInput / deleteProcessInputs (server/db.js) 는 실패한다 —
--       import 경로(POST /api/admin/bop/import, apply-sample) 는 item/bom_*/process_material 적재기로 교체해야 한다.


-- ============================================================================
-- I. 매개변수 쿼리 참조 — **주석**. 계획서 §5.9 Q-1 · Q-3 · Q-5 와 동일. :asof, :root, :pn, :lot 바인딩
-- ============================================================================
-- Q-1 정전개 (as-of, 팬텀 경로 유지, 대체품 주자재만, GROSS/NET 규칙 동일)
-- WITH RECURSIVE eff AS (
--   SELECT h.parent_item_id, h.base_qty, l.line_id, l.child_item_id, l.uom_code, l.bop_link, l.qty_per,
--          CASE WHEN l.qty_basis='GROSS' THEN (1.0-l.scrap_pct/100.0) ELSE 1.0 END AS nf,          -- 순소요 계수
--          CASE WHEN l.qty_basis='GROSS' THEN 1.0 ELSE 1.0/(1.0-l.scrap_pct/100.0) END AS gf       -- 실소요 계수
--     FROM bom_header h JOIN bom_line l ON l.bom_id=h.bom_id
--    WHERE h.status IN ('APPROVED','ACTIVE') AND :asof BETWEEN h.valid_from AND h.valid_to
--      AND :asof BETWEEN l.valid_from AND l.valid_to
--      AND (l.alt_group IS NULL OR l.alt_priority = (SELECT MIN(alt_priority) FROM bom_line l2
--            WHERE l2.bom_id=l.bom_id AND l2.alt_group=l.alt_group AND :asof BETWEEN l2.valid_from AND l2.valid_to))),
-- ex(item_id, pn, depth, qty, qty_gross, uom, path, is_phantom, line_id) AS (
--   SELECT i.item_id, i.pn, 0, CAST(:qty AS REAL), CAST(:qty AS REAL), i.base_uom, i.pn, i.is_phantom, NULL
--     FROM item i WHERE i.pn = :root
--   UNION ALL
--   SELECT c.item_id, c.pn, ex.depth+1, ex.qty*e.qty_per*e.nf/e.base_qty, ex.qty_gross*e.qty_per*e.gf/e.base_qty, e.uom_code,   -- 곱셈 먼저, 나눗셈 마지막
--          ex.path || ' > ' || c.pn, c.is_phantom, e.line_id
--     FROM ex JOIN eff e ON e.parent_item_id = ex.item_id JOIN item c ON c.item_id = e.child_item_id
--    WHERE ex.depth < 64)
-- SELECT * FROM ex WHERE depth > 0;
--
-- Q-2 말단 합계 (차원 기준단위로 환산, 품목별) — Q-1 결과 ex 에 이어서
-- SELECT ex.pn, b.dim, b.base_uom, SUM(ex.qty * b.to_base) AS qty_base
--   FROM ex JOIN v_uom_base b ON b.uom_code = ex.uom
--  WHERE ex.depth > 0 AND ex.is_phantom = 0
--    AND NOT EXISTS (SELECT 1 FROM eff e WHERE e.parent_item_id = ex.item_id)     -- 말단 = 유효 BOM 이 없는 품목
--  GROUP BY ex.pn, b.dim, b.base_uom;
--
-- Q-3 역전개 (where-used) — 경로마다 누적 소요
-- WITH RECURSIVE up(item_id, pn, qty, depth, path) AS (
--   SELECT i.item_id, i.pn, 1.0, 0, i.pn FROM item i WHERE i.pn = :pn
--   UNION ALL
--   SELECT p.item_id, p.pn, up.qty * l.qty_per / h.base_qty, up.depth+1, p.pn || ' > ' || up.path
--     FROM up JOIN bom_line l ON l.child_item_id = up.item_id AND :asof BETWEEN l.valid_from AND l.valid_to
--     JOIN bom_header h ON h.bom_id = l.bom_id AND h.status IN ('APPROVED','ACTIVE') AND :asof BETWEEN h.valid_from AND h.valid_to
--     JOIN item p ON p.item_id = h.parent_item_id
--    WHERE up.depth < 64)
-- SELECT * FROM up WHERE depth > 0;
--
-- Q-5 로트 추적 — 간선 2종을 먼저 합친다 (정방향 fwd / 역방향 back)
-- WITH RECURSIVE lot_edge(parent, child, kind) AS (
--   SELECT parent_lot_id, lot_id, 'SPLIT' FROM mat_lot WHERE parent_lot_id IS NOT NULL
--   UNION ALL SELECT in_lot_id, out_lot_id, 'CONSUME' FROM lot_genealogy),
-- fwd(lot_id, depth, path) AS (
--   SELECT lot_id, 0, lot_no FROM mat_lot WHERE lot_no = :lot
--   UNION SELECT e.child, fwd.depth+1, fwd.path || ' > ' || m.lot_no
--     FROM fwd JOIN lot_edge e ON e.parent = fwd.lot_id JOIN mat_lot m ON m.lot_id = e.child WHERE fwd.depth < 64)
-- SELECT f.depth, m.lot_no, i.pn, m.lot_kind, f.path FROM fwd f JOIN mat_lot m ON m.lot_id = f.lot_id JOIN item i ON i.item_id = m.item_id ORDER BY f.depth;
-- (역방향은 e.child = back.lot_id 로 조인 방향만 바꾼다)
-- ============================================================================
-- 끝. 이 파일의 문 수·실행 결과는 docs/team/handoff-윤태경.md 에 기록한다.
-- ============================================================================
