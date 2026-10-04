'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { tmpEnv } = require('./helpers');
const { openDb, getSetting, insertImportedRow, insertImportedFrequent, insertImportedLock } = require('../db');

test('建表冪等：開兩次不壞、資料與設定保留', () => {
  const env = tmpEnv();
  try {
    const a = openDb(env.cfg.DATA_DIR);
    const tables = a.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
    for (const t of ['rows', 'frequent', 'locks', 'settings', 'create_tokens', 'meta']) assert.ok(tables.includes(t), t);
    a.prepare("INSERT INTO settings (key, value) VALUES ('store', '改過')  ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    a.close();
    const b = openDb(env.cfg.DATA_DIR);
    assert.strictEqual(getSetting(b, 'store'), '改過');   // 初始設定不會蓋掉既有值
    b.close();
    const c = openDb(env.cfg.DATA_DIR);
    assert.strictEqual(c.prepare('SELECT COUNT(*) c FROM settings').get().c >= 3, true);
    c.close();
  } finally { env.cleanup(); }
});

test('初始設定：店別新竹光復、科目預設照 Code.gs setup', () => {
  const env = tmpEnv();
  try {
    const db = openDb(env.cfg.DATA_DIR);
    assert.strictEqual(getSetting(db, 'store'), '新竹光復');
    assert.deepStrictEqual(JSON.parse(getSetting(db, 'expense_subjects')).slice(0, 3), ['食材', '蔬果', '瓦斯']);
    assert.strictEqual(JSON.parse(getSetting(db, 'expense_subjects')).length, 12);
    assert.deepStrictEqual(JSON.parse(getSetting(db, 'income_subjects')), ['回收收入', '員工／同業購買', '代收轉付', '其他收入']);
    db.close();
  } finally { env.cleanup(); }
});

test('transaction 失敗會回滾', () => {
  const env = tmpEnv();
  try {
    const db = openDb(env.cfg.DATA_DIR);
    assert.throws(() => db.tx(() => {
      db.prepare("INSERT INTO locks (month, status, locked_at) VALUES ('2026-01', '鎖定', 'x')").run();
      throw new Error('boom');
    }), /boom/);
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM locks').get().c, 0);
    db.tx(() => db.prepare("INSERT INTO locks (month, status, locked_at) VALUES ('2026-02', '鎖定', 'x')").run());   // 回滾後仍可正常交易
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM locks').get().c, 1);
    db.close();
  } finally { env.cleanup(); }
});

test('insertImportedRow 原樣保留 id/seq/created_at/status/photo，Number 型髒資料轉型', () => {
  const env = tmpEnv();
  try {
    const db = openDb(env.cfg.DATA_DIR);
    insertImportedRow(db, { id: '2026-09-007', store: '新竹光復', date: '2026-09-03', kind: '支出', subject: 123, name: 456, amount: '1050', hasInvoice: true,
      net: 1000, tax: 50, seq: '9', photo: 'https://drive.google.com/x', author: '店長', createdAt: '2026-09-03T10:00:00+08:00', status: '作廢', voidedAt: '2026-09-04T00:00:00+08:00', voidReason: '記錯' });
    const r = db.prepare('SELECT * FROM rows WHERE id = ?').get('2026-09-007');
    assert.strictEqual(r.subject, '123'); assert.strictEqual(r.name, '456'); assert.strictEqual(r.amount, 1050); assert.strictEqual(r.seq, 9);
    assert.strictEqual(r.has_invoice, 1); assert.strictEqual(r.status, '作廢'); assert.strictEqual(r.created_at, '2026-09-03T10:00:00+08:00');
    assert.strictEqual(r.photo, 'https://drive.google.com/x'); assert.strictEqual(r.photo_file, ''); assert.strictEqual(r.photo_backed_at, null);
    insertImportedFrequent(db, { subject: 5, name: 'a', count: '3', lastUsed: '' });
    insertImportedLock(db, '2026-08', '2026-09-01T00:00:00+08:00');
    assert.strictEqual(db.prepare('SELECT count FROM frequent').get().count, 3);
    assert.strictEqual(db.prepare('SELECT month FROM locks').get().month, '2026-08');
    db.close();
  } finally { env.cleanup(); }
});
