/* 裁判：apiCreate 的冪等（同一次送出只記一筆帳）。
 *
 * 為什麼要有這支：前端 20 秒逾時只中止瀏覽器這一端，後端照樣跑完並寫進試算表，
 * 但畫面會跳「這次沒送出去，請再按一次」——2026-09-24 深夜就這樣記出三組重複帳
 * （收據 73/74/77 外送三筆、79/80/83 瓦斯三筆），店長按三次、三筆全寫進去。
 *
 * 跟 pnlSummary.test.js 同樣用 Node vm 載 Code.gs 進假 GAS 全域，差別是這支
 * 允許寫入（appendRow／setValue 真的動假資料），因為要驗的就是「寫了幾次」。
 * 用法：node test/createIdempotent.test.js
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
function ok(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; fails.push('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

function pad(n) { return String(n).padStart(2, '0'); }
var Utilities = {
  formatDate: function (date, tz, fmt) {
    var d = new Date(date.getTime() + 8 * 3600 * 1000);
    if (fmt === 'yyyy-MM-dd') {
      return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
    }
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) +
           'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + '+08:00';
  },
  base64Decode: function () { throw new Error('NOT_EXPECTED:base64Decode'); },
  newBlob: function () { throw new Error('NOT_EXPECTED:newBlob'); }
};

var 明細Rows = [
  ['單號', '店別', '日期', '收支別', '科目', '項目名稱', '金額', '發票', '未稅價', '稅額', '收據編號', '照片連結', '填表人', '登記時間', '狀態', '作廢時間', '作廢原因'],
  ['2026-09-001', '新竹光復', '2026-09-01', '支出', '食材', '豬肉', 1000, '無', 1000, 0, 1, '', '店長', '2026-09-01T09:00:00+08:00', '正常', '', '']
];
var 設定Rows = [['鍵', '值'], ['通行碼', 'p'], ['店別', '新竹光復'], ['支出科目', '食材,運費'], ['收入科目', '回收收入'], ['照片資料夾ID', '']];
var 月結Rows = [['月份', '狀態', '鎖定時間']];
var 常用項目Rows = [['科目', '項目名稱', '使用次數', '最後使用時間']];

/* 可寫的假分頁：appendRow 真的把列加進去，getRange().setValue 真的改格子。
   要驗的就是「到底寫了幾次」，所以這裡不能像 pnlSummary 那樣一寫就拋錯。 */
function makeSheet(rows) {
  return {
    _rows: rows.map(function (r) { return r.slice(); }),
    _appends: 0,
    getDataRange: function () {
      var self = this;
      return { getValues: function () { return self._rows.map(function (r) { return r.slice(); }); } };
    },
    getLastRow: function () { return this._rows.length; },
    appendRow: function (r) { this._appends++; this._rows.push(r.slice()); },
    getRange: function (row, col) {
      var self = this;
      return {
        setValue: function (v) { self._rows[row - 1][col - 1] = v; },
        setValues: function () {}, setFontWeight: function () {}, setNumberFormat: function () {}
      };
    },
    setFrozenRows: function () {}, setName: function () {}, deleteRow: function () {}
  };
}
function freshSheets() {
  return { '明細': makeSheet(明細Rows), '設定': makeSheet(設定Rows), '月結': makeSheet(月結Rows), '常用項目': makeSheet(常用項目Rows) };
}

/* 假快取：用一個 Map，並記下被呼叫的次數，測試可以手動清空模擬「快取失效」。 */
function makeCache() {
  var store = {};
  return {
    _store: store,
    _clear: function () { Object.keys(store).forEach(function (k) { delete store[k]; }); },
    getScriptCache: function () {
      return {
        get: function (k) { return store.hasOwnProperty(k) ? store[k] : null; },
        put: function (k, v) { store[k] = v; },
        remove: function (k) { delete store[k]; }
      };
    }
  };
}

/* 假鎖：單執行緒測試裡永遠拿得到。記下有沒有被用，因為寫入動作一定要在鎖內。 */
function makeLock() {
  var calls = { tryLock: 0, release: 0 };
  return {
    _calls: calls,
    getScriptLock: function () {
      return {
        tryLock: function () { calls.tryLock++; return true; },
        releaseLock: function () { calls.release++; }
      };
    }
  };
}

function loadCodeGs(sheets, cache, lock) {
  var src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  var sandbox = {
    SpreadsheetApp: {
      getActiveSpreadsheet: function () {
        return { getSheetByName: function (n) { return sheets[n] || null; }, insertSheet: function () { throw new Error('NOT_EXPECTED:insertSheet'); } };
      },
      create: function () { throw new Error('NOT_EXPECTED:create'); }
    },
    PropertiesService: { getScriptProperties: function () { return { getProperty: function () { return null; }, setProperty: function () {} }; } },
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: function (t) { return { setMimeType: function () { return this; }, _text: t }; } },
    Utilities: Utilities,
    CacheService: cache,
    LockService: lock,
    DriveApp: { createFolder: function () { throw new Error('NOT_EXPECTED:createFolder'); }, getFolderById: function () { throw new Error('NOT_EXPECTED:getFolderById'); } },
    ScriptApp: {}, UrlFetchApp: {}, console: console
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'Code.gs' });
  return sandbox;
}

function callDoPost(sandbox, body) {
  return JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(body) } })._text);
}

var BASE = { action: 'create', pass: 'p', date: '2026-09-24', kind: '支出',
             subject: '運費', name: '外送－益誠/羽成', amount: 300, hasInvoice: false };

// ---------- ① 同一個 token 送兩次，只能記一筆 ----------
(function () {
  var sheets = freshSheets(), cache = makeCache(), lock = makeLock();
  var sb = loadCodeGs(sheets, cache, lock);
  var req = Object.assign({}, BASE, { clientToken: 'tok-aaa' });

  var first = callDoPost(sb, req);
  var second = callDoPost(sb, req);

  eq('第一次成功', first.ok, true);
  eq('第二次也回成功（對店長來說就是成功了，不該看到錯誤）', second.ok, true);
  eq('★ 明細只被 append 一次（這是整支測試的重點）', sheets['明細']._appends, 1);
  eq('第二次回的是同一筆（單號相同）', second.row.id, first.row.id);
  eq('第二次有標記 duplicate，前端才知道不必再更新畫面兩次', second.duplicate, true);
  eq('第一次不該有 duplicate 標記', first.duplicate, undefined);
  eq('收據編號沒有被跳號', second.row.seq, first.row.seq);
  eq('★ 常用項目沒有被灌水（使用次數仍是 1）', sheets['常用項目']._rows[1][2], 1);
  ok('寫入有拿鎖', lock._calls.tryLock >= 1, '拿鎖次數 ' + lock._calls.tryLock);
})();

// ---------- ② 不同 token＝真的兩筆，不可以被擋掉 ----------
(function () {
  var sheets = freshSheets(), cache = makeCache(), lock = makeLock();
  var sb = loadCodeGs(sheets, cache, lock);
  var a = callDoPost(sb, Object.assign({}, BASE, { clientToken: 'tok-a' }));
  var b = callDoPost(sb, Object.assign({}, BASE, { clientToken: 'tok-b' }));
  eq('內容一樣但 token 不同＝兩筆都要記（店長可能真的買了兩次一樣的）', sheets['明細']._appends, 2);
  ok('兩筆的單號不同', a.row.id !== b.row.id, a.row.id + ' vs ' + b.row.id);
  eq('第二筆收據編號有遞增', b.row.seq, a.row.seq + 1);
})();

// ---------- ③ 沒帶 token＝舊版前端，行為要跟以前一樣 ----------
(function () {
  var sheets = freshSheets(), cache = makeCache(), lock = makeLock();
  var sb = loadCodeGs(sheets, cache, lock);
  callDoPost(sb, BASE);
  callDoPost(sb, BASE);
  eq('沒有 token 就無從判斷重複，維持原行為記兩筆（舊前端不會因為後端先上而壞掉）', sheets['明細']._appends, 2);
})();

// ---------- ④ 快取失效是已知的退路，行為要可預期 ----------
(function () {
  var sheets = freshSheets(), cache = makeCache(), lock = makeLock();
  var sb = loadCodeGs(sheets, cache, lock);
  var req = Object.assign({}, BASE, { clientToken: 'tok-ccc' });
  callDoPost(sb, req);
  cache._clear();                       // 模擬快取被清掉
  callDoPost(sb, req);
  eq('快取沒了就擋不住，退回記兩筆（不會更糟，但要知道這條退路存在）', sheets['明細']._appends, 2);
})();

// ---------- ⑤ token 是外部輸入，要有長度上限 ----------
(function () {
  var sheets = freshSheets(), cache = makeCache(), lock = makeLock();
  var sb = loadCodeGs(sheets, cache, lock);
  var huge = new Array(5000).join('x');
  var r = callDoPost(sb, Object.assign({}, BASE, { clientToken: huge }));
  eq('超長 token 不會讓這筆記不成', r.ok, true);
  var keys = Object.keys(cache._store);
  ok('存進快取的鍵有被截短（GAS 的 key 上限 250 字元）',
     keys.length === 1 && keys[0].length <= 250, '鍵長 ' + (keys[0] || '').length);
})();

// ---------- 收尾 ----------
console.log('\n通過 ' + pass + ' / 共 ' + (pass + fail));
if (fail) {
  console.log(fails.join('\n'));
  console.log('\nFAIL（' + fail + ' 項未通過）\n');
  process.exit(1);
}
console.log('\nPASS\n');
