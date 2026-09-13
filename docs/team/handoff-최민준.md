# handoff — 최민준 (MES 운영 리더)

## 스프린트 3 라운드 4 — 자재(Material) 관리 시스템 구현 — 2026-09-13 완료 (커밋만, push 는 라운드 5 노하린 인수 뒤)

계약: 인터페이스 §10 · `docs/4m/ddl-v1.sql`(윤태경, 무수정) · `docs/4m/cleansing-v1.json`(무수정) · 계획서 §5.9 기준 쿼리. 게임 계약(`equipment:detail.process.inputs[]`)은 호환 뷰로 유지.

### 한 일 (전부 내 소유 파일 + 신규 `server/materials.js`)
| 파일 | 변경 |
|---|---|
| `server/db.js` | ① `docs/4m/ddl-v1.sql` 을 **파일로 읽어 문 단위로 `exec`** — `splitSqlStatements()` 가 주석·문자열·`BEGIN/CASE…END` 깊이를 보고 **85문**으로 나눠 한 트랜잭션에서 실행, 실패하면 `[db] ddl-v1.sql 실행 실패 — 문 #n/85 "머리말": 오류` 로그 후 롤백(서버는 기동, `materialsSchema.ok=false`). 파일을 코드에 복사하지 않았다(원천 하나). ② 이행 `migrateMaterials()` — `parts` 가 표이면: legacy 데이터가 있고 `item` 이 비었을 때 적재기(strict) → expected 대조 → 실패 시 롤백·legacy 유지 / 성공 시 `process_inputs`·`parts` → `*_legacy` rename + 같은 이름 뷰(DDL 절 H 그대로). 이미 뷰인 DB 는 건너뜀(재기동 멱등). ③ `queries.upsertPart`·`deleteProcessInputs`·`addProcessInput` 제거(뷰에 INSERT 는 prepare 단계에서 실패). `countParts`·`processInputs`·`listProcesses` **무수정** |
| `server/materials.js` (신규, 내 소유) | `loadMaterials(db, { source, cleansing, strict })` — `loader_algorithm` 1~7 그대로(uom→uom_conv→mat_class→item→bom_header→bom_line→OUT 24→IN 46, `SAVEPOINT`, 전부 UPSERT·삭제 없음, `bop_link` 안 넣음, `pn_pending.approved=false` → `TMP-`), `verifyLoad()` 가 `expected` 전 키 + `v_chk_summary` 대조. `registerMaterials(app, { requireAdmin, db, queries, settings, afterChange })` — §10 라우트 전부 + 추가 라우트(아래). `readMaterialFiles()`. **db.js 를 import 하지 않는다**(db.js 가 적재기를 import) |
| `server/index.js` | `importBop()` 은 products/processes 만 upsert 하고 단품·투입은 `loadMaterials` 로(규칙 `fg_pn` ≠ 제품이면 공정만 갱신 + 경고). `apply-sample`(콘솔 버튼)·`FW_SEED_PRODUCT_LINE`(자동 시드, **strict** — 대조가 어긋나면 적용 전체 롤백) 공용. `/js/materials.js`·`/css/materials.css` 빈 파일 대체. `registerMaterials` 동적 import(분석과 같은 훅, `afterChange` = `world:refresh` 로 열린 상태창 갱신) |
| `public/admin.html` · `public/js/admin.js` | 탭 `data-tab="materials"`(🧩 자재) · `#tab-materials` · `css/materials.css` · `js/materials.js` 링크, 활성화 시 `window.FWMaterials.mount($('tab-materials'), api)` — 없으면 안내 + summary 한 줄(품목·분류·헤더·라인·로트·점검) |
| 문서 | README 스프린트 3 절·구조, 인터페이스 §10 구현 메모, 운영 가이드 §2 이행·되돌리기, 작업보드 스프린트 3 절, 협업로그 |

### 스키마·이행 결과 (운영 DB `data/factory.db`, 2026-09-13 11:56 — 백업 `OneDrive/FactoryWorld-백업/fw-backup-20260913-115025` 먼저)
- 기동 로그: `ddl-v1.sql 85문 실행 — 객체 85개 생성` → `이행 [1] 자재 적재(BLDC-500W-48V) — item 60·bom_header 11·bom_line 59·IN 46·OUT 24(완성 7) · [2] expected 대조 일치 · v_chk_summary {"D-8":10,"R-10":10} · 임시 품번 TMP-SC1010P, TMP-FS7023, TMP-PK0010` → `이행 [3] — parts(56행)·process_inputs(36행) → parts_legacy·process_inputs_legacy 보존, 같은 이름의 호환 뷰로 전환`.
- 행 수: `item 60 · bom_header 11 · bom_line 59 · process_material 70(IN 46·OUT 24) · parts_legacy 56 · process_inputs_legacy 36 · parts(뷰) 59 · process_inputs(뷰) 46 · mat_lot 0`. `sqlite_master`: `parts`/`process_inputs` = view, `*_legacy` = table.
- **설비 24대 `equipment:detail.process.inputs[]` 전후 diff** (legacy 표 vs 뷰 vs 소켓 응답 — 소켓 응답 = 뷰 SQL 결과 100% 동일):
  행 36 → 46 · **공통 35행 수량 차 0 · 공정 안 순서 차 0** · 전에만 1행(`OP-B90: PE-6000`) · 후에만 11행(`OP-A20: TMP-SC1010P`, `OP-B90: PC-4010·PC-4011·HS-4020·MO-4030·GD-4040·CP-4050·HK-4060·BB-4070·SP-4040`, `OP-B120: TMP-PK0010`) = 계획서 §9.3 [2] ④ 그대로.
  값이 바뀐 필드(공통 행): `level` 1건(`SC-1011` L3→L4), `parentPn` 11건(`HA-3000/EX-5000` → `HA-3000` 7·`EX-5000` 3, `SC-1011` → `TMP-SC1010P`), `parentName` 19건(원천 단품 표의 짧은 라벨 "Stator Assy"·"Housing/External"·"Power Electronics" → 부모 품목의 `item.name` "Stator (Armature) Assy"·"Housing Assy"·"External Parts Set"·"Power Electronics Assy"·"Stator Lamination (블랭킹편)"). `name`·`spec`·`unit`·`image` 차 0. "구 NULL 2행(SA-1000@B50, RA-2000@B70)" 은 실제 운영 DB 에는 없었다(전에도 qty 1.0).
- 리허설(백업본 → 격리 `FW_DATA_DIR`, 포트 3002)에서 같은 결과를 먼저 확인한 뒤 운영 DB 에 적용. 격리 DB 재기동 시 이행 로그 없음·행 수 불변.

### API (전부 `requireAdmin`, 오류 `{ error }`, 트리거 거부 = 400 에 RAISE 문자열 그대로) — `server/materials.js`
§10 표 그대로: `GET summary` · `GET uom` · `GET classes` · `GET items?q&classId&status&kind` · `GET items/:pn` · `POST items` · `PUT items/:pn` · `GET bom/:pn?asOf&depth(&qty)` · `GET where-used/:pn?asOf` · `GET bom-headers/:pn` · `POST bom-headers` · `PUT bom-headers/:id` · `POST bom-lines` · `PUT bom-lines/:id` · `DELETE bom-lines/:id` · `GET process/:op` · `PUT process/:op/links` · `GET lots?pn&q(&status)` · `POST lots` · `GET lots/:id/genealogy?dir=fwd|back` · `POST import-sample`.
**추가**: `GET check`(v_chk_* 상세 — 콘솔 무결성 카드용) · `GET process`(24공정 IN/OUT 건수 목록) · `GET bom-lines/:id` · `GET lots/:id` · `PUT lots/:id`(status HOLD 등) · `POST lots/:id/consume`(투입 계보 `lot_genealogy` 1행 + 투입 로트 qty 차감 — 계보 조회를 시험하려면 이게 필요) · `DELETE items/:pn` → 405(R-11 안내).
응답 예(운영 DB, 발췌):
- `summary` → `{"items":60,"classes":24,"bomHeaders":11,"bomLines":59,"lots":0,"processMaterial":{"in":46,"out":24},"itemsByKind":{"CN":6,"FG":1,"PK":1,"PT":40,"RM":2,"SA":10},"phantoms":3,"tmpItems":3,"check":{"D-8":10,"R-10":10},"schema":{"compatViews":true,"legacyTables":false}}`
- `items` 원소 → `{"itemId":50,"pn":"GB-8010","name":"Gearbox Housing","nameKo":null,"spec":"AL 다이캐스트","kind":"PT","classId":13,"classCode":"PT-MCH","className":"기계가공품","uom":"EA","uomSymbol":"EA","status":"ACTIVE","traceKind":"NONE","isTmp":false,"isPhantom":false,"phantom":false,"sourceType":"BUY","image":"GB-8000.png",…}` · `items/:pn` → `{ item, whereUsed:[{lineId,parentPn,parentName,qtyPer,uom,headerId,status,bopLink,effFrom,effTo}], headers:[…], lots:0, outAt:[{op,isFinal,outState,qtyOut}], inAt:["OP-B85"] }`
- `bom/BLDC-500W-48V` → `{ root:{pn,name,kind,uom,phantom,status}, asOf:"2026-09-13", qty:1, nodes:[…트리 중첩…], count:59, totals:{"EA":76,"kg":0.85,"g":221,"SHT":12,"m":0.5}, totalsBase:{"COUNT(EA)":76,"MASS(kg)":1.071,"LENGTH(m)":0.5} }`. 노드: `{"lineId":1,"headerId":1,"rev":"A","level":1,"lineNo":10,"parentPn":"BLDC-500W-48V","pn":"SA-1000","name":"Stator (Armature) Assy","kind":"SA","uom":"EA","itemUom":"EA","qtyPer":1,"baseQty":1,"qtyPerParent":1,"qtyPerProduct":1,"qtyPerProductGross":1,"scrapRate":0,"qtyBasis":"NET","phantom":false,"traceKind":"LOT","itemStatus":"ACTIVE","image":"SA-1000.png","altGroup":null,"altPriority":null,"isOptional":false,"bopLink":"REQUIRED","bop":{"op":"OP-B50","mode":"IN","state":"linked","inOps":["OP-B50"],"outOp":"OP-A100"},"effFrom":"2026-01-01","effTo":"9999-12-31","note":null,"children":[…9]}`. `asOf=2025-12-31` → `nodes:[]`(유효 전).
- `where-used/SC-1011` → `{"pn":"SC-1011","paths":[[{"pn":"SC-1011","qtyPer":1,"qtyCum":1},{"pn":"TMP-SC1010P","qtyPer":0.010625,"qtyCum":0.010625},{"pn":"SC-1010","qtyPer":80,"qtyCum":0.85},{"pn":"SA-1000","qtyPer":1,"qtyCum":0.85},{"pn":"BLDC-500W-48V","qtyPer":1,"qtyCum":0.85}]],"parents":[…]}` (각 원소에 `name` 포함)
- `process/OP-B90` → `{ op, process:{id,productCode,op,seq,line,name,kind,output,inputText}, inputs:[{pmId,seq,lineId,parentPn,parentName,pn,name,kind,traceKind,image,qtyPer,baseQty,qtyPerProduct,uom,uomSymbol,splitPct,issueMethod,note,mode:"IN"}×9], outputs:[{pmId,pn:"BLDC-500W-48V",isFinal:false,outState:"제어부 결합",qtyOut:null,mode:"OUT"}], unassigned:[{lineId,parentPn,pn,name,qtyPerProduct,uom}×10] }`
- `lots` 원소 → `{"id":2,"lotNo":"LOT-SC1011-260913-A1","pn":"SC-1011","name":"규소강판 원소재","kind":"SUBLOT","parentLotId":1,"parentLotNo":"LOT-SC1011-260913-A","qty":39.15,"qtyInit":40,"uom":"kg","status":"AVAILABLE","statePmId":null,"stateOp":null,"stateText":null,"supplier":null,"supplierLot":null,…}` · `lots/3/genealogy?dir=back` → `{ lot, dir:"back", tree:[{lotId:2,lotNo,pn,kind:"SUBLOT",qty,uom,status,depth:1,edge:{kind:"CONSUME",qty:0.85,uom:"kg",op:"OP-A10",equipment:null,user:"관리자",at,genId:1},children:[{lotId:1,…,edge:{kind:"SPLIT",qty:40,…},children:[]}]}], nodes:2 }`
- 400 예: `R-1: BOM 순환 참조 — 자식의 하위 구조에 부모가 있다 (또는 깊이 64 초과)` · `R-11: 승인된 BOM 의 라인은 삭제하지 않는다 — valid_to 를 끊어라` · `R-7: …` · `R-8: …` · `R-9b: …` · `R-14: …` · `R-22: …` · `R-13: …` · `CHECK constraint failed: pn NOT LIKE '%/%' …`
- `import-sample` → `{ ok, product, counts, check, expectedMatch, mismatches:[{key,expected,actual}], tmp:{"SC-1010P":"TMP-SC1010P",…}, warnings }` (재적재는 UPSERT — 리허설에서 편집으로 남은 TEST 품목·rev B 헤더가 `item 60→61`·`bom_header 11→12` 로 정직하게 mismatch 보고, 행 중복 없음)

### 적재 검산 (`verifyLoad`, 운영·격리·빈 DB 3곳 동일)
`uom 5 · uom_conv 1 · mat_class 24(leaf 18) · item 60 {FG 1, SA 10, PT 40, RM 2, CN 6, PK 1} · 팬텀 3 · trace {SERIAL 1, LOT 34, NONE 25} · bom_header 11 · bom_line 59 {REQUIRED 56, PHANTOM 3, NONE 0} · 노드−간선 1 · 최대 깊이 4 · IN 46 · OUT 24(final 7) · bop_status {ASSIGNED 46, UNASSIGNED 10, PHANTOM 3} · 미배정 10건 목록 일치 · 말단 합계 EA 76 · g 221 · SHT 12 · kg 0.85 · m 0.5 (MASS 1.071 kg) · 호환 뷰 process_inputs 46 · parts 59 · v_chk_summary {D-8:10, R-10:10}` = `expected` 전부 일치.

### 검증 수치 (2026-09-13)
- `node --check` server 8·drivers 5·public/js 4(내 파일)·scripts 4 통과. (`public/js/materials.js` 는 서지안이 작성 중이라 62행에서 끝나 있음 — 그 파일만 실패, 내 것 아님.)
- 격리 이행 리허설(백업본, 포트 3002): 위 diff 그대로 · API 60여 호출(정상 2xx, 404, 트리거 400 9종) · 재기동 멱등.
- 빈 DB + `FW_SEED_PRODUCT_LINE=bldc`(포트 3003): `[bop] 제품 라인 적용(자동 시드) — 공정 24·품목 60·단품(뷰) 59·투입 46 · 자재 expected 일치 · v_chk {"D-8":10,"R-10":10} / 설비 +24 … 라인 +23`, 재기동 시 건너뜀.
- 부하 테스트(격리 서버 3001, 시드 적용, 50명 30초): 접속 50/50 · 오류 0 · 이동 수신 9,898 · 손실 1 · p50 6.3ms · **p95 18.5ms** · max 23.9ms / 채팅 5,100 · p50 1.8ms · **p95 8.5ms** · max 21.0ms → 통과(NFR-01), 서버 오류 로그 0.
- 운영 DB: 백업 → 미리보기 `factory-world` 재기동(이행 로그 위) → 게임에서 니들 와인더(OP-A40) 실제 클릭 → "공정 · 단품" 표 `MW-1030 Magnet Wire ↳ Stator (Armature) Assy · 동선 φ0.80 · 180 g · thumb SA-1000.png`(이전과 동일, 부모 라벨만 위 규칙) · 관리자 콘솔 🧩 자재 탭 = 안내 + `품목 60 · 분류 24 · BOM 헤더 11 · 라인 59 · 로트 0 · 점검: D-8 10 · R-10 10` · `/api/admin/bop` summary `processes 24·parts 59·inputs 46·linked 24` · 라인 밸런스 UPH 60·일 1,020 그대로 · OEE·설비·분해도 API 200.
- 관리자 토큰은 로컬 `data/jwt.secret` 로 2시간짜리를 발급해 썼다(비밀번호 입력 없음). 격리 서버는 무작위 `FW_JWT_SECRET`·`FW_ADMIN_PASSWORD`.

### §10 과 달라진 점 (인터페이스 §10 구현 메모에도 적음)
1. `items[].kind` 는 §10 표기(FG/SA/PHANTOM/PART/RAW/PKG)가 아니라 **DDL `item_type` 코드(FG/SA/PT/RM/CN/PK)**, 팬텀은 별도 `isPhantom`(=`phantom`). 필터 `kind=` 는 두 표기 다 받는다(`PHANTOM`→`is_phantom=1`, `PART`→PT, `RAW`→RM, `PKG`→PK).
2. `bom/:pn` 노드에 §10 필드 외 `headerId, rev, lineNo, itemUom, baseQty, qtyPerProductGross, traceKind, itemStatus, image, altGroup, altPriority, isOptional, bopLink, note` 와 `bop.inOps[]·outOp` 추가. `bop.state` 는 `linked | unassigned | phantom | none`(NONE 라인). `totalsBase` 추가. `qty=` 쿼리로 n 대 전개.
3. `where-used` 경로는 **품목 자신부터 루트까지** `[{pn,name,qtyPer,qtyCum}]`, 직계 부모 `parents[]` 별도.
4. `PUT process/:op/links` — `links` 의 IN 항목이 그 공정 IN 집합 전체를 대체(순서 = `seq`, 같은 집합·순서면 UPDATE 만, 아니면 삭제 후 재삽입 → pm_id 갱신). `mode:"OUT"` 항목이 하나라도 있으면 OUT 집합도 대체(`pn, isFinal, outState, qtyOut`).
5. `POST lots` 에 `parentLotId`(또는 `parentLotNo`) 가 있으면 SUBLOT + **부모 qty 차감**(D-17 서비스 계층), `stateOp` 로 `state_pm_id` 지정. 추가 라우트 `POST lots/:id/consume`·`PUT lots/:id`·`GET lots/:id`.
6. `bom-headers` 상태 전이는 **앞으로만**(`DRAFT→APPROVED→ACTIVE→OBSOLETE`, 역행 400). 승인 시 `approved_by/approved_at` 자동.
7. `import-sample` 는 기본 비-strict(커밋 후 `expectedMatch`·`mismatches` 보고), `{ "strict": true }` 본문이면 불일치 시 롤백 400.
8. 추가 `GET check`·`GET process`·`GET bom-lines/:id`, `DELETE items/:pn` → 405.

### 적재 규칙에서 내가 정한 것 (윤태경 확인 요청 — DDL·cleansing 파일은 한 글자도 안 고쳤다)
- `parts.parent_name` 의 짧은 라벨은 새 구조에 저장 자리가 없다 → 호환 뷰 `parent_name` = 부모 `item.name`(위 19건 값 변화). 라벨을 보존하려면 `item.name_ko` 가 아니라 별도 컬럼이 필요 — 필요하면 DDL 에 제안.
- `item.image` = 자기 `<pn>.png` → 없으면 **가장 가까운 조상**의 `<pn>.png`(현행 `pn → parentPn` 규칙의 다단 일반화). 그래서 `SC-1011`(부모 TMP-SC1010P) 이 전처럼 `SA-1000.png` 를 유지하고, `HA-3000`·`EX-5000` 자식은 전처럼 `null`(파일 없음). TMP 품번은 논리 pn 파일도 찾는다.
- 이름·규격: FG `spec` = 사양의 정격 출력/전압/회전수 3값 `"500 W / 48 VDC / 3,000 RPM"`(원천 값 조합). 서브어셈블리 `spec` = 같은 P/N 단품 행의 규격(FS-7010 DEMOTE 는 같은 물건이라 `SCM440` 채택, FS-7020 RENUMBER_CHILD 는 자식 규격이라 미채택 → `note`). `item.name_ko` 는 `new_items.name_ko` 3건만.
- note 형식: `bom_header.note` = 표의 note + `valid_from 2026-01-01: <_valid_from_note>`, `bom_line.note` = `원천: <extra_lines.source>` · `line_attrs.note`, `process_material(IN).note` = `[CONFIRMED] <reason>`.
- `pn_pending[x].rejected === true` 이면 `reparent.fallback_to` 를 쓴다(P-3b 부결 경로 — 파일 형식 확장, 지금은 안 씀). `approved: true` 로 바꾸고 재적재하면 `UPDATE item SET pn` 1건(리허설 미실행 — PM 결정 뒤 노하린이 TC 로).
- `uom_conv` 는 `INSERT OR IGNORE`(식 인덱스 `ux_uom_conv` 기준). 재적재 시 `item` 의 `status`·`bom_header` 의 `status/valid_*` 는 덮어쓰지 않는다(운영 중 바뀐 값 보존).

### 훅 위치 · 되돌리기
- 서지안: `public/js/materials.js`(`window.FWMaterials = { mount(container, api) }`)·`public/css/materials.css` 만 놓으면 된다. 지금 두 파일이 없을 때 서버가 빈 파일을 200 으로 준다(`index.js` 상단). `api(path, opts)` 는 admin.js 의 인증 fetch 래퍼(JSON, 4xx 는 `Error(data.error)` throw — 트리거 문자열이 `e.message`).
- 되돌리기(운영 가이드 §2): `DROP VIEW process_inputs; DROP VIEW parts; ALTER TABLE process_inputs_legacy RENAME TO process_inputs; ALTER TABLE parts_legacy RENAME TO parts;` — 다음 기동 때 `migrateMaterials` 가 `item` 이 이미 있으므로 적재 없이 뷰로 다시 전환한다. 완전 롤백은 이전 커밋 + 백업 DB.

### 다음 (라운드 5)
- 노하린: 실서버 API 로 TC-01~59 인수 — 접점은 협업로그. 격리 실행: `FW_DATA_DIR=<임시> PORT=3005 FW_SEED_PRODUCT_LINE=bldc FW_JWT_SECRET=<임의> FW_ADMIN_PASSWORD=<임의> node server/index.js`, 토큰은 `FW_JWT_SECRET` 으로 HS256 `{uid: admin id, emp:"admin", exp}` 서명(`server/auth.js` 형식).
- 서지안: `materials.js`·`materials.css` 완성 → 내가 실제 화면 확인·통합·push.
- PM: `pn_pending` 승인(쟁점 1·2) → `cleansing-v1.json` `approved: true` → 콘솔 `import-sample`(또는 재기동 없이 `POST /api/admin/materials/import-sample`).

## 스프린트 2 라운드 2 (통합·배포) — 2026-09-10 완료

### 반영한 요청
| 발신 | 요청 | 결과 |
|---|---|---|
| 한도윤 | (1) 24대 이미지 스프라이트·램프·라벨 확인 | 라운드 1에서 확인(재생성 요청 없음). 이번 라운드 로컬 게임 24대 전부 `isImage`(큐브 0), 매니페스트 15종 요청 200 |
| 한도윤 | (2) §8 썸네일 경로 + HUD 전환 | `app.js` `PARTS_THUMB = '/assets/parts/thumb/'` 우선, `data-orig` = 원본, `error` 리스너로 원본 폴백 → 그것도 없으면 `img` 제거(빈 칸). `style.css` `.pthumb` 36×36. §8 확정 문구 |
| 한도윤 | (3) 커밋 대상 | equipment PNG 15 + manifest, parts/thumb 9, blender 스크립트 5(수정 3·신규 2) 전부 이번 커밋. `assets/blender/out/`·`__pycache__/` 제외 |
| 한도윤 | (4) 라벨 겹침 | 해당 없음(라운드 1 확인) |
| 서지안 | (1) README·가이드 §3-1 라인 밸런스 한 줄 + §8 링크 | README 관리자 콘솔 📈 항목·스프린트 2 절, 운영 가이드 §3-1 — 앵커 `#8-라인-밸런스-line-balance-스프린트-2`(GitHub 슬러그 규칙 대조) |
| 서지안 | (2) `unlinked` 정의 대조 | 라운드 1 답변(동일). 빈 DB 격리 서버에서도 `/api/admin/bop` linked 24 = 라인 밸런스 `summary.linked` 24 |
| 서지안 | (3) 병렬 자동 반영 | PM 결정(2026-09-09 23:55): 자동 반영 안 함, `linkedCount` 표시 + 수동 `parallel` 유지 |
| 서지안 | (4)(5)(6) | 코드 요청 아님 / 중복 제외 무해 / SIM 이번 스프린트 없음 — 라운드 1 답변 그대로 |
| PM | (1) `docs/bldc/source` 원본 커밋 | 라운드 1 커밋 `6917e76`에 이미 포함 → 이번 push로 공개 저장소 반영 |
| PM | (3) `FW_SEED_PRODUCT_LINE=bldc` 빈 DB 자동 적용 + `render.yaml` | 구현·검증(아래). `render.yaml` envVars에 `FW_SEED_PRODUCT_LINE: "bldc"` |

되돌린 산출물: **없음.** 한도윤 — 15장 192×192 RGBA, 알파 1~27 픽셀 0·64~95 구간 0·본체 최소 96·램프 알파 255·최고점 y ≥ 69, 썸네일 9장 96×96 전 픽셀 불투명·테두리 rgb(150,154,164), 원본 9장 HEAD와 바이트 동일.
서지안 — `registerAnalytics(app, { requireAdmin, db, queries, settings })`, 라우트 4개 전부 `requireAdmin`, `window.FWAnalytics.mount`, 셀렉터 144개 전부 `.fwa-*`, 하드코딩 색 0·테마 변수만.

### 코드 변경 (이번 라운드, 전부 내 소유 파일)
- `server/index.js`: `SAMPLE_PRODUCT_LINES = { bldc: {bop, layout} }`, `sampleLineFiles(line)`, `applySampleProductLine(line, who)`(콘솔 버튼과 공용), 기동 블록 —
  `FW_SEED_PRODUCT_LINE`이 있으면 ① 지원 값이 아니면 경고 ② `products`가 있으면 건너뜀 ③ `settings.seed_product_line` 이력이 같으면 건너뜀 ④ 파일 없으면 오류 로그 ⑤ 적용 후 이력 저장. 실패해도 서버는 뜬다.
  위치: "관리자 API" 절 바로 위(참조하는 `num`·`partImageFor`·`clampInt`·`SAMPLE_PRODUCT_LINES`는 앞에서 정의, `localTs`는 함수 선언이라 TDZ 없음). 기동 시 소켓이 없으므로 `afterLayoutChange()` 불필요(라인 상태는 `tickLinks`가 지연 생성).
- `render.yaml`: `FW_SEED_PRODUCT_LINE: "bldc"`.
- `public/js/app.js`·`public/css/style.css`: 썸네일 경로·폴백·크기(위 표).
- `public/admin.html`: `.content { min-width: 0 }` — 📈 탭에서 라인 밸런스 표(`nowrap`, 약 1,176px)의 최소 콘텐츠 폭이 flex 항목 `.content`를 `max-width` 1100px까지 밀어
  982px 화면에서 본문이 1,300px로 가로 스크롤되던 문제. 수정 후 본문 967/967, 표는 `.fwa-scroll` 안에서 스크롤(681/1176). 서지안 파일은 손대지 않음.
- `.gitignore`: `__pycache__/`(검증 중 `py_compile`이 만든 폴더가 커밋되지 않게), `data-loadtest/`(가이드 §4의 부하 테스트 폴더 — 테스트 DB에도 비밀번호 해시가 있음).
- 문서: README(체험 서버·Render 버튼·Koyeb 버튼 `FW_SEED_PRODUCT_LINE`, 사용법·📈 라인 밸런스·구조·스프린트 2 절 완료·부하 기록·스프린트 3 후보), `docs/운영전환-가이드.md`(§1 체험 서버, §3-1 제목, §4 기록·BLDC 옵션),
  `docs/배포-가이드.md`(Render 체험 서버·로그인 없는 반영 확인법·`[skip render]`, Koyeb 표 행), `docs/design-brief.md`(§3 구축 순서 9·BLDC 절, §4 현재 상태), 인터페이스 §8 확정 문구.

### 검증 결과 (2026-09-10, 이 PC)
- `node --check` 20파일(server 7·drivers 5·public/js 4·scripts 4) 통과, python 5개 `py_compile` 통과(생성된 `__pycache__` 삭제).
- **빈 DB 자동 적용**(임시 `FW_DATA_DIR`, `PORT=3002`, `FW_SEED_PRODUCT_LINE=bldc`, 무작위 `FW_ADMIN_PASSWORD`·`FW_JWT_SECRET` — 관리자 확인은 비밀번호 로그인 대신 그 시크릿으로 발급한 토큰):
  - 1차 기동 로그: 마이그레이션 3줄, `[auth] 관리자 초기 비밀번호를 FW_ADMIN_PASSWORD로 설정`, `[bop] 제품 라인 적용(자동 시드) — BLDC-500W-48V: 공정 24·단품 49·투입 36 / 설비 +24 수정 0 숨김 10 / 존 +2 숨김 4 / 라인 +23`.
  - `/api/admin/bop` summary `processes 24·parts 56·inputs 36·linked 24·unlinked []`. 설비 34대 = 표시 24(전부 `op` 연결)·숨김 **10**(PRS-01~03, WLD-01~03, ASM-01~02, INS-01, PKG-01 — 빈 DB 시드가 10대라서. 로컬 DB는 CNC-01이 있어 11), 존 2/4, 내보내기 설비 24·라인 23.
    유형 분포 press 4·assembly 7·inspector 3·stacker·winder·vpi·oven·dispenser·magnetizer·balancer·smt·robot·packer 각 1. `/api/bop/exploded` 비로그인 **401**, 로그인 9단계·final OP-B110,OP-B120.
    라인 밸런스 `?hints=1` UPH 60·일 1,020·linked 24 (아마추어 A40 45초·UPH 80·1,360 / 조립 B110 60초·UPH 60·1,020). 소켓 `init` 설비 24·존 2·라인 23, OP-A40 `equipment:detail.process` 입력 MW-1030(image SA-1000.png)·단계 1.
  - 2차 기동(재기동): `[bop] FW_SEED_PRODUCT_LINE=bldc — products 에 이미 제품이 있어 자동 적용 건너뜀`, DB 행 수 불변(products 1·processes 24·parts 56·inputs 36·equipments 34·links 23·zones 6).
  - 3차 `FW_SEED_PRODUCT_LINE=xyz` → 경고 1줄 후 정상 기동, 4차 변수 없음 → 시드 로그 없음. 프로세스 종료·임시 폴더 삭제 확인.
- **로컬 3000**(미리보기 `factory-world` 재기동 — `FW_SEED_PRODUCT_LINE` 미설정이라 로컬 DB 무영향. 브라우저 패널에 이전 세션 토큰이 없어 로컬 `data/jwt.secret`으로 3시간짜리 관리자 토큰을 발급하고
  페이지의 `/api/login` 요청만 가로채 그 토큰을 돌려주는 방식으로 로그인 흐름을 재현 — 비밀번호는 서버로 보내지 않음. 검증 후 localStorage 정리):
  - 게임: 설비 24대 전부 이미지. 니들 와인더 본체를 실제 클릭 → 상태창 "니들 와인더 · OP-A40", 병목 칩, 공정 정보, 단품 표 MW-1030 Magnet Wire ↳ Stator Assy 동선 φ0.80 180 g,
    썸네일 `/assets/parts/thumb/SA-1000.png` 96×96(표시 34×34 + 테두리), 산출물 "3상 권선 스테이터 · 분해도 1단계". 🔩 분해도 실제 클릭 → 카드 10(9단계+완성품), `cur` = STAGE 1(SA-1000)만, 원본 9장 전부 로드(325×484 등), 내 공정 표시 OP-A40. ESC 닫기.
  - 폴백: 실제 `img`(리스너 부착된 요소)에 없는 thumb 경로 + `data-orig`=원본 → 원본 325×484로 교체, 원본도 없는 경로 → `img` 제거·셀 빈 칸(표 유지). 이 두 404만 콘솔에 남음.
  - 라이트 테마: 상태창 배경 rgba(255,255,255,.97), 썸네일 경계 보임. 다크 테마 스크린샷도 확인.
  - 관리자 콘솔 📈: 라인 밸런스 카드(SVG 2·병렬 입력 27) 타일 "60 / 1,020대 / 100% / 24/24공정", 경고 1건(A90), 다크·라이트. 위 `.content` 수정 전후 폭 비교.
  - 에셋 요청: 매니페스트·PNG 15장·thumb·원본 9장 전부 200.
  - 관찰(이번 변경과 무관): 브라우저 패널이 OS에서 가려진(`document.hidden`) 상태로 게임을 부팅하면 Phaser RESIZE 캔버스가 0×0으로 잡히고 `Framebuffer status: Incomplete Attachment`가 한 번 뜬다.
    `scale.getParentBounds()+refresh()` 후 정상 렌더. 실제 사용자가 백그라운드 탭에서 입장하는 경우에만 해당 — 스프린트 3에서 `visibilitychange` 시 `scale.refresh()` 한 줄 검토.
- **부하 테스트**(격리 서버 3001, 스크래치 `FW_DATA_DIR`, `FW_SEED_PRODUCT_LINE=bldc` → 설비 24·라인 23, 50명 30초): 접속 50/50 · 오류 0 · 이동 수신 9,903건 · 손실 4건 · p50 7.8ms · **p95 18.9ms** · max 25.0ms,
  채팅 수신 5,250건 · p50 2.0ms · **p95 9.4ms** · max 17.1ms → 통과(NFR-01). 서버 오류 로그 0, 테스트 서버 종료·데이터 삭제.

### 커밋·push·Render
- `990cb62` 스프린트 2 라운드 2 통합 — 43파일(두 사람 산출물 + 내 파일 + 문서). 라운드 1 `6917e76`(PM 원천 `docs/bldc/source` xlsx·PDF 포함)과 함께 push: `origin/main` `7f8f779..990cb62`. push 전 `git status` 클린, 스테이징 목록에 `data/`·`assets/blender/out/`·`__pycache__`·로그·시크릿 패턴 없음 확인.
- 이 Render 확인 기록은 문서만 바꾸는 후속 커밋이라 메시지에 `[skip render]`를 넣어 재배포(=체험 서버 DB 초기화)를 일으키지 않게 했다.

### Render 반영 확인 (2026-09-10, 로그인 없이)
- GitHub Deployments(Render가 기록): 환경 `main - factory-world`, sha `990cb62` — 09:18:07Z 생성(진행 중에서 멈춤 = 뒤 배포로 대체된 것으로 보임), 09:19:48Z 생성 → **09:20:32Z success**(18:20 KST, push 후 약 2.5분). 같은 sha 배포가 두 번인 것은 push 자동 배포와 `render.yaml` 변경에 따른 Blueprint 동기화로 추정.
- 백그라운드 폴링(18:32 KST 첫 확인에서 통과): `/js/app.js` `eq-proc-section` 1·`PARTS_THUMB` 2, `/assets/equipment/winder.png` 200, `/assets/parts/thumb/SA-1000.png` 200, `/api/bop/exploded` 비로그인 **401**(배포 전 404 = 라우트 없음).
- 추가 확인: `/api/admin/bop`·`/api/admin/analytics/line-balance`·`/oee`·`/api/admin/equipments` 비로그인 401(라우트 등록·`analytics.js` 로드 — 로드 실패면 404), `/api/policy` `allowSelfRegister:false`(Render 환경변수 적용),
  매니페스트 15종, 설비 PNG 15/15·썸네일 9/9·분해도 원본 9/9 200, `/admin.html`에 `.content min-width: 0`, `/js/analytics.js`에 `line-balance`, `/`에 `eq-proc-section`.
- **로그인이 필요한 확인(사용자)**: `FW_SEED_PRODUCT_LINE=bldc` 적용 여부 — https://factory-world.onrender.com 에 `admin` / `관리자` / Render `FW_ADMIN_PASSWORD`로 입장 → 토스트 "2개 존 · 설비 24대"와 BLDC 맵, 설비(예: 니들 와인더) 클릭 → "공정 · 단품"·썸네일·🔩 분해도.
  설비가 10대(프레스 존 등)로 보이면 Render 대시보드 Environment에 `FW_SEED_PRODUCT_LINE=bldc`가 동기화되지 않은 것 — 대시보드에서 값을 넣고 재배포하거나, 관리자 콘솔 → 맵 에디터 [🔩 제품 라인 적용]을 누르면 된다.

### 한도윤에게 (다음)
- 요청 전부 반영, 되돌림 없음. 다음 후보: `footprint {w,h}`(SMT 다리 3% 초과), `balancer_run.png` 상태별 프레임(로더 프레임 훅은 내가 만든다 — 계약 제안을 협업로그에), `generic` 스프라이트 여부.
- 썸네일 폴백이 있으니 새 P/N 이미지를 넣을 때 thumb를 빠뜨려도 화면은 원본으로 뜬다. 그래도 `make_part_thumbs.py`로 같이 만들어 달라(96×96이 표에서 더 선명).

### 서지안에게 (다음)
- 요청 전부 반영. 📈 탭 가로 넘침은 내 `admin.html` 쪽 원인이라 내가 고쳤다 — 서지안 파일 변경 필요 없음. 다만 라인 밸런스 표가 1,176px라 약 1,000px 화면에서는 표 안 가로 스크롤이 생긴다(정상 동작).
- 다음 후보: 공정별 실측 C/T(게이트웨이 사이클 카운트 전제 — 수집·스키마는 내가, 정의·화면은 서지안), "OEE 가정"에 §3 실측 OEE 끌어오기 버튼.

### 열린 항목 / 스프린트 3 후보
1. 게이트웨이 폴링 수신/실패 카운트 표 `gateway_samples` (서지안 제안, 스키마·수집은 최민준) — 실측 C/T의 전제이기도 함
2. 공정별 실측 C/T 열 (서지안)
3. 제품 여러 개: `equipments.product_code` + `processByOp`에 제품 조건 (최민준)
4. 분해도 5·6단계(FS-7010·FS-7020)에 `stagePn` 공정이 없어 "공정 미정" — 원천 JSON 보완 여부 PM 결정
5. 숨김 탭 부팅 시 캔버스 0×0 (위 관찰) — `game.js` 한 줄
6. 가동률 정의 통일, 설비 방향 4방향, 상태별 애니메이션, 유형별 OEE, `generic` 스프라이트, `footprint` (스프린트 1 후보 이월)

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

### 커밋
- `6917e76` 스프린트 2 라운드 1 — 27파일(내 파일 + PM 원천 docs/bldc·scripts/bldc·parts 원본 9장). push 안 함(라운드 2). `data/` 미포함 확인.
- 미커밋(라운드 2 통합 커밋 대상): 한도윤 `public/assets/equipment/*.png` 8장 신규·manifest.json·`assets/blender/*`(스크립트 3 수정 + 2 신규)·`public/assets/parts/thumb/`, 서지안 `server/analytics.js`·`public/js/analytics.js`·`public/css/analytics.css`·`docs/분석-정의.md`, 두 handoff.
- `docs/bldc/source/`의 xlsx(37 KB)·PDF(944 KB) 원본을 저장소에 넣었다(다른 PC에서 `extract.py` 재현용). 공개 저장소이므로 push 전에 PM이 원하지 않으면 라운드 2에서 뺀다.

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
