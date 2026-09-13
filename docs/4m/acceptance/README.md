# acceptance — 자재(Material) API 인수 테스트 도구

노하린 소유 (인터페이스 §6 파일 소유 · §10 "노하린 인수 테스트"). 검증보고서 §2 TC-01~59 를 **실서버 API(§10 라우트)** 로 돌린다.
Node 22+ 의 내장 `fetch` 만 쓴다 — `socket.io-client` 불필요, 추가 설치 없음.

## 파일

| 파일 | 역할 |
|---|---|
| `acceptance.mjs` | 인수 테스트 본체. 0 인증 → 1 적재·멱등 → 2 마스터 → 3 정전개 → 4 역전개 → 5 공정 IN/OUT → 6 트리거 거부(400+문자열) → 7 as-of·라인 편집 → 8 로트 계보 정·역 → 9 호환 계약·성능 |
| `lib/compat.mjs` | 호환 계약 검사 — `server/db.js` `queries.processInputs` SQL 을 **문자 그대로** 격리 DB 에 실행해 이행 전(`*_legacy`)·후(뷰) 대조 |
| `compat-diff.mjs` | 위 검사를 서버 없이 단독 실행 (`--snapshot` / `--against`) |
| `mock/mock-server.mjs` | **도구 자체 시험용 스텁** (프로토타입 DB 위 §10 흉내). 운영 서버가 아니다 — 실서버 인수는 반드시 `server/index.js` 로 |
| `out/` | 결과. `acceptance-<시각>.json` · `acceptance-latest.json` · `acceptance-latest.md`(판정표) · `compat-diff*.json` |

## 실행법 — 격리 서버 (운영 DB 를 열지 않는다)

```bat
:: 1) 격리 서버 — 임시 데이터 폴더·다른 포트·임시 관리자 비밀번호·시크릿. 운영 data/ 와 포트 3000 은 건드리지 않는다
set FW_DATA_DIR=%TEMP%\fw-accept
set PORT=3003
set FW_SEED_PRODUCT_LINE=bldc
set FW_ADMIN_PASSWORD=accept-1234
set FW_JWT_SECRET=accept-secret
node server\index.js

:: 2) 다른 창에서 인수 테스트
cd docs\4m\acceptance
set FW_URL=http://localhost:3003
set FW_ADMIN_PASSWORD=accept-1234
set FW_DATA_DIR=%TEMP%\fw-accept
node acceptance.mjs
```

PowerShell 은 `$env:FW_DATA_DIR = "$env:TEMP\fw-accept"` 식으로. 토큰을 직접 줄 때는 `FW_TOKEN=<jwt>`.

| 환경변수 | 뜻 |
|---|---|
| `FW_URL` | 서버 (기본 `http://localhost:3003`) |
| `FW_TOKEN` 또는 `FW_ADMIN_EMPNO`(admin)·`FW_ADMIN_NAME`(관리자)·`FW_ADMIN_PASSWORD` | 관리자 인증. 토큰이 없으면 `POST /api/login` |
| `FW_DATA_DIR` | 격리 서버의 데이터 폴더. 주면 9단계에서 `factory.db` 를 **읽기 전용**으로 열어 호환 계약 전후를 대조한다. 운영 `data/` 를 주면 즉시 중단 |
| `FW_ASOF` | as-of 기준일 (기본 2026-06-01) |
| `FW_READONLY=1` | 6·7·8 단계(쓰기)를 건너뛴다 — 공유 서버 |
| `FW_SKIP_IMPORT=1` | `import-sample` 를 부르지 않는다 |

**재실행은 새 격리 DB 로.** 6·7·8 단계가 시험 품목·라인·로트(접두 `AT????-`)를 남기므로 두 번째 실행에서 건수 검사가 어긋난다.
종료 코드: FAIL 이 하나라도 있으면 1.

## 무엇을 어떻게 판정하나

| 단계 | 검사 | 기대값 근거 |
|---|---|---|
| 1 | `import-sample` 2회 → `expectedMatch true`, `mismatches []`, 건수 동일, `check = {D-8:10, R-10:10}` | `cleansing-v1.json` `expected` |
| 3 | `bom/BLDC-500W-48V` `totals` = **EA 76 · g 221 · SHT(매) 12 · kg 0.85 · m 0.5** (오차 1e-9), 노드 59 · 최대 level 4 · 팬텀 3 · `bop.state` linked 46/unassigned 10/phantom 3, `SC-1011` 정확히 0.85 | 검증보고서 §1.9 · v1.0 §5.9 |
| 4 | `where-used` 경로가 루트까지 (`OR-5020 → EX-5000 → BLDC`, `BF-3040 → HA-3000 → BLDC`, `SC-1011` 5노드) | TC-18~22 |
| 5 | 24공정 `process/:op` IN 합 46 · OUT 24 · 완성 7, OP-B90 9종 BOP 표기 순서, `GET /api/admin/bop` inputs 46 · parts 59 | TC-23~27 · 계획서 §10.3 |
| 6 | 트리거 거부가 **400 + `R-1:` `R-9:` `R-8:` `R-7:` `R-7b:` `R-9b:` `R-11:` `R-14:` `D-13:` `D-8:`** 접두 문자열로 오는지, 거부 뒤 롤백 | 인터페이스 §10 "트리거 문자열 그대로 400" |
| 7 | 2027 부터 유효한 라인 → as-of 2026 없음 / 2027 있음, EA 77 · GB-8000 2개 → GB-8010 2 · GB-8040 4 · EA 81 (되돌림) | TC-37~40 · TC-14 · TC-57b |
| 8 | 코일 850 kg → 서브로트 0.85 (원로트 849.15) → SC-1010P → SC-1010 → SA-1000 → 시리얼, `genealogy?dir=fwd` 시리얼 도달 · `dir=back` 밀시트 `MS-8842` 도달, 순환·자기참조·중복 간선 400 | TC-45~47 · D-15·D-16·D-17 |
| 9 | `FW_DATA_DIR/factory.db`(읽기 전용): `process_inputs`·`parts` 가 뷰, `*_legacy` 표 존재, `queries.processInputs` SQL 그대로 — legacy 36행 ↔ 뷰 46행, 전에만 `(OP-B90, PE-6000)`, 후에만 11, **공통 35행 수량·단위·이름·규격 차 0** (level·parentPn 변화만 예고분) | 계획서 §9.3 [2]④ · §10.3 (검증보고서 §6 TC-57 정정 반영) |

## 호환 계약(`equipment:detail.process.inputs[]`) 전후 diff 절차

`equipment:detail` 은 소켓 이벤트라 fetch 로 못 부른다. 대신 그 응답을 만드는 `queries.processInputs` SQL 을 DB 에 그대로 실행한다.

```bat
:: (a) 이행 전 서버의 격리 DB 를 스냅샷 (parts/process_inputs 가 아직 표일 때)
node compat-diff.mjs %TEMP%\fw-before\factory.db --snapshot out\compat-before.json
:: (b) 이행 후 DB 를 스냅샷과 대조
node compat-diff.mjs %TEMP%\fw-accept\factory.db --against out\compat-before.json
:: (c) 이행 후 DB 하나로 legacy 표 ↔ 뷰 대조 (최민준 이행이 *_legacy 를 남기므로 보통 이걸로 충분)
node compat-diff.mjs %TEMP%\fw-accept\factory.db
```

"diff 0" 의 뜻: **공통 (공정, P/N) 35행의 qty·unit·name·spec 차이 0**. 행 집합 변화(36→46)와 level·parentPn 값 변화는 계획서 §10.3 이 예고한 것이고 도구가 그 목록과 정확히 같은지 본다.

## 도구 자체 시험 (서버 없이)

```bat
cd docs\4m\prototype\v1 && python v1_load.py --db out\bldc_v1_compat.db --compat --quiet
cd ..\..\acceptance
node mock\mock-server.mjs 3009
:: 다른 창
set FW_URL=http://localhost:3009& set FW_TOKEN=mock& set FW_DATA_DIR=mock\data& node acceptance.mjs
```

mock 은 판정 로직·출력을 확인하는 용도다. 실서버 결과가 곧 인수 결과다.
