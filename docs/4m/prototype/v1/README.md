# prototype/v1 — 계획서 v1.0 · `ddl-v1.sql` 재검증 (라운드 4)

노하린 소유. **운영 DB `data/factory.db` 는 열지도 쓰지도 않았다.** 여기서 만드는 DB 는 전부 `out/` 안의 임시 파일이다.
`ddl-v1.sql`·`cleansing-v1.json`(윤태경) 은 한 글자도 고치지 않고 읽기만 한다.

v09 폴더(라운드 2, v0.9 대상) 와의 차이: 전개·역전개·로트 추적 SQL 을 **내가 정하지 않고 DDL 절 I(Q-1~Q-5) 원문**을 그대로 쓴다(`bomsql_v1.py`).
반례는 **데이터 파일(`cases.json`)** 로 만들어 python 과 node:sqlite 가 같은 것을 실행한다.

## 실행 순서

```bash
cd docs/4m/prototype/v1
python v1_ddl.py          # [1] ddl-v1.sql 문 단위 실행 · 객체 수 · 멱등        → out/01_ddl_python.log
node   v1_ddl_node.mjs    # [1] 같은 것을 node:sqlite(운영 런타임) exec 로       → out/02_ddl_node.log
python v1_cases.py        #     반례 배터리 생성                                 → cases.json
python v1_cases_run.py    # [2] 반례 133건 (python)                               → out/03_cases_python.log · out/cases_python.json
node   v1_cases_run.mjs   # [2] 반례 133건 (node:sqlite) + python 결과 대조       → out/04_cases_node.log · out/cases_node.json
python v1_load.py         # [3] BLDC 적재 (cleansing-v1.json 7단계 그대로) + expected 대조 → out/bldc_v1.db · out/05_load.log
python v1_tests.py        # [4] TC-01~59 + 파생 (104건)                            → out/06_tests.log · out/csv/tc_result_v1.csv
```

`v1_tests.py` 는 `out/bldc_v1.db`(TMP- 품번 상태) 를 전제한다. Windows 콘솔에서 한글이 깨지면 `PYTHONUTF8=1`.
의존성: Python 3.9+ (표준 `sqlite3`), Node 22+ (`node:sqlite`).

## 파일

| 파일 | 역할 |
|---|---|
| `common.py` | 문 분리(`sqlite3.complete_statement`) · DDL 실행 · 새 DB(선행 테이블 `../v09/prereq_existing.sql` + ddl-v1 + uom 5) |
| `v1_ddl.py` · `v1_ddl_node.mjs` | 단독 / 선행 테이블 뒤 / 2회째, 객체 수 12·20·34·19, 85문 전부 CREATE |
| `v1_cases.py` → `cases.json` | 반례 133건: D-19·R-7c / R-1(D-3·D-4·D-1·D-5, 길이 2~70, 헤더 변경·OBSOLETE 되살리기, 거짓양성) / R-3·R-9·D-6·D-7 / R-9b / D-13 / R-7·R-8·R-7b·R-14·R-20·R-6 / D-8·PM CHECK·R-22 / R-13·D-14·D-15·D-16·D-17 / R-11 |
| `v1_cases_run.py` · `v1_cases_run.mjs` | 케이스마다 새 DB. 판정 = 기대(거부/허용) + 메시지 접두 + 사후 확인 SQL. node 판은 python 결과와 대조 |
| `v1_load.py` | 참조 적재기 — `loader_algorithm` 7단계, UPSERT 멱등(`--rerun`), 승인 전환(`--approved`), 이행 [3] 뷰 전환(`--compat`), `expected` 24항목 대조. 현행 `parts`/`process_inputs` 도 `server/index.js` `importBop` 규칙 그대로 넣는다(TC-57 대조용) |
| `bomsql_v1.py` | DDL 절 I 의 Q-1·Q-2·Q-3·Q-5 **원문**(주석만 벗김) |
| `v1_tests.py` | TC-01~59 + 파생 104건. v0.9 판과 케이스 번호·입력은 같고 판정은 전부 실행 결과로 계산 |

## 다시 돌릴 때

- `out/` 는 전부 생성물이다. 지우고 위 순서대로 돌리면 같은 결과가 나온다.
- `v1_tests.py` 의 TC-16 은 트리거 2개를 **일부러 DROP** 한 사본에서 순환을 심는다(레거시 데이터 가정). 원본 DB 는 건드리지 않는다.
- `python v1_load.py --rerun --approved` 는 `TMP-` 3건을 정식 P/N 으로 바꾼다(`pn` UPDATE 만). 그 뒤 `v1_tests.py` 를 돌리려면 `python v1_load.py` 로 다시 만든다.
