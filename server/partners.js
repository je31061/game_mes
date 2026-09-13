/* 거래처 마스터 API (스프린트 4, 인터페이스 §12) — registerPartners(app, { requireAdmin, db })
 *
 * 표는 server/db.js 의 partners. 매입처·매출처를 한 표에 두고 kind 로 나눈다(BUY/SELL/BOTH/ETC) —
 * 사서 팔기도 하는 곳이 흔해서 ERP 들이 공통으로 쓰는 방식이다.
 * 지우지 않고 status(ACTIVE/HOLD/CLOSED)로 관리한다 — 품목과 같은 규칙. 이미 쓰인 거래처를 지우면 과거 전표가 떠 버린다.
 *
 * 품목 연동(주거래처·공급사 품번·단가)은 다음 단계(품목 세부 등록 화면)에서 item_partner 로 붙인다.
 */

export const PARTNER_KINDS = [
  { code: 'BUY',  name: '매입', hint: '우리가 사 오는 곳 — 자재·부품 공급사' },
  { code: 'SELL', name: '매출', hint: '우리가 파는 곳 — 고객사' },
  { code: 'BOTH', name: '매입·매출', hint: '사기도 하고 팔기도 하는 곳 — 사급·임가공이 얽힌 협력사' },
  { code: 'ETC',  name: '기타', hint: '외주·운송·용역처럼 자재가 오가지 않는 곳' },
];
export const PARTNER_STATUS = [
  { code: 'ACTIVE', name: '거래중' },
  { code: 'HOLD',   name: '거래보류' },
  { code: 'CLOSED', name: '거래종료' },
];

const KIND_CODES = PARTNER_KINDS.map((k) => k.code);
const STATUS_CODES = PARTNER_STATUS.map((s) => s.code);

// 사업자등록번호: 000-00-00000. 국세청 검증식(가중치 1,3,7,1,3,7,1,3,5 + 9번째 자리 ×5 의 십의 자리)
export function normalizeBizNo(v) {
  const d = String(v ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length !== 10) throw new Error('사업자등록번호는 숫자 10자리입니다 — 예) 123-45-67890');
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(d[i]) * w[i];
  sum += Math.floor((Number(d[8]) * 5) / 10);
  if ((10 - (sum % 10)) % 10 !== Number(d[9])) throw new Error(`사업자등록번호 ${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)} 는 검증식을 통과하지 못했습니다 — 자릿수를 확인하세요.`);
  return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
}

export function registerPartners(app, { requireAdmin, db, afterChange = () => {} } = {}) {
  const q = (sql) => db.prepare(sql);
  const fail = (res, e, status = 400) => res.status(status).json({ error: String(e?.message || e) });
  const orNull = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
  const B = '/api/admin/partners';

  const json = (r) => r && ({
    id: r.id, code: r.code, name: r.name, kind: r.kind,
    kindName: (PARTNER_KINDS.find((k) => k.code === r.kind) || {}).name || r.kind,
    bizNo: r.biz_no, ceo: r.ceo, bizType: r.biz_type, bizItem: r.biz_item,
    tel: r.tel, fax: r.fax, email: r.email, zipcode: r.zipcode, addr: r.addr,
    mgrName: r.mgr_name, mgrTel: r.mgr_tel, mgrEmail: r.mgr_email,
    payTerms: r.pay_terms, currency: r.currency, status: r.status,
    statusName: (PARTNER_STATUS.find((s) => s.code === r.status) || {}).name || r.status,
    note: r.note, createdAt: r.created_at, updatedAt: r.updated_at,
  });
  const byCode = (code) => q('SELECT * FROM partners WHERE code = ?').get(String(code));

  // 코드를 안 주면 P0001 부터 비어 있는 번호를 찾아 채운다 (P 로 시작하는 기존 코드만 본다)
  function nextCode() {
    const rows = q(`SELECT code FROM partners WHERE code GLOB 'P[0-9][0-9][0-9][0-9]'`).all().map((r) => Number(r.code.slice(1)));
    const used = new Set(rows);
    for (let n = 1; n <= 9999; n++) if (!used.has(n)) return 'P' + String(n).padStart(4, '0');
    throw new Error('자동 채번이 가득 찼습니다 — 거래처 코드를 직접 지정하세요.');
  }

  // ── 메타 (화면 드롭다운 + 건수) ──
  app.get(`${B}/meta`, requireAdmin, (req, res) => {
    try {
      const byKind = Object.fromEntries(q('SELECT kind, COUNT(*) c FROM partners GROUP BY kind').all().map((r) => [r.kind, r.c]));
      const byStatus = Object.fromEntries(q('SELECT status, COUNT(*) c FROM partners GROUP BY status').all().map((r) => [r.status, r.c]));
      // 칩 건수는 목록 필터와 같은 뜻이어야 한다 — 매입·매출 칩은 BOTH 를 함께 센다(필터도 함께 보여 주므로)
      const kindCount = (c) => (c === 'BUY' || c === 'SELL' ? (byKind[c] || 0) + (byKind.BOTH || 0) : byKind[c] || 0);
      res.json({
        kinds: PARTNER_KINDS.map((k) => ({ ...k, count: kindCount(k.code) })),
        statuses: PARTNER_STATUS.map((s) => ({ ...s, count: byStatus[s.code] || 0 })),
        total: q('SELECT COUNT(*) c FROM partners').get().c,
        nextCode: nextCode(),
      });
    } catch (e) { fail(res, e, 500); }
  });

  // ── 목록 ──
  app.get(B, requireAdmin, (req, res) => {
    try {
      const { q: text, kind, status } = req.query;
      const where = [], p = [];
      if (text) {
        where.push('(code LIKE ? OR name LIKE ? OR biz_no LIKE ? OR ceo LIKE ? OR mgr_name LIKE ?)');
        const t = `%${String(text).trim()}%`; p.push(t, t, t, t, t);
      }
      if (kind) {
        const k = String(kind).toUpperCase();
        if (!KIND_CODES.includes(k)) return res.status(400).json({ error: `거래구분은 ${KIND_CODES.join('/')} 중 하나입니다.` });
        // 매입/매출을 고르면 '매입·매출' 거래처도 함께 보인다 — 실제로 그 역할을 하는 곳이므로
        if (k === 'BUY' || k === 'SELL') { where.push(`kind IN (?, 'BOTH')`); p.push(k); }
        else { where.push('kind = ?'); p.push(k); }
      }
      if (status) { where.push('status = ?'); p.push(String(status).toUpperCase()); }
      const rows = q(`SELECT * FROM partners ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                       ORDER BY CASE status WHEN 'ACTIVE' THEN 0 WHEN 'HOLD' THEN 1 ELSE 2 END, code`).all(...p);
      res.json(rows.map(json));
    } catch (e) { fail(res, e, 500); }
  });

  app.get(`${B}/:code`, requireAdmin, (req, res) => {
    const r = byCode(req.params.code);
    if (!r) return res.status(404).json({ error: `거래처 ${req.params.code} 이(가) 없습니다.` });
    res.json({ partner: json(r) });
  });

  function upsert(body, existing) {
    const b = body || {};
    const name = orNull(b.name ?? existing?.name);
    if (!name) throw new Error('거래처명을 적어 주세요.');
    let code = orNull(b.code) ?? existing?.code ?? null;
    if (!code) code = nextCode();
    if (/[\s/]/.test(code)) throw new Error('거래처 코드에 공백이나 / 는 쓸 수 없습니다.');
    if (code.length > 20) throw new Error('거래처 코드는 20자 이내입니다.');

    const kind = String(b.kind ?? existing?.kind ?? 'BUY').toUpperCase();
    if (!KIND_CODES.includes(kind)) throw new Error(`거래구분은 ${PARTNER_KINDS.map((k) => `${k.code}(${k.name})`).join(' · ')} 중 하나입니다.`);
    const status = String(b.status ?? existing?.status ?? 'ACTIVE').toUpperCase();
    if (!STATUS_CODES.includes(status)) throw new Error(`상태는 ${PARTNER_STATUS.map((s) => `${s.code}(${s.name})`).join(' · ')} 중 하나입니다.`);
    const bizNo = b.bizNo !== undefined ? (orNull(b.bizNo) === null ? null : normalizeBizNo(b.bizNo)) : (existing?.biz_no ?? null);
    const email = orNull(b.email ?? existing?.email);
    if (email && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) throw new Error(`이메일 형식이 아닙니다 — ${email}`);

    const v = {
      code, name, kind, biz_no: bizNo, status,
      ceo: orNull(b.ceo ?? existing?.ceo), biz_type: orNull(b.bizType ?? existing?.biz_type), biz_item: orNull(b.bizItem ?? existing?.biz_item),
      tel: orNull(b.tel ?? existing?.tel), fax: orNull(b.fax ?? existing?.fax), email,
      zipcode: orNull(b.zipcode ?? existing?.zipcode), addr: orNull(b.addr ?? existing?.addr),
      mgr_name: orNull(b.mgrName ?? existing?.mgr_name), mgr_tel: orNull(b.mgrTel ?? existing?.mgr_tel), mgr_email: orNull(b.mgrEmail ?? existing?.mgr_email),
      pay_terms: orNull(b.payTerms ?? existing?.pay_terms), currency: (orNull(b.currency ?? existing?.currency) || 'KRW').toUpperCase(),
      note: orNull(b.note ?? existing?.note),
    };
    if (existing) {
      q(`UPDATE partners SET code = ?, name = ?, kind = ?, biz_no = ?, ceo = ?, biz_type = ?, biz_item = ?, tel = ?, fax = ?, email = ?,
                zipcode = ?, addr = ?, mgr_name = ?, mgr_tel = ?, mgr_email = ?, pay_terms = ?, currency = ?, status = ?, note = ?,
                updated_at = datetime('now','localtime') WHERE id = ?`)
        .run(v.code, v.name, v.kind, v.biz_no, v.ceo, v.biz_type, v.biz_item, v.tel, v.fax, v.email,
          v.zipcode, v.addr, v.mgr_name, v.mgr_tel, v.mgr_email, v.pay_terms, v.currency, v.status, v.note, existing.id);
    } else {
      q(`INSERT INTO partners (code, name, kind, biz_no, ceo, biz_type, biz_item, tel, fax, email, zipcode, addr, mgr_name, mgr_tel, mgr_email, pay_terms, currency, status, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(v.code, v.name, v.kind, v.biz_no, v.ceo, v.biz_type, v.biz_item, v.tel, v.fax, v.email,
          v.zipcode, v.addr, v.mgr_name, v.mgr_tel, v.mgr_email, v.pay_terms, v.currency, v.status, v.note);
    }
    return byCode(v.code);
  }

  app.post(B, requireAdmin, (req, res) => {
    try {
      const code = orNull(req.body?.code);
      const existing = code ? byCode(code) : null;
      const r = upsert(req.body, existing);
      afterChange();
      res.status(existing ? 200 : 201).json({ ok: true, created: !existing, partner: json(r) });
    } catch (e) { fail(res, e); }
  });

  app.put(`${B}/:code`, requireAdmin, (req, res) => {
    try {
      const existing = byCode(req.params.code);
      if (!existing) return res.status(404).json({ error: `거래처 ${req.params.code} 이(가) 없습니다.` });
      const r = upsert(req.body, existing);
      afterChange();
      res.json({ ok: true, partner: json(r) });
    } catch (e) { fail(res, e); }
  });

  app.delete(`${B}/:code`, requireAdmin, (req, res) =>
    res.status(405).json({ error: '거래처는 삭제하지 않습니다 — 상태를 거래종료(CLOSED)로 바꾸세요. 지우면 과거 전표의 거래처가 사라집니다.' }));
}
