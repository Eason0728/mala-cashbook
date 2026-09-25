/* 裁判：mala-pnl-auto#13 pnlSummary 唯讀端點的本機 mock 測試。
 * 用 Node vm 把 apps-script/Code.gs 載進一個假的 GAS 全域（假 SpreadsheetApp／
 * PropertiesService／ContentService／Utilities），不連任何真試算表、不連網。
 * 用法：node test/pnlSummary.test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var pass = 0, fail = 0, fails = [];
function eq(name, got, want) {
  var ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; fails.push('  ✗ ' + name + '\n      期望 ' + JSON.stringify(want) + '\n      實得 ' + JSON.stringify(got)); }
}

// ---------- 假 SpreadsheetApp ----------

function pad(n) { return String(n).padStart(2, '0'); }

// 假 Utilities.formatDate：只需要對「Asia/Taipei」轉出 yyyy-MM-dd 這一種用法正確。
var Utilities = {
  formatDate: function (date, tz, fmt) {
    var d = new Date(date.getTime() + 8 * 3600 * 1000); // Asia/Taipei = UTC+8
    if (fmt === 'yyyy-MM-dd') {
      return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
    }
    return d.toISOString();
  },
  base64Decode: function () { throw new Error('WRITE_PATH_NOT_EXPECTED: base64Decode'); },
  base64Encode: function () { throw new Error('WRITE_PATH_NOT_EXPECTED: base64Encode'); },
  newBlob: function () { throw new Error('WRITE_PATH_NOT_EXPECTED: newBlob'); }
};

// HEADERS 順序：單號,店別,日期,收支別,科目,項目名稱,金額,發票,未稅價,稅額,收據編號,照片連結,填表人,登記時間,狀態,作廢時間,作廢原因
var 明細Rows = [
  ['單號', '店別', '日期', '收支別', '科目', '項目名稱', '金額', '發票', '未稅價', '稅額', '收據編號', '照片連結', '填表人', '登記時間', '狀態', '作廢時間', '作廢原因'],
  ['2026-09-001', '新竹光復', '2026-09-01', '支出', '食材', '豬肉', 1000, '無', 1000, 0, 1, '', '店長', '2026-09-01T09:00:00+08:00', '正常', '', ''],
  ['2026-09-002', '新竹光復', '2026-09-15', '支出', '食材', '蔬菜', 500, '無', 500, 0, 2, '', '店長', '2026-09-15T09:00:00+08:00', '正常', '', ''],
  // Date 物件型日期（不是字串）——issue 特別要求要測這種
  ['2026-09-003', '新竹光復', new Date('2026-09-10T12:00:00Z'), '收入', '回收收入', '紙箱', 200, '無', 200, 0, 1, '', '店長', '2026-09-10T20:00:00+08:00', '正常', '', ''],
  // 已作廢——不該計入
  ['2026-09-004', '新竹光復', '2026-09-05', '支出', '瓦斯', '瓦斯桶', 300, '無', 300, 0, 3, '', '店長', '2026-09-05T09:00:00+08:00', '作廢', '2026-09-06T09:00:00+08:00', '重複登記'],
  // 跨月——不該計入 2026-09
  ['2026-08-031', '新竹光復', '2026-08-31', '支出', '食材', '八月肉', 999, '無', 999, 0, 5, '', '店長', '2026-08-31T09:00:00+08:00', '正常', '', '']
];

var 設定Rows = [
  ['鍵', '值'],
  ['通行碼', 'store-pass-1234'],
  ['店別', '新竹光復'],
  ['支出科目', '食材,瓦斯'],
  ['收入科目', '回收收入'],
  ['照片資料夾ID', '']
];

var 月結Rows = [
  ['月份', '狀態', '鎖定時間']
  // 2026-09 沒有鎖定
];

var 常用項目Rows = [
  ['科目', '項目名稱', '使用次數', '最後使用時間']
];

function makeSheet(rows) {
  var writeCalls = [];
  return {
    _rows: rows,
    _writeCalls: writeCalls,
    getDataRange: function () {
      var self = this;
      return { getValues: function () { return self._rows.map(function (r) { return r.slice(); }); } };
    },
    getLastRow: function () { return this._rows.length; },
    // 以下都是寫入操作：pnlSummary 路徑不應該呼叫到任何一個，呼叫到就讓測試爆炸失敗
    appendRow: function () { writeCalls.push('appendRow'); throw new Error('UNEXPECTED_WRITE:appendRow'); },
    setName: function () { writeCalls.push('setName'); throw new Error('UNEXPECTED_WRITE:setName'); },
    getRange: function () {
      writeCalls.push('getRange');
      return {
        setValue: function () { writeCalls.push('setValue'); throw new Error('UNEXPECTED_WRITE:setValue'); },
        setValues: function () { writeCalls.push('setValues'); throw new Error('UNEXPECTED_WRITE:setValues'); },
        setFontWeight: function () { throw new Error('UNEXPECTED_WRITE:setFontWeight'); },
        setNumberFormat: function () { throw new Error('UNEXPECTED_WRITE:setNumberFormat'); }
      };
    },
    setFrozenRows: function () { writeCalls.push('setFrozenRows'); throw new Error('UNEXPECTED_WRITE:setFrozenRows'); },
    deleteRow: function () { writeCalls.push('deleteRow'); throw new Error('UNEXPECTED_WRITE:deleteRow'); }
  };
}

function freshSheets() {
  return {
    '明細': makeSheet(明細Rows),
    '設定': makeSheet(設定Rows),
    '月結': makeSheet(月結Rows),
    '常用項目': makeSheet(常用項目Rows)
  };
}

function makeSpreadsheetApp(sheets) {
  var book = {
    getSheetByName: function (name) {
      if (!sheets[name]) return null;
      return sheets[name];
    },
    insertSheet: function () { throw new Error('UNEXPECTED_WRITE:insertSheet'); }
  };
  return {
    getActiveSpreadsheet: function () { return book; },
    create: function () { throw new Error('UNEXPECTED_WRITE:SpreadsheetApp.create'); }
  };
}

function makePropertiesService(props) {
  return {
    getScriptProperties: function () {
      return {
        getProperty: function (key) { return props.hasOwnProperty(key) ? props[key] : null; },
        setProperty: function () { throw new Error('UNEXPECTED_WRITE:PropertiesService.setProperty'); },
        setProperties: function () { throw new Error('UNEXPECTED_WRITE:PropertiesService.setProperties'); }
      };
    }
  };
}

var ContentService = {
  MimeType: { JSON: 'JSON' },
  createTextOutput: function (text) {
    var mime = null;
    return {
      setMimeType: function (m) { mime = m; return this; },
      _text: text,
      _mime: function () { return mime; }
    };
  }
};

var DriveApp = {
  createFolder: function () { throw new Error('UNEXPECTED_WRITE:DriveApp.createFolder'); },
  getFolderById: function () { throw new Error('UNEXPECTED_WRITE:DriveApp.getFolderById'); },
  getFileById: function () { throw new Error('UNEXPECTED_ACCESS:DriveApp.getFileById'); }
};
var LockService = {
  getScriptLock: function () { throw new Error('UNEXPECTED_ACCESS:LockService (pnlSummary 不應該碰鎖)'); }
};
var ScriptApp = { getOAuthToken: function () { throw new Error('UNEXPECTED_ACCESS:ScriptApp'); } };
var UrlFetchApp = { fetch: function () { throw new Error('UNEXPECTED_ACCESS:UrlFetchApp'); } };

function loadCodeGs(sheets, props) {
  var src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  var sandbox = {
    SpreadsheetApp: makeSpreadsheetApp(sheets),
    PropertiesService: makePropertiesService(props),
    ContentService: ContentService,
    Utilities: Utilities,
    DriveApp: DriveApp,
    LockService: LockService,
    ScriptApp: ScriptApp,
    UrlFetchApp: UrlFetchApp,
    console: console
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'Code.gs' });
  return sandbox;
}

function callDoPost(sandbox, body) {
  var res = sandbox.doPost({ postData: { contents: JSON.stringify(body) } });
  return JSON.parse(res._text);
}

// ---------- 1. 正確金鑰＋正確月份 → 正確加總（含作廢排除、跨月排除、Date 物件日期） ----------
(function () {
  var sandbox = loadCodeGs(freshSheets(), { PNL_KEY: 'secret-pnl-key' });
  var res = callDoPost(sandbox, { action: 'pnlSummary', key: 'secret-pnl-key', month: '2026-09' });
  eq('pnlSummary ok:true', res.ok, true);
  eq('pnlSummary month 回原值', res.month, '2026-09');
  eq('pnlSummary store', res.store, '新竹光復');
  eq('pnlSummary expense 加總（食材 1000+500，排除作廢的瓦斯 300，排除跨月的 999）',
     res.expense, { 食材: 1500 });
  eq('pnlSummary income 加總（含 Date 物件日期那筆）', res.income, { 回收收入: 200 });
  eq('pnlSummary rows 數（3 筆：2 支出＋1 收入，排除作廢與跨月）', res.rows, 3);
  eq('pnlSummary locked（2026-09 沒鎖）', res.locked, false);
})();

// ---------- 2. 月結有鎖定時 locked:true ----------
(function () {
  var sheets = freshSheets();
  sheets['月結']._rows.push(['2026-09', '鎖定', '2026-10-01T00:00:00+08:00']);
  var sandbox = loadCodeGs(sheets, { PNL_KEY: 'secret-pnl-key' });
  var res = callDoPost(sandbox, { action: 'pnlSummary', key: 'secret-pnl-key', month: '2026-09' });
  eq('pnlSummary locked:true（月結分頁鎖定 2026-09）', res.locked, true);
})();

// ---------- 3. 錯金鑰 → AUTH ----------
(function () {
  var sandbox = loadCodeGs(freshSheets(), { PNL_KEY: 'secret-pnl-key' });
  var res = callDoPost(sandbox, { action: 'pnlSummary', key: 'wrong-key', month: '2026-09' });
  eq('錯金鑰 → ok:false', res.ok, false);
  eq('錯金鑰 → error:AUTH', res.error, 'AUTH');
})();

// ---------- 4. 沒帶 key → AUTH ----------
(function () {
  var sandbox = loadCodeGs(freshSheets(), { PNL_KEY: 'secret-pnl-key' });
  var res = callDoPost(sandbox, { action: 'pnlSummary', month: '2026-09' });
  eq('沒帶 key → ok:false', res.ok, false);
  eq('沒帶 key → error:AUTH', res.error, 'AUTH');
})();

// ---------- 4b. Script Properties 根本沒設 PNL_KEY → AUTH（不能預設開放） ----------
(function () {
  var sandbox = loadCodeGs(freshSheets(), {});
  var res = callDoPost(sandbox, { action: 'pnlSummary', key: 'anything', month: '2026-09' });
  eq('PNL_KEY 未設定時 → ok:false', res.ok, false);
  eq('PNL_KEY 未設定時 → error:AUTH', res.error, 'AUTH');
})();

// ---------- 5. 帶正確 key 但沒帶 pass 也能過（證明分流在 assertPass 之前） ----------
(function () {
  var sandbox = loadCodeGs(freshSheets(), { PNL_KEY: 'secret-pnl-key' });
  var res = callDoPost(sandbox, { action: 'pnlSummary', key: 'secret-pnl-key', month: '2026-09' }); // 沒有 pass 欄位
  eq('沒帶 pass 依然成功（沒有被 assertPass 擋下）', res.ok, true);
})();

// ---------- 6. 既有動作路徑未改變：assertPass 正常擋錯誤通行碼（bootstrap 走原本的路） ----------
(function () {
  var sandbox = loadCodeGs(freshSheets(), { PNL_KEY: 'secret-pnl-key' });
  var res = callDoPost(sandbox, { action: 'bootstrap', pass: 'wrong-store-pass' });
  eq('既有 bootstrap 遇錯誤通行碼仍是 AUTH_FAIL（沒被本次改動動到）', res, { ok: false, error: 'AUTH_FAIL' });
})();

// ---------- 7. 既有動作路徑未改變：bootstrap 用正確通行碼仍正常回資料 ----------
(function () {
  var sandbox = loadCodeGs(freshSheets(), { PNL_KEY: 'secret-pnl-key' });
  var res = callDoPost(sandbox, { action: 'bootstrap', pass: 'store-pass-1234' });
  eq('既有 bootstrap 用正確通行碼仍正常運作', res.ok, true);
  eq('既有 bootstrap 仍回店別', res.settings && res.settings.store, '新竹光復');
})();

// ---------- 8. 月份沒帶 → BAD_INPUT（不是靜默回空物件） ----------
(function () {
  var sandbox = loadCodeGs(freshSheets(), { PNL_KEY: 'secret-pnl-key' });
  var res = callDoPost(sandbox, { action: 'pnlSummary', key: 'secret-pnl-key' });
  eq('沒帶 month → ok:false', res.ok, false);
  eq('沒帶 month → error:BAD_INPUT', res.error, 'BAD_INPUT');
})();

// ---------- 收尾 ----------
console.log('\n通過 ' + pass + ' / 共 ' + (pass + fail));
if (fail) {
  console.log(fails.join('\n'));
  console.log('\nFAIL（' + fail + ' 項未通過）\n');
  process.exit(1);
}
console.log('\nPASS\n');
