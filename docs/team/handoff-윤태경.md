# 핸드오프 — 윤태경 (자재 마스터·BOM 표준 설계)

## 2026-09-13 · 4M Material 라운드 3: v1.0 확정 + 실행 DDL + 적재 규칙

### 한 일

| 파일 | 내용 |
|---|---|
| `docs/4m/자재관리-기준-계획서.md` | **v1.0 확정**. §0 요지, §5 요약(정본은 DDL), §5.9 기준 쿼리 신설, §6 규칙 전부 DDL 위치 명시, §13 노하린 결함·V-12 답변표, §14 변경 이력 |
| `docs/4m/ddl-v1.sql` | **실행 가능한 DDL** — 테이블 12 · 인덱스 20 · 트리거 34 · 뷰 19 = **85문**. 전부 `IF NOT EXISTS`(멱등). PRAGMA·INSERT·DROP 없음. 절 H 에 이행 [3] 전환 블록(주석), 절 I 에 매개변수 쿼리(주석) |
| `docs/4m/cleansing-v1.json` | **적재 규칙** — uom 5 · uom_conv 1 · mat_class 24 · 품목 60 속성 · 정제 규칙(P-1 분리 10행, P-2 자기참조 2건, P-3 재배치+fallback) · 신규 3건 + `TMP-` 임시 품번 · 라인 59 의 공정·확신도·출고방식 · OUT 24 · expected(건수·합계) · R-21 품목별 대조표 · PM 판단 항목 |
| `docs/team/handoff-윤태경.md` | 이 파일 |

**건드리지 않은 것**: `server/*`, 운영 DB(열지 않았다), 노하린 프로토타입(`docs/4m/prototype/**` — 스크립트·로그 한 글자도 안 고쳤다), 인터페이스 문서, 다른 사람 문서. 커밋 안 했다. 협업로그는 append 만.

### 실행 확인 결과 (내가 직접 돌린 것)

| 런타임 | 방법 | 결과 |
|---|---|---|
| **python 3.14.5 · sqlite3 3.50.4** | 노하린 `r2_ddl.py` 와 같은 방식(`sqlite3.complete_statement` 문 분리, 주석만인 문 제외)으로 `ddl-v1.sql` 실행 — [a] 단독 / [b] `prereq_existing.sql` 선행 / [c] 같은 DB 2회째 | **85문 · 성공 85 · 실패 0** (세 경우 전부). 객체: table 21(선행 9 + 신규 12) · index 20 · trigger 34 · view 19 |
| **node:sqlite (Node v24.16.0 · SQLite 3.53.0)** — 운영 런타임 | `DatabaseSync.exec()` 단독 / 선행 / 2회째 | **전부 OK**. `PRAGMA foreign_keys` 기본 1 확인 |
| 적재 검산 | `cleansing-v1.json` 대로 BLDC 적재(참조 적재기, 정식 P/N 1회 + `TMP-` P/N 1회) | item 60 · header 11 · line 59 · IN 46 · OUT 24(final 7) · 팬텀 3 · 미배정 10 · `v_chk_summary` {D-8:10, R-10:10} — `expected` 전부 일치. Q-2 말단 EA 76 · g 221 · SHT 12 · kg 0.85(오차 0) · m 0.5 · 49품목 · MASS 1.071 kg |
| 호환 뷰 | `process_inputs`·`parts` 를 뷰로 바꾼 뒤 `server/db.js` 의 `processInputs`(`ORDER BY i.rowid`)·`listProcesses`·`countParts` 쿼리를 **문자 그대로** 실행 (python + node) | 정상. 24공정 46행 11 ms. TC-57b: `GB-8000` 2개 → `GB-8010` **2.0**, `GB-8040` 4.0 |
| 반례 | 노하린 §5.6 "뚫린다 16건" + 신규 | **72 항목 72 OK** — 16건 전부 거부, 거짓양성 0, 정상 조작(라인 이동·DRAFT rev·대체품·품목 한정 환산) 허용 |

재현: 검산 스크립트는 세션 스크래치(`run_ddl_v1.py`, `run_ddl_v1.mjs`, `load_v1.py`)에 있고 프로젝트에 넣지 않았다 — 노하린이 라운드 4 에서 자기 하네스로 다시 돌리는 것이 맞다. 적재 알고리즘은 `cleansing-v1.json` `loader_algorithm` 7단계에 적었다.

### 노하린 결함 D-1~D-21 — 반영 / 보류 (요약, 상세 계획서 §13)

| 답 | 건 |
|---|---|
| **반영 (20)** | D-1 D-3 D-4 D-5 D-6 D-7 D-8 D-9 D-10 D-11 D-12 D-13 D-14 D-15 D-16 D-17(규칙+감사 뷰, 차감은 서비스 계층) D-18 D-19 D-20 D-21 |
| 해소 확인 (1) | D-2 |
| R-18~R-24 | R-18 R-20 R-21 R-22 R-23(`proc_batch` 로) R-24 **반영** · **R-19 보류** — `RAISE()` 는 리터럴만, 경로는 `v_chk_r1_cycle` |
| V-12 8건 | **전부 반영** — 추정 표기 · P-3a/b 분리 · §4.3 (a) 삭제 · 0.010625 삭제→`qty_basis` · 기준 (c) '합침' 제거+배치 테이블 · P-10 "원천과 상충" · PE-6000 세 절 동시 수정 · CN-4030 부모 유지(팬텀 확정으로 모순 소멸) |

**설계 판단 중 라운드 1 과 달라진 것**: `PE-6000` 실물 권장 → **팬텀 확정**(근거 3: 원천 산출 문구 "제어부 결합" ≠ 완성 · CN-4030 B90 뒤 투입 · 단독 검사 없음). `uom_conv` SHT→kg → 삭제. SET 단위 → 미등록. LOT 35 → 34.

### 다른 사람이 해 줄 일

**최민준 (4라운드 — `server/db.js` 반영·적재기·뷰 전환). 지켜야 할 계약 5줄:**

1. **`ddl-v1.sql` 을 그대로** `db.js` 초기화에 넣는다(`exec` 한 번, 멱등). 스키마를 고쳐야 하면 파일을 고치지 말고 나에게 — 계획서 §5 와 파일이 함께 바뀌어야 한다. 선행 테이블(users·equipments·processes·production_records) 뒤에 실행.
2. **호환 뷰 계약**: 이행 [3] 은 DDL 절 H 블록 그대로 — `process_inputs`·`parts` 를 `*_legacy` 로 rename 하고 `v_process_inputs_compat`·`v_parts_compat` 위에 같은 이름의 뷰. `qty` = 완성품 1대당 순소요(전개값), `rowid` 컬럼이 있어 `ORDER BY i.rowid` 가 산다, `unit` 은 `uom.symbol`('매'). `equipment:detail.process.inputs[]` 키·의미 불변. **뷰 전환 후 `upsertPart`·`addProcessInput`·`deleteProcessInputs` 와 `POST /api/admin/bop/import`·`apply-sample` 은 실패한다** → 같은 PR 에서 새 적재기로 교체.
3. **적재기는 `cleansing-v1.json` 만 읽고 판단한다**(순서 `load_order`, 알고리즘 `loader_algorithm`). 이름·규격·수량은 원천 JSON. `bop_link` 는 넣지 않는다(트리거가 팬텀 자식을 PHANTOM 으로). **OUT 24행 먼저, IN 46행은 `line_process.rows` 순서대로**(pm_id 가 상태창 정렬 키). `pn_pending.approved=false` 면 `tmp` 로 INSERT. `item.pn(FG) = products.code = processes.product_code` 등식이 뷰의 루트 조건이다.
4. **적재 후 `expected` 와 `v_chk_summary` 를 대조하고 어긋나면 커밋하지 않는다.** 정상 상태는 `{D-8:10, R-10:10}` 뿐(쟁점 3·6 미배정). 품목별 대조표(R-21)는 `item_compare_R21`.
5. **삭제 금지가 DB 에 박혀 있다** — `item`·`bom_header` DELETE, 승인 BOM 의 `bom_line` DELETE, `qty_init` UPDATE 는 트리거가 거부한다. 재적재는 UPSERT 로(키는 `loader_algorithm` 7). 트리거 오류 메시지는 `R-1:` `R-9:` `D-8:` 접두로 시작하니 API 는 그대로 400 본문에 실어 보내면 콘솔이 쓴다.

**서지안 (자재 탭 `public/js/materials.js`)**: 데이터 소스는 전부 뷰·쿼리다 — BOM 트리 `v_bom_line_qpp`(오늘) / Q-1(as-of), where-used Q-3, 공정별 소요 `v_process_requirement`, 미배정 `v_bom_line_bop`, 무결성 `v_chk_summary` + `v_chk_*`, 순환 경로 `v_chk_r1_cycle`. `processes.ct_sec` 는 건드리지 않았다.

**한도윤**: 분해도 9단계·썸네일 경로 규칙 그대로. `TMP-` 품번 3건은 썸네일이 없어 빈 칸(승인 후 해소).

**노하린 (라운드 4 최종 검증)**: `ddl_v09_raw.sql` 자리에 `ddl-v1.sql` 을 놓고 돌릴 때 `r2_load.py`·`bomsql.py` 가 바뀌어야 하는 곳 — `uom` 에 `symbol` 컬럼(NULL 허용), `mat_lot.proc_state` → `state_pm_id`, `process_material` OUT 에 `is_final/out_state`, `uom_conv` 초기값 kg→g 1행, SET 미등록(EX-5000 EA), IN 46(IP-1040·LC-1080 미배정), OUT 24, PE-6000 OUT 없음. 전개 규칙은 §5.9 (곱셈 먼저·나눗셈 마지막, `qty_basis`, `is_primary`). 네 TC-57 은 `qty_per` 뷰를 직접 만들어 비교하므로 v1 의 `v_process_inputs_compat` 로 바꿔 돌려 달라. **서명 조건 5건(D-19·D-3·D-5·D-10·D-15)은 전부 DDL 에 있고 내가 실행해 봤다 — 네 하네스로 다시 깨뜨려 달라.**

### PM 판단이 남은 항목

| # | 항목 | 지금 상태 | 결정 시 할 일 |
|---|---|---|---|
| 1 | `FS-7023` 개번 (대안 `FS-7020B`) | `TMP-FS7023` 로 적재 | `cleansing-v1.json` `pn_pending` `approved: true` → 적재기 재실행(`pn` UPDATE 1건) |
| 2 | `SC-1010P` · `PK-0010` 신규 등록 | `TMP-` 로 적재 | 같음. 부결 시 P-3b fallback(SC-1011 을 SC-1010 직하) |
| 3 | 동력전달부 체결 공정 BOP 보완 + `FS-7021/7022/OR-7025` 부모 확인 | 미배정 8건 (점검 뷰에 뜸) | 생산기술이 공정을 정하면 `line_process` 의 `null` → op |
| 5 | `PE-6000` 팬텀 확정 — **이의 없으면 확정** | 팬텀으로 적재 | 실물로 바꾸려면 §4.4 "되돌리는 길" 3건 UPDATE + CN-4030 부모 이동 |
| 6 | `IP-1040` · `LC-1080` 투입 공정 (원천이 '투입 없음') | 미배정 2건 | 생산기술 답 → `line_process` |
| 7 | 추적 단위 `CP-4050` · `HK-4060` NONE | NONE 적재 | 품질담당 → `items` |
| 8 | 낱장 실중량·블랭킹 스크랩률 실측 | `qty_basis=GROSS`, scrap 0 | 생산기술 → `qty_per`/`scrap_pct`/`uom_conv` |

### 검증 방법 (내가 한 것)

- `ddl-v1.sql` 문 단위 실행: python(3.50.4)·node(3.53.0) 각 3경우(단독·선행·2회째)
- BLDC 적재 후 expected 대조, Q-1/Q-2/Q-5 실행, 서버 쿼리 문자 그대로 실행, 반례 72항목
- 원천 대조는 v0.9 §12 + v1.0 추가 5건(계획서 §12)
- **운영 DB 는 열지 않았다.**

---

## 2026-09-12 · 4M Material 라운드 1: 기준 계획서 v0.9 초안

### 한 일

`docs/4m/자재관리-기준-계획서.md` v0.9 초안 작성 (13개 절 + 부록).
PM 요구 3가지(① BOM·BOP에 넣을 수 있는 구조 ② 모자관계 필수 ③ 표준 참조 트리 설계)를 전부 다뤘다.

**설계 요지 — 트리 3축**

| 축 | 테이블 | 부모-자식의 뜻 |
|---|---|---|
| ① 품목 분류 | `mat_class` (자기참조) | 상위 분류 ⊃ 하위 분류. 6대 분류 → 말단 18개, 품목 60종 배정 (중복 0) |
| ② **제품 구조 BOM** | `bom_header` + `bom_line` | 부모 1개를 만들려면 자식 n개가 든다. **노드 60 · 간선 59 = 정확히 트리** |
| ③ 로트 계보 | `mat_lot` (자기참조) + `lot_genealogy` | 부모 로트가 분할·투입되어 자식 로트가 됐다. ISA-95 Lot/Sublot을 한 테이블로 |

**설계 판단 3가지**

1. `products` + `parts` 를 `item` 한 테이블로 합친다.
2. 소요량은 `bom_line.qty_per` 에만 둔다. `process_material` 은 "어느 공정에서 몇 %" 만 갖는다.
3. 팬텀 조립품 도입 (`HA-3000`·`EX-5000`·`PE-6000`).

### 실데이터에서 확인한 문제 (계획서 §9.2, P-1~P-14) — 처리 방안은 v1.0 §9.2 로 대체

### 검증 방법 (라운드 1)

- `python` + `openpyxl` 로 xlsx 12시트 전량 덤프, `json` 모듈로 JSON 집계
- 운영 DB 는 열지 않았다.
