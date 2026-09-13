/* Factory World — 자재(Material) 관리 화면 (서지안, 인터페이스 §10 · 계획서 §10.1)
 *
 * window.FWMaterials.mount(container, api) — admin.js 가 🧩 자재 탭을 열 때마다 호출한다 (멱등).
 *   첫 호출: 컨테이너에 골격(요약 타일·분류 트리·섹션 탭)을 만들고 기본 데이터를 읽는다.
 *   이후 호출: 골격은 그대로 두고 요약·품목 목록만 다시 읽는다.
 * api(path, opts) 는 admin.js 의 인증 fetch 래퍼 (JSON 반환, 실패 시 Error(message) — 'auth' 면 게이트로 이미 이동).
 *   서버(server/materials.js, 최민준)가 트리거 거부를 400 { error: 'R-1: …' } 로 돌려주면 그 문자열을 그대로 빨간 줄로 보여 준다.
 * 데이터 소스는 전부 서버 뷰·쿼리(계획서 §10.1) — 화면은 계산하지 않고 표시만 한다. 유일한 클라이언트 계산은
 *   분류 트리의 하위 품목 수 합산(itemCount 누계)뿐이다.
 * 목(mock): URL 에 ?mock=1 이 있을 때만 FWMaterials._mock 이 api 를 대신한다(§10 응답 형태를 cleansing-v1.json 의 실품번으로 흉내).
 *   기본은 꺼져 있고, 켜지면 화면 상단에 "목 데이터" 표시가 붙는다.
 * 외부 라이브러리 없음. 색은 테마 변수(css/materials.css).
 */
(function () {
  'use strict';
  const KIND_LABEL = { FG: '완제품', SA: '조립품', PHANTOM: '팬텀', PART: '단품', PT: '단품', RAW: '원자재', RM: '원자재', CN: '부자재', PKG: '포장재', PK: '포장재' };
  const STATUS_LABEL = { DRAFT: '초안', APPROVED: '승인', ACTIVE: '사용', BLOCKED: '차단', OBSOLETE: '폐기' };
  const HEADER_NEXT = { DRAFT: ['APPROVED'], APPROVED: ['ACTIVE', 'OBSOLETE'], ACTIVE: ['OBSOLETE'], OBSOLETE: [] };   // §10 DRAFT→APPROVED→ACTIVE→OBSOLETE
  const BOP_LABEL = { linked: '연결', phantom: '팬텀', unassigned: '미배정', none: '미연결(의도)' };
  const LOT_STATUS = { AVAILABLE: '가용', HOLD: '보류', CONSUMED: '소진', SCRAPPED: '폐기', SHIPPED: '출하' };
  // 검사 규칙 — ddl-v1.sql G 절 v_chk_* 와 같은 코드·같은 뜻. 응답 check 에 없는 규칙은 0건.
  const RULES = [
    ['R-1', '순환 참조', 'BOM 자식의 하위에 부모가 있다 (v_chk_r1_cycle)'],
    ['R-2', '깊이 10 초과', '전개 깊이가 10을 넘는 라인 (v_chk_r2_depth)'],
    ['R-4', '고아 품목', '완성품이 아닌데 어느 BOM 의 자식도 아니다 (v_chk_r4_orphan)'],
    ['R-5', '미아 조립품', 'SA/FG 인데 BOM 라인이 하나도 없다 (v_chk_r5_lost_sa)'],
    ['R-10', '투입 비율 ≠ 100', 'REQUIRED 라인의 split_pct 합이 100 이 아니다 — 0 이면 미배정 (v_chk_r10_split)'],
    ['D-8', '미배정 라인', 'REQUIRED 인데 투입(IN) 공정이 없다 — BOP 누락 후보, 쟁점 3·6 (v_chk_bop_unassigned)'],
    ['R-12', '빈 팬텀', '팬텀인데 자식이 없어 전개가 멈춘다 (v_chk_r12_phantom_empty)'],
    ['R-22', '투입 순서 역전', '자식 투입 공정이 부모 산출 공정보다 늦다 (v_chk_r22_seq)'],
    ['TR-2', '추적 단위 역전', '하위가 SERIAL 인데 상위가 NONE (v_chk_trace_serial)'],
    ['D-18', 'BULK·로트 추적', 'BULK 출고인데 로트 추적 품목 (v_chk_bulk_trace)'],
    ['D-17', '로트 수량 불일치', 'qty_init ≠ qty + 분할 + 투입 (v_chk_lot_qty)'],
  ];
  const KNOWN_ISSUE_RULES = { 'D-8': 10, 'R-10': 10 };   // cleansing-v1.json expected.v_chk_summary — 쟁점 3·6 미배정 10건은 알려진 값
  const states = new WeakMap();   // container → st

  // ── 유틸 ──────────────────────────────────────────────
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const p2 = (n) => String(n).padStart(2, '0');
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
  const num = (v, max = 4) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? '—' : Number(v).toLocaleString('ko-KR', { maximumFractionDigits: max }));
  const qty = (v, uom) => (v === null || v === undefined ? '—' : `${num(v)}<span class="fwm-uom">${esc(uom || '')}</span>`);
  const isOpen = (v) => !v || v >= '9999-01-01';
  const eff = (from, to) => `${from || '—'} ~ ${isOpen(to) ? '무기한' : to}`;
  const kindLabel = (k) => KIND_LABEL[k] || k || '—';
  const chip = (cls, text, title) => `<span class="fwm-chip ${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
  const empty = (title, why) => `<div class="fwm-empty"><b>${esc(title)}</b>${esc(why || '')}</div>`;
  const errBox = (msg) => `<div class="fwm-err">${esc(msg)}</div>`;
  const qs = (o) => { const u = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== '' && v !== null && v !== undefined) u.set(k, v); const s = u.toString(); return s ? '?' + s : ''; };
  const mockOn = () => /[?&]mock=1(&|$)/.test(location.search);

  /** api 호출 — 라우트가 아직 없으면(404 HTML → JSON 파싱 실패) 이유가 보이는 메시지로 바꾼다. 'auth' 는 그대로 던진다. */
  async function call(st, path, opts) {
    try { return await st.api(path, opts); }
    catch (e) {
      if (e.message === 'auth') throw e;
      if (/Unexpected token|JSON|Cannot (GET|POST|PUT|DELETE)/.test(e.message)) throw new Error('자재 API 없음 — server/materials.js 가 아직 등록되지 않았거나 서버가 재기동되지 않았습니다 (' + path.split('?')[0] + ')');
      throw e;
    }
  }

  // ── 목 데이터 (?mock=1 일 때만) — cleansing-v1.json 의 실품번·적재 규칙을 그대로 옮긴 60품목·59라인·24공정 ──
  // 응답 형태는 인터페이스 §10. 서버 뷰가 하는 계산(완성품당 소요·말단 합계·where-used·검사 건수)을 여기서만 흉내 낸다.
  // 목의 말단 합계는 expected.leaf_totals_per_product (EA 76 · g 221 · SHT 12 · kg 0.85 · m 0.5) 와 같아야 한다 — 목이 맞는지의 검산.
  const MOCK_CLASSES = [
    ['FG', '완제품', null], ['FG-MOT', '모터 완제품', 'FG'],
    ['SA', '반제품·서브어셈블리', null], ['SA-STA', '스테이터계', 'SA'], ['SA-ROT', '로터계', 'SA'], ['SA-HSG', '하우징계', 'SA'], ['SA-DRV', '동력전달계', 'SA'], ['SA-CTL', '제어계', 'SA'],
    ['PT', '단품(구매·가공)', null], ['PT-CORE', '코어·적층품', 'PT'], ['PT-MAG', '영구자석', 'PT'], ['PT-BRG', '베어링', 'PT'], ['PT-MCH', '기계가공품', 'PT'], ['PT-ELE', '전장·전자', 'PT'], ['PT-FST', '체결·실링', 'PT'], ['PT-ETC', '기타 단품', 'PT'],
    ['RM', '원자재', null], ['RM-COIL', '강판 코일', 'RM'], ['RM-WIR', '권선 동선', 'RM'],
    ['CN', '부자재·소모품', null], ['CN-CHM', '화학품(접착·함침·윤활·솔더)', 'CN'], ['CN-INS', '절연재', 'CN'],
    ['PK', '포장재', null], ['PK-BOX', '외장 박스', 'PK'],
  ];
  // [pn, name, spec, class, type, uom, phantom, trace]
  const MOCK_ITEMS = [
    ['BLDC-500W-48V', 'BLDC 모터 500W 48V', '500 W · 48 VDC · 3,000 RPM · IP54', 'FG-MOT', 'FG', 'EA', 0, 'SERIAL'],
    ['SA-1000', 'Stator (Armature) Assy', '권선/함침 완료품', 'SA-STA', 'SA', 'EA', 0, 'LOT'],
    ['RA-2000', 'Rotor Assy', '착자/밸런싱 완료품', 'SA-ROT', 'SA', 'EA', 0, 'LOT'],
    ['HA-3000', 'Housing Assy', '하우징+베어링플레이트', 'SA-HSG', 'SA', 'EA', 1, 'NONE'],
    ['EX-5000', 'External Parts Set', '네임플레이트/오링/글랜드', 'SA-CTL', 'SA', 'EA', 1, 'NONE'],
    ['PE-6000', 'Power Electronics Assy', '제어부 (팬텀)', 'SA-CTL', 'SA', 'EA', 1, 'NONE'],
    ['FS-7020', 'Flange Shaft No.2 Assy', '', 'SA-DRV', 'SA', 'EA', 0, 'LOT'],
    ['GB-8000', 'Gearbox Assy', '', 'SA-DRV', 'SA', 'EA', 0, 'LOT'],
    ['PL-9000', 'Parking Lock Assy', '', 'SA-DRV', 'SA', 'EA', 0, 'LOT'],
    ['SC-1010', 'Stator Core', '규소강판 50W470', 'PT-CORE', 'SA', 'EA', 0, 'LOT'],
    ['TMP-SC1010P', 'Stator Lamination (블랭킹편)', '규소강판 50W470 0.5t 낱장', 'PT-CORE', 'SA', 'SHT', 0, 'LOT'],
    ['SC-1011', '규소강판 원소재', 'POSCO 50W470', 'RM-COIL', 'RM', 'kg', 0, 'LOT'],
    ['MW-1030', 'Magnet Wire', '동선 φ0.80', 'RM-WIR', 'RM', 'g', 0, 'LOT'],
    ['RC-2020', 'Rotor Core', '규소강판 적층', 'PT-CORE', 'PT', 'EA', 0, 'LOT'],
    ['PM-2030', 'Permanent Magnet', 'NdFeB N42SH', 'PT-MAG', 'PT', 'EA', 0, 'LOT'],
    ['BF-3040', 'Bearing Front', '6002ZZ', 'PT-BRG', 'PT', 'EA', 0, 'LOT'],
    ['BR-3050', 'Bearing Rear', '6001ZZ', 'PT-BRG', 'PT', 'EA', 0, 'LOT'],
    ['GB-8040', 'Gearbox Bearing', '6003ZZ', 'PT-BRG', 'PT', 'EA', 0, 'LOT'],
    ['SH-2010', 'Shaft', 'SCM440 QT', 'PT-MCH', 'PT', 'EA', 0, 'LOT'],
    ['HS-3010', 'Housing Frame', 'AL6061-T6', 'PT-MCH', 'PT', 'EA', 0, 'NONE'],
    ['BP-3020F', 'Bearing Plate Front', 'AL6061', 'PT-MCH', 'PT', 'EA', 0, 'NONE'],
    ['BP-3020R', 'Bearing Plate Rear', 'AL6061', 'PT-MCH', 'PT', 'EA', 0, 'NONE'],
    ['FS-7010', 'Main Flange Shaft No.1', 'SCM440', 'PT-MCH', 'PT', 'EA', 0, 'LOT'],
    ['FS-7021', 'Top Bushing', '황동', 'PT-MCH', 'PT', 'EA', 0, 'LOT'],
    ['FS-7022', 'Internal Shaft', 'SCM415', 'PT-MCH', 'PT', 'EA', 0, 'LOT'],
    ['TMP-FS7023', 'Flange Base', 'AL 다이캐스트', 'PT-MCH', 'PT', 'EA', 0, 'LOT'],
    ['GB-8010', 'Gearbox Housing', 'AL 다이캐스트', 'PT-MCH', 'PT', 'EA', 0, 'NONE'],
    ['GB-8020', 'Input Spur Gear', 'Z=18', 'PT-MCH', 'PT', 'EA', 0, 'LOT'],
    ['GB-8030', 'Output Spur Gear', 'Z=90', 'PT-MCH', 'PT', 'EA', 0, 'LOT'],
    ['PL-9010', 'Parking Gear Ring', 'SCM440', 'PT-MCH', 'PT', 'EA', 0, 'LOT'],
    ['PL-9020', 'Parking Pawl', 'SCM435', 'PT-MCH', 'PT', 'EA', 0, 'LOT'],
    ['PL-9040', 'Actuator Rod', '솔레노이드봉', 'PT-MCH', 'PT', 'EA', 0, 'LOT'],
    ['PC-4010', 'Main PCB', 'FR-4 4L', 'PT-ELE', 'PT', 'EA', 0, 'LOT'],
    ['PC-4011', 'Hall PCB', 'FR-4 2L', 'PT-ELE', 'PT', 'EA', 0, 'LOT'],
    ['HS-4020', 'Hall Sensor', 'SS41F', 'PT-ELE', 'PT', 'EA', 0, 'LOT'],
    ['MO-4030', 'Power MOSFET', '100V/60A', 'PT-ELE', 'PT', 'EA', 0, 'LOT'],
    ['GD-4040', 'Gate Driver IC', 'Half-Bridge', 'PT-ELE', 'PT', 'EA', 0, 'LOT'],
    ['CP-4050', 'Electrolytic Cap', '470uF/63V', 'PT-ELE', 'PT', 'EA', 0, 'NONE'],
    ['HK-4060', 'Heatsink', 'AL 방열', 'PT-ELE', 'PT', 'EA', 0, 'NONE'],
    ['BB-4070', 'Bus Bar', '동 3.0t', 'PT-ELE', 'PT', 'EA', 0, 'NONE'],
    ['CN-4030', 'Signal Connector', 'JST XH 5P', 'PT-ELE', 'PT', 'EA', 0, 'NONE'],
    ['LW-1050', 'Lead Wire', 'AWG18 L300', 'PT-ELE', 'PT', 'EA', 0, 'NONE'],
    ['TM-1060', 'Terminal Lug', 'φ3.2', 'PT-ELE', 'PT', 'EA', 0, 'NONE'],
    ['BT-3070', 'Bolt', 'M4×20 SUS304', 'PT-FST', 'PT', 'EA', 0, 'NONE'],
    ['WW-3060', 'Wave Washer', 'SUS304 φ12', 'PT-FST', 'PT', 'EA', 0, 'NONE'],
    ['PL-9030', 'Return Spring', 'SUS304', 'PT-FST', 'PT', 'EA', 0, 'LOT'],
    ['OR-5020', 'O-Ring', 'NBR P24', 'PT-FST', 'PT', 'EA', 0, 'NONE'],
    ['OR-7025', 'O-Ring (Shaft Seal)', 'NBR', 'PT-FST', 'PT', 'EA', 0, 'NONE'],
    ['IN-1020U', 'Insulator Upper', 'PBT+GF30', 'PT-ETC', 'PT', 'EA', 0, 'NONE'],
    ['IN-1020L', 'Insulator Lower', 'PBT+GF30', 'PT-ETC', 'PT', 'EA', 0, 'NONE'],
    ['BW-2050', 'Balancing Weight', 'Fe계', 'PT-ETC', 'PT', 'EA', 0, 'NONE'],
    ['NP-5010', 'Name Plate', 'AL 에칭', 'PT-ETC', 'PT', 'EA', 0, 'NONE'],
    ['CG-5030', 'Cable Gland', 'PG9', 'PT-ETC', 'PT', 'EA', 0, 'NONE'],
    ['IV-1070', 'Impregnation Varnish', '에폭시', 'CN-CHM', 'CN', 'g', 0, 'LOT'],
    ['AD-2040', 'Adhesive', '락타이트 638', 'CN-CHM', 'CN', 'g', 0, 'LOT'],
    ['GB-8050', 'Gear Oil/Grease', '리튬계', 'CN-CHM', 'CN', 'g', 0, 'LOT'],
    ['SP-4040', 'Solder Paste', 'SAC305', 'CN-CHM', 'CN', 'g', 0, 'LOT'],
    ['IP-1040', 'Insulation Paper', 'Nomex 410', 'CN-INS', 'CN', 'SHT', 0, 'NONE'],
    ['LC-1080', 'Lacing Cord', '폴리에스터', 'CN-INS', 'CN', 'm', 0, 'NONE'],
    ['TMP-PK0010', 'Carton', '골판지 외장 박스', 'PK-BOX', 'PK', 'EA', 0, 'NONE'],
  ];
  const MOCK_BASE = { 'TMP-SC1010P': [80, 'SHT'] };   // bom_header.base_qty (그 외 1 EA)
  // [parent, child, qtyPer, uom, op|null, note]  — op null 이면 미배정, 자식이 팬텀이면 bop.state=phantom
  const MOCK_LINES = [
    ['BLDC-500W-48V', 'SA-1000', 1, 'EA', 'OP-B50'], ['BLDC-500W-48V', 'RA-2000', 1, 'EA', 'OP-B70'],
    ['BLDC-500W-48V', 'HA-3000', 1, 'EA', null], ['BLDC-500W-48V', 'EX-5000', 1, 'EA', null], ['BLDC-500W-48V', 'PE-6000', 1, 'EA', null],
    ['BLDC-500W-48V', 'FS-7010', 1, 'EA', null, '미배정 — 체결 공정이 BOP 에 없다 (쟁점 3)'],
    ['BLDC-500W-48V', 'FS-7020', 1, 'EA', null, '미배정 — 체결 공정이 BOP 에 없다 (쟁점 3)'],
    ['BLDC-500W-48V', 'GB-8000', 1, 'EA', null, '미배정 — OP-B85 가 만들지만 체결 공정이 BOP 에 없다 (쟁점 3)'],
    ['BLDC-500W-48V', 'PL-9000', 1, 'EA', null, '미배정 — OP-B87 이 만들지만 체결 공정이 BOP 에 없다 (쟁점 3)'],
    ['BLDC-500W-48V', 'TMP-PK0010', 1, 'EA', 'OP-B120'],
    ['SA-1000', 'SC-1010', 1, 'EA', 'OP-A30'], ['SA-1000', 'IN-1020U', 1, 'EA', 'OP-A30'], ['SA-1000', 'IN-1020L', 1, 'EA', 'OP-A30'],
    ['SA-1000', 'IP-1040', 12, 'SHT', null, '미배정 — 원천과 상충 (쟁점 6)'], ['SA-1000', 'MW-1030', 180, 'g', 'OP-A40'],
    ['SA-1000', 'LC-1080', 0.5, 'm', null, '미배정 — 원천과 상충 (쟁점 6)'], ['SA-1000', 'LW-1050', 3, 'EA', 'OP-A60'], ['SA-1000', 'TM-1060', 3, 'EA', 'OP-A60'],
    ['SA-1000', 'IV-1070', 15, 'g', 'OP-A80'],
    ['SC-1010', 'TMP-SC1010P', 80, 'SHT', 'OP-A20'],
    ['TMP-SC1010P', 'SC-1011', 0.85, 'kg', 'OP-A10', '0.85 kg/80매는 코일 투입 실측(GROSS) — 낱장 실중량 미측정'],
    ['RA-2000', 'SH-2010', 1, 'EA', 'OP-B10'], ['RA-2000', 'RC-2020', 1, 'EA', 'OP-B10'], ['RA-2000', 'PM-2030', 8, 'EA', 'OP-B20'], ['RA-2000', 'AD-2040', 0.5, 'g', 'OP-B20'], ['RA-2000', 'BW-2050', 2, 'EA', 'OP-B40'],
    ['HA-3000', 'HS-3010', 1, 'EA', 'OP-B50'], ['HA-3000', 'BF-3040', 1, 'EA', 'OP-B60'], ['HA-3000', 'BR-3050', 1, 'EA', 'OP-B60'], ['HA-3000', 'WW-3060', 1, 'EA', 'OP-B60'],
    ['HA-3000', 'BP-3020F', 1, 'EA', 'OP-B80'], ['HA-3000', 'BP-3020R', 1, 'EA', 'OP-B80'], ['HA-3000', 'BT-3070', 8, 'EA', 'OP-B80'],
    ['EX-5000', 'OR-5020', 1, 'EA', 'OP-B100'], ['EX-5000', 'CG-5030', 1, 'EA', 'OP-B100'], ['EX-5000', 'NP-5010', 1, 'EA', 'OP-B120'],
    ['PE-6000', 'PC-4010', 1, 'EA', 'OP-B90'], ['PE-6000', 'PC-4011', 1, 'EA', 'OP-B90'], ['PE-6000', 'HS-4020', 3, 'EA', 'OP-B90'], ['PE-6000', 'MO-4030', 6, 'EA', 'OP-B90'],
    ['PE-6000', 'GD-4040', 3, 'EA', 'OP-B90'], ['PE-6000', 'CP-4050', 4, 'EA', 'OP-B90'], ['PE-6000', 'HK-4060', 1, 'EA', 'OP-B90'], ['PE-6000', 'BB-4070', 3, 'EA', 'OP-B90'],
    ['PE-6000', 'SP-4040', 0.5, 'g', 'OP-B90'], ['PE-6000', 'CN-4030', 1, 'EA', 'OP-B100'],
    ['FS-7020', 'TMP-FS7023', 1, 'EA', null, '미배정 — FS-70xx 5종은 BOP 에 없다 (쟁점 3)'],
    ['FS-7020', 'FS-7021', 1, 'EA', null, '미배정·부모 추정 (쟁점 3, V12-1)'], ['FS-7020', 'FS-7022', 1, 'EA', null, '미배정·부모 추정 (쟁점 3, V12-1)'],
    ['FS-7020', 'OR-7025', 2, 'EA', null, '미배정·부모 추정 — Shaft Seal 이라 FS-7010 쪽일 수도 (쟁점 3)'],
    ['GB-8000', 'GB-8010', 1, 'EA', 'OP-B85'], ['GB-8000', 'GB-8020', 1, 'EA', 'OP-B85'], ['GB-8000', 'GB-8030', 1, 'EA', 'OP-B85'], ['GB-8000', 'GB-8040', 2, 'EA', 'OP-B85'], ['GB-8000', 'GB-8050', 25, 'g', 'OP-B85'],
    ['PL-9000', 'PL-9010', 1, 'EA', 'OP-B87'], ['PL-9000', 'PL-9020', 1, 'EA', 'OP-B87'], ['PL-9000', 'PL-9030', 1, 'EA', 'OP-B87'], ['PL-9000', 'PL-9040', 1, 'EA', 'OP-B87'],
  ];
  const MOCK_PROCS = [
    ['OP-A10', 1, '아마추어 라인', '규소강판 블랭킹'], ['OP-A20', 2, '아마추어 라인', '코어 적층/결합'], ['OP-A30', 3, '아마추어 라인', '인슐레이터 조립'], ['OP-A40', 4, '아마추어 라인', 'Needle Winding (권선)'],
    ['OP-A50', 5, '아마추어 라인', '결선/포밍'], ['OP-A60', 6, '아마추어 라인', '리드선 납땜'], ['OP-A70', 7, '아마추어 라인', '절연저항/내전압'], ['OP-A80', 8, '아마추어 라인', '바니시 함침 (VPI)'],
    ['OP-A90', 9, '아마추어 라인', '큐어링/건조'], ['OP-A100', 10, '아마추어 라인', '아마추어 최종검사'],
    ['OP-B10', 1, '조립 라인', '샤프트/로터코어 압입'], ['OP-B20', 2, '조립 라인', '마그넷 접착'], ['OP-B30', 3, '조립 라인', '마그넷 착자'], ['OP-B40', 4, '조립 라인', '로터 다이나믹 밸런싱'],
    ['OP-B50', 5, '조립 라인', '스테이터 압입 (Housing)'], ['OP-B60', 6, '조립 라인', '베어링 압입'], ['OP-B70', 7, '조립 라인', '로터 삽입'], ['OP-B80', 8, '조립 라인', '브라켓 체결'],
    ['OP-B85', 9, '조립 라인', '기어박스 조립'], ['OP-B87', 10, '조립 라인', '파킹락 조립'], ['OP-B90', 11, '조립 라인', 'Power Electronics 조립'], ['OP-B100', 12, '조립 라인', '커넥터/케이블 결선'],
    ['OP-B110', 13, '조립 라인', '성능/기능 시험'], ['OP-B120', 14, '조립 라인', '각인/외관검사/포장'],
  ];
  // [op, item, isFinal, outState, qtyOut] — cleansing process_out
  const MOCK_OUT = [
    ['OP-A10', 'TMP-SC1010P', 1, null, 80], ['OP-A20', 'SC-1010', 1, null, 1], ['OP-A30', 'SA-1000', 0, '인슐레이터 결합코어'], ['OP-A40', 'SA-1000', 0, '3상 권선 스테이터'],
    ['OP-A50', 'SA-1000', 0, '결선 완료품'], ['OP-A60', 'SA-1000', 0, '리드 부착품'], ['OP-A70', 'SA-1000', 0, 'QC 합격품'], ['OP-A80', 'SA-1000', 0, '함침 스테이터'],
    ['OP-A90', 'SA-1000', 0, '경화 완료품'], ['OP-A100', 'SA-1000', 1, null, 1], ['OP-B10', 'RA-2000', 0, '로터 서브'], ['OP-B20', 'RA-2000', 0, '마그넷 부착 로터'],
    ['OP-B30', 'RA-2000', 0, '착자 로터'], ['OP-B40', 'RA-2000', 1, null, 1], ['OP-B50', 'BLDC-500W-48V', 0, '하우징+스테이터'], ['OP-B60', 'BLDC-500W-48V', 0, '브라켓 서브'],
    ['OP-B70', 'BLDC-500W-48V', 0, '로터 삽입 완료'], ['OP-B80', 'BLDC-500W-48V', 0, '하우징 완성'], ['OP-B85', 'GB-8000', 1, null, 1], ['OP-B87', 'PL-9000', 1, null, 1],
    ['OP-B90', 'BLDC-500W-48V', 0, '제어부 결합'], ['OP-B100', 'BLDC-500W-48V', 0, '결선 완료'], ['OP-B110', 'BLDC-500W-48V', 0, '시험 합격품'], ['OP-B120', 'BLDC-500W-48V', 1, null, 1],
  ];
  // 로트 표본 — 계획서 §3.3 V-9 계보 1건 (밀시트 MS-8842 → 시리얼). [id, lotNo, pn, kind, qty, uom, status, parentId, supplier, supplierLot, made]
  const MOCK_LOTS = [
    [1, 'LOT-SC1011-260912-A', 'SC-1011', 'LOT', 849.15, 'kg', 'AVAILABLE', null, 'POSCO', 'MS-8842', '2026-09-12'],
    [2, 'SUB-SC1011-A-001', 'SC-1011', 'SUBLOT', 0, 'kg', 'CONSUMED', 1, 'POSCO', 'MS-8842', '2026-09-12'],
    [3, 'LOT-SC1010P-260912-0007', 'TMP-SC1010P', 'LOT', 0, 'SHT', 'CONSUMED', null, null, null, '2026-09-12'],
    [4, 'LOT-SC1010-260912-0007', 'SC-1010', 'LOT', 0, 'EA', 'CONSUMED', null, null, null, '2026-09-12'],
    [5, 'LOT-MW1030-260901-B', 'MW-1030', 'LOT', 4820, 'g', 'AVAILABLE', null, 'LS전선', 'W-2026-0901', '2026-09-01'],
    [6, 'LOT-SA1000-260912-031', 'SA-1000', 'LOT', 0, 'EA', 'CONSUMED', null, null, null, '2026-09-12'],
    [7, 'SN-BLDC-2026-000481', 'BLDC-500W-48V', 'SERIAL', 1, 'EA', 'AVAILABLE', null, null, null, '2026-09-12'],
  ];
  // 투입 간선 [outLotId, inLotId, op, qtyConsumed, uom]
  const MOCK_GEN = [[3, 2, 'OP-A10', 0.85, 'kg'], [4, 3, 'OP-A20', 80, 'SHT'], [6, 4, 'OP-A30', 1, 'EA'], [6, 5, 'OP-A40', 180, 'g'], [7, 6, 'OP-B50', 1, 'EA']];

  function buildMock() {
    const classes = MOCK_CLASSES.map(([code, name, parent], i) => ({ id: i + 1, code, name, parentCode: parent, parentId: null, level: parent ? 1 : 0, itemCount: 0, isLeaf: !!parent, sortNo: i + 1 }));   // 배열 순서 = cleansing sort
    const cById = new Map(classes.map(c => [c.code, c]));
    classes.forEach(c => { c.parentId = c.parentCode ? cById.get(c.parentCode).id : null; delete c.parentCode; });
    const items = MOCK_ITEMS.map(([pn, name, spec, cls, type, uom, phantom, trace]) => {
      const c = cById.get(cls); c.itemCount++;
      return { pn, name, spec, kind: phantom ? 'PHANTOM' : type, itemType: type, classId: c.id, className: c.name, uom, status: 'ACTIVE', traceKind: trace, isTmp: pn.startsWith('TMP-'), phantom: !!phantom };
    });
    const iByPn = new Map(items.map(i => [i.pn, i]));
    const headers = []; const hByParent = new Map();
    let lid = 0;
    const lines = MOCK_LINES.map(([parentPn, pn, qtyPer, uom, op, note]) => {
      let h = hByParent.get(parentPn);
      if (!h) { const [bq, bu] = MOCK_BASE[parentPn] || [1, 'EA']; h = { id: headers.length + 1, parentPn, baseQty: bq, baseUom: bu, status: 'ACTIVE', effFrom: '2026-01-01', effTo: '9999-12-31', rev: 'A', lineCount: 0 }; headers.push(h); hByParent.set(parentPn, h); }
      h.lineCount++;
      return { lineId: ++lid, headerId: h.id, lineNo: h.lineCount * 10, parentPn, pn, qtyPer, uom, op, note: note || null, qtyBasis: pn === 'SC-1011' ? 'GROSS' : 'NET', scrapRate: 0, effFrom: '2026-01-01', effTo: '9999-12-31' };
    });
    const procs = MOCK_PROCS.map(([op, seq, line, name]) => ({ op, seq, line, name, productCode: 'BLDC-500W-48V' }));
    const INIT = { 1: 850, 2: 0.85, 3: 80, 4: 1, 5: 5000, 6: 1, 7: 1 };   // qty_init (생성 시 수량, D-17)
    const lots = MOCK_LOTS.map(([id, lotNo, pn, kind, q, uom, status, parentLotId, supplier, supplierLot, madeAt]) => ({ id, lotNo, pn, name: iByPn.get(pn)?.name, kind, qty: q, qtyInit: INIT[id] ?? q, uom, status, parentLotId, parentLotNo: parentLotId ? MOCK_LOTS.find(x => x[0] === parentLotId)?.[1] : null, supplier, supplierLot, madeAt }));
    return { classes, items, iByPn, headers, hByParent, lines, nextLineId: lid, procs, lots, gen: MOCK_GEN.map(([outLotId, inLotId, op, qtyConsumed, uom]) => ({ outLotId, inLotId, op, qtyConsumed, uom })), importedAt: null };
  }

  /** 목 라우터 — §10 표의 라우트만. 트리거 흉내: 자기참조·순환·승인 라인 삭제는 400 과 같은 'R-1: …' / 'R-11: …' 문자열로 throw */
  function mockApi(db) {
    const bopState = (l) => { const child = db.iByPn.get(l.pn); return child?.phantom ? 'phantom' : l.op ? 'linked' : 'unassigned'; };
    const nodeOf = (l, level, parentQpp, parentBase) => {
      const child = db.iByPn.get(l.pn) || { name: '?', kind: '?', uom: l.uom };
      const qpp = parentQpp * l.qtyPer / parentBase;
      const h = db.hByParent.get(l.pn);
      const n = { lineId: l.lineId, headerId: l.headerId, lineNo: l.lineNo, level, parentPn: l.parentPn, pn: l.pn, name: child.name, kind: child.kind, uom: l.uom, qtyPer: l.qtyPer, qtyPerProduct: qpp,
        scrapRate: l.scrapRate, qtyBasis: l.qtyBasis, phantom: !!child.phantom, isTmp: !!child.isTmp, bop: { op: l.op, mode: l.op ? 'IN' : null, state: bopState(l) }, effFrom: l.effFrom, effTo: l.effTo, note: l.note, children: [] };
      if (h) n.children = db.lines.filter(x => x.headerId === h.id).map(x => nodeOf(x, level + 1, qpp, h.baseQty));
      return n;
    };
    const bomOf = (pn, depth) => {
      const root = db.iByPn.get(pn); const h = db.hByParent.get(pn);
      if (!root) throw new Error('품목 없음: ' + pn);
      const nodes = h ? db.lines.filter(l => l.headerId === h.id).map(l => nodeOf(l, 1, 1, h.baseQty)) : [];
      const totals = {}; const walk = (ns) => ns.forEach(n => { if (n.children.length) walk(n.children); else if (!n.phantom) totals[n.uom] = Math.round(((totals[n.uom] || 0) + n.qtyPerProduct) * 1e6) / 1e6; });
      walk(nodes);
      const prune = (ns, d) => ns.forEach(n => { if (d >= depth) n.children = []; else prune(n.children, d + 1); });
      if (depth) prune(nodes, 1);
      return { root: { pn: root.pn, name: root.name, kind: root.kind, uom: root.uom }, asOf: today(), nodes, totals };
    };
    const descendants = (pn, acc = new Set()) => { const h = db.hByParent.get(pn); if (h) for (const l of db.lines) if (l.headerId === h.id && !acc.has(l.pn)) { acc.add(l.pn); descendants(l.pn, acc); } return acc; };
    const summary = () => {
      const unassigned = db.lines.filter(l => bopState(l) === 'unassigned').length;
      const check = {}; if (unassigned) { check['D-8'] = unassigned; check['R-10'] = unassigned; }
      return { items: db.items.length, classes: db.classes.length, bomHeaders: db.headers.length, bomLines: db.lines.length, lots: db.lots.length, check };
    };
    const lotOut = (l) => ({ ...l, name: db.iByPn.get(l.pn)?.name });
    const genTree = (id, dir, seen = new Set()) => {
      const lot = db.lots.find(l => l.id === id); if (!lot || seen.has(id)) return []; seen.add(id);
      const kids = [];
      if (dir === 'back') {   // 역방향: 이 로트에 들어간 것 (투입 간선) + 이 로트가 분할된 원로트
        // edge 형태는 서버와 동일: { kind: 'SPLIT'|'CONSUME', qty, uom, op, equipment, user, at }
        for (const g of db.gen.filter(g => g.outLotId === id)) kids.push({ ...lotOut(db.lots.find(l => l.id === g.inLotId)), edge: { kind: 'CONSUME', qty: g.qtyConsumed, uom: g.uom, op: g.op, equipment: null, user: null, at: null }, children: genTree(g.inLotId, dir, seen) });
        if (lot.parentLotId) { const p = db.lots.find(l => l.id === lot.parentLotId); kids.push({ ...lotOut(p), edge: { kind: 'SPLIT', qty: lot.qtyInit ?? lot.qty, uom: lot.uom, op: null }, children: genTree(p.id, dir, seen) }); }
      } else {                // 정방향: 이 로트가 들어간 것 + 이 로트에서 분할된 서브로트
        for (const s of db.lots.filter(l => l.parentLotId === id)) kids.push({ ...lotOut(s), edge: { kind: 'SPLIT', qty: s.qtyInit ?? s.qty, uom: s.uom, op: null }, children: genTree(s.id, dir, seen) });
        for (const g of db.gen.filter(g => g.inLotId === id)) kids.push({ ...lotOut(db.lots.find(l => l.id === g.outLotId)), edge: { kind: 'CONSUME', qty: g.qtyConsumed, uom: g.uom, op: g.op, equipment: null, user: null, at: null }, children: genTree(g.outLotId, dir, seen) });
      }
      return kids;
    };
    const bad = (msg) => { throw new Error(msg); };
    return async function (path, opts = {}) {
      await new Promise(r => setTimeout(r, 60));
      const m = opts.method || 'GET'; const body = opts.body ? JSON.parse(opts.body) : {};
      const [p, q] = path.split('?'); const query = Object.fromEntries(new URLSearchParams(q || ''));
      const seg = p.replace(/^\/api\/admin\/materials\/?/, '').split('/').map(decodeURIComponent);
      if (p === '/api/admin/equipments') return { equipments: [], processes: db.procs };
      if (seg[0] === 'summary') return summary();
      if (seg[0] === 'check') { const un = db.lines.filter(l => bopState(l) === 'unassigned'); const s = summary(); return { summary: s.check, details: un.length ? { 'D-8': un.map(l => `${l.parentPn} > ${l.pn}`), 'R-10': un.map(l => `${l.parentPn} > ${l.pn} split=0 (UNASSIGNED)`) } : {} }; }
      if (seg[0] === 'process' && seg.length === 1 && m === 'GET') return db.procs.map(p => ({ ...p, inCount: db.lines.filter(l => l.op === p.op).length, outCount: MOCK_OUT.filter(o => o[0] === p.op).length }));
      if (seg[0] === 'uom') return [['EA', '개', 'COUNT', 0], ['SHT', '매', 'COUNT', 0], ['kg', '킬로그램', 'MASS', 3], ['g', '그램', 'MASS', 2], ['m', '미터', 'LENGTH', 2]].map(([code, name, kind, decimals]) => ({ code, name, kind, decimals }));
      if (seg[0] === 'classes') return db.classes;
      if (seg[0] === 'items' && seg.length === 1 && m === 'GET') {
        const ql = (query.q || '').toLowerCase();
        return db.items.filter(i => (!ql || i.pn.toLowerCase().includes(ql) || i.name.toLowerCase().includes(ql) || (i.spec || '').toLowerCase().includes(ql))
          && (!query.classId || String(i.classId) === query.classId) && (!query.status || i.status === query.status) && (!query.kind || i.kind === query.kind));
      }
      if (seg[0] === 'items' && seg.length === 2 && m === 'GET') {
        const it = db.iByPn.get(seg[1]); if (!it) bad('품목 없음: ' + seg[1]);
        const whereUsed = db.lines.filter(l => l.pn === it.pn).map(l => { const h = db.headers.find(x => x.id === l.headerId); return { parentPn: l.parentPn, parentName: db.iByPn.get(l.parentPn)?.name, qtyPer: l.qtyPer, uom: l.uom, headerId: l.headerId, status: h.status }; });
        const hs = db.headers.filter(h => h.parentPn === it.pn).map(h => ({ id: h.id, status: h.status, effFrom: h.effFrom, effTo: h.effTo, lineCount: h.lineCount, rev: h.rev, baseQty: h.baseQty, baseUom: h.baseUom }));
        const outAt = MOCK_OUT.filter(o => o[1] === it.pn).map(([op, , isFinal, outState, qtyOut]) => ({ op, isFinal: !!isFinal, outState, qtyOut: qtyOut ?? null }));
        const inAt = [...new Set(db.lines.filter(l => l.pn === it.pn && l.op).map(l => l.op))];
        return { item: it, whereUsed, headers: hs, lots: db.lots.filter(l => l.pn === it.pn).length, outAt, inAt };
      }
      if (seg[0] === 'items' && (m === 'POST' || m === 'PUT')) {
        const pn = m === 'PUT' ? seg[1] : body.pn; if (!pn) bad('pn 필수');
        if (/[\/ ]/.test(pn) || pn.length > 32) bad("R-20: 품번에 '/'·공백 불가, 32자 이하");
        let it = db.iByPn.get(pn);
        if (!it) { const c = db.classes.find(x => x.id === Number(body.classId)); if (!c || !c.parentId) bad('R-14: 품목은 말단(is_leaf=1) 분류에만 붙는다'); it = { pn, kind: body.kind || 'PT', status: 'DRAFT', uom: body.uom || 'EA', traceKind: 'NONE', isTmp: pn.startsWith('TMP-'), classId: c.id, className: c.name }; db.items.push(it); db.iByPn.set(pn, it); c.itemCount++; }
        Object.assign(it, { name: body.name ?? it.name, spec: body.spec ?? it.spec, status: body.status ?? it.status, traceKind: body.traceKind ?? it.traceKind, uom: body.uom ?? it.uom });
        return { ok: true, item: it };
      }
      if (seg[0] === 'bom' && seg[1]) return bomOf(seg[1], Number(query.depth) || 0);
      if (seg[0] === 'where-used' && seg[1]) {
        const paths = []; const up = (pn, acc) => { const ps = db.lines.filter(l => l.pn === pn); if (!ps.length) { paths.push(acc); return; } for (const l of ps) up(l.parentPn, [...acc, { pn: l.parentPn, name: db.iByPn.get(l.parentPn)?.name, qtyPer: l.qtyPer, uom: l.uom }]); };
        up(seg[1], []); return { pn: seg[1], paths: paths.filter(x => x.length) };
      }
      if (seg[0] === 'bom-headers' && m === 'GET') return db.headers.filter(h => h.parentPn === seg[1]).map(h => ({ ...h }));
      if (seg[0] === 'bom-headers' && m === 'POST') {
        const it = db.iByPn.get(body.parentPn); if (!it) bad('부모 품목 없음: ' + body.parentPn);
        if (db.hByParent.get(it.pn)) bad('UNIQUE: 같은 부모·bom_type·alt_no·rev 의 헤더가 이미 있다 (rev 는 ECO 로만 올린다)');
        const h = { id: db.headers.length + 1, parentPn: it.pn, baseQty: Number(body.baseQty) || 1, baseUom: it.uom, status: 'DRAFT', effFrom: body.effFrom || today(), effTo: '9999-12-31', rev: 'A', lineCount: 0 };
        db.headers.push(h); db.hByParent.set(it.pn, h); return { ok: true, header: h };
      }
      if (seg[0] === 'bom-headers' && m === 'PUT') {
        const h = db.headers.find(x => x.id === Number(seg[1])); if (!h) bad('헤더 없음');
        if (body.status && body.status !== h.status && !HEADER_NEXT[h.status].includes(body.status)) bad(`상태 전이 불가: ${h.status} → ${body.status} (DRAFT→APPROVED→ACTIVE→OBSOLETE)`);
        if (body.effTo && (body.effFrom || h.effFrom) > body.effTo) bad('D-6: valid_to >= valid_from');
        Object.assign(h, { status: body.status ?? h.status, effFrom: body.effFrom ?? h.effFrom, effTo: body.effTo ?? h.effTo, note: body.note ?? h.note }); return { ok: true, header: h };
      }
      if (seg[0] === 'bom-lines' && m === 'POST') {
        const h = db.headers.find(x => x.id === Number(body.headerId)); if (!h) bad('headerId 없음');
        const child = db.iByPn.get(body.childPn); if (!child) bad('자식 품목 없음: ' + body.childPn);
        if (child.pn === h.parentPn || descendants(child.pn).has(h.parentPn)) bad('R-1: BOM 순환 참조 — 자식의 하위 구조에 부모가 있다 (또는 깊이 64 초과)');
        if (!(Number(body.qtyPer) > 0)) bad('CHECK: qty_per > 0');
        if (db.lines.some(l => l.headerId === h.id && l.pn === child.pn && l.effFrom === (body.effFrom || '2026-01-01'))) bad('R-3: 같은 부모 밑 같은 자식 중복 (ux_bom_line_dup)');
        const l = { lineId: ++db.nextLineId, headerId: h.id, lineNo: Number(body.lineNo) || (h.lineCount + 1) * 10, parentPn: h.parentPn, pn: child.pn, qtyPer: Number(body.qtyPer), uom: body.uom || child.uom, op: null, note: body.note || null, qtyBasis: body.qtyBasis || 'NET', scrapRate: Number(body.scrapRate) || 0, effFrom: body.effFrom || '2026-01-01', effTo: body.effTo || '9999-12-31' };
        db.lines.push(l); h.lineCount++; return { ok: true, line: l };
      }
      if (seg[0] === 'bom-lines' && m === 'PUT') {
        const l = db.lines.find(x => x.lineId === Number(seg[1])); if (!l) bad('라인 없음');
        if (body.childPn && body.childPn !== l.pn) { const c = db.iByPn.get(body.childPn); if (!c) bad('자식 품목 없음: ' + body.childPn); if (c.pn === l.parentPn || descendants(c.pn).has(l.parentPn)) bad('R-1: BOM 순환 참조 — UPDATE 결과 자식의 하위 구조에 부모가 생긴다 (또는 깊이 64 초과)'); l.pn = c.pn; }
        if (body.qtyPer !== undefined && !(Number(body.qtyPer) > 0)) bad('CHECK: qty_per > 0');
        if (body.effTo && (body.effFrom || l.effFrom) > body.effTo) bad('D-6: valid_to >= valid_from');
        for (const k of ['qtyPer', 'uom', 'lineNo', 'qtyBasis', 'scrapRate', 'effFrom', 'effTo', 'note']) if (body[k] !== undefined) l[k] = (k === 'qtyPer' || k === 'lineNo' || k === 'scrapRate') ? Number(body[k]) : body[k];
        return { ok: true, line: l };
      }
      if (seg[0] === 'bom-lines' && m === 'DELETE') {
        const i = db.lines.findIndex(x => x.lineId === Number(seg[1])); if (i < 0) bad('라인 없음');
        const h = db.headers.find(x => x.id === db.lines[i].headerId);
        if (h.status !== 'DRAFT') bad('R-11: 승인된 BOM 의 라인은 삭제하지 않는다 — valid_to 를 끊어라');
        db.lines.splice(i, 1); h.lineCount--; return { ok: true };
      }
      if (seg[0] === 'process' && seg[1] && seg.length === 2) {
        const op = seg[1]; if (!db.procs.some(x => x.op === op)) bad('공정 없음: ' + op);
        const inputs = db.lines.filter(l => l.op === op).map((l, i) => ({ lineId: l.lineId, parentPn: l.parentPn, pn: l.pn, name: db.iByPn.get(l.pn)?.name, qtyPer: l.qtyPer, qtyPerProduct: l.qtyPer, uom: l.uom, seq: i + 1, splitPct: 100, issueMethod: 'BACKFLUSH' }));
        const outputs = MOCK_OUT.filter(o => o[0] === op).map(([, pn, isFinal, outState, qtyOut]) => ({ pn, name: db.iByPn.get(pn)?.name, isFinal: !!isFinal, outState, qtyOut: qtyOut ?? null, uom: db.iByPn.get(pn)?.uom }));
        const unassigned = db.lines.filter(l => bopState(l) === 'unassigned').map(l => ({ lineId: l.lineId, parentPn: l.parentPn, pn: l.pn, name: db.iByPn.get(l.pn)?.name, qtyPer: l.qtyPer, uom: l.uom, note: l.note }));
        return { op, inputs, outputs, unassigned };
      }
      if (seg[0] === 'process' && seg[2] === 'links' && m === 'PUT') {
        const op = seg[1]; const want = new Set((body.links || []).filter(x => x.mode !== 'OUT').map(x => Number(x.lineId)));
        for (const id of want) { const l = db.lines.find(x => x.lineId === id); if (!l) bad('라인 없음: ' + id); if (db.iByPn.get(l.pn)?.phantom) bad('D-8: 팬텀(PHANTOM)·미연결(NONE) 라인에는 투입(IN) 행을 둘 수 없다'); }
        for (const l of db.lines) { if (l.op === op && !want.has(l.lineId)) l.op = null; if (want.has(l.lineId)) l.op = op; }
        return { ok: true, op, count: want.size };
      }
      if (seg[0] === 'lots' && seg.length === 1 && m === 'GET') { const ql = (query.q || '').toLowerCase(); return db.lots.filter(l => (!query.pn || l.pn === query.pn) && (!ql || l.lotNo.toLowerCase().includes(ql) || (l.supplierLot || '').toLowerCase().includes(ql))).map(lotOut); }
      if (seg[0] === 'lots' && m === 'POST') {
        if (!body.lotNo || !body.pn) bad('lotNo·pn 필수'); if (db.lots.some(l => l.lotNo === body.lotNo)) bad('UNIQUE: lot_no 중복');
        const it = db.iByPn.get(body.pn); if (!it) bad('품목 없음: ' + body.pn); if (it.phantom) bad('V12-7: 팬텀 품목은 로트를 가질 수 없다');
        const l = { id: db.lots.length + 1, lotNo: body.lotNo, pn: it.pn, kind: body.kind || 'LOT', qty: Number(body.qty) || 0, uom: it.uom, status: 'AVAILABLE', parentLotId: body.parentLotId ? Number(body.parentLotId) : null, supplier: body.supplier || null, supplierLot: body.supplierLot || null, madeAt: body.madeAt || today() };
        if (l.kind === 'SERIAL' && l.qty > 1) bad('CHECK: 시리얼은 개체 1'); db.lots.push(l); return { ok: true, lot: lotOut(l) };
      }
      if (seg[0] === 'lots' && seg[2] === 'consume' && m === 'POST') {
        const out = db.lots.find(l => l.id === Number(seg[1])); if (!out) bad('산출 로트가 없습니다.');
        const inLot = db.lots.find(l => l.lotNo === body.inLotNo || (body.inLotId && l.id === Number(body.inLotId))); if (!inLot) bad('투입 로트(inLotId|inLotNo)가 없습니다.');
        if (inLot.id === out.id) bad('R-13: 로트 계보 순환 — 산출 로트의 하류에 투입 로트가 이미 있다 (또는 깊이 64 초과)');
        if (!(Number(body.qty) > 0)) bad('qty 는 0 보다 커야 합니다.');
        if (inLot.qty < Number(body.qty)) bad(`D-17: 투입 로트 잔량(${inLot.qty})보다 큰 수량은 투입할 수 없습니다 (force 로 무시 가능).`);
        db.gen.push({ outLotId: out.id, inLotId: inLot.id, op: body.op || null, qtyConsumed: Number(body.qty), uom: inLot.uom });
        inLot.qty = Math.round((inLot.qty - Number(body.qty)) * 1e6) / 1e6; if (inLot.qty <= 0 && inLot.status === 'AVAILABLE') inLot.status = 'CONSUMED';
        return { ok: true, outLot: lotOut(out), inLot: lotOut(inLot) };
      }
      if (seg[0] === 'lots' && seg[2] === 'genealogy') { const lot = db.lots.find(l => l.id === Number(seg[1])); if (!lot) bad('로트 없음'); return { lot: lotOut(lot), dir: query.dir === 'fwd' ? 'fwd' : 'back', tree: genTree(lot.id, query.dir === 'fwd' ? 'fwd' : 'back') }; }
      if (seg[0] === 'import-sample' && m === 'POST') { db.importedAt = new Date().toISOString(); const s = summary(); return { ok: true, counts: { uom: 5, mat_class: 24, item: 60, bom_header: 11, bom_line: 59, process_material_in: 46, process_material_out: 24 }, check: s.check, expectedMatch: true, mismatches: [] }; }
      bad('목에 없는 라우트: ' + m + ' ' + p);
    };
  }

  // ── 골격 ──────────────────────────────────────────────
  const KIND_OPTS = [['FG', '완제품'], ['SA', '조립품'], ['PHANTOM', '팬텀'], ['PT', '단품'], ['RM', '원자재'], ['CN', '부자재'], ['PK', '포장재']];
  const KIND_ALIAS = { PART: 'PT', RAW: 'RM', PKG: 'PK' };   // §10 표기(PART/RAW/PKG)와 DDL item_type(PT/RM/PK) 둘 다 받는다
  const normKind = (k) => KIND_ALIAS[k] || k;
  const itemKind = (i) => (i?.phantom || i?.isPhantom || normKind(i?.kind) === 'PHANTOM') ? 'PHANTOM' : normKind(i?.kind);   // 서버는 kind=item_type('SA') + phantom:true

  function build(container, api) {
    container.classList.add('fwm');
    container.innerHTML = `
      <h2>자재 관리 <small>품목 분류 트리 · 제품 구조(BOM) 정전개/역전개 · 공정 연결 · 로트 계보 — 기준 <code>docs/4m/자재관리-기준-계획서.md</code> v1.0, 계약 인터페이스 §10</small></h2>
      <div class="fwm-toolbar">
        <button class="fwm-import" title="docs/4m/cleansing-v1.json 을 서버가 읽어 멱등 UPSERT (POST /api/admin/materials/import-sample)">🔩 샘플 적재</button>
        <button class="fwm-reload" title="요약·분류·품목을 다시 읽는다">↻ 새로고침</button>
        <span class="fwm-status muted"></span>
        <span class="fwm-mockflag" hidden title="URL 에 ?mock=1 — 서버 대신 FWMaterials._mock 이 응답한다">목 데이터</span>
      </div>
      <div class="fwm-msg"></div>
      <div class="fwm-import-result"></div>
      <div class="fwm-cards"></div>
      <div class="fwm-check"></div>
      <div class="fwm-layout">
        <aside class="fwm-aside">
          <div class="fwm-aside-head"><b>품목 분류</b><span class="muted fwm-aside-sub"></span><button class="fwm-tree-all" title="분류 필터 해제">전체</button></div>
          <div class="fwm-ctree"></div>
        </aside>
        <main class="fwm-main">
          <div class="fwm-tabs">
            <button data-sec="items" class="on">품목</button><button data-sec="bom">BOM 트리</button><button data-sec="process">공정 연결</button><button data-sec="lots">로트 계보</button>
          </div>
          <section class="fwm-sec" data-sec="items">
            <div class="fwm-filters">
              <input class="fwm-q" placeholder="품번·품명·규격 검색" size="22">
              <select class="fwm-kind"><option value="">모든 종류</option>${KIND_OPTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
              <select class="fwm-status-f"><option value="">모든 상태</option>${Object.entries(STATUS_LABEL).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
              <button class="fwm-search">조회</button>
              <span class="fwm-items-count muted"></span>
              <button class="fwm-new-item fwm-ghost" title="POST /api/admin/materials/items">+ 품목</button>
            </div>
            <div class="fwm-item-form" hidden></div>
            <!-- 2단: 왼쪽 목록 · 오른쪽 상세 (좁으면 CSS 가 한 단으로 내린다) -->
            <div class="fwm-split">
              <div class="fwm-scroll fwm-items-box"></div>
              <div class="fwm-detail"></div>
            </div>
          </section>
          <section class="fwm-sec" data-sec="bom" hidden>
            <div class="fwm-filters">
              <label>부모 품목</label><select class="fwm-bom-root"></select>
              <label>기준일</label><input type="date" class="fwm-asof" title="as-of: 이 날짜에 유효한 헤더·라인만 전개 (Q-1)">
              <label>깊이</label><input type="number" class="fwm-depth" min="0" max="64" step="1" value="0" title="0 = 전부" style="width:56px">
              <button class="fwm-bom-go">전개</button>
              <button class="fwm-bom-expand fwm-ghost">모두 펼침</button><button class="fwm-bom-collapse fwm-ghost">모두 접음</button>
              <span class="fwm-bom-status muted"></span>
            </div>
            <div class="fwm-bom-box"></div>
            <div class="fwm-bom-side">
              <div class="fwm-line-form"></div>
              <div class="fwm-headers"></div>
            </div>
          </section>
          <section class="fwm-sec" data-sec="process" hidden>
            <div class="fwm-filters">
              <label>공정</label><select class="fwm-op"></select>
              <button class="fwm-proc-go">조회</button>
              <span class="fwm-proc-status muted"></span>
            </div>
            <div class="fwm-proc-box"></div>
          </section>
          <section class="fwm-sec" data-sec="lots" hidden>
            <div class="fwm-filters">
              <label>품목</label><input class="fwm-lot-pn" list="fwm-pn-list" placeholder="P/N (비우면 전체)" size="16">
              <input class="fwm-lot-q" placeholder="로트번호·밀시트 검색" size="20">
              <button class="fwm-lot-go">조회</button>
              <button class="fwm-new-lot fwm-ghost" title="POST /api/admin/materials/lots">+ 로트</button>
              <span class="fwm-lot-status muted"></span>
            </div>
            <div class="fwm-lot-form" hidden></div>
            <div class="fwm-scroll fwm-lots-box"></div>
            <div class="fwm-gen-box"></div>
          </section>
        </main>
      </div>
      <datalist id="fwm-pn-list"></datalist>
      <div class="fwm-foot">
        BOM 수량은 <b>부모 base_qty 당 소요(qty_per)</b>이고 "완성품당"은 서버 뷰 <code>v_bom_line_qpp</code>가 경로를 곱해 계산한 값이다(팬텀은 수량 경로에 참여, 재고·로트·투입에는 없음). 말단 합계는 팬텀을 뺀 말단 품목의 완성품 1대당 합(단위별, 환산 없음).
        <b>미배정</b>은 REQUIRED 라인인데 투입(IN) 공정이 없는 것 — 쟁점 3·6 의 10건은 알려진 값이다. 트리거가 거부한 쓰기는 서버가 400 으로 돌려주며 그 문자열(<code>R-1:</code> …)을 그대로 보여 준다. 로트·계보는 3단계 실적 신고가 붙기 전까지 비어 있을 수 있다.
      </div>`;
    const $ = (sel) => container.querySelector(sel);
    const els = {
      status: $('.fwm-status'), msg: $('.fwm-msg'), cards: $('.fwm-cards'), check: $('.fwm-check'), importBtn: $('.fwm-import'), importResult: $('.fwm-import-result'), reload: $('.fwm-reload'), mockflag: $('.fwm-mockflag'),
      ctree: $('.fwm-ctree'), asideSub: $('.fwm-aside-sub'), treeAll: $('.fwm-tree-all'), tabs: [...container.querySelectorAll('.fwm-tabs button')], secs: [...container.querySelectorAll('.fwm-sec')],
      q: $('.fwm-q'), kind: $('.fwm-kind'), statusF: $('.fwm-status-f'), search: $('.fwm-search'), itemsCount: $('.fwm-items-count'), newItem: $('.fwm-new-item'), itemForm: $('.fwm-item-form'), itemsBox: $('.fwm-items-box'), detail: $('.fwm-detail'),
      bomRoot: $('.fwm-bom-root'), asOf: $('.fwm-asof'), depth: $('.fwm-depth'), bomGo: $('.fwm-bom-go'), bomExpand: $('.fwm-bom-expand'), bomCollapse: $('.fwm-bom-collapse'), bomStatus: $('.fwm-bom-status'), bomBox: $('.fwm-bom-box'), lineForm: $('.fwm-line-form'), headers: $('.fwm-headers'),
      op: $('.fwm-op'), procGo: $('.fwm-proc-go'), procStatus: $('.fwm-proc-status'), procBox: $('.fwm-proc-box'),
      lotPn: $('.fwm-lot-pn'), lotQ: $('.fwm-lot-q'), lotGo: $('.fwm-lot-go'), newLot: $('.fwm-new-lot'), lotForm: $('.fwm-lot-form'), lotStatus: $('.fwm-lot-status'), lotsBox: $('.fwm-lots-box'), genBox: $('.fwm-gen-box'), pnList: $('#fwm-pn-list'),
    };
    const st = { api, els, mock: false, section: 'items', loading: false,
      summary: null, classes: [], uom: [], procs: [], items: [], errors: {},
      classFilter: null, classDesc: null, expandedClasses: new Set(),
      detail: null, detailPn: null, wherePaths: null,
      bom: { pn: '', asOf: '', depth: 0, data: null, collapsed: new Set(), sel: null, headers: [], headersPn: null, formMode: 'new', err: '' },
      proc: { op: '', data: null, edit: false, err: '' },
      lots: { pn: '', q: '', list: null, sel: null, dir: 'back', gen: null, err: '' } };
    states.set(container, st);
    els.asOf.value = ''; els.asOf.placeholder = '오늘';

    // 이벤트
    els.tabs.forEach(b => { b.onclick = () => showSection(container, b.dataset.sec); });
    els.reload.onclick = () => loadBase(container);
    els.importBtn.onclick = () => importSample(container);
    els.treeAll.onclick = () => { st.classFilter = null; st.classDesc = null; renderClassTree(st); renderItems(st); };
    els.search.onclick = () => loadItems(container);
    els.q.onkeydown = (ev) => { if (ev.key === 'Enter') loadItems(container); };
    els.kind.onchange = els.statusF.onchange = () => loadItems(container);
    els.newItem.onclick = () => renderItemForm(container, null);
    els.bomGo.onclick = () => { st.bom.pn = els.bomRoot.value; st.bom.asOf = els.asOf.value; st.bom.depth = Number(els.depth.value) || 0; loadBom(container); };
    els.bomRoot.onchange = els.bomGo.onclick;
    els.bomExpand.onclick = () => { st.bom.collapsed.clear(); renderBom(container); };
    els.bomCollapse.onclick = () => { const all = (ns) => ns.forEach(n => { if (n.children?.length) { st.bom.collapsed.add(n.lineId); all(n.children); } }); all(st.bom.data?.nodes || []); renderBom(container); };
    els.procGo.onclick = () => { st.proc.op = els.op.value; loadProcess(container); };
    els.op.onchange = els.procGo.onclick;
    els.lotGo.onclick = () => { st.lots.pn = els.lotPn.value.trim(); st.lots.q = els.lotQ.value.trim(); loadLots(container); };
    els.lotQ.onkeydown = els.lotPn.onkeydown = (ev) => { if (ev.key === 'Enter') els.lotGo.onclick(); };
    els.newLot.onclick = () => renderLotForm(container);
    return st;
  }

  function showSection(container, sec) {
    const st = states.get(container); st.section = sec;
    st.els.tabs.forEach(b => b.classList.toggle('on', b.dataset.sec === sec));
    st.els.secs.forEach(s => { s.hidden = s.dataset.sec !== sec; });
    if (sec === 'bom' && !st.bom.data && st.bom.pn) loadBom(container);
    if (sec === 'process' && !st.proc.data && st.proc.op) loadProcess(container);
    if (sec === 'lots' && st.lots.list === null) loadLots(container);
  }

  // ── 기본 데이터: 요약·분류·단위·공정·품목 (하나가 실패해도 나머지는 그린다) ──
  async function loadBase(container) {
    const st = states.get(container); if (st.loading) return;
    const { els } = st;
    st.loading = true; els.status.textContent = '불러오는 중…'; els.msg.innerHTML = ''; st.errors = {};
    const settle = (key, p) => p.then(v => { delete st.errors[key]; return v; }, e => { if (e.message === 'auth') throw e; st.errors[key] = e.message; return null; });
    try {
      const [summary, classes, uom, eq] = await Promise.all([
        settle('summary', call(st, '/api/admin/materials/summary')),
        settle('classes', call(st, '/api/admin/materials/classes')),
        settle('uom', call(st, '/api/admin/materials/uom')),
        // 공정 목록: 자재 API 의 GET /process (IN/OUT 건수 포함, 최민준 구현) — 없으면 기존 equipments.processes[] (인터페이스 §7) 로 폴백
        settle('procs', call(st, '/api/admin/materials/process').catch(e => { if (e.message === 'auth') throw e; return call(st, '/api/admin/equipments'); })),
      ]);
      st.summary = summary; st.classes = Array.isArray(classes) ? classes : []; st.uom = Array.isArray(uom) ? uom : [];
      st.procs = (Array.isArray(eq) ? eq : (eq?.processes || [])).slice().sort((a, b) => (a.line || '').localeCompare(b.line || '') || (a.seq - b.seq));
      if (st.expandedClasses.size === 0) st.classes.filter(c => c.parentId === null || c.parentId === undefined).forEach(c => st.expandedClasses.add(c.id));
      renderSummary(st); renderClassTree(st); fillOps(st);
      await loadItems(container);
      const errs = Object.entries(st.errors);
      els.msg.innerHTML = errs.length ? errBox('일부 데이터를 읽지 못했습니다 — ' + errs.map(([k, m]) => `${k}: ${m}`).join(' · ')) : '';
      els.status.textContent = st.summary ? `품목 ${num(st.summary.items)} · 분류 ${num(st.summary.classes)} · BOM 헤더 ${num(st.summary.bomHeaders)} · 라인 ${num(st.summary.bomLines)} · 로트 ${num(st.summary.lots)}` : '';
    } catch (e) {
      if (e.message === 'auth') return;
      els.status.textContent = ''; els.msg.innerHTML = errBox('자재 데이터를 불러오지 못했습니다: ' + e.message); console.error('[materials]', e);
    } finally { st.loading = false; }
  }

  // ── 요약 타일 + 검사 규칙 ──
  function renderSummary(st) {
    const s = st.summary, { els } = st;
    if (!s) { els.cards.innerHTML = empty('요약 없음', st.errors.summary || 'GET /api/admin/materials/summary 응답 없음'); els.check.innerHTML = ''; return; }
    const tile = (k, v, sub) => `<div class="fwm-card"><div class="k">${k}</div><div class="v${v ? '' : ' na'}">${num(v)}</div><div class="s">${sub}</div></div>`;
    const check = s.check || {};
    const total = Object.values(check).reduce((a, b) => a + (Number(b) || 0), 0);
    const known = Object.entries(check).every(([r, c]) => KNOWN_ISSUE_RULES[r] !== undefined && Number(c) === KNOWN_ISSUE_RULES[r]);
    els.cards.innerHTML = `
      ${tile('품목', s.items, s.itemsByKind ? Object.entries(s.itemsByKind).map(([k, v]) => `${kindLabel(k)} ${v}`).join(' · ') + (s.phantoms !== undefined ? ` · 팬텀 ${s.phantoms}` : '') + (s.tmpItems ? ` · TMP ${s.tmpItems}` : '') : 'item (FG·SA·단품·원자재·부자재·포장재)')}
      ${tile('분류', s.classes, 'mat_class (최상위 + 말단)')}
      ${tile('BOM 헤더', s.bomHeaders, 'bom_header — 부모 품목당 rev')}
      ${tile('BOM 라인', s.bomLines, s.processMaterial ? `bom_line · 공정 연결 IN ${num(s.processMaterial.in)} / OUT ${num(s.processMaterial.out)}` : 'bom_line — 부모-자식 간선')}
      ${tile('로트', s.lots, 'mat_lot (3단계 실적 신고 후 증가)')}
      <div class="fwm-card ${total === 0 ? 'ok' : known ? 'known' : 'warn'}"><div class="k">검사 위반</div><div class="v">${num(total)}</div><div class="s">${total === 0 ? 'v_chk_summary 0건 — 무결성 이상 없음' : known ? '알려진 쟁점(3·6 미배정)만 — 계획서 기대값과 일치' : '규칙별 건수는 아래'}</div></div>`;
    els.check.innerHTML = `<div class="fwm-rules">${RULES.map(([code, label, desc]) => {
      const c = Number(check[code] || 0);
      const cls = c === 0 ? 'ok' : KNOWN_ISSUE_RULES[code] === c ? 'known' : 'bad';
      return `<span class="fwm-rule ${cls}${c ? ' has' : ''}" data-rule="${code}" title="${esc(desc)}${c ? ' — 클릭하면 상세(GET /check)' : ''}"><b>${code}</b> ${esc(label)} <i>${num(c)}</i></span>`;
    }).join('')}${Object.keys(check).filter(r => !RULES.some(x => x[0] === r)).map(r => `<span class="fwm-rule bad has" data-rule="${esc(r)}" title="화면에 라벨이 없는 규칙 — 서버 응답 그대로"><b>${esc(r)}</b> <i>${num(check[r])}</i></span>`).join('')}</div><div class="fwm-check-detail"></div>`;
    // 규칙 칩 클릭 → v_chk_* 상세 (GET /api/admin/materials/check, 최민준 추가 라우트 — 없으면 오류 문구만)
    els.check.querySelectorAll('.fwm-rule.has').forEach(el => {
      el.onclick = async () => {
        const box = els.check.querySelector('.fwm-check-detail'); const rule = el.dataset.rule;
        if (box.dataset.rule === rule) { box.innerHTML = ''; box.dataset.rule = ''; return; }
        box.dataset.rule = rule; box.innerHTML = '<div class="muted fwm-small">상세 조회 중…</div>';
        try {
          const r = await call(st, '/api/admin/materials/check'); const rows = (r.details || {})[rule] || [];
          box.innerHTML = `<div class="fwm-panel" style="margin-top:0"><b>${esc(rule)}</b> <span class="muted">${rows.length}건 — ${esc((RULES.find(x => x[0] === rule) || [])[2] || '')}</span>${rows.length ? `<ul class="fwm-mm plain">${rows.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<div class="muted fwm-small">상세 없음</div>'}</div>`;
        } catch (e) { if (e.message !== 'auth') box.innerHTML = errBox(e.message); }
      };
    });
  }

  // ── 좌측 품목 분류 트리 (parentId 로 조립, 접기/펼치기, 누계 품목 수, 클릭 = 목록 필터) ──
  function classChildren(st, pid) { return st.classes.filter(c => (c.parentId ?? null) === pid).sort((a, b) => (a.sortNo ?? 0) - (b.sortNo ?? 0) || String(a.code).localeCompare(String(b.code))); }
  function classCount(st, c) { return (Number(c.itemCount) || 0) + classChildren(st, c.id).reduce((a, k) => a + classCount(st, k), 0); }
  function classDescendants(st, id, acc = new Set([id])) { classChildren(st, id).forEach(k => { acc.add(k.id); classDescendants(st, k.id, acc); }); return acc; }
  function renderClassTree(st) {
    const { els } = st;
    if (!st.classes.length) { els.ctree.innerHTML = empty('분류 없음', st.errors.classes || '샘플 적재 전이거나 mat_class 가 비어 있음'); els.asideSub.textContent = ''; return; }
    els.asideSub.textContent = `${st.classes.length}개`;
    const node = (c, depth) => {
      const kids = classChildren(st, c.id); const open = st.expandedClasses.has(c.id);
      const on = st.classFilter === c.id;
      return `<div class="fwm-cnode" style="--d:${depth}">
        <div class="fwm-crow${on ? ' on' : ''}" data-id="${c.id}">
          <button class="fwm-caret${kids.length ? '' : ' leaf'}" data-toggle="${c.id}" ${kids.length ? '' : 'disabled'}>${kids.length ? (open ? '▾' : '▸') : '·'}</button>
          <span class="fwm-ccode">${esc(c.code)}</span><span class="fwm-cname">${esc(c.name)}</span><span class="fwm-ccount">${num(classCount(st, c))}</span>
        </div>
        ${kids.length && open ? `<div class="fwm-ckids">${kids.map(k => node(k, depth + 1)).join('')}</div>` : ''}
      </div>`;
    };
    els.ctree.innerHTML = classChildren(st, null).map(c => node(c, 0)).join('');
    els.ctree.querySelectorAll('[data-toggle]').forEach(b => { b.onclick = (ev) => { ev.stopPropagation(); const id = Number(b.dataset.toggle); st.expandedClasses.has(id) ? st.expandedClasses.delete(id) : st.expandedClasses.add(id); renderClassTree(st); }; });
    els.ctree.querySelectorAll('.fwm-crow').forEach(r => { r.onclick = () => { const id = Number(r.dataset.id); if (st.classFilter === id) { st.classFilter = null; st.classDesc = null; } else { st.classFilter = id; st.classDesc = classDescendants(st, id); st.expandedClasses.add(id); } renderClassTree(st); renderItems(st); }; });
  }

  // ── 품목 목록 (검색·종류·상태는 서버 필터, 분류는 트리 선택 → 하위 분류 포함 클라이언트 필터) ──
  async function loadItems(container) {
    const st = states.get(container); const { els } = st;
    els.itemsCount.textContent = '…';
    try {
      const r = await call(st, '/api/admin/materials/items' + qs({ q: els.q.value.trim(), kind: els.kind.value, status: els.statusF.value }));
      st.items = Array.isArray(r) ? r : (r.items || []); delete st.errors.items;
      els.pnList.innerHTML = st.items.map(i => `<option value="${esc(i.pn)}">${esc(i.name)}</option>`).join('');
      fillBomRoots(st);
    } catch (e) { if (e.message === 'auth') return; st.items = []; st.errors.items = e.message; }
    renderItems(st);
    if (!st.detail) renderDetail(st);   // 2단 오른쪽에 안내를 먼저 띄운다 (아직 고른 품목이 없을 때)
  }
  function visibleItems(st) { return st.classDesc ? st.items.filter(i => st.classDesc.has(Number(i.classId))) : st.items; }
  function renderItems(st) {
    const { els } = st; const list = visibleItems(st);
    const cls = st.classFilter ? st.classes.find(c => c.id === st.classFilter) : null;
    els.itemsCount.textContent = `${list.length}건${cls ? ` · 분류 ${cls.code}` : ''}${st.items.length !== list.length ? ` / 전체 ${st.items.length}` : ''}`;
    if (st.errors.items) { els.itemsBox.innerHTML = empty('품목 없음 · API 오류', st.errors.items); return; }
    if (!list.length) { els.itemsBox.innerHTML = empty('품목 없음', st.items.length ? '선택한 분류(하위 포함)에 품목이 없습니다.' : '검색 조건에 맞는 품목이 없거나 아직 적재되지 않았습니다 — [🔩 샘플 적재]로 cleansing-v1.json 60품목을 넣을 수 있습니다.'); return; }
    els.itemsBox.innerHTML = `<table class="fwm-table fwm-items"><thead><tr><th>품번</th><th>품명</th><th>규격</th><th>종류</th><th>분류</th><th>단위</th><th>추적</th><th>상태</th></tr></thead><tbody>
      ${list.map(i => `<tr data-pn="${esc(i.pn)}" class="${st.detailPn === i.pn ? 'on' : ''}">
        <td><b>${esc(i.pn)}</b>${i.isTmp ? ' ' + chip('tmp', 'TMP', '승인 전 임시 품번 (pn_pending) — 쟁점 1·2 승인 후 정식 P/N') : ''}</td>
        <td>${esc(i.name)}</td><td class="muted">${esc(i.spec || '')}</td>
        <td>${chip('kind-' + itemKind(i), kindLabel(itemKind(i)))}</td>
        <td class="muted">${esc(i.className || i.classCode || i.classId)}</td><td>${esc(i.uom)}</td>
        <td>${chip('trace-' + (i.traceKind || 'NONE'), i.traceKind || 'NONE')}</td>
        <td>${chip('st-' + i.status, STATUS_LABEL[i.status] || i.status)}</td></tr>`).join('')}
    </tbody></table>`;
    els.itemsBox.querySelectorAll('tr[data-pn]').forEach(tr => { tr.onclick = () => loadDetail(st, tr.dataset.pn); });
  }

  // ── 품목 상세: 속성 · where-used · BOM 헤더 · 로트 수 ──
  async function loadDetail(st, pn) {
    const { els } = st; st.detailPn = pn; st.wherePaths = null;
    els.itemsBox.querySelectorAll('tr[data-pn]').forEach(tr => tr.classList.toggle('on', tr.dataset.pn === pn));
    els.detail.innerHTML = '<div class="muted" style="padding:8px">불러오는 중…</div>';
    try { st.detail = await call(st, '/api/admin/materials/items/' + encodeURIComponent(pn)); }
    catch (e) { if (e.message === 'auth') return; st.detail = null; els.detail.innerHTML = errBox('품목 상세를 읽지 못했습니다: ' + e.message); return; }
    renderDetail(st);
  }
  function renderDetail(st) {
    const d = st.detail, { els } = st;
    if (!d) {   // 2단 화면이라 오른쪽이 비어 보이지 않게 안내를 둔다
      els.detail.innerHTML = `<div class="fwm-panel fwm-detail-empty">
        <b>품목 상세</b>
        <p class="muted fwm-small">왼쪽 목록에서 품번을 누르면 여기에 속성·어디에 쓰이나(where-used)·BOM 헤더·로트 수가 나옵니다.
          상세에서 <b>BOM 트리</b>·<b>역전개 경로</b>·<b>로트</b>로 바로 넘어갈 수 있습니다.</p></div>`;
      return;
    }
    const it = d.item || {}; const wu = d.whereUsed || []; const hs = d.headers || [];
    const kind = itemKind(it);
    els.detail.innerHTML = `<div class="fwm-panel">
      <div class="fwm-panel-head">
        <div><b class="fwm-pn">${esc(it.pn)}</b>${it.isTmp ? ' ' + chip('tmp', 'TMP') : ''} <span class="fwm-name">${esc(it.name)}</span> ${chip('kind-' + kind, kindLabel(kind))} ${chip('st-' + it.status, STATUS_LABEL[it.status] || it.status)}</div>
        <div class="fwm-actions">
          ${hs.length ? `<button class="fwm-go-bom" title="이 품목을 부모로 정전개">BOM 트리</button>` : ''}
          <button class="fwm-go-wu fwm-ghost" title="GET where-used — 루트까지 경로">역전개 경로</button>
          <button class="fwm-go-lots fwm-ghost">로트 ${num(d.lots)}건</button>
          <button class="fwm-edit-item fwm-ghost" title="PUT /api/admin/materials/items/:pn">편집</button>
          <button class="fwm-close fwm-ghost" title="닫기">✕</button>
        </div>
      </div>
      <div class="fwm-props">
        <div><i>규격</i>${esc(it.spec || '—')}</div><div><i>분류</i>${esc(it.className || it.classCode || it.classId || '—')}</div><div><i>기준단위</i>${esc(it.uom || '—')}</div>
        <div><i>추적</i>${esc(it.traceKind || 'NONE')}</div><div><i>조달</i>${esc(it.sourceType || '—')}</div><div><i>팬텀</i>${kind === 'PHANTOM' || it.phantom ? '예 (재고·로트·IN·OUT 없음)' : '아니오'}</div>
        ${d.outAt?.length ? `<div><i>산출 공정 (OUT)</i>${d.outAt.map(o => `${esc(o.op)}${o.isFinal ? ' <b>완성</b>' : ' · ' + esc(o.outState || '')}`).join(', ')}</div>` : ''}
        ${d.inAt?.length ? `<div><i>투입 공정 (IN)</i>${d.inAt.map(esc).join(', ')}</div>` : ''}
        ${it.image ? `<div><i>이미지</i>${esc(it.image)}</div>` : ''}${it.effFrom ? `<div><i>유효</i>${esc(it.effFrom)}</div>` : ''}
      </div>
      <div class="fwm-cols">
        <div><h4>어디에 쓰이나 (where-used) <span>${wu.length}건</span></h4>
          ${wu.length ? `<div class="fwm-scroll"><table class="fwm-table"><thead><tr><th>부모</th><th>품명</th><th class="num">수량/부모</th><th>헤더</th><th>상태</th></tr></thead><tbody>
            ${wu.map(w => `<tr><td><a href="#" data-pn="${esc(w.parentPn)}">${esc(w.parentPn)}</a></td><td class="muted">${esc(w.parentName || '')}</td><td class="num">${qty(w.qtyPer, w.uom)}</td><td class="muted">#${esc(w.headerId)}</td><td>${chip('st-' + w.status, STATUS_LABEL[w.status] || w.status)}</td></tr>`).join('')}
          </tbody></table></div>` : `<div class="muted fwm-small">${kind === 'FG' ? '완성품 — 상위 없음' : '어느 BOM 의 자식도 아니다 (R-4 고아 후보)'}</div>`}
          <div class="fwm-wu-paths"></div>
        </div>
        <div><h4>이 품목의 BOM 헤더 <span>${hs.length}건</span></h4>
          ${hs.length ? `<div class="fwm-scroll"><table class="fwm-table"><thead><tr><th>#</th><th>rev</th><th>상태</th><th>유효</th><th class="num">라인</th></tr></thead><tbody>
            ${hs.map(h => `<tr><td class="muted">#${esc(h.id)}</td><td>${esc(h.rev || '—')}</td><td>${chip('st-' + h.status, STATUS_LABEL[h.status] || h.status)}</td><td class="muted">${esc(eff(h.effFrom, h.effTo))}</td><td class="num">${num(h.lineCount)}</td></tr>`).join('')}
          </tbody></table></div>` : `<div class="muted fwm-small">${['SA', 'FG', 'PHANTOM'].includes(kind) ? 'BOM 없음 — SA/FG 인데 헤더가 없으면 R-5 미아 조립품' : '단품·원자재 — BOM 없음이 정상'}</div>`}
        </div>
      </div>
    </div>`;
    const q = (s) => els.detail.querySelector(s);
    if (q('.fwm-go-bom')) q('.fwm-go-bom').onclick = () => { st.bom.pn = it.pn; st.els.bomRoot.value = it.pn; if (st.els.bomRoot.value !== it.pn) { st.els.bomRoot.insertAdjacentHTML('beforeend', `<option value="${esc(it.pn)}" selected>${esc(it.pn)} · ${esc(it.name)}</option>`); } showSection(els.detail.closest('.fwm'), 'bom'); loadBom(els.detail.closest('.fwm')); };
    q('.fwm-go-lots').onclick = () => { els.lotPn.value = it.pn; st.lots.pn = it.pn; st.lots.q = ''; els.lotQ.value = ''; showSection(els.detail.closest('.fwm'), 'lots'); loadLots(els.detail.closest('.fwm')); };
    q('.fwm-edit-item').onclick = () => renderItemForm(els.detail.closest('.fwm'), it);
    q('.fwm-close').onclick = () => { st.detail = null; st.detailPn = null; renderDetail(st); renderItems(st); };
    q('.fwm-go-wu').onclick = async () => {
      const box = q('.fwm-wu-paths'); box.innerHTML = '<div class="muted fwm-small">경로 계산 중…</div>';
      try {
        const r = await call(st, '/api/admin/materials/where-used/' + encodeURIComponent(it.pn) + qs({ asOf: st.bom.asOf }));
        const paths = r.paths || [];
        // 서버 경로는 자기 자신(depth 0)부터 루트까지: qtyPer = 한 단계 위 부모 1개당, qtyCum = 루트 1개당 누적
        box.innerHTML = paths.length ? `<div class="fwm-paths">${paths.map(p => `<div class="fwm-path">${esc(it.pn)}${p.filter((s, i) => !(i === 0 && s.pn === it.pn)).map(s => ` <span class="arr">←</span> <b>${esc(s.pn)}</b><span class="muted"> ${esc(s.name || '')} · ${num(s.qtyPer, 6)}${esc(s.uom || '')}/부모${s.qtyCum !== undefined ? ` · 누적 ${num(s.qtyCum, 6)}` : ''}</span>`).join('')}</div>`).join('')}</div>` : '<div class="muted fwm-small">역전개 경로 없음 (루트이거나 어느 BOM 에도 없음)</div>';
      } catch (e) { if (e.message !== 'auth') box.innerHTML = errBox(e.message); }
    };
    els.detail.querySelectorAll('a[data-pn]').forEach(a => { a.onclick = (ev) => { ev.preventDefault(); loadDetail(st, a.dataset.pn); }; });
  }

  // ── 품목 등록/편집 폼 (POST / PUT items) ──
  function renderItemForm(container, it) {
    const st = states.get(container); const { els } = st; const edit = !!it; it = it || {};
    const leaf = st.classes.filter(c => !classChildren(st, c.id).length);
    els.itemForm.hidden = false;
    els.itemForm.innerHTML = `<div class="fwm-panel fwm-form">
      <div class="fwm-panel-head"><b>${edit ? '품목 편집 — ' + esc(it.pn) : '새 품목'}</b><button class="fwm-close fwm-ghost">✕</button></div>
      <div class="fwm-grid">
        <label>품번<input name="pn" value="${esc(it.pn || '')}" ${edit ? 'readonly' : ''} placeholder="예: SC-1010 (공백·/ 불가)"></label>
        <label>품명<input name="name" value="${esc(it.name || '')}"></label>
        <label>규격<input name="spec" value="${esc(it.spec || '')}"></label>
        <label>분류(말단)<select name="classId">${leaf.map(c => `<option value="${c.id}"${Number(it.classId) === c.id ? ' selected' : ''}>${esc(c.code)} ${esc(c.name)}</option>`).join('')}</select></label>
        <label>종류<select name="kind">${KIND_OPTS.filter(([v]) => v !== 'PHANTOM').map(([v, l]) => `<option value="${v}"${normKind(it.kind) === v || (normKind(it.kind) === 'PHANTOM' && v === 'SA') ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>기준단위<select name="uom">${(st.uom.length ? st.uom : [{ code: 'EA', name: '개' }]).map(u => `<option value="${esc(u.code)}"${it.uom === u.code ? ' selected' : ''}>${esc(u.code)} ${esc(u.name || '')}</option>`).join('')}</select></label>
        <label>추적<select name="traceKind">${['NONE', 'LOT', 'SERIAL'].map(v => `<option${(it.traceKind || 'NONE') === v ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>팬텀<select name="phantom"><option value="0"${!it.phantom && normKind(it.kind) !== 'PHANTOM' ? ' selected' : ''}>아니오</option><option value="1"${it.phantom || normKind(it.kind) === 'PHANTOM' ? ' selected' : ''}>예</option></select></label>
        <label>상태<select name="status">${Object.entries(STATUS_LABEL).map(([v, l]) => `<option value="${v}"${(it.status || 'DRAFT') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      <div class="fwm-form-foot"><button class="fwm-save">${edit ? '저장 (PUT)' : '등록 (POST)'}</button><span class="fwm-form-err"></span></div>
      <div class="muted fwm-small">삭제는 없다 — 상태를 <b>폐기(OBSOLETE)</b>로 바꾼다(R-11). 분류는 말단만 고를 수 있다(R-14).</div>
    </div>`;
    const f = els.itemForm; f.querySelector('.fwm-close').onclick = () => { f.hidden = true; f.innerHTML = ''; };
    f.querySelector('.fwm-save').onclick = async () => {
      const body = {}; f.querySelectorAll('[name]').forEach(x => { body[x.name] = x.value; });
      body.classId = Number(body.classId); body.phantom = body.phantom === '1';
      const err = f.querySelector('.fwm-form-err'); err.textContent = '';
      try {
        await call(st, edit ? '/api/admin/materials/items/' + encodeURIComponent(it.pn) : '/api/admin/materials/items', { method: edit ? 'PUT' : 'POST', body: JSON.stringify(body) });
        f.hidden = true; f.innerHTML = '';
        await loadItems(container); if (edit || body.pn) loadDetail(st, edit ? it.pn : body.pn);
        loadSummaryOnly(container);
      } catch (e) { if (e.message !== 'auth') err.textContent = e.message; }
    };
  }
  async function loadSummaryOnly(container) { const st = states.get(container); try { st.summary = await call(st, '/api/admin/materials/summary'); renderSummary(st); } catch (e) { /* 요약은 부가 정보 — 조용히 유지 */ } }

  // ── BOM 트리 뷰 (정전개, 서버 GET bom/:pn?asOf&depth — 노드 중첩 그대로 그린다) ──
  function fillBomRoots(st) {
    const { els } = st; const cur = st.bom.pn || els.bomRoot.value;
    const parents = st.items.filter(i => ['FG', 'SA', 'PHANTOM'].includes(itemKind(i))).sort((a, b) => (itemKind(a) === 'FG' ? 0 : 1) - (itemKind(b) === 'FG' ? 0 : 1) || a.pn.localeCompare(b.pn));
    els.bomRoot.innerHTML = parents.length ? parents.map(p => `<option value="${esc(p.pn)}">${esc(p.pn)} · ${esc(p.name)}${itemKind(p) === 'PHANTOM' ? ' (팬텀)' : ''}</option>`).join('') : '<option value="">(조립품 없음)</option>';
    if (cur && parents.some(p => p.pn === cur)) els.bomRoot.value = cur;
    if (!st.bom.pn && parents.length) st.bom.pn = els.bomRoot.value;
  }
  async function loadBom(container) {
    const st = states.get(container); const { els } = st; const b = st.bom;
    if (!b.pn) { els.bomBox.innerHTML = empty('부모 품목 없음', '전개할 조립품(FG/SA)을 고르세요. 품목이 없으면 [🔩 샘플 적재].'); return; }
    els.bomStatus.textContent = '전개 중…'; b.sel = null; b.formMode = 'new'; b.err = '';
    try {
      const [data, headers] = await Promise.all([
        call(st, '/api/admin/materials/bom/' + encodeURIComponent(b.pn) + qs({ asOf: b.asOf, depth: b.depth || '' })),
        call(st, '/api/admin/materials/bom-headers/' + encodeURIComponent(b.pn)).catch(e => { if (e.message === 'auth') throw e; return { _err: e.message }; }),
      ]);
      b.data = data; b.headers = Array.isArray(headers) ? headers : (headers?.headers || []); b.headersErr = headers?._err || ''; b.headersPn = b.pn;   // 서버는 { pn, name, headers[] }
      const cnt = (ns) => ns.reduce((a, n) => a + 1 + cnt(n.children || []), 0);
      els.bomStatus.textContent = `${data.root?.pn || b.pn} · 노드 ${cnt(data.nodes || [])} · 기준일 ${data.asOf || b.asOf || '오늘'}${b.depth ? ` · 깊이 ≤ ${b.depth}` : ''}`;
    } catch (e) { if (e.message === 'auth') return; b.data = null; els.bomStatus.textContent = ''; els.bomBox.innerHTML = errBox('BOM 을 읽지 못했습니다: ' + e.message); els.headers.innerHTML = ''; els.lineForm.innerHTML = ''; return; }
    renderBom(container); renderHeaders(container); renderLineForm(container);
  }
  function bopChip(n) {
    const s = n.bop?.state || (n.phantom ? 'phantom' : n.bop?.op ? 'linked' : 'unassigned');
    if (s === 'linked') return chip('bop-linked', `${n.bop.mode === 'OUT' ? 'OUT' : 'IN'} ${n.bop.op}`, '투입 공정 (process_material IN)');
    if (s === 'phantom') return chip('bop-phantom', '팬텀', '팬텀 — IN 없음, 자식이 부모 공정으로 직접 (§4.4)');
    if (s === 'none') return chip('bop-none', '미연결(의도)', 'bop_link=NONE — note 에 사유');
    return chip('bop-unassigned', '⚠ 미배정', 'REQUIRED 라인인데 투입 공정이 없다 — BOP 누락 후보 (D-8)');
  }
  function renderBom(container) {
    const st = states.get(container); const { els } = st; const b = st.bom; const d = b.data;
    if (!d) return;
    const nodes = d.nodes || [];
    if (!nodes.length) { els.bomBox.innerHTML = empty('BOM 없음', `${d.root?.pn || b.pn} 에 ${b.asOf ? b.asOf + ' 기준으로 ' : ''}유효한(APPROVED/ACTIVE) 헤더·라인이 없습니다. 아래 헤더 표에서 상태·유효일자를 확인하세요.`); return; }
    const row = (n) => {
      const kids = n.children || []; const open = !b.collapsed.has(n.lineId); const kind = n.phantom ? 'PHANTOM' : normKind(n.kind);   // 서버 kind = item_type, 팬텀은 phantom 플래그
      const est = /추정/.test(n.note || '');
      return `<div class="fwm-bnode${n.phantom || kind === 'PHANTOM' ? ' phantom' : ''}${b.sel?.lineId === n.lineId ? ' on' : ''}" style="--lvl:${n.level || 1}" data-line="${n.lineId}">
        <div class="fwm-brow">
          <button class="fwm-caret${kids.length ? '' : ' leaf'}" data-toggle="${n.lineId}" ${kids.length ? '' : 'disabled'}>${kids.length ? (open ? '▾' : '▸') : '·'}</button>
          <span class="fwm-lvl" title="깊이 (FG = 0)">L${n.level ?? '?'}</span>
          <b class="fwm-pn">${esc(n.pn)}</b>${n.isTmp || /^TMP-/.test(n.pn) ? ' ' + chip('tmp', 'TMP') : ''}
          <span class="fwm-name">${esc(n.name || '')}${est ? ' <span class="fwm-est" title="' + esc(n.note) + '">(추정)</span>' : ''}</span>
          ${chip('kind-' + kind, kindLabel(kind))}
          <span class="fwm-q1" title="부모 base_qty 당 소요 (qty_per)${n.qtyBasis === 'GROSS' ? ' · GROSS(손실 포함 실측)' : ''}${n.scrapRate ? ' · 스크랩 ' + n.scrapRate + '%' : ''}">${qty(n.qtyPer, n.uom)}${n.qtyBasis === 'GROSS' ? '<i class="fwm-gross">G</i>' : ''}</span>
          <span class="fwm-q2" title="완성품 1대당 소요 (v_bom_line_qpp)">= ${qty(n.qtyPerProduct, n.uom)}<i>/대</i></span>
          ${bopChip(n)}${n.bop?.outOp ? ' ' + chip('bop-out', '◀ ' + n.bop.outOp, '이 품목을 산출(완성)하는 공정 — process_material OUT, is_final=1') : ''}
          <span class="fwm-eff muted" title="유효기간">${isOpen(n.effTo) && (!n.effFrom || n.effFrom <= '2026-01-01') ? '' : esc(eff(n.effFrom, n.effTo))}</span>
          ${n.note ? `<span class="fwm-note" title="${esc(n.note)}">✎</span>` : ''}
        </div>
        ${kids.length && open ? `<div class="fwm-bkids">${kids.map(row).join('')}</div>` : ''}
      </div>`;
    };
    const totals = Object.entries(d.totals || {});
    els.bomBox.innerHTML = `<div class="fwm-tree">
      <div class="fwm-broot"><b class="fwm-pn">${esc(d.root?.pn || b.pn)}</b> <span class="fwm-name">${esc(d.root?.name || '')}</span> ${chip('kind-' + normKind(d.root?.kind), kindLabel(normKind(d.root?.kind)))} <span class="muted">기준단위 ${esc(d.root?.uom || '')}</span>
        <span class="fwm-legend"><i class="ph"></i>팬텀(점선) · <i class="un"></i>미배정 · <b>G</b> GROSS 수량 · 행 클릭 = 라인 편집</span></div>
      ${nodes.map(row).join('')}
      <div class="fwm-totals"><b>말단 합계 / 완성품 1대</b> ${totals.length ? totals.map(([u, v]) => `<span class="fwm-total">${num(v)}<i>${esc(u)}</i></span>`).join('') : '<span class="muted">서버가 totals 를 주지 않음</span>'}${d.totalsBase && Object.keys(d.totalsBase).length ? `<span class="muted fwm-small" title="차원별 기준단위 환산 (v_uom_base)">환산: ${Object.entries(d.totalsBase).map(([k, v]) => `${esc(k)} ${num(v)}`).join(' · ')}</span>` : ''}<span class="muted fwm-small">단위별 합, 팬텀 제외 · 서버 계산값</span></div>
    </div>`;
    els.bomBox.querySelectorAll('[data-toggle]').forEach(x => { x.onclick = (ev) => { ev.stopPropagation(); const id = Number(x.dataset.toggle); b.collapsed.has(id) ? b.collapsed.delete(id) : b.collapsed.add(id); renderBom(container); }; });
    els.bomBox.querySelectorAll('.fwm-brow').forEach(r => { r.onclick = () => { const id = Number(r.parentElement.dataset.line); b.sel = findNode(nodes, id); b.formMode = 'edit'; b.err = ''; renderBom(container); renderLineForm(container); }; });
  }
  function findNode(nodes, id) { for (const n of nodes) { if (n.lineId === id) return n; const f = findNode(n.children || [], id); if (f) return f; } return null; }

  // ── BOM 라인 편집 (POST / PUT / DELETE bom-lines — 트리거 거부 400 은 그대로 빨간 줄) ──
  const headerCache = new WeakMap();   // st → Map(parentPn → headers[])
  async function headersFor(st, pn) {
    if (pn === st.bom.headersPn) return st.bom.headers;
    let m = headerCache.get(st); if (!m) { m = new Map(); headerCache.set(st, m); }
    if (!m.has(pn)) { try { const r = await call(st, '/api/admin/materials/bom-headers/' + encodeURIComponent(pn)); m.set(pn, Array.isArray(r) ? r : (r?.headers || [])); } catch (e) { if (e.message === 'auth') throw e; m.set(pn, []); } }
    return m.get(pn);
  }
  async function renderLineForm(container) {
    const st = states.get(container); const { els } = st; const b = st.bom; const edit = b.formMode === 'edit' && b.sel; const n = edit ? b.sel : null;
    const parentPn = edit ? n.parentPn : (b.sel && (b.sel.children || []).length ? b.sel.pn : (b.data?.root?.pn || b.pn));
    const hs = await headersFor(st, parentPn);
    const uoms = st.uom.length ? st.uom : [{ code: n?.uom || 'EA' }];
    els.lineForm.innerHTML = `<div class="fwm-panel fwm-form">
      <div class="fwm-panel-head"><b>${edit ? `라인 편집 — #${esc(n.lineId)} ${esc(n.parentPn)} › ${esc(n.pn)}` : `라인 추가 — 부모 ${esc(parentPn)}`}</b>
        <div class="fwm-actions">${edit ? '<button class="fwm-line-new fwm-ghost">새 라인</button>' : ''}</div></div>
      <div class="fwm-grid">
        <label>부모 품목<input name="parentPn" list="fwm-pn-list" value="${esc(parentPn)}" ${edit ? 'readonly' : ''}></label>
        <label>헤더<select name="headerId" ${edit ? 'disabled' : ''}>${hs.length ? hs.map(h => `<option value="${h.id}"${edit ? (Number(n.headerId) === h.id ? ' selected' : '') : (h.status === 'ACTIVE' ? ' selected' : '')}>#${h.id} ${h.rev ? 'rev ' + esc(h.rev) + ' ' : ''}${STATUS_LABEL[h.status] || h.status} · ${esc(eff(h.effFrom, h.effTo))}</option>`).join('') : `<option value="">(헤더 없음 — 아래 [+ 헤더]${edit ? '' : ' 로 먼저 생성'})</option>`}</select></label>
        <label>자식 품번<input name="childPn" list="fwm-pn-list" value="${esc(n?.pn || '')}" placeholder="P/N"></label>
        <label>수량/부모 base_qty<input name="qtyPer" type="number" step="any" min="0" value="${n?.qtyPer ?? ''}"></label>
        <label>단위<select name="uom">${uoms.map(u => `<option value="${esc(u.code)}"${(n?.uom || '') === u.code ? ' selected' : ''}>${esc(u.code)}</option>`).join('')}</select></label>
        <label>표시순서(line_no)<input name="lineNo" type="number" step="10" value="${n?.lineNo ?? ''}" placeholder="비우면 서버 기본"></label>
        <label>수량 기준<select name="qtyBasis"><option value="NET"${(n?.qtyBasis || 'NET') === 'NET' ? ' selected' : ''}>NET 순소요</option><option value="GROSS"${n?.qtyBasis === 'GROSS' ? ' selected' : ''}>GROSS 손실 포함 실측</option></select></label>
        <label>스크랩 %<input name="scrapRate" type="number" step="any" min="0" max="99.99" value="${n?.scrapRate ?? 0}"></label>
        <label>BOP 연결(bop_link)<select name="bopLink"><option value="REQUIRED"${(n?.bopLink || 'REQUIRED') === 'REQUIRED' ? ' selected' : ''}>REQUIRED 투입 필요</option><option value="NONE"${n?.bopLink === 'NONE' ? ' selected' : ''}>NONE 의도적 미연결 (비고 필수)</option>${n?.bopLink === 'PHANTOM' ? '<option value="PHANTOM" selected>PHANTOM (트리거 자동)</option>' : ''}</select></label>
        <label>유효 시작<input name="effFrom" type="date" value="${esc(n?.effFrom || '')}"></label>
        <label>유효 종료<input name="effTo" type="date" value="${isOpen(n?.effTo) ? '' : esc(n.effTo)}" placeholder="무기한"></label>
        <label class="wide">비고<input name="note" value="${esc(n?.note || '')}" placeholder="bop_link=NONE 이면 사유 필수"></label>
      </div>
      <div class="fwm-form-foot">
        ${edit ? '<button class="fwm-line-save">수정 (PUT)</button><button class="fwm-line-del fwm-danger">삭제 (DELETE)</button>' : '<button class="fwm-line-add">추가 (POST)</button>'}
        <span class="fwm-form-err">${esc(b.err || '')}</span>
      </div>
      <div class="muted fwm-small">DB 트리거가 거부하면(순환 R-1 · 유효기간 겹침 R-9 · 단위 R-7 · 소수 자릿수 R-8 · 승인 라인 삭제 R-11 …) 서버가 400 으로 돌려준 문자열을 위에 그대로 표시한다.</div>
    </div>`;
    const f = els.lineForm; const read = () => { const o = {}; f.querySelectorAll('[name]').forEach(x => { o[x.name] = x.value; }); return o; };
    const after = async () => { b.err = ''; headerCache.delete(st); await loadBom(container); loadSummaryOnly(container); };
    const fail = (e) => { if (e.message === 'auth') return; b.err = e.message; f.querySelector('.fwm-form-err').textContent = e.message; };
    const parentIn = f.querySelector('[name=parentPn]');
    if (!edit) parentIn.onchange = async () => { const p = parentIn.value.trim(); const hs2 = await headersFor(st, p); const sel = f.querySelector('[name=headerId]'); sel.innerHTML = hs2.length ? hs2.map(h => `<option value="${h.id}">#${h.id} ${STATUS_LABEL[h.status] || h.status} · ${esc(eff(h.effFrom, h.effTo))}</option>`).join('') : '<option value="">(헤더 없음)</option>'; };
    if (f.querySelector('.fwm-line-new')) f.querySelector('.fwm-line-new').onclick = () => { b.formMode = 'new'; b.err = ''; renderLineForm(container); };
    if (f.querySelector('.fwm-line-add')) f.querySelector('.fwm-line-add').onclick = async () => {
      const o = read(); if (!o.headerId) return fail(new Error('헤더가 없습니다 — 부모 품목의 BOM 헤더를 먼저 만드세요'));
      const body = { headerId: Number(o.headerId), parentPn: o.parentPn.trim(), childPn: o.childPn.trim(), qtyPer: Number(o.qtyPer), uom: o.uom, lineNo: o.lineNo ? Number(o.lineNo) : undefined, qtyBasis: o.qtyBasis, scrapRate: Number(o.scrapRate) || 0, bopLink: o.bopLink || 'REQUIRED', effFrom: o.effFrom || undefined, effTo: o.effTo || undefined, note: o.note || undefined };
      try { await call(st, '/api/admin/materials/bom-lines', { method: 'POST', body: JSON.stringify(body) }); await after(); } catch (e) { fail(e); }
    };
    if (f.querySelector('.fwm-line-save')) f.querySelector('.fwm-line-save').onclick = async () => {
      const o = read();
      const body = { childPn: o.childPn.trim(), qtyPer: Number(o.qtyPer), uom: o.uom, lineNo: o.lineNo ? Number(o.lineNo) : undefined, qtyBasis: o.qtyBasis, scrapRate: Number(o.scrapRate) || 0, bopLink: o.bopLink || 'REQUIRED', effFrom: o.effFrom || undefined, effTo: o.effTo || '9999-12-31', note: o.note || null };
      try { await call(st, '/api/admin/materials/bom-lines/' + n.lineId, { method: 'PUT', body: JSON.stringify(body) }); await after(); } catch (e) { fail(e); }
    };
    if (f.querySelector('.fwm-line-del')) f.querySelector('.fwm-line-del').onclick = async () => {
      if (!confirm(`라인 #${n.lineId} (${n.parentPn} › ${n.pn}) 을 삭제합니다. 승인된 BOM 의 라인은 트리거가 거부합니다(R-11 — valid_to 를 끊으세요).`)) return;
      try { await call(st, '/api/admin/materials/bom-lines/' + n.lineId, { method: 'DELETE' }); await after(); } catch (e) { fail(e); }
    };
  }

  // ── BOM 헤더 (GET/POST/PUT bom-headers — 상태 전이·유효일자) ──
  function renderHeaders(container) {
    const st = states.get(container); const { els } = st; const b = st.bom; const hs = b.headers || [];
    els.headers.innerHTML = `<div class="fwm-panel">
      <div class="fwm-panel-head"><b>BOM 헤더 — ${esc(b.pn)} <span class="muted">${hs.length}건</span></b><div class="fwm-actions"><button class="fwm-hdr-new fwm-ghost" title="POST bom-headers {parentPn, effFrom}">+ 헤더</button></div></div>
      ${b.headersErr ? errBox(b.headersErr) : ''}
      ${hs.length ? `<div class="fwm-scroll"><table class="fwm-table"><thead><tr><th>#</th><th>rev</th><th>base</th><th>상태</th><th>유효</th><th class="num">라인</th><th>변경</th></tr></thead><tbody>
        ${hs.map(h => `<tr data-id="${h.id}"><td class="muted">#${esc(h.id)}</td><td>${esc(h.rev || '—')}</td><td class="muted">${h.baseQty ? num(h.baseQty) + ' ' + esc(h.baseUom || '') : '—'}</td>
          <td>${chip('st-' + h.status, STATUS_LABEL[h.status] || h.status)}</td><td class="muted">${esc(eff(h.effFrom, h.effTo))}</td><td class="num">${num(h.lineCount)}</td>
          <td class="fwm-hdr-ctl"><select name="status"><option value="">상태 유지</option>${(HEADER_NEXT[h.status] || []).map(s => `<option value="${s}">→ ${STATUS_LABEL[s]}</option>`).join('')}</select>
            <input type="date" name="effTo" value="${isOpen(h.effTo) ? '' : esc(h.effTo)}" title="유효 종료 (비우면 무기한)"><button class="fwm-hdr-save">적용</button></td></tr>`).join('')}
      </tbody></table></div>` : `<div class="muted fwm-small">${b.headersErr ? '' : '헤더 없음 — 이 품목은 아직 BOM 이 없다. [+ 헤더]로 DRAFT 헤더를 만들고 라인을 추가한다.'}</div>`}
      <div class="fwm-form-err fwm-hdr-err"></div>
      <div class="muted fwm-small">상태는 DRAFT → APPROVED → ACTIVE → OBSOLETE 한 방향. 삭제 없음(R-11). 같은 부모의 승인 BOM 유효기간이 겹치면 R-9b 로 거부된다.</div>
    </div>`;
    const errEl = els.headers.querySelector('.fwm-hdr-err');
    els.headers.querySelector('.fwm-hdr-new').onclick = async () => {
      errEl.textContent = '';
      try { await call(st, '/api/admin/materials/bom-headers', { method: 'POST', body: JSON.stringify({ parentPn: b.pn, effFrom: today(), status: 'DRAFT' }) }); headerCache.delete(st); await loadBom(container); loadSummaryOnly(container); }
      catch (e) { if (e.message !== 'auth') errEl.textContent = e.message; }
    };
    els.headers.querySelectorAll('.fwm-hdr-save').forEach(btn => {
      btn.onclick = async () => {
        const tr = btn.closest('tr'); const id = tr.dataset.id; const status = tr.querySelector('[name=status]').value; const effTo = tr.querySelector('[name=effTo]').value;
        const body = {}; if (status) body.status = status; body.effTo = effTo || '9999-12-31';
        errEl.textContent = '';
        try { await call(st, '/api/admin/materials/bom-headers/' + id, { method: 'PUT', body: JSON.stringify(body) }); headerCache.delete(st); await loadBom(container); loadSummaryOnly(container); }
        catch (e) { if (e.message !== 'auth') errEl.textContent = e.message; }
      };
    });
  }

  // ── 공정 연결 (GET process/:op → IN/OUT/미배정, PUT process/:op/links) ──
  function fillOps(st) {
    const { els } = st; const cur = st.proc.op || els.op.value;
    els.op.innerHTML = st.procs.length ? st.procs.map(p => `<option value="${esc(p.op)}">${esc(p.op)} · ${esc(p.name || '')} (${esc(p.line || '')}${p.inCount !== undefined ? ` · IN ${p.inCount} / OUT ${p.outCount}` : ''})</option>`).join('') : '<option value="">(공정 없음 — BOP 적용 전)</option>';
    if (cur && st.procs.some(p => p.op === cur)) els.op.value = cur;
    if (!st.proc.op && st.procs.length) st.proc.op = els.op.value;
    if (!st.procs.length) els.procBox.innerHTML = empty('공정 없음', st.errors.procs || 'processes 가 비어 있습니다 — 관리자 콘솔 "제품 라인 적용"(BOP)을 먼저 실행하세요.');
  }
  async function loadProcess(container) {
    const st = states.get(container); const { els } = st; const p = st.proc;
    if (!p.op) return;
    els.procStatus.textContent = '조회 중…'; p.err = ''; p.edit = false;
    try { p.data = await call(st, '/api/admin/materials/process/' + encodeURIComponent(p.op)); }
    catch (e) { if (e.message === 'auth') return; p.data = null; els.procStatus.textContent = ''; els.procBox.innerHTML = errBox('공정 연결을 읽지 못했습니다: ' + e.message); return; }
    els.procStatus.textContent = `${p.op} · IN ${(p.data.inputs || []).length} · OUT ${(p.data.outputs || []).length} · 미배정 ${(p.data.unassigned || []).length}`;
    renderProcess(container);
  }
  function renderProcess(container) {
    const st = states.get(container); const { els } = st; const p = st.proc; const d = p.data; if (!d) return;
    const proc = st.procs.find(x => x.op === p.op);
    const ins = d.inputs || [], outs = d.outputs || [], un = d.unassigned || [];
    els.procBox.innerHTML = `<div class="fwm-panel">
      <div class="fwm-panel-head"><b>${esc(p.op)} <span class="fwm-name">${esc(proc?.name || '')}</span> <span class="muted">${esc(proc?.line || '')}${proc?.seq ? ' · seq ' + proc.seq : ''}</span></b>
        <div class="fwm-actions">${p.edit ? '<button class="fwm-proc-save">저장 (PUT links)</button><button class="fwm-proc-cancel fwm-ghost">취소</button>' : '<button class="fwm-proc-edit fwm-ghost" title="IN 연결 해제·미배정 라인 연결">연결 편집</button>'}</div></div>
      <div class="fwm-form-err">${esc(p.err || '')}</div>
      <h4>투입 (IN) <span>${ins.length}건 — process_material · 완성품 1대당 소요 = v_process_requirement</span></h4>
      ${ins.length ? `<div class="fwm-scroll"><table class="fwm-table"><thead><tr>${p.edit ? '<th>유지</th>' : ''}<th class="num">순서</th><th>자식 품목</th><th>품명</th><th>부모</th><th class="num">수량/부모</th><th class="num">/완성품</th><th>출고</th><th class="num">분할%</th></tr></thead><tbody>
        ${ins.map((r, i) => `<tr data-line="${r.lineId}">${p.edit ? `<td><input type="checkbox" class="fwm-keep" checked></td>` : ''}<td class="num">${p.edit ? `<input type="number" class="fwm-seq" value="${r.seq ?? i + 1}" min="1" style="width:52px">` : num(r.seq ?? i + 1)}</td>
          <td><b>${esc(r.pn)}</b></td><td class="muted">${esc(r.name || '')}</td><td class="muted">${esc(r.parentPn || '')}</td><td class="num">${qty(r.qtyPer, r.uom)}</td><td class="num">${qty(r.qtyPerProduct, r.uom)}</td><td class="muted">${p.edit ? `<select class="fwm-issue">${['BACKFLUSH', 'PICK', 'BULK'].map(v => `<option${(r.issueMethod || 'BACKFLUSH') === v ? ' selected' : ''}>${v}</option>`).join('')}</select>` : esc(r.issueMethod || '—')}</td><td class="num">${r.splitPct ?? 100}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="muted fwm-small">투입 자재 없음 — 상태 변경만 하는 공정(QC·착자·시험 등)이면 정상.</div>'}
      <h4>산출 (OUT) <span>${outs.length}건 — is_final=1 이면 여기서 로트 확정(백플러시), 0 이면 진행 상태</span></h4>
      ${outs.length ? `<div class="fwm-scroll"><table class="fwm-table"><thead><tr><th>품목</th><th>품명</th><th>완성</th><th>진행 상태</th><th class="num">산출 수량</th></tr></thead><tbody>
        ${outs.map(o => `<tr><td><b>${esc(o.pn)}</b></td><td class="muted">${esc(o.name || '')}</td><td>${o.isFinal ? chip('bop-linked', '완성 (is_final)') : chip('st-DRAFT', '진행')}</td><td>${esc(o.outState || (o.isFinal ? '—' : ''))}</td><td class="num">${o.qtyOut ? qty(o.qtyOut, o.uom) : '—'}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="muted fwm-small">산출 행 없음 — 24공정은 전부 OUT 1행을 가져야 한다(D-9). 샘플 적재 전이면 정상.</div>'}
      <h4>미배정 라인 <span>${un.length}건 — REQUIRED 인데 어느 공정에도 IN 이 없다 (전체 BOM 기준, D-8)</span></h4>
      ${un.length ? `<div class="fwm-scroll"><table class="fwm-table"><thead><tr>${p.edit ? `<th>${esc(p.op)} 에 연결</th>` : ''}<th>부모</th><th>자식 품목</th><th>품명</th><th class="num">/완성품</th><th>비고</th></tr></thead><tbody>
        ${un.map(r => `<tr data-line="${r.lineId}" class="warn">${p.edit ? '<td><input type="checkbox" class="fwm-link"></td>' : ''}<td class="muted">${esc(r.parentPn || '')}</td><td><b>${esc(r.pn)}</b></td><td class="muted">${esc(r.name || '')}</td><td class="num">${qty(r.qtyPerProduct ?? r.qtyPer, r.uom)}</td><td class="fwm-notes">${esc(r.note || '')}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="muted fwm-small">미배정 없음 — 모든 REQUIRED 라인이 공정에 연결되어 있다.</div>'}
      <div class="muted fwm-small">저장은 이 공정의 IN 연결 집합을 통째로 보낸다(<code>{ links: [{ lineId, mode: 'IN', seq }] }</code>) — 체크를 풀면 해제, 미배정에서 체크하면 연결. 트리거가 거부하면(팬텀 라인 D-8, 순서 역전 R-22) 400 문자열을 위에 표시한다.</div>
    </div>`;
    const q = (s) => els.procBox.querySelector(s);
    if (q('.fwm-proc-edit')) q('.fwm-proc-edit').onclick = () => { p.edit = true; p.err = ''; renderProcess(container); };
    if (q('.fwm-proc-cancel')) q('.fwm-proc-cancel').onclick = () => { p.edit = false; p.err = ''; renderProcess(container); };
    if (q('.fwm-proc-save')) q('.fwm-proc-save').onclick = async () => {
      const links = [];
      els.procBox.querySelectorAll('tr[data-line]').forEach(tr => {
        const keep = tr.querySelector('.fwm-keep'), link = tr.querySelector('.fwm-link');
        if ((keep && keep.checked) || (link && link.checked)) {
          const cur = ins.find(x => x.lineId === Number(tr.dataset.line));   // 서버는 IN 집합을 통째로 바꾸므로 splitPct·issueMethod·note 를 함께 보내 값이 기본값으로 덮이지 않게 한다
          links.push({ lineId: Number(tr.dataset.line), mode: 'IN', seq: Number(tr.querySelector('.fwm-seq')?.value) || links.length + 1, splitPct: cur?.splitPct ?? 100, issueMethod: tr.querySelector('.fwm-issue')?.value || cur?.issueMethod || 'BACKFLUSH', note: cur?.note ?? null });
        }
      });
      links.sort((a, b) => a.seq - b.seq);
      try { await call(st, '/api/admin/materials/process/' + encodeURIComponent(p.op) + '/links', { method: 'PUT', body: JSON.stringify({ links }) }); await loadProcess(container); loadSummaryOnly(container); }
      catch (e) { if (e.message === 'auth') return; p.err = e.message; renderProcess(container); }
    };
  }

  // ── 로트 계보 (GET lots, GET lots/:id/genealogy?dir=fwd|back, POST lots) ──
  async function loadLots(container) {
    const st = states.get(container); const { els } = st; const L = st.lots;
    els.lotStatus.textContent = '조회 중…'; L.sel = null; L.gen = null; els.genBox.innerHTML = '';
    try { const r = await call(st, '/api/admin/materials/lots' + qs({ pn: L.pn, q: L.q })); L.list = Array.isArray(r) ? r : (r.lots || []); L.err = ''; }
    catch (e) { if (e.message === 'auth') return; L.list = []; L.err = e.message; }
    els.lotStatus.textContent = L.err ? '' : `${L.list.length}건${L.pn ? ' · ' + L.pn : ''}`;
    renderLots(container);
  }
  function renderLots(container) {
    const st = states.get(container); const { els } = st; const L = st.lots;
    if (L.err) { els.lotsBox.innerHTML = empty('로트 없음 · API 오류', L.err); return; }
    if (!L.list.length) { els.lotsBox.innerHTML = empty('로트 없음', L.pn || L.q ? '조건에 맞는 로트가 없습니다.' : '아직 로트가 없습니다 — 로트·계보는 3단계(실적 신고·백플러시)에서 생기며, 지금은 [+ 로트]로 수동 등록만 가능합니다.'); return; }
    els.lotsBox.innerHTML = `<table class="fwm-table"><thead><tr><th>로트번호</th><th>품목</th><th>종류</th><th class="num">현재 수량</th><th>상태</th><th>진행</th><th>원로트</th><th>공급사 / 밀시트</th><th>생성</th></tr></thead><tbody>
      ${L.list.map(l => `<tr data-id="${l.id}" class="${L.sel?.id === l.id ? 'on' : ''}"><td><b>${esc(l.lotNo)}</b></td><td>${esc(l.pn)} <span class="muted">${esc(l.name || '')}</span></td><td>${chip('lot-' + l.kind, l.kind)}</td><td class="num">${qty(l.qty, l.uom)}${l.qtyInit !== undefined && l.qtyInit !== null && l.qtyInit !== l.qty ? `<span class="muted fwm-uom">/ ${num(l.qtyInit)}</span>` : ''}</td>
        <td>${chip('ls-' + l.status, LOT_STATUS[l.status] || l.status)}</td><td class="muted" title="마지막 통과 산출 공정 (state_pm_id)">${l.stateText ? esc((l.stateOp || '') + ' ' + l.stateText) : '—'}</td><td class="muted">${l.parentLotNo ? esc(l.parentLotNo) : l.parentLotId ? '#' + esc(l.parentLotId) : '—'}</td><td class="muted">${esc([l.supplier, l.supplierLot].filter(Boolean).join(' / ') || '—')}</td><td class="muted">${esc(l.madeAt || l.createdAt || '—')}</td></tr>`).join('')}
    </tbody></table>`;
    els.lotsBox.querySelectorAll('tr[data-id]').forEach(tr => { tr.onclick = () => { L.sel = L.list.find(l => String(l.id) === tr.dataset.id); renderLots(container); loadGenealogy(container); }; });
  }
  async function loadGenealogy(container) {
    const st = states.get(container); const { els } = st; const L = st.lots; if (!L.sel) return;
    els.genBox.innerHTML = '<div class="muted" style="padding:8px">계보 조회 중…</div>';
    try { L.gen = await call(st, '/api/admin/materials/lots/' + encodeURIComponent(L.sel.id) + '/genealogy' + qs({ dir: L.dir })); }
    catch (e) { if (e.message === 'auth') return; L.gen = null; els.genBox.innerHTML = errBox('계보를 읽지 못했습니다: ' + e.message); return; }
    renderGenealogy(container);
  }
  function renderGenealogy(container) {
    const st = states.get(container); const { els } = st; const L = st.lots; const g = L.gen; if (!g) return;
    const lot = g.lot || L.sel; const tree = g.tree || [];
    // 노드 edge = { kind: 'SPLIT'|'CONSUME', qty, uom, op, equipment: {code,name}|null, user, at } — 서버 genealogy 응답 그대로 (분할 = parent_lot_id, 투입 = lot_genealogy)
    const node = (n, depth) => { const e = n.edge || {}; const split = e.kind === 'SPLIT'; return `<div class="fwm-gnode" style="--lvl:${depth}">
      <div class="fwm-grow">
        <span class="fwm-edge ${split ? 'split' : 'input'}" title="${split ? '분할 (parent_lot_id)' : '투입 (lot_genealogy)'}">${split ? '분할' : (L.dir === 'back' ? '← 투입' : '투입 →')}${e.op ? ' @' + esc(e.op) : ''}</span>
        <b>${esc(n.lotNo)}</b> <span class="muted">${esc(n.pn)} ${esc(n.name || '')}</span> ${chip('lot-' + n.kind, n.kind || 'LOT')}
        ${e.qty !== undefined && e.qty !== null ? `<span class="fwm-q1" title="${split ? '분할 수량 (qty_init)' : '실투입 (qty_consumed)'}">${qty(e.qty, e.uom)}</span>` : ''}
        ${e.equipment ? `<span class="muted">${esc(e.equipment.code || e.equipment)}</span>` : ''}${e.user ? `<span class="muted">${esc(e.user)}</span>` : ''}${e.at ? `<span class="muted">${esc(String(e.at).slice(0, 16))}</span>` : ''}
        ${n.stateText ? `<span class="muted" title="진행 상태 (state_pm_id)">${esc(n.stateOp || '')} ${esc(n.stateText)}</span>` : ''}
        ${chip('ls-' + n.status, LOT_STATUS[n.status] || n.status || '')}
      </div>
      ${(n.children || []).map(c => node(c, depth + 1)).join('')}
    </div>`; };
    const count = (ns) => ns.reduce((a, n) => a + 1 + count(n.children || []), 0);
    els.genBox.innerHTML = `<div class="fwm-panel">
      <div class="fwm-panel-head"><b>계보 — ${esc(lot.lotNo)} <span class="fwm-name">${esc(lot.pn)} ${esc(lot.name || '')}</span></b>
        <div class="fwm-actions"><button class="fwm-dir ${L.dir === 'back' ? 'on' : 'fwm-ghost'}" data-dir="back" title="이 로트에 무엇이 들어갔나 (밀시트까지)">역방향</button><button class="fwm-dir ${L.dir === 'fwd' ? 'on' : 'fwm-ghost'}" data-dir="fwd" title="이 로트가 어디로 갔나 (완성품 시리얼까지)">정방향</button></div></div>
      <div class="fwm-gtree">
        <div class="fwm-grow root"><b>${esc(lot.lotNo)}</b> <span class="muted">${esc(lot.pn)}</span> ${chip('lot-' + lot.kind, lot.kind || 'LOT')} <span class="fwm-q1">${qty(lot.qty, lot.uom)}</span> ${chip('ls-' + lot.status, LOT_STATUS[lot.status] || lot.status || '')}${lot.supplierLot ? ` <span class="muted">밀시트 ${esc(lot.supplierLot)}</span>` : ''}</div>
        ${tree.length ? tree.map(n => node(n, 1)).join('') : `<div class="fwm-empty" style="margin-top:8px"><b>계보 없음</b>${L.dir === 'back' ? '이 로트에 투입·분할 기록이 없다 (입고 원로트이거나 실적 미신고).' : '이 로트가 투입된 곳이 없다 (아직 사용 전이거나 실적 미신고).'}</div>`}
      </div>
      <div class="muted fwm-small">${L.dir === 'back' ? '역방향' : '정방향'} · 노드 ${count(tree)} · 간선 2종(분할 parent_lot_id · 투입 lot_genealogy)을 서버가 합쳐 준다(Q-5).</div>
      <div class="fwm-consume"><h4>투입 기록 <span>POST lots/:id/consume — 이 로트(산출)에 다른 로트가 들어갔다고 기록. 3단계 백플러시 전까지는 수동</span></h4>
        <div class="fwm-filters"><input class="fwm-c-lot" placeholder="투입 로트번호" size="22"><input class="fwm-c-qty" type="number" step="any" min="0" placeholder="수량" style="width:90px"><select class="fwm-c-op"><option value="">공정 (선택)</option>${st.procs.map(p => `<option value="${esc(p.op)}">${esc(p.op)} ${esc(p.name || '')}</option>`).join('')}</select><button class="fwm-c-go">기록</button><span class="fwm-form-err fwm-c-err"></span></div></div>
    </div>`;
    els.genBox.querySelectorAll('.fwm-dir').forEach(b => { b.onclick = () => { L.dir = b.dataset.dir; loadGenealogy(container); }; });
    const selId = lot.id ?? L.sel?.id;
    els.genBox.querySelector('.fwm-c-go').onclick = async () => {
      const body = { inLotNo: els.genBox.querySelector('.fwm-c-lot').value.trim(), qty: Number(els.genBox.querySelector('.fwm-c-qty').value), op: els.genBox.querySelector('.fwm-c-op').value || undefined };
      const err = els.genBox.querySelector('.fwm-c-err'); err.textContent = '';
      try {
        await call(st, '/api/admin/materials/lots/' + encodeURIComponent(selId) + '/consume', { method: 'POST', body: JSON.stringify(body) });
        await loadLots(container); L.sel = L.list.find(l => l.id === selId) || null; renderLots(container); if (L.sel) loadGenealogy(container);
      } catch (e) { if (e.message !== 'auth') err.textContent = e.message; }
    };
  }
  function renderLotForm(container) {
    const st = states.get(container); const { els } = st; const f = els.lotForm; f.hidden = false;
    f.innerHTML = `<div class="fwm-panel fwm-form">
      <div class="fwm-panel-head"><b>새 로트 (수동 등록)</b><button class="fwm-close fwm-ghost">✕</button></div>
      <div class="fwm-grid">
        <label>로트번호<input name="lotNo" placeholder="LOT-SC1011-260912-A"></label>
        <label>품목<input name="pn" list="fwm-pn-list" value="${esc(st.lots.pn || '')}"></label>
        <label>종류<select name="kind"><option>LOT</option><option>SUBLOT</option><option>SERIAL</option></select></label>
        <label>수량(기준단위)<input name="qty" type="number" step="any" min="0" value="1"></label>
        <label>원로트 id(분할)<input name="parentLotId" type="number" placeholder="SUBLOT 이면 필수"></label>
        <label>공급사<input name="supplier"></label>
        <label>공급사 로트/밀시트<input name="supplierLot"></label>
        <label>생성일<input name="madeAt" type="date" value="${today()}"></label>
      </div>
      <div class="fwm-form-foot"><button class="fwm-save">등록 (POST)</button><span class="fwm-form-err"></span></div>
      <div class="muted fwm-small">팬텀 품목은 로트를 가질 수 없다. 시리얼은 수량 1. 분할 로트는 원로트 수량에서 차감된다(D-17, 서비스 계층).</div>
    </div>`;
    f.querySelector('.fwm-close').onclick = () => { f.hidden = true; f.innerHTML = ''; };
    f.querySelector('.fwm-save').onclick = async () => {
      const body = {}; f.querySelectorAll('[name]').forEach(x => { body[x.name] = x.value.trim(); });
      body.qty = Number(body.qty); if (!body.parentLotId) delete body.parentLotId; else body.parentLotId = Number(body.parentLotId);
      const err = f.querySelector('.fwm-form-err'); err.textContent = '';
      try { await call(st, '/api/admin/materials/lots', { method: 'POST', body: JSON.stringify(body) }); f.hidden = true; f.innerHTML = ''; st.lots.pn = body.pn; els.lotPn.value = body.pn; await loadLots(container); loadSummaryOnly(container); }
      catch (e) { if (e.message !== 'auth') err.textContent = e.message; }
    };
  }

  // ── 🔩 샘플 적재 (POST import-sample → counts · check · expectedMatch) ──
  async function importSample(container) {
    const st = states.get(container); const { els } = st;
    if (!confirm('docs/4m/cleansing-v1.json 을 서버가 읽어 자재 마스터·BOM·공정 연결을 멱등 UPSERT 합니다(삭제 없음). 진행할까요?')) return;
    els.importBtn.disabled = true; els.importResult.innerHTML = '<div class="muted" style="padding:6px 0">적재 중…</div>';
    try {
      const r = await call(st, '/api/admin/materials/import-sample', { method: 'POST', body: '{}' });
      const counts = Object.entries(r.counts || {}); const check = Object.entries(r.check || {}); const mm = r.mismatches || [];
      els.importResult.innerHTML = `<div class="fwm-panel fwm-import ${r.expectedMatch ? 'ok' : 'warn'}">
        <div class="fwm-panel-head"><b>샘플 적재 결과</b> ${r.expectedMatch ? chip('ok', '기대값 일치 (expectedMatch)') : chip('bad', '기대값 불일치 — 커밋 금지 (cleansing expected)')}<button class="fwm-close fwm-ghost">✕</button></div>
        <div class="fwm-import-grid">
          <div><h4>적재 건수 <span>counts</span></h4>${counts.length ? `<table class="fwm-table"><tbody>${counts.map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td class="num">${v !== null && typeof v === 'object' ? `<span class="fwm-small" style="white-space:normal">${esc(Array.isArray(v) ? v.join(', ') : Object.entries(v).map(([a, b]) => `${a} ${b}`).join(' · '))}</span>` : `<b>${num(v)}</b>`}</td></tr>`).join('')}</tbody></table>` : '<div class="muted fwm-small">counts 없음</div>'}</div>
          <div><h4>검사 <span>v_chk_summary</span></h4>${check.length ? `<div class="fwm-rules">${check.map(([k, v]) => `<span class="fwm-rule ${KNOWN_ISSUE_RULES[k] === Number(v) ? 'known' : 'bad'}"><b>${esc(k)}</b> <i>${num(v)}</i></span>`).join('')}</div><div class="muted fwm-small">정상 = D-8 10 · R-10 10 (쟁점 3·6), 그 외 0</div>` : '<div class="fwm-rule ok" style="display:inline-block"><b>0건</b> 위반 없음</div>'}
            ${mm.length ? `<h4 style="margin-top:10px">불일치 <span>${mm.length}건</span></h4><ul class="fwm-mm">${mm.map(x => `<li>${esc(typeof x === 'string' ? x : JSON.stringify(x))}</li>`).join('')}</ul>` : ''}
            ${(r.warnings || []).length ? `<h4 style="margin-top:10px">경고 <span>${r.warnings.length}건</span></h4><ul class="fwm-mm warn">${r.warnings.map(x => `<li>${esc(typeof x === 'string' ? x : JSON.stringify(x))}</li>`).join('')}</ul>` : ''}
            ${r.tmp ? `<div class="muted fwm-small">임시 품번(TMP, 쟁점 1·2 승인 전): ${esc(Array.isArray(r.tmp) ? r.tmp.map(t => typeof t === 'string' ? t : `${t.pn || t.tmp} → ${t.tmp || t.pn}`).join(', ') : Object.entries(r.tmp).map(([k, v]) => `${k} → ${typeof v === 'string' ? v : v?.tmp || JSON.stringify(v)}`).join(', '))}</div>` : ''}</div>
        </div></div>`;
      els.importResult.querySelector('.fwm-close').onclick = () => { els.importResult.innerHTML = ''; };
      await loadBase(container);
      if (st.bom.pn) st.bom.data = null; st.proc.data = null; st.lots.list = null;
      if (st.section !== 'items') showSection(container, st.section);
    } catch (e) { if (e.message !== 'auth') els.importResult.innerHTML = errBox('샘플 적재 실패: ' + e.message); }
    finally { els.importBtn.disabled = false; }
  }

  // ── 공개 API ─────────────────────────────────────────
  const _mock = {
    get enabled() { return mockOn(); },
    db: null, api: null,
    use() { if (!this.db) { this.db = buildMock(); this.api = mockApi(this.db); } return this.api; },
    reset() { this.db = null; this.api = null; },
  };
  window.FWMaterials = {
    _mock,
    mount(container, api) {
      if (!container) throw new Error('컨테이너가 없습니다');
      const useMock = mockOn(); const fn = useMock ? _mock.use() : api;
      let st = states.get(container); const first = !st;
      if (first) st = build(container, fn); else st.api = fn;
      st.mock = useMock; st.els.mockflag.hidden = !useMock;
      if (first) loadBase(container);
      else { loadSummaryOnly(container); loadItems(container); }   // 재진입: 골격 유지, 요약·목록만 갱신
    },
  };
})();
