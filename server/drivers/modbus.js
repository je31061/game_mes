/* Modbus TCP 드라이버 (준비 완료 — 라이브러리 설치 시 LIVE)
 *
 * 활성화: npm install modbus-serial
 * 설정:  address   호스트:포트 (예: 192.168.0.20:502, 포트 생략 시 502)
 *        tag       레지스터/코일 주소 (0 기반 정수, 예: 40001번 홀딩 레지스터 → 0)
 *        regType   holding | input | coil | discrete   (기본 holding)
 *        unitId    슬레이브 ID (기본 1)
 *        statusMap 원시값→상태 (예: {"0":"IDLE","1":"RUN","2":"STOP","3":"ALARM"})
 *        intervalMs 폴링 주기
 *
 * modbus-serial이 없으면 create()가 null을 반환하고 게이트웨이는 SIM으로 대체 가동한다.
 * 상태 레지스터가 비트 플래그(예: bit0 RUN, bit3 ALARM)인 장비는 statusMap 대신
 * 아래 readRaw 결과를 해석하는 분기를 추가하면 된다.
 */
import { resolveStatus, optionalImport } from './common.js';

export const protocol = 'modbus';

export async function create({ log }) {
  const lib = await optionalImport('modbus-serial');
  if (!lib) return null;
  const ModbusRTU = lib.default || lib;

  return {
    start(eq, { onStatus, onValue }) {
      const [host, portStr] = String(eq.ds.address || '').split(':');
      const port = Number(portStr) || 502;
      const addr = Math.max(0, Number(eq.ds.tag) || 0);
      const unitId = Number.isInteger(eq.ds.unitId) ? eq.ds.unitId : 1;
      const regType = eq.ds.regType || 'holding';
      const intervalMs = Math.max(200, eq.ds.intervalMs || 1000);
      const client = new ModbusRTU();
      let connected = false, timer = null, alive = true, busy = false;

      async function readRaw() {
        switch (regType) {
          case 'input': return (await client.readInputRegisters(addr, 1)).data[0];
          case 'coil': return (await client.readCoils(addr, 1)).data[0];
          case 'discrete': return (await client.readDiscreteInputs(addr, 1)).data[0];
          default: return (await client.readHoldingRegisters(addr, 1)).data[0];
        }
      }

      async function connect() {
        try {
          await client.connectTCP(host, { port });
          client.setID(unitId);
          client.setTimeout(Math.max(500, intervalMs));
          connected = true;
        } catch (e) {
          connected = false;
          log?.(`modbus ${eq.code}: 연결 실패 ${host}:${port} — ${e.message}`);
        }
      }

      async function poll() {
        if (!alive || busy) return;
        busy = true;
        try {
          if (!connected) await connect();
          if (connected) {
            const raw = await readRaw();
            const status = resolveStatus(raw, eq.ds);
            if (status) onStatus(status, `Modbus 수신 (${regType}[${addr}] = ${raw})`);
            else if (Number.isFinite(Number(raw))) onValue(Number(raw));
          }
        } catch (e) {
          connected = false;
          log?.(`modbus ${eq.code}: 읽기 실패 — ${e.message}`);
          try { client.close(() => {}); } catch {}
        } finally { busy = false; }
      }

      timer = setInterval(poll, intervalMs);
      poll();
      return {
        stop() { alive = false; clearInterval(timer); connected = false; try { client.close(() => {}); } catch {} },
        connected: () => connected,
      };
    },
  };
}
