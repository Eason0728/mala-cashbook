/* 裁判：FROZEN 凍結寫入（MOVED）與 importRows 回退匯入。
 * 用 Node vm 載真的 Code.gs 進假 GAS 全域。用法：node test/frozenImport.test.js */
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');
var pass = 0, fail = 0, fails = [];
function eq(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; fails.push('  ✗ ' + name + '\n      期望 ' + JSON.stringify(want) + '\n      實得 ' + JSON.stringify(got)); }
}
function pad(n) { return String(n).padStart(2, '0'); }
var Utilities = {
  formatDate: function (date, tz, fmt) {
    var d = new Date(date.getTime() + 8 * 3600 * 1000);
    var ymd = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
    if (fmt === 'yyyy-MM-dd') return ymd;
    return ymd + 'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + '+08:00';
  }
};
var HDR = ['單號', '店別', '日期', '收支別', '科目', '項目名稱', '金額', '發票', '未稅價', '稅額', '收據編號', '照片連結', '填表人', '登記時間', '狀態', '作廢時間', '作廢原因'];
function makeSheet(rows) {
  return {
    _rows: rows.map(function (r) { return r.slice(); }), _writes: 0,
    getDataRange: function () { var s = this; return { getValues: function () { return s._rows.map(function (r) { return r.slice(); }); } }; },
    getLastRow: function () { return this._rows.length; },
    appendRow: function (r) { this._writes++; this._rows.push(r.slice()); },
    getRange: function (row, col, nr, nc) {
      var s = this;
      return {
        setValue: function (v) { s._writes++; s._rows[row - 1][col - 1] = v; },
        setValues: function (vs) { s._writes++; vs[0].forEach(function (v, i) { s._rows[row - 1][col - 1 + i] = v; }); }
      };
    }
  };
}
function fresh() {
  return {
    '明細': makeSheet([HDR, ['2026-09-001', '新竹光復', '2026-09-01', '支出', '食材', '豬肉', 1000, '無', 1000, 0, 1, '', '店長', '2026-09-01T09:00:00+08:00', '正常', '', '']]),
    '設定': makeSheet([['鍵', '值'], ['通行碼', 'p'], ['店別', '新竹光復'], ['支出科目', '食材'], ['收入科目', '回收收入'], ['照片資料夾ID', '']]),
    '月結': makeSheet([['月份', '狀態', '鎖定時間']]),
    '常用項目': makeSheet([['科目', '項目名稱', '使用次數', '最後使用時間']])
  };
}
function load(sheets, props, lockCalls) {
  var src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  var sb = {
    SpreadsheetApp: { getActiveSpreadsheet: function () { return { getSheetByName: function (n) { return sheets[n] || null; } }; } },
    PropertiesService: { getScriptProperties: function () { return { getProperty: function (k) { return props.hasOwnProperty(k) ? props[k] : null; } }; } },
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: function (t) { return { setMimeType: function () { return this; }, _text: t }; } },
    Utilities: Utilities,
    CacheService: { getScriptCache: function () { return { get: function () { return null; }, put: function () {} }; } },
    LockService: { getScriptLock: function () { return { tryLock: function () { lockCalls.n++; return true; }, releaseLock: function () {} }; } },
    console: console
  };
  vm.createContext(sb);
  vm.runInContext(src, sb, { filename: 'Code.gs' });
  return sb;
}
function call(sb, body) { return JSON.parse(sb.doPost({ postData: { contents: JSON.stringify(body) } })._text); }
var CREATE = { action: 'create', pass: 'p', date: '2026-09-24', kind: '支出', subject: '食材', name: '菜', amount: 300, hasInvoice: false };
function rowObj(id, amount) {
  return { id: id, store: '新竹光復', date: '2026-10-05', kind: '支出', subject: '食材', name: 'x', amount: amount, hasInvoice: true, net: 286, tax: 14, seq: 2, photo: '', author: '店長', createdAt: '2026-10-05T09:00:00+08:00', status: '正常', voidedAt: '', voidReason: '' };
}

(function () { // FROZEN=1
  var sh = fresh(), lc = { n: 0 }, sb = load(sh, { FROZEN: '1' }, lc);
  var before = JSON.stringify(sh['明細']._rows);
  var r = call(sb, CREATE);
  eq('FROZEN create → MOVED', r, { ok: false, error: 'MOVED' });
  ['update', 'void', 'lock', 'unlock'].forEach(function (a) {
    eq('FROZEN ' + a + ' → MOVED', call(sb, { action: a, pass: 'p', id: '2026-09-001', month: '2026-09' }), { ok: false, error: 'MOVED' });
  });
  eq('FROZEN 沒拿鎖', lc.n, 0);
  eq('FROZEN 試算表沒變', JSON.stringify(sh['明細']._rows), before);
  eq('FROZEN 沒寫任何分頁', sh['明細']._writes + sh['常用項目']._writes + sh['月結']._writes, 0);
  var l = call(sb, { action: 'list', pass: 'p', month: '2026-09' });
  eq('FROZEN list 照常', [l.ok, l.rows.length], [true, 1]);
  eq('FROZEN bootstrap 照常', call(sb, { action: 'bootstrap', pass: 'p' }).ok, true);
})();

(function () { // FROZEN 未設 / 非 1
  var sh = fresh(), lc = { n: 0 }, sb = load(sh, {}, lc);
  var r = call(sb, CREATE);
  eq('未凍結 create 正常', r.ok, true);
  eq('未凍結 明細多一列', sh['明細']._rows.length, 3);
  var sb2 = load(fresh(), { FROZEN: '0' }, { n: 0 });
  eq('FROZEN=0 create 正常', call(sb2, CREATE).ok, true);
})();

(function () { // importRows 認證
  var sh = fresh(), lc = { n: 0 };
  var sbNo = load(sh, {}, lc);
  eq('未設 ROLLBACK_KEY → AUTH', call(sbNo, { action: 'importRows', key: '', rows: [] }), { ok: false, error: 'AUTH' });
  eq('未設且 key 缺 → AUTH', call(sbNo, { action: 'importRows', rows: [] }), { ok: false, error: 'AUTH' });
  var sbEmpty = load(sh, { ROLLBACK_KEY: '' }, lc);
  eq('ROLLBACK_KEY 空字串 → AUTH', call(sbEmpty, { action: 'importRows', key: '', rows: [] }), { ok: false, error: 'AUTH' });
  var sb = load(sh, { ROLLBACK_KEY: 'secret-1', FROZEN: '1' }, lc);
  eq('錯金鑰 → AUTH', call(sb, { action: 'importRows', key: 'secret-2', rows: [rowObj('a', 1)] }), { ok: false, error: 'AUTH' });
  eq('長度不同 → AUTH', call(sb, { action: 'importRows', key: 'secret', rows: [] }), { ok: false, error: 'AUTH' });
  eq('店長通行碼不能代替 → AUTH', call(sb, { action: 'importRows', pass: 'p', rows: [] }), { ok: false, error: 'AUTH' });
  eq('認證失敗沒寫入', sh['明細']._writes, 0);
})();

(function () { // upsert（FROZEN=1 仍允許）
  var sh = fresh(), lc = { n: 0 }, sb = load(sh, { ROLLBACK_KEY: 'k3y', FROZEN: '1' }, lc);
  var r = call(sb, { action: 'importRows', key: 'k3y', rows: [rowObj('2026-09-001', 555), rowObj('2026-10-001', 700)] });
  eq('計數 1 新增 1 覆寫', r, { inserted: 1, updated: 1, ok: true });
  eq('有拿鎖', lc.n, 1);
  var rows = sh['明細']._rows;
  eq('總列數 3', rows.length, 3);
  eq('覆寫整列 17 欄', rows[1], ['2026-09-001', '新竹光復', '2026-10-05', '支出', '食材', 'x', 555, '有', 286, 14, 2, '', '店長', '2026-10-05T09:00:00+08:00', '正常', '', '']);
  eq('新列 append', [rows[2][0], rows[2][6]], ['2026-10-001', 700]);
  var r2 = call(sb, { action: 'importRows', key: 'k3y', rows: [rowObj('2026-10-001', 800), rowObj('2026-10-001', 900)] });
  eq('再匯一次：全是覆寫', r2, { inserted: 0, updated: 2, ok: true });
  eq('最後一筆生效且不增列', [rows.length, rows[2][6]], [3, 900]);
  var r3 = call(sb, { action: 'importRows', key: 'k3y', rows: [{ id: 'n1' }, { id: 'n1' }].map(function (o) { return rowObj(o.id, 5); }) });
  eq('同批重複新 id：1 新增 1 覆寫', r3, { inserted: 1, updated: 1, ok: true });
})();

(function () { // 上限與壞資料
  var sh = fresh(), sb = load(sh, { ROLLBACK_KEY: 'k' }, { n: 0 });
  var many = []; for (var i = 0; i < 2001; i++) many.push(rowObj('id' + i, 1));
  eq('2001 筆 → BAD_INPUT', call(sb, { action: 'importRows', key: 'k', rows: many }), { ok: false, error: 'BAD_INPUT' });
  eq('超量沒寫入', sh['明細']._writes, 0);
  eq('2000 筆可', call(sb, { action: 'importRows', key: 'k', rows: many.slice(0, 2000) }).inserted, 2000);
  eq('rows 非陣列 → BAD_INPUT', call(sb, { action: 'importRows', key: 'k', rows: 'x' }).error, 'BAD_INPUT');
  var sh2 = fresh(), sb2 = load(sh2, { ROLLBACK_KEY: 'k' }, { n: 0 });
  eq('有壞筆整批不寫', [call(sb2, { action: 'importRows', key: 'k', rows: [rowObj('ok', 1), {}] }).error, sh2['明細']._writes], ['BAD_INPUT', 0]);
})();

console.log('\n通過 ' + pass + ' / 共 ' + (pass + fail));
if (fail) { console.log(fails.join('\n')); process.exit(1); }
