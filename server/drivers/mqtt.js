/* MQTT 드라이버 (LIVE) — 브로커에 접속해 태그(토픽)를 구독
 * payload: 'RUN'|'IDLE'|'STOP'|'ALARM' 평문, {"status":"RUN","value":72.5} JSON,
 *          또는 statusMap으로 변환 가능한 원시값('1', 'ON' 등) */
import mqtt from 'mqtt';
import { resolveStatus } from './common.js';

export const protocol = 'mqtt';

export async function create({ log }) {
  const clients = new Map(); // address -> { client, topics: Map<topic, handler> }

  function clientFor(address) {
    let entry = clients.get(address);
    if (entry) return entry;
    const client = mqtt.connect(address, { reconnectPeriod: 5000, connectTimeout: 4000 });
    entry = { client, topics: new Map() };
    client.on('message', (topic, payload) => entry.topics.get(topic)?.(payload));
    client.on('error', (e) => log?.(`mqtt ${address}: ${e.message}`)); // 재접속은 mqtt.js가 담당
    clients.set(address, entry);
    return entry;
  }

  return {
    start(eq, { onStatus, onValue }) {
      const address = eq.ds.address, topic = eq.ds.tag;
      const entry = clientFor(address);
      entry.topics.set(topic, (payload) => {
        const text = payload.toString().trim();
        let raw = text, value = null;
        try {
          const j = JSON.parse(text);
          if (j && typeof j === 'object') { raw = j.status ?? j.value ?? null; value = j.value ?? null; }
          else raw = j;
        } catch { /* 평문 */ }
        if (value !== null && Number.isFinite(Number(value))) onValue(Number(value));
        const status = resolveStatus(raw, eq.ds);
        if (status) onStatus(status, `MQTT 수신 (${topic}${value !== null ? ` · ${value}` : ''})`);
      });
      entry.client.subscribe(topic, { qos: 0 });
      return {
        stop() {
          entry.topics.delete(topic);
          entry.client.unsubscribe(topic);
          if (entry.topics.size === 0) { entry.client.end(true); clients.delete(address); }
        },
        connected: () => !!entry.client.connected,
      };
    },
  };
}
