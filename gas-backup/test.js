'use strict';
// node gas-backup/test.js — 用 vm 載入 Code.js，mock Apps Script 服務
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

let passed = 0;
const J = (x) => JSON.parse(JSON.stringify(x));   // vm 內的陣列屬於另一個 realm，先轉成本 realm 再比 deepStrictEqual
function t(name, fn) { try { fn(); passed++; console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n' + e.stack); process.exitCode = 1; } }

function makeEnv(props, failOn) {
  const sheets = {}, files = {}, cache = {};
  const mkSheet = (name) => ({ name, cleared: 0, setName(n) { delete sheets[this.name]; this.name = n; sheets[n] = this; }, values: [], fmts: [], frozen: 0,
    clear() { this.cleared++; this.values = []; }, setFrozenRows(n) { this.frozen = n; },
    getRange(r, c, nr, nc) { const s = this; return { setNumberFormats(f) { s.fmts = f; }, setValues(v) { if (failOn && s.name === failOn) throw new Error('quota');  assert.strictEqual(v.length, nr); assert.strictEqual(v[0].length, nc); s.values = v; } }; } });
  const book = { getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => { if (sheets[n]) throw new Error('dup sheet'); return (sheets[n] = mkSheet(n)); }, deleteSheet: (sh) => { delete sheets[sh.name]; }, getSheets: () => Object.values(sheets), getId: () => 'SID', getUrl: () => 'u' };
  const folder = { getId: () => 'FID', getUrl: () => 'u', getFilesByName: (n) => { const l = n in files ? [files[n]] : []; let i = 0; return { hasNext: () => i < l.length, next: () => l[i++] }; }, createFile: (b) => { b.isTrashed = () => !!b.trashed; files[b.name] = b; return {}; } };
  let created = { ss: 0, folder: 0 };
  const ctx = {
    console, Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    CacheService: { getScriptCache: () => ({ get: (k) => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = v; }, remove: (k) => { delete cache[k]; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    SpreadsheetApp: { create: () => { created.ss++; return book; }, openById: () => book },
    DriveApp: { createFolder: () => { created.folder++; return folder; }, getFolderById: () => folder },
    Utilities: { base64Decode: (s) => Buffer.from(s, 'base64'), newBlob: (data, type, name) => ({ data, type, name }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ s, setMimeType() { return this; } }) }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.js'), 'utf8'), ctx);
  const post = (o) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(o) } }).s);
  return { ctx, sheets, files, props, created, post };
}

const HDR = ['單號', '店別', '日期', '收支別', '科目', '項目名稱', '金額', '發票', '未稅價', '稅額', '收據編號', '照片連結', '填表人', '登記時間', '狀態', '作廢時間', '作廢原因'];
const row = (id, name) => [id, '新竹光復', '2026-10-02', '支出', '食材', name, 105, '有', 100, 5, 1, '', '店長', '2026-10-02T10:00:00+08:00', '正常', '', ''];
const body = (key, extra) => Object.assign({ action: 'backup', key, rows: [HDR, row('2026-10-001', '豆皮'), row('2026-10-002', '=1+1')], frequent: [['食材', '豆皮', 2, '2026-10-02T10:00:00+08:00']], locks: [['2026-09', '鎖定', '']], subjects: { expense: ['食材', '雜支'], income: ['回收收入'] } }, extra || {});

t('setup 建試算表與資料夾、ID 存屬性、重跑不重建', () => {
  const e = makeEnv({ BACKUP_KEY: 'k' });
  e.ctx.setup(); e.ctx.setup();
  assert.strictEqual(e.props.SHEET_ID, 'SID'); assert.strictEqual(e.props.FOLDER_ID, 'FID');
  assert.deepStrictEqual(J(e.created), { ss: 1, folder: 1 });
});
t('backup：四分頁表頭與列數正確、公式字樣加引號、凍結首列', () => {
  const e = makeEnv({ BACKUP_KEY: 'k', SHEET_ID: 'SID', FOLDER_ID: 'FID' });
  const r = e.post(body('k'));
  assert.deepStrictEqual(r, { ok: true, data: { rows: 2, frequent: 1, locks: 1, subjects: 3 } });
  assert.deepStrictEqual(J(Object.keys(e.sheets)), ['明細', '常用項目', '月結', '科目']);
  assert.deepStrictEqual(J(e.sheets['明細'].values[0]), HDR); assert.strictEqual(e.sheets['明細'].values.length, 3);
  assert.strictEqual(e.sheets['明細'].values[2][5], "'=1+1");
  assert.strictEqual(e.sheets['明細'].values[1][6], 105);
  assert.deepStrictEqual(J(e.sheets['常用項目'].values[0]), ['科目', '項目名稱', '使用次數', '最後使用時間']); assert.strictEqual(e.sheets['常用項目'].values.length, 2);
  assert.deepStrictEqual(J(e.sheets['月結'].values[0]), ['月份', '狀態', '鎖定時間']); assert.strictEqual(e.sheets['月結'].values.length, 2);
  assert.deepStrictEqual(J(e.sheets['科目'].values), [['收支別', '科目'], ['支出', '食材'], ['支出', '雜支'], ['收入', '回收收入']]);
  assert.ok(Object.values(e.sheets).every((s) => s.frozen === 1));
  assert.ok(!('明細_new' in e.sheets), '暫名分頁要改名掉');
});
t('backup 跑兩次結果相同（整頁覆蓋），資料變少時舊列被清掉', () => {
  const e = makeEnv({ BACKUP_KEY: 'k', SHEET_ID: 'SID', FOLDER_ID: 'FID' });
  e.post(body('k')); const first = JSON.stringify(e.sheets['明細'].values);
  e.post(body('k')); assert.strictEqual(JSON.stringify(e.sheets['明細'].values), first);
  e.post(body('k', { rows: [HDR], frequent: [], locks: [] }));
  assert.strictEqual(e.sheets['明細'].values.length, 1); assert.strictEqual(e.sheets['月結'].values.length, 1);
});
t('金鑰錯／沒帶／BACKUP_KEY 沒設 → AUTH', () => {
  const e = makeEnv({ BACKUP_KEY: 'k', SHEET_ID: 'SID' });
  assert.strictEqual(e.post(body('wrong')).code, 'AUTH');
  assert.strictEqual(e.post(body('kk')).code, 'AUTH');
  assert.strictEqual(e.post(Object.assign(body('k'), { key: undefined })).code, 'AUTH');
  assert.strictEqual(e.sheets['明細'], undefined);
  const e2 = makeEnv({ SHEET_ID: 'SID' });
  assert.strictEqual(e2.post(body('')).code, 'AUTH'); assert.strictEqual(e2.post(body('anything')).code, 'AUTH');
  const e3 = makeEnv({ BACKUP_KEY: '', SHEET_ID: 'SID' });
  assert.strictEqual(e3.post(body('')).code, 'AUTH');
});
t('錯 20 次後連正確金鑰也被鎖', () => {
  const e = makeEnv({ BACKUP_KEY: 'k', SHEET_ID: 'SID' });
  for (let i = 0; i < 20; i++) e.post(body('bad'));
  assert.strictEqual(e.post(body('k')).code, 'LOCKED');
});
t('格式錯（欄數不對、物件格、科目非陣列）→ BAD_REQ 且不寫入', () => {
  const e = makeEnv({ BACKUP_KEY: 'k', SHEET_ID: 'SID' });
  assert.strictEqual(e.post(body('k', { rows: [HDR, ['a']] })).code, 'BAD_REQ');
  const bad = row('x', 'y'); bad[5] = { a: 1 };
  assert.strictEqual(e.post(body('k', { rows: [HDR, bad] })).code, 'BAD_REQ');
  assert.strictEqual(e.post(body('k', { subjects: { expense: 'x', income: [] } })).code, 'BAD_REQ');
  assert.strictEqual(e.post({ action: 'nope', key: 'k' }).code, 'BAD_REQ');
  assert.strictEqual(e.sheets['明細'], undefined);
});
t('單格截 300 字', () => {
  const e = makeEnv({ BACKUP_KEY: 'k', SHEET_ID: 'SID' });
  e.post(body('k', { rows: [HDR, row('2026-10-001', 'x'.repeat(500))] }));
  assert.strictEqual(e.sheets['明細'].values[1][5].length, 300);
});
t('photo：存檔、同名再傳略過（冪等）、壞檔名拒絕、金鑰錯 AUTH', () => {
  const e = makeEnv({ BACKUP_KEY: 'k', FOLDER_ID: 'FID' });
  const name = '2026-10-001_' + 'a'.repeat(32) + '.jpg';
  const b64 = Buffer.from('jpgdata').toString('base64');
  assert.deepStrictEqual(e.post({ action: 'photo', key: 'k', name, base64: b64 }).data, { name, skipped: false });
  assert.deepStrictEqual(e.post({ action: 'photo', key: 'k', name, base64: b64 }).data, { name, skipped: true });
  assert.strictEqual(Object.keys(e.files).length, 1);
  assert.strictEqual(e.files[name].data.toString(), 'jpgdata');
  assert.strictEqual(e.post({ action: 'photo', key: 'k', name: '../x.jpg', base64: b64 }).code, 'BAD_REQ');
  assert.strictEqual(e.post({ action: 'photo', key: 'bad', name: 'z.jpg', base64: b64 }).code, 'AUTH');
});
t('整頁覆蓋：寫入中途失敗 → 舊備份原封不動、回 SERVER、下次可重跑', () => {
  const props = { BACKUP_KEY: 'k', SHEET_ID: 'SID' };
  const e = makeEnv(props);
  e.post(body('k')); const before = JSON.stringify(e.sheets['明細'].values);
  const e2 = makeEnv(props, '科目_new');
  Object.assign(e2.sheets, e.sheets);              // 帶著上次成功的四個分頁
  const r = e2.post(body('k', { rows: [HDR] }));
  assert.strictEqual(r.code, 'SERVER');
  assert.strictEqual(JSON.stringify(e2.sheets['明細'].values), before);
  const e3 = makeEnv(props); Object.assign(e3.sheets, e2.sheets);   // 殘留 *_new 也不擋下一次
  assert.strictEqual(e3.post(body('k', { rows: [HDR] })).ok, true);
  assert.strictEqual(e3.sheets['明細'].values.length, 1); assert.ok(!('明細_new' in e3.sheets));
});
t('photo：垃圾桶裡的同名檔不算已備份，會重存', () => {
  const e = makeEnv({ BACKUP_KEY: 'k', FOLDER_ID: 'FID' });
  const name = '2026-10-001_' + 'b'.repeat(32) + '.jpg', b64 = Buffer.from('x').toString('base64');
  e.post({ action: 'photo', key: 'k', name, base64: b64 });
  e.files[name].trashed = true;
  assert.strictEqual(e.post({ action: 'photo', key: 'k', name, base64: b64 }).data.skipped, false);
});
console.log('\n' + passed + ' 項通過' + (process.exitCode ? '，有失敗' : '，全綠'));
