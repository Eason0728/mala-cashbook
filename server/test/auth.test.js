'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { setup, STORE, ADMIN, tmpEnv, clock } = require('./helpers');
const { openDb, getSetting } = require('../db');
const { ensureAdminInit, verifyPassword, createAuth, setStorePass } = require('../auth');
const { createActions } = require('../actions');

const mk = () => ({ date: '2026-10-03', kind: '支出', subject: '瓦斯', name: '桶裝瓦斯', amount: 1050, hasInvoice: true });

test('錯 20 次後第 21 次回 AUTH_LOCKED（連正確通行碼也擋），10 分鐘後解鎖，別的來源不受影響', () => {
  const s = setup();
  try {
    for (let i = 0; i < 20; i++) assert.deepStrictEqual(s.actions.dispatch({ action: 'bootstrap', pass: 'wrong' + i }, '9.9.9.9'), { ok: false, error: 'AUTH_FAIL' }, 'try ' + i);
    assert.deepStrictEqual(s.actions.dispatch({ action: 'bootstrap', pass: 'wrong' }, '9.9.9.9'), { ok: false, error: 'AUTH_LOCKED' });
    assert.deepStrictEqual(s.actions.dispatch({ action: 'bootstrap', pass: STORE }, '9.9.9.9'), { ok: false, error: 'AUTH_LOCKED' });
    assert.strictEqual(s.actions.dispatch({ action: 'bootstrap', pass: STORE }, '8.8.8.8').ok, true);
    s.clock.ms += 9 * 60e3;
    assert.strictEqual(s.actions.dispatch({ action: 'bootstrap', pass: STORE }, '9.9.9.9').error, 'AUTH_LOCKED');
    s.clock.ms += 61e3;
    assert.strictEqual(s.actions.dispatch({ action: 'bootstrap', pass: STORE }, '9.9.9.9').ok, true);
  } finally { s.cleanup(); }
});

test('失敗計數只算 10 分鐘窗口：分散在窗口外的錯誤不會鎖', () => {
  const s = setup();
  try {
    for (let i = 0; i < 30; i++) { s.actions.dispatch({ action: 'bootstrap', pass: 'x' }, '5.5.5.5'); s.clock.ms += 60e3; }   // 每分鐘錯一次，窗口內最多 10 次
    assert.strictEqual(s.actions.dispatch({ action: 'bootstrap', pass: STORE }, '5.5.5.5').ok, true);
  } finally { s.cleanup(); }
});

test('settings 沒有店長碼雜湊時，所有 bootstrap 一律 AUTH_FAIL（含空字串、undefined）', () => {
  const s = setup({ storePass: false });
  try {
    for (const pass of ['', 'x', STORE, undefined, null, 0]) assert.deepStrictEqual(s.actions.dispatch({ action: 'bootstrap', pass }, '1.1.1.1'), { ok: false, error: 'AUTH_FAIL' });
    setStorePass(s.db, 'newpass');   // migrate 用的 helper
    assert.strictEqual(s.actions.dispatch({ action: 'bootstrap', pass: 'newpass' }, '1.1.1.1').ok, true);
  } finally { s.cleanup(); }
});

test('通行碼只存 scrypt 雜湊，不存明碼', () => {
  const s = setup();
  try {
    const dump = JSON.stringify(s.db.prepare('SELECT * FROM settings').all());
    assert.ok(!dump.includes(STORE) && !dump.includes(ADMIN));
    const h = getSetting(s.db, 'store_pass_hash');
    assert.match(h, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    assert.ok(verifyPassword(STORE, h)); assert.ok(!verifyPassword(STORE + 'x', h));
  } finally { s.cleanup(); }
});

test('ADMIN_INIT：DB 沒有管理碼時寫入一次；已有就不覆蓋', () => {
  const env = tmpEnv({ ADMIN_INIT: 'first-admin' });
  try {
    const db = openDb(env.cfg.DATA_DIR);
    assert.strictEqual(getSetting(db, 'admin_pass_hash'), null);
    ensureAdminInit(db, env.cfg);
    const h1 = getSetting(db, 'admin_pass_hash');
    assert.ok(verifyPassword('first-admin', h1));
    ensureAdminInit(db, Object.assign({}, env.cfg, { ADMIN_INIT: 'other' }));
    assert.strictEqual(getSetting(db, 'admin_pass_hash'), h1);
    ensureAdminInit(db, Object.assign({}, env.cfg, { ADMIN_INIT: '' }));
    db.close();
    const env2 = tmpEnv({ ADMIN_INIT: '' });
    const db2 = openDb(env2.cfg.DATA_DIR); ensureAdminInit(db2, env2.cfg);
    assert.strictEqual(getSetting(db2, 'admin_pass_hash'), null);   // 沒設 ADMIN_INIT 就不寫
    db2.close(); env2.cleanup();
  } finally { env.cleanup(); }
});

test('adminGet：回科目與店別，錯管理碼 AUTH_FAIL，店長碼不能當管理碼', () => {
  const s = setup();
  try {
    const g = s.actions.dispatch({ action: 'adminGet', adminPass: ADMIN }, '1.1.1.1');
    assert.strictEqual(g.ok, true); assert.strictEqual(g.store, '新竹光復'); assert.strictEqual(g.expenseSubjects.length, 12); assert.strictEqual(g.incomeSubjects.length, 4);
    assert.strictEqual(s.actions.dispatch({ action: 'adminGet', adminPass: 'nope' }, '1.1.1.1').error, 'AUTH_FAIL');
    assert.strictEqual(s.actions.dispatch({ action: 'adminGet', adminPass: STORE }, '1.1.1.1').error, 'AUTH_FAIL');
    assert.strictEqual(s.actions.dispatch({ action: 'adminGet', pass: ADMIN }, '1.1.1.1').error, 'AUTH_FAIL');   // 欄位名要 adminPass
    assert.strictEqual(s.actions.dispatch({ action: 'bootstrap', pass: ADMIN }, '1.1.1.1').error, 'AUTH_FAIL');
  } finally { s.cleanup(); }
});

test('adminSave 改店長碼後舊碼 AUTH_FAIL、新碼可用；改科目後 bootstrap 反映', () => {
  const s = setup();
  try {
    const out = s.actions.dispatch({ action: 'adminSave', adminPass: ADMIN, expenseSubjects: [' 食材 ', '瓦斯', '瓦斯', '新科目'], incomeSubjects: ['回收收入'], newStorePass: 'brand-new' }, '1.1.1.1');
    assert.strictEqual(out.ok, true); assert.deepStrictEqual(out.expenseSubjects, ['食材', '瓦斯', '新科目']);
    assert.deepStrictEqual(s.call('bootstrap'), { ok: false, error: 'AUTH_FAIL' });   // 舊碼
    const b = s.actions.dispatch({ action: 'bootstrap', pass: 'brand-new' }, '1.1.1.1');
    assert.strictEqual(b.ok, true); assert.deepStrictEqual(b.settings.expenseSubjects, ['食材', '瓦斯', '新科目']); assert.deepStrictEqual(b.settings.incomeSubjects, ['回收收入']);
    // 改管理碼
    assert.strictEqual(s.actions.dispatch({ action: 'adminSave', adminPass: ADMIN, newAdminPass: 'admin-2' }, '1.1.1.1').ok, true);
    assert.strictEqual(s.actions.dispatch({ action: 'adminGet', adminPass: ADMIN }, '1.1.1.1').error, 'AUTH_FAIL');
    assert.strictEqual(s.actions.dispatch({ action: 'adminGet', adminPass: 'admin-2' }, '1.1.1.1').ok, true);
  } finally { s.cleanup(); }
});

test('adminSave 驗證：通行碼至少 4 碼、科目清單格式錯 → BAD_INPUT 且什麼都不寫', () => {
  const s = setup();
  try {
    const before = JSON.stringify(s.db.prepare('SELECT * FROM settings ORDER BY key').all());
    for (const bad of [{ newStorePass: 'abc' }, { newAdminPass: 'ab' }, { expenseSubjects: [] }, { expenseSubjects: 'x' }, { expenseSubjects: ['a', ''] }, { incomeSubjects: [1] },
      { expenseSubjects: ['ok'], newStorePass: '123' }]) {
      assert.deepStrictEqual(s.actions.dispatch(Object.assign({ action: 'adminSave', adminPass: ADMIN }, bad), '1.1.1.1'), { ok: false, error: 'BAD_INPUT' }, JSON.stringify(bad));
    }
    assert.strictEqual(JSON.stringify(s.db.prepare('SELECT * FROM settings ORDER BY key').all()), before);
    assert.strictEqual(s.actions.dispatch({ action: 'adminSave', adminPass: ADMIN, newStorePass: 'abcd' }, '1.1.1.1').ok, true);   // 4 碼剛好可
  } finally { s.cleanup(); }
});

test('回應永不含通行碼或雜湊（含成功與各種失敗）', () => {
  const s = setup();
  try {
    const seen = [];
    seen.push(s.call('bootstrap'), s.call('create', mk()), s.call('list', { month: '2026-10' }), s.call('nope'), s.call('bootstrap', {}, '2.2.2.2'));
    seen.push(s.actions.dispatch({ action: 'bootstrap', pass: 'secretWrong' }, '3.3.3.3'));
    seen.push(s.actions.dispatch({ action: 'adminGet', adminPass: ADMIN }, '1.1.1.1'));
    seen.push(s.actions.dispatch({ action: 'adminSave', adminPass: ADMIN, newStorePass: 'zzzz-new', newAdminPass: 'yyyy-new' }, '1.1.1.1'));
    seen.push(s.actions.dispatch({ action: 'adminSave', adminPass: ADMIN, newStorePass: 'x' }, '1.1.1.1'));
    seen.push(s.actions.dispatch({ action: 'pnlSummary', key: 'secretKey', month: '2026-10' }));
    seen.push(s.actions.dispatch(null), s.actions.dispatch([1]));
    const all = JSON.stringify(seen);
    for (const secret of [STORE, ADMIN, 'secretWrong', 'zzzz-new', 'yyyy-new', 'secretKey', 'scrypt$', 'pass_hash']) assert.ok(!all.includes(secret), secret);
  } finally { s.cleanup(); }
});

test('管理碼錯誤與店長碼共用同一來源的失敗鎖', () => {
  const s = setup();
  try {
    for (let i = 0; i < 20; i++) s.actions.dispatch({ action: i % 2 ? 'adminGet' : 'bootstrap', pass: 'x', adminPass: 'x' }, '7.7.7.7');
    assert.strictEqual(s.actions.dispatch({ action: 'adminGet', adminPass: ADMIN }, '7.7.7.7').error, 'AUTH_LOCKED');
  } finally { s.cleanup(); }
});

test('verifyPassword：雜湊段空白或長度不是 64 bytes 一律 false', () => {
  const salt = '00'.repeat(16);
  for (const stored of [`scrypt$${salt}$`, `scrypt$${salt}$${'ab'.repeat(32)}`, `scrypt$${salt}$${'ab'.repeat(63)}`, `scrypt$${salt}$${'ab'.repeat(65)}`, 'scrypt$$', 'scrypt', '', null, undefined]) {
    assert.strictEqual(verifyPassword('', stored), false, String(stored));
    assert.strictEqual(verifyPassword('anything', stored), false, String(stored));
  }
  const s = setup();
  try {   // DB 裡被手改成空雜湊：任何通行碼都不能過
    s.db.prepare("UPDATE settings SET value = ? WHERE key = 'store_pass_hash'").run(`scrypt$${salt}$`);
    assert.strictEqual(s.actions.dispatch({ action: 'bootstrap', pass: 'whatever' }, '1.1.1.1').error, 'AUTH_FAIL');
  } finally { s.cleanup(); }
});
