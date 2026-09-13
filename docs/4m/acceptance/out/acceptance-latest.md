# 자재 API 인수 테스트 결과 — 2026-09-13T06-39-56

서버 http://localhost:3198 · as-of 2026-06-01 · 데이터 접두 AT2BH0 · FW_DATA_DIR C:\Users\je310\AppData\Local\Temp\claude\D--factory-world-master\cf599f60-41cc-444e-840e-c30525cfb9ad\scratchpad\data-acc · readonly=false

**합계 75 — PASS 72 · FAIL 2 · BLOCK 0 · NOTE 1**

| # | 구분 | 검사 | 판정 | 기대 | 실제 | ms |
|---|---|---|---|---|---|---:|
| AT-00 | 0 | 토큰 없이 summary → 401 | **PASS** | 401 | 401 {"error":"인증이 필요합니다."} | 37 |
| AT-02 | 0 | GET summary 응답 키 (items·classes·bomHeaders·bomLines·lots·check) | **PASS** | items,classes,bomHeaders,bomLines,lots,check | ["items","classes","bomHeaders","bomLines","lots","processMaterial","itemsByKind","phantoms","tmpItems","check","schema"] | 6 |
| AT-10 | 1 | import-sample #1 → ok · expectedMatch true · mismatches [] | **PASS** | expectedMatch true | {"status":200,"expectedMatch":true,"mismatches":[],"counts":{"uom":5,"uom_conv":1,"mat_class":24,"mat_class_leaf":18,"item":60,"item_by_type":{"CN":6,"FG":1,"PK":1,"PT":40,"RM":2,"SA":10},"item_phantom":3,"trace_mode":{" | 35 |
| AT-11 | 1 | import-sample.check = {D-8:10, R-10:10} | **PASS** | {D-8:10,R-10:10} | {"D-8":10,"R-10":10} |  |
| AT-12 | 1 | import-sample #2 (멱등) → summary 건수·counts 동일 | **PASS** | 동일 | {"s1":{"items":60,"classes":24,"bomHeaders":11,"bomLines":59,"lots":0,"check":{"D-8":10,"R-10":10}},"s2":{"items":60,"classes":24,"bomHeaders":11,"bomLines":59,"lots":0,"check":{"D-8":10,"R-10":10}},"counts2":{"uom":5,"u | 24 |
| AT-13 | 1 | summary 건수 = expected (item 60 · header 11 · line 59 · class 24) | **PASS** | 60/11/59/24 | {"items":60,"classes":24,"bomHeaders":11,"bomLines":59,"lots":0,"check":{"D-8":10,"R-10":10}} |  |
| AT-14 | 1 | summary.check = {D-8:10, R-10:10} (그 밖의 규칙 0) | **PASS** | {D-8:10,R-10:10} | {"D-8":10,"R-10":10} |  |
| AT-20 | 2 | uom 5종 (EA·SHT·kg·g·m) · SET 없음 · decimals EA0 SHT0 kg3 g2 m2 | **PASS** | EA,SHT,g,kg,m | {"codes":["EA","SHT","g","kg","m"],"dec":{"EA":0,"SHT":0,"m":2,"kg":3,"g":2}} | 1 |
| AT-21 | 2 | classes 24 · 최상위 6 · 말단 18 · itemCount 합 60 | **PASS** | 24/6/18/60 | {"n":24,"roots":6,"leaves":18,"itemSum":60} | 1 |
| AT-22 | 2 | items 60 · isTmp 3 (TMP-) | **FAIL** | 60 / 3 | {"n":60,"tmp":[],"byKind":{"CN":6,"FG":1,"PK":1,"PT":40,"RM":2,"SA":10}} | 2 |
| AT-22b | 2 | items[].kind 값이 §10 열거(FG/SA/PHANTOM/PART/RAW/PKG) 안인가 | **NOTE** | FG/SA/PHANTOM/PART/RAW/PKG | ["CN","FG","PK","PT","RM","SA"] |  |
| AT-23 | 2 | items?kind=PHANTOM → 3 (HA-3000·EX-5000·PE-6000) | **PASS** | 3 | ["EX-5000","HA-3000","PE-6000"] | 2 |
| AT-23b | 2 | items?q=SC-10 → SC-1010 · SC-1011 (TMP-SC1010P 는 승인 전이라 문자열에 안 걸린다) | **PASS** | SC-1010,SC-1011 | ["SC-1010","SC-1010P","SC-1011"] | 1 |
| AT-23c | 2 | items?classId=PT-BRG → BF-3040 · BR-3050 · GB-8040 | **PASS** | 3 | ["BF-3040","BR-3050","GB-8040"] | 1 |
| AT-24 | 2 | items/OR-5020 → whereUsed 부모 EX-5000 · headers [] · lots 0 | **PASS** | EX-5000 / [] / 0 | {"status":200,"wu":[{"lineId":33,"parentPn":"EX-5000","parentName":"External Parts Set","qtyPer":1,"uom":"EA","headerId":7,"status":"ACTIVE","bopLink":"REQUIRED","effFrom":"2026-01-01","effTo":"9999-12-31"}],"headers":0, | 1 |
| AT-24b | 2 | items/SA-1000 → headers 1 (ACTIVE, lineCount 9 — SC-1011 은 SC-1010P 밑) · whereUsed 부모 BLDC-500W-48V | **PASS** | 1 ACTIVE 9 / BLDC | {"headers":[{"id":2,"pn":"SA-1000","parentPn":"SA-1000","parentName":"Stator (Armature) Assy","bomType":"PROD","altNo":"00","rev":"A","baseQty":1,"baseUom":"EA","status":"ACTIVE","effFrom":"2026-01-01","effTo":"9999-12-3 | 1 |
| AT-24c | 2 | items/NO-SUCH-PN → 404 {error} | **PASS** | 404 | 404 {"error":"품목 NO-SUCH-PN 이 없습니다."} | 1 |
| AT-30 | 3 | bom/BLDC-500W-48V totals = EA 76 · g 221 · SHT(매) 12 · kg 0.85 · m 0.5 | **PASS** | {"EA":76,"g":221,"SHT":12,"kg":0.85,"m":0.5} | {"EA":76,"kg":0.85,"g":221,"SHT":12,"m":0.5} | 4 |
| AT-31 | 3 | nodes 59 · 최대 level 4 · 팬텀 3 · bop.state linked 46 / unassigned 10 / phantom 3 | **PASS** | 59/4/3/46/10/3 | {"n":59,"maxLv":4,"phantoms":["EX-5000","HA-3000","PE-6000"],"states":{"linked":46,"unassigned":10,"phantom":3}} |  |
| AT-32 | 3 | SC-1011 노드 level 4 · qtyPerProduct 정확히 0.85 kg · SC-1010P qtyPer 80 SHT | **PASS** | L4 0.85 kg / 80 SHT | {"sc":{"level":4,"q":0.85,"uom":"kg"},"scp":{"qtyPer":80,"uom":"SHT","qpp":80}} |  |
| AT-33 | 3 | 미배정 10 = 쟁점 3·6 목록 | **PASS** | BLDC-500W-48V>FS-7010,BLDC-500W-48V>FS-7020,BLDC-500W-48V>GB-8000,BLDC-500W-48V>PL-9000,SA-1000>IP-1040,SA-1000>LC-1080,FS-7020>FS-7023,FS-7020>FS-7021,FS-7020>FS-7022,FS-7020>OR-7025 | ["BLDC-500W-48V>FS-7010","BLDC-500W-48V>FS-7020","BLDC-500W-48V>GB-8000","BLDC-500W-48V>PL-9000","FS-7020>FS-7021","FS-7020>FS-7022","FS-7020>FS-7023","FS-7020>OR-7025","SA-1000>IP-1040","SA-1000>LC-1080"] |  |
| AT-34 | 3 | depth=1 → 완성품 직하 10 (서브어셈블리 9 + PK-0010) | **PASS** | 10 · level 1 | {"n":10,"pns":["SA-1000","RA-2000","HA-3000","PE-6000","FS-7010","FS-7020","GB-8000","PL-9000","EX-5000","PK-0010"]} | 2 |
| AT-35 | 3 | bom/HA-3000 (팬텀 루트) → 자식 7 · totals EA 14 | **PASS** | 7 / EA 14 | {"n":7,"totals":{"EA":14}} | 2 |
| AT-36 | 3 | bom/GB-8000 → totals EA 5 · g 25 | **PASS** | EA 5 g 25 | {"EA":5,"g":25} | 2 |
| AT-37 | 3 | bom/NO-SUCH → 404 | **PASS** | 404 | 404 | 1 |
| AT-38 | 3 | as-of 2025-12-31 (valid_from 2026-01-01 이전) → 노드 0 · totals {} | **PASS** | 0 / {} | {"n":0,"totals":{}} | 1 |
| AT-40 | 4 | where-used/OR-5020 → 경로 OR-5020 … EX-5000 … BLDC-500W-48V (루트까지) | **PASS** | [OR-5020 > EX-5000 > BLDC-500W-48V] | ["OR-5020 > EX-5000 > BLDC-500W-48V"] | 1 |
| AT-41 | 4 | where-used/BF-3040 → 경로 BF-3040 … HA-3000 … BLDC-500W-48V (루트까지) | **PASS** | [BF-3040 > HA-3000 > BLDC-500W-48V] | ["BF-3040 > HA-3000 > BLDC-500W-48V"] | 1 |
| AT-42 | 4 | where-used/BT-3070 → 경로 BT-3070 … HA-3000 … BLDC-500W-48V (루트까지) | **PASS** | [BT-3070 > HA-3000 > BLDC-500W-48V] | ["BT-3070 > HA-3000 > BLDC-500W-48V"] | 1 |
| AT-43 | 4 | where-used/SC-1011 → 4단 경로 (SC-1011 > SC-1010P > SC-1010 > SA-1000 > BLDC) | **PASS** | 5 노드 | ["SC-1011","SC-1010P","SC-1010","SA-1000","BLDC-500W-48V"] | 1 |
| AT-44 | 4 | where-used/NO-SUCH → 404 (500 아님) | **PASS** | 404 | 404 | 0 |
| AT-45 | 4 | where-used/BLDC-500W-48V (루트) → paths [] · 오류 아님 | **PASS** | 200 [] | 200 [] | 1 |
| AT-50 | 5 | 24공정 process/:op → IN 합 46 · OUT 24 · 완성(isFinal) 7 · 오류 0 | **PASS** | 46/24/7 | {"nin":46,"nout":24,"nfinal":7,"bad":[]} | 27 |
| AT-51 | 5 | OP-B90 inputs 9 = BOP 표기 순서 (PC-4010 … SP-4040) | **PASS** | PC-4010…SP-4040 | ["PC-4010","PC-4011","HS-4020","MO-4030","GD-4040","CP-4050","HK-4060","BB-4070","SP-4040"] |  |
| AT-52 | 5 | OP-A10 IN [SC-1011] · OUT SC-1010P(final) · OP-A70 IN [] · OUT SA-1000(진행) | **PASS** | A10 / A70 | {"A10":{"in":["SC-1011"],"out":[{"pn":"SC-1010P","final":true}],"un":10},"A70":{"in":[],"out":[{"pn":"SA-1000","final":false}],"un":10}} |  |
| AT-53 | 5 | process/OP-ZZ → 404 | **PASS** | 404 | 404 | 0 |
| AT-54 | 5 | GET /api/admin/bop (기존 계약) → summary.inputs 46 · parts 59 · OP-B90 inputCount 9 · processes 24 | **PASS** | 46/59/9/24 | {"summary":{"processes":24,"parts":59,"inputs":46,"linked":24,"unlinked":[]},"b90":9} | 1 |
| AT-55 | 5 | GET check (있으면) → details D-8 10건 = 미배정 목록 | **PASS** | 10 | ["BLDC-500W-48V > FS-7010","BLDC-500W-48V > FS-7020","BLDC-500W-48V > GB-8000","BLDC-500W-48V > PL-9000","SA-1000 > IP-1040","SA-1000 > LC-1080","FS-7020 > FS-7023","FS-7020 > FS-7021","FS-7020 > FS-7022","FS-7020 > OR-7 | 3 |
| AT-60 | 6 | R-1 순환: GB-8000 BOM 에 BLDC-500W-48V 를 자식으로 → 400 "R-1:" | **PASS** | 400 R-1: | 400 {"error":"R-1: BOM 순환 참조 — 자식의 하위 구조에 부모가 있다 (또는 깊이 64 초과)"} | 1 |
| AT-61 | 6 | R-9 겹침: PL-9000 에 PL-9010 을 2026-03-01 부터 한 번 더 → 400 "R-9:" | **PASS** | 400 R-9: | 400 {"error":"R-9: 같은 부모·자식·대체그룹의 라인 유효기간이 겹친다"} | 1 |
| AT-61b | 6 | R-3 중복: 같은 자식·같은 시작일 → 400 (R-9 또는 UNIQUE) | **PASS** | 400 | 400 {"error":"R-9: 같은 부모·자식·대체그룹의 라인 유효기간이 겹친다"} | 1 |
| AT-62 | 6 | R-6 수량 0 → 400 | **PASS** | 400 | 400 {"error":"qtyPer 는 0 보다 커야 합니다."} | 1 |
| AT-63 | 6 | R-8 소수: 0.5 EA → 400 "R-8:" | **PASS** | 400 R-8: | 400 {"error":"R-8: 수량의 소수 자릿수가 단위 허용 자릿수(uom.decimals)를 넘는다"} | 1 |
| AT-64 | 6 | R-7 단위: EA 품목에 g → 400 "R-7:" | **PASS** | 400 R-7: | 400 {"error":"R-7: 라인 단위가 자식 기준단위와 다르고 uom_conv 환산도 없다"} | 1 |
| AT-64b | 6 | D-6 valid_to < valid_from → 400 | **PASS** | 400 | 400 {"error":"CHECK constraint failed: valid_to >= valid_from"} | 1 |
| AT-65 | 6 | R-11 승인 라인 삭제 → 400 "R-11:" | **PASS** | 400 R-11: | 400 {"error":"R-11: 승인된 BOM 의 라인은 삭제하지 않는다 — valid_to 를 끊어라"} | 1 |
| AT-65b | 6 | DELETE items/:pn → 거부 (405/400, R-11) | **PASS** | 405\|400 | 405 {"error":"R-11: item 은 삭제하지 않는다 — PUT 으로 status=OBSOLETE 로 전환"} | 0 |
| AT-66a | 6 | POST items (대체 자석 시험 품목) → 200/201 | **PASS** | 201 | 201 {"ok":true,"created":true,"item":{"itemId":301,"pn":"AT2BH0-PM-X","name":"대체 자석(시험)","nameKo":null,"spec":null,"kind":"PT","classId":11,"classCode":"PT-MAG","className":"영구자석","uom":"EA","uomSymbol":"EA","status":"AC | 3 |
| AT-66b | 6 | PUT bom-lines PM-2030 altGroup=MAG priority 1 → 200 | **PASS** | 200 | 200 {"ok":true,"line":{"id":22,"lineId":22,"headerId":5,"lineNo":30,"parentPn":"RA-2000","parentName":"Rotor Assy","pn":"PM-2030","name":"Permanent Magnet","kind":"PT","phantom":false,"qtyPer":8,"uom":"EA","qtyBasis":"NE | 2 |
| AT-66c | 6 | D-13 우선순위 중복 (1,1) → 400 "D-13:" | **PASS** | 400 D-13: | 400 {"error":"D-13: 같은 대체 그룹에 같은 우선순위가 같은 기간에 둘이다 — 주자재를 정할 수 없다"} | 1 |
| AT-66d | 6 | 대체품 우선순위 2 → 201 (동시 유효 허용) | **PASS** | 201 | 201 {"ok":true,"line":{"id":60,"lineId":60,"headerId":5,"lineNo":60,"parentPn":"RA-2000","parentName":"Rotor Assy","pn":"AT2BH0-PM-X","name":"대체 자석(시험)","kind":"PT","phantom":false,"qtyPer":8,"uom":"EA","qtyBasis":"NET", | 1 |
| AT-66e | 6 | TC-44 대체품 있는 전개 — 주자재 PM-2030 만 계상 · totals EA 76 불변 | **PASS** | PM-2030 8 · EA 76 | {"magNodes":[{"pn":"PM-2030","q":8}],"totals":{"EA":76,"kg":0.85,"g":221,"SHT":12,"m":0.5}} | 3 |
| AT-67 | 6 | R-9b 같은 부모 ACTIVE rev B 같은 기간 → 400 "R-9b:" | **PASS** | 400 R-9b: | 400 {"error":"R-9b: 같은 부모의 승인 BOM 유효기간이 겹친다 — 직전 rev 의 valid_to 를 먼저 끊어라"} | 1 |
| AT-67b | 6 | DRAFT rev B → 201 (ECO 준비 허용) | **PASS** | 201 | 201 {"ok":true,"header":{"id":12,"pn":"PL-9000","parentPn":"PL-9000","parentName":"Parking Lock Assy","bomType":"PROD","altNo":"00","rev":"B","baseQty":1,"baseUom":"EA","status":"DRAFT","effFrom":"2026-01-01","effTo":"99 | 1 |
| AT-67c | 6 | DRAFT → ACTIVE 승격 (직전 rev 미종료) → 400 "R-9b:" | **PASS** | 400 R-9b: | 400 {"error":"R-9b: UPDATE 결과 같은 부모의 승인 BOM 유효기간이 겹친다"} | 1 |
| AT-67d | 6 | R-7b 헤더 base_uom ≠ 품목 base_uom → 400 "R-7b:" | **PASS** | 400 R-7b: | 400 {"error":"R-7b: bom_header.base_uom 은 부모 품목의 base_uom 과 같아야 한다"} | 1 |
| AT-68 | 6 | D-8 팬텀 라인(BLDC>HA-3000)에 IN 연결 → 400 "D-8:" | **PASS** | 400 D-8: | 400 {"error":"D-8: 팬텀(PHANTOM)·미연결(NONE) 라인에는 투입(IN) 행을 둘 수 없다"} | 2 |
| AT-68b | 6 | 거부된 links 편집 뒤 OP-B50 IN 이 원래대로 (롤백) | **PASS** | 1,25 | 1,25 | 1 |
| AT-68c | 6 | 같은 links 를 다시 PUT (순서 동일) → 200 · pm_id 불변 | **PASS** | pmId 동일 | {"before":[39,40],"after":[39,40]} | 2 |
| AT-69 | 6 | R-14 비말단 분류(PT)에 품목 → 400 "R-14:" | **PASS** | 400 R-14: | 400 {"error":"R-14: 품목은 말단(is_leaf=1) 분류에만 붙는다"} | 1 |
| AT-69b | 6 | R-20 pn 에 "/" → 400 (CHECK) | **PASS** | 400 | 400 {"error":"CHECK constraint failed: pn NOT LIKE '%/%' AND pn NOT LIKE '% %' AND length(pn) <= 32"} | 1 |
| AT-69c | 6 | TC-29 코드표에 없는 단위 "말" → 400 (FK) | **PASS** | 400 | 400 {"error":"FOREIGN KEY constraint failed"} | 1 |
| AT-70 | 7 | PL-9000 에 2027-01-01 부터 유효한 라인 추가 → 201 | **PASS** | 201 | 201 {"ok":true,"line":{"id":61,"lineId":61,"headerId":11,"lineNo":50,"parentPn":"PL-9000","parentName":"Parking Lock Assy","pn":"AT2BH0-ASOF","name":"as-of 시험 품목","kind":"PT","phantom":false,"qtyPer":1,"uom":"EA","qtyBas | 1 |
| AT-71 | 7 | as-of 2026-06-01 에는 없고 2027-06-01 에는 있다 | **PASS** | false / true | {"inNow":false,"inFut":true} |  |
| AT-72 | 7 | as-of 2027-06-01 완성품 전개 EA 77 (76 + 시험 품목 1) | **PASS** | 77 | {"EA":77,"kg":0.85,"g":221,"SHT":12,"m":0.5} | 3 |
| AT-73 | 7 | TC-14/57b GB-8000 2개 → GB-8010 qpp 2 · GB-8040 4 · totals EA 81 g 246 · process/OP-B85 GB-8010 2 | **PASS** | 2/4/81/246/2 | {"put":200,"g10":2,"g40":4,"totals":{"EA":81,"kg":0.85,"g":246,"SHT":12,"m":0.5},"p10":2} |  |
| AT-74 | 7 | 되돌린 뒤 totals 원상 (EA 76) | **PASS** | EA 76 | {"EA":76,"kg":0.85,"g":221,"SHT":12,"m":0.5} |  |
| AT-80 | 8 | POST lots 코일 입고 로트 850 kg (POSCO / MS-8842) → 201 | **PASS** | 201 id | 201 {"ok":true,"lot":{"id":1,"lotNo":"AT2BH0-LOT-SC1011-A","pn":"SC-1011","name":"규소강판 원소재","kind":"LOT","parentLotId":null,"parentLotNo":null,"qty":850,"qtyInit":850,"uom":"kg","status":"AVAILABLE","statePmId":null,"sta | 1 |
| AT-81 | 8 | 분할 서브로트 0.85 kg (parentLotId) → 201 · 원로트 잔량 849.15 (D-17 차감) | **PASS** | 201 / 849.15 / init 850 | {"status":201,"qty":849.15,"qtyInit":850,"text":"{\"ok\":true,\"lot\":{\"id\":2,\"lotNo\":\"AT2BH0-SUB-001\",\"pn\":\"SC-1011\",\"name\":\"규소강판 원소재\",\"kind\":\"SUBLOT\",\"parentLotId\":1,\"parentLotNo\":\"AT2BH0-LOT-SC1 | 1 |
| AT-81b | 8 | 잔량보다 큰 분할 → 400 (D-17) | **PASS** | 400 | 400 {"error":"D-17: 부모 로트 잔량(849.15)보다 큰 수량은 분할할 수 없습니다."} | 1 |
| AT-82 | 8 | SC-1010P 산출 로트 생성 | **FAIL** | 201 | 404 {"error":"품목 TMP-SC1010P 이 없습니다."} |  |
| AT-90 | 9 | process_inputs · parts 가 뷰(이행 [3]) 이고 *_legacy 표가 남아 있다 | **PASS** | view/view/table/table | {"parts_legacy":"table","process_inputs_legacy":"table","process_inputs":"view","parts":"view"} |  |
| AT-91 | 9 | queries.processInputs SQL 그대로 — legacy 36행 ↔ 뷰 46행 · 전에만 (B90,PE-6000) · 후에만 11 · 공통 35 수량/단위/이름/규격 차 0 | **PASS** | verdict all true | {"verdict":{"onlyBefore":true,"onlyAfter":true,"rows":true,"qtyUnitNameSpec":true,"parts":true,"all":true},"onlyBefore":[["OP-B90","PE-6000"]],"onlyAfter":11,"qty":[],"unit":[],"name":0,"spec":0,"level":[["OP-A10\|SC-101 |  |
| AT-92 | 9 | parts_legacy 56 · parts(뷰) 59 · listProcesses input_count 합 46 | **PASS** | 56/59/46 | {"partsBefore":56,"partsAfter":59,"sum":46} |  |
| AT-93 | 9 | 응답 시간 — 전개·역전개·요약·품목·공정·bop 각 < 1,000 ms | **PASS** | < 1000 | [["/bom/BLDC-500W-48V?asOf=2026-06-01",3],["/where-used/BF-3040",1],["/summary",2],["/items",1],["/process/OP-B90",1],["/api/admin/bop",1]] |  |

## 비고
- AT-22b: §10 열거에 CN(부자재 6종)이 없고 서버는 item_type 원값(FG/SA/PT/RM/CN/PK)을 낸다 — 계약 문구 정정 필요(서지안 화면 매핑 확인)
- AT-54: 호환 뷰(process_inputs·parts) 위에서 기존 listProcesses·countParts 가 그대로 도는지
- AT-91: level·parentPn 변화는 계획서 §10.3 예고분(값만 바뀐다)
