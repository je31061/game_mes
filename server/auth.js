/* 인증 유틸 — JWT(HS256) + scrypt 비밀번호 해시 (NFR-03)
 * 시크릿은 data/jwt.secret에 영속화되어 서버 재시작에도 세션이 유지된다. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

const SECRET_PATH = path.join(DATA_DIR, 'jwt.secret');

let SECRET;
if (process.env.FW_JWT_SECRET) {
  // 클라우드 배포(디스크가 재배포마다 초기화되는 환경): 환경변수로 시크릿을 고정해 세션 유지
  SECRET = String(process.env.FW_JWT_SECRET).trim();
} else if (fs.existsSync(SECRET_PATH)) {
  SECRET = fs.readFileSync(SECRET_PATH, 'utf8').trim();
} else {
  SECRET = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_PATH, SECRET);
}

const TOKEN_TTL_SEC = 12 * 60 * 60; // 12시간

export function signToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({
    ...payload, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyToken(token) {
  try {
    const [h, b, s] = String(token).split('.');
    const expect = crypto.createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64url');
    const sb = Buffer.from(s), eb = Buffer.from(expect);
    if (sb.length !== eb.length || !crypto.timingSafeEqual(sb, eb)) return null;
    const payload = JSON.parse(Buffer.from(b, 'base64url').toString());
    if (!payload.exp || payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  try {
    const [saltHex, hashHex] = String(stored).split(':');
    const hash = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 32);
    return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
  } catch {
    return false;
  }
}
