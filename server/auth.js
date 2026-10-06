'use strict';
// 通行碼：scrypt 加鹽雜湊（只存雜湊）、固定長度比對、依來源 IP 失敗鎖（10 分鐘錯 20 次 → 鎖 10 分鐘）
const crypto = require('node:crypto');
const { getSetting, setSetting } = require('./db');

const STORE_KEY = 'store_pass_hash', ADMIN_KEY = 'admin_pass_hash';
const WINDOW_MS = 10 * 60e3, MAX_FAILS = 20, LOCK_MS = 10 * 60e3;

class AuthError extends Error { constructor(code) { super(code); this.code = code; } }

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(String(pw), salt, 64).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const p = String(stored || '').split('$');
  if (p.length !== 3 || p[0] !== 'scrypt') return false;
  const want = Buffer.from(p[2], 'hex');
  const got = crypto.scryptSync(String(pw), Buffer.from(p[1], 'hex'), want.length);
  if (want.length !== 64) return false;   // 雜湊段空白或被截短一律拒絕
  return want.length === got.length && crypto.timingSafeEqual(want, got);   // 雜湊等長，逐位元常數時間比對
}
const DUMMY = hashPassword('dummy-not-a-real-password');   // 還沒設碼時也跑一次雜湊，回應時間不洩漏狀態

// 給 migrate／adminSave 用
function setStorePass(db, plain) { setSetting(db, STORE_KEY, hashPassword(plain)); }
function setAdminPass(db, plain) { setSetting(db, ADMIN_KEY, hashPassword(plain)); }
// ADMIN_INIT 有值且 DB 還沒有管理碼 → 寫入一次
function ensureAdminInit(db, cfg) {
  if (cfg.ADMIN_INIT && !getSetting(db, ADMIN_KEY)) setAdminPass(db, cfg.ADMIN_INIT);
}

function createAuth(db, now) {
  const clock = now || (() => new Date());
  const state = new Map();   // ip -> { fails:[ms], lockedUntil }
  function entry(ip) { let e = state.get(ip); if (!e) { e = { fails: [], lockedUntil: 0 }; state.set(ip, e); } return e; }
  function sweep(t) {
    if (state.size < 5000) return;
    for (const [k, e] of state) if (e.lockedUntil <= t && !e.fails.some((x) => t - x < WINDOW_MS)) state.delete(k);
  }
  // verify() 回 true＝通過。失敗計入同一個來源的失敗鎖（通行碼與服務金鑰共用）
  function guard(ip, verify) {
    const t = clock().getTime(), e = entry(ip || '?');
    sweep(t);
    if (e.lockedUntil > t) throw new AuthError('AUTH_LOCKED');
    if (verify()) return;
    e.fails = e.fails.filter((x) => t - x < WINDOW_MS);
    e.fails.push(t);
    if (e.fails.length >= MAX_FAILS) { e.lockedUntil = t + LOCK_MS; e.fails = []; }
    throw new AuthError('AUTH_FAIL');
  }
  function check(key, pass, ip) {
    guard(ip, () => {
      const stored = getSetting(db, key);
      return typeof pass === 'string' && pass.length > 0 && pass.length <= 200 && verifyPassword(pass, stored || DUMMY) && !!stored;
    });
  }
  // 服務金鑰：長度不同直接失敗，等長才逐位元常數時間比對（real 空＝通道關閉，一律失敗）
  function checkKey(provided, real, ip) {
    guard(ip, () => {
      if (!real || typeof provided !== 'string') return false;
      const a = Buffer.from(provided), b = Buffer.from(real);
      return a.byteLength === b.byteLength && crypto.timingSafeEqual(a, b);
    });
  }
  return {
    checkKey,
    checkStore: (pass, ip) => check(STORE_KEY, pass, ip),
    checkAdmin: (pass, ip) => check(ADMIN_KEY, pass, ip)
  };
}

module.exports = { AuthError, hashPassword, verifyPassword, setStorePass, setAdminPass, ensureAdminInit, createAuth, STORE_KEY, ADMIN_KEY };
