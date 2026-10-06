'use strict';
// T12／T12b：門市營運系統通道＋多店（STORE_SVC_KEY／STORE_LOGIN_OFF／店別過濾／遷移／會計跨店查帳）
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { test } = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { setup, tmpEnv, STORE, ADMIN, PNL, JPG } = require('./helpers');
const { openDb } = require('../db');
const { makeApp } = require('../index');
const { setStorePass } = require('../auth');

const KEY = 'svc-key-for-test-0123456789';
const mk = (o) => Object.assign({ date: '2026-10-03', kind: '支出', subject: '瓦斯', name: '桶裝瓦斯', amount: 1050, hasInvoice: true }, o || {});
function svcSetup(extraEnv) {
  const s = setup({ env: Object.assign({ STORE_SVC_KEY: KEY }, extraEnv || {}) });
  // 金鑰通道呼叫：call 帶 X-Store-Key／X-Store-Code
  s.svc = (code, action, p, key) => s.actions.dispatch(Object.assign({ action }, p || {}), '2.2.2.2', { key: key === undefined ? KEY : key, code });
  s.admin = (action, p) => s.actions.dispatch(Object.assign({ action, adminPass: ADMIN }, p || {}), '3.3.3.3');
  return s;
}

test('A 店看不到 B 店的帳（list／bootstrap／update／void 皆然），光復舊路徑也看不到兩店', () => {
  const s = svcSetup();
  try {
    const a = s.svc('AAA', 'create', mk({ name: 'A的帳' })).row, b = s.svc('BBB', 'create', mk({ name: 'B的帳' })).row;
    assert.deepStrictEqual(s.svc('AAA', 'list', { month: '2026-10' }).rows.map((r) => r.name), ['A的帳']);
    assert.deepStrictEqual(s.svc('BBB', 'bootstrap', { month: '2026-10' }).rows.map((r) => r.name), ['B的帳']);
    assert.strictEqual(s.svc('AAA', 'bootstrap', {}).settings.store, 'AAA');
    assert.strictEqual(s.svc('AAA', 'update', { id: b.id, amount: 5 }).error, 'NOT_FOUND');
    assert.strictEqual(s.svc('AAA', 'void', { id: b.id }).error, 'NOT_FOUND');
    assert.strictEqual(s.svc('BBB', 'void', { id: a.id }).error, 'NOT_FOUND');
    assert.strictEqual(s.svc('BBB', 'void', { id: b.id }).ok, true);
    assert.deepStrictEqual(s.call('list', { month: '2026-10' }).rows, []);   // 舊通行碼路徑＝光復，沒有這兩店的帳
    assert.strictEqual(a.store, 'AAA');
  } finally { s.cleanup(); }
});

test('B 店鎖月不影響 A 店；解鎖也只動自己那店', () => {
  const s = svcSetup();
  try {
    assert.deepStrictEqual(s.svc('BBB', 'lock', { month: '2026-10' }).lockedMonths, ['2026-10']);
    assert.strictEqual(s.svc('BBB', 'create', mk()).error, 'LOCKED');
    assert.strictEqual(s.svc('AAA', 'create', mk()).ok, true);
    assert.deepStrictEqual(s.svc('AAA', 'bootstrap', {}).lockedMonths, []);
    assert.strictEqual(s.call('create', mk()).ok, true);   // 光復也不受影響
    s.svc('AAA', 'lock', { month: '2026-10' });
    assert.strictEqual(s.svc('AAA', 'unlock', { month: '2026-10' }).lockedMonths.length, 0);
    assert.deepStrictEqual(s.svc('BBB', 'bootstrap', {}).lockedMonths, ['2026-10']);
  } finally { s.cleanup(); }
});

test('兩店收據編號各自從 1 起算；單號不重複', () => {
  const s = svcSetup();
  try {
    const a1 = s.svc('AAA', 'create', mk()).row, b1 = s.svc('BBB', 'create', mk()).row;
    const a2 = s.svc('AAA', 'create', mk()).row, b2 = s.svc('BBB', 'create', mk()).row;
    const a3 = s.svc('AAA', 'create', mk({ kind: '收入', subject: '回收收入', name: '紙箱' })).row;
    assert.deepStrictEqual([a1.seq, a2.seq, b1.seq, b2.seq, a3.seq], [1, 2, 1, 2, 1]);
    const ids = [a1, a2, b1, b2, a3].map((r) => r.id);
    assert.strictEqual(new Set(ids).size, ids.length);
    const l = s.call('create', mk()).row;   // 光復也從 1 起，單號形狀不變
    assert.deepStrictEqual([l.seq, l.id.slice(0, 8)], [1, '2026-10-']);
  } finally { s.cleanup(); }
});

test('同 clientToken 不同店不互相擋；同店才算重複', () => {
  const s = svcSetup();
  try {
    const a = s.svc('AAA', 'create', mk({ clientToken: 'tok-1' })), b = s.svc('BBB', 'create', mk({ clientToken: 'tok-1' }));
    assert.ok(!a.duplicate && !b.duplicate); assert.notStrictEqual(a.row.id, b.row.id);
    const a2 = s.svc('AAA', 'create', mk({ clientToken: 'tok-1' }));
    assert.strictEqual(a2.duplicate, true); assert.strictEqual(a2.row.id, a.row.id);
    assert.strictEqual(s.svc('AAA', 'list', { month: '2026-10' }).rows.length, 1);
    const l = s.call('create', mk({ clientToken: 'tok-1' }));   // 光復舊路徑也是另一個範圍
    assert.ok(!l.duplicate);
  } finally { s.cleanup(); }
});

test('常用項目每店各自；科目清單全店共用', () => {
  const s = svcSetup();
  try {
    s.svc('AAA', 'create', mk({ name: '只有A用' }));
    assert.deepStrictEqual(s.svc('AAA', 'bootstrap', {}).frequent.map((f) => f.name), ['只有A用']);
    assert.deepStrictEqual(s.svc('BBB', 'bootstrap', {}).frequent, []);
    assert.deepStrictEqual(s.call('bootstrap').frequent, []);
    s.admin('adminSave', { expenseSubjects: ['共用科目甲'], incomeSubjects: ['共用收入'] });
    assert.deepStrictEqual(s.svc('AAA', 'bootstrap', {}).settings.expenseSubjects, ['共用科目甲']);
    assert.deepStrictEqual(s.svc('BBB', 'bootstrap', {}).settings.expenseSubjects, ['共用科目甲']);
  } finally { s.cleanup(); }
});

test('服務金鑰：只放行七個門市動作；adminGet／adminSave／adminStores／adminList／pnlSummary 一律拒絕', () => {
  const s = svcSetup();
  try {
    ['bootstrap', 'list', 'create', 'update', 'void', 'lock', 'unlock'].forEach((a) => {
      const r = s.svc('AAA', a, a === 'create' ? mk() : { month: '2026-10', id: 'x' });
      assert.notStrictEqual(r.error, 'FORBIDDEN', a); assert.notStrictEqual(r.error, 'AUTH_FAIL', a);
    });
    ['adminGet', 'adminSave', 'adminStores', 'adminList', 'pnlSummary'].forEach((a) => {
      const r = s.actions.dispatch({ action: a, adminPass: ADMIN, key: PNL, month: '2026-10', store: 'AAA', expenseSubjects: ['x'] }, '4.4.4.4', { key: KEY, code: 'AAA' });
      assert.deepStrictEqual(r, { ok: false, error: 'FORBIDDEN' }, a);
    });
    assert.deepStrictEqual(s.admin('adminGet').expenseSubjects.includes('x'), false);   // adminSave 沒生效
    assert.strictEqual(s.svc('AAA', 'nosuch', {}).error, 'BAD_INPUT');
  } finally { s.cleanup(); }
});

test('服務金鑰：錯誤金鑰／缺店碼／壞店碼被拒；錯誤金鑰計入失敗鎖；金鑰不等於通行碼', () => {
  const s = svcSetup();
  try {
    assert.strictEqual(s.svc('AAA', 'list', { month: '2026-10' }, 'wrong-key').error, 'AUTH_FAIL');
    assert.strictEqual(s.svc('AAA', 'list', { month: '2026-10' }, KEY + 'x').error, 'AUTH_FAIL');   // 長度不同
    ['', undefined, 'aaa', 'A', 'TOOLONGSTORECODE1', 'A B', 'AA-1'].forEach((c) => assert.strictEqual(s.svc(c, 'list', { month: '2026-10' }).error, 'BAD_INPUT', String(c)));
    // 金鑰通道不吃通行碼：帶金鑰標頭時請求內文的 pass 不會被拿來當門市驗證
    assert.strictEqual(s.actions.dispatch({ action: 'list', pass: STORE, month: '2026-10' }, '5.5.5.5', { key: 'bad', code: 'AAA' }).error, 'AUTH_FAIL');
    let last; for (let i = 0; i < 25; i++) last = s.svc('AAA', 'list', { month: '2026-10' }, 'bad' + i);
    assert.strictEqual(last.error, 'AUTH_LOCKED');
  } finally { s.cleanup(); }
});

test('STORE_SVC_KEY 未設：標頭整個被忽略，行為與舊版相同（含用金鑰字串猜也進不去）', () => {
  const s = setup();   // 未設 STORE_SVC_KEY
  try {
    assert.strictEqual(s.actions.dispatch({ action: 'create', ...mk() }, '6.6.6.6', { key: KEY, code: 'AAA' }).error, 'AUTH_FAIL');
    assert.strictEqual(s.actions.dispatch({ action: 'create', ...mk() }, '6.6.6.7', { key: '', code: 'AAA' }).error, 'AUTH_FAIL');
    const r = s.call('create', mk());
    assert.strictEqual(r.ok, true); assert.strictEqual(r.row.store, '新竹光復');   // 對外店別維持店名
    assert.strictEqual(s.call('bootstrap', { month: '2026-10' }).settings.store, '新竹光復');
    assert.strictEqual(s.db.prepare('SELECT store FROM rows').get().store, 'MDGF');   // 庫內是代號
    assert.strictEqual(s.actions.dispatch({ action: 'pnlSummary', key: PNL, month: '2026-10' }).store, '新竹光復');
  } finally { s.cleanup(); }
});

test('STORE_LOGIN_OFF=1：店長通行碼（對或錯）回 MOVED_TO_STORE_OPS；會計與損益與金鑰通道照常', () => {
  const s = svcSetup({ STORE_LOGIN_OFF: '1' });
  try {
    ['bootstrap', 'list', 'create', 'update', 'void', 'lock', 'unlock'].forEach((a) => assert.strictEqual(s.call(a, mk({ month: '2026-10', id: 'x' })).error, 'MOVED_TO_STORE_OPS', a));
    assert.strictEqual(s.actions.dispatch({ action: 'bootstrap', pass: 'wrong', month: '2026-10' }, '7.7.7.7').error, 'MOVED_TO_STORE_OPS');
    assert.strictEqual(s.admin('adminGet').ok, true);
    assert.strictEqual(s.admin('adminSave', { expenseSubjects: ['科目乙'] }).ok, true);
    assert.strictEqual(s.admin('adminStores').ok, true);
    assert.strictEqual(s.actions.dispatch({ action: 'pnlSummary', key: PNL, month: '2026-10' }).ok, true);
    assert.strictEqual(s.svc('AAA', 'create', mk()).ok, true);
    assert.strictEqual(s.actions.dispatch({ action: 'adminGet', adminPass: 'bad' }, '8.8.8.8').error, 'AUTH_FAIL');   // 會計密碼錯仍是 AUTH_FAIL
  } finally { s.cleanup(); }
});

test('STORE_LOGIN_OFF 預設關閉：店長通行碼照常可用', () => {
  const s = svcSetup();
  try { assert.strictEqual(s.call('create', mk()).ok, true); } finally { s.cleanup(); }
});

test('pnlSummary：不帶 store＝光復（舊行為）；帶 store 只算該店；壞店碼 BAD_INPUT', () => {
  const s = svcSetup();
  try {
    s.call('create', mk({ amount: 100 })); s.svc('AAA', 'create', mk({ amount: 700 })); s.svc('AAA', 'lock', { month: '2026-10' });
    const p = (o) => s.actions.dispatch(Object.assign({ action: 'pnlSummary', key: PNL, month: '2026-10' }, o || {}));
    const old = p();
    assert.deepStrictEqual([old.store, old.expense, old.rows, old.locked], ['新竹光復', { 瓦斯: 100 }, 1, false]);
    const a = p({ store: 'AAA' });
    assert.deepStrictEqual([a.store, a.expense, a.rows, a.locked], ['AAA', { 瓦斯: 700 }, 1, true]);
    assert.strictEqual(p({ store: 'MDGF' }).expense['瓦斯'], 100);
    assert.strictEqual(p({ store: 'bad code' }).error, 'BAD_INPUT');
    assert.strictEqual(p({ store: 'ZZZ' }).rows, 0);
  } finally { s.cleanup(); }
});

test('會計跨店：adminStores／adminList 只用管理通行碼，依店別與月份取明細（含作廢與是否鎖定）', () => {
  const s = svcSetup();
  try {
    s.call('create', mk({ name: '光復帳' })); s.svc('BBB', 'create', mk({ name: 'B帳1' }));
    const b2 = s.svc('BBB', 'create', mk({ name: 'B帳2' })).row; s.svc('BBB', 'void', { id: b2.id, reason: '測' });
    s.svc('CCC', 'lock', { month: '2026-10' });
    const st = s.admin('adminStores');
    assert.deepStrictEqual(st.stores, [{ code: 'MDGF', name: '新竹光復' }, { code: 'BBB', name: 'BBB' }, { code: 'CCC', name: 'CCC' }]);
    const l = s.admin('adminList', { store: 'BBB', month: '2026-10' });
    assert.deepStrictEqual([l.store, l.name, l.rows.map((r) => r.name), l.rows[1].status, l.rows[1].voidReason, l.locked], ['BBB', 'BBB', ['B帳1', 'B帳2'], '作廢', '測', false]);
    assert.strictEqual(s.admin('adminList', { store: 'CCC', month: '2026-10' }).locked, true);
    assert.deepStrictEqual(s.admin('adminList', { store: 'MDGF', month: '2026-10' }).rows.map((r) => r.name), ['光復帳']);
    assert.strictEqual(s.admin('adminList', { store: 'MDGF', month: '2026-10' }).rows[0].store, '新竹光復');
    assert.strictEqual(s.admin('adminList', { store: 'bad', month: '2026-10' }).error, 'BAD_INPUT');
    assert.strictEqual(s.admin('adminList', { store: 'BBB', month: '2026-13' }).error, 'BAD_INPUT');
    // 店長通行碼、不帶碼都進不去
    assert.strictEqual(s.actions.dispatch({ action: 'adminList', adminPass: STORE, store: 'BBB', month: '2026-10' }, '9.9.9.9').error, 'AUTH_FAIL');
    assert.strictEqual(s.actions.dispatch({ action: 'adminStores' }, '9.9.9.8').error, 'AUTH_FAIL');
  } finally { s.cleanup(); }
});

test('LEGACY_STORE_CODE 可改：舊通行碼路徑寫進該代號', () => {
  const s = setup({ env: { LEGACY_STORE_CODE: 'HFGF' } });
  try {
    s.call('create', mk());
    assert.strictEqual(s.db.prepare('SELECT store FROM rows').get().store, 'HFGF');
    assert.strictEqual(s.actions.dispatch({ action: 'pnlSummary', key: PNL, month: '2026-10' }).rows, 1);
  } finally { s.cleanup(); }
});

// ---------- 遷移 ----------
const OLD_SCHEMA = `
CREATE TABLE rows (id TEXT PRIMARY KEY, store TEXT NOT NULL DEFAULT '', date TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL,
  name TEXT NOT NULL, amount INTEGER NOT NULL, has_invoice INTEGER NOT NULL DEFAULT 0, net INTEGER NOT NULL DEFAULT 0,
  tax INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL DEFAULT 0, photo TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '正常', voided_at TEXT NOT NULL DEFAULT '',
  void_reason TEXT NOT NULL DEFAULT '', photo_file TEXT NOT NULL DEFAULT '', photo_backed_at TEXT);
CREATE INDEX idx_rows_date ON rows(date);
CREATE TABLE frequent (subject TEXT NOT NULL, name TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, last_used TEXT NOT NULL DEFAULT '', PRIMARY KEY (subject, name));
CREATE TABLE locks (month TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT '鎖定', locked_at TEXT NOT NULL DEFAULT '');
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE create_tokens (token TEXT PRIMARY KEY, row_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
PRAGMA user_version = 1;
INSERT INTO rows (id, store, date, kind, subject, name, amount, seq, created_at) VALUES
  ('2026-09-001','新竹光復','2026-09-05','支出','瓦斯','舊帳一',1050,1,'2026-09-05T10:00:00+08:00'),
  ('2026-09-002','','2026-09-06','收入','回收收入','舊帳二',200,1,'2026-09-06T10:00:00+08:00');
INSERT INTO frequent VALUES ('瓦斯','桶裝瓦斯',3,'2026-09-05T10:00:00+08:00');
INSERT INTO locks VALUES ('2026-08','鎖定','2026-09-02T09:00:00+08:00');
INSERT INTO create_tokens VALUES ('tok-old','2026-09-001','2026-09-05T10:00:00+08:00');
INSERT INTO settings VALUES ('store','新竹光復');`;
const dump = (db) => JSON.stringify(['rows', 'frequent', 'locks', 'create_tokens', 'settings'].map((t) => db.prepare('SELECT * FROM ' + t + ' ORDER BY 1,2').all()));

test('遷移：舊結構庫啟動時自動升級、先備份到 snapshots/、現有列店別換成代號、重跑兩次結果一樣', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cashbook-ms-'));
  try {
    const old = new DatabaseSync(path.join(dir, 'cashbook.db')); old.exec(OLD_SCHEMA); old.close();
    const NOW = () => new Date('2026-10-06T01:00:00Z');
    const d1 = openDb(dir, NOW); const j1 = dump(d1);
    const snaps = fs.readdirSync(path.join(dir, 'snapshots')).filter((f) => f.startsWith('cashbook-pre-multistore-'));
    assert.strictEqual(snaps.length, 1);
    const sdb = new DatabaseSync(path.join(dir, 'snapshots', snaps[0]), { readOnly: true });   // 備份是升級前的原樣
    assert.strictEqual(sdb.prepare("SELECT store FROM rows WHERE id='2026-09-001'").get().store, '新竹光復');
    assert.ok(!sdb.prepare('PRAGMA table_info(locks)').all().some((c) => c.name === 'store')); sdb.close();
    assert.deepStrictEqual(d1.prepare('SELECT id, store FROM rows ORDER BY id').all().map((r) => [r.id, r.store]), [['2026-09-001', 'MDGF'], ['2026-09-002', 'MDGF']]);
    assert.deepStrictEqual(d1.prepare('SELECT * FROM locks').all().map((r) => ({ ...r })), [{ store: 'MDGF', month: '2026-08', status: '鎖定', locked_at: '2026-09-02T09:00:00+08:00' }]);
    assert.strictEqual(d1.prepare('SELECT store, count FROM frequent').get().store, 'MDGF');
    assert.strictEqual(d1.prepare('SELECT store FROM create_tokens').get().store, 'MDGF');
    d1.close();
    const d2 = openDb(dir, NOW); const j2 = dump(d2); d2.close();
    const d3 = openDb(dir, NOW); const j3 = dump(d3); d3.close();
    assert.strictEqual(j2, j1); assert.strictEqual(j3, j1);
    assert.strictEqual(fs.readdirSync(path.join(dir, 'snapshots')).filter((f) => f.startsWith('cashbook-pre-multistore-')).length, 1);   // 重跑不再備份
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('遷移後：舊光復資料經舊路徑完全可讀、月結鎖定與 clientToken 冪等沿用', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cashbook-ms2-'));
  try {
    const old = new DatabaseSync(path.join(dir, 'cashbook.db')); old.exec(OLD_SCHEMA); old.close();
    const env = tmpEnv({ DATA_DIR: dir, STORE_SVC_KEY: KEY });
    const { createAuth, ensureAdminInit } = require('../auth');
    const { createActions } = require('../actions');
    const db = openDb(dir, undefined, env.cfg.LEGACY_STORE); ensureAdminInit(db, env.cfg); setStorePass(db, STORE);
    const act = createActions({ db, cfg: env.cfg, auth: createAuth(db) });
    const c = (a, p) => act.dispatch(Object.assign({ action: a, pass: STORE }, p));
    assert.deepStrictEqual(c('list', { month: '2026-09' }).rows.map((r) => [r.id, r.store]), [['2026-09-001', '新竹光復'], ['2026-09-002', '新竹光復']]);
    assert.deepStrictEqual(c('bootstrap', {}).lockedMonths, ['2026-08']);
    assert.strictEqual(c('create', mk({ date: '2026-08-10' })).error, 'LOCKED');
    assert.strictEqual(c('bootstrap', {}).frequent[0].name, '桶裝瓦斯');
    const n = c('create', mk({ date: '2026-09-10' })).row; assert.deepStrictEqual([n.seq, n.id], [2, '2026-09-003']);   // 支出第 2 筆、單號續號
    db.close(); env.cleanup();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- HTTP：標頭通道 ----------
function post(port, body, headers) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/cashbook/api', headers: Object.assign({ 'Content-Type': 'text/plain;charset=utf-8' }, headers || {}) }, (res) => {
      const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => resolve(JSON.parse(Buffer.concat(ch).toString('utf8'))));
    });
    r.on('error', reject); r.end(JSON.stringify(body));
  });
}
test('HTTP：X-Store-Key／X-Store-Code 標頭通道；access log 不含金鑰', async () => {
  const env = tmpEnv({ STORE_SVC_KEY: KEY }); const logs = [];
  const app = makeApp(env.cfg, { log: (s) => logs.push(s) });
  const { port } = await app.listen(0, '127.0.0.1');
  try {
    const h = { 'X-Store-Key': KEY, 'X-Store-Code': 'AAA' };
    const c = await post(port, Object.assign({ action: 'create' }, mk({ name: '標頭通道' })), h);
    assert.strictEqual(c.ok, true); assert.strictEqual(c.row.store, 'AAA');
    assert.strictEqual((await post(port, { action: 'list', month: '2026-10' }, h)).rows.length, 1);
    assert.strictEqual((await post(port, { action: 'list', month: '2026-10' }, { 'X-Store-Key': KEY, 'X-Store-Code': 'BBB' })).rows.length, 0);
    assert.strictEqual((await post(port, { action: 'list', month: '2026-10' }, { 'X-Store-Key': 'nope', 'X-Store-Code': 'AAA' })).error, 'AUTH_FAIL');
    assert.strictEqual((await post(port, { action: 'adminGet', adminPass: ADMIN }, h)).error, 'FORBIDDEN');
    assert.ok(!logs.join('\n').includes(KEY));
  } finally { await app.close(); env.cleanup(); }
});
