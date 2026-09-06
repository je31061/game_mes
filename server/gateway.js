/* 설비 게이트웨이 (Phase 2, FR-11)
 *
 * 맵 에디터에서 저장한 equipments.data_source(프로토콜/주소/태그/주기/매핑)를 읽어
 * 프로토콜별 드라이버(server/drivers/*)로 설비 상태를 수집하고, 수동 변경과 동일한
 * 이벤트 규격(onStatus 콜백)으로 발행한다. 서버 본체와 클라이언트는 프로토콜을 모른다 (설계서 5.3).
 *
 *  - mqtt   : LIVE (mqtt 패키지 내장)
 *  - opcua  : node-opcua 설치 시 LIVE, 없으면 SIM으로 대체 (관리자 콘솔에 '드라이버 미설치' 표시)
 *  - modbus : modbus-serial 설치 시 LIVE, 없으면 SIM으로 대체
 */
import { queries } from './db.js';
import * as simDriver from './drivers/sim.js';
import * as mqttDriver from './drivers/mqtt.js';
import * as opcuaDriver from './drivers/opcua.js';
import * as modbusDriver from './drivers/modbus.js';

const DRIVER_MODULES = { mqtt: mqttDriver, opcua: opcuaDriver, modbus: modbusDriver };

export function createGateway({ onStatus, log = (m) => console.log('[gateway]', m) }) {
  const handles = new Map();   // eqId -> { handle, mode: 'live'|'sim', driverMissing }
  const values = new Map();    // eqId -> number (최근 수집값)
  const drivers = new Map();   // protocol -> driver | null (null = 라이브러리 없음)
  let sim = null;
  let running = false;

  function configured() {
    return queries.listEquipments.all()
      .filter(e => e.data_source)
      .map(e => { try { return { ...e, ds: JSON.parse(e.data_source) }; } catch { return null; } })
      .filter(e => e && e.ds.protocol);
  }

  async function driverFor(protocol) {
    if (!drivers.has(protocol)) {
      const mod = DRIVER_MODULES[protocol];
      const d = mod ? await mod.create({ log }) : null;
      if (mod && !d) log(`${protocol.toUpperCase()} 드라이버 라이브러리가 없어 SIM으로 대체합니다`);
      drivers.set(protocol, d);
    }
    return drivers.get(protocol);
  }

  async function startOne(eq) {
    const callbacks = {
      onStatus: (status, reason) => onStatus(eq.id, status, reason),
      onValue: (v) => values.set(eq.id, v),
    };
    const driver = await driverFor(eq.ds.protocol);
    if (driver) {
      handles.set(eq.id, { handle: driver.start(eq, callbacks), mode: 'live', driverMissing: false });
    } else {
      sim ||= await simDriver.create({ getStatus: (id) => queries.getEquipment.get(id)?.status });
      handles.set(eq.id, { handle: sim.start(eq, callbacks), mode: 'sim', driverMissing: eq.ds.protocol !== 'sim' });
    }
  }

  async function start() {
    if (running) return;
    running = true;
    for (const eq of configured()) {
      if (!running) break;
      try { await startOne(eq); } catch (e) { log(`${eq.code} 시작 실패: ${e.message}`); }
    }
  }

  function stop() {
    running = false;
    for (const { handle } of handles.values()) { try { handle.stop(); } catch {} }
    handles.clear();
  }

  function reload() {
    if (!running) return;
    stop();
    return start();
  }

  function status() {
    return {
      running,
      equipments: configured().map(eq => {
        const h = handles.get(eq.id);
        const p = eq.ds.protocol;
        // 드라이버 로드 전에는 판정 불가 → 'unknown' (MQTT는 내장이라 항상 live, sim은 항상 sim)
        let mode, driverMissing = false;
        if (h) { mode = h.mode; driverMissing = h.driverMissing; }
        else if (p === 'mqtt') mode = 'live';
        else if (p === 'sim' || !DRIVER_MODULES[p]) mode = 'sim';
        else if (drivers.has(p)) { mode = drivers.get(p) ? 'live' : 'sim'; driverMissing = !drivers.get(p); }
        else mode = 'unknown';
        return {
          id: eq.id, code: eq.code, name: eq.name,
          protocol: p, tag: eq.ds.tag || eq.ds.address,
          intervalMs: eq.ds.intervalMs || 1000,
          mode,
          driverMissing,
          connected: running && h ? !!h.handle.connected() : false,
          value: values.has(eq.id) ? Number(values.get(eq.id).toFixed(1)) : null,
          status: eq.status,
        };
      }),
    };
  }

  return { start, stop, reload, status };
}
