import express from 'express';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { db, queries, settings, DATA_DIR, EQUIPMENT_TYPES, inferEquipmentType } from './db.js';
import { createGateway } from './gateway.js';
import { signToken, verifyToken, hashPassword, verifyPassword } from './auth.js';
import { runBackup, listBackups, defaultBackupRoot } from './backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const FLOORPLAN_DIR = path.join(DATA_DIR, 'floorplan');   // 공장 평면도(배경 이미지) 저장
fs.mkdirSync(FLOORPLAN_DIR, { recursive: true });
const PARTS_DIR = path.join(__dirname, '..', 'public', 'assets', 'parts');   // 분해도 서브어셈블리 이미지 <PN>.png (인터페이스 §8)
const BLDC_DIR = path.join(__dirname, '..', 'docs', 'bldc');                 // 제품 라인 샘플 (BOP JSON + 배치 JSON)
const MAP_W = 24, MAP_H = 16;

const app = express();
// HTTPS/WSS (NFR-03 전 구간 암호화): FW_TLS_CERT/FW_TLS_KEY(PEM)가 있으면 TLS로 기동.
// 리버스 프록시(IIS/nginx) 뒤에 둘 때는 프록시가 TLS를 종단하므로 설정하지 않아도 된다.
const TLS = process.env.FW_TLS_CERT && process.env.FW_TLS_KEY
  ? { cert: fs.readFileSync(process.env.FW_TLS_CERT), key: fs.readFileSync(process.env.FW_TLS_KEY) }
  : null;
const server = TLS ? https.createServer(TLS, app) : http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
// 분석 화면 파일(서지안, 인터페이스 §5)이 아직 없을 때의 대체 응답 — 콘솔 404 없이 빈 스크립트/스타일 제공.
// 실제 파일이 public/에 놓이면 위 static이 먼저 응답하므로 이 라우트는 자동으로 비활성화된다.
app.get('/js/analytics.js', (req, res) => res.type('application/javascript').send('// analytics.js 미배치 — public/js/analytics.js 를 추가하면 대체됩니다\n'));
app.get('/css/analytics.css', (req, res) => res.type('text/css').send('/* analytics.css 미배치 */\n'));

// ── 인증 (사번 + 비밀번호 → JWT, NFR-03) ──────────────
// admin 초기 비밀번호 시드 — 환경변수 FW_ADMIN_PASSWORD가 있으면 그 값(클라우드 배포용), 없으면 admin1234 (최초 로그인 후 변경 권장)
{
  const adminRow = queries.findUserByEmpNo.get('admin');
  if (adminRow && !adminRow.password_hash) {
    queries.setPassword.run(hashPassword(process.env.FW_ADMIN_PASSWORD || 'admin1234'), adminRow.id);
    if (process.env.FW_ADMIN_PASSWORD) console.log('[auth] 관리자 초기 비밀번호를 FW_ADMIN_PASSWORD로 설정');
  }
}

// ── 파일럿 운영 정책 (settings.policy) ──
//  allowSelfRegister: 신규 사번이 첫 로그인으로 자동 등록되는지 (운영 전환 시 false 권장 → 관리자 사전 등록)
//  retentionDays: 대화·파일 보존 일수 (0 = 무기한). 백업 직후 하루 1회 정리 (FR-08 보존 기간 정책)
//  shiftMinutesPerDay: 1일 계획 가동 시간(분, 1~1440). 실적 분석(OEE 가동률 분모)이 읽는다 — 없으면(null) 24h. docs/분석-정의.md §2
function normalizeShiftMinutes(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 1440 ? n : undefined; // undefined = 잘못된 값
}
function getPolicy() {
  const p = settings.get('policy', {}) || {};
  // 콘솔에서 정한 값이 없으면 환경변수 FW_SELF_REGISTER(기본 true)로 초기값 결정 — 공개 배포 시 false 권장
  const envSelf = process.env.FW_SELF_REGISTER !== 'false';
  return {
    allowSelfRegister: p.allowSelfRegister === undefined ? envSelf : p.allowSelfRegister !== false,
    retentionDays: Math.max(0, Math.min(3650, Math.floor(Number(p.retentionDays) || 0))),
    shiftMinutesPerDay: normalizeShiftMinutes(p.shiftMinutesPerDay) ?? null,
  };
}
app.get('/api/policy', (req, res) => res.json({ allowSelfRegister: getPolicy().allowSelfRegister }));

app.post('/api/login', (req, res) => {
  const { empNo, name, password } = req.body || {};
  if (!empNo || !name || !/^[\w가-힣 .-]{1,30}$/.test(name) || !/^[\w-]{1,20}$/.test(empNo)) {
    return res.status(400).json({ error: '사번과 이름을 확인해 주세요.' });
  }
  if (!password || String(password).length < 4) {
    return res.status(400).json({ error: '비밀번호는 4자 이상 입력해 주세요.' });
  }
  let user = queries.findUserByEmpNo.get(empNo);
  if (!user) {
    if (!getPolicy().allowSelfRegister) {
      return res.status(403).json({ error: '등록되지 않은 사번입니다. 관리자에게 사용자 등록을 요청해 주세요.' });
    }
    // 신규 사번: 입력한 비밀번호로 자동 등록 (파일럿 정책)
    const r = queries.createUser.run(empNo, name, 'worker');
    user = queries.getUser.get(r.lastInsertRowid);
    queries.setPassword.run(hashPassword(password), user.id);
  } else if (!user.password_hash) {
    // 기존 사용자 마이그레이션: 첫 로그인 시 비밀번호 등록
    queries.setPassword.run(hashPassword(password), user.id);
  } else if (!verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: '비밀번호가 일치하지 않습니다.' });
  }
  // emp: 발급 당시 사번 — DB가 초기화되는 배포(Render)에서 같은 id의 다른 사용자로 인증되는 것을 막는다 (authUser에서 대조)
  const token = signToken({ uid: user.id, emp: user.emp_no });
  res.json({ token, user: { id: user.id, empNo: user.emp_no, name: user.name, role: user.role } });
});

function authUser(token) {
  const payload = verifyToken(token);
  if (!payload) return null;
  const user = queries.getUser.get(payload.uid);
  if (!user) return null;
  if (payload.emp && payload.emp !== user.emp_no) return null;   // 토큰의 사번과 현재 id의 사번이 다르면 무효
  return user;
}

// 세션 확인 (자동 로그인): 저장된 토큰이 유효하면 로그인 화면을 건너뛴다 — 관리자 콘솔 → 공장 맵, 테마 전환 새로고침
app.get('/api/me', (req, res) => {
  const user = authUser(req.headers['x-auth-token']);
  if (!user || user.role === 'system') return res.status(401).json({ error: '세션이 만료되었습니다. 다시 로그인해 주세요.' });
  res.json({ user: { id: user.id, empNo: user.emp_no, name: user.name, role: user.role } });
});

// 비밀번호 변경 (본인)
app.post('/api/password/change', (req, res) => {
  const user = authUser(req.headers['x-auth-token']);
  if (!user) return res.status(401).json({ error: '인증이 필요합니다.' });
  const { oldPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 4) {
    return res.status(400).json({ error: '새 비밀번호는 4자 이상이어야 합니다.' });
  }
  if (user.password_hash && !verifyPassword(oldPassword, user.password_hash)) {
    return res.status(401).json({ error: '현재 비밀번호가 일치하지 않습니다.' });
  }
  queries.setPassword.run(hashPassword(newPassword), user.id);
  res.json({ ok: true });
});

// 상태 변경 권한: 보전/관리자 (설계서 6.3 '상태 변경(권한자)')
const CAN_SET_STATUS = ['maintainer', 'admin'];

// ── 파일 업로드/다운로드 (MVP: 로컬 저장, 확장자 화이트리스트) ──
const ALLOWED_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'mp4', 'dwg', 'dxf', 'xlsx', 'docx', 'pptx', 'txt', 'csv']);

app.post('/api/upload', express.raw({ type: '*/*', limit: '25mb' }), (req, res) => {
  const user = authUser(req.headers['x-auth-token']);
  if (!user) return res.status(401).json({ error: '인증이 필요합니다.' });

  const channel = String(req.query.channel || '');
  const originalName = decodeURIComponent(String(req.query.name || 'file'));
  const ext = originalName.split('.').pop().toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return res.status(400).json({ error: `허용되지 않는 확장자입니다 (${ext})` });
  if (!req.body || !req.body.length) return res.status(400).json({ error: '빈 파일입니다.' });

  const m = channel.match(/^eq:(\d+)$/);
  const equipmentId = m ? Number(m[1]) : null;
  if (channel !== 'all' && !m) return res.status(400).json({ error: '잘못된 채널입니다.' });
  if (equipmentId && !queries.getEquipment.get(equipmentId)) return res.status(400).json({ error: '설비를 찾을 수 없습니다.' });

  const safeBase = originalName.replace(/[^\w가-힣 ().-]/g, '_').slice(-80);
  const storedName = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${safeBase}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, storedName), req.body);

  // 메시지로 저장(파일은 설비 이력에 귀속 — append-only)
  const content = JSON.stringify({ name: originalName, size: req.body.length });
  const msgId = queries.saveMessage.run(channel, equipmentId, user.id, user.name, 'file', content).lastInsertRowid;
  const fileId = queries.saveFile.run(msgId, equipmentId, storedName, originalName, req.body.length, user.id).lastInsertRowid;
  db.prepare('UPDATE messages SET content = ? WHERE id = ?')
    .run(JSON.stringify({ fileId, name: originalName, size: req.body.length }), msgId);

  const msg = queries.getMessage.get(msgId);
  io.to(roomOf(channel)).emit('chat:message', shapeMessage(msg));
  res.json({ ok: true, fileId });
});

app.get('/api/files/:id', (req, res) => {
  const f = queries.getFile.get(Number(req.params.id));
  if (!f) return res.status(404).end();
  res.download(path.join(UPLOAD_DIR, f.stored_name), f.original_name);
});

// ── 맵 구성 변경 브로드캐스트 (존/설비 마스터 편집 → 접속자 맵 즉시 반영, NFR-02) ──
function worldPayload() {
  return { zones: queries.listZones.all(), equipments: queries.listEquipments.all(), floorplan: settings.get('floorplan', null) };
}
function emitWorldRefresh() {
  io.emit('world:refresh', worldPayload());
}

// ── 공장 평면도 배경 (옵션): 건축 배치도·설계도 이미지를 맵 에디터와 게임 맵 바닥에 깔기 ──
const FLOORPLAN_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'svg']);
const clampInt = (v, min, max, def) => Number.isFinite(Number(v)) ? Math.max(min, Math.min(max, Math.round(Number(v)))) : def;

function normalizeFloorplan(prev, patch = {}) {
  const rect = { ...(prev?.rect || { x: 0, y: 0, w: MAP_W, h: MAP_H }), ...(patch.rect || {}) };
  return {
    file: patch.file ?? prev?.file ?? null,
    name: patch.name ?? prev?.name ?? null,
    uploadedAt: patch.uploadedAt ?? prev?.uploadedAt ?? null,
    opacity: Math.max(0.1, Math.min(1, Number(patch.opacity ?? prev?.opacity ?? 0.6) || 0.6)),
    showInGame: patch.showInGame !== undefined ? !!patch.showInGame : (prev?.showInGame ?? true),
    rect: {
      x: clampInt(rect.x, 0, MAP_W - 1, 0), y: clampInt(rect.y, 0, MAP_H - 1, 0),
      w: clampInt(rect.w, 1, MAP_W, MAP_W), h: clampInt(rect.h, 1, MAP_H, MAP_H),
    },
  };
}

// 이미지 파일 — 로그인 사용자면 열람 가능 (게임 클라이언트는 쿼리 토큰으로 요청)
app.get('/api/floorplan/image', (req, res) => {
  const user = authUser(req.query.token || req.headers['x-auth-token']);
  if (!user) return res.status(401).end();
  const plan = settings.get('floorplan', null);
  if (!plan?.file || (req.query.f && req.query.f !== plan.file)) return res.status(404).end();
  res.sendFile(path.join(FLOORPLAN_DIR, plan.file));
});

app.get('/api/admin/floorplan', requireAdmin, (req, res) => res.json(settings.get('floorplan', null)));

app.post('/api/admin/floorplan', requireAdmin, express.raw({ type: '*/*', limit: '15mb' }), (req, res) => {
  const originalName = decodeURIComponent(String(req.query.name || 'floorplan.png'));
  const ext = originalName.split('.').pop().toLowerCase();
  if (!FLOORPLAN_EXT.has(ext)) return res.status(400).json({ error: '평면도는 PNG/JPG/WEBP/SVG만 가능합니다. PDF·DWG는 이미지로 내보낸 뒤 올려 주세요.' });
  if (!req.body || !req.body.length) return res.status(400).json({ error: '빈 파일입니다.' });
  const prev = settings.get('floorplan', null);
  const file = `floorplan_${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(FLOORPLAN_DIR, file), req.body);
  if (prev?.file) { try { fs.unlinkSync(path.join(FLOORPLAN_DIR, prev.file)); } catch {} }
  const plan = normalizeFloorplan(prev, { file, name: originalName, uploadedAt: localTs(new Date()) });
  settings.set('floorplan', plan);
  emitWorldRefresh();
  res.json(plan);
});

app.put('/api/admin/floorplan', requireAdmin, (req, res) => {
  const prev = settings.get('floorplan', null);
  if (!prev?.file) return res.status(404).json({ error: '평면도가 없습니다. 먼저 업로드해 주세요.' });
  const plan = normalizeFloorplan(prev, req.body || {});
  settings.set('floorplan', plan);
  emitWorldRefresh();
  res.json(plan);
});

app.delete('/api/admin/floorplan', requireAdmin, (req, res) => {
  const prev = settings.get('floorplan', null);
  if (prev?.file) { try { fs.unlinkSync(path.join(FLOORPLAN_DIR, prev.file)); } catch {} }
  settings.set('floorplan', null);
  emitWorldRefresh();
  res.json({ ok: true });
});

// ── 배치 데이터 JSON 내보내기/가져오기 (도면 → Claude/Gemini → JSON → 맵) ──
// 스키마: docs/도면-AI-연동.md. 가져오기는 존(이름)·설비(코드) 기준 추가/갱신, 라인(코드 쌍) 추가. 삭제는 하지 않음.
// 스프린트 2: equipments[].op(공정 연결), "replace": true 면 파일에 없는 설비·존을 hidden=1 로 숨김(이력 보존, 콘솔에서 복원 가능).
// 내보내기는 숨긴 설비·존을 제외한다.
app.get('/api/admin/layout', requireAdmin, (req, res) => {
  const zones = queries.listZones.all();
  const zoneName = new Map(zones.map(z => [z.id, z.name]));
  res.json({
    version: 1,
    map: { w: MAP_W, h: MAP_H },
    zones: zones.map(z => ({ name: z.name, color: z.color, rect: { x: z.rect_x, y: z.rect_y, w: z.rect_w, h: z.rect_h } })),
    equipments: queries.listEquipments.all().map(e => ({
      code: e.code, name: e.name, type: e.type || 'generic', op: e.op || null, zone: zoneName.get(e.zone_id) || null, x: e.x, y: e.y, manager: e.manager || '',
    })),
    links: queries.listLinks.all().map(l => ({ from: l.from_code, to: l.to_code })),
  });
});

// 배치 JSON 적용 (트랜잭션). 실패 시 Error throw (호출자가 400 응답). 성공 시 결과 집계 반환 — 브로드캐스트는 호출자가 afterLayoutChange()
function importLayout(body) {
  body = body || {};
  const zonesIn = Array.isArray(body.zones) ? body.zones : [];
  const eqIn = Array.isArray(body.equipments) ? body.equipments : [];
  const linksIn = Array.isArray(body.links) ? body.links : [];
  const replace = body.replace === true;
  if (!zonesIn.length && !eqIn.length && !linksIn.length) {
    throw new Error('zones / equipments / links 중 하나는 있어야 합니다.');
  }
  const result = {
    zones: { created: 0, updated: 0, hidden: 0, restored: 0 },
    equipments: { created: 0, updated: 0, hidden: 0, restored: 0, opLinked: 0 },
    links: { created: 0 }, replace, warnings: [],
  };
  const isColor = (c) => /^#[0-9a-f]{6}$/i.test(String(c || ''));
  const opMissing = [];
  db.exec('BEGIN');
  try {
    const zoneNamesIn = new Set();
    for (const z of zonesIn) {
      const name = String(z.name || '').trim().slice(0, 40);
      if (!name) { result.warnings.push('이름 없는 존을 건너뜀'); continue; }
      zoneNamesIn.add(name);
      const r = z.rect || {};
      const cur = queries.findZoneByName.get(name);
      const rect = {
        x: clampInt(r.x, 0, MAP_W - 1, cur?.rect_x ?? 0), y: clampInt(r.y, 0, MAP_H - 1, cur?.rect_y ?? 0),
        w: clampInt(r.w, 1, MAP_W, cur?.rect_w ?? 4), h: clampInt(r.h, 1, MAP_H, cur?.rect_h ?? 3),
      };
      const color = isColor(z.color) ? z.color : (cur?.color || '#3d5a80');
      if (cur) {
        queries.updateZone.run(name, color, rect.x, rect.y, rect.w, rect.h, cur.id); result.zones.updated++;
        if (cur.hidden) { queries.setZoneHidden.run(0, cur.id); result.zones.restored++; }   // 파일에 있는 존은 다시 보이게
      } else { queries.createZone.run(name, color, rect.x, rect.y, rect.w, rect.h); result.zones.created++; }
    }
    const zones = queries.listZones.all();
    const zoneByName = new Map(zones.map(z => [z.name, z]));
    const zoneAt = (x, y) => zones.find(z => x >= z.rect_x && x < z.rect_x + z.rect_w && y >= z.rect_y && y < z.rect_y + z.rect_h);
    const codesIn = new Set();
    for (const e of eqIn) {
      const code = String(e.code || '').trim().slice(0, 20);
      if (!code) { result.warnings.push('코드 없는 설비를 건너뜀'); continue; }
      codesIn.add(code);
      const cur = queries.findEquipmentByCode.get(code);
      const x = clampInt(e.x, 0, MAP_W - 1, cur?.x ?? 0), y = clampInt(e.y, 0, MAP_H - 1, cur?.y ?? 0);
      const zone = (e.zone && zoneByName.get(String(e.zone))) || zoneAt(x, y) || (cur ? queries.getZone.get(cur.zone_id) : zones[0]);
      if (!zone) { result.warnings.push(`${code}: 배치할 존이 없어 건너뜀 (존을 먼저 정의하세요)`); continue; }
      if (e.zone && !zoneByName.has(String(e.zone))) result.warnings.push(`${code}: 존 '${e.zone}'이 없어 좌표 기준 존(${zone.name})으로 배치`);
      const name = String(e.name || cur?.name || code).trim().slice(0, 40);
      const manager = String(e.manager ?? cur?.manager ?? '').trim().slice(0, 30);
      // 유형(선택): 지정되면 검증, 없으면 기존 값 유지(신규는 코드 접두로 추정)
      let type = cur?.type || inferEquipmentType(code);
      if (e.type !== undefined && e.type !== null && e.type !== '') {
        if (EQUIPMENT_TYPES.includes(String(e.type))) type = String(e.type);
        else result.warnings.push(`${code}: 알 수 없는 유형 '${e.type}' — ${type}(으)로 유지`);
      }
      let id;
      if (cur) {
        queries.updateEquipment.run(zone.id, code, name, x, y, manager, cur.data_source, type, cur.id); result.equipments.updated++; id = cur.id;
        if (cur.hidden) { queries.setEquipmentHidden.run(0, cur.id); result.equipments.restored++; }
      } else { id = queries.createEquipment.run(zone.id, code, name, x, y, manager, type).lastInsertRowid; result.equipments.created++; }
      // 공정 연결(선택): 문자열이면 설정, null/'' 이면 해제, 없으면 유지
      if (e.op !== undefined) {
        const op = String(e.op || '').trim().slice(0, 20) || null;
        queries.setEquipmentOp.run(op, id);
        if (op) { result.equipments.opLinked++; if (!queries.processByOp.get(op)) opMissing.push(`${code}→${op}`); }
      }
    }
    for (const l of linksIn) {
      const a = queries.findEquipmentByCode.get(String(l.from || '')), b = queries.findEquipmentByCode.get(String(l.to || ''));
      if (!a || !b || a.id === b.id) { result.warnings.push(`라인 ${l.from}→${l.to}: 설비를 찾을 수 없어 건너뜀`); continue; }
      try { queries.createLink.run(a.id, b.id); result.links.created++; } catch { /* 이미 있음 */ }
    }
    // replace: 파일에 없는 설비·존은 숨김 (삭제 아님 — 이력·실적·라인 레코드 보존). 설비/존 목록이 있을 때만 각각 적용
    if (replace) {
      if (eqIn.length) {
        for (const e of queries.listAllEquipments.all()) {
          if (!codesIn.has(e.code) && !e.hidden) { queries.setEquipmentHidden.run(1, e.id); result.equipments.hidden++; }
        }
      }
      if (zonesIn.length) {
        for (const z of queries.listAllZones.all()) {
          if (!zoneNamesIn.has(z.name) && !z.hidden) { queries.setZoneHidden.run(1, z.id); result.zones.hidden++; }
        }
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  if (opMissing.length) result.warnings.push(`BOP에 없는 공정에 연결된 설비 ${opMissing.length}대 (${opMissing.slice(0, 5).join(', ')}${opMissing.length > 5 ? ' …' : ''}) — BOP JSON을 먼저 가져오면 상태창에 단품이 표시됩니다`);
  return result;
}

function afterLayoutChange() {
  syncLinkStates();
  emitWorldRefresh();
  io.emit('links:changed', { links: linksPayload(), states: linkStatesPayload() });
  gateway.reload();
}

app.post('/api/admin/layout', requireAdmin, (req, res) => {
  let result;
  try { result = importLayout(req.body); }
  catch (e) { return res.status(400).json({ error: '가져오기 실패: ' + e.message }); }
  afterLayoutChange();
  res.json({ ok: true, ...result });
});

// ── 스프린트 2: 제품 공정(BOP) · 단품(BOM) · 분해도 (인터페이스 §7) ──
// 원천 JSON(docs/bldc/bldc-500w-48v.json, scripts/bldc/extract.py 생성)을 products/processes/parts/process_inputs 에 upsert.
// 분해도 단계(exploded)·라인 밸런스 기준값·사양은 products.spec_json 에 원문 보관(표로 풀지 않음).
const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
const partImageFor = (...pns) => {
  for (const pn of pns) {
    if (!pn || /[\\/]/.test(String(pn))) continue;                        // 'HA-3000/EX-5000' 같은 복합 부모는 파일 없음
    if (fs.existsSync(path.join(PARTS_DIR, `${pn}.png`))) return `${pn}.png`;
  }
  return null;
};

function importBop(json) {
  const prod = json?.product;
  if (!prod || !prod.code) throw new Error('product.code 가 필요합니다.');
  const code = String(prod.code).trim().slice(0, 40);
  const name = String(prod.name || code).trim().slice(0, 80);
  const subs = Array.isArray(json.subassemblies) ? json.subassemblies : [];
  const parts = Array.isArray(json.parts) ? json.parts : [];
  const procs = Array.isArray(json.processes) ? json.processes : [];
  const exploded = Array.isArray(json.exploded) ? json.exploded : [];
  if (!procs.length) throw new Error('processes 가 비어 있습니다.');
  const result = { product: code, subassemblies: 0, parts: 0, processes: 0, inputs: 0, stages: exploded.length, warnings: [] };
  const qtyOf = new Map();   // pn → 제품 1대당 수량 (투입 표의 수량)
  db.exec('BEGIN');
  try {
    queries.upsertProduct.run(code, name, JSON.stringify({
      spec: prod.spec || {},
      exploded: exploded.map(s => ({
        stage: num(s.stage), pn: String(s.pn || ''), file: s.file || partImageFor(s.pn), label: s.label || s.pn, group: s.group || null,
      })).filter(s => s.pn),
      lineBalance: json.lineBalance || null,
      source: json.source || null,
      importedAt: localTs(new Date()),
    }));
    // 단품 → 서브어셈블리 순서로 모아 P/N 당 한 행. 같은 P/N이 양쪽에 있으면(FS-7010처럼 축 자체가 어셈블리) L1(분해도 단계·이미지)을 우선하되 단품의 규격은 보존
    const rows = new Map();
    for (const p of parts) {
      if (!p.pn) continue;
      rows.set(String(p.pn), [String(p.pn), p.name || null, p.spec || null, p.level || 'L2', p.parentPn || null, p.parentName || null,
        num(p.qtyPerParent), num(p.qtyPerProduct), p.unit || 'EA', partImageFor(p.pn, p.parentPn)]);
      qtyOf.set(String(p.pn), num(p.qtyPerProduct) ?? num(p.qtyPerParent)); result.parts++;
    }
    for (const s of subs) {
      if (!s.pn) continue;
      const prev = rows.get(String(s.pn));
      if (prev) result.warnings.push(`${s.pn}: 서브어셈블리와 단품 양쪽에 있어 L1로 저장 (규격 '${prev[2] || ''}' 유지)`);
      rows.set(String(s.pn), [String(s.pn), s.name || prev?.[1] || null, prev?.[2] || s.note || null, 'L1', code, name,
        num(s.qty), num(s.qty), s.unit || prev?.[8] || 'EA', partImageFor(s.pn)]);
      qtyOf.set(String(s.pn), num(s.qty)); result.subassemblies++;
    }
    for (const r of rows.values()) queries.upsertPart.run(...r);
    for (const pr of procs) {
      if (!pr.op) { result.warnings.push('op 없는 공정을 건너뜀'); continue; }
      const op = String(pr.op).trim().slice(0, 20);
      queries.upsertProcess.run(code, op, num(pr.seq), pr.line || null, pr.name || null, pr.equipment || null, pr.inputText || null,
        pr.output || null, num(pr.ctSec), pr.kind || null, pr.qc || null, pr.note || null, pr.stagePn || null);
      const row = queries.getProcess.get(code, op);
      queries.deleteProcessInputs.run(row.id);
      for (const pn of (Array.isArray(pr.inputs) ? pr.inputs : [])) {
        if (!qtyOf.has(String(pn))) result.warnings.push(`${op}: 투입 ${pn} 이 parts/subassemblies 에 없음`);
        queries.addProcessInput.run(row.id, String(pn), qtyOf.get(String(pn)) ?? null);
        result.inputs++;
      }
      result.processes++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return result;
}

function productMeta(product) {
  try { return JSON.parse(product?.spec_json || '{}') || {}; } catch { return {}; }
}
// 분해도 단계 목록 + 단계별 공정(op) — stage_pn 기준. final = 완성품 공정(stage_pn null)
function explodedStages(product) {
  const meta = productMeta(product);
  const procs = queries.listProcesses.all(product.code);
  const stages = (meta.exploded || []).slice().sort((a, b) => (a.stage ?? 0) - (b.stage ?? 0)).map(s => ({
    ...s, processes: procs.filter(p => p.stage_pn === s.pn).map(p => p.op),
  }));
  return { stages, final: procs.filter(p => !p.stage_pn).map(p => p.op) };
}
// equipment:detail 의 process 블록 (§7) — op 미연결·BOP 미가져오기면 null → 상태창은 섹션을 감춘다
function processBlock(eq) {
  if (!eq?.op) return null;
  const p = queries.processByOp.get(eq.op);
  if (!p) return null;
  const product = queries.getProduct.get(p.product_code);
  const { stages } = explodedStages(product);
  const st = p.stage_pn ? (stages.find(s => s.pn === p.stage_pn) || { stage: null, pn: p.stage_pn, file: partImageFor(p.stage_pn), label: p.stage_pn, group: null }) : null;
  return {
    product: { code: product.code, name: product.name },
    op: p.op, seq: p.seq, line: p.line, name: p.name, equipmentHint: p.equipment_hint, ctSec: p.ct_sec, kind: p.kind, qc: p.qc, note: p.note,
    output: p.output, inputText: p.input_text,
    inputs: queries.processInputs.all(p.id).map(i => ({
      pn: i.pn, name: i.name, spec: i.spec, qty: i.qty, unit: i.unit, level: i.level, parentPn: i.parent_pn, parentName: i.parent_name, image: i.image,
    })),
    stage: st ? { stage: st.stage, pn: st.pn, file: st.file, label: st.label, group: st.group } : null,
  };
}
function pickProduct(codeParam) {
  const products = queries.listProducts.all();
  if (!products.length) return null;
  const code = codeParam ? String(codeParam) : products[0].code;
  return queries.getProduct.get(code) || null;
}

app.post('/api/admin/bop/import', requireAdmin, (req, res) => {
  let result;
  try { result = importBop(req.body); }
  catch (e) { return res.status(400).json({ error: 'BOP 가져오기 실패: ' + e.message }); }
  io.emit('world:refresh', worldPayload());   // 열려 있는 상태창이 단품을 다시 읽도록
  res.json({ ok: true, ...result });
});

// 공정 목록 + 투입 단품 수 + 설비 연결 현황 (어느 공정에 설비가 없는지)
app.get('/api/admin/bop', requireAdmin, (req, res) => {
  const products = queries.listProducts.all();
  const product = pickProduct(req.query.product);
  if (!product) return res.json({ products, product: null, processes: [], summary: { processes: 0, parts: 0, inputs: 0, linked: 0, unlinked: [] } });
  const processes = queries.listProcesses.all(product.code).map(p => ({
    id: p.id, op: p.op, seq: p.seq, line: p.line, name: p.name, equipmentHint: p.equipment_hint, ctSec: p.ct_sec, kind: p.kind, qc: p.qc,
    note: p.note, output: p.output, stagePn: p.stage_pn, inputCount: p.input_count,
    equipments: queries.equipmentsByOp.all(p.op).map(e => ({ id: e.id, code: e.code, name: e.name, hidden: !!e.hidden })),
  }));
  const unlinked = processes.filter(p => !p.equipments.some(e => !e.hidden)).map(p => p.op);
  const meta = productMeta(product);
  res.json({
    products, product: { code: product.code, name: product.name, spec: meta.spec || {}, lineBalance: meta.lineBalance || null, source: meta.source || null, importedAt: meta.importedAt || null },
    processes,
    summary: {
      processes: processes.length, parts: queries.countParts.get().c, inputs: processes.reduce((s, p) => s + p.inputCount, 0),
      linked: processes.length - unlinked.length, unlinked,
    },
  });
});

// 분해도 모달용 (로그인 사용자): 9단계 + 단계별 공정, 완성품 공정
app.get('/api/bop/exploded', (req, res) => {
  const user = authUser(req.query.token || req.headers['x-auth-token']);
  if (!user) return res.status(401).json({ error: '인증이 필요합니다.' });
  const product = pickProduct(req.query.product);
  if (!product) return res.json({ product: null, stages: [], final: [] });
  const { stages, final } = explodedStages(product);
  res.json({ product: { code: product.code, name: product.name }, stages, final });
});

// 샘플 제품 라인: docs/bldc 의 BOP JSON → 배치 JSON(replace) 순서로 적용. 콘솔 "제품 라인 적용" 버튼과 기동 시 자동 적용(FW_SEED_PRODUCT_LINE)이 공용.
// 지원 라인: bldc (docs/bldc/bldc-500w-48v.json + layout-bldc-500w.json). 라인이 늘면 이 표에 파일 쌍을 추가한다.
const SAMPLE_PRODUCT_LINES = {
  bldc: { bop: 'bldc-500w-48v.json', layout: 'layout-bldc-500w.json' },
};
function sampleLineFiles(line) {
  const def = SAMPLE_PRODUCT_LINES[line];
  if (!def) return null;
  const bopFile = path.join(BLDC_DIR, def.bop), layoutFile = path.join(BLDC_DIR, def.layout);
  const rel = (f) => path.relative(path.join(__dirname, '..'), f);
  return { bopFile, layoutFile, missing: [bopFile, layoutFile].filter(f => !fs.existsSync(f)).map(rel) };
}
function applySampleProductLine(line, who) {
  const files = sampleLineFiles(line);
  const bop = importBop(JSON.parse(fs.readFileSync(files.bopFile, 'utf8')));
  const layout = importLayout(JSON.parse(fs.readFileSync(files.layoutFile, 'utf8')));
  console.log(`[bop] 제품 라인 적용(${who}) — ${bop.product}: 공정 ${bop.processes}·단품 ${bop.parts}·투입 ${bop.inputs} / 설비 +${layout.equipments.created} 수정 ${layout.equipments.updated} 숨김 ${layout.equipments.hidden} / 존 +${layout.zones.created} 숨김 ${layout.zones.hidden} / 라인 +${layout.links.created}`);
  return { bop, layout };
}

app.post('/api/admin/bop/apply-sample', requireAdmin, (req, res) => {
  const files = sampleLineFiles('bldc');
  if (files.missing.length) return res.status(404).json({ error: `샘플 파일이 없습니다: ${files.missing.join(', ')}` });
  let result;
  try { result = applySampleProductLine('bldc', `콘솔 ${req.user.emp_no}`); }
  catch (e) { return res.status(400).json({ error: '제품 라인 적용 실패: ' + e.message }); }
  afterLayoutChange();
  res.json({ ok: true, ...result });
});

// ── 빈 DB 기동 시 제품 라인 자동 적용 (PM 결정 2026-09-09): FW_SEED_PRODUCT_LINE=bldc 이면 products 가 비어 있을 때 1회만 적용 ──
// Render 무료 플랜처럼 재배포마다 DB가 초기화되는 환경에서 데모가 BLDC 라인으로 바로 뜨게 한다.
// 이미 제품이 있는 DB(로컬 개발 DB 등)에는 영향 없음. 적용 이력은 settings.seed_product_line 에 남기고(두 번째 조건), 실패해도 서버는 계속 기동한다.
{
  const seedLine = String(process.env.FW_SEED_PRODUCT_LINE || '').trim().toLowerCase();
  if (seedLine) {
    const already = settings.get('seed_product_line', null);
    if (!SAMPLE_PRODUCT_LINES[seedLine]) {
      console.warn(`[bop] FW_SEED_PRODUCT_LINE='${seedLine}' 은 지원하지 않는 값 — 가능한 값: ${Object.keys(SAMPLE_PRODUCT_LINES).join(', ')}`);
    } else if (queries.listProducts.all().length) {
      console.log(`[bop] FW_SEED_PRODUCT_LINE=${seedLine} — products 에 이미 제품이 있어 자동 적용 건너뜀`);
    } else if (already?.line === seedLine) {
      console.log(`[bop] FW_SEED_PRODUCT_LINE=${seedLine} — 이전에 적용된 이력(${already.appliedAt})이 있어 건너뜀`);
    } else {
      const files = sampleLineFiles(seedLine);
      if (files.missing.length) {
        console.error(`[bop] FW_SEED_PRODUCT_LINE=${seedLine} — 샘플 파일이 없어 자동 적용 실패: ${files.missing.join(', ')}`);
      } else {
        try {
          const r = applySampleProductLine(seedLine, '자동 시드');
          settings.set('seed_product_line', { line: seedLine, appliedAt: localTs(new Date()), processes: r.bop.processes, equipments: r.layout.equipments.created });
        } catch (e) {
          console.error(`[bop] FW_SEED_PRODUCT_LINE=${seedLine} — 자동 적용 실패(서버는 계속 기동):`, e?.message || e);
        }
      }
    }
  }
}

// ── 관리자 API ────────────────────────────────────────
function requireAdmin(req, res, next) {
  const user = authUser(req.headers['x-auth-token']);
  if (!user) return res.status(401).json({ error: '인증이 필요합니다.' });
  if (user.role !== 'admin') return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
  req.user = user;
  next();
}

// 금일 상태별 점유 시간(ms) — 상태 로그 기반
function todayStatusBreakdown(eq) {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const now = Date.now();
  const acc = { RUN: 0, IDLE: 0, STOP: 0, ALARM: 0 };
  const logs = queries.todayLogs.all(eq.id);
  if (logs.length === 0) {
    const since = Math.max(new Date(eq.status_since.replace(' ', 'T')).getTime(), dayStart.getTime());
    if (acc[eq.status] !== undefined) acc[eq.status] += Math.max(0, now - since);
  } else {
    for (let i = 0; i < logs.length; i++) {
      const start = new Date(logs[i].changed_at.replace(' ', 'T')).getTime();
      const end = i + 1 < logs.length ? new Date(logs[i + 1].changed_at.replace(' ', 'T')).getTime() : now;
      if (acc[logs[i].status] !== undefined) acc[logs[i].status] += Math.max(0, end - start);
    }
  }
  return acc;
}

// 금일 알람 대응 시간: ALARM 진입 → 다음 상태 변경까지
function todayAlarmStats() {
  let count = 0, totalMs = 0, ongoing = 0;
  for (const eq of queries.listEquipments.all()) {
    const logs = queries.todayLogs.all(eq.id);
    for (let i = 0; i < logs.length; i++) {
      if (logs[i].status !== 'ALARM') continue;
      count++;
      if (i + 1 < logs.length) {
        totalMs += new Date(logs[i + 1].changed_at.replace(' ', 'T')).getTime()
                 - new Date(logs[i].changed_at.replace(' ', 'T')).getTime();
      } else ongoing++;
    }
  }
  const resolved = count - ongoing;
  return { count, ongoing, avgMinutes: resolved > 0 ? Math.round(totalMs / resolved / 60000) : null };
}

app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const equipments = queries.listEquipments.all().map(eq => ({
    ...eq, breakdown: todayStatusBreakdown(eq),
  }));
  res.json({
    equipments,
    zones: queries.listZones.all(),
    alarmStats: todayAlarmStats(),
    today: queries.countToday.get(),
    online: [...players.values()].map(p => ({ name: p.name, badge: p.badge })),
  });
});

app.get('/api/admin/messages', requireAdmin, (req, res) => {
  const { equipmentId, q, from, to } = req.query;
  const cond = [], params = [];
  if (equipmentId) { cond.push('m.equipment_id = ?'); params.push(Number(equipmentId)); }
  if (q) { cond.push("(m.content LIKE ? OR m.sender_name LIKE ?)"); params.push(`%${q}%`, `%${q}%`); }
  if (from) { cond.push('m.created_at >= ?'); params.push(from + ' 00:00:00'); }
  if (to) { cond.push('m.created_at <= ?'); params.push(to + ' 23:59:59'); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const rows = db.prepare(`
    SELECT m.*, e.name AS equipment_name, e.code AS equipment_code
    FROM messages m LEFT JOIN equipments e ON e.id = m.equipment_id
    ${where} ORDER BY m.id DESC LIMIT 300`).all(...params);
  res.json(rows);
});

app.get('/api/admin/users', requireAdmin, (req, res) => res.json(queries.listUsers.all()));

// 사용자 사전 등록 (관리자): 비밀번호는 대상자의 첫 로그인 때 등록됨
app.post('/api/admin/users', requireAdmin, (req, res) => {
  const { empNo, name, role, team } = req.body || {};
  if (!empNo || !name || !/^[\w가-힣 .-]{1,30}$/.test(name) || !/^[\w-]{1,20}$/.test(empNo)) {
    return res.status(400).json({ error: '사번(영문/숫자/-, 20자)과 이름을 확인해 주세요.' });
  }
  if (!['worker', 'maintainer', 'admin'].includes(role || 'worker')) return res.status(400).json({ error: '잘못된 역할입니다.' });
  if (queries.findUserByEmpNo.get(empNo)) return res.status(400).json({ error: '이미 등록된 사번입니다.' });
  const r = queries.createUserFull.run(String(empNo), String(name), role || 'worker', String(team || '').trim().slice(0, 30) || null);
  res.json({ ok: true, id: r.lastInsertRowid });
});

// 운영 정책 조회/변경
app.get('/api/admin/policy', requireAdmin, (req, res) => res.json({ ...getPolicy(), lastPurge: settings.get('last_purge', null) }));
app.put('/api/admin/policy', requireAdmin, (req, res) => {
  const cur = getPolicy();
  const next = {
    allowSelfRegister: req.body?.allowSelfRegister !== undefined ? !!req.body.allowSelfRegister : cur.allowSelfRegister,
    retentionDays: req.body?.retentionDays !== undefined ? Number(req.body.retentionDays) : cur.retentionDays,
    shiftMinutesPerDay: cur.shiftMinutesPerDay,
  };
  if (!Number.isFinite(next.retentionDays) || next.retentionDays < 0 || next.retentionDays > 3650) {
    return res.status(400).json({ error: '보존 기간은 0~3650 사이의 일수여야 합니다.' });
  }
  if (req.body?.shiftMinutesPerDay !== undefined) {
    const shift = normalizeShiftMinutes(req.body.shiftMinutesPerDay);
    if (shift === undefined) return res.status(400).json({ error: '1일 계획 가동 시간은 1~1440 사이의 정수(분)여야 합니다. 비우면 24시간 기준.' });
    next.shiftMinutesPerDay = shift;
  }
  settings.set('policy', next);
  res.json({ ...getPolicy(), lastPurge: settings.get('last_purge', null) });
});

// 보존 기간 정리 실행: N일 지난 대화·파일 삭제 (백업 이후에만 호출됨). 상태 이력·실적은 보존(가동률·KPI 원천)
function purgeByRetention(trigger) {
  const { retentionDays } = getPolicy();
  if (!retentionDays) return null;
  const mod = `-${retentionDays} days`;
  let removedFiles = 0;
  for (const f of queries.filesBefore.all(mod)) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, f.stored_name)); } catch {}
    removedFiles++;
  }
  db.exec('BEGIN');
  let removedMessages = 0;
  try {
    queries.deleteFilesBefore.run(mod);
    removedMessages = queries.deleteMessagesBefore.run(mod).changes;
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const info = { at: localTs(new Date()), retentionDays, removedMessages, removedFiles, trigger };
  settings.set('last_purge', info);
  console.log(`[retention] ${retentionDays}일 초과 정리: 메시지 ${removedMessages}건, 파일 ${removedFiles}건`);
  return info;
}
app.post('/api/admin/policy/purge', requireAdmin, (req, res) => {
  const last = settings.get('last_backup');
  const today = localTs(new Date()).slice(0, 10);
  if (!last?.ok || !String(last.at).startsWith(today)) {
    return res.status(400).json({ error: '보존 기간 정리는 오늘 백업이 성공한 뒤에만 실행할 수 있습니다. 먼저 [지금 백업]을 실행하세요.' });
  }
  try { res.json(purgeByRetention('manual') || { skipped: true, reason: '보존 기간이 0(무기한)입니다.' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 비밀번호 초기화 (관리자): 해시 제거 → 대상자의 다음 로그인 시 입력한 비밀번호로 재등록
app.post('/api/admin/users/:id/reset-password', requireAdmin, (req, res) => {
  const target = queries.getUser.get(Number(req.params.id));
  if (!target) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  if (target.role === 'system') return res.status(400).json({ error: '시스템 계정입니다.' });
  queries.setPassword.run(null, target.id);
  res.json({ ok: true });
});

// 팀(부서) 지정 (관리자)
app.put('/api/admin/users/:id/team', requireAdmin, (req, res) => {
  const target = queries.getUser.get(Number(req.params.id));
  if (!target) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  queries.setTeam.run(String(req.body?.team || '').trim().slice(0, 30) || null, target.id);
  res.json({ ok: true });
});
app.put('/api/admin/users/:id/role', requireAdmin, (req, res) => {
  const { role } = req.body || {};
  if (!['worker', 'maintainer', 'admin'].includes(role)) return res.status(400).json({ error: '잘못된 역할입니다.' });
  const target = queries.getUser.get(Number(req.params.id));
  if (!target) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  if (target.id === req.user.id) return res.status(400).json({ error: '자신의 역할은 변경할 수 없습니다.' });
  queries.setUserRole.run(role, target.id);
  res.json({ ok: true });
});

// 설비 마스터(콘솔)는 숨긴 설비도 hidden 플래그와 함께 전부 준다(복원 버튼). 맵 에디터는 클라이언트가 hidden 을 걸러 그린다.
// processes: 공정 select 용 요약 (op·이름·라인), hiddenZones: 숨긴 존 복원용
app.get('/api/admin/equipments', requireAdmin, (req, res) => {
  const processes = queries.listProducts.all().flatMap(pr =>
    queries.listProcesses.all(pr.code).map(p => ({ productCode: pr.code, op: p.op, seq: p.seq, line: p.line, name: p.name })));
  res.json({
    equipments: queries.listAllEquipments.all(), zones: queries.listZones.all(),
    hiddenZones: queries.listAllZones.all().filter(z => z.hidden),
    types: EQUIPMENT_TYPES, processes,
  });
});

const normalizeOp = (v) => (v === undefined ? undefined : (String(v || '').trim().slice(0, 20) || null));

app.post('/api/admin/equipments', requireAdmin, (req, res) => {
  const { zoneId, code, name, x, y, manager, type, op } = req.body || {};
  if (!code || !name || !Number.isInteger(x) || !Number.isInteger(y)) return res.status(400).json({ error: '입력값을 확인해 주세요.' });
  if (type !== undefined && type !== '' && !EQUIPMENT_TYPES.includes(type)) {
    return res.status(400).json({ error: `설비 유형은 ${EQUIPMENT_TYPES.join(' / ')} 중 하나여야 합니다.` });
  }
  try {
    const r = queries.createEquipment.run(Number(zoneId), String(code), String(name), x, y, String(manager || ''),
      type || inferEquipmentType(code));
    const opv = normalizeOp(op);
    if (opv) queries.setEquipmentOp.run(opv, r.lastInsertRowid);
    emitWorldRefresh();
    gateway.reload();
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: '설비 코드가 중복이거나 저장에 실패했습니다.' });
  }
});

app.put('/api/admin/equipments/:id', requireAdmin, (req, res) => {
  const eq = queries.getEquipment.get(Number(req.params.id));
  if (!eq) return res.status(404).json({ error: '설비를 찾을 수 없습니다.' });
  const { zoneId, code, name, x, y, manager, dataSource, type, op, hidden } = req.body || {};
  if (type !== undefined && !EQUIPMENT_TYPES.includes(type)) {
    return res.status(400).json({ error: `설비 유형은 ${EQUIPMENT_TYPES.join(' / ')} 중 하나여야 합니다.` });
  }
  // 숨김/복원만 바꾸는 요청 ({ hidden: true|false }) — 복원 시 설비가 속한 존도 함께 보이게
  if (hidden !== undefined) {
    const want = hidden ? 1 : 0;
    if (want !== eq.hidden) {
      queries.setEquipmentHidden.run(want, eq.id);
      if (!want) { const z = queries.getZone.get(eq.zone_id); if (z?.hidden) queries.setZoneHidden.run(0, z.id); }
    }
    if (Object.keys(req.body).every(k => k === 'hidden')) { afterLayoutChange(); return res.json({ ok: true, hidden: !!want }); }
  }
  // 연동 설정 검증 (Phase 2 게이트웨이 규격, server/drivers/common.js 참조)
  let ds = dataSource === undefined ? eq.data_source : null;
  if (dataSource && typeof dataSource === 'object' && dataSource.protocol) {
    if (!['opcua', 'modbus', 'mqtt', 'sim'].includes(dataSource.protocol)) {
      return res.status(400).json({ error: '지원 프로토콜: opcua / modbus / mqtt / sim' });
    }
    const clean = {
      protocol: dataSource.protocol,
      address: String(dataSource.address || '').slice(0, 200),
      tag: String(dataSource.tag || '').slice(0, 100),
      intervalMs: Math.max(200, Number(dataSource.intervalMs) || 1000),
    };
    // 원시값 → 상태 매핑 (선택): {"1":"RUN","2":"IDLE"} — 값은 4개 상태만 허용, 최대 32개
    if (dataSource.statusMap && typeof dataSource.statusMap === 'object') {
      const map = {};
      for (const [k, v] of Object.entries(dataSource.statusMap).slice(0, 32)) {
        const s = String(v).toUpperCase();
        if (STATUS_LABELS[s]) map[String(k).trim().slice(0, 40)] = s;
      }
      if (Object.keys(map).length) clean.statusMap = map;
    }
    if (dataSource.protocol === 'modbus') {
      clean.unitId = Math.max(0, Math.min(255, Math.floor(Number(dataSource.unitId) || 1)));
      clean.regType = ['holding', 'input', 'coil', 'discrete'].includes(dataSource.regType) ? dataSource.regType : 'holding';
    }
    if (dataSource.protocol === 'opcua' && dataSource.valueTag) {
      clean.valueTag = String(dataSource.valueTag).slice(0, 100);
    }
    ds = JSON.stringify(clean);
  }
  try {
    queries.updateEquipment.run(
      Number(zoneId ?? eq.zone_id), String(code ?? eq.code), String(name ?? eq.name),
      Number.isInteger(x) ? x : eq.x, Number.isInteger(y) ? y : eq.y, String(manager ?? eq.manager ?? ''), ds,
      type ?? eq.type ?? 'generic', eq.id);
    const opv = normalizeOp(op);
    if (opv !== undefined && opv !== eq.op) queries.setEquipmentOp.run(opv, eq.id);   // 공정 연결 변경 (null = 해제)
    if (hidden !== undefined) afterLayoutChange(); else { emitWorldRefresh(); gateway.reload(); }
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: '저장에 실패했습니다 (코드 중복 여부 확인).' });
  }
});

// ── 공정 라인 관리 (맵 에디터) ──
app.get('/api/admin/links', requireAdmin, (req, res) => {
  syncLinkStates();
  const states = new Map(linkStatesPayload().map(s => [s.id, s]));
  res.json(queries.listLinks.all().map(l => ({
    id: l.id, fromId: l.from_id, toId: l.to_id,
    fromName: l.from_name, fromCode: l.from_code,
    toName: l.to_name, toCode: l.to_code,
    level: states.get(l.id)?.level ?? 0, flowing: states.get(l.id)?.flowing ?? false,
  })));
});

app.post('/api/admin/links', requireAdmin, (req, res) => {
  const fromId = Number(req.body?.fromId), toId = Number(req.body?.toId);
  if (!queries.getEquipment.get(fromId) || !queries.getEquipment.get(toId)) {
    return res.status(400).json({ error: '설비를 찾을 수 없습니다.' });
  }
  if (fromId === toId) return res.status(400).json({ error: '같은 설비끼리는 연결할 수 없습니다.' });
  try {
    queries.createLink.run(fromId, toId);
  } catch {
    return res.status(400).json({ error: '이미 연결된 라인입니다.' });
  }
  syncLinkStates();
  io.emit('links:changed', { links: linksPayload(), states: linkStatesPayload() });
  res.json({ ok: true });
});

app.delete('/api/admin/links/:id', requireAdmin, (req, res) => {
  if (!queries.getLink.get(Number(req.params.id))) return res.status(404).json({ error: '라인을 찾을 수 없습니다.' });
  queries.deleteLink.run(Number(req.params.id));
  syncLinkStates();
  io.emit('links:changed', { links: linksPayload(), states: linkStatesPayload() });
  res.json({ ok: true });
});

// ── 작업지시 관리 (FR-12, 관리자 콘솔) ──
app.get('/api/admin/workorders', requireAdmin, (req, res) => {
  res.json(queries.allWorkOrders.all().map(r => ({ ...shapeQuest(r), createdByName: r.created_by_name })));
});

app.post('/api/admin/workorders', requireAdmin, (req, res) => {
  const { equipmentId, title, description, targetQty, dueDate } = req.body || {};
  const eq = queries.getEquipment.get(Number(equipmentId));
  if (!eq || !title || !String(title).trim()) return res.status(400).json({ error: '설비와 제목을 확인해 주세요.' });
  const r = queries.createWorkOrder.run(
    eq.id, String(title).trim().slice(0, 100), String(description || '').slice(0, 500),
    Math.max(0, Math.floor(Number(targetQty) || 0)), dueDate || null, req.user.id);
  const wo = queries.getWorkOrder.get(r.lastInsertRowid);
  const quest = shapeQuest({ ...wo, equipment_name: eq.name, equipment_code: eq.code });
  io.emit('quest:new', quest);
  res.json({ ok: true, id: wo.id });
});

app.put('/api/admin/workorders/:id/cancel', requireAdmin, (req, res) => {
  const r = queries.cancelWorkOrder.run(Number(req.params.id));
  if (r.changes === 0) return res.status(400).json({ error: '취소할 수 없는 상태입니다.' });
  io.emit('quest:update', {});
  res.json({ ok: true });
});

// ── 알람 대응 리포트 (기대효과 '대응 시간 단축' 지표화) ──
function localTs(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

app.get('/api/admin/alarm-report', requireAdmin, (req, res) => {
  const { from, to, equipmentId } = req.query;
  const defFrom = new Date(); defFrom.setDate(defFrom.getDate() - 7); defFrom.setHours(0, 0, 0, 0);
  const fromTs = from ? `${from} 00:00:00` : localTs(defFrom);
  const toTs = to ? `${to} 23:59:59` : '9999-12-31 23:59:59';
  const nowTs = localTs(new Date());

  const eqs = equipmentId
    ? [queries.getEquipment.get(Number(equipmentId))].filter(Boolean)
    : queries.listEquipments.all();

  const msgStats = db.prepare(`
    SELECT COUNT(*) AS c, COUNT(DISTINCT sender_id) AS p FROM messages
    WHERE channel = ? AND type != 'system' AND created_at BETWEEN ? AND ?`);
  const fileStats = db.prepare(
    'SELECT COUNT(*) AS c FROM files WHERE equipment_id = ? AND created_at BETWEEN ? AND ?');

  const episodes = [];
  for (const eq of eqs) {
    const logs = db.prepare(`
      SELECT l.*, u.name AS changed_by_name FROM equipment_status_log l
      LEFT JOIN users u ON u.id = l.changed_by
      WHERE l.equipment_id = ? ORDER BY l.id`).all(eq.id);
    for (let i = 0; i < logs.length; i++) {
      if (logs[i].status !== 'ALARM') continue;
      const start = logs[i].changed_at;
      if (start < fromTs || start > toTs) continue;
      const next = logs[i + 1] || null;
      const end = next ? next.changed_at : null;
      const durationSec = Math.max(0, Math.round(
        (new Date((end || nowTs).replace(' ', 'T')) - new Date(start.replace(' ', 'T'))) / 1000));
      const m = msgStats.get(`eq:${eq.id}`, start, end || nowTs);
      const f = fileStats.get(eq.id, start, end || nowTs);
      episodes.push({
        equipmentId: eq.id, equipment: eq.name, code: eq.code,
        start, end, durationSec, ongoing: !next,
        alarmedBy: logs[i].changed_by_name, reason: logs[i].reason,
        resolvedBy: next?.changed_by_name || null, resolvedStatus: next?.status || null,
        messages: m.c, participants: m.p, files: f.c,
      });
    }
  }
  episodes.sort((a, b) => b.start.localeCompare(a.start));

  const resolved = episodes.filter(e => !e.ongoing);
  res.json({
    episodes: episodes.slice(0, 200),
    summary: {
      count: episodes.length,
      ongoing: episodes.length - resolved.length,
      avgSec: resolved.length ? Math.round(resolved.reduce((s, e) => s + e.durationSec, 0) / resolved.length) : null,
      maxSec: resolved.length ? Math.max(...resolved.map(e => e.durationSec)) : null,
      withCollab: episodes.filter(e => e.messages > 0 || e.files > 0).length,
    },
  });
});

// ── 존(맵) 관리 — 맵 에디터용 ──
app.post('/api/admin/zones', requireAdmin, (req, res) => {
  const { name, color } = req.body || {};
  if (!name) return res.status(400).json({ error: '존 이름을 입력해 주세요.' });
  const r = queries.createZone.run(String(name), String(color || '#2d4a6b'), 0, 0, 4, 3);
  emitWorldRefresh();
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.put('/api/admin/zones/:id', requireAdmin, (req, res) => {
  const zone = queries.getZone.get(Number(req.params.id));
  if (!zone) return res.status(404).json({ error: '존을 찾을 수 없습니다.' });
  const { name, color, rectX, rectY, rectW, rectH, hidden } = req.body || {};
  const clamp = (v, min, max, def) => Number.isInteger(v) ? Math.max(min, Math.min(max, v)) : def;
  queries.updateZone.run(
    String(name ?? zone.name), String(color ?? zone.color),
    clamp(rectX, 0, 23, zone.rect_x), clamp(rectY, 0, 15, zone.rect_y),
    clamp(rectW, 1, 24, zone.rect_w), clamp(rectH, 1, 16, zone.rect_h), zone.id);
  if (hidden !== undefined) queries.setZoneHidden.run(hidden ? 1 : 0, zone.id);   // 라인 전환으로 숨긴 존 복원/숨김
  emitWorldRefresh();
  res.json({ ok: true });
});

app.delete('/api/admin/zones/:id', requireAdmin, (req, res) => {
  const zone = queries.getZone.get(Number(req.params.id));
  if (!zone) return res.status(404).json({ error: '존을 찾을 수 없습니다.' });
  if (queries.countEqInZone.get(zone.id).c > 0) {
    return res.status(400).json({ error: '설비가 배치된 존은 삭제할 수 없습니다. 설비를 먼저 이동해 주세요.' });
  }
  queries.deleteZone.run(zone.id);
  emitWorldRefresh();
  res.json({ ok: true });
});

// ── 공정 라인 부하 (심시티식 흐름/정체 모델) ───────────
// 상류 설비 가동 → 라인에 재공 유입(+), 하류 설비 가동 → 배출(−).
// 하류가 정지/알람이면 재공이 쌓여 부하가 오르고, 90% 초과 시 '라인 정체' 알림.
const LINK_TICK_MS = 2000;
const LINK_INFLOW = 4;   // 틱당 유입 (%p)
const LINK_OUTFLOW = 6;  // 틱당 배출 (%p) — 정상 흐름이면 서서히 비워짐 (정체 해소 속도)
const linkStates = new Map(); // linkId -> { level: 0~100, flowing: bool, congested: bool }

function linksPayload() {
  return queries.listLinks.all().map(l => ({
    id: l.id, fromId: l.from_id, toId: l.to_id,
    fromName: l.from_name, toName: l.to_name,
  }));
}

function linkStatesPayload() {
  return [...linkStates.entries()].map(([id, s]) => ({
    id, level: Math.round(s.level), flowing: s.flowing,
  }));
}

// DB에 저장된 부하(load)로 초기화 — 재시작 후에도 정체 상태가 이어지고, 90% 이상이면 재알림하지 않음
function newLinkState(load) {
  const level = Math.max(0, Math.min(100, Number(load) || 0));
  return { level, flowing: false, congested: level >= 90 };
}

function syncLinkStates() {
  const links = queries.listLinks.all();
  const ids = new Set(links.map(l => l.id));
  for (const l of links) if (!linkStates.has(l.id)) linkStates.set(l.id, newLinkState(l.load));
  for (const id of [...linkStates.keys()]) if (!ids.has(id)) linkStates.delete(id);
}

function tickLinks() {
  const links = queries.listLinks.all();
  if (links.length === 0) return;
  for (const l of links) {
    let s = linkStates.get(l.id);
    if (!s) { s = newLinkState(l.load); linkStates.set(l.id, s); }
    const up = queries.getEquipment.get(l.from_id);
    const down = queries.getEquipment.get(l.to_id);
    const inflow = up?.status === 'RUN' ? LINK_INFLOW * (0.8 + Math.random() * 0.4) : 0;
    const outflow = down?.status === 'RUN' ? LINK_OUTFLOW * (0.8 + Math.random() * 0.4) : 0;
    const prev = s.level;
    s.level = Math.max(0, Math.min(100, s.level + inflow - outflow));
    s.flowing = inflow > 0;
    if (s.level !== prev) queries.setLinkLoad.run(s.level, l.id);
    // 90% 상향 돌파 시 정체 알림 (재돌파 방지 플래그)
    if (s.level >= 90 && !s.congested) {
      s.congested = true;
      io.emit('link:congested', { id: l.id, fromName: l.from_name, toName: l.to_name });
    } else if (s.level < 70 && s.congested) {
      s.congested = false;
    }
  }
  io.volatile.emit('link:load', linkStatesPayload());
}
setInterval(tickLinks, LINK_TICK_MS);

// ── Phase 3: 포인트 · 레벨 · 뱃지 (FR-13) ─────────────
const BADGES = {
  'first-quest': { icon: '🎖', name: '첫 임무 완수', desc: '작업지시 1건 완료' },
  'quest-5': { icon: '🏅', name: '임무 베테랑', desc: '작업지시 5건 완료' },
  'alarm-hero': { icon: '🚨', name: '알람 해결사', desc: '알람 해제 3회' },
  'perfect-3': { icon: '💎', name: '무결점', desc: '불량 0 실적 3회' },
};

function levelOf(points) { return Math.floor(Math.sqrt(points / 100)) + 1; }

function statsOf(userId) {
  const points = queries.userPoints.get(userId).p;
  return {
    points, level: levelOf(points),
    nextLevelAt: Math.pow(levelOf(points), 2) * 100,
    badges: queries.userBadges.all(userId).map(b => ({ key: b.badge_key, ...BADGES[b.badge_key] })),
  };
}

function emitToUser(userId, event, data) {
  for (const [sid, p] of players) if (p.userId === userId) io.to(sid).emit(event, data);
}

function awardPoints(user, pts, kind, label) {
  queries.addPoints.run(user.id, pts, kind, label);
  const total = queries.userPoints.get(user.id).p;
  const level = levelOf(total);
  emitToUser(user.id, 'points:awarded', {
    points: pts, total, level, levelUp: level > levelOf(total - pts), reason: label,
  });
  checkBadges(user);
}

function checkBadges(user) {
  const done = queries.questDoneCount.get(user.id).c;
  const alarms = queries.alarmResolveCount.get(user.id).c;
  const perfect = queries.perfectCount.get(user.id).c;
  const earned = [];
  if (done >= 1) earned.push('first-quest');
  if (done >= 5) earned.push('quest-5');
  if (alarms >= 3) earned.push('alarm-hero');
  if (perfect >= 3) earned.push('perfect-3');
  for (const key of earned) {
    if (queries.addBadge.run(user.id, key).changes > 0) {
      emitToUser(user.id, 'badge:earned', { key, ...BADGES[key] });
    }
  }
}

function questChannelMessage(eq, actor, text) {
  const msgId = queries.saveMessage.run(`eq:${eq.id}`, eq.id, actor.id, actor.name, 'system', text).lastInsertRowid;
  io.to(roomOf(`eq:${eq.id}`)).emit('chat:message', shapeMessage(queries.getMessage.get(msgId)));
}

function shapeQuest(row) {
  return {
    id: row.id, equipmentId: row.equipment_id,
    equipmentName: row.equipment_name, equipmentCode: row.equipment_code,
    title: row.title, description: row.description,
    targetQty: row.target_qty, dueDate: row.due_date, status: row.status,
    assigneeId: row.assignee_id, assigneeName: row.assignee_name || null,
    createdAt: row.created_at, completedAt: row.completed_at,
    qtyGood: row.qty_good ?? null, qtyDefect: row.qty_defect ?? null,
  };
}

// ── 상태 변경 공통 처리 (수동/게이트웨이 동일 규격 — 설계서 5.3) ──
const STATUS_LABELS = { RUN: '가동', IDLE: '대기', STOP: '정지', ALARM: '알람' };

function applyStatusChange(equipmentId, status, reason, actor, source = 'manual') {
  const eq = queries.getEquipment.get(Number(equipmentId));
  if (!eq || !STATUS_LABELS[status]) return null;
  if (eq.status === status) return eq; // 동일 상태 재설정은 무시
  const prevStatus = eq.status;
  queries.setEquipmentStatus.run(status, eq.id);
  queries.logStatus.run(eq.id, status, String(reason || '').slice(0, 200), actor?.id ?? null);
  const updated = queries.getEquipment.get(eq.id);
  io.emit('equipment:status', { equipment: updated, changedBy: actor?.name || '시스템', source });

  // 설비 채널 시스템 메시지: 수동은 항상, 자동 수집은 알람 발생/해제 시에만 (메시지 홍수 방지)
  const shouldLog = source === 'manual' || status === 'ALARM' || prevStatus === 'ALARM';
  if (shouldLog && actor) {
    const text = `[상태 변경] ${STATUS_LABELS[status]}${reason ? ` — ${reason}` : ''} (${actor.name})`;
    const msgId = queries.saveMessage.run(`eq:${eq.id}`, eq.id, actor.id, actor.name, 'system', text).lastInsertRowid;
    io.to(roomOf(`eq:${eq.id}`)).emit('chat:message', shapeMessage(queries.getMessage.get(msgId)));
  }
  // 알람을 수동으로 해제한 담당자에게 포인트 (FR-13)
  if (source === 'manual' && prevStatus === 'ALARM' && status !== 'ALARM' && actor && actor.role !== 'system') {
    awardPoints(actor, 50, 'alarm', `알람 해제 — ${eq.name}`);
  }
  return updated;
}

// ── 가상 PLC 게이트웨이 (Phase 2 데모) ────────────────
const gatewayUser = db.prepare("SELECT * FROM users WHERE emp_no = 'gateway'").get();
const gateway = createGateway({
  onStatus: (eqId, status, reason) => applyStatusChange(eqId, status, reason, gatewayUser, 'gateway'),
});

app.get('/api/admin/gateway', requireAdmin, (req, res) => res.json(gateway.status()));
app.post('/api/admin/gateway/start', requireAdmin, async (req, res) => {
  await gateway.start();
  settings.set('gateway_running', true);   // 재시작 후 자동 재개
  io.emit('gateway:state', { running: true });
  res.json(gateway.status());
});
app.post('/api/admin/gateway/stop', requireAdmin, (req, res) => {
  gateway.stop();
  settings.set('gateway_running', false);
  io.emit('gateway:state', { running: false });
  res.json(gateway.status());
});
// 서버 재시작 시 게이트웨이 자동 재개 (운영: 관리자가 매번 켜지 않아도 됨)
if (settings.get('gateway_running', false)) {
  gateway.start();
  console.log('[gateway] 이전 가동 상태를 복원하여 자동 시작');
}

// ── 백업 (NFR-04: 일 단위 자동 백업 + 관리자 수동 실행) ──
const BACKUP_HOUR = Math.min(23, Math.max(0, Number(process.env.FW_BACKUP_HOUR ?? 3)));
const BACKUP_ROOT = defaultBackupRoot();

function doBackup(trigger) {
  try {
    const r = runBackup({ destRoot: BACKUP_ROOT, log: (m) => console.log('[backup]', m) });
    const info = { at: localTs(new Date()), dir: r.dir, uploads: r.uploads, trigger, ok: true };
    settings.set('last_backup', info);
    return info;
  } catch (e) {
    const info = { at: localTs(new Date()), error: String(e.message || e), trigger, ok: false };
    settings.set('last_backup', info);
    console.error('[backup] 실패:', e);
    return info;
  }
}

// 매 분 확인: 지정 시각(기본 03시)이 되었고 오늘 아직 자동 백업이 없으면 실행
setInterval(() => {
  const now = new Date();
  if (now.getHours() !== BACKUP_HOUR) return;
  const last = settings.get('last_backup');
  const today = localTs(now).slice(0, 10);
  if (last?.ok && last.trigger === 'auto' && String(last.at).startsWith(today)) return;
  const info = doBackup('auto');
  // 백업이 성공했을 때만 보존 기간 정리 (삭제 전 사본 보장)
  if (info.ok) { try { purgeByRetention('auto'); } catch (e) { console.error('[retention] 실패:', e); } }
}, 60 * 1000);

app.get('/api/admin/backup', requireAdmin, (req, res) => {
  res.json({
    root: BACKUP_ROOT, hour: BACKUP_HOUR,
    last: settings.get('last_backup'),
    backups: listBackups(BACKUP_ROOT).slice(0, 14).map(b => b.name),
  });
});
app.post('/api/admin/backup', requireAdmin, (req, res) => {
  const info = doBackup('manual');
  res.status(info.ok ? 200 : 500).json(info);
});

// ── 실적 분석 API (서지안, 인터페이스 §4) — server/analytics.js 가 있으면 라우트 등록, 없으면 건너뜀 ──
// 시그니처: export function registerAnalytics(app, { requireAdmin, db, queries, settings })
try {
  const mod = await import('./analytics.js');
  if (typeof mod.registerAnalytics === 'function') {
    mod.registerAnalytics(app, { requireAdmin, db, queries, settings });
    console.log('[analytics] server/analytics.js 로드 — /api/admin/analytics/* 등록');
  } else {
    console.warn('[analytics] server/analytics.js 에 registerAnalytics export가 없어 건너뜀');
  }
} catch (e) {
  if (e?.code === 'ERR_MODULE_NOT_FOUND' && /analytics\.js/.test(String(e.message))) {
    console.log('[analytics] server/analytics.js 없음 — 분석 API 미등록 (라운드 2에서 추가 예정)');
  } else {
    console.error('[analytics] server/analytics.js 로드 실패 — 분석 API 미등록:', e?.message || e);
  }
}

// ── 게임 상태 (메모리) ────────────────────────────────
const players = new Map(); // socketId -> {userId, name, empNo, color, badge, x, y, moving}
const CHAT_RADIUS = 2.4;   // 타일 단위 근접 반경

const equipmentsCache = () => queries.listEquipments.all();

function roomOf(channel) { return `ch:${channel}`; }

function shapeMessage(row) {
  return {
    id: row.id, channel: row.channel, equipmentId: row.equipment_id,
    senderId: row.sender_id, senderName: row.sender_name,
    type: row.type, content: row.type === 'file' ? JSON.parse(row.content) : row.content,
    createdAt: row.created_at,
  };
}

// 금일 가동률(%) — 상태 로그 기반 근사치
function todayUptime(eq) {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const now = Date.now();
  const logs = db.prepare(
    "SELECT status, changed_at FROM equipment_status_log WHERE equipment_id = ? AND changed_at >= datetime(?, 'localtime') ORDER BY id"
  ).all(eq.id, dayStart.toISOString().slice(0, 19).replace('T', ' '));

  let runMs = 0, totalMs = 0;
  if (logs.length === 0) {
    const since = Math.max(new Date(eq.status_since).getTime(), dayStart.getTime());
    totalMs = now - since;
    if (eq.status === 'RUN') runMs = totalMs;
  } else {
    let cursor = new Date(logs[0].changed_at).getTime();
    for (let i = 0; i < logs.length; i++) {
      const end = i + 1 < logs.length ? new Date(logs[i + 1].changed_at).getTime() : now;
      const dur = Math.max(0, end - cursor);
      if (logs[i].status === 'RUN') runMs += dur;
      totalMs += dur;
      cursor = end;
    }
  }
  return totalMs > 0 ? Math.round((runMs / totalMs) * 100) : null;
}

// 근접 판정: 서버가 설비별 반경 내 인원 계산 (기록 신뢰성 확보 — 설계서 5.3)
function updateProximity(socket) {
  const p = players.get(socket.id);
  if (!p) return;
  const near = new Set();
  for (const eq of equipmentsCache()) {
    const dx = p.x - eq.x, dy = p.y - eq.y;
    if (dx * dx + dy * dy <= CHAT_RADIUS * CHAT_RADIUS) near.add(eq.id);
  }
  const auto = socket.data.autoChannels;
  // 반경 진입 → 자동 입장
  for (const eqId of near) {
    if (!auto.has(eqId) && !socket.data.manualChannels.has(eqId)) {
      auto.add(eqId);
      joinChannel(socket, eqId, true);
    }
  }
  // 반경 이탈 → 자동 퇴장 (수동 입장자는 유지)
  for (const eqId of [...auto]) {
    if (!near.has(eqId)) {
      auto.delete(eqId);
      leaveChannel(socket, eqId);
    }
  }
}

function channelMembers(eqId) {
  const room = io.sockets.adapter.rooms.get(roomOf(`eq:${eqId}`));
  if (!room) return [];
  return [...room].map(sid => players.get(sid)).filter(Boolean).map(p => ({ userId: p.userId, name: p.name }));
}

function joinChannel(socket, eqId, auto) {
  const channel = `eq:${eqId}`;
  const before = channelMembers(eqId).length;
  socket.join(roomOf(channel));
  const eq = queries.getEquipment.get(eqId);
  const members = channelMembers(eqId);
  socket.emit('channel:enter', { equipmentId: eqId, equipmentName: eq?.name, auto, members });
  io.to(roomOf(channel)).emit('channel:members', { equipmentId: eqId, members });
  // 2인 이상 모이는 순간 → 방 전체에 대화 활성화 알림 (설계서 FR-06)
  if (before < 2 && members.length >= 2) {
    io.to(roomOf(channel)).emit('channel:active', { equipmentId: eqId, equipmentName: eq?.name, members });
  }
}

function leaveChannel(socket, eqId) {
  const channel = `eq:${eqId}`;
  socket.leave(roomOf(channel));
  socket.emit('channel:exit', { equipmentId: eqId });
  io.to(roomOf(channel)).emit('channel:members', { equipmentId: eqId, members: channelMembers(eqId) });
}

// ── Socket.IO ─────────────────────────────────────────
io.use((socket, next) => {
  const user = authUser(socket.handshake.auth?.token);
  if (!user) return next(new Error('unauthorized'));
  socket.data.user = user;
  next();
});

io.on('connection', (socket) => {
  const user = socket.data.user;
  socket.data.autoChannels = new Set();
  socket.data.manualChannels = new Set();

  const spawn = { x: 12 + (Math.random() * 2 - 1), y: 7.5 + (Math.random() * 2 - 1) };
  const stats = statsOf(user.id);
  const p = {
    socketId: socket.id, userId: user.id, name: user.name, empNo: user.emp_no,
    color: socket.handshake.auth.color || '#4fc3f7',
    badge: socket.handshake.auth.badge || '작업자',
    level: stats.level,
    x: spawn.x, y: spawn.y, moving: false,
  };
  players.set(socket.id, p);
  socket.join(roomOf('all'));

  // 초기 데이터 일괄 전송
  socket.emit('init', {
    me: { socketId: socket.id, userId: user.id, name: user.name, badge: p.badge, color: p.color, x: p.x, y: p.y, level: stats.level },
    players: [...players.values()].filter(o => o.socketId !== socket.id),
    zones: queries.listZones.all(),
    equipments: equipmentsCache(),
    links: linksPayload(),
    linkStates: (syncLinkStates(), linkStatesPayload()),
    floorplan: settings.get('floorplan', null),
    chatRadius: CHAT_RADIUS,
    stats,
    // 출근 브리핑 (설계서 6.1: 입장 시 금일 공지·미확인 알림 요약)
    briefing: {
      alarms: queries.alarmEquipments.all(),
      openQuests: queries.countOpenQuests.get().c,
      myQuests: queries.countMyQuests.get(user.id).c,
      notices: queries.recentNotices.all().reverse(),
    },
  });
  socket.broadcast.emit('player:joined', p);

  socket.on('player:move', (data) => {
    const me = players.get(socket.id);
    if (!me || typeof data?.x !== 'number' || typeof data?.y !== 'number') return;
    me.x = Math.max(0, Math.min(24, data.x));
    me.y = Math.max(0, Math.min(16, data.y));
    me.moving = !!data.moving;
    me.dir = ['down', 'up', 'left', 'right'].includes(data.dir) ? data.dir : (me.dir || 'down');
    socket.broadcast.volatile.emit('player:moved', { socketId: socket.id, x: me.x, y: me.y, moving: me.moving, dir: me.dir });
    updateProximity(socket);
  });

  // 설비 상태 수동 변경 (1단계 — 2단계에서 게이트웨이가 동일 이벤트 발행)
  socket.on('equipment:setStatus', ({ equipmentId, status, reason }, cb) => {
    if (!CAN_SET_STATUS.includes(user.role)) {
      return cb?.({ error: '상태 변경 권한이 없습니다 (보전/관리자 전용).' });
    }
    const updated = applyStatusChange(equipmentId, status, reason, user, 'manual');
    cb?.(updated ? { ok: true } : { error: '잘못된 요청입니다.' });
  });

  socket.on('equipment:detail', ({ equipmentId }, cb) => {
    const eq = queries.getEquipment.get(Number(equipmentId));
    if (!eq) return cb?.({ error: 'not found' });
    const prod = queries.eqTodayProduction.get(eq.id);
    const tgt = queries.eqTargetQty.get(eq.id);
    cb?.({
      equipment: eq,
      uptime: todayUptime(eq),
      // 설계서 6.3 게이지: 금일 가동률(HP바) + 목표 대비 진행률(경험치바)
      production: { good: prod.good, defect: prod.defect, target: tgt.target, orders: tgt.orders },
      managerOnline: [...players.values()].some(p => eq.manager && p.name === eq.manager),
      recentLog: queries.recentStatusLog.all(eq.id),
      files: queries.filesByEquipment.all(eq.id),
      members: channelMembers(eq.id),
      // 스프린트 2 (§7): 연결된 공정·투입 단품·분해도 단계. op 미연결이면 null → 상태창은 섹션을 감춘다
      process: processBlock(eq),
    });
  });

  // 담당자 호출 (설계서 6.3 액션): 설비 담당자 이름과 같은 접속자에게 알림 + 설비 채널 기록
  socket.on('equipment:call', ({ equipmentId, note }, cb) => {
    const eq = queries.getEquipment.get(Number(equipmentId));
    if (!eq) return cb?.({ error: '설비를 찾을 수 없습니다.' });
    if (!eq.manager) return cb?.({ error: '이 설비에는 담당자가 지정되어 있지 않습니다.' });
    const targets = [...players.values()].filter(p => p.name === eq.manager && p.socketId !== socket.id);
    const text = `[호출] ${user.name} → 담당자 ${eq.manager}${note ? ` — ${String(note).slice(0, 100)}` : ''}`;
    const msgId = queries.saveMessage.run(`eq:${eq.id}`, eq.id, user.id, user.name, 'system', text).lastInsertRowid;
    io.to(roomOf(`eq:${eq.id}`)).emit('chat:message', shapeMessage(queries.getMessage.get(msgId)));
    for (const t of targets) {
      io.to(t.socketId).emit('call:incoming', {
        equipmentId: eq.id, equipmentName: eq.name, from: user.name, note: String(note || '').slice(0, 100),
      });
    }
    cb?.({ ok: true, notified: targets.length, manager: eq.manager });
  });

  // 대화방 수동 입장/퇴장 (원격 협업 — 설계서 6.4)
  socket.on('channel:join', ({ equipmentId }) => {
    const eqId = Number(equipmentId);
    if (!queries.getEquipment.get(eqId)) return;
    socket.data.manualChannels.add(eqId);
    if (!socket.data.autoChannels.has(eqId)) joinChannel(socket, eqId, false);
  });
  socket.on('channel:leave', ({ equipmentId }) => {
    const eqId = Number(equipmentId);
    socket.data.manualChannels.delete(eqId);
    if (!socket.data.autoChannels.has(eqId)) leaveChannel(socket, eqId);
    else socket.data.autoChannels.delete(eqId), leaveChannel(socket, eqId);
  });

  socket.on('chat:history', ({ channel }, cb) => {
    if (typeof channel !== 'string' || !/^(all|eq:\d+)$/.test(channel)) return cb?.([]);
    cb?.(queries.recentMessages.all(channel).reverse().map(shapeMessage));
  });

  // 저장 우선 → 브로드캐스트 (설계서 5.3)
  socket.on('chat:send', ({ channel, text }, cb) => {
    if (typeof channel !== 'string' || !/^(all|eq:\d+)$/.test(channel)) return cb?.({ error: '잘못된 채널' });
    const body = String(text || '').trim().slice(0, 2000);
    if (!body) return cb?.({ error: '내용이 없습니다.' });
    const m = channel.match(/^eq:(\d+)$/);
    const equipmentId = m ? Number(m[1]) : null;
    const msgId = queries.saveMessage.run(channel, equipmentId, user.id, user.name, 'text', body).lastInsertRowid;
    io.to(roomOf(channel)).emit('chat:message', shapeMessage(queries.getMessage.get(msgId)));
    cb?.({ ok: true });
  });

  // ── Phase 3: 퀘스트 (FR-12) · 리더보드 (FR-13) ──
  socket.on('quest:list', (cb) => {
    cb?.({
      active: queries.activeWorkOrders.all().map(shapeQuest),
      myDone: queries.myRecentDone.all(user.id).map(shapeQuest),
      stats: statsOf(user.id),
    });
  });

  socket.on('quest:accept', ({ id }, cb) => {
    const r = queries.acceptWorkOrder.run(user.id, Number(id));
    if (r.changes === 0) return cb?.({ error: '이미 수락되었거나 진행할 수 없는 작업지시입니다.' });
    const wo = queries.getWorkOrder.get(Number(id));
    const eq = queries.getEquipment.get(wo.equipment_id);
    questChannelMessage(eq, user, `[작업지시] '${wo.title}' 수락 (${user.name})`);
    io.emit('quest:update', {});
    cb?.({ ok: true });
  });

  socket.on('quest:complete', ({ id, qtyGood, qtyDefect, note }, cb) => {
    const g = Math.max(0, Math.floor(Number(qtyGood) || 0));
    const d = Math.max(0, Math.floor(Number(qtyDefect) || 0));
    if (g + d === 0) return cb?.({ error: '양품/불량 수량을 입력해 주세요.' });
    const r = queries.completeWorkOrder.run(Number(id), user.id);
    if (r.changes === 0) return cb?.({ error: '본인이 수락한 진행 중 작업지시만 완료할 수 있습니다.' });
    const wo = queries.getWorkOrder.get(Number(id));
    queries.addRecord.run(wo.id, wo.equipment_id, user.id, g, d, String(note || '').slice(0, 200));
    const eq = queries.getEquipment.get(wo.equipment_id);
    questChannelMessage(eq, user, `[작업지시] '${wo.title}' 완료 — 양품 ${g} · 불량 ${d} (${user.name})`);
    let pts = 100, label = `작업지시 완료 — ${wo.title}`;
    if (d === 0) { pts += 20; label += ' (무결점 보너스)'; }
    awardPoints(user, pts, 'quest', label);
    io.emit('quest:update', {});
    cb?.({ ok: true, points: pts });
  });

  socket.on('leaderboard:get', (cb) => {
    cb?.({
      top: queries.leaderboard.all().map(row => ({ ...row, level: levelOf(row.points) })),
      teams: queries.teamLeaderboard.all(),
      me: { ...statsOf(user.id), name: user.name, userId: user.id, team: user.team || null },
    });
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
    for (const eqId of new Set([...socket.data.autoChannels, ...socket.data.manualChannels])) {
      io.to(roomOf(`eq:${eqId}`)).emit('channel:members', { equipmentId: eqId, members: channelMembers(eqId) });
    }
    io.emit('player:left', { socketId: socket.id });
  });
});

server.listen(PORT, () => {
  console.log(`[Factory World] ${TLS ? 'https' : 'http'}://localhost:${PORT}  (data: ${DATA_DIR}, backup: ${BACKUP_ROOT} @ ${String(BACKUP_HOUR).padStart(2, '0')}:00)`);
});

// ── 종료 처리: 게이트웨이·소켓·DB를 정리하고 종료 (start.cmd가 비정상 종료 시 재기동) ──
let shuttingDown = false;
function shutdown(signal, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Factory World] ${signal} — 종료 중`);
  try { gateway.stop(); } catch {}
  io.close();
  server.close(() => {
    try { db.close(); } catch {}
    process.exit(code);
  });
  setTimeout(() => process.exit(code), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => { console.error('[Factory World] 처리되지 않은 예외:', e); shutdown('uncaughtException', 1); });
process.on('unhandledRejection', (e) => { console.error('[Factory World] 처리되지 않은 거부:', e); });
