/* 데이터 백업 CLI (NFR-04)
 *
 * 사용: node scripts/backup.js [대상폴더]
 *  - 대상폴더 결정 순서: 인자 → 환경변수 FW_BACKUP_DIR → OneDrive(회사/개인)의 FactoryWorld-백업
 *    → 프로젝트의 backups/ (OneDrive가 없는 PC용 로컬 백업)
 *  - 서버가 켜져 있으면 대시보드의 [지금 백업]과 일 단위 자동 백업도 같은 로직을 사용한다 (server/backup.js)
 */
import { runBackup, defaultBackupRoot } from '../server/backup.js';

const destRoot = process.argv[2] || defaultBackupRoot();
const r = runBackup({ destRoot, log: (m) => console.log(m) });
console.log(`\n백업 완료 → ${r.dir}`);
