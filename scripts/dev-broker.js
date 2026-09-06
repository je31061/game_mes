/* 개발용 로컬 MQTT 브로커 (aedes) — 실 브로커 없이 게이트웨이 LIVE 모드 테스트
 * 실행: node scripts/dev-broker.js  (기본 포트 1883) */
import { Aedes } from 'aedes';
import net from 'node:net';

const PORT = process.env.MQTT_PORT || 1883;
const aedes = await Aedes.createBroker();
const server = net.createServer(aedes.handle);

aedes.on('client', (c) => console.log(`[broker] 접속: ${c.id}`));
aedes.on('publish', (packet, client) => {
  if (client) console.log(`[broker] ${packet.topic} ← ${packet.payload.toString()}`);
});

server.listen(PORT, () => console.log(`[dev-broker] mqtt://localhost:${PORT}`));
