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
  subject TEXT NOT NULL, name TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, last_used TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (subject, name));
CREATE TABLE IF NOT EXISTS locks (month TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT '鎖定', locked_at TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS create_tokens (token TEXT PRIMARY KEY, row_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

// 台北時間字串 YYYY-MM-DDTHH:mm:ss+08:00（與舊版 createdAt 同格式）
function taipeiStamp(d) { return new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 19) + '+08:00'; }

function getSetting(db, key) { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key); return r ? r.value : null; }
function setSetting(db, key, value) { db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value)); }
function getMeta(db, key) { const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key); return r ? r.value : null; }
function setMeta(db, key, value) { db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value)); }

// dataDir 可傳 ':memory:'（只給單元測試）。開兩次不壞：建表 IF NOT EXISTS、初始設定只在缺值時寫入。
function openDb(dataDir, now) {
  let file = ':memory:';
  if (dataDir !== ':memory:') { fs.mkdirSync(dataDir, { recursive: true }); file = path.join(dataDir, 'cashbook.db'); }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  db.exec('PRAGMA user_version = 1');
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
  db.prepare('INSERT OR REPLACE INTO frequent (subject, name, count, last_used) VALUES (?,?,?,?)').run(S(f.subject), S(f.name), Math.round(N(f.count)), S(f.lastUsed));
}
function insertImportedLock(db, month, lockedAt) {
  db.prepare("INSERT OR REPLACE INTO locks (month, status, locked_at) VALUES (?, '鎖定', ?)").run(S(month), S(lockedAt));
}

module.exports = { openDb, taipeiStamp, getSetting, setSetting, getMeta, setMeta, insertImportedRow, insertImportedFrequent, insertImportedLock, DEFAULT_EXPENSE, DEFAULT_INCOME };
