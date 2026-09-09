# handoff — 최민준 (MES 운영 리더)

## 스프린트 2 라운드 1 (기반: 스키마·BOP API·단품 HUD·라인 전환) — 2026-09-09 완료

### 한 일 (전부 내 소유 파일)
1. **스키마** (`server/db.js`): `products / processes / parts / process_inputs` 테이블(§7 정의 그대로, CREATE IF NOT EXISTS), 마이그레이션 `equipments.op TEXT`, `equipments.hidden`·`zones.hidden INTEGER DEFAULT 0` (기존 DB 기동 시 자동, 로그 `[db] equipments.op 컬럼 추가` 등 3줄, 재기동 시 무출력 = 멱등).
   `EQUIPMENT_TYPES` 16종(§9 8종 추가), `EQUIPMENT_TYPE_LABELS`, `inferEquipmentType`에 OP-* 표(§9)와 접두 STK/WND/VPI/OVN/MAG/BAL/DSP/SMT 추가.
   `queries.listEquipments / listZones / listLinks(양끝) / alarmEquipments`에 `hidden = 0` — 이 쿼리를 쓰는 init·world:refresh·근접 판정·부하 틱·대시보드·알람 리포트·분석·게이트웨이·내보내기가 자동 제외. 전체 조회는 `listAllEquipments / listAllZones`. BOP 쿼리 14개(`upsertProduct … equipmentsByOp`).
2. **API** (`server/index.js`)
   - `POST /api/admin/bop/import` 본문 = bldc JSON → 트랜잭션 upsert. 응답 `{ ok, product, subassemblies, parts, processes, inputs, stages, warnings }`. `product.code` 없음·`processes` 비면 400.
   - `GET /api/admin/bop?product=` → `{ products, product:{code,name,spec,lineBalance,source,importedAt}, processes:[{id,op,seq,line,name,equipmentHint,ctSec,kind,qc,note,output,stagePn,inputCount,equipments:[{id,code,name,hidden}]}], summary:{processes,parts,inputs,linked,unlinked:[op]} }`.
   - `GET /api/bop/exploded?product=` (로그인 사용자, `X-Auth-Token` 또는 `?token=`) → `{ product:{code,name}, stages:[{stage,pn,file,label,group,processes:[op]}], final:[op] }`.
   - `POST /api/admin/bop/apply-sample` → `docs/bldc/bldc-500w-48v.json` → `layout-bldc-500w.json` 순서 적용, `{ ok, bop, layout }`. 파일 없으면 404.
   - 배치 JSON: `importLayout(body)`로 분리. `equipments[].op`(null/''=해제, BOP에 없는 op는 경고 1줄로 합침), `replace: true` → 파일에 없는 설비(설비 목록 있을 때)·존(존 목록 있을 때) `hidden=1`, 파일에 있는 것은 `hidden=0` 복원. 응답에 `hidden`·`restored`·`opLinked` 카운트. 내보내기에 `op` 포함, 숨김 제외.
   - `GET /api/admin/equipments` → `equipments`(숨김 포함, `hidden`·`op`), `zones`(보이는 것), `hiddenZones`, `types`(16), `processes`(공정 select용). `POST/PUT` 본문 `op`, `PUT` 본문 `hidden`(복원 시 속한 존도 복원, `{hidden}`만 보내면 그것만 처리), `PUT /api/admin/zones/:id` 본문 `hidden`.
   - `equipment:detail` 응답 `process`(§7 블록 + `product`, `stage.stage`) — op 미연결·BOP 없음이면 null.
3. **현장 상태창** (`public/index.html`, `public/js/app.js`, `public/css/style.css`): "공정 · 단품" 섹션(`#eq-proc-section`, 공정 없으면 `hidden`), 공정유형 칩(병목=적, 배치=황, QC=청, 완성=녹), 정보 grid(공정·라인·C/T·설비(BOP)·품질 관리·비고), 투입 단품 표(썸네일 34×50 = 단품 이미지 → 부모 → 공정 단계 이미지, P/N·품명·상위 어셈블리, 규격, 수량/단위), 산출물+분해도 단계, **🔩 분해도** → `#exploded-panel`(9단계 + 완성품 카드, 현재 단계 `.cur`, 완성품 공정은 전체 `.cur`, 내 op는 `b.me`로 표시, ESC/✕ 닫기, `world:refresh` 시 캐시 무효화).
4. **관리자 콘솔** (`public/admin.html`, `public/js/admin.js`): `TYPE_LABEL` 8종 추가, 설비 마스터 "공정" select(`.e-op`, `#n-op`)·숨김 행(흐림 + "숨김" 칩 + [복원])·보이는 행 [숨김] 버튼, 맵 에디터 설비 패널 "공정" select(`#ed-eq-op`), 존 목록 아래 "숨긴 존 N개 [복원]", 배치 데이터 아래 **제품 라인** 카드([🔩 제품 라인 적용 (BLDC 500W)] `#lay-apply-sample`, [BOP JSON 가져오기] `#bop-import`, 현황 줄 `#bop-info` = `GET /api/admin/bop` 요약). 에디터 맵은 숨긴 설비를 그리지 않음.
5. **다크 테마 버그 수정** (`style.css`): `--input/--overlay/--toast-bg`가 `var(--input)`처럼 자기 참조라 무효 → 상태창·패널·입력 배경이 투명이던 문제(초기 커밋부터). `#0e1220 / rgba(22,26,38,.96)`로 지정. 라이트 값은 그대로.
6. 문서: README(사용법 4·관리자 콘솔·구조·스프린트 2 절), `docs/도면-AI-연동.md`(`op`·`replace`·유형 15종), 인터페이스 §7 구현 메모·§8 썸네일 경로 메모.

### 실제 DB 적용 결과 (2026-09-09 22:35, 적용 전 백업 `OneDrive/FactoryWorld-백업/fw-backup-20260909-223507`)
- 콘솔 [제품 라인 적용] 1회: BOP 공정 24·단품 49(+서브어셈블리 9 = parts 56행, FS-7010·FS-7020 중복은 L1 우선)·투입 36·분해도 9단계 / 배치 존 +2·숨김 4, 설비 +24·숨김 11(PRS-01~03, WLD-01~03, ASM-01~02, INS-01, PKG-01, CNC-01)·복원 0, 라인 +23. 경고 0.
- DB: equipments 35(hidden 0 = 24, 1 = 11), zones 6(2/4), processes 24, process_inputs 36, parts 56(L1 9·이미지 7 / L2 46 / L3 1), equipment_links 27(숨긴 양끝 4개는 listLinks에서 제외 → 23).
- `GET /api/admin/bop` summary `linked 24 / unlinked []`. 보이는 유형 분포: press 4·assembly 7·inspector 3·stacker/winder/vpi/oven/dispenser/magnetizer/balancer/smt/robot/packer 각 1.

### 검증 결과 (이 PC, 서버 재기동 2회, 관리자 세션 토큰 — 비밀번호 미입력)
- `node --check` server/*.js(7)+drivers(5)+public/js(4)+scripts(4) = 20파일 통과. 기동 로그에 마이그레이션 3줄, 재기동 시 없음.
- API(node 스크립트): 적용 전 11대/hidden 0/processes 0 → 적용 후 위 수치. 내보내기 `equipments 24·withOp 24·links 23`, exploded 9단계(+final B110·B120), 분석 OEE `equipments 24`(서지안 라우트가 hidden 자동 제외), 게이트웨이 대상 0(파일럿 data_source 설비가 숨겨짐), overview 24/2, 알람 리포트 24대 기준. 오류 처리: BOP 본문 불량 400, 인증 없음 401, 알 수 없는 op → 경고 1건, `type=stacker` PUT 200.
- 숨김 왕복: PRS-01 복원 → `hidden 0`, 프레스 존 자동 복원, overview·내보내기 25대 → 다시 숨김 + 존 숨김 → 24/11·2/4 원복.
- 콘솔(브라우저 패널): 맵 에디터 24대·2존·라인 23, `#bop-info` "공정 24 · 단품 56 · 투입 36 · 설비 연결 24/24 · 전 공정 연결됨", 숨긴 존 4개 복원 버튼, 설비 마스터 35행(보이는 24행 공정 select 값 = op, 숨김 11행 [복원]), 유형 select 16·공정 select 25 옵션. 앱 콘솔 오류 0(내 400/401 시험·재기동 중 연결 거부만).
- 게임(브라우저 패널, 저장된 관리자 토큰으로 로그인 흐름 재현 후 소켓 연결): 토스트 "2개 존 · 설비 24대 — 출근 완료", 스프라이트 24대 전부 이미지(한도윤 매니페스트 15종이 이미 배치되어 있어 큐브 0 — 폴백 경로는 코드상 유지), 라인 23. OP-A40 클릭 → "공정 · 단품 [병목]" 공정 OP-A40 Needle Winding·아마추어 라인 4번째·C/T 90초·설비 니들 와인더·QC "U/V/W 각 45T, 장력 250gf"·비고 "병렬 2대 권장", 단품 표 1행 MW-1030 Magnet Wire ↳ Stator Assy 동선 φ0.80 180 g(썸네일 SA-1000.png 325×484 로드), 산출물 "3상 권선 스테이터 · 분해도 1단계". 🔩 분해도: 제목 BLDC 모터 500W 48V, 카드 10(9단계+완성품), SA-1000만 강조, 이미지 9장 로드, 내 op 표시. OP-B120(완성) → 10/10 전체 강조, final OP-B110·OP-B120. OP-A20 → "투입 단품 없음 — 전공정 산출물을 가공 (블랭킹편 ×80)". 라이트 테마(HUD 배경 rgba(255,255,255,.97))·다크 모두 스크린샷 확인.
- 기존 기능: 근접 — (8.5,3.5)로 이동 → 니들 와인더·결선/포밍 지그 채널 자동 입장·근접 링, 두 번째 소켓 접근 → "『니들 와인더』 대화방 활성화 (2명)" 토스트·채팅 패널 자동 열림·참여 2명. 상태 변경 — RUN 클릭 → 램프 34d399·이력 1행·상태창 갱신, 공정 섹션 유지. 라인 부하 — A40 RUN 6.5초 후 A40→A50 링크 16%·flowing·라벨 "16%"; 정리로 A40 IDLE·A50 RUN 8.5초 후 29%까지 배출 확인, A50 IDLE. 검증 소켓 disconnect, 상태 원복(IDLE). 상태 로그에 검증 4건 남음(append-only).
- 부하 테스트: 스키마·HUD 변경이라 이번 라운드 미실행 → 라운드 2에서 24대 기준 재실행.

### 한도윤에게 (라운드 2에서 반영·답변)
- (1) 확인 완료: 24대 전부 이미지 스프라이트, 다크·라이트 스크린샷에서 램프가 경광등 위, 라벨 겹침 없음(A라인 2칸 간격도 판독 가능). 재생성 요청 없음. 큐브 폴백 경로는 코드에 남아 있다(매니페스트에서 유형을 빼면 즉시 큐브).
- (2) §8에 썸네일 경로 메모 추가함. 라운드 2에서 상태창 표를 `/assets/parts/thumb/<pn>.png` 우선 + 원본 폴백으로 바꾼다.
- (3) 커밋 대상 목록 확인. 이번 라운드 1 커밋은 내 파일 + PM 원천(`docs/bldc`, `scripts/bldc`, `public/assets/parts/*.png` 원본 9장)만. 한도윤 산출물(PNG 15·manifest·blender 스크립트·thumb 9)은 라운드 2 통합 커밋.
- (4) labelY 조정 필요 없음.

### 서지안에게 (라운드 2에서 반영·답변)
- (2) `unlinked` 정의 동일: `equipments.op = processes.op`, `hidden = 0`인 설비가 하나도 없는 공정. 24/24 일치.
- (3) 병렬은 자동 반영하지 않는다(현재 정책 유지). 같은 op 설비 2대는 `linkedCount 2`로만 보이면 된다.
- (5) 중복 제외 무해 — 그대로 두어도 된다. `queries.listEquipments`가 원천.
- (6) SIM 연동은 이번 스프린트에 붙이지 않는다(PM 결정 없음). 데모가 필요하면 맵 에디터에서 설비별 `sim` 지정으로 언제든 가능.
- (1) README·가이드 §3-1 라인 밸런스 한 줄은 라운드 2 통합 때.
- 참고: `products.spec_json.lineBalance`에 xlsx 12_Line_Balance 기준값 원문이 있다(`GET /api/admin/bop`의 `product.lineBalance`).

### 열린 항목 / 라운드 2 할 일
- 두 사람 산출물 통합 커밋·push, 부하 테스트(24대), README·운영 가이드·브리프 갱신, 썸네일 경로 전환, 분석 §3-1 문구.
- 분해도 5·6단계(FS-7010·FS-7020)는 BOP에 `stagePn`으로 지정된 공정이 없어 "공정 미정"으로 표시된다 — 원천 JSON(PM) 그대로. 필요하면 B85/B87 앞의 축 조립 공정을 추가하거나 stagePn을 보완.
- `equipments.op`는 제품 1개 전제(`processByOp`). 제품이 늘면 `equipments.product_code` 추가.
- 상태창 스크롤: 섹션이 아래쪽이라 태블릿에서는 스크롤이 필요하다. 접힘/펼침 토글은 현장 의견 후.
- 브라우저 패널의 관리자 세션 토큰은 이번 라운드에 서버 시크릿으로 새로 발급해 `localStorage.fw.adminToken`에 두었다(12h). 비밀번호는 입력하지 않았다.

## 라운드 3 (통합) — 2026-09-08 완료

### 반영한 요청
| 발신 | 요청 | 결과 |
|---|---|---|
| 한도윤 | (1) 11대 스프라이트·램프·라벨 실제 화면 확인 | 다크·라이트·저사양(30fps, 점멸 정지) 모두 11대 이미지. 램프 좌표 매니페스트−앵커 일치, 3배 컨택트 시트로 7종 램프가 경광등 위·라벨선이 최고점 위 확인. **재생성 요청 없음** |
| 한도윤 | (2) `.gitignore`에 `assets/blender/out/` | 추가 (`git check-ignore` 확인) |
| 한도윤 | (3) 그림자 클릭 통과 정책 | **통과로 결정.** 매니페스트·`SHADOW_A_MIN` 유지, `game.js` `SPRITE_HIT_ALPHA = 64`. 인터페이스 §3에 계약 추가(그림자 ≤ 63, 본체 ≥ 64). 검증: 7종 그림자 픽셀 히트 0 / 본체 픽셀 히트 100% |
| 한도윤 | (4) 카메라 63.435° 인용 정정 | README·가이드·브리프에 인용 없음 → 정정 대상 없음. §2 60° 수용 |
| 서지안 | (1) `policy.shiftMinutesPerDay` 입력란·검증 | `admin.html` `#pol-shift`(1~1440, 비우면 24h) + `admin.js` 클라이언트 검증 + `index.js` `normalizeShiftMinutes`·`PUT /api/admin/policy` 400 처리. `GET /api/admin/policy`에 `shiftMinutesPerDay`(null=미설정) 포함 |
| 서지안 | (2) README·운영 가이드 📈 한 줄 + 분석-정의 링크 | README 관리자 콘솔 절·스프린트 1 절, 가이드 §3·§3-1·체크리스트 |
| 서지안 | (3) 상태창 가동률 라벨 구분 | `index.html` "금일 가동 비율 (로그 구간 기준)" + 툴팁, `admin.html` 대시보드 "가동률 (로그 구간)" + 툴팁 |
| 서지안 | (4) 게이트웨이 폴링 카운트 표 | 스프린트 2 후보 1순위 (아래) |

되돌린 산출물: 없음. 두 사람의 파일은 규격(192×192 RGBA·매니페스트 키 / `registerAnalytics` 시그니처·`FWAnalytics.mount`·`.fwa-*` css)과 일치.

### 커밋·push
- `97445eb` 스프린트 1 라운드 3: 실사형 설비 스프라이트 7종·실적 분석(OEE) 통합 — 30파일(스프라이트 PNG 7장·매니페스트, blender 스크립트 3개, analytics 3파일, 분석-정의, 공용 파일·문서). `data/`·`assets/blender/out/` 제외.
- push: `origin/main` `10b2b48..97445eb` (라운드 1 커밋 `ffa966e` 포함). 이후 `git status` 클린.

### 코드 변경 (이번 라운드, 전부 내 소유 파일)
- `public/js/game.js`: `SPRITE_HIT_ALPHA = 64` 상수, `setInteractive({ pixelPerfect, alphaTolerance: SPRITE_HIT_ALPHA })`.
- `server/index.js`: `normalizeShiftMinutes()`, `getPolicy()`에 `shiftMinutesPerDay`, `PUT /api/admin/policy`에 shift·retention 검증(400).
- `public/admin.html`·`public/js/admin.js`: 운영 정책 카드 입력란·저장·클라이언트 검증, 대시보드 가동률 라벨.
- `public/index.html`: 상태창 가동률 라벨.
- `.gitignore`: `assets/blender/out/`.
- `docs/team/인터페이스.md` §3: 클릭 알파 임계값 64 계약(내 소유 절).
- 문서: README(스프린트 1 절 완성·구조·파이프라인·검증 수치·스프린트 2 후보), `docs/운영전환-가이드.md`(§3 정책·§3-1 분석·§4 수치·체크리스트), `docs/design-brief.md`(§3 구축 순서 8·새 절, §4 현재 상태).

### 검증 결과 (2026-09-08, 이 PC, 실제 DB, 서버 재기동 후)
- `node --check`: server/*.js(7) + server/drivers/*.js(5) + public/js/*.js(4) + scripts/*.js(4) = 21파일 통과.
- 서버 로그: `[analytics] server/analytics.js 로드 — /api/admin/analytics/* 등록`.
- 관리자 콘솔(브라우저 패널 관리자 세션, 라이트 테마): 📈 탭 렌더 — 요약 타일 4개, 설비별 OEE 막대 11대, 표 3개, SVG 2개, `FWAnalytics` 로드. 설비 마스터 유형 select 11행 = DB(press×3, welder×2, robot, assembly×2, inspector, packer, cnc), 신규 행 8종, 맵 에디터 `#ed-eq-type` 존재. 정책 카드 `#pol-shift` min 1 / max 1440. 앱 콘솔 오류 0(내 검증 호출의 401/400만).
- 정책 API: PUT shift 0·2000·480.5·'abc' → 400; 480 → 200, OEE `range.shiftMinutesPerDay=480, shiftConfigured=true`, WLD-01(08-13) 가동률 0.0702 → 0.2106(=101.1/480); retention만 PUT → shift 480 유지; null → 200, OEE 1440 복귀. 정책 원상 복원(null).
- 게임 화면(저장된 토큰으로 소켓 연결 → `FW.startGame`, 비밀번호 미입력, 검증 후 disconnect): 매니페스트 v1·7종, 11대 전부 `isImage`. 램프 컨테이너 좌표 press (14,−64) welder (18,−30) robot (23,−27) assembly (11,−45) inspector (10,−53) packer (−5,−38) cnc (16,−47), 라벨 y −80/−57/−51/−61/−69/−54/−76. 히트 콜백 검사(2px 간격 샘플): 그림자(알파 28~60) 295~430개/장 히트 0, 본체(255) 268~697개/장 히트 100%. 라이트·다크 스크린샷, 저사양 모드 fps 30·알람 tween 전부 paused. 브라우저 테마는 라이트, 저사양 해제로 복원.
- 부하 테스트(`FW_DATA_DIR=data-loadtest PORT=3001`, 50명 30초): 접속 50/50·오류 0, 이동 수신 9,876건·손실 1건·p50 6.0ms·p95 **21.1ms**·max 27.0ms, 채팅 수신 5,250건·p50 1.7ms·p95 **10.1ms**·max 28.1ms → 통과(NFR-01). 테스트 서버 종료·`data-loadtest/` 삭제.

### 한도윤에게 (다음 라운드)
- `postprocess.py` 주석 "게임 alphaTolerance 24 → 최소 28"을 "게임 임계값 64: 그림자 28~60 통과, 본체 ≥ 64"로 갱신(파일은 한도윤 소유).
- 스프라이트·좌표 재생성 불필요. `generic` 실사 스프라이트·4방향 렌더·footprint는 스프린트 2 후보 — 의견을 협업로그에.

### 서지안에게 (다음 라운드)
- `shiftMinutesPerDay`는 운영 정책 카드에서 설정 가능. 분석-정의 §2에 "관리자 콘솔 → 사용자 관리 → 운영 정책"으로 설정 위치 한 줄 추가 부탁(문서는 서지안 소유).
- 게이트웨이 폴링 카운트 표는 스프린트 2 후보 1순위. 원하는 컬럼(설비·시각·성공/실패·지연 ms·오류 코드?)을 제안해 주면 스키마는 내가 만든다.

### 스프린트 2 후보 (세 명 의견 수렴 후 PM 결정)
1. 게이트웨이 폴링 수신/실패 카운트 표 `gateway_samples` — "연결 끊김 vs 상태 안정" 구분 (서지안, 스키마·수집은 최민준)
2. 가동률 정의 통일 — 상태창·대시보드 `todayUptime`을 분석 정의(계획 시간 분모)로 (서지안)
3. 설비 방향(회전) 필드 + 4방향 렌더 (한도윤, 맵 에디터·로더는 최민준)
4. 상태별 애니메이션 프레임(RUN 시 공정품 이동) — 로더 프레임 훅 (한도윤)
5. 유형별 OEE 집계, 알람 대응 시간을 OEE 표에 합치기 (서지안)
6. `generic` 실사 스프라이트 — 큐브 폴백 유지 여부 (한도윤)
7. 타일 2칸 설비 `footprint {w,h}` (한도윤, 계약 변경)

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
