/* 裁判：跑起來印 PASS/FAIL。功能還沒寫之前先跑一次，必須 FAIL。
 * 對照基準＝js/demo-data.js 的 17 筆（支出 15、收入 2）。
 * 這份是虛構資料——真帳不進 public repo。要用真帳回測就把
 * private/paper-2026-09.real.js 複製成 js/demo-data.js 再跑一次。
 * 用法：node test/logic.test.js
 */
'use strict';
var Calc = require('../js/calc.js');
var PAPER = require('../js/demo-data.js'); // 示範 17 筆（結構與真帳一致，數字是編的）

var pass = 0, fail = 0, fails = [];

// 功能還沒寫好時 got 會是 null，取屬性會爆——包起來，讓裁判印 FAIL 而不是 crash
function safe(fn) { try { return fn(); } catch (e) { return '(例外: ' + e.message + ')'; } }

function eq(name, got, want) {
  var ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; fails.push('  ✗ ' + name + '\n      期望 ' + JSON.stringify(want) + '\n      實得 ' + JSON.stringify(got)); }
}

// ---- 1. 稅額拆分（spec 共用契約） ----
eq('有發票 1000 → 未稅 952 / 稅 48', Calc.splitTax(1000, true), { net: 952, tax: 48 });
eq('無發票 1000 → 未稅 1000 / 稅 0', Calc.splitTax(1000, false), { net: 1000, tax: 0 });
eq('有發票 375 → 未稅 357 / 稅 18', Calc.splitTax(375, true), { net: 357, tax: 18 });
eq('有發票 1 → 未稅 1 / 稅 0（不能出現負稅）', Calc.splitTax(1, true), { net: 1, tax: 0 });
eq('金額 0 → 0/0', Calc.splitTax(0, true), { net: 0, tax: 0 });
eq('未稅＋稅額必定等於金額（2707 有發票）',
   safe(function () { var r = Calc.splitTax(2707, true); return r.net + r.tax; }), 2707);

// ---- 2. 收據編號：每月、每種收支別各自從 1 起算 ----
eq('當月沒有支出時，第一筆支出編號 1', Calc.nextSeq([], '支出'), 1);
eq('已有 2 筆支出 → 下一筆 3',
   Calc.nextSeq([{ kind: '支出', seq: 1 }, { kind: '支出', seq: 2 }], '支出'), 3);
eq('支出 2 筆不影響收入編號（收入仍從 1）',
   Calc.nextSeq([{ kind: '支出', seq: 1 }, { kind: '支出', seq: 2 }], '收入'), 1);
eq('作廢的筆仍占用編號（不回收，才留得住痕）',
   Calc.nextSeq([{ kind: '支出', seq: 1, status: '作廢' }], '支出'), 2);

// ---- 3. 合計：對照紙本手算 ----
var sum = safe(function () { return Calc.summarize(PAPER.rows); });
eq('示範資料支出合計 16800', sum && sum.expense, 16800);
eq('示範資料收入合計 1700', sum && sum.income, 1700);
eq('示範資料淨額 -15100', sum && sum.net, -15100);
eq('筆數 17（15 支出＋2 收入）', PAPER.rows.length, 17);

// ---- 4. 作廢一律留痕：不列入合計，但資料列還在 ----
var voided = PAPER.rows.map(function (r, i) {
  return i === 0 ? Object.assign({}, r, { status: '作廢' }) : r;
});
var sum2 = safe(function () { return Calc.summarize(voided); });
eq('作廢第一筆（500）後支出合計 16300', sum2 && sum2.expense, 16800 - 500);
eq('作廢後資料列數不變（沒有真刪）', voided.length, 17);

// ---- 5. 匯出列：欄位順序與內容照 spec 第六節 ----
var rows = safe(function () { return Calc.buildExportRows(PAPER.rows); });
eq('匯出只出正常筆（17 筆）', rows && rows.length, 17);
eq('匯出標題列欄位', rows && Calc.EXPORT_HEADERS,
   ['店別', '日期', '收支別', '科目', '項目名稱', '未稅價', '稅額', '金額', '發票', '收據編號', '收據照片', '填表人', '登記時間']);
var voidedRows = safe(function () { return Calc.buildExportRows(voided); });
eq('作廢的不出現在匯出檔（16 筆）', voidedRows && voidedRows.length, 16);
eq('匯出第一列的金額欄是數字不是字串',
   safe(function () { return typeof rows[0][7]; }), 'number');

// ---- 收尾 ----
console.log('\n通過 ' + pass + ' / 共 ' + (pass + fail));
if (fail) {
  console.log(fails.join('\n'));
  console.log('\nFAIL（' + fail + ' 項未通過）\n');
  process.exit(1);
}
console.log('\nPASS\n');
