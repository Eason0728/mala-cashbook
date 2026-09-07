/* 現金收支明細：純計算模組
 * 刻意不碰 DOM、不碰網路——node 跑得起來，才能當自動化測試的裁判。
 * 瀏覽器用 window.Calc，node 用 require。
 * 稅額與流水號的單一真相在後端 Code.gs，本檔與後端必須用同一套規則（見 docs/spec.md 共用契約）。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Calc = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EXPORT_HEADERS = ['店別', '日期', '收支別', '科目', '項目名稱', '未稅價', '稅額',
                        '金額', '發票', '收據編號', '收據照片', '填表人', '登記時間'];
  var VOID = '作廢';

  function isLive(r) { return r && r.status !== VOID; }

  /* 有統一發票：金額是含稅價，未稅＝金額÷1.05 四捨五入，稅額＝差額。
     沒發票（收據）：未稅＝金額、稅額 0。
     一律用「稅額＝金額−未稅」而不是各自四捨五入，未稅＋稅額才會恰好等於金額。 */
  function splitTax(amount, hasInvoice) {
    var amt = Math.round(Number(amount) || 0);
    if (!hasInvoice) return { net: amt, tax: 0 };
    var net = Math.round(amt / 1.05);
    return { net: net, tax: amt - net };
  }

  /* 收據編號：每月、每種收支別各自從 1 起算。
     作廢的筆仍占用編號不回收——編號跳號本身就是「這裡曾經有一筆」的痕跡。 */
  function nextSeq(rows, kind) {
    var max = 0;
    (rows || []).forEach(function (r) {
      if (r && r.kind === kind && Number(r.seq) > max) max = Number(r.seq);
    });
    return max + 1;
  }

  /* 當月三個數字：支出、收入、淨額（收入−支出）。作廢的不算。 */
  function summarize(rows) {
    var expense = 0, income = 0, count = 0;
    (rows || []).filter(isLive).forEach(function (r) {
      var amt = Number(r.amount) || 0;
      if (r.kind === '收入') income += amt; else expense += amt;
      count++;
    });
    return { expense: expense, income: income, net: income - expense, count: count };
  }

  /* 匯出的資料列：一列一筆，欄位順序＝EXPORT_HEADERS，作廢的不出。
     金額三欄回數字型別（不是字串），Excel 才套得上千分位格式。 */
  function buildExportRows(rows) {
    return (rows || []).filter(isLive).slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      if (a.kind !== b.kind) return a.kind === '支出' ? -1 : 1;
      return (Number(a.seq) || 0) - (Number(b.seq) || 0);
    }).map(function (r) {
      return [
        r.store || '', r.date || '', r.kind || '', r.subject || '', r.name || '',
        Number(r.net) || 0, Number(r.tax) || 0, Number(r.amount) || 0,
        r.hasInvoice ? '有' : '無', Number(r.seq) || 0,
        r.photo || '', r.author || '', r.createdAt || ''
      ];
    });
  }

  return {
    EXPORT_HEADERS: EXPORT_HEADERS,
    splitTax: splitTax,
    nextSeq: nextSeq,
    summarize: summarize,
    buildExportRows: buildExportRows
  };
});
