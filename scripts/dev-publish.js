/* 개발용 MQTT 발행 도구 — 가상 설비가 상태를 보내는 것을 흉내낸다
 * 사용: node scripts/dev-publish.js <topic> <payload>
 * 예:  node scripts/dev-publish.js factory/press3/status ALARM
 *      node scripts/dev-publish.js factory/press3/status "{\"status\":\"RUN\",\"value\":72.5}" */
import mqtt from 'mqtt';

const [topic, payload] = process.argv.slice(2);
if (!topic || !payload) {
  console.error('사용법: node scripts/dev-publish.js <topic> <payload>');
  process.exit(1);
}
const client = mqtt.connect(process.env.MQTT_URL || 'mqtt://127.0.0.1:1883');
client.on('connect', () => {
  client.publish(topic, payload, {}, () => {
    console.log(`발행 완료: ${topic} ← ${payload}`);
    client.end();
  });
});
