/* 프로토콜 드라이버 공통 규약 (Phase 2 게이트웨이)
 *
 * 드라이버 모듈은 다음을 export 한다:
 *   export const protocol = 'mqtt' | 'opcua' | 'modbus' | 'sim';
 *   export async function create({ log }) → driver | null   (필요한 라이브러리가 없으면 null)
 *   driver.start(eq, { onStatus(status, reason), onValue(value) }) → handle
 *   handle.stop()          수집 중지 (연결 정리)
 *   handle.connected()     현재 연결 여부 (boolean)
 *
 * eq.ds (equipments.data_source JSON):
 *   protocol, address, tag, intervalMs,
 *   statusMap  { "<원시값>": "RUN|IDLE|STOP|ALARM" }  — 원시값을 상태로 변환 (선택)
 *   unitId, regType('holding'|'input'|'coil'|'discrete')   — Modbus 전용
 *   valueTag   — OPC-UA에서 온도 등 수치 노드를 따로 읽을 때 (선택)
 *
 * 서버 본체·클라이언트는 프로토콜과 무관하게 onStatus 한 가지 이벤트만 받는다 (설계서 5.3).
 */
export const VALID_STATUS = ['RUN', 'IDLE', 'STOP', 'ALARM'];

/** 원시값 → 설비 상태. 매핑되지 않으면 null (상태 변경 없이 수집값만 갱신) */
export function resolveStatus(raw, ds) {
  if (raw === null || raw === undefined) return null;
  const map = ds?.statusMap || null;
  if (map) {
    const key = typeof raw === 'boolean' ? (raw ? '1' : '0') : String(raw).trim();
    const hit = map[key] ?? map[key.toUpperCase()] ?? map[key.toLowerCase()];
    if (hit && VALID_STATUS.includes(hit)) return hit;
  }
  const s = String(raw).trim().toUpperCase();
  return VALID_STATUS.includes(s) ? s : null;
}

/** 라이브러리를 선택적으로 로드 — 설치되지 않았으면 null */
export async function optionalImport(name) {
  try { return await import(name); } catch { return null; }
}
