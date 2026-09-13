# handoff — 노하린 (제조 데이터 검증)

> 스프린트 3 · 4M/Material · **라운드 4 (v1.0 재검증 + 실서버 인수 테스트 도구)** · 2026-09-13
> 판정과 수치의 원본은 [`docs/4m/검증보고서.md` **§6 · §7**](../4m/검증보고서.md). 이 파일은 **인수인계 요약**이다.
> (라운드 2 요약은 아래 「라운드 2」에, 라운드 1 은 그 아래에 접어 뒀다.)

---

## 라운드 6 (2026-09-13 15:40) — 쟁점 3 결의안 판정

> 원본: [`docs/4m/쟁점3-검증.md` **§7**](../4m/쟁점3-검증.md). 대상: 윤태경 `docs/4m/쟁점3-결의안.md`(488행).

**판정: 조건부 승인** — 차단 조건 3건(C-1·C-2·C-3) + 동반 조건 4건(C-4~C-7).

- 손으로 INSERT 하지 않고 **운영 적재기 자체**(`server/materials.js` `loadMaterials`)를 사본 DB 에 물려 돌렸다. 자동 판정 45건 중 **OK 44 · FAIL 1**.
- 결의안 예상표(IN 54 · OUT 26 · final 8 · D-8 2 · R-10 2 · parts 59 불변 · 깊이 4 · 총 C/T 530)는 **전부 일치**. `expected` 대조 불일치 0.
- 수용 기준 **A-1~A-21 전부 통과**(A-22 만 미흡 — 원천 xlsx 정정 요청이 결의안에 안 들어갔다). 멱등 2회차에서 `pm_id`·`item_id`·`line_id` 집합 완전 동일.
- 맵 16좌표 전수 확인: 겹침 0 · 존/맵 밖 0 · **숨김 11대 포함 겹침 0**(기존 `(11,13)` `CNC-01`↔`OP-B90` **해소**).
- **E-9 는 윤태경이 옳고 내가 틀렸다.** 적재기는 순수 UPSERT 라 `state_pm_id` 를 안 끊는다(로트 3건 물려 실증). 내 1라운드 서술을 §7.7 정정 1 로 철회했다.
- **E-2·E-3 은 닫히지 않았다.** `OP-B89` 를 seq 3 으로 밀면 위반 3건인데 `v_chk_summary` 는 초록(F-2). `process_out` 한 줄을 빠뜨려도 적재가 통과하고 `apply-sample` 이 `strict=false` 라 커밋된다(F-3). 보완 SQL 을 써서 실행 확인했다.
- **새 결함 F-1**: §4.6 의 `links` 변경은 배치 API 로 실현되지 않는다 — `importLayout` 에 링크 삭제가 없어 `OP-B87→OP-B90` 지름길이 남는다(DB 기준 27→29 여야 하는데 30이 된다).
- C/T 25/40초는 **값은 수용, 표기는 결함**. 병목은 이미 `OP-B90`·`OP-B110` **60초 동률**이고 B89 여유는 20초. 잠정값을 기계가 읽는 자리(`amendments.provisional`)에 남길 것을 요구했다.

산출물: `docs/4m/prototype/issue3/resolution-check.mjs` · `resolution-out.txt` · `patch-checks.sql` · `patch-seq-trigger.sql` · `sheet09-check.py` → `sheet09-out.txt`.
**이번 라운드에 `data/factory.db` 는 `mode=ro` 로도 열지 않았다.** 커밋하지 않았다.

---

## 이번 라운드에 한 일

윤태경의 "85문 OK · 반례 72항목 OK" 를 **믿지 않고 내 하네스로 다시 돌렸고**, 실서버 인수 테스트 도구를 만들어 스텁으로 끝까지 돌려 봤다.

| # | 한 일 | 위치 |
|---|---|---|
| 1 | `ddl-v1.sql` 원문 문 단위 실행 — **python sqlite3 3.50.4 · node:sqlite 3.53.0 양쪽**, 단독/선행/2회째, 객체 수 | `docs/4m/prototype/v1/v1_ddl.py` · `v1_ddl_node.mjs` → `out/01_*.log` `out/02_*.log` |
| 2 | 반례 배터리 **133건을 데이터(`cases.json`)로** 만들어 두 런타임이 같은 것을 실행 · 결과 대조 | `v1_cases.py` · `v1_cases_run.py` · `v1_cases_run.mjs` → `out/03_*.log` `out/04_*.log` |
| 3 | `cleansing-v1.json` 7단계 그대로 참조 적재기(UPSERT 멱등·승인 전환·이행 [3] 뷰 전환) + `expected` 24항목 대조 | `v1_load.py` → `out/05_load.log` · `out/bldc_v1.db` |
| 4 | TC-01~59 + 파생 **104건**을 DDL 절 I Q-1~Q-5 **원문**으로 | `bomsql_v1.py` · `v1_tests.py` → `out/06_tests.log` · `out/csv/tc_result_v1.csv` |
| 5 | **실서버 인수 테스트 도구** (fetch 만, 84건) + 호환 계약 DB 직접 대조 + legacy DB 생성기 + 자체 시험용 mock | `docs/4m/acceptance/` (README 에 실행법) |
| 6 | **격리 서버 1차 실행** — legacy 상태 DB 를 만들어 최민준 커밋본을 `PORT=3003` 으로 띄우고(이행 [1]→[3] 실제 경로) 84건 실행 | `acceptance/out/acceptance-2026-09-13T03-15-05.json` · `acceptance-latest.md` · `compat-diff-*.json` · `server-2026-09-13.log` |
| 7 | 검증보고서 §6(재검증·서명)·§7(도구·1차 실행 결과), 이 파일, 협업로그 | — |

**커밋하지 않았다.** 운영 DB `data/factory.db`·백업본은 **열지 않았다.** 운영 서버·포트 3000 도 건드리지 않았다(격리 서버는 세션 스크래치 폴더·3003, 끝나고 내렸다).
내 소유 파일만: `docs/4m/검증보고서.md` · `docs/4m/prototype/v1/**` · `docs/4m/acceptance/**` · 이 파일 · 협업로그(append).
`ddl-v1.sql`·`cleansing-v1.json`·계획서·`server/*` 는 읽기만 했다.

---

## 한 줄 결론

> **v1.0 DDL 에 서명한다. 결함 잔존 0. 실서버 인수 1차 — 통과(84건 FAIL 0).**
> 라운드 2 서명 조건 D-19·D-3·D-5·D-10·D-15 가 전부 닫혔고, 그때 뚫린 16건이 하나도 재현되지 않는다.
> 두 런타임 결과 차이 0. BLDC 적재 `expected` 24/24, EA 76 · g 221 · SHT 12 · kg 0.85 · m 0.5.
> 격리 서버에서 legacy 36행 DB 가 이행 [1]→[3] 을 거쳐 뷰 46행이 됐고, API 로 TC-01~59 가 전부 재현됐다. 남는 것은 **문서 정정 3건**뿐이다.

| | 건수 | 확인 | 결함 | 의견 | 미실시 |
|---|---:|---:|---:|---:|---:|
| DDL 실행 (py 5 + node 4) | 9 | 9 | 0 | — | — |
| 반례 `cases.json` (py 133 · node 133) | 133 | 133/133 | **0** | 4 | — |
| 적재 `expected` | 24 | 24 | 0 | — | — |
| TC-01~59 + 파생 | 104 | 102 | **0** | 1 (TC-28) | 1 (TC-13) |
| **합계** | **270** | **268** | **0** | **5** | **1** |

성능(1만 품목·라인 10,495·트리거 34개 켠 채): 적재 라인당 0.009 ms · 정전개 27.6 ms · 역전개 4.5 ms · 순환 검출 0.3 ms · 말단 합계 23.9 ms · `v_chk_summary` 91.6 ms.

---

## 윤태경에게 — 서명 + 정정 1 + 의견 3

**서명한다** (`ddl-v1.sql` v1.0 · `cleansing-v1.json`). 근거 표는 검증보고서 §6.4.

| # | 판정 | 내용 | 요청 |
|---|---|---|---|
| **F-1** | **문서 정정** | 계획서 §9.3 [2]④ · §10.3 의 "구 NULL 이던 `SA-1000`·`RA-2000` qty 가 1.0" — **사실이 아니다.** 그 NULL 은 **내 v0.9 프로토타입 `r2_load.py` 가 `subassemblies` 수량을 안 읽어서 생긴 것**이고, 실제 `importBop` 은 `qtyOf.set(s.pn, s.qty)` = 1.0 을 넣는다(라운드 1 운영 DB 사본 실측 EA 51 도 그 전제). 이행 전후 공통 35행 **수량차 0 이 정답**(TC-57 로 확인) | 두 절 문구를 "공통 행 수량차 0" 으로. **원인이 나라서 먼저 적는다** |
| F-2 | 의견 | `trg_lot_split_cycle_ins` 는 INSERT 에서 발동할 수 없다(새 로트는 누구의 하류도 아님, 자기부모는 CHECK). 무해한 죽은 코드 | 주석 한 줄이면 된다 |
| F-3 | 의견 | 비순환 65간선 사슬이 깊이 한계에서 "순환 또는 깊이" 메시지로 거부 — R-2(10) 가 있어 실무 영향 없음 | 없음 |
| F-4 | 의견 | 환산 양방향 두 행(`kg→g`·`g→kg`)을 DB 가 안 막는다. `v_uom_base` 는 정방향을 먼저 써서 값이 어긋나도 조용하다 | 적재기/API 거부 또는 점검 뷰 1개 (v1.1) |

잘 된 것: 34 트리거가 두 런타임에서 똑같이 동작한다 · `is_primary` 대체품 승격이 as-of 로 자동 · `qty_init` 불변 + `v_chk_lot_qty` 0 · `proc_batch` 로 "배치 #7 의 30대" 한 번에 · Q-2 단일 CTE 가 v0.9 내 구현(126 ms)의 5배 빠르다.

---

## 최민준에게 — 1차 인수 결과 + 정정 3건

**1차 실행(격리 3003, legacy 36행 DB → 이행 [1]→[3] 실제 경로): 84건 PASS 83 · FAIL 0 · NOTE 1. 통과.** 검증보고서 §7.2.
기동 로그에서 확인한 것: `ddl-v1.sql` **85문**(네 문 분리기가 내 방식과 같은 답) · 이행 [1] expected 일치 · [3] `*_legacy` 보존 + 뷰. 트리거 거부 400 문자열 11종 그대로, 거부 뒤 롤백, `import-sample` 2회 멱등, `consume` 4단 계보 정·역 완주, 호환 뷰 36→46행 공통 35행 수량·단위·이름·규격·image 차 0.

남은 것은 코드가 아니라 **문서**다(인터페이스 §10·계획서 §10.3):
1. **§10 `items[].kind` 열거** — 구현은 `item_type` 원값(`FG/SA/PT/RM/CN/PK`) + `phantom` 플래그, §10 은 `FG/SA/PHANTOM/PART/RAW/PKG`(CN 없음). 구현 쪽으로 문구를 맞추고 서지안에게 알릴 것(라운드 5 인수 때 NOTE → PASS 로 바꾸겠다).
2. **§10 에 `POST …/lots/:id/consume`(투입 계보) 등재** — 이게 없으면 계보 정·역 인수가 불가능하다. 있어서 됐다.
3. **`parentName` 19행 값 변화**(네 handoff ①) — 내 격리 diff 도 19행 정확히 같다. 계획서 §10.3 표엔 없던 변화라 윤태경에게 표 추가를 요청했다. 라벨 보존 컬럼은 PM 판단.
4. (유지) **전개 API 호출 전 `v_chk_summary.'R-1'` 확인** — Q-1 은 순환이 남아 있어도 raise 하지 않는다(TC-16). 레거시 이행 시점 방어용.

2차 실행은 새 격리 DB 로(이번 실행이 `ATQW0P-` 접두 시험 데이터를 남겼다). 실행법·legacy DB 생성기(`tools/make-legacy-db.py`)는 `acceptance/README.md`.

## 서지안에게 — 자재 탭이 보여 줄 값 (인수 테스트가 같은 값을 본다)

- 요약 타일: `summary.check` 정상값은 **정확히 `{D-8:10, R-10:10}`** — 쟁점 3·6 미배정 10건이다. 다른 규칙이 하나라도 뜨면 빨간색이 맞다.
- BOM 트리: `bom/BLDC-500W-48V` `totals` = **EA 76 · g 221 · SHT(매) 12 · kg 0.85 · m 0.5**. 노드 59 · 깊이 4 · 팬텀 3(`bop.state='phantom'`, 수량 경로엔 참여·합계엔 제외) · 미배정 10(`'unassigned'`). `SC-1011` 은 L4 · 0.85 kg 정확히.
- 승인 전 신규 3건은 **`TMP-SC1010P` · `TMP-FS7023` · `TMP-PK0010`** 으로 보인다(`isTmp`). 썸네일 없음.
- 트리거 오류는 400 본문 `error` 가 **`R-1:` `R-9:` `R-8:` `R-7:` `R-9b:` `R-11:` `D-13:` `D-8:`** 로 시작한다 — 그대로 띄우면 된다. 순환 경로는 메시지에 없고 `GET …/check` 의 `v_chk_r1_cycle` 에 있다.
- `items[].kind` 는 실서버가 **`item_type` 원값(`FG/SA/PT/RM/CN/PK`)** 을 내고 팬텀은 `phantom:true` 플래그다(§10 열거와 다름 — 최민준이 문구를 맞춘다). 화면 매핑은 원값 기준으로.
- `parentName` 은 짧은 라벨이 아니라 부모 `item.name` 이다(19행 값 변화, 최민준 handoff ①).
- 로트 계보: `genealogy?dir=back` 트리의 말단 노드 `supplierLot` 이 밀시트(예: `MS-8842`)다.

## 한도윤에게 — 영향 없음

분해도 9단계·썸네일 규칙 그대로. `stage_pn='BP-3020'` 미실재는 여전(TC-28 의견, P-12 표시 축).

---

## 프로토타입·도구 — 다음 사람이 이어받는 법

```bash
cd docs/4m/prototype/v1
python v1_ddl.py ; node v1_ddl_node.mjs
python v1_cases.py ; python v1_cases_run.py ; node v1_cases_run.mjs
python v1_load.py ; python v1_tests.py
```
```bat
cd docs\4m\acceptance   (README 참조)
set FW_URL=http://localhost:3003& set FW_ADMIN_PASSWORD=…& set FW_DATA_DIR=%TEMP%\fw-accept& node acceptance.mjs
node compat-diff.mjs %TEMP%\fw-accept\factory.db
```
의존성: Python 3.9+ · Node 22+. 한글 깨지면 `PYTHONUTF8=1`. 재실행은 **새 격리 DB** 로(쓰기 검사가 `AT????-` 접두 데이터를 남긴다).

## 미실시 (추정으로 통과시키지 않은 것)

| 항목 | 사유 |
|---|---|
| **운영 DB 이행 결과 직접 확인** | 운영 DB·백업본을 열지 않았다. 최민준 handoff 수치(36→46·공통 35 수량차 0·parentName 19)가 내 격리 결과와 **일치한다**는 것만 확인 |
| TC-13 현행 결함 데이터 회귀(EA 58) | 정제가 적재 전제 — 라운드 1 `selftest.py` 담당 |
| `equipment:detail` 소켓 직접 호출 | fetch 로 불가 → `queries.processInputs` SQL 을 격리 DB 에 그대로 실행하는 것으로 대체(`compat-diff.mjs`, 최민준도 소켓 응답 = 뷰 SQL 동일을 확인) |
| 자재 탭 화면(서지안 `materials.js`) | 아직 작성 중 — 라운드 5 |

---

<details>
<summary><b>라운드 2 (2026-09-13 10:40) 요약 — 접어 둠</b></summary>

윤태경 v0.9 초안을 실행해서 깨뜨렸다. 확인 99 · 결함 35(→ D-1~D-21) · 의견 1 · 미실시 2.
"구조는 맞다. 제약이 비어 있다." — 반례 31건 중 16건이 그대로 들어갔고 DDL 이 원문 그대로 실행되지 않았다(D-19).
서명 조건 5건: D-19(DDL 실행 오류) · D-3(DRAFT 순환) · D-5(UPDATE 트리거 없음) · D-10(호환 뷰 qty 의미) · D-15(계보 무결성 전무).
V-9 로트 계보는 밀시트 `MS-8842` → 시리얼 `SN-BLDC-2026-000481` 정·역 완주 — "로트 하나를 역추적할 수 있나?" 가 '예'로 바뀐 라운드.
V-12 반박 8건(FS-70xx 부모 추정 · P-3 분리 · §4.3 (a) 삭제 · 0.010625 수율 · 배치 로트 · P-10 원천 상충 · PE-6000 세 절 · CN-4030 증거) 전부 v1.0 에 반영됐다.
프로토타입: `docs/4m/prototype/v09/` (README 에 실행 순서).

</details>

<details>
<summary><b>라운드 1 (2026-09-12) 요약 — 접어 둠</b></summary>

현행 실측(§1) · 검증 계획 59건(§2) · 프로토타입 뼈대(`docs/4m/prototype/`).
현행 데이터로 완성품 1대를 전개하면 **EA 58**, 정답은 **76** — 부족분 18 은 전부 트리 연결이 끊긴 자리(M-01 복합 부모 16 · M-02 자기참조 2).
설계 요구 R-01~R-17, 조기 검증 결함 D-1(순환 길이 12+)·D-2(유효일자 NULL).

</details>
