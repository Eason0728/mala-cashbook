/* 匯出：會計月底要的那個檔。
 *
 * 決定（2026-09-08，岔路裁決＝選最少新依賴的）：
 *   cloud 模式 → 由後端 Apps Script 用 Google 試算表原生匯出，拿到的是**真正的 .xlsx**，
 *                前端不需要任何第三方函式庫（原本規劃的 SheetJS 因此不採用）。
 *   local 模式 → 沒有後端可用，就地產 CSV（帶 UTF-8 BOM，Excel open 不會變亂碼），
 *                純粹給本機測試看欄位對不對用，檔名會標明是測試檔。
 */
(function () {
  'use strict';

  function csvCell(v) {
    var s = String(v === null || v === undefined ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function baseName(month) {
    return '現金收支_' + window.Config.STORE + '_' + month;
  }

  /* 匯出的內容組裝在 Calc.buildExportRows（作廢的不出、依日期與收據編號排序），
     這裡只負責變成檔案。合計三列放在資料後面空一列，跟紙本的「總金額」對得上。 */
  function buildMatrix(rows) {
    var data = window.Calc.buildExportRows(rows);
    var sum = window.Calc.summarize(rows);
    var matrix = [window.Calc.EXPORT_HEADERS].concat(data);
    matrix.push([]);
    matrix.push(['支出合計', '', '', '', '', '', '', sum.expense]);
    matrix.push(['收入合計', '', '', '', '', '', '', sum.income]);
    matrix.push(['淨額', '', '', '', '', '', '', sum.net]);
    return matrix;
  }

  function exportCSV(rows, month) {
    var text = buildMatrix(rows).map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
    download(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }),
             baseName(month) + '_本機測試.csv');
    return { format: 'csv' };
  }

  function b64ToBlob(b64, mime) {
    var bin = atob(b64), len = bin.length, buf = new Uint8Array(len);
    for (var i = 0; i < len; i++) buf[i] = bin.charCodeAt(i);
    return new Blob([buf], { type: mime });
  }

  function run(pass, month, rows) {
    if (window.Config.MODE === 'local') return Promise.resolve(exportCSV(rows, month));
    return window.Api.exportXlsx(pass, month).then(function (res) {
      download(b64ToBlob(res.base64,
               'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
               baseName(month) + '.xlsx');
      return { format: 'xlsx' };
    });
  }

  window.Exporter = { run: run, buildMatrix: buildMatrix };
})();
