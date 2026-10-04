'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');
const { setup, STORE, PNL, JPG } = require('./helpers');
const { splitTax } = require('../actions');

const mk = (o) => Object.assign({ date: '2026-10-03', kind: '支出', subject: '瓦斯', name: '桶裝瓦斯', amount: 1050, hasInvoice: true }, o || {});

test('稅額：有發票含稅回推未稅、稅額相減；無發票未稅＝金額、稅額 0', () => {
  assert.deepStrictEqual(splitTax(1050, true), { net: 1000, tax: 50 });
  assert.deepStrictEqual(splitTax(100, true), { net: 95, tax: 5 });
  assert.deepStrictEqual(splitTax(1, true), { net: 1, tax: 0 });
  assert.deepStrictEqual(splitTax(500, false), { net: 500, tax: 0 });
  const s = setup();
  try {
    const a = s.call('create', mk({ amount: 1000, hasInvoice: true })).row;
    assert.strictEqual(a.net + a.tax, a.amount); assert.strictEqual(a.net, 952); assert.strictEqual(a.tax, 48); assert.strictEqual(a.hasInvoice, true);
    const b = s.call('create', mk({ amount: 333, hasInvoice: false })).row;
    assert.deepStrictEqual([b.net, b.tax, b.hasInvoice], [333, 0, false]);
    const c = s.call('create', mk({ amount: '88.6' })).row;   // 金額四捨五入成整數
    assert.strictEqual(c.amount, 89);
  } finally { s.cleanup(); }
});

test('單號 YYYY-MM-NNN 與收據編號：依月與收支別各自遞增', () => {
  const s = setup();
  try {
    const r1 = s.call('create', mk()).row, r2 = s.call('create', mk({ kind: '收入', subject: '回收收入', name: '紙箱' })).row;
    const r3 = s.call('create', mk()).row, r4 = s.call('create', mk({ kind: '收入', subject: '回收收入', name: '紙箱' })).row;
    assert.deepStrictEqual([r1.id, r2.id, r3.id, r4.id], ['2026-10-001', '2026-10-002', '2026-10-003', '2026-10-004']);
    assert.deepStrictEqual([r1.seq, r2.seq, r3.seq, r4.seq], [1, 1, 2, 2]);
    const n = s.call('create', mk({ date: '2026-11-01' })).row;   // 另一個月重新計
    assert.deepStrictEqual([n.id, n.seq], ['2026-11-001', 1]);
    s.call('void', { id: r3.id, reason: 'x' });   // 作廢的列仍占號
    assert.strictEqual(s.call('create', mk()).row.seq, 3);
    assert.strictEqual(s.call('create', mk()).row.id, '2026-10-006');
  } finally { s.cleanup(); }
});

test('create 回應形狀：row 欄位、frequent、author、createdAt 格式', () => {
  const s = setup();
  try {
    const out = s.call('create', mk());
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(Object.keys(out.row).sort(), ['amount', 'author', 'createdAt', 'date', 'hasInvoice', 'id', 'kind', 'name', 'net', 'photo', 'seq', 'status', 'store', 'subject', 'tax'].sort());
    assert.strictEqual(out.row.author, '店長'); assert.strictEqual(out.row.status, '正常'); assert.strictEqual(out.row.store, '新竹光復'); assert.strictEqual(out.row.photo, '');
    assert.match(out.row.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
    assert.strictEqual(out.row.createdAt, '2026-10-04T20:00:00+08:00');   // 12:00Z → 台北 20:00
    assert.deepStrictEqual(out.frequent, [{ subject: '瓦斯', name: '桶裝瓦斯', count: 1, lastUsed: '2026-10-04T20:00:00+08:00' }]);
    assert.strictEqual(out.warning, undefined);
  } finally { s.cleanup(); }
});

test('輸入檢查：缺欄位、金額<=0、壞日期、壞 kind 回 BAD_INPUT', () => {
  const s = setup();
  try {
    for (const bad of [{ date: '' }, { subject: '' }, { name: '' }, { amount: 0 }, { amount: -5 }, { amount: 'abc' }, { date: '2026/10/03' }, { kind: '其他' }]) {
      assert.deepStrictEqual(s.call('create', mk(bad)), { ok: false, error: 'BAD_INPUT' }, JSON.stringify(bad));
    }
    assert.deepStrictEqual(s.call('nope'), { ok: false, error: 'BAD_INPUT' });
    assert.strictEqual(s.db.prepare('SELECT COUNT(*) c FROM rows').get().c, 0);
  } finally { s.cleanup(); }
});

test('鎖定月拒寫：create/update/void 回 LOCKED，unlock 後恢復，list 仍可讀', () => {
  const s = setup();
  try {
    const r = s.call('create', mk()).row;
    assert.deepStrictEqual(s.call('lock', { month: '2026-10' }).lockedMonths, ['2026-10']);
    assert.deepStrictEqual(s.call('lock', { month: '2026-10' }).lockedMonths, ['2026-10']);   // 重複鎖不重複記
    assert.strictEqual(s.call('create', mk()).error, 'LOCKED');
    assert.strictEqual(s.call('update', { id: r.id, amount: 5 }).error, 'LOCKED');
    assert.strictEqual(s.call('void', { id: r.id }).error, 'LOCKED');
    s.call('lock', { month: '2026-11' });
    s.call('unlock', { month: '2026-11' });
    const r2 = s.call('create', mk({ date: '2026-11-02' }));   // 11 月已解鎖
    assert.strictEqual(r2.ok, true);
    s.call('lock', { month: '2026-11' });
    assert.strictEqual(s.call('update', { id: r2.row.id, date: '2026-10-05' }).error, 'LOCKED');   // 改去鎖定月也擋
    assert.strictEqual(s.call('list', { month: '2026-10' }).rows.length, 1);
    assert.deepStrictEqual(s.call('unlock', { month: '2026-10' }).lockedMonths, ['2026-11']);
    assert.strictEqual(s.call('lock', { month: 'bad' }).error, 'BAD_INPUT');
  } finally { s.cleanup(); }
});

test('作廢留痕：只改狀態、保留資料列與原單號，帶時間與原因，不計入 pnl 合計', () => {
  const s = setup();
  try {
    const a = s.call('create', mk({ amount: 1000 })).row, b = s.call('create', mk({ amount: 500 })).row;
    s.clock.ms += 60e3;
    const v = s.call('void', { id: a.id, reason: '記錯了' });
    assert.strictEqual(v.row.status, '作廢'); assert.strictEqual(v.row.voidReason, '記錯了'); assert.strictEqual(v.row.voidedAt, '2026-10-04T20:01:00+08:00');
    assert.strictEqual(v.row.amount, 1000); assert.strictEqual(v.row.id, a.id);
    const rows = s.call('list', { month: '2026-10' }).rows;
    assert.strictEqual(rows.length, 2);   // 資料列永遠留著
    assert.strictEqual(rows.find((r) => r.id === a.id).status, '作廢');
    assert.strictEqual(rows.find((r) => r.id === b.id).voidedAt, '');   // 正常列 voidedAt 是空字串（同 Code.gs 讀到空儲存格）
    const p = s.actions.dispatch({ action: 'pnlSummary', key: PNL, month: '2026-10' });
    assert.strictEqual(p.expense['瓦斯'], 500); assert.strictEqual(p.rows, 1);
    assert.deepStrictEqual(s.call('void', { id: 'nope' }), { ok: false, error: 'NOT_FOUND' });
  } finally { s.cleanup(); }
});

test('clientToken 冪等：重送回 duplicate:true、不多記一筆、frequent 次數不變、鎖月後仍回原帳', () => {
  const s = setup();
  try {
    const first = s.call('create', mk({ clientToken: 'tok-1' }));
    assert.strictEqual(first.duplicate, undefined);
    const again = s.call('create', mk({ clientToken: 'tok-1', amount: 9999 }));
    assert.strictEqual(again.duplicate, true);
    assert.strictEqual(again.row.id, first.row.id); assert.strictEqual(again.row.amount, 1050);
    assert.strictEqual(again.frequent[0].count, 1);
    assert.strictEqual(s.db.prepare('SELECT COUNT(*) c FROM rows').get().c, 1);
    assert.strictEqual(s.db.prepare('SELECT count FROM frequent').get().count, 1);
    s.call('lock', { month: '2026-10' });
    assert.strictEqual(s.call('create', mk({ clientToken: 'tok-1' })).duplicate, true);
    // 永久保存：隔很久仍認得
    s.clock.ms += 30 * 86400e3;
    assert.strictEqual(s.call('create', mk({ clientToken: 'tok-1' })).duplicate, true);
    // 不同 token 是新帳；失敗的 create 不佔用 token
    s.call('unlock', { month: '2026-10' });
    assert.strictEqual(s.call('create', mk({ clientToken: 'tok-2', amount: 0 })).error, 'BAD_INPUT');
    assert.strictEqual(s.call('create', mk({ clientToken: 'tok-2' })).row.id, '2026-10-002');
    assert.strictEqual(s.db.prepare('SELECT COUNT(*) c FROM create_tokens').get().c, 2);
  } finally { s.cleanup(); }
});

test('frequent：同科目＋項目累計次數，依最後使用時間新到舊；lastUsed 為字串', () => {
  const s = setup();
  try {
    s.call('create', mk({ subject: '食材', name: '豆皮' })); s.clock.ms += 1000;
    s.call('create', mk({ subject: '瓦斯', name: '桶裝' })); s.clock.ms += 1000;
    const out = s.call('create', mk({ subject: '食材', name: '豆皮' }));
    assert.deepStrictEqual(out.frequent.map((f) => [f.subject, f.name, f.count]), [['食材', '豆皮', 2], ['瓦斯', '桶裝', 1]]);
    s.call('create', mk({ subject: 123, name: 456 }));   // 純數字也轉字串
    assert.ok(s.call('bootstrap').frequent.every((f) => typeof f.subject === 'string' && typeof f.name === 'string' && typeof f.lastUsed === 'string'));
  } finally { s.cleanup(); }
});

test('list 只回當月（依日期欄），bootstrap 帶 month 順便回當月明細', () => {
  const s = setup();
  try {
    s.call('create', mk({ date: '2026-09-30' })); s.call('create', mk({ date: '2026-10-01' })); s.call('create', mk({ date: '2026-10-31' })); s.call('create', mk({ date: '2026-11-01' }));
    assert.deepStrictEqual(s.call('list', { month: '2026-10' }).rows.map((r) => r.date), ['2026-10-01', '2026-10-31']);
    assert.deepStrictEqual(s.call('list', { month: '2026-12' }).rows, []);
    const b = s.call('bootstrap', { month: '2026-09' });
    assert.strictEqual(b.month, '2026-09'); assert.strictEqual(b.rows.length, 1);
    const b0 = s.call('bootstrap');
    assert.strictEqual(b0.rows, undefined); assert.strictEqual(b0.month, undefined);
    assert.strictEqual(b0.settings.store, '新竹光復'); assert.strictEqual(b0.settings.expenseSubjects.length, 12); assert.ok(Array.isArray(b0.lockedMonths));
    assert.deepStrictEqual(Object.keys(b0.settings).sort(), ['expenseSubjects', 'incomeSubjects', 'store']);
  } finally { s.cleanup(); }
});

test('update：重算稅額、可改日期／科目／發票；沒帶的欄位維持；NOT_FOUND', () => {
  const s = setup();
  try {
    const r = s.call('create', mk({ amount: 1050, hasInvoice: true })).row;
    const u = s.call('update', { id: r.id, amount: 2100 }).row;
    assert.deepStrictEqual([u.amount, u.net, u.tax, u.hasInvoice, u.subject, u.seq, u.id], [2100, 2000, 100, true, '瓦斯', 1, r.id]);
    const u2 = s.call('update', { id: r.id, hasInvoice: false, subject: '水電', name: '電費', date: '2026-10-09' }).row;
    assert.deepStrictEqual([u2.net, u2.tax, u2.hasInvoice, u2.subject, u2.name, u2.date], [2100, 0, false, '水電', '電費', '2026-10-09']);
    assert.strictEqual(u2.voidedAt, ''); assert.strictEqual(u2.createdAt, r.createdAt);
    assert.strictEqual(s.call('update', { id: 'x' }).error, 'NOT_FOUND');
    assert.strictEqual(s.call('update', { id: r.id, amount: -1 }).error, 'BAD_INPUT');
    // update 不增加 frequent 次數
    assert.strictEqual(s.db.prepare('SELECT count FROM frequent').get().count, 1);
  } finally { s.cleanup(); }
});

test('單號撞號保護：日期被改到別月後再 create 不會重複單號', () => {
  const s = setup();
  try {
    const a = s.call('create', mk()).row, b = s.call('create', mk()).row, c = s.call('create', mk()).row;
    s.call('update', { id: b.id, date: '2026-11-02' });   // 10 月剩 001、003；count+1 = 3 會撞
    const d = s.call('create', mk());
    assert.strictEqual(d.ok, true); assert.strictEqual(d.row.id, '2026-10-004');
    assert.deepStrictEqual([a.id, c.id], ['2026-10-001', '2026-10-003']);
  } finally { s.cleanup(); }
});

test('pnlSummary：金鑰錯回 AUTH、月份格式錯 BAD_INPUT、不需通行碼、合計與 locked', () => {
  const s = setup();
  try {
    s.call('create', mk({ amount: 1000 })); s.call('create', mk({ amount: 200 })); s.call('create', mk({ kind: '收入', subject: '回收收入', name: '紙', amount: 70 }));
    s.call('lock', { month: '2026-10' });
    const ok = s.actions.dispatch({ action: 'pnlSummary', key: PNL, month: '2026-10' });
    assert.deepStrictEqual(ok, { month: '2026-10', store: '新竹光復', expense: { 瓦斯: 1200 }, income: { 回收收入: 70 }, rows: 3, skipped: 0, locked: true, ok: true });
    for (const key of ['wrong', undefined, 123, '', PNL + 'x', PNL.slice(1)]) {
      assert.deepStrictEqual(s.actions.dispatch({ action: 'pnlSummary', key, month: '2026-10' }), { ok: false, error: 'AUTH' });
    }
    assert.strictEqual(s.actions.dispatch({ action: 'pnlSummary', key: PNL, month: '2026-13' }).error, 'BAD_INPUT');
    assert.strictEqual(s.actions.dispatch({ action: 'pnlSummary', key: PNL }).error, 'BAD_INPUT');
    assert.strictEqual(s.actions.dispatch({ action: 'pnlSummary', key: PNL, month: '2026-09' }).locked, false);
  } finally { s.cleanup(); }
});

test('PNL_KEY 沒設定時 pnlSummary 一律 AUTH', () => {
  const s = setup({ env: { PNL_KEY: '' } });
  try { assert.strictEqual(s.actions.dispatch({ action: 'pnlSummary', key: '', month: '2026-10' }).error, 'AUTH'); } finally { s.cleanup(); }
});

test('照片：存成 photos/<32hex>.jpg、row.photo 為 PUBLIC_BASE 網址、photo_file 記 token', () => {
  const s = setup();
  try {
    const out = s.call('create', mk({ photoBase64: JPG }));
    assert.strictEqual(out.warning, undefined);
    const m = /^https:\/\/x\.example\/cashbook\/photo\/([0-9a-f]{32})\.jpg$/.exec(out.row.photo);
    assert.ok(m, out.row.photo);
    const f = path.join(s.cfg.DATA_DIR, 'photos', m[1] + '.jpg');
    assert.deepStrictEqual(fs.readFileSync(f), Buffer.from(JPG, 'base64'));
    assert.strictEqual(s.db.prepare('SELECT photo_file FROM rows').get().photo_file, m[1]);
    // data URL 前綴也接受
    assert.strictEqual(s.call('create', mk({ photoBase64: 'data:image/jpeg;base64,' + JPG })).row.photo.length > 0, true);
  } finally { s.cleanup(); }
});

test('照片寫檔失敗：帳照記、回 warning:PHOTO_FAIL、photo 空、photo_file 空', () => {
  const s = setup({ writePhoto() { throw new Error('disk full'); } });
  try {
    const out = s.call('create', mk({ photoBase64: JPG }));
    assert.strictEqual(out.ok, true); assert.strictEqual(out.warning, 'PHOTO_FAIL'); assert.strictEqual(out.row.photo, '');
    assert.strictEqual(s.db.prepare('SELECT COUNT(*) c FROM rows').get().c, 1);
    assert.strictEqual(s.db.prepare('SELECT photo_file FROM rows').get().photo_file, '');
  } finally { s.cleanup(); }
  const s2 = setup();   // 壞掉的 base64 一樣不擋帳
  try { const o = s2.call('create', mk({ photoBase64: '!!!not base64!!!' })); assert.strictEqual(o.ok, true); assert.strictEqual(o.warning, 'PHOTO_FAIL'); } finally { s2.cleanup(); }
});

test('READONLY 檔存在：所有寫入回 READONLY，讀取照常', () => {
  const s = setup();
  try {
    const r = s.call('create', mk()).row;
    fs.writeFileSync(path.join(s.cfg.DATA_DIR, 'READONLY'), '');
    for (const [a, p] of [['create', mk()], ['update', { id: r.id, amount: 5 }], ['void', { id: r.id }], ['lock', { month: '2026-10' }], ['unlock', { month: '2026-10' }]]) {
      assert.deepStrictEqual(s.call(a, p), { ok: false, error: 'READONLY' }, a);
    }
    assert.strictEqual(s.actions.dispatch({ action: 'adminSave', adminPass: 'admin-pass-1', expenseSubjects: ['a'] }).error, 'READONLY');
    assert.strictEqual(s.call('list', { month: '2026-10' }).rows.length, 1);
    assert.strictEqual(s.call('bootstrap').ok, true);
    fs.unlinkSync(path.join(s.cfg.DATA_DIR, 'READONLY'));
    assert.strictEqual(s.call('create', mk()).ok, true);
  } finally { s.cleanup(); }
});

test('寫入動作整個 transaction：中途出錯不留半筆（rows/frequent/token 一起回滾）', () => {
  const s = setup();
  try {
    s.db.exec('DROP TABLE create_tokens');   // 讓 create 的最後一步失敗
    const out = s.call('create', mk({ clientToken: 't' }));
    assert.deepStrictEqual(out, { ok: false, error: 'SERVER_ERROR' });
  } finally { s.cleanup(); }
  const s2 = setup();
  try {
    s2.db.exec('CREATE TRIGGER boom BEFORE INSERT ON frequent BEGIN SELECT RAISE(ABORT, \'x\'); END');
    assert.strictEqual(s2.call('create', mk()).error, 'SERVER_ERROR');
    assert.strictEqual(s2.db.prepare('SELECT COUNT(*) c FROM rows').get().c, 0);
  } finally { s2.cleanup(); }
});
