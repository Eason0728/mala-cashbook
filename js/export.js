/* 匯出：會計月底要的那個檔。
 *
 * 2026-09-09 改版：由**瀏覽器就地產 xlsx**（js/vendor/xlsx.mini.min.js）。
 *   為什麼改：原本 cloud 模式是叫後端 Apps Script 建一份臨時試算表、請 Google 轉檔成
 *   xlsx、再 base64 回傳，常態 20～40 秒，會計連按五次全撞上前端 20 秒逾時。
 *   現在資料本來就已經在前端手上（畫面就是用它畫的），直接寫成檔案不到 1 秒，
 *   而且不必等後端、不會逾時、離線也產得出來。
 *
 *   附帶好處：local 與 cloud 走**同一條路**，所以 e2e 從此真的測得到匯出這條路徑
 *   ——舊版 local 走 CSV 分支，後端那條真 xlsx 從上線到出事都沒有任何測試涵蓋。
 *
 *   代價：標題粗體與凍結首列沒了（那是 SheetJS 付費版才有的儲存格樣式）。
 *   千分位格式與欄寬有保留。後端的 apiExport 沒有刪，只是前端不再呼叫它。
 */
(function () {
  'use strict';

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

  // 未稅價／稅額／金額這三欄（含最後的合計）套千分位，會計對帳才看得快
  var MONEY_COLS = [5, 6, 7];
  // 欄寬照欄位實際會裝的東西給，不然日期跟登記時間會擠成 ####
  var COL_WIDTHS = [10, 12, 8, 14, 22, 10, 8, 10, 6, 10, 28, 10, 20];

  function toWorkbook(matrix) {
    var ws = XLSX.utils.aoa_to_sheet(matrix);
    for (var r = 1; r < matrix.length; r++) {
      MONEY_COLS.forEach(function (c) {
        var cell = ws[XLSX.utils.encode_cell({ r: r, c: c })];
        if (cell && typeof cell.v === 'number') cell.z = '#,##0';
      });
    }
    ws['!cols'] = COL_WIDTHS.map(function (w) { return { wch: w }; });
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '明細');
    return wb;
  }

  function run(pass, month, rows) {
    // 函式庫沒載進來就講人話，不要丟一個 ReferenceError 給會計看
    if (typeof XLSX === 'undefined') return Promise.reject(new Error('XLSX_MISSING'));
    var buf = XLSX.write(toWorkbook(buildMatrix(rows)), { bookType: 'xlsx', type: 'array' });
    // 本機測試檔標明出處，免得混進真帳
    var suffix = window.Config.MODE === 'local' ? '_本機測試' : '';
    download(new Blob([buf], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }), baseName(month) + suffix + '.xlsx');
    return Promise.resolve({ format: 'xlsx' });
  }

  window.Exporter = { run: run, buildMatrix: buildMatrix };
})();
