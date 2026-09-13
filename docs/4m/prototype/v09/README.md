# prototype/v09 — 계획서 v0.9 실증 검증 (라운드 2)

노하린 소유. **운영 DB `data/factory.db` 는 열지도 쓰지도 않았다.** 여기서 만드는 DB는 전부 `out/` 안의 임시 파일이다.
서버 코드·공용 문서는 건드리지 않았다. 커밋하지 않았다.

라운드 1 프로토타입(`../bomkit.py` 등)은 **스키마 무관 검증 루틴**이고,
이 폴더는 **윤태경 v0.9 스키마에 직접 적재해 깨뜨리는** 쪽이다. 둘 다 남긴다.

## 실행 순서

```bash
cd docs/4m/prototype/v09

python r2_ddl.py        # [1] 계획서 §5·§6 DDL 원문 실행 가부      → out/01_ddl.log
python r2_v1.py         # [2] V-1 순환 트리거 (python sqlite3)     → out/02_v1_python.log
node   r2_v1_node.mjs   # [2] V-1 순환 트리거 (node:sqlite = 운영) → out/03_v1_node.log
python r2_load.py       # [3] BLDC 실데이터 적재 (§9.2 정제 규칙)  → out/04_load.log, out/bldc_v09.db
python r2_tests.py      # [4] TC-01~TC-59 전량                     → out/05_tests.log, out/csv/tc_result.csv
python r2_v12.py        # [5] V-12 정제 판단 반박                  → out/06_v12.log
python r2_lot.py        # [6] V-9 로트 계보 1건 완주               → out/07_lot.log
```

`r2_tests.py` 는 `r2_load.py` 가 만든 `out/bldc_v09.db` 를 전제한다. 나머지는 순서 무관.
Windows 콘솔에서 한글이 깨지면 앞에 `PYTHONUTF8=1` 을 붙인다.

의존성: Python 3.9+ (표준 `sqlite3`), `openpyxl`(r2_v12.py 만), Node 18+ (`node:sqlite`).

## 파일

| 파일 | 역할 |
|---|---|
| `ddl_v09_raw.sql` | **계획서 §5 DDL + §6 트리거를 한 글자도 안 고치고 옮긴 것.** 원문 줄번호를 주석에 적어 뒀다 |
| `ddl_v09_patched.sql` | 위에서 **딱 1건**만 고친 판 (`uom_conv` PK 식 제약 → 식 인덱스). 나머지 의심 결함은 원문 그대로 남겼다 — 깨지는지 봐야 하므로 |
| `prereq_existing.sql` | 계획서가 재사용을 전제한 기존 운영 테이블(`processes`/`equipments`/`users`/`production_records`/`parts`/`process_inputs`)의 최소 사본. 출처 `server/db.js` |
| `bomsql.py` | 전개·역전개·점검 쿼리. **계획서에 없어서 검증자가 쓴 것** — 파일 머리에 "내가 정한 규칙 4가지"를 적어 뒀다 |
| `r2_ddl.py` | DDL 원문을 문 단위로 실행. 문 경계는 SQLite 자신의 `sqlite3_complete()` 로 판정한다 |
| `r2_v1.py` / `r2_v1_node.mjs` | V-1. 자기참조·길이 2~20 순환·상태 혼재·UPDATE 경로·거짓양성·지연을 **두 런타임에서 같은 항목으로** |
| `r2_load.py` | §9.2 P-1~P-9 정제 규칙 적용 적재. 정제 이력은 `out/csv/cleansing_map.csv`(§9.3 이 요구한 매핑 CSV) |
| `r2_tests.py` | TC-01~TC-59 + 추가 반례. 판정 CSV 는 `out/csv/tc_result.csv` |
| `r2_v12.py` | 원천 xlsx 12시트를 다시 읽어 §9.2 판단의 근거 강도를 가른다 |
| `r2_lot.py` | V-9 계보 1건을 감사 대응 화면처럼 출력 |

## 다시 돌릴 때 주의

- `out/` 는 전부 생성물이다. 지우고 위 순서대로 다시 돌리면 같은 결과가 나온다(TC-53 멱등 확인).
- `r2_load.py --status DRAFT` 로 돌리면 **순환 참조 트리거가 사실상 꺼진다.** 결함 D-3 재현용이다.
- 운영 DB 사본이 필요하면 `factory.db` 와 `factory.db-wal` 을 **같이** 복사하고 `factory.db-shm` 은 복사하지 마라
  (남의 shm 을 들고 가면 테이블이 1개만 보인다 — 라운드 1 에서 겪었다).

## 스키마가 v1.0 으로 바뀌면

`ddl_v09_raw.sql` 을 새 원문으로 교체하고 위 순서대로 다시 돌린다.
`r2_tests.py` 의 테스트 케이스는 **고치지 않는다.** 고칠 곳은 `r2_load.py`(적재)와 `bomsql.py`(쿼리)뿐이다.
