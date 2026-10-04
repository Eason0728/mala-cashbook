/* 麻的小辛辣｜現金收支備份 — Apps Script 橋接
 * 正本在 repo ~/mala-cashbook/gas-backup/。Mac mini 的 server/backup.js 每天帶金鑰 POST 進來。
 *   doPost { action:'backup', key, rows, frequent, locks, subjects:{expense,income} }
 *     → 試算表四個分頁「明細」「常用項目」「月結」「科目」整頁清空重寫（跑兩次結果相同；手動修改下次備份會被蓋掉）
 *   doPost { action:'photo', key, name:'<id>_<token>.jpg', base64 }
 *     → 存進雲端硬碟資料夾；同名檔已存在就略過（冪等）
 *   - 金鑰：指令碼屬性 BACKUP_KEY；沒設（或空字串）一律拒絕（AUTH）。比對用等長逐字元；10 分鐘內錯 20 次鎖 10 分鐘。
 *   - 單格截 300 字、只收文字與數字（物件、陣列、布林整批拒絕）；=、+、-、@ 開頭的文字前面加 '（防公式注入）。
 *   - setup() 建試算表與資料夾，ID 存指令碼屬性 SHEET_ID／FOLDER_ID，重跑不重建；不分享給任何人。 */
'use strict';

var SHEET_TITLE_ = '麻的小辛辣｜現金收支備份';
var FOLDER_TITLE_ = '麻的小辛辣｜現金收支收據照片備份';
var MAX_ROWS_ = 50000, MAX_CELL_ = 300, MAX_PHOTO_B64_ = 14000000;
var FAIL_LIMIT_ = 20, FAIL_WINDOW_S_ = 600, LOCK_S_ = 600;

var HEADERS_ = ['單號', '店別', '日期', '收支別', '科目', '項目名稱', '金額', '發票', '未稅價', '稅額', '收據編號', '照片連結', '填表人', '登記時間', '狀態', '作廢時間', '作廢原因'];
var NUM_COLS_ = { 6: 1, 8: 1, 9: 1, 10: 1 };       // 明細裡的數字欄（0 起算）：金額、未稅價、稅額、收據編號
var FREQ_HEADERS_ = ['科目', '項目名稱', '使用次數', '最後使用時間'];
var LOCK_HEADERS_ = ['月份', '狀態', '鎖定時間'];
var SUBJ_HEADERS_ = ['收支別', '科目'];

/** 第一次部署：在編輯器手動執行一次（授權試算表與雲端硬碟權限）。重複執行不會重建。 */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var sid = props.getProperty('SHEET_ID');
  if (sid) { try { SpreadsheetApp.openById(sid); Logger.log('試算表已存在：' + sid + '（沒有重建）'); } catch (e) { sid = null; Logger.log('原本記的試算表打不開，重建一份'); } }
  if (!sid) {
    var ss = SpreadsheetApp.create(SHEET_TITLE_);
    props.setProperty('SHEET_ID', ss.getId());
    Logger.log('已建立試算表：' + ss.getUrl() + '（不分享給任何人）');
  }
  var fid = props.getProperty('FOLDER_ID');
  if (fid) { try { DriveApp.getFolderById(fid); Logger.log('資料夾已存在：' + fid + '（沒有重建）'); } catch (e) { fid = null; Logger.log('原本記的資料夾打不開，重建一份'); } }
  if (!fid) {
    var f = DriveApp.createFolder(FOLDER_TITLE_);
    props.setProperty('FOLDER_ID', f.getId());
    Logger.log('已建立資料夾：' + f.getUrl() + '（不分享給任何人）');
  }
  Logger.log(props.getProperty('BACKUP_KEY') ? 'BACKUP_KEY 已設定' : '⚠ BACKUP_KEY 還沒設定——到 專案設定 → 指令碼屬性 自己加（沒設一律拒絕所有請求）');
}

function doGet() { return json_({ ok: true, data: { app: 'cashbook-backup' } }); }

function doPost(e) {
  var req;
  try { req = JSON.parse(e && e.postData ? e.postData.contents : '{}'); }
  catch (x) { return json_({ ok: false, code: 'BAD_REQ' }); }
  if (!req || typeof req !== 'object' || Array.isArray(req)) return json_({ ok: false, code: 'BAD_REQ' });
  var action = String(req.action || '');
  if (action !== 'backup' && action !== 'photo') return json_({ ok: false, code: 'BAD_REQ' });
  var auth = checkKey_(req.key);
  if (auth) return json_(auth);
  try {
    if (action === 'photo') return json_(savePhoto_(req));
    var sheets = buildSheets_(req);
    if (!sheets) return json_({ ok: false, code: 'BAD_REQ' });
    var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
    if (!id) return json_({ ok: false, code: 'SERVER' });
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(20000)) return json_({ ok: false, code: 'SERVER' });
    try { writeSheets_(SpreadsheetApp.openById(id), sheets); }
    finally { lock.releaseLock(); }
    return json_({ ok: true, data: { rows: sheets['明細'].length - 1, frequent: sheets['常用項目'].length - 1, locks: sheets['月結'].length - 1, subjects: sheets['科目'].length - 1 } });
  } catch (x) {
    console.error('cashbook-backup: ' + (x && x.stack || x));
    return json_({ ok: false, code: 'SERVER' });
  }
}

/* 金鑰檢查：回 null＝通過；否則回要送出的錯誤物件。BACKUP_KEY 沒設一律 AUTH */
function checkKey_(given) {
  var cache = null; try { cache = CacheService.getScriptCache(); } catch (x) { cache = null; }
  var failKey = 'bk_fail', lockKey = 'bk_lock';
  if (cache && cache.get(lockKey)) return { ok: false, code: 'LOCKED' };
  var key = PropertiesService.getScriptProperties().getProperty('BACKUP_KEY');
  var good = !!key && String(key).length > 0 && typeof given === 'string' && safeEq_(String(key), given);
  if (good) return null;
  if (cache) {
    var n = Number(cache.get(failKey) || 0) + 1;
    if (n >= FAIL_LIMIT_) { cache.put(lockKey, '1', LOCK_S_); cache.remove(failKey); } else cache.put(failKey, String(n), FAIL_WINDOW_S_);
  }
  return { ok: false, code: 'AUTH' };
}
function safeEq_(a, b) {                       // 長度不同也走完整個迴圈
  var n = Math.max(a.length, b.length), d = a.length ^ b.length;
  for (var i = 0; i < n; i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

/* 單格：數字欄必須是有限數字或空白（字串形式的數字轉數字）；文字欄收文字與數字。其他型別 → undefined（整批拒絕） */
function cell_(v, isNum) {
  if (v === null || v === undefined || v === '') return '';
  if (isNum) {
    if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) v = Number(v);
    return (typeof v === 'number' && isFinite(v)) ? v : undefined;
  }
  var wasNum = typeof v === 'number' && isFinite(v);
  if (wasNum) v = String(v);
  if (typeof v !== 'string') return undefined;
  v = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, MAX_CELL_);
  if (!wasNum && /^[=+\-@]/.test(v)) v = "'" + v;
  return v;
}
/* list：二維陣列；width 欄；numCols：數字欄索引表；回清洗後的陣列，或 null */
function table_(list, width, numCols) {
  if (!Array.isArray(list) || list.length > MAX_ROWS_) return null;
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var r = list[i];
    if (!Array.isArray(r) || r.length !== width) return null;
    var row = [];
    for (var c = 0; c < width; c++) { var x = cell_(r[c], !!(numCols && numCols[c])); if (x === undefined) return null; row.push(x); }
    out.push(row);
  }
  return out;
}
/* 把請求變成四個分頁的完整內容（含表頭）；格式有問題回 null。純函式，node 可測。
   明細：送來的第一列若就是表頭則略過；表頭一律由這裡寫，不信任送來的。 */
function buildSheets_(req) {
  var rows = req.rows;
  if (Array.isArray(rows) && rows.length && Array.isArray(rows[0]) && String(rows[0][0]) === HEADERS_[0]) rows = rows.slice(1);
  var detail = table_(rows, HEADERS_.length, NUM_COLS_);
  var freq = table_(req.frequent, 4, { 2: 1 });
  var locks = table_(req.locks, 3, null);
  var s = req.subjects;
  if (!detail || !freq || !locks || !s || typeof s !== 'object' || !Array.isArray(s.expense) || !Array.isArray(s.income)) return null;
  var subj = [];
  var kinds = [['支出', s.expense], ['收入', s.income]];
  for (var k = 0; k < 2; k++) for (var i = 0; i < kinds[k][1].length; i++) {
    var name = cell_(kinds[k][1][i], false);
    if (name === undefined || name === '') return null;
    subj.push([kinds[k][0], name]);
  }
  return {
    '明細': [HEADERS_].concat(detail),
    '常用項目': [FREQ_HEADERS_].concat(freq),
    '月結': [LOCK_HEADERS_].concat(locks),
    '科目': [SUBJ_HEADERS_].concat(subj)
  };
}

/* 整頁覆蓋（先寫暫名分頁、全部寫成功後才刪舊分頁並改名）：中途失敗時舊的備份原封不動。
   先把格式設成純文字／數字，避免日期被轉型或 "=…" 被當公式 */
function writeSheets_(ss, sheets) {
  var names = ['明細', '常用項目', '月結', '科目'], tmps = [], i;
  for (i = 0; i < names.length; i++) {
    var name = names[i], matrix = sheets[name], tmpName = name + '_new';
    var stale = ss.getSheetByName(tmpName);          // 上次中途失敗留下的
    if (stale) ss.deleteSheet(stale);
    var tmp = ss.insertSheet(tmpName);
    var fmts = matrix.map(function (r, ri) {
      return r.map(function (v, c) { return (ri > 0 && ((name === '明細' && NUM_COLS_[c]) || (name === '常用項目' && c === 2))) ? '#,##0.##' : '@'; });
    });
    var range = tmp.getRange(1, 1, matrix.length, matrix[0].length);
    range.setNumberFormats(fmts);
    range.setValues(matrix);
    tmp.setFrozenRows(1);
    tmps.push(tmp);
  }
  for (i = 0; i < names.length; i++) {                // 四個都寫成功才換
    var old = ss.getSheetByName(names[i]);
    if (old) ss.deleteSheet(old);
    tmps[i].setName(names[i]);
  }
  var junk = ['Sheet1', '工作表1'];                    // setup() 建的空白預設分頁
  for (i = 0; i < junk.length; i++) { var j = ss.getSheetByName(junk[i]); if (j && ss.getSheets().length > 1) ss.deleteSheet(j); }
}

/* 照片：檔名只允許 英數底線連字號＋.jpg；同名已存在就略過（冪等） */
function savePhoto_(req) {
  var name = req.name, b64 = req.base64;
  if (typeof name !== 'string' || !/^[A-Za-z0-9_\-]{1,100}\.jpg$/.test(name)) return { ok: false, code: 'BAD_REQ' };
  if (typeof b64 !== 'string' || !b64 || b64.length > MAX_PHOTO_B64_) return { ok: false, code: 'BAD_REQ' };
  var fid = PropertiesService.getScriptProperties().getProperty('FOLDER_ID');
  if (!fid) return { ok: false, code: 'SERVER' };
  var folder = DriveApp.getFolderById(fid);
  var it = folder.getFilesByName(name);
  while (it.hasNext()) { if (!it.next().isTrashed()) return { ok: true, data: { name: name, skipped: true } }; }   // 垃圾桶裡的同名檔不算
  folder.createFile(Utilities.newBlob(Utilities.base64Decode(b64), 'image/jpeg', name));
  return { ok: true, data: { name: name, skipped: false } };
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
