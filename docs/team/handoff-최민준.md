# handoff — 최민준 (MES 운영 리더)

## 라운드 1 (기반) — 2026-09-07 완료

### 한 일
1. **`equipments.type` 컬럼** (`server/db.js`)
   - `TEXT NOT NULL DEFAULT 'generic'`. 새 DB는 CREATE TABLE에 포함, 기존 DB는 마이그레이션으로 컬럼 추가 후 코드 접두로 1회 매핑
     (`inferEquipmentType(code)`: PRS→press, WLD-03→robot, WLD→welder, ASM→assembly, INS→inspector, PKG→packer, CNC→cnc, 그 외 generic).
     이후 관리자가 바꾼 값은 재기동해도 유지된다(컬럼이 이미 있으면 매핑을 다시 하지 않음).
   - export: `EQUIPMENT_TYPES`(8종 배열), `EQUIPMENT_TYPE_LABELS`(한글 라벨), `inferEquipmentType`.
   - `queries.createEquipment`(7번째 인자 type), `queries.updateEquipment`(8번째 인자 type, 마지막이 id).
2. **API** (`server/index.js`)
   - `GET /api/admin/equipments` → `{ equipments, zones, types }` (equipment 객체에 `type`, `types`는 허용 목록).
   - `POST /api/admin/equipments` 본문 `type`(선택, 없으면 코드 접두 추정), `PUT /api/admin/equipments/:id` 본문 `type`(선택, 없으면 유지). 허용 외 값은 400.
   - 배치 JSON `GET/POST /api/admin/layout`: `equipments[].type` 내보내기/가져오기(없으면 유지·신규는 추정, 모르는 값은 경고 후 유지).
   - `init`·`world:refresh`·`equipment:status`의 equipment 객체는 `SELECT *`라 `type`이 자동 포함됨.
3. **관리자 콘솔** (`public/admin.html`, `public/js/admin.js`)
   - 설비 마스터 표에 "유형" select 열 + 신규 행 select(`#n-type`), 맵 에디터 설비 패널에 "유형" select(`#ed-eq-type`). 저장 시 `type` 전송.
   - 라벨은 admin.js의 `TYPE_LABEL`, 목록은 서버 `types`로 덮어씀(유형을 늘릴 때 db.js `EQUIPMENT_TYPES` + admin.js `TYPE_LABEL` 두 곳).
4. **게임 스프라이트 로더** (`public/js/game.js`)
   - 페이지 로드 시 `/assets/equipment/manifest.json` fetch(404·파싱 실패 → null). `FW.startGame`은 그 결과를 기다린 뒤 Phaser 부팅.
   - `FactoryScene.preload()`: `manifest.types[type].file`을 `eq-<type>` 키로 preload. 로드 실패한 유형은 매니페스트에서 제거(콘솔 warn) → 큐브 폴백.
   - `addEquipment(eq)`: 유형이 매니페스트에 있고 텍스처가 있으면 이미지(`setOrigin(anchor.x/w, anchor.y/h)`, 기본 앵커 (96,150)),
     램프는 `lamp{x,y}` 이미지 픽셀 → 컨테이너 좌표 `(x-anchor.x, y-anchor.y)`, 라벨 y = `labelY - anchor.y`(labelY 기본 0).
     클릭은 이미지 자체 `setInteractive({ pixelPerfect: true, alphaTolerance: 24 })` — 투명 픽셀은 뒤 설비로 통과. 없으면 기존 큐브 + 존 히트.
   - 깊이 정렬(`x+y`), 근접 링, 알람 점멸(저사양 모드는 정적 광원), `setEquipmentStatus`는 두 경로 공통.
   - `reloadWorld`: 위치·이름에 더해 `type`이 바뀌면 스프라이트 재생성.
5. **분석 탭 훅**
   - `admin.html`: 탭 버튼 `data-tab="analytics"`(📈 실적 분석), `<div class="tabview" id="tab-analytics"></div>`,
     `<link href="css/analytics.css">`, `<script src="js/analytics.js">`(admin.js 다음).
   - `admin.js`: 탭 활성화 시 `mountAnalytics()` → `window.FWAnalytics.mount($('tab-analytics'), api)`. `api(path, opts)`는 인증 fetch 래퍼(JSON 반환, 401/403이면 게이트로).
     FWAnalytics가 없으면 "미배치" 안내를 컨테이너에 표시. mount가 throw하면 콘솔 error + 안내.
   - `index.js`: `await import('./analytics.js')`를 try로 감싸 `registerAnalytics(app, { requireAdmin, db, queries, settings })` 호출.
     파일 없음은 log, 그 외 오류(문법 오류 등)는 error 로그 후 서버 계속 기동. 위치: "게임 상태 (메모리)" 섹션 바로 위(관리자 라우트 정의 이후).
   - `index.js`: `public/js/analytics.js`·`public/css/analytics.css`가 없을 때 빈 JS/CSS를 200으로 응답하는 대체 라우트(콘솔 404 방지).
     실제 파일을 두면 `express.static`이 먼저 응답하므로 자동 무효.
6. `public/assets/equipment/manifest.json` — 인터페이스 §2 형식, `types: {}`.
7. 문서: README(스프린트 1 절·구조), `docs/도면-AI-연동.md`(`type` 필드·프롬프트), `docs/layout-sample.json`(type 추가).

### 검증 결과 (2026-09-07, 이 PC, 실제 DB)
- `node --check`: server/*.js, server/drivers/*.js, public/js/*.js, scripts/*.js 전부 통과.
- 서버 재기동 로그: `[db] equipments.type 컬럼 추가 — 코드 접두로 11대 유형 매핑`, `[analytics] server/analytics.js 없음 — 분석 API 미등록`.
- DB 확인: 11대 type = press×3, welder×2, robot×1, assembly×2, inspector×1, packer×1, cnc×1 (모두 generic 아님).
- 관리자 콘솔(브라우저 패널 관리자 세션): 콘솔 오류 0. 설비 마스터 11행 유형 select 값이 DB와 일치, 신규 행 select 8종, 맵 에디터에서 WLD-03 클릭 → 패널 유형 `robot`. 📈 탭 클릭 → 미배치 안내 표시.
- API(관리자 토큰): PUT type=spaceship → 400, PUT generic→cnc 왕복 200·반영, POST type 없이 PRS-99 → press 추정, POST type=nope → 400,
  layout 내보내기에 11대 type 포함, layout 가져오기 `{code, type:'weird'}` → 경고 후 유지. `/api/admin/analytics/oee` → 404(미등록). 테스트 설비 PRS-99는 DB에서 삭제(현재 11대).
- 게임 화면(저장된 토큰으로 소켓 연결 → `FW.startGame(init)`, 비밀번호 미입력): 매니페스트 v1·유형 0종 → 11대 전부 큐브, 콘솔 오류 0.
  브라우저에서 만든 192×192 캔버스를 `eq-press` 텍스처로 넣고 매니페스트 `{press:{lamp:{x:118,y:52},labelY:8}}`를 흉내낸 뒤 `reloadWorld`로 유형 변경 재생성:
  press 3대 이미지, 램프 컨테이너 좌표 (22,-98), 라벨 y -142, 원점 (0.5, 0.78125), pixelPerfect 히트: 불투명 픽셀 → 해당 설비, 투명 모서리 → 뒤 설비(PRS-01), 바닥 → 없음.
  ALARM 설정 시 램프 색 ef4444, 저사양 모드라 점멸 대신 정적 광원(규칙대로). 이 검증 세션은 소켓 해제·페이지 재로드로 정리.
- 부하 테스트: 이번 라운드는 스키마/클라이언트 변경만이라 미실행(라운드 3에서 재실행 예정).

### 한도윤에게 (라운드 2)
- 산출물 위치: `public/assets/equipment/<type>.png` + `manifest.json`(현재 빈 types를 덮어쓰면 됨). 스크립트는 `assets/blender/`.
- 게임이 읽는 것: `types[type].file`(필수), `lamp{x,y}`(없으면 앵커 위 100px), `labelY`(없으면 0 = 이미지 상단). `anchor`는 최상위(기본 96,150). 캔버스 크기는 실제 이미지 크기로 계산하므로 192가 아니어도 동작하지만 규격은 192×192.
- 클릭은 불투명 픽셀 기준이라 바닥 그림자를 완전 투명에 가깝게 두면 그림자 클릭은 통과한다(alphaTolerance 24/255 미만은 무시). 실사 몸통은 알파 255 권장.
- 램프는 게임이 반지름 5(광원 9)의 원으로 그린다. 경광등 몸통을 모델에 넣고 그 위 좌표를 lamp로 적어 달라.
- 라이트 테마(흰 바탕)·저사양 모드에서도 확인 부탁. 확인은 관리자 콘솔 설비 마스터에서 유형만 바꾸면 접속자 맵에 즉시 재생성됨.
- 파일이 없는 유형은 콘솔 warn 후 큐브로 떨어지므로, 7종을 한꺼번에 내지 않아도 된다.

### 서지안에게 (라운드 2)
- 서버: `server/analytics.js`에 `export function registerAnalytics(app, { requireAdmin, db, queries, settings })`. 라우트 3개는 인터페이스 §4. `db`는 `node:sqlite` DatabaseSync(`db.prepare(...).all()`), `queries.listEquipments`(type 포함)·`queries.todayLogs` 등 재사용 가능. `settings.get('policy', {})`에 `shiftMinutesPerDay`가 있으면 계획 시간으로 사용(현재는 없음 → 24h).
- 화면: `public/js/analytics.js`가 `window.FWAnalytics = { mount(container, api) }`를 정의. `api('/api/admin/analytics/oee?from=..&to=..')`처럼 호출(JSON 반환, 실패 시 throw — `e.message !== 'auth'`면 사용자에게 표시). 탭을 다시 열 때마다 mount가 호출되니 멱등하게(컨테이너 innerHTML 갱신).
- 스타일: `public/css/analytics.css`. 테마 변수는 `public/css/style.css`(`--text --muted --panel --border --run --idle --stop --alarm --accent`), 라이트 테마는 `html[data-theme=light]`.
- 두 파일이 없을 때 서버가 빈 JS/CSS를 대신 주고 있으니 파일을 두는 순간 자동 전환. 문법 오류가 있으면 서버 로그 `[analytics] ... 로드 실패`로 표시되고 서버는 계속 뜬다.
- 데이터: `equipment_status_log`(상태 이력, `changed_at` 로컬 시각 문자열 'YYYY-MM-DD HH:MM:SS'), `production_records`(qty_good/qty_defect, `created_at`), `work_orders`(target_qty, status, completed_at), `equipments.data_source`(JSON 문자열, protocol). 게이트웨이 수집 이력은 `equipment_status_log.changed_by = gateway 계정 id`(users.emp_no='gateway').

### 열린 질문
- 유형을 7종 이상으로 늘릴 때(한도윤 제안권): db.js `EQUIPMENT_TYPES` + admin.js `TYPE_LABEL` 두 곳을 최민준이 고친다. 협업로그에 제안만 남기면 됨.
- 이미지 스프라이트의 클릭 영역이 이웃 타일까지 넓어질 수 있음(192px). pixelPerfect로 완화했지만 현장 태블릿에서 오클릭이 있으면 히트 영역을 바닥 마름도 중심 반경으로 바꾸는 안을 라운드 3에서 검토.
