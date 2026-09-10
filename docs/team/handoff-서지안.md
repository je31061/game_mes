# handoff — 서지안 (설비 연동·생산실적 분석가)

## 스프린트 2 라운드 1 — 라인 밸런스 — 2026-09-09 완료 (커밋은 라운드 2에서 최민준)

### 만든 것 (전부 내 소유 파일, 공용 파일 미수정, 서버 재기동 안 함)
| 파일 | 변경 |
|---|---|
| `docs/분석-정의.md` | **§8 라인 밸런스** 신설(입력·공정 단위·라인 단위·제품 단위·xlsx 기준값 대조·한계 6가지). §2에 shift 설정 위치 한 줄(최민준 요청). §7에 숨김 설비 취급. |
| `server/analytics.js` | `GET /api/admin/analytics/line-balance` 추가. 순수 계산 `computeLineBalance(rows, params, eqByOp)`·`parseLineBalanceParams(query)`를 export(검증용). 기존 3개 라우트는 `hidden` 설비 제외(`visible` 필터 — `listEquipments`가 이미 거르면 무해한 중복). 스키마 유무는 요청 시점에 `sqlite_master`·`PRAGMA table_info`로 본다. |
| `public/js/analytics.js` | 📈 탭 5번째 섹션 **"라인 밸런스"**: 설정 컨트롤(제품·가동시간·OEE 가정·목표 UPH·"비고 권장 병렬 적용" 토글·기준값 버튼), 제품 요약 타일 4개, 미연결·배치 경고, 라인별 타일 6개 + 공정 C/T 가로 막대(SVG) + 표(병렬 대수 입력). 설정을 바꾸면 이 섹션만 다시 조회. `TYPE_LABEL`에 §9 새 유형 8종 라벨. |
| `public/css/analytics.css` | `.fwa-lb-*` 스타일, 차트 3 클래스(병목 `--alarm`, 배치 빗금 `pattern`, 병렬 전 점선, 목표 C/T 선, 설비 상태 점). 테마 변수만 사용. |

### 지표 요약 (정의는 docs/분석-정의.md §8)
- 기간 필터와 **무관**한 설계 능력 지표. 원천 `processes.ct_sec`(BOP 설계값) + `equipments.op`.
- 유효 C/T = C/T ÷ 병렬 대수(기본 1, 쿼리 `parallel[OP]=n` 또는 `parallel=OP:n,…`; `hints=1`이면 note "병렬 N대 권장" 적용 — 화면 기본 ON).
- 배치 공정(kind=배치): 개당 C/T = C/T ÷ 배치 크기(note "30ea/배치")를 병기, **합계·병목에서 제외**(xlsx와 동일). 개당 C/T > 병목이면 경고(A90 건조로 120초/ea > 45초 → 배치 설비 3대 또는 80ea).
- 병목 = 유효 C/T 최대 비배치 공정. 동률이면 시트 `kind=병목` 표기 우선, 없으면 seq 앞선 것, 동률 목록은 `tiedWith`(조립 라인 B90·B110 60초 동률 → B110).
- UPH = 3600 ÷ 병목 C/T · 일 생산량 = hours×3600×oee ÷ 병목 C/T(정수 내림) · 달성률 = UPH ÷ 목표 UPH · 목표 C/T = 3600 ÷ 목표 UPH(넘는 공정 `overTakt`) · 밸런스 효율 = Σ유효 C/T ÷ (공정 수 × 병목 C/T).
- 제품 = 직렬 라인이므로 min(라인 UPH)·min(일 생산량), `slowestLine`.
- 기본값(xlsx 12_Line_Balance): hours 20 · oee 0.85 · targetUph 60.

### API 응답 예 (2026-09-09 22:40, 실서버 · 최민준이 BOP 적재한 실제 DB · 관리자 토큰)
`GET /api/admin/analytics/line-balance?hints=1` → 200 (발췌)
```json
{ "ok": true, "product": { "code": "BLDC-500W-48V", "name": "BLDC 모터 500W 48V" }, "products": [ { "code": "BLDC-500W-48V", "name": "…" } ],
  "schema": { "processes": true, "products": true, "equipmentOp": true, "equipmentHidden": true },
  "params": { "hours": 20, "oee": 0.85, "targetUph": 60, "dailySec": 61200, "taktSec": 60, "hints": true, "parallel": { "OP-A40": 2, "OP-A10": 1, "…": 1 } },
  "lines": [
    { "line": "아마추어 라인", "processCount": 10, "flowCount": 8, "batchCount": 2,
      "bottleneck": { "op": "OP-A40", "name": "Needle Winding (권선)", "ctSec": 90, "parallel": 2, "effectiveCtSec": 45, "tiedWith": [] },
      "sumCtSec": 240.5, "sumEffectiveCtSec": 195.5, "balanceEff": 0.5431, "uph": 80, "dailyOutput": 1360, "attainment": 1.3333, "overTakt": [],
      "linkedCount": 10, "unlinked": [], "warnings": ["OP-A90 배치 개당 120초 > 병목 45초 → 실질 병목. 배치 설비 3대(병렬) 또는 배치 크기 80ea 필요"],
      "processes": [ { "op": "OP-A40", "seq": 4, "name": "Needle Winding (권선)", "kind": "병목", "ctSec": 90, "isBatch": false, "batchSize": null, "parallel": 2, "parallelHint": 2,
                       "effectiveCtSec": 45, "perUnitCtSec": null, "isBottleneck": true, "equipmentHint": "니들 와인더", "qc": "U/V/W 각 45T, 장력 250gf", "note": "병렬 2대 권장", "stagePn": "SA-1000",
                       "equipment": { "id": 15, "code": "OP-A40", "name": "니들 와인더", "type": "winder", "status": "IDLE" }, "linkedCount": 1, "notes": ["병렬 2대 적용(비고 권장값)", "설비 연결 1대(병렬 설정 2대)"] },
                     { "op": "OP-A90", "kind": "배치", "ctSec": 3600, "isBatch": true, "batchSize": 30, "perUnitCtSec": 120, "effectiveCtSec": null, "notes": ["배치 개당 120초 > 병목 45초 → …"] }, "…" ] },
    { "line": "조립 라인", "processCount": 14, "flowCount": 14, "batchCount": 0,
      "bottleneck": { "op": "OP-B110", "name": "성능/기능 시험", "ctSec": 60, "parallel": 1, "effectiveCtSec": 60, "tiedWith": ["OP-B90"] },
      "sumCtSec": 465, "sumEffectiveCtSec": 465, "balanceEff": 0.5536, "uph": 60, "dailyOutput": 1020, "attainment": 1, "overTakt": [], "linkedCount": 14, "unlinked": [], "warnings": [], "processes": ["…"] } ],
  "summary": { "lines": 2, "processes": 24, "linked": 24, "unlinked": [], "uph": 60, "dailyOutput": 1020, "attainment": 1, "slowestLine": "조립 라인", "targetUph": 60 } }
```
- 데이터 없음(200): `{ "ok": false, "reason": "processes 테이블 없음 — …" | "BOP 미적용 — …" | "제품 X의 공정 데이터가 없습니다. 등록된 제품: …", "schema": {…}, "params": {…}, "lines": [], "summary": null }`
- 오류(400): `?hours=30` → `hours 는 0.1~24 사이 숫자여야 합니다.` / `?parallel[OP-A40]=2.5` → `parallel[OP-A40] 은 1~20 정수여야 합니다.` / 토큰 없음 → 401.

### 검증 결과 (2026-09-09, 이 PC)
1. **JSON 원천 대조(서버 없이)** — `computeLineBalance`에 `docs/bldc/bldc-500w-48v.json`의 processes 24건을 넣어 50항목 확인(스크래치 스크립트): xlsx 12_Line_Balance와 **일치** — 아마추어(A40 병렬 2) 병목 45초·UPH 80·일 1360, 조립 B110 60초·UPH 60·일 1020, 합계 240.5/465초, 밸런스 효율 54.3/55.4%. 병렬 없이 A40 90초 → UPH 40·일 680·`overTakt [OP-A40]`. A40×3이면 병목이 A50 40초로 이동, B110×2면 B90 60초. 24h·OEE 1 → 86400/45 = 1920.
2. **라우트(인메모리 node:sqlite, §7 스키마 그대로)** — 테이블 없음 → ok:false, 테이블만 있고 비었음 → "BOP 미적용", `op` 컬럼 없음 → linked 0·`schema.equipmentOp:false`, `op`/`hidden` 추가 후 숨김 설비는 연결로 안 침·동일 op 2대는 `linkedCount 2`, 숨김 설비는 OEE에서 제외.
3. **실서버**(최민준이 스키마·BOP 적재 후 재기동한 3000, 브라우저 패널 관리자 세션 토큰, 비밀번호 미입력, 내가 재기동하지 않음) — 위 응답 예 그대로. `parallel[OP-A40]=2&parallel[OP-B110]=2`(Express qs 객체형) → A40 2·B110 2 파싱, 조립 병목 B90 60초로 이동. 문자열형 `parallel=OP-A40:2` → UPH 80. 400 두 종·미등록 제품 안내 확인. `/oee` 24대(구 11대 숨김 제외 확인), `/gateway` 오늘 0대(BLDC 설비는 data_source 없음 — 정상).
4. **화면** — (a) 정적 하네스(스크래치패드, 실제 css/js + 계산 함수 인라인, 포트 3177 임시 http.server → 종료): 다크·라이트 모두 막대·병목 강조·배치 빗금·병렬 전 점선·목표 C/T 선·설비 상태 점·미연결 경고·배치 경고 렌더, 병렬 입력 1 → UPH 40/680, 가동시간 24 → 816/1224, 기준값 버튼 → 80/1360, 권장 병렬 OFF → 90초·초과 표시, 데이터 없음 3종(BOP 미적용·스키마 전·API 실패)에서 나머지 섹션은 정상, 콘솔 오류 0. (b) 실제 관리자 콘솔 📈 탭: `.fwa-lb` 2라인·SVG 2·병렬 입력 24, 타일 "60 / 1,020대 / 100% / 24/24공정", 경고 1건(A90). 콘솔 오류는 내가 일부러 보낸 400 두 건뿐.
5. `node --check` server/analytics.js·public/js/analytics.js 통과, `import('./server/analytics.js')` OK.

### 최민준에게 요청 (라운드 2)
1. README·운영 가이드 §3-1에 "📈 라인 밸런스 카드(BOP 적용 후 표시, 정의 `docs/분석-정의.md` §8)" 한 줄.
2. `GET /api/admin/bop`의 "설비 연결 현황"과 내 `unlinked`가 같은 정의(equipments.op = processes.op, hidden 제외)인지 한 번 대조 — 두 화면 숫자가 다르면 문의가 생긴다. 지금 실 DB에서는 둘 다 24/24.
3. (정책 질문) 같은 op에 설비를 2대 등록하면 `linkedCount 2`로 표시만 하고 `parallel`은 자동 반영하지 않는다(정의 §8.2). 자동 반영을 원하면 알려 달라 — 계산 함수 한 줄이다.
4. (주의, 코드 요청 아님) node:sqlite는 `ALTER TABLE` **전에** prepare한 `SELECT *` 문이 새 컬럼을 못 본다(테스트에서 확인). db.js는 마이그레이션 → `queries` 순서라 문제없지만, 앞으로 `queries` 뒤에 마이그레이션을 넣지 않도록.
5. 게이트웨이 표는 BLDC 24대에 `data_source`가 없어 비어 있다. 시뮬레이션(SIM)을 붙일 계획이면 알려 달라 — 라인 밸런스에 실측 C/T 열을 붙이는 다음 단계의 전제다.

### 데이터 한계 (화면 비고와 같은 말, 정의 §8.6)
- C/T는 BOP 시트 설계값(수기), OEE 0.85는 가정값. 실측 사이클 타임·실측 OEE와 연결되지 않는다.
- 배치 공정은 병목 판정에서 제외(xlsx 기준), 개당 C/T가 병목보다 크면 경고만.
- 라인 간 버퍼·재공·수율·셋업 시간 미고려.
- 설비 연결은 `equipments.op` 1:1 기준.

### 다음 개선안
- 게이트웨이가 사이클 카운트를 수집하면 공정별 **실측 C/T**(= RUN 시간 ÷ 산출 수) 열을 붙여 설계 C/T와 나란히 보여 준다.
- §3의 실측 OEE를 "OEE 가정" 입력란의 기본값으로 끌어오는 버튼.
- 라인 간 재공(WIP) 시뮬레이션은 범위 밖 — 필요하면 별도 설계.

---

## 스프린트 1 라운드 2 — 2026-09-07 완료 (커밋은 라운드 3에서 최민준)

### 만든 파일 (전부 내 소유 파일만, 공용 파일 미수정)
| 파일 | 내용 |
|---|---|
| `docs/분석-정의.md` | 가동률·성능·품질·OEE 정의(분자·분모·계획 시간·null 조건), 일별 실적, 게이트웨이 연결 품질 지표, 데이터 한계 7가지 |
| `server/analytics.js` | `export function registerAnalytics(app, { requireAdmin, db, queries, settings })` — 인터페이스 §4 라우트 3개. 모든 라우트 `requireAdmin`, 날짜 형식 오류는 400 |
| `public/js/analytics.js` | `window.FWAnalytics = { mount(container, api) }` (멱등: 첫 호출에 골격, 이후 호출은 현재 필터로 재조회). 기간·설비 필터, 프리셋(오늘/7일/30일/전체), 요약 타일, 설비별 OEE 막대(인라인 SVG)+표, 일별 생산 누적 막대+목표선+표, 게이트웨이 연결 품질 표, 툴팁, 데이터 없음 처리 |
| `public/css/analytics.css` | `.fwa-*` 접두. 테마 변수만 사용(다크·라이트 확인) |

### 지표 요약 (자세한 것은 docs/분석-정의.md)
- **상태 점유 시간**: `todayStatusBreakdown`과 같은 방식 — 로그 구간을 다음 로그까지로 보고 기간에 맞춰 자름. 기간 이전 마지막 로그가 시작 상태. 로그가 하나도 없는 설비는 `status_since`부터 현재 상태(대시보드 폴백과 동일). 첫 로그 이전 시간은 **상태 미확인(`unknownMin`)** 으로 따로 보고(추정하지 않음).
- **계획 시간**: `settings.policy.shiftMinutesPerDay`(1~1440) 없으면 1440/일. 지난 날은 전량, 오늘은 경과 시간까지, 미래는 0. 교대 시작 시각이 없으므로 총량만.
- **가동률** = RUN/계획(상한 1) · **성능** = (양품+불량)/목표(상한 1, 초과는 비고·달성률 `attainment`로 표시) · **품질** = 양품/(양품+불량) · **OEE** = 곱(하나라도 null → null + 비고 이유).
- **목표 귀속**: `eqTargetQty`(오늘 게이지)와 같은 규칙 — DONE은 `completed_at`, OPEN/IN_PROGRESS는 `created_at`, CANCELED 제외.
- **요약**은 설비별 평균이 아니라 합계로 재계산(가중).
- **게이트웨이**: `changed_by = gateway` 로그만 집계. `samples`=자동 상태 변경 수(폴링 수가 아님), `manualChanges`, `alarmCount`, `medianGapSec`/`maxGapSec`(간격), `lastSeen`(기간 무관 최근), `mode`=reason의 `SIM` 표기로 판정.

### API 응답 예 (2026-09-07 23:00, 실제 DB, 관리자 토큰으로 호출)

`GET /api/admin/analytics/oee?from=2026-08-13&to=2026-08-13` → 200 (일부 발췌)
```json
{ "range": { "from": "2026-08-13", "to": "2026-08-13", "days": 1, "elapsedDays": 1, "shiftMinutesPerDay": 1440, "shiftConfigured": false,
             "plannedMinPerEquipment": 1440, "now": "2026-09-07 23:00:41", "dataFrom": "2026-08-13" },
  "equipments": [
    { "id": 4, "code": "WLD-01", "name": "용접기 1호", "type": "welder",
      "availability": 0.0702, "performance": null, "quality": null, "oee": null,
      "runMin": 101.1, "plannedMin": 1440, "coveredMin": 608.5, "unknownMin": 831.5,
      "minutes": { "RUN": 101.1, "IDLE": 4.1, "STOP": 2.3, "ALARM": 501 },
      "good": 0, "defect": 0, "target": 0, "orders": 0, "records": 0, "statusSource": "mixed",
      "notes": ["상태 미확인 831.5분(첫 로그 이전)", "목표 없음(성능 —)", "실적 없음(품질 —)"] },
    { "id": 7, "code": "ASM-01", "type": "assembly", "availability": 0.4276, "runMin": 615.7, "unknownMin": 824.3, "statusSource": "none", "...": "..." } ],
  "summary": { "equipments": 11, "equipmentsWithOee": 1, "equipmentsWithLogs": 11, "runMin": 4803.1, "plannedMin": 15840,
               "good": 100, "defect": 0, "target": 100, "attainment": 1, "availability": 0.3032, "performance": 1, "quality": 1, "oee": 0.3032 } }
```
`GET /api/admin/analytics/production?from=2026-08-13&to=2026-09-07` → 200
```json
{ "range": { "from": "2026-08-13", "to": "2026-09-07", "days": 26 },
  "days": [ { "date": "2026-08-13", "good": 100, "defect": 0, "records": 1, "target": 100, "orders": 1 }, "... (0인 날도 포함)",
            { "date": "2026-09-07", "good": 100, "defect": 1, "records": 1, "target": 10, "orders": 1 } ],
  "byEquipment": [ { "id": 1, "code": "PRS-01", "name": "프레스 1호기", "type": "press", "good": 200, "defect": 1, "records": 2, "target": 110, "orders": 2 }, "..." ],
  "total": { "good": 200, "defect": 1, "target": 110, "orders": 2, "records": 2 } }
```
`GET /api/admin/analytics/gateway?from=2026-08-13&to=2026-08-13` → 200
```json
{ "range": { "from": "2026-08-13", "to": "2026-08-13", "gatewayUserId": 5 },
  "equipments": [
    { "id": 3, "code": "PRS-03", "name": "프레스 3호기", "type": "press", "protocol": "mqtt", "intervalMs": 1000, "mode": "live",
      "samples": 18, "statusChanges": 19, "manualChanges": 1, "alarmCount": 3, "lastSeen": "2026-08-13 15:16:12",
      "firstInRange": "2026-08-13 14:18:48", "lastInRange": "2026-08-13 15:16:12", "medianGapSec": 14, "maxGapSec": 2883, "currentStatus": "RUN" },
    { "code": "WLD-01", "protocol": "modbus", "mode": "sim", "samples": 77, "statusChanges": 81, "manualChanges": 4, "alarmCount": 5, "medianGapSec": 14, "maxGapSec": 2817, "...": "..." },
    { "code": "CNC-01", "protocol": "opcua", "mode": "sim", "samples": 89, "statusChanges": 89, "manualChanges": 0, "alarmCount": 8, "medianGapSec": 16.5, "maxGapSec": 2856, "...": "..." } ] }
```
오류: `?from=13-08-2026` → 400 `{"error":"from 은 YYYY-MM-DD 형식이어야 합니다."}`, 토큰 없음 → 401.

### 검증 결과 (2026-09-07, 이 PC, 실제 DB, 서버 재기동 후)
- 서버 로그: `[analytics] server/analytics.js 로드 — /api/admin/analytics/* 등록`. `node --check` server/analytics.js·public/js/analytics.js 통과.
- **수기 대조 1 — WLD-01, 2026-08-13**: 로그 81건을 손으로 구간 합산(별도 스크립트) → RUN 101.1분 · IDLE 4.1 · STOP 2.3 · ALARM 501.0. API와 **일치**. 가동률 101.1/1440 = 7.02% ✓. 게이트웨이 ALARM 진입 5건(DB `count where status='ALARM' and changed_by=5`) = `alarmCount` 5 ✓.
- **수기 대조 2 — ASM-01(로그 0건, 시드 RUN since 13:44:20)**: 13:44:20→24:00 = 615.67분 → API `runMin` 615.7 ✓, `unknownMin` 824.3(=1440−615.7) ✓.
- **수기 대조 3 — PRS-01, 08-13~09-07(26일)**: 계획 25×1440+1379.5(23:59:30 경과) = 37379.5 ✓. RUN = 08-13 14:30:24→09-07 22:37:14(36486.8) + 22:37:21→22:59:30(22.2) = 36509 ✓. 성능 201/110 → 상한 1 + 비고 "목표 초과 생산", 품질 200/201 = 99.5% ✓.
- 필터: `equipmentId=4` → 1대만, 오늘+WLD-03 → 가동률 0%(STOP 유지)·실적 없음 안내·게이트웨이 표 "이력 없음". 프리셋 전체(`dataFrom` 2026-08-13부터).
- 화면: 📈 탭 다크·라이트(localStorage `fw.theme`) 모두 확인 — 요약 타일, OEE 막대(11대), OEE 표, 일별 누적 막대(08-13·09-07)+목표선, 실적 표, 게이트웨이 표 3대. 마운트 후 콘솔 오류 0(이전 5건은 내가 400/401 응답을 시험한 것). 테스트 후 테마는 다크로 복원.
- 데이터 변화 주의: 검증 중 PRS-01에 오늘(09-07 22:37) 상태 변경 4건과 실적 1건(WO#2 완료, 양품 100·불량 1)이 새로 들어와 있었음(다른 사람의 검증으로 보임). 수치는 그 상태 기준.

### 최민준에게 요청 (라운드 3)
1. **설정 항목 `policy.shiftMinutesPerDay`** (정수 1~1440): 관리자 콘솔 운영 정책 카드에 입력란 추가 + `PUT /api/admin/policy`(현재 allowSelfRegister·retentionDays 저장하는 곳)에서 검증·저장. 분석 API는 이미 이 값을 읽는다(없으면 1440). 라벨 제안: "1일 계획 가동 시간(분)".
2. `README`·운영 가이드에 📈 탭 한 줄 + `docs/분석-정의.md` 링크.
3. (선택) `server/index.js`의 `todayUptime`(게임 상태창 가동률)은 `todayStatusBreakdown`과 달리 첫 로그 이후만 분모로 쓴다 — 분석 탭의 가동률(계획 시간 분모)과 숫자가 달라 보일 수 있다. 화면 라벨을 "금일 가동 비율(로그 구간 기준)"처럼 구분해 주면 문의가 줄 것.
4. (다음 스프린트 제안) 게이트웨이 폴링 수신/실패 카운트를 남길 표(`gateway_samples` 등) — 지금은 상태 변경만 남아 "연결 끊김"과 "상태 안정"을 구분할 수 없다. 스키마는 최민준 소유라 제안만.

### 데이터 한계 (화면 하단·표 비고에도 같은 말)
- 실적·목표는 수동 입력(작업지시 완료 시). 게이트웨이는 수량을 수집하지 않는다.
- 상태 로그는 변경 시점만 → 첫 로그 이전은 "상태 미확인", 로그 공백은 끊김/안정 구분 불가.
- 계획 시간은 총량(24h 기본), 야간·휴무 포함.
- SIM 로그는 가짜 데이터(`mode: sim`).
- 현재 DB는 2026-08-13 하루치 로그 + 오늘 PRS-01 몇 건이라 기본 7일 창에서는 대부분 설비가 "변경 없음"으로 RUN 100%/0%로 보인다(마지막 상태 유지). 정상 동작이며, 화면이 이유를 표시한다.

### 다음 개선안
- 설비 유형별 OEE 집계(type 그룹) — 한도윤의 유형 체계가 안정되면 추가.
- 알람 리포트의 대응 시간을 OEE 표에 열로 합치기(기대효과 "대응 시간 단축"을 같은 화면에서).
- 상태 로그가 수천 건을 넘으면 `allLogs` 전량 읽기를 기간+직전 1건 쿼리로 바꾼다(현재 196건이라 전량이 단순·안전).

### 열린 질문
- 근무 캘린더(교대 시작 시각·휴무일)를 둘 계획이 있는지? 있으면 계획 시간 정의(§2)를 시간대 기준으로 바꾼다.
