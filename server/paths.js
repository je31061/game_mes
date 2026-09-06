/* 데이터 경로 — 환경변수 FW_DATA_DIR로 분리 가능 (부하 테스트·스테이징을 운영 DB와 격리)
 * db.js/auth.js/backup.js가 공용으로 사용. DB 연결 없이 경로만 계산한다. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.join(__dirname, '..');
export const DATA_DIR = process.env.FW_DATA_DIR
  ? path.resolve(process.env.FW_DATA_DIR)
  : path.join(PROJECT_ROOT, 'data');
