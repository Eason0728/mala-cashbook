'use strict';
// SQLite 資料層（node:sqlite）：建表冪等（IF NOT EXISTS＋user_version）、tx() 交易、初始設定、匯入 helper
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_EXPENSE = ['食材', '蔬果', '瓦斯', '備品耗材', '清潔用品', '修繕維護', '水電', '房租管理費', '運費', '文具印刷', '員工餐費', '雜支'];
const DEFAULT_INCOME = ['回收收入', '員工／同業購買', '代收轉付', '其他收入'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rows (
  id TEXT PRIMARY KEY, store TEXT NOT NULL DEFAULT '', date TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL,
  name TEXT NOT NULL, amount INTEGER NOT NULL, has_invoice INTEGER NOT NULL DEFAULT 0, net INTEGER NOT NULL DEFAULT 0,
  tax INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL DEFAULT 0, photo TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '正常', voided_at TEXT NOT NULL DEFAULT '',
  void_reason TEXT NOT NULL DEFAULT '', photo_file TEXT NOT NULL DEFAULT '', photo_backed_at TEXT);
CREATE INDEX IF NOT EXISTS idx_rows_date ON rows(date);
CREATE TABLE IF NOT EXISTS frequent (
  store TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL, name TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, last_used TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (store, subject, name));
CREATE TABLE IF NOT EXISTS locks (store TEXT NOT NULL DEFAULT '', month TEXT NOT NULL, status TEXT NOT NULL DEFAULT '鎖定', locked_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (store, month));
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS create_tokens (store TEXT NOT NULL DEFAULT '', token TEXT NOT NULL, row_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (store, token));
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

// 台北時間字串 YYYY-MM-DDTHH:mm:ss+08:00（與舊版 createdAt 同格式）
function taipeiStamp(d) { return new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 19) + '+08:00'; }

function getSetting(db, key) { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key); return r ? r.value : null; }
function setSetting(db, key, value) { db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value)); }
function getMeta(db, key) { const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key); return r ? r.value : null; }
function setMeta(db, key, value) { db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value)); }

const STORE_CODE_RE = /^[A-Z0-9]{2,12}$/;
const hasCol = (db, table, col) => db.prepare('PRAGMA table_info(' + table + ')').all().some((c) => c.name === col);

// 多店遷移（2026-10-06）：啟動時自動、可重跑、不毀資料。
// 1) 舊結構（locks/frequent/create_tokens 還沒有 store 欄）→ 先把 db 複製一份到 snapshots/ 再改結構；
// 2) rows.store 不是門市代號的（舊值「新竹光復」、空白）一律換成 legacy 代號。每次開庫都跑一次，已是代號的不動。
function migrateMultistore(db, dataDir, now, legacy) {
  const needSchema = !hasCol(db, 'locks', 'store') || !hasCol(db, 'frequent', 'store') || !hasCol(db, 'create_tokens', 'store');
  if (needSchema) {
    if (dataDir !== ':memory:') {
      const dir = path.join(dataDir, 'snapshots');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = taipeiStamp(now ? now() : new Date()).replace(/[-:]/g, '').replace('+0800', '').replace('+08:00', '');
      const file = path.join(dir, 'cashbook-pre-multistore-' + stamp + '.db');
      if (!fs.existsSync(file)) db.exec("VACUUM INTO '" + file.replace(/'/g, "''") + "'");
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const L = "'" + legacy.replace(/'/g, "''") + "'";
      if (!hasCol(db, 'locks', 'store')) {
        db.exec(`ALTER TABLE locks RENAME TO locks_old;
          CREATE TABLE locks (store TEXT NOT NULL DEFAULT '', month TEXT NOT NULL, status TEXT NOT NULL DEFAULT '鎖定', locked_at TEXT NOT NULL DEFAULT '', PRIMARY KEY (store, month));
          INSERT INTO locks (store, month, status, locked_at) SELECT ${L}, month, status, locked_at FROM locks_old ORDER BY rowid;
          DROP TABLE locks_old;`);
      }
      if (!hasCol(db, 'frequent', 'store')) {
        db.exec(`ALTER TABLE frequent RENAME TO frequent_old;
          CREATE TABLE frequent (store TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL, name TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, last_used TEXT NOT NULL DEFAULT '', PRIMARY KEY (store, subject, name));
          INSERT INTO frequent (store, subject, name, count, last_used) SELECT ${L}, subject, name, count, last_used FROM frequent_old ORDER BY rowid;
          DROP TABLE frequent_old;`);
      }
      if (!hasCol(db, 'create_tokens', 'store')) {
        db.exec(`ALTER TABLE create_tokens RENAME TO create_tokens_old;
          CREATE TABLE create_tokens (store TEXT NOT NULL DEFAULT '', token TEXT NOT NULL, row_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (store, token));
          INSERT INTO create_tokens (store, token, row_id, created_at) SELECT ${L}, token, row_id, created_at FROM create_tokens_old ORDER BY rowid;
          DROP TABLE create_tokens_old;`);
      }
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch (e2) { /* */ } throw e; }
  }
  db.prepare("UPDATE rows SET store = ? WHERE store = '' OR store NOT GLOB '[A-Z0-9]*'").run(legacy);
}

// dataDir 可傳 ':memory:'（只給單元測試）。開兩次不壞：建表 IF NOT EXISTS、初始設定只在缺值時寫入。
function openDb(dataDir, now, legacyStore) {
  const legacy = legacyStore || process.env.LEGACY_STORE_CODE || 'MDGF';
  if (!STORE_CODE_RE.test(legacy)) throw new Error('LEGACY_STORE_CODE 格式不對（大寫英數 2～12 碼）');
  let file = ':memory:';
  if (dataDir !== ':memory:') { fs.mkdirSync(dataDir, { recursive: true }); file = path.join(dataDir, 'cashbook.db'); }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  db.legacyStore = legacy;
  db.exec(SCHEMA);
  migrateMultistore(db, dataDir, now, legacy);
  db.exec('PRAGMA user_version = 2');
  // 交易：同一個行程依序處理，不支援巢狀；失敗一律回滾後把錯誤丟出去
  db.tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch (e2) { /* 已回滾 */ } throw e; }
  };
  const init = (k, v) => db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(k, v);
  init('store', '新竹光復');
  init('expense_subjects', JSON.stringify(DEFAULT_EXPENSE));
  init('income_subjects', JSON.stringify(DEFAULT_INCOME));
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('created_at', (now ? now() : new Date()).toISOString());
  return db;
}

// ---- 給 migrate（T5）用：原樣保留舊資料，所有值先轉字串再轉型（試算表會回 Number）----
const S = (v) => (v === undefined || v === null ? '' : String(v));
const N = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
function insertImportedRow(db, r) {
  const inv = r.hasInvoice === true || r.hasInvoice === 1 || r.hasInvoice === '有' || r.hasInvoice === '1' || r.hasInvoice === 'true';
  db.prepare(`INSERT INTO rows (id, store, date, kind, subject, name, amount, has_invoice, net, tax, seq, photo, author, created_at,
      status, voided_at, void_reason, photo_file, photo_backed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(S(r.id), S(r.store), S(r.date), S(r.kind), S(r.subject), S(r.name), Math.round(N(r.amount)), inv ? 1 : 0,
      Math.round(N(r.net)), Math.round(N(r.tax)), Math.round(N(r.seq)), S(r.photo), S(r.author), S(r.createdAt),
      S(r.status) || '正常', S(r.voidedAt), S(r.voidReason), S(r.photoFile), r.photoBackedAt ? S(r.photoBackedAt) : null);
}
function insertImportedFrequent(db, f) {
  db.prepare('INSERT OR REPLACE INTO frequent (store, subject, name, count, last_used) VALUES (?,?,?,?,?)').run(db.legacyStore, S(f.subject), S(f.name), Math.round(N(f.count)), S(f.lastUsed));
}
function insertImportedLock(db, month, lockedAt) {
  db.prepare("INSERT OR REPLACE INTO locks (store, month, status, locked_at) VALUES (?, ?, '鎖定', ?)").run(db.legacyStore, S(month), S(lockedAt));
}

module.exports = { STORE_CODE_RE, openDb, taipeiStamp, getSetting, setSetting, getMeta, setMeta, insertImportedRow, insertImportedFrequent, insertImportedLock, DEFAULT_EXPENSE, DEFAULT_INCOME };
