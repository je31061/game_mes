/* OPC-UA 드라이버 (준비 완료 — 라이브러리 설치 시 LIVE)
 *
 * 활성화: npm install node-opcua
 * 설정:  address  opc.tcp://호스트:4840
 *        tag      상태 노드 ID  (예: ns=2;s=Press3.Status)
 *        valueTag 수치 노드 ID  (예: ns=2;s=Press3.Temp, 선택)
 *        statusMap 원시값→상태 (예: {"1":"RUN","2":"IDLE","3":"STOP","9":"ALARM"})
 *        intervalMs 구독 샘플링 주기
 *
 * node-opcua가 없으면 create()가 null을 반환하고 게이트웨이는 SIM으로 대체 가동한다.
 * 실 장비 연결 시 확인할 것: 보안 정책(None/Sign/SignAndEncrypt), 익명 접속 허용 여부, 방화벽 4840.
 */
import { resolveStatus, optionalImport } from './common.js';

export const protocol = 'opcua';

export async function create({ log }) {
  const lib = await optionalImport('node-opcua');
  if (!lib) return null;
  const { OPCUAClient, AttributeIds, TimestampsToReturn, MessageSecurityMode, SecurityPolicy } = lib;

  return {
    start(eq, { onStatus, onValue }) {
      let session = null, subscription = null, client = null, alive = true, connected = false;
      const intervalMs = Math.max(200, eq.ds.intervalMs || 1000);

      async function connect() {
        client = OPCUAClient.create({
          endpointMustExist: false,
          securityMode: MessageSecurityMode.None,
          securityPolicy: SecurityPolicy.None,
          connectionStrategy: { maxRetry: -1, initialDelay: 2000, maxDelay: 10000 },
        });
        client.on('backoff', (n, delay) => log?.(`opcua ${eq.code}: 재시도 ${n} (${delay}ms)`));
        client.on('connection_lost', () => { connected = false; });
        client.on('connection_reestablished', () => { connected = true; });
        await client.connect(eq.ds.address);
        session = await client.createSession();
        connected = true;
        subscription = await session.createSubscription2({
          requestedPublishingInterval: intervalMs, requestedLifetimeCount: 100,
          requestedMaxKeepAliveCount: 10, maxNotificationsPerPublish: 10, publishingEnabled: true, priority: 10,
        });
        const monitor = async (nodeId, handler) => {
          const item = await subscription.monitor(
            { nodeId, attributeId: AttributeIds.Value },
            { samplingInterval: intervalMs, discardOldest: true, queueSize: 1 },
            TimestampsToReturn.Both,
          );
          item.on('changed', (dv) => handler(dv.value?.value));
        };
        await monitor(eq.ds.tag, (raw) => {
          const status = resolveStatus(raw, eq.ds);
          if (status) onStatus(status, `OPC-UA 수신 (${eq.ds.tag} = ${raw})`);
          else if (Number.isFinite(Number(raw))) onValue(Number(raw));
        });
        if (eq.ds.valueTag) await monitor(eq.ds.valueTag, (raw) => {
          if (Number.isFinite(Number(raw))) onValue(Number(raw));
        });
      }

      connect().catch((e) => {
        log?.(`opcua ${eq.code}: 연결 실패 — ${e.message}`);
        if (alive) setTimeout(() => alive && connect().catch(() => {}), 10000);
      });

      return {
        async stop() {
          alive = false; connected = false;
          try { await subscription?.terminate(); } catch {}
          try { await session?.close(); } catch {}
          try { await client?.disconnect(); } catch {}
        },
        connected: () => connected,
      };
    },
  };
}
