/* 現金收支明細登記 — Apps Script 後端
 *
 * 部署方式：以「我（Eason）」的身分執行、「任何人」皆可存取。
 * 因為前端沒有 Google 登入，Web App 網址等同鑰匙，通行碼是第二道門。
 *
 * 試算表四個分頁（第一次用先執行一次 setup()）：明細／設定／常用項目／月結
 * 通行碼只寫在「設定」分頁，不寫在這支程式裡，也不進 GitHub。
 */

// 容器繫結在試算表上（試算表 → 擴充功能 → Apps Script），所以直接拿當前試算表，
// 不用手填 ID。萬一改成獨立專案，再把 ID 填進 SHEET_ID_FALLBACK。
var SHEET_ID_FALLBACK = '';
var SHEET_ROWS = '明細';
var SHEET_SETTINGS = '設定';
var SHEET_FREQUENT = '常用項目';
var SHEET_LOCKS = '月結';

var HEADERS = ['單號', '店別', '日期', '收支別', '科目', '項目名稱', '金額', '發票',
               '未稅價', '稅額', '收據編號', '照片連結', '填表人', '登記時間',
               '狀態', '作廢時間', '作廢原因'];

// ---------- 入口 ----------

function doPost(e) {
  var out;
  try {
    var req = JSON.parse(e.postData.contents);
    assertPass(req.pass);
    var fn = {
      bootstrap: apiBootstrap, list: apiList, create: apiCreate, update: apiUpdate,
      'void': apiVoid, lock: apiLock, unlock: apiUnlock, 'export': apiExport
    }[req.action];
    if (!fn) throw new Error('BAD_INPUT');
    out = fn(req);
    out.ok = true;
  } catch (err) {
    out = { ok: false, error: String(err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
                       .setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput('現金收支登記後端運作中');
}

// ---------- 共用 ----------

function ss() {
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  if (!SHEET_ID_FALLBACK) throw new Error('NO_SPREADSHEET');
  return SpreadsheetApp.openById(SHEET_ID_FALLBACK);
}
function sheet(name) {
  var s = ss().getSheetByName(name);
  if (!s) throw new Error('SHEET_MISSING_' + name);
  return s;
}

function settings() {
  var rows = sheet(SHEET_SETTINGS).getDataRange().getValues();
  var map = {};
  rows.forEach(function (r) { if (r[0]) map[String(r[0]).trim()] = String(r[1]).trim(); });
  return map;
}

function assertPass(pass) {
  var real = settings()['通行碼'];
  if (!real || String(pass) !== real) throw new Error('AUTH_FAIL');
}

function monthOf(date) { return String(date).slice(0, 7); }

/* 稅額拆法與前端 js/calc.js 必須完全一致（見 docs/spec.md 共用契約）：
   有發票＝含稅價回推未稅並四捨五入，稅額用相減，未稅＋稅額才會剛好等於金額。 */
function splitTax(amount, hasInvoice) {
  var amt = Math.round(Number(amount) || 0);
  if (!hasInvoice) return { net: amt, tax: 0 };
  var net = Math.round(amt / 1.05);
  return { net: net, tax: amt - net };
}

function allRows() {
  var values = sheet(SHEET_ROWS).getDataRange().getValues();
  values.shift();
  return values.map(function (r, i) {
    return {
      _row: i + 2,
      id: r[0], store: r[1],
      date: Utilities.formatDate(new Date(r[2]), 'Asia/Taipei', 'yyyy-MM-dd'),
      kind: String(r[3]), subject: String(r[4]), name: String(r[5]),
      amount: Number(r[6]), hasInvoice: r[7] === '有',
      net: Number(r[8]), tax: Number(r[9]), seq: Number(r[10]),
      photo: r[11], author: r[12], createdAt: r[13],
      status: r[14], voidedAt: r[15], voidReason: r[16]
    };
  }).filter(function (r) { return r.id; });
}

function lockedMonths() {
  var values = sheet(SHEET_LOCKS).getDataRange().getValues();
  values.shift();
  return values.filter(function (r) { return r[0] && r[1] === '鎖定'; })
               .map(function (r) { return String(r[0]); });
}

function assertOpen(month) {
  if (lockedMonths().indexOf(month) >= 0) throw new Error('LOCKED');
}

// ---------- API ----------

function apiBootstrap() {
  var cfg = settings();
  var freq = sheet(SHEET_FREQUENT).getDataRange().getValues();
  freq.shift();
  return {
    settings: {
      store: cfg['店別'] || '新竹光復',
      expenseSubjects: String(cfg['支出科目'] || '').split(',').filter(String),
      incomeSubjects: String(cfg['收入科目'] || '').split(',').filter(String)
    },
    // 一律轉字串：試算表會把純數字的科目或項目名稱回成 Number，
    // 前端拿去 .replace()／.toLowerCase() 會直接炸掉整個登入流程
    frequent: freq.filter(function (r) { return r[0] !== '' && r[1] !== ''; }).map(function (r) {
      return { subject: String(r[0]), name: String(r[1]),
               count: Number(r[2]) || 0, lastUsed: String(r[3] || '') };
    }),
    lockedMonths: lockedMonths()
  };
}

function apiList(req) {
  return { rows: allRows().filter(function (r) { return monthOf(r.date) === req.month; }) };
}

function apiCreate(req) {
  var month = monthOf(req.date);
  assertOpen(month);
  if (!req.date || !req.subject || !req.name || !(Number(req.amount) > 0)) throw new Error('BAD_INPUT');

  var rows = allRows();
  var monthRows = rows.filter(function (r) { return monthOf(r.date) === month; });
  var seq = 0;
  monthRows.forEach(function (r) { if (r.kind === req.kind && r.seq > seq) seq = r.seq; });

  var t = splitTax(req.amount, req.hasInvoice);
  var id = month + '-' + ('00' + (monthRows.length + 1)).slice(-3);
  var photoUrl = '';
  var photoFailed = false;
  if (req.photoBase64) {
    try { photoUrl = savePhoto(req.photoBase64, id); }
    catch (e) { photoFailed = true; }  // 照片失敗不能害這筆帳記不成
  }

  var row = {
    id: id, store: settings()['店別'] || '新竹光復',
    date: req.date, kind: req.kind, subject: req.subject, name: req.name,
    amount: Math.round(Number(req.amount)), hasInvoice: !!req.hasInvoice,
    net: t.net, tax: t.tax, seq: seq + 1,
    photo: photoUrl, author: '店長',
    createdAt: Utilities.formatDate(new Date(), 'Asia/Taipei', "yyyy-MM-dd'T'HH:mm:ssXXX"),
    status: '正常'
  };
  sheet(SHEET_ROWS).appendRow([
    row.id, row.store, row.date, row.kind, row.subject, row.name, row.amount,
    row.hasInvoice ? '有' : '無', row.net, row.tax, row.seq, row.photo,
    row.author, row.createdAt, row.status, '', ''
  ]);
  bumpFrequent(row.subject, row.name);

  var out = { row: row, frequent: apiBootstrap().frequent };
  if (photoFailed) out.warning = 'PHOTO_FAIL';
  return out;
}

function apiUpdate(req) {
  var target = findRow(req.id);
  assertOpen(monthOf(target.date));
  var sh = sheet(SHEET_ROWS);
  var date = req.date || target.date;
  var amount = req.amount !== undefined ? Math.round(Number(req.amount)) : target.amount;
  var hasInvoice = req.hasInvoice !== undefined ? !!req.hasInvoice : target.hasInvoice;
  assertOpen(monthOf(date));
  var t = splitTax(amount, hasInvoice);

  sh.getRange(target._row, 3).setValue(date);
  sh.getRange(target._row, 4).setValue(req.kind || target.kind);
  sh.getRange(target._row, 5).setValue(req.subject || target.subject);
  sh.getRange(target._row, 6).setValue(req.name || target.name);
  sh.getRange(target._row, 7).setValue(amount);
  sh.getRange(target._row, 8).setValue(hasInvoice ? '有' : '無');
  sh.getRange(target._row, 9).setValue(t.net);
  sh.getRange(target._row, 10).setValue(t.tax);

  return { row: findRow(req.id) };
}

/* 作廢：只改狀態，資料列永遠留著（Eason 2026-09-08 指示：刪除都要留痕） */
function apiVoid(req) {
  var target = findRow(req.id);
  assertOpen(monthOf(target.date));
  var sh = sheet(SHEET_ROWS);
  sh.getRange(target._row, 15).setValue('作廢');
  sh.getRange(target._row, 16).setValue(Utilities.formatDate(new Date(), 'Asia/Taipei', "yyyy-MM-dd'T'HH:mm:ssXXX"));
  sh.getRange(target._row, 17).setValue(req.reason || '');
  return { row: findRow(req.id) };
}

function findRow(id) {
  var hit = null;
  allRows().forEach(function (r) { if (r.id === id) hit = r; });
  if (!hit) throw new Error('NOT_FOUND');
  return hit;
}

function apiLock(req) {
  var sh = sheet(SHEET_LOCKS);
  if (lockedMonths().indexOf(req.month) < 0) {
    sh.appendRow([req.month, '鎖定', Utilities.formatDate(new Date(), 'Asia/Taipei', "yyyy-MM-dd'T'HH:mm:ssXXX")]);
  }
  return { lockedMonths: lockedMonths() };
}

function apiUnlock(req) {
  var sh = sheet(SHEET_LOCKS);
  var values = sh.getDataRange().getValues();
  for (var i = values.length - 1; i >= 1; i--) {
    if (String(values[i][0]) === req.month) sh.deleteRow(i + 1);
  }
  return { lockedMonths: lockedMonths() };
}

function bumpFrequent(subject, name) {
  var sh = sheet(SHEET_FREQUENT);
  var values = sh.getDataRange().getValues();
  var now = Utilities.formatDate(new Date(), 'Asia/Taipei', "yyyy-MM-dd'T'HH:mm:ssXXX");
  for (var i = 1; i < values.length; i++) {
    if (values[i][0] === subject && values[i][1] === name) {
      sh.getRange(i + 1, 3).setValue((Number(values[i][2]) || 0) + 1);
      sh.getRange(i + 1, 4).setValue(now);
      return;
    }
  }
  sh.appendRow([subject, name, 1, now]);
}

function savePhoto(base64, id) {
  var folderId = settings()['照片資料夾ID'];
  if (!folderId) throw new Error('PHOTO_FAIL');
  var blob = Utilities.newBlob(Utilities.base64Decode(base64), 'image/jpeg', id + '.jpg');
  return DriveApp.getFolderById(folderId).createFile(blob).getUrl();
}

/* 匯出真正的 .xlsx：把當月資料寫進一份臨時試算表，用 Google 原生匯出成 xlsx，
   回傳 base64 給前端下載，然後把臨時檔丟掉。前端因此不需要任何第三方函式庫。 */
function apiExport(req) {
  var rows = allRows().filter(function (r) {
    return monthOf(r.date) === req.month && r.status !== '作廢';
  }).sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === '支出' ? -1 : 1;
    return a.seq - b.seq;
  });

  var expense = 0, income = 0;
  rows.forEach(function (r) { if (r.kind === '收入') income += r.amount; else expense += r.amount; });

  var matrix = [['店別', '日期', '收支別', '科目', '項目名稱', '未稅價', '稅額', '金額',
                 '發票', '收據編號', '收據照片', '填表人', '登記時間']];
  rows.forEach(function (r) {
    matrix.push([r.store, r.date, r.kind, r.subject, r.name, r.net, r.tax, r.amount,
                 r.hasInvoice ? '有' : '無', r.seq, r.photo, r.author, r.createdAt]);
  });
  matrix.push(['', '', '', '', '', '', '', '']);
  matrix.push(['支出合計', '', '', '', '', '', '', expense]);
  matrix.push(['收入合計', '', '', '', '', '', '', income]);
  matrix.push(['淨額', '', '', '', '', '', '', income - expense]);

  var tmp = SpreadsheetApp.create('tmp_cashbook_' + req.month + '_' + Date.now());
  var sh = tmp.getSheets()[0].setName('明細');
  sh.getRange(1, 1, matrix.length, 13).setValues(matrix.map(function (r) {
    while (r.length < 13) r.push('');
    return r;
  }));
  sh.getRange(1, 1, 1, 13).setFontWeight('bold');
  sh.getRange(2, 6, Math.max(rows.length, 1), 3).setNumberFormat('#,##0');
  sh.setFrozenRows(1);
  SpreadsheetApp.flush();

  var url = 'https://docs.google.com/spreadsheets/d/' + tmp.getId() + '/export?format=xlsx';
  var blob = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }
  }).getBlob();
  var b64 = Utilities.base64Encode(blob.getBytes());
  DriveApp.getFileById(tmp.getId()).setTrashed(true);

  return { base64: b64, count: rows.length };
}

// ---------- 第一次使用：建立四個分頁 ----------

function setup() {
  var book = ss();
  function ensure(name, header) {
    var s = book.getSheetByName(name) || book.insertSheet(name);
    if (s.getLastRow() === 0) s.appendRow(header);
    return s;
  }
  ensure(SHEET_ROWS, HEADERS);
  ensure(SHEET_FREQUENT, ['科目', '項目名稱', '使用次數', '最後使用時間']);
  ensure(SHEET_LOCKS, ['月份', '狀態', '鎖定時間']);

  var cfg = book.getSheetByName(SHEET_SETTINGS) || book.insertSheet(SHEET_SETTINGS);
  if (cfg.getLastRow() === 0) {
    cfg.getRange(1, 1, 6, 2).setValues([
      ['通行碼', '請改成你要的碼'],
      ['店別', '新竹光復'],
      ['支出科目', '食材,蔬果,瓦斯,備品耗材,清潔用品,修繕維護,水電,房租管理費,運費,文具印刷,員工餐費,雜支'],
      ['收入科目', '回收收入,員工／同業購買,代收轉付,其他收入'],
      ['照片資料夾ID', ''],
      ['說明', '科目改這裡就生效，不用改程式。通行碼只存這裡，不要寫進程式碼。']
    ]);
  }
}
