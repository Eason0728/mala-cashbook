'use strict';
// 設定：server/.env（不進版控）＋環境變數（環境變數優先）。傳入 envIn 時只用它（測試用，不讀任何 .env）。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function readDotenv(file, into) {
  try {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line) => {
      const m = /^\s*([A-Z_0-9]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && into[m[1]] === undefined) into[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
  } catch (e) { /* 沒有 .env 就用預設 */ }
}

function loadConfig(envIn) {
  const env = Object.assign({}, envIn || process.env);
  if (!envIn) readDotenv(path.join(__dirname, '.env'), env);
  const home = env.HOME || os.homedir();
  const dataDir = env.DATA_DIR ? path.resolve(env.DATA_DIR.replace(/^~/, home)) : path.join(home, 'mala-cashbook-data');
  return {
    PORT: env.PORT !== undefined && env.PORT !== '' ? Number(env.PORT) : 8795,
    BIND: env.BIND || '127.0.0.1',
    DATA_DIR: dataDir,
    ADMIN_INIT: env.ADMIN_INIT || '',
    PNL_KEY: env.PNL_KEY || '',
    BACKUP_URL: env.BACKUP_URL || '',
    BACKUP_KEY: env.BACKUP_KEY || '',
    ALLOW_ORIGIN: ['https://eason0728.github.io'].concat((env.ALLOW_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean)),
    PUBLIC_BASE: String(env.PUBLIC_BASE || '').replace(/\/+$/, ''),
    LOG_XFF: env.LOG_XFF === '1',
    MAX_BODY_BYTES: 8 * 1024 * 1024
  };
}
module.exports = { loadConfig };
