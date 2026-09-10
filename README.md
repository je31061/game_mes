# Factory World — 게임형 MES (MVP)

기획서 『게임형 MES 시스템 구축 기안 및 기본설계서』 Phase 1의 MVP 구현.

## 다른 PC에서 시작하기 (이어서 작업)

1. **Node.js 설치**: https://nodejs.org 에서 LTS(24 권장, 최소 22.5) 설치
2. **저장소 클론**:
   ```
   git clone https://github.com/je31061/game_mes.git
   cd game_mes
   npm install
   npm start
   ```
   push 권한이 필요하면 GitHub Desktop 또는 `gh auth login`(웹 브라우저 인증)이 가장 간단함
3. http://localhost:3000 접속 — DB가 없으면 자동 생성·시드됨 (관리자: `admin` / `관리자` / `admin1234`)
4. **기존 파일럿 데이터를 이어가려면**: 백업 폴더(`FactoryWorld-백업\fw-backup-*` 또는 `backups\fw-backup-*`) 중
   최신 폴더에서 `factory.db`, `uploads`, `jwt.secret`을 프로젝트의 `data\` 폴더에 복사한 뒤 서버 시작.
   (루트가 아니라 반드시 `data\` 아래여야 서버가 읽습니다.)
   백업 없이 시작하면 초기 시드 데이터(설비 10대·4존)로 새로 시작됨.
   BLDC 500W 제품 라인(설비 24·공정 24)으로 바로 시작하려면 환경변수 `FW_SEED_PRODUCT_LINE=bldc`를 주고 시작(빈 DB에 1회 자동 적용)하거나,
   시작 후 관리자 콘솔 → 맵 에디터 → [🔩 제품 라인 적용 (BLDC 500W)]
5. Claude Code로 이어서 개발할 때는 프로젝트 폴더를 열고 이 README를 읽게 하면 전체 맥락 파악 가능

## 실행

요구 사항: Node.js 22.5+ (`node:sqlite` 내장 버전, 24 LTS 권장). 외부 DB·Docker 불필요.

```
npm install
npm start
```

브라우저에서 http://localhost:3000 접속. (`data/` 폴더에 SQLite DB와 업로드 파일이 자동 생성됩니다.)

`start.cmd`를 더블클릭해도 됩니다. PATH의 `node`를 우선 쓰고, 없으면 무설치 Node.js
(`%USERPROFILE%\dev\tools\node-v24.19.0-win-x64`)를 찾으며, `node_modules`가 없으면 자동으로 `npm install`합니다.

## 백업 · 운영 (NFR-04)

- 서버가 켜져 있으면 **매일 03시(`FW_BACKUP_HOUR`)에 자동 백업**하고, 관리자 대시보드에서 [지금 백업]도 가능
- 수동 실행: `node scripts/backup.js [대상폴더]` 또는 `backup.cmd [대상폴더]`
- 대상 폴더 생략 시 환경변수 `FW_BACKUP_DIR` → OneDrive(회사 계정 우선)의 `FactoryWorld-백업` →
  프로젝트의 `backups/` 순. DB는 서버 가동 중에도 안전한 `VACUUM INTO` 스냅샷이며,
  업로드 파일과 `jwt.secret`을 함께 복사하고 최근 14개만 보존
- `start.cmd`는 서버가 오류로 종료되면 3초 후 자동 재기동. 클라이언트는 끊기면 자동 재접속
- 환경 변수(`PORT`, `FW_DATA_DIR`, `FW_TLS_CERT/KEY` 등), HTTPS, 복구 절차, PostgreSQL/MinIO 전환 경로는
  [docs/운영전환-가이드.md](docs/운영전환-가이드.md) 참조

## 외부에서 접속하게 하기

- **체험 서버 (Render, 공개)**: https://factory-world.onrender.com — GitHub `main`에 push하면 `render.yaml`(Blueprint) 설정으로 자동 재배포됩니다.
  무료 플랜이라 15분 미접속 시 절전(첫 접속 30~60초), 재배포마다 DB가 초기화되지만 `FW_SEED_PRODUCT_LINE=bldc`로 매번 **BLDC 500W 라인(설비 24·공정 24)**으로
  시작해 설비 클릭 → 공정·단품·분해도가 바로 보입니다. 관리자 로그인은 `admin` / `관리자` / Render 환경변수 `FW_ADMIN_PASSWORD`로 정한 비밀번호(배포한 사람만 앎).
  같은 설정으로 새로 배포: [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/je31061/game_mes)
- **무료 웹 배포 (Koyeb, 카드 불필요)**:
  [![Deploy to Koyeb](https://www.koyeb.com/static/images/deploy/button.svg)](https://app.koyeb.com/deploy?type=git&repository=github.com/je31061/game_mes&branch=main&name=factory-world&builder=dockerfile&instance_type=free&regions=was&ports=3000;http;/&env[FW_SELF_REGISTER]=false&env[FW_ADMIN_PASSWORD]=CHANGE-ME&env[FW_JWT_SECRET]=CHANGE-ME-TO-A-LONG-RANDOM-STRING&env[FW_SEED_PRODUCT_LINE]=bldc)
  버튼을 누르고 `FW_ADMIN_PASSWORD`·`FW_JWT_SECRET` 두 값을 바꾼 뒤 Deploy → `https://factory-world-<계정>.koyeb.app` 주소가 생깁니다.
  무료 인스턴스는 미접속 시 절전(첫 접속 수십 초), 재배포 때 DB 초기화(`FW_SEED_PRODUCT_LINE=bldc`면 BLDC 라인으로 재시작) — 절차와 한계, 대안은 [docs/배포-가이드.md](docs/배포-가이드.md)
- **사내망**: 서버 PC에서 실행해 두고 `http://<서버 IP>:3000`으로 접속. Windows 방화벽에서 3000 포트 인바운드 허용
- **임시 외부 공개(시연용)**: `tunnel.cmd` 실행 → 출력되는 `https://xxxx.trycloudflare.com` 주소를 공유
  (Cloudflare Quick Tunnel, 계정 불필요, 창을 닫으면 주소가 사라짐. 설치: `winget install Cloudflare.cloudflared`)
- 공개 전에 관리자 비밀번호를 바꾸고, 필요하면 운영 정책에서 "신규 사번 자동 등록"을 끄세요.
  정식 외부 공개(HTTPS·상시 가동)는 [docs/운영전환-가이드.md](docs/운영전환-가이드.md) 참조
- 소개 페이지·문서는 GitHub Pages로 공개: https://je31061.github.io/game_mes/

## 부하 테스트 (NFR-01)

```
# 터미널 1: 운영 DB와 분리된 테스트 서버
set FW_DATA_DIR=data-loadtest && set PORT=3001 && npm start
# 터미널 2: 동시 50명, 60초
node scripts/load-test.js --users 50 --duration 60 --url http://localhost:3001
```

이동 동기화(p95 ≤ 200ms)·채팅 전달(p95 ≤ 1초) 지연과 손실을 측정해 기준 충족 여부를 판정합니다.
테스트 서버에 `FW_SEED_PRODUCT_LINE=bldc`를 함께 주면 BLDC 라인(설비 24·라인 23) 기준으로 잽니다.
최근 결과(2026-09-10, BLDC 24대·라인 23, 50명 30초): 접속 50/50 · 오류 0 · 이동 p50 7.8ms / p95 18.9ms / max 25.0ms(수신 9,903건 중 손실 4건) · 채팅 p50 2.0ms / p95 9.4ms / max 17.1ms → 통과.
(이전: 2026-09-08 파일럿 11대 — 이동 p95 21.1ms · 채팅 p95 10.1ms)

## 사용법

1. 사번 + 이름 + 비밀번호 → 로그인 (JWT 12시간 세션)
   - 신규 사번: 입력한 비밀번호로 자동 등록 (파일럿 정책)
   - 기존 사용자: 첫 로그인 시 입력한 비밀번호가 등록됨
   - 관리자 초기 계정: `admin` / `관리자` / `admin1234` (변경 권장)
   - 역할: 작업자(기본) / 보전 / 관리자 — 설비 상태 변경은 보전·관리자만,
     역할 부여는 관리자 콘솔 → 사용자 관리
2. 캐릭터 색상/닉네임/직무 뱃지 설정 → 출근하기
3. 이동: 방향키/WASD 또는 맵 클릭
4. 설비 클릭 → 상태창(HUD): 상태/지속시간/금일 가동률(HP바)/목표 대비 진행률(경험치바, 작업지시 목표수량 대비 금일 양품)/이력/첨부,
   상태 수동 변경, 📣 담당자 호출(담당자 이름과 같은 접속자에게 알림 + 설비 이력 기록)
   - **공정 · 단품**(스프린트 2): 설비에 공정(BOP)이 연결되어 있으면 공정번호·공정명·라인·C/T·공정유형(표준/병목/배치/QC/완성)·품질 관리 항목과
     **투입 단품 표**(서브어셈블리 썸네일 — `assets/parts/thumb/<PN>.png` 96×96, 없으면 원본으로 폴백 — ·P/N·품명·규격·수량/단위), 산출물이 표시된다. **🔩 분해도** 버튼은 제품 분해도 9단계를
     조립 순서대로 가로 스크롤로 보여 주고 이 설비의 단계를 강조(완성품 공정은 전체 강조). 공정이 없는 설비는 섹션이 숨겨진다
   - 출근 시 "출근 브리핑" 팝업: 진행 중 알람, 모집 중 작업지시, 오늘의 전체 공지 (알릴 것이 없으면 뜨지 않음)
   - 상단 ⚡ 저사양 모드: 점멸·자재 흐름 애니메이션 끄고 30fps — 구형 태블릿용. 터치 기기에서는 좌하단 방향 패드 표시
   - 상단 🌓 테마: 다크 / 흰 바탕(라이트) 전환. 맵 바닥·존 색·라벨이 테마에 맞게 바뀜
5. 두 명 이상이 같은 설비 반경(2.4타일)에 모이면 → 설비 대화방 자동 활성화
6. 대화 패널: 텍스트 + 파일 드래그&드롭 업로드, 전체 공지 채널
7. 모든 대화·파일·상태 변경은 설비 이력으로 DB에 영구 기록 (append-only)
8. 관리자 콘솔: http://localhost:3000/admin.html — `admin` / `관리자` / `admin1234`
   - 대시보드: 금일 알람 건수·평균 대응 시간, 대화/파일 건수, 현재 접속, 설비별 상태 점유율,
     게이트웨이 시작/중지, 데이터 백업(마지막 백업·[지금 백업])
   - 대화 로그: 설비/기간/키워드 검색 (열람 전용)
   - 알람 리포트: 알람 발생→해제 에피소드별 대응 시간·해제자·협업 지표(대화/참여자/파일),
     기간·설비 필터, 평균/최장 대응 시간 요약 — 기대효과 "대응 시간 단축" 측정 근거
   - 설비 마스터: 추가·수정 (접속 중인 사용자의 맵에 새로고침 없이 즉시 반영). **설비 유형** 15종(프레스/용접기/로봇/조립 라인/검사기/포장기/CNC +
     적층기/와인더/함침조/건조로/착자기/밸런싱 머신/디스펜서/SMT) + 미지정 선택 — 게임 맵의 실사형 스프라이트와 실적 분석 분류에 사용.
     코드 접두(PRS-, WLD-, ASM-, INS-, PKG-, CNC-, STK-, WND-, VPI-, OVN-, MAG-, BAL-, DSP-, SMT-)나 공정번호(OP-A40 등)로 추가하면 자동 추정.
     **공정** select로 제품 공정(BOP)에 연결(현장 상태창에 단품 표시), **숨김/복원** — 라인 전환 시 설비를 지우지 않고 맵·분석·게이트웨이에서 제외(이력 보존)
   - 📈 실적 분석: 설비별 OEE(가동률·성능·품질)와 일별 생산실적, 게이트웨이 연결 품질 — 기간·설비 필터, 요약 타일, 인라인 SVG 막대.
     모든 지표의 정의·분모·한계는 [docs/분석-정의.md](docs/분석-정의.md) (대시보드·상태창의 "가동률(로그 구간)"과는 분모가 다름)
     - **라인 밸런스 카드**(스프린트 2, BOP 적용 후 표시): 공정 C/T(BOP 설계값)와 설비 연결로 라인별 병목·UPH·일 생산량·목표 달성률·밸런스 효율 —
       가동시간·OEE 가정·목표 UPH·병렬 대수를 화면에서 바꿔 본다(기간 필터와 무관한 설계 능력 지표). 정의 [docs/분석-정의.md §8](docs/분석-정의.md#8-라인-밸런스-line-balance-스프린트-2)
   - 사용자 관리: 역할(작업자/보전/관리자)·팀 변경, 비밀번호 초기화, **사전 등록**(사번·이름·역할·팀 — 비밀번호는 본인 첫 로그인 때 설정)
   - 운영 정책: **신규 사번 자동 등록 허용** 토글(운영 전환 시 끄고 사전 등록만 허용),
     **대화·파일 보존 기간**(0=무기한, 매일 자동 백업 성공 직후 기간 초과분 정리 — 상태 이력·실적은 보존),
     **1일 계획 가동 시간(분, 1~1440)** — 📈 실적 분석 가동률의 분모(계획 시간). 비우면 24시간/일
   - 맵 에디터: 설비 드래그 배치, 존 추가/영역 드래그 지정/색상 변경,
     🔗 라인 연결 모드(설비 A→B 클릭, 연속 클릭 체인 연결, 목록에서 삭제),
     설비별 데이터 연동 설정(OPC-UA/Modbus/MQTT 프로토콜·주소·태그·상태 매핑·수집 주기)
     - **평면도 배경(옵션)**: 건축 배치도·설계도 이미지(PNG/JPG/WEBP/SVG)를 올려 격자 아래에 깔고
       투명도·범위를 조정. "게임 맵에도 표시"를 켜면 현장 화면 바닥에 아이소메트릭으로 투영
     - **배치 JSON 내보내기/가져오기**: 존(이름)·설비(코드·유형·공정 `op`)·라인을 JSON으로 주고받음. `"replace": true`면 파일에 없는 설비·존을 숨김.
       Claude/Gemini에 도면 이미지와 프롬프트를 주어 JSON 초안을 받는 절차는 [docs/도면-AI-연동.md](docs/도면-AI-연동.md)
     - **제품 라인 적용**(스프린트 2): [🔩 제품 라인 적용 (BLDC 500W)] 버튼 한 번으로 `docs/bldc/bldc-500w-48v.json`(BOP·BOM) →
       `docs/bldc/layout-bldc-500w.json`(배치, replace) 순서로 적용. 다른 제품은 [BOP JSON 가져오기] → 배치 JSON 가져오기 순서로 같은 절차
   - 🌓 테마 전환: 다크(기본) / 흰 바탕 — 게임 화면과 콘솔에 함께 적용, 브라우저에 저장

## 구조

```
server/
  index.js    Express + Socket.IO — 인증, 위치 동기화, 근접 판정(서버), 채팅, 파일, 백업 스케줄
  db.js       SQLite(node:sqlite) 스키마 + 시드 + 운영 설정(settings)
  auth.js     JWT + scrypt
  gateway.js  설비 게이트웨이 — 드라이버를 골라 동일 이벤트 규격으로 발행
  drivers/    mqtt(LIVE) · opcua · modbus · sim — 프로토콜 드라이버 (common.js에 규약)
  backup.js   백업 모듈 (서버 스케줄과 CLI가 공용)
  paths.js    FW_DATA_DIR 해석
scripts/      backup.js(CLI), load-test.js(부하 테스트), dev-broker.js/dev-publish.js(MQTT 개발용)
public/
  index.html  SCR-01~05 화면
  js/game.js  Phaser 3 — 아이소메트릭 맵, 캐릭터, 설비 오브젝트, 보간, 저사양 모드
  js/app.js   로그인 흐름, 소켓 핸들링, HUD/채팅/퀘스트/브리핑 UI
  admin.html, js/admin.js  관리자 콘솔 (SCR-06)
  js/analytics.js, css/analytics.css  실적 분석 화면 (window.FWAnalytics.mount — 없으면 서버가 빈 파일로 대체)
  assets/equipment/  설비 유형 15종 아이소메트릭 스프라이트 PNG(192×192) + manifest.json (없는 유형·generic은 절차적 큐브)
  assets/parts/      제품 분해도 서브어셈블리 이미지 <PN>.png (325×484, 흰 카드) — 🔩 분해도 모달
  assets/parts/thumb/  같은 이름의 96×96 썸네일 — 상태창 투입 단품 표 (없으면 원본으로 폴백)
assets/blender/  설비 3D 모델 생성·렌더 파이프라인 (build_equipment.py · render.cmd · postprocess.py, Blender 5.2; out/은 커밋 제외)
                 contact_sheet.py(3배 확대 검수 시트) · make_part_thumbs.py(분해도 → 썸네일, Blender 불필요)
server/analytics.js  실적 분석 API — registerAnalytics(app, {requireAdmin, db, queries, settings}) (없으면 건너뜀)
docs/         기획 브리프, 구축 경과 보고, 운영 전환 가이드, 분석-정의(OEE 지표 정의), 도면-AI-연동, 소개 캔버스 작업 파일
docs/bldc/    BLDC 500W 제품 라인 원천 — bldc-500w-48v.json(BOP·BOM·분해도 단계), layout-bldc-500w.json(배치), source/(xlsx·PDF 원본)
scripts/bldc/ extract.py — xlsx/PDF → bldc-500w-48v.json + public/assets/parts/*.png 생성
docs/team/    세 에이전트(한도윤·서지안·최민준) 협업 규약·인터페이스 계약·작업보드·협업로그·핸드오프
data/         factory.db (SQLite) + uploads/ (첨부 실물) + jwt.secret
```

## 기획서 대비 구현 범위 (FR)

| ID | 기능 | 상태 |
|----|------|------|
| FR-01 | 게임형 로그인 (타이틀 → 인증 → 캐릭터 → 출근) | ✅ |
| FR-02 | 캐릭터 (색상/닉네임/뱃지, 4방향 걷기 애니메이션) | ✅ (도트 스프라이트 절차 생성 — 색상별 자동) |
| FR-03 | 공장 맵 (아이소메트릭, DB 데이터 기반) + 맵 에디터 | ✅ (관리자 콘솔에서 존 영역·설비 배치 편집) |
| FR-04 | 설비 상태창 (수동 변경, 지속시간, 가동률, 이력) | ✅ |
| FR-05 | 다중 접속 (실시간 위치 동기화, 접속자 목록) | ✅ |
| FR-06 | 근접 대화 (서버 판정, 2인 이상 자동 활성화) | ✅ |
| FR-07 | 파일 공유 (화이트리스트, 설비 이력 귀속) | ✅ |
| FR-08 | 대화 기록 (append-only 저장, 관리자 콘솔 검색) | ✅ |
| FR-09 | 알림 (알람 토스트, 맵 색상/점멸 동기화) | ✅ |
| FR-10 | 관리자 콘솔 (KPI 대시보드, 대화 로그 검색, 설비/사용자 마스터) | ✅ |
| FR-11 | 설비 연동 (OPC-UA/Modbus/MQTT 게이트웨이) | ✅ MQTT LIVE · OPC-UA/Modbus 드라이버 준비(라이브러리 설치 시 LIVE) |
| FR-12 | 생산관리 — 작업지시(퀘스트), 실적·품질(불량) 등록 | ✅ MVP (Phase 3) |
| FR-13 | 게이미피케이션 — 포인트/레벨/뱃지, 리더보드 | ✅ MVP (Phase 3) |

## 기술 스택 (MVP 단순화 — 기획서 스택으로 확장 가능)

| 기획서 | MVP | 비고 |
|--------|-----|------|
| Next.js | 순수 HTML/JS (빌드 없음) | 확장 시 전환 |
| NestJS | Express 단일 서버 | 이벤트 규격은 기획서 5.3 준수 |
| PostgreSQL | SQLite (node:sqlite) | 스키마는 기획서 7장 데이터 모델 기반 |
| Redis | 메모리 Map | 다중 서버 확장 시 도입 |
| MinIO | 로컬 파일 저장 | 사전서명 URL 방식으로 확장 |
| Phaser 3 | Phaser 3 ✅ | 동일 |
| Socket.IO | Socket.IO ✅ | 동일 |

## 설비 게이트웨이 (Phase 2, FR-11)

- 관리자 콘솔 → 대시보드 → "설비 게이트웨이"에서 시작/중지. 켜 둔 상태는 저장되어 서버 재시작 시 자동 재개
- 맵 에디터에서 연동 설정(data_source)된 설비를 자동 수집 대상으로 편입.
  프로토콜별 드라이버(`server/drivers/`)가 값을 읽어 **수동 변경과 동일한
  `equipment:status` 이벤트로 발행** — 게임 클라이언트는 무수정으로 실시간 반영 (설계서 5.3)
- 상태 이력에는 행위자 '설비 게이트웨이'와 수집값이 기록됨.
  자동 수집의 채팅 시스템 메시지는 알람 발생/해제 시에만 기록 (메시지 홍수 방지)
- **상태 매핑**: 장비가 `RUN/IDLE/STOP/ALARM` 문자열 대신 숫자·코드를 주면 맵 에디터의
  "상태 매핑"에 `0=IDLE, 1=RUN, 2=STOP, 3=ALARM`처럼 적는다. 매핑되지 않는 값은 수집값으로만 표시

| 프로토콜 | 상태 | 설정 항목 |
|---|---|---|
| MQTT | **LIVE** (내장) | 브로커 주소(`mqtt://호스트:1883`), 토픽. payload는 평문 상태, `{"status":"RUN","value":72.5}` JSON, 또는 매핑할 원시값 |
| OPC-UA | 드라이버 준비 완료 — `npm install node-opcua` 하면 LIVE, 없으면 SIM 대체 | `opc.tcp://호스트:4840`, 상태 노드 ID(`ns=2;s=...`), 수치 노드(선택), 상태 매핑 |
| Modbus TCP | 드라이버 준비 완료 — `npm install modbus-serial` 하면 LIVE, 없으면 SIM 대체 | `호스트:502`, 레지스터 주소(0 기반), 종류(holding/input/coil/discrete), 유닛 ID, 상태 매핑 |
| 시뮬레이션 | 데모용 | 확률 기반 상태 전이 + 온도성 수집값 |

- 관리자 대시보드의 모드 컬럼에 LIVE/SIM과 연결 상태, 라이브러리가 없으면 "드라이버 미설치"를 표시
- 로컬 MQTT 테스트: `node scripts/dev-broker.js` (개발용 브로커, 포트 1883) 실행 후
  설비 주소를 `mqtt://127.0.0.1:1883`으로 설정, `node scripts/dev-publish.js <토픽> <payload>`로 발행
- 실 장비 연결 시 확인할 것은 각 드라이버 파일 상단 주석 참조 (보안 정책, 익명 접속, 방화벽 포트)

## 인증 (NFR-03)

- 비밀번호: scrypt 해시(솔트 포함) 저장, 평문 미보관
- 세션: JWT(HS256, 12시간) — 시크릿은 `data/jwt.secret`에 영속화되어 재시작에도 세션 유지
- 재접속(NFR-04): 서버 재시작·네트워크 단절 시 클라이언트가 자동 재연결하고, 맵·접속자·내 위치를 다시 맞춤
- 역할 기반 권한: 상태 변경(보전/관리자), 관리자 콘솔·게이트웨이 제어(관리자) — 서버에서 강제, UI에서도 비활성화
- 비밀번호 변경: 게임 상단 🔑 버튼(현재/새 비밀번호 확인). 관리자 초기화: 사용자 관리 →
  [비번 초기화] — 해시 제거 후 대상자의 다음 로그인 비밀번호로 재등록
- 파일럿 완화 정책: 신규 사번 첫 로그인 자동 등록 — 관리자 콘솔 → 사용자 관리 → 운영 정책에서 끌 수 있음(사전 등록 방식). 사내 계정(SSO/AD) 연동 미적용

## 공정 라인 · 부하 시각화 (심시티식)

- **라인 연결**: 맵 에디터 → [🔗 라인 연결 모드] → 설비 A → B 순서로 클릭 (연속 클릭으로
  A→B→C 체인 연결). 목록에서 ✕로 삭제. `equipment_links` 테이블에 저장
- **부하(재공 WIP) 모델**: 2초 틱 — 상류 설비가 가동이면 라인에 유입(+4%p),
  하류 설비가 가동이면 배출(−6%p). 하류가 정지/알람이면 재공이 쌓여 부하 상승
  (심시티 도로 정체와 동일 원리). 부하는 `equipment_links.load`에 저장되어 서버 재시작 후에도 이어짐
- **시각화**: 게임 맵에 라인을 부하 색(녹<40% < 황<70% < 주황<90% ≤ 적)으로 그리고
  방향 화살표·부하% 라벨 표시. 상류 가동 중이면 자재 점이 라인을 따라 이동
- **정체 알림**: 부하 90% 상향 돌파 시 전체 알림 "🚚 라인 정체: A → B — 하류 설비 확인"
  (70% 미만으로 내려가면 재무장). 관리 액션 = 하류 설비 재가동 → 부하 자연 해소

## Phase 3: 작업지시(퀘스트) · 게이미피케이션

- **작업지시 (FR-12)**: 관리자 콘솔 → 작업지시 탭에서 발행(설비/제목/목표수량/마감/설명).
  현장 게임 화면에는 📜 임무 버튼으로 퀘스트 목록이 표시되고, 발행 즉시 전체 알림.
  누구나 수락(OPEN→IN_PROGRESS) 가능, 완료 시 양품/불량/비고 실적 등록(production_records).
  수락·완료는 설비 채널에 시스템 메시지로 자동 기록(append-only 이력).
- **포인트/레벨 (FR-13)**: 작업지시 완료 +100P (불량 0이면 무결점 보너스 +20P),
  알람 수동 해제 +50P. 레벨 = √(포인트/100)+1. 포인트는 point_log에 append-only 기록.
- **뱃지**: 🎖 첫 임무 완수(1건) · 🏅 임무 베테랑(5건) · 🚨 알람 해결사(해제 3회) · 💎 무결점(불량 0 실적 3회)
- **리더보드**: 🏆 버튼 — 개인 Top 10 (레벨/포인트/뱃지 수) + 팀 순위(합산 포인트),
  내 순위·다음 레벨까지 필요 포인트. 팀 지정은 관리자 콘솔 → 사용자 관리
- 캐릭터 머리 위에 접속 시점 레벨 표시(Lv.N), 상단 바에 실시간 포인트/레벨 표시

## 스프린트 1: 실사형 설비 스프라이트 · 실적 분석 (2026-09-08 완료)

세 에이전트(한도윤 — 설비 3D/스프라이트, 서지안 — 실적 분석, 최민준 — 통합·운영)가 `docs/team/`의 규약·인터페이스 계약으로 분업했다.

- **설비 유형** `equipments.type`(기본 `generic`): press / welder / robot / assembly / inspector / packer / cnc.
  기존 DB는 서버 첫 기동 시 컬럼이 추가되고 코드 접두로 1회 매핑됨(이후 관리자가 바꾼 값 유지).
  설비 API(POST/PUT `type`), 배치 JSON `equipments[].type`, `init`·`world:refresh`의 equipment 객체에 포함
- **실사형 스프라이트 7종** (`public/assets/equipment/*.png` + `manifest.json`, 합계 36 KB — 커밋되어 있어 Blender 없이도 동작):
  프레스(C-프레임·램·플라이휠), 용접기(전원 캐비닛·토치·차광막), 로봇(6축 팔·펜스), 조립 라인(컨베이어·갠트리), 검사기(비전 게이트),
  포장기(투입 터널·상자), CNC(밀폐 외장·툴 매거진). 전 유형에 경광등 몸통·비상정지·황색 가드 포함, 바닥 그림자(반투명)로 라이트 테마 대비 확보
- **제작 파이프라인** (`assets/blender/`): `render.cmd` 한 번에 `build_equipment.py`(bpy 절차 모델 + 직교 카메라 (60°,0,45°) → 2:1 마름모 64×32,
  EEVEE 약 15초) → `postprocess.py`(PIL: 캘리브레이션 실측·앵커 (96,150) 정렬·윤곽·그림자 알파 밴드·검증·매니페스트 생성).
  옵션 `--types press,cnc`, `--engine cycles`. 요구: Blender 5.2 + python(PIL, numpy). 중간 렌더 `assets/blender/out/`은 커밋 제외
- **스프라이트 로더** (`public/js/game.js`): 부팅 시 `/assets/equipment/manifest.json`을 읽어 유형별 PNG(192×192, 앵커 (96,150))를
  preload. 매니페스트에 있는 유형은 이미지 스프라이트 + 매니페스트 좌표의 상태 램프 + 라벨, 없는 유형·`generic`은 절차적 큐브.
  클릭은 이미지의 불투명 픽셀 기준(pixelPerfect, 알파 64 미만은 통과 → **바닥 그림자를 눌러도 뒤 설비·바닥으로 통과**, 태블릿 오클릭 방지).
  유형을 바꾸면 접속자 맵에서 즉시 재생성. 규격은 `docs/team/인터페이스.md` §2·§3
- **실적 분석 탭** (관리자 콘솔 📈): `server/analytics.js`가 `/api/admin/analytics/{oee,production,gateway}`를 등록하고
  `public/js/analytics.js`가 화면을 그림(외부 라이브러리 없이 인라인 SVG). 두 파일이 없어도 서버·콘솔은 정상 동작(탭에는 미배치 안내).
  가동률 = RUN/계획 시간(운영 정책 **1일 계획 가동 시간**, 없으면 24h), 성능 = 실적/목표, 품질 = 양품/(양품+불량), OEE = 곱.
  첫 로그 이전은 "상태 미확인"으로 따로 보고하고 추정하지 않음. 정의·한계 전문은 [docs/분석-정의.md](docs/분석-정의.md)
- **검증(2026-09-08)**: 11대 전부 이미지 스프라이트(다크·라이트·저사양 30fps), 그림자 픽셀 히트 0/본체 히트 100%(7종),
  정책 API 경계값(0·2000·소수·문자 → 400), 부하 테스트 50명 30초 통과(이동 p95 21.1ms, 채팅 p95 10.1ms)
- 팀 운영: `docs/team/운영규약.md`(역할·라운드), `인터페이스.md`(계약), `작업보드.md`, `협업로그.md`, `handoff-*.md`

## 스프린트 2: BLDC 500W 모터 라인 — 공정(BOP)·단품(BOM)·분해도·라인 밸런스 (2026-09-10 완료)

첨부 자료(BLDC_500W_48V BOM/BOP 마스터 xlsx, 분해도 PDF)의 24공정을 맵으로 표현하고, **설비를 클릭하면 그 공정에 투입되는 단품**이 보인다.
계약은 `docs/team/인터페이스.md` §7(데이터 모델·API)·§8(단품 HUD)·§9(새 유형 8종). 원본 xlsx·PDF는 `docs/bldc/source/`에 있고
`python scripts/bldc/extract.py`가 `docs/bldc/bldc-500w-48v.json`과 분해도 이미지 `public/assets/parts/<PN>.png`를 다시 만든다.
체험 서버 https://factory-world.onrender.com 은 이 라인으로 시작한다(아래 "빈 DB 자동 적용").

- **데이터 모델** (`server/db.js`, 기존 DB는 기동 시 자동 마이그레이션): `products`(code, name, spec_json — 사양·분해도 단계·라인 밸런스 기준값 원문),
  `processes`(product_code+op 유일, seq/line/name/equipment_hint/input_text/output/ct_sec/kind/qc/note/stage_pn), `parts`(pn PK, level L1~L3, parent, 수량, image),
  `process_inputs`(process_id, pn, qty). `equipments.op`(공정 연결), `equipments.hidden`·`zones.hidden`(라인 전환 숨김).
- **API**: `POST /api/admin/bop/import`(BOP JSON upsert), `GET /api/admin/bop`(공정별 투입 수·연결 설비·미연결 공정), `GET /api/bop/exploded`(로그인 사용자, 분해도 9단계+단계별 공정),
  `POST /api/admin/bop/apply-sample`(docs/bldc 두 파일 순서 적용), 배치 JSON `equipments[].op`·`replace`, 설비 API `op`·`hidden`, `equipment:detail`의 `process` 블록.
- **숨김 규칙**: `hidden=1` 설비·존은 `init`·`world:refresh`·근접 판정·라인 부하 틱·대시보드·알람 리포트·실적 분석·게이트웨이·배치 내보내기에서 제외
  (`queries.listEquipments/listZones/listLinks`가 거름). 설비 마스터에서 [복원](속한 존도 함께)·[숨김], 맵 에디터 존 목록에 숨긴 존 복원. 이력·실적·라인 레코드는 그대로 남는다.
- **적용 절차** (관리자 콘솔 → 맵 에디터 → 제품 라인): [🔩 제품 라인 적용 (BLDC 500W)] → 확인. 서버가 `docs/bldc/bldc-500w-48v.json`을 가져온 뒤 `docs/bldc/layout-bldc-500w.json`을
  `replace`로 적용한다(존 2·설비 24·라인 23, 파일에 없는 기존 설비·존은 숨김 — 이 PC는 파일럿 11대·4존, 빈 DB는 시드 10대·4존). 다른 제품: [BOP JSON 가져오기] → 배치 JSON [가져오기](설비마다 `op` 지정) 순서.
- **빈 DB 자동 적용** (`FW_SEED_PRODUCT_LINE=bldc`): 서버가 빈 DB(`products` 없음)로 뜰 때 위 절차를 1회 자동 실행한다(기동 로그 `[bop] 제품 라인 적용(자동 시드)`).
  제품이 이미 있는 DB는 건너뛰므로(`… 이미 제품이 있어 자동 적용 건너뜀`) 로컬 개발 DB에는 영향이 없고, 적용 이력은 `settings.seed_product_line`. 지원하지 않는 값은 경고만 남기고 서버는 뜬다.
  `render.yaml`에 설정되어 있어 Render 체험 서버는 재배포(DB 초기화)마다 BLDC 라인으로 시작한다. 라인이 늘면 `server/index.js`의 `SAMPLE_PRODUCT_LINES`에 파일 쌍을 추가.
- **현장 화면**: 상태창 "공정 · 단품" 섹션 + 🔩 분해도 모달(사용법 4 참조). 투입 단품 썸네일은 `public/assets/parts/thumb/<PN>.png`(96×96 불투명·1px 회색 테두리, 표시 36×36) —
  로드 실패 시 원본 `/assets/parts/<PN>.png`, 그것도 없으면 빈 칸. 분해도 모달은 원본(325×484)을 쓰고 이 설비의 단계를 강조한다.
- **새 설비 스프라이트 8종** (한도윤, `assets/blender/build_equipment.py`): 자동 적층기(stacker)·니들 와인더(winder)·진공 함침조(vpi)·열풍 건조로(oven)·
  착자기(magnetizer)·밸런싱 머신(balancer)·접착 디스펜서(dispenser)·SMT 결선(smt). 매니페스트 15종·PNG 15장 합계 79.8 KB, 규격 동일(192×192, 앵커 (96,150),
  그림자 알파 28~60 → 클릭 통과, 본체 ≥ 96). BLDC 배치 24대가 큐브 없이 전부 이미지로 뜬다. 검수용 `contact_sheet.py`(3배 시트·다크/라이트), 썸네일 `make_part_thumbs.py`.
- **📈 라인 밸런스** (서지안, `GET /api/admin/analytics/line-balance?product&hours&oee&targetUph&parallel[OP]&hints`): BOP 설계 C/T ÷ 병렬 대수로 라인별 병목·UPH·
  일 생산량(가동시간 × OEE ÷ 병목 C/T)·목표 달성률·밸런스 효율을 내고, 제품은 가장 느린 라인으로 본다. 기본값은 xlsx 12_Line_Balance(가동 20h·OEE 0.85·목표 UPH 60).
  배치 공정(A80·A90)은 병목 판정에서 빼되 개당 C/T가 병목보다 크면 경고. 같은 공정에 설비 2대를 연결해도 병렬은 자동 반영하지 않는다(연결 대수만 표시, PM 결정).
  xlsx와 일치: 아마추어 라인 A40 45초(병렬 2)·UPH 80·일 1,360대 / 조립 라인 B110 60초·UPH 60·일 1,020대. 정의 [docs/분석-정의.md §8](docs/분석-정의.md#8-라인-밸런스-line-balance-스프린트-2)
- **적용 결과(이 PC, 2026-09-09)**: 설비 35대 중 24대 표시·11대 숨김, 존 2 표시·4 숨김, 공정 24·단품 56(서브어셈블리 9 포함)·투입 36·라인 23, 24/24 공정에 설비 연결.
  근접 대화(2인 자동 활성화)·상태 변경·라인 부하(A40→A50 16%)가 새 설비에서 그대로 동작.
- **검증(2026-09-10)**: `node --check` 20파일. 빈 DB 격리 서버(포트 3002, 임시 `FW_DATA_DIR`)에서 자동 적용 → `/api/admin/bop` 연결 24/24, 설비 34대 중 24 표시·10 숨김,
  존 2/4, 라인 23, 분해도 API 비로그인 401·로그인 9단계, 라인 밸런스 UPH 60·일 1,020대, 소켓 `init` 24대 / 재기동 시 건너뜀·수치 불변.
  로컬에서 니들 와인더(OP-A40) 클릭 → 병목 칩·단품 표(MW-1030 Magnet Wire 180 g, 썸네일 96×96)·🔩 분해도 모달(10장, 1단계 강조) 다크·라이트,
  썸네일 404 → 원본 폴백 → 원본도 없으면 빈 칸. 부하 테스트(BLDC 24대, 50명 30초) 이동 p95 18.9ms·채팅 p95 9.4ms 통과.
- 참고: 다크 테마의 `--input/--overlay/--toast-bg`가 자기 참조로 무효 처리되어 상태창·패널 배경이 투명하던 문제를 함께 수정(`public/css/style.css`).
  관리자 콘솔 본문(`.content`)에 `min-width: 0`을 줘서 📈 탭의 넓은 표가 약 1,000px 화면에서 페이지를 가로로 밀지 않고 표 안에서 스크롤되게 했다.

## 다음 단계 후보

- 사내 계정 연동(SSO/AD) — 현재 사내 인증 서버 없음, 필요 시 LDAP/OIDC 모듈 추가
- OPC-UA/Modbus 실 장비 연결 검증 — 드라이버는 준비됨, 라이브러리 설치 후 파일럿 설비 1대로 확인
- 심시티식 라인 증설 시뮬레이션 뷰 (Phase 3 확장)
- 스프린트 3 후보(`docs/team/handoff-최민준.md` 참조): 게이트웨이 폴링 수신/실패 카운트 표(연결 끊김 vs 상태 안정 구분),
  공정별 실측 C/T(게이트웨이 사이클 카운트 → 라인 밸런스에 설계 C/T와 나란히), 가동률 정의 통일(상태창·대시보드 → 분석 정의),
  제품 여러 개(`equipments.product_code`), 분해도 5·6단계(축 서브어셈블리) 공정 연결 보완, 설비 방향(회전) 필드 + 4방향 렌더, 상태별 애니메이션 프레임, 유형별 OEE 집계
