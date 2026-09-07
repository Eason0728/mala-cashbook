/* ?mode=local 的種子資料：設定 + 常用項目。
 * 明細資料的單一真相是 js/demo-data.js（示範 17 筆），這裡不重複一份。
 */
(function () {
  'use strict';
  var paper = window.PaperData;

  // 由紙本資料推常用項目：越晚用過的排越前面（記憶功能的初始狀態）
  var seen = {};
  paper.rows.forEach(function (r) {
    var k = r.subject + '' + r.name;
    if (!seen[k]) seen[k] = { subject: r.subject, name: r.name, count: 0, lastUsed: '' };
    seen[k].count += 1;
    if (r.createdAt > seen[k].lastUsed) seen[k].lastUsed = r.createdAt;
  });

  window.MockData = {
    passcode: '1234',
    settings: {
      store: paper.store,
      expenseSubjects: ['食材', '蔬果', '瓦斯', '備品耗材', '清潔用品', '修繕維護',
                        '水電', '房租管理費', '運費', '文具印刷', '員工餐費', '雜支'],
      incomeSubjects: ['回收收入', '員工／同業購買', '代收轉付', '其他收入']
    },
    rows: paper.rows.map(function (r) { return Object.assign({}, r); }),
    frequent: Object.keys(seen).map(function (k) { return seen[k]; }),
    lockedMonths: []
  };
})();
