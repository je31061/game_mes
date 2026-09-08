# handoff — 서지안 (설비 연동·생산실적 분석가)

## 라운드 2 — 2026-09-07 완료 (커밋은 라운드 3에서 최민준)

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
