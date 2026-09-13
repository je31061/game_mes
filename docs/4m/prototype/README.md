# 자재 BOM 검증 프로토타입

> 작성: **노하린** (제조 데이터 검증) · 스프린트 3 라운드 1 · 2026-09-12
> 판정 결과는 [`../검증보고서.md`](../검증보고서.md) 에 있다. 여기는 **돌리는 법**만 적는다.

---

## ⚠ 먼저 읽을 것 — 운영 DB를 건드리지 않는다

이 폴더의 어떤 스크립트도 **`data/factory.db` 를 열지 않는다.** 읽지도 쓰지도 않는다.

| 무엇 | 어디를 쓰는가 |
|---|---|
| 원천 읽기 | `docs/bldc/bldc-500w-48v.json`, `docs/bldc/source/BLDC_500W_48V_BOM_BOP_Master.xlsx` (**읽기만**) |
| 임시 DB | `tempfile.mkdtemp()` — 실행이 끝나면 지운다 (`--keep` 로 유지 가능) |
| 산출물 | 이 폴더의 `out/` |

운영 DB 실태를 확인할 일이 생기면 **파일을 복사한 뒤 복사본을** 열어라.
WAL 모드라 `factory.db` 만 복사하면 최신 데이터가 빠진다 — `factory.db` 와
`factory.db-wal` 을 **같이** 복사하고 `factory.db-shm` 은 **복사하지 마라**
(다른 프로세스가 만든 shm 을 들고 가면 SQLite 가 WAL 색인을 잘못 읽어 테이블이
일부만 보인다 — 이번에 실제로 겪었다).

```bash
cp data/factory.db  /tmp/chk/factory.db
cp data/factory.db-wal /tmp/chk/factory.db-wal     # shm 은 복사하지 않는다
python -c "import sqlite3; con=sqlite3.connect('file:/tmp/chk/factory.db?mode=ro', uri=True)"
```

---

## 의존성

| | 버전 | 비고 |
|---|---|---|
| Python | 3.14.5 (이 PC 확인) | 3.9 이상이면 동작 |
| openpyxl | 3.1.5 | 엑셀 대조용. 없으면 `--no-xlsx` 로 JSON만 |
| sqlite3 | 3.50.4 (표준 라이브러리) | 별도 설치 불필요 |

```bash
pip install openpyxl        # 이미 설치되어 있으면 불필요
```

Windows 콘솔에서 한글이 깨지면 `PYTHONUTF8=1` 을 앞에 붙여라
(스크립트가 `sys.stdout.reconfigure` 로 한 번 더 막아 두었다).

---

## 파일

| 파일 | 역할 |
|---|---|
| `load_source.py` | **원천 → 정규화 중간 형태.** JSON·엑셀을 읽어 품목 목록 + 부모-자식 관계 목록 + 이상값 목록으로 바꾼다. 원천을 고치지 않는다 |
| `bomkit.py` | **스키마 무관 검증 루틴.** 순환검출·정전개·역전개·as-of·중복·고아·수량·단위·유효일자·대체품 |
| `selftest.py` | **자체 시험.** 임시 SQLite에 실데이터와 반례를 넣고 루틴이 제대로 걸러내는지 확인 |
| `trigger_test.py` | **계획서 §6 트리거 초안 시험.** `WITH RECURSIVE` 순환 트리거(R-1)·유효일자 겹침 트리거(R-9)·`ux_bom_line_dup` 식 인덱스를 원문 그대로 임시 SQLite에 올려 본다 (윤태경 V-1·V-2 답변) |
| `out/` | 생성물. 지워도 되고 아래 명령으로 다시 만든다 |

---

## 실행

```bash
cd docs/4m/prototype

# 1) 원천을 정규화해 요약만 본다
python load_source.py

# 2) 파일로 뽑는다
python load_source.py --out out/normalized.json
python load_source.py --split-composite --out out/normalized.split.json
python load_source.py --format csv --out out/csv        # 엑셀로 열어 보기 좋다

# 3) 자체 시험 (실데이터 전개 대조 + 반례 주입)
python selftest.py

# 4) 계획서 트리거 초안 시험 (V-1 · V-2)
python trigger_test.py
python selftest.py --perf        # 품목 1만·레벨 5 성능 시험 포함
python selftest.py --keep        # 임시 DB 를 남긴다 (경로를 찍어 준다)
```

`selftest.py` 는 실패가 있으면 종료 코드 1 을 낸다. CI 에 그대로 걸 수 있다.

---

## 정규화 중간 형태

`load_source.py` 의 출력은 **스키마가 아니다.** 스키마는 윤태경 몫이다.
이것은 "어떤 DDL이 와도 적재할 수 있는 최소 공통 형태"다.

```jsonc
{
  "schema": "normalized-bom/0.1",
  "meta":   { "root": "BLDC-500W-48V", "counts": {...}, "issuesBySeverity": {...} },

  "items":  [ { "pn", "name", "spec", "unit", "srcLevel",
                "roles": ["product"|"subassembly"|"part"], "sources": [...] } ],

  "edges":  [ { "parentPn", "childPn", "qtyPerParent", "unit", "srcLevel",
                "source", "derived", "note",
                // --split-composite 일 때만
                "derivedFrom", "confidence" } ],

  "processes":    [ { "op", "seq", "line", "name", "ctSec", "kind", "stagePn", "output" } ],
  "processInputs":[ { "op", "pn", "qty", "unit" } ],
  "units":  { "EA": {...}, "kg": { "convert": ["g", 1000] }, ... },
  "issues": [ { "code", "severity", "title", "subject", "detail", "evidence" } ]
}
```

**핵심 약속 세 가지**

1. `edges` 는 원천의 부모 값을 **그대로** 싣는다. `HA-3000/EX-5000` 도 그대로 들어간다.
   보정하지 않고 `issues` 에 `COMPOSITE_PARENT` 로 표시만 한다.
2. 보정안이 필요하면 `--split-composite` 로 **따로** 낸다. 이때 `derived: true`,
   `derivedFrom`, `confidence` 가 붙는다 — 원천값과 추정값이 절대 섞이지 않는다.
3. `issues` 의 `severity` 는 ERROR(트리가 깨짐) / WARN(해석이 갈림) / INFO(기록만).

---

## 스키마가 확정되면 — 무엇을 갈아끼우나

`bomkit.py` 는 테이블·컬럼 이름을 모른다. `Mapping` 하나만 채우면 된다.

```python
from bomkit import Mapping, from_sqlite, run_all

m = Mapping(
    item_table="mat_item",      item_pn="item_code",
    item_cols={"name": "item_name", "unit": "uom_code"},
    edge_table="mat_bom",       edge_parent="parent_item",
    edge_child="child_item",    edge_qty="qty_num",
    edge_cols={"unit": "uom_code", "validFrom": "eff_from", "validTo": "eff_to",
               "altGroup": "sub_group", "altPriority": "sub_seq", "seq": "line_no"},
)
items, edges = from_sqlite(con, m)
result = run_all(items, edges, roots=("BLDC-500W-48V",))
assert result["blocking"] == 0
```

없는 컬럼은 `None` 으로 채워지고 해당 검사는 자동으로 건너뛴다.
**검증 루틴·테스트 케이스는 한 줄도 고치지 않는다.**

적재 스크립트(`load_source.py` → 확정 DDL)만 새로 쓰면 된다. 지금은
`selftest.py` 안의 `LOOSE_DDL` / `STRICT_DDL` 이 그 자리표시자다.

---

## 자체 시험이 확인하는 것

### A. 실데이터 전개 (기대값 = 엑셀 `09_BOM_Flat_Consolidated` 수기 집계)

완성품 1대 기준 **EA 76 · g 221 · 매 12 · kg 0.85 · m 0.5**.
결함을 하나씩 정정하며 숫자가 어떻게 회복되는지 보인다.

| 시나리오 | 전개 EA | 기대 대비 |
|---|---|---|
| ① 현행 원천 그대로 | **58** | −18 |
| ② + 복합 부모 `HA-3000/EX-5000` 분해 | **74** | −2 |
| ③ + 자기 참조 2건(`FS-7010`·`FS-7020`) 정정 | **76** | 일치 |

g·kg·매·m 은 세 시나리오 모두 정확하다 — **EA 품목에서만 어긋난다.**

### B. 반례 주입 (관계 20건 · 검사 22항목)

제약 없는 스키마에 반례를 전부 넣고 검출기가 잡는지 본다. 이어서 제약을 건
`STRICT_DDL` 에 하나씩 넣어 **DDL 만으로 막히는 것과 못 막는 것**을 가른다.

- DDL 로 막힌다(9) — 자기 참조 · 한 칸에 부모 둘 · 수량 0/음수/NULL · 부모 미존재
  · 미등록 단위 · 유효기간 역전 · 같은 시작일 중복 자식
- **DDL 로 못 막는다(4)** — 2단계 이상 순환 · 유효일자 겹침 · 대체품 동시 유효
  · 같은 P/N 단위 불일치 → **트리거·검증 배치·입력 화면 검사가 반드시 필요**

### C. 성능 (`--perf`)

품목 10,001 · 관계 10,500 · 레벨 5 (다부모 공용부품 500건 포함), 순수 Python:

| | 시간 |
|---|---|
| 순환 검출 | 5.5 ms |
| 정전개 (노드 10,500) | 9.8 ms |
| 역전개 | 1.3 ms |

규모는 문제가 아니다. 문제는 데이터 품질이다.

### 계획서 트리거 시험 (`trigger_test.py`)

계획서 v0.9 §6 의 트리거를 **한 글자도 고치지 않고** 올려 본 결과 (SQLite 3.50.4):

| | 결과 |
|---|---|
| R-1 트리거 생성 (본문 안의 `WITH RECURSIVE`) | **동작한다** — 설계 후퇴 불필요 |
| 자기 참조 · 순환 길이 2 ~ 11 | 전부 차단 |
| **순환 길이 12 이상** | **통과 — 막지 못한다** (`depth < 10` 가드) → 결함 D-1 |
| 거짓양성 | 없음 |
| INSERT 지연 | 행당 0.33 ms |
| `ux_bom_line_dup` 식 인덱스 | 동작 (같은 시작일 중복 차단) |
| **R-9 겹침 트리거, `valid_to = NULL`** | **3가지 조합 전부 통과 — 뚫림** (SQL 3값 논리) → 결함 D-2 |

### D. 미실시 (이번 라운드에 못 한 것)

로트 계보 · 대체품 실데이터 · 유효일자 실데이터 · 단위 환산 · BOP 투입지점 수량.
전부 **데이터나 스키마가 없어서** 못 했다. 추정으로 통과시키지 않았다.
사유는 `selftest.py` 의 `part_d()` 와 검증보고서 §2 에 적혀 있다.
