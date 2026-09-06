/* 시뮬레이션 드라이버 — 실제 장비 없이 게이트웨이 흐름을 검증
 * 확률 기반(Markov) 상태 전이 + 온도성 수집값. 실 드라이버가 없을 때의 대체 경로이기도 하다. */
export const protocol = 'sim';

// 초당 상태 전이 확률
const RATES = {
  RUN: [['IDLE', 0.012], ['STOP', 0.006], ['ALARM', 0.006]],
  IDLE: [['RUN', 0.09]],
  STOP: [['RUN', 0.05]],
  ALARM: [['RUN', 0.035]],
};

export async function create({ getStatus }) {
  return {
    start(eq, { onStatus, onValue }) {
      const label = `${(eq.ds.protocol || 'sim').toUpperCase()} SIM`;
      let value = 55 + Math.random() * 10;
      if (eq.status === 'IDLE' || eq.status === 'STOP') {
        onStatus('RUN', `게이트웨이 연결 — 가동 신호 감지 (${label})`);
      }
      const intervalMs = Math.max(200, eq.ds.intervalMs || 1000);
      const timer = setInterval(() => {
        const cur = getStatus(eq.id);
        if (!cur) return;
        const drift = cur === 'ALARM' ? 1.2 : cur === 'RUN' ? 0.15 : -0.8;
        value = Math.max(35, Math.min(98, value + (Math.random() - 0.5) * 3 + drift));
        onValue(value);
        const dt = intervalMs / 1000;
        for (const [next, rate] of RATES[cur] || []) {
          if (Math.random() < rate * dt) {
            onStatus(next, `자동 수집 ${label} · ${value.toFixed(1)}°`);
            break;
          }
        }
      }, intervalMs);
      return { stop: () => clearInterval(timer), connected: () => true };
    },
  };
}
