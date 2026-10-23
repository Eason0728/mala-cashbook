'use strict';
// 管理系統（會計）代轉通道：ADMIN_SVC_KEY／operator／admin_log／LOCKED_BY_ACCT／ADMIN_LOGIN_OFF／舊庫補欄位
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { setup, ADMIN } = require('./helpers');
const { openDb } = require('../db');

const AKEY = 'admin-svc-key-for-test-0123456789';
const OP = '測試會計（acct1）（管理系統）';
const mk = (o) => Object.assign({ date: '2026-10-03', kind: '支出', subject: '瓦斯', name: '桶裝瓦斯', amount: 1050, hasInvoice: true }, o || {});
function mkSetup(env) {
  const s = setup({ env: Object.assign({ ADMIN_SVC_KEY: AKEY }, env || {}) });
  s.ch = (action, p, o) => s.actions.dispatch(Object.assign({ action, adminKey: AKEY, operator: OP }, p || {}), (o && o.ip) || '4.4.4.4');
  s.log = () => s.db.prepare('SELECT * FROM admin_log ORDER BY id').all();
  return s;
}

test('通道只放行 8 個管理動作；店長動作與損益動作一律 FORBIDDEN', () => {
  const s = mkSetup();
  try {
    for (const a of ['bootstrap', 'list', 'create', 'update', 'void', 'lock', 'unlock', 'pnlSummary', 'nope']) {
      assert.strictEqual(s.ch(a, { store: 'MDGF', month: '2026-10' }).error, 'FORBIDDEN', a);
    }
    assert.strictEqual(s.ch('adminStores').ok, true);
    assert.strictEqual(s.ch('adminGet').ok, true);
    assert.strictEqual(s.ch('adminList', { store: 'MDGF', month: '2026-10' }).ok, true);
    assert.strictEqual(s.ch('adminLocks', { store: 'MDGF' }).ok, true);
  } finally { s.cleanup(); }
});

test('金鑰錯或沒設 ADMIN_SVC_KEY：AUTH_FAIL；錯太多會被鎖', () => {
  const s = mkSetup();
  try {
    assert.strictEqual(s.actions.dispatch({ action: 'adminStores', adminKey: 'wrong', operator: OP }, '5.5.5.5').error, 'AUTH_FAIL');
    assert.strictEqual(s.actions.dispatch({ action: 'adminStores', adminKey: '', operator: OP }, '5.5.5.5').error, 'AUTH_FAIL');
    let last;
    for (let i = 0; i < 25; i++) last = s.actions.dispatch({ action: 'adminStores', adminKey: 'wrong', operator: OP }, '6.6.6.6').error;
    assert.strictEqual(last, 'AUTH_LOCKED');
  } finally { s.cleanup(); }
  const off = setup({});   // 沒設 ADMIN_SVC_KEY
  try {
    assert.strictEqual(off.actions.dispatch({ action: 'adminStores', adminKey: AKEY, operator: OP }, '7.7.7.7').error, 'AUTH_FAIL');
  } finally { off.cleanup(); }
});

test('operator 必填、≤60 字', () => {
  const s = mkSetup();
  try {
    const raw = (op) => s.actions.dispatch(Object.assign({ action: 'adminStores', adminKey: AKEY }, op === undefined ? {} : { operator: op }), '4.4.4.4');
    assert.strictEqual(raw().error, 'BAD_INPUT');
    assert.strictEqual(raw('').error, 'BAD_INPUT');
    assert.strictEqual(raw('   ').error, 'BAD_INPUT');
    assert.strictEqual(raw(123).error, 'BAD_INPUT');
    assert.strictEqual(raw('字'.repeat(61)).error, 'BAD_INPUT');
    assert.strictEqual(raw('字'.repeat(60)).ok, true);
  } finally { s.cleanup(); }
});

test('adminSave 通道不接受改通行碼；改科目寫 admin_log', () => {
  const s = mkSetup();
  try {
    assert.strictEqual(s.ch('adminSave', { newStorePass: 'abcd1234' }).error, 'BAD_INPUT');
    assert.strictEqual(s.ch('adminSave', { newAdminPass: 'abcd1234' }).error, 'BAD_INPUT');
    assert.strictEqual(s.ch('adminSave', { expenseSubjects: ['食材'], newAdminPass: '' }).error, 'BAD_INPUT');
    assert.strictEqual(s.log().length, 0);
    assert.strictEqual(s.ch('adminSave', { expenseSubjects: ['食材', '瓦斯'], incomeSubjects: ['其他收入'] }).ok, true);
    assert.deepStrictEqual(s.ch('adminGet').expenseSubjects, ['食材', '瓦斯']);
    const l = s.log();
    assert.strictEqual(l.length, 1);
    assert.strictEqual(l[0].action, 'adminSave'); assert.strictEqual(l[0].operator, OP);
    // 通行碼沒被動到：舊管理通行碼仍可用
    assert.strictEqual(s.actions.dispatch({ action: 'adminGet', adminPass: ADMIN }, '1.1.1.1').ok, true);
  } finally { s.cleanup(); }
});

test('adminVoid：留痕 voidedBy、寫 admin_log；已作廢／已鎖／缺原因／找不到', () => {
  const s = mkSetup();
  try {
    const r = s.call('create', mk()).row;
    assert.strictEqual(s.ch('adminVoid', { store: 'MDGF', id: r.id }).error, 'BAD_INPUT');   // 缺原因
    assert.strictEqual(s.ch('adminVoid', { store: 'MDGF', id: r.id, reason: 'x'.repeat(201) }).error, 'BAD_INPUT');
    assert.strictEqual(s.ch('adminVoid', { store: 'MDGF', id: 'nope', reason: '測試' }).error, 'NOT_FOUND');
    assert.strictEqual(s.ch('adminVoid', { store: 'MDGF', id: r.id, reason: '重複登記' }).ok, true);
    assert.strictEqual(s.ch('adminVoid', { store: 'MDGF', id: r.id, reason: '再來一次' }).error, 'BAD_INPUT');   // 已作廢
    const row = s.ch('adminList', { store: 'MDGF', month: '2026-10' }).rows[0];
    assert.strictEqual(row.status, '作廢'); assert.strictEqual(row.voidedBy, OP); assert.strictEqual(row.voidReason, '重複登記');
    const l = s.log();
    assert.strictEqual(l.length, 1);
    assert.deepStrictEqual([l[0].action, l[0].operator, l[0].store, l[0].month, l[0].row_id, l[0].detail], ['adminVoid', OP, 'MDGF', '2026-10', r.id, '重複登記']);
    // 已鎖月份 → LOCKED，且不留 log
    const r2 = s.call('create', mk({ name: '第二筆' })).row;
    s.ch('adminLock', { store: 'MDGF', month: '2026-10' });
    assert.strictEqual(s.ch('adminVoid', { store: 'MDGF', id: r2.id, reason: '測試' }).error, 'LOCKED');
    assert.strictEqual(s.log().length, 2);   // void + lock
  } finally { s.cleanup(); }
});

test('adminLock／adminUnlock：lockedBy／lockedVia、adminLocks、寫 admin_log', () => {
  const s = mkSetup();
  try {
    assert.strictEqual(s.ch('adminLock', { store: 'MDGF', month: '2026-9' }).error, 'BAD_INPUT');
    assert.strictEqual(s.ch('adminLock', { store: 'MDGF', month: '2026-09' }).ok, true);
    assert.strictEqual(s.ch('adminLock', { store: 'MDGF', month: '2026-09' }).ok, true);   // 冪等
    const l = s.ch('adminList', { store: 'MDGF', month: '2026-09' });
    assert.deepStrictEqual([l.locked, l.lockedBy, l.lockedVia], [true, OP, 'acct']);
    const ls = s.ch('adminLocks', { store: 'MDGF' }).locks;
    assert.strictEqual(ls.length, 1);
    assert.deepStrictEqual([ls[0].month, ls[0].status, ls[0].lockedBy, ls[0].lockedVia], ['2026-09', '鎖定', OP, 'acct']);
    assert.ok(ls[0].lockedAt);
    assert.strictEqual(s.ch('adminUnlock', { store: 'MDGF', month: '2026-09' }).ok, true);
    assert.deepStrictEqual(s.ch('adminLocks', { store: 'MDGF' }).locks, []);
    assert.strictEqual(s.ch('adminList', { store: 'MDGF', month: '2026-09' }).locked, false);
    assert.deepStrictEqual(s.log().map((x) => x.action), ['adminLock', 'adminLock', 'adminUnlock']);
    assert.ok(s.log().every((x) => x.operator === OP && x.store === 'MDGF' && x.month === '2026-09'));
  } finally { s.cleanup(); }
});

test('LOCKED_BY_ACCT：會計鎖的月份店長通道不能解；店長自己鎖的照舊能解；舊資料（無來源）能解', () => {
  const s = mkSetup();
  try {
    s.ch('adminLock', { store: 'MDGF', month: '2026-09' });
    assert.strictEqual(s.call('unlock', { month: '2026-09' }).error, 'LOCKED_BY_ACCT');
    assert.deepStrictEqual(s.call('bootstrap', {}).lockedMonths, ['2026-09']);
    // 店長自己鎖
    assert.strictEqual(s.call('lock', { month: '2026-08' }).ok, true);
    const lk = s.ch('adminLocks', { store: 'MDGF' }).locks.find((x) => x.month === '2026-08');
    assert.deepStrictEqual([lk.lockedBy, lk.lockedVia], ['店長', 'store']);
    assert.strictEqual(s.call('unlock', { month: '2026-08' }).ok, true);
    // 舊資料：locked_via 空
    s.db.prepare("INSERT INTO locks (store, month, status, locked_at) VALUES ('MDGF', '2026-07', '鎖定', 'x')").run();
    assert.strictEqual(s.call('unlock', { month: '2026-07' }).ok, true);
    // 會計解鎖後店長可再鎖／解
    s.ch('adminUnlock', { store: 'MDGF', month: '2026-09' });
    assert.strictEqual(s.call('unlock', { month: '2026-09' }).ok, true);
  } finally { s.cleanup(); }
});

test('店長通道（STORE_SVC_KEY）也受 LOCKED_BY_ACCT 管；且不能呼叫 admin 通道動作', () => {
  const s = mkSetup({ STORE_SVC_KEY: 'svc-key-for-test-0123456789' });
  try {
    const svc = (action, p) => s.actions.dispatch(Object.assign({ action }, p || {}), '2.2.2.2', { key: 'svc-key-for-test-0123456789', code: 'MDGF' });
    s.ch('adminLock', { store: 'MDGF', month: '2026-09' });
    assert.strictEqual(svc('unlock', { month: '2026-09' }).error, 'LOCKED_BY_ACCT');
    assert.strictEqual(svc('adminVoid', { store: 'MDGF', id: 'x', reason: 'y' }).error, 'FORBIDDEN');
    assert.strictEqual(svc('lock', { month: '2026-08' }).ok, true);
    assert.strictEqual(s.ch('adminLocks', { store: 'MDGF' }).locks.find((x) => x.month === '2026-08').lockedVia, 'store');
  } finally { s.cleanup(); }
});

test('管理通行碼：admin 通道動作不接受（adminVoid 等）；ADMIN_LOGIN_OFF=1 時舊 admin* 回 MOVED_TO_DZY，不論碼對錯', () => {
  const s = mkSetup();
  try {
    const pw = (action, p) => s.actions.dispatch(Object.assign({ action, adminPass: ADMIN }, p || {}), '1.1.1.1');
    assert.strictEqual(pw('adminGet').ok, true);
    assert.strictEqual(pw('adminLocks', { store: 'MDGF' }).ok, false);
    assert.strictEqual(pw('adminLock', { store: 'MDGF', month: '2026-09' }).ok, false);
    assert.strictEqual(s.ch('adminLocks', { store: 'MDGF' }).locks.length, 0);
  } finally { s.cleanup(); }
  const off = mkSetup({ ADMIN_LOGIN_OFF: '1' });
  try {
    for (const a of ['adminGet', 'adminSave', 'adminStores', 'adminList']) {
      assert.strictEqual(off.actions.dispatch({ action: a, adminPass: ADMIN, store: 'MDGF', month: '2026-10' }, '1.1.1.1').error, 'MOVED_TO_DZY', a);
      assert.strictEqual(off.actions.dispatch({ action: a, adminPass: 'wrong' }, '1.1.1.1').error, 'MOVED_TO_DZY', a);
    }
    assert.strictEqual(off.ch('adminGet').ok, true);   // 新通道不受影響
    assert.strictEqual(off.call('list', { month: '2026-10' }).ok, true);   // 店長通行碼路徑不受影響
  } finally { off.cleanup(); }
});

test('唯讀模式（READONLY）擋三個新寫入動作', () => {
  const s = mkSetup();
  try {
    fs.writeFileSync(path.join(s.cfg.DATA_DIR, 'READONLY'), '');
    assert.strictEqual(s.ch('adminLock', { store: 'MDGF', month: '2026-09' }).error, 'READONLY');
    assert.strictEqual(s.ch('adminUnlock', { store: 'MDGF', month: '2026-09' }).error, 'READONLY');
    assert.strictEqual(s.ch('adminVoid', { store: 'MDGF', id: 'x', reason: 'y' }).error, 'READONLY');
    assert.strictEqual(s.ch('adminStores').ok, true);
  } finally { s.cleanup(); }
});

test('舊庫補欄位：沒有新欄位的舊 db 開庫後補齊、資料不壞、重複開庫不報錯', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cashbook-old-'));
  try {
    const f = path.join(dir, 'cashbook.db');
    const old = new DatabaseSync(f);
    old.exec(`CREATE TABLE rows (id TEXT PRIMARY KEY, store TEXT NOT NULL DEFAULT '', date TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL,
      name TEXT NOT NULL, amount INTEGER NOT NULL, has_invoice INTEGER NOT NULL DEFAULT 0, net INTEGER NOT NULL DEFAULT 0, tax INTEGER NOT NULL DEFAULT 0,
      seq INTEGER NOT NULL DEFAULT 0, photo TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '正常', voided_at TEXT NOT NULL DEFAULT '', void_reason TEXT NOT NULL DEFAULT '', photo_file TEXT NOT NULL DEFAULT '', photo_backed_at TEXT);
      CREATE TABLE locks (store TEXT NOT NULL DEFAULT '', month TEXT NOT NULL, status TEXT NOT NULL DEFAULT '鎖定', locked_at TEXT NOT NULL DEFAULT '', PRIMARY KEY (store, month));
      INSERT INTO rows (id, store, date, kind, subject, name, amount) VALUES ('2026-09-001','MDGF','2026-09-01','支出','食材','菜',100);
      INSERT INTO locks (store, month, locked_at) VALUES ('MDGF','2026-08','t');`);
    old.close();
    for (let i = 0; i < 2; i++) {
      const db = openDb(dir);
      const cols = (t) => db.prepare('PRAGMA table_info(' + t + ')').all().map((c) => c.name);
      assert.ok(cols('rows').includes('voided_by'));
      assert.ok(cols('locks').includes('locked_by') && cols('locks').includes('locked_via'));
      assert.deepStrictEqual(cols('admin_log'), ['id', 'at', 'operator', 'action', 'store', 'month', 'row_id', 'detail']);
      assert.strictEqual(db.prepare('SELECT voided_by FROM rows').get().voided_by, '');
      assert.strictEqual(db.prepare('SELECT locked_via FROM locks').get().locked_via, '');
      assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM rows').get().n, 1);
      db.close();
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
