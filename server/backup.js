/* 데이터 백업 모듈 (NFR-04: 대화·파일 데이터 일 단위 백업)
 *
 * - DB는 WAL 모드에서도 안전한 VACUUM INTO 방식으로 스냅샷 (서버 가동 중 실행 가능)
 * - 업로드 파일과 JWT 시크릿을 함께 복사
 * - 보존 정책: 최근 KEEP개만 유지, 오래된 것 자동 삭제
 * - 서버(index.js)의 일 단위 스케줄과 CLI(scripts/backup.js)가 같은 함수를 사용
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, PROJECT_ROOT } from './paths.js';

export const DEFAULT_KEEP = 14;

/** 대상 폴더 결정: 인자 → FW_BACKUP_DIR → OneDrive(회사 계정 우선) → 프로젝트 backups/ */
export function defaultBackupRoot() {
  if (process.env.FW_BACKUP_DIR) return path.resolve(process.env.FW_BACKUP_DIR);
  const oneDrive = process.env.OneDriveCommercial || process.env.OneDrive;
  if (oneDrive && fs.existsSync(oneDrive)) return path.join(oneDrive, 'FactoryWorld-백업');
  return path.join(PROJECT_ROOT, 'backups');
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 백업 실행. 반환: { dir, db: bool, uploads: number, secret: bool, removed: string[] }
 * @param {{ destRoot?: string, keep?: number, log?: (msg: string) => void }} opts
 */
export function runBackup({ destRoot = defaultBackupRoot(), keep = DEFAULT_KEEP, log = () => {} } = {}) {
  const destDir = path.join(destRoot, `fw-backup-${stamp()}`);
  fs.mkdirSync(destDir, { recursive: true });
  const result = { dir: destDir, db: false, uploads: 0, secret: false, removed: [] };

  // 1) DB 스냅샷 (온라인 백업)
  const dbPath = path.join(DATA_DIR, 'factory.db');
  if (fs.existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const out = path.join(destDir, 'factory.db').replaceAll('\\', '/').replaceAll("'", "''");
    db.exec(`VACUUM INTO '${out}'`);
    db.close();
    result.db = true;
    log(`DB 백업 완료: ${path.join(destDir, 'factory.db')}`);
  } else {
    log('DB 파일이 없습니다 (건너뜀)');
  }

  // 2) 업로드 파일 + JWT 시크릿
  const uploads = path.join(DATA_DIR, 'uploads');
  if (fs.existsSync(uploads)) {
    fs.cpSync(uploads, path.join(destDir, 'uploads'), { recursive: true });
    result.uploads = fs.readdirSync(uploads).length;
    log(`업로드 파일 백업 완료: ${result.uploads}개`);
  }
  const secret = path.join(DATA_DIR, 'jwt.secret');
  if (fs.existsSync(secret)) {
    fs.copyFileSync(secret, path.join(destDir, 'jwt.secret'));
    result.secret = true;
  }

  // 3) 보존 정책
  const old = fs.readdirSync(destRoot)
    .filter(n => n.startsWith('fw-backup-'))
    .sort()
    .slice(0, -keep);
  for (const n of old) {
    fs.rmSync(path.join(destRoot, n), { recursive: true, force: true });
    result.removed.push(n);
    log(`오래된 백업 삭제: ${n}`);
  }
  return result;
}

/** 백업 폴더 목록 (최신순) */
export function listBackups(destRoot = defaultBackupRoot()) {
  if (!fs.existsSync(destRoot)) return [];
  return fs.readdirSync(destRoot)
    .filter(n => n.startsWith('fw-backup-'))
    .sort()
    .reverse()
    .map(n => ({ name: n, path: path.join(destRoot, n) }));
}
